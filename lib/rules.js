'use strict';
// Default-account rules: match the workspace folder (path globs) or the git remote (remote globs).

function normalizeRemote(url) {
  let u = String(url)
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (/^[a-z+]+:\/\//i.test(u)) {
    u = u
      .replace(/^[a-z+]+:\/\//i, '')
      .replace(/^[^@/]+@/, '')
      .replace(/^([^/:]+):\d+(?=\/)/, '$1');
  } else {
    const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/); // git@github.com:org/repo
    if (scp) u = `${scp[1]}/${scp[2]}`;
  }
  return u.toLowerCase();
}

function globToRegExp(glob, caseInsensitive) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', caseInsensitive ? 'i' : '');
}

const isPathPattern = (p) => /^(~|\/|[a-zA-Z]:[\\/]|\\\\)/.test(p);
const hasGlob = (p) => /[*?]/.test(p);

function normPath(p, home) {
  let s = String(p);
  if (s.startsWith('~')) s = home + s.slice(1);
  return s.replace(/\\/g, '/').replace(/\/+$/, '');
}

function matchesPattern(pattern, { folder, remote, home, platform }) {
  const p = String(pattern || '').trim();
  if (!p) return false;
  const insensitive = platform === 'win32' || platform === 'darwin';
  if (isPathPattern(p)) {
    if (!folder) return false;
    const target = normPath(folder, home);
    const pat = normPath(p, home);
    if (!hasGlob(pat)) {
      const a = insensitive ? target.toLowerCase() : target;
      const b = insensitive ? pat.toLowerCase() : pat;
      return a === b || a.startsWith(b + '/');
    }
    return globToRegExp(pat, insensitive).test(target);
  }
  if (!remote) return false;
  const target = normalizeRemote(remote);
  const pat = normalizeRemote(p);
  if (!hasGlob(pat)) return target === pat || target.startsWith(pat + '/');
  return globToRegExp(pat, true).test(target);
}

// Returns the first rule that matches, or null.
function matchRule(rules, ctx) {
  for (const r of Array.isArray(rules) ? rules : []) {
    if (r && r.account && matchesPattern(r.pattern, ctx)) return r;
  }
  return null;
}

module.exports = { normalizeRemote, globToRegExp, matchesPattern, matchRule };
