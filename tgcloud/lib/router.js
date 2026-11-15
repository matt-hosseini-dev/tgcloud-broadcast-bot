// Entry points for the handlers: dedupe, authorization, command and button
// parsing, and dispatch to the feature modules. Handlers stay one line.
import * as store from './store.js';
import { resolveRole } from './auth.js';
import { addToDraft, cancelDraftById, cancelOpenDraft } from './drafts.js';
import { publishDraft, retryFailed } from './broadcast.js';
import { addChannel, channelsView, handleMyChatMember, removeChannelById } from './channels.js';
import {
  addBroadcasterById,
  addBroadcasterFromForward,
  broadcastersView,
  removeBroadcasterById,
} from './broadcasters.js';
import { helpText } from './report.js';

const DAY = 86_400;
/** processed_updates rows are kept this long. */
const DEDUPE_TTL = 7 * DAY;
/** /addbroadcaster waits this long for the forwarded message. */
const PENDING_TTL = 10 * 60;
const ADD_BROADCASTER = 'add_broadcaster';
const ONLY_OWNERS = 'Only owners can manage channels and broadcasters.';

/** @returns {{ command: string, args: string } | null} */
export function parseCommand(message) {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(message?.text ?? '');
  return m ? { command: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

const CALLBACK = /^(pub|can|retry|rmch|rmbc):(-?\d+)$/;

/** @returns {{ action: string, id: number } | null} */
export function parseCallbackData(data) {
  const m = CALLBACK.exec(data ?? '');
  return m ? { action: m[1], id: Number(m[2]) } : null;
}

/** False if this update was already handled (Telegram redelivery). */
async function firstSeen(deps, update) {
  const id = update?.update_id;
  if (id == null) return true;
  const fresh = await store.markUpdateProcessed(deps.db, id, deps.now());
  if (fresh && id % 500 === 0) await store.pruneProcessedUpdates(deps.db, deps.now() - DEDUPE_TTL);
  return fresh;
}

const reply = (deps, message, text) => deps.api.sendMessage({ chat_id: message.chat.id, text });
/** Sends a { text, reply_markup } view. */
const replyView = (deps, message, view) =>
  deps.api.sendMessage({ chat_id: message.chat.id, ...view });

// ---- messages ----

const OWNER_COMMANDS = new Set(['channels', 'addchannel', 'broadcasters', 'addbroadcaster']);

async function runCommand(deps, message, role, { command, args }) {
  const userId = message.from.id;
  if (OWNER_COMMANDS.has(command) && role !== 'owner') return reply(deps, message, ONLY_OWNERS);
  switch (command) {
    case 'start':
    case 'help':
      return reply(deps, message, helpText(role));
    case 'cancel': {
      const hadPending = await store.clearPendingAction(deps.db, userId);
      const cancelled = await cancelOpenDraft(deps, userId);
      return reply(deps, message, cancelled || hadPending ? 'Cancelled.' : 'Nothing to cancel.');
    }
    case 'channels':
      return replyView(deps, message, await channelsView(deps));
    case 'broadcasters':
      return replyView(deps, message, await broadcastersView(deps));
    case 'addchannel': {
      const r = await addChannel(deps, { ref: args, addedBy: userId });
      const text = r.ok
        ? `✅ Channel "${r.channel.title}" ${r.created ? 'added' : 'updated'}.`
        : r.error;
      return reply(deps, message, text);
    }
    case 'addbroadcaster': {
      if (!args) {
        await store.setPendingAction(deps.db, {
          userId,
          action: ADD_BROADCASTER,
          now: deps.now(),
        });
        return reply(
          deps,
          message,
          'Forward me a message from the person you want to add (within 10 minutes). /cancel to stop.',
        );
      }
      return reply(
        deps,
        message,
        broadcasterResult(await addBroadcasterById(deps, { ref: args, addedBy: userId })),
      );
    }
    default:
      return null;
  }
}

function broadcasterResult(r) {
  if (!r.ok) return r.error;
  const who = r.name ? `${r.name} (${r.userId})` : String(r.userId);
  return r.created ? `✅ ${who} added as broadcaster.` : `${who} is already a broadcaster.`;
}

const KNOWN_COMMANDS = new Set(['start', 'help', 'cancel', ...OWNER_COMMANDS]);
const isForward = (message) => Boolean(message.forward_origin ?? message.forward_from);

/** handlers/message: a Message, plus the full Update for dedupe. */
export async function onMessage(deps, message, update) {
  if (message?.chat?.type !== 'private' || !message.from) return;
  if (!(await firstSeen(deps, update))) return;
  const role = await resolveRole(deps, message.from.id);
  if (!role) return;

  const cmd = parseCommand(message);
  if (cmd && KNOWN_COMMANDS.has(cmd.command)) {
    await runCommand(deps, message, role, cmd);
    return;
  }
  if (
    role === 'owner' &&
    isForward(message) &&
    (await store.takePendingAction(deps.db, {
      userId: message.from.id,
      action: ADD_BROADCASTER,
      since: deps.now() - PENDING_TTL,
    }))
  ) {
    const r = await addBroadcasterFromForward(deps, { message, addedBy: message.from.id });
    await reply(deps, message, broadcasterResult(r));
    return;
  }
  // Anything else, including unknown /commands, is content for the draft.
  await addToDraft(deps, message);
}

// ---- buttons ----

const REASONS = {
  not_open: 'This draft was already published or cancelled.',
  no_channels: 'No channels yet. An owner can add one with /addchannel.',
  empty: 'This draft is empty.',
  not_found: 'This broadcast no longer exists.',
  not_allowed: 'Only the author or an owner can retry.',
  nothing_to_retry: 'Nothing to retry.',
};

async function refreshList(deps, query, view) {
  if (!query.message) return;
  try {
    await deps.api.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      ...view,
    });
  } catch (err) {
    console.warn('list refresh failed', err?.description ?? err);
  }
}

/** handlers/callback_query: a CallbackQuery, plus the full Update for dedupe. */
export async function onCallbackQuery(deps, query, update) {
  let answered = false;
  const answer = async (text) => {
    if (answered) return;
    answered = true;
    try {
      await deps.api.answerCallbackQuery({
        callback_query_id: query.id,
        ...(text ? { text } : {}),
      });
    } catch (err) {
      console.warn('answerCallbackQuery failed', err?.description ?? err);
    }
  };

  if (!(await firstSeen(deps, update))) return;
  const userId = query.from?.id;
  const role = await resolveRole(deps, userId);
  const parsed = parseCallbackData(query.data);
  if (!role || !parsed) return answer();

  const { action, id } = parsed;
  if ((action === 'rmch' || action === 'rmbc') && role !== 'owner') return answer(ONLY_OWNERS);
  switch (action) {
    case 'pub': {
      const r = await publishDraft(deps, {
        draftId: id,
        userId,
        onStarted: () => answer('Publishing…'),
      });
      return answer(r.ok ? undefined : REASONS[r.reason]);
    }
    case 'can': {
      const ok = await cancelDraftById(deps, { draftId: id, userId });
      return answer(ok ? 'Cancelled.' : REASONS.not_open);
    }
    case 'retry': {
      const r = await retryFailed(deps, {
        broadcastId: id,
        userId,
        onStarted: () => answer('Retrying…'),
      });
      return answer(r.ok ? undefined : REASONS[r.reason]);
    }
    case 'rmch': {
      const ok = await removeChannelById(deps, id);
      await refreshList(deps, query, await channelsView(deps));
      return answer(ok ? 'Removed.' : 'Already removed.');
    }
    case 'rmbc': {
      const ok = await removeBroadcasterById(deps, id);
      await refreshList(deps, query, await broadcastersView(deps));
      return answer(ok ? 'Removed.' : 'Already removed.');
    }
    default:
      return answer();
  }
}

// ---- membership ----

/** handlers/my_chat_member: a ChatMemberUpdated, plus the full Update for dedupe. */
export async function onMyChatMember(deps, chatMemberUpdated, update) {
  if (!(await firstSeen(deps, update))) return;
  await handleMyChatMember(deps, chatMemberUpdated);
}
