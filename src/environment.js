'use strict';
// Applies an account to this window: the extension host environment (read by the Claude Code
// extension when it starts its CLI) and the environment of integrated terminals.
const vscode = require('vscode');
const { rt, t, cfg, notifyChanged } = require('./runtime');
const { envOf, BLOCKED_ENV } = require('./accounts');

/** @typedef {import('./accounts').Account} Account */

const touchedEnv = new Map(); // variable -> value before this extension changed it
const state = {
  /** Account whose environment the extension host has now. */
  envAccountId: /** @type {string | null} */ (null),
  /** Account applied when this window activated: what an already running Claude Code panel uses. */
  startedWithId: /** @type {string | null} */ (null),
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

/** @param {Account} account */
function applyEnv(account) {
  const env = desiredEnv(account);
  for (const name of touchedEnv.keys()) if (!(name in env)) setProcessEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) setProcessEnv(name, value);

  const coll = rt.ctx.environmentVariableCollection;
  coll.persistent = false;
  coll.clear();
  if (cfg('applyToTerminal')) {
    for (const [name, value] of Object.entries(env)) coll.replace(name, value);
    // An account without its own folder still needs the launch value back in terminals.
    if (!account.dir && rt.ORIGINAL_ENV) coll.replace('CLAUDE_CONFIG_DIR', rt.ORIGINAL_ENV);
    coll.description = t('Claude Code account: {0}', account.name);
  }
  if (state.startedWithId === null) state.startedWithId = account.id;
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
    env: terminalEnvFor(account),
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
/** @param {string} selectedId */
const reloadPending = (selectedId) => state.startedWithId !== null && state.startedWithId !== selectedId;

module.exports = { state, desiredEnv, applyEnv, terminalEnvFor, createAccountTerminal, reloadPending, touchedEnv };
