'use strict';
// "Diagnose": a Markdown report of everything that decides which account Claude Code uses.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { rt, t, cfg, OFFICIAL_EXTENSION_ID, baseDir, bridgeDir } = require('./runtime');
const accounts = require('./accounts');
const repo = require('./repo');
const env = require('./environment');
const profile = require('./profile');
const quota = require('./quota');
const health = require('./health');
const { maskEmail } = require('../lib/names');
const { isBridgeCommand } = require('../lib/statusline');
const { samePath } = require('../lib/paths');

/** @typedef {import('./accounts').Account} Account */

// The claude binary bundled with the official extension, or "claude" from PATH.
function claudeBinary() {
  const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
  if (ext) {
    const p = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

// `claude auth status` (JSON; exit code 1 when logged out) with the account's environment.
/** @param {Account} a @returns {Promise<any>} */
function authStatus(a) {
  return new Promise((resolve) => {
    execFile(
      claudeBinary(),
      ['auth', 'status'],
      { env: env.terminalEnvFor(a), timeout: 20e3, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || '').trim();
        try {
          resolve(JSON.parse(text.slice(text.indexOf('{'))));
        } catch {
          resolve({ error: err ? (err.code === 'ENOENT' ? 'claude not found' : String(err.message).split('\n')[0]) : 'unexpected output' });
        }
      }
    );
  });
}

/** @param {unknown} v */
const cell = (v) =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

// The report is in English on purpose: it is meant to be pasted into a GitHub issue.
async function buildReport({ runAuthStatus = true } = {}) {
  const lines = [];
  const add = (/** @type {string} */ s = '') => lines.push(s);
  const official = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
  const cur = accounts.selectedAccount();

  add('# Multi-Account Switcher for Claude Code — diagnostics');
  add();
  add(`- Generated: ${new Date().toISOString()}`);
  add(`- Extension: ${rt.ctx.extension.packageJSON.version}`);
  add(`- ${vscode.env.appName} ${vscode.version} · ${process.platform} ${process.arch} · Node ${process.version}`);
  add(`- Remote: ${vscode.env.remoteName || 'local'} · Workspace trusted: ${vscode.workspace.isTrusted}`);
  add(
    `- Claude Code (${OFFICIAL_EXTENSION_ID}): ${official ? `${official.packageJSON?.version} (${official.isActive ? 'active' : 'not active'})` : 'not installed'}`
  );
  add();
  add(`## This window`);
  add();
  add(`- Selected account: ${cur.name} (\`${cur.id}\`)`);
  add(
    `- Applied to the extension host: \`${env.state.envAccountId}\` · CLAUDE_CONFIG_DIR=\`${process.env.CLAUDE_CONFIG_DIR ?? '(not set)'}\``
  );
  add(`- Applied when the window started: \`${env.state.startedWithId}\`${env.reloadPending(cur.id) ? ` — reload pending` : ''}`);
  add(`- Launch value of CLAUDE_CONFIG_DIR: \`${rt.ORIGINAL_ENV ?? '(not set)'}\` · base profile: \`${baseDir()}\``);
  add(`- Scope: ${cfg('scope')} · terminals: ${cfg('applyToTerminal') ? 'on' : 'off'} · reload: ${cfg('reloadBehavior')}`);
  const override = health.overridingSetting();
  add(`- claudeCode.environmentVariables CLAUDE_CONFIG_DIR: ${override ? `\`${override}\` ⚠️` : '(not set)'}`);
  const d = repo.resolveDefault();
  for (const r of repo.getRepos()) add(`- Folder \`${r.folder}\` → \`${r.key}\``);
  add(
    `- Resolved default: ${d ? `${d.account.name} (${d.source}${d.pattern ? ` ${d.pattern}` : ''})${d.conflicts.length ? ` · conflicts: ${d.conflicts.join(', ')}` : ''}` : 'none'}`
  );
  add();

  add(`## Accounts`);
  add();
  add(`| ${['Account', 'Kind', 'Mode', 'Folder', 'Login', 'claude auth status', 'Links', 'Limit', 'Quota'].join(' | ')} |`);
  add(`|${' --- |'.repeat(9)}`);
  for (const a of accounts.allAccounts()) {
    const dir = accounts.configDirOf(a);
    const id = accounts.getIdentity(a.id);
    const signed = accounts.isSignedIn(a);
    const login =
      signed === false ? 'not logged in' : [maskEmail(id?.email), id?.plan].filter(Boolean).join(' · ') || (signed ? 'yes' : '?');
    let auth = '—';
    if (runAuthStatus) {
      const s = await authStatus(a);
      if (s.error) auth = `⚠️ ${s.error}`;
      else {
        const dirOk = !s.configDirectory || samePath(s.configDirectory, dir);
        auth = `${s.loggedIn === false ? 'logged out' : s.authMethod || 'logged in'}${dirOk ? '' : ` ⚠️ uses ${s.configDirectory}`}`;
      }
    }
    const broken = await profile.brokenShares(a).catch(() => []);
    const lim = accounts.activeLimit(a.id);
    const q = quota.quotaOf(a.id);
    add(
      `| ${[
        `${a.name}${a.id === cur.id ? ' ✔' : ''} (\`${a.id}\`)`,
        a.kind,
        a.mode,
        `\`${dir}\`${fs.existsSync(dir) ? '' : ` ⚠️ missing`}`,
        login,
        auth,
        broken.length ? `⚠️ ${broken.join(', ')}` : '✔',
        lim ? new Date(lim.until).toISOString() + (lim.estimated ? ` (estimated)` : '') : '—',
        q
          ? [q.fiveHour && `5h ${Math.round(q.fiveHour.usedPct)}%`, q.sevenDay && `7d ${Math.round(q.sevenDay.usedPct)}%`]
              .filter(Boolean)
              .join(' · ')
          : '—',
      ]
        .map(cell)
        .join(' | ')} |`
    );
  }
  add();

  add(`## Sharing`);
  add();
  add(`- Shared items mode: ${cfg('sharedItemsMode')} · items: ${(await profile.configItems()).join(', ') || '—'}`);
  add(`- History sharing: ${cfg('shareHistory') ? 'on' : 'off'} · items: ${profile.configuredHistoryItems().join(', ')}`);
  add(`- MCP servers mirrored into shared accounts: ${cfg('shareMcpServers') ? 'on' : 'off'}`);
  add(`- Live quota: ${quota.enabled() ? 'on' : 'off'}`);
  for (const file of quota.settingsTargets()) {
    let state = 'no status line';
    try {
      const sl = JSON.parse(fs.readFileSync(file, 'utf8')).statusLine;
      if (sl) state = isBridgeCommand(sl.command) ? 'bridge installed' : 'own status line';
    } catch {
      state = fs.existsSync(file) ? 'unreadable' : 'no settings.json';
    }
    add(`  - \`${file}\`: ${state}`);
  }
  add(`- Bridge folder: \`${bridgeDir()}\``);
  add();

  const issues = health.current();
  add(`## Setup issues`);
  add();
  if (!issues.length) add('None.');
  for (const i of issues) add(`- ⚠️ ${i.message}`);
  add();
  add(`> E-mails are masked. Review the report before sharing it: it contains folder paths.`);
  return lines.join('\n');
}

async function cmdDiagnose() {
  await health.refresh();
  const text = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Checking accounts (runs "claude auth status" for each)...') },
    () => buildReport()
  );
  rt.log.info('Diagnostics report created');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
  await vscode.window.showTextDocument(doc, { preview: false });
  if (health.current().length) {
    const review = t('Review issues');
    const pick = await vscode.window.showWarningMessage(t('{0} setup issue(s) found.', health.current().length), review);
    if (pick === review) await health.review();
  }
}

module.exports = { cmdDiagnose, buildReport, authStatus, claudeBinary };
