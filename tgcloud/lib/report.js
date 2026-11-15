// Texts and keyboards shown to users. Kept short. Plain text (no parse_mode),
// so titles and Bot API error descriptions never need escaping.

/** Cuts to n code points (never splits an emoji). */
export function clip(s, n) {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
}

export const TYPE_ICON = { channel: '📢', group: '👥', supergroup: '👥', private: '👤' };
const icon = (type) => TYPE_ICON[type] ?? '📢';

// ---- drafts ----

export const DRAFT_STARTED = '📝 Draft started. Add more or tap Publish.';
export const DRAFT_CANCELLED = '🗑 Cancelled.';
export const DRAFT_EXPIRED = '⌛ Draft expired (idle 1h).';

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

/** Publish checklist: every target with a tick, All/None, then Send. */
export function checklistView({ draftId, targets, excluded }) {
  const selected = targets.filter((t) => !excluded.has(t.chat_id)).length;
  const rows = targets.map((t) => [
    {
      text: `${excluded.has(t.chat_id) ? '⬜️' : '✅'} ${icon(t.chat_type)} ${clip(t.title, 40)}`,
      callback_data: `tg:${draftId}:${t.chat_id}`,
    },
  ]);
  const anyExcluded = excluded.size > 0 && targets.some((t) => excluded.has(t.chat_id));
  rows.push([{ text: anyExcluded ? '☑️ All' : '⬜️ None', callback_data: `all:${draftId}` }]);
  rows.push([
    { text: `📤 Send (${selected})`, callback_data: `send:${draftId}` },
    { text: '✖️ Cancel', callback_data: `can:${draftId}` },
  ]);
  return {
    text: `Send to ${selected}/${targets.length}:`,
    reply_markup: { inline_keyboard: rows },
  };
}

// ---- publishing and report ----

export const PUBLISHING = '⏳ Sending…';
export const RETRYING = '⏳ Retrying…';

const retryKeyboard = (broadcastId) => [
  [{ text: '🔁 Retry', callback_data: `retry:${broadcastId}` }],
];

/** Shown while sending. Its Retry button recovers a run that was interrupted. */
export function progressView(broadcastId, text) {
  return {
    text: `${text}\nStuck? Tap Retry.`,
    reply_markup: { inline_keyboard: retryKeyboard(broadcastId) },
  };
}

const MAX_TEXT = 4096;
const MAX_ERROR = 120;
const FINAL = new Set(['sent', 'partial', 'skipped']);

function deliveryLine(d, total) {
  const title = d.channel_title;
  switch (d.status) {
    case 'sent':
      return `✅ ${title}`;
    case 'partial':
      return `⚠️ ${title}: ${d.copied}/${total} copied`;
    case 'skipped':
      return `⏭ ${title}: ${clip(d.error ?? 'skipped', MAX_ERROR)}`;
    case 'failed':
      return `❌ ${title}: ${clip(d.error ?? 'failed', MAX_ERROR)}`;
    default: // pending, retrying:<token>
      return `⏳ ${title}`;
  }
}

/**
 * The per-target report that replaces the control message after publishing.
 * @param {{ broadcastId: number, total: number, deliveries: Array<{ channel_title: string, status: string, copied: number, error: string | null }> }} r
 */
export function renderReport({ broadcastId, total, deliveries }) {
  const delivered = deliveries.filter((d) => d.status === 'sent' || d.status === 'partial').length;
  const header = `📣 Sent ${delivered}/${deliveries.length}`;
  const lines = [header, ''];
  let length = header.length + 1;
  for (const [i, d] of deliveries.entries()) {
    const line = deliveryLine(d, total);
    if (length + line.length + 1 > MAX_TEXT - 40) {
      lines.push(`…and ${deliveries.length - i} more`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  const unfinished = deliveries.some((d) => !FINAL.has(d.status));
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: unfinished ? retryKeyboard(broadcastId) : [] },
  };
}

// ---- owner keyboard ----

export const TARGETS_BUTTON = '📋 Targets';

/** Picker request ids, echoed back in users_shared / chat_shared. */
export const REQUEST = { users: 1, group: 2, channel: 3 };

// ChatAdministratorRights: the non-optional fields must all be present.
const POST_RIGHTS = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_send_welcome_messages: false,
  can_post_messages: true,
};

/** Persistent reply keyboard for owners: native pickers to add targets. */
export function ownerKeyboard() {
  return {
    keyboard: [
      [
        {
          text: '👤 User',
          request_users: {
            request_id: REQUEST.users,
            user_is_bot: false,
            max_quantity: 10,
            request_name: true,
            request_username: true,
          },
        },
        {
          text: '👥 Group',
          request_chat: {
            request_id: REQUEST.group,
            chat_is_channel: false,
            bot_is_member: true,
            request_title: true,
            request_username: true,
          },
        },
        {
          text: '📢 Channel',
          request_chat: {
            request_id: REQUEST.channel,
            chat_is_channel: true,
            user_administrator_rights: POST_RIGHTS,
            bot_administrator_rights: POST_RIGHTS,
            request_title: true,
            request_username: true,
          },
        },
      ],
      [{ text: TARGETS_BUTTON }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Send a post…',
  };
}

// ---- help ----

/** @param {'owner' | 'broadcaster'} role */
export function helpText(role) {
  const base = 'Send a post, then tap Publish.\n/cancel drops the draft.';
  if (role !== 'owner') return base;
  return (
    `${base}\n\n` +
    '👤 👥 📢 add targets · 📋 lists them\n' +
    '/broadcasters · /addbroadcaster <id>'
  );
}
