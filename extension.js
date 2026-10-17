'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { execFile } = require('child_process');
const { normalizeRemote, matchRule } = require('./lib/rules');
const { readIdentity, identityFiles, mtimeKey } = require('./lib/identity');
const { encodeProjectDir, isRateLimitEntry, summarizeUsage, formatTokens, totalTokens, TailReader } = require('./lib/usage');

const t = (message, ...args) => vscode.l10n.t(message, ...args);

const DEFAULT_ID = '__default__';
const K_ACCOUNTS = 'accounts'; // local: [{ id, dir, mode }]
const K_META = 'accountMeta'; // synced: { [id]: { name, color, icon } }
const K_ENV = 'accountEnv'; // local: { [id]: { NAME: value } } (may hold secrets, never synced)
const K_AVATARS = 'accountAvatars'; // local: { [id]: fileName }
const K_REPO_DEFAULTS = 'repoDefaults'; // synced
const K_LAST_APPLIED = 'lastAppliedRepoDefault';
const K_SELECTED = 'selectedAccount';
const K_PREVIOUS = 'previousAccount';
const K_IMPORT_PROMPTED = 'importPrompted';
const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR; // value VS Code was launched with

const COLORS = ['orange', 'green', 'blue', 'purple', 'pink', 'yellow', 'teal', 'red'];
const ICONS = [
  'account', 'briefcase', 'home', 'organization', 'rocket', 'beaker', 'code', 'terminal',
  'heart', 'star-full', 'flame', 'zap', 'globe', 'coffee', 'mortar-board', 'shield',
];

let ctx;
let statusItem;
let currentRepo = null;
const identityCache = new Map(); // id -> { key, data }
let usageCache = null; // { at, accountId, data }

// ───────────────────────── utilities ─────────────────────────

const cfg = (k) => vscode.workspace.getConfiguration('claudeAccounts').get(k);
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const homeClaudeDir = () => path.join(os.homedir(), '.claude');
const accountsRoot = () => expandHome(cfg('accountsRoot')) || path.join(os.homedir(), '.claude-accounts');
const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const folderPath = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

function samePath(a, b) {
  if (!a || !b) return false;
  const n = (p) => path.resolve(expandHome(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

function slugify(name) {
  return (
    name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
  );
}

function initials(name) {
  const words = String(name).replace(/[()~/.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

const isCodicon = (icon) => ICONS.includes(icon) || /^[a-z][a-z0-9-]*$/.test(icon || '');
const themeColor = (c) => (c && COLORS.includes(c) ? new vscode.ThemeColor(`claudeAccounts.${c}`) : undefined);

// ───────────────────────── accounts & metadata ─────────────────────────

const getMeta = () => ctx.globalState.get(K_META, {});
const getEnvMap = () => ctx.globalState.get(K_ENV, {});
const getAvatars = () => ctx.globalState.get(K_AVATARS, {});

async function updateMeta(id, patch) {
  const meta = { ...getMeta() };
  meta[id] = { ...(meta[id] || {}), ...patch };
  for (const k of Object.keys(meta[id])) if (meta[id][k] === undefined) delete meta[id][k];
  await ctx.globalState.update(K_META, meta);
}

function decorate(rec) {
  const m = getMeta()[rec.id] || {};
  return {
    ...rec,
    name: m.name || rec.name || rec.id,
    color: m.color,
    icon: m.icon,
    env: getEnvMap()[rec.id] || {},
    avatar: getAvatars()[rec.id],
  };
}

function defaultAccount() {
  return decorate({ id: DEFAULT_ID, name: t('Default (~/.claude)'), dir: null, mode: 'original' });
}
const getRecords = () => ctx.globalState.get(K_ACCOUNTS, []);
const saveRecords = (list) => ctx.globalState.update(K_ACCOUNTS, list.map(({ id, dir, mode }) => ({ id, dir, mode })));
const getAccounts = () => getRecords().map(decorate);
const allAccounts = () => [defaultAccount(), ...getAccounts()];
const findAccount = (id) => allAccounts().find((a) => a.id === id);
const getRepoDefaults = () => ctx.globalState.get(K_REPO_DEFAULTS, {});
const saveRepoDefaults = (m) => ctx.globalState.update(K_REPO_DEFAULTS, m);

// 1.0 kept the name inside the local record; 1.1 keeps it in synced metadata.
async function migrate() {
  const recs = getRecords();
  if (!recs.some((r) => r.name)) return;
  const meta = { ...getMeta() };
  for (const r of recs) if (r.name && !meta[r.id]?.name) meta[r.id] = { ...(meta[r.id] || {}), name: r.name };
  await ctx.globalState.update(K_META, meta);
  await saveRecords(recs);
}

function findAccountByRef(ref) {
  if (!ref) return null;
  const s = String(ref).toLowerCase();
  return allAccounts().find((a) => a.id.toLowerCase() === s) || allAccounts().find((a) => a.name.toLowerCase() === s) || null;
}

function modeLabel(m) {
  if (m === 'shared') return t('shared profile');
  if (m === 'isolated') return t('isolated profile');
  if (m === 'original') return t('original');
  return '?';
}

const configDirOf = (a) => a.dir || ORIGINAL_ENV || homeClaudeDir();

// Where the selection is remembered: per workspace (each window/repo) or globally.
const store = () => (cfg('scope') === 'user' ? ctx.globalState : ctx.workspaceState);
const selectedAccount = () => findAccount(store().get(K_SELECTED)) || defaultAccount();

// CLAUDE_CONFIG_DIR in claudeCode.environmentVariables (User settings) takes precedence
// over the process environment and would defeat switching.
function overridingSetting() {
  const list = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables');
  if (!Array.isArray(list)) return null;
  const e = list.find((v) => v && v.name === 'CLAUDE_CONFIG_DIR');
  return e && e.value ? e.value : null;
}

// ───────────────────────── applying an account ─────────────────────────

const touchedEnv = new Map(); // variable -> value before this extension changed it

function setProcessEnv(name, value) {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  if (value === undefined) {
    const orig = touchedEnv.get(name);
    if (orig === undefined) delete process.env[name];
    else process.env[name] = orig;
  } else {
    process.env[name] = value;
  }
}

function desiredEnv(account) {
  const env = { ...(account.env || {}) };
  delete env.CLAUDE_CONFIG_DIR;
  if (account.dir) env.CLAUDE_CONFIG_DIR = account.dir;
  return env;
}

function applyEnv(account) {
  // The window's extension host: the Claude Code extension inherits this environment
  // when it starts the CLI. Every VS Code window has its own extension host.
  const env = desiredEnv(account);
  for (const name of touchedEnv.keys()) if (!(name in env)) setProcessEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) setProcessEnv(name, value);

  // Integrated terminals of this window.
  const coll = ctx.environmentVariableCollection;
  coll.persistent = false;
  coll.clear();
  if (cfg('applyToTerminal')) {
    for (const [name, value] of Object.entries(env)) coll.replace(name, value);
    coll.description = t('Claude Code account: {0}', account.name);
  }
}

async function selectAccount(account, reason, { reload = true } = {}) {
  const prev = selectedAccount();
  if (prev.id !== account.id) await store().update(K_PREVIOUS, prev.id);
  await store().update(K_SELECTED, account.id);
  applyEnv(account);
  updateStatus();
  const msg = reason
    ? t('Claude Code account: {0} ({1}).', account.name, reason)
    : t('Claude Code account: {0}.', account.name);
  if (reload) return maybeReload(msg);
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(
    t('{0} If the Claude Code panel was already open, reload the window.', msg), reloadBtn);
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function maybeReload(msg) {
  const b = cfg('reloadBehavior');
  if (b === 'always') return vscode.commands.executeCommand('workbench.action.reloadWindow');
  if (b === 'never') {
    vscode.window.showInformationMessage(t('{0} Reload the window for Claude Code to use the new account.', msg));
    return;
  }
  const reloadBtn = t('Reload');
  const pick = await vscode.window.showInformationMessage(t('{0} Reload the window now?', msg), reloadBtn, t('Later'));
  if (pick === reloadBtn) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function checkOverridingSetting() {
  const dir = overridingSetting();
  if (!dir) return;
  const removeBtn = t('Remove that entry');
  const pick = await vscode.window.showWarningMessage(
    t('Your user settings set CLAUDE_CONFIG_DIR={0} in claudeCode.environmentVariables. It takes precedence and makes every window use that folder, ignoring account switching.', dir),
    removeBtn,
    t('Ignore')
  );
  if (pick !== removeBtn) return;
  const c = vscode.workspace.getConfiguration('claudeCode');
  const list = (c.inspect('environmentVariables')?.globalValue || []).filter((v) => v && v.name !== 'CLAUDE_CONFIG_DIR');
  await c.update('environmentVariables', list.length ? list : undefined, vscode.ConfigurationTarget.Global);
  updateStatus();
  await maybeReload(t('Entry removed.'));
}

// ───────────────────────── shared items (links) ─────────────────────────

const historyItems = () => (cfg('shareHistory') ? cfg('historyItems') || [] : []);
// Config items for shared-profile mode (history is handled separately).
const configItems = () => (cfg('sharedItems') || []).filter((i) => !(cfg('historyItems') || []).includes(i));

function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p); // Windows junctions; removes only the link, never the target
  }
}

function isLinkedTo(d, s) {
  try {
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink()) return samePath(fs.realpathSync(d), fs.realpathSync(s));
    if (st.isFile()) {
      const a = fs.statSync(d, { bigint: true });
      const b = fs.statSync(s, { bigint: true });
      return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev; // hard link
    }
  } catch {
    /* does not exist */
  }
  return false;
}

function moveFs(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// Moves the account's content (from) into ~/.claude (to), merging without overwriting.
function mergeInto(from, to, tag, out) {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) { removeLink(from); return; }
  if (st.isDirectory()) {
    if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); moveFs(from, to); out.merged++; return; }
    for (const e of fs.readdirSync(from)) mergeInto(path.join(from, e), path.join(to, e), tag, out);
    fs.rmSync(from, { recursive: true, force: true });
    return;
  }
  if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); moveFs(from, to); out.merged++; return; }
  const extra = fs.readFileSync(from);
  const existing = fs.readFileSync(to);
  if (extra.equals(existing)) { fs.unlinkSync(from); return; }
  if (to.endsWith('.jsonl')) {
    // Line logs (sessions, prompt history): append what is missing.
    const have = new Set(existing.toString('utf8').split('\n'));
    const add = extra.toString('utf8').split('\n').filter((l) => l && !have.has(l));
    if (add.length) {
      const sep = existing.length && existing[existing.length - 1] !== 0x0a ? '\n' : '';
      fs.appendFileSync(to, sep + add.join('\n') + '\n');
    }
    fs.unlinkSync(from);
    out.merged++;
    return;
  }
  const conflict = `${to}.conflict-${tag}`;
  moveFs(from, conflict);
  out.conflicts.push(path.basename(conflict));
}

function linkItems(dir, items, { replaceLocal = false, merge = false, tag = 'account' } = {}) {
  const src = homeClaudeDir();
  const out = { linked: [], copied: [], skipped: [], backedUp: [], merged: 0, conflicts: [] };
  for (const item of items) {
    const s = path.join(src, item);
    const d = path.join(dir, item);
    if (isLinkedTo(d, s)) { out.linked.push(item); continue; }

    let st = null;
    try { st = fs.lstatSync(d); } catch { /* does not exist */ }
    if (st && st.isSymbolicLink()) { removeLink(d); st = null; }

    if (!fs.existsSync(s)) {
      if (!merge) { out.skipped.push(t('{0} (not present in ~/.claude)', item)); continue; }
      fs.mkdirSync(src, { recursive: true });
      if (st) { moveFs(d, s); st = null; out.merged++; }
      else if (path.extname(item)) fs.writeFileSync(s, '');
      else fs.mkdirSync(s, { recursive: true });
    }

    if (st) {
      if (merge) mergeInto(d, s, tag, out);
      else if (replaceLocal) { const bak = `${d}.bak-${timestamp()}`; fs.renameSync(d, bak); out.backedUp.push(path.basename(bak)); }
      else { out.skipped.push(t('{0} (this account already has its own version)', item)); continue; }
    }

    const isDir = fs.statSync(s).isDirectory();
    try {
      fs.symlinkSync(s, d, isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      out.linked.push(item);
    } catch (e) {
      if (isDir) { out.skipped.push(`${item} (${e.code || e.message})`); continue; }
      try { fs.linkSync(s, d); out.linked.push(item); } // Windows without symlink permission
      catch {
        if (merge) { out.skipped.push(t('{0} (could not create link)', item)); continue; }
        fs.copyFileSync(s, d); out.copied.push(item);
      }
    }
  }
  return out;
}

const linkSharedItems = (dir, opts) => linkItems(dir, configItems(), opts);
const linkHistory = (dir, tag) => linkItems(dir, historyItems(), { merge: true, tag });

// Undoes links. copy=true creates independent copies; copy=false leaves the account empty.
function unlinkItems(dir, items, { copy = true } = {}) {
  const src = homeClaudeDir();
  const done = [];
  for (const item of items) {
    const s = path.join(src, item);
    const d = path.join(dir, item);
    if (!isLinkedTo(d, s)) continue;
    if (fs.lstatSync(d).isSymbolicLink()) removeLink(d); else fs.unlinkSync(d);
    if (copy) fs.cpSync(s, d, { recursive: true });
    done.push(item);
  }
  return done;
}
const unlinkSharedItems = (dir) => unlinkItems(dir, configItems());

function brokenShares(account) {
  if (!account || !account.dir) return [];
  const src = homeClaudeDir();
  const cfgBroken = account.mode === 'shared'
    ? configItems().filter((i) => fs.existsSync(path.join(src, i)) && !isLinkedTo(path.join(account.dir, i), path.join(src, i)))
    : [];
  const histBroken = historyItems().filter((i) => !isLinkedTo(path.join(account.dir, i), path.join(src, i)));
  return [...cfgBroken, ...histBroken];
}

function removeAccountDir(dir) {
  // Remove links before deleting so ~/.claude is never followed into.
  if (!fs.existsSync(dir) || samePath(dir, homeClaudeDir()) || samePath(dir, os.homedir()) || path.dirname(path.resolve(dir)) === path.resolve(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    try { if (fs.lstatSync(p).isSymbolicLink()) removeLink(p); } catch { /* ignore */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function describe(r) {
  const parts = [];
  if (r.linked.length) parts.push(t('Shared: {0}.', r.linked.join(', ')));
  if (r.copied.length) parts.push(t('Copied (no link possible, will not sync): {0}.', r.copied.join(', ')));
  if (r.backedUp.length) parts.push(t('Backups: {0}.', r.backedUp.join(', ')));
  if (r.merged) parts.push(t('History items merged: {0}.', r.merged));
  if (r.conflicts.length) parts.push(t('Conflicts kept next to the original: {0}.', r.conflicts.join(', ')));
  if (r.skipped.length) parts.push(t('Skipped: {0}.', r.skipped.join('; ')));
  return parts.length ? ' ' + parts.join(' ') : '';
}

// ───────────────────────── repository & rules ─────────────────────────

async function detectRepo() {
  const folder = folderPath();
  if (!folder) return null;
  const [remote, root] = await Promise.all([
    git(['config', '--get', 'remote.origin.url'], folder),
    git(['rev-parse', '--show-toplevel'], folder),
  ]);
  const rootPath = root ? path.resolve(root) : null;
  const base = { folder, remote: remote || null, root: rootPath };
  if (remote) return { ...base, key: 'remote:' + normalizeRemote(remote), label: remote };
  const p = rootPath || folder;
  return { ...base, key: 'path:' + (process.platform === 'win32' ? p.toLowerCase() : p), label: p };
}

// Explicit repository default wins; otherwise the first matching rule.
function resolveDefault() {
  if (!currentRepo) return null;
  const id = getRepoDefaults()[currentRepo.key];
  const repoAcc = id && findAccount(id);
  if (repoAcc) return { account: repoAcc, source: 'repo' };
  const rule = matchRule(cfg('rules'), {
    folder: currentRepo.folder,
    remote: currentRepo.remote,
    home: os.homedir(),
    platform: process.platform,
  });
  const ruleAcc = rule && findAccountByRef(rule.account);
  return ruleAcc ? { account: ruleAcc, source: 'rule', pattern: rule.pattern } : null;
}

async function autoApply() {
  if (!cfg('autoApplyRepoDefault')) return;
  const d = resolveDefault();
  if (!d) return;
  // Only applies when the resolved default changes; manual switches in this window are respected.
  if (ctx.workspaceState.get(K_LAST_APPLIED) === d.account.id) return;
  await ctx.workspaceState.update(K_LAST_APPLIED, d.account.id);
  if (selectedAccount().id === d.account.id) return;
  const reason = d.source === 'rule' ? t('rule {0}', d.pattern) : t('repository default');
  await selectAccount(d.account, reason, { reload: false });
}

// ───────────────────────── identity (plan, e-mail) ─────────────────────────

function identityArgs(a) {
  const dir = configDirOf(a);
  const legacy = a.id === DEFAULT_ID && !ORIGINAL_ENV ? path.join(os.homedir(), '.claude.json') : undefined;
  return { dir, legacy };
}

async function refreshIdentity(a) {
  const { dir, legacy } = identityArgs(a);
  const key = await mtimeKey(identityFiles(dir, legacy));
  const cached = identityCache.get(a.id);
  if (cached && cached.key === key) return cached.data;
  const data = await readIdentity(dir, { legacyJsonPath: legacy });
  identityCache.set(a.id, { key, data });
  return data;
}

async function refreshAllIdentities() {
  await Promise.all(allAccounts().map((a) => refreshIdentity(a).catch(() => null)));
  if (cfg('gravatar')) await Promise.all(allAccounts().map((a) => ensureGravatar(a).catch(() => null)));
  updateStatus();
}

const identityOf = (a) => identityCache.get(a.id)?.data || null;

function identityLine(a) {
  const id = identityOf(a);
  if (!id) return '';
  if (!id.loggedIn) return t('not logged in');
  return [id.email, cfg('showPlan') ? id.plan : null, id.organization].filter(Boolean).join(' · ');
}

// ───────────────────────── avatars ─────────────────────────

const storageDir = (...p) => path.join(ctx.globalStorageUri.fsPath, ...p);

function avatarUri(a) {
  if (a.avatar) {
    const p = storageDir('avatars', a.avatar);
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  if (cfg('gravatar')) {
    const email = identityOf(a)?.email;
    if (email) {
      const p = storageDir('gravatar', gravatarHash(email) + '.png');
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return vscode.Uri.file(p);
    }
  }
  return undefined;
}

const gravatarHash = (email) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

// Opt-in only: the single network request this extension can make.
async function ensureGravatar(a) {
  const email = identityOf(a)?.email;
  if (!email) return;
  const file = storageDir('gravatar', gravatarHash(email) + '.png');
  try {
    const st = fs.statSync(file);
    const maxAge = st.size > 0 ? 7 * 864e5 : 864e5; // empty file = "no gravatar", retry daily
    if (Date.now() - st.mtimeMs < maxAge) return;
  } catch { /* not cached */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const url = `https://www.gravatar.com/avatar/${gravatarHash(email)}?s=64&d=404`;
  const buf = await new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(Buffer.alloc(0)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
  if (buf) fs.writeFileSync(file, buf);
}

// ───────────────────────── usage & limits ─────────────────────────

const projectsDirOf = (a) => path.join(configDirOf(a), 'projects');

async function computeUsage(a) {
  return summarizeUsage(projectsDirOf(a));
}

async function refreshCurrentUsage() {
  const a = selectedAccount();
  try {
    usageCache = { at: Date.now(), accountId: a.id, data: await computeUsage(a) };
    updateStatus();
  } catch { /* best effort */ }
}

let lastLimitPrompt = 0;

async function startLimitWatcher(context) {
  if (!cfg('suggestSwitchOnLimit')) return;
  const folder = folderPath();
  if (!folder) return;
  const account = selectedAccount();
  const configDir = configDirOf(account);
  const encoded = encodeProjectDir(folder);
  const projects = path.join(configDir, 'projects');

  // The file watcher does not follow symlinks, so watch the real projects folder when it exists.
  let base;
  let pattern;
  try {
    base = fs.realpathSync(projects);
    pattern = `${encoded}/**/*.jsonl`;
  } catch {
    if (!fs.existsSync(configDir)) return;
    base = configDir;
    pattern = `projects/${encoded}/**/*.jsonl`;
  }

  const tail = new TailReader();
  const sessionDir = path.join(base, pattern.startsWith('projects/') ? 'projects' : '', encoded);
  try {
    for (const f of fs.readdirSync(sessionDir)) if (f.endsWith('.jsonl')) await tail.prime(path.join(sessionDir, f));
  } catch { /* no sessions yet */ }

  const onFile = async (uri) => {
    const entries = await tail.readNew(uri.fsPath);
    const hit = entries.find((o) => isRateLimitEntry(o) && Date.now() - (Date.parse(o.timestamp) || Date.now()) < 15 * 60e3);
    if (hit) onLimitReached(account).catch(() => null);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern));
  context.subscriptions.push(watcher, watcher.onDidChange(onFile), watcher.onDidCreate(onFile));
}

async function onLimitReached(account) {
  if (Date.now() - lastLimitPrompt < 20 * 60e3) return; // at most once every 20 minutes
  lastLimitPrompt = Date.now();
  const others = allAccounts().filter((a) => a.id !== account.id && identityOf(a)?.loggedIn !== false);
  if (!others.length) return;
  const buttons = others.slice(0, 2).map((a) => ({ title: t('Switch to {0}', a.name), account: a }));
  if (others.length > 2) buttons.push({ title: t('Choose...') });
  const tip = cfg('shareHistory') ? '' : ' ' + t('Tip: turn on shared history to continue the same conversation in the other account.');
  const pick = await vscode.window.showWarningMessage(t('Account "{0}" hit its usage limit.', account.name) + tip, ...buttons);
  if (!pick) return;
  if (pick.account) return selectAccount(pick.account, t('usage limit reached'));
  return cmdSwitch();
}

// ───────────────────────── UI ─────────────────────────

function iconText(a) {
  if (a.icon && !isCodicon(a.icon)) return a.icon; // emoji
  return `$(${a.icon || 'account'})`;
}

function updateStatus() {
  if (!statusItem) return;
  const cur = selectedAccount();
  const override = overridingSetting();
  const id = identityOf(cur);
  const name = cur.id === DEFAULT_ID && !getMeta()[DEFAULT_ID]?.name ? t('default') : cur.name;
  const style = cfg('statusBarStyle');
  let text = style === 'icon' ? iconText(cur) : style === 'initials' ? `${iconText(cur)} ${initials(name)}` : `${iconText(cur)} Claude: ${name}`;
  if (cfg('showPlan') && id?.plan && style !== 'icon') text += ` · ${id.plan}`;
  statusItem.text = (override ? '$(warning) ' : '') + text;
  statusItem.color = themeColor(cur.color);

  const lines = [t('Account: {0}', cur.name)];
  if (id?.email) lines.push(t('E-mail: {0}', id.email));
  if (id?.plan) lines.push(t('Plan: {0}', id.plan));
  if (id?.organization) lines.push(t('Organization: {0}', id.organization));
  if (id && !id.loggedIn) lines.push(t('Not logged in'));
  lines.push(t('Folder: {0}', configDirOf(cur)), t('Mode: {0}', modeLabel(cur.mode)));
  if (cfg('shareHistory')) lines.push(t('History: shared'));
  const d = resolveDefault();
  if (d?.source === 'repo') lines.push(t('Repository default: {0}', d.account.name));
  if (d?.source === 'rule') lines.push(t('Default by rule {0}: {1}', d.pattern, d.account.name));
  if (usageCache && usageCache.accountId === cur.id) {
    const scope = cfg('shareHistory') ? t('all accounts') : cur.name;
    lines.push(t('Tokens today ({0}): {1}', scope, formatTokens(totalTokens(usageCache.data.today))));
  }
  if (override) lines.push('', t('Warning: claudeCode.environmentVariables in user settings forces {0}', override));
  lines.push('', t('Click to switch'));
  statusItem.tooltip = lines.join('\n');
  statusItem.show();
}

function accountButtons(a) {
  const b = [
    { iconPath: new vscode.ThemeIcon('edit'), tooltip: t('Rename'), action: 'rename' },
    { iconPath: new vscode.ThemeIcon('symbol-color'), tooltip: t('Appearance'), action: 'appearance' },
    { iconPath: new vscode.ThemeIcon('key'), tooltip: t('Log in'), action: 'login' },
  ];
  if (a.id !== DEFAULT_ID) b.push({ iconPath: new vscode.ThemeIcon('trash'), tooltip: t('Remove'), action: 'remove' });
  return b;
}

function accountItem(a, { markCurrent = true, buttons = true } = {}) {
  const cur = selectedAccount();
  const d = resolveDefault();
  const emoji = a.icon && !isCodicon(a.icon) ? a.icon + ' ' : '';
  const desc = [modeLabel(a.mode)];
  if (d && d.account.id === a.id) desc.push(d.source === 'rule' ? t('default by rule') : t('repository default'));
  return {
    label: `${markCurrent && a.id === cur.id ? '$(check) ' : ''}${emoji}${a.name}`,
    description: desc.join(' · '),
    detail: identityLine(a) || configDirOf(a),
    iconPath: avatarUri(a) || (emoji ? undefined : new vscode.ThemeIcon(a.icon || 'account', themeColor(a.color))),
    buttons: buttons ? accountButtons(a) : undefined,
    account: a,
  };
}

// Quick pick with per-item buttons. Resolves to { item, button } or undefined.
function pick(items, placeHolder) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.items = items;
    qp.placeholder = placeHolder;
    qp.matchOnDetail = true;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); qp.hide(); } };
    qp.onDidAccept(() => finish(qp.selectedItems[0] ? { item: qp.selectedItems[0] } : undefined));
    qp.onDidTriggerItemButton((e) => finish({ item: e.item, button: e.button }));
    qp.onDidHide(() => { finish(undefined); qp.dispose(); });
    qp.show();
  });
}

async function runAccountAction(action, a) {
  if (action === 'rename') return rename(a);
  if (action === 'appearance') return cmdAppearance(a);
  if (action === 'login') return loginTerminal(a);
  if (action === 'remove') return remove(a);
  if (action === 'env') return cmdEditEnv(a);
}

async function pickMode() {
  const p = await vscode.window.showQuickPick(
    [
      {
        label: '$(link) ' + t('Shared profile'),
        detail: t('Uses the same configuration as ~/.claude (settings, CLAUDE.md, agents, commands, skills...). Login and history stay separate. Changes to that configuration apply to every shared account.'),
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
  return p?.mode;
}

const loginTerminals = new Set();

function loginTerminal(account) {
  const env = desiredEnv(account);
  if (!account.dir) env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV ?? null;
  const term = vscode.window.createTerminal({ name: t('Claude login: {0}', account.name), env });
  loginTerminals.add(term);
  term.show();
  term.sendText(cfg('loginCommand'));
}

// ───────────────────────── commands ─────────────────────────

async function cmdSwitch() {
  const cur = selectedAccount();
  refreshAllIdentities().catch(() => null);
  const items = allAccounts().map((a) => accountItem(a));
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(add) ' + t('Add account...'), action: 'claudeAccounts.add' });
  if (currentRepo) {
    items.push({ label: '$(pin) ' + t('Set default account for this repository...'), action: 'claudeAccounts.setRepoDefault' });
    items.push({ label: '$(list-filter) ' + t('Add default-account rule...'), action: 'claudeAccounts.addRule' });
  }
  items.push({ label: '$(graph) ' + t('Show usage by account'), action: 'claudeAccounts.showUsage' });
  items.push({
    label: '$(history) ' + (cfg('shareHistory') ? t('Stop sharing history...') : t('Share history across accounts...')),
    action: 'claudeAccounts.toggleHistorySharing',
  });
  items.push({ label: '$(gear) ' + t('Manage accounts...'), action: 'claudeAccounts.manage' });

  const r = await pick(items, t('Current account: {0}', cur.name));
  if (!r) return;
  if (r.button) return runAccountAction(r.button.action, r.item.account);
  if (r.item.action) return vscode.commands.executeCommand(r.item.action);
  if (r.item.account.id === cur.id) return;
  await selectAccount(r.item.account);
}

async function cmdSwitchToPrevious() {
  const prev = findAccount(store().get(K_PREVIOUS));
  if (!prev || prev.id === selectedAccount().id) {
    return vscode.window.showInformationMessage(t('There is no previous account in this window yet.'));
  }
  await selectAccount(prev);
}

async function cmdAdd() {
  const name = await vscode.window.showInputBox({
    prompt: t('Account name (e.g. Work, Personal)'),
    validateInput: (v) => (v.trim() ? null : t('Enter a name')),
  });
  if (!name) return;
  const mode = await pickMode();
  if (!mode) return;

  const recs = getRecords();
  const base = slugify(name);
  let id = base;
  for (let i = 2; recs.some((a) => a.id === id); i++) id = `${base}-${i}`;
  const dir = path.join(accountsRoot(), id);
  fs.mkdirSync(dir, { recursive: true });

  let summary = mode === 'shared' ? describe(linkSharedItems(dir)) : '';
  if (historyItems().length) { linkHistory(dir, id); summary += ' ' + t('History shared with the other accounts.'); }
  await saveRecords([...recs, { id, dir, mode }]);
  const used = new Set(allAccounts().map((a) => a.color).filter(Boolean));
  await updateMeta(id, { name: name.trim(), color: COLORS.find((c) => !used.has(c)) });
  updateStatus();

  const account = findAccount(id);
  const loginBtn = t('Log in');
  const res = await vscode.window.showInformationMessage(
    t('Account "{0}" created at {1}.{2} Log in now?', account.name, dir, summary),
    loginBtn,
    t('Later')
  );
  if (res === loginBtn) loginTerminal(account);
}

async function cmdManage() {
  const r = await pick(allAccounts().map((a) => accountItem(a)), t('Which account?'));
  if (!r) return;
  const a = r.item.account;
  if (r.button) return runAccountAction(r.button.action, a);

  const actions = [
    { label: '$(key) ' + t('Log in'), run: () => loginTerminal(a) },
    { label: '$(edit) ' + t('Rename'), run: () => rename(a) },
    { label: '$(symbol-color) ' + t('Appearance (color, icon, image)'), run: () => cmdAppearance(a) },
    { label: '$(symbol-variable) ' + t('Environment variables'), run: () => cmdEditEnv(a) },
  ];
  if (a.id !== DEFAULT_ID) {
    actions.push(
      a.mode === 'shared'
        ? { label: '$(lock) ' + t('Switch to isolated profile'), run: () => toIsolated(a) }
        : { label: '$(link) ' + t('Switch to shared profile'), run: () => toShared(a) }
    );
    if (a.mode === 'shared' || historyItems().length) {
      actions.push({ label: '$(sync) ' + t('Relink shared items'), run: () => relink(a) });
    }
    actions.push(
      { label: '$(folder-opened) ' + t('Open account folder'), run: () => vscode.env.openExternal(vscode.Uri.file(a.dir)) },
      { label: '$(trash) ' + t('Remove'), run: () => remove(a) }
    );
  }
  const act = await vscode.window.showQuickPick(actions, { placeHolder: a.name });
  if (act) await act.run();
}

async function saveRecordPatch(id, patch) {
  await saveRecords(getRecords().map((x) => (x.id === id ? { ...x, ...patch } : x)));
  updateStatus();
}

async function toIsolated(a) {
  const copied = unlinkSharedItems(a.dir);
  await saveRecordPatch(a.id, { mode: 'isolated' });
  const extra = copied.length ? ' ' + t('Independent copies created: {0}.', copied.join(', ')) : '';
  vscode.window.showInformationMessage(t('"{0}" now uses an isolated profile.', a.name) + extra);
}

async function toShared(a) {
  const switchBtn = t('Switch');
  const ok = await vscode.window.showWarningMessage(
    t('Switch "{0}" to a shared profile?', a.name),
    { modal: true, detail: t('Items this account has its own version of that are in the shared list will be renamed to .bak and replaced by links to ~/.claude.') },
    switchBtn
  );
  if (ok !== switchBtn) return;
  const r = linkSharedItems(a.dir, { replaceLocal: true });
  await saveRecordPatch(a.id, { mode: 'shared' });
  vscode.window.showInformationMessage(t('"{0}" now uses a shared profile.', a.name) + describe(r));
}

async function relink(a) {
  let msg = '';
  if (a.mode === 'shared') msg += describe(linkSharedItems(a.dir, { replaceLocal: true }));
  if (historyItems().length) msg += describe(linkHistory(a.dir, a.id));
  vscode.window.showInformationMessage(t('Items relinked in "{0}".', a.name) + msg);
}

async function rename(a) {
  const name = await vscode.window.showInputBox({
    prompt: t('New name'),
    value: a.name,
    validateInput: (v) => (v.trim() ? null : t('Enter a name')),
  });
  if (!name) return;
  await updateMeta(a.id, { name: name.trim() });
  updateStatus();
}

async function cmdAppearance(a) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(symbol-color) ' + t('Color...'), id: 'color' },
      { label: '$(smiley) ' + t('Icon or emoji...'), id: 'icon' },
      { label: '$(file-media) ' + t('Image...'), id: 'image', detail: t('Shown in the account picker. The status bar only supports icons.') },
      ...(a.avatar ? [{ label: '$(close) ' + t('Remove image'), id: 'noimage' }] : []),
    ],
    { placeHolder: t('Appearance of "{0}"', a.name) }
  );
  if (!choice) return;

  if (choice.id === 'color') {
    const names = {
      orange: t('Orange'), green: t('Green'), blue: t('Blue'), purple: t('Purple'),
      pink: t('Pink'), yellow: t('Yellow'), teal: t('Teal'), red: t('Red'),
    };
    const c = await vscode.window.showQuickPick(
      [
        ...COLORS.map((col) => ({ label: names[col], color: col, iconPath: new vscode.ThemeIcon('circle-filled', themeColor(col)) })),
        { label: t('No color'), color: undefined, iconPath: new vscode.ThemeIcon('circle-outline') },
      ],
      { placeHolder: t('Color of "{0}"', a.name) }
    );
    if (c) await updateMeta(a.id, { color: c.color });
  } else if (choice.id === 'icon') {
    const i = await vscode.window.showQuickPick(
      [
        ...ICONS.map((ic) => ({ label: `$(${ic}) ${ic}`, icon: ic })),
        { label: '$(smiley) ' + t('Emoji...'), icon: '__emoji__' },
      ],
      { placeHolder: t('Icon of "{0}"', a.name) }
    );
    if (!i) return;
    let icon = i.icon;
    if (icon === '__emoji__') {
      icon = await vscode.window.showInputBox({
        prompt: t('Type or paste one emoji'),
        validateInput: (v) => (v.trim() && [...v.trim()].length <= 4 && !/[a-z0-9]/i.test(v) ? null : t('Enter a single emoji')),
      });
      if (!icon) return;
      icon = icon.trim();
    }
    await updateMeta(a.id, { icon });
  } else if (choice.id === 'image') {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [t('Images')]: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
    });
    if (!files?.length) return;
    const src = files[0].fsPath;
    if (fs.statSync(src).size > 2 * 1024 * 1024) return vscode.window.showWarningMessage(t('Choose an image smaller than 2 MB.'));
    const fileName = `${a.id}-${Date.now()}${path.extname(src).toLowerCase()}`;
    fs.mkdirSync(storageDir('avatars'), { recursive: true });
    fs.copyFileSync(src, storageDir('avatars', fileName));
    if (a.avatar) fs.rmSync(storageDir('avatars', a.avatar), { force: true });
    await ctx.globalState.update(K_AVATARS, { ...getAvatars(), [a.id]: fileName });
  } else if (choice.id === 'noimage') {
    fs.rmSync(storageDir('avatars', a.avatar), { force: true });
    const m = { ...getAvatars() };
    delete m[a.id];
    await ctx.globalState.update(K_AVATARS, m);
  }
  updateStatus();
}

async function cmdEditEnv(a) {
  for (;;) {
    const env = { ...(getEnvMap()[a.id] || {}) };
    const items = Object.entries(env).map(([k, v]) => ({ label: k, description: /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(k) ? '••••••••' : v, key: k }));
    items.push({ label: '$(add) ' + t('Add variable...'), key: null });
    const p = await vscode.window.showQuickPick(items, {
      placeHolder: t('Environment variables of "{0}" (kept on this machine only)', a.name),
    });
    if (!p) break;
    const input = await vscode.window.showInputBox({
      prompt: p.key ? t('Edit as NAME=value. Leave empty to remove {0}.', p.key) : t('Enter NAME=value'),
      value: p.key ? `${p.key}=${env[p.key]}` : '',
      validateInput: (v) => {
        if (!v.trim()) return p.key ? null : t('Enter NAME=value');
        const m = v.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
        if (!m) return t('Enter NAME=value');
        if (m[1] === 'CLAUDE_CONFIG_DIR') return t('CLAUDE_CONFIG_DIR is managed by the account itself.');
        return null;
      },
    });
    if (input === undefined) continue;
    if (p.key) delete env[p.key];
    const m = input.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (m) env[m[1]] = m[2];
    await ctx.globalState.update(K_ENV, { ...getEnvMap(), [a.id]: env });
    if (selectedAccount().id === a.id) {
      applyEnv(findAccount(a.id));
      await maybeReload(t('Environment variables of "{0}" updated.', a.name));
      break;
    }
  }
}

async function remove(a) {
  const keepBtn = t('Remove (keep folder)');
  const deleteBtn = t('Remove and delete folder');
  const choice = await vscode.window.showWarningMessage(
    t('Remove account "{0}"?', a.name),
    { modal: true, detail: t('Folder: {0}\n~/.claude is never deleted; shared links are undone before anything is deleted.', a.dir) },
    keepBtn,
    deleteBtn
  );
  if (!choice) return;
  const wasCurrent = selectedAccount().id === a.id;
  await saveRecords(getRecords().filter((x) => x.id !== a.id));
  const map = { ...getRepoDefaults() };
  for (const k of Object.keys(map)) if (map[k] === a.id) delete map[k];
  await saveRepoDefaults(map);
  // Drop everything stored for this id so a new account with the same name starts clean.
  const envMap = { ...getEnvMap() };
  delete envMap[a.id];
  await ctx.globalState.update(K_ENV, envMap);
  const meta = { ...getMeta() };
  delete meta[a.id];
  await ctx.globalState.update(K_META, meta);
  if (a.avatar) fs.rmSync(storageDir('avatars', a.avatar), { force: true });
  const avatars = { ...getAvatars() };
  delete avatars[a.id];
  await ctx.globalState.update(K_AVATARS, avatars);
  if (choice === deleteBtn) removeAccountDir(a.dir);
  updateStatus();
  if (wasCurrent) await selectAccount(defaultAccount(), t('previous account removed'));
}

async function cmdToggleHistory() {
  const enabled = !!cfg('shareHistory');
  const accounts = getAccounts();
  const items = cfg('historyItems') || [];

  if (!enabled) {
    const shareBtn = t('Share');
    const ok = await vscode.window.showWarningMessage(
      t('Share history across all accounts?'),
      {
        modal: true,
        detail: t('Items: {0}.\n\nThe history each account already has is merged into ~/.claude (nothing is deleted; conflicting files are kept alongside with the suffix .conflict-<account>), and every account will see the same conversations.\n\nClose the Claude Code panel in other windows before continuing.', items.join(', ')),
      },
      shareBtn
    );
    if (ok !== shareBtn) return;
    await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', true, vscode.ConfigurationTarget.Global);
    const total = { merged: 0, conflicts: [], skipped: [] };
    for (const a of accounts) {
      const r = linkHistory(a.dir, a.id);
      total.merged += r.merged;
      total.conflicts.push(...r.conflicts);
      total.skipped.push(...r.skipped.map((x) => `${a.name}: ${x}`));
    }
    const extra = [
      total.merged ? t('{0} items merged.', total.merged) : '',
      total.conflicts.length ? t('Conflicts: {0}.', total.conflicts.join(', ')) : '',
      total.skipped.length ? t('Skipped: {0}.', total.skipped.join('; ')) : '',
    ].filter(Boolean).join(' ');
    return maybeReload(t('History shared across {0} accounts.', accounts.length + 1) + (extra ? ' ' + extra : ''));
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
  for (const a of accounts) unlinkItems(a.dir, items, { copy: choice === copyBtn });
  await vscode.workspace.getConfiguration('claudeAccounts').update('shareHistory', false, vscode.ConfigurationTarget.Global);
  return maybeReload(t('History is no longer shared.'));
}

async function cmdSetRepoDefault() {
  currentRepo = currentRepo || (await detectRepo());
  if (!currentRepo) return vscode.window.showWarningMessage(t('Open a folder to set a default account.'));
  const r = await pick(allAccounts().map((a) => accountItem(a, { markCurrent: false, buttons: false })), t('Default account for {0}', currentRepo.label));
  if (!r) return;
  const acc = r.item.account;
  const map = { ...getRepoDefaults(), [currentRepo.key]: acc.id };
  await saveRepoDefaults(map);
  await ctx.workspaceState.update(K_LAST_APPLIED, acc.id);
  updateStatus();
  if (selectedAccount().id !== acc.id) await selectAccount(acc, t('repository default'));
  else vscode.window.showInformationMessage(t('"{0}" is now the default account for this repository.', acc.name));
}

async function cmdClearRepoDefault() {
  currentRepo = currentRepo || (await detectRepo());
  if (!currentRepo) return;
  const map = { ...getRepoDefaults() };
  delete map[currentRepo.key];
  await saveRepoDefaults(map);
  await ctx.workspaceState.update(K_LAST_APPLIED, undefined);
  updateStatus();
  vscode.window.showInformationMessage(t('Default account for this repository removed.'));
}

async function cmdAddRule() {
  currentRepo = currentRepo || (await detectRepo());
  const folder = folderPath();
  if (!folder) return vscode.window.showWarningMessage(t('Open a folder to set a default account.'));
  const home = os.homedir();
  const tilde = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p).replace(/\\/g, '/');
  const options = [];
  if (currentRepo?.remote) {
    const parts = normalizeRemote(currentRepo.remote).split('/');
    if (parts.length >= 3) {
      const org = parts.slice(0, -1).join('/');
      options.push({ label: t('Every repository of {0}', org), detail: org, pattern: org });
    }
  }
  const parent = path.dirname(currentRepo?.root || folder);
  options.push({ label: t('Every folder under {0}', tilde(parent)), detail: tilde(parent), pattern: tilde(parent) });
  options.push({ label: '$(edit) ' + t('Custom pattern...'), pattern: null });

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
  const r = await pick(allAccounts().map((a) => accountItem(a, { markCurrent: false, buttons: false })), t('Account for {0}', pattern));
  if (!r) return;
  const rules = [...(cfg('rules') || []).filter((x) => x?.pattern !== pattern), { pattern, account: r.item.account.id }];
  await vscode.workspace.getConfiguration('claudeAccounts').update('rules', rules, vscode.ConfigurationTarget.Global);
  await ctx.workspaceState.update(K_LAST_APPLIED, undefined);
  const editBtn = t('Edit rules');
  vscode.window.showInformationMessage(
    t('Rule added: {0} → {1}. A repository default set for a specific repository still wins.', pattern, r.item.account.name),
    editBtn
  ).then((b) => b === editBtn && vscode.commands.executeCommand('workbench.action.openSettings', 'claudeAccounts.rules'));
  await autoApply();
  updateStatus();
}

async function cmdShowUsage() {
  const shared = !!cfg('shareHistory');
  const targets = shared ? [selectedAccount()] : allAccounts();
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('Reading local session logs...') },
    async () => Promise.all(targets.map(async (a) => ({ a, u: await computeUsage(a).catch(() => null) })))
  );
  const items = results.map(({ a, u }) => ({
    label: shared ? t('All accounts (history is shared)') : a.name,
    description: u ? t('today: {0} · 7 days: {1}', formatTokens(totalTokens(u.today)), formatTokens(totalTokens(u.week))) : t('no data'),
    detail: u
      ? t('7 days: input {0} · output {1} · cache write {2} · cache read {3} · {4} responses',
        formatTokens(u.week.input), formatTokens(u.week.output), formatTokens(u.week.cacheWrite), formatTokens(u.week.cacheRead), u.week.messages)
      : undefined,
  }));
  await vscode.window.showQuickPick(items, {
    placeHolder: shared
      ? t('Usage cannot be split by account while history is shared.')
      : t('Tokens recorded on this machine (local logs only; other devices are not included).'),
  });
}

// Finds account folders that are not registered (e.g. created by an earlier install).
function findUnregisteredDirs() {
  const root = accountsRoot();
  if (!fs.existsSync(root)) return [];
  const known = getRecords();
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter((d) => !known.some((a) => samePath(a.dir, d)));
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
  const src = homeClaudeDir();
  const taken = new Set([DEFAULT_ID, ...getRecords().map((r) => r.id)]);
  const imported = found.map((d) => {
    const base = path.basename(d);
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    taken.add(id);
    const shared = (cfg('sharedItems') || []).some((i) => isLinkedTo(path.join(d, i), path.join(src, i)));
    return { id, dir: d, mode: shared ? 'shared' : 'isolated' };
  });
  await saveRecords([...getRecords(), ...imported]);
  updateStatus();
  const names = imported.map((a) => findAccount(a.id).name).join(', ');
  vscode.window.showInformationMessage(t('Imported: {0}. Use "Manage accounts" to rename them.', names));
}

async function checkSharedHealth() {
  const cur = selectedAccount();
  const broken = brokenShares(cur);
  if (!broken.length) return;
  const relinkBtn = t('Relink');
  const res = await vscode.window.showWarningMessage(
    t('Account "{0}" is not linked to these shared items: {1}. This happens when an item is created in ~/.claude later or gets rewritten over the link.', cur.name, broken.join(', ')),
    relinkBtn,
    t('Ignore')
  );
  if (res === relinkBtn) await relink(cur);
}

// ───────────────────────── activation ─────────────────────────

function reg(id, fn) {
  return vscode.commands.registerCommand(id, async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      vscode.window.showErrorMessage(`Multi-Account Switcher for Claude Code: ${e.message || e}`);
    }
  });
}

async function activate(context) {
  ctx = context;
  // First, synchronously: set the environment before the Claude Code extension starts the CLI.
  applyEnv(selectedAccount());

  context.globalState.setKeysForSync([K_META, K_REPO_DEFAULTS]);
  statusItem = vscode.window.createStatusBarItem('claudeAccounts.status', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Multi-Account Switcher for Claude Code';
  statusItem.command = 'claudeAccounts.switch';

  let lastFocusRefresh = 0;
  context.subscriptions.push(
    statusItem,
    reg('claudeAccounts.switch', cmdSwitch),
    reg('claudeAccounts.switchToPrevious', cmdSwitchToPrevious),
    reg('claudeAccounts.add', cmdAdd),
    reg('claudeAccounts.manage', cmdManage),
    reg('claudeAccounts.setRepoDefault', cmdSetRepoDefault),
    reg('claudeAccounts.clearRepoDefault', cmdClearRepoDefault),
    reg('claudeAccounts.addRule', cmdAddRule),
    reg('claudeAccounts.showUsage', cmdShowUsage),
    reg('claudeAccounts.toggleHistorySharing', cmdToggleHistory),
    reg('claudeAccounts.importExisting', () => cmdImport()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCode.environmentVariables') || e.affectsConfiguration('claudeAccounts')) updateStatus();
      if (e.affectsConfiguration('claudeAccounts.gravatar')) refreshAllIdentities().catch(() => null);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      currentRepo = await detectRepo();
      updateStatus();
    }),
    vscode.window.onDidCloseTerminal((term) => {
      if (loginTerminals.delete(term)) refreshAllIdentities().catch(() => null);
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && Date.now() - lastFocusRefresh > 60e3) {
        lastFocusRefresh = Date.now();
        refreshAllIdentities().catch(() => null);
      }
    })
  );

  try { await migrate(); } catch { /* keep going */ }
  updateStatus();
  currentRepo = await detectRepo();
  updateStatus();
  try {
    await autoApply();
    await startLimitWatcher(context);
    await refreshAllIdentities();
  } catch (e) {
    vscode.window.showErrorMessage(`Multi-Account Switcher for Claude Code: ${e.message || e}`);
  }
  const usageTimer = setTimeout(() => refreshCurrentUsage(), 3000);
  context.subscriptions.push({ dispose: () => clearTimeout(usageTimer) });
  // Prompts wait for the user, so they must not hold activation (or the setup above) back.
  startupPrompts = runStartupPrompts(context);
}

let startupPrompts = Promise.resolve();

async function runStartupPrompts(context) {
  try {
    if (!getRecords().length && !context.globalState.get(K_IMPORT_PROMPTED)) {
      await context.globalState.update(K_IMPORT_PROMPTED, true);
      await cmdImport({ prompt: true });
    }
    await checkOverridingSetting();
    await checkSharedHealth();
  } catch (e) {
    vscode.window.showErrorMessage(`Multi-Account Switcher for Claude Code: ${e.message || e}`);
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _internals: {
    normalizeRemote, slugify, initials, linkSharedItems, unlinkSharedItems, linkHistory, unlinkItems,
    isLinkedTo, removeAccountDir, brokenShares, findUnregisteredDirs, resolveDefault, desiredEnv,
    startupDone: () => startupPrompts,
  },
};
