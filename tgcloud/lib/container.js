// The only lib module that imports the platform SDK. It wires the real `api`
// and `db` into the dependencies every other lib module takes as an argument,
// which is what lets those modules run under test in plain Node.
import { api, db } from 'sdk';
import { OWNER_IDS } from './config.js';

const sleep =
  typeof setTimeout === 'function'
    ? (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    : null;

export function createDeps() {
  return {
    api,
    db,
    config: { ownerIds: OWNER_IDS },
    now: () => Math.floor(Date.now() / 1000),
    // null if the runtime has no timers: a 429 is then reported instead of retried.
    sleep,
  };
}
