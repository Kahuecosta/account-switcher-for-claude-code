'use strict';
// Cross-window lock file, so two VS Code windows never relink or merge the same folders at once.
const fs = require('fs');
const os = require('os');
const path = require('path');

class LockedError extends Error {
  /** @param {string} lockPath @param {any} owner */
  constructor(lockPath, owner) {
    super(`Another window is changing the account folders (${lockPath}).`);
    this.code = 'ELOCKED';
    this.owner = owner;
  }
}

/** @param {number} pid */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Runs fn while holding the lock. A lock older than staleMs, or held by a dead process on this
 * host, is taken over.
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{ staleMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withLock(lockPath, fn, { staleMs = 10 * 60e3 } = {}) {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  const me = { pid: process.pid, host: os.hostname(), at: Date.now() };
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.promises.open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify(me));
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || attempt >= 1) {
        if (e.code === 'EEXIST') throw new LockedError(lockPath, await readOwner(lockPath));
        throw e;
      }
      const owner = await readOwner(lockPath);
      const stale =
        !owner ||
        Date.now() - (owner.at || 0) > staleMs ||
        (owner.host === me.host && owner.pid !== process.pid && !processAlive(owner.pid));
      if (!stale) throw new LockedError(lockPath, owner);
      await fs.promises.rm(lockPath, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    await fs.promises.rm(lockPath, { force: true });
  }
}

/** @param {string} lockPath */
async function readOwner(lockPath) {
  try {
    return JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { withLock, LockedError };
