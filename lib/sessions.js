'use strict';
// Every Claude Code CLI registers itself in <config dir>/sessions/<pid>.json (pid, cwd, startedAt,
// entrypoint). That folder belongs to one account (it is never linked), so a live entry there tells
// which account a running Claude Code panel really uses.
const fs = require('fs');
const path = require('path');
const { isInside } = require('./paths');

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Pids of the live Claude Code panel (VS Code) sessions registered in a config folder.
 * @param {string} configDir
 * @param {{ folders?: string[], since?: number, alive?: (pid: number) => boolean }} [opts]
 *   folders: only sessions whose cwd is inside one of them (all when empty);
 *   since: only sessions started at or after this time (ms).
 * @returns {number[]}
 */
function panelSessions(configDir, { folders = [], since = 0, alive = isAlive } = {}) {
  const dir = path.join(configDir, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const pids = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!s || s.entrypoint !== 'claude-vscode' || !Number.isInteger(s.pid)) continue;
    if (typeof s.startedAt !== 'number' || s.startedAt < since) continue;
    if (folders.length && (typeof s.cwd !== 'string' || !folders.some((f) => isInside(s.cwd, f)))) continue;
    if (alive(s.pid)) pids.push(s.pid);
  }
  return pids;
}

module.exports = { panelSessions, isAlive };
