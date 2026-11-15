// node:sqlite adapter exposing the tgcloud `db` raw-SQL surface:
//   db.run(query, params) -> { rowsAffected, lastInsertRowid, rows }
//   db.all(query, params) -> rows
//   db.get(query, params) -> row | null
// Every call is async, like on the platform, so concurrent callers interleave
// at each await the way separate invocations would.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const plain = (row) => (row ? { ...row } : null);

export function createTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  const prepare = (query) => sqlite.prepare(query);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    sqlite,
    async run(query, params = {}) {
      await tick();
      const info = prepare(query).run(params);
      return {
        rowsAffected: Number(info.changes),
        lastInsertRowid: Number(info.lastInsertRowid),
        rows: [],
      };
    },
    async all(query, params = {}) {
      await tick();
      return prepare(query).all(params).map(plain);
    },
    async get(query, params = {}) {
      await tick();
      return plain(prepare(query).get(params));
    },
  };
}
