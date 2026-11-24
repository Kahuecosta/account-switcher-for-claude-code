'use strict';
// Plan usage (5-hour and weekly windows) of every account. The main source is what Claude Code saves in
// each account's .claude.json, read without changing anything. Claude Code saves it when its panel starts
// and when asked for the usage, not while a conversation goes on, so this module also asks it to, now and
// then (claudeAccounts.usageCheckMinutes) and on Refresh. The opt-in status line bridge
// (claudeAccounts.liveQuota) adds a fresher reading whenever the claude CLI draws its status line.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { rt, cfg, DEFAULT_ID, baseDir, baseJsonPath, bridgeDir, storageDir, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const env = require('./environment');
const cli = require('./cli');
const statusline = require('../lib/statusline');
const usageCheck = require('../lib/usageCheck');
const { readCachedUsage, mergeQuota } = require('../lib/quota');

/** @typedef {import('./accounts').Account} Account */
/** @typedef {import('../lib/quota').Quota} Quota */

/** @type {Map<string, Quota | null>} */
const snapshots = new Map();
/** @type {vscode.Disposable[]} */
let watchers = [];
/** @type {NodeJS.Timeout | undefined} */
let pending;
// Claude Code writes .claude.json often, and it can be several MB: at most one read every few seconds.
const DEBOUNCE_MS = 5000;
// Claude Code keeps an answer for a minute: asking again sooner changes nothing.
const ANSWER_KEPT_MS = 60e3;
// After a failed check, how long the account is left alone (unless the user asks).
const RETRY_MS = 15 * 60e3;

const bridgeEnabled = () => !!cfg('liveQuota');
/** @param {string} id @returns {Quota | null} */
const quotaOf = (id) => snapshots.get(id) || null;

// Where Claude Code keeps the account's .claude.json.
/** @param {Account} a */
const jsonPathOf = (a) => (a.id === DEFAULT_ID || !a.dir ? baseJsonPath() : path.join(a.dir, '.claude.json'));

/** @param {Account} a */
async function refreshQuota(a) {
  const dir = accounts.configDirOf(a);
  const [cached, bridged] = await Promise.all([
    readCachedUsage(jsonPathOf(a)).catch(() => null),
    bridgeEnabled() ? statusline.readSnapshot(dir) : null,
  ]);
  const snap = mergeQuota(cached, bridged);
  const before = JSON.stringify(snapshots.get(a.id) || null);
  snapshots.set(a.id, snap);
  return { snap, changed: before !== JSON.stringify(snap) };
}

async function refreshAllQuota() {
  const all = accounts.allAccounts();
  for (const id of snapshots.keys()) if (!all.some((a) => a.id === id)) snapshots.delete(id);
  const results = await Promise.all(all.map((a) => refreshQuota(a).catch(() => ({ changed: false }))));
  if (results.some((r) => r.changed)) notifyChanged();
}

// ───────── asking Claude Code to check ─────────

/** @type {Map<string, number>} */
const failedAt = new Map();
/** @type {Promise<any>} */
let queue = Promise.resolve();
let autoChecking = false;
/** Accounts being checked, or waiting for it because the user asked. @type {Map<string, number>} */
const checking = new Map();

/** @param {string} id */
const isChecking = (id) => checking.has(id);
/** @param {string} id @param {1 | -1} delta */
function markChecking(id, delta) {
  const n = (checking.get(id) || 0) + delta;
  if (n > 0) checking.set(id, n);
  else checking.delete(id);
  notifyChanged();
}

// Only a claude.ai login has plan limits that Claude Code can check.
/** @param {Account} a */
const checkable = (a) => a.kind === 'subscription' && accounts.isSignedIn(a) === true;

// When an account that is used up can be used again: until then its figures cannot change, so it is not
// checked on its own. Null when it is not used up, or when paid extra usage keeps counting.
/** @param {string} id */
function pausedUntil(id, now = Date.now()) {
  const q = quotaOf(id);
  if (!q || q.extra) return null;
  const resets = [q.fiveHour, q.sevenDay].flatMap((w) => (w && w.usedPct >= 100 && w.resetsAt && w.resetsAt > now ? [w.resetsAt] : []));
  return resets.length ? Math.max(...resets) : null;
}

/** @param {Account} a */
async function checkAccount(a) {
  markChecking(a.id, 1);
  try {
    return await runCheck(a);
  } finally {
    markChecking(a.id, -1);
  }
}

/** @param {Account} a */
async function runCheck(a) {
  try {
    if (accounts.secretsPending(a.id)) await accounts.loadSecrets(a.id);
    await fs.promises.mkdir(storageDir(), { recursive: true });
    await usageCheck.checkUsage(cli.claudeExecutable(), { env: env.terminalEnvFor(a), cwd: storageDir() });
  } catch (e) {
    rt.log.warn(`Usage check of ${a.id}: ${e instanceof Error ? e.message : e}`);
  }
  // What counts is what Claude Code saved, whatever it answered.
  const { snap, changed } = await refreshQuota(a);
  if (changed) notifyChanged();
  return !!snap && typeof snap.at === 'number' && Date.now() - snap.at < 2 * ANSWER_KEPT_MS;
}

// One process at a time. Returns the accounts that could not be checked.
/** @param {Account[]} list @param {number} maxAgeMs @param {boolean} auto */
async function checkEach(list, maxAgeMs, auto) {
  /** @type {Account[]} */
  const failed = [];
  for (const a of list) {
    if (auto && Date.now() - (failedAt.get(a.id) || 0) < RETRY_MS) continue;
    // Read again first: the panel or another window may have had it checked meanwhile.
    const { snap, changed } = await refreshQuota(a);
    if (changed) notifyChanged();
    if (snap && typeof snap.at === 'number' && Date.now() - snap.at < maxAgeMs) continue;
    if (auto && pausedUntil(a.id)) continue;
    if (await checkAccount(a)) failedAt.delete(a.id);
    else {
      failedAt.set(a.id, Date.now());
      failed.push(a);
    }
  }
  return failed;
}

/**
 * Has Claude Code check the usage of signed-in subscription accounts, the window's account first: all of
 * them, or only `only`. Those just checked are skipped.
 * @param {{ only?: string, maxAgeMs?: number, auto?: boolean }} [opts] auto: not asked for by the user
 * @returns {Promise<Account[]>} the accounts that could not be checked
 */
function checkAll({ only, maxAgeMs = ANSWER_KEPT_MS, auto = false } = {}) {
  const cur = accounts.selectedAccount().id;
  const list = accounts
    .allAccounts()
    .filter((a) => checkable(a) && (!only || a.id === only))
    .sort((x, y) => Number(y.id === cur) - Number(x.id === cur));
  // Asked for: shown from the click on, even while it waits for another check.
  if (!auto) for (const a of list) markChecking(a.id, 1);
  const run = queue
    .then(() => checkEach(list, maxAgeMs, auto))
    .finally(() => {
      if (!auto) for (const a of list) markChecking(a.id, -1);
    });
  queue = run.catch(() => undefined);
  return run;
}

const autoChecks = () => Number(cfg('usageCheckMinutes')) > 0;

// VS Code calls a window inactive 10 seconds after the last key or click, and does not see those inside the
// Claude Code panel. So a window counts as in use for a while after them, and after Claude worked in it.
const IN_USE_MS = 10 * 60e3;
let usedAt = Date.now();
const noteUse = (now = Date.now()) => {
  usedAt = Math.max(usedAt, now);
};

// Run every minute and on focus: checks accounts whose reading is older than the setting, while this window
// is in use. In the background that is only its own account, the one Claude is using up.
async function autoCheck(now = Date.now()) {
  const state = /** @type {{ focused: boolean, active?: boolean }} */ (vscode.window.state); // active: VS Code 1.89
  if (state.focused && state.active !== false) noteUse(now);
  if (!autoChecks() || autoChecking || now - usedAt > IN_USE_MS) return;
  autoChecking = true;
  try {
    const only = state.focused ? undefined : accounts.selectedAccount().id;
    await checkAll({ only, maxAgeMs: Math.max(Number(cfg('usageCheckMinutes')) * 60e3, ANSWER_KEPT_MS), auto: true });
  } finally {
    autoChecking = false;
  }
}

// True when any account has usage figures (the status bar then refreshes relative times every minute).
const hasAny = () => [...snapshots.values()].some(Boolean);

// settings.json files to wrap: the base profile and every account folder, once per real file
// (shared-profile accounts link to the base file).
function settingsTargets() {
  const seen = new Set();
  const out = [];
  for (const dir of [
    baseDir(),
    ...accounts
      .getAccounts()
      .map((a) => a.dir)
      .filter(Boolean),
  ]) {
    const p = path.join(dir, 'settings.json');
    let real = p;
    try {
      real = fs.realpathSync(p);
    } catch {
      /* not created yet */
    }
    const key = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
    if (!seen.has(key) && fs.existsSync(dir)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

// Installs or removes the bridge in every settings file, following the liveQuota setting.
async function syncBridge() {
  const on = bridgeEnabled();
  const errors = [];
  for (const file of settingsTargets()) {
    try {
      if (on) {
        const r = await statusline.install(file, bridgeDir());
        if (r.changed) rt.log.info(`Status line bridge installed in ${file}`);
      } else if (await statusline.uninstall(file, bridgeDir())) {
        rt.log.info(`Status line bridge removed from ${file}`);
      }
    } catch (e) {
      rt.log.error(`Status line bridge in ${file}: ${e}`);
      errors.push(`${file}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return errors;
}

/** @param {string} file */
function watchFile(file) {
  if (!fs.existsSync(path.dirname(file))) return undefined;
  return vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
}

/**
 * Watches the selected account's usage: its .claude.json and, with the bridge on, its snapshot.
 * @param {(a: Account, snap: any) => void} onSnapshot
 */
function watchSelected(onSnapshot) {
  dispose();
  const a = accounts.selectedAccount();
  const files = [jsonPathOf(a)];
  if (bridgeEnabled()) files.push(path.join(accounts.configDirOf(a), statusline.SNAPSHOT_FILE));
  // What the threshold check last saw. Compared with the reading itself rather than with the stored
  // snapshot, which other refreshes (window focus, the Accounts view) may already have updated.
  let lastChecked = JSON.stringify(quotaOf(a.id));
  const read = async () => {
    try {
      const { snap, changed } = await refreshQuota(a);
      if (changed) notifyChanged();
      const seen = JSON.stringify(snap);
      if (snap && seen !== lastChecked) onSnapshot(a, snap);
      lastChecked = seen;
    } catch (e) {
      rt.log.warn(`Quota of ${a.id}: ${e}`);
    }
  };
  // At most one read per DEBOUNCE_MS, starting with the first write: a steady stream of writes never
  // postpones it.
  const handler = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      read();
    }, DEBOUNCE_MS);
  };
  for (const file of files) {
    const w = watchFile(file);
    if (!w) continue;
    w.onDidChange(handler);
    w.onDidCreate(handler);
    watchers.push(w);
  }
}

function dispose() {
  for (const w of watchers) w.dispose();
  watchers = [];
  if (pending) clearTimeout(pending);
  pending = undefined;
}

module.exports = {
  bridgeEnabled,
  quotaOf,
  hasAny,
  jsonPathOf,
  refreshQuota,
  refreshAllQuota,
  checkAll,
  autoCheck,
  autoChecks,
  noteUse,
  checkable,
  isChecking,
  pausedUntil,
  syncBridge,
  settingsTargets,
  watchSelected,
  dispose,
};
