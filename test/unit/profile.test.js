'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

// VS Code was launched with CLAUDE_CONFIG_DIR set: that folder is the Default account and the base
// profile for shared items and history (not ~/.claude).
const env = setup({ sharedItems: ['settings.json', 'agents', '.credentials.json'] }, { originalEnv: '~/custom-claude' });
const { context, home, write, messages, commands, settings } = env;
test.after(env.dispose);

const base = path.join(home, 'custom-claude');
const read = (p) => fs.readFileSync(p, 'utf8');

test('setup', async () => {
  write(path.join(base, 'settings.json'), '{"base":true}');
  write(path.join(base, 'agents', 'a.md'), 'agent');
  write(path.join(base, '.claude.json'), JSON.stringify({ mcpServers: { gh: { command: 'gh' } } }));
  write(path.join(home, '.claude', 'settings.json'), '{"home":true}');
  await context.globalState.update('schemaVersion', 3);
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, base);
});

test('adding a shared account links to the base profile, never credentials, and mirrors MCP servers', async () => {
  env.inputs.push('Work');
  env.pickQuick = (items) => items.find((i) => i.value === 'subscription' || i.mode === 'shared') || items[0];
  env.respond = () => undefined;
  await commands.get('claudeAccounts.add')();
  const dir = path.join(home, '.claude-accounts', 'work');
  assert.strictEqual(
    fs.realpathSync(path.join(dir, 'settings.json')),
    path.join(base, 'settings.json'),
    'linked to the launch folder, not ~/.claude'
  );
  assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')), 'credentials are never linked, even when listed');
  assert.deepStrictEqual(JSON.parse(read(path.join(dir, '.claude.json'))).mcpServers, { gh: { command: 'gh' } });
  assert.deepStrictEqual(context.globalState.get('accounts'), [{ id: 'work', dir, mode: 'shared' }]);
  assert.strictEqual(context.globalState.get('accountMeta').work.color, 'orange', 'first free color');
  const health = env.load('health');
  await health.refresh();
  assert.ok(
    health.current().some((i) => i.id === 'refused' && i.message.includes('.credentials.json')),
    'the refused entry is reported'
  );
});

test('a leftover folder with another login is only reused when the user says so', async () => {
  const left = path.join(home, '.claude-accounts', 'personal');
  write(path.join(left, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'old@x.com' } }));
  env.inputs.push('Personal');
  let offered;
  env.pickQuick = (items, o) => {
    if (o?.placeHolder?.includes('already exists')) {
      offered = items;
      return items.find((i) => i.reuse === false);
    }
    return items.find((i) => i.value === 'subscription' || i.mode === 'isolated') || items[0];
  };
  await commands.get('claudeAccounts.add')();
  assert.ok(
    offered.some((i) => i.detail.includes('old@x.com')),
    'the existing login is shown'
  );
  assert.ok(
    context.globalState.get('accounts').some((a) => a.id === 'personal-2'),
    'a new folder was created instead'
  );
  assert.strictEqual(read(path.join(left, '.claude.json')).includes('old@x.com'), true, 'the old folder is untouched');
});

test('sharing history merges into the base profile with backups, and can be undone', async () => {
  const work = path.join(home, '.claude-accounts', 'work');
  write(path.join(base, 'history.jsonl'), '{"p":"base","timestamp":1}\n');
  write(path.join(work, 'history.jsonl'), '{"p":"work","timestamp":2}\n');
  write(path.join(work, 'projects', '-r', 's.jsonl'), '{"m":1}\n');
  env.respond = (type, text, items) => (type === 'warning' && /Share history/.test(text) ? items[0] : undefined);
  messages.length = 0;
  await commands.get('claudeAccounts.toggleHistorySharing')();
  assert.strictEqual(settings.claudeAccounts.shareHistory, true);
  assert.strictEqual(read(path.join(base, 'history.jsonl')), '{"p":"base","timestamp":1}\n{"p":"work","timestamp":2}\n');
  assert.ok(fs.existsSync(path.join(base, 'projects', '-r', 's.jsonl')));
  assert.strictEqual(fs.realpathSync(path.join(work, 'projects')), path.join(base, 'projects'));
  const done = messages.find((m) => /History shared across/.test(m.text));
  assert.ok(done && /Backups: .*\.backups/.test(done.text), done && done.text);

  env.respond = (type, text, items) => (type === 'warning' && /Stop sharing/.test(text) ? items[0] : undefined); // "Copy current history"
  await commands.get('claudeAccounts.toggleHistorySharing')();
  assert.strictEqual(settings.claudeAccounts.shareHistory, false);
  assert.ok(!fs.lstatSync(path.join(work, 'projects')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(work, 'projects', '-r', 's.jsonl')), 'each account keeps a copy');
});

test('removing an account removes its rules and moves the folder to the trash, never the base profile', async () => {
  const work = path.join(home, '.claude-accounts', 'work');
  settings.claudeAccounts.rules = [
    { pattern: '~/w/**', account: 'Work' },
    { pattern: '~/p/**', account: 'personal-2' },
  ];
  await context.globalState.update('repoDefaults', { 'remote:x/y': { id: 'work' }, 'remote:x/z': 'personal-2' });
  env.respond = (type, text, items) => (/Remove account/.test(text) ? items[1] : undefined); // "move folder to trash"
  await commands.get('claudeAccounts.remove')('work');
  assert.ok(!fs.existsSync(work));
  assert.strictEqual(read(path.join(base, 'settings.json')), '{"base":true}');
  assert.strictEqual(read(path.join(base, 'agents', 'a.md')), 'agent');
  assert.deepStrictEqual(settings.claudeAccounts.rules, [{ pattern: '~/p/**', account: 'personal-2' }]);
  assert.deepStrictEqual(context.globalState.get('repoDefaults'), { 'remote:x/z': 'personal-2' });
  assert.ok(!context.globalState.get('accountMeta').work);
  assert.ok(messages.some((m) => /Its folder is in the trash/.test(m.text)));
});

test('without a trash the folder is only deleted after an explicit confirmation', async () => {
  const p2 = path.join(home, '.claude-accounts', 'personal-2');
  env.noTrash = true;
  env.respond = (type, text, items) => (/Remove account/.test(text) ? items[1] : undefined); // declines permanent deletion
  await commands.get('claudeAccounts.remove')('personal-2');
  assert.ok(fs.existsSync(p2), 'kept, because permanent deletion was not confirmed');
  assert.ok(!context.globalState.get('accounts').some((a) => a.id === 'personal-2'));
});

test('folders that must never be deleted', () => {
  const profile = env.load('profile');
  for (const p of [base, home, path.dirname(home), path.join(home, '.claude-accounts'), path.parse(home).root]) {
    assert.ok(!profile.safeToDelete(p), `${p} must be refused`);
  }
  assert.ok(profile.safeToDelete(path.join(home, '.claude-accounts', 'x')));
});
