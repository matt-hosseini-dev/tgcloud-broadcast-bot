import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addChannel,
  channelsView,
  removeChannelById,
  handleMyChatMember,
  parseChatRef,
} from '../tgcloud/lib/channels.js';
import * as store from '../tgcloud/lib/store.js';
import { BOT, FakeBotApiError } from './helpers/fake-api.js';
import { makeDeps, OWNER, BROADCASTER, NOW } from './helpers/deps.js';

const CHANNEL = { id: -1001, type: 'channel', title: 'News', username: 'news' };
const adminMember = (rights = {}) => ({
  status: 'administrator',
  user: BOT,
  can_post_messages: true,
  ...rights,
});

function channelApi(deps, { chat = CHANNEL, member = adminMember() } = {}) {
  deps.api.on('getChat', () => chat);
  deps.api.on('getChatMember', () => member);
}

test('parseChatRef accepts numeric ids, @usernames and t.me links', () => {
  assert.equal(parseChatRef('-1001234'), -1001234);
  assert.equal(parseChatRef('@news'), '@news');
  assert.equal(parseChatRef('https://t.me/news'), '@news');
  assert.equal(parseChatRef('t.me/news'), '@news');
  assert.equal(parseChatRef('news'), '@news');
  assert.equal(parseChatRef(''), null);
  assert.equal(parseChatRef('bad name!'), null);
});

test('addChannel verifies the bot can post and saves the channel', async () => {
  const deps = makeDeps();
  channelApi(deps);
  const r = await addChannel(deps, { ref: '@news', addedBy: OWNER });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(deps.api.callsOf('getChat')[0].chat_id, '@news');
  assert.deepEqual(deps.api.callsOf('getChatMember')[0], { chat_id: -1001, user_id: BOT.id });
  const saved = await store.getChannel(deps.db, -1001);
  assert.equal(saved.title, 'News');
  assert.equal(saved.username, 'news');
  assert.equal(saved.added_by, OWNER);
});

test('addChannel accepts the bot as channel creator', async () => {
  const deps = makeDeps();
  channelApi(deps, { member: { status: 'creator', user: BOT } });
  assert.equal((await addChannel(deps, { ref: '-1001', addedBy: OWNER })).ok, true);
});

test('addChannel refuses when the bot cannot post', async () => {
  const deps = makeDeps();
  channelApi(deps, { member: adminMember({ can_post_messages: false }) });
  const r = await addChannel(deps, { ref: '@news', addedBy: OWNER });
  assert.equal(r.ok, false);
  assert.match(r.error, /Post messages/);
  assert.equal(await store.getChannel(deps.db, -1001), null);
});

test('addChannel refuses a plain member, a group, an unknown chat and a bad reference', async () => {
  const deps = makeDeps();
  channelApi(deps, { member: { status: 'member', user: BOT } });
  assert.match((await addChannel(deps, { ref: '@news', addedBy: OWNER })).error, /admin/);

  channelApi(deps, { chat: { id: -5, type: 'supergroup', title: 'G' } });
  assert.match((await addChannel(deps, { ref: '-5', addedBy: OWNER })).error, /not a channel/);

  deps.api.fail('getChat', 400, 'Bad Request: chat not found');
  assert.match((await addChannel(deps, { ref: '@nope', addedBy: OWNER })).error, /chat not found/);

  assert.match((await addChannel(deps, { ref: '', addedBy: OWNER })).error, /Usage/);
  assert.equal((await store.listChannels(deps.db)).length, 0);
});

test('channelsView lists channels with remove buttons', async () => {
  const deps = makeDeps();
  assert.match((await channelsView(deps)).text, /No channels yet/);
  await store.upsertChannel(deps.db, {
    chatId: -1001,
    title: 'News',
    username: 'news',
    addedBy: OWNER,
    now: NOW,
  });
  await store.upsertChannel(deps.db, {
    chatId: -1002,
    title: 'Blog',
    username: null,
    addedBy: OWNER,
    now: NOW,
  });
  const view = await channelsView(deps);
  assert.match(view.text, /1\. Blog \(-1002\)/);
  assert.match(view.text, /2\. News @news \(-1001\)/);
  assert.deepEqual(
    view.reply_markup.inline_keyboard.map((row) => row[0].callback_data),
    ['rmch:-1002', 'rmch:-1001'],
  );
});

test('removeChannelById deletes once', async () => {
  const deps = makeDeps();
  await store.upsertChannel(deps.db, {
    chatId: -1001,
    title: 'News',
    username: null,
    addedBy: OWNER,
    now: NOW,
  });
  assert.equal(await removeChannelById(deps, -1001), true);
  assert.equal(await removeChannelById(deps, -1001), false);
});

const memberUpdate = (fromId, newMember, chat = CHANNEL) => ({
  chat,
  from: { id: fromId, is_bot: false, first_name: 'X' },
  date: NOW,
  old_chat_member: { status: 'left', user: BOT },
  new_chat_member: newMember,
});

test('my_chat_member from an owner promoting the bot registers the channel and notifies', async () => {
  const deps = makeDeps();
  await handleMyChatMember(deps, memberUpdate(OWNER, adminMember()));
  assert.equal((await store.getChannel(deps.db, -1001)).title, 'News');
  const sent = deps.api.callsOf('sendMessage');
  assert.equal(sent[0].chat_id, OWNER);
  assert.match(sent[0].text, /News/);
});

test('my_chat_member from a non-owner is ignored silently', async () => {
  const deps = makeDeps();
  await store.addBroadcaster(deps.db, {
    userId: BROADCASTER,
    name: null,
    addedBy: OWNER,
    now: NOW,
  });
  await handleMyChatMember(deps, memberUpdate(BROADCASTER, adminMember()));
  await handleMyChatMember(deps, memberUpdate(777, adminMember()));
  assert.equal((await store.listChannels(deps.db)).length, 0);
  assert.equal(deps.api.calls.length, 0);
});

test('my_chat_member without posting rights tells the owner what is missing', async () => {
  const deps = makeDeps();
  await handleMyChatMember(deps, memberUpdate(OWNER, adminMember({ can_post_messages: false })));
  assert.equal((await store.listChannels(deps.db)).length, 0);
  assert.match(deps.api.callsOf('sendMessage')[0].text, /Post messages/);
});

test('my_chat_member for groups, private chats and removals is ignored', async () => {
  const deps = makeDeps();
  await handleMyChatMember(
    deps,
    memberUpdate(OWNER, adminMember(), { id: -5, type: 'supergroup', title: 'G' }),
  );
  await handleMyChatMember(deps, memberUpdate(OWNER, { status: 'kicked', user: BOT }));
  await handleMyChatMember(deps, memberUpdate(OWNER, { status: 'left', user: BOT }));
  assert.equal((await store.listChannels(deps.db)).length, 0);
  assert.equal(deps.api.calls.length, 0);
});

test('a failed owner notification does not undo the registration', async () => {
  const deps = makeDeps();
  deps.api.on('sendMessage', () => {
    throw new FakeBotApiError('sendMessage', 403, 'Forbidden: bot was blocked by the user');
  });
  await handleMyChatMember(deps, memberUpdate(OWNER, adminMember()));
  assert.ok(await store.getChannel(deps.db, -1001));
});
