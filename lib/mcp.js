'use strict';
// Mirrors user-scope MCP servers (top-level "mcpServers" in .claude.json) from the base profile into
// a shared-profile account. Servers the account defined itself are never touched; servers mirrored
// earlier and since removed from the base are removed again.
const fs = require('fs');
const { writeAtomic } = require('./links');

/** @param {string} file */
async function readJsonFile(file) {
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, json: {}, mtimeMs: 0 };
    throw e;
  }
  const json = JSON.parse(text); // a corrupt file is reported, never overwritten
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file} is not a JSON object`);
  const { mtimeMs } = await fs.promises.stat(file);
  return { exists: true, json, mtimeMs };
}

const isObject = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Pure merge. Returns { servers, mirrored, changed }.
 * @param {Record<string, any> | undefined} accountServers
 * @param {Record<string, any> | undefined} baseServers
 * @param {string[]} previouslyMirrored
 */
function mergeServers(accountServers, baseServers, previouslyMirrored) {
  const own = isObject(accountServers) ? { ...accountServers } : {};
  const base = isObject(baseServers) ? baseServers : {};
  const prev = new Set(previouslyMirrored || []);
  const servers = {};
  const mirrored = [];
  // Keep the account's own servers (those not mirrored before).
  for (const [name, def] of Object.entries(own)) if (!prev.has(name)) servers[name] = def;
  for (const [name, def] of Object.entries(base)) {
    if (name in servers) continue; // the account's own definition wins
    servers[name] = def;
    mirrored.push(name);
  }
  const changed = JSON.stringify(sortKeys(servers)) !== JSON.stringify(sortKeys(own));
  return { servers, mirrored: mirrored.sort(), changed };
}

/** @param {Record<string, any>} o */
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Applies the merge to the account's .claude.json. Retries when Claude Code writes the file meanwhile.
 * @param {string} baseJsonPath @param {string} accountJsonPath @param {string[]} previouslyMirrored
 * @returns {Promise<{ changed: boolean, mirrored: string[] }>}
 */
async function mirrorMcpServers(baseJsonPath, accountJsonPath, previouslyMirrored) {
  const base = await readJsonFile(baseJsonPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    const acc = await readJsonFile(accountJsonPath);
    const r = mergeServers(acc.json.mcpServers, base.json.mcpServers, previouslyMirrored);
    if (!r.changed) return { changed: false, mirrored: r.mirrored };
    const next = { ...acc.json };
    if (Object.keys(r.servers).length) next.mcpServers = r.servers;
    else delete next.mcpServers;
    // Do not overwrite a write that happened while we were merging.
    const now = acc.exists ? (await fs.promises.stat(accountJsonPath)).mtimeMs : 0;
    if (now !== acc.mtimeMs) continue;
    await writeAtomic(accountJsonPath, JSON.stringify(next, null, 2));
    return { changed: true, mirrored: r.mirrored };
  }
  throw new Error(`${accountJsonPath} kept changing; MCP servers were not mirrored`);
}

module.exports = { mergeServers, mirrorMcpServers, readJsonFile };
