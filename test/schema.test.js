import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../tgcloud/schema.js';
import { createTestDb } from './helpers/sqlite-db.js';

test('tgcloud/schema.js and test/helpers/schema.sql declare the same tables and columns', () => {
  const { sqlite } = createTestDb();
  const sqlTables = Object.fromEntries(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(({ name }) => [
        name,
        sqlite
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((c) => c.name)
          .sort(),
      ]),
  );
  const jsTables = Object.fromEntries(
    Object.values(schema).map((t) => [t.__table, [...t.__columns].sort()]),
  );
  assert.deepEqual(jsTables, sqlTables);
});
