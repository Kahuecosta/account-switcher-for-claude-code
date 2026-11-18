'use strict';
// Switching without reloading the window. The Claude Code extension starts each claude process with the
// extension host's environment, read again at every start, so new chats already follow CLAUDE_CONFIG_DIR
// as soon as it changes. Its account display, sign-in state and caches follow it too, but only when it
// re-checks CLAUDE_CONFIG_DIR, which it does whenever claudeCode.environmentVariables changes: it then
// logs "CLAUDE_CONFIG_DIR changed in the claudeCode.environmentVariables setting; refreshing every
// webview". Each window compares its own environment, so only the window that switched refreshes.
//
// To make it re-check, an entry is added to claudeCode.environmentVariables and removed right away; the
// setting ends exactly as it was. Conversations already open keep their claude process, and so their
// account, until they are closed or the window reloads.
//
// Only used when the installed Claude Code extension contains that behavior (checked in its code, by the
// log message above, since its internal names change with every build), and when nothing else decides
// CLAUDE_CONFIG_DIR for it.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { rt, cfg, OFFICIAL_EXTENSION_ID } = require('./runtime');

const MARKER = 'CLAUDE_ACCOUNTS_REFRESH';
const SIGNATURE = 'CLAUDE_CONFIG_DIR changed in the claudeCode.environmentVariables setting';

/** @type {Map<string, boolean>} extension version -> whether it follows CLAUDE_CONFIG_DIR */
const supportCache = new Map();

const claudeCodeConfig = () => vscode.workspace.getConfiguration('claudeCode');

// Whether the installed Claude Code extension follows a CLAUDE_CONFIG_DIR change without a reload.
async function officialSupports() {
  const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
  if (!ext) return false;
  const version = String(ext.packageJSON?.version || '');
  const cached = supportCache.get(version);
  if (cached !== undefined) return cached;
  const main = path.join(ext.extensionPath, ext.packageJSON?.main || 'extension.js');
  let found;
  try {
    // "main" may name the file with or without its extension (.js, .cjs, .mjs).
    const file = fs.existsSync(main) ? main : `${main}.js`;
    found = (await fs.promises.readFile(file, 'utf8')).includes(SIGNATURE);
  } catch (e) {
    // Not remembered: a passing error (a busy file system) must not rule it out until the next reload.
    rt.log.warn(`Reading the Claude Code extension: ${e}`);
    return false;
  }
  supportCache.set(version, found);
  rt.log.info(`Claude Code ${version} ${found ? 'follows' : 'does not follow'} account changes without a reload`);
  return found;
}

/** @param {unknown} v @returns {string[]} names set by the setting, in either of its formats */
function namesIn(v) {
  if (Array.isArray(v)) return v.filter((e) => e && typeof e === 'object' && typeof e.name === 'string').map((e) => e.name);
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
}

// CLAUDE_CONFIG_DIR set in claudeCode.environmentVariables wins over the window's environment: switching
// then cannot work, live or not (the setup issue in src/health.js explains it).
const overridden = () => namesIn(claudeCodeConfig().get('environmentVariables')).some((n) => n.toUpperCase() === 'CLAUDE_CONFIG_DIR');

/** @param {unknown} v @returns {boolean} whether `v` is a value this module can add an entry to */
const editable = (v) => v === undefined || Array.isArray(v) || (!!v && typeof v === 'object');

/** @param {unknown} v @param {string} nonce */
function withMarker(v, nonce) {
  if (Array.isArray(v)) return [...v, { name: MARKER, value: nonce }];
  if (v && typeof v === 'object') return { ...v, [MARKER]: nonce };
  return [{ name: MARKER, value: nonce }];
}

/** @param {unknown} v */
function withoutMarker(v) {
  if (Array.isArray(v)) return v.filter((e) => !(e && typeof e === 'object' && e.name === MARKER));
  if (v && typeof v === 'object') {
    const out = { ...v };
    delete out[MARKER];
    return out;
  }
  return v;
}

const hasMarker = (/** @type {unknown} */ v) => namesIn(v).includes(MARKER);

// What the user's variables are, in a form to compare: the marker left out, and an unset, empty or
// marker-only value all the same ("no variables").
/** @param {unknown} v */
const userVariables = (v) => {
  const rest = withoutMarker(v);
  return namesIn(rest).length ? JSON.stringify(rest) : '';
};
// A value holding nothing but a marker (left by an interrupted switch): it did not exist for the user.
const onlyMarker = (/** @type {unknown} */ v) => hasMarker(v) && namesIn(withoutMarker(v)).length === 0;

// The setting without the marker; removed altogether when the marker was all it held and the setting
// did not exist before (wasSet false). An empty list or object you set yourself stays.
/** @param {unknown} v @param {boolean} wasSet */
const restoredValue = (v, wasSet) => {
  const rest = withoutMarker(v);
  return !wasSet && namesIn(rest).length === 0 ? undefined : rest;
};

// Whether a switch can happen without a reload now (notify() still checks again, and can still fail).
async function available() {
  if (cfg('switchWithoutReload') === false || overridden()) return false;
  if (!editable(claudeCodeConfig().inspect('environmentVariables')?.globalValue)) return false;
  return officialSupports();
}

/**
 * Tells the Claude Code extension of this window to re-check CLAUDE_CONFIG_DIR. Resolves to true when it
 * was told; false when switching needs a reload (feature off, extension missing or too old, the setting
 * cannot be edited). Callers run one switch at a time (switching.serially), so two calls never
 * interleave their writes.
 */
function notify() {
  return notifyNow();
}

async function notifyNow() {
  if (cfg('switchWithoutReload') === false || overridden()) return false;
  if (!(await officialSupports())) return false;
  const c = claudeCodeConfig();
  const before = c.inspect('environmentVariables')?.globalValue;
  if (!editable(before)) return false;
  // A marker left by an interrupted earlier call goes away too.
  const original = withoutMarker(before);
  try {
    await c.update('environmentVariables', withMarker(original, String(Date.now())), vscode.ConfigurationTarget.Global);
  } catch (e) {
    rt.log.warn(`Could not tell Claude Code about the account change: ${e}`);
    return false;
  }
  try {
    // Taken out of the value as it is now, so an edit made meanwhile (by you, another window or Settings
    // Sync) is kept; and not written at all when someone already took it out.
    const now = claudeCodeConfig().inspect('environmentVariables')?.globalValue;
    if (hasMarker(now))
      await c.update(
        'environmentVariables',
        restoredValue(now, before !== undefined && !onlyMarker(before)),
        vscode.ConfigurationTarget.Global
      );
  } catch (e) {
    rt.log.error(`Could not restore claudeCode.environmentVariables: ${e}`);
  }
  rt.log.info('Claude Code told about the account change');
  return true;
}

// Removes a marker an interrupted call left behind (the window closed between the two writes).
async function cleanup() {
  const c = claudeCodeConfig();
  const v = c.inspect('environmentVariables')?.globalValue;
  if (!hasMarker(v)) return;
  await c.update('environmentVariables', restoredValue(v, false), vscode.ConfigurationTarget.Global);
  rt.log.info('Removed a leftover entry from claudeCode.environmentVariables');
}

module.exports = {
  MARKER,
  SIGNATURE,
  notify,
  available,
  cleanup,
  officialSupports,
  overridden,
  withMarker,
  withoutMarker,
  namesIn,
  userVariables,
};
