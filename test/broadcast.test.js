import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyToChannel, publishDraft, retryFailed } from '../tgcloud/lib/broadcast.js';
import { addToDraft } from '../tgcloud/lib/drafts.js';
import * as store from '../tgcloud/lib/store.js';
import { FakeBotApiError } from './helpers/fake-api.js';
import { makeDeps, privateMessage, BROADCASTER, OWNER, NOW } from './helpers/deps.js';

const A = -1001;
const B = -1002;
const C = -1003;

async function setup({ channels = [A, B], messages = [10] } = {}) {
  const deps = makeDeps();
  for (const [i, chatId] of channels.entries()) {
    await store.upsertChannel(deps.db, {
      chatId,
      title: `Chan ${String.fromCharCode(65 + i)}`,
      username: null,
      addedBy: OWNER,
      now: NOW,
    });
  }
  let draftId;
  for (const id of messages)
    ({ draftId } = await addToDraft(deps, privateMessage(BROADCASTER, id)));
  deps.api.reset();
  return { deps, draftId };
}

test('publish copies the whole draft to every enabled channel in one call each', async () => {
  const { deps, draftId } = await setup({ messages: [12, 10, 11] });
  await store.upsertChannel(deps.db, {
    chatId: C,
    title: 'Off',
    username: null,
    addedBy: OWNER,
    now: NOW,
  });
  await deps.db.run('UPDATE channels SET enabled = 0 WHERE chat_id = :c', { ':c': C });
  const result = await publishDraft(deps, { draftId, userId: BROADCASTER });
  assert.equal(result.ok, true);
  const calls = deps.api.callsOf('copyMessages');
  assert.deepEqual(
    calls.map((c) => c.chat_id).sort((x, y) => x - y),
    [B, A],
  );
  for (const c of calls) {
    assert.equal(c.from_chat_id, BROADCASTER);
    assert.deepEqual(c.message_ids, [10, 11, 12]);
  }
  assert.equal((await store.getDraft(deps.db, draftId)).status, 'published');
  const deliveries = await store.listDeliveries(deps.db, result.broadcastId);
  assert.deepEqual(
    deliveries.map((d) => [d.chat_id, d.status, d.copied]),
    [
      [A, 'sent', 3],
      [B, 'sent', 3],
    ],
  );
});

test('publish edits the control message into a report without a Retry button when all succeed', async () => {
  const { deps, draftId } = await setup();
  await publishDraft(deps, { draftId, userId: BROADCASTER });
  const edits = deps.api.callsOf('editMessageText');
  const final = edits.at(-1);
  assert.equal(final.message_id, 1000);
  assert.match(final.text, /Sent to 2 of 2 channels/);
  assert.match(final.text, /✅ Chan A/);
  assert.deepEqual(final.reply_markup, { inline_keyboard: [] });
});

test('a double-tapped Publish publishes once', async () => {
  const { deps, draftId } = await setup();
  const results = await Promise.all([
    publishDraft(deps, { draftId, userId: BROADCASTER }),
    publishDraft(deps, { draftId, userId: BROADCASTER }),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(results.find((r) => !r.ok).reason, 'not_open');
  assert.equal(deps.api.callsOf('copyMessages').length, 2);
});

test('only the draft author can publish it', async () => {
  const { deps, draftId } = await setup();
  const result = await publishDraft(deps, { draftId, userId: 6 });
  assert.deepEqual(result, { ok: false, reason: 'not_open' });
  assert.equal(deps.api.callsOf('copyMessages').length, 0);
});

test('publish without channels keeps the draft open', async () => {
  const { deps, draftId } = await setup({ channels: [] });
  const result = await publishDraft(deps, { draftId, userId: BROADCASTER });
  assert.deepEqual(result, { ok: false, reason: 'no_channels' });
  assert.equal((await store.getDraft(deps.db, draftId)).status, 'open');
});

test('mixed success and failure: report lists the error and offers Retry failed', async () => {
  const { deps, draftId } = await setup();
  deps.api.on('copyMessages', (p) => {
    if (p.chat_id === B) {
      throw new FakeBotApiError(
        'copyMessages',
        403,
        'Forbidden: bot is not a member of the channel chat',
      );
    }
    return p.message_ids.map((id) => ({ message_id: id + 100 }));
  });
  const result = await publishDraft(deps, { draftId, userId: BROADCASTER });
  const final = deps.api.callsOf('editMessageText').at(-1);
  assert.match(final.text, /Sent to 1 of 2 channels/);
  assert.match(final.text, /❌ Chan B: Forbidden: bot is not a member of the channel chat/);
  assert.deepEqual(final.reply_markup.inline_keyboard, [
    [{ text: '🔁 Retry failed', callback_data: `retry:${result.broadcastId}` }],
  ]);
});

test('fewer copies than requested is reported as partial, not failed', async () => {
  const { deps, draftId } = await setup({ channels: [A], messages: [10, 11, 12] });
  deps.api.on('copyMessages', () => [{ message_id: 1 }, { message_id: 2 }]);
  const result = await publishDraft(deps, { draftId, userId: BROADCASTER });
  const [d] = await store.listDeliveries(deps.db, result.broadcastId);
  assert.equal(d.status, 'partial');
  assert.equal(d.copied, 2);
  const final = deps.api.callsOf('editMessageText').at(-1);
  assert.match(final.text, /⚠️ Chan A: 2 of 3 messages copied/);
  assert.deepEqual(final.reply_markup, { inline_keyboard: [] });
});

test('a short 429 is retried once after retry_after', async () => {
  const deps = makeDeps();
  deps.api.on('copyMessages', (p, n) => {
    if (n === 0)
      throw new FakeBotApiError('copyMessages', 429, 'Too Many Requests: retry after 3', {
        retry_after: 3,
      });
    return p.message_ids.map(() => ({ message_id: 1 }));
  });
  const r = await copyToChannel(deps, { fromChatId: 5, chatId: A, messageIds: [1, 2] });
  assert.deepEqual(r, { status: 'sent', copied: 2, error: null });
  assert.deepEqual(deps.sleeps, [3000]);
});

test('a long 429 is reported without waiting', async () => {
  const deps = makeDeps();
  deps.api.fail('copyMessages', 429, 'Too Many Requests: retry after 60', { retry_after: 60 });
  const r = await copyToChannel(deps, { fromChatId: 5, chatId: A, messageIds: [1] });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /retry after 60/);
  assert.deepEqual(deps.sleeps, []);
  assert.equal(deps.api.callsOf('copyMessages').length, 1);
});

test('a 429 that repeats after the wait is reported as failed', async () => {
  const deps = makeDeps();
  deps.api.fail('copyMessages', 429, 'Too Many Requests: retry after 1', { retry_after: 1 });
  const r = await copyToChannel(deps, { fromChatId: 5, chatId: A, messageIds: [1] });
  assert.equal(r.status, 'failed');
  assert.equal(deps.api.callsOf('copyMessages').length, 2);
});

test('without a sleep function a 429 is not retried', async () => {
  const deps = makeDeps({ sleep: null });
  deps.api.fail('copyMessages', 429, 'Too Many Requests: retry after 1', { retry_after: 1 });
  const r = await copyToChannel(deps, { fromChatId: 5, chatId: A, messageIds: [1] });
  assert.equal(r.status, 'failed');
  assert.equal(deps.api.callsOf('copyMessages').length, 1);
});

test('more than 100 messages are copied in chunks of 100', async () => {
  const deps = makeDeps();
  const ids = Array.from({ length: 150 }, (_, i) => i + 1);
  const r = await copyToChannel(deps, { fromChatId: 5, chatId: A, messageIds: ids });
  assert.deepEqual(r, { status: 'sent', copied: 150, error: null });
  assert.deepEqual(
    deps.api.callsOf('copyMessages').map((c) => c.message_ids.length),
    [100, 50],
  );
});

test('an unexpected non-API error is reported as failed with its message', async () => {
  const deps = makeDeps();
  deps.api.on('copyMessages', () => {
    throw new TypeError('network down');
  });
  const r = await copyToChannel(deps, { fromChatId: 5, chatId: A, messageIds: [1] });
  assert.deepEqual(r, { status: 'failed', copied: 0, error: 'network down' });
});

test('Retry failed re-sends only to the failed channels and updates the report', async () => {
  const { deps, draftId } = await setup({ channels: [A, B, C] });
  deps.api.on('copyMessages', (p) => {
    if (p.chat_id !== A)
      throw new FakeBotApiError('copyMessages', 400, 'Bad Request: need administrator rights');
    return [{ message_id: 1 }];
  });
  const { broadcastId } = await publishDraft(deps, { draftId, userId: BROADCASTER });
  deps.api.reset();
  deps.api.on('copyMessages', () => [{ message_id: 2 }]);

  const r = await retryFailed(deps, { broadcastId, userId: BROADCASTER });
  assert.equal(r.ok, true);
  assert.deepEqual(
    deps.api
      .callsOf('copyMessages')
      .map((c) => c.chat_id)
      .sort((x, y) => x - y),
    [C, B],
  );
  const final = deps.api.callsOf('editMessageText').at(-1);
  assert.match(final.text, /Sent to 3 of 3 channels/);
  assert.deepEqual(final.reply_markup, { inline_keyboard: [] });
});

test('a double-tapped Retry failed retries once; nothing left reports nothing_to_retry', async () => {
  const { deps, draftId } = await setup();
  deps.api.fail('copyMessages', 403, 'Forbidden');
  const { broadcastId } = await publishDraft(deps, { draftId, userId: BROADCASTER });
  deps.api.reset();
  deps.api.on('copyMessages', () => [{ message_id: 2 }]);
  const results = await Promise.all([
    retryFailed(deps, { broadcastId, userId: BROADCASTER }),
    retryFailed(deps, { broadcastId, userId: BROADCASTER }),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(deps.api.callsOf('copyMessages').length, 2);
  const again = await retryFailed(deps, { broadcastId, userId: BROADCASTER });
  assert.deepEqual(again, { ok: false, reason: 'nothing_to_retry' });
});

test('retry skips channels removed since the broadcast', async () => {
  const { deps, draftId } = await setup();
  deps.api.fail('copyMessages', 403, 'Forbidden');
  const { broadcastId } = await publishDraft(deps, { draftId, userId: BROADCASTER });
  await store.removeChannel(deps.db, B);
  deps.api.reset();
  deps.api.on('copyMessages', () => [{ message_id: 2 }]);
  await retryFailed(deps, { broadcastId, userId: BROADCASTER });
  assert.deepEqual(
    deps.api.callsOf('copyMessages').map((c) => c.chat_id),
    [A],
  );
  const final = deps.api.callsOf('editMessageText').at(-1);
  assert.match(final.text, /⏭ Chan B: channel was removed from the bot/);
  assert.deepEqual(final.reply_markup, { inline_keyboard: [] });
});

test('retry is limited to the author and owners', async () => {
  const { deps, draftId } = await setup();
  deps.api.fail('copyMessages', 403, 'Forbidden');
  const { broadcastId } = await publishDraft(deps, { draftId, userId: BROADCASTER });
  assert.deepEqual(await retryFailed(deps, { broadcastId, userId: 6 }), {
    ok: false,
    reason: 'not_allowed',
  });
  deps.api.on('copyMessages', () => [{ message_id: 2 }]);
  assert.equal((await retryFailed(deps, { broadcastId, userId: OWNER })).ok, true);
  assert.deepEqual(await retryFailed(deps, { broadcastId: 999, userId: OWNER }), {
    ok: false,
    reason: 'not_found',
  });
});

test('report falls back to a new message when the control message cannot be edited', async () => {
  const { deps, draftId } = await setup();
  deps.api.fail('editMessageText', 400, 'Bad Request: message to edit not found');
  await publishDraft(deps, { draftId, userId: BROADCASTER });
  const sent = deps.api.callsOf('sendMessage');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sent to 2 of 2 channels/);
});

test('"message is not modified" is not treated as an edit failure', async () => {
  const { deps, draftId } = await setup();
  deps.api.fail('editMessageText', 400, 'Bad Request: message is not modified');
  await publishDraft(deps, { draftId, userId: BROADCASTER });
  assert.equal(deps.api.callsOf('sendMessage').length, 0);
});
