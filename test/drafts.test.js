import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToDraft, cancelOpenDraft, cancelDraftById } from '../tgcloud/lib/drafts.js';
import * as store from '../tgcloud/lib/store.js';
import { makeDeps, privateMessage, BROADCASTER } from './helpers/deps.js';

test('first message opens a draft and sends one control message with Publish and Cancel', async () => {
  const deps = makeDeps();
  const { draftId, created } = await addToDraft(
    deps,
    privateMessage(BROADCASTER, 10, { text: 'hi' }),
  );
  assert.equal(created, true);
  const sent = deps.api.callsOf('sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, BROADCASTER);
  assert.equal(sent[0].reply_parameters.message_id, 10);
  const buttons = sent[0].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, [`pub:${draftId}`, `can:${draftId}`]);
  const draft = await store.getDraft(deps.db, draftId);
  assert.equal(draft.control_message_id, 1000);
  assert.deepEqual(await store.listDraftMessageIds(deps.db, draftId), [10]);
});

test('later messages join the open draft without another control message', async () => {
  const deps = makeDeps();
  const a = await addToDraft(deps, privateMessage(BROADCASTER, 10));
  const b = await addToDraft(deps, privateMessage(BROADCASTER, 11));
  assert.equal(b.draftId, a.draftId);
  assert.equal(b.created, false);
  assert.equal(deps.api.callsOf('sendMessage').length, 1);
});

test('a 10-item album arriving concurrently produces one draft and one control message', async () => {
  const deps = makeDeps();
  const album = Array.from({ length: 10 }, (_, i) =>
    privateMessage(BROADCASTER, 20 + i, { media_group_id: 'g1', photo: [{ file_id: `p${i}` }] }),
  );
  const results = await Promise.all(album.map((m) => addToDraft(deps, m)));
  assert.equal(new Set(results.map((r) => r.draftId)).size, 1);
  assert.equal(deps.api.callsOf('sendMessage').length, 1);
  assert.deepEqual(
    await store.listDraftMessageIds(deps.db, results[0].draftId),
    album.map((m) => m.message_id),
  );
});

test('if the control message cannot be sent, the draft is cancelled so the next message retries', async () => {
  const deps = makeDeps();
  deps.api.fail('sendMessage', 500, 'Internal Server Error');
  const first = await addToDraft(deps, privateMessage(BROADCASTER, 10));
  assert.equal((await store.getDraft(deps.db, first.draftId)).status, 'cancelled');
  deps.api.on('sendMessage', () => ({ message_id: 55 }));
  const second = await addToDraft(deps, privateMessage(BROADCASTER, 11));
  assert.notEqual(second.draftId, first.draftId);
  assert.equal(second.created, true);
  assert.equal((await store.getDraft(deps.db, second.draftId)).control_message_id, 55);
});

test('cancelOpenDraft closes the draft and edits the control message', async () => {
  const deps = makeDeps();
  const { draftId } = await addToDraft(deps, privateMessage(BROADCASTER, 10));
  assert.equal(await cancelOpenDraft(deps, BROADCASTER), true);
  assert.equal((await store.getDraft(deps.db, draftId)).status, 'cancelled');
  const edits = deps.api.callsOf('editMessageText');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].message_id, 1000);
  assert.match(edits[0].text, /cancelled/i);
  assert.equal(await cancelOpenDraft(deps, BROADCASTER), false);
});

test('cancelDraftById only works for the draft author and only once', async () => {
  const deps = makeDeps();
  const { draftId } = await addToDraft(deps, privateMessage(BROADCASTER, 10));
  assert.equal(await cancelDraftById(deps, { draftId, userId: 6 }), false);
  assert.equal(await cancelDraftById(deps, { draftId, userId: BROADCASTER }), true);
  assert.equal(await cancelDraftById(deps, { draftId, userId: BROADCASTER }), false);
  assert.equal(await cancelDraftById(deps, { draftId: 999, userId: BROADCASTER }), false);
});

test('an edit failure on the control message does not undo the cancel', async () => {
  const deps = makeDeps();
  const { draftId } = await addToDraft(deps, privateMessage(BROADCASTER, 10));
  deps.api.fail('editMessageText', 400, 'Bad Request: message to edit not found');
  assert.equal(await cancelOpenDraft(deps, BROADCASTER), true);
  assert.equal((await store.getDraft(deps.db, draftId)).status, 'cancelled');
});
