'use strict';
// Setup issues, shown as one warning in the status bar and one notification instead of a series
// of pop-ups at startup.
const vscode = require('vscode');
const { rt, K, t, OFFICIAL_EXTENSION_ID, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const { maybeReload } = require('./switching');

/** @typedef {{ id: string, message: string, actions: { title: string, run: () => any }[] }} Issue */

/** @type {Issue[]} */
let issues = [];
/** @type {(() => Promise<Issue[]>)[]} */
const providers = [];

const current = () => issues;

// Profile-related checks live in the commands module; it registers them here.
/** @param {() => Promise<Issue[]>} fn */
const addProvider = (fn) => providers.push(fn);

// CLAUDE_CONFIG_DIR in claudeCode.environmentVariables wins over the process environment in every
// window, which defeats switching. The setting is machine-scoped (user or remote settings).
function overridingSetting() {
  const list = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables');
  if (!Array.isArray(list)) return null;
  const e = list.find((v) => v && v.name === 'CLAUDE_CONFIG_DIR');
  return e && e.value ? String(e.value) : null;
}

/** @param {string} id */
const dismissed = (id) => !!rt.ctx.globalState.get(K.NOTICES, {})[id];
/** @param {string} id */
async function dismiss(id) {
  await rt.ctx.globalState.update(K.NOTICES, { ...rt.ctx.globalState.get(K.NOTICES, {}), [id]: true });
  await refresh();
}

async function builtIn() {
  /** @type {Issue[]} */
  const out = [];
  const dir = overridingSetting();
  if (dir) {
    out.push({
      id: 'override',
      message: t(
        'Your settings set CLAUDE_CONFIG_DIR={0} in claudeCode.environmentVariables. It takes precedence and makes every window use that folder, ignoring account switching.',
        dir
      ),
      actions: [{ title: t('Remove that entry'), run: removeOverridingEntry }],
    });
  }
  if (!vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID) && !dismissed('officialMissing')) {
    out.push({
      id: 'officialMissing',
      message: t(
        'The Claude Code extension ({0}) is not installed. Accounts still apply to the claude CLI in terminals.',
        OFFICIAL_EXTENSION_ID
      ),
      actions: [
        { title: t('Install'), run: () => vscode.commands.executeCommand('workbench.extensions.search', OFFICIAL_EXTENSION_ID) },
        { title: t("Don't show again"), run: () => dismiss('officialMissing') },
      ],
    });
  }
  return out;
}

async function removeOverridingEntry() {
  const c = vscode.workspace.getConfiguration('claudeCode');
  const info = c.inspect('environmentVariables');
  const keep = (/** @type {any} */ list) => (Array.isArray(list) ? list.filter((v) => v && v.name !== 'CLAUDE_CONFIG_DIR') : list);
  if (Array.isArray(info?.globalValue)) {
    const list = keep(info.globalValue);
    await c.update('environmentVariables', list.length ? list : undefined, vscode.ConfigurationTarget.Global);
  }
  rt.log.info('Removed CLAUDE_CONFIG_DIR from claudeCode.environmentVariables');
  await refresh();
  await maybeReload(t('Entry removed.'));
}

async function refresh() {
  const safe = (/** @type {() => Promise<Issue[]>} */ p) =>
    p().catch((e) => {
      rt.log.warn(`Health check: ${e}`);
      return [];
    });
  const lists = await Promise.all([safe(builtIn), ...providers.map(safe)]);
  const next = lists.flat();
  const changed = JSON.stringify(next.map((i) => i.message)) !== JSON.stringify(issues.map((i) => i.message));
  issues = next;
  if (changed) {
    for (const i of issues) rt.log.warn(`Setup issue: ${i.message}`);
    notifyChanged();
  }
  return issues;
}

// One notification for everything; "Review" lists the issues with their fixes.
async function notify() {
  if (!issues.length) return;
  if (issues.length === 1) {
    const [i] = issues;
    const pick = await vscode.window.showWarningMessage(i.message, ...i.actions.map((a) => a.title), t('Ignore'));
    const action = i.actions.find((a) => a.title === pick);
    if (action) await action.run();
    return;
  }
  const review = t('Review');
  const pick = await vscode.window.showWarningMessage(t('Claude Accounts found {0} setup issues.', issues.length), review);
  if (pick === review) await reviewIssues();
}

async function reviewIssues() {
  if (!issues.length) {
    vscode.window.showInformationMessage(t('No setup issues found.'));
    return;
  }
  const items = issues.flatMap((i) => i.actions.map((a) => ({ label: a.title, detail: i.message, run: a.run })));
  const p = await vscode.window.showQuickPick(items, { placeHolder: t('Setup issues: choose a fix'), matchOnDetail: true });
  if (p) await p.run();
}

// Signed-in duplicates: two accounts logged in to the same e-mail are usually a mistake.
function duplicateLogins() {
  const byEmail = new Map();
  for (const a of accounts.allAccounts()) {
    const email = accounts.getIdentity(a.id)?.email;
    if (!email || accounts.isSignedIn(a) === false) continue;
    const k = email.toLowerCase();
    byEmail.set(k, [...(byEmail.get(k) || []), a.name]);
  }
  return [...byEmail.entries()].filter(([, names]) => names.length > 1).map(([email, names]) => ({ email, names }));
}

module.exports = {
  current,
  addProvider,
  overridingSetting,
  refresh,
  notify,
  review: reviewIssues,
  dismiss,
  duplicateLogins,
  removeOverridingEntry,
};
