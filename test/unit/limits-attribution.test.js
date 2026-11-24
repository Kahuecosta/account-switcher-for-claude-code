'use strict';
// A conversation goes along when the account changes (shared history, or a copy of it), and with it the
// usage limit its previous account hit. That limit must never be recorded for the new account.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup, tick } = require('./helpers');

const env = setup();
const { context, home, write, watchers, messages } = env;
test.after(env.dispose);

const dir = (id) => path.join(home, '.claude-accounts', id);
const FIVE_HOURS = 5 * 3600e3;
const resetOfA = Math.floor((Date.now() + 90 * 60e3) / 1000); // when the limit of account "a" resets

// What Claude Code 2.1.330 writes when the 5-hour limit is hit.
const limitLine = (at, resetsAt = resetOfA) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    cwd: home,
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    quotaLimits: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', isUsingOverage: false },
    message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 10:30pm (America/Lima)" }] },
  }) + '\n';
const transcript = (id, name) => path.join(dir(id), 'projects', 'p', `${name}.jsonl`);
const logged = async (file) => {
  const w = watchers.filter((x) => !x.disposed && x.pattern.pattern.endsWith('*.jsonl')).at(-1);
  for (const h of w.handlers) await h({ fsPath: file });
};

test('setup: two accounts; "a" hit its limit a few seconds before this window starts as "b"', async () => {
  for (const id of ['a', 'b']) {
    fs.mkdirSync(path.join(dir(id), 'projects', 'p'), { recursive: true });
    write(
      path.join(dir(id), '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: id, emailAddress: `${id}@x.com` },
        // The 5-hour window of both starts again with the next message; the weekly one resets in days.
        cachedUsageUtilization: {
          accountUuid: id,
          fetchedAtMs: Date.now(),
          utilization: {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 3, resets_at: new Date(Date.now() + 6 * 864e5).toISOString() },
          },
        },
      })
    );
  }
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update(
    'accounts',
    ['a', 'b'].map((id) => ({ id, dir: dir(id), mode: 'isolated' }))
  );
  await context.workspaceState.update('selectedAccount', 'b');
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
});

test('a limit logged before this window used the account is not attributed to it', async () => {
  const file = transcript('b', 'carried');
  write(file, limitLine(Date.now() - 45e3));
  await logged(file);
  assert.strictEqual(env.load('accounts').activeLimit('b'), null);
  assert.ok(!messages.some((m) => /hit its usage limit/.test(m.text)), messages.map((m) => m.text).join(' | '));
});

test('a limit logged afterwards is, with the kind and the reset time Claude Code reports', async () => {
  await tick(5);
  const file = transcript('b', 'own');
  write(file, limitLine(Date.now()));
  await logged(file);
  const l = env.load('accounts').activeLimit('b');
  assert.deepStrictEqual(
    { kind: l.kind, until: l.until, estimated: l.estimated },
    { kind: 'session', until: resetOfA * 1000, estimated: false }
  );
});

test('switching in this window: the limit of the account it leaves stays with that account', async () => {
  const accounts = env.load('accounts');
  const { selectAccount } = env.load('switching');
  await accounts.setLimit('b', null);
  await tick(5);
  const before = Date.now();
  await tick(5);
  await selectAccount(accounts.findAccount('a'), undefined, { silent: true });
  const file = transcript('a', 'switched');
  write(file, limitLine(before));
  await logged(file);
  assert.strictEqual(accounts.activeLimit('a'), null);
  // Restarting the watcher for other reasons (a setting, the folders) keeps the account's own limits.
  const own = Date.now();
  await tick(5);
  env.load('limits').restartWatcher();
  fs.appendFileSync(file, limitLine(own));
  await logged(file);
  assert.strictEqual(accounts.activeLimit('a')?.until, resetOfA * 1000);
});

test('a 5-hour limit without a reported reset never takes the weekly reset', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  await accounts.setLimit('a', null);
  const now = Date.now();
  await limits.onLimitReached(accounts.findAccount('a'), { kind: 'session', resetAt: null });
  const l = accounts.activeLimit('a');
  assert.ok(l.estimated, 'assumed to last one 5-hour window');
  assert.ok(l.until <= now + FIVE_HOURS + 5000, new Date(l.until).toISOString());
});
