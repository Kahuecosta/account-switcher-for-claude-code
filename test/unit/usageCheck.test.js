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
const saved = (id, at, five) =>
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
              utilization: { five_hour: { utilization: five, resets_at: new Date(Date.now() + 3600e3).toISOString() } },
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
  env.vscode.window.state = { focused: false };
  await quota.autoCheck();
  env.vscode.window.state = { focused: true, active: false };
  await quota.autoCheck();
  env.vscode.window.state = { focused: true, active: true };
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
