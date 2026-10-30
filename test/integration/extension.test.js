'use strict';
// Runs inside a real VS Code (npm run test:integration). The test files share the extension host
// with the extension, so requiring its modules returns the same instances it uses.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const ID = 'kahuecosta.claude-code-multi-account';
// The extension's own module instances, exposed to tests through its exports (CLAUDE_ACCOUNTS_TEST=1).
let api;
const mod = (name) => api.__test.mod(name);

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

suite('Multi-Account Switcher for Claude Code', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-it-')));
  const dirA = path.join(tmp, 'a');
  const dirB = path.join(tmp, 'b');

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, 'extension found');
    api = await ext.activate();
    await mod('extension')._internals.startupDone(); // startup work must not race with the setup below
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    const accounts = mod('accounts');
    await accounts.saveRecords([
      { id: 'it-a', dir: dirA, mode: 'isolated' },
      { id: 'it-b', dir: dirB, mode: 'isolated' },
    ]);
    await accounts.updateMeta('it-a', { name: 'IT A' });
    await accounts.updateMeta('it-b', { name: 'IT B' });
    // VS Code echoes every globalState write back to the extension host, which can briefly show an
    // older snapshot: wait until the accounts are visible and stay visible.
    const ids = () =>
      accounts
        .getAccounts()
        .map((a) => `${a.id}=${a.name}`)
        .join(', ');
    await until(() => ids() === 'it-a=IT A, it-b=IT B', 10000).catch(() => {
      throw new Error(
        `accounts never became visible; records: ${JSON.stringify(accounts.getRecords())}, meta: ${JSON.stringify(accounts.getMeta())}`
      );
    });
    await new Promise((r) => setTimeout(r, 1000));
    assert.strictEqual(ids(), 'it-a=IT A, it-b=IT B', 'accounts after setup');
  });

  suiteTeardown(async () => {
    mod('environment').applyEnv(mod('accounts').defaultAccount());
    await mod('accounts').saveRecords([]);
  });

  test('activates on startup and exposes the API', () => {
    assert.strictEqual(vscode.extensions.getExtension(ID).isActive, true);
    assert.strictEqual(api.apiVersion, 1);
    assert.strictEqual(api.getCurrentAccount().id, '__default__');
  });

  test('registers every contributed command', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const declared = vscode.extensions.getExtension(ID).packageJSON.contributes.commands.map((c) => c.command);
    for (const c of declared) assert.ok(all.has(c), `${c} is registered`);
  });

  test('switching through the API sets the extension host environment', async () => {
    await vscode.workspace.getConfiguration('claudeAccounts').update('reloadBehavior', 'never', vscode.ConfigurationTarget.Global);
    assert.strictEqual(await api.switchAccount('IT A'), true);
    assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, dirA);
    assert.strictEqual(api.getCurrentAccount().configDir, dirA);
  });

  test('a terminal for another account is not overridden by the window environment', async function () {
    if (process.platform === 'win32') this.skip(); // the probe below uses a POSIX shell
    const accounts = mod('accounts');
    const env = mod('environment');
    env.applyEnv(accounts.findAccount('it-a'));
    const probe = (file) => `printf '%s' "$CLAUDE_CONFIG_DIR" > '${file}'; exit`;

    // A normal terminal gets the window account through the environment variable collection...
    const plainOut = path.join(tmp, 'plain.txt');
    const plain = vscode.window.createTerminal({ name: 'plain' });
    plain.sendText(probe(plainOut));
    assert.strictEqual(await until(() => fs.existsSync(plainOut) && fs.readFileSync(plainOut, 'utf8')), dirA);

    // ...while a terminal for account B (e.g. its login terminal) must use B.
    const bOut = path.join(tmp, 'b.txt');
    env.createAccountTerminal(accounts.findAccount('it-b'), { name: 'login B', command: probe(bOut), transient: true });
    assert.strictEqual(await until(() => fs.existsSync(bOut) && fs.readFileSync(bOut, 'utf8')), dirB);
  });

  test('the diagnostics report renders', async () => {
    const report = await mod('diagnostics').buildReport({ runAuthStatus: false });
    assert.match(report, /## Accounts/);
    assert.match(report, /IT A/);
  });
});
