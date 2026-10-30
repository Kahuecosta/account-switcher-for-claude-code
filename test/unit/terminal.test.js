'use strict';
// Regression: the login terminal of another account used to inherit the window's environment
// collection (which sets the current account), so logging in went to the wrong account.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup();
const { context, home, terminals, commands } = env;
test.after(env.dispose);

const work = path.join(home, '.claude-accounts', 'work');
const personal = path.join(home, '.claude-accounts', 'personal');

test('setup: two accounts, window on "work"', async () => {
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(personal, { recursive: true });
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [
    { id: 'work', dir: work, mode: 'isolated' },
    { id: 'personal', dir: personal, mode: 'isolated' },
  ]);
  await context.globalState.update('accountMeta', { work: { name: 'Work', color: 'blue' }, personal: { name: 'Personal' } });
  await context.globalState.update('accountEnvironment', {
    work: { ANTHROPIC_MODEL: { value: 'opus' } },
    personal: { ANTHROPIC_MODEL: { value: 'sonnet' } },
  });
  await context.workspaceState.update('selectedAccount', 'work');
  process.env.ELECTRON_RUN_AS_NODE = '1';
  process.env.VSCODE_IPC_HOOK = '/tmp/ipc';
  process.env.VSCODE_PORTABLE = '/kept';
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
  assert.strictEqual(context.environmentVariableCollection.vars.CLAUDE_CONFIG_DIR, work);
});

test('logging in to another account uses only that account, with strictEnv', async () => {
  env.respond = () => undefined;
  await commands.get('claudeAccounts.login')('personal');
  const term = terminals.at(-1);
  assert.strictEqual(term.options.strictEnv, true, 'the window environment collection must not apply');
  assert.strictEqual(term.options.env.CLAUDE_CONFIG_DIR, personal);
  assert.strictEqual(term.options.env.ANTHROPIC_MODEL, 'sonnet');
  assert.strictEqual(term.options.isTransient, true);
  assert.deepStrictEqual(term.sent, ['claude auth login']);
  const pathKey = Object.keys(term.options.env).find((k) => k.toUpperCase() === 'PATH'); // "Path" on Windows
  assert.strictEqual(term.options.env[pathKey], process.env.PATH, 'a complete environment');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in term.options.env), 'extension-host variables are removed');
  assert.ok(!('VSCODE_IPC_HOOK' in term.options.env));
  assert.strictEqual(term.options.env.VSCODE_PORTABLE, '/kept', 'like VS Code, VSCODE_PORTABLE is kept');
});

test('logging in to the Default account removes CLAUDE_CONFIG_DIR and the other account variables', async () => {
  await commands.get('claudeAccounts.login')('__default__');
  const term = terminals.at(-1);
  assert.ok(!('CLAUDE_CONFIG_DIR' in term.options.env));
  assert.ok(!('ANTHROPIC_MODEL' in term.options.env), 'variables of the window account do not leak');
});

test('a terminal as another account does not change the window', async () => {
  await commands.get('claudeAccounts.openTerminal')('Personal');
  const term = terminals.at(-1);
  assert.strictEqual(term.options.env.CLAUDE_CONFIG_DIR, personal);
  assert.deepStrictEqual(term.sent, ['claude']);
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, work);
  assert.strictEqual(term.options.isTransient, false);
});

test('API-key accounts get the key from secret storage', async () => {
  const accounts = env.load('accounts');
  await accounts.saveRecords([
    ...accounts.getRecords(),
    { id: 'ci', dir: path.join(home, '.claude-accounts', 'ci'), mode: 'isolated', kind: 'apiKey' },
  ]);
  await accounts.setEnvVar('ci', 'ANTHROPIC_API_KEY', 'sk-ant-123', true);
  assert.ok(!JSON.stringify(context.globalState.data).includes('sk-ant-123'));
  await commands.get('claudeAccounts.openTerminal')('ci');
  assert.strictEqual(terminals.at(-1).options.env.ANTHROPIC_API_KEY, 'sk-ant-123');
  // "Log in" for a key-based account edits its variables instead of opening a login terminal.
  const before = terminals.length;
  env.pickQuick = () => undefined;
  await commands.get('claudeAccounts.login')('ci');
  assert.strictEqual(terminals.length, before);
});
