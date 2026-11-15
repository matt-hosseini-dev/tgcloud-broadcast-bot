import { table, integer, text, boolean, index, primaryKey } from 'sdk/db';

// Database schema. Deploying registers it; `npx tgcloud migrate` applies it.
// test/helpers/schema.sql mirrors this file for local tests; keep them in step
// (test/schema.test.js checks table and column names).
// Timestamps are unix seconds, written by the application.

/** Update ids already handled, so a redelivered update is processed once. */
export const processedUpdates = table(
  'processed_updates',
  {
    updateId: integer('update_id').primaryKey(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    createdIdx: index('idx_processed_updates_created').on(t.createdAt),
  }),
);

/** People allowed to publish. Owners come from lib/config.js, not from here. */
export const broadcasters = table('broadcasters', {
  userId: integer('user_id').primaryKey(),
  name: text('name'),
  addedBy: integer('added_by').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Targets a post is copied to: channels, groups and users. (The table predates
 * groups and users, hence its name.) chat_type: channel | group | supergroup | private
 */
export const channels = table('channels', {
  chatId: integer('chat_id').primaryKey(),
  title: text('title').notNull(),
  username: text('username'),
  enabled: boolean('enabled').notNull().default(true),
  chatType: text('chat_type').notNull().default('channel'),
  addedBy: integer('added_by').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * A post being collected in private chat. `open_key` holds the user id while the
 * draft is open and NULL afterwards: its UNIQUE constraint allows one open draft
 * per user, so concurrent album items all land in the same draft.
 * status: open | publishing | published | cancelled
 */
export const drafts = table('drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  openKey: integer('open_key').unique(),
  status: text('status').notNull(),
  controlMessageId: integer('control_message_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Messages that make up a draft (ids in the broadcaster's private chat). */
export const draftMessages = table(
  'draft_messages',
  {
    draftId: integer('draft_id').notNull(),
    messageId: integer('message_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.draftId, t.messageId] }),
  }),
);

/** Targets unticked in a draft's Publish checklist (all others are selected). */
export const draftExclusions = table(
  'draft_exclusions',
  {
    draftId: integer('draft_id').notNull(),
    chatId: integer('chat_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.draftId, t.chatId] }),
  }),
);

/** One publish of a draft. message_ids is a JSON array, ascending. */
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  draftId: integer('draft_id').notNull().unique(),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  messageIds: text('message_ids').notNull(),
  controlMessageId: integer('control_message_id'),
  createdAt: integer('created_at').notNull(),
});

/**
 * Result per channel of a broadcast.
 * status: sent | partial | failed | retrying
 */
export const deliveries = table(
  'deliveries',
  {
    broadcastId: integer('broadcast_id').notNull(),
    chatId: integer('chat_id').notNull(),
    channelTitle: text('channel_title').notNull(),
    status: text('status').notNull(),
    copied: integer('copied').notNull().default(0),
    error: text('error'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.broadcastId, t.chatId] }),
  }),
);

/** A multi-step command waiting for the user's next message (e.g. a forward). */
export const pendingActions = table('pending_actions', {
  userId: integer('user_id').primaryKey(),
  action: text('action').notNull(),
  createdAt: integer('created_at').notNull(),
});
