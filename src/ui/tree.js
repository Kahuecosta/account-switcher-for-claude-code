'use strict';
// "Claude Accounts" view in the Explorer.
const vscode = require('vscode');
const { t, cfg, DEFAULT_ID, changed } = require('../runtime');
const accounts = require('../accounts');
const repo = require('../repo');
const identity = require('../identity');
const env = require('../environment');
const f = require('./format');

/** @typedef {import('../accounts').Account} Account */

/** @implements {vscode.TreeDataProvider<Account>} */
class AccountsTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.sub = changed.event(() => this.emitter.fire(undefined));
  }

  getChildren(/** @type {Account | undefined} */ el) {
    return el ? [] : accounts.allAccounts();
  }

  /** @param {Account} a */
  getTreeItem(a) {
    const cur = accounts.selectedAccount();
    const item = new vscode.TreeItem(a.name, vscode.TreeItemCollapsibleState.None);
    item.id = a.id;
    const parts = [];
    if (a.id === cur.id) parts.push(t('current'));
    const id = accounts.getIdentity(a.id);
    if (a.kind !== 'subscription') parts.push(accounts.kindLabel(a.kind));
    else if (accounts.isSignedIn(a) === false) parts.push(t('not logged in'));
    else if (cfg('showPlan') && id?.plan) parts.push(id.plan);
    const q = f.quotaLine(a.id);
    if (q) parts.push(q);
    if (accounts.activeLimit(a.id)) parts.push(t('usage limit reached'));
    item.description = parts.join(' · ');
    item.iconPath =
      identity.avatarUri(a) ||
      new vscode.ThemeIcon(a.id === cur.id ? 'pass-filled' : f.isEmojiIcon(a) ? 'account' : a.icon || 'account', f.themeColor(a.color));
    const flags = ['account'];
    flags.push(a.id === cur.id ? 'current' : 'other');
    if (a.id === DEFAULT_ID) flags.push('default');
    else flags.push(a.mode);
    if (a.kind === 'subscription') flags.push('login');
    item.contextValue = flags.join('.');

    const tip = new vscode.MarkdownString('', true);
    const line = (/** @type {string} */ s) => tip.appendMarkdown(`${s}  \n`);
    line(`**${f.md(a.name)}**${f.isEmojiIcon(a) ? ` ${f.md(/** @type {string} */ (a.icon))}` : ''}`);
    const idLine = identity.identityLine(a);
    if (idLine) line(f.md(idLine));
    line(f.md(t('Folder: {0}', accounts.configDirOf(a))));
    line(f.md(t('Mode: {0}', accounts.modeLabel(a.mode))));
    if (q) line(f.md(q));
    const lim = f.limitLine(a.id);
    if (lim) line(`$(watch) ${f.md(lim)}`);
    const d = repo.resolveDefault();
    if (d && d.account.id === a.id) line(f.md(d.source === 'rule' ? t('default by rule') : t('repository default')));
    if (a.id === cur.id && env.reloadPending(a.id)) line(`$(sync) ${f.md(t('Reload pending.'))}`);
    item.tooltip = tip;
    return item;
  }

  dispose() {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

module.exports = { AccountsTree };
