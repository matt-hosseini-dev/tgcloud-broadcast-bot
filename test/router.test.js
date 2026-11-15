import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseCallbackData } from '../tgcloud/lib/router.js';

test('parseCommand reads the command, strips @botname and keeps the arguments', () => {
  assert.deepEqual(parseCommand({ text: '/start' }), { command: 'start', args: '' });
  assert.deepEqual(parseCommand({ text: '/addchannel@my_bot  @news ' }), {
    command: 'addchannel',
    args: '@news',
  });
  assert.deepEqual(parseCommand({ text: '/ADDBROADCASTER 123' }), {
    command: 'addbroadcaster',
    args: '123',
  });
});

test('parseCommand returns null for non-commands', () => {
  assert.equal(parseCommand({ text: 'hello /start' }), null);
  assert.equal(parseCommand({ caption: '/start' }), null);
  assert.equal(parseCommand({}), null);
  assert.equal(parseCommand({ text: '/' }), null);
});

test('parseCallbackData accepts known actions with integer ids only', () => {
  assert.deepEqual(parseCallbackData('pub:12'), { action: 'pub', id: 12 });
  assert.deepEqual(parseCallbackData('rmch:-1001'), { action: 'rmch', id: -1001 });
  assert.deepEqual(parseCallbackData('send:3'), { action: 'send', id: 3 });
  assert.deepEqual(parseCallbackData('all:3'), { action: 'all', id: 3 });
  assert.deepEqual(parseCallbackData('tg:3:-1001'), { action: 'tg', id: 3, chatId: -1001 });
  assert.equal(parseCallbackData('tg:3'), null);
  assert.equal(parseCallbackData('pub:abc'), null);
  assert.equal(parseCallbackData('zap:1'), null);
  assert.equal(parseCallbackData(undefined), null);
});
