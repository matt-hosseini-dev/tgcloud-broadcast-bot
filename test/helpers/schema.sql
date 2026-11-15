-- Test DDL. Mirrors tgcloud/schema.js, which only runs on the platform.
-- test/schema.test.js checks that both declare the same tables and columns.

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_processed_updates_created ON processed_updates (created_at);

CREATE TABLE broadcasters (
  user_id INTEGER PRIMARY KEY,
  name TEXT,
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  username TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  chat_type TEXT NOT NULL DEFAULT 'channel',
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  open_key INTEGER UNIQUE,
  status TEXT NOT NULL,
  control_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE draft_messages (
  draft_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (draft_id, message_id)
);

CREATE TABLE draft_exclusions (
  draft_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  PRIMARY KEY (draft_id, chat_id)
);

CREATE TABLE broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_ids TEXT NOT NULL,
  control_message_id INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  broadcast_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  channel_title TEXT NOT NULL,
  status TEXT NOT NULL,
  copied INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (broadcast_id, chat_id)
);

CREATE TABLE pending_actions (
  user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
