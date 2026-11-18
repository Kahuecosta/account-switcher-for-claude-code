'use strict';
// Runs inside a real VS Code with the real Claude Code extension (npm run test:claude-code). Claude Code
// is started through a stand-in claude (claudeCode.claudeProcessWrapper) that only records the
// CLAUDE_CONFIG_DIR and arguments of every process Claude Code starts, so no login and no network are
// needed. This is what switching without a reload depends on; it fails when a Claude Code release
// changes it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const ID = 'kahuecosta.claude-code-multi-account';
let api;
const mod = (name) => api.__test.mod(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// Everything Claude Code wrote to its log in this run.
function claudeCodeLog() {
  const root = path.join(String(process.env.CLAUDE_ACCOUNTS_USER_DATA), 'logs');
  const out = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.log') && /anthropic\.claude-code/i.test(p)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
}

suite('With the Claude Code extension', function () {
  if (process.platform === 'win32') return; // the stand-in claude is a shell script

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-cc-')));
  const dirA = path.join(tmp, 'a');
  const dirB = path.join(tmp, 'b');
  const spawnLog = path.join(tmp, 'spawns.txt');
  const standIn = path.join(tmp, 'claude-stand-in.sh');
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  /** @returns {{ dir: string, args: string }[]} */
  const spawns = () =>
    (fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [dir, args] = l.split('\t');
        return { dir, args };
      });

  suiteSetup(async () => {
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    // Signed in, as far as this extension can tell (it reads the account from .claude.json).
    for (const [d, who] of [
      [dirA, 'a'],
      [dirB, 'b'],
    ])
      fs.writeFileSync(
        path.join(d, '.claude.json'),
        JSON.stringify({ oauthAccount: { accountUuid: who, emailAddress: `${who}@example.com` } })
      );
    fs.writeFileSync(standIn, `#!/bin/sh\nprintf '%s\\t%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "$*" >> '${spawnLog}'\nexit 1\n`, {
      mode: 0o755,
    });
    await vscode.workspace.getConfiguration('claudeCode').update('claudeProcessWrapper', standIn, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('claudeAccounts').update('reloadBehavior', 'never', vscode.ConfigurationTarget.Global);
    api = await vscode.extensions.getExtension(ID).activate();
    await mod('extension')._internals.startupDone();
    const accounts = mod('accounts');
    await accounts.saveRecords([
      { id: 'cc-a', dir: dirA, mode: 'isolated' },
      { id: 'cc-b', dir: dirB, mode: 'isolated' },
    ]);
    await accounts.updateMeta('cc-a', { name: 'CC A' });
    await accounts.updateMeta('cc-b', { name: 'CC B' });
    await until(() => accounts.findAccount('cc-b'), 'the accounts');
    await mod('identity').refreshAllIdentities();
    await mod('switching').selectAccount(accounts.findAccount('cc-a'), undefined, { silent: true });
    const official = vscode.extensions.getExtension('anthropic.claude-code');
    assert.ok(official, 'the Claude Code extension is installed');
    await official.activate();
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('claudeCode').update('claudeProcessWrapper', undefined, vscode.ConfigurationTarget.Global);
  });

  test('its code still follows a CLAUDE_CONFIG_DIR change without a reload', async () => {
    assert.strictEqual(
      await mod('live').officialSupports(),
      true,
      `Claude Code ${vscode.extensions.getExtension('anthropic.claude-code').packageJSON.version}`
    );
  });

  test('a new chat starts as the current account', async () => {
    await vscode.commands.executeCommand('claude-vscode.editor.open');
    await until(() => spawns().some((s) => s.dir === dirA), 'a claude process as A');
  });

  test('after switching without a reload, the panel is told and new chats start as the new account', async () => {
    const env = mod('environment');
    const how = await mod('switching').selectAccount(mod('accounts').findAccount('cc-b'), undefined, { silent: true });
    assert.strictEqual(how, 'live');
    assert.ok(!env.reloadPending('cc-b'));
    await until(
      () => /CLAUDE_CONFIG_DIR changed in the claudeCode\.environmentVariables setting; refreshing every webview/.test(claudeCodeLog()),
      'Claude Code to refresh'
    );
    assert.strictEqual(
      vscode.workspace.getConfiguration('claudeCode').inspect('environmentVariables').globalValue,
      undefined,
      'the setting is left as it was'
    );
    const before = spawns().length;
    await vscode.commands.executeCommand('claude-vscode.editor.open');
    await until(
      () =>
        spawns()
          .slice(before)
          .some((s) => s.dir === dirB),
      'a claude process as B'
    );
  });

  test('continuing with another account opens a forked copy in a new tab, as that account', async () => {
    const project = path.join(dirB, 'projects', mod('../lib/usage').encodeProjectDir(folder));
    const sid = '0f0e0d0c-0b0a-4908-8706-050403020100';
    fs.mkdirSync(project, { recursive: true });
    // A small but complete conversation, as Claude Code writes it.
    const common = {
      cwd: folder,
      entrypoint: 'claude-vscode',
      gitBranch: '',
      isSidechain: false,
      sessionId: sid,
      userType: 'external',
      version: '2.1.0',
    };
    const u1 = '1a1a1a1a-0000-4000-8000-000000000001';
    const u2 = '1a1a1a1a-0000-4000-8000-000000000002';
    const lines = [
      {
        ...common,
        type: 'user',
        uuid: u1,
        parentUuid: null,
        timestamp: '2026-11-18T10:00:00.000Z',
        message: { role: 'user', content: 'Remember PINEAPPLE.' },
      },
      {
        ...common,
        type: 'assistant',
        uuid: u2,
        parentUuid: u1,
        timestamp: '2026-11-18T10:00:01.000Z',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'OK.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      { type: 'ai-title', sessionId: sid, aiTitle: 'Pineapple' },
    ];
    fs.writeFileSync(path.join(project, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const before = spawns().length;
    await mod('handoff').continueInPanel(mod('accounts').findAccount('cc-a'));
    assert.strictEqual(mod('accounts').selectedAccount().id, 'cc-a');
    const forked = await until(
      () =>
        spawns()
          .slice(before)
          .find((s) => s.dir === dirA && /--resume[= ][0-9a-f-]{36}/.test(s.args) && !s.args.includes(sid)),
      'the forked conversation to start as A'
    ).catch((e) => {
      const log = claudeCodeLog().split('\n').slice(-40).join('\n');
      throw new Error(`${e.message}\nprocesses: ${JSON.stringify(spawns().slice(before))}\nClaude Code log:\n${log}`);
    });
    const id = /--resume[= ]([0-9a-f-]{36})/.exec(forked.args)[1];
    assert.ok(fs.existsSync(path.join(dirA, 'projects', mod('../lib/usage').encodeProjectDir(folder), `${id}.jsonl`)), 'the copy is in A');
  });
});
