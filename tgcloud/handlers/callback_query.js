// Runs on each `callback_query` update (Publish, Cancel, Retry failed, Remove buttons).
import { createDeps } from '../lib/container.js';
import { onCallbackQuery } from '../lib/router.js';

export default async function (query, ctx) {
  await onCallbackQuery(createDeps(), query, ctx?.update);
}
