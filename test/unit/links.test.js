'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const links = require('../../lib/links');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-links-')));
const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};
const read = (p) => fs.readFileSync(p, 'utf8');

// Every file below dir with its content (links shown as "-> target"), to compare before/after.
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const r = path.join(rel, e.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[r] = '-> ' + fs.realpathSync(p);
      else if (st.isDirectory()) {
        out[r + '/'] = '';
        walk(p, r);
      } else out[r] = read(p);
    }
  };
  walk(dir, '');
  return out;
}

function fixture() {
  const d = tmp();
  const base = path.join(d, 'base');
  const acc = path.join(d, 'accounts', 'work');
  fs.mkdirSync(acc, { recursive: true });
  return { d, base, acc, journal: () => new links.Journal(path.join(d, 'backups', String(Date.now()))) };
}

test('items that are never shared', () => {
  for (const bad of [
    '.credentials.json',
    '.claude.json',
    '.claude.json.backup',
    'ide',
    'sessions',
    'session-env',
    '../x',
    'a/b',
    '/abs',
    '',
    ' x',
    '.',
    '..',
    7,
  ]) {
    assert.ok(links.invalidItem(bad), `${JSON.stringify(bad)} must be refused`);
  }
  for (const ok of ['settings.json', 'CLAUDE.md', 'agents', 'rules', 'keybindings.json', 'projects'])
    assert.strictEqual(links.invalidItem(ok), null);
});

test('shared profile links config but never credentials, even when listed', async () => {
  const { base, acc, journal } = fixture();
  write(path.join(base, 'settings.json'), '{"a":1}');
  write(path.join(base, 'agents', 'x.md'), 'agent');
  write(path.join(base, '.credentials.json'), 'MAIN');
  const r = await links.linkItems(base, acc, ['settings.json', 'agents', '.credentials.json', 'missing-dir'], { journal: journal() });
  assert.deepStrictEqual(r.linked, ['settings.json', 'agents']);
  assert.deepStrictEqual(
    r.skipped.map((s) => [s.item, s.reason]),
    [
      ['.credentials.json', 'credentials'],
      ['missing-dir', 'missing'],
    ]
  );
  assert.ok(await links.isLinkedTo(path.join(acc, 'settings.json'), path.join(base, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(acc, '.credentials.json')));
  assert.deepStrictEqual(
    await links.brokenLinks(base, acc, { configItems: ['settings.json', 'agents', 'missing-dir'], historyItems: [] }),
    []
  );
});

test('a link replaced by a regular file is detected and repaired with a backup', async () => {
  const { base, acc, journal } = fixture();
  write(path.join(base, 'settings.json'), '{"a":1}');
  await links.linkItems(base, acc, ['settings.json'], { journal: journal() });
  fs.unlinkSync(path.join(acc, 'settings.json'));
  fs.writeFileSync(path.join(acc, 'settings.json'), '{"b":2}');
  assert.deepStrictEqual(await links.brokenLinks(base, acc, { configItems: ['settings.json'], historyItems: [] }), ['settings.json']);
  const own = await links.linkItems(base, acc, ['settings.json'], { journal: journal() });
  assert.deepStrictEqual(
    own.skipped.map((s) => s.reason),
    ['own'],
    'not replaced without replaceLocal'
  );
  const r = await links.linkItems(base, acc, ['settings.json'], { journal: journal(), replaceLocal: true });
  assert.strictEqual(r.backedUp.length, 1);
  assert.strictEqual(read(path.join(acc, r.backedUp[0])), '{"b":2}');
  assert.deepStrictEqual(await links.brokenLinks(base, acc, { configItems: ['settings.json'], historyItems: [] }), []);
});

test('isolating creates independent copies; removing links never touches base', async () => {
  const { base, acc, journal } = fixture();
  write(path.join(base, 'settings.json'), '{"a":1}');
  write(path.join(base, 'agents', 'x.md'), 'agent');
  await links.linkItems(base, acc, ['settings.json', 'agents'], { journal: journal() });
  assert.deepStrictEqual(await links.unlinkItems(base, acc, ['settings.json', 'agents'], { journal: journal(), copy: true }), [
    'settings.json',
    'agents',
  ]);
  fs.writeFileSync(path.join(acc, 'settings.json'), '{"changed":true}');
  assert.strictEqual(read(path.join(base, 'settings.json')), '{"a":1}');
  assert.strictEqual(read(path.join(acc, 'agents', 'x.md')), 'agent');

  await links.linkItems(base, acc, ['agents'], { journal: journal(), replaceLocal: true });
  await links.removeTopLevelLinks(acc);
  fs.rmSync(acc, { recursive: true, force: true });
  assert.strictEqual(read(path.join(base, 'agents', 'x.md')), 'agent');
});

test('history merge: nothing lost, prompts sorted by time, conflicts kept, backups made', async () => {
  const { base, acc, journal } = fixture();
  write(path.join(base, 'projects', '-repo-a', 's1.jsonl'), '{"m":1}\n');
  write(path.join(base, 'history.jsonl'), '{"p":"a","timestamp":1}\n{"p":"c","timestamp":3}\n');
  write(path.join(base, 'projects', '-repo-a', 'memory', 'notes.md'), 'original');
  write(path.join(acc, 'projects', '-repo-a', 's2.jsonl'), '{"m":2}\n');
  write(path.join(acc, 'projects', '-repo-b', 's3.jsonl'), '{"m":3}\n');
  write(path.join(acc, 'projects', '-repo-a', 'memory', 'notes.md'), 'from account');
  write(path.join(acc, 'history.jsonl'), '{"p":"c","timestamp":3}\n{"p":"b","timestamp":2}\n');
  write(path.join(acc, '.credentials.json'), 'WORK');

  const j = journal();
  const r = await links.linkItems(base, acc, ['projects', 'history.jsonl', 'todos'], { journal: j, merge: true, tag: 'work' });
  assert.deepStrictEqual(r.conflicts, ['notes.md.conflict-work']);
  for (const f of [
    ['-repo-a', 's1.jsonl'],
    ['-repo-a', 's2.jsonl'],
    ['-repo-b', 's3.jsonl'],
  ])
    assert.ok(fs.existsSync(path.join(base, 'projects', ...f)));
  assert.strictEqual(read(path.join(base, 'history.jsonl')), '{"p":"a","timestamp":1}\n{"p":"b","timestamp":2}\n{"p":"c","timestamp":3}\n');
  assert.strictEqual(read(path.join(base, 'projects', '-repo-a', 'memory', 'notes.md')), 'original');
  assert.strictEqual(read(path.join(base, 'projects', '-repo-a', 'memory', 'notes.md.conflict-work')), 'from account');
  assert.strictEqual(read(path.join(acc, '.credentials.json')), 'WORK');
  assert.ok(fs.statSync(path.join(base, 'todos')).isDirectory(), 'missing history items are created in base');
  assert.deepStrictEqual(await links.brokenLinks(base, acc, { configItems: [], historyItems: ['projects', 'history.jsonl', 'todos'] }), []);
  const backupDir = await j.finish();
  assert.ok(backupDir && fs.existsSync(path.join(backupDir, 'manifest.json')));
  assert.ok(
    fs.readdirSync(backupDir).some((f) => f.endsWith('history.jsonl')),
    'the rewritten base history was backed up'
  );
});

test('a failed or cancelled merge is rolled back to the exact previous state', async () => {
  const { d, base, acc, journal } = fixture();
  write(path.join(base, 'projects', '-repo-a', 's1.jsonl'), '{"m":1}\n');
  write(path.join(base, 'history.jsonl'), '{"p":"a","timestamp":1}\n');
  write(path.join(acc, 'projects', '-repo-a', 's1.jsonl'), '{"m":1}\n{"m":"extra"}\n');
  write(path.join(acc, 'projects', '-repo-b', 's3.jsonl'), '{"m":3}\n');
  write(path.join(acc, 'history.jsonl'), '{"p":"b","timestamp":2}\n');
  write(path.join(acc, 'plans', 'p.md'), 'plan');
  const before = snapshot(d);

  const j = journal();
  let steps = 0;
  const check = () => {
    if (++steps > 4) throw new links.CancelledError();
  };
  await assert.rejects(
    links.linkItems(base, acc, ['projects', 'history.jsonl', 'plans'], { journal: j, merge: true, tag: 'work', check }),
    { code: 'ECANCELLED' }
  );
  assert.ok(j.ops.length > 0, 'something had changed before the failure');
  assert.deepStrictEqual(await j.rollback(), []);
  const after = snapshot(d);
  for (const k of Object.keys(after)) if (k.startsWith('backups')) delete after[k];
  for (const k of Object.keys(before)) if (k.startsWith('backups')) delete before[k];
  assert.deepStrictEqual(after, before);
});

test('mergeJsonl: append without duplicates, or sort by timestamp', () => {
  assert.strictEqual(links.mergeJsonl('a\nb\n', 'b\nc\n'), 'a\nb\nc\n');
  assert.strictEqual(links.mergeJsonl('a', 'c'), 'a\nc\n', 'adds the missing newline');
  assert.strictEqual(links.mergeJsonl('a\n', 'a\n'), null);
  const sorted = links.mergeJsonl('{"timestamp":"2026-01-02T00:00:00Z","x":2}\n', '{"timestamp":1767225600,"x":1}\nnot json\n', {
    sortByTime: true,
  });
  assert.deepStrictEqual(
    sorted
      .trim()
      .split('\n')
      .map((l) => (l.startsWith('{') ? JSON.parse(l).x : l)),
    [1, 'not json', 2]
  );
});

test('shareableItems: everything except login data, history, session state and exclusions', async () => {
  const { base } = fixture();
  for (const f of [
    'settings.json',
    'CLAUDE.md',
    '.credentials.json',
    'ide/x',
    'projects/x',
    'history.jsonl',
    'themes/a',
    'secret-stuff/x',
    'settings.json.bak-1/x',
    'a.tmp-123-4',
  ]) {
    write(path.join(base, f), '');
  }
  assert.deepStrictEqual(await links.shareableItems(base, { exclude: ['secret-stuff'] }), ['CLAUDE.md', 'settings.json', 'themes']);
  assert.deepStrictEqual(await links.shareableItems(path.join(base, 'nope')), []);
});

test('MCP servers: mirrored from base, own servers kept, removed ones cleaned up', async () => {
  const { mergeServers, mirrorMcpServers } = require('../../lib/mcp');
  let r = mergeServers({ own: { command: 'o' } }, { a: { command: 'a' }, own: { command: 'base' } }, []);
  assert.deepStrictEqual(r.servers, { own: { command: 'o' }, a: { command: 'a' } });
  assert.deepStrictEqual(r.mirrored, ['a']);
  r = mergeServers(r.servers, {}, r.mirrored);
  assert.deepStrictEqual(r.servers, { own: { command: 'o' } }, 'a server removed from base goes away');
  assert.ok(r.changed);

  const { d } = fixture();
  const baseJson = path.join(d, 'home', '.claude.json');
  const accJson = path.join(d, 'acc', '.claude.json');
  write(baseJson, JSON.stringify({ mcpServers: { gh: { type: 'stdio', command: 'gh-mcp' } }, oauthAccount: { emailAddress: 'base@x' } }));
  write(accJson, JSON.stringify({ oauthAccount: { emailAddress: 'acc@x' }, numStartups: 3 }));
  const res = await mirrorMcpServers(baseJson, accJson, []);
  assert.deepStrictEqual(res, { changed: true, mirrored: ['gh'] });
  const acc = JSON.parse(read(accJson));
  assert.deepStrictEqual(acc.mcpServers, { gh: { type: 'stdio', command: 'gh-mcp' } });
  assert.strictEqual(acc.oauthAccount.emailAddress, 'acc@x', 'the account login is untouched');
  assert.strictEqual(acc.numStartups, 3);
  assert.deepStrictEqual(await mirrorMcpServers(baseJson, accJson, ['gh']), { changed: false, mirrored: ['gh'] });
  fs.writeFileSync(accJson, '{ corrupt');
  await assert.rejects(mirrorMcpServers(baseJson, accJson, ['gh']));
  assert.strictEqual(read(accJson), '{ corrupt', 'a corrupt file is never overwritten');
  const fresh = path.join(d, 'new', '.claude.json');
  fs.mkdirSync(path.dirname(fresh));
  await mirrorMcpServers(baseJson, fresh, []);
  assert.deepStrictEqual(JSON.parse(read(fresh)), { mcpServers: { gh: { type: 'stdio', command: 'gh-mcp' } } });
});
