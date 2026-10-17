'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup();
const { ext, I, context, settings, home, write, watchers, messages } = env;

test('slugify and initials', () => {
  assert.strictEqual(I.slugify('Trabalho Ação!'), 'trabalho-acao');
  assert.strictEqual(I.initials('Trabalho'), 'TR');
  assert.strictEqual(I.initials('Minha Empresa'), 'ME');
});

test('activation: migrates 1.0 data, applies account + per-account env, clears overriding setting', async () => {
  const dir = path.join(home, '.claude-accounts', 'work');
  fs.mkdirSync(dir, { recursive: true });
  // 1.0 stored the name inside the local record
  const personal = path.join(home, '.claude-accounts', 'personal');
  write(path.join(personal, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@home.com' } }));
  await context.globalState.update('accounts', [
    { id: 'work', name: 'Work', dir, mode: 'isolated' },
    { id: 'personal', name: 'Personal', dir: personal, mode: 'isolated' },
  ]);
  await context.globalState.update('accountEnv', { work: { ANTHROPIC_MODEL: 'opus', CLAUDE_CONFIG_DIR: '/evil' } });
  await context.workspaceState.update('selectedAccount', 'work');
  settings.claudeCode.environmentVariables = [{ name: 'HTTP_PROXY', value: 'x' }, { name: 'CLAUDE_CONFIG_DIR', value: '/old' }];
  write(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.com', organizationName: 'ACME' } }));

  await ext.activate(context);
  await I.startupDone();

  assert.deepStrictEqual(context.globalState.get('accounts')[0], { id: 'work', dir, mode: 'isolated' });
  assert.strictEqual(context.globalState.get('accountMeta').work.name, 'Work');
  assert.deepStrictEqual(context.globalState.synced, ['accountMeta', 'repoDefaults']);
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir, 'account dir wins over per-account env');
  assert.strictEqual(process.env.ANTHROPIC_MODEL, 'opus');
  const coll = context.environmentVariableCollection;
  assert.strictEqual(coll.vars.CLAUDE_CONFIG_DIR, dir);
  assert.strictEqual(coll.vars.ANTHROPIC_MODEL, 'opus');
  assert.strictEqual(coll.persistent, false);
  assert.deepStrictEqual(settings.claudeCode.environmentVariables, [{ name: 'HTTP_PROXY', value: 'x' }]);
  assert.ok(watchers.length === 1, 'limit watcher started');
  assert.ok(!messages.some((m) => m.includes('SECRET')), 'tokens never surface');
});

test('per-account env is restored when switching back to the default account', () => {
  const desired = I.desiredEnv({ id: '__default__', dir: null, env: {} });
  assert.deepStrictEqual(desired, {});
});

test('finds unregistered account folders for import', () => {
  fs.mkdirSync(path.join(home, '.claude-accounts', 'legacy'), { recursive: true });
  assert.deepStrictEqual(I.findUnregisteredDirs().map((d) => path.basename(d)), ['legacy']);
});

test('rules resolve the default account when the repository has none', () => {
  settings.claudeAccounts.rules = [{ pattern: '~/nowhere/**', account: 'work' }, { pattern: home, account: 'Personal' }];
  const d = I.resolveDefault();
  assert.strictEqual(d.source, 'rule');
  assert.strictEqual(d.account.id, 'personal', 'matched by name, case-insensitive');
  settings.claudeAccounts.rules = [];
});

test('a rate-limit line in this window\'s session log offers switching accounts', async () => {
  const { encodeProjectDir } = require('../lib/usage');
  const dir = path.join(home, '.claude-accounts', 'work');
  const file = path.join(dir, 'projects', encodeProjectDir(home), 'session.jsonl');
  write(file, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), isApiErrorMessage: true, error: 'rate_limit',
    message: { content: [{ type: 'text', text: 'API Error: Rate limit reached' }] },
  }) + '\n');
  const before = messages.length;
  for (const h of watchers[0].handlers) await h({ fsPath: file });
  await new Promise((r) => setTimeout(r, 20));
  const shown = messages.slice(before);
  assert.ok(shown.some((m) => m.includes('"Work" hit its usage limit')), shown.join(' | '));
});
