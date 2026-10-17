'use strict';
// Minimal stub of the `vscode` module so the extension logic runs under plain Node.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;

  const settings = {
    claudeAccounts: {
      scope: 'workspace',
      sharedItems: ['settings.json', 'CLAUDE.md', 'agents'],
      shareHistory: false,
      historyItems: ['projects', 'history.jsonl', 'file-history', 'todos', 'plans'],
      autoApplyRepoDefault: true,
      reloadBehavior: 'ask',
      applyToTerminal: true,
      loginCommand: 'claude auth login',
      rules: [],
      statusBarStyle: 'name',
      showPlan: true,
      suggestSwitchOnLimit: true,
      gravatar: false,
      ...config,
    },
    claudeCode: { environmentVariables: [] },
  };
  const messages = [];
  const watchers = [];
  const calls = { reload: 0 };
  const vscode = {
    l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[i])) },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    StatusBarAlignment: { Left: 1 },
    QuickPickItemKind: { Separator: -1 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: home } }],
      getConfiguration: (sec) => ({
        get: (k) => settings[sec]?.[k],
        inspect: (k) => ({ globalValue: settings[sec]?.[k] }),
        update: async (k, v) => { settings[sec][k] = v; },
      }),
      onDidChangeConfiguration: () => ({}),
      onDidChangeWorkspaceFolders: () => ({}),
      createFileSystemWatcher: (p) => {
        const w = { pattern: p, handlers: [], onDidChange(h) { w.handlers.push(h); return {}; }, onDidCreate(h) { w.handlers.push(h); return {}; } };
        watchers.push(w);
        return w;
      },
    },
    window: {
      createStatusBarItem: () => ({ show() {} }),
      showInformationMessage: async (m, ...b) => { messages.push(m); return b.find((x) => typeof x === 'string'); },
      showWarningMessage: async (m, ...b) => { messages.push(m); return b.find((x) => typeof x === 'string'); },
      showErrorMessage: async (m) => { messages.push(m); },
      onDidCloseTerminal: () => ({}),
      onDidChangeWindowState: () => ({}),
    },
    commands: {
      registerCommand: () => ({}),
      executeCommand: async (c) => { if (c === 'workbench.action.reloadWindow') calls.reload++; },
    },
    env: {},
    Uri: { file: (p) => ({ fsPath: p }) },
  };
  const orig = Module._load;
  Module._load = (req, ...a) => (req === 'vscode' ? vscode : orig(req, ...a));
  const ext = require('../extension.js');

  const memento = () => {
    const m = {};
    return { get: (k, d) => (k in m ? m[k] : d), update: async (k, v) => { m[k] = v; }, setKeysForSync(keys) { this.synced = keys; } };
  };
  const context = {
    workspaceState: memento(),
    globalState: memento(),
    environmentVariableCollection: { vars: {}, persistent: true, replace(k, v) { this.vars[k] = v; }, clear() { this.vars = {}; } },
    subscriptions: { push() {} },
    globalStorageUri: { fsPath: path.join(home, '.vscode-storage') },
  };
  const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
  return { home, claude: path.join(home, '.claude'), settings, messages, calls, watchers, ext, I: ext._internals, context, write };
}

module.exports = { setup };
