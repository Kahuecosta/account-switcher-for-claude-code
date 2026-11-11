'use strict';
// Persistent state of the extension.
//
// VS Code keeps globalState as one JSON object per extension. Every write is echoed back to the
// extension host, which replaces the whole object with the echoed value, and the next write sends the
// whole object again (extHostMemento.ts). A late echo of an older write can therefore undo a newer
// write for good. So state lives in one file per key in the extension's global storage folder,
// written atomically and read fresh (other windows write the same files).
//
// Synced state (account names, colors, icons and repository defaults) is kept the same way and
// mirrored into globalState for Settings Sync, with a timestamp per entry: the newest entry wins in
// both directions, so a mirror write lost to an echo is repaired by the next pull.
const fs = require('fs');
const path = require('path');
const { rt, K, cfg } = require('./runtime');

const SYNCED = [K.META, K.REPO_DEFAULTS];
// Keys copied from globalState the first time, so data from earlier versions is kept.
const LEGACY_KEYS = [
  K.ACCOUNTS,
  K.META,
  K.ENV_V1,
  K.ENV,
  K.AVATARS,
  K.REPO_DEFAULTS,
  K.IDENTITY,
  K.LIMITS,
  K.MCP_MIRRORED,
  K.NOTICES,
  K.SCHEMA,
  K.IMPORT_PROMPTED,
  K.SELECTED,
  K.PREVIOUS,
];

const dir = () => path.join(rt.ctx.globalStorageUri.fsPath, 'state');
const file = (/** @type {string} */ key) => path.join(dir(), `${key}.json`);

/** @type {Map<string, { stamp: string, value: any }>} */
const cache = new Map();

// Reads a file through one descriptor (no check-then-open race), with a cache keyed by mtime and size.
/** @param {string} p */
function readJson(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(p);
    if (hit && hit.stamp === stamp) return hit.value;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    cache.set(p, { stamp, value });
    return value;
  } catch (e) {
    rt.log?.error(`State file ${p} is unreadable: ${e}`);
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** @param {number} ms */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Replaces a file atomically. On Windows a rename can fail for a moment while another window reads it.
/** @param {string} p @param {string} text */
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, p);
      break;
    } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      pause(20);
    }
  }
  cache.delete(p);
}

/**
 * @template T
 * @param {string} key @param {T} [fallback]
 * @returns {T}
 */
function get(key, fallback) {
  const v = readJson(file(key));
  return v === undefined ? fallback : v;
}

/** @param {string} key @param {unknown} value */
function set(key, value) {
  const p = file(key);
  if (value === undefined) {
    fs.rmSync(p, { force: true });
    cache.delete(p);
  } else writeAtomic(p, JSON.stringify(value));
}

// Same signature as a Memento's update, for callers that await it.
/** @param {string} key @param {unknown} value */
const update = async (key, value) => set(key, value);

// ───────── synced entries ─────────

/** @param {string} key @param {any} v */
function normalizeEntry(key, v) {
  if (key === K.REPO_DEFAULTS && typeof v === 'string') return { id: v, _t: 0 }; // 1.0 / 1.1 format
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return { ...v, _t: typeof v._t === 'number' ? v._t : 0 };
}

// Entries without tombstones and timestamps: { [id]: value }.
/** @param {string} key @returns {Record<string, any>} */
function synced(key) {
  const out = {};
  for (const [id, e] of Object.entries(get(key, {}))) {
    if (!e || e._deleted) continue;
    const value = { ...e };
    delete value._t;
    out[id] = value;
  }
  return out;
}

// Changes entries (null removes one) and mirrors the result for Settings Sync.
/** @param {string} key @param {Record<string, any>} changes */
async function setSynced(key, changes) {
  const raw = { ...get(key, {}) };
  const now = Date.now();
  for (const [id, value] of Object.entries(changes)) raw[id] = value ? { ...value, _t: now } : { _deleted: true, _t: now };
  set(key, raw);
  await mirror(key);
}

/** @param {string} key */
async function mirror(key) {
  try {
    await rt.ctx.globalState.update(key, get(key, {}));
  } catch (e) {
    rt.log?.warn(`Settings Sync mirror of ${key}: ${e}`);
  }
}

// Merges what Settings Sync brought into globalState with the local files, newest entry first.
// Synchronous for the local side (activation needs repository defaults right away). Returns whether
// the local state changed.
function pullSynced() {
  let any = false;
  for (const key of SYNCED) {
    const remote = rt.ctx.globalState.get(key, {}) || {};
    const local = get(key, {});
    const merged = { ...local };
    let changed = false;
    for (const [id, v] of Object.entries(remote)) {
      const r = normalizeEntry(key, v);
      if (!r) continue;
      const l = local[id];
      if (!l || r._t > (l._t || 0)) {
        merged[id] = r;
        changed = changed || JSON.stringify(l) !== JSON.stringify(r);
      }
    }
    if (changed) set(key, merged);
    if (JSON.stringify(remote) !== JSON.stringify(merged)) mirror(key);
    any = any || changed;
  }
  return any;
}

// ───────── first run ─────────

// Copies state from globalState (versions up to 1.2) into files, once.
function init() {
  const marker = path.join(dir(), '.migrated');
  if (fs.existsSync(marker)) return;
  for (const key of LEGACY_KEYS) {
    const v = rt.ctx.globalState.get(key);
    if (v === undefined || fs.existsSync(file(key))) continue;
    if (SYNCED.includes(key)) {
      const entries = {};
      for (const [id, e] of Object.entries(v || {})) {
        const n = normalizeEntry(key, e);
        if (n) entries[id] = n;
      }
      set(key, entries);
    } else set(key, v);
  }
  writeAtomic(marker, new Date().toISOString());
  rt.log?.info(`State moved to ${dir()}`);
}

// Where the selection is remembered: per workspace (workspaceState is not shared, so it has no
// echoes) or for every window (a state file).
const selection = () => (cfg('scope') === 'user' ? { get, update } : rt.ctx.workspaceState);

module.exports = { get, set, update, synced, setSynced, pullSynced, init, selection, dir, SYNCED };
