'use strict';
// Finds the repository of a folder and its remotes by reading .git directly.
// No git process is started, so this is safe in untrusted workspaces (no hooks,
// no core.fsmonitor) and fast enough to run synchronously during activation.
const fs = require('fs');
const path = require('path');

/** @param {string} p */
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Returns { root, gitDir, commonDir } for the repository containing `folder`, or null.
/** @param {string} folder */
function findRepo(folder) {
  let dir = path.resolve(folder);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      /* not here */
    }
    if (st) {
      let gitDir = null;
      if (st.isDirectory()) gitDir = dotGit;
      else if (st.isFile()) {
        // Worktrees and submodules: ".git" is a file with "gitdir: <path>".
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) || '');
        if (m) gitDir = path.resolve(dir, m[1]);
      }
      if (gitDir) {
        const common = readText(path.join(gitDir, 'commondir'));
        const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir;
        return { root: dir, gitDir, commonDir };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Minimal git-config reader for remote URLs. Returns remotes in file order: [{ name, url }].
/** @param {string} text */
function parseRemotes(text) {
  const remotes = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, '').trim();
    if (!line) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (section) {
      const name = section[1].toLowerCase();
      if (name === 'remote' && section[2] !== undefined) current = section[2].replace(/\\(.)/g, '$1');
      else if (name.startsWith('remote.')) current = section[1].slice('remote.'.length);
      else current = null;
      continue;
    }
    if (current === null) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1].toLowerCase() !== 'url') continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!remotes.some((r) => r.name === current)) remotes.push({ name: current, url: value });
  }
  return remotes;
}

// "origin" when present, otherwise "upstream", otherwise the first remote.
/** @param {{ name: string, url: string }[]} remotes */
function pickRemote(remotes) {
  return remotes.find((r) => r.name === 'origin') || remotes.find((r) => r.name === 'upstream') || remotes[0] || null;
}

// { root, remote, remoteName } for a folder; root/remote are null outside a repository.
/** @param {string} folder */
function repoInfo(folder) {
  const repo = findRepo(folder);
  if (!repo) return { root: null, remote: null, remoteName: null };
  const remote = pickRemote(parseRemotes(readText(path.join(repo.commonDir, 'config')) || ''));
  return { root: repo.root, remote: remote ? remote.url : null, remoteName: remote ? remote.name : null };
}

module.exports = { findRepo, parseRemotes, pickRemote, repoInfo };
