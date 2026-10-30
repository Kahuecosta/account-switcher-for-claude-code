'use strict';
// Repositories of this window and the default account they resolve to.
const vscode = require('vscode');
const os = require('os');
const path = require('path');
const { rt, K, t, cfg, notifyChanged } = require('./runtime');
const { repoInfo } = require('../lib/git');
const { normalizeRemote, matchRule } = require('../lib/rules');
const { caseInsensitive } = require('../lib/paths');
const accounts = require('./accounts');

/**
 * @typedef {{ folder: string, root: string | null, remote: string | null, key: string, label: string }} Repo
 * @typedef {{ account: import('./accounts').Account, source: 'repo' | 'rule', pattern?: string, repo: Repo, conflicts: string[] }} ResolvedDefault
 */

/** @type {Repo[]} */
let repos = [];

/** @param {string} folder @returns {Repo} */
function describeFolder(folder) {
  const info = repoInfo(folder);
  if (info.remote)
    return { folder, root: info.root, remote: info.remote, key: 'remote:' + normalizeRemote(info.remote), label: info.remote };
  const p = path.resolve(info.root || folder);
  return { folder, root: info.root, remote: null, key: 'path:' + (process.platform === 'win32' ? p.toLowerCase() : p), label: p };
}

// Reads .git directly (no git process), so it is synchronous and safe in untrusted folders.
function detectRepos() {
  repos = (vscode.workspace.workspaceFolders || [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => {
      try {
        return describeFolder(f.uri.fsPath);
      } catch (e) {
        rt.log?.warn(`Could not read the repository of ${f.uri.fsPath}: ${e}`);
        return null;
      }
    })
    .filter(Boolean);
  return repos;
}

const getRepos = () => repos;
const primaryRepo = () => repos[0] || null;

/** @returns {Record<string, string | { id: string, email?: string }>} */
const getRepoDefaults = () => rt.ctx.globalState.get(K.REPO_DEFAULTS, {});
/** @param {Record<string, any>} m */
const saveRepoDefaults = async (m) => {
  await rt.ctx.globalState.update(K.REPO_DEFAULTS, m);
  notifyChanged();
};

// Finds the stored default for a key. Folder keys compare case-insensitively where the file system does.
/** @param {string} key */
function storedDefault(key) {
  const map = getRepoDefaults();
  let v = map[key];
  if (v === undefined && key.startsWith('path:') && caseInsensitive()) {
    const k = Object.keys(map).find((x) => x.toLowerCase() === key.toLowerCase());
    if (k) v = map[k];
  }
  if (!v) return null;
  return typeof v === 'string' ? { id: v } : v;
}

// Synced defaults carry the account e-mail: on another machine the same id may be another login.
/** @param {{ id: string, email?: string }} v */
function accountForStored(v) {
  const byId = accounts.findAccount(v.id);
  if (!v.email) return byId || null;
  const email = v.email.toLowerCase();
  const emailOf = (/** @type {import('./accounts').Account} */ a) => (accounts.getIdentity(a.id)?.email || '').toLowerCase();
  if (byId && (!emailOf(byId) || emailOf(byId) === email)) return byId;
  return accounts.allAccounts().find((a) => emailOf(a) === email) || null;
}

/** @param {import('./accounts').Account} account */
function storedValueFor(account) {
  const email = accounts.getIdentity(account.id)?.email;
  return email ? { id: account.id, email } : { id: account.id };
}

/** @param {Repo} repo @returns {Omit<ResolvedDefault, 'conflicts'> | null} */
function resolveFor(repo) {
  const stored = storedDefault(repo.key);
  const repoAcc = stored && accountForStored(stored);
  if (repoAcc) return { account: repoAcc, source: 'repo', repo };
  const rule = matchRule(cfg('rules'), { folder: repo.folder, remote: repo.remote, home: os.homedir(), platform: process.platform });
  const ruleAcc = rule && accounts.findAccountByRef(rule.account);
  return ruleAcc ? { account: ruleAcc, source: 'rule', pattern: rule.pattern, repo } : null;
}

// An explicit repository default wins over rules; in a multi-root window the first folder that
// resolves wins, and other folders that resolve to another account are reported as conflicts.
/** @returns {ResolvedDefault | null} */
function resolveDefault() {
  const all = repos.map(resolveFor).filter(Boolean);
  const winner = all.find((d) => d.source === 'repo') || all[0];
  if (!winner) return null;
  const conflicts = all.filter((d) => d.account.id !== winner.account.id).map((d) => path.basename(d.repo.folder));
  return { ...winner, conflicts };
}

// Picks the repository a command applies to: the only one, or the one the user chooses.
/** @param {string} placeHolder */
async function pickRepo(placeHolder) {
  if (repos.length <= 1) return repos[0] || null;
  const p = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: path.basename(r.folder), description: r.label, repo: r })),
    { placeHolder }
  );
  return p ? p.repo : null;
}

/** @param {ResolvedDefault} d */
const reasonOf = (d) => (d.source === 'rule' ? t('rule {0}', d.pattern) : t('repository default'));

module.exports = {
  detectRepos,
  getRepos,
  primaryRepo,
  getRepoDefaults,
  saveRepoDefaults,
  storedDefault,
  accountForStored,
  storedValueFor,
  resolveDefault,
  pickRepo,
  reasonOf,
  describeFolder,
};
