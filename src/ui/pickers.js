'use strict';
const vscode = require('vscode');
const { t, DEFAULT_ID } = require('../runtime');
const accounts = require('../accounts');
const repo = require('../repo');
const identity = require('../identity');
const f = require('./format');

/** @typedef {import('../accounts').Account} Account */

/** @param {Account} a */
function accountButtons(a) {
  const b = [
    { iconPath: new vscode.ThemeIcon('edit'), tooltip: t('Rename'), action: 'rename' },
    { iconPath: new vscode.ThemeIcon('symbol-color'), tooltip: t('Appearance'), action: 'appearance' },
    a.kind === 'subscription'
      ? { iconPath: new vscode.ThemeIcon('key'), tooltip: t('Log in'), action: 'login' }
      : { iconPath: new vscode.ThemeIcon('symbol-variable'), tooltip: t('Environment variables'), action: 'env' },
    { iconPath: new vscode.ThemeIcon('terminal'), tooltip: t('Open terminal as this account'), action: 'terminal' },
  ];
  if (a.id !== DEFAULT_ID) b.push({ iconPath: new vscode.ThemeIcon('trash'), tooltip: t('Remove'), action: 'remove' });
  return b;
}

/** @param {Account} a @param {{ markCurrent?: boolean, buttons?: boolean }} [opts] */
function accountItem(a, { markCurrent = true, buttons = true } = {}) {
  const cur = accounts.selectedAccount();
  const d = repo.resolveDefault();
  const emoji = f.isEmojiIcon(a) ? a.icon + ' ' : '';
  const desc = [accounts.modeLabel(a.mode)];
  if (d && d.account.id === a.id) desc.push(d.source === 'rule' ? t('default by rule') : t('repository default'));
  const detail = [identity.identityLine(a) || accounts.configDirOf(a), f.quotaLine(a.id), f.limitLine(a.id)].filter(Boolean).join(' · ');
  return {
    label: `${markCurrent && a.id === cur.id ? '$(check) ' : ''}${emoji}${a.name}`,
    description: desc.join(' · '),
    detail,
    iconPath: identity.avatarUri(a) || (emoji ? undefined : new vscode.ThemeIcon(a.icon || 'account', f.themeColor(a.color))),
    buttons: buttons ? accountButtons(a) : undefined,
    account: a,
  };
}

/**
 * Quick pick with per-item buttons. Resolves to { item, button } or undefined.
 * @template {vscode.QuickPickItem} T
 * @param {T[]} items @param {string} placeHolder
 * @returns {Promise<{ item: T, button?: any } | undefined>}
 */
function pick(items, placeHolder) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = placeHolder;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    let done = false;
    const finish = (/** @type {any} */ v) => {
      if (!done) {
        done = true;
        resolve(v);
        qp.hide();
      }
    };
    qp.onDidAccept(() => finish(qp.selectedItems[0] ? { item: qp.selectedItems[0] } : undefined));
    qp.onDidTriggerItemButton((e) => finish({ item: e.item, button: e.button }));
    qp.onDidHide(() => {
      finish(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

// Lets the user choose an account. Resolves to the account or undefined.
/** @param {string} placeHolder @param {{ exclude?: string[] }} [opts] */
async function pickAccount(placeHolder, { exclude = [] } = {}) {
  const items = accounts
    .allAccounts()
    .filter((a) => !exclude.includes(a.id))
    .map((a) => accountItem(a, { markCurrent: false, buttons: false }));
  const r = await pick(items, placeHolder);
  return r ? r.item.account : undefined;
}

module.exports = { accountButtons, accountItem, pick, pickAccount };
