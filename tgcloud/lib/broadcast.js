// Fan-out: copy a draft to every enabled channel, classify each result, store
// it, and show the report. Retry re-sends only to the channels that failed.
import * as store from './store.js';
import { isOwner } from './auth.js';
import { editQuietly } from './drafts.js';
import { PUBLISHING, renderReport } from './report.js';

/** A 429 with a retry_after up to this many seconds is waited out once. */
export const MAX_RETRY_AFTER = 5;
/** copyMessages accepts at most 100 ids per call. */
export const MAX_IDS_PER_CALL = 100;

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

/** Delivers to the given channels concurrently and stores each result. */
async function deliver(deps, broadcast, targets) {
  const settled = await Promise.allSettled(
    targets.map((t) =>
      copyToChannel(deps, {
        fromChatId: broadcast.chat_id,
        chatId: t.chatId,
        messageIds: broadcast.message_ids,
      }),
    ),
  );
  for (const [i, s] of settled.entries()) {
    const r =
      s.status === 'fulfilled'
        ? s.value
        : { status: 'failed', copied: 0, error: describe(s.reason) };
    await store.upsertDelivery(deps.db, {
      broadcastId: broadcast.id,
      chatId: targets[i].chatId,
      title: targets[i].title,
      status: r.status,
      copied: r.copied,
      error: r.error,
      now: deps.now(),
    });
  }
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
 * to every enabled channel, and reports.
 * @returns {Promise<{ ok: true, broadcastId: number } | { ok: false, reason: 'no_channels' | 'not_open' | 'empty' }>}
 */
export async function publishDraft(deps, { draftId, userId }) {
  const { db } = deps;
  const channels = await store.listChannels(db, { enabledOnly: true });
  if (channels.length === 0) return { ok: false, reason: 'no_channels' };

  const draft = await store.getDraft(db, draftId);
  if (!draft || !(await store.claimDraft(db, { draftId, userId, now: deps.now() }))) {
    return { ok: false, reason: 'not_open' };
  }
  const messageIds = await store.listDraftMessageIds(db, draftId);
  if (messageIds.length === 0) {
    await store.setDraftStatus(db, { draftId, status: 'cancelled', now: deps.now() });
    return { ok: false, reason: 'empty' };
  }

  if (draft.control_message_id) {
    await editQuietly(deps.api, {
      chat_id: draft.chat_id,
      message_id: draft.control_message_id,
      text: PUBLISHING,
    });
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
  await deliver(
    deps,
    broadcast,
    channels.map((c) => ({ chatId: c.chat_id, title: c.title })),
  );
  await store.setDraftStatus(db, { draftId, status: 'published', now: deps.now() });
  await showReport(deps, broadcast);
  return { ok: true, broadcastId };
}

/**
 * Retry failed button. Re-sends only to channels whose delivery failed; channels
 * removed from the bot since then are marked skipped.
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'not_found' | 'not_allowed' | 'nothing_to_retry' }>}
 */
export async function retryFailed(deps, { broadcastId, userId }) {
  const { db } = deps;
  const broadcast = await store.getBroadcast(db, broadcastId);
  if (!broadcast) return { ok: false, reason: 'not_found' };
  if (broadcast.user_id !== userId && !isOwner(deps, userId)) {
    return { ok: false, reason: 'not_allowed' };
  }
  const claimed = await store.claimFailedDeliveries(db, broadcastId, deps.now());
  if (claimed.length === 0) return { ok: false, reason: 'nothing_to_retry' };

  const targets = [];
  for (const d of claimed) {
    const channel = await store.getChannel(db, d.chat_id);
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
  await showReport(deps, broadcast);
  return { ok: true };
}
