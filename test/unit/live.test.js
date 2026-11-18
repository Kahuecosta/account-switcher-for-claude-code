'use strict';
// Switching without reloading the window (src/live.js): Claude Code is told through
// claudeCode.environmentVariables, which must end exactly as it was; and conversations continue in a new
// tab from a forked copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setup, tick } = require('./helpers');
const { encodeProjectDir } = require('../../lib/usage');
const { forkSession } = require('../../lib/conversations');

const env = setup({ reloadBehavior: 'never' });
const { context, home, write, messages, commands, settings } = env;
test.after(env.dispose);

const dir = (id) => path.join(home, '.claude-accounts', id);
const SIGNATURE = 'CLAUDE_CONFIG_DIR changed in the claudeCode.environmentVariables setting';
const SID = 'a1b2c3d4-1111-4222-8333-444455556666';

// A Claude Code extension on disk, with or without the code that follows CLAUDE_CONFIG_DIR changes.
function official({ version, supports, active = true }) {
  const p = path.join(home, `official-${version}`);
  write(path.join(p, 'extension.js'), `// minified\n${supports ? `log("${SIGNATURE}; refreshing every webview")` : 'nothing'}\n`);
  env.extensions['anthropic.claude-code'] = { isActive: active, packageJSON: { version, main: './extension.js' }, extensionPath: p };
}

// Every write to claudeCode.environmentVariables, in order.
const writes = [];
const realGetConfiguration = env.vscode.workspace.getConfiguration;
env.vscode.workspace.getConfiguration = (sec) => {
  const c = realGetConfiguration(sec);
  if (sec !== 'claudeCode') return c;
  return {
    ...c,
    update: async (k, v, target) => {
      if (k === 'environmentVariables') writes.push(JSON.parse(JSON.stringify(v ?? null)));
      await tick(5); // a real write takes time: lets concurrent calls interleave if they could
      return c.update(k, v, target);
    },
  };
};
const opened = [];

test('setup: two accounts, Claude Code running with a build that follows account changes', async () => {
  for (const id of ['work', 'side']) {
    write(path.join(dir(id), '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: id, emailAddress: `${id}@x.com` } }));
  }
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [
    { id: 'work', dir: dir('work'), mode: 'isolated' },
    { id: 'side', dir: dir('side'), mode: 'isolated' },
  ]);
  await context.globalState.update('accountMeta', { work: { name: 'Work' }, side: { name: 'Side' } });
  await context.workspaceState.update('selectedAccount', 'work');
  official({ version: '2.1.327', supports: true });
  commands.set('claude-vscode.editor.open', async (...args) => opened.push(args));
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
  await ext._internals.promptsDone();
});

test('startup: a Claude Code panel that started first is told, so no reload is needed', () => {
  const environment = env.load('environment');
  assert.strictEqual(environment.state.panelAccountId, 'work');
  assert.ok(!environment.reloadPending('work'));
  assert.strictEqual(environment.state.uncertain, null, 'told about the account: nothing left to verify (no false "reload pending")');
  assert.ok(env.calls.reload === 0);
});

test('switching: done without a reload, and claudeCode.environmentVariables ends exactly as it was', async () => {
  const userValue = [{ name: 'HTTPS_PROXY', value: 'http://proxy:8080' }];
  settings.claudeCode.environmentVariables = JSON.parse(JSON.stringify(userValue));
  writes.length = 0;
  messages.length = 0;
  const switching = env.load('switching');
  const how = await switching.selectAccount(env.load('accounts').findAccount('side'));
  assert.strictEqual(how, 'live');
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir('side'));
  assert.ok(!env.load('environment').reloadPending('side'), 'nothing pending');
  assert.strictEqual(env.calls.reload, 0, 'no reload');
  assert.deepStrictEqual(settings.claudeCode.environmentVariables, userValue, 'the user value is back, untouched');
  assert.strictEqual(writes.length, 2);
  assert.ok(
    writes[0].some((e) => e.name === 'CLAUDE_ACCOUNTS_REFRESH'),
    'Claude Code was told'
  );
  assert.ok(
    writes[0].some((e) => e.name === 'HTTPS_PROXY'),
    'the user entries stay meanwhile'
  );
  assert.ok(messages.some((m) => /New chats use it now; conversations already open keep their account/.test(m.text)));
});

test('switching: the setting is restored in its own format, or removed when it was not set', async () => {
  const live = env.load('live');
  settings.claudeCode.environmentVariables = { FOO: 'bar' };
  assert.strictEqual(await live.notify(), true);
  assert.deepStrictEqual(settings.claudeCode.environmentVariables, { FOO: 'bar' });
  delete settings.claudeCode.environmentVariables;
  assert.strictEqual(await live.notify(), true);
  assert.ok(!('environmentVariables' in settings.claudeCode), 'not left as an empty list');
  settings.claudeCode.environmentVariables = 'not a list';
  assert.strictEqual(await live.notify(), false, 'an unexpected value is never rewritten');
  assert.strictEqual(settings.claudeCode.environmentVariables, 'not a list');
  settings.claudeCode.environmentVariables = [];
});

test('switching: quick switches never interleave their writes, and the panel ends on the latest account', async () => {
  const switching = env.load('switching');
  const accounts = env.load('accounts');
  settings.claudeCode.environmentVariables = [{ name: 'KEEP', value: '1' }];
  writes.length = 0;
  await Promise.all([
    switching.selectAccount(accounts.findAccount('work'), undefined, { silent: true }),
    switching.selectAccount(accounts.findAccount('side'), undefined, { silent: true }),
  ]);
  const marked = writes.map((w) => (Array.isArray(w) && w.some((e) => e.name === 'CLAUDE_ACCOUNTS_REFRESH') ? 'add' : 'restore'));
  assert.ok(marked.length >= 2 && marked.length % 2 === 0, marked.join());
  assert.ok(
    marked.every((m, i) => m === (i % 2 ? 'restore' : 'add')),
    `never interleaved: ${marked.join()}`
  );
  assert.deepStrictEqual(settings.claudeCode.environmentVariables, [{ name: 'KEEP', value: '1' }]);
  assert.strictEqual(accounts.selectedAccount().id, 'side');
  assert.strictEqual(env.load('environment').state.panelAccountId, 'side');
});

test('switching away and straight back, while Claude Code is being told, ends on the account chosen last', async () => {
  const switching = env.load('switching');
  const accounts = env.load('accounts');
  const environment = env.load('environment');
  assert.strictEqual(environment.state.panelAccountId, 'side');
  writes.length = 0;
  const first = switching.selectAccount(accounts.findAccount('work'), undefined, { silent: true });
  await tick(1); // Claude Code is being told about Work...
  const second = switching.selectAccount(accounts.findAccount('side'), undefined, { silent: true }); // ...and back
  await Promise.all([first, second]);
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir('side'));
  assert.strictEqual(environment.state.panelAccountId, 'side');
  // The last time Claude Code was told, the environment already said Side.
  assert.ok(writes.length >= 2);
});

test('falls back to a reload: feature off, CLAUDE_CONFIG_DIR in the setting, or an older Claude Code', async () => {
  const switching = env.load('switching');
  const accounts = env.load('accounts');
  const environment = env.load('environment');
  const cases = [
    () => {
      settings.claudeAccounts.switchWithoutReload = false;
      return () => delete settings.claudeAccounts.switchWithoutReload;
    },
    () => {
      settings.claudeCode.environmentVariables = [{ name: 'CLAUDE_CONFIG_DIR', value: '/x' }];
      return () => (settings.claudeCode.environmentVariables = []);
    },
    () => {
      official({ version: '2.0.0', supports: false });
      return () => official({ version: '2.1.327', supports: true });
    },
  ];
  for (const make of cases) {
    const undo = make();
    try {
      writes.length = 0;
      const target = accounts.selectedAccount().id === 'work' ? 'side' : 'work';
      assert.strictEqual(await switching.selectAccount(accounts.findAccount(target), undefined, { silent: true }), 'reload');
      assert.ok(environment.reloadPending(target), 'the panel still uses the previous account');
      assert.strictEqual(writes.length, 0, 'the setting is not touched');
    } finally {
      undo();
    }
    // Back in sync for the next case.
    const back = accounts.selectedAccount().id;
    environment.state.panelAccountId = back;
  }
});

test('the support check reads the Claude Code code once per version', async () => {
  const live = env.load('live');
  official({ version: '9.9.9', supports: true });
  assert.strictEqual(await live.officialSupports(), true);
  fs.writeFileSync(path.join(home, 'official-9.9.9', 'extension.js'), 'changed');
  assert.strictEqual(await live.officialSupports(), true, 'cached for this version');
  official({ version: '9.9.10', supports: false });
  assert.strictEqual(await live.officialSupports(), false);
  official({ version: '2.1.327', supports: true });
  delete env.extensions['anthropic.claude-code'];
  assert.strictEqual(await live.officialSupports(), false, 'not installed');
  official({ version: '2.1.327', supports: true });
});

test('a marker left by an interrupted switch is removed at the next start', async () => {
  const live = env.load('live');
  settings.claudeCode.environmentVariables = [
    { name: 'KEEP', value: '1' },
    { name: 'CLAUDE_ACCOUNTS_REFRESH', value: '123' },
  ];
  await live.cleanup();
  assert.deepStrictEqual(settings.claudeCode.environmentVariables, [{ name: 'KEEP', value: '1' }]);
  settings.claudeCode.environmentVariables = [{ name: 'CLAUDE_ACCOUNTS_REFRESH', value: '123' }];
  await live.cleanup();
  assert.ok(!('environmentVariables' in settings.claudeCode));
  settings.claudeCode.environmentVariables = [];
});

test('continuing with another account: a forked copy opens in a new tab, without a reload', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const switching = env.load('switching');
  await switching.selectAccount(accounts.findAccount('work'), undefined, { silent: true });
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = encodeProjectDir(folder);
  const original = path.join(dir('work'), 'projects', project, `${SID}.jsonl`);
  write(original, `{"type":"user","sessionId":"${SID}","message":{"content":"hi"}}\n`);
  opened.length = 0;
  messages.length = 0;
  await handoff.continueInPanel(accounts.findAccount('side'));
  assert.strictEqual(accounts.selectedAccount().id, 'side');
  assert.strictEqual(env.calls.reload, 0, 'no reload');
  assert.strictEqual(opened.length, 1);
  const [id] = opened[0];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notStrictEqual(id, SID, 'a new id: the tab holding the original keeps it');
  const fork = fs.readFileSync(path.join(dir('side'), 'projects', project, `${id}.jsonl`), 'utf8');
  assert.ok(fork.includes(`"sessionId":"${id}"`) && !fork.includes(SID));
  assert.ok(fs.readFileSync(original, 'utf8').includes(SID), 'the original is untouched');
  assert.ok(messages.some((m) => /continues in a new tab as "Side"\. The tab you were using stays with "Work"/.test(m.text)));
  assert.strictEqual(context.workspaceState.get('resumeConversation'), undefined, 'nothing waits for a reload');
});

test('fork: ids are replaced in the conversation, its subagent files and their names; checkpoints are copied', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-fork-')));
  const from = path.join(root, 'a');
  const to = path.join(root, 'b');
  const pd = path.join(from, 'projects', '-r');
  const big = 'x'.repeat(200000);
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(JSON.stringify({ sessionId: SID, i, big }));
  write(path.join(pd, `${SID}.jsonl`), lines.join('\r\n') + '\r\n');
  write(path.join(pd, SID, 'subagents', `agent-${SID}.jsonl`), JSON.stringify({ sessionId: SID }) + '\n');
  write(path.join(pd, SID, 'tool-results', 'r.txt'), `binary-ish ${SID}`);
  write(path.join(from, 'file-history', SID, 'abc@v1'), 'v1');
  const id = await forkSession({ id: SID, file: path.join(pd, `${SID}.jsonl`), projectDir: pd }, from, to);
  const out = fs
    .readFileSync(path.join(to, 'projects', '-r', `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);
  assert.strictEqual(out.length, 30, 'every line, CRLF or not');
  assert.ok(out.every((l) => JSON.parse(l).sessionId === id));
  const sub = path.join(to, 'projects', '-r', id);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sub, 'subagents', `agent-${id}.jsonl`), 'utf8')).sessionId, id);
  assert.strictEqual(
    fs.readFileSync(path.join(sub, 'tool-results', 'r.txt'), 'utf8'),
    `binary-ish ${SID}`,
    'other files copied as they are'
  );
  assert.strictEqual(fs.readFileSync(path.join(to, 'file-history', id, 'abc@v1'), 'utf8'), 'v1');
  assert.ok(fs.readFileSync(path.join(pd, `${SID}.jsonl`), 'utf8').includes(SID), 'the original is untouched');
  assert.deepStrictEqual(
    fs.readdirSync(path.join(to, 'projects', '-r')).filter((n) => n.includes('.tmp')),
    []
  );
  await assert.rejects(forkSession({ id: '../x', file: '', projectDir: pd }, from, to), /Not a session id/);
});

test('review 5.6: an edit made while Claude Code is told is kept; nothing is written when the marker is already gone', async () => {
  const live = env.load('live');
  settings.claudeCode.environmentVariables = [{ name: 'A', value: '1' }];
  // Someone edits the setting right after the marker is written.
  const realUpdate = env.vscode.workspace.getConfiguration;
  let step = 0;
  env.vscode.workspace.getConfiguration = (sec) => {
    const c = realUpdate(sec);
    if (sec !== 'claudeCode') return c;
    return {
      ...c,
      update: async (k, v, target) => {
        await c.update(k, v, target);
        if (k === 'environmentVariables' && step++ === 0) settings.claudeCode.environmentVariables = [...v, { name: 'B', value: '2' }];
      },
    };
  };
  try {
    assert.strictEqual(await live.notify(), true);
    assert.deepStrictEqual(settings.claudeCode.environmentVariables, [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
    // Another window took the marker out already: nothing to write back.
    step = 0;
    env.vscode.workspace.getConfiguration = (sec) => {
      const c = realUpdate(sec);
      if (sec !== 'claudeCode') return c;
      return {
        ...c,
        update: async (k, v, target) => {
          await c.update(k, v, target);
          if (k === 'environmentVariables' && step++ === 0) settings.claudeCode.environmentVariables = [{ name: 'C', value: '3' }];
        },
      };
    };
    assert.strictEqual(await live.notify(), true);
    assert.deepStrictEqual(settings.claudeCode.environmentVariables, [{ name: 'C', value: '3' }], 'their value stays');
  } finally {
    env.vscode.workspace.getConfiguration = realUpdate;
    settings.claudeCode.environmentVariables = [];
  }
});

test('review 7.4: an empty list or object you set yourself stays; a setting that did not exist is removed again', async () => {
  const live = env.load('live');
  for (const empty of [[], {}]) {
    settings.claudeCode.environmentVariables = JSON.parse(JSON.stringify(empty));
    assert.strictEqual(await live.notify(), true);
    assert.deepStrictEqual(settings.claudeCode.environmentVariables, empty);
  }
  delete settings.claudeCode.environmentVariables;
  assert.strictEqual(await live.notify(), true);
  assert.ok(!('environmentVariables' in settings.claudeCode));
  settings.claudeCode.environmentVariables = [];
});

test('review 7.5: unset, empty and marker-only all mean "no variables"; a real change does not', () => {
  const { userVariables } = env.load('live');
  const none = userVariables(undefined);
  for (const v of [[], {}, [{ name: 'CLAUDE_ACCOUNTS_REFRESH', value: '1' }], { CLAUDE_ACCOUNTS_REFRESH: '1' }])
    assert.strictEqual(userVariables(v), none);
  assert.notStrictEqual(userVariables([{ name: 'A', value: '1' }]), none);
  assert.strictEqual(
    userVariables([
      { name: 'A', value: '1' },
      { name: 'CLAUDE_ACCOUNTS_REFRESH', value: '2' },
    ]),
    userVariables([{ name: 'A', value: '1' }])
  );
});

test('review 7.6: a failed read is not remembered, and a .cjs entry point is read', async () => {
  const live = env.load('live');
  const p = path.join(home, 'official-cjs');
  env.extensions['anthropic.claude-code'] = {
    isActive: true,
    packageJSON: { version: '7.0.0', main: './dist/extension.cjs' },
    extensionPath: p,
  };
  assert.strictEqual(await live.officialSupports(), false, 'missing for now');
  write(path.join(p, 'dist', 'extension.cjs'), `x("${SIGNATURE}")`);
  assert.strictEqual(await live.officialSupports(), true, 'found once it can be read');
  official({ version: '2.1.327', supports: true });
});
