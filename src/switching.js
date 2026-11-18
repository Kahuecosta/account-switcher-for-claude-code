'use strict';
// Selecting an account, reloading, and applying repository defaults.
const vscode = require('vscode');
const { rt, K, t, cfg, store, notifyChanged, OFFICIAL_EXTENSION_ID } = require('./runtime');
const accounts = require('./accounts');
const env = require('./environment');
const repo = require('./repo');
const rating = require('./rating');
const live = require('./live');

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
 * Brings this window's Claude Code panel to `account` (its account display and its new chats).
 * 'none': nothing to do (it already uses the account, or Claude Code has not started yet and will start
 * with it). 'live': done without a reload; conversations already open keep their account. 'reload': the
 * window must reload.
 * @param {Account} account @returns {Promise<'none' | 'live' | 'reload'>}
 */
async function followInPanel(account) {
  env.verifyStart(); // a restored panel's account, if still unverified (see environment.verifyStart)
  if (!env.reloadPending(account.id)) return 'none';
  if (!vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID)?.isActive) {
    env.panelFollows(account.id);
    notifyChanged();
    return 'none';
  }
  // Runs inside serially(): no other switch changes the environment until Claude Code has been told, so
  // it reads the account applied here.
  if (!(await live.notify())) return 'reload';
  env.panelFollows(account.id);
  notifyChanged();
  rt.log.info(`Claude Code panel now uses ${account.id} (no reload)`);
  return 'live';
}

// The part of a switch that changes state runs one switch at a time, so the remembered selection, the
// environment and the Claude Code panel always end on the account chosen last. Messages stay outside:
// a question waiting for an answer never holds up the next switch.
let applying = Promise.resolve(/** @type {'none' | 'live' | 'reload'} */ ('none'));
/** @param {() => Promise<'none' | 'live' | 'reload'>} run */
function serially(run) {
  const next = applying.then(run, run);
  applying = next.catch(() => /** @type {'reload'} */ ('reload'));
  return next;
}
/** @param {Account} account @param {string} [reason] */
const applySerially = (account, reason) => serially(() => applyNow(account, reason));
// followInPanel, in turn with switches (used at startup).
/** @param {Account} account */
const followSerially = (account) => serially(() => followInPanel(account));

/** @param {Account} account @param {string} [reason] */
async function applyNow(account, reason) {
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
  rating.noteSwitch().catch(() => null);
  switched.fire(account);
  notifyChanged();
  return followInPanel(account);
}

/**
 * @param {Account} account
 * @param {string} [reason]
 * @param {{ reload?: boolean, silent?: boolean }} [opts] reload=false: the switch happened on its own
 *   (repository default), so only suggest a reload in case the panel was already open. silent: no
 *   message (the caller shows its own).
 * @returns {Promise<'none' | 'live' | 'reload'>} how the Claude Code panel follows (see followInPanel)
 */
async function selectAccount(account, reason, { reload = true, silent = false } = {}) {
  const how = await applySerially(account, reason);
  if (silent) return how;
  const msg = reason ? t('Claude Code account: {0} ({1}).', account.name, reason) : t('Claude Code account: {0}.', account.name);
  if (how === 'none') {
    vscode.window.showInformationMessage(msg);
    return how;
  }
  if (how === 'live') {
    // Not awaited: the switch is done; the button is only for moving conversations already open.
    const reloadBtn = t('Reload window');
    vscode.window
      .showInformationMessage(
        t('{0} New chats use it now; conversations already open keep their account until you close them.', msg),
        reloadBtn
      )
      .then((pick) => pick === reloadBtn && vscode.commands.executeCommand('workbench.action.reloadWindow'));
    return how;
  }
  if (reload) {
    await maybeReload(msg);
    return how;
  }
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(
    t('{0} If the Claude Code panel was already open, reload the window.', msg),
    reloadBtn
  );
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  return how;
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
  return serially(async () => {
    const sel = accounts.selectedAccount();
    if (env.state.envAccountId === sel.id) return 'none';
    rt.log.info(`Selection changed elsewhere: ${sel.id}`);
    env.applyEnv(sel);
    switched.fire(sel);
    return followInPanel(sel);
  }).catch((e) => {
    rt.log.warn(`Following the selection: ${e}`);
    return /** @type {'reload'} */ ('reload');
  });
}

module.exports = {
  switched,
  setBeforeApply,
  maybeReload,
  followInPanel,
  followSerially,
  selectAccount,
  startupAccount,
  autoApply,
  syncFromStore,
};
