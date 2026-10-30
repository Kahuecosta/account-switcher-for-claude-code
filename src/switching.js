'use strict';
// Selecting an account, reloading, and applying repository defaults.
const vscode = require('vscode');
const { rt, K, t, cfg, store, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const env = require('./environment');
const repo = require('./repo');

/** @typedef {import('./accounts').Account} Account */

// Fires with the new account after a switch (for the public API and the watchers).
const switched = new vscode.EventEmitter();

// Work that must happen before the environment is applied (e.g. mirroring MCP servers). Set by
// the profile module to avoid a circular import.
/** @type {(a: Account) => Promise<void>} */
let beforeApply = async () => undefined;
/** @param {(a: Account) => Promise<void>} fn */
const setBeforeApply = (fn) => {
  beforeApply = fn;
};

/** @param {string} msg */
async function maybeReload(msg) {
  const b = cfg('reloadBehavior');
  if (b === 'always') return vscode.commands.executeCommand('workbench.action.reloadWindow');
  if (b === 'never') {
    vscode.window.showInformationMessage(t('{0} Reload the window for Claude Code to use the new account.', msg));
    return;
  }
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(t('{0} Reload the window now?', msg), reloadBtn, t('Later'));
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/**
 * @param {Account} account
 * @param {string} [reason]
 * @param {{ reload?: boolean, silent?: boolean }} [opts] reload=false: the switch happened on its own
 *   (repository default), so only suggest a reload in case the panel was already open.
 */
async function selectAccount(account, reason, { reload = true, silent = false } = {}) {
  const prev = accounts.selectedAccount();
  if (prev.id !== account.id) await store().update(K.PREVIOUS, prev.id);
  await store().update(K.SELECTED, account.id);
  if (accounts.secretsPending(account.id)) await accounts.loadSecrets(account.id);
  try {
    await beforeApply(account);
  } catch (e) {
    rt.log.warn(`Preparing ${account.id}: ${e}`);
  }
  env.applyEnv(account);
  rt.log.info(`Selected ${account.id}${reason ? ` (${reason})` : ''}`);
  switched.fire(account);
  notifyChanged();
  if (silent) return;
  const msg = reason ? t('Claude Code account: {0} ({1}).', account.name, reason) : t('Claude Code account: {0}.', account.name);
  if (!env.reloadPending(account.id)) {
    vscode.window.showInformationMessage(msg);
    return;
  }
  if (reload) return maybeReload(msg);
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(
    t('{0} If the Claude Code panel was already open, reload the window.', msg),
    reloadBtn
  );
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

// The account to apply when the window starts: the repository default when it changed since it was
// last applied here, otherwise the remembered selection. Synchronous on purpose, so the environment is
// in place before the Claude Code extension starts its CLI.
function startupAccount() {
  const d = cfg('autoApplyRepoDefault') ? repo.resolveDefault() : null;
  if (d && rt.ctx.workspaceState.get(K.LAST_APPLIED) !== d.account.id) return { account: d.account, autoApplied: d };
  return { account: accounts.selectedAccount(), autoApplied: null };
}

// Applies the repository default when it changed (folders added, rule or default edited).
async function autoApply() {
  if (!cfg('autoApplyRepoDefault')) return;
  const d = repo.resolveDefault();
  if (!d) return;
  // Only when the resolved default changes: manual switches in this window are respected.
  if (rt.ctx.workspaceState.get(K.LAST_APPLIED) === d.account.id) return;
  await rt.ctx.workspaceState.update(K.LAST_APPLIED, d.account.id);
  if (accounts.selectedAccount().id === d.account.id) return;
  await selectAccount(d.account, repo.reasonOf(d), { reload: false });
}

// Picks up a selection made in another window (scope "user") when this window gets focus.
function syncFromStore() {
  const sel = accounts.selectedAccount();
  if (env.state.envAccountId !== sel.id) {
    rt.log.info(`Selection changed elsewhere: ${sel.id}`);
    env.applyEnv(sel);
    switched.fire(sel);
  }
}

module.exports = { switched, setBeforeApply, maybeReload, selectAccount, startupAccount, autoApply, syncFromStore };
