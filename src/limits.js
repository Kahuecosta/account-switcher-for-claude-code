'use strict';
// Usage limits: detects them in this window's session logs (and, with live quota, before they are
// hit), offers or performs the switch to the best other account, and says when a limit resets.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { rt, t, cfg, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const quota = require('./quota');
const usage = require('./usage');
const { createAccountTerminal } = require('./environment');
const { encodeProjectDir, limitInfo, TailReader } = require('../lib/usage');
const { peakUsage } = require('../lib/statusline');
const { isInside } = require('../lib/paths');
const { clock } = require('./ui/format');

/** @typedef {import('./accounts').Account} Account */

const PROMPT_COOLDOWN_MS = 20 * 60e3; // at most one prompt per account every 20 minutes
const RECENT_MS = 15 * 60e3; // older log entries are history, not news

/** @type {Map<string, number>} */
const lastPrompt = new Map();
/** @type {vscode.FileSystemWatcher | undefined} */
let watcher;
/** @type {NodeJS.Timeout | undefined} */
let timer;

/** @type {(a: Account, reason: string, opts?: any) => Promise<any>} */
let select = async () => undefined;
/** @type {() => Promise<any>} */
let chooseAccount = async () => undefined;
// Injected by the extension to avoid a circular import.
/** @param {{ select: typeof select, choose: typeof chooseAccount }} fns */
function init(fns) {
  select = fns.select;
  chooseAccount = fns.choose;
}

// Accounts to move to, best first: signed in, not limited, lowest known usage (unknown counts as half).
/** @param {Account} current */
function rankCandidates(current) {
  return accounts
    .allAccounts()
    .filter((a) => a.id !== current.id && accounts.isSignedIn(a) !== false && !accounts.activeLimit(a.id))
    .map((a, i) => ({ a, i, peak: peakUsage(quota.quotaOf(a.id)) }))
    .sort((x, y) => (x.peak ?? 50) - (y.peak ?? 50) || x.i - y.i)
    .map((x) => x.a);
}

/** @param {Account} target */
function continueInTerminal(target) {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return createAccountTerminal(target, {
    name: t('Claude: {0}', target.name),
    command: 'claude --continue',
    cwd: folder,
    icon: 'comment-discussion',
  });
}

/**
 * @param {Account} account
 * @param {{ kind: string, resetAt: number | null }} info
 * @param {{ origin?: 'log' | 'quota', pct?: number, windowName?: string }} [opts]
 */
async function onLimitReached(account, info, { origin = 'log', pct, windowName } = {}) {
  const now = Date.now();
  let until = info.resetAt;
  if (!until) {
    const q = quota.quotaOf(account.id);
    until = (info.kind === 'weekly' ? q?.sevenDay?.resetsAt : (q?.fiveHour?.resetsAt ?? q?.sevenDay?.resetsAt)) || null;
  }
  await accounts.setLimit(account.id, { at: now, until, kind: info.kind });
  rt.log.info(`Limit (${origin}, ${info.kind}) for ${account.id}${until ? ` until ${new Date(until).toISOString()}` : ''}`);
  arm();

  const mode = cfg('onUsageLimit');
  if (mode === 'ignore') return;
  if (accounts.selectedAccount().id !== account.id) return; // this window already moved on
  if (now - (lastPrompt.get(account.id) || 0) < PROMPT_COOLDOWN_MS) return;
  lastPrompt.set(account.id, now);

  const what =
    origin === 'quota'
      ? t('Account "{0}" has used {1}% of its {2} limit.', account.name, pct, windowName)
      : t('Account "{0}" hit its usage limit.', account.name);
  const resets = until ? ' ' + t('It resets {0}.', clock(until)) : '';
  const candidates = rankCandidates(account);
  if (!candidates.length) {
    vscode.window.showWarningMessage(what + resets + ' ' + t('No other account is available.'));
    return;
  }
  const shared = !!cfg('shareHistory');
  const reason = origin === 'quota' ? t('usage limit near') : t('usage limit reached');

  if (mode === 'switch') {
    const target = candidates[0];
    if (shared) {
      const cont = t('Continue in terminal');
      vscode.window.showInformationMessage(what + resets + ' ' + t('Switched to "{0}".', target.name), cont).then((b) => {
        if (b === cont) continueInTerminal(target);
      });
    }
    return select(target, reason);
  }

  const buttons = candidates.slice(0, 2).map((a) => ({ title: t('Switch to {0}', a.name), account: a, cont: false }));
  if (shared) buttons.push({ title: t('Switch to {0} and continue in terminal', candidates[0].name), account: candidates[0], cont: true });
  if (candidates.length > 2) buttons.push({ title: t('Choose...'), account: null, cont: false });
  const tip = shared ? '' : ' ' + t('Tip: turn on shared history to continue the same conversation in the other account.');
  const pick = await vscode.window.showWarningMessage(what + resets + tip, ...buttons);
  if (!pick) return;
  if (!pick.account) return chooseAccount();
  if (pick.cont) continueInTerminal(pick.account);
  return select(pick.account, reason);
}

// Live quota: treats crossing the threshold like a limit, before Claude Code refuses requests.
/** @param {Account} account @param {any} snap */
function checkQuota(account, snap) {
  const threshold = Number(cfg('quotaThreshold'));
  if (!threshold || !snap) return;
  const weekly = snap.sevenDay && snap.sevenDay.usedPct >= threshold ? snap.sevenDay : null;
  const session = snap.fiveHour && snap.fiveHour.usedPct >= threshold ? snap.fiveHour : null;
  const hit = weekly || session;
  if (!hit) return;
  const kind = weekly ? 'weekly' : 'session';
  onLimitReached(
    account,
    { kind, resetAt: hit.resetsAt },
    {
      origin: 'quota',
      pct: Math.round(hit.usedPct),
      windowName: weekly ? t('weekly') : t('5-hour'),
    }
  ).catch((e) => rt.log.warn(`Quota threshold: ${e}`));
}

// Watches the selected account's session logs for usage-limit errors from this window's folders.
function restartWatcher() {
  watcher?.dispose();
  watcher = undefined;
  const folders = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  if (!folders.length) return;
  const account = accounts.selectedAccount();
  const configDir = accounts.configDirOf(account);
  // The file watcher does not follow symlinks, so watch the real projects folder when it exists.
  let base;
  let pattern;
  try {
    base = fs.realpathSync(path.join(configDir, 'projects'));
    pattern = '**/*.jsonl';
  } catch {
    if (!fs.existsSync(configDir)) return;
    base = configDir;
    pattern = 'projects/**/*.jsonl';
  }
  const encoded = folders.map(encodeProjectDir);
  // Entries carry the session's cwd; folder names are the fallback (they may be truncated and hashed).
  const belongsHere = (/** @type {any} */ o, /** @type {string} */ file) =>
    typeof o.cwd === 'string' ? folders.some((f) => isInside(o.cwd, f)) : encoded.some((e) => file.split(/[\\/]/).includes(e));
  const tail = new TailReader();
  const onFile = async (/** @type {vscode.Uri} */ uri) => {
    usage.scheduleRefresh();
    if (cfg('onUsageLimit') === 'ignore') return;
    try {
      const now = Date.now();
      for (const o of await tail.readNew(uri.fsPath)) {
        const info = limitInfo(o);
        if (!info) continue;
        const ts = Date.parse(o.timestamp);
        if (Number.isFinite(ts) && now - ts > RECENT_MS) continue;
        if (!belongsHere(o, uri.fsPath)) continue;
        await onLimitReached(account, info);
        break;
      }
    } catch (e) {
      rt.log.warn(`Reading ${uri.fsPath}: ${e}`);
    }
  };
  watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
  watcher.onDidChange(onFile);
  watcher.onDidCreate(onFile);
  rt.log.info(`Watching session logs of ${account.id} in ${base}`);
}

// Clears limits that have reset. The focused window announces it; other windows only clear.
async function checkExpired() {
  const now = Date.now();
  for (const [id, l] of Object.entries(accounts.getLimits())) {
    const until = l.until || l.at + 5 * 3600e3;
    if (now < until) continue;
    if (!vscode.window.state.focused && l.until) continue; // let a focused window announce it
    await accounts.setLimit(id, null);
    const a = accounts.findAccount(id);
    if (a && l.until && cfg('onUsageLimit') !== 'ignore') {
      vscode.window.showInformationMessage(t('Account "{0}" is available again.', a.name));
    }
  }
  arm();
}

// Wakes up when the next limit resets. Limits that already reset are handled on window focus.
function arm() {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const now = Date.now();
  const next = Object.values(accounts.getLimits())
    .map((l) => l.until || l.at + 5 * 3600e3)
    .filter((u) => u > now)
    .sort((a, b) => a - b)[0];
  if (next) timer = setTimeout(() => checkExpired().catch((e) => rt.log.warn(`Limits: ${e}`)), Math.min(next - now + 1000, 2 ** 31 - 1));
  notifyChanged();
}

function dispose() {
  watcher?.dispose();
  if (timer) clearTimeout(timer);
}

module.exports = {
  init,
  rankCandidates,
  onLimitReached,
  checkQuota,
  restartWatcher,
  checkExpired,
  arm,
  continueInTerminal,
  dispose,
};
