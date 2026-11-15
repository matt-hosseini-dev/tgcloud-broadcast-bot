// Entry points for the handlers: dedupe, authorization, command and button
// parsing, and dispatch to the feature modules. Handlers stay one line.
import * as store from './store.js';
import { resolveRole } from './auth.js';
import { addToDraft, cancelDraftById, cancelOpenDraft } from './drafts.js';
import { publishDraft, retryFailed } from './broadcast.js';
import {
  addChatTarget,
  addUserTargets,
  handleMyChatMember,
  label,
  removeTargetById,
  targetsView,
} from './targets.js';
import { checklistFor, toggleAll, toggleTarget } from './checklist.js';
import {
  addBroadcasterById,
  addBroadcasterFromForward,
  broadcastersView,
  removeBroadcasterById,
} from './broadcasters.js';
import { TARGETS_BUTTON, helpText, ownerKeyboard } from './report.js';

const DAY = 86_400;
/** processed_updates rows are kept this long. */
const DEDUPE_TTL = 7 * DAY;
/** /addbroadcaster waits this long for the forwarded message. */
const PENDING_TTL = 10 * 60;
const ADD_BROADCASTER = 'add_broadcaster';
const ONLY_OWNERS = 'Owners only.';

/** @returns {{ command: string, args: string } | null} */
export function parseCommand(message) {
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(message?.text ?? '');
  return m ? { command: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null;
}

const CALLBACK = /^(pub|can|send|all|retry|rmch|rmbc):(-?\d+)$/;
const TOGGLE = /^tg:(\d+):(-?\d+)$/;

/** @returns {{ action: string, id: number, chatId?: number } | null} */
export function parseCallbackData(data) {
  const t = TOGGLE.exec(data ?? '');
  if (t) return { action: 'tg', id: Number(t[1]), chatId: Number(t[2]) };
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

const OWNER_COMMANDS = new Set([
  'targets',
  'channels',
  'add',
  'addchannel',
  'broadcasters',
  'addbroadcaster',
]);
const KNOWN_COMMANDS = new Set(['start', 'help', 'cancel', ...OWNER_COMMANDS]);

async function runCommand(deps, message, role, { command, args }) {
  const userId = message.from.id;
  if (OWNER_COMMANDS.has(command) && role !== 'owner') return reply(deps, message, ONLY_OWNERS);
  switch (command) {
    case 'start':
    case 'help':
      return deps.api.sendMessage({
        chat_id: message.chat.id,
        text: helpText(role),
        ...(role === 'owner' ? { reply_markup: ownerKeyboard() } : {}),
      });
    case 'cancel': {
      const hadPending = await store.clearPendingAction(deps.db, userId);
      const cancelled = await cancelOpenDraft(deps, userId);
      return reply(deps, message, cancelled || hadPending ? 'Cancelled.' : 'Nothing to cancel.');
    }
    case 'targets':
    case 'channels':
      return replyView(deps, message, await targetsView(deps));
    case 'broadcasters':
      return replyView(deps, message, await broadcastersView(deps));
    case 'add':
    case 'addchannel':
      return reply(
        deps,
        message,
        chatTargetResult(await addChatTarget(deps, { ref: args, addedBy: userId })),
      );
    case 'addbroadcaster': {
      if (!args) {
        await store.setPendingAction(deps.db, { userId, action: ADD_BROADCASTER, now: deps.now() });
        return reply(deps, message, 'Forward me a message from them (10 min). /cancel to stop.');
      }
      const r = await addBroadcasterById(deps, { ref: args, addedBy: userId });
      return reply(deps, message, broadcasterResult(r));
    }
    default:
      return null;
  }
}

function chatTargetResult(r) {
  if (!r.ok) return r.error;
  return `${r.created ? '✅ Added' : 'Already added'}: ${label(r.target.chat_type, r.target.title)}`;
}

function broadcasterResult(r) {
  if (!r.ok) return r.error;
  const who = r.name ? `${r.name} (${r.userId})` : String(r.userId);
  return r.created ? `✅ Broadcaster: ${who}` : `Already a broadcaster: ${who}`;
}

/** users_shared / chat_shared from the owner keyboard's pickers. */
async function handleShared(deps, message) {
  const addedBy = message.from.id;
  if (message.chat_shared) {
    const r = await addChatTarget(deps, { ref: message.chat_shared.chat_id, addedBy });
    return reply(deps, message, chatTargetResult(r));
  }
  const results = await addUserTargets(deps, { users: message.users_shared.users ?? [], addedBy });
  const lines = results.map(
    (u) =>
      `${u.created ? '✅ Added' : 'Already added'}: ${label('private', u.name)}` +
      (u.reachable ? '' : ' (must /start me first)'),
  );
  return reply(deps, message, lines.join('\n') || 'Nobody selected.');
}

const isForward = (message) => Boolean(message.forward_origin ?? message.forward_from);

/** handlers/message: a Message, plus the full Update for dedupe. */
export async function onMessage(deps, message, update) {
  if (message?.chat?.type !== 'private' || !message.from) return;
  if (!(await firstSeen(deps, update))) return;
  const role = await resolveRole(deps, message.from.id);
  if (!role) return;

  if (message.users_shared || message.chat_shared) {
    if (role === 'owner') await handleShared(deps, message);
    return; // service messages are never draft content
  }
  const cmd =
    message.text === TARGETS_BUTTON ? { command: 'targets', args: '' } : parseCommand(message);
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
  not_open: 'Already sent or cancelled.',
  no_targets: 'No targets yet.',
  none_selected: 'Tick at least one.',
  empty: 'Draft is empty.',
  not_found: 'Not found.',
  not_allowed: 'Not allowed.',
  nothing_to_retry: 'Nothing to retry.',
};

/** Replaces the tapped message (control message or list) with a new view. */
async function editTapped(deps, query, view) {
  if (!query.message) return;
  try {
    await deps.api.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      ...view,
    });
  } catch (err) {
    const why = err?.description ?? String(err);
    if (!/message is not modified/i.test(why)) console.warn('edit failed', why);
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
  const showChecklist = async (r) => {
    if (r.ok) await editTapped(deps, query, r.view);
    return answer(r.ok ? undefined : REASONS[r.reason]);
  };

  switch (action) {
    case 'pub':
      return showChecklist(await checklistFor(deps, { draftId: id, userId }));
    case 'tg':
      return showChecklist(
        await toggleTarget(deps, { draftId: id, userId, chatId: parsed.chatId }),
      );
    case 'all':
      return showChecklist(await toggleAll(deps, { draftId: id, userId }));
    case 'send': {
      const r = await publishDraft(deps, {
        draftId: id,
        userId,
        onStarted: () => answer('Sending…'),
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
      const ok = await removeTargetById(deps, id);
      await editTapped(deps, query, await targetsView(deps));
      return answer(ok ? 'Removed.' : 'Already removed.');
    }
    case 'rmbc': {
      const ok = await removeBroadcasterById(deps, id);
      await editTapped(deps, query, await broadcastersView(deps));
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
