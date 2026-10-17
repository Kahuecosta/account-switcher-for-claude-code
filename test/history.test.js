'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const { I, claude, home, write } = setup({ shareHistory: true });
const P = (...x) => path.join(claude, ...x);
const read = (p) => fs.readFileSync(p, 'utf8');

test('merges existing history without losing anything', () => {
  write(P('projects', '-repo-a', 's1.jsonl'), '{"m":1}\n');
  write(P('history.jsonl'), '{"p":"a"}\n{"p":"b"}\n');
  write(P('projects', '-repo-a', 'memory', 'notes.md'), 'original');
  const acc = path.join(home, '.claude-accounts', 'work');
  write(path.join(acc, 'projects', '-repo-a', 's2.jsonl'), '{"m":2}\n');
  write(path.join(acc, 'projects', '-repo-b', 's3.jsonl'), '{"m":3}\n');
  write(path.join(acc, 'projects', '-repo-a', 'memory', 'notes.md'), 'from account');
  write(path.join(acc, 'history.jsonl'), '{"p":"b"}\n{"p":"c"}\n');
  write(path.join(acc, '.credentials.json'), 'WORK');

  const r = I.linkHistory(acc, 'work');
  assert.deepStrictEqual(r.conflicts, ['notes.md.conflict-work']);
  for (const f of [['-repo-a', 's1.jsonl'], ['-repo-a', 's2.jsonl'], ['-repo-b', 's3.jsonl']]) assert.ok(fs.existsSync(P('projects', ...f)));
  assert.strictEqual(read(P('history.jsonl')), '{"p":"a"}\n{"p":"b"}\n{"p":"c"}\n');
  assert.strictEqual(read(P('projects', '-repo-a', 'memory', 'notes.md')), 'original');
  assert.strictEqual(read(path.join(acc, '.credentials.json')), 'WORK');
  assert.deepStrictEqual(I.brokenShares({ mode: 'isolated', dir: acc }), []);
});

test('stopping sharing can copy or start empty', () => {
  const items = ['projects', 'history.jsonl', 'file-history', 'todos', 'plans'];
  const a = path.join(home, '.claude-accounts', 'work');
  const b = path.join(home, '.claude-accounts', 'other');
  fs.mkdirSync(b, { recursive: true });
  I.linkHistory(b, 'other');
  I.unlinkItems(a, items, { copy: true });
  I.unlinkItems(b, items, { copy: false });
  assert.ok(fs.existsSync(path.join(a, 'projects', '-repo-b', 's3.jsonl')));
  assert.ok(!fs.existsSync(path.join(b, 'projects')));
  assert.ok(fs.existsSync(P('projects', '-repo-b', 's3.jsonl')));
});
