'use strict';
// Links between an account folder and the base Claude folder (shared profile items and shared
// history). Every change goes through a Journal, so a failed or cancelled operation is rolled back
// and nothing an account owned is ever deleted: duplicates and replaced files are moved into a
// backup folder instead.
const fs = require('fs');
const path = require('path');
const { samePath } = require('./paths');

const fsp = fs.promises;

// Login and per-account state: never linked, whatever the settings say.
const CREDENTIAL_ITEM = /^(\.credentials\.json|\.claude\.json.*)$/i;
// Per-session or per-process state and caches (https://code.claude.com/docs/en/claude-directory).
const VOLATILE_ITEMS = [
  'ide',
  'sessions',
  'session-env',
  'shell-snapshots',
  'debug',
  'paste-cache',
  'image-cache',
  'uploads',
  'dev-mods',
  'tasks',
  'backups',
  'usage-data',
  'feedback-bundles',
  'feedback',
  'statsig',
  'logs',
  'cache',
  'jobs',
  'daemon',
  'stats-cache.json',
  'remote-settings.json',
  'policy-limits.json',
];
const DEFAULT_HISTORY_ITEMS = ['projects', 'history.jsonl', 'file-history', 'todos', 'plans'];

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.code = 'ECANCELLED';
  }
}

// Reason an item cannot be shared, or null when it can.
/** @param {unknown} item */
function invalidItem(item) {
  if (typeof item !== 'string' || !item.trim()) return 'empty';
  if (item !== item.trim() || /[\\/]/.test(item) || item === '.' || item === '..' || path.isAbsolute(item)) return 'name';
  if (CREDENTIAL_ITEM.test(item)) return 'credentials';
  if (VOLATILE_ITEMS.includes(item.toLowerCase())) return 'volatile';
  return null;
}

/** @param {string} p */
async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

/** @param {string} p */
async function exists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} p */
async function removeLink(p) {
  try {
    await fsp.unlink(p);
  } catch (e) {
    if (!['EPERM', 'EISDIR'].includes(e.code)) throw e;
    await fsp.rmdir(p); // Windows junction: removes only the link, never the target
  }
}

/** @param {string} from @param {string} to */
async function move(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

// Removes dir and its ancestors up to (not including) stopAt while they are empty.
/** @param {string} dir */
async function removeEmptyTree(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyTree(path.join(dir, e.name));
  try {
    await fsp.rmdir(dir);
  } catch {
    /* not empty: something else lives there now, keep it */
  }
}

/** @param {string} file @param {string | Buffer} data */
async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** @param {string} a @param {string} b */
async function sameContent(a, b) {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (sa.size !== sb.size) return false;
  const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return x.equals(y);
}

/** @param {string} line */
function lineTime(line) {
  try {
    const v = JSON.parse(line)?.timestamp;
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : t;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

// Merges JSON-lines logs: adds lines from `extra` that `existing` lacks. With sortByTime the result is
// ordered by each line's "timestamp" (stable; lines without one stay after their predecessor).
// Returns the new text, or null when nothing changes.
/** @param {string} existing @param {string} extra @param {{ sortByTime?: boolean }} [opts] */
function mergeJsonl(existing, extra, { sortByTime = false } = {}) {
  const have = new Set(existing.split('\n').filter((l) => l.trim()));
  const add = [];
  for (const l of extra.split('\n')) {
    if (l.trim() && !have.has(l)) {
      have.add(l);
      add.push(l);
    }
  }
  if (!add.length) return null;
  if (!sortByTime) {
    const sep = existing.length && !existing.endsWith('\n') ? '\n' : '';
    return existing + sep + add.join('\n') + '\n';
  }
  const all = [...existing.split('\n').filter((l) => l.trim()), ...add];
  let last = -Infinity;
  const keyed = all.map((line, i) => {
    const ts = lineTime(line);
    if (ts !== null) last = ts;
    return { line, i, ts: ts ?? last };
  });
  keyed.sort((a, b) => a.ts - b.ts || a.i - b.i);
  return keyed.map((k) => k.line).join('\n') + '\n';
}

// Records changes so they can be undone. Files that would otherwise be deleted or overwritten are
// kept in backupDir (created on first use).
class Journal {
  /** @param {string} backupDir */
  constructor(backupDir) {
    this.backupDir = backupDir;
    /** @type {any[]} */
    this.ops = [];
    this.used = false;
    this.seq = 0;
  }

  /** @param {any} op */
  record(op) {
    this.ops.push(op);
  }

  /** @param {string} file */
  async backupPath(file) {
    await fsp.mkdir(this.backupDir, { recursive: true });
    this.used = true;
    return path.join(this.backupDir, `${String(++this.seq).padStart(4, '0')}-${path.basename(file)}`);
  }

  // Moves a file or folder out of the way, into the backup folder.
  /** @param {string} p */
  async stash(p) {
    const to = await this.backupPath(p);
    await move(p, to);
    this.record({ type: 'move', from: p, to });
    return to;
  }

  // Keeps a copy of a file before it is rewritten.
  /** @param {string} file */
  async backupCopy(file) {
    const copy = await this.backupPath(file);
    await fsp.copyFile(file, copy);
    this.record({ type: 'restore', original: file, copy });
  }

  /** @param {string} from @param {string} to */
  async move(from, to) {
    await move(from, to);
    this.record({ type: 'move', from, to });
  }

  // Creates dir and records the topmost folder that did not exist.
  /** @param {string} dir */
  async mkdirp(dir) {
    const first = await fsp.mkdir(dir, { recursive: true });
    if (first) this.record({ type: 'mkdir', path: first });
  }

  /** @param {string} p */
  async unlink(p) {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) {
      const target = await fsp.readlink(p);
      let isDir = false;
      try {
        isDir = (await fsp.stat(p)).isDirectory();
      } catch {
        /* broken link */
      }
      await removeLink(p);
      this.record({ type: 'unlinked', path: p, target, kind: isDir ? 'dir' : 'file' });
    } else {
      // Hard link (Windows fallback): the shared content lives on in the base folder.
      const target = await this.backupPath(p);
      await move(p, target);
      this.record({ type: 'move', from: p, to: target });
    }
  }

  /** @param {any} op */
  async undo(op) {
    switch (op.type) {
      case 'move':
        await fsp.mkdir(path.dirname(op.from), { recursive: true });
        await move(op.to, op.from);
        break;
      case 'restore':
        await fsp.copyFile(op.copy, op.original);
        break;
      case 'mkdir':
        await removeEmptyTree(op.path);
        break;
      case 'created':
        await fsp.rm(op.path, { recursive: true, force: true });
        break;
      case 'link':
        await removeLink(op.path);
        break;
      case 'unlinked':
        await fsp.symlink(op.target, op.path, op.kind === 'dir' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
        break;
      case 'rmdir':
        await fsp.mkdir(op.path, { recursive: true });
        break;
      default:
        break;
    }
  }

  // Undoes everything in reverse order. Returns the errors it could not recover from.
  async rollback() {
    const errors = [];
    for (const op of [...this.ops].reverse()) {
      try {
        await this.undo(op);
      } catch (e) {
        errors.push({ op, error: e });
      }
    }
    this.ops = [];
    return errors;
  }

  // Writes a manifest next to the backups. Returns the backup folder, or null when nothing was kept.
  async finish() {
    if (!this.used) return null;
    await fsp.writeFile(path.join(this.backupDir, 'manifest.json'), JSON.stringify(this.ops, null, 2));
    return this.backupDir;
  }
}

/** @param {string} d @param {string} s */
async function isLinkedTo(d, s) {
  try {
    const st = await fsp.lstat(d);
    if (st.isSymbolicLink()) return samePath(await fsp.realpath(d), await fsp.realpath(s));
    if (st.isFile()) {
      const [a, b] = await Promise.all([fsp.stat(d, { bigint: true }), fsp.stat(s, { bigint: true })]);
      return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev; // hard link
    }
  } catch {
    /* does not exist */
  }
  return false;
}

const newResult = () => ({
  /** @type {string[]} */ linked: [],
  /** @type {string[]} */ copied: [],
  /** @type {{ item: string, reason: string, detail?: string }[]} */ skipped: [],
  /** @type {string[]} */ backedUp: [],
  merged: 0,
  /** @type {string[]} */ conflicts: [],
});

/**
 * @typedef {{ journal: Journal, tag?: string, check?: () => void, platform?: string }} OpContext
 * @typedef {ReturnType<typeof newResult>} LinkResult
 */

// Moves the account's content (from) into the base folder (to), merging without overwriting.
/** @param {string} from @param {string} to @param {OpContext & { out: LinkResult }} c */
async function mergeInto(from, to, c) {
  c.check?.();
  const st = await fsp.lstat(from);
  if (st.isSymbolicLink()) {
    await c.journal.unlink(from);
    return;
  }
  const target = await lstatOrNull(to);
  if (!target) {
    await c.journal.mkdirp(path.dirname(to));
    await c.journal.move(from, to);
    c.out.merged++;
    return;
  }
  const targetIsDir = (await fsp.stat(to)).isDirectory();
  if (st.isDirectory() && targetIsDir) {
    for (const e of await fsp.readdir(from)) await mergeInto(path.join(from, e), path.join(to, e), c);
    await fsp.rmdir(from); // empty now; fails (and rolls back) if something appeared meanwhile
    c.journal.record({ type: 'rmdir', path: from });
    return;
  }
  if (!st.isDirectory() && !targetIsDir) {
    if (await sameContent(from, to)) {
      await c.journal.stash(from);
      return;
    }
    if (to.endsWith('.jsonl')) {
      // Line logs (sessions, prompt history): add what is missing.
      const merged = mergeJsonl(await fsp.readFile(to, 'utf8'), await fsp.readFile(from, 'utf8'), {
        sortByTime: path.basename(to) === 'history.jsonl',
      });
      if (merged !== null) {
        await c.journal.backupCopy(to);
        await writeAtomic(to, merged);
      }
      await c.journal.stash(from);
      c.out.merged++;
      return;
    }
  }
  let conflict = `${to}.conflict-${c.tag || 'account'}`;
  for (let i = 2; await lstatOrNull(conflict); i++) conflict = `${to}.conflict-${c.tag || 'account'}-${i}`;
  await c.journal.move(from, conflict);
  c.out.conflicts.push(path.basename(conflict));
}

/**
 * Links each item of the account folder (dir) to the same item in base.
 * - merge: the account's own content is merged into base first (history).
 * - replaceLocal: the account's own version is renamed to .bak-<date> (config).
 * - otherwise an item the account already has is skipped.
 * @param {string} base @param {string} dir @param {string[]} items
 * @param {OpContext & { merge?: boolean, replaceLocal?: boolean, stamp?: string }} c
 */
async function linkItems(base, dir, items, c) {
  const out = newResult();
  const platform = c.platform || process.platform;
  for (const item of items) {
    c.check?.();
    const why = invalidItem(item);
    if (why) {
      out.skipped.push({ item: String(item), reason: why });
      continue;
    }
    const s = path.join(base, item);
    const d = path.join(dir, item);
    if (await isLinkedTo(d, s)) {
      out.linked.push(item);
      continue;
    }

    let st = await lstatOrNull(d);
    if (st && st.isSymbolicLink()) {
      await c.journal.unlink(d); // points elsewhere or is broken
      st = null;
    }

    if (!(await exists(s))) {
      if (!c.merge) {
        out.skipped.push({ item, reason: 'missing' });
        continue;
      }
      await c.journal.mkdirp(base);
      if (st) {
        await c.journal.move(d, s);
        st = null;
        out.merged++;
      } else if (path.extname(item)) {
        await fsp.writeFile(s, '', { flag: 'wx' });
        c.journal.record({ type: 'created', path: s });
      } else {
        await c.journal.mkdirp(s);
      }
    }

    if (st) {
      if (c.merge) await mergeInto(d, s, { ...c, out });
      else if (c.replaceLocal) {
        let bak = `${d}.bak-${c.stamp || stamp()}`;
        for (let i = 2; await lstatOrNull(bak); i++) bak = `${d}.bak-${c.stamp || stamp()}-${i}`;
        await c.journal.move(d, bak);
        out.backedUp.push(path.basename(bak));
      } else {
        out.skipped.push({ item, reason: 'own' });
        continue;
      }
    }

    const isDir = (await fsp.stat(s)).isDirectory();
    try {
      await fsp.symlink(s, d, isDir ? (platform === 'win32' ? 'junction' : 'dir') : 'file');
      c.journal.record({ type: 'link', path: d });
      out.linked.push(item);
    } catch (e) {
      if (isDir) {
        out.skipped.push({ item, reason: 'link', detail: e.code || e.message });
        continue;
      }
      try {
        await fsp.link(s, d); // Windows without symlink permission
        c.journal.record({ type: 'link', path: d });
        out.linked.push(item);
      } catch {
        if (c.merge) {
          out.skipped.push({ item, reason: 'link' });
          continue;
        }
        await fsp.copyFile(s, d);
        c.journal.record({ type: 'created', path: d });
        out.copied.push(item);
      }
    }
  }
  return out;
}

// Undoes links. copy=true leaves an independent copy; copy=false leaves the account without the item.
/** @param {string} base @param {string} dir @param {string[]} items @param {OpContext & { copy?: boolean }} c */
async function unlinkItems(base, dir, items, c) {
  const done = [];
  for (const item of items) {
    c.check?.();
    if (invalidItem(item)) continue;
    const s = path.join(base, item);
    const d = path.join(dir, item);
    if (!(await isLinkedTo(d, s))) continue;
    await c.journal.unlink(d);
    if (c.copy !== false) {
      await fsp.cp(s, d, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      c.journal.record({ type: 'created', path: d });
    }
    done.push(item);
  }
  return done;
}

// Items that should be linked but are not. Config items only count when they exist in base.
/** @param {string} base @param {string} dir @param {{ configItems: string[], historyItems: string[] }} items */
async function brokenLinks(base, dir, { configItems, historyItems }) {
  const broken = [];
  for (const i of configItems) {
    if (invalidItem(i)) continue;
    if ((await exists(path.join(base, i))) && !(await isLinkedTo(path.join(dir, i), path.join(base, i)))) broken.push(i);
  }
  for (const i of historyItems) {
    if (invalidItem(i)) continue;
    if (!(await isLinkedTo(path.join(dir, i), path.join(base, i)))) broken.push(i);
  }
  return broken;
}

// Removes the top-level links of an account folder, so deleting it can never follow them into base.
/** @param {string} dir */
async function removeTopLevelLinks(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry);
    const st = await lstatOrNull(p);
    if (st && st.isSymbolicLink()) await removeLink(p);
  }
}

// Every top-level item of base that a shared profile may link in "all except" mode.
/** @param {string} base @param {{ exclude?: string[], historyItems?: string[] }} [opts] */
async function shareableItems(base, { exclude = [], historyItems = DEFAULT_HISTORY_ITEMS } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(base);
  } catch {
    return [];
  }
  const skip = new Set([...exclude, ...historyItems, ...DEFAULT_HISTORY_ITEMS].map((x) => x.toLowerCase()));
  return entries
    .filter((e) => !e.startsWith('.') && !invalidItem(e) && !skip.has(e.toLowerCase()))
    .filter((e) => !/\.(bak|conflict)-/.test(e) && !/\.tmp-\d/.test(e))
    .sort();
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

module.exports = {
  CREDENTIAL_ITEM,
  VOLATILE_ITEMS,
  DEFAULT_HISTORY_ITEMS,
  CancelledError,
  Journal,
  invalidItem,
  isLinkedTo,
  linkItems,
  unlinkItems,
  mergeInto,
  mergeJsonl,
  brokenLinks,
  removeTopLevelLinks,
  shareableItems,
  writeAtomic,
  removeLink,
  stamp,
};
