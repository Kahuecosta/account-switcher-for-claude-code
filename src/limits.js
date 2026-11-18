'use strict';
// Usage limits: detects them in this window's session logs (and, with live quota, before they are
// hit), offers or performs the switch to the best other account, and says when a limit resets.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { rt, t, cfg, notifyChanged, fileFolders } = require('./runtime');
const accounts = require('./accounts');
const quota = require('./quota');
const usage = require('./usage');
const handoff = require('./handoff');
const { encodeProjectDir, limitInfo, TailReader } = require('../lib/usage');
const { peakUsage } = require('../lib/statusline');
const { isInside } = require('../lib/paths');
const { clock } = require('./ui/format');

/** @typedef {import('./accounts').Account} Account */

const PROMPT_COOLDOWN_MS = 20 * 60e3; // at most one prompt per account every 20 minutes
const RECENT_MS = 15 * 60e3; // older log entries are history, not news
const QUOTA_MAX_AGE_MS = 15 * 60e3; // older usage readings do not trigger the threshold

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
/** @param {{ select: typeof select, choose: typeof chooseAccount, continueIn?: typeof continueIn }} fns */
function init(fns) {
  select = fns.select;
  chooseAccount = fns.choose;
  if (fns.continueIn) continueIn = fns.continueIn;
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

/**
 * @param {Account} account
 * @param {{ kind: string, resetAt: number | null }} info
 * @param {{ origin?: 'log' | 'quota', pct?: number, windowName?: string, file?: string }} [opts] file: the
 *   transcript that reported the limit, so that very conversation is the one that goes along
 */
async function onLimitReached(account, info, { origin = 'log', pct, windowName, file } = {}) {
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
  const reason = origin === 'quota' ? t('usage limit near') : t('usage limit reached');

  // Automatically: at the limit itself, the conversation goes along to the other account, since it cannot
  // go on here. Near the limit (the threshold), its tab may still be working, so only the window switches:
  // new chats use the other account, and the open conversation finishes where it is.
  if (mode === 'switch') return origin === 'log' ? continueIn(candidates[0], reason, { file, auto: true }) : select(candidates[0], reason);

  const best = candidates[0];
  const buttons = [
    { title: t('Continue in {0}', best.name), account: best, cont: true },
    { title: t('Switch to {0}', best.name), account: best, cont: false },
  ];
  if (candidates.length > 1) buttons.push({ title: t('Choose...'), account: null, cont: false });
  const pick = await vscode.window.showWarningMessage(what + resets, ...buttons);
  if (!pick) return;
  if (!pick.account) return chooseAccount();
  if (pick.cont) return continueIn(pick.account, reason, { file });
  return select(pick.account, reason);
}

// Continues the conversation in the Claude Code panel as the other account (replaced in tests).
/** @type {(a: Account, reason: string, opts?: { file?: string, auto?: boolean }) => Promise<any>} */
let continueIn = (a, reason, opts) => handoff.continueInPanel(a, reason, opts);

// Live quota: treats crossing the threshold like a limit, before Claude Code refuses requests.
/** @param {Account} account @param {any} snap */
function checkQuota(account, snap) {
  const threshold = Number(cfg('quotaThreshold'));
  if (!threshold || !snap) return;
  // Only a recent reading: an old one, or one of unknown age, may describe a window that has moved on.
  if (typeof snap.at !== 'number' || Date.now() - snap.at > QUOTA_MAX_AGE_MS) return;
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
  const folders = fileFolders();
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
        await onLimitReached(account, info, { file: uri.fsPath });
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
  dispose,
};
