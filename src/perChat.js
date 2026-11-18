'use strict';
// Per-chat accounts (experimental, claudeAccounts.perChatAccounts): the Claude Code extension starts
// claude through a launcher (claudeCode.claudeProcessWrapper) that picks the account for each chat, so a
// new chat can use another account and a resumed one uses the account it belongs to, without reloading
// the window. See lib/wrapper.js. Turning it off restores the previous claudeProcessWrapper value.
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { rt, K, t, cfg, DEFAULT_ID, OFFICIAL_EXTENSION_ID, OPEN_SESSION_COMMAND, baseDir, bridgeDir } = require('./runtime');
const accounts = require('./accounts');
const state = require('./state');
const { writeAtomic } = require('../lib/links');
const w = require('../lib/wrapper');

/** @typedef {import('./accounts').Account} Account */

const { WINDOW_VAR, BASE_VAR } = w;

const supported = () => process.platform !== 'win32';
const enabled = () => supported() && !!cfg('perChatAccounts');
const scriptPath = () => path.join(bridgeDir(), w.SCRIPT_NAME);
const wrapperConfig = () => vscode.workspace.getConfiguration('claudeCode');
const currentWrapper = () => wrapperConfig().inspect('claudeProcessWrapper')?.globalValue;
const active = () => enabled() && currentWrapper() === scriptPath();
// A launcher of this extension, wherever it was written (claudeAccounts.accountsRoot may have changed
// since), so it is never mistaken for a wrapper of the user's own.
/** @param {unknown} p */
const isLauncher = (p) => typeof p === 'string' && path.basename(p) === w.SCRIPT_NAME && path.basename(path.dirname(p)) === '.bridge';

// Accounts a single chat can use: the launcher can only change the folder, not supply a key or token,
// so the account must sign in with its own claude.ai login and set no variables of its own.
/** @param {Account} a */
const eligible = (a) => a.kind === 'subscription' && Object.keys(accounts.envSpec(a.id)).length === 0;

// Identifies this window to the launcher, and tells it the window's base profile (the Default account
// can differ between windows started with and without CLAUDE_CONFIG_DIR). Set before the Claude Code
// extension starts claude.
function init() {
  // Always a new id: one inherited from a terminal of another window (`code -n` run there) would make
  // both windows share a route file.
  process.env[WINDOW_VAR] = crypto.randomBytes(8).toString('hex');
  if (rt.ORIGINAL_ENV) process.env[BASE_VAR] = baseDir();
  else delete process.env[BASE_VAR];
}
const routeFile = () => path.join(bridgeDir(), w.ROUTE_DIR, String(process.env[WINDOW_VAR]));

// How the launcher names an account: its folder, or null for the window's base profile.
/** @param {Account} a */
const lineOf = (a) => (a.id === DEFAULT_ID ? null : a.dir);

/** @param {string} file @param {string} text @param {number} [mode] */
async function writeIfChanged(file, text, mode) {
  try {
    if ((await fs.promises.readFile(file, 'utf8')) === text) {
      // Same content, but the mode may have been lost (restored from a backup, an older build).
      if (mode !== undefined && ((await fs.promises.stat(file)).mode & 0o777) !== mode) await fs.promises.chmod(file, mode);
      return false;
    }
  } catch {
    /* new */
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // Created with its final mode: the launcher is never seen, even for a moment, as a file that cannot run.
  await writeAtomic(file, text, mode);
  return true;
}

// The folders the launcher looks in for a resumed conversation. Called on every refresh, so it touches
// the disk only when the list changed since this window last wrote it.
let lastList = '';
async function writeAccountsList() {
  const text =
    accounts
      .allAccounts()
      .filter(eligible)
      .map((a) => lineOf(a) || w.BASE)
      .join('\n') + '\n';
  if (text === lastList) return;
  await writeIfChanged(path.join(bridgeDir(), w.ACCOUNTS_LIST), text);
  lastList = text;
}

// Installs or removes the launcher, following the setting. Returns an error message or null. Calls run
// one after another (the setting listener and the command can both ask).
let chain = Promise.resolve(/** @type {string | null} */ (null));
function sync() {
  const next = chain.then(syncNow, syncNow);
  chain = next.catch(() => null);
  return next;
}

async function syncNow() {
  const configured = currentWrapper();
  const ours = isLauncher(configured);
  try {
    if (!enabled()) {
      if (!ours) return null;
      const prev = state.get(K.WRAPPER_PREV, null);
      await wrapperConfig().update('claudeProcessWrapper', prev || undefined, vscode.ConfigurationTarget.Global);
      await state.update(K.WRAPPER_PREV, undefined);
      rt.log.info(`Per-chat accounts off: claudeProcessWrapper ${prev ? `restored to ${prev}` : 'removed'}`);
      return null;
    }
    // A wrapper of your own keeps running: the launcher starts it instead of claude.
    const original = ours ? state.get(K.WRAPPER_PREV, null) : configured || null;
    lastList = '';
    await writeAccountsList();
    const changed = await writeIfChanged(scriptPath(), w.wrapperScript({ bridgeDir: bridgeDir(), original }), 0o755);
    if (changed) rt.log.info(`Per-chat launcher written: ${scriptPath()}`);
    if (!ours) await state.update(K.WRAPPER_PREV, original);
    if (configured !== scriptPath()) {
      await wrapperConfig().update('claudeProcessWrapper', scriptPath(), vscode.ConfigurationTarget.Global);
      rt.log.info(`Per-chat accounts on: claudeProcessWrapper set${original ? ` (runs ${original})` : ''}`);
    }
    return null;
  } catch (e) {
    rt.log.error(`Per-chat launcher: ${e instanceof Error && e.stack ? e.stack : e}`);
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Opens a new Claude Code chat whose claude process uses `a`. The launcher uses the route for the next
 * new chat only (a resumed conversation always goes to the account it belongs to).
 * @param {Account} a
 */
async function openAs(a) {
  if (!vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID)) throw new Error(t('The Claude Code extension is not installed.'));
  if (!eligible(a))
    throw new Error(
      t('"{0}" signs in with a key, a token or variables of its own, so it can only be used by switching the window.', a.name)
    );
  const file = routeFile();
  const line = w.routeLine(lineOf(a));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, line);
  // Removed once expired, unless a later "New chat as account" replaced it in the meantime.
  const cleanup = setTimeout(async () => {
    try {
      if ((await fs.promises.readFile(file, 'utf8')) === line) await fs.promises.rm(file, { force: true });
    } catch {
      /* already gone */
    }
  }, w.ROUTE_TTL_S * 1000);
  cleanup.unref?.();
  rt.log.info(`Opening a new chat as ${a.id}`);
  await vscode.commands.executeCommand(OPEN_SESSION_COMMAND);
}

// Asks to turn the mode on. Resolves to true when it is on.
async function ensureEnabled() {
  if (!supported()) {
    vscode.window.showInformationMessage(t('Per-chat accounts are not available on Windows.'));
    return false;
  }
  if (active()) return true;
  const on = t('Turn on');
  const pick = await vscode.window.showInformationMessage(
    t('Turn on per-chat accounts (experimental)?'),
    {
      modal: true,
      detail: t(
        'Each Claude Code chat can then use its own account, without reloading the window. The extension sets claudeCode.claudeProcessWrapper to a small launcher that chooses the account for each chat and then runs claude unchanged. Turning this off restores the previous value.'
      ),
    },
    on
  );
  if (pick !== on) return false;
  await vscode.workspace.getConfiguration('claudeAccounts').update('perChatAccounts', true, vscode.ConfigurationTarget.Global);
  const err = await sync();
  if (err) vscode.window.showWarningMessage(err);
  return active();
}

module.exports = { WINDOW_VAR, supported, enabled, active, eligible, init, sync, openAs, ensureEnabled, writeAccountsList, scriptPath };
