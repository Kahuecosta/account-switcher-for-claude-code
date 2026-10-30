'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup();
const { context, settings, home, write, watchers, messages, calls, commands } = env;
test.after(env.dispose);

test('activation migrates 1.x data, applies the account, moves secrets, fixes the overriding setting', async () => {
  const dir = path.join(home, '.claude-accounts', 'work');
  fs.mkdirSync(dir, { recursive: true });
  const personal = path.join(home, '.claude-accounts', 'personal');
  write(path.join(personal, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@home.com' } }));
  // 1.0 stored the name inside the local record; 1.1 stored variables in plain globalState.
  await context.globalState.update('accounts', [
    { id: 'work', name: 'Work', dir, mode: 'isolated' },
    { id: 'personal', name: 'Personal', dir: personal, mode: 'isolated' },
  ]);
  await context.globalState.update('accountEnv', {
    work: { ANTHROPIC_MODEL: 'opus', ANTHROPIC_API_KEY: 'sk-SECRET', CLAUDE_CONFIG_DIR: '/evil' },
  });
  await context.workspaceState.update('selectedAccount', 'work');
  settings.claudeCode.environmentVariables = [
    { name: 'HTTP_PROXY', value: 'x' },
    { name: 'CLAUDE_CONFIG_DIR', value: '/old' },
  ];
  settings.claudeAccounts.suggestSwitchOnLimit = false;
  write(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } })
  );
  write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.com', organizationName: 'ACME' } }));

  const ext = require('../../src/extension');
  const api = ext.activate(context);
  // Synchronously, before anything was awaited: the environment is in place, legacy variables included.
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir);
  assert.strictEqual(process.env.ANTHROPIC_MODEL, 'opus');
  assert.strictEqual(process.env.ANTHROPIC_API_KEY, 'sk-SECRET');
  await ext._internals.promptsDone();

  assert.deepStrictEqual(context.globalState.get('accounts')[0], { id: 'work', dir, mode: 'isolated' });
  assert.strictEqual(context.globalState.get('accountMeta').work.name, 'Work');
  assert.deepStrictEqual(context.globalState.synced, ['accountMeta', 'repoDefaults']);
  assert.strictEqual(context.globalState.get('accountEnv'), undefined, '1.x variables were migrated');
  assert.deepStrictEqual(context.globalState.get('accountEnvironment').work, {
    ANTHROPIC_MODEL: { value: 'opus' },
    ANTHROPIC_API_KEY: { secret: true },
  });
  assert.strictEqual(context.secrets.data['env:work:ANTHROPIC_API_KEY'], 'sk-SECRET');
  assert.ok(!JSON.stringify(context.globalState.data).includes('sk-SECRET'), 'no secret left in plain storage');
  assert.strictEqual(context.globalState.get('schemaVersion'), 3);
  assert.strictEqual(settings.claudeAccounts.onUsageLimit, 'ignore', 'suggestSwitchOnLimit=false is carried over');

  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir, 'account dir wins over a per-account CLAUDE_CONFIG_DIR');
  const coll = context.environmentVariableCollection;
  assert.strictEqual(coll.vars.CLAUDE_CONFIG_DIR, dir);
  assert.strictEqual(coll.vars.ANTHROPIC_MODEL, 'opus');
  assert.strictEqual(coll.persistent, false);
  assert.deepStrictEqual(settings.claudeCode.environmentVariables, [{ name: 'HTTP_PROXY', value: 'x' }], 'only that entry was removed');
  assert.ok(calls.reload >= 1, 'offered (and here accepted) a reload after removing it');
  assert.ok(watchers.length >= 1, 'limit watcher started');
  assert.ok(!messages.some((m) => /SECRET/.test(m.text || '')), 'tokens never surface');

  assert.strictEqual(context.globalState.get('accountIdentity').work.email, 'me@work.com');
  assert.strictEqual(context.globalState.get('accountIdentity').work.plan, 'Max 20x');
  assert.ok(!JSON.stringify(context.globalState.get('accountIdentity')).includes('SECRET'));

  // Public API.
  assert.strictEqual(api.apiVersion, 1);
  assert.strictEqual(api.getCurrentAccount().id, 'work');
  assert.strictEqual(api.getCurrentAccount().email, 'me@work.com');
  assert.deepStrictEqual(
    api.getAccounts().map((a) => a.id),
    ['__default__', 'work', 'personal']
  );
  assert.strictEqual(await api.switchAccount('nobody'), false);

  // Every command in package.json is registered, and nothing registered is missing from it.
  const declared = context.extension.packageJSON.contributes.commands.map((c) => c.command).sort();
  assert.deepStrictEqual([...commands.keys()].sort(), declared);
});

test('switching to the Default account restores the launch environment', async () => {
  env.respond = () => undefined; // dismiss prompts
  await commands.get('claudeAccounts.switch')('__default__');
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, undefined);
  assert.strictEqual(process.env.ANTHROPIC_MODEL, undefined);
  assert.strictEqual(process.env.ANTHROPIC_API_KEY, undefined);
  assert.deepStrictEqual(context.environmentVariableCollection.vars, {});
  assert.strictEqual(context.workspaceState.get('previousAccount'), 'work');
  // Back to where the window started: no reload needed.
  messages.length = 0;
  await commands.get('claudeAccounts.switchToPrevious')();
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude-accounts', 'work'));
  assert.ok(
    messages.some((m) => m.text === 'Claude Code account: Work.' && m.items.length === 0),
    'no reload offered when returning to the started account'
  );
});

test('a command given an unknown account fails with a readable error', async () => {
  messages.length = 0;
  await commands.get('claudeAccounts.switch')('ghost');
  assert.ok(messages.some((m) => m.type === 'error' && m.text.includes('No account matches "ghost"')));
});
