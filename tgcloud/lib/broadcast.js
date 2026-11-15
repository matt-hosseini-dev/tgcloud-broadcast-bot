// Fan-out: copy a draft to every enabled channel, classify each result, store
// it, and show the report. Retry re-sends only to the channels that failed.
import * as store from './store.js';
import { isOwner } from './auth.js';
import { editQuietly } from './drafts.js';
import { PUBLISHING, RETRYING, progressView, renderReport } from './report.js';

/** A 429 with a retry_after up to this many seconds is waited out once. */
export const MAX_RETRY_AFTER = 5;
/** copyMessages accepts at most 100 ids per call. */
export const MAX_IDS_PER_CALL = 100;
/**
 * A pending or retrying delivery untouched for this long belongs to a run that
 * was interrupted, and Retry may take it over.
 */
export const STALE_AFTER_SECONDS = 120;

const describe = (err) => err?.description ?? err?.message ?? String(err);

async function copyOnce(deps, params) {
  try {
    return await deps.api.copyMessages(params);
  } catch (err) {
    const wait = err?.parameters?.retry_after;
    if (err?.code !== 429 || !deps.sleep || !(wait <= MAX_RETRY_AFTER)) throw err;
    await deps.sleep(wait * 1000);
    return deps.api.copyMessages(params);
  }
}

/**
 * Copies messages to one channel. Never throws.
 * sent: every message copied; partial: Telegram skipped some (paid media, polls,
 * …); failed: the call failed, with the Bot API description.
 * @returns {Promise<{ status: 'sent' | 'partial' | 'failed', copied: number, error: string | null }>}
 */
export async function copyToChannel(deps, { fromChatId, chatId, messageIds }) {
  let copied = 0;
  try {
    for (let i = 0; i < messageIds.length; i += MAX_IDS_PER_CALL) {
      const result = await copyOnce(deps, {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_ids: messageIds.slice(i, i + MAX_IDS_PER_CALL),
      });
      copied += Array.isArray(result) ? result.length : 0;
    }
  } catch (err) {
    return { status: 'failed', copied, error: describe(err) };
  }
  return { status: copied === messageIds.length ? 'sent' : 'partial', copied, error: null };
}

/**
 * Delivers to the given channels concurrently. Each result is stored as soon as
 * that channel settles, so an interrupted run leaves an accurate record. Never throws.
 */
async function deliver(deps, broadcast, targets) {
  const settled = await Promise.allSettled(
    targets.map(async (t) => {
      const r = await copyToChannel(deps, {
        fromChatId: broadcast.chat_id,
        chatId: t.chatId,
        messageIds: broadcast.message_ids,
      });
      await store.upsertDelivery(deps.db, {
        broadcastId: broadcast.id,
        chatId: t.chatId,
        title: t.title,
        status: r.status,
        copied: r.copied,
        error: r.error,
        now: deps.now(),
      });
    }),
  );
  for (const s of settled) {
    if (s.status === 'rejected') console.error('delivery result not stored', describe(s.reason));
  }
}

async function showProgress(deps, broadcast, text) {
  if (!broadcast.control_message_id) return;
  await editQuietly(deps.api, {
    chat_id: broadcast.chat_id,
    message_id: broadcast.control_message_id,
    ...progressView(broadcast.id, text),
  });
}

/** Replaces the control message with the report; sends a new message if that fails. */
async function showReport(deps, broadcast) {
  const deliveries = await store.listDeliveries(deps.db, broadcast.id);
  const report = renderReport({
    broadcastId: broadcast.id,
    total: broadcast.message_ids.length,
    deliveries,
  });
  if (broadcast.control_message_id) {
    try {
      await deps.api.editMessageText({
        chat_id: broadcast.chat_id,
        message_id: broadcast.control_message_id,
        ...report,
      });
      return;
    } catch (err) {
      if (/message is not modified/i.test(describe(err))) return;
      console.warn('report edit failed, sending a new message', describe(err));
    }
  }
  await deps.api.sendMessage({ chat_id: broadcast.chat_id, ...report });
}

/**
 * Publish button. Claims the draft (so a double tap publishes once), copies it
 * to every enabled channel, and reports. `onStarted` runs right after the claim,
 * before the slow fan-out (the router uses it to answer the callback query).
 * @returns {Promise<{ ok: true, broadcastId: number } | { ok: false, reason: 'no_channels' | 'not_open' | 'empty' }>}
 */
export async function publishDraft(deps, { draftId, userId, onStarted }) {
  const { db } = deps;
  const channels = await store.listTargets(db, { enabledOnly: true });
  if (channels.length === 0) return { ok: false, reason: 'no_channels' };

  const draft = await store.getDraft(db, draftId);
  if (!draft || !(await store.claimDraft(db, { draftId, userId, now: deps.now() }))) {
    return { ok: false, reason: 'not_open' };
  }
  await onStarted?.();
  const messageIds = await store.listDraftMessageIds(db, draftId);
  if (messageIds.length === 0) {
    await store.setDraftStatus(db, { draftId, status: 'cancelled', now: deps.now() });
    return { ok: false, reason: 'empty' };
  }

  const broadcastId = await store.createBroadcast(db, {
    draftId,
    userId,
    chatId: draft.chat_id,
    messageIds,
    controlMessageId: draft.control_message_id,
    now: deps.now(),
  });
  const broadcast = await store.getBroadcast(db, broadcastId);
  const targets = channels.map((c) => ({ chatId: c.chat_id, title: c.title }));
  for (const t of targets) {
    await store.upsertDelivery(db, {
      broadcastId,
      chatId: t.chatId,
      title: t.title,
      status: 'pending',
      copied: 0,
      error: null,
      now: deps.now(),
    });
  }
  await showProgress(deps, broadcast, PUBLISHING);
  try {
    await deliver(deps, broadcast, targets);
  } finally {
    await store.setDraftStatus(db, { draftId, status: 'published', now: deps.now() });
    await showReport(deps, broadcast);
  }
  return { ok: true, broadcastId };
}

/**
 * Retry failed button. Re-sends only to channels whose delivery failed (or was
 * left unfinished by an interrupted run); channels removed from the bot since
 * then are marked skipped.
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'not_found' | 'not_allowed' | 'nothing_to_retry' }>}
 */
export async function retryFailed(deps, { broadcastId, userId, onStarted }) {
  const { db } = deps;
  const broadcast = await store.getBroadcast(db, broadcastId);
  if (!broadcast) return { ok: false, reason: 'not_found' };
  if (broadcast.user_id !== userId && !isOwner(deps, userId)) {
    return { ok: false, reason: 'not_allowed' };
  }
  const now = deps.now();
  const claimed = await store.claimDeliveriesForRetry(db, {
    broadcastId,
    token: `retrying:${now}:${Math.random().toString(36).slice(2, 10)}`,
    now,
    staleBefore: now - STALE_AFTER_SECONDS,
  });
  if (claimed.length === 0) return { ok: false, reason: 'nothing_to_retry' };
  await onStarted?.();
  await showProgress(deps, broadcast, RETRYING);

  try {
    const targets = [];
    for (const d of claimed) {
      const channel = await store.getTarget(db, d.chat_id);
      if (channel) {
        targets.push({ chatId: d.chat_id, title: channel.title });
      } else {
        await store.upsertDelivery(db, {
          broadcastId,
          chatId: d.chat_id,
          title: d.channel_title,
          status: 'skipped',
          copied: 0,
          error: 'channel was removed from the bot',
          now: deps.now(),
        });
      }
    }
    await deliver(deps, broadcast, targets);
  } finally {
    await showReport(deps, broadcast);
  }
  return { ok: true };
}
