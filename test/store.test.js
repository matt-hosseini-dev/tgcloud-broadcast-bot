import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../tgcloud/lib/store.js';
import { createTestDb } from './helpers/sqlite-db.js';

const NOW = 1_700_000_000;

test('markUpdateProcessed returns true once per update id', async () => {
  const db = createTestDb();
  assert.equal(await store.markUpdateProcessed(db, 10, NOW), true);
  assert.equal(await store.markUpdateProcessed(db, 10, NOW), false);
  assert.equal(await store.markUpdateProcessed(db, 11, NOW), true);
});

test('markUpdateProcessed is atomic under concurrency', async () => {
  const db = createTestDb();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => store.markUpdateProcessed(db, 7, NOW)),
  );
  assert.equal(results.filter(Boolean).length, 1);
});

test('pruneProcessedUpdates deletes rows older than the cutoff', async () => {
  const db = createTestDb();
  await store.markUpdateProcessed(db, 1, NOW - 100);
  await store.markUpdateProcessed(db, 2, NOW);
  await store.pruneProcessedUpdates(db, NOW - 50);
  assert.equal(await store.markUpdateProcessed(db, 1, NOW), true);
  assert.equal(await store.markUpdateProcessed(db, 2, NOW), false);
});

test('broadcasters: add, get, list, rename, remove', async () => {
  const db = createTestDb();
  assert.equal(
    await store.addBroadcaster(db, { userId: 5, name: 'Ann', addedBy: 1, now: NOW }),
    true,
  );
  assert.equal(
    await store.addBroadcaster(db, { userId: 5, name: 'Ann B', addedBy: 1, now: NOW }),
    false,
  );
  assert.equal((await store.getBroadcaster(db, 5)).name, 'Ann B');
  await store.addBroadcaster(db, { userId: 6, name: null, addedBy: 2, now: NOW });
  assert.deepEqual(
    (await store.listBroadcasters(db)).map((b) => b.user_id),
    [5, 6],
  );
  assert.equal(await store.removeBroadcaster(db, 5), true);
  assert.equal(await store.removeBroadcaster(db, 5), false);
  assert.equal(await store.getBroadcaster(db, 5), null);
});

test('channels: upsert, list enabled, remove', async () => {
  const db = createTestDb();
  const ch = { chatId: -1001, title: 'One', username: 'one', addedBy: 1, now: NOW };
  assert.equal(await store.upsertChannel(db, ch), true);
  assert.equal(await store.upsertChannel(db, { ...ch, title: 'One!' }), false);
  await store.upsertChannel(db, {
    chatId: -1002,
    title: 'Two',
    username: null,
    addedBy: 1,
    now: NOW,
  });
  await db.run('UPDATE channels SET enabled = 0 WHERE chat_id = -1002');
  assert.deepEqual(
    (await store.listChannels(db)).map((c) => c.title),
    ['One!', 'Two'],
  );
  assert.deepEqual(
    (await store.listChannels(db, { enabledOnly: true })).map((c) => c.chat_id),
    [-1001],
  );
  assert.equal((await store.getChannel(db, -1001)).username, 'one');
  assert.equal(await store.removeChannel(db, -1001), true);
  assert.equal(await store.removeChannel(db, -1001), false);
});

test('upsertChannel re-enables a disabled channel', async () => {
  const db = createTestDb();
  const ch = { chatId: -1001, title: 'One', username: null, addedBy: 1, now: NOW };
  await store.upsertChannel(db, ch);
  await db.run('UPDATE channels SET enabled = 0');
  await store.upsertChannel(db, ch);
  assert.equal((await store.getChannel(db, -1001)).enabled, 1);
});

test('openDraft creates one open draft per user, even concurrently', async () => {
  const db = createTestDb();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => store.openDraft(db, { userId: 5, chatId: 5, now: NOW })),
  );
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(new Set(results.map((r) => r.draft.id)).size, 1);
  const other = await store.openDraft(db, { userId: 6, chatId: 6, now: NOW });
  assert.notEqual(other.draft.id, results[0].draft.id);
});

test('draft messages are stored once and listed ascending', async () => {
  const db = createTestDb();
  const { draft } = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  for (const id of [12, 10, 11, 10]) await store.addDraftMessage(db, draft.id, id);
  assert.deepEqual(await store.listDraftMessageIds(db, draft.id), [10, 11, 12]);
});

test('setControlMessage stores the control message id', async () => {
  const db = createTestDb();
  const { draft } = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  await store.setControlMessage(db, draft.id, 77);
  assert.equal((await store.getDraft(db, draft.id)).control_message_id, 77);
  assert.equal((await store.getOpenDraft(db, 5)).id, draft.id);
});

test('claimDraft succeeds once and frees the user for a new draft', async () => {
  const db = createTestDb();
  const { draft } = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  const claims = await Promise.all([
    store.claimDraft(db, { draftId: draft.id, userId: 5, now: NOW }),
    store.claimDraft(db, { draftId: draft.id, userId: 5, now: NOW }),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal((await store.getDraft(db, draft.id)).status, 'publishing');
  assert.equal(await store.getOpenDraft(db, 5), null);
  const next = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  assert.equal(next.created, true);
});

test('claimDraft refuses another user', async () => {
  const db = createTestDb();
  const { draft } = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  assert.equal(await store.claimDraft(db, { draftId: draft.id, userId: 6, now: NOW }), false);
});

test('cancelDraft closes an open draft once', async () => {
  const db = createTestDb();
  const { draft } = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  assert.equal(await store.cancelDraft(db, { draftId: draft.id, now: NOW }), true);
  assert.equal(await store.cancelDraft(db, { draftId: draft.id, now: NOW }), false);
  assert.equal((await store.getDraft(db, draft.id)).status, 'cancelled');
  assert.equal(await store.getOpenDraft(db, 5), null);
});

test('setDraftStatus updates the status', async () => {
  const db = createTestDb();
  const { draft } = await store.openDraft(db, { userId: 5, chatId: 5, now: NOW });
  await store.claimDraft(db, { draftId: draft.id, userId: 5, now: NOW });
  await store.setDraftStatus(db, { draftId: draft.id, status: 'published', now: NOW });
  assert.equal((await store.getDraft(db, draft.id)).status, 'published');
});

test('broadcasts: create and read back with parsed message ids', async () => {
  const db = createTestDb();
  const id = await store.createBroadcast(db, {
    draftId: 3,
    userId: 5,
    chatId: 5,
    messageIds: [10, 11],
    controlMessageId: 77,
    now: NOW,
  });
  const b = await store.getBroadcast(db, id);
  assert.deepEqual(b.message_ids, [10, 11]);
  assert.equal(b.control_message_id, 77);
  assert.equal(await store.getBroadcast(db, 999), null);
});

test('deliveries: upsert, list, claim failed for retry once', async () => {
  const claim = (token) =>
    store.claimDeliveriesForRetry(db, { broadcastId: 1, token, now: NOW, staleBefore: NOW - 120 });
  const db = createTestDb();
  const base = { broadcastId: 1, now: NOW };
  await store.upsertDelivery(db, {
    ...base,
    chatId: -1,
    title: 'B',
    status: 'sent',
    copied: 2,
    error: null,
  });
  await store.upsertDelivery(db, {
    ...base,
    chatId: -2,
    title: 'A',
    status: 'failed',
    copied: 0,
    error: 'Forbidden',
  });
  await store.upsertDelivery(db, {
    ...base,
    chatId: -3,
    title: 'C',
    status: 'failed',
    copied: 0,
    error: 'x',
  });
  assert.deepEqual(
    (await store.listDeliveries(db, 1)).map((d) => [d.channel_title, d.status]),
    [
      ['A', 'failed'],
      ['B', 'sent'],
      ['C', 'failed'],
    ],
  );
  const [first, second] = await Promise.all([claim('retrying:a'), claim('retrying:b')]);
  const claimed = [first, second].sort((a, b) => b.length - a.length);
  assert.deepEqual(
    claimed[0].map((d) => d.chat_id).sort((x, y) => x - y),
    [-3, -2],
  );
  assert.deepEqual(claimed[1], []);
  await store.upsertDelivery(db, {
    ...base,
    chatId: -2,
    title: 'A',
    status: 'sent',
    copied: 2,
    error: null,
  });
  const a = (await store.listDeliveries(db, 1)).find((d) => d.chat_id === -2);
  assert.equal(a.status, 'sent');
  assert.equal(a.error, null);
});

test('pending actions: set, take within max age once, clear', async () => {
  const db = createTestDb();
  await store.setPendingAction(db, { userId: 1, action: 'add_broadcaster', now: NOW });
  assert.equal(
    await store.takePendingAction(db, { userId: 1, action: 'other', since: NOW - 10 }),
    false,
  );
  assert.equal(
    await store.takePendingAction(db, { userId: 1, action: 'add_broadcaster', since: NOW + 1 }),
    false,
  );
  assert.equal(
    await store.takePendingAction(db, { userId: 1, action: 'add_broadcaster', since: NOW - 10 }),
    true,
  );
  assert.equal(
    await store.takePendingAction(db, { userId: 1, action: 'add_broadcaster', since: NOW - 10 }),
    false,
  );
  await store.setPendingAction(db, { userId: 1, action: 'add_broadcaster', now: NOW });
  assert.equal(await store.clearPendingAction(db, 1), true);
  assert.equal(
    await store.hasPendingAction(db, { userId: 1, action: 'add_broadcaster', since: 0 }),
    false,
  );
});
