import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderReport,
  checklistView,
  ownerKeyboard,
  helpText,
  TARGETS_BUTTON,
  clip,
} from '../tgcloud/lib/report.js';

const d = (title, status, extra = {}) => ({
  channel_title: title,
  status,
  copied: 0,
  error: null,
  ...extra,
});

test('renderReport is short and offers Retry only when something is unfinished', () => {
  const r = renderReport({
    broadcastId: 7,
    total: 3,
    deliveries: [
      d('A', 'sent', { copied: 3 }),
      d('B', 'partial', { copied: 2 }),
      d('C', 'failed', { error: 'Forbidden' }),
      d('D', 'skipped', { error: 'removed' }),
      d('E', 'retrying:x'),
      d('F', 'pending'),
    ],
  });
  assert.equal(
    r.text,
    [
      '📣 Sent 2/6',
      '',
      '✅ A',
      '⚠️ B: 2/3 copied',
      '❌ C: Forbidden',
      '⏭ D: removed',
      '⏳ E',
      '⏳ F',
    ].join('\n'),
  );
  assert.deepEqual(r.reply_markup.inline_keyboard, [
    [{ text: '🔁 Retry', callback_data: 'retry:7' }],
  ]);
  const done = renderReport({
    broadcastId: 7,
    total: 1,
    deliveries: [d('A', 'sent', { copied: 1 })],
  });
  assert.deepEqual(done.reply_markup.inline_keyboard, []);
});

test('renderReport keeps the text within the Telegram message limit', () => {
  const deliveries = Array.from({ length: 200 }, (_, i) =>
    d(`Channel ${i}`, 'failed', { error: 'x'.repeat(500) }),
  );
  const r = renderReport({ broadcastId: 1, total: 1, deliveries });
  assert.ok(r.text.length <= 4096, `length ${r.text.length}`);
  assert.match(r.text, /…and \d+ more/);
});

test('checklistView ticks selected targets and counts them on Send', () => {
  const targets = [
    { chat_id: -1001, chat_type: 'channel', title: 'News' },
    { chat_id: -5, chat_type: 'supergroup', title: 'Team' },
    { chat_id: 77, chat_type: 'private', title: 'Ann' },
  ];
  const v = checklistView({ draftId: 3, targets, excluded: new Set([-5]) });
  assert.equal(v.text, 'Send to 2/3:');
  assert.deepEqual(v.reply_markup.inline_keyboard, [
    [{ text: '✅ 📢 News', callback_data: 'tg:3:-1001' }],
    [{ text: '⬜️ 👥 Team', callback_data: 'tg:3:-5' }],
    [{ text: '✅ 👤 Ann', callback_data: 'tg:3:77' }],
    [{ text: '☑️ All', callback_data: 'all:3' }],
    [
      { text: '📤 Send (2)', callback_data: 'send:3' },
      { text: '✖️ Cancel', callback_data: 'can:3' },
    ],
  ]);
  const none = checklistView({ draftId: 3, targets, excluded: new Set() });
  assert.equal(none.reply_markup.inline_keyboard[3][0].text, '⬜️ None');
});

test('ownerKeyboard opens the native user, group and channel pickers', () => {
  const k = ownerKeyboard();
  const [user, group, channel] = k.keyboard[0];
  assert.equal(user.request_users.max_quantity, 10);
  assert.equal(user.request_users.user_is_bot, false);
  assert.equal(group.request_chat.chat_is_channel, false);
  assert.equal(group.request_chat.bot_is_member, true);
  assert.equal(channel.request_chat.chat_is_channel, true);
  assert.equal(channel.request_chat.bot_administrator_rights.can_post_messages, true);
  assert.equal(channel.request_chat.user_administrator_rights.can_post_messages, true);
  assert.equal(
    new Set([user, group, channel].map((b) => (b.request_users ?? b.request_chat).request_id)).size,
    3,
  );
  assert.deepEqual(k.keyboard[1], [{ text: TARGETS_BUTTON }]);
  assert.equal(k.resize_keyboard, true);
  assert.equal(k.is_persistent, true);
});

test('help texts are short', () => {
  assert.ok(helpText('broadcaster').length < 120);
  assert.ok(helpText('owner').length < 300);
  assert.doesNotMatch(helpText('broadcaster'), /addbroadcaster/);
  assert.match(helpText('owner'), /addbroadcaster/);
});

test('clip never splits an emoji', () => {
  const s = `${'a'.repeat(38)}😀😀😀`;
  const c = clip(s, 40);
  assert.ok(c.isWellFormed());
  assert.equal([...c].length, 40);
});
