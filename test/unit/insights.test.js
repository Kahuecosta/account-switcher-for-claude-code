'use strict';
// What the figures mean: when a window runs out, what used it up, and which conversations are heavy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { setup, tick } = require('./helpers');
const { forecast } = require('../../lib/pace');
const { UsageIndex, usedBy, contextOf, encodeProjectDir } = require('../../lib/usage');
const { liveSessions } = require('../../lib/sessions');

const env = setup({ shareHistory: true, usageBreakdown: 'conversation', forecast: 'both' });
const { context, home, write, messages, vscode } = env;
test.after(env.dispose);

const dir = (id) => (id === '__default__' ? path.join(home, '.claude') : path.join(home, '.claude-accounts', id));
const MIN = 60e3;
const HOUR = 3600e3;
const T0 = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ───────── forecast ─────────

test('forecast: the recent pace when there are readings, the average otherwise', () => {
  const opts = { at: T0, lengthMs: 5 * HOUR, minSpanMs: 10 * MIN, recentMs: 45 * MIN };
  const w = { usedPct: 50, resetsAt: T0 + 4 * HOUR };
  assert.deepStrictEqual(forecast(w, opts), { runsOut: true, hitAt: T0 + HOUR }, '50% in the first hour');
  const samples = [
    { at: T0 - 50 * MIN, pct: 1 }, // too old
    { at: T0 - 40 * MIN, pct: 46 },
    { at: T0 - 5 * MIN, pct: 49 }, // too close
  ];
  assert.deepStrictEqual(forecast(w, { ...opts, samples }), { runsOut: false, hitAt: T0 + 500 * MIN }, '4% in 40 minutes');
  assert.deepStrictEqual(forecast(w, { ...opts, samples: [{ at: T0 - 30 * MIN, pct: 50 }] }), { runsOut: false, hitAt: null }, 'idle');
  assert.strictEqual(forecast({ usedPct: 5, resetsAt: T0 + 5 * HOUR - MIN }, opts), null, 'just started');
  for (const x of [null, { usedPct: 100, resetsAt: T0 + HOUR }, { usedPct: 0, resetsAt: T0 + HOUR }, { usedPct: 50, resetsAt: null }])
    assert.strictEqual(forecast(x, opts), null);
});

// ───────── transcripts ─────────

const response = (
  session,
  ts,
  { out = 0, read = 0, write1h = 0, write5m = 0, input = 0, id, cwd, side = false, model = 'claude-opus-5-5' } = {}
) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: session,
    timestamp: iso(ts),
    cwd,
    isSidechain: side,
    requestId: 'r',
    message: {
      id: id || `${session}-${ts}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: out,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write1h + write5m,
        cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m },
      },
    },
  }) + '\n';
const projects = path.join(dir('__default__'), 'projects');
const file = (project, ...rest) => path.join(projects, project, ...rest);
const A = path.join(home, 'alpha');
const B = path.join(home, 'beta');

test('conversations: cost by kind of token, titles, latest context, subagents, duplicates', async () => {
  write(
    file('p-alpha', 's1.jsonl'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'arregla esto', sessionId: 's1' }) +
      '\n' +
      response('s1', T0 - 3 * HOUR, { out: 100, read: 1000, cwd: A }) +
      response('s1', T0 - 2 * HOUR, { out: 100, read: 400000, write1h: 1000, write5m: 100, input: 10, cwd: A, id: 'dup' }) +
      response('s1', T0 - 2 * HOUR, { out: 100, read: 400000, write1h: 1000, write5m: 100, input: 10, cwd: A, id: 'dup' }) +
      JSON.stringify({ type: 'ai-title', aiTitle: 'Arreglo del tablero', sessionId: 's1' }) +
      '\n'
  );
  write(
    file('p-alpha', 's1', 'subagents', 'x.jsonl'),
    response('s1', T0 - HOUR, { out: 10, read: 5, side: true, model: 'claude-haiku-5-5', cwd: A })
  );
  write(file('p-beta', 's2.jsonl'), response('s2', T0 - HOUR, { out: 400, read: 50000, cwd: B }));
  const index = new UsageIndex();
  await index.summarize(projects);
  const list = index.conversations(projects);
  const s1 = list.find((c) => c.session === 's1');
  assert.deepStrictEqual([s1.title, s1.cwd, s1.context, s1.records.length], ['Arreglo del tablero', A, 401110, 3]);
  assert.deepStrictEqual(
    s1.records.map((r) => Math.round(r.cost * 1000) / 1000).sort((x, y) => x - y),
    [1.256, 550, 22635],
    'haiku, then 5x output + 0.05x read, then also 2x and 1.25x writes'
  );
  const all = usedBy(list, { from: T0 - 5 * HOUR, owner: () => true, top: 1 });
  assert.strictEqual(all.rows[0].session, 's1');
  assert.strictEqual(Math.round(all.rows[0].pct + all.others), 100);
  const recent = usedBy(list, { from: T0 - 90 * MIN, owner: (s) => s === 's2' });
  assert.deepStrictEqual([recent.rows.map((r) => [r.session, r.pct]), recent.others], [[['s2', 100]], 0]);
  assert.deepStrictEqual(usedBy(list, { from: T0, owner: () => true }), { rows: [], others: 0 });
});

test('contextOf: only responses of the conversation itself', () => {
  const o = JSON.parse(response('s1', T0, { read: 10, input: 2, write1h: 3 }));
  assert.deepStrictEqual(contextOf(o), { session: 's1', tokens: 15, ts: T0 });
  assert.strictEqual(contextOf({ ...o, isSidechain: true }), null);
  assert.strictEqual(contextOf({ ...o, type: 'user' }), null);
  assert.strictEqual(contextOf(null), null);
});

// ───────── in the window ─────────

const sessionFile = (id, pid, session, startedAt) =>
  write(path.join(dir(id), 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: session, startedAt, cwd: A }));
const saved = (id, at, five, seven = 20) => {
  const json = id === '__default__' ? path.join(home, '.claude.json') : path.join(dir(id), '.claude.json');
  write(
    json,
    JSON.stringify({
      oauthAccount: { accountUuid: id, emailAddress: 'x@x.com' },
      cachedUsageUtilization: {
        accountUuid: id,
        fetchedAtMs: at,
        utilization: {
          five_hour: { utilization: five, resets_at: iso(T0 + HOUR) },
          seven_day: { utilization: seven, resets_at: iso(T0 + 2 * 24 * HOUR) },
        },
      },
    })
  );
};
const card = (id) =>
  env
    .load('ui/panel')
    .viewModel()
    .cards.find((c) => c.id === id);

test('setup: two accounts that share their history', async () => {
  fs.mkdirSync(path.join(dir('b'), 'sessions'), { recursive: true });
  saved('__default__', T0 - 60 * MIN, 60);
  saved('b', T0 - 2 * MIN, 40, 90);
  await context.globalState.update('schemaVersion', 3);
  await context.globalState.update('accounts', [{ id: 'b', dir: dir('b'), mode: 'shared' }]);
  await context.globalState.update('accountMeta', { b: { name: 'B', icon: '2️⃣' } });
  env.respond = () => undefined;
  const ext = require('../../src/extension');
  ext.activate(context);
  await ext._internals.startupDone();
});

test('pace: readings are remembered, for this window only, and shown with the bars', async () => {
  const quota = env.load('quota');
  const b = env.load('accounts').findAccount('b');
  await env.load('state').update('usageSamples', {
    b: [
      [T0 - 32 * MIN, 10, T0 + HOUR],
      [T0 - 31 * MIN, 99, T0 - HOUR],
    ],
  });
  saved('b', T0 - MIN, 70, 90);
  await quota.refreshQuota(b);
  await quota.refreshQuota(b);
  const stored = env.stored('usageSamples').b;
  assert.strictEqual(stored.filter((s) => s[0] === T0 - MIN).length, 1, 'once');
  const p = quota.paceOf('b', T0);
  assert.ok(p.fiveHour.runsOut, '60% in half an hour');
  assert.ok(Math.abs(p.fiveHour.hitAt - (T0 + 14.5 * MIN)) < MIN, new Date(p.fiveHour.hitAt).toISOString());
  assert.ok(p.sevenDay.runsOut, '90% with two days to go');
  const c = card('b');
  assert.match(c.windows[0].pace, /^At this pace it runs out at /);
  assert.strictEqual(c.windows[0].runsOut, true);
  assert.strictEqual(quota.paceOf('b', T0 + HOUR / 2).fiveHour, null, 'not from an old reading');
  assert.deepStrictEqual(quota.paceOf('nobody'), { fiveHour: null, sevenDay: null });
});

test('what used it: by the account that ran the conversation, not the one that started it', async () => {
  const usage = env.load('usage');
  // s1 ran as Default and went on as B an hour and a half ago; s2 always ran as B. Nothing is known of s9.
  sessionFile('__default__', process.pid, 's1', T0 - 4 * HOUR);
  usage.noteSessions();
  fs.rmSync(path.join(dir('__default__'), 'sessions'), { recursive: true });
  sessionFile('b', process.pid, 's1', T0 - 90 * MIN);
  usage.noteSessions();
  // A process of the old account that is still closing does not take it back.
  sessionFile('__default__', process.pid, 's1', T0 - 4 * HOUR);
  usage.noteSessions();
  sessionFile('b', process.pid, 's2', T0 - 4 * HOUR);
  usage.noteSessions();
  assert.deepStrictEqual(env.stored('sessionAccounts').s1, [
    ['__default__', T0 - 4 * HOUR],
    ['b', T0 - 90 * MIN],
  ]);
  write(file('p-beta', 's9.jsonl'), response('s9', T0 - HOUR, { out: 1e6, cwd: B }));
  await usage.refreshCurrentUsage();
  const own = usage.usedByOf('__default__');
  assert.deepStrictEqual(
    own.fiveHour.rows.map((r) => r.session),
    ['s1']
  );
  const other = usage.usedByOf('b');
  assert.deepStrictEqual(
    other.fiveHour.rows.map((r) => [r.session, Math.round(r.pct)]),
    [
      ['s2', 100],
      ['s1', 0],
    ]
  );
  const [five, week] = card('__default__').used;
  assert.deepStrictEqual([five.label, week.label], ['5-hour', 'weekly']);
  assert.deepStrictEqual(five.rows[0], {
    share: '100%',
    project: 'alpha',
    title: 'Arreglo del tablero',
    context: '401k per response',
    heavy: true,
  });
  assert.strictEqual(usage.usedByOf('nobody'), null);
});

test('live sessions: only running ones', () => {
  assert.deepStrictEqual(
    liveSessions(dir('b'), () => false),
    []
  );
  assert.deepStrictEqual(liveSessions(path.join(home, 'nowhere')), []);
  write(path.join(dir('b'), 'sessions', '1.json'), '{');
  assert.strictEqual(liveSessions(dir('b')).length, 1);
});

test('a heavy conversation is announced once, again when it grows, and after being compacted', async () => {
  const heavy = env.load('heavy');
  const at = (tokens, ts = Date.now(), side = false) => [JSON.parse(response('h', ts, { read: tokens, side }))];
  const warnings = () => messages.filter((m) => /re-reads/.test(m.text)).length;
  messages.length = 0;
  await heavy.note(at(299999));
  await heavy.note(at(500000, Date.now() - HOUR));
  await heavy.note(at(500000, Date.now(), true));
  assert.strictEqual(warnings(), 0, 'below, old, or a subagent');
  await heavy.note(at(320000));
  await heavy.note(at(400000));
  assert.strictEqual(warnings(), 1);
  assert.match(messages.find((m) => /re-reads/.test(m.text)).text, /re-reads 320k tokens/);
  await heavy.note(at(480000));
  assert.strictEqual(warnings(), 2, 'half as much again');
  await heavy.note(at(40000));
  await heavy.note(at(310000));
  assert.strictEqual(warnings(), 3, 'it grew back after /compact');

  let copied = '';
  vscode.env.clipboard = { writeText: async (s) => (copied = s) };
  env.respond = (_t, _x, items) => items[0];
  await heavy.note(at(900000));
  assert.strictEqual(copied, '/compact');
  env.respond = (_t, _x, items) => items[1];
  await heavy.note(at(2000000));
  await heavy.note(at(9000000));
  assert.strictEqual(warnings(), 5, 'not for this conversation any more');
  env.respond = () => undefined;
  env.settings.claudeAccounts.heavyConversationTokens = 0;
  await heavy.note([JSON.parse(response('other', Date.now(), { read: 9e6 }))]);
  assert.strictEqual(warnings(), 5, 'off');
  assert.strictEqual(heavy.isHeavy(9e6), false);
  env.settings.claudeAccounts.heavyConversationTokens = 300000;
});

test('the watcher hands over only the conversations of this window', async () => {
  const w = env.watchers.find((x) => !x.disposed && x.pattern.pattern.endsWith('*.jsonl'));
  messages.length = 0;
  const log = async (name, cwd) => {
    const f = file(encodeProjectDir(cwd), `${name}.jsonl`);
    write(f, response(name, Date.now(), { read: 700000, cwd }));
    for (const h of w.handlers) await h({ fsPath: f });
    await tick(5);
  };
  await log('w1', '/somewhere/else');
  assert.ok(!messages.some((m) => /re-reads/.test(m.text)));
  env.settings.claudeAccounts.onUsageLimit = 'ignore';
  await log('w2', path.join(home, 'sub'));
  assert.ok(
    messages.some((m) => /re-reads 700k/.test(m.text)),
    'also with the usage limits ignored'
  );
  env.settings.claudeAccounts.onUsageLimit = 'suggest';
});

test('status bar: one window, both, or every account; a click on another account never switches', () => {
  const sb = env.load('ui/statusBar');
  const items = [];
  const orig = vscode.window.createStatusBarItem;
  vscode.window.createStatusBarItem = (id) => {
    const it = { id, show() {}, dispose: () => (it.disposed = true) };
    items.push(it);
    return it;
  };
  try {
    sb.create();
    const show = (mode) => {
      env.settings.claudeAccounts.statusBarUsage = mode;
      sb.update();
      return items.filter((i) => !i.disposed);
    };
    assert.match(show('window')[0].text, / · 60%/);
    assert.match(show('both')[0].text, / · 5h 60% · 7d 20%/);
    assert.strictEqual(show('both').length, 1);
    const [main, other] = show('all');
    assert.match(main.text, /5h 60% · 7d 20%/);
    assert.strictEqual(other.text, '2️⃣ 5h 70% · 7d 90%');
    assert.strictEqual(other.command, 'claudeAccounts.panel.focus');
    assert.match(other.tooltip.value, /weekly: 90%/);
    assert.match(other.tooltip.value, /At this pace it runs out/);
    assert.strictEqual(show('all').length, 2, 'updated, not added again');
    assert.strictEqual(show('both').length, 1, 'and removed');
    show('all');
    sb.dispose();
    assert.strictEqual(items.filter((i) => !i.disposed).length, 1);
  } finally {
    vscode.window.createStatusBarItem = orig;
    env.settings.claudeAccounts.statusBarUsage = 'window';
  }
});

// ───────── options ─────────

test('forecast: for both windows, only the weekly one, or none', () => {
  const quota = env.load('quota');
  const known = () => {
    const p = quota.paceOf('b', T0);
    return [!!p.fiveHour, !!p.sevenDay];
  };
  assert.deepStrictEqual(known(), [true, true]);
  env.settings.claudeAccounts.forecast = 'weekly';
  assert.deepStrictEqual(known(), [false, true]);
  const c = card('b');
  assert.deepStrictEqual([c.windows[0].pace, /^At this pace/.test(c.windows[1].pace)], ['', true]);
  env.settings.claudeAccounts.forecast = 'off';
  assert.deepStrictEqual(known(), [false, false]);
  const { configuration } = context.extension.packageJSON.contributes;
  assert.strictEqual(configuration.properties['claudeAccounts.forecast'].default, 'weekly');
});

test('forecast: earlier readings are kept only when they are used', async () => {
  const quota = env.load('quota');
  const b = env.load('accounts').findAccount('b');
  const count = () => env.stored('usageSamples').b.length;
  const before = count();
  env.settings.claudeAccounts.forecast = 'weekly';
  saved('b', T0, 71, 90);
  await quota.refreshQuota(b);
  assert.strictEqual(count(), before);
  env.settings.claudeAccounts.forecast = 'both';
  await quota.refreshQuota(b);
  assert.strictEqual(count(), before + 1);
});

test('what used it: by project shows folders only; off works nothing out', async () => {
  const usage = env.load('usage');
  env.settings.claudeAccounts.usageBreakdown = 'project';
  const [five] = card('b').used;
  assert.deepStrictEqual(
    five.rows.map((r) => [r.project, r.title, r.context]),
    [
      ['beta', '', ''],
      ['alpha', '', ''],
    ]
  );
  env.settings.claudeAccounts.usageBreakdown = 'off';
  assert.strictEqual(card('b').used, null);
  const seen = JSON.stringify(env.stored('sessionAccounts'));
  sessionFile('b', process.pid, 's77', T0);
  usage.noteSessions();
  assert.strictEqual(JSON.stringify(env.stored('sessionAccounts')), seen, 'not even which account runs what');
  env.settings.claudeAccounts.usageBreakdown = 'conversation';
  await usage.refreshCurrentUsage();
  const { configuration } = context.extension.packageJSON.contributes;
  assert.strictEqual(configuration.properties['claudeAccounts.usageBreakdown'].default, 'off');
});

test('what used it: the section is there before anything was recorded, and says so', async () => {
  await env.load('state').update('sessionAccounts', {});
  assert.deepStrictEqual(card('b').used, []);
  const { html } = env.load('ui/panel');
  assert.ok(html('x').includes('s.nothing'));
  // With separate histories only the selected account's is read: the others have no section at all.
  env.settings.claudeAccounts.shareHistory = false;
  assert.strictEqual(card('b').used, null);
  assert.ok(card('__default__').used.length, 'all of it is its own');
  env.settings.claudeAccounts.shareHistory = true;
});

test('the organization can be hidden', async () => {
  const identity = env.load('identity');
  const b = env.load('accounts').findAccount('b');
  await env.load('accounts').setIdentity('b', { email: 'x@x.com', organization: 'x@x.com Organization', plan: 'Pro', loggedIn: true });
  assert.match(identity.identityLine(b), /Organization$/);
  env.settings.claudeAccounts.showOrganization = false;
  assert.strictEqual(identity.identityLine(b), 'x@x.com · Pro');
  env.settings.claudeAccounts.showOrganization = true;
});
