'use strict';
// Storage migrations, run once per schema version.
const vscode = require('vscode');
const { rt, K, SCHEMA_VERSION } = require('./runtime');
const accounts = require('./accounts');

async function migrate() {
  const g = rt.ctx.globalState;
  const from = g.get(K.SCHEMA, 0);
  if (from >= SCHEMA_VERSION) return;

  // 1.0 kept the name inside the local record; 1.1 keeps it in synced metadata.
  const recs = g.get(K.ACCOUNTS, []);
  if (recs.some((/** @type {any} */ r) => r.name)) {
    const meta = { ...accounts.getMeta() };
    for (const r of recs) if (r.name && !meta[r.id]?.name) meta[r.id] = { ...(meta[r.id] || {}), name: r.name };
    await g.update(K.META, meta);
    await accounts.saveRecords(recs);
  }

  // 1.1 kept per-account variables in plain globalState; 1.2 keeps secrets in SecretStorage.
  const legacy = g.get(K.ENV_V1);
  if (legacy && typeof legacy === 'object') {
    const specs = { ...g.get(K.ENV, {}) };
    for (const [id, vars] of Object.entries(legacy)) {
      if (!vars || typeof vars !== 'object' || specs[id]) continue;
      const spec = {};
      for (const [name, value] of Object.entries(vars)) {
        if (typeof value !== 'string' || accounts.BLOCKED_ENV.test(name)) continue;
        if (accounts.SECRET_NAME.test(name)) {
          await rt.ctx.secrets.store(accounts.secretKey(id, name), value);
          spec[name] = { secret: true };
        } else spec[name] = { value };
      }
      specs[id] = spec;
    }
    await g.update(K.ENV, specs);
    await g.update(K.ENV_V1, undefined);
    for (const id of Object.keys(legacy)) await accounts.loadSecrets(id);
  }

  // suggestSwitchOnLimit: false became onUsageLimit: "ignore".
  const c = vscode.workspace.getConfiguration('claudeAccounts');
  if (c.inspect('suggestSwitchOnLimit')?.globalValue === false && c.inspect('onUsageLimit')?.globalValue === undefined) {
    await c.update('onUsageLimit', 'ignore', vscode.ConfigurationTarget.Global);
  }

  await g.update(K.SCHEMA, SCHEMA_VERSION);
  rt.log.info(`Storage migrated from schema ${from} to ${SCHEMA_VERSION}`);
}

module.exports = { migrate };
