// Flow tests through the real handler modules. The loader hook (helpers/register.js)
// maps 'sdk' to fakes, so handlers/*.js run exactly as deployed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import onMessage from '../tgcloud/handlers/message.js';
import onCallbackQuery from '../tgcloud/handlers/callback_query.js';
import onMyChatMember from '../tgcloud/handlers/my_chat_member.js';
import { installSdkFakes } from './helpers/fake-sdk.js';
import { createFakeApi, BOT } from './helpers/fake-api.js';
import { createTestDb } from './helpers/sqlite-db.js';
import { privateMessage, NOW } from './helpers/deps.js';
import * as store from '../tgcloud/lib/store.js';

// test/helpers/test-config.js sets OWNER_IDS = [1, 2]
const OWNER = 1;
const BROADCASTER = 5;
const STRANGER = 9;
const NEWS = { id: -1001, type: 'channel', title: 'News', username: 'news' };

let api;
let db;
let updateId;

beforeEach(() => {
  api = createFakeApi();
  db = createTestDb();
  installSdkFakes({ api, db });
  updateId = 1;
});

const ctx = () => ({ update: { update_id: updateId++ } });
const send = (userId, messageId, extra) =>
  onMessage(privateMessage(userId, messageId, extra), ctx());
const tap = (userId, data, message = { message_id: 1000, chat: { id: userId } }) =>
  onCallbackQuery({ id: `cq${updateId}`, from: { id: userId }, data, message }, ctx());

async function addChannelRow(chatId, title) {
  await store.upsertChannel(db, { chatId, title, username: null, addedBy: OWNER, now: NOW });
}

test('strangers are ignored silently', async () => {
  await send(STRANGER, 1, { text: '/start' });
  await send(STRANGER, 2, { text: 'hello' });
  await tap(STRANGER, 'pub:1');
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['answerCallbackQuery'],
  );
  assert.equal(api.callsOf('answerCallbackQuery')[0].text, undefined);
  assert.equal(await store.getOpenDraft(db, STRANGER), null);
});

test('/start shows owner help to owners and broadcaster help to broadcasters', async () => {
  await send(OWNER, 1, { text: '/start' });
  assert.match(api.callsOf('sendMessage')[0].text, /\/addchannel/);
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  api.reset();
  await send(BROADCASTER, 2, { text: '/help' });
  const text = api.callsOf('sendMessage')[0].text;
  assert.match(text, /Publish/);
  assert.doesNotMatch(text, /\/addchannel/);
});

test('messages outside private chats are ignored', async () => {
  await onMessage(
    { message_id: 1, from: { id: OWNER }, chat: { id: -5, type: 'supergroup' }, text: '/start' },
    ctx(),
  );
  assert.equal(api.calls.length, 0);
});

test('a redelivered update is handled once', async () => {
  const message = privateMessage(OWNER, 1, { text: '/start' });
  const c = { update: { update_id: 77 } };
  await onMessage(message, c);
  await onMessage(message, c);
  assert.equal(api.callsOf('sendMessage').length, 1);
});

test('album draft, publish, report: the full broadcaster flow', async () => {
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  await addChannelRow(-1001, 'News');
  await addChannelRow(-1002, 'Blog');
  await Promise.all(
    [10, 11, 12].map((id) =>
      send(BROADCASTER, id, { media_group_id: 'a', photo: [{ file_id: 'x' }] }),
    ),
  );
  const control = api.callsOf('sendMessage');
  assert.equal(control.length, 1);
  const publish = control[0].reply_markup.inline_keyboard[0][0].callback_data;

  await tap(BROADCASTER, publish);
  const copies = api.callsOf('copyMessages');
  assert.equal(copies.length, 2);
  assert.deepEqual(copies[0].message_ids, [10, 11, 12]);
  assert.equal(api.callsOf('answerCallbackQuery')[0].text, 'Publishing…');
  assert.match(api.callsOf('editMessageText').at(-1).text, /Sent to 2 of 2 channels/);

  // A second tap on the same button does nothing more.
  await tap(BROADCASTER, publish);
  assert.equal(api.callsOf('copyMessages').length, 2);
  assert.match(api.callsOf('answerCallbackQuery').at(-1).text, /already/i);
});

test('Publish with no channels explains how to add one', async () => {
  await send(OWNER, 10, { text: 'post' });
  const publish = api.callsOf('sendMessage')[0].reply_markup.inline_keyboard[0][0].callback_data;
  await tap(OWNER, publish);
  assert.match(api.callsOf('answerCallbackQuery')[0].text, /No channels/);
  assert.equal(api.callsOf('copyMessages').length, 0);
});

test('Cancel button and /cancel discard the draft', async () => {
  await send(OWNER, 10, { text: 'post' });
  const cancel = api.callsOf('sendMessage')[0].reply_markup.inline_keyboard[0][1].callback_data;
  await tap(OWNER, cancel);
  assert.equal(await store.getOpenDraft(db, OWNER), null);
  assert.match(api.callsOf('answerCallbackQuery')[0].text, /Cancelled/);

  await send(OWNER, 11, { text: 'another' });
  assert.ok(await store.getOpenDraft(db, OWNER));
  api.reset();
  await send(OWNER, 12, { text: '/cancel' });
  assert.equal(await store.getOpenDraft(db, OWNER), null);
  assert.match(api.callsOf('sendMessage')[0].text, /cancelled/i);
  api.reset();
  await send(OWNER, 13, { text: '/cancel' });
  assert.match(api.callsOf('sendMessage')[0].text, /Nothing to cancel/);
});

test('owners add, list and remove channels', async () => {
  api.on('getChat', () => NEWS);
  api.on('getChatMember', () => ({ status: 'administrator', user: BOT, can_post_messages: true }));
  await send(OWNER, 1, { text: '/addchannel @news' });
  assert.match(api.callsOf('sendMessage')[0].text, /added/);
  assert.ok(await store.getChannel(db, -1001));

  api.reset();
  await send(OWNER, 2, { text: '/channels' });
  const list = api.callsOf('sendMessage')[0];
  assert.match(list.text, /News @news/);
  const remove = list.reply_markup.inline_keyboard[0][0].callback_data;

  api.reset();
  await tap(OWNER, remove, { message_id: 555, chat: { id: OWNER } });
  assert.equal(await store.getChannel(db, -1001), null);
  const edit = api.callsOf('editMessageText')[0];
  assert.equal(edit.message_id, 555);
  assert.match(edit.text, /No channels yet/);
  assert.match(api.callsOf('answerCallbackQuery')[0].text, /Removed/);
});

test('/addchannel reports why a channel cannot be added', async () => {
  api.fail('getChat', 400, 'Bad Request: chat not found');
  await send(OWNER, 1, { text: '/addchannel @nope' });
  assert.match(api.callsOf('sendMessage')[0].text, /chat not found/);
});

test('broadcasters cannot use owner commands or owner buttons', async () => {
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  await addChannelRow(-1001, 'News');
  await send(BROADCASTER, 1, { text: '/addchannel @news' });
  assert.match(api.callsOf('sendMessage')[0].text, /Only owners/);
  await tap(BROADCASTER, 'rmch:-1001');
  assert.ok(await store.getChannel(db, -1001));
  assert.match(api.callsOf('answerCallbackQuery')[0].text, /Only owners/);
  assert.equal(await store.getOpenDraft(db, BROADCASTER), null);
});

test('/addbroadcaster with an id, and with a forwarded message', async () => {
  await send(OWNER, 1, { text: '/addbroadcaster 77' });
  assert.ok(await store.getBroadcaster(db, 77));
  assert.match(api.callsOf('sendMessage')[0].text, /added/);

  api.reset();
  await send(OWNER, 2, { text: '/addbroadcaster' });
  assert.match(api.callsOf('sendMessage')[0].text, /Forward/);
  await send(OWNER, 3, {
    text: 'hi',
    forward_origin: {
      type: 'user',
      date: NOW,
      sender_user: { id: 88, is_bot: false, first_name: 'Cy' },
    },
  });
  assert.equal((await store.getBroadcaster(db, 88)).name, 'Cy');
  assert.equal(await store.getOpenDraft(db, OWNER), null, 'the forward is not added to a draft');

  // Without a pending /addbroadcaster, a forward is ordinary draft content.
  api.reset();
  await send(OWNER, 4, {
    text: 'fwd',
    forward_origin: {
      type: 'user',
      date: NOW,
      sender_user: { id: 99, is_bot: false, first_name: 'Ed' },
    },
  });
  assert.equal(await store.getBroadcaster(db, 99), null);
  assert.ok(await store.getOpenDraft(db, OWNER));
});

test('/broadcasters lists and the remove button removes', async () => {
  await store.addBroadcaster(db, { userId: 77, name: 'Ann', addedBy: OWNER, now: NOW });
  await send(OWNER, 1, { text: '/broadcasters' });
  const remove = api.callsOf('sendMessage')[0].reply_markup.inline_keyboard[0][0].callback_data;
  await tap(OWNER, remove);
  assert.equal(await store.getBroadcaster(db, 77), null);
  assert.match(api.callsOf('editMessageText')[0].text, /No broadcasters yet/);
});

test('Retry failed button re-sends to failed channels', async () => {
  await addChannelRow(-1001, 'News');
  api.fail('copyMessages', 403, 'Forbidden: bot is not a member of the channel chat');
  await send(OWNER, 10, { text: 'post' });
  await tap(OWNER, 'pub:1');
  const report = api.callsOf('editMessageText').at(-1);
  const retry = report.reply_markup.inline_keyboard[0][0].callback_data;
  api.on('copyMessages', () => [{ message_id: 1 }]);
  api.reset();
  await tap(OWNER, retry);
  assert.equal(api.callsOf('copyMessages').length, 1);
  assert.match(api.callsOf('editMessageText').at(-1).text, /Sent to 1 of 1/);
  api.reset();
  await tap(OWNER, retry);
  assert.match(api.callsOf('answerCallbackQuery')[0].text, /Nothing to retry/);
});

test('my_chat_member registers a channel only for owners', async () => {
  const update = (fromId) => ({
    chat: NEWS,
    from: { id: fromId },
    date: NOW,
    old_chat_member: { status: 'left', user: BOT },
    new_chat_member: { status: 'administrator', user: BOT, can_post_messages: true },
  });
  await onMyChatMember(update(STRANGER), ctx());
  assert.equal(await store.getChannel(db, -1001), null);
  await onMyChatMember(update(OWNER), ctx());
  assert.ok(await store.getChannel(db, -1001));
});

test('a failed callback answer does not break the action', async () => {
  await send(OWNER, 10, { text: 'post' });
  api.fail('answerCallbackQuery', 400, 'Bad Request: query is too old');
  await tap(OWNER, 'can:1');
  assert.equal(await store.getOpenDraft(db, OWNER), null);
});
