'use strict';
// onUsageLimit "switch": what happens at the limit and near it (threshold). Its own process, so no
// earlier prompt is within the 20-minute cooldown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup({ onUsageLimit: 'switch' });
const { context, home, write } = env;
test.after(env.dispose);
const dir = (id) => path.join(home, '.claude-accounts', id);

test('setup', async () => {
  for (const id of ['a', 'b']) {
    fs.mkdirSync(dir(id), { recursive: true });
    write(path.join(dir(id), '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: id, emailAddress: `${id}@x.com` } }));
  }
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update(
    'accounts',
    ['a', 'b'].map((id) => ({ id, dir: dir(id), mode: 'isolated' }))
  );
  await context.workspaceState.update('selectedAccount', 'a');
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
});

test('switch mode near the limit: only the window switches; the open conversation is not forked', async () => {
  const limits = env.load('limits');
  const accounts = env.load('accounts');
  const continued = [];
  const selected = [];
  limits.init({
    select: async (a) => selected.push(a.id),
    choose: async () => undefined,
    continueIn: async (a) => continued.push(a.id),
  });
  const a = accounts.findAccount('a');
  await limits.onLimitReached(a, { kind: 'session', resetAt: Date.now() + 3600e3 }, { origin: 'quota', pct: 96, windowName: '5-hour' });
  assert.deepStrictEqual(continued, [], 'the tab may still be working: no copy in another tab');
  assert.deepStrictEqual(selected, ['b'], 'the window switches');
  // At the limit itself (reported in the session log), for an account not prompted yet.
  await env.load('switching').selectAccount(accounts.findAccount('b'), undefined, { silent: true });
  await accounts.setLimit('a', null);
  await limits.onLimitReached(accounts.findAccount('b'), { kind: 'session', resetAt: null });
  assert.deepStrictEqual(continued, ['a'], 'the conversation goes along, since it cannot go on here');
});
