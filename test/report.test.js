import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../tgcloud/lib/report.js';

const d = (title, status, extra = {}) => ({
  channel_title: title,
  status,
  copied: 0,
  error: null,
  ...extra,
});

test('renderReport summarises statuses and offers Retry only for failures', () => {
  const r = renderReport({
    broadcastId: 7,
    total: 3,
    deliveries: [
      d('A', 'sent', { copied: 3 }),
      d('B', 'partial', { copied: 2 }),
      d('C', 'failed', { error: 'Forbidden' }),
      d('D', 'skipped', { error: 'channel was removed from the bot' }),
      d('E', 'retrying'),
    ],
  });
  assert.equal(
    r.text,
    [
      '📣 Sent to 2 of 5 channels.',
      '',
      '✅ A',
      '⚠️ B: 2 of 3 messages copied (some message types cannot be copied)',
      '❌ C: Forbidden',
      '⏭ D: channel was removed from the bot',
      '⏳ E: retrying…',
    ].join('\n'),
  );
  assert.deepEqual(r.reply_markup.inline_keyboard, [
    [{ text: '🔁 Retry failed', callback_data: 'retry:7' }],
  ]);
});

test('renderReport keeps the text within the Telegram message limit', () => {
  const deliveries = Array.from({ length: 200 }, (_, i) =>
    d(`Channel ${i}`, 'failed', { error: 'x'.repeat(500) }),
  );
  const r = renderReport({ broadcastId: 1, total: 1, deliveries });
  assert.ok(r.text.length <= 4096, `length ${r.text.length}`);
  assert.match(r.text, /…and \d+ more/);
});
