'use strict';
// With the extension activated: usage of every account without the status line bridge, continuing a
// conversation with another account in the panel, the Accounts view, login detection, the bundled CLI,
// per-chat accounts and the rating prompt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup, tick } = require('./helpers');
const { encodeProjectDir } = require('../../lib/usage');

const env = setup({ reloadBehavior: 'never' });
const { context, home, write, messages, commands, webviews, settings } = env;
test.after(env.dispose);

const dir = (id) => path.join(home, '.claude-accounts', id);
const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const usage = (uuid, five, seven) => ({
  oauthAccount: {
    accountUuid: uuid,
    emailAddress: `${uuid}@x.com`,
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_5x',
  },
  cachedUsageUtilization: {
    fetchedAtMs: Date.now() - 3600e3,
    accountUuid: uuid,
    utilization: {
      five_hour: { utilization: five, resets_at: new Date(Date.now() + 3600e3).toISOString() },
      seven_day: { utilization: seven, resets_at: new Date(Date.now() + 3 * 864e5).toISOString() },
    },
  },
});
const opened = [];

test('setup: two accounts with usage saved by Claude Code, live quota off', async () => {
  write(path.join(dir('work'), '.claude.json'), JSON.stringify(usage('work', 81, 20)));
  write(path.join(dir('side'), '.claude.json'), JSON.stringify(usage('side', 5, 10)));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [
    { id: 'work', dir: dir('work'), mode: 'isolated' },
    { id: 'side', dir: dir('side'), mode: 'isolated' },
  ]);
  await context.globalState.update('accountMeta', { work: { name: 'Work', color: 'teal' }, side: { name: 'Side' } });
  await context.workspaceState.update('selectedAccount', 'work');
  const ext = path.join(home, 'ext');
  write(
    path.join(
      ext,
      'resources',
      'native-binaries',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'claude.exe' : 'claude'
    ),
    ''
  );
  env.extensions['anthropic.claude-code'] = { isActive: false, packageJSON: { version: '2.1.326' }, extensionPath: ext };
  commands.set('claude-vscode.editor.open', async (...args) => opened.push(args));
  env.respond = () => undefined;
  const extension = require('../../src/extension');
  extension.activate(context);
  await extension._internals.startupDone();
});

test('usage of every account is read from .claude.json, and settings.json is never touched', () => {
  const quota = env.load('quota');
  assert.strictEqual(quota.quotaOf('work')?.fiveHour?.usedPct, 81);
  assert.strictEqual(quota.quotaOf('side')?.sevenDay?.usedPct, 10);
  assert.strictEqual(quota.quotaOf('__default__'), null, 'nothing saved for the Default account');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')), 'no status line bridge');
  assert.strictEqual(env.load('accounts').getIdentity('work')?.plan, 'Max 5x', 'plan without .credentials.json');
  assert.deepStrictEqual(
    env
      .load('limits')
      .rankCandidates(env.load('accounts').findAccount('work'))
      .map((a) => a.id),
    ['side'],
    'signed-in accounts with quota left (the Default account is not logged in here)'
  );
});

test('the Accounts view: one card per account with meters, and only known actions run', async () => {
  const { viewModel } = env.load('ui/panel');
  const m = viewModel();
  const work = m.cards.find((c) => c.id === 'work');
  assert.strictEqual(work.current, true);
  assert.strictEqual(work.color, 'teal');
  assert.deepStrictEqual(
    work.windows.map((w) => [w.label, w.pct]),
    [
      ['5-hour', 81],
      ['weekly', 20],
    ]
  );
  assert.ok(
    work.notes.some((n) => /^as of /.test(n)),
    'an hour-old reading says when it is from'
  );

  const provider = webviews.get('claudeAccounts.panel');
  assert.ok(provider, 'registered');
  const ran = [];
  const before = env.calls.executed.length;
  commands.set('claudeAccounts.manage', async (id) => ran.push(id));
  await provider.onMessage({ type: 'action', action: 'manage', id: 'side' });
  await provider.onMessage({ type: 'action', action: 'manage', id: 'nobody' });
  await provider.onMessage({ type: 'action', action: 'workbench.action.files.delete', id: 'side' });
  await provider.onMessage({ type: 'action', action: '__proto__' });
  assert.deepStrictEqual(ran, ['side']);
  assert.deepStrictEqual(env.calls.executed.slice(before), ['claudeAccounts.manage']);
});

test('continue with another account: with an older Claude Code running, the conversation reopens after the reload', async () => {
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  const src = path.join(dir('work'), 'projects', encodeProjectDir(folder), `${SID}.jsonl`);
  write(src, '{"type":"user"}\n');
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  // Claude Code is running, but this build cannot follow an account change without a reload.
  env.extensions['anthropic.claude-code'].isActive = true;
  try {
    await handoff.continueInPanel(accounts.findAccount('side'));
  } finally {
    env.extensions['anthropic.claude-code'].isActive = false;
  }
  assert.strictEqual(
    fs.readFileSync(path.join(dir('side'), 'projects', encodeProjectDir(folder), `${SID}.jsonl`), 'utf8'),
    '{"type":"user"}\n'
  );
  assert.strictEqual(accounts.selectedAccount().id, 'side');
  assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dir('side'));
  assert.deepStrictEqual(context.workspaceState.get('resumeConversation')?.id, SID, 'waits for the reload');
  assert.deepStrictEqual(opened, [], 'the panel still runs as Work until the reload');

  // After the reload the window starts as Side, and the conversation opens there.
  env.load('environment').state.panelAccountId = 'side';
  await handoff.resumePending();
  assert.deepStrictEqual(opened, [[SID]]);
  assert.strictEqual(context.workspaceState.get('resumeConversation'), undefined);
  await handoff.resumePending();
  assert.strictEqual(opened.length, 1, 'only once');
});

test('continue with another account: with Claude Code not running yet, it opens right away (no reload)', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  opened.length = 0;
  await handoff.continueInPanel(accounts.findAccount('work'));
  assert.strictEqual(accounts.selectedAccount().id, 'work');
  assert.ok(!env.load('environment').reloadPending('work'), 'the panel will start with Work');
  assert.deepStrictEqual(opened, [[SID]], 'opened without waiting for a reload');
  // Back to Side for the tests below.
  await env.load('switching').selectAccount(accounts.findAccount('side'), undefined, { silent: true });
});

test('a terminal for another account resumes a forked copy (never the same file as a panel tab) and finds the bundled claude', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const term = await handoff.continueInTerminal(accounts.findAccount('work'));
  const m = /^claude --resume ([0-9a-f-]{36})$/.exec(term.sent.at(-1) || '');
  assert.ok(m && m[1] !== SID, JSON.stringify(term.sent));
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.ok(fs.existsSync(path.join(dir('work'), 'projects', encodeProjectDir(folder), `${m[1]}.jsonl`)), 'the copy is in Work');
  const key = Object.keys(term.options.env).find((k) => k.toUpperCase() === 'PATH');
  const cli = env.load('cli');
  if (!cli.onPath(process.env))
    assert.ok(
      term.options.env[key].endsWith(path.join(home, 'ext', 'resources', 'native-binaries', `${process.platform}-${process.arch}`)),
      'bundled binary added at the end of PATH'
    );
  assert.ok(
    cli.bundledCandidates('/e', 'linux', 'x64').includes(path.join('/e', 'resources', 'native-binary', 'claude')),
    'older layout still found'
  );
});

test('login is noticed as soon as Claude Code saves it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  write(path.join(dir('new'), '.keep'), '');
  await env.load('state').update('accounts', [...env.stored('accounts'), { id: 'new', dir: dir('new'), mode: 'isolated' }]);
  const accounts = env.load('accounts');
  messages.length = 0;
  await env.load('commands').cmdLogin(accounts.findAccount('new'));
  write(path.join(dir('new'), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'new@x.com' } }));
  t.mock.timers.tick(2000);
  for (let i = 0; i < 50 && !messages.some((m) => /Logged in to/.test(m.text)); i++) await tick(10);
  assert.ok(
    messages.some((m) => m.text === 'Logged in to "new" as new@x.com.'),
    messages.map((m) => m.text).join(' | ')
  );
  env.load('commands').stopLoginWatches();
});

test(
  'per-chat accounts: the launcher is set, routes a new chat, and the previous wrapper comes back',
  { skip: process.platform === 'win32' },
  async () => {
    const perChat = env.load('perChat');
    settings.claudeCode.claudeProcessWrapper = '/opt/my-wrapper';
    await env.vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', true, 1);
    await perChat.sync();
    assert.strictEqual(settings.claudeCode.claudeProcessWrapper, perChat.scriptPath());
    const script = fs.readFileSync(perChat.scriptPath(), 'utf8');
    assert.ok(script.includes("orig='/opt/my-wrapper'"), 'your own wrapper keeps running');
    assert.strictEqual(
      fs.statSync(perChat.scriptPath()).mode & 0o777,
      0o755,
      'written executable, never replaced by a file that cannot run'
    );
    fs.chmodSync(perChat.scriptPath(), 0o644); // lost its execute bit (restored from a backup)
    await perChat.sync();
    assert.strictEqual(fs.statSync(perChat.scriptPath()).mode & 0o777, 0o755, 'repaired even though its content did not change');
    assert.ok(fs.readFileSync(path.join(home, '.claude-accounts', '.bridge', 'accounts.list'), 'utf8').includes(dir('side')));
    assert.ok(perChat.active());

    opened.length = 0;
    await perChat.openAs(env.load('accounts').findAccount('work'));
    assert.deepStrictEqual(opened, [[]], 'a new chat');
    const route = path.join(home, '.claude-accounts', '.bridge', 'route', String(process.env[perChat.WINDOW_VAR]));
    assert.match(fs.readFileSync(route, 'utf8'), new RegExp(`^\\d+\\t${dir('work').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));

    await env.vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', false, 1);
    await perChat.sync();
    assert.strictEqual(settings.claudeCode.claudeProcessWrapper, '/opt/my-wrapper');
  }
);

test('rating: asked only after a week and a few switches, at most twice', () => {
  const { due } = env.load('rating');
  const week = 7 * 864e5;
  const base = { first: 0, switches: 5, asked: 0, lastAsked: 0, done: false };
  assert.strictEqual(due(base, week - 1), false, 'too early');
  assert.strictEqual(due({ ...base, switches: 4 }, week), false, 'not used enough');
  assert.strictEqual(due(base, week), true);
  assert.strictEqual(due({ ...base, asked: 1, lastAsked: week }, week + 864e5), false, 'not again within 30 days');
  assert.strictEqual(due({ ...base, asked: 2, lastAsked: 0 }, 400 * 864e5), false, 'never a third time');
  assert.strictEqual(due({ ...base, done: true }, week), false);
});

test('review: the status bar shows the window closest to its limit', () => {
  const quota = env.load('quota');
  const accounts = env.load('accounts');
  const sb = env.load('ui/statusBar');
  const orig = env.vscode.window.createStatusBarItem;
  let item;
  env.vscode.window.createStatusBarItem = () => (item = { show() {}, hide() {}, dispose() {} });
  sb.create();
  env.vscode.window.createStatusBarItem = orig;
  const cur = accounts.selectedAccount();
  // A reading where the week is nearly used up but the 5-hour window is empty.
  const snaps = { fiveHour: { usedPct: 0, resetsAt: null }, sevenDay: { usedPct: 97, resetsAt: null }, at: Date.now(), source: 'cache' };
  const map = new Map([[cur.id, snaps]]);
  const realQuotaOf = quota.quotaOf;
  quota.quotaOf = (id) => map.get(id) || null;
  try {
    sb.update();
  } finally {
    quota.quotaOf = realQuotaOf;
  }
  assert.ok(item.text.endsWith('· 97%'), item.text);
});

test('review: with extra usage on, the threshold still offers an account with free quota', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  const cur = accounts.selectedAccount();
  await accounts.setLimit(cur.id, null);
  limits.checkQuota(cur, {
    fiveHour: { usedPct: 99, resetsAt: Date.now() + 3600e3 },
    sevenDay: null,
    extra: { used: 1, limit: null, currency: 'USD' },
    at: Date.now(),
  });
  await tick(20);
  assert.ok(accounts.activeLimit(cur.id), 'another subscription with quota left beats paying for extra usage');
  await accounts.setLimit(cur.id, null);
});

test('review: continuing as a logged-out account asks to log in instead', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const before = accounts.selectedAccount().id;
  const target = accounts.allAccounts().find((a) => a.id !== before && accounts.isSignedIn(a) === false);
  assert.ok(target, 'the Default account is not logged in here');
  messages.length = 0;
  await handoff.continueInPanel(target);
  assert.strictEqual(accounts.selectedAccount().id, before, 'no switch');
  assert.ok(messages.some((m) => /is not logged in/.test(m.text)));
});

test('review: with only the claude CLI, continuing switches and resumes in a terminal', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const saved = env.extensions['anthropic.claude-code'];
  delete env.extensions['anthropic.claude-code'];
  try {
    const target = accounts.allAccounts().find((a) => a.id !== accounts.selectedAccount().id && accounts.isSignedIn(a) !== false);
    const n = env.terminals.length;
    await handoff.continueInPanel(target);
    assert.strictEqual(accounts.selectedAccount().id, target.id);
    const term = env.terminals.at(-1);
    assert.strictEqual(env.terminals.length, n + 1);
    assert.match(term.sent.at(-1), /^claude --resume [0-9a-f-]{36}$/);
  } finally {
    env.extensions['anthropic.claude-code'] = saved;
  }
});

test(
  'review: a later "New chat as account" keeps its route when the earlier one expires',
  { skip: process.platform === 'win32' },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const perChat = env.load('perChat');
    const accounts = env.load('accounts');
    const route = path.join(home, '.claude-accounts', '.bridge', 'route', String(process.env[perChat.WINDOW_VAR]));
    await perChat.openAs(accounts.findAccount('work'));
    t.mock.timers.tick(20e3);
    await perChat.openAs(accounts.findAccount('side'));
    t.mock.timers.tick(15e3); // the first route's cleanup runs now
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.ok(fs.readFileSync(route, 'utf8').includes(dir('side')), 'the newer route is still there');
  }
);

test('review: the Accounts view page is locked down and its script compiles', () => {
  const vm = require('vm');
  const { html } = env.load('ui/panel');
  const page = html('vscode-webview://x', 'pt-br');
  assert.match(page, /<html lang="pt-br">/);
  assert.match(page, /default-src 'none'; style-src vscode-webview:\/\/x 'nonce-[^']+'; script-src 'nonce-[^']+';/);
  const markup = page.replace(/<script[\s\S]*<\/script>/, '');
  assert.ok(!/\son[a-z]+=/i.test(markup), 'no inline event handlers');
  assert.ok(!/innerHTML|insertAdjacentHTML|eval\(/.test(page), 'no HTML built from strings');
  const script = /** @type {RegExpMatchArray} */ (page.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/))[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.notStrictEqual(html('x').match(/nonce-([^']+)/)[1], html('x').match(/nonce-([^']+)/)[1], 'a new nonce each time');
});

test('review 2: a failed copy still switches, and says why', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  const cur = accounts.selectedAccount();
  const target = accounts.allAccounts().find((a) => a.id !== cur.id && accounts.isSignedIn(a) !== false);
  write(path.join(accounts.configDirOf(cur), 'projects', encodeProjectDir(folder), `${SID}.jsonl`), '{"x":1}\n{"x":2}\n{"x":3}\n{"x":4}\n');
  // The target's project folder is a file, so the copy fails.
  const blocked = path.join(accounts.configDirOf(target), 'projects', encodeProjectDir(folder));
  fs.rmSync(blocked, { recursive: true, force: true });
  write(blocked, 'not a folder');
  messages.length = 0;
  try {
    await handoff.continueInPanel(target);
    assert.strictEqual(accounts.selectedAccount().id, target.id, 'switched anyway');
    assert.ok(
      messages.some((m) => /could not be copied/.test(m.text)),
      messages.map((m) => m.text).join(' | ')
    );
    assert.strictEqual(context.workspaceState.get('resumeConversation'), undefined, 'nothing to reopen');
  } finally {
    fs.rmSync(blocked, { force: true });
  }
});

test('review 5: continuing in a terminal never falls back to another conversation when the copy fails', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  const cur = accounts.selectedAccount();
  const target = accounts.allAccounts().find((a) => a.id !== cur.id && accounts.isSignedIn(a) !== false);
  write(path.join(accounts.configDirOf(cur), 'projects', encodeProjectDir(folder), `${SID}.jsonl`), '{"y":1}\n'.repeat(20));
  const blocked = path.join(accounts.configDirOf(target), 'projects', encodeProjectDir(folder));
  fs.rmSync(blocked, { recursive: true, force: true });
  write(blocked, 'not a folder');
  const n = env.terminals.length;
  try {
    assert.strictEqual(await handoff.continueInTerminal(target), undefined);
    assert.strictEqual(env.terminals.length, n, 'no terminal running `claude --continue` on the wrong conversation');
  } finally {
    fs.rmSync(blocked, { force: true });
  }
});

test('review 8: a pending conversation is dropped when the window moved on to another account', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const other = accounts.allAccounts().find((a) => a.id !== accounts.selectedAccount().id);
  await context.workspaceState.update('resumeConversation', { id: SID, account: other.id, at: Date.now() });
  opened.length = 0;
  await handoff.resumePending();
  assert.strictEqual(context.workspaceState.get('resumeConversation'), undefined, 'forgotten');
  assert.deepStrictEqual(opened, [], 'and never opened later by surprise');
});

test('review 7: a token renewal is not taken for a login; a real login is announced once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const accounts = env.load('accounts');
  const a = accounts.findAccount('side');
  const json = path.join(dir('side'), '.claude.json');
  const creds = path.join(dir('side'), '.credentials.json');
  messages.length = 0;
  await env.load('commands').cmdLogin(a);
  // Claude Code renews the token of the account already signed in: same e-mail.
  write(creds, JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'renewed' } }));
  t.mock.timers.tick(2000);
  await tick(50);
  assert.ok(!messages.some((m) => /Logged in to/.test(m.text)), 'not announced');
  // The user signs in to another account in that terminal.
  write(json, JSON.stringify({ ...usage('side', 5, 10), oauthAccount: { accountUuid: 'other', emailAddress: 'other@x.com' } }));
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(2000);
    await tick(20);
  }
  assert.strictEqual(messages.filter((m) => m.text === 'Logged in to "Side" as other@x.com.').length, 1);
  env.load('commands').stopLoginWatches();
  write(json, JSON.stringify(usage('side', 5, 10)));
  await env.load('identity').refreshAllIdentities();
});

test('review 6/3.3: the base profile reaches the launcher through the window, already expanded', () => {
  const perChat = env.load('perChat');
  const { rt } = env.load('runtime');
  const saved = rt.ORIGINAL_ENV;
  try {
    rt.ORIGINAL_ENV = '~/.claude-main';
    perChat.init();
    assert.strictEqual(process.env.CLAUDE_ACCOUNTS_BASE, path.join(home, '.claude-main'));
    rt.ORIGINAL_ENV = undefined;
    perChat.init();
    assert.strictEqual(process.env.CLAUDE_ACCOUNTS_BASE, undefined, 'without it: ~/.claude without the variable');
  } finally {
    rt.ORIGINAL_ENV = saved;
    perChat.init();
  }
});

test('review 2.1: a routed chat drops the variables of the window account (real shell)', { skip: process.platform === 'win32' }, () => {
  const { execFileSync } = require('child_process');
  const w = require('../../lib/wrapper');
  const root = path.join(home, 'wrap-env');
  const bridge = path.join(root, 'bridge');
  write(path.join(bridge, w.SCRIPT_NAME), w.wrapperScript({ bridgeDir: bridge, baseDir: path.join(root, 'base') }));
  write(path.join(bridge, w.ROUTE_DIR, 'win9'), w.routeLine(path.join(root, 'sub')));
  const fake = path.join(root, 'fake');
  write(fake, '#!/bin/sh\nprintf "%s|%s|%s" "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY-unset}" "${KEEP-unset}"\n');
  fs.chmodSync(fake, 0o755);
  const run = (/** @type {string} */ dirNow) =>
    execFileSync('sh', [path.join(bridge, w.SCRIPT_NAME), fake], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        CLAUDE_ACCOUNTS_WINDOW: 'win9',
        CLAUDE_CONFIG_DIR: dirNow,
        ANTHROPIC_API_KEY: 'sk-window',
        KEEP: 'user',
        [w.VARS_VAR]: 'ANTHROPIC_API_KEY,bad name,1X',
      },
    });
  assert.strictEqual(run(path.join(root, 'api')), `${path.join(root, 'sub')}|unset|user`, 'another account: the key is dropped');
  assert.strictEqual(run(path.join(root, 'sub')), `${path.join(root, 'sub')}|sk-window|user`, 'same account: nothing dropped');
});

test('review 2.1: only accounts signed in with their own login can be used for a single chat', async () => {
  const perChat = env.load('perChat');
  const accounts = env.load('accounts');
  assert.strictEqual(perChat.eligible(accounts.findAccount('side')), true);
  await accounts.setEnvVar('side', 'ANTHROPIC_API_KEY', 'sk-x', true);
  try {
    assert.strictEqual(perChat.eligible(accounts.findAccount('side')), false);
    await assert.rejects(perChat.openAs(accounts.findAccount('side')), /can only be used by switching the window/);
    const card = env
      .load('ui/panel')
      .viewModel()
      .cards.find((c) => c.id === 'side');
    assert.strictEqual(card.newChat, false, 'no "New chat" button');
  } finally {
    await accounts.removeEnvVar('side', 'ANTHROPIC_API_KEY');
  }
  // The window publishes only the names of its account's variables.
  const { applyEnv } = env.load('environment');
  await accounts.setEnvVar('work', 'ANTHROPIC_MODEL', 'opus', false);
  applyEnv(accounts.findAccount('work'));
  assert.strictEqual(process.env.CLAUDE_ACCOUNTS_VARS, 'ANTHROPIC_MODEL');
  await accounts.removeEnvVar('work', 'ANTHROPIC_MODEL');
  applyEnv(accounts.findAccount('work'));
  assert.strictEqual(process.env.CLAUDE_ACCOUNTS_VARS, undefined);
  applyEnv(accounts.selectedAccount());
});

test('review 2.2/2.7: an old launcher path (other root, other machine) is recognized and removed when off', async () => {
  const perChat = env.load('perChat');
  settings.claudeCode.claudeProcessWrapper = '/elsewhere/.bridge/claude-accounts-wrapper.sh';
  await env.vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', false, 1);
  await perChat.sync();
  assert.strictEqual(settings.claudeCode.claudeProcessWrapper, undefined, 'never left pointing at a missing script');
});

test('review 2.4: continuing back to an account makes its copy the newest', async () => {
  const { copySession } = require('../../lib/conversations');
  const from = path.join(home, 'nw', 'a');
  const to = path.join(home, 'nw', 'b');
  const s = { id: SID, file: path.join(from, 'projects', '-r', `${SID}.jsonl`), projectDir: path.join(from, 'projects', '-r') };
  write(s.file, 'same\n');
  write(path.join(to, 'projects', '-r', `${SID}.jsonl`), 'same\n');
  const past = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(to, 'projects', '-r', `${SID}.jsonl`), past, past);
  await copySession(s, from, to);
  assert.ok(fs.statSync(path.join(to, 'projects', '-r', `${SID}.jsonl`)).mtimeMs >= fs.statSync(s.file).mtimeMs);
});

test('review 2.10: a window only the older reading knows is kept', () => {
  const { mergeQuota } = require('../../lib/quota');
  const cached = { fiveHour: { usedPct: 1, resetsAt: null }, sevenDay: { usedPct: 97, resetsAt: null }, at: 1, source: 'cache' };
  const bridged = { fiveHour: { usedPct: 3, resetsAt: null }, sevenDay: null, at: 2, source: 'statusline' };
  const m = mergeQuota(/** @type {any} */ (cached), /** @type {any} */ (bridged));
  assert.strictEqual(m?.fiveHour?.usedPct, 3);
  assert.strictEqual(m?.sevenDay?.usedPct, 97);
});

test('review 2.6: the bundled claude goes last on PATH', () => {
  const cli = env.load('cli');
  const out = cli.withClaudeOnPath({ PATH: path.join(home, 'nowhere') });
  assert.ok(out.PATH.startsWith(path.join(home, 'nowhere') + path.delimiter), out.PATH);
});

test('review 4.2: each window gets its own id, and terminals of other accounts carry none of the launcher variables', () => {
  const perChat = env.load('perChat');
  const { terminalEnvFor } = env.load('environment');
  process.env.CLAUDE_ACCOUNTS_WINDOW = 'inherited-from-a-terminal';
  perChat.init();
  assert.notStrictEqual(process.env.CLAUDE_ACCOUNTS_WINDOW, 'inherited-from-a-terminal');
  const t = terminalEnvFor(env.load('accounts').findAccount('side'));
  for (const k of ['CLAUDE_ACCOUNTS_WINDOW', 'CLAUDE_ACCOUNTS_VARS', 'CLAUDE_ACCOUNTS_BASE']) assert.ok(!(k in t), k);
});

test('review 4.6: with nothing to carry over, the terminal starts a new conversation', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const cur = accounts.selectedAccount();
  const target = accounts.allAccounts().find((a) => a.id !== cur.id);
  fs.rmSync(path.join(accounts.configDirOf(cur), 'projects'), { recursive: true, force: true });
  messages.length = 0;
  const term = await handoff.continueInTerminal(target);
  assert.deepStrictEqual(term.sent, ['claude']);
  assert.ok(messages.some((m) => /Starting a new one/.test(m.text)));
});

test('review 5.4: an old usage reading never triggers the threshold', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  const cur = accounts.selectedAccount();
  await accounts.setLimit(cur.id, null);
  limits.checkQuota(cur, { fiveHour: { usedPct: 99, resetsAt: null }, sevenDay: null, at: Date.now() - 3 * 3600e3 });
  await tick(20);
  assert.ok(!accounts.activeLimit(cur.id), 'three hours old: the window may have moved on');
});

test('review 6.6: the conversation that hit the limit is the one carried, even when it is not the latest', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const cur = accounts.selectedAccount();
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  const pd = path.join(accounts.configDirOf(cur), 'projects', encodeProjectDir(folder));
  const limited = '1b2b3b4b-0000-4000-8000-00000000000a';
  const newer = '1b2b3b4b-0000-4000-8000-00000000000b';
  write(path.join(pd, `${limited}.jsonl`), `{"sessionId":"${limited}"}\n`);
  write(path.join(pd, `${newer}.jsonl`), `{"sessionId":"${newer}"}\n`);
  const past = new Date(Date.now() - 600e3);
  fs.utimesSync(path.join(pd, `${limited}.jsonl`), past, past);
  assert.strictEqual((await handoff.sessionToCarry(cur, path.join(pd, `${limited}.jsonl`)))?.id, limited);
  assert.strictEqual(
    (await handoff.sessionToCarry(cur, path.join(pd, limited, 'subagents', 'agent-x.jsonl')))?.id,
    limited,
    'from a subagent transcript too'
  );
  assert.strictEqual((await handoff.sessionToCarry(cur))?.id, newer, 'without a file: the latest');
});

test('review 6.2: with only the claude CLI, a fork continues (never the same file); started on its own, no terminal opens', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const saved = env.extensions['anthropic.claude-code'];
  delete env.extensions['anthropic.claude-code'];
  try {
    const cur = accounts.selectedAccount();
    const target = accounts.allAccounts().find((a) => a.id !== cur.id && accounts.isSignedIn(a) !== false);
    const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
    const pd = path.join(accounts.configDirOf(cur), 'projects', encodeProjectDir(folder));
    const sid = '2c2c2c2c-0000-4000-8000-000000000001';
    write(path.join(pd, `${sid}.jsonl`), `{"sessionId":"${sid}"}\n`);
    const n = env.terminals.length;
    messages.length = 0;
    await handoff.continueInPanel(target, 'usage limit reached', { file: path.join(pd, `${sid}.jsonl`), auto: true });
    assert.strictEqual(accounts.selectedAccount().id, target.id);
    assert.strictEqual(env.terminals.length, n, 'nothing opens on its own');
    assert.ok(
      messages.some((m) => m.items?.includes('Continue in terminal')),
      'offered instead'
    );
    const back = accounts.allAccounts().find((a) => a.id === cur.id);
    await handoff.continueInPanel(back, undefined, {});
    const term = env.terminals.at(-1);
    const m = /^claude --resume ([0-9a-f-]{36})$/.exec(term.sent.at(-1) || '');
    assert.ok(m, JSON.stringify(term.sent));
  } finally {
    env.extensions['anthropic.claude-code'] = saved;
  }
});

test('review 6.3: a conversation that went on before the reload is copied again when it reopens', async () => {
  const handoff = env.load('handoff');
  const accounts = env.load('accounts');
  const cur = accounts.selectedAccount();
  const target = accounts.allAccounts().find((a) => a.id !== cur.id && accounts.isSignedIn(a) !== false);
  const folder = env.vscode.workspace.workspaceFolders[0].uri.fsPath;
  const sid = '3d3d3d3d-0000-4000-8000-000000000001';
  const src = path.join(accounts.configDirOf(cur), 'projects', encodeProjectDir(folder), `${sid}.jsonl`);
  const dst = path.join(accounts.configDirOf(target), 'projects', encodeProjectDir(folder), `${sid}.jsonl`);
  write(src, 'one\n');
  write(dst, 'one\n'); // copied before the reload
  write(src, 'one\ntwo-written-before-the-reload\n');
  await env.load('switching').selectAccount(target, undefined, { silent: true });
  await context.workspaceState.update('resumeConversation', { id: sid, account: target.id, from: cur.id, at: Date.now() });
  env.load('environment').state.panelAccountId = target.id;
  opened.length = 0;
  await handoff.resumePending();
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'one\ntwo-written-before-the-reload\n');
  assert.deepStrictEqual(opened, [[sid]]);
});

test('review 7.7: a reading of unknown age never triggers the threshold', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  const cur = accounts.selectedAccount();
  await accounts.setLimit(cur.id, null);
  limits.checkQuota(cur, { fiveHour: { usedPct: 99, resetsAt: null }, sevenDay: null, at: null });
  await tick(20);
  assert.ok(!accounts.activeLimit(cur.id));
});

test('the Accounts view offers "New chat" only while per-chat accounts are on', { skip: process.platform === 'win32' }, async () => {
  const { viewModel } = env.load('ui/panel');
  const perChat = env.load('perChat');
  await env.vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', false, 1);
  await perChat.sync();
  assert.ok(
    viewModel().cards.every((c) => !c.newChat),
    'an experimental mode is not advertised on every card'
  );
  await env.vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', true, 1);
  await perChat.sync();
  assert.ok(viewModel().cards.some((c) => c.newChat));
  await env.vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', false, 1);
  await perChat.sync();
});
