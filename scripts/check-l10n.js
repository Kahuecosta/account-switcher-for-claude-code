// Verifies every t('...') message has a pt-BR translation with matching placeholders.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const keys = new Set();
for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
let failed = false;
for (const f of fs.readdirSync(path.join(root, 'l10n'))) {
  const bundle = JSON.parse(fs.readFileSync(path.join(root, 'l10n', f), 'utf8'));
  for (const k of keys) {
    if (!(k in bundle)) { console.error(`${f}: missing ${JSON.stringify(k)}`); failed = true; continue; }
    const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
    if (ph(k) !== ph(bundle[k])) { console.error(`${f}: placeholder mismatch in ${JSON.stringify(k)}`); failed = true; }
  }
  for (const k of Object.keys(bundle)) if (!keys.has(k)) console.warn(`${f}: unused ${JSON.stringify(k)}`);
}
const nls = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const base = nls('package.nls.json');
for (const f of fs.readdirSync(root).filter((x) => /^package\.nls\..+\.json$/.test(x))) {
  for (const k of Object.keys(base)) if (!(k in nls(f))) { console.error(`${f}: missing ${k}`); failed = true; }
}
if (failed) process.exit(1);
console.log(`l10n OK (${keys.size} messages)`);
