'use strict';
// Live quota (opt-in): installs the status line bridge and reads what it saves for each account.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { rt, cfg, baseDir, bridgeDir, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const statusline = require('../lib/statusline');

/** @typedef {import('./accounts').Account} Account */

/** @type {Map<string, any>} */
const snapshots = new Map();
/** @type {vscode.FileSystemWatcher | undefined} */
let watcher;

const enabled = () => !!cfg('liveQuota');
/** @param {string} id */
const quotaOf = (id) => (enabled() ? snapshots.get(id) || null : null);

/** @param {Account} a */
async function refreshQuota(a) {
  const snap = await statusline.readSnapshot(accounts.configDirOf(a));
  const before = JSON.stringify(snapshots.get(a.id) || null);
  snapshots.set(a.id, snap);
  return { snap, changed: before !== JSON.stringify(snap) };
}

async function refreshAllQuota() {
  if (!enabled()) {
    if (snapshots.size) {
      snapshots.clear();
      notifyChanged();
    }
    return;
  }
  const results = await Promise.all(accounts.allAccounts().map((a) => refreshQuota(a).catch(() => ({ changed: false }))));
  if (results.some((r) => r.changed)) notifyChanged();
}

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
  const on = enabled();
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

/**
 * Watches the selected account's snapshot.
 * @param {(a: Account, snap: any) => void} onSnapshot
 */
function watchSelected(onSnapshot) {
  watcher?.dispose();
  watcher = undefined;
  if (!enabled()) return;
  const a = accounts.selectedAccount();
  const dir = accounts.configDirOf(a);
  if (!fs.existsSync(dir)) return;
  watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), statusline.SNAPSHOT_FILE));
  const handler = async () => {
    try {
      const { snap, changed } = await refreshQuota(a);
      if (changed) notifyChanged();
      if (snap) onSnapshot(a, snap);
    } catch (e) {
      rt.log.warn(`Quota of ${a.id}: ${e}`);
    }
  };
  watcher.onDidChange(handler);
  watcher.onDidCreate(handler);
}

const dispose = () => watcher?.dispose();

module.exports = { enabled, quotaOf, refreshQuota, refreshAllQuota, syncBridge, settingsTargets, watchSelected, dispose };
