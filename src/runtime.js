'use strict';
// Shared runtime state: extension context, log, settings and storage keys.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { expandHome } = require('../lib/paths');

const t = (/** @type {string} */ message, /** @type {any[]} */ ...args) => vscode.l10n.t(message, ...args);

const EXTENSION_NAME = 'Multi-Account Switcher for Claude Code';
const OFFICIAL_EXTENSION_ID = 'anthropic.claude-code';
const DEFAULT_ID = '__default__';
const SCHEMA_VERSION = 3;

const K = {
  SCHEMA: 'schemaVersion', // global
  ACCOUNTS: 'accounts', // local: [{ id, dir, mode, kind }]
  META: 'accountMeta', // synced: { [id]: { name, color, icon } }
  ENV_V1: 'accountEnv', // 1.x only, migrated to ENV + secrets
  ENV: 'accountEnvironment', // local: { [id]: { NAME: { value } | { secret: true } } }
  AVATARS: 'accountAvatars', // local: { [id]: fileName }
  REPO_DEFAULTS: 'repoDefaults', // synced: { [repoKey]: { id, email } } (1.x: id string)
  IDENTITY: 'accountIdentity', // local: { [id]: { email, plan, organization, loggedIn } } (no secrets)
  LIMITS: 'accountLimits', // local: { [id]: { at, until, kind } }
  MCP_MIRRORED: 'mcpMirrored', // local: { [id]: [serverName] }
  NOTICES: 'dismissedNotices', // local: { [noticeId]: true }
  LAST_APPLIED: 'lastAppliedRepoDefault', // workspace
  SELECTED: 'selectedAccount', // workspace or global, see store()
  PREVIOUS: 'previousAccount', // workspace or global
  IMPORT_PROMPTED: 'importPrompted', // global
};

const COLORS = ['orange', 'green', 'blue', 'purple', 'pink', 'yellow', 'teal', 'red'];
const ICONS = [
  'account',
  'briefcase',
  'home',
  'organization',
  'rocket',
  'beaker',
  'code',
  'terminal',
  'heart',
  'star-full',
  'flame',
  'zap',
  'globe',
  'coffee',
  'mortar-board',
  'shield',
];

/** @type {{ ctx: vscode.ExtensionContext, log: vscode.LogOutputChannel, ORIGINAL_ENV: string | undefined }} */
const rt = {
  ctx: /** @type {any} */ (undefined),
  log: /** @type {any} */ (undefined),
  ORIGINAL_ENV: process.env.CLAUDE_CONFIG_DIR, // value VS Code was launched with
};

// Fires whenever accounts, selection, identity, quota or limits change, so every view refreshes.
const changed = new vscode.EventEmitter();
const notifyChanged = () => changed.fire(undefined);

/** @param {string} key */
const cfg = (key) => vscode.workspace.getConfiguration('claudeAccounts').get(key);
const homeClaudeDir = () => path.join(os.homedir(), '.claude');
// The base profile: the Default account's folder, the source of shared items and shared history.
const baseDir = () => (rt.ORIGINAL_ENV ? path.resolve(expandHome(rt.ORIGINAL_ENV)) : homeClaudeDir());
// Where the Default account keeps .claude.json (next to the home folder unless CLAUDE_CONFIG_DIR was set).
const baseJsonPath = () => (rt.ORIGINAL_ENV ? path.join(baseDir(), '.claude.json') : path.join(os.homedir(), '.claude.json'));
const accountsRoot = () =>
  path.resolve(expandHome(String(cfg('accountsRoot') || '').trim()) || path.join(os.homedir(), '.claude-accounts'));
const lockPath = () => path.join(accountsRoot(), '.lock');
const backupsDir = () => path.join(accountsRoot(), '.backups');
const bridgeDir = () => path.join(accountsRoot(), '.bridge');
const storageDir = (/** @type {string[]} */ ...p) => path.join(rt.ctx.globalStorageUri.fsPath, ...p);

// Where the selection is remembered: per workspace (each window/repo) or globally.
const store = () => (cfg('scope') === 'user' ? rt.ctx.globalState : rt.ctx.workspaceState);

/** @param {any} e */
function errorMessage(e) {
  if (e && e.code === 'ELOCKED') return t('Another window is changing the account folders. Try again in a moment.');
  return e instanceof Error ? e.message : String(e);
}

// Logs and shows an error. Used by every command and background task.
/** @param {string} what @param {unknown} e */
function reportError(what, e) {
  rt.log?.error(`${what}: ${e instanceof Error && e.stack ? e.stack : errorMessage(e)}`);
  const showLog = t('Show log');
  vscode.window.showErrorMessage(`${EXTENSION_NAME}: ${errorMessage(e)}`, showLog).then(
    (b) => b === showLog && rt.log?.show(),
    () => undefined
  );
}

module.exports = {
  t,
  rt,
  K,
  COLORS,
  ICONS,
  DEFAULT_ID,
  SCHEMA_VERSION,
  EXTENSION_NAME,
  OFFICIAL_EXTENSION_ID,
  changed,
  notifyChanged,
  cfg,
  homeClaudeDir,
  baseDir,
  baseJsonPath,
  accountsRoot,
  lockPath,
  backupsDir,
  bridgeDir,
  storageDir,
  store,
  errorMessage,
  reportError,
};
