import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEnv, nodeMajorOk } from '../scripts/setup.mjs';

test('renderEnv sets OWNER_IDS and keeps other keys', () => {
  assert.equal(
    renderEnv({ OTHER: 'x', OWNER_IDS: '1' }, { OWNER_IDS: '5,6' }),
    'OTHER=x\nOWNER_IDS=5,6\n',
  );
  assert.equal(renderEnv({}, { OWNER_IDS: '5' }), 'OWNER_IDS=5\n');
});

test('nodeMajorOk requires Node 22.15 or newer', () => {
  assert.equal(nodeMajorOk('22.14.0'), false);
  assert.equal(nodeMajorOk('22.15.0'), true);
  assert.equal(nodeMajorOk('24.1.0'), true);
  assert.equal(nodeMajorOk('20.19.0'), false);
});

test('askOwners re-asks on a bad answer and keeps the current ids on Enter', async () => {
  const { Readable, Writable } = await import('node:stream');
  const { askOwners } = await import('../scripts/setup.mjs');
  const out = () => new Writable({ write: (_c, _e, cb) => cb() });
  assert.equal(
    await askOwners({ input: Readable.from(['1, x\n111,222\n']), output: out() }),
    '111,222',
  );
  assert.equal(await askOwners({ input: Readable.from(['\n']), output: out(), current: '5' }), '5');
  await assert.rejects(askOwners({ input: Readable.from([]), output: out() }), /No input/);
});
