import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addBroadcasterById,
  addBroadcasterFromForward,
  broadcastersView,
  removeBroadcasterById,
  displayName,
} from '../tgcloud/lib/broadcasters.js';
import * as store from '../tgcloud/lib/store.js';
import { makeDeps, privateMessage, OWNER, NOW } from './helpers/deps.js';

test('displayName joins names and username', () => {
  assert.equal(
    displayName({ first_name: 'Ann', last_name: 'Lee', username: 'ann' }),
    'Ann Lee @ann',
  );
  assert.equal(displayName({ first_name: 'Bo' }), 'Bo');
  assert.equal(displayName(null), null);
});

test('addBroadcasterById saves the user with the name Telegram knows', async () => {
  const deps = makeDeps();
  deps.api.on('getChat', () => ({ id: 77, type: 'private', first_name: 'Ann', username: 'ann' }));
  const r = await addBroadcasterById(deps, { ref: '77', addedBy: OWNER });
  assert.deepEqual(r, { ok: true, created: true, userId: 77, name: 'Ann @ann' });
  assert.equal((await store.getBroadcaster(deps.db, 77)).name, 'Ann @ann');
});

test('addBroadcasterById works when Telegram does not know the user yet', async () => {
  const deps = makeDeps();
  deps.api.fail('getChat', 400, 'Bad Request: chat not found');
  const r = await addBroadcasterById(deps, { ref: '78', addedBy: OWNER });
  assert.equal(r.ok, true);
  assert.equal(r.name, null);
  assert.ok(await store.getBroadcaster(deps.db, 78));
});

test('addBroadcasterById rejects non-numeric ids and owners', async () => {
  const deps = makeDeps();
  assert.match((await addBroadcasterById(deps, { ref: '@ann', addedBy: OWNER })).error, /Usage/);
  assert.match(
    (await addBroadcasterById(deps, { ref: String(OWNER), addedBy: OWNER })).error,
    /owner/,
  );
  assert.equal((await store.listBroadcasters(deps.db)).length, 0);
});

test('addBroadcasterFromForward reads forward_origin and legacy forward_from', async () => {
  const deps = makeDeps();
  const fwd = privateMessage(OWNER, 30, {
    forward_origin: {
      type: 'user',
      date: NOW,
      sender_user: { id: 88, is_bot: false, first_name: 'Cy' },
    },
  });
  assert.deepEqual(await addBroadcasterFromForward(deps, { message: fwd, addedBy: OWNER }), {
    ok: true,
    created: true,
    userId: 88,
    name: 'Cy',
  });
  const legacy = privateMessage(OWNER, 31, {
    forward_from: { id: 89, is_bot: false, first_name: 'Di' },
  });
  assert.equal(
    (await addBroadcasterFromForward(deps, { message: legacy, addedBy: OWNER })).userId,
    89,
  );
});

test('addBroadcasterFromForward explains hidden senders, bots and channels', async () => {
  const deps = makeDeps();
  const hidden = privateMessage(OWNER, 30, {
    forward_origin: { type: 'hidden_user', date: NOW, sender_user_name: 'Someone' },
  });
  assert.match(
    (await addBroadcasterFromForward(deps, { message: hidden, addedBy: OWNER })).error,
    /hidden/,
  );
  const bot = privateMessage(OWNER, 31, {
    forward_origin: {
      type: 'user',
      date: NOW,
      sender_user: { id: 90, is_bot: true, first_name: 'B' },
    },
  });
  assert.match(
    (await addBroadcasterFromForward(deps, { message: bot, addedBy: OWNER })).error,
    /Bots/,
  );
  const chan = privateMessage(OWNER, 32, {
    forward_origin: { type: 'channel', date: NOW, chat: { id: -1 } },
  });
  assert.match(
    (await addBroadcasterFromForward(deps, { message: chan, addedBy: OWNER })).error,
    /person/,
  );
  assert.equal((await store.listBroadcasters(deps.db)).length, 0);
});

test('broadcastersView lists broadcasters with remove buttons', async () => {
  const deps = makeDeps();
  assert.match((await broadcastersView(deps)).text, /No broadcasters yet/);
  await store.addBroadcaster(deps.db, { userId: 77, name: 'Ann', addedBy: OWNER, now: NOW });
  await store.addBroadcaster(deps.db, { userId: 78, name: null, addedBy: OWNER, now: NOW + 1 });
  const view = await broadcastersView(deps);
  assert.match(view.text, /1\. Ann \(77\)/);
  assert.match(view.text, /2\. 78/);
  assert.deepEqual(
    view.reply_markup.inline_keyboard.map((row) => row[0].callback_data),
    ['rmbc:77', 'rmbc:78'],
  );
});

test('removeBroadcasterById deletes once', async () => {
  const deps = makeDeps();
  await store.addBroadcaster(deps.db, { userId: 77, name: null, addedBy: OWNER, now: NOW });
  assert.equal(await removeBroadcasterById(deps, 77), true);
  assert.equal(await removeBroadcasterById(deps, 77), false);
});
