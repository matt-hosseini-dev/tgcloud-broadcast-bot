// All SQL lives here. Every function takes the tgcloud `db` (raw-SQL surface:
// db.run / db.all / db.get with named `:params`) as its first argument, so tests
// can pass an in-memory SQLite adapter instead of the platform database.
// Each statement is atomic on its own; races are settled by unique constraints
// and conditional updates checked through rowsAffected.

// ---- processed updates (dedupe) ----

/** @returns {Promise<boolean>} true if this is the first time we see the update. */
export async function markUpdateProcessed(db, updateId, now) {
  const r = await db.run(
    'INSERT INTO processed_updates (update_id, created_at) VALUES (:id, :now) ON CONFLICT(update_id) DO NOTHING',
    { ':id': updateId, ':now': now },
  );
  return r.rowsAffected === 1;
}

export async function pruneProcessedUpdates(db, before) {
  await db.run('DELETE FROM processed_updates WHERE created_at < :before', { ':before': before });
}

// ---- broadcasters ----

export function getBroadcaster(db, userId) {
  return db.get('SELECT * FROM broadcasters WHERE user_id = :id', { ':id': userId });
}

export function listBroadcasters(db) {
  return db.all('SELECT * FROM broadcasters ORDER BY created_at, user_id');
}

/** Adds or renames a broadcaster. @returns {Promise<boolean>} true if newly added. */
export async function addBroadcaster(db, { userId, name, addedBy, now }) {
  const existed = await getBroadcaster(db, userId);
  await db.run(
    `INSERT INTO broadcasters (user_id, name, added_by, created_at)
     VALUES (:id, :name, :by, :now)
     ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, broadcasters.name)`,
    { ':id': userId, ':name': name ?? null, ':by': addedBy, ':now': now },
  );
  return !existed;
}

export async function removeBroadcaster(db, userId) {
  const r = await db.run('DELETE FROM broadcasters WHERE user_id = :id', { ':id': userId });
  return r.rowsAffected > 0;
}

// ---- channels ----

export function getChannel(db, chatId) {
  return db.get('SELECT * FROM channels WHERE chat_id = :id', { ':id': chatId });
}

export function listChannels(db, { enabledOnly = false } = {}) {
  return db.all(
    `SELECT * FROM channels ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY title COLLATE NOCASE, chat_id`,
  );
}

/** Adds a channel or refreshes its title/username and re-enables it. @returns true if new. */
export async function upsertChannel(db, { chatId, title, username, addedBy, now }) {
  const existed = await getChannel(db, chatId);
  await db.run(
    `INSERT INTO channels (chat_id, title, username, enabled, added_by, created_at)
     VALUES (:id, :title, :username, 1, :by, :now)
     ON CONFLICT(chat_id) DO UPDATE SET
       title = excluded.title, username = excluded.username, enabled = 1`,
    { ':id': chatId, ':title': title, ':username': username ?? null, ':by': addedBy, ':now': now },
  );
  return !existed;
}

export async function removeChannel(db, chatId) {
  const r = await db.run('DELETE FROM channels WHERE chat_id = :id', { ':id': chatId });
  return r.rowsAffected > 0;
}

// ---- drafts ----

export function getDraft(db, draftId) {
  return db.get('SELECT * FROM drafts WHERE id = :id', { ':id': draftId });
}

export function getOpenDraft(db, userId) {
  return db.get('SELECT * FROM drafts WHERE open_key = :u', { ':u': userId });
}

/**
 * Returns the user's open draft, creating it if needed. Safe under concurrency:
 * the UNIQUE open_key lets exactly one insert win; `created` is true only for it.
 */
export async function openDraft(db, { userId, chatId, now }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await db.run(
      `INSERT INTO drafts (user_id, chat_id, open_key, status, created_at, updated_at)
       VALUES (:u, :c, :u, 'open', :now, :now)
       ON CONFLICT(open_key) DO NOTHING`,
      { ':u': userId, ':c': chatId, ':now': now },
    );
    const draft = await getOpenDraft(db, userId);
    if (draft) {
      const created = r.rowsAffected === 1 && Number(r.lastInsertRowid) === draft.id;
      return { draft, created };
    }
    // The draft was claimed between insert and select; try again with a fresh one.
  }
  throw new Error(`could not open a draft for user ${userId}`);
}

export async function addDraftMessage(db, draftId, messageId) {
  await db.run(
    'INSERT INTO draft_messages (draft_id, message_id) VALUES (:d, :m) ON CONFLICT DO NOTHING',
    { ':d': draftId, ':m': messageId },
  );
}

/** @returns {Promise<number[]>} ascending, as copyMessages requires. */
export async function listDraftMessageIds(db, draftId) {
  const rows = await db.all(
    'SELECT message_id FROM draft_messages WHERE draft_id = :d ORDER BY message_id',
    { ':d': draftId },
  );
  return rows.map((r) => r.message_id);
}

export async function setControlMessage(db, draftId, messageId) {
  await db.run('UPDATE drafts SET control_message_id = :m WHERE id = :id', {
    ':m': messageId,
    ':id': draftId,
  });
}

/** open -> publishing, once, and only by the draft's author. */
export async function claimDraft(db, { draftId, userId, now }) {
  const r = await db.run(
    `UPDATE drafts SET status = 'publishing', open_key = NULL, updated_at = :now
     WHERE id = :id AND user_id = :u AND status = 'open'`,
    { ':id': draftId, ':u': userId, ':now': now },
  );
  return r.rowsAffected === 1;
}

/** open -> cancelled, once. */
export async function cancelDraft(db, { draftId, now }) {
  const r = await db.run(
    `UPDATE drafts SET status = 'cancelled', open_key = NULL, updated_at = :now
     WHERE id = :id AND status = 'open'`,
    { ':id': draftId, ':now': now },
  );
  return r.rowsAffected === 1;
}

export async function setDraftStatus(db, { draftId, status, now }) {
  await db.run('UPDATE drafts SET status = :s, updated_at = :now WHERE id = :id', {
    ':s': status,
    ':now': now,
    ':id': draftId,
  });
}

// ---- broadcasts and deliveries ----

/** @returns {Promise<number>} the new broadcast id. */
export async function createBroadcast(
  db,
  { draftId, userId, chatId, messageIds, controlMessageId, now },
) {
  const r = await db.run(
    `INSERT INTO broadcasts (draft_id, user_id, chat_id, message_ids, control_message_id, created_at)
     VALUES (:d, :u, :c, :m, :cm, :now)`,
    {
      ':d': draftId,
      ':u': userId,
      ':c': chatId,
      ':m': JSON.stringify(messageIds),
      ':cm': controlMessageId ?? null,
      ':now': now,
    },
  );
  return Number(r.lastInsertRowid);
}

export async function getBroadcast(db, broadcastId) {
  const row = await db.get('SELECT * FROM broadcasts WHERE id = :id', { ':id': broadcastId });
  return row ? { ...row, message_ids: JSON.parse(row.message_ids) } : null;
}

export async function upsertDelivery(
  db,
  { broadcastId, chatId, title, status, copied, error, now },
) {
  await db.run(
    `INSERT INTO deliveries (broadcast_id, chat_id, channel_title, status, copied, error, updated_at)
     VALUES (:b, :c, :t, :s, :n, :e, :now)
     ON CONFLICT(broadcast_id, chat_id) DO UPDATE SET
       channel_title = excluded.channel_title, status = excluded.status,
       copied = excluded.copied, error = excluded.error, updated_at = excluded.updated_at`,
    {
      ':b': broadcastId,
      ':c': chatId,
      ':t': title,
      ':s': status,
      ':n': copied,
      ':e': error ?? null,
      ':now': now,
    },
  );
}

export function listDeliveries(db, broadcastId) {
  return db.all(
    'SELECT * FROM deliveries WHERE broadcast_id = :b ORDER BY channel_title, chat_id',
    { ':b': broadcastId },
  );
}

/**
 * failed -> retrying for every failed delivery of a broadcast. Only the caller
 * whose update flipped rows gets them back, so a double-tapped Retry runs once.
 */
export async function claimFailedDeliveries(db, broadcastId, now) {
  const r = await db.run(
    `UPDATE deliveries SET status = 'retrying', updated_at = :now
     WHERE broadcast_id = :b AND status = 'failed'`,
    { ':b': broadcastId, ':now': now },
  );
  if (r.rowsAffected === 0) return [];
  return db.all(
    `SELECT * FROM deliveries WHERE broadcast_id = :b AND status = 'retrying'
     ORDER BY channel_title, chat_id`,
    { ':b': broadcastId },
  );
}

// ---- pending actions ----

export async function setPendingAction(db, { userId, action, now }) {
  await db.run(
    `INSERT INTO pending_actions (user_id, action, created_at) VALUES (:u, :a, :now)
     ON CONFLICT(user_id) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`,
    { ':u': userId, ':a': action, ':now': now },
  );
}

export async function hasPendingAction(db, { userId, action, since }) {
  const row = await db.get(
    'SELECT 1 AS ok FROM pending_actions WHERE user_id = :u AND action = :a AND created_at >= :since',
    { ':u': userId, ':a': action, ':since': since },
  );
  return Boolean(row);
}

/** Consumes the pending action if it exists and is not older than `since`. */
export async function takePendingAction(db, { userId, action, since }) {
  const r = await db.run(
    'DELETE FROM pending_actions WHERE user_id = :u AND action = :a AND created_at >= :since',
    { ':u': userId, ':a': action, ':since': since },
  );
  return r.rowsAffected === 1;
}

export async function clearPendingAction(db, userId) {
  const r = await db.run('DELETE FROM pending_actions WHERE user_id = :u', { ':u': userId });
  return r.rowsAffected > 0;
}
