'use strict';
const vscode = require('vscode');
const { rt, K, t, cfg, DEFAULT_ID, EXTENSION_NAME, OFFICIAL_EXTENSION_ID, changed, store, reportError } = require('./runtime');
const accounts = require('./accounts');
const env = require('./environment');
const repo = require('./repo');
const switching = require('./switching');
const profile = require('./profile');
const identity = require('./identity');
const quota = require('./quota');
const usage = require('./usage');
const limits = require('./limits');
const health = require('./health');
const commands = require('./commands');
const diagnostics = require('./diagnostics');
const transfer = require('./transfer');
const { migrate } = require('./migrations');
const { createApi } = require('./api');
const statusBar = require('./ui/statusBar');
const { AccountsTree } = require('./ui/tree');
const { pickAccount } = require('./ui/pickers');

/** @param {string} id @param {(...args: any[]) => any} fn */
function reg(id, fn) {
  return vscode.commands.registerCommand(id, async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      reportError(id, e);
      return undefined;
    }
  });
}

// Background work: logged, never thrown.
/** @param {string} what @param {() => any} fn */
function background(what, fn) {
  Promise.resolve()
    .then(fn)
    .catch((e) => rt.log.warn(`${what}: ${e instanceof Error && e.stack ? e.stack : e}`));
}

let startup = Promise.resolve();
let prompts = Promise.resolve();

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  rt.ctx = context;
  rt.log = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
  // Was the Claude Code extension already running (e.g. its panel was restored)? Then it started with
  // the launch environment and needs a reload to pick up the account applied below.
  const officialWasActive = !!vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID)?.isActive;

  // First, synchronously: the environment, before the Claude Code extension starts its CLI.
  repo.detectRepos();
  const { account: first, autoApplied } = switching.startupAccount();
  env.applyEnv(first);
  if (officialWasActive && first.id !== DEFAULT_ID) env.state.startedWithId = DEFAULT_ID;
  rt.log.info(
    `Activated: ${first.id}${autoApplied ? ` (${repo.reasonOf(autoApplied)})` : ''}; Claude Code active before: ${officialWasActive}`
  );

  context.globalState.setKeysForSync([K.META, K.REPO_DEFAULTS]);
  const item = statusBar.create();
  const tree = new AccountsTree();
  const treeView = vscode.window.createTreeView('claudeAccounts.accounts', { treeDataProvider: tree });

  // Coalesces bursts of changes into one refresh of the status bar.
  /** @type {NodeJS.Timeout | undefined} */
  let refreshTimer;
  const scheduleUpdate = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      statusBar.update();
    }, 50);
  };

  let lastFocusRefresh = 0;
  const minuteTimer = setInterval(() => {
    // Relative times ("resets in 20 min") and expiring limits.
    if (Object.keys(accounts.getLimits()).length || quota.enabled()) scheduleUpdate();
  }, 60e3);

  limits.init({ select: switching.selectAccount, choose: () => commands.cmdSwitch() });
  switching.setBeforeApply(async (a) => {
    await profile.mirrorMcp(a);
  });

  context.subscriptions.push(
    rt.log,
    item,
    tree,
    treeView,
    switching.switched,
    { dispose: () => clearInterval(minuteTimer) },
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },
    { dispose: () => limits.dispose() },
    { dispose: () => quota.dispose() },
    { dispose: () => usage.dispose() },
    changed.event(scheduleUpdate),
    reg('claudeAccounts.switch', commands.cmdSwitch),
    reg('claudeAccounts.switchToPrevious', commands.cmdSwitchToPrevious),
    reg('claudeAccounts.add', commands.cmdAdd),
    reg('claudeAccounts.manage', commands.cmdManage),
    reg('claudeAccounts.login', commands.cmdLogin),
    reg('claudeAccounts.openTerminal', commands.cmdOpenTerminal),
    reg('claudeAccounts.rename', commands.cmdRename),
    reg('claudeAccounts.appearance', commands.cmdAppearance),
    reg('claudeAccounts.editEnvironment', commands.cmdEditEnv),
    reg('claudeAccounts.remove', commands.cmdRemove),
    reg('claudeAccounts.makeIsolated', commands.cmdToIsolated),
    reg('claudeAccounts.makeShared', commands.cmdToShared),
    reg('claudeAccounts.relink', commands.cmdRelink),
    reg('claudeAccounts.openFolder', commands.cmdOpenFolder),
    reg('claudeAccounts.setRepoDefault', commands.cmdSetRepoDefault),
    reg('claudeAccounts.clearRepoDefault', commands.cmdClearRepoDefault),
    reg('claudeAccounts.addRule', commands.cmdAddRule),
    reg('claudeAccounts.showUsage', commands.cmdShowUsage),
    reg('claudeAccounts.toggleHistorySharing', commands.cmdToggleHistory),
    reg('claudeAccounts.importExisting', () => commands.cmdImport()),
    reg('claudeAccounts.toggleLiveQuota', commands.cmdToggleLiveQuota),
    reg('claudeAccounts.diagnose', diagnostics.cmdDiagnose),
    reg('claudeAccounts.reviewIssues', () => health.review()),
    reg('claudeAccounts.exportSettings', transfer.cmdExport),
    reg('claudeAccounts.importSettings', transfer.cmdImportSettings),
    reg('claudeAccounts.showLog', () => rt.log.show()),
    reg('claudeAccounts.refresh', async () => {
      await Promise.all([identity.refreshAllIdentities(), quota.refreshAllQuota(), health.refresh(), usage.refreshCurrentUsage()]);
    }),
    reg('claudeAccounts.continueInTerminal', async (arg) => {
      const a = arg ? commands.accountArg(arg) : await pickAccount(t('Continue the latest conversation as which account?'));
      if (a) limits.continueInTerminal(a);
    }),
    switching.switched.event(() => {
      limits.restartWatcher();
      quota.watchSelected(limits.checkQuota);
      background('usage', usage.refreshCurrentUsage);
      background('health', health.refresh);
    }),
    vscode.window.registerUriHandler({ handleUri: (uri) => handleUri(uri).catch((e) => reportError('uri', e)) }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeAccounts') && !e.affectsConfiguration('claudeCode.environmentVariables')) return;
      if (e.affectsConfiguration('claudeAccounts.applyToTerminal')) env.applyEnv(accounts.selectedAccount());
      if (e.affectsConfiguration('claudeAccounts.scope')) switching.syncFromStore();
      if (e.affectsConfiguration('claudeAccounts.gravatar')) background('identity', identity.refreshAllIdentities);
      if (e.affectsConfiguration('claudeAccounts.liveQuota')) {
        background('live quota', commands.onLiveQuotaChanged);
        quota.watchSelected(limits.checkQuota);
      }
      if (e.affectsConfiguration('claudeAccounts.onUsageLimit')) limits.restartWatcher();
      if (e.affectsConfiguration('claudeAccounts.rules') || e.affectsConfiguration('claudeAccounts.autoApplyRepoDefault')) {
        background('auto-apply', switching.autoApply);
      }
      background('health', health.refresh);
      scheduleUpdate();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      repo.detectRepos();
      limits.restartWatcher();
      background('auto-apply', switching.autoApply);
      scheduleUpdate();
    }),
    vscode.window.onDidCloseTerminal((term) => commands.onTerminalClosed(term)),
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;
      if (cfg('scope') === 'user') switching.syncFromStore();
      background('limits', limits.checkExpired);
      if (Date.now() - lastFocusRefresh > 60e3) {
        lastFocusRefresh = Date.now();
        background('identity', identity.refreshAllIdentities);
        background('quota', quota.refreshAllQuota);
        background('health', health.refresh);
      }
    })
  );

  statusBar.update();
  startup = afterActivation(first, autoApplied);
  prompts = startup.then(() => startupPrompts(first, autoApplied, officialWasActive));
  const api = createApi();
  // Integration tests (CLAUDE_ACCOUNTS_TEST, see .vscode-test.mjs) get the extension's own module
  // instances: requiring them by path can load second copies (e.g. drive-letter case on Windows).
  if (process.env.CLAUDE_ACCOUNTS_TEST === '1') return { ...api, __test: { mod: (/** @type {string} */ name) => require(`./${name}`) } };
  return api;
}

// Everything that may wait, except prompts: secrets, migration, identity, watchers.
/**
 * @param {import('./accounts').Account} first
 * @param {import('./repo').ResolvedDefault | null} autoApplied
 */
async function afterActivation(first, autoApplied) {
  try {
    if (accounts.secretsPending(first.id)) {
      await accounts.loadSecrets(first.id);
      env.applyEnv(first);
    }
    if (autoApplied) {
      const prev = store().get(K.SELECTED);
      if (prev && prev !== first.id) await store().update(K.PREVIOUS, prev);
      await store().update(K.SELECTED, first.id);
      await rt.ctx.workspaceState.update(K.LAST_APPLIED, first.id);
    }
    await migrate().catch((e) => rt.log.error(`Migration: ${e}`));
    await profile.mirrorMcp(first).catch((e) => rt.log.warn(`MCP mirror: ${e}`));
    limits.restartWatcher();
    limits.arm();
    if (quota.enabled()) {
      quota.watchSelected(limits.checkQuota);
      await quota.syncBridge();
    }
    await Promise.all([identity.refreshAllIdentities(), quota.refreshAllQuota()]);
    await health.refresh();
    const usageTimer = setTimeout(() => background('usage', usage.refreshCurrentUsage), 3000);
    rt.ctx.subscriptions.push({ dispose: () => clearTimeout(usageTimer) });
  } catch (e) {
    reportError('startup', e);
  }
}

// Prompts wait for the user, so they run after the setup work and nothing waits for them.
/**
 * @param {import('./accounts').Account} first
 * @param {import('./repo').ResolvedDefault | null} autoApplied
 * @param {boolean} officialWasActive
 */
async function startupPrompts(first, autoApplied, officialWasActive) {
  if (autoApplied) {
    const msg = t('Claude Code account: {0} ({1}).', first.name, repo.reasonOf(autoApplied));
    if (officialWasActive) background('notice', () => switching.maybeReload(msg));
    else vscode.window.showInformationMessage(msg);
  }
  try {
    if (!accounts.getRecords().length && !rt.ctx.globalState.get(K.IMPORT_PROMPTED)) {
      await rt.ctx.globalState.update(K.IMPORT_PROMPTED, true);
      await commands.cmdImport({ prompt: true });
    }
    await health.notify();
  } catch (e) {
    reportError('startup', e);
  }
}

// vscode://kahuecosta.claude-code-multi-account/<action>?account=<id|name|e-mail>
/** @param {vscode.Uri} uri */
async function handleUri(uri) {
  const action = uri.path.replace(/^\/+/, '');
  const ref = new URLSearchParams(uri.query).get('account');
  rt.log.info(`URI: ${action}${ref ? ` (${ref})` : ''}`);
  if (action === 'switch' || action === 'openTerminal') {
    const a = ref ? accounts.findAccountByRef(ref) : null;
    if (!a) throw new Error(t('No account matches "{0}".', ref || ''));
    // Links can come from any web page, so they always ask first.
    const go = t('Continue');
    const question =
      action === 'switch'
        ? t('Switch this window to the Claude Code account "{0}"?', a.name)
        : t('Open a terminal as the Claude Code account "{0}"?', a.name);
    const ok = await vscode.window.showWarningMessage(question, { modal: true, detail: t('A link asked for this.') }, go);
    if (ok !== go) return;
    if (action === 'switch') await switching.selectAccount(a);
    else await commands.cmdOpenTerminal(a);
    return;
  }
  if (action === 'diagnose') return diagnostics.cmdDiagnose();
  if (action === 'add') return commands.cmdAdd();
  throw new Error(t('Unknown link: {0}', uri.toString()));
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internals: { startupDone: () => startup, promptsDone: () => prompts, handleUri },
};
