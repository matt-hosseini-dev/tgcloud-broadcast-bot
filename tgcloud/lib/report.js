// Texts and inline keyboards shown to users. Plain text (no parse_mode), so
// channel titles and Bot API error descriptions never need escaping.

export const DRAFT_STARTED =
  '📝 New post started. Everything you send now is added to it (albums stay grouped).\n' +
  'Press Publish to send it to all channels, or Cancel to discard it.';

export const DRAFT_CANCELLED = '🗑 Draft cancelled. Nothing was published.';

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
