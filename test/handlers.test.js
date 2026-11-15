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
import { TARGETS_BUTTON, REQUEST } from '../tgcloud/lib/report.js';
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
const lastAnswer = () => api.callsOf('answerCallbackQuery').at(-1)?.text;
const lastEdit = () => api.callsOf('editMessageText').at(-1);
const buttons = (markup) => markup.inline_keyboard.flat().map((b) => b.callback_data);

async function addTarget(chatId, title, chatType = 'channel') {
  await store.upsertTarget(db, {
    chatId,
    chatType,
    title,
    username: null,
    addedBy: OWNER,
    now: NOW,
  });
}

test('strangers are ignored silently', async () => {
  await send(STRANGER, 1, { text: '/start' });
  await send(STRANGER, 2, { text: 'hello' });
  await send(STRANGER, 3, { chat_shared: { request_id: REQUEST.channel, chat_id: -1001 } });
  await tap(STRANGER, 'pub:1');
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['answerCallbackQuery'],
  );
  assert.equal(lastAnswer(), undefined);
});

test('/start gives owners the picker keyboard; broadcasters get short help only', async () => {
  await send(OWNER, 1, { text: '/start' });
  const owner = api.callsOf('sendMessage')[0];
  assert.ok(owner.reply_markup.keyboard[0][2].request_chat);
  assert.match(owner.text, /addbroadcaster/);
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  api.reset();
  await send(BROADCASTER, 2, { text: '/help' });
  const b = api.callsOf('sendMessage')[0];
  assert.equal(b.reply_markup, undefined);
  assert.doesNotMatch(b.text, /addbroadcaster/);
});

test('messages outside private chats are ignored, and redeliveries run once', async () => {
  await onMessage(
    { message_id: 1, from: { id: OWNER }, chat: { id: -5, type: 'supergroup' }, text: '/start' },
    ctx(),
  );
  assert.equal(api.calls.length, 0);
  const c = { update: { update_id: 77 } };
  await onMessage(privateMessage(OWNER, 1, { text: '/start' }), c);
  await onMessage(privateMessage(OWNER, 1, { text: '/start' }), c);
  assert.equal(api.callsOf('sendMessage').length, 1);
});

test('full flow: album draft, Publish opens the checklist, untick one, Send', async () => {
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  await addTarget(-1001, 'News');
  await addTarget(-5, 'Team', 'supergroup');
  await addTarget(77, 'Ann', 'private');
  await Promise.all(
    [10, 11, 12].map((id) =>
      send(BROADCASTER, id, { media_group_id: 'a', photo: [{ file_id: 'x' }] }),
    ),
  );
  const control = api.callsOf('sendMessage');
  assert.equal(control.length, 1);
  assert.deepEqual(buttons(control[0].reply_markup), ['pub:1', 'can:1']);

  await tap(BROADCASTER, 'pub:1');
  assert.equal(lastEdit().text, 'Send to 3/3:');
  assert.equal(lastEdit().message_id, 1000);
  assert.equal(api.callsOf('copyMessages').length, 0, 'Publish only opens the checklist');

  await tap(BROADCASTER, 'tg:1:-5');
  assert.equal(lastEdit().text, 'Send to 2/3:');

  await send(BROADCASTER, 13, { text: 'late addition' });
  assert.equal(api.callsOf('sendMessage').length, 1, 'still the same open draft');

  await tap(BROADCASTER, 'send:1');
  const copies = api.callsOf('copyMessages');
  assert.deepEqual(
    copies.map((c) => c.chat_id).sort((x, y) => x - y),
    [-1001, 77],
  );
  assert.deepEqual(copies[0].message_ids, [10, 11, 12, 13]);
  assert.equal(api.callsOf('answerCallbackQuery').at(-1).text, 'Sending…');
  assert.match(lastEdit().text, /^📣 Sent 2\/2/);

  await tap(BROADCASTER, 'send:1');
  assert.equal(api.callsOf('copyMessages').length, 2);
  assert.equal(lastAnswer(), 'Already sent or cancelled.');
});

test('Publish with no targets and Send with none ticked explain briefly', async () => {
  await send(OWNER, 10, { text: 'post' });
  await tap(OWNER, 'pub:1');
  assert.equal(lastAnswer(), 'No targets yet.');
  await addTarget(-1001, 'News');
  await tap(OWNER, 'all:1');
  assert.equal(lastEdit().text, 'Send to 0/1:');
  await tap(OWNER, 'send:1');
  assert.equal(lastAnswer(), 'Tick at least one.');
  assert.equal(api.callsOf('copyMessages').length, 0);
});

test('only the author can use a draft checklist', async () => {
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  await addTarget(-1001, 'News');
  await send(BROADCASTER, 10, { text: 'post' });
  await tap(OWNER, 'tg:1:-1001');
  assert.equal(lastAnswer(), 'Already sent or cancelled.');
  assert.deepEqual(await store.listExcluded(db, 1), []);
});

test('Cancel button and /cancel discard the draft', async () => {
  await send(OWNER, 10, { text: 'post' });
  await tap(OWNER, 'can:1');
  assert.equal(await store.getOpenDraft(db, OWNER), null);
  assert.equal(lastAnswer(), 'Cancelled.');
  await send(OWNER, 11, { text: 'another' });
  api.reset();
  await send(OWNER, 12, { text: '/cancel' });
  assert.equal(api.callsOf('sendMessage')[0].text, 'Cancelled.');
  api.reset();
  await send(OWNER, 13, { text: '/cancel' });
  assert.equal(api.callsOf('sendMessage')[0].text, 'Nothing to cancel.');
});

test('📢 picker: a shared channel is verified and added', async () => {
  api.on('getChat', () => NEWS);
  api.on('getChatMember', () => ({ status: 'administrator', user: BOT, can_post_messages: true }));
  await send(OWNER, 1, {
    chat_shared: { request_id: REQUEST.channel, chat_id: -1001, title: 'News' },
  });
  assert.equal(api.callsOf('sendMessage')[0].text, '✅ Added: 📢 News');
  assert.equal((await store.getTarget(db, -1001)).chat_type, 'channel');
  assert.equal(await store.getOpenDraft(db, OWNER), null, 'service messages never start a draft');
});

test('👥 picker: a group the bot cannot post in is refused', async () => {
  api.on('getChat', () => ({ id: -5, type: 'supergroup', title: 'Team' }));
  api.on('getChatMember', () => ({
    status: 'restricted',
    is_member: true,
    can_send_messages: false,
    user: BOT,
  }));
  await send(OWNER, 1, { chat_shared: { request_id: REQUEST.group, chat_id: -5 } });
  assert.match(api.callsOf('sendMessage')[0].text, /can't post in Team/);
  assert.equal(await store.getTarget(db, -5), null);
});

test('👤 picker: shared users are added, flagged if they never started the bot', async () => {
  api.on('getChat', ({ chat_id }) => {
    if (chat_id === 78)
      throw Object.assign(new Error('x'), { code: 400, description: 'chat not found' });
    return { id: chat_id, type: 'private' };
  });
  await send(OWNER, 1, {
    users_shared: {
      request_id: REQUEST.users,
      users: [
        { user_id: 77, first_name: 'Ann' },
        { user_id: 78, first_name: 'Bo' },
      ],
    },
  });
  assert.equal(
    api.callsOf('sendMessage')[0].text,
    '✅ Added: 👤 Ann\n✅ Added: 👤 Bo (must /start me first)',
  );
  assert.equal((await store.getTarget(db, 77)).chat_type, 'private');
});

test('broadcasters cannot add targets, even through a picker message', async () => {
  await store.addBroadcaster(db, { userId: BROADCASTER, name: null, addedBy: OWNER, now: NOW });
  await send(BROADCASTER, 1, { chat_shared: { request_id: REQUEST.channel, chat_id: -1001 } });
  assert.equal(api.calls.length, 0);
  await send(BROADCASTER, 2, { text: '/add @news' });
  assert.equal(api.callsOf('sendMessage')[0].text, 'Owners only.');
  await addTarget(-1001, 'News');
  await tap(BROADCASTER, 'rmch:-1001');
  assert.ok(await store.getTarget(db, -1001));
  assert.equal(lastAnswer(), 'Owners only.');
});

test('📋 Targets button lists targets; remove refreshes the list', async () => {
  await addTarget(-1001, 'News');
  await send(OWNER, 1, { text: TARGETS_BUTTON });
  const list = api.callsOf('sendMessage')[0];
  assert.equal(list.text, '📋 Targets (1)\n\n📢 News');
  assert.equal(await store.getOpenDraft(db, OWNER), null, 'the button text is not draft content');
  await tap(OWNER, 'rmch:-1001', { message_id: 555, chat: { id: OWNER } });
  assert.equal(await store.getTarget(db, -1001), null);
  assert.equal(lastEdit().message_id, 555);
  assert.match(lastEdit().text, /No targets yet/);
  assert.equal(lastAnswer(), 'Removed.');
});

test('/add accepts a channel or group by username or id', async () => {
  api.on('getChat', () => NEWS);
  api.on('getChatMember', () => ({ status: 'administrator', user: BOT, can_post_messages: true }));
  await send(OWNER, 1, { text: '/add @news' });
  assert.equal(api.callsOf('sendMessage')[0].text, '✅ Added: 📢 News');
  api.reset();
  api.fail('getChat', 400, 'Bad Request: chat not found');
  await send(OWNER, 2, { text: '/addchannel @nope' });
  assert.match(api.callsOf('sendMessage')[0].text, /chat not found/);
});

test('/addbroadcaster with an id, and with a forwarded message', async () => {
  await send(OWNER, 1, { text: '/addbroadcaster 77' });
  assert.ok(await store.getBroadcaster(db, 77));
  assert.match(api.callsOf('sendMessage')[0].text, /^✅ Broadcaster: /);
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
  assert.equal(await store.getOpenDraft(db, OWNER), null);
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
  assert.match(lastEdit().text, /No broadcasters yet/);
});

test('Retry re-sends to failed targets', async () => {
  await addTarget(-1001, 'News');
  api.fail('copyMessages', 403, 'Forbidden: bot is not a member of the channel chat');
  await send(OWNER, 10, { text: 'post' });
  await tap(OWNER, 'send:1');
  assert.deepEqual(buttons(lastEdit().reply_markup), ['retry:1']);
  api.on('copyMessages', () => [{ message_id: 1 }]);
  api.reset();
  await tap(OWNER, 'retry:1');
  assert.equal(api.callsOf('copyMessages').length, 1);
  assert.match(lastEdit().text, /^📣 Sent 1\/1/);
  api.reset();
  await tap(OWNER, 'retry:1');
  assert.equal(lastAnswer(), 'Nothing to retry.');
});

test('my_chat_member registers channels and groups only for owners', async () => {
  const update = (fromId, chat, member) => ({
    chat,
    from: { id: fromId },
    date: NOW,
    old_chat_member: { status: 'left', user: BOT },
    new_chat_member: member,
  });
  const adminRights = { status: 'administrator', user: BOT, can_post_messages: true };
  await onMyChatMember(update(STRANGER, NEWS, adminRights), ctx());
  assert.equal(await store.getTarget(db, -1001), null);
  await onMyChatMember(update(OWNER, NEWS, adminRights), ctx());
  assert.ok(await store.getTarget(db, -1001));
  await onMyChatMember(
    update(OWNER, { id: -5, type: 'group', title: 'Team' }, { status: 'member', user: BOT }),
    ctx(),
  );
  assert.equal((await store.getTarget(db, -5)).chat_type, 'group');
});

test('a failed callback answer does not break the action', async () => {
  await send(OWNER, 10, { text: 'post' });
  api.fail('answerCallbackQuery', 400, 'Bad Request: query is too old');
  await tap(OWNER, 'can:1');
  assert.equal(await store.getOpenDraft(db, OWNER), null);
});
