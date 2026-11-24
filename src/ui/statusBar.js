'use strict';
const vscode = require('vscode');
const { t, cfg, EXTENSION_NAME } = require('../runtime');
const accounts = require('../accounts');
const quota = require('../quota');
const usage = require('../usage');
const repo = require('../repo');
const env = require('../environment');
const health = require('../health');
const f = require('./format');
const { initials } = require('../../lib/names');
const { formatTokens, totalTokens } = require('../../lib/usage');
const { peakUsage } = require('../../lib/statusline');

/** @type {vscode.StatusBarItem | undefined} */
let item;
/** Items of the other accounts (statusBarUsage "all"), by account id. @type {Map<string, vscode.StatusBarItem>} */
const others = new Map();
const MAX_OTHERS = 4;

const LINK_COMMANDS = [
  'claudeAccounts.switch',
  'claudeAccounts.showUsage',
  'claudeAccounts.manage',
  'claudeAccounts.diagnose',
  'claudeAccounts.reviewIssues',
  'workbench.action.reloadWindow',
];

function create() {
  item = vscode.window.createStatusBarItem('claudeAccounts.status', vscode.StatusBarAlignment.Left, 100);
  item.name = EXTENSION_NAME;
  item.command = 'claudeAccounts.switch';
  return item;
}

function update() {
  if (!item) return;
  const cur = accounts.selectedAccount();
  const id = accounts.getIdentity(cur.id);
  const name = f.shortName(cur);
  const style = cfg('statusBarStyle');
  const q = f.showQuota() ? quota.quotaOf(cur.id) : null;
  const limit = accounts.activeLimit(cur.id);
  const pending = env.reloadPending(cur.id);
  const issues = health.current();

  let text =
    style === 'icon'
      ? f.iconText(cur)
      : style === 'initials'
        ? `${f.iconText(cur)} ${initials(name)}`
        : `${f.iconText(cur)} Claude: ${name}`;
  if (cfg('showPlan') && id?.plan && style !== 'icon') text += ` · ${id.plan}`;
  // The window closest to its limit: a full week matters even when the 5-hour window is empty.
  const shown = q ? [q.fiveHour, q.sevenDay].filter(Boolean).sort((x, y) => y.usedPct - x.usedPct)[0] : null;
  const both = q && cfg('statusBarUsage') !== 'window' ? f.quotaLine(cur.id) : '';
  if (both) text += ` · ${both}`;
  else if (shown) text += ` · ${Math.round(shown.usedPct)}%`;
  if (limit) text += limit.estimated ? ' $(watch)' : ` $(watch) ${f.clock(limit.until)}`;
  if (pending) text = `$(sync) ${text}`;
  if (issues.length) text = `$(warning) ${text}`;
  item.text = text;
  item.color = f.themeColor(cur.color);
  const peak = peakUsage(q);
  item.backgroundColor =
    issues.length || limit || (peak !== null && peak >= 90) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

  const tip = new vscode.MarkdownString('', true);
  tip.isTrusted = { enabledCommands: LINK_COMMANDS };
  const line = (/** @type {string} */ s) => tip.appendMarkdown(`${s}  \n`);
  line(`**${f.md(t('Account: {0}', cur.name))}**`);
  if (cur.kind && cur.kind !== 'subscription') line(f.md(accounts.kindLabel(cur.kind)));
  if (id?.email) line(f.md(t('E-mail: {0}', id.email)));
  if (id?.plan) line(f.md(t('Plan: {0}', id.plan)));
  if (id?.organization && cfg('showOrganization') !== false) line(f.md(t('Organization: {0}', id.organization)));
  if (accounts.isSignedIn(cur) === false) line(f.md(t('Not logged in')));
  line(f.md(t('Folder: {0}', accounts.configDirOf(cur))));
  line(f.md(t('Mode: {0}', accounts.modeLabel(cur.mode))));
  if (cfg('shareHistory')) line(f.md(t('History: shared')));
  if (q?.fiveHour)
    line(
      f.md(
        t(
          '5-hour limit: {0}% used, resets {1}',
          Math.round(q.fiveHour.usedPct),
          q.fiveHour.resetsAt ? f.relative(q.fiveHour.resetsAt) : '?'
        )
      )
    );
  if (q?.sevenDay)
    line(
      f.md(
        t(
          'Weekly limit: {0}% used, resets {1}',
          Math.round(q.sevenDay.usedPct),
          q.sevenDay.resetsAt ? f.relative(q.sevenDay.resetsAt) : '?'
        )
      )
    );
  const pace = quota.paceOf(cur.id);
  if (q?.fiveHour && pace.fiveHour) line(f.md(`${t('5-hour')}: ${f.paceLine(pace.fiveHour)}`));
  if (q?.sevenDay && pace.sevenDay) line(f.md(`${t('weekly')}: ${f.paceLine(pace.sevenDay)}`));
  if (limit)
    line(
      `$(watch) ${f.md(limit.estimated ? t('Usage limit reached.') : t('Usage limit reached. Resets {0} ({1}).', f.clock(limit.until), f.relative(limit.until)))}`
    );
  const d = repo.resolveDefault();
  if (d?.source === 'repo') line(f.md(t('Repository default: {0}', d.account.name)));
  if (d?.source === 'rule') line(f.md(t('Default by rule {0}: {1}', d.pattern, d.account.name)));
  if (d?.conflicts.length) line(f.md(t('Other folders in this window prefer other accounts: {0}', d.conflicts.join(', '))));
  const u = usage.usageOf(cur.id);
  if (u) line(f.md(t('Tokens today ({0}): {1}', cfg('shareHistory') ? t('all accounts') : cur.name, formatTokens(totalTokens(u.today)))));
  if (pending) {
    const started = accounts.findAccount(env.state.panelAccountId);
    tip.appendMarkdown('\n---\n');
    line(
      `$(sync) ${f.md(t('The Claude Code panel still uses "{0}" until the window reloads.', started ? started.name : '?'))} [${f.md(t('Reload window'))}](command:workbench.action.reloadWindow)`
    );
  }
  if (issues.length) {
    tip.appendMarkdown('\n---\n');
    for (const i of issues) line(`$(warning) ${f.md(i.message)}`);
    line(`[${f.md(t('Review'))}](command:claudeAccounts.reviewIssues)`);
  }
  tip.appendMarkdown('\n---\n');
  tip.appendMarkdown(
    [
      `[$(arrow-swap) ${f.md(t('Switch'))}](command:claudeAccounts.switch)`,
      `[$(graph) ${f.md(t('Usage'))}](command:claudeAccounts.showUsage)`,
      `[$(gear) ${f.md(t('Manage'))}](command:claudeAccounts.manage)`,
      `[$(pulse) ${f.md(t('Diagnose'))}](command:claudeAccounts.diagnose)`,
    ].join(' · ')
  );
  item.tooltip = tip;

  const a11y = [t('Claude Code account: {0}', cur.name)];
  if (id?.plan) a11y.push(id.plan);
  if (shown) a11y.push(t('{0}% of the usage limit used', Math.round(shown.usedPct)));
  if (limit) a11y.push(t('Usage limit reached.'));
  if (pending) a11y.push(t('Reload pending.'));
  if (issues.length) a11y.push(t('{0} setup issue(s).', issues.length));
  item.accessibilityInformation = { label: a11y.join(', '), role: 'button' };
  item.show();
  updateOthers(cur);
}

// The other accounts' 5-hour and weekly usage, one item each. A click opens the Claude Accounts view: it
// never switches, so a stray one cannot reload the window.
/** @param {import('../accounts').Account} cur */
function updateOthers(cur) {
  const list =
    f.showQuota() && cfg('statusBarUsage') === 'all'
      ? accounts
          .allAccounts()
          .filter((a) => a.id !== cur.id && f.quotaLine(a.id))
          .slice(0, MAX_OTHERS)
      : [];
  for (const [id, it] of others) {
    if (list.some((a) => a.id === id)) continue;
    it.dispose();
    others.delete(id);
  }
  list.forEach((a, i) => {
    let it = others.get(a.id);
    if (!it) {
      it = vscode.window.createStatusBarItem(`claudeAccounts.status.${a.id}`, vscode.StatusBarAlignment.Left, 99 - i);
      it.name = `${EXTENSION_NAME}: ${a.name}`;
      it.command = 'claudeAccounts.panel.focus';
      others.set(a.id, it);
    }
    const q = quota.quotaOf(a.id);
    const limit = accounts.activeLimit(a.id);
    const usage = f.quotaLine(a.id);
    it.text = `${f.iconText(a)} ${usage}${limit && !limit.estimated ? ` $(watch) ${f.clock(limit.until)}` : ''}`;
    it.color = f.themeColor(a.color);
    const tip = new vscode.MarkdownString('', true);
    const line = (/** @type {string} */ s) => tip.appendMarkdown(`${f.md(s)}  \n`);
    tip.appendMarkdown(`**${f.md(a.name)}**  \n`);
    const pace = quota.paceOf(a.id);
    for (const [label, w, p] of /** @type {const} */ ([
      [t('5-hour'), q?.fiveHour, pace.fiveHour],
      [t('weekly'), q?.sevenDay, pace.sevenDay],
    ])) {
      if (!w) continue;
      line([`${label}: ${Math.round(w.usedPct)}%`, w.resetsAt ? t('resets {0}', f.relative(w.resetsAt)) : ''].filter(Boolean).join(' · '));
      if (p) line(f.paceLine(p));
    }
    if (limit) line(f.limitLine(a.id));
    it.tooltip = tip;
    it.accessibilityInformation = { label: [a.name, usage, f.limitLine(a.id)].filter(Boolean).join(', '), role: 'button' };
    it.show();
  });
}

function dispose() {
  for (const it of others.values()) it.dispose();
  others.clear();
}

module.exports = { create, update, dispose };
