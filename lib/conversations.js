'use strict';
// Claude Code conversations on disk (transcripts; lib/sessions.js is the registry of running claude processes): <config>/projects/<encoded folder>/<session id>.jsonl, with the
// session's subagent and tool-result files in <session id>/ next to it and its checkpoints in
// <config>/file-history/<session id>/. Used to carry a conversation over to another account.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { encodeProjectDir } = require('./usage');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code shortens folder names longer than this and appends a hash.
const MAX_DIR_NAME = 200;

/** @param {string} p */
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Project folders of `configDir` that hold the conversations of `folder`. Asynchronous throughout: a
// long-used folder can have thousands of conversations, and this runs on the extension host.
/** @param {string} configDir @param {string} folder @returns {Promise<string[]>} */
async function projectDirs(configDir, folder) {
  const projects = path.join(configDir, 'projects');
  const name = encodeProjectDir(folder);
  if (name.length <= MAX_DIR_NAME) {
    const p = path.join(projects, name);
    try {
      return (await fs.promises.stat(p)).isDirectory() ? [p] : [];
    } catch {
      return [];
    }
  }
  const prefix = name.slice(0, MAX_DIR_NAME);
  try {
    return (await fs.promises.readdir(projects)).filter((n) => n.startsWith(prefix)).map((n) => path.join(projects, n));
  } catch {
    return [];
  }
}

/**
 * The most recently written conversation of any of `folders`, or null.
 * @param {string} configDir @param {string[]} folders
 * @returns {Promise<{ id: string, file: string, projectDir: string, mtimeMs: number } | null>}
 */
async function latestSession(configDir, folders) {
  /** @type {{ id: string, file: string, projectDir: string, mtimeMs: number } | null} */
  let best = null;
  for (const folder of folders) {
    for (const projectDir of await projectDirs(configDir, folder)) {
      let names;
      try {
        names = await fs.promises.readdir(projectDir);
      } catch {
        continue;
      }
      const ids = names.filter((n) => n.endsWith('.jsonl') && SESSION_ID.test(n.slice(0, -6)));
      const stats = await Promise.all(ids.map((n) => fs.promises.stat(path.join(projectDir, n)).catch(() => null)));
      ids.forEach((n, i) => {
        const st = stats[i];
        if (!st || !st.isFile() || st.size === 0) return;
        if (!best || st.mtimeMs > best.mtimeMs)
          best = { id: n.slice(0, -6), file: path.join(projectDir, n), projectDir, mtimeMs: st.mtimeMs };
      });
    }
  }
  return best;
}

// Copies through a temporary file, removed if anything fails, so the target is never half written.
/** @param {string} src @param {string} dst */
async function copyFileAtomic(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.copyFile(src, tmp);
    await fs.promises.rename(tmp, dst);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => null);
    throw e;
  }
}

const CHUNK = 1 << 20;
// True when the first `length` bytes of both files are equal. Read in chunks: a conversation with large
// tool outputs can be hundreds of MB, and this runs on the extension host.
/** @param {string} a @param {string} b @param {number} length */
async function samePrefix(a, b, length) {
  const [ha, hb] = await Promise.all([fs.promises.open(a, 'r'), fs.promises.open(b, 'r')]);
  try {
    const x = Buffer.alloc(Math.min(CHUNK, Math.max(length, 1)));
    const y = Buffer.alloc(x.length);
    for (let pos = 0; pos < length; pos += x.length) {
      const n = Math.min(x.length, length - pos);
      const [ra, rb] = await Promise.all([ha.read(x, 0, n, pos), hb.read(y, 0, n, pos)]);
      if (ra.bytesRead !== n || rb.bytesRead !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false;
    }
    return true;
  } finally {
    await Promise.all([ha.close(), hb.close()]);
  }
}

/** @param {string} src @param {string} dst */
async function copyDirIfAny(src, dst) {
  if (!fs.existsSync(src) || real(src) === real(dst)) return;
  await fs.promises.mkdir(path.dirname(dst), { recursive: true });
  await fs.promises.cp(src, dst, { recursive: true, force: true, errorOnExist: false });
}

/**
 * @typedef {'shared' | 'copied' | 'current' | 'diverged'} CopyResult
 * shared: both accounts use the same folder (shared history), nothing to copy.
 * copied: the target had no copy, or an older one that this copy extends.
 * current: the target's copy already has everything (it is the same or continues it).
 * diverged: the conversation went on in both accounts; the target's copy is kept as it is.
 */

/**
 * Copies a conversation into another account's folder, so that account can resume it. A copy in the
 * target is replaced only when the source extends it, so no message written there is ever lost.
 * @param {{ id: string, file: string, projectDir: string }} session
 * @param {string} fromConfigDir @param {string} toConfigDir
 * @returns {Promise<CopyResult>}
 */
async function copySession(session, fromConfigDir, toConfigDir) {
  if (!SESSION_ID.test(session.id)) throw new Error(`Not a session id: ${session.id}`);
  const dstDir = path.join(toConfigDir, 'projects', path.basename(session.projectDir));
  if (real(session.projectDir) === real(dstDir)) return 'shared';
  await fs.promises.mkdir(dstDir, { recursive: true });
  const dst = path.join(dstDir, `${session.id}.jsonl`);
  const srcSize = (await fs.promises.stat(session.file)).size;
  let dstSize = -1;
  try {
    dstSize = (await fs.promises.stat(dst)).size;
  } catch {
    /* not copied before */
  }
  /** @type {CopyResult} */
  let result;
  if (dstSize < 0 || (srcSize > dstSize && (await samePrefix(session.file, dst, dstSize)))) {
    await copyFileAtomic(session.file, dst);
    await copyDirIfAny(path.join(session.projectDir, session.id), path.join(dstDir, session.id));
    await copyDirIfAny(path.join(fromConfigDir, 'file-history', session.id), path.join(toConfigDir, 'file-history', session.id));
    result = 'copied';
  } else {
    result = srcSize <= dstSize && (await samePrefix(session.file, dst, srcSize)) ? 'current' : 'diverged';
  }
  // The target's copy becomes the newest: the per-chat launcher resumes a conversation from the account
  // whose copy was written last, and that is now the account it continues in. A copy that lacks the
  // source's latest messages (diverged) is left alone: the caller forks instead.
  if (result !== 'diverged') {
    const now = new Date();
    await fs.promises.utimes(dst, now, now);
  }
  return result;
}

// Copies a text file line by line, replacing every occurrence of `from` with `to`, through a temporary
// file removed if anything fails. Streams, so a conversation of any size uses little memory.
/** @param {string} src @param {string} dst @param {string} from @param {string} to */
async function copyReplacing(src, dst, from, to) {
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  const fix = (/** @type {string} */ line) => line.replace(/\r$/, '').split(from).join(to) + '\n';
  // Whole lines only (the id never spans two chunks), decoded as UTF-8 across chunk boundaries.
  async function* lines(/** @type {AsyncIterable<string>} */ input) {
    let rest = '';
    for await (const chunk of input) {
      const parts = (rest + chunk).split('\n');
      rest = /** @type {string} */ (parts.pop());
      for (const p of parts) yield fix(p);
    }
    if (rest) yield fix(rest);
  }
  try {
    // pipeline() settles on an error at either end (a full disk, a folder that cannot be written), so a
    // failure is always reported instead of leaving the copy waiting.
    await pipeline(fs.createReadStream(src, { encoding: 'utf8' }), lines, fs.createWriteStream(tmp));
    await fs.promises.rename(tmp, dst);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => null);
    throw e;
  }
}

/** @param {string} srcDir @param {string} dstDir @param {string} from @param {string} to */
async function copyTreeReplacing(srcDir, dstDir, from, to) {
  let entries;
  try {
    entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  } catch {
    return; // nothing to copy
  }
  await fs.promises.mkdir(dstDir, { recursive: true });
  for (const e of entries) {
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name.split(from).join(to));
    if (e.isDirectory()) await copyTreeReplacing(s, d, from, to);
    else if (e.isFile()) await (e.name.endsWith('.jsonl') ? copyReplacing(s, d, from, to) : fs.promises.copyFile(s, d));
  }
}

/**
 * A copy of a conversation under a new session id in another account's folder (or the same folder,
 * with shared history), like Claude Code's own --fork-session. The original is not touched, so a tab
 * that still runs it keeps working; the copy opens in a tab of its own.
 * @param {{ id: string, file: string, projectDir: string }} session
 * @param {string} fromConfigDir @param {string} toConfigDir
 * @returns {Promise<string>} the new session id
 */
async function forkSession(session, fromConfigDir, toConfigDir, newId = crypto.randomUUID()) {
  if (!SESSION_ID.test(session.id)) throw new Error(`Not a session id: ${session.id}`);
  if (!SESSION_ID.test(newId)) throw new Error(`Not a session id: ${newId}`);
  const dstDir = path.join(toConfigDir, 'projects', path.basename(session.projectDir));
  await fs.promises.mkdir(dstDir, { recursive: true });
  await copyReplacing(session.file, path.join(dstDir, `${newId}.jsonl`), session.id, newId);
  await copyTreeReplacing(path.join(session.projectDir, session.id), path.join(dstDir, newId), session.id, newId);
  const history = path.join(fromConfigDir, 'file-history', session.id);
  if (fs.existsSync(history)) {
    const dst = path.join(toConfigDir, 'file-history', newId);
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.cp(history, dst, { recursive: true, force: false, errorOnExist: false });
  }
  return newId;
}

/**
 * The conversation a transcript file belongs to: the file itself, or, for a subagent's transcript
 * (<project>/<session id>/subagents/...), the conversation that holds it. Null when it is neither.
 * @param {string} file @returns {{ id: string, file: string, projectDir: string } | null}
 */
function sessionOfFile(file) {
  const parts = path.resolve(file).split(path.sep);
  const own = path.basename(file, '.jsonl');
  if (file.endsWith('.jsonl') && SESSION_ID.test(own))
    return { id: own, file: path.resolve(file), projectDir: path.dirname(path.resolve(file)) };
  for (let i = parts.length - 2; i > 0; i--) {
    if (!SESSION_ID.test(parts[i])) continue;
    const projectDir = parts.slice(0, i).join(path.sep) || path.sep;
    const main = path.join(projectDir, `${parts[i]}.jsonl`);
    return fs.existsSync(main) ? { id: parts[i], file: main, projectDir } : null;
  }
  return null;
}

/**
 * The conversation `id` of `folders` in `configDir`, or null.
 * @param {string} configDir @param {string[]} folders @param {string} id
 */
async function findSession(configDir, folders, id) {
  if (!SESSION_ID.test(id)) return null;
  for (const folder of folders) {
    for (const projectDir of await projectDirs(configDir, folder)) {
      const file = path.join(projectDir, `${id}.jsonl`);
      if (fs.existsSync(file)) return { id, file, projectDir };
    }
  }
  return null;
}

module.exports = { SESSION_ID, projectDirs, latestSession, findSession, sessionOfFile, copySession, forkSession };
