// Draft collection in private chat. Every message a broadcaster sends is added
// to their open draft; the first one also gets the control message with the
// Publish / Cancel buttons. Albums arrive as one invocation per item, so the
// "first" is decided by the database (see store.openDraft), not by the caller.
import * as store from './store.js';
import { DRAFT_CANCELLED, DRAFT_STARTED, draftKeyboard } from './report.js';

/** @returns {Promise<{ draftId: number, created: boolean }>} */
export async function addToDraft(deps, message) {
  const { api, db } = deps;
  const userId = message.from.id;
  const chatId = message.chat.id;
  const { draft, created } = await store.openDraft(db, { userId, chatId, now: deps.now() });
  await store.addDraftMessage(db, draft.id, message.message_id);
  if (!created) return { draftId: draft.id, created };

  try {
    const control = await api.sendMessage({
      chat_id: chatId,
      text: DRAFT_STARTED,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      reply_markup: draftKeyboard(draft.id),
    });
    await store.setControlMessage(db, draft.id, control.message_id);
  } catch (err) {
    // Without a control message the draft has no buttons. Close it so the next
    // message starts a fresh draft and gets a new control message.
    console.error('control message failed, cancelling draft', draft.id, err?.description ?? err);
    await store.cancelDraft(db, { draftId: draft.id, now: deps.now() });
  }
  return { draftId: draft.id, created };
}

/** /cancel: discards the user's open draft. @returns {Promise<boolean>} */
export async function cancelOpenDraft(deps, userId) {
  const draft = await store.getOpenDraft(deps.db, userId);
  if (!draft) return false;
  return closeDraft(deps, draft);
}

/** Cancel button. Only the draft's author can cancel it. @returns {Promise<boolean>} */
export async function cancelDraftById(deps, { draftId, userId }) {
  const draft = await store.getDraft(deps.db, draftId);
  if (!draft || draft.user_id !== userId) return false;
  return closeDraft(deps, draft);
}

async function closeDraft(deps, draft) {
  const done = await store.cancelDraft(deps.db, { draftId: draft.id, now: deps.now() });
  if (done && draft.control_message_id) {
    await editQuietly(deps.api, {
      chat_id: draft.chat_id,
      message_id: draft.control_message_id,
      text: DRAFT_CANCELLED,
    });
  }
  return done;
}

/** Edits a message, logging instead of throwing: the state change already happened. */
export async function editQuietly(api, params) {
  try {
    await api.editMessageText(params);
  } catch (err) {
    console.warn('editMessageText failed', err?.description ?? err);
  }
}
