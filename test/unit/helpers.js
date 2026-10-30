'use strict';
// Minimal stub of the `vscode` module so the extension logic runs under plain Node. Each test file runs
// in its own process (node --test), so the module-level state of the extension starts fresh.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn, thisArg, disposables) => {
      const l = thisArg ? fn.bind(thisArg) : fn;
      this.listeners.push(l);
      const d = { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(v) {
    for (const l of [...this.listeners]) l(v);
  }
  dispose() {
    this.listeners = [];
  }
}

const memento = () => {
  const m = {};
  return {
    data: m,
    get: (k, d) => (k in m ? m[k] : d),
    update: async (k, v) => {
      if (v === undefined) delete m[k];
      else m[k] = JSON.parse(JSON.stringify(v));
    },
    keys: () => Object.keys(m),
    setKeysForSync(keys) {
      this.synced = keys;
    },
  };
};

/**
 * @param {Record<string, any>} [config] claudeAccounts settings
 * @param {{ originalEnv?: string, folders?: string[] }} [opts]
 */
function setup(config = {}, opts = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  if (opts.originalEnv) process.env.CLAUDE_CONFIG_DIR = opts.originalEnv.replace('~', home);
  else delete process.env.CLAUDE_CONFIG_DIR;

  const defaults = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.configuration.properties;
  const claudeAccounts = {};
  for (const [k, v] of Object.entries(defaults)) claudeAccounts[k.replace('claudeAccounts.', '')] = JSON.parse(JSON.stringify(v.default));
  const settings = { claudeAccounts: { ...claudeAccounts, ...config }, claudeCode: { environmentVariables: [] } };

  const messages = [];
  const terminals = [];
  const watchers = [];
  const commands = new Map();
  const calls = { reload: 0, executed: [] };
  const extensions = {};
  const configChanged = new EventEmitter();
  const env = {
    /** Chooses the answer to a message: (type, text, items) => item. Default: the first item. */
    respond: (_type, _text, items) => items[0],
    /** Chooses a quick pick item: (items, options) => item. */
    pickQuick: (items) => items[0],
    /** Answers to input boxes, in order. */
    inputs: [],
  };
  const answer =
    (type) =>
    async (text, ...rest) => {
      const items = rest.filter((x) => typeof x === 'string' || (x && typeof x === 'object' && 'title' in x));
      const options = rest.find((x) => x && typeof x === 'object' && !('title' in x));
      messages.push({ type, text, items, options });
      const pick = env.respond(type, text, items, options);
      return pick;
    };
  const folders = (opts.folders || [home]).map((p) => ({ uri: { fsPath: p, scheme: 'file' }, name: path.basename(p) }));

  const vscode = {
    version: '1.99.0',
    l10n: { t: (m, ...a) => m.replace(/\{(\d+)\}/g, (_, i) => String(a[i])) },
    EventEmitter,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    TreeItemCollapsibleState: { None: 0 },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    ThemeIcon: class {
      constructor(id, color) {
        this.id = id;
        this.color = color;
      }
    },
    MarkdownString: class {
      constructor(value = '', supportThemeIcons = false) {
        this.value = value;
        this.supportThemeIcons = supportThemeIcons;
      }
      appendMarkdown(s) {
        this.value += s;
        return this;
      }
    },
    TreeItem: class {
      constructor(label, state) {
        this.label = label;
        this.collapsibleState = state;
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }), parse: (s) => new URL(s) },
    workspace: {
      workspaceFolders: folders,
      isTrusted: true,
      getConfiguration: (sec) => ({
        get: (k) => settings[sec]?.[k],
        // A value equal to the default counts as not set, like in VS Code.
        inspect: (k) => {
          const v = settings[sec]?.[k];
          const d = sec === 'claudeAccounts' ? claudeAccounts[k] : undefined;
          return { defaultValue: d, globalValue: JSON.stringify(v) === JSON.stringify(d) ? undefined : v };
        },
        update: async (k, v) => {
          settings[sec] = settings[sec] || {};
          if (v === undefined) delete settings[sec][k];
          else settings[sec][k] = v;
          configChanged.fire({ affectsConfiguration: (s) => `${sec}.${k}`.startsWith(s) || s.startsWith(`${sec}.${k}`) });
        },
      }),
      onDidChangeConfiguration: configChanged.event,
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      createFileSystemWatcher: (p) => {
        const w = {
          pattern: p,
          handlers: [],
          disposed: false,
          onDidChange(h) {
            w.handlers.push(h);
            return { dispose() {} };
          },
          onDidCreate(h) {
            w.handlers.push(h);
            return { dispose() {} };
          },
          dispose() {
            w.disposed = true;
          },
        };
        watchers.push(w);
        return w;
      },
      fs: {
        delete: async (uri, o) => {
          if (env.noTrash && o?.useTrash) throw new Error('no trash');
          fs.rmSync(uri.fsPath, { recursive: true, force: true });
        },
        writeFile: async (uri, data) => fs.writeFileSync(uri.fsPath, data),
        readFile: async (uri) => fs.readFileSync(uri.fsPath),
      },
      openTextDocument: async (o) => ({ ...o }),
    },
    window: {
      state: { focused: true },
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showInformationMessage: answer('info'),
      showWarningMessage: answer('warning'),
      showErrorMessage: answer('error'),
      showQuickPick: async (items, options) => {
        const list = await items;
        messages.push({ type: 'quickPick', text: options?.placeHolder, items: list });
        return env.pickQuick(list, options);
      },
      showInputBox: async (o) => {
        messages.push({ type: 'input', text: o?.prompt });
        const v = env.inputs.shift();
        if (v !== undefined && o?.validateInput) {
          const err = await o.validateInput(v);
          if (err) throw new Error(`Input "${v}" rejected: ${err}`);
        }
        return v;
      },
      createQuickPick: () => {
        const accept = new EventEmitter();
        const button = new EventEmitter();
        const hide = new EventEmitter();
        const qp = {
          items: [],
          selectedItems: [],
          onDidAccept: accept.event,
          onDidTriggerItemButton: button.event,
          onDidHide: hide.event,
          show() {
            messages.push({ type: 'quickPick', text: qp.placeholder, items: qp.items });
            setImmediate(() => {
              const choice = env.pickQuick(qp.items, { placeHolder: qp.placeholder });
              if (choice && choice.__button) button.fire({ item: choice.item, button: choice.__button });
              else if (choice) {
                qp.selectedItems = [choice];
                accept.fire();
              } else hide.fire();
            });
          },
          hide() {
            hide.fire();
          },
          dispose() {},
        };
        return qp;
      },
      withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
      createTerminal: (o) => {
        const term = {
          options: o,
          sent: [],
          show() {},
          sendText(s) {
            term.sent.push(s);
          },
          dispose() {},
        };
        terminals.push(term);
        return term;
      },
      createOutputChannel: () => ({ info() {}, warn() {}, error() {}, debug() {}, trace() {}, show() {}, dispose() {} }),
      createTreeView: () => ({ dispose() {} }),
      registerUriHandler: () => ({ dispose() {} }),
      onDidCloseTerminal: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      showTextDocument: async () => undefined,
      showOpenDialog: async () => env.openDialog,
      showSaveDialog: async () => env.saveDialog,
    },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (c, ...args) => {
        calls.executed.push(c);
        if (c === 'workbench.action.reloadWindow') calls.reload++;
        if (commands.has(c)) return commands.get(c)(...args);
        return undefined;
      },
    },
    extensions: { getExtension: (id) => extensions[id] },
    env: { language: 'en', appName: 'Visual Studio Code', remoteName: undefined, openExternal: async () => true },
  };
  const orig = Module._load;
  Module._load = (req, ...a) => (req === 'vscode' ? vscode : orig(req, ...a));

  const secrets = {};
  const context = {
    workspaceState: memento(),
    globalState: memento(),
    secrets: {
      data: secrets,
      get: async (k) => secrets[k],
      store: async (k, v) => {
        secrets[k] = v;
      },
      delete: async (k) => {
        delete secrets[k];
      },
    },
    environmentVariableCollection: {
      vars: {},
      persistent: true,
      description: undefined,
      replace(k, v) {
        this.vars[k] = v;
      },
      clear() {
        this.vars = {};
      },
    },
    subscriptions: [],
    globalStorageUri: { fsPath: path.join(home, '.vscode-storage') },
    extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) },
  };
  const write = (p, c) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  // Loads a module of the extension (src/...) with the stub in place.
  const load = (name) => require(path.join(root, 'src', name));
  // Sets the runtime context without running activate(), for module-level tests.
  const init = () => {
    const { rt } = load('runtime');
    rt.ctx = context;
    rt.log = vscode.window.createOutputChannel();
    rt.ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;
    return rt;
  };
  // Disposes what activate() registered (timers, watchers), so the test process can exit.
  const dispose = () => {
    for (const d of context.subscriptions.splice(0)) d?.dispose?.();
  };
  // The returned object is also the control object the stub reads (respond, pickQuick, inputs...).
  return Object.assign(env, {
    dispose,
    home,
    claude: path.join(home, '.claude'),
    root: path.join(home, '.claude-accounts'),
    settings,
    messages,
    calls,
    watchers,
    terminals,
    commands,
    extensions,
    vscode,
    context,
    write,
    load,
    init,
  });
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

module.exports = { setup, tick };
