'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup();
const { I, claude, home, write } = env;
const read = (p) => fs.readFileSync(p, 'utf8');

test('shared profile links config but never credentials', () => {
  write(path.join(claude, 'settings.json'), '{"a":1}');
  write(path.join(claude, 'agents', 'x.md'), 'agent');
  write(path.join(claude, '.credentials.json'), 'MAIN');
  const acc = path.join(home, '.claude-accounts', 'work');
  fs.mkdirSync(acc, { recursive: true });
  I.linkSharedItems(acc);
  assert.ok(I.isLinkedTo(path.join(acc, 'settings.json'), path.join(claude, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(acc, '.credentials.json')));
  assert.deepStrictEqual(I.brokenShares({ mode: 'shared', dir: acc }), []);
});

test('detects and repairs a link replaced by a regular file', () => {
  const acc = path.join(home, '.claude-accounts', 'work');
  fs.unlinkSync(path.join(acc, 'settings.json'));
  fs.writeFileSync(path.join(acc, 'settings.json'), '{"b":2}');
  assert.deepStrictEqual(I.brokenShares({ mode: 'shared', dir: acc }), ['settings.json']);
  const r = I.linkSharedItems(acc, { replaceLocal: true });
  assert.strictEqual(r.backedUp.length, 1);
  assert.deepStrictEqual(I.brokenShares({ mode: 'shared', dir: acc }), []);
});

test('isolating creates independent copies', () => {
  const acc = path.join(home, '.claude-accounts', 'work');
  I.unlinkSharedItems(acc);
  fs.writeFileSync(path.join(acc, 'settings.json'), '{"changed":true}');
  assert.strictEqual(read(path.join(claude, 'settings.json')), '{"a":1}');
});

test('deleting an account never touches ~/.claude', () => {
  const acc = path.join(home, '.claude-accounts', 'work');
  I.linkSharedItems(acc, { replaceLocal: true });
  I.removeAccountDir(acc);
  assert.ok(!fs.existsSync(acc));
  assert.strictEqual(read(path.join(claude, 'agents', 'x.md')), 'agent');
  assert.strictEqual(read(path.join(claude, '.credentials.json')), 'MAIN');
  I.removeAccountDir(claude); // must refuse
  assert.ok(fs.existsSync(claude));
});
