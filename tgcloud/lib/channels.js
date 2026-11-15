// Channel management (owners only): add with verification, list, remove, and
// automatic registration when an owner makes the bot a channel admin.
import * as store from './store.js';
import { isOwner } from './auth.js';

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const describe = (err) => err?.description ?? err?.message ?? String(err);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "-100…", "@name", "name" or a t.me link -> chat_id for the Bot API, or null. */
export function parseChatRef(raw) {
  const ref = String(raw ?? '').trim();
  if (/^-?\d+$/.test(ref)) return Number(ref);
  const name = ref.replace(/^(https?:\/\/)?t\.me\//i, '').replace(/^@/, '');
  return USERNAME.test(name) ? `@${name}` : null;
}

/** Whether a ChatMember lets the bot post in a channel. */
export function canPost(member) {
  if (member?.status === 'creator') return true;
  return member?.status === 'administrator' && member.can_post_messages === true;
}

function missingRightsText(title, member) {
  return member?.status === 'administrator'
    ? `I'm an admin in "${title}" but without the "Post messages" right. Enable it and try again.`
    : `I'm not an admin in "${title}". Add me as an admin with the "Post messages" right.`;
}

/**
 * /addchannel <ref>. Checks with getChat and getChatMember that the chat is a
 * channel the bot can post in, then saves it.
 * @returns {Promise<{ ok: true, created: boolean, channel: object } | { ok: false, error: string }>}
 */
export async function addChannel(deps, { ref, addedBy }) {
  const { api, db } = deps;
  const chatId = parseChatRef(ref);
  if (chatId == null) {
    return { ok: false, error: 'Usage: /addchannel <@username or -100… channel id>' };
  }
  let chat;
  let member;
  try {
    chat = await api.getChat({ chat_id: chatId });
    if (chat.type !== 'channel') {
      return { ok: false, error: `"${chat.title ?? chatId}" is a ${chat.type}, not a channel.` };
    }
    const me = await api.getMe();
    member = await api.getChatMember({ chat_id: chat.id, user_id: me.id });
  } catch (err) {
    return {
      ok: false,
      error: `I can't reach that channel (${describe(err)}). Add me to it as an admin first.`,
    };
  }
  if (!canPost(member)) return { ok: false, error: missingRightsText(chat.title, member) };

  const created = await store.upsertTarget(db, {
    chatId: chat.id,
    title: chat.title ?? String(chat.id),
    username: chat.username ?? null,
    addedBy,
    now: deps.now(),
  });
  return { ok: true, created, channel: await store.getTarget(db, chat.id) };
}

export function removeChannelById(deps, chatId) {
  return store.removeTarget(deps.db, chatId);
}

/** /channels: the list with one remove button per channel. */
export async function channelsView(deps) {
  const channels = await store.listTargets(deps.db);
  if (channels.length === 0) {
    return {
      text:
        'No channels yet.\n\nMake me an admin (with "Post messages") of a channel and it is added ' +
        'automatically, or use /addchannel <@username or id>.',
      reply_markup: { inline_keyboard: [] },
    };
  }
  const lines = channels.map((c, i) => {
    const handle = c.username ? ` @${c.username}` : '';
    const paused = c.enabled ? '' : ' (paused)';
    return `${i + 1}. ${c.title}${handle} (${c.chat_id})${paused}`;
  });
  return {
    text: `📢 Channels (${channels.length}):\n\n${lines.join('\n')}`,
    reply_markup: {
      inline_keyboard: channels.map((c) => [
        { text: `✖ Remove ${clip(c.title, 40)}`, callback_data: `rmch:${c.chat_id}` },
      ]),
    },
  };
}

/**
 * my_chat_member: the bot's status changed in a chat. A channel is registered
 * only when an owner made the change, so strangers cannot attach their channels.
 */
export async function handleMyChatMember(deps, update) {
  const { chat, from, new_chat_member: member } = update;
  if (chat?.type !== 'channel' || !isOwner(deps, from?.id)) return;
  if (member?.status !== 'administrator' && member?.status !== 'creator') return;

  const title = chat.title ?? String(chat.id);
  let text;
  if (canPost(member)) {
    const created = await store.upsertTarget(deps.db, {
      chatId: chat.id,
      title,
      username: chat.username ?? null,
      addedBy: from.id,
      now: deps.now(),
    });
    text = created
      ? `✅ Channel "${title}" added. New posts will be published there too.`
      : `✅ Channel "${title}" updated.`;
  } else {
    text = missingRightsText(title, member);
  }
  try {
    await deps.api.sendMessage({ chat_id: from.id, text });
  } catch (err) {
    // The owner may never have started the bot; the registration still stands.
    console.warn('could not notify owner', describe(err));
  }
}
