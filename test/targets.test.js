import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addChatTarget,
  addUserTargets,
  targetsView,
  removeTargetById,
  handleMyChatMember,
  parseChatRef,
  canPost,
} from '../tgcloud/lib/targets.js';
import * as store from '../tgcloud/lib/store.js';
import { BOT, FakeBotApiError } from './helpers/fake-api.js';
import { makeDeps, OWNER, BROADCASTER, NOW } from './helpers/deps.js';

const CHANNEL = { id: -1001, type: 'channel', title: 'News', username: 'news' };
const GROUP = { id: -5, type: 'supergroup', title: 'Team' };
const admin = (rights = {}) => ({
  status: 'administrator',
  user: BOT,
  can_post_messages: true,
  ...rights,
});

function chatApi(deps, { chat = CHANNEL, member = admin() } = {}) {
  deps.api.on('getChat', () => chat);
  deps.api.on('getChatMember', () => member);
}

test('parseChatRef accepts numeric ids, @usernames and t.me links', () => {
  assert.equal(parseChatRef(-1001234), -1001234);
  assert.equal(parseChatRef('-1001234'), -1001234);
  assert.equal(parseChatRef('@news'), '@news');
  assert.equal(parseChatRef('https://t.me/news'), '@news');
  assert.equal(parseChatRef('news'), '@news');
  assert.equal(parseChatRef(''), null);
  assert.equal(parseChatRef('bad name!'), null);
});

test('canPost: channels need Post messages; groups need membership that allows sending', () => {
  assert.equal(canPost(admin(), 'channel'), true);
  assert.equal(canPost(admin({ can_post_messages: false }), 'channel'), false);
  assert.equal(canPost({ status: 'member' }, 'channel'), false);
  assert.equal(canPost({ status: 'creator' }, 'channel'), true);
  assert.equal(canPost({ status: 'member' }, 'supergroup'), true);
  assert.equal(canPost({ status: 'administrator' }, 'group'), true);
  assert.equal(
    canPost({ status: 'restricted', is_member: true, can_send_messages: false }, 'supergroup'),
    false,
  );
  assert.equal(
    canPost({ status: 'restricted', is_member: true, can_send_messages: true }, 'supergroup'),
    true,
  );
  assert.equal(canPost({ status: 'left' }, 'group'), false);
  assert.equal(canPost({ status: 'kicked' }, 'supergroup'), false);
});

test('addChatTarget saves a channel the bot can post in', async () => {
  const deps = makeDeps();
  chatApi(deps);
  const r = await addChatTarget(deps, { ref: '@news', addedBy: OWNER });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.deepEqual(deps.api.callsOf('getChatMember')[0], { chat_id: -1001, user_id: BOT.id });
  const saved = await store.getTarget(deps.db, -1001);
  assert.equal(saved.chat_type, 'channel');
  assert.equal(saved.username, 'news');
});

test('addChatTarget saves a group the bot is in', async () => {
  const deps = makeDeps();
  chatApi(deps, { chat: GROUP, member: { status: 'member', user: BOT } });
  const r = await addChatTarget(deps, { ref: -5, addedBy: OWNER });
  assert.equal(r.ok, true);
  assert.equal((await store.getTarget(deps.db, -5)).chat_type, 'supergroup');
});

test('addChatTarget refuses with a short reason', async () => {
  const deps = makeDeps();
  chatApi(deps, { member: admin({ can_post_messages: false }) });
  assert.match(
    (await addChatTarget(deps, { ref: '@news', addedBy: OWNER })).error,
    /Post messages/,
  );
  chatApi(deps, { member: { status: 'member', user: BOT } });
  assert.match((await addChatTarget(deps, { ref: '@news', addedBy: OWNER })).error, /admin/);
  chatApi(deps, { chat: GROUP, member: { status: 'left', user: BOT } });
  assert.match((await addChatTarget(deps, { ref: -5, addedBy: OWNER })).error, /Add me/);
  chatApi(deps, { chat: { id: 9, type: 'private', first_name: 'X' } });
  assert.match((await addChatTarget(deps, { ref: 9, addedBy: OWNER })).error, /👤/);
  deps.api.fail('getChat', 400, 'Bad Request: chat not found');
  assert.match(
    (await addChatTarget(deps, { ref: '@nope', addedBy: OWNER })).error,
    /chat not found/,
  );
  assert.match((await addChatTarget(deps, { ref: '', addedBy: OWNER })).error, /Usage/);
  assert.equal((await store.listTargets(deps.db)).length, 0);
});

test('addUserTargets saves shared users and flags those who have not started the bot', async () => {
  const deps = makeDeps();
  deps.api.on('getChat', ({ chat_id }) => {
    if (chat_id === 78) throw new FakeBotApiError('getChat', 400, 'Bad Request: chat not found');
    return { id: chat_id, type: 'private' };
  });
  const results = await addUserTargets(deps, {
    users: [
      { user_id: 77, first_name: 'Ann', username: 'ann' },
      { user_id: 78, first_name: 'Bo' },
    ],
    addedBy: OWNER,
  });
  assert.deepEqual(results, [
    { userId: 77, name: 'Ann @ann', created: true, reachable: true },
    { userId: 78, name: 'Bo', created: true, reachable: false },
  ]);
  const saved = await store.getTarget(deps.db, 77);
  assert.equal(saved.chat_type, 'private');
  assert.equal(saved.title, 'Ann @ann');
});

test('targetsView lists targets with type icons and remove buttons', async () => {
  const deps = makeDeps();
  assert.match((await targetsView(deps)).text, /No targets yet/);
  await store.upsertTarget(deps.db, {
    chatId: -1001,
    title: 'News',
    username: 'news',
    addedBy: OWNER,
    now: NOW,
  });
  await store.upsertTarget(deps.db, {
    chatId: 77,
    chatType: 'private',
    title: 'Ann',
    username: null,
    addedBy: OWNER,
    now: NOW,
  });
  const view = await targetsView(deps);
  assert.equal(view.text, '📋 Targets (2)\n\n👤 Ann\n📢 News @news');
  assert.deepEqual(
    view.reply_markup.inline_keyboard.map((row) => row[0]),
    [
      { text: '✖ Ann', callback_data: 'rmch:77' },
      { text: '✖ News', callback_data: 'rmch:-1001' },
    ],
  );
});

test('removeTargetById deletes once', async () => {
  const deps = makeDeps();
  await store.upsertTarget(deps.db, {
    chatId: -1001,
    title: 'News',
    username: null,
    addedBy: OWNER,
    now: NOW,
  });
  assert.equal(await removeTargetById(deps, -1001), true);
  assert.equal(await removeTargetById(deps, -1001), false);
});

const memberUpdate = (fromId, newMember, chat = CHANNEL) => ({
  chat,
  from: { id: fromId, is_bot: false, first_name: 'X' },
  date: NOW,
  old_chat_member: { status: 'left', user: BOT },
  new_chat_member: newMember,
});

test('my_chat_member: an owner making the bot a channel admin registers it', async () => {
  const deps = makeDeps();
  await handleMyChatMember(deps, memberUpdate(OWNER, admin()));
  assert.equal((await store.getTarget(deps.db, -1001)).title, 'News');
  const sent = deps.api.callsOf('sendMessage')[0];
  assert.equal(sent.chat_id, OWNER);
  assert.equal(sent.text, '✅ Added: 📢 News');
});

test('my_chat_member: an owner adding the bot to a group registers it', async () => {
  const deps = makeDeps();
  await handleMyChatMember(deps, memberUpdate(OWNER, { status: 'member', user: BOT }, GROUP));
  assert.equal((await store.getTarget(deps.db, -5)).chat_type, 'supergroup');
  assert.equal(deps.api.callsOf('sendMessage')[0].text, '✅ Added: 👥 Team');
});

test('my_chat_member from non-owners, for private chats and for removals is ignored', async () => {
  const deps = makeDeps();
  await store.addBroadcaster(deps.db, {
    userId: BROADCASTER,
    name: null,
    addedBy: OWNER,
    now: NOW,
  });
  await handleMyChatMember(deps, memberUpdate(BROADCASTER, admin()));
  await handleMyChatMember(deps, memberUpdate(777, { status: 'member', user: BOT }, GROUP));
  await handleMyChatMember(
    deps,
    memberUpdate(OWNER, { status: 'member', user: BOT }, { id: 9, type: 'private' }),
  );
  await handleMyChatMember(deps, memberUpdate(OWNER, { status: 'kicked', user: BOT }));
  await handleMyChatMember(deps, memberUpdate(OWNER, { status: 'left', user: BOT }, GROUP));
  assert.equal((await store.listTargets(deps.db)).length, 0);
  assert.equal(deps.api.calls.length, 0);
});

test('my_chat_member: channel admin without Post messages gets a short hint', async () => {
  const deps = makeDeps();
  await handleMyChatMember(deps, memberUpdate(OWNER, admin({ can_post_messages: false })));
  assert.equal((await store.listTargets(deps.db)).length, 0);
  assert.match(deps.api.callsOf('sendMessage')[0].text, /Post messages/);
});

test('a failed owner notification does not undo the registration', async () => {
  const deps = makeDeps();
  deps.api.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user');
  await handleMyChatMember(deps, memberUpdate(OWNER, admin()));
  assert.ok(await store.getTarget(deps.db, -1001));
});
