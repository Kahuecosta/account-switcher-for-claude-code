'use strict';
// Shared profile items, shared history and account folders on disk. Every operation holds a
// cross-window lock, reports progress, can be cancelled, and is rolled back if it fails.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rt, K, t, cfg, baseDir, baseJsonPath, lockPath, backupsDir, accountsRoot, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const links = require('../lib/links');
const { withLock } = require('../lib/lock');
const { mirrorMcpServers } = require('../lib/mcp');
const { samePath, isInside, tildify } = require('../lib/paths');

/** @typedef {import('./accounts').Account} Account @typedef {import('../lib/links').LinkResult} LinkResult */

const validItems = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.filter((i) => !links.invalidItem(i)) : []);

// Items treated as history (whether or not sharing is on).
const configuredHistoryItems = () => {
  const v = cfg('historyItems');
  return validItems(Array.isArray(v) ? v : links.DEFAULT_HISTORY_ITEMS);
};
// History items to link right now: none unless history sharing is on.
const historyItems = () => (cfg('shareHistory') ? configuredHistoryItems() : []);

// Config items for shared-profile accounts (history is handled separately).
async function configItems() {
  const history = configuredHistoryItems();
  if (cfg('sharedItemsMode') === 'allExcept') {
    const exclude = validItems(cfg('sharedItemsExclude'));
    return links.shareableItems(baseDir(), { exclude, historyItems: history });
  }
  return validItems(cfg('sharedItems')).filter((i) => !history.includes(i));
}

// Items from the settings that are refused, so the user learns why.
function refusedItems() {
  const list = Array.isArray(cfg('sharedItems')) ? cfg('sharedItems') : [];
  return list.map((i) => ({ item: String(i), reason: links.invalidItem(i) })).filter((x) => x.reason);
}

/** @param {{ item: string, reason: string, detail?: string }} s */
function skippedText(s) {
  const base = tildify(baseDir());
  switch (s.reason) {
    case 'missing':
      return t('{0} (not present in {1})', s.item, base);
    case 'own':
      return t('{0} (this account already has its own version)', s.item);
    case 'credentials':
      return t('{0} (never shared: login data)', s.item);
    case 'volatile':
      return t('{0} (never shared: session state)', s.item);
    case 'link':
      return t('{0} (could not create link)', s.item) + (s.detail ? ` ${s.detail}` : '');
    default:
      return t('{0} (invalid name)', s.item);
  }
}

/** @param {LinkResult} r */
function describe(r) {
  const parts = [];
  if (r.linked.length) parts.push(t('Shared: {0}.', r.linked.join(', ')));
  if (r.copied.length) parts.push(t('Copied (no link possible, will not sync): {0}.', r.copied.join(', ')));
  if (r.backedUp.length) parts.push(t('Backups: {0}.', r.backedUp.join(', ')));
  if (r.merged) parts.push(t('History items merged: {0}.', r.merged));
  if (r.conflicts.length) parts.push(t('Conflicts kept next to the original: {0}.', r.conflicts.join(', ')));
  const skipped = r.skipped.filter((s) => s.reason !== 'missing');
  if (skipped.length) parts.push(t('Skipped: {0}.', skipped.map(skippedText).join('; ')));
  return parts.length ? ' ' + parts.join(' ') : '';
}

/** @param {LinkResult[]} results */
function combine(results) {
  const out = { linked: [], copied: [], skipped: [], backedUp: [], merged: 0, conflicts: [] };
  for (const r of results) {
    for (const k of ['linked', 'copied', 'skipped', 'backedUp', 'conflicts']) out[k].push(...r[k]);
    out.merged += r.merged;
  }
  return out;
}

// Keeps the 10 most recent backup folders.
async function pruneBackups() {
  let entries;
  try {
    entries = (await fs.promises.readdir(backupsDir(), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  for (const name of entries.slice(0, -10)) await fs.promises.rm(path.join(backupsDir(), name), { recursive: true, force: true });
}

/**
 * Runs a file-system change with the lock, a progress notification, a journal and rollback.
 * @template T
 * @param {string} title @param {string} label
 * @param {(journal: InstanceType<typeof links.Journal>, check: () => void) => Promise<T>} fn
 * @returns {Promise<{ value: T, backupDir: string | null }>}
 */
function runOperation(title, label, fn) {
  return withLock(lockPath(), async () =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const journal = new links.Journal(path.join(backupsDir(), `${links.stamp()}-${label}`));
      const check = () => {
        if (token.isCancellationRequested) throw new links.CancelledError();
      };
      rt.log.info(`Start: ${label}`);
      try {
        const value = await fn(journal, check);
        const backupDir = await journal.finish();
        rt.log.info(`Done: ${label}${backupDir ? ` (backups in ${backupDir})` : ''}`);
        await pruneBackups();
        return { value, backupDir };
      } catch (e) {
        rt.log.error(`Failed: ${label}: ${e && e.stack ? e.stack : e}. Rolling back ${journal.ops.length} change(s).`);
        const errors = await journal.rollback();
        for (const x of errors) rt.log.error(`Rollback step failed: ${JSON.stringify(x.op)}: ${x.error}`);
        if (e instanceof links.CancelledError) throw new Error(t('Cancelled. Every change was undone.'), { cause: e });
        if (errors.length) {
          await journal.finish().catch(() => null);
          throw new Error(t('{0} Some changes could not be undone; see the log. Backups: {1}', e.message, journal.backupDir), { cause: e });
        }
        throw new Error(t('{0} Every change was undone.', e.message), { cause: e });
      }
    })
  );
}

const opContext = (/** @type {any} */ journal, /** @type {() => void} */ check, /** @type {string} */ tag) => ({ journal, check, tag });

/**
 * @param {Account} a @param {InstanceType<typeof links.Journal>} journal @param {() => void} check
 * @param {{ replaceLocal?: boolean }} [opts]
 */
async function linkConfig(a, journal, check, { replaceLocal = false } = {}) {
  return links.linkItems(baseDir(), a.dir, await configItems(), { ...opContext(journal, check, a.id), replaceLocal });
}
/** @param {Account} a */
const linkHistory = (a, journal, check) =>
  links.linkItems(baseDir(), a.dir, historyItems(), { ...opContext(journal, check, a.id), merge: true });

// New account folder: shared config (shared profile) and shared history (when on).
/** @param {Account} a */
async function setUpNewAccount(a) {
  const { value } = await runOperation(t('Setting up "{0}"...', a.name), `setup-${a.id}`, async (journal, check) => {
    const results = [];
    if (a.mode === 'shared') results.push(await linkConfig(a, journal, check));
    if (historyItems().length) results.push(await linkHistory(a, journal, check));
    return combine(results);
  });
  return value;
}

/** @param {Account} a */
async function toIsolated(a) {
  const items = await configItems();
  const { value } = await runOperation(t('Isolating "{0}"...', a.name), `isolate-${a.id}`, (journal, check) =>
    links.unlinkItems(baseDir(), a.dir, items, { ...opContext(journal, check, a.id), copy: true })
  );
  await saveRecordPatch(a.id, { mode: 'isolated' });
  await setMirrored(a.id, null);
  return value;
}

/** @param {Account} a */
async function toShared(a) {
  const { value } = await runOperation(t('Sharing the profile with "{0}"...', a.name), `share-${a.id}`, (journal, check) =>
    linkConfig(a, journal, check, { replaceLocal: true })
  );
  await saveRecordPatch(a.id, { mode: 'shared' });
  await mirrorMcp({ ...a, mode: 'shared' }).catch((e) => rt.log.warn(`MCP mirror for ${a.id}: ${e}`));
  return value;
}

/** @param {Account} a */
async function relink(a) {
  const { value } = await runOperation(t('Relinking "{0}"...', a.name), `relink-${a.id}`, async (journal, check) => {
    const results = [];
    if (a.mode === 'shared') results.push(await linkConfig(a, journal, check, { replaceLocal: true }));
    if (historyItems().length) results.push(await linkHistory(a, journal, check));
    return combine(results);
  });
  return value;
}

// Turns history sharing on: merges every account's history into the base folder and links it.
/** @param {Account[]} list */
async function shareHistory(list) {
  await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', true, vscode.ConfigurationTarget.Global);
  try {
    const { value, backupDir } = await runOperation(t('Merging history...'), 'share-history', async (journal, check) => {
      const results = [];
      for (const a of list) {
        const r = await linkHistory(a, journal, check);
        results.push({ ...r, skipped: r.skipped.map((s) => ({ ...s, item: `${a.name}: ${s.item}` })) });
      }
      return combine(results);
    });
    return { result: value, backupDir };
  } catch (e) {
    await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', false, vscode.ConfigurationTarget.Global);
    throw e;
  }
}

// Turns history sharing off. copy=true gives every account a copy of the current history.
/** @param {Account[]} list @param {boolean} copy */
async function unshareHistory(list, copy) {
  const items = configuredHistoryItems();
  await runOperation(t('Separating history...'), 'unshare-history', async (journal, check) => {
    for (const a of list) await links.unlinkItems(baseDir(), a.dir, items, { ...opContext(journal, check, a.id), copy });
  });
  await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', false, vscode.ConfigurationTarget.Global);
}

/** @param {Account} a */
async function brokenShares(a) {
  if (!a || !a.dir) return [];
  return links.brokenLinks(baseDir(), a.dir, {
    configItems: a.mode === 'shared' ? await configItems() : [],
    historyItems: historyItems(),
  });
}

// A folder that may be deleted: never the base profile, the home folder or an ancestor of either.
/** @param {string} dir */
function safeToDelete(dir) {
  const d = path.resolve(dir);
  return !!dir && path.dirname(d) !== d && !isInside(baseDir(), d) && !isInside(os.homedir(), d) && !samePath(d, accountsRoot());
}

// Moves an account folder to the trash (or deletes it, if the user agrees when there is no trash).
/** @param {string} dir */
async function removeAccountDir(dir) {
  if (!fs.existsSync(dir)) return 'missing';
  if (!safeToDelete(dir)) throw new Error(t('Refusing to delete {0}.', dir));
  return withLock(lockPath(), async () => {
    await links.removeTopLevelLinks(dir); // so nothing can follow them into the base profile
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true, useTrash: true });
      rt.log.info(`Moved to trash: ${dir}`);
      return 'trash';
    } catch (e) {
      rt.log.warn(`Trash unavailable for ${dir}: ${e}`);
      const del = t('Delete permanently');
      const ok = await vscode.window.showWarningMessage(
        t('The folder could not be moved to the trash.'),
        { modal: true, detail: t('{0}\n\nDelete it permanently? This cannot be undone.', dir) },
        del
      );
      if (ok !== del) return 'kept';
      await fs.promises.rm(dir, { recursive: true, force: true });
      rt.log.info(`Deleted: ${dir}`);
      return 'deleted';
    }
  });
}

/** @param {string} id @param {Partial<import('./accounts').AccountRecord>} patch */
async function saveRecordPatch(id, patch) {
  await accounts.saveRecords(accounts.getRecords().map((x) => (x.id === id ? { ...x, ...patch } : x)));
  notifyChanged();
}

// ───────── MCP servers ─────────

/** @param {string} id @param {string[] | null} names */
async function setMirrored(id, names) {
  const all = { ...rt.ctx.globalState.get(K.MCP_MIRRORED, {}) };
  if (names) all[id] = names;
  else delete all[id];
  await rt.ctx.globalState.update(K.MCP_MIRRORED, all);
}

// Copies the base profile's user-scope MCP servers into a shared-profile account.
/** @param {Account} a */
async function mirrorMcp(a) {
  if (!a.dir || a.mode !== 'shared' || !cfg('shareMcpServers')) return null;
  const prev = rt.ctx.globalState.get(K.MCP_MIRRORED, {})[a.id] || [];
  const r = await mirrorMcpServers(baseJsonPath(), path.join(a.dir, '.claude.json'), prev);
  await setMirrored(a.id, r.mirrored);
  if (r.changed) rt.log.info(`MCP servers mirrored into ${a.id}: ${r.mirrored.join(', ') || '(none)'}`);
  return r;
}

module.exports = {
  configItems,
  historyItems,
  configuredHistoryItems,
  refusedItems,
  describe,
  skippedText,
  runOperation,
  setUpNewAccount,
  toIsolated,
  toShared,
  relink,
  shareHistory,
  unshareHistory,
  brokenShares,
  removeAccountDir,
  safeToDelete,
  mirrorMcp,
  setMirrored,
  saveRecordPatch,
};
