'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');

const env = setup();
const { context, home, write, messages, commands, settings, vscode } = env;
test.after(env.dispose);
const dir = (id) => path.join(home, '.claude-accounts', id);

test('setup', async () => {
  for (const id of ['work', 'side']) fs.mkdirSync(dir(id), { recursive: true });
  write(
    path.join(dir('work'), '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'dev@acme.com', organizationName: 'ACME' } })
  );
  write(
    path.join(dir('work'), '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } })
  );
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [
    { id: 'work', dir: dir('work'), mode: 'shared' },
    { id: 'side', dir: dir('side'), mode: 'isolated', kind: 'bedrock' },
  ]);
  await context.globalState.update('accountMeta', { work: { name: 'Work [*]', color: 'teal', icon: '🚀' }, side: { name: 'Side' } });
  await context.workspaceState.update('selectedAccount', 'work');
  env.extensions['anthropic.claude-code'] = { isActive: false, packageJSON: { version: '2.1.312' }, extensionPath: '/nowhere' };
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
});

test('status bar: name, plan, emoji, accessible label, escaped trusted tooltip', () => {
  const sb = env.load('ui/statusBar');
  let item;
  const orig = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = () => (item = { show() {}, dispose() {} });
  sb.create();
  sb.update();
  vscode.window.createStatusBarItem = orig;
  assert.strictEqual(item.text, '🚀 Claude: Work [*] · Max 5x');
  assert.strictEqual(item.color.id, 'claudeAccounts.teal');
  assert.match(item.accessibilityInformation.label, /Claude Code account: Work \[\*\], Max 5x/);
  assert.ok(item.tooltip.value.includes('Work \\[\\*\\]'), 'user text is escaped in Markdown');
  assert.deepStrictEqual(item.tooltip.isTrusted.enabledCommands.includes('claudeAccounts.switch'), true);
  assert.ok(item.tooltip.value.includes('(command:claudeAccounts.diagnose)'));

  // A switch makes a reload pending: shown in the text and the tooltip.
  env.load('environment').applyEnv(env.load('accounts').findAccount('side'));
  context.workspaceState.update('selectedAccount', 'side');
  sb.update();
  assert.ok(item.text.startsWith('$(sync) '));
  assert.ok(item.tooltip.value.includes('still uses'));
});

test('tree items: context values drive the menus', () => {
  const { AccountsTree } = env.load('ui/tree');
  const accounts = env.load('accounts');
  const tree = new AccountsTree();
  const items = Object.fromEntries(tree.getChildren().map((a) => [a.id, tree.getTreeItem(a)]));
  assert.strictEqual(items.__default__.contextValue, 'account.other.default.login');
  assert.strictEqual(items.work.contextValue, 'account.other.shared.login');
  assert.strictEqual(items.side.contextValue, 'account.current.isolated');
  assert.match(items.side.description, /current · Amazon Bedrock/);
  assert.strictEqual(accounts.isSignedIn(accounts.findAccount('side')), true);
  // The when-clauses in package.json match these values.
  const menus = context.extension.packageJSON.contributes.menus['view/item/context'];
  const when = (cmd) => menus.filter((m) => m.command === cmd).map((m) => new RegExp(m.when.match(/viewItem =~ \/(.+?)\//)[1]));
  assert.ok(
    when('claudeAccounts.remove').every((re) => !re.test(items.__default__.contextValue)),
    'the Default account cannot be removed'
  );
  assert.ok(when('claudeAccounts.remove').every((re) => re.test(items.work.contextValue)));
  assert.ok(
    when('claudeAccounts.switch').every((re) => !re.test(items.side.contextValue)),
    'no switch on the current account'
  );
  assert.ok(
    when('claudeAccounts.login').every((re) => !re.test(items.side.contextValue)),
    'no login for Bedrock'
  );
  tree.dispose();
});

test('export and import: no secrets, validated, merges without overwriting', async () => {
  const transfer = env.load('transfer');
  const accounts = env.load('accounts');
  await accounts.setEnvVar('work', 'ANTHROPIC_API_KEY', 'sk-NOPE', true);
  settings.claudeAccounts.rules = [{ pattern: '~/w/**', account: 'work' }];
  const data = transfer.buildExport();
  assert.ok(!JSON.stringify(data).includes('sk-NOPE'));
  assert.ok(!JSON.stringify(data).includes(home), 'no machine paths');
  assert.deepStrictEqual(
    data.accounts.map((a) => a.id),
    ['__default__', 'work', 'side']
  );

  assert.throws(() => transfer.validate({ format: 'x' }), /not an account settings export/);
  assert.throws(
    () => transfer.validate({ format: transfer.FORMAT, version: 1, accounts: [{ id: '../../etc', mode: 'shared' }] }),
    /Invalid account/
  );

  data.accounts.push({ id: 'new-one', name: 'New', mode: 'isolated', kind: 'apiKey' });
  data.rules.push({ pattern: '~/n/**', account: 'new-one' }, { pattern: '~/w/**', account: 'other' });
  const { created } = await transfer.applyImport(data);
  assert.deepStrictEqual(created, ['new-one']);
  assert.ok(fs.existsSync(dir('new-one')));
  assert.strictEqual(accounts.findAccount('new-one').kind, 'apiKey');
  assert.deepStrictEqual(
    settings.claudeAccounts.rules,
    [
      { pattern: '~/w/**', account: 'work' },
      { pattern: '~/n/**', account: 'new-one' },
    ],
    'existing rules win'
  );
});

test('links always ask before switching', async () => {
  const { handleUri } = require('../../src/extension')._internals;
  const accounts = env.load('accounts');
  const before = accounts.selectedAccount().id;
  env.respond = () => undefined; // the user closes the dialog
  await handleUri({ path: '/switch', query: 'account=dev@acme.com', toString: () => 'vscode://x/switch' });
  assert.strictEqual(accounts.selectedAccount().id, before);
  const q = messages.at(-1);
  assert.match(q.text, /Switch this window to the Claude Code account "Work \[\*\]"/);
  assert.strictEqual(q.options.modal, true);
  env.respond = (type, text, items) => (/Switch this window/.test(text) ? items[0] : undefined);
  await handleUri({ path: '/switch', query: 'account=work', toString: () => '' });
  assert.strictEqual(accounts.selectedAccount().id, 'work');
  await assert.rejects(handleUri({ path: '/switch', query: 'account=ghost', toString: () => '' }), /No account matches/);
  await assert.rejects(handleUri({ path: '/evil', query: '', toString: () => 'vscode://x/evil' }), /Unknown link/);
});

test('the diagnostics report masks e-mails and stays in English', async () => {
  const { buildReport } = env.load('diagnostics');
  const report = await buildReport({ runAuthStatus: false });
  assert.ok(report.includes('d***@acme.com'));
  assert.ok(!report.includes('dev@acme.com'));
  assert.match(report, /## Accounts/);
  assert.match(report, /### Work \[\*\] \(selected\)/);
  assert.match(report, /- Id: `work` · kind: subscription · mode: shared/);
});

test('appearance: emoji validation uses graphemes', async () => {
  env.pickQuick = (items) => items.find((i) => i.id === 'icon') || items.find((i) => i.icon === '__emoji__');
  env.inputs.push('👨‍👩‍👧');
  await commands.get('claudeAccounts.appearance')('side');
  assert.strictEqual(env.load('accounts').findAccount('side').icon, '👨‍👩‍👧');
});
