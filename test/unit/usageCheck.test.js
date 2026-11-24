'use strict';
// Having Claude Code check an account's usage: the exchange with the binary (a stand-in script here),
// and which accounts are checked, when.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup, tick } = require('./helpers');
const usageCheck = require('../../lib/usageCheck');
const { checkUsage } = usageCheck; // the real one: the module's is replaced below

const env = setup({}, {});
const { context, home, write, messages, commands } = env;
test.after(env.dispose);

const dir = (id) => path.join(home, '.claude-accounts', id);
const MINUTE = 60e3;

// ───────── the exchange ─────────

const script = path.join(home, 'stand-in.js');
write(
  script,
  `const fs = require('fs');
   const mode = process.env.MODE;
   if (mode === 'exit') process.exit(3);
   const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
   const seen = [];
   let buf = '';
   process.stdin.on('data', (d) => {
     buf += d;
     const lines = buf.split('\\n');
     buf = lines.pop();
     for (const l of lines) {
       const m = JSON.parse(l);
       seen.push(m);
       if (mode === 'silent') continue;
       if (m.request.subtype === 'initialize') {
         process.stdout.write('not json control_response\\n');
         out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
       } else if (mode === 'refuse') {
         out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'not supported' } });
       } else {
         const rate_limits = mode === 'none' ? null : { five_hour: { utilization: 100 } };
         const text = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { rate_limits } } });
         process.stdout.write(text.slice(0, 20));
         setTimeout(() => process.stdout.write(text.slice(20) + '\\n'), 20);
       }
     }
   });
   process.stdin.on('end', () => {
     fs.writeFileSync('seen.json', JSON.stringify(seen));
     if (mode === 'stay') setInterval(() => {}, 1000);
   });`
);
const run = (mode, opts = {}) => checkUsage(process.execPath, { env: { ...process.env, MODE: mode }, cwd: home, args: [script], ...opts });

test('asks for the usage and nothing else, and waits until Claude Code has exited', async () => {
  assert.strictEqual(await run('ok'), true);
  const seen = JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8'));
  assert.deepStrictEqual(
    seen.map((m) => [m.type, m.request.subtype]),
    [
      ['control_request', 'initialize'],
      ['control_request', 'get_usage'],
    ],
    'no user message: nothing is charged to the plan'
  );
  assert.strictEqual(seen[1].request.skip_behaviors, true);
});

test('no plan limits, a refusal, no answer, a binary that fails or does not exist', async () => {
  assert.strictEqual(await run('none'), false);
  await assert.rejects(run('refuse'), /not supported/);
  await assert.rejects(run('silent', { timeoutMs: 600 }), /did not answer in time/);
  await assert.rejects(run('exit'), /exited \(3\) without an answer/);
  await assert.rejects(checkUsage(path.join(home, 'missing'), { env: {}, cwd: home }), /ENOENT/);
});

test('an answered check does not wait for a process that stays', async () => {
  const t0 = Date.now();
  assert.strictEqual(await run('stay', { exitMs: 100 }), true);
  assert.ok(Date.now() - t0 < 5000);
});

test('the real arguments: no customizations, no tools, no saved conversation', () => {
  for (const a of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(usageCheck.ARGS.includes(a), a);
  assert.strictEqual(usageCheck.ARGS[usageCheck.ARGS.indexOf('--tools') + 1], '');
});

// ───────── which accounts, when ─────────

/** Ids of the accounts checked, in order. @type {string[]} */
const checks = [];
const saved = (id, at, five, { resets = Date.now() + 3600e3, seven, extra } = {}) =>
  write(
    path.join(dir(id), '.claude.json'),
    JSON.stringify({
      oauthAccount: { accountUuid: id, emailAddress: `${id}@x.com` },
      cachedUsageUtilization:
        at === null
          ? undefined
          : {
              accountUuid: id,
              fetchedAtMs: at,
              utilization: {
                five_hour: { utilization: five, resets_at: new Date(resets).toISOString() },
                seven_day: seven,
                extra_usage: extra,
              },
            },
    })
  );
/** What the stand-in for Claude Code does with a check of the account. @type {(id: string) => boolean} */
let claude = () => true;
usageCheck.checkUsage = async (_exe, o) => {
  const id = path.basename(String(o.env.CLAUDE_CONFIG_DIR));
  checks.push(id);
  await tick(5);
  if (claude(id)) saved(id, Date.now(), 100);
  return true;
};

test('setup: two signed-in accounts, one signed out and one with an API key', async () => {
  for (const id of ['a', 'b', 'out', 'key']) fs.mkdirSync(dir(id), { recursive: true });
  saved('a', Date.now() - 3 * 3600e3, 24);
  saved('b', Date.now() - 2 * MINUTE, 18);
  write(path.join(dir('out'), '.claude.json'), '{}');
  saved('key', null);
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [
    ...['b', 'a', 'out'].map((id) => ({ id, dir: dir(id), mode: 'isolated' })),
    { id: 'key', dir: dir('key'), mode: 'isolated', kind: 'apiKey' },
  ]);
  await context.workspaceState.update('selectedAccount', 'a');
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
  assert.strictEqual(env.load('quota').quotaOf('a').fiveHour.usedPct, 24, 'what was saved hours ago');
  assert.deepStrictEqual(checks, [], 'starting does not start other processes');
});

test('Refresh checks every signed-in subscription, the current one first, and shows the new figures', async () => {
  await commands.get('claudeAccounts.refresh')();
  assert.deepStrictEqual(checks, ['a', 'b']);
  assert.strictEqual(env.load('quota').quotaOf('a').fiveHour.usedPct, 100);
  assert.ok(!messages.some((m) => m.type === 'warning' && /usage/.test(m.text)), messages.map((m) => m.text).join(' | '));
});

test('a reading younger than a minute is not asked for again (Claude Code would repeat it)', async () => {
  checks.length = 0;
  await commands.get('claudeAccounts.refresh')();
  assert.deepStrictEqual(checks, []);
});

test('automatic checks: only old readings, only while the window is used, and never when turned off', async () => {
  const quota = env.load('quota');
  saved('a', Date.now() - 6 * MINUTE, 50);
  saved('b', Date.now() - 4 * MINUTE, 50);
  // VS Code says "inactive" 10 seconds after the last key or click: that is not leaving the window.
  env.vscode.window.state = { focused: true, active: false };
  await quota.autoCheck(Date.now() + 11 * MINUTE);
  assert.deepStrictEqual(checks, [], 'left alone for a while');
  env.settings.claudeAccounts.usageCheckMinutes = 0;
  await quota.autoCheck();
  assert.deepStrictEqual(checks, []);
  env.settings.claudeAccounts.usageCheckMinutes = 5;
  await Promise.all([quota.autoCheck(), quota.autoCheck()]);
  assert.deepStrictEqual(checks, ['a'], 'b was read 4 minutes ago, by another window for example');
});

test('a failed check is reported when asked for, and not repeated for a while on its own', async () => {
  const quota = env.load('quota');
  claude = (id) => id !== 'b';
  saved('b', Date.now() - 10 * MINUTE, 50);
  checks.length = 0;
  await quota.autoCheck();
  await quota.autoCheck();
  assert.deepStrictEqual(checks, ['b']);
  assert.ok(!messages.some((m) => /could not check/.test(m.text)), 'silent in the background');
  await commands.get('claudeAccounts.refresh')();
  assert.deepStrictEqual(checks, ['b', 'b'], 'asking for it always tries');
  assert.ok(
    messages.some((m) => m.type === 'warning' && /could not check the usage of b\b/.test(m.text)),
    messages.map((m) => m.text).join(' | ')
  );
  assert.strictEqual(quota.quotaOf('b').fiveHour.usedPct, 50, 'the last figures stay');
  claude = () => true;
  await commands.get('claudeAccounts.refresh')();
  assert.strictEqual(quota.quotaOf('b').fiveHour.usedPct, 100);
});

test('each check runs with the environment of its own account', async () => {
  const quota = env.load('quota');
  const seen = [];
  const before = usageCheck.checkUsage;
  usageCheck.checkUsage = async (exe, o) => {
    seen.push({ exe, dir: o.env.CLAUDE_CONFIG_DIR, cwd: o.cwd });
    return before(exe, o);
  };
  saved('b', Date.now() - 10 * MINUTE, 50);
  await quota.checkAll();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].dir, dir('b'), 'not the account of this window');
  assert.strictEqual(seen[0].cwd, context.globalStorageUri.fsPath, 'outside any project');
});

// ───────── one account ─────────

const card = (id) =>
  env
    .load('ui/panel')
    .viewModel()
    .cards.find((c) => c.id === id);

test('one account: only that one is checked, and its card shows it meanwhile', async () => {
  const provider = env.webviews.get('claudeAccounts.panel');
  saved('a', Date.now() - 10 * MINUTE, 50);
  saved('b', Date.now() - 10 * MINUTE, 50);
  await env.load('quota').refreshAllQuota();
  checks.length = 0;
  const run = provider.onMessage({ type: 'action', action: 'refreshAccount', id: 'b' });
  await tick(1);
  assert.strictEqual(card('b').checking, true);
  assert.strictEqual(card('a').checking, false);
  await run;
  assert.deepStrictEqual(checks, ['b']);
  assert.strictEqual(card('b').checking, false);
  assert.ok(card('b').notes.includes('Updated just now · paused until it resets'), card('b').notes.join(' | '));
  assert.ok(card('a').notes.includes('Updated 10 min ago'), card('a').notes.join(' | '));
  await provider.onMessage({ type: 'action', action: 'refreshAccount', id: 'nobody' });
  await provider.onMessage({ type: 'action', action: 'refreshAccount' });
  assert.deepStrictEqual(checks, ['b'], 'only for a known account');
});

test('one account: waits for the running check, and clicks on a fresh reading start nothing', async () => {
  saved('a', Date.now() - 10 * MINUTE, 50);
  saved('b', Date.now() - 10 * MINUTE, 50);
  checks.length = 0;
  const one = (id) => commands.get('claudeAccounts.refreshAccount')(id);
  await Promise.all([commands.get('claudeAccounts.refresh')(), one('b'), one('b'), one('a')]);
  assert.deepStrictEqual([...checks].sort(), ['a', 'b'], 'each account once');
  assert.ok(!card('a').checking && !card('b').checking);
});

test('one account: a failure is reported; accounts without plan limits have no button and are not offered', async () => {
  claude = () => false;
  saved('b', Date.now() - 10 * MINUTE, 50);
  messages.length = 0;
  await commands.get('claudeAccounts.refreshAccount')('b');
  claude = () => true;
  assert.ok(messages.some((m) => m.type === 'warning' && /could not check the usage of b\b/.test(m.text)));
  assert.strictEqual(card('b').checking, false);
  assert.deepStrictEqual(
    ['a', 'b', 'out', 'key', '__default__'].map((id) => card(id).canRefresh),
    [true, true, false, false, false]
  );
  env.pickQuick = () => undefined;
  messages.length = 0;
  await commands.get('claudeAccounts.refreshAccount')();
  const offered = messages
    .find((m) => m.type === 'quickPick')
    .items.map((i) => i.account?.id)
    .filter(Boolean);
  assert.deepStrictEqual(offered.sort(), ['a', 'b']);
  checks.length = 0;
  await commands.get('claudeAccounts.refreshAccount')('key');
  assert.deepStrictEqual(checks, []);
});

// ───────── used up ─────────

test('an account that is used up is left alone until it resets; asking for it still checks it', async () => {
  const quota = env.load('quota');
  const { refreshQuota, autoCheck, pausedUntil } = quota;
  const resets = Date.now() + 40 * MINUTE;
  saved('a', Date.now() - 20 * MINUTE, 100, { resets });
  saved('b', Date.now() - 1000, 99);
  checks.length = 0;
  await autoCheck();
  assert.deepStrictEqual(checks, [], 'nothing can change before the reset');
  assert.strictEqual(pausedUntil('a'), resets);
  assert.strictEqual(pausedUntil('b'), null);
  assert.ok(
    card('a').notes.some((n) => /^as of .* · paused until it resets$/.test(n)),
    card('a').notes.join(' | ')
  );
  await commands.get('claudeAccounts.refreshAccount')('a');
  assert.deepStrictEqual(checks, ['a']);

  // The window reset: it counts from zero and is checked again.
  saved('a', Date.now() - 20 * MINUTE, 100, { resets: Date.now() - 1000 });
  checks.length = 0;
  await refreshQuota(env.load('accounts').findAccount('a'));
  assert.strictEqual(pausedUntil('a'), null);
  await autoCheck();
  assert.deepStrictEqual(checks, ['a']);
});

test('used up: the longest window counts, paid extra usage keeps it checked, and off means no pause', async () => {
  const quota = env.load('quota');
  const weekly = Date.now() + 3 * 864e5;
  saved('a', Date.now() - 20 * MINUTE, 100, { seven: { utilization: 100, resets_at: new Date(weekly).toISOString() } });
  await quota.refreshAllQuota();
  assert.strictEqual(quota.pausedUntil('a'), weekly);
  env.settings.claudeAccounts.usageCheckMinutes = 0;
  assert.ok(!card('a').notes.some((n) => /paused/.test(n)), 'nothing is checked on its own anyway');
  env.settings.claudeAccounts.usageCheckMinutes = 5;

  saved('a', Date.now() - 20 * MINUTE, 100, { extra: { is_enabled: true, used_credits: 100, monthly_limit: 1000, decimal_places: 2 } });
  checks.length = 0;
  await quota.autoCheck();
  assert.deepStrictEqual(checks, ['a']);
});

// ───────── in use ─────────

test('a window in the background checks only its own account, and only while Claude works in it', async () => {
  const quota = env.load('quota');
  const w = env.watchers.find((x) => !x.disposed && x.pattern.pattern.endsWith('*.jsonl'));
  const { encodeProjectDir } = require('../../lib/usage');
  const work = async (folder) => {
    const file = path.join(dir('a'), 'projects', encodeProjectDir(folder), 's.jsonl');
    write(file, '{}\n');
    for (const h of w.handlers) await h({ fsPath: file });
  };
  saved('b', Date.now() - 10 * MINUTE, 50);
  await quota.checkAll({ only: 'b' }); // forgets its failed check, so only the rule tested here keeps it out
  const stale = () => ['a', 'b'].forEach((id) => saved(id, Date.now() - 10 * MINUTE, 50));
  env.vscode.window.state = { focused: false };
  stale();
  checks.length = 0;
  await work(home);
  await quota.autoCheck();
  assert.deepStrictEqual(checks, ['a']);

  // Another window's conversations (shared history) do not count as using this one.
  stale();
  checks.length = 0;
  const later = Date.now() + 11 * MINUTE;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    await work('/somewhere/else');
    await quota.autoCheck();
    assert.deepStrictEqual(checks, []);
    await work(home);
    await quota.autoCheck();
    assert.deepStrictEqual(checks, ['a']);
  } finally {
    Date.now = realNow;
    env.vscode.window.state = { focused: true };
  }
});
