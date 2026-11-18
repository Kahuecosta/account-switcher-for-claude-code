'use strict';
// The repository default is applied synchronously during activation, before Claude Code starts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup({}, { folders: [] });
const { context, home, write, messages, extensions } = env;
test.after(env.dispose);

const repoDir = path.join(home, 'src', 'api');
const work = path.join(home, '.claude-accounts', 'work');
const other = path.join(home, '.claude-accounts', 'other');

test('a synced default with another e-mail is not applied to the wrong login', async () => {
  write(path.join(repoDir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  env.vscode.workspace.workspaceFolders = [{ uri: { fsPath: repoDir, scheme: 'file' }, name: 'api' }];
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [
    { id: 'work', dir: work, mode: 'isolated' },
    { id: 'other', dir: other, mode: 'isolated' },
  ]);
  await context.globalState.update('accountMeta', { work: { name: 'Work' }, other: { name: 'Other' } });
  // On this machine "work" is logged in as someone else; "other" has the e-mail the default was set for.
  write(path.join(work, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'someone@else.com' } }));
  write(path.join(other, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@acme.com' } }));
  // Last known identity, as stored by an earlier session (startup must not need to read files first).
  await context.globalState.update('accountIdentity', {
    work: { email: 'someone@else.com', loggedIn: true },
    other: { email: 'dev@acme.com', loggedIn: true },
  });
  await context.globalState.update('repoDefaults', { 'remote:github.com/acme/api': { id: 'work', email: 'dev@acme.com' } });
  // The Claude Code extension was already running (its panel was restored).
  extensions['anthropic.claude-code'] = { isActive: true, packageJSON: { version: '2.1.312' }, extensionPath: '/nowhere' };

  const ext = require('../../src/extension');
  ext.activate(context);
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, other, 'applied synchronously, matched by e-mail');
  const environment = env.load('environment');
  assert.strictEqual(environment.state.startedWithId, '__default__', 'the running panel still uses the launch environment');
  assert.ok(environment.reloadPending('other'));
  env.respond = () => undefined;
  await ext._internals.promptsDone();
  assert.strictEqual(context.workspaceState.get('selectedAccount'), 'other');
  assert.strictEqual(context.workspaceState.get('lastAppliedRepoDefault'), 'other');
  assert.ok(
    messages.some((m) => /Claude Code account: Other \(repository default\)\. Reload the window now\?/.test(m.text)),
    'a reload is offered'
  );
});

test('an uncertain start is settled by the session the restored panel registered', () => {
  const environment = env.load('environment');
  assert.ok(environment.state.uncertain, 'unverified while no session is known');
  assert.strictEqual(environment.verifyStart([repoDir]), false, 'no session yet: the safe assumption stays');
  assert.ok(environment.reloadPending('__default__'), 'while uncertain, switching to Default still reloads');
  // The panel's CLI started after the environment was applied, so it registered in the account folder.
  const session = { pid: process.pid, cwd: repoDir, startedAt: Date.now(), entrypoint: 'claude-vscode' };
  write(path.join(other, 'sessions', `${process.pid}.json`), JSON.stringify(session));
  assert.strictEqual(environment.verifyStart([repoDir]), true);
  assert.strictEqual(environment.state.startedWithId, 'other');
  assert.strictEqual(environment.state.uncertain, null);
  assert.ok(!environment.reloadPending('other'), 'no false "reload pending" for the account in use');
  assert.ok(environment.reloadPending('__default__'), 'switching back to Default reloads');
  fs.rmSync(path.join(other, 'sessions'), { recursive: true, force: true });
});

test('a session in the launch folder confirms the panel kept the launch environment', () => {
  const environment = env.load('environment');
  environment.markStartUncertain({ id: 'other', dir: other }, path.join(home, '.claude'));
  const session = { pid: process.pid, cwd: repoDir, startedAt: Date.now(), entrypoint: 'claude-vscode' };
  write(path.join(home, '.claude', 'sessions', `${process.pid}.json`), JSON.stringify(session));
  assert.strictEqual(environment.verifyStart([repoDir]), true);
  assert.strictEqual(environment.state.startedWithId, '__default__');
  assert.ok(environment.reloadPending('other'), 'the reload is still offered');
  fs.rmSync(path.join(home, '.claude', 'sessions'), { recursive: true, force: true });
});

test('the sessions folders are watched, so the start is settled as soon as the panel registers', async () => {
  const environment = env.load('environment');
  fs.mkdirSync(path.join(other, 'sessions'), { recursive: true });
  environment.markStartUncertain({ id: 'other', dir: other }, path.join(home, '.claude'));
  const watcher = environment.watchStart(); // the launch folder has no sessions/ yet: skipped
  try {
    const session = { pid: process.pid, cwd: repoDir, startedAt: Date.now(), entrypoint: 'claude-vscode' };
    write(path.join(other, 'sessions', `${process.pid}.json`), JSON.stringify(session));
    for (let i = 0; i < 50 && environment.state.uncertain; i++) await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(environment.state.uncertain, null, 'settled by the watcher, without a timed check');
    assert.strictEqual(environment.state.startedWithId, 'other');
  } finally {
    watcher.dispose();
    fs.rmSync(path.join(other, 'sessions'), { recursive: true, force: true });
  }
});

test('a default whose e-mail matches no login here applies nothing', () => {
  const repo = env.load('repo');
  assert.strictEqual(repo.accountForStored({ id: 'work', email: 'nobody@acme.com' }), null);
  assert.strictEqual(repo.accountForStored({ id: 'work' }).id, 'work', 'defaults from 1.x (id only) still work');
  assert.strictEqual(repo.accountForStored({ id: 'gone' }), null);
});

test('rules accept an e-mail and multi-root conflicts are reported', async () => {
  const repo = env.load('repo');
  const second = path.join(home, 'personal', 'site');
  fs.mkdirSync(second, { recursive: true });
  env.vscode.workspace.workspaceFolders.push({ uri: { fsPath: second, scheme: 'file' }, name: 'site' });
  env.settings.claudeAccounts.rules = [{ pattern: '~/personal/**', account: 'SOMEONE@else.com' }];
  repo.detectRepos();
  const d = repo.resolveDefault();
  assert.strictEqual(d.account.id, 'other', 'the explicit repository default wins');
  assert.deepStrictEqual(d.conflicts, ['site']);
  env.vscode.workspace.workspaceFolders.shift();
  repo.detectRepos();
  assert.strictEqual(repo.resolveDefault().account.id, 'work', 'rule matched by e-mail');
  assert.strictEqual(repo.resolveDefault().source, 'rule');
});
