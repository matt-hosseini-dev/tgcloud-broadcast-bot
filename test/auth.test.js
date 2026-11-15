import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRole, isOwner } from '../tgcloud/lib/auth.js';
import { addBroadcaster } from '../tgcloud/lib/store.js';
import { createTestDb } from './helpers/sqlite-db.js';

const config = { ownerIds: [1, 2] };

test('owners come from config, broadcasters from the database, anyone else is null', async () => {
  const db = createTestDb();
  await addBroadcaster(db, { userId: 5, name: 'B', addedBy: 1, now: 0 });
  const deps = { db, config };
  assert.equal(await resolveRole(deps, 1), 'owner');
  assert.equal(await resolveRole(deps, 5), 'broadcaster');
  assert.equal(await resolveRole(deps, 9), null);
  assert.equal(await resolveRole(deps, undefined), null);
});

test('an owner listed as broadcaster is still an owner', async () => {
  const db = createTestDb();
  await addBroadcaster(db, { userId: 2, name: 'O', addedBy: 1, now: 0 });
  assert.equal(await resolveRole({ db, config }, 2), 'owner');
});

test('isOwner checks config only', () => {
  assert.equal(isOwner({ config }, 2), true);
  assert.equal(isOwner({ config }, 5), false);
});
