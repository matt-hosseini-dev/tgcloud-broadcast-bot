// Targets (owners only): channels, groups and users a post is copied to. Added
// from the native pickers (chat_shared / users_shared), with /add, or
// automatically when an owner adds the bot to a channel or group.
import * as store from './store.js';
import { isOwner } from './auth.js';
import { displayName } from './broadcasters.js';
import { TYPE_ICON, clip } from './report.js';

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const describe = (err) => err?.description ?? err?.message ?? String(err);
const GROUP_TYPES = new Set(['group', 'supergroup']);

/** Label used in replies and lists, e.g. "📢 News". */
export const label = (type, title) => `${TYPE_ICON[type] ?? '📢'} ${title}`;

/** -100…, "@name", "name", a t.me link or a number -> chat_id, or null. */
export function parseChatRef(raw) {
  if (typeof raw === 'number') return raw;
  const ref = String(raw ?? '').trim();
  if (/^-?\d+$/.test(ref)) return Number(ref);
  const name = ref.replace(/^(https?:\/\/)?t\.me\//i, '').replace(/^@/, '');
  return USERNAME.test(name) ? `@${name}` : null;
}

/** Whether a ChatMember lets the bot post in a chat of this type. */
export function canPost(member, chatType) {
  const status = member?.status;
  if (status === 'creator') return true;
  if (chatType === 'channel')
    return status === 'administrator' && member.can_post_messages === true;
  if (status === 'administrator' || status === 'member') return true;
  return (
    status === 'restricted' && member.is_member !== false && member.can_send_messages !== false
  );
}

function cannotPostText(chat, member) {
  if (chat.type !== 'channel') return `I can't post in ${chat.title}. Add me to it.`;
  return member?.status === 'administrator'
    ? `No "Post messages" right in ${chat.title}.`
    : `Make me an admin of ${chat.title} with "Post messages".`;
}

/**
 * Adds a channel or group after checking the bot can post there.
 * @returns {Promise<{ ok: true, created: boolean, target: object } | { ok: false, error: string }>}
 */
export async function addChatTarget(deps, { ref, addedBy }) {
  const { api, db } = deps;
  const chatId = parseChatRef(ref);
  if (chatId == null) return { ok: false, error: 'Usage: /add <@username or id>' };
  let chat;
  let member;
  try {
    chat = await api.getChat({ chat_id: chatId });
    if (chat.type === 'private') return { ok: false, error: 'Use 👤 User to add people.' };
    const me = await api.getMe();
    member = await api.getChatMember({ chat_id: chat.id, user_id: me.id });
  } catch (err) {
    return { ok: false, error: `Can't reach it: ${describe(err)}` };
  }
  if (!canPost(member, chat.type)) return { ok: false, error: cannotPostText(chat, member) };
  const created = await store.upsertTarget(db, {
    chatId: chat.id,
    chatType: chat.type,
    title: chat.title ?? String(chat.id),
    username: chat.username ?? null,
    addedBy,
    now: deps.now(),
  });
  return { ok: true, created, target: await store.getTarget(db, chat.id) };
}

/**
 * Adds users shared from the 👤 picker. A user who never started the bot can't
 * receive posts yet; they are saved anyway and flagged.
 * @returns {Promise<Array<{ userId: number, name: string, created: boolean, reachable: boolean }>>}
 */
export async function addUserTargets(deps, { users, addedBy }) {
  const results = [];
  for (const u of users) {
    const name = displayName(u) ?? String(u.user_id);
    let reachable = true;
    try {
      await deps.api.getChat({ chat_id: u.user_id });
    } catch {
      reachable = false;
    }
    const created = await store.upsertTarget(deps.db, {
      chatId: u.user_id,
      chatType: 'private',
      title: name,
      username: u.username ?? null,
      addedBy,
      now: deps.now(),
    });
    results.push({ userId: u.user_id, name, created, reachable });
  }
  return results;
}

export function removeTargetById(deps, chatId) {
  return store.removeTarget(deps.db, chatId);
}

const MAX_LIST = 90;

/** 📋 Targets: the list with one remove button per target. */
export async function targetsView(deps) {
  const all = await store.listTargets(deps.db);
  if (all.length === 0) {
    return { text: 'No targets yet. Use 👤 👥 📢 below.', reply_markup: { inline_keyboard: [] } };
  }
  const shown = all.slice(0, MAX_LIST);
  const lines = shown.map((t) => {
    const handle = t.username && t.chat_type !== 'private' ? ` @${t.username}` : '';
    return `${label(t.chat_type, clip(t.title, 60))}${handle}`;
  });
  if (all.length > shown.length) lines.push(`…and ${all.length - shown.length} more`);
  return {
    text: `📋 Targets (${all.length})\n\n${lines.join('\n')}`,
    reply_markup: {
      inline_keyboard: shown.map((t) => [
        { text: `✖ ${clip(t.title, 40)}`, callback_data: `rmch:${t.chat_id}` },
      ]),
    },
  };
}

/**
 * my_chat_member: the bot's status changed in a chat. A channel or group is
 * registered only when an owner made the change, so strangers can't attach theirs.
 */
export async function handleMyChatMember(deps, update) {
  const { chat, from, new_chat_member: member } = update;
  if (chat?.type !== 'channel' && !GROUP_TYPES.has(chat?.type)) return;
  if (!isOwner(deps, from?.id)) return;
  const status = member?.status;
  if (status === 'left' || status === 'kicked') return;
  if (chat.type === 'channel' && status !== 'administrator' && status !== 'creator') return;

  const title = chat.title ?? String(chat.id);
  let text;
  if (canPost(member, chat.type)) {
    const created = await store.upsertTarget(deps.db, {
      chatId: chat.id,
      chatType: chat.type,
      title,
      username: chat.username ?? null,
      addedBy: from.id,
      now: deps.now(),
    });
    text = `${created ? '✅ Added' : '✅ Updated'}: ${label(chat.type, title)}`;
  } else {
    text = cannotPostText({ ...chat, title }, member);
  }
  try {
    await deps.api.sendMessage({ chat_id: from.id, text });
  } catch (err) {
    // The owner may never have started the bot; the registration still stands.
    console.warn('could not notify owner', describe(err));
  }
}
