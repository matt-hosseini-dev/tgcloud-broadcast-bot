// Broadcaster management (owners only). Broadcasters can publish; only owners
// manage channels and broadcasters.
import * as store from './store.js';
import { isOwner } from './auth.js';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "First Last @username" from a User or private Chat, or null. */
export function displayName(user) {
  if (!user) return null;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const handle = user.username ? `@${user.username}` : '';
  return [name, handle].filter(Boolean).join(' ') || null;
}

async function save(deps, { userId, name, addedBy }) {
  if (isOwner(deps, userId)) return { ok: false, error: 'That user is already an owner.' };
  const created = await store.addBroadcaster(deps.db, { userId, name, addedBy, now: deps.now() });
  return { ok: true, created, userId, name };
}

/** /addbroadcaster <user id> */
export async function addBroadcasterById(deps, { ref, addedBy }) {
  const raw = String(ref ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      error:
        'Send a numeric user id, e.g. /addbroadcaster 123456789.\n' +
        'Or send /addbroadcaster alone, then forward me a message from the person.',
    };
  }
  const userId = Number(raw);
  let name;
  try {
    // Only works if the person has talked to the bot; the id is enough otherwise.
    name = displayName(await deps.api.getChat({ chat_id: userId }));
  } catch {
    name = null;
  }
  return save(deps, { userId, name, addedBy });
}

/** A forwarded message after /addbroadcaster: adds the original sender. */
export async function addBroadcasterFromForward(deps, { message, addedBy }) {
  const origin = message.forward_origin;
  if (origin?.type === 'hidden_user') {
    return {
      ok: false,
      error:
        'This person hides their account when forwarded. Ask them for their numeric user id ' +
        '(for example from @userinfobot) and use /addbroadcaster <id>.',
    };
  }
  const user = origin ? (origin.type === 'user' ? origin.sender_user : null) : message.forward_from;
  if (!user) {
    return { ok: false, error: 'Forward a message written by a person, not a channel or group.' };
  }
  if (user.is_bot) return { ok: false, error: 'That is a bot. Broadcasters must be people.' };
  return save(deps, { userId: user.id, name: displayName(user), addedBy });
}

export function removeBroadcasterById(deps, userId) {
  return store.removeBroadcaster(deps.db, userId);
}

/** /broadcasters: the list with one remove button per broadcaster. */
export async function broadcastersView(deps) {
  const list = await store.listBroadcasters(deps.db);
  if (list.length === 0) {
    return {
      text:
        'No broadcasters yet. Owners can always publish.\n\n' +
        'Add one with /addbroadcaster <user id>, or send /addbroadcaster and forward a message from them.',
      reply_markup: { inline_keyboard: [] },
    };
  }
  const label = (b) => (b.name ? `${b.name} (${b.user_id})` : String(b.user_id));
  return {
    text: `👥 Broadcasters (${list.length}):\n\n${list.map((b, i) => `${i + 1}. ${label(b)}`).join('\n')}`,
    reply_markup: {
      inline_keyboard: list.map((b) => [
        {
          text: `✖ Remove ${clip(b.name ?? String(b.user_id), 40)}`,
          callback_data: `rmbc:${b.user_id}`,
        },
      ]),
    },
  };
}
