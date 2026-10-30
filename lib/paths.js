'use strict';
const os = require('os');
const path = require('path');

/** @param {string | undefined | null} p */
const expandHome = (p) => (p && /^~(?=$|[\\/])/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// Windows and (by default) macOS file systems are case-insensitive.
const caseInsensitive = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

/** @param {string} p */
const normalize = (p) => path.resolve(expandHome(p)).replace(/[\\/]+$/, '') || path.sep;

/** @param {string | null | undefined} a @param {string | null | undefined} b */
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const x = normalize(a);
  const y = normalize(b);
  return caseInsensitive(platform) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// True when child is parent itself or somewhere below it.
/** @param {string} child @param {string} parent */
function isInside(child, parent, platform = process.platform) {
  const rel = path.relative(normalize(parent), normalize(child));
  const r = caseInsensitive(platform) ? rel.toLowerCase() : rel;
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

// "~/work/x" for paths under the home folder, with forward slashes.
/** @param {string} p */
function tildify(p, home = os.homedir()) {
  const rel = path.relative(home, p);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return (inside ? path.join('~', rel) : p).replace(/\\/g, '/');
}

module.exports = { expandHome, samePath, isInside, tildify, caseInsensitive, normalize };
