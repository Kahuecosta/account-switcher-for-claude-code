'use strict';
// Generates the settings table of README.md (English) and README.pt-BR.md (Portuguese) from
// package.json and package.nls*.json, between <!-- settings:start --> and <!-- settings:end -->.
// With --check, fails when a README is out of date instead of writing it.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const pkg = read('package.json');
const check = process.argv.includes('--check');

const targets = [
  { file: 'README.md', nls: read('package.nls.json'), head: ['Setting', 'Default', 'Description'], deprecated: 'Deprecated.' },
  { file: 'README.pt-BR.md', nls: read('package.nls.pt-br.json'), head: ['Configuração', 'Padrão', 'Descrição'], deprecated: 'Obsoleta.' },
];

/** @param {string} s */
const plain = (s) =>
  s
    .replace(/\[([^\]]+)\]\(command:[^)]+\)/g, '$1') // command links only work inside VS Code
    .replace(/`#([\w.]+)#`/g, '`$1`')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ');

/** @param {unknown} v */
function defaultText(v) {
  if (Array.isArray(v)) return v.length ? v.map((x) => `\`${x}\``).join(', ') : '`[]`';
  if (v === '') return '—';
  return `\`${JSON.stringify(v)}\``;
}

let stale = false;
for (const t of targets) {
  const props = Object.entries(pkg.contributes.configuration.properties).sort(([, a], [, b]) => (a.order ?? 999) - (b.order ?? 999));
  const rows = props.map(([key, p]) => {
    const ref = (p.markdownDescription || p.description || '').replace(/^%|%$/g, '');
    let desc = plain(t.nls[ref] || ref);
    if (p.enum && p.enumDescriptions) {
      desc += ' ' + p.enum.map((v, i) => `\`${v}\`: ${plain(t.nls[p.enumDescriptions[i].replace(/^%|%$/g, '')])}`).join(' ');
    }
    if (p.markdownDeprecationMessage) desc = `${t.deprecated} ${plain(t.nls[p.markdownDeprecationMessage.replace(/^%|%$/g, '')])}`;
    return `| \`${key}\` | ${defaultText(p.default)} | ${desc} |`;
  });
  const table = [`| ${t.head.join(' | ')} |`, '| --- | --- | --- |', ...rows].join('\n');
  const file = path.join(root, t.file);
  const text = fs.readFileSync(file, 'utf8');
  const re = /(<!-- settings:start -->)[\s\S]*?(<!-- settings:end -->)/;
  if (!re.test(text)) throw new Error(`${t.file}: settings markers not found`);
  const next = text.replace(re, `$1\n${table}\n$2`);
  if (next === text) continue;
  if (check) {
    console.error(`${t.file}: the settings table is out of date. Run "npm run docs".`);
    stale = true;
  } else {
    fs.writeFileSync(file, next);
    console.log(`${t.file}: settings table updated`);
  }
}
if (stale) process.exit(1);
