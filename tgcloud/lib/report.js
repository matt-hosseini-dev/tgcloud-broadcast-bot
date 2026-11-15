// Texts and inline keyboards shown to users. Plain text (no parse_mode), so
// channel titles and Bot API error descriptions never need escaping.

export const DRAFT_STARTED =
  '📝 New post started. Everything you send now is added to it (albums stay grouped).\n' +
  'Press Publish to send it to all channels, or Cancel to discard it.';

export const DRAFT_CANCELLED = '🗑 Draft cancelled. Nothing was published.';

export const DRAFT_EXPIRED =
  '⌛ This draft expired after an hour without new messages and was discarded. Nothing was published.';

/** Publish / Cancel buttons for a draft's control message. */
export function draftKeyboard(draftId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Publish', callback_data: `pub:${draftId}` },
        { text: '✖️ Cancel', callback_data: `can:${draftId}` },
      ],
    ],
  };
}

export const PUBLISHING = '⏳ Publishing…';
export const RETRYING = '⏳ Retrying…';
const IN_PROGRESS_HINT =
  'If this message has not turned into a report after a few minutes, press Retry failed.';

const retryKeyboard = (broadcastId) => [
  [{ text: '🔁 Retry failed', callback_data: `retry:${broadcastId}` }],
];

/** Shown while sending. Its Retry button recovers a run that was interrupted. */
export function progressView(broadcastId, text) {
  return {
    text: `${text}\n\n${IN_PROGRESS_HINT}`,
    reply_markup: { inline_keyboard: retryKeyboard(broadcastId) },
  };
}

const MAX_TEXT = 4096;
const MAX_ERROR = 200;

const FINAL = new Set(['sent', 'partial', 'skipped']);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function deliveryLine(d, total) {
  const title = d.channel_title;
  switch (d.status) {
    case 'sent':
      return `✅ ${title}`;
    case 'partial':
      return `⚠️ ${title}: ${d.copied} of ${total} messages copied (some message types cannot be copied)`;
    case 'skipped':
      return `⏭ ${title}: ${clip(d.error ?? 'skipped', MAX_ERROR)}`;
    case 'pending':
      return `⏳ ${title}: sending…`;
    default:
      if (d.status.startsWith('retrying')) return `⏳ ${title}: retrying…`;
      return `❌ ${title}: ${clip(d.error ?? 'failed', MAX_ERROR)}`;
  }
}

/**
 * The per-channel report that replaces the control message after publishing.
 * @param {{ broadcastId: number, total: number, deliveries: Array<{ channel_title: string, status: string, copied: number, error: string | null }> }} r
 * @returns {{ text: string, reply_markup: { inline_keyboard: object[][] } }}
 */
export function renderReport({ broadcastId, total, deliveries }) {
  const delivered = deliveries.filter((d) => d.status === 'sent' || d.status === 'partial').length;
  const header = `📣 Sent to ${delivered} of ${deliveries.length} channels.`;
  const lines = [header, ''];
  let length = header.length + 1;
  for (const [i, d] of deliveries.entries()) {
    const line = deliveryLine(d, total);
    const rest = deliveries.length - i;
    if (length + line.length + 1 > MAX_TEXT - 40) {
      lines.push(`…and ${rest} more`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  // failed, or never finished (pending / retrying after an error): retry can pick them up.
  const unfinished = deliveries.some((d) => !FINAL.has(d.status));
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: unfinished ? retryKeyboard(broadcastId) : [] },
  };
}

const BROADCASTER_HELP = [
  '📣 Send me a post: text, photo, video, document or an album. Send several',
  'messages to publish them together. Then press ✅ Publish to copy it to every',
  'channel, or ✖️ Cancel to discard it.',
  '',
  'After publishing you get a report per channel, with 🔁 Retry failed if any',
  'channel could not be reached.',
  '',
  '/cancel discards the current draft.',
];

const OWNER_HELP = [
  '',
  'Owner commands:',
  '/channels list channels (with remove buttons)',
  '/addchannel <@username or id> add a channel the bot can post in',
  '/broadcasters list broadcasters (with remove buttons)',
  '/addbroadcaster <user id> allow someone to publish',
  '/addbroadcaster then forward a message from them, if you do not know the id',
  '',
  'Making the bot an admin of a channel (with "Post messages") adds it automatically.',
];

/** @param {'owner' | 'broadcaster'} role */
export function helpText(role) {
  return [...BROADCASTER_HELP, ...(role === 'owner' ? OWNER_HELP : [])].join('\n');
}
