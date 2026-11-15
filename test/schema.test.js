import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../tgcloud/schema.js';
import { createTestDb } from './helpers/sqlite-db.js';

// The SQL in lib/store.js relies on these constraints (ON CONFLICT targets, the
// UNIQUE open_key), so the platform schema and the test schema must agree on
// them, not only on names.

const sqlDefault = (v) =>
  v === undefined ? null : typeof v === 'boolean' ? String(Number(v)) : String(v);

function describeSql(sqlite) {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  return Object.fromEntries(
    tables.map((name) => {
      const info = sqlite.prepare(`PRAGMA table_info(${name})`).all();
      const uniques = sqlite
        .prepare(`PRAGMA index_list(${name})`)
        .all()
        .filter((i) => i.unique && i.origin === 'u')
        .map((i) =>
          sqlite
            .prepare(`PRAGMA index_info(${i.name})`)
            .all()
            .map((c) => c.name),
        );
      const singleUnique = new Set(uniques.filter((u) => u.length === 1).map((u) => u[0]));
      return [
        name,
        {
          columns: Object.fromEntries(
            info.map((c) => [
              c.name,
              {
                notNull: Boolean(c.notnull),
                unique: singleUnique.has(c.name),
                default: c.dflt_value,
              },
            ]),
          ),
          primaryKey: info
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name),
        },
      ];
    }),
  );
}

function describeJs() {
  return Object.fromEntries(
    Object.values(schema).map((t) => [
      t.__table,
      {
        columns: Object.fromEntries(
          t.__columns.map((c) => [
            c.name,
            { notNull: c.notNull, unique: c.unique, default: sqlDefault(c.default) },
          ]),
        ),
        primaryKey: t.__primaryKey,
      },
    ]),
  );
}

test('tgcloud/schema.js and test/helpers/schema.sql declare the same tables, columns and constraints', () => {
  assert.deepEqual(describeJs(), describeSql(createTestDb().sqlite));
});
