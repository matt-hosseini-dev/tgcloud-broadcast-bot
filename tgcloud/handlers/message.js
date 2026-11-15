// Runs on each `message` update. Drafting, commands and authorization live in
// lib/router.js; the full Update (for dedupe) is ctx.update.
import { createDeps } from '../lib/container.js';
import { onMessage } from '../lib/router.js';

export default async function (message, ctx) {
  await onMessage(createDeps(), message, ctx?.update);
}
