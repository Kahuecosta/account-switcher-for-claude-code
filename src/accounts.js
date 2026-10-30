'use strict';
// Account model: local records, synced metadata, per-account environment (secrets in SecretStorage),
// last known identity and usage-limit state.
const { rt, K, t, DEFAULT_ID, baseDir, store, notifyChanged } = require('./runtime');

/**
 * @typedef {'subscription' | 'oauthToken' | 'apiKey' | 'bedrock' | 'vertex'} AccountKind
 * @typedef {{ id: string, dir: string | null, mode: 'shared' | 'isolated' | 'original', kind?: AccountKind }} AccountRecord
 * @typedef {AccountRecord & { name: string, color?: string, icon?: string, avatar?: string }} Account
 * @typedef {{ email: string | null, displayName?: string | null, organization: string | null, plan: string | null, loggedIn: boolean }} Identity
 */

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|SESSION/i;
// Variables an account may not set: they belong to the account itself or would break VS Code.
const BLOCKED_ENV =
  /^(CLAUDE_CONFIG_DIR|NODE_OPTIONS|PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|ELECTRON_RUN_AS_NODE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|VSCODE_.*)$/i;

// ───────── records & metadata ─────────

/** @returns {AccountRecord[]} */
const getRecords = () => rt.ctx.globalState.get(K.ACCOUNTS, []);
/** @param {AccountRecord[]} list */
const saveRecords = (list) =>
  rt.ctx.globalState.update(
    K.ACCOUNTS,
    list.map(({ id, dir, mode, kind }) => (kind && kind !== 'subscription' ? { id, dir, mode, kind } : { id, dir, mode }))
  );

/** @returns {Record<string, { name?: string, color?: string, icon?: string }>} */
const getMeta = () => rt.ctx.globalState.get(K.META, {});
/** @param {string} id @param {Record<string, any>} patch */
async function updateMeta(id, patch) {
  const meta = { ...getMeta() };
  meta[id] = { ...(meta[id] || {}), ...patch };
  for (const k of Object.keys(meta[id])) if (meta[id][k] === undefined) delete meta[id][k];
  await rt.ctx.globalState.update(K.META, meta);
  notifyChanged();
}

/** @returns {Record<string, string>} */
const getAvatars = () => rt.ctx.globalState.get(K.AVATARS, {});

/** @param {AccountRecord} rec @returns {Account} */
function decorate(rec) {
  const m = getMeta()[rec.id] || {};
  return { ...rec, kind: rec.kind || 'subscription', name: m.name || rec.id, color: m.color, icon: m.icon, avatar: getAvatars()[rec.id] };
}

/** @returns {Account} */
function defaultAccount() {
  const m = getMeta()[DEFAULT_ID] || {};
  return { ...decorate({ id: DEFAULT_ID, dir: null, mode: 'original' }), name: m.name || t('Default (~/.claude)') };
}
const getAccounts = () => getRecords().map(decorate);
const allAccounts = () => [defaultAccount(), ...getAccounts()];
/** @param {string | undefined | null} id */
const findAccount = (id) => (id ? allAccounts().find((a) => a.id === id) : undefined);

// Accepts an account id, name or e-mail (case-insensitive).
/** @param {unknown} ref */
function findAccountByRef(ref) {
  if (!ref) return null;
  const s = String(ref).trim().toLowerCase();
  const all = allAccounts();
  return (
    all.find((a) => a.id.toLowerCase() === s) ||
    all.find((a) => a.name.toLowerCase() === s) ||
    (s.includes('@') ? all.find((a) => (getIdentity(a.id)?.email || '').toLowerCase() === s) : undefined) ||
    null
  );
}

/** @param {Account} a */
const configDirOf = (a) => a.dir || baseDir();

/** @param {string | undefined} m */
function modeLabel(m) {
  if (m === 'shared') return t('shared profile');
  if (m === 'isolated') return t('isolated profile');
  if (m === 'original') return t('original');
  return '?';
}

/** @param {AccountKind | undefined} k */
function kindLabel(k) {
  if (k === 'oauthToken') return t('subscription token');
  if (k === 'apiKey') return t('API key');
  if (k === 'bedrock') return t('Amazon Bedrock');
  if (k === 'vertex') return t('Google Vertex AI');
  return t('Claude subscription');
}

/** @returns {Account} */
const selectedAccount = () => findAccount(store().get(K.SELECTED)) || defaultAccount();

// ───────── environment variables ─────────
// Non-secret values live in globalState (never synced). Secret values live in SecretStorage and are
// cached in memory once loaded.

/** @type {Map<string, Record<string, string>>} */
const secretCache = new Map();
const secretKey = (/** @type {string} */ id, /** @type {string} */ name) => `env:${id}:${name}`;

// Until the migration runs, 1.x values ({ NAME: value }) are read as plain values, so the very first
// activation after an update already applies them.
/** @returns {Record<string, Record<string, { value?: string, secret?: boolean }>>} */
function getEnvSpecs() {
  const specs = rt.ctx.globalState.get(K.ENV, {});
  const legacy = rt.ctx.globalState.get(K.ENV_V1);
  if (!legacy || typeof legacy !== 'object') return specs;
  const out = { ...specs };
  for (const [id, vars] of Object.entries(legacy)) {
    if (out[id] || !vars || typeof vars !== 'object') continue;
    out[id] = Object.fromEntries(
      Object.entries(vars)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, { value: v }])
    );
  }
  return out;
}
/** @param {string} id */
const envSpec = (id) => getEnvSpecs()[id] || {};

/** @param {string} id */
async function loadSecrets(id) {
  const spec = envSpec(id);
  const values = {};
  for (const [name, s] of Object.entries(spec)) {
    if (!s.secret) continue;
    const v = await rt.ctx.secrets.get(secretKey(id, name));
    if (v !== undefined) values[name] = v;
  }
  secretCache.set(id, values);
  return values;
}

// The account's variables as far as they are known now (secrets only once loaded).
/** @param {string} id @returns {Record<string, string>} */
function envOf(id) {
  const out = {};
  const secrets = secretCache.get(id) || {};
  for (const [name, s] of Object.entries(envSpec(id))) {
    if (s.secret) {
      if (name in secrets) out[name] = secrets[name];
    } else if (typeof s.value === 'string') out[name] = s.value;
  }
  return out;
}
/** @param {string} id */
const secretsPending = (id) => Object.values(envSpec(id)).some((s) => s.secret) && !secretCache.has(id);

/** @param {string} id @param {string} name @param {string} value @param {boolean} secret */
async function setEnvVar(id, name, value, secret) {
  const specs = { ...getEnvSpecs() };
  const spec = { ...(specs[id] || {}) };
  if (secret) {
    await rt.ctx.secrets.store(secretKey(id, name), value);
    spec[name] = { secret: true };
    secretCache.set(id, { ...(secretCache.get(id) || {}), [name]: value });
  } else {
    if (spec[name]?.secret) await rt.ctx.secrets.delete(secretKey(id, name));
    spec[name] = { value };
    const cached = { ...(secretCache.get(id) || {}) };
    delete cached[name];
    secretCache.set(id, cached);
  }
  specs[id] = spec;
  await rt.ctx.globalState.update(K.ENV, specs);
}

/** @param {string} id @param {string} name */
async function removeEnvVar(id, name) {
  const specs = { ...getEnvSpecs() };
  const spec = { ...(specs[id] || {}) };
  if (spec[name]?.secret) await rt.ctx.secrets.delete(secretKey(id, name));
  delete spec[name];
  specs[id] = spec;
  await rt.ctx.globalState.update(K.ENV, specs);
  const cached = { ...(secretCache.get(id) || {}) };
  delete cached[name];
  secretCache.set(id, cached);
}

/** @param {string} id */
async function removeAllEnv(id) {
  for (const name of Object.keys(envSpec(id))) await removeEnvVar(id, name);
  const specs = { ...getEnvSpecs() };
  delete specs[id];
  await rt.ctx.globalState.update(K.ENV, specs);
  secretCache.delete(id);
}

// ───────── identity (non-secret, persisted so it is available synchronously at startup) ─────────

/** @param {string} id @returns {Identity | null} */
const getIdentity = (id) => rt.ctx.globalState.get(K.IDENTITY, {})[id] || null;
/** @param {string} id @param {Identity | null} data */
const setIdentity = (id, data) => setIdentities({ [id]: data });

// Writes several identities at once, and only when something changed: every globalState write is
// echoed back by VS Code, so fewer writes mean fewer moments with a stale view.
/** @param {Record<string, Identity | null>} entries @returns {Promise<boolean>} whether anything changed */
async function setIdentities(entries) {
  const before = rt.ctx.globalState.get(K.IDENTITY, {});
  const all = { ...before };
  for (const [id, data] of Object.entries(entries)) {
    if (data) all[id] = { email: data.email, organization: data.organization, plan: data.plan, loggedIn: data.loggedIn };
    else delete all[id];
  }
  if (JSON.stringify(all) === JSON.stringify(before)) return false;
  await rt.ctx.globalState.update(K.IDENTITY, all);
  return true;
}

// A credential kind other than a claude.ai login counts as signed in when its variables are set.
/** @param {Account} a */
function isSignedIn(a) {
  if (a.kind === 'apiKey') return 'ANTHROPIC_API_KEY' in envSpec(a.id);
  if (a.kind === 'oauthToken') return 'CLAUDE_CODE_OAUTH_TOKEN' in envSpec(a.id);
  if (a.kind === 'bedrock' || a.kind === 'vertex') return true;
  const id = getIdentity(a.id);
  return id ? id.loggedIn : null; // null = unknown
}

// ───────── usage limits (shared by every window through globalState) ─────────

const SESSION_WINDOW_MS = 5 * 3600e3;

/** @returns {Record<string, { at: number, until: number | null, kind: string }>} */
const getLimits = () => rt.ctx.globalState.get(K.LIMITS, {});
/** @param {string} id @param {{ at: number, until: number | null, kind: string } | null} info */
async function setLimit(id, info) {
  const all = { ...getLimits() };
  if (info) all[id] = info;
  else delete all[id];
  await rt.ctx.globalState.update(K.LIMITS, all);
  notifyChanged();
}

// { until } when the account is known to be limited right now, otherwise null. Without a known reset
// time a limit is assumed to last one session window (5 hours) from when it was hit.
/** @param {string} id */
function activeLimit(id, now = Date.now()) {
  const l = getLimits()[id];
  if (!l) return null;
  const until = l.until || l.at + SESSION_WINDOW_MS;
  return now < until ? { ...l, until, estimated: !l.until } : null;
}

module.exports = {
  SECRET_NAME,
  BLOCKED_ENV,
  secretKey,
  getRecords,
  saveRecords,
  getMeta,
  updateMeta,
  getAvatars,
  decorate,
  defaultAccount,
  getAccounts,
  allAccounts,
  findAccount,
  findAccountByRef,
  configDirOf,
  modeLabel,
  kindLabel,
  selectedAccount,
  getEnvSpecs,
  envSpec,
  loadSecrets,
  envOf,
  secretsPending,
  setEnvVar,
  removeEnvVar,
  removeAllEnv,
  getIdentity,
  setIdentity,
  setIdentities,
  isSignedIn,
  getLimits,
  setLimit,
  activeLimit,
};
