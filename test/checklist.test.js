import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistFor, toggleTarget, toggleAll } from '../tgcloud/lib/checklist.js';
import { addToDraft } from '../tgcloud/lib/drafts.js';
import * as store from '../tgcloud/lib/store.js';
import { makeDeps, privateMessage, BROADCASTER, OWNER, NOW } from './helpers/deps.js';

async function setup({ targets = [-1001, -1002] } = {}) {
  const deps = makeDeps();
  for (const [i, chatId] of targets.entries()) {
    await store.upsertTarget(deps.db, {
      chatId,
      title: `T${i}`,
      username: null,
      addedBy: OWNER,
      now: NOW,
    });
  }
  const { draftId } = await addToDraft(deps, privateMessage(BROADCASTER, 10));
  return { deps, draftId };
}

const ticks = (view) =>
  view.reply_markup.inline_keyboard
    .filter((row) => row[0].callback_data.startsWith('tg:'))
    .map((row) => row[0].text.split(' ')[0]);

test('checklistFor shows every target ticked', async () => {
  const { deps, draftId } = await setup();
  const r = await checklistFor(deps, { draftId, userId: BROADCASTER });
  assert.equal(r.ok, true);
  assert.equal(r.view.text, 'Send to 2/2:');
  assert.deepEqual(ticks(r.view), ['✅', '✅']);
});

test('checklistFor refuses other users, closed drafts and an empty target list', async () => {
  const { deps, draftId } = await setup();
  assert.deepEqual(await checklistFor(deps, { draftId, userId: 6 }), {
    ok: false,
    reason: 'not_open',
  });
  await store.cancelDraft(deps.db, { draftId, now: NOW });
  assert.deepEqual(await checklistFor(deps, { draftId, userId: BROADCASTER }), {
    ok: false,
    reason: 'not_open',
  });
  const empty = await setup({ targets: [] });
  assert.deepEqual(
    await checklistFor(empty.deps, { draftId: empty.draftId, userId: BROADCASTER }),
    {
      ok: false,
      reason: 'no_targets',
    },
  );
});

test('toggleTarget unticks and reticks one target', async () => {
  const { deps, draftId } = await setup();
  let r = await toggleTarget(deps, { draftId, userId: BROADCASTER, chatId: -1002 });
  assert.equal(r.view.text, 'Send to 1/2:');
  assert.deepEqual(await store.listExcluded(deps.db, draftId), [-1002]);
  r = await toggleTarget(deps, { draftId, userId: BROADCASTER, chatId: -1002 });
  assert.equal(r.view.text, 'Send to 2/2:');
  assert.equal((await toggleTarget(deps, { draftId, userId: 6, chatId: -1002 })).ok, false);
});

test('toggleAll switches between none and all', async () => {
  const { deps, draftId } = await setup();
  let r = await toggleAll(deps, { draftId, userId: BROADCASTER });
  assert.equal(r.view.text, 'Send to 0/2:');
  r = await toggleAll(deps, { draftId, userId: BROADCASTER });
  assert.equal(r.view.text, 'Send to 2/2:');
});
