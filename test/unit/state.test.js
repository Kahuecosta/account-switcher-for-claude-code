'use strict';
// Regression: VS Code echoes every globalState write back and replaces the whole object, so a late
// echo of an older write could erase newer data (accounts disappeared in an integration test).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup();
const { context } = env;
env.init();
const state = env.load('state');
const accounts = env.load('accounts');
const repo = env.load('repo');

// Replaces globalState with an older snapshot, like a late echo does.
const echo = (snapshot) => {
  for (const k of Object.keys(context.globalState.data)) delete context.globalState.data[k];
  Object.assign(context.globalState.data, JSON.parse(JSON.stringify(snapshot)));
};

test('first run copies the state of earlier versions, once', async () => {
  await context.globalState.update('accounts', [{ id: 'old', dir: '/x/old', mode: 'isolated' }]);
  await context.globalState.update('repoDefaults', { 'remote:a/b': 'old' }); // 1.x stored plain ids
  await context.globalState.update('accountMeta', { old: { name: 'Old' } });
  state.init();
  assert.deepStrictEqual(accounts.getRecords(), [{ id: 'old', dir: '/x/old', mode: 'isolated' }]);
  assert.deepStrictEqual(repo.getRepoDefaults(), { 'remote:a/b': { id: 'old' } });
  assert.strictEqual(accounts.getMeta().old.name, 'Old');
  // A second init does not copy again (the files are the source of truth now).
  await context.globalState.update('accounts', []);
  state.init();
  assert.strictEqual(accounts.getRecords().length, 1);
  assert.ok(fs.existsSync(path.join(state.dir(), '.migrated')));
});

test('a late echo of an older globalState no longer erases accounts or names', async () => {
  const before = JSON.parse(JSON.stringify(context.globalState.data));
  await accounts.saveRecords([...accounts.getRecords(), { id: 'new', dir: '/x/new', mode: 'shared' }]);
  await accounts.updateMeta('new', { name: 'New' });
  echo(before); // the mirror loses the name for now
  assert.deepStrictEqual(
    accounts.getRecords().map((r) => r.id),
    ['old', 'new']
  );
  assert.strictEqual(accounts.getMeta().new.name, 'New', 'local state is authoritative');
  state.pullSynced();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(context.globalState.get('accountMeta').new.name, 'New', 'the next pull repairs the mirror');
});

test('Settings Sync: the newest entry wins in both directions, and removals stay removed', async () => {
  const later = Date.now() + 60e3;
  // Another machine renamed "old" later and added "remote-only".
  echo({
    ...context.globalState.data,
    accountMeta: {
      ...context.globalState.data.accountMeta,
      old: { name: 'Renamed elsewhere', _t: later },
      'remote-only': { name: 'Remote', _t: later },
    },
  });
  assert.strictEqual(state.pullSynced(), true);
  assert.strictEqual(accounts.getMeta().old.name, 'Renamed elsewhere');
  assert.strictEqual(accounts.getMeta()['remote-only'].name, 'Remote');

  // An older copy from another machine does not win.
  echo({ ...context.globalState.data, accountMeta: { ...context.globalState.data.accountMeta, new: { name: 'Stale', _t: 1 } } });
  state.pullSynced();
  assert.strictEqual(accounts.getMeta().new.name, 'New');

  // A removal is a stamped tombstone, so an older synced copy cannot bring the entry back.
  const snapshot = JSON.parse(JSON.stringify(context.globalState.data));
  await accounts.removeMeta('new');
  echo(snapshot);
  state.pullSynced();
  assert.strictEqual(accounts.getMeta().new, undefined);
});

test('repository defaults are stamped per entry', async () => {
  await repo.saveRepoDefaults({ 'remote:a/b': { id: 'old' }, 'remote:c/d': { id: 'new', email: 'n@x.com' } });
  const raw = state.get('repoDefaults');
  assert.ok(raw['remote:c/d']._t > 0);
  assert.strictEqual(raw['remote:a/b']._t, 0, 'unchanged entries keep their stamp');
  await repo.saveRepoDefaults({ 'remote:c/d': { id: 'new', email: 'n@x.com' } });
  assert.strictEqual(state.get('repoDefaults')['remote:a/b']._deleted, true);
  assert.deepStrictEqual(repo.getRepoDefaults(), { 'remote:c/d': { id: 'new', email: 'n@x.com' } });
});
