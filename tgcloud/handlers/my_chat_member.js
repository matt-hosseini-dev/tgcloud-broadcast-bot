// Runs when the bot's own membership changes in a chat. Registers a channel when
// an owner makes the bot an admin with the right to post.
import { createDeps } from '../lib/container.js';
import { onMyChatMember } from '../lib/router.js';

export default async function (chatMemberUpdated, ctx) {
  await onMyChatMember(createDeps(), chatMemberUpdated, ctx?.update);
}
