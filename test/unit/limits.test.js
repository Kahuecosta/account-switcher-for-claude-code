'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup, tick } = require('./helpers');

const env = setup({ liveQuota: true, quotaThreshold: 90 });
const { context, home, write, watchers, messages } = env;
test.after(env.dispose);

const dir = (id) => path.join(home, '.claude-accounts', id);
const snapshot = (id, five, seven) =>
  write(
    path.join(dir(id), '.multi-account-statusline.json'),
    JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: five, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        seven_day: { used_percentage: seven, resets_at: Math.floor(Date.now() / 1000) + 5 * 86400 },
      },
    })
  );
const limitLine = (cwd, text = "You've hit your session limit") =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    cwd,
    isApiErrorMessage: true,
    message: { content: [{ type: 'text', text }] },
  }) + '\n';

test('setup: three logged-in accounts with live quota', async () => {
  for (const id of ['work', 'a', 'b']) {
    fs.mkdirSync(path.join(dir(id), 'projects'), { recursive: true });
    write(path.join(dir(id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${id}@x.com` } }));
  }
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  snapshot('a', 70, 80);
  snapshot('b', 10, 20);
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update(
    'accounts',
    ['work', 'a', 'b'].map((id) => ({ id, dir: dir(id), mode: 'isolated' }))
  );
  await context.globalState.update('accountMeta', { work: { name: 'Work' }, a: { name: 'A' }, b: { name: 'B' } });
  await context.workspaceState.update('selectedAccount', 'work');
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
  // The Default account is not logged in here.
  await context.globalState.update('accountIdentity', {
    ...context.globalState.get('accountIdentity'),
    __default__: { email: null, loggedIn: false },
  });
  assert.ok(
    fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8').includes('claude-accounts-statusline'),
    'bridge installed in the base profile'
  );
  assert.ok(
    fs.readFileSync(path.join(dir('a'), 'settings.json'), 'utf8').includes('claude-accounts-statusline'),
    'and in isolated accounts'
  );
});

test('candidates: signed in, not limited, lowest usage first', () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  assert.deepStrictEqual(
    limits.rankCandidates(accounts.findAccount('work')).map((a) => a.id),
    ['b', 'a']
  );
});

test('a limit in another folder is ignored; one in this window is offered with the best account', async () => {
  const watcher = watchers.find((w) => !w.disposed && w.pattern.pattern.endsWith('*.jsonl'));
  const elsewhere = path.join(dir('work'), 'projects', '-other', 's.jsonl');
  write(elsewhere, limitLine('/somewhere/else'));
  for (const h of watcher.handlers) await h({ fsPath: elsewhere });
  assert.ok(!messages.some((m) => /hit its usage limit/.test(m.text)), 'other folders do not count');

  const here = path.join(dir('work'), 'projects', 'x', 's.jsonl');
  write(here, limitLine(path.join(home, 'sub')));
  env.respond = () => undefined;
  for (const h of watcher.handlers) await h({ fsPath: here });
  const msg = messages.find((m) => /"Work" hit its usage limit/.test(m.text));
  assert.ok(msg, messages.map((m) => m.text).join(' | '));
  assert.strictEqual(msg.items[0].title, 'Switch to B');
  assert.ok(env.load('accounts').activeLimit('work'), 'recorded for every window');
});

test('the same account is not prompted twice within 20 minutes', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  messages.length = 0;
  await limits.onLimitReached(accounts.findAccount('work'), { kind: 'session', resetAt: null });
  assert.ok(!messages.some((m) => /hit its usage limit/.test(m.text)));
});

test('switch mode moves to the best account automatically', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  const { selectAccount } = env.load('switching');
  await selectAccount(accounts.findAccount('a'));
  env.settings.claudeAccounts.onUsageLimit = 'switch';
  await limits.onLimitReached(accounts.findAccount('a'), { kind: 'weekly', resetAt: null });
  assert.strictEqual(accounts.selectedAccount().id, 'b', 'work is limited, so b');
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir('b'));
  const l = accounts.activeLimit('a');
  assert.ok(l && !l.estimated, 'with no reset time from the log, the weekly reset comes from live quota when known');
});

test('live quota above the threshold acts before the limit is hit', async () => {
  const accounts = env.load('accounts');
  env.settings.claudeAccounts.onUsageLimit = 'suggest';
  messages.length = 0;
  snapshot('b', 95, 30);
  const w = watchers.filter((x) => !x.disposed && x.pattern.pattern === '.multi-account-statusline.json').at(-1);
  for (const h of w.handlers) await h({ fsPath: path.join(dir('b'), '.multi-account-statusline.json') });
  await tick();
  assert.ok(
    messages.some((m) => /"B" has used 95% of its 5-hour limit/.test(m.text)),
    messages.map((m) => m.text).join(' | ')
  );
  assert.ok(accounts.activeLimit('b'));
});

test('limits expire and the focused window announces it', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  await accounts.setLimit('a', { at: Date.now() - 10e3, until: Date.now() - 1, kind: 'session' });
  messages.length = 0;
  await limits.checkExpired();
  assert.ok(!accounts.getLimits().a);
  assert.ok(messages.some((m) => /"A" is available again/.test(m.text)));
});

test('turning live quota off restores every status line', async () => {
  await env.vscode.workspace.getConfiguration('claudeAccounts').update('liveQuota', false, 1);
  await tick(50);
  assert.ok(!fs.readFileSync(path.join(dir('a'), 'settings.json'), 'utf8').includes('claude-accounts-statusline'));
  assert.ok(!fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8').includes('statusLine'));
});
