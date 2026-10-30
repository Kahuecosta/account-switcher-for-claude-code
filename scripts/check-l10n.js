'use strict';
// Verifies the translations:
// - every t('...') message in src/ has a translation with the same placeholders in each l10n bundle;
// - t() is only called with a string literal (anything else cannot be translated);
// - bundles have no stale entries;
// - every %key% in package.json exists in package.nls.json and in every package.nls.<lang>.json.
// With --write-keys <file>, writes the sorted message list as JSON (used to prepare translations).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const errors = [];

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

/** @param {string} s */
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

const keys = new Set();
for (const file of jsFiles(path.join(root, 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  for (const m of src.matchAll(/(?<![.\w$])t\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)) keys.add(unescape(m[1].slice(1, -1)));
  for (const m of src.matchAll(/(?<![.\w$])t\(\s*(?!['"])([^\s)])/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    errors.push(`${rel}:${line}: t() must be called with a string literal`);
  }
}

const ph = (/** @type {string} */ s) => (s.match(/\{\d+\}/g) || []).sort().join();
const bundles = fs.readdirSync(path.join(root, 'l10n')).filter((f) => /^bundle\.l10n\..+\.json$/.test(f));
for (const f of bundles) {
  const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', f), 'utf8'));
  for (const k of keys) {
    if (!(k in bundle)) errors.push(`${f}: missing ${JSON.stringify(k)}`);
    else if (typeof bundle[k] !== 'string' || !bundle[k].trim()) errors.push(`${f}: empty translation for ${JSON.stringify(k)}`);
    else if (ph(k) !== ph(bundle[k])) errors.push(`${f}: placeholder mismatch in ${JSON.stringify(k)}`);
  }
  for (const k of Object.keys(bundle)) if (!keys.has(k)) errors.push(`${f}: unused ${JSON.stringify(k)}`);
}

const nls = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const base = nls('package.nls.json');
const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const used = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
for (const k of used) if (!(k in base)) errors.push(`package.nls.json: missing ${k}`);
for (const k of Object.keys(base)) if (!used.has(k)) errors.push(`package.nls.json: unused ${k}`);
for (const f of fs.readdirSync(root).filter((x) => /^package\.nls\..+\.json$/.test(x))) {
  const other = nls(f);
  for (const k of Object.keys(base)) {
    if (!(k in other)) errors.push(`${f}: missing ${k}`);
    else if (ph(base[k]) !== ph(other[k])) errors.push(`${f}: placeholder mismatch in ${k}`);
  }
  for (const k of Object.keys(other)) if (!(k in base)) errors.push(`${f}: unused ${k}`);
}

const out = process.argv.indexOf('--write-keys');
if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify([...keys].sort(), null, 2) + '\n');

if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(`\n${errors.length} l10n problem(s).`);
  process.exit(1);
}
console.log(`l10n OK (${keys.size} messages, ${bundles.length} bundle(s), ${used.size} manifest strings)`);
