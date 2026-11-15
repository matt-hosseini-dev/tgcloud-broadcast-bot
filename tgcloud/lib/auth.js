// Role resolution. Owners are fixed per deployment (lib/config.js); broadcasters
// are managed from the bot and stored in the database. Anyone else has no role
// and is ignored.
import { getBroadcaster } from './store.js';

/** @typedef {'owner' | 'broadcaster' | null} Role */

export function isOwner({ config }, userId) {
  return config.ownerIds.includes(userId);
}

/** @returns {Promise<Role>} */
export async function resolveRole(deps, userId) {
  if (userId == null) return null;
  if (isOwner(deps, userId)) return 'owner';
  if (await getBroadcaster(deps.db, userId)) return 'broadcaster';
  return null;
}
