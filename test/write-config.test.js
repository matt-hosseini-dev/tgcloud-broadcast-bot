import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOwnerIds, readEnvFile, renderConfig, writeConfig } from '../scripts/write-config.mjs';

test('parseOwnerIds accepts comma or space separated positive integers', () => {
  assert.deepEqual(parseOwnerIds('111, 222 333'), [111, 222, 333]);
});

test('parseOwnerIds removes duplicates', () => {
  assert.deepEqual(parseOwnerIds('5,5,6'), [5, 6]);
});

test('parseOwnerIds rejects empty and invalid values', () => {
  assert.throws(() => parseOwnerIds(''), /OWNER_IDS is empty/);
  assert.throws(() => parseOwnerIds(undefined), /OWNER_IDS is empty/);
  assert.throws(() => parseOwnerIds('12,abc'), /not a valid Telegram user id: "abc"/);
  assert.throws(() => parseOwnerIds('-5'), /not a valid Telegram user id/);
});

test('readEnvFile reads KEY=value lines and ignores comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const file = join(dir, '.env');
  writeFileSync(file, '# comment\nOWNER_IDS="1,2"\n\nOTHER=x\n');
  assert.deepEqual(readEnvFile(file), { OWNER_IDS: '1,2', OTHER: 'x' });
  assert.deepEqual(readEnvFile(join(dir, 'missing')), {});
});

test('renderConfig produces an ES module exporting OWNER_IDS', () => {
  const src = renderConfig([1, 2]);
  assert.match(src, /export const OWNER_IDS = \[1, 2\];/);
  assert.match(src, /Do not edit or commit/);
});

test('writeConfig prefers the environment over the .env file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  writeFileSync(join(dir, '.env'), 'OWNER_IDS=9\n');
  const out = join(dir, 'config.js');
  writeConfig({ env: { OWNER_IDS: '7,8' }, envFile: join(dir, '.env'), outFile: out });
  assert.match(readFileSync(out, 'utf8'), /\[7, 8\]/);
  writeConfig({ env: {}, envFile: join(dir, '.env'), outFile: out });
  assert.match(readFileSync(out, 'utf8'), /\[9\]/);
});
