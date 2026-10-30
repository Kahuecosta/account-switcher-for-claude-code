'use strict';
// Export and import of account settings (names, colors, icons, modes, kinds, repository defaults and
// rules) to set up another machine. Logins, environment variables and images are never exported.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rt, t, cfg, DEFAULT_ID, accountsRoot, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const repo = require('./repo');
const profile = require('./profile');

const FORMAT = 'claude-accounts-export';

function buildExport() {
  const meta = accounts.getMeta();
  return {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: accounts.allAccounts().map((a) => ({
      id: a.id,
      name: meta[a.id]?.name,
      color: a.color,
      icon: a.icon,
      mode: a.mode,
      kind: a.kind,
    })),
    // Copies, so the export never aliases live settings or storage.
    repoDefaults: structuredClone(repo.getRepoDefaults()),
    rules: Array.isArray(cfg('rules')) ? structuredClone(cfg('rules')) : [],
  };
}

async function cmdExport() {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-accounts.json')),
    filters: { JSON: ['json'] },
    saveLabel: t('Export'),
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(buildExport(), null, 2) + '\n'));
  rt.log.info(`Exported settings to ${uri.fsPath}`);
  vscode.window.showInformationMessage(
    t('Account settings exported to {0}. Logins and environment variables are not included.', uri.fsPath)
  );
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODES = ['shared', 'isolated'];
const KINDS = ['subscription', 'oauthToken', 'apiKey', 'bedrock', 'vertex'];

// Validates an export file. Throws with a readable message.
/** @param {any} data */
function validate(data) {
  if (!data || data.format !== FORMAT) throw new Error(t('This is not an account settings export.'));
  if (data.version !== 1) throw new Error(t('Unsupported export version: {0}.', data.version));
  if (!Array.isArray(data.accounts)) throw new Error(t('The export has no accounts.'));
  for (const a of data.accounts) {
    if (!a || (a.id !== DEFAULT_ID && (!ID.test(a.id) || !MODES.includes(a.mode) || (a.kind && !KINDS.includes(a.kind))))) {
      throw new Error(t('Invalid account in the export: {0}.', JSON.stringify(a)));
    }
  }
}

/** @param {any} data */
async function applyImport(data) {
  validate(data);
  const created = [];
  const records = accounts.getRecords();
  for (const a of data.accounts) {
    if (a.id !== DEFAULT_ID && !records.some((r) => r.id === a.id)) {
      const dir = path.join(accountsRoot(), a.id);
      await fs.promises.mkdir(dir, { recursive: true });
      records.push({ id: a.id, dir, mode: a.mode, kind: a.kind || 'subscription' });
      created.push(a.id);
    }
  }
  await accounts.saveRecords(records);
  for (const a of data.accounts) {
    await accounts.updateMeta(a.id, {
      name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : undefined,
      color: typeof a.color === 'string' ? a.color : undefined,
      icon: typeof a.icon === 'string' ? a.icon : undefined,
    });
  }
  // Repository defaults and rules: keep what this machine already has, add the rest.
  const defaults = { ...(data.repoDefaults && typeof data.repoDefaults === 'object' ? data.repoDefaults : {}), ...repo.getRepoDefaults() };
  await repo.saveRepoDefaults(defaults);
  const mine = Array.isArray(cfg('rules')) ? cfg('rules') : [];
  const incoming = Array.isArray(data.rules)
    ? data.rules.filter((r) => r && typeof r.pattern === 'string' && typeof r.account === 'string')
    : [];
  const rules = [...mine, ...incoming.filter((r) => !mine.some((m) => m && m.pattern === r.pattern))];
  if (rules.length !== mine.length)
    await vscode.workspace.getConfiguration('claudeAccounts').update('rules', rules, vscode.ConfigurationTarget.Global);
  for (const id of created) {
    const a = accounts.findAccount(id);
    if (a) await profile.setUpNewAccount(a).catch((e) => rt.log.warn(`Setting up ${id}: ${e}`));
  }
  notifyChanged();
  return { created };
}

async function cmdImportSettings() {
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: t('Import') });
  if (!files?.length) return;
  const data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8'));
  const { created } = await applyImport(data);
  rt.log.info(`Imported settings from ${files[0].fsPath}; created ${created.join(', ') || 'nothing'}`);
  vscode.window.showInformationMessage(
    created.length
      ? t('Imported. New accounts: {0}. Log in to each of them.', created.join(', '))
      : t('Imported. No new accounts were needed.')
  );
}

module.exports = { buildExport, validate, applyImport, cmdExport, cmdImportSettings, FORMAT };
