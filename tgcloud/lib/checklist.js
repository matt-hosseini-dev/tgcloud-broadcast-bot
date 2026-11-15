// The Publish checklist: before sending, the author sees every target ticked
// and can untick some. Unticked targets are stored per draft (draft_exclusions).
import * as store from './store.js';
import { checklistView } from './report.js';

/** @returns {Promise<{ ok: true, view: object } | { ok: false, reason: 'not_open' | 'no_targets' }>} */
export async function checklistFor(deps, { draftId, userId }) {
  const draft = await store.getDraft(deps.db, draftId);
  if (!draft || draft.user_id !== userId || draft.status !== 'open') {
    return { ok: false, reason: 'not_open' };
  }
  const targets = await store.listTargets(deps.db, { enabledOnly: true });
  if (targets.length === 0) return { ok: false, reason: 'no_targets' };
  const excluded = new Set(await store.listExcluded(deps.db, draftId));
  return { ok: true, view: checklistView({ draftId, targets, excluded }) };
}

export async function toggleTarget(deps, { draftId, userId, chatId }) {
  const check = await checklistFor(deps, { draftId, userId });
  if (!check.ok) return check;
  const excluded = await store.listExcluded(deps.db, draftId);
  if (excluded.includes(chatId)) await store.includeInDraft(deps.db, draftId, chatId);
  else await store.excludeFromDraft(deps.db, draftId, chatId);
  return checklistFor(deps, { draftId, userId });
}

/** Ticks everything if anything is unticked; otherwise unticks everything. */
export async function toggleAll(deps, { draftId, userId }) {
  const check = await checklistFor(deps, { draftId, userId });
  if (!check.ok) return check;
  const targets = await store.listTargets(deps.db, { enabledOnly: true });
  const excluded = new Set(await store.listExcluded(deps.db, draftId));
  if (targets.some((t) => excluded.has(t.chat_id))) {
    await store.clearExcluded(deps.db, draftId);
  } else {
    for (const t of targets) await store.excludeFromDraft(deps.db, draftId, t.chat_id);
  }
  return checklistFor(deps, { draftId, userId });
}
