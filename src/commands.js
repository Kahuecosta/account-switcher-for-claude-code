'use strict';
// Command handlers.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { rt, K, t, cfg, COLORS, ICONS, DEFAULT_ID, store, accountsRoot, baseDir, storageDir, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const repo = require('./repo');
const profile = require('./profile');
const quota = require('./quota');
const usage = require('./usage');
const identity = require('./identity');
const health = require('./health');
const env = require('./environment');
const { selectAccount, maybeReload, autoApply } = require('./switching');
const { accountItem, pick, pickAccount } = require('./ui/pickers');
const { slugify, isSingleEmoji } = require('../lib/names');
const { normalizeRemote } = require('../lib/rules');
const { isLinkedTo } = require('../lib/links');
const { formatTokens, totalTokens } = require('../lib/usage');
const { readIdentity } = require('../lib/identity');
const { samePath, tildify } = require('../lib/paths');
const f = require('./ui/format');

/** @typedef {import('./accounts').Account} Account */

// Accepts what a command can receive: an Account (tree item), an id/name/e-mail string, or { account }.
/** @param {any} arg @returns {Account | null} */
function accountArg(arg) {
  if (!arg) return null;
  if (typeof arg === 'string') return accounts.findAccountByRef(arg);
  if (arg.account) return accountArg(arg.account);
  if (typeof arg.id === 'string') return accounts.findAccount(arg.id) || null;
  return null;
}

/** @param {any} arg @param {string} placeHolder */
async function accountOrPick(arg, placeHolder) {
  if (arg !== undefined && arg !== null) {
    const a = accountArg(arg);
    if (!a) throw new Error(t('No account matches "{0}".', typeof arg === 'string' ? arg : JSON.stringify(arg)));
    return a;
  }
  return pickAccount(placeHolder);
}

// ───────── switching ─────────

/** @param {any} [arg] account to switch to, for keybindings, tasks and other extensions */
async function cmdSwitch(arg) {
  if (arg !== undefined && arg !== null) {
    const a = accountArg(arg);
    if (!a) throw new Error(t('No account matches "{0}".', String(arg)));
    if (a.id !== accounts.selectedAccount().id) await selectAccount(a);
    return;
  }
  const cur = accounts.selectedAccount();
  identity.refreshAllIdentities().catch(() => null);
  /** @type {any[]} */
  const items = [];
  if (env.reloadPending(cur.id))
    items.push({
      label: '$(sync) ' + t('Reload window to use "{0}" in the Claude Code panel', cur.name),
      action: 'workbench.action.reloadWindow',
    });
  items.push(...accounts.allAccounts().map((a) => accountItem(a)));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(add) ' + t('Add account...'), action: 'claudeAccounts.add' });
  if (repo.getRepos().length) {
    items.push({ label: '$(pin) ' + t('Set default account for this repository...'), action: 'claudeAccounts.setRepoDefault' });
    items.push({ label: '$(list-filter) ' + t('Add default-account rule...'), action: 'claudeAccounts.addRule' });
  }
  items.push({ label: '$(terminal) ' + t('Open terminal as account...'), action: 'claudeAccounts.openTerminal' });
  items.push({ label: '$(graph) ' + t('Show usage by account'), action: 'claudeAccounts.showUsage' });
  items.push({
    label: '$(history) ' + (cfg('shareHistory') ? t('Stop sharing history...') : t('Share history across accounts...')),
    action: 'claudeAccounts.toggleHistorySharing',
  });
  items.push({ label: '$(gear) ' + t('Manage accounts...'), action: 'claudeAccounts.manage' });
  items.push({ label: '$(pulse) ' + t('Diagnose...'), action: 'claudeAccounts.diagnose' });

  const r = await pick(items, t('Current account: {0}', cur.name));
  if (!r) return;
  if (r.button) return runAccountAction(r.button.action, r.item.account);
  if (r.item.action) return vscode.commands.executeCommand(r.item.action);
  if (r.item.account.id === cur.id) return;
  await selectAccount(r.item.account);
}

async function cmdSwitchToPrevious() {
  const prev = accounts.findAccount(store().get(K.PREVIOUS));
  if (!prev || prev.id === accounts.selectedAccount().id) {
    vscode.window.showInformationMessage(t('There is no previous account in this window yet.'));
    return;
  }
  await selectAccount(prev);
}

/** @param {string} action @param {Account} a */
function runAccountAction(action, a) {
  if (action === 'rename') return cmdRename(a);
  if (action === 'appearance') return cmdAppearance(a);
  if (action === 'login') return cmdLogin(a);
  if (action === 'env') return cmdEditEnv(a);
  if (action === 'terminal') return cmdOpenTerminal(a);
  if (action === 'remove') return cmdRemove(a);
  return undefined;
}

// ───────── adding accounts ─────────

const KIND_ENV = {
  apiKey: 'ANTHROPIC_API_KEY',
  oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN',
};

async function pickKind() {
  const p = await vscode.window.showQuickPick(
    [
      {
        label: '$(account) ' + t('Claude subscription'),
        detail: t('Log in with a claude.ai account (Pro, Max, Team or Enterprise).'),
        value: 'subscription',
      },
      {
        label: '$(key) ' + t('Subscription token'),
        detail: t('A long-lived token from "claude setup-token", kept in VS Code secret storage.'),
        value: 'oauthToken',
      },
      { label: '$(key) ' + t('API key'), detail: t('An Anthropic Console API key, kept in VS Code secret storage.'), value: 'apiKey' },
      { label: '$(cloud) ' + t('Amazon Bedrock'), detail: t('Uses your AWS credentials (region and optional profile).'), value: 'bedrock' },
      {
        label: '$(cloud) ' + t('Google Vertex AI'),
        detail: t('Uses your Google Cloud credentials (region and project).'),
        value: 'vertex',
      },
    ],
    { placeHolder: t('How does this account sign in?') }
  );
  return p ? /** @type {import('./accounts').AccountKind} */ (p.value) : undefined;
}

async function pickMode() {
  const p = await vscode.window.showQuickPick(
    [
      {
        label: '$(link) ' + t('Shared profile'),
        detail: t(
          'Uses the same configuration as ~/.claude (settings, CLAUDE.md, agents, commands, skills, MCP servers...). Login and history stay separate. Changes to that configuration apply to every shared account.'
        ),
        mode: 'shared',
      },
      {
        label: '$(lock) ' + t('Isolated profile'),
        detail: t('Configuration, history and login fully separate. ~/.claude is not touched.'),
        mode: 'isolated',
      },
    ],
    { placeHolder: t('How should this account handle configuration?') }
  );
  return p ? /** @type {'shared' | 'isolated'} */ (p.mode) : undefined;
}

/** @param {string} prompt @param {{ value?: string, password?: boolean, optional?: boolean }} [opts] */
function ask(prompt, { value, password = false, optional = false } = {}) {
  return vscode.window.showInputBox({
    prompt,
    value,
    password,
    ignoreFocusOut: true,
    validateInput: (v) => (optional || v.trim() ? null : t('Enter a value')),
  });
}

// Variables a credential kind needs, or undefined when cancelled.
/** @param {import('./accounts').AccountKind} kind @returns {Promise<[string, string, boolean][] | undefined>} */
async function credentialEnv(kind) {
  if (kind === 'apiKey' || kind === 'oauthToken') {
    const v = await ask(kind === 'apiKey' ? t('Anthropic API key') : t('Token printed by "claude setup-token"'), { password: true });
    return v === undefined ? undefined : [[KIND_ENV[kind], v.trim(), true]];
  }
  if (kind === 'bedrock') {
    const region = await ask(t('AWS region (AWS_REGION)'), { value: 'us-east-1' });
    if (region === undefined) return undefined;
    const prof = await ask(t('AWS profile (AWS_PROFILE), optional'), { optional: true });
    if (prof === undefined) return undefined;
    /** @type {[string, string, boolean][]} */
    const out = [
      ['CLAUDE_CODE_USE_BEDROCK', '1', false],
      ['AWS_REGION', region.trim(), false],
    ];
    if (prof.trim()) out.push(['AWS_PROFILE', prof.trim(), false]);
    return out;
  }
  if (kind === 'vertex') {
    const region = await ask(t('Vertex AI region (CLOUD_ML_REGION)'), { value: 'us-east5' });
    if (region === undefined) return undefined;
    const project = await ask(t('Google Cloud project (ANTHROPIC_VERTEX_PROJECT_ID)'));
    if (project === undefined) return undefined;
    return [
      ['CLAUDE_CODE_USE_VERTEX', '1', false],
      ['CLOUD_ML_REGION', region.trim(), false],
      ['ANTHROPIC_VERTEX_PROJECT_ID', project.trim(), false],
    ];
  }
  return [];
}

/** @param {string} dir */
const nonEmptyDir = (dir) => {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

// Picks the folder for a new account. An existing non-empty folder (left behind by a removed account)
// is only reused when the user says so, because it may hold another login.
/** @param {string} base */
async function chooseAccountDir(base) {
  const taken = new Set([DEFAULT_ID, ...accounts.getRecords().map((r) => r.id)]);
  const dirOf = (/** @type {string} */ id) => path.join(accountsRoot(), id);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  if (!nonEmptyDir(dirOf(id))) return { id, dir: dirOf(id), reused: false };

  let next = id;
  for (let i = 2; taken.has(next) || nonEmptyDir(dirOf(next)); i++) next = `${base}-${i}`;
  const found = await readIdentity(dirOf(id)).catch(() => null);
  const p = await vscode.window.showQuickPick(
    [
      { label: '$(new-folder) ' + t('Create a new folder'), detail: dirOf(next), reuse: false },
      {
        label: '$(folder) ' + t('Use the existing folder'),
        detail: found?.email ? t('{0} (logged in as {1})', dirOf(id), found.email) : dirOf(id),
        reuse: true,
      },
    ],
    { placeHolder: t('The folder {0} already exists and is not empty.', dirOf(id)) }
  );
  if (!p) return undefined;
  return p.reuse ? { id, dir: dirOf(id), reused: true } : { id: next, dir: dirOf(next), reused: false };
}

async function cmdAdd() {
  const name = await vscode.window.showInputBox({
    prompt: t('Account name (e.g. Work, Personal)'),
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? t('Enter a name') : v.trim().length > 60 ? t('Use at most 60 characters') : null),
  });
  if (!name) return;
  const kind = await pickKind();
  if (!kind) return;
  const mode = await pickMode();
  if (!mode) return;
  const vars = await credentialEnv(kind);
  if (!vars) return;
  const target = await chooseAccountDir(slugify(name));
  if (!target) return;
  const { id, dir } = target;
  await fs.promises.mkdir(dir, { recursive: true });

  await accounts.saveRecords([...accounts.getRecords(), { id, dir, mode, kind }]);
  const used = new Set(
    accounts
      .allAccounts()
      .map((a) => a.color)
      .filter(Boolean)
  );
  await accounts.updateMeta(id, { name: name.trim(), color: COLORS.find((c) => !used.has(c)) });
  for (const [n, v, secret] of vars) await accounts.setEnvVar(id, n, v, secret);
  rt.log.info(`Account added: ${id} (${kind}, ${mode}) at ${dir}`);

  const account = /** @type {Account} */ (accounts.findAccount(id));
  let summary = '';
  try {
    summary = profile.describe(await profile.setUpNewAccount(account));
    if (profile.historyItems().length) summary += ' ' + t('History shared with the other accounts.');
    await profile.mirrorMcp(account);
    if (quota.enabled()) await quota.syncBridge();
  } catch (e) {
    summary += ' ' + t('Setting up the folder failed: {0}', e instanceof Error ? e.message : String(e));
  }
  await identity.refreshIdentity(account).catch(() => null);
  notifyChanged();

  if (kind !== 'subscription') {
    const switchBtn = t('Switch to it');
    const res = await vscode.window.showInformationMessage(t('Account "{0}" created at {1}.{2}', account.name, dir, summary), switchBtn);
    if (res === switchBtn) await selectAccount(account);
    return;
  }
  const loginBtn = t('Log in');
  const res = await vscode.window.showInformationMessage(
    t('Account "{0}" created at {1}.{2} Log in now?', account.name, dir, summary),
    loginBtn,
    t('Later')
  );
  if (res === loginBtn) cmdLogin(account);
}

// ───────── per-account actions ─────────

/** @type {Set<vscode.Terminal>} */
const loginTerminals = new Set();

/** @param {any} [arg] */
async function cmdLogin(arg) {
  const a = await accountOrPick(arg, t('Log in to which account?'));
  if (!a) return;
  if (a.kind !== 'subscription') return cmdEditEnv(a);
  const term = env.createAccountTerminal(a, {
    name: t('Claude login: {0}', a.name),
    command: String(cfg('loginCommand') || 'claude auth login'),
    transient: true,
    icon: 'key',
  });
  loginTerminals.add(term);
}

/** @param {vscode.Terminal} term */
function onTerminalClosed(term) {
  if (loginTerminals.delete(term))
    identity
      .refreshAllIdentities()
      .then(() => health.refresh())
      .catch(() => null);
}

/** @param {any} [arg] */
async function cmdOpenTerminal(arg) {
  const a = await accountOrPick(arg, t('Open a terminal as which account?'));
  if (!a) return;
  env.createAccountTerminal(a, {
    name: t('Claude: {0}', a.name),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    command: 'claude',
  });
}

/** @param {any} [arg] */
async function cmdRename(arg) {
  const a = await accountOrPick(arg, t('Rename which account?'));
  if (!a) return;
  const name = await vscode.window.showInputBox({
    prompt: t('New name'),
    value: a.name,
    validateInput: (v) => (!v.trim() ? t('Enter a name') : v.trim().length > 60 ? t('Use at most 60 characters') : null),
  });
  if (!name) return;
  await accounts.updateMeta(a.id, { name: name.trim() });
}

/** @param {any} [arg] */
async function cmdAppearance(arg) {
  const a = await accountOrPick(arg, t('Change the appearance of which account?'));
  if (!a) return;
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(symbol-color) ' + t('Color...'), id: 'color' },
      { label: '$(smiley) ' + t('Icon or emoji...'), id: 'icon' },
      {
        label: '$(file-media) ' + t('Image...'),
        id: 'image',
        detail: t('Shown in the account picker. The status bar only supports icons.'),
      },
      ...(a.avatar ? [{ label: '$(close) ' + t('Remove image'), id: 'noimage' }] : []),
    ],
    { placeHolder: t('Appearance of "{0}"', a.name) }
  );
  if (!choice) return;

  if (choice.id === 'color') {
    const names = {
      orange: t('Orange'),
      green: t('Green'),
      blue: t('Blue'),
      purple: t('Purple'),
      pink: t('Pink'),
      yellow: t('Yellow'),
      teal: t('Teal'),
      red: t('Red'),
    };
    const c = await vscode.window.showQuickPick(
      [
        ...COLORS.map((col) => ({ label: names[col], color: col, iconPath: new vscode.ThemeIcon('circle-filled', f.themeColor(col)) })),
        { label: t('No color'), color: undefined, iconPath: new vscode.ThemeIcon('circle-outline') },
      ],
      { placeHolder: t('Color of "{0}"', a.name) }
    );
    if (c) await accounts.updateMeta(a.id, { color: c.color });
  } else if (choice.id === 'icon') {
    const i = await vscode.window.showQuickPick(
      [...ICONS.map((ic) => ({ label: `$(${ic}) ${ic}`, icon: ic })), { label: '$(smiley) ' + t('Emoji...'), icon: '__emoji__' }],
      { placeHolder: t('Icon of "{0}"', a.name) }
    );
    if (!i) return;
    let icon = i.icon;
    if (icon === '__emoji__') {
      icon = await vscode.window.showInputBox({
        prompt: t('Type or paste one emoji'),
        validateInput: (v) => (isSingleEmoji(v) ? null : t('Enter a single emoji')),
      });
      if (!icon) return;
      icon = icon.trim();
    }
    await accounts.updateMeta(a.id, { icon });
  } else if (choice.id === 'image') {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [t('Images')]: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
    });
    if (!files?.length) return;
    const src = files[0].fsPath;
    if ((await fs.promises.stat(src)).size > 2 * 1024 * 1024) {
      vscode.window.showWarningMessage(t('Choose an image smaller than 2 MB.'));
      return;
    }
    const fileName = `${a.id}-${Date.now()}${path.extname(src).toLowerCase()}`;
    await fs.promises.mkdir(storageDir('avatars'), { recursive: true });
    await fs.promises.copyFile(src, storageDir('avatars', fileName));
    if (a.avatar) await fs.promises.rm(storageDir('avatars', a.avatar), { force: true });
    await rt.ctx.globalState.update(K.AVATARS, { ...accounts.getAvatars(), [a.id]: fileName });
  } else if (choice.id === 'noimage' && a.avatar) {
    await fs.promises.rm(storageDir('avatars', a.avatar), { force: true });
    const m = { ...accounts.getAvatars() };
    delete m[a.id];
    await rt.ctx.globalState.update(K.AVATARS, m);
  }
  notifyChanged();
}

/** @param {any} [arg] */
async function cmdEditEnv(arg) {
  const a = await accountOrPick(arg, t('Edit the environment variables of which account?'));
  if (!a) return;
  let dirty = false;
  for (;;) {
    if (accounts.secretsPending(a.id)) await accounts.loadSecrets(a.id);
    const spec = accounts.envSpec(a.id);
    const values = accounts.envOf(a.id);
    const items = Object.entries(spec).map(([k, s]) => ({
      label: (s.secret ? '$(lock) ' : '') + k,
      description: s.secret ? '••••••••' : s.value,
      key: k,
      secret: !!s.secret,
    }));
    items.push({ label: '$(add) ' + t('Add variable...'), description: '', key: null, secret: false });
    items.push({
      label: '$(lock) ' + t('Add secret variable...'),
      description: t('kept in VS Code secret storage'),
      key: null,
      secret: true,
    });
    const p = await vscode.window.showQuickPick(items, {
      placeHolder: t(
        'Variables of "{0}": they apply to every extension and terminal of a window using this account. Kept on this machine only.',
        a.name
      ),
    });
    if (!p) break;

    let name = p.key;
    if (!name) {
      name = await vscode.window.showInputBox({
        prompt: t('Variable name'),
        validateInput: (v) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim())) return t('Use letters, digits and underscores, not starting with a digit.');
          if (accounts.BLOCKED_ENV.test(v.trim())) return t('{0} cannot be set per account.', v.trim());
          return null;
        },
      });
      if (!name) continue;
      name = name.trim();
    }
    const secret = p.key ? p.secret : p.secret || accounts.SECRET_NAME.test(name);
    const value = await vscode.window.showInputBox({
      prompt: p.key ? t('New value for {0}. Leave empty to remove it.', name) : t('Value for {0}', name),
      value: p.key && !secret ? values[name] : '',
      password: secret,
    });
    if (value === undefined) continue;
    if (value === '' && p.key) await accounts.removeEnvVar(a.id, name);
    else if (value !== '') await accounts.setEnvVar(a.id, name, value, secret);
    else continue;
    dirty = true;
    rt.log.info(`Environment of ${a.id}: ${value === '' ? 'removed' : 'set'} ${name}${secret ? ' (secret)' : ''}`);
  }
  if (dirty && accounts.selectedAccount().id === a.id) {
    env.applyEnv(/** @type {Account} */ (accounts.findAccount(a.id)));
    await maybeReload(t('Environment variables of "{0}" updated.', a.name));
  }
}

// Rules that name the account by id, name or e-mail.
/** @param {Account} a */
function rulesFor(a) {
  const email = (accounts.getIdentity(a.id)?.email || '').toLowerCase();
  const refs = new Set([a.id.toLowerCase(), a.name.toLowerCase(), ...(email ? [email] : [])]);
  const rules = Array.isArray(cfg('rules')) ? cfg('rules') : [];
  return rules.filter((r) => r && refs.has(String(r.account || '').toLowerCase()));
}

/** @param {any} [arg] */
async function cmdRemove(arg) {
  const a = await accountOrPick(arg, t('Remove which account?'));
  if (!a) return;
  if (a.id === DEFAULT_ID) throw new Error(t('The Default account cannot be removed.'));
  const keepBtn = t('Remove (keep folder)');
  const deleteBtn = t('Remove and move folder to trash');
  const rules = rulesFor(a);
  const detail = [
    t('Folder: {0}', a.dir),
    t('~/.claude is never deleted; shared links are undone before anything is deleted. Close other windows that use this account first.'),
    ...(rules.length ? [t('Default-account rules that point to it are removed too: {0}', rules.map((r) => r.pattern).join(', '))] : []),
  ].join('\n\n');
  const choice = await vscode.window.showWarningMessage(t('Remove account "{0}"?', a.name), { modal: true, detail }, keepBtn, deleteBtn);
  if (!choice) return;
  const wasCurrent = accounts.selectedAccount().id === a.id;

  await accounts.saveRecords(accounts.getRecords().filter((x) => x.id !== a.id));
  const map = { ...repo.getRepoDefaults() };
  for (const k of Object.keys(map)) {
    const v = map[k];
    if ((typeof v === 'string' ? v : v?.id) === a.id) delete map[k];
  }
  await repo.saveRepoDefaults(map);
  if (rules.length) {
    const info = vscode.workspace.getConfiguration('claudeAccounts').inspect('rules');
    if (Array.isArray(info?.globalValue)) {
      const keep = info.globalValue.filter((r) => !rules.includes(r));
      await vscode.workspace
        .getConfiguration('claudeAccounts')
        .update('rules', keep.length ? keep : undefined, vscode.ConfigurationTarget.Global);
    }
  }
  await accounts.removeAllEnv(a.id);
  const meta = { ...accounts.getMeta() };
  delete meta[a.id];
  await rt.ctx.globalState.update(K.META, meta);
  if (a.avatar) await fs.promises.rm(storageDir('avatars', a.avatar), { force: true });
  const avatars = { ...accounts.getAvatars() };
  delete avatars[a.id];
  await rt.ctx.globalState.update(K.AVATARS, avatars);
  await accounts.setIdentity(a.id, null);
  await accounts.setLimit(a.id, null);
  await profile.setMirrored(a.id, null);
  rt.log.info(`Account removed: ${a.id}`);

  let outcome = 'kept';
  if (choice === deleteBtn && a.dir) outcome = await profile.removeAccountDir(a.dir);
  notifyChanged();
  if (wasCurrent) await selectAccount(accounts.defaultAccount(), t('previous account removed'));
  else if (outcome === 'trash') vscode.window.showInformationMessage(t('Account "{0}" removed. Its folder is in the trash.', a.name));
  else vscode.window.showInformationMessage(t('Account "{0}" removed.', a.name));
}

/** @param {any} [arg] */
async function cmdToIsolated(arg) {
  const a = await accountOrPick(arg, t('Isolate which account?'));
  if (!a || !a.dir) return;
  const copied = await profile.toIsolated(a);
  const extra = copied.length ? ' ' + t('Independent copies created: {0}.', copied.join(', ')) : '';
  vscode.window.showInformationMessage(t('"{0}" now uses an isolated profile.', a.name) + extra);
}

/** @param {any} [arg] */
async function cmdToShared(arg) {
  const a = await accountOrPick(arg, t('Share the profile with which account?'));
  if (!a || !a.dir) return;
  const switchBtn = t('Switch');
  const ok = await vscode.window.showWarningMessage(
    t('Switch "{0}" to a shared profile?', a.name),
    {
      modal: true,
      detail: t(
        'Items this account has its own version of that are in the shared list will be renamed to .bak and replaced by links to ~/.claude.'
      ),
    },
    switchBtn
  );
  if (ok !== switchBtn) return;
  const r = await profile.toShared(a);
  vscode.window.showInformationMessage(t('"{0}" now uses a shared profile.', a.name) + profile.describe(r));
}

/** @param {any} [arg] */
async function cmdRelink(arg) {
  const a = await accountOrPick(arg, t('Relink which account?'));
  if (!a || !a.dir) return;
  const r = await profile.relink(a);
  await profile.mirrorMcp(a).catch((e) => rt.log.warn(`MCP mirror for ${a.id}: ${e}`));
  vscode.window.showInformationMessage(t('Items relinked in "{0}".', a.name) + profile.describe(r));
  await health.refresh();
}

/** @param {any} [arg] */
async function cmdOpenFolder(arg) {
  const a = await accountOrPick(arg, t('Open the folder of which account?'));
  if (!a) return;
  await vscode.env.openExternal(vscode.Uri.file(accounts.configDirOf(a)));
}

/** @param {any} [arg] */
async function cmdManage(arg) {
  let a = arg ? accountArg(arg) : null;
  if (!a) {
    const r = await pick(
      accounts.allAccounts().map((x) => accountItem(x)),
      t('Which account?')
    );
    if (!r) return;
    a = r.item.account;
    if (r.button) return runAccountAction(r.button.action, a);
  }
  const acc = /** @type {Account} */ (a);
  const actions = [];
  if (acc.id !== accounts.selectedAccount().id)
    actions.push({ label: '$(arrow-swap) ' + t('Switch to it'), run: () => selectAccount(acc) });
  if (acc.kind === 'subscription') actions.push({ label: '$(key) ' + t('Log in'), run: () => cmdLogin(acc) });
  actions.push(
    { label: '$(terminal) ' + t('Open terminal as this account'), run: () => cmdOpenTerminal(acc) },
    { label: '$(edit) ' + t('Rename'), run: () => cmdRename(acc) },
    { label: '$(symbol-color) ' + t('Appearance (color, icon, image)'), run: () => cmdAppearance(acc) },
    { label: '$(symbol-variable) ' + t('Environment variables'), run: () => cmdEditEnv(acc) }
  );
  if (repo.getRepos().length)
    actions.push({ label: '$(pin) ' + t('Make it the default for this repository'), run: () => cmdSetRepoDefault(acc) });
  if (acc.id !== DEFAULT_ID) {
    actions.push(
      acc.mode === 'shared'
        ? { label: '$(lock) ' + t('Switch to isolated profile'), run: () => cmdToIsolated(acc) }
        : { label: '$(link) ' + t('Switch to shared profile'), run: () => cmdToShared(acc) }
    );
    if (acc.mode === 'shared' || profile.historyItems().length)
      actions.push({ label: '$(sync) ' + t('Relink shared items'), run: () => cmdRelink(acc) });
  }
  actions.push({ label: '$(folder-opened) ' + t('Open account folder'), run: () => cmdOpenFolder(acc) });
  if (acc.id !== DEFAULT_ID) actions.push({ label: '$(trash) ' + t('Remove'), run: () => cmdRemove(acc) });
  const act = await vscode.window.showQuickPick(actions, { placeHolder: acc.name });
  if (act) await act.run();
}

// ───────── repositories & rules ─────────

/** @param {any} [arg] */
async function cmdSetRepoDefault(arg) {
  repo.detectRepos();
  const r = await repo.pickRepo(t('Set the default account of which folder?'));
  if (!r) {
    if (!repo.getRepos().length) vscode.window.showWarningMessage(t('Open a folder to set a default account.'));
    return;
  }
  const acc = arg ? accountArg(arg) : await pickAccount(t('Default account for {0}', r.label));
  if (!acc) return;
  await repo.saveRepoDefaults({ ...repo.getRepoDefaults(), [r.key]: repo.storedValueFor(acc) });
  await rt.ctx.workspaceState.update(K.LAST_APPLIED, acc.id);
  rt.log.info(`Repository default: ${r.key} -> ${acc.id}`);
  if (accounts.selectedAccount().id !== acc.id) await selectAccount(acc, t('repository default'));
  else vscode.window.showInformationMessage(t('"{0}" is now the default account for this repository.', acc.name));
}

async function cmdClearRepoDefault() {
  repo.detectRepos();
  const r = await repo.pickRepo(t('Clear the default account of which folder?'));
  if (!r) return;
  const map = { ...repo.getRepoDefaults() };
  for (const k of Object.keys(map)) if (k === r.key || (k.startsWith('path:') && samePath(k.slice(5), r.key.slice(5)))) delete map[k];
  await repo.saveRepoDefaults(map);
  await rt.ctx.workspaceState.update(K.LAST_APPLIED, undefined);
  vscode.window.showInformationMessage(t('Default account for this repository removed.'));
}

async function cmdAddRule() {
  repo.detectRepos();
  const r = await repo.pickRepo(t('Base the rule on which folder?'));
  if (!r) {
    vscode.window.showWarningMessage(t('Open a folder to set a default account.'));
    return;
  }
  const options = [];
  if (r.remote) {
    const parts = normalizeRemote(r.remote).split('/');
    if (parts.length >= 3) {
      const org = parts.slice(0, -1).join('/');
      options.push({ label: t('Every repository of {0}', org), detail: org, pattern: org });
    }
  }
  const parent = path.dirname(r.root || r.folder);
  options.push({ label: t('Every folder under {0}', tildify(parent)), detail: tildify(parent), pattern: tildify(parent) });
  options.push({ label: '$(edit) ' + t('Custom pattern...'), detail: undefined, pattern: null });

  const o = await vscode.window.showQuickPick(options, { placeHolder: t('Which repositories should this rule cover?') });
  if (!o) return;
  let pattern = o.pattern;
  if (!pattern) {
    pattern = await vscode.window.showInputBox({
      prompt: t('Folder pattern (e.g. ~/work/**) or remote pattern (e.g. github.com/my-company/*)'),
      validateInput: (v) => (v.trim() ? null : t('Enter a pattern')),
    });
    if (!pattern) return;
    pattern = pattern.trim();
  }
  const acc = await pickAccount(t('Account for {0}', pattern));
  if (!acc) return;
  const current = vscode.workspace.getConfiguration('claudeAccounts').inspect('rules')?.globalValue;
  const rules = [...(Array.isArray(current) ? current : []).filter((x) => x?.pattern !== pattern), { pattern, account: acc.id }];
  await vscode.workspace.getConfiguration('claudeAccounts').update('rules', rules, vscode.ConfigurationTarget.Global);
  await rt.ctx.workspaceState.update(K.LAST_APPLIED, undefined);
  rt.log.info(`Rule added: ${pattern} -> ${acc.id}`);
  const editBtn = t('Edit rules');
  vscode.window
    .showInformationMessage(
      t('Rule added: {0} → {1}. A repository default set for a specific repository still wins.', pattern, acc.name),
      editBtn
    )
    .then(
      (b) =>
        b === editBtn &&
        vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'claudeAccounts.rules' } })
    );
  await autoApply();
}

// ───────── usage ─────────

async function cmdShowUsage() {
  const shared = !!cfg('shareHistory');
  const targets = shared ? [accounts.selectedAccount()] : accounts.allAccounts();
  await quota.refreshAllQuota();
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Reading local session logs...') },
    () => Promise.all(targets.map(async (a) => ({ a, u: await usage.computeUsage(a).catch(() => null) })))
  );
  const items = results.map(({ a, u }) => {
    const q = f.quotaLine(a.id);
    const lim = f.limitLine(a.id);
    return {
      label: shared ? t('All accounts (history is shared)') : a.name,
      description: [
        u ? t('today: {0} · 7 days: {1}', formatTokens(totalTokens(u.today)), formatTokens(totalTokens(u.week))) : t('no data'),
        q,
        lim,
      ]
        .filter(Boolean)
        .join(' · '),
      detail: u
        ? t(
            '7 days: input {0} · output {1} · cache write {2} · cache read {3} · {4} responses',
            formatTokens(u.week.input),
            formatTokens(u.week.output),
            formatTokens(u.week.cacheWrite),
            formatTokens(u.week.cacheRead),
            u.week.messages
          )
        : undefined,
    };
  });
  if (shared && quota.enabled()) {
    for (const a of accounts.allAccounts()) {
      const q = f.quotaLine(a.id);
      if (q) items.push({ label: a.name, description: q, detail: undefined });
    }
  }
  await vscode.window.showQuickPick(items, {
    placeHolder: shared
      ? t('Usage cannot be split by account while history is shared.')
      : t('Tokens recorded on this machine (local logs only; other devices are not included).'),
  });
}

// ───────── history ─────────

async function cmdToggleHistory() {
  const enabled = !!cfg('shareHistory');
  const list = accounts.getAccounts().filter((a) => a.dir);
  const items = profile.configuredHistoryItems();

  if (!enabled) {
    const shareBtn = t('Share');
    const ok = await vscode.window.showWarningMessage(
      t('Share history across all accounts?'),
      {
        modal: true,
        detail: t(
          'Items: {0}.\n\nThe history each account already has is merged into ~/.claude (nothing is deleted; conflicting files are kept alongside with the suffix .conflict-<account>, and replaced files are backed up in {1}), and every account will see the same conversations.\n\nClose the Claude Code panel in other windows before continuing.',
          items.join(', '),
          tildify(path.join(accountsRoot(), '.backups'))
        ),
      },
      shareBtn
    );
    if (ok !== shareBtn) return;
    const { result, backupDir } = await profile.shareHistory(list);
    const extra = [
      result.merged ? t('{0} items merged.', result.merged) : '',
      result.conflicts.length ? t('Conflicts: {0}.', result.conflicts.join(', ')) : '',
      result.skipped.filter((s) => s.reason !== 'missing').length
        ? t(
            'Skipped: {0}.',
            result.skipped
              .filter((s) => s.reason !== 'missing')
              .map(profile.skippedText)
              .join('; ')
          )
        : '',
      backupDir ? t('Backups: {0}.', backupDir) : '',
    ]
      .filter(Boolean)
      .join(' ');
    return maybeReload(t('History shared across {0} accounts.', list.length + 1) + (extra ? ' ' + extra : ''));
  }

  const copyBtn = t('Copy current history');
  const emptyBtn = t('Start empty');
  const choice = await vscode.window.showWarningMessage(
    t('Stop sharing history?'),
    { modal: true, detail: t('~/.claude keeps all current history. The other accounts can get a copy of it or start empty.') },
    copyBtn,
    emptyBtn
  );
  if (!choice) return;
  await profile.unshareHistory(list, choice === copyBtn);
  return maybeReload(t('History is no longer shared.'));
}

// ───────── import of existing folders ─────────

// Account folders that are not registered (e.g. created by an earlier install).
function findUnregisteredDirs() {
  const root = accountsRoot();
  if (!fs.existsSync(root)) return [];
  const known = accounts.getRecords();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter((d) => !known.some((a) => samePath(a.dir, d)) && !samePath(d, baseDir()));
}

async function cmdImport({ prompt = false } = {}) {
  const found = findUnregisteredDirs();
  if (!found.length) {
    if (!prompt) vscode.window.showInformationMessage(t('No unregistered account folders found in {0}.', accountsRoot()));
    return;
  }
  if (prompt) {
    const importBtn = t('Import');
    const res = await vscode.window.showInformationMessage(
      t('Found {0} account folder(s) in {1} that are not registered. Import them?', found.length, accountsRoot()),
      importBtn,
      t('Not now')
    );
    if (res !== importBtn) return;
  }
  const items = Array.isArray(cfg('sharedItems')) ? cfg('sharedItems') : [];
  const taken = new Set([DEFAULT_ID, ...accounts.getRecords().map((r) => r.id)]);
  const imported = [];
  for (const d of found) {
    const base = path.basename(d);
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    taken.add(id);
    let shared = false;
    for (const i of items) if (await isLinkedTo(path.join(d, i), path.join(baseDir(), i))) shared = true;
    imported.push({ id, dir: d, mode: /** @type {'shared' | 'isolated'} */ (shared ? 'shared' : 'isolated') });
  }
  await accounts.saveRecords([...accounts.getRecords(), ...imported]);
  rt.log.info(`Imported: ${imported.map((a) => a.id).join(', ')}`);
  await identity.refreshAllIdentities();
  notifyChanged();
  vscode.window.showInformationMessage(t('Imported: {0}. Use "Manage accounts" to rename them.', imported.map((a) => a.id).join(', ')));
}

// ───────── live quota ─────────

async function cmdToggleLiveQuota() {
  const on = !quota.enabled();
  if (on) {
    const enable = t('Turn on');
    const ok = await vscode.window.showInformationMessage(
      t('Turn on live quota?'),
      {
        modal: true,
        detail: t(
          'Claude Code passes your 5-hour and weekly usage to its status line. To read it, the extension wraps the statusLine command in settings.json with a small script that saves that input in the account folder and then runs your own status line unchanged. Turning this off restores your status line.\n\nQuota appears after the claude CLI shows its status line (for example in a terminal), for Pro and Max subscriptions.'
        ),
      },
      enable
    );
    if (ok !== enable) return;
  }
  await vscode.workspace.getConfiguration('claudeAccounts').update('liveQuota', on, vscode.ConfigurationTarget.Global);
  // The configuration listener installs or removes the bridge.
}

async function onLiveQuotaChanged() {
  const errors = await quota.syncBridge();
  await quota.refreshAllQuota();
  if (errors.length) vscode.window.showWarningMessage(t('Live quota could not update some settings files: {0}', errors.join('; ')));
  else if (quota.enabled())
    vscode.window.showInformationMessage(t('Live quota is on. Usage appears after the claude CLI next shows its status line.'));
}

// ───────── health checks that need the profile module ─────────

health.addProvider(async () => {
  /** @type {import('./health').Issue[]} */
  const out = [];
  const cur = accounts.selectedAccount();
  const broken = await profile.brokenShares(cur);
  if (broken.length) {
    out.push({
      id: 'broken',
      message: t(
        'Account "{0}" is not linked to these shared items: {1}. This happens when an item is created in ~/.claude later or gets rewritten over the link.',
        cur.name,
        broken.join(', ')
      ),
      actions: [{ title: t('Relink'), run: () => cmdRelink(cur) }],
    });
  }
  const refused = profile.refusedItems();
  if (refused.length) {
    out.push({
      id: 'refused',
      message: t(
        'These entries in claudeAccounts.sharedItems are never shared: {0}.',
        refused.map((r) => profile.skippedText(r)).join('; ')
      ),
      actions: [
        {
          title: t('Open settings'),
          run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeAccounts.sharedItems'),
        },
      ],
    });
  }
  const dups = health.duplicateLogins();
  if (dups.length) {
    out.push({
      id: 'duplicates',
      message: t(
        'These accounts are logged in to the same e-mail: {0}. Log in to a different account in one of them.',
        dups.map((d) => d.names.join(' + ')).join('; ')
      ),
      actions: [{ title: t('Log in...'), run: () => cmdLogin() }],
    });
  }
  if (cur.dir && !fs.existsSync(cur.dir)) {
    out.push({
      id: 'missingDir',
      message: t('The folder of "{0}" does not exist: {1}', cur.name, cur.dir),
      actions: [{ title: t('Manage accounts...'), run: () => cmdManage(cur) }],
    });
  }
  return out;
});

module.exports = {
  accountArg,
  cmdSwitch,
  cmdSwitchToPrevious,
  cmdAdd,
  cmdLogin,
  onTerminalClosed,
  cmdOpenTerminal,
  cmdRename,
  cmdAppearance,
  cmdEditEnv,
  cmdRemove,
  cmdToIsolated,
  cmdToShared,
  cmdRelink,
  cmdOpenFolder,
  cmdManage,
  cmdSetRepoDefault,
  cmdClearRepoDefault,
  cmdAddRule,
  cmdShowUsage,
  cmdToggleHistory,
  findUnregisteredDirs,
  cmdImport,
  cmdToggleLiveQuota,
  onLiveQuotaChanged,
  rulesFor,
};
