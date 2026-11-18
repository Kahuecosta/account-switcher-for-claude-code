'use strict';
// Applies an account to this window: the extension host environment (read by the Claude Code
// extension when it starts its CLI) and the environment of integrated terminals.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { rt, t, cfg, DEFAULT_ID, notifyChanged } = require('./runtime');
const { envOf, BLOCKED_ENV } = require('./accounts');
const { panelSessions } = require('../lib/sessions');
const { withClaudeOnPath } = require('./cli');

/** @typedef {import('./accounts').Account} Account */

const touchedEnv = new Map(); // variable -> value before this extension changed it
const state = {
  /** Account whose environment the extension host has now. */
  envAccountId: /** @type {string | null} */ (null),
  /**
   * Account the Claude Code panel uses for its account display and its new chats: the one applied when
   * this window activated, or the last one it was told about without a reload (src/live.js).
   */
  panelAccountId: /** @type {string | null} */ (null),
  /**
   * Set when the Claude Code extension was already active at activation: its panel may have started
   * the CLI before or after applyEnv(). Cleared by verifyStart() once the panel's session shows which,
   * or by panelFollows() once the panel has been told about the account.
   */
  uncertain: /** @type {{ id: string, dir: string, launchDir: string } | null} */ (null),
};

/** @param {string} name @param {string | undefined} value */
function setProcessEnv(name, value) {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  if (value === undefined) {
    const orig = touchedEnv.get(name);
    if (orig === undefined) delete process.env[name];
    else process.env[name] = orig;
  } else {
    process.env[name] = value;
  }
}

// Variables an account sets. The Default account sets none, so the launch environment comes back.
/** @param {Account} account @returns {Record<string, string>} */
function desiredEnv(account) {
  const env = {};
  for (const [name, value] of Object.entries(envOf(account.id))) if (!BLOCKED_ENV.test(name)) env[name] = value;
  if (account.dir) env.CLAUDE_CONFIG_DIR = account.dir;
  return env;
}

// Names (never values) of the variables the window's account sets, read by the per-chat launcher
// (lib/wrapper.js) so a chat routed to another account does not inherit them.
const { VARS_VAR, WINDOW_VAR, BASE_VAR } = require('../lib/wrapper');

/** @param {Account} account */
function applyEnv(account) {
  const env = desiredEnv(account);
  for (const name of touchedEnv.keys()) if (!(name in env) && name !== VARS_VAR) setProcessEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) setProcessEnv(name, value);
  const names = Object.keys(env).filter((n) => n !== 'CLAUDE_CONFIG_DIR');
  setProcessEnv(VARS_VAR, names.length ? names.join(',') : undefined);

  const coll = rt.ctx.environmentVariableCollection;
  coll.persistent = false;
  coll.clear();
  if (cfg('applyToTerminal')) {
    for (const [name, value] of Object.entries(env)) coll.replace(name, value);
    // An account without its own folder still needs the launch value back in terminals.
    if (!account.dir && rt.ORIGINAL_ENV) coll.replace('CLAUDE_CONFIG_DIR', rt.ORIGINAL_ENV);
    coll.description = t('Claude Code account: {0}', account.name);
  }
  if (state.panelAccountId === null) state.panelAccountId = account.id;
  if (state.envAccountId !== account.id) rt.log?.info(`Environment applied: ${account.id}`);
  state.envAccountId = account.id;
  notifyChanged();
}

// Mirrors VS Code's sanitizeProcessEnvironment: the extension host has variables a shell must not get.
const HOST_ONLY = [
  /^ELECTRON_.+$/,
  /^VSCODE_(?!(PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)).+$/,
  /^SNAP(|_.*)$/,
  /^GDK_PIXBUF_.+$/,
];

// Complete environment for a terminal that must use `account`, whatever this window uses. It is
// passed with strictEnv, because VS Code applies the window's environment collection (which sets the
// current account) to every terminal that is not strict.
/** @param {Account} account @returns {Record<string, string>} */
function terminalEnvFor(account) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !HOST_ONLY.some((re) => re.test(k))) env[k] = v;
  // The per-chat launcher's view of this window, meaningless anywhere else.
  for (const k of [WINDOW_VAR, VARS_VAR, BASE_VAR]) delete env[k];
  for (const [name, orig] of touchedEnv) {
    if (orig === undefined) delete env[name];
    else env[name] = orig;
  }
  Object.assign(env, desiredEnv(account));
  if (!account.dir) {
    if (rt.ORIGINAL_ENV) env.CLAUDE_CONFIG_DIR = rt.ORIGINAL_ENV;
    else delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

/**
 * Opens a terminal bound to an account and optionally runs a command in it.
 * @param {Account} account
 * @param {{ name: string, command?: string, cwd?: string, transient?: boolean, icon?: string }} opts
 */
function createAccountTerminal(account, { name, command, cwd, transient = false, icon = 'account' }) {
  const term = vscode.window.createTerminal({
    name,
    cwd,
    env: withClaudeOnPath(terminalEnvFor(account)),
    strictEnv: true,
    isTransient: transient,
    iconPath: new vscode.ThemeIcon(icon),
    color: account.color ? new vscode.ThemeColor(`claudeAccounts.${account.color}`) : undefined,
  });
  term.show();
  if (command) term.sendText(command);
  rt.log?.info(`Terminal for ${account.id}: ${name}${command ? ` (${command})` : ''}`);
  return term;
}

// True when the Claude Code panel may still be using another account until the window reloads.
// While the start is uncertain (see markStartUncertain) any selection may need one.
/** @param {string} selectedId */
const reloadPending = (selectedId) => state.panelAccountId !== null && (state.uncertain !== null || state.panelAccountId !== selectedId);

// The Claude Code extension was already active when this window activated (its panel was restored).
// Being active does not mean its CLI had started: until verifyStart() settles it, assume the panel
// kept the launch environment, which is the safe side (a reload is offered rather than skipped).
/** @param {Account} account @param {string} launchDir */
function markStartUncertain(account, launchDir) {
  state.panelAccountId = DEFAULT_ID;
  state.uncertain = account.dir ? { id: account.id, dir: account.dir, launchDir } : null;
}

const workspaceFolders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);

// Settles an uncertain start from the session the panel's CLI registered: in the applied account's
// folder means it started after applyEnv(); in the launch folder means before. Returns true once settled.
function verifyStart(folders = workspaceFolders()) {
  const u = state.uncertain;
  if (!u) return false;
  const since = Date.now() - process.uptime() * 1000; // sessions of this extension host only
  const inAccount = panelSessions(u.dir, { folders, since }).length > 0;
  const inLaunch = panelSessions(u.launchDir, { folders, since }).length > 0;
  if (inAccount === inLaunch) return false; // no session yet, or both: keep the safe assumption
  state.uncertain = null;
  if (inAccount) state.panelAccountId = u.id;
  stopWatching();
  rt.log?.info(`Claude Code panel verified: started with ${state.panelAccountId}`);
  notifyChanged();
  return true;
}

let stopWatching = () => {};

// The Claude Code panel now uses `id` for its account display and new chats (it was told without a
// reload, or had not started yet): nothing is uncertain any more.
/** @param {string} id */
function panelFollows(id) {
  state.panelAccountId = id;
  state.uncertain = null;
  stopWatching();
}

// While the start is uncertain, watches both sessions folders so it is settled as soon as the panel's
// CLI registers (instead of waiting for the next timed check). A missing folder is skipped: the timed
// checks and the check before each switch still cover it.
function watchStart() {
  stopWatching();
  const u = state.uncertain;
  if (!u) return { dispose() {} };
  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  /** @type {NodeJS.Timeout | undefined} */
  let debounce;
  const stop = () => {
    clearTimeout(debounce);
    for (const w of watchers.splice(0)) w.close();
  };
  const onChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        verifyStart();
      } catch (e) {
        rt.log?.warn(`start check: ${e}`);
      }
    }, 300);
    debounce.unref?.();
  };
  for (const dir of new Set([u.dir, u.launchDir])) {
    try {
      const w = fs.watch(path.join(dir, 'sessions'), onChange);
      w.on('error', () => w.close());
      w.unref?.();
      watchers.push(w);
    } catch {
      /* folder missing */
    }
  }
  stopWatching = stop;
  return { dispose: stop };
}

module.exports = {
  state,
  desiredEnv,
  applyEnv,
  terminalEnvFor,
  createAccountTerminal,
  reloadPending,
  markStartUncertain,
  verifyStart,
  watchStart,
  panelFollows,
  touchedEnv,
};
