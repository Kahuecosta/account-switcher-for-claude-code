'use strict';
// "Accounts" view in its own Activity Bar container: one card per account with its plan, its 5-hour and
// weekly usage and the actions that matter most. Every action runs a registered command, so the view
// adds no behavior of its own. The Explorer tree stays as the plain-list alternative.
const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { t, COLORS, changed } = require('../runtime');
const accounts = require('../accounts');
const quota = require('../quota');
const usage = require('../usage');
const heavy = require('../heavy');
const identity = require('../identity');
const env = require('../environment');
const perChat = require('../perChat');
const f = require('./format');
const { formatTokens } = require('../../lib/usage');

/** @typedef {import('../accounts').Account} Account */

const VIEW_ID = 'claudeAccounts.panel';
const STALE_MS = 15 * 60e3;

/** Actions the view may ask for, and the command each one runs (with the account id as argument). */
const ACTIONS = {
  switch: 'claudeAccounts.switch',
  login: 'claudeAccounts.login',
  terminal: 'claudeAccounts.openTerminal',
  continue: 'claudeAccounts.continueInPanel',
  newChat: 'claudeAccounts.newChatAs',
  manage: 'claudeAccounts.manage',
  add: 'claudeAccounts.add',
  usage: 'claudeAccounts.showUsage',
  refresh: 'claudeAccounts.refresh',
  refreshAccount: 'claudeAccounts.refreshAccount',
  reload: 'workbench.action.reloadWindow',
};
const NEEDS_ACCOUNT = new Set(['switch', 'login', 'terminal', 'continue', 'newChat', 'manage', 'refreshAccount']);

/** @param {number} n @param {string | null} currency */
function money(n, currency) {
  try {
    if (currency) return new Intl.NumberFormat(vscode.env.language, { style: 'currency', currency }).format(n);
  } catch {
    /* unknown currency code */
  }
  return n.toFixed(2) + (currency ? ` ${currency}` : '');
}

/**
 * @param {string} label @param {{ usedPct: number, resetsAt: number | null } | null | undefined} w
 * @param {import('../../lib/pace').Pace | null} [pace]
 */
function windowModel(label, w, pace = null) {
  if (!w) return null;
  const pct = Math.round(w.usedPct);
  return {
    label,
    pct,
    text: `${pct}%`,
    resets: w.resetsAt ? t('resets {0}', f.relative(w.resetsAt)) : '',
    aria: t('{0}: {1}% used', label, pct),
    pace: f.paceLine(pace),
    runsOut: !!pace && pace.runsOut,
  };
}

// How old the figures are and, when they are not checked on their own for now, why.
/** @param {string} id @param {number} at @param {number} now */
function ageNote(id, at, now) {
  const minutes = Math.floor((now - at) / 60e3);
  let age = t('as of {0}', f.clock(at));
  if (minutes < 1) age = t('Updated just now');
  else if (now - at <= STALE_MS) age = t('Updated {0} min ago', minutes);
  return quota.autoChecks() && quota.pausedUntil(id, now) ? `${age} · ${t('paused until it resets')}` : age;
}

// What used up the account's windows, by project or conversation. Null when that is off; empty when nothing
// was recorded yet.
/** @param {string} id */
function usedModel(id) {
  if (!quota.quotaOf(id) || !usage.breakdownAvailable(id)) return null;
  const byProject = usage.breakdownMode() === 'project';
  const used = usage.usedByOf(id);
  if (!used) return [];
  return /** @type {const} */ ([
    [t('5-hour'), used.fiveHour],
    [t('weekly'), used.sevenDay],
  ]).flatMap(([label, u]) =>
    u
      ? [
          {
            label,
            rows: u.rows.map((r) => ({
              share: `${Math.round(r.pct)}%`,
              project: r.cwd ? path.basename(r.cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')) : '?',
              title: byProject ? '' : (r.title || r.session.slice(0, 8)).replace(/\s+/g, ' ').slice(0, 120),
              context: r.context ? t('{0} per response', formatTokens(r.context)) : '',
              heavy: heavy.isHeavy(r.context),
            })),
            others: u.others >= 0.5 ? t('others: {0}%', Math.round(u.others)) : '',
          },
        ]
      : []
  );
}

/** @param {Account} a @param {Account} cur */
function cardModel(a, cur, now = Date.now()) {
  const q = quota.quotaOf(a.id);
  const signedIn = accounts.isSignedIn(a);
  const subscription = a.kind === 'subscription';
  const pace = quota.paceOf(a.id, now);
  const windows = q
    ? [
        windowModel(t('5-hour'), q.fiveHour, pace.fiveHour),
        windowModel(t('weekly'), q.sevenDay, pace.sevenDay),
        ...(q.models || []).map((m) => windowModel(t('{0} weekly', m.name), m)),
      ].filter(Boolean)
    : [];
  const notes = [];
  if (q?.extra)
    notes.push(
      t(
        'Extra usage: {0} of {1}',
        money(q.extra.used, q.extra.currency),
        q.extra.limit === null ? '?' : money(q.extra.limit, q.extra.currency)
      )
    );
  if (q?.at) notes.push(ageNote(a.id, q.at, now));
  if (!q && subscription && signedIn) notes.push(t('Usage appears after Claude Code checks it for this account.'));
  return {
    id: a.id,
    name: a.name,
    emoji: f.isEmojiIcon(a) ? a.icon : '',
    color: a.color && COLORS.includes(a.color) ? a.color : '',
    current: a.id === cur.id,
    line: identity.identityLine(a),
    loggedOut: subscription && signedIn === false,
    limit: f.limitLine(a.id),
    windows,
    notes,
    newChat: perChat.active() && perChat.eligible(a),
    canRefresh: quota.checkable(a),
    checking: quota.isChecking(a.id),
    used: usedModel(a.id),
  };
}

function viewModel() {
  const cur = accounts.selectedAccount();
  const started = accounts.findAccount(env.state.panelAccountId);
  return {
    pending: env.reloadPending(cur.id)
      ? t('The Claude Code panel still uses "{0}" until the window reloads.', started ? started.name : '?')
      : null,
    cards: accounts.allAccounts().map((a) => cardModel(a, cur)),
    strings: {
      current: t('current'),
      switch: t('Switch'),
      login: t('Log in'),
      terminal: t('Terminal'),
      terminalTitle: t('Open terminal as this account'),
      continue: t('Continue conversation'),
      continueTitle: t('Continue the latest conversation of this folder with this account'),
      newChat: t('New chat'),
      newChatTitle: t('New Claude Code chat as this account, without switching the window'),
      manage: t('Manage'),
      add: t('Add account...'),
      usage: t('Usage'),
      reload: t('Reload window'),
      empty: t('Add an account to use several Claude Code accounts.'),
      notLoggedIn: t('Not logged in'),
      refresh: t('Refresh the usage of this account'),
      refreshing: t('Checking usage...'),
      used: t('What used it'),
      nothing: t('Nothing recorded yet for this account'),
      usedTitle: t('Estimate: shares of what this computer used with the account'),
      heavy: t('Heavy conversation: /compact, or a new chat, makes your plan last longer'),
    },
  };
}

/** @implements {vscode.WebviewViewProvider} */
class AccountsPanel {
  constructor() {
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
    this.sub = changed.event(() => this.schedule());
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = html(view.webview.cspSource, vscode.env.language);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.post());
    view.onDidDispose(() => (this.view = undefined));
  }

  schedule() {
    if (!this.view || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.post();
    }, 100);
  }

  post() {
    if (this.view?.visible) this.view.webview.postMessage({ type: 'state', model: viewModel() }).then(undefined, () => undefined);
  }

  /** @param {any} m */
  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') return this.post();
    if (m.type !== 'action' || !Object.prototype.hasOwnProperty.call(ACTIONS, m.action)) return;
    const command = ACTIONS[/** @type {keyof typeof ACTIONS} */ (m.action)];
    if (NEEDS_ACCOUNT.has(m.action)) {
      if (typeof m.id !== 'string' || !accounts.findAccount(m.id)) return;
      return vscode.commands.executeCommand(command, m.id);
    }
    return vscode.commands.executeCommand(command);
  }

  dispose() {
    this.sub.dispose();
    if (this.timer) clearTimeout(this.timer);
  }
}

/** @param {string} cspSource @param {string} [lang] */
function html(cspSource, lang = 'en') {
  const nonce = crypto.randomBytes(16).toString('base64');
  const colorRules = COLORS.map((c) => `.card.c-${c}{border-left-color:var(--vscode-claudeAccounts-${c})}`).join('');
  return `<!DOCTYPE html>
<html lang="${String(lang).replace(/[^\w-]/g, '')}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
body{padding:8px 10px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
.banner{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 8px;margin-bottom:8px;border-radius:4px;background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder)}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.card{border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-left:3px solid var(--vscode-descriptionForeground);border-radius:4px;padding:8px;background:var(--vscode-sideBar-background)}
.card.current{outline:1px solid var(--vscode-focusBorder)}
${colorRules}
.head{display:flex;align-items:center;gap:6px;font-weight:600}
.head .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.head .spacer{flex:1}
button.icon{display:flex;padding:3px;border-color:transparent;background:transparent;color:var(--vscode-icon-foreground,var(--vscode-foreground))}
button.icon:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-button-secondaryHoverBackground))}
button.icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
button.icon.busy{cursor:default}
button.icon.busy svg{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){button.icon.busy svg{animation:none;opacity:.5}}
.vscode-reduce-motion button.icon.busy svg{animation:none;opacity:.5}
.badge{font-size:.85em;font-weight:400;padding:0 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.line,.note{color:var(--vscode-descriptionForeground);font-size:.92em;margin-top:2px;overflow-wrap:anywhere}
.limit{color:var(--vscode-errorForeground);font-size:.92em;margin-top:2px}
.meter{margin-top:6px}
.meter .top{display:flex;justify-content:space-between;font-size:.88em;color:var(--vscode-descriptionForeground)}
.bar{height:6px;border-radius:3px;background:var(--vscode-editorWidget-background,rgba(128,128,128,.2));overflow:hidden;margin-top:2px;border:1px solid var(--vscode-widget-border,transparent)}
.fill{height:100%;background:var(--vscode-charts-blue,var(--vscode-progressBar-background))}
.fill.warn{background:var(--vscode-charts-yellow)}
.fill.crit{background:var(--vscode-charts-red)}
.pace{font-size:.85em;color:var(--vscode-descriptionForeground);margin-top:1px}
.pace.out{color:var(--vscode-editorWarning-foreground,var(--vscode-charts-yellow))}
details{margin-top:6px;font-size:.88em}
summary{cursor:pointer;color:var(--vscode-descriptionForeground)}
summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.used h4{margin:6px 0 2px;font-weight:600;font-size:1em;color:var(--vscode-descriptionForeground)}
.use{display:grid;grid-template-columns:2.8em minmax(0,1fr);column-gap:4px;margin-top:2px}
.use .share{font-variant-numeric:tabular-nums;text-align:right}
.use .what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.use .ctx{grid-column:2;color:var(--vscode-descriptionForeground);font-size:.95em}
.use .ctx.heavy{color:var(--vscode-editorWarning-foreground,var(--vscode-charts-yellow))}
.actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
button{font:inherit;font-size:.92em;border:1px solid var(--vscode-button-border,var(--vscode-widget-border,transparent));border-radius:2px;padding:2px 8px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.footer{display:flex;gap:4px;margin-top:10px;flex-wrap:wrap}
.empty{color:var(--vscode-descriptionForeground);margin:8px 0}
</style>
</head>
<body>
<div id="banner" role="status"></div>
<div id="root"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const bannerHost = document.getElementById('banner');
  let shownBanner = null;
  const open = new Set((vscode.getState() || {}).open || []);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };
  const button = (label, action, id, opts) => {
    const b = el('button', opts && opts.primary ? 'primary' : '', label);
    b.type = 'button';
    b.dataset.key = action + ':' + (id || '');
    if (opts && opts.title) b.title = opts.title;
    b.addEventListener('click', () => {
      if (!opts || !opts.busy) vscode.postMessage({ type: 'action', action, id });
    });
    return b;
  };
  function refreshButton(c, s) {
    const label = c.checking ? s.refreshing : s.refresh;
    const b = button('', 'refreshAccount', c.id, { title: label, busy: c.checking });
    b.className = 'icon' + (c.checking ? ' busy' : '');
    b.setAttribute('aria-label', label + ' (' + c.name + ')');
    // Not "disabled": that would take the keyboard focus away from it.
    b.setAttribute('aria-disabled', String(c.checking));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M13.5 8a5.5 5.5 0 1 1-1.7-4', 'M13.5 1.5v3h-3']) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    b.append(svg);
    return b;
  }
  function meter(w) {
    const m = el('div', 'meter');
    const top = el('div', 'top');
    top.append(el('span', '', w.label + ' · ' + w.text), el('span', '', w.resets));
    const bar = el('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(w.pct));
    bar.setAttribute('aria-label', w.aria);
    const fill = el('div', 'fill' + (w.pct >= 95 ? ' crit' : w.pct >= 80 ? ' warn' : ''));
    fill.style.width = Math.max(0, Math.min(100, w.pct)) + '%';
    bar.append(fill);
    m.append(top, bar);
    if (w.pace) m.append(el('div', 'pace' + (w.runsOut ? ' out' : ''), w.pace));
    return m;
  }
  function usedSection(c, s) {
    const d = el('details', 'used');
    d.open = open.has(c.id);
    const sum = el('summary', '', s.used);
    sum.title = s.usedTitle;
    sum.dataset.key = 'used:' + c.id;
    d.append(sum);
    d.addEventListener('toggle', () => {
      if (d.open) open.add(c.id);
      else open.delete(c.id);
      vscode.setState({ open: Array.from(open) });
    });
    if (!c.used.length) d.append(el('div', 'note', s.nothing));
    for (const w of c.used) {
      d.append(el('h4', '', w.label));
      for (const r of w.rows) {
        const row = el('div', 'use');
        const text = [r.project, r.title].filter(Boolean).join(' · ');
        const what = el('span', 'what', text);
        what.title = text;
        row.append(el('span', 'share', r.share), what);
        if (r.context) {
          const ctx = el('span', 'ctx' + (r.heavy ? ' heavy' : ''), (r.heavy ? '⚠ ' : '') + r.context);
          if (r.heavy) ctx.title = s.heavy;
          row.append(ctx);
        }
        d.append(row);
      }
      if (w.others) d.append(el('div', 'note', w.others));
    }
    return d;
  }
  function card(c, s) {
    const li = el('li', 'card' + (c.current ? ' current' : '') + (c.color ? ' c-' + c.color : ''));
    li.setAttribute('aria-label', c.name + (c.current ? ' (' + s.current + ')' : ''));
    const head = el('div', 'head');
    if (c.emoji) head.append(el('span', '', c.emoji));
    head.append(el('span', 'name', c.name));
    if (c.current) head.append(el('span', 'badge', s.current));
    if (c.canRefresh) head.append(el('span', 'spacer'), refreshButton(c, s));
    li.append(head);
    if (c.loggedOut) li.append(el('div', 'line', s.notLoggedIn));
    else if (c.line) li.append(el('div', 'line', c.line));
    if (c.limit) li.append(el('div', 'limit', c.limit));
    for (const w of c.windows) li.append(meter(w));
    for (const n of c.notes) li.append(el('div', 'note', n));
    if (c.used) li.append(usedSection(c, s));
    const actions = el('div', 'actions');
    if (c.loggedOut) actions.append(button(s.login, 'login', c.id, { primary: true }));
    if (!c.current) {
      actions.append(button(s.switch, 'switch', c.id, { primary: !c.loggedOut }));
      actions.append(button(s.continue, 'continue', c.id, { title: s.continueTitle }));
    }
    if (c.newChat) actions.append(button(s.newChat, 'newChat', c.id, { title: s.newChatTitle }));
    actions.append(button(s.terminal, 'terminal', c.id, { title: s.terminalTitle }));
    actions.append(button(s.manage, 'manage', c.id));
    li.append(actions);
    return li;
  }
  function render(m) {
    const s = m.strings;
    // Updates arrive every minute and on every change: keep the keyboard focus where it was.
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
    root.replaceChildren();
    // The banner lives outside the list and changes only when its text does, so a screen reader
    // announces it once instead of on every update.
    if (m.pending !== shownBanner) {
      shownBanner = m.pending;
      bannerHost.replaceChildren();
      if (m.pending) {
        const b = el('div', 'banner');
        b.append(el('span', '', m.pending), button(s.reload, 'reload', undefined, { primary: true }));
        bannerHost.append(b);
      }
    }
    const list = el('ul');
    for (const c of m.cards) list.append(card(c, s));
    root.append(list);
    if (m.cards.length < 2) root.append(el('p', 'empty', s.empty));
    const footer = el('div', 'footer');
    footer.append(button(s.add, 'add', undefined, { primary: m.cards.length < 2 }), button(s.usage, 'usage'));
    root.append(footer);
    if (focused) {
      const again = Array.from(document.querySelectorAll('button, summary')).find((b) => b.dataset.key === focused);
      if (again) again.focus();
    }
  }
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') render(e.data.model);
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { VIEW_ID, AccountsPanel, viewModel, cardModel, html, ACTIONS };
