import { createFakeApi } from './fake-api.js';
import { createTestDb } from './sqlite-db.js';

export const NOW = 1_700_000_000;
export const OWNER = 1;
export const OWNER_2 = 2;
export const BROADCASTER = 5;
export const STRANGER = 9;

/** Fresh dependencies for one test: fake api, in-memory db, fixed clock. */
export function makeDeps(overrides = {}) {
  const sleeps = [];
  return {
    api: createFakeApi(),
    db: createTestDb(),
    config: { ownerIds: [OWNER, OWNER_2] },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sleeps,
    ...overrides,
  };
}

/** A private-chat message from `userId`. */
export function privateMessage(userId, messageId, extra = {}) {
  return {
    message_id: messageId,
    from: { id: userId, is_bot: false, first_name: `User${userId}` },
    chat: { id: userId, type: 'private', first_name: `User${userId}` },
    date: NOW,
    ...extra,
  };
}
