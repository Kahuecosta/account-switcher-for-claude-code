'use strict';
// Pure helpers: usage saved by Claude Code, the plan without .credentials.json, carrying a conversation
// to another account, and the per-chat launcher (run in a real shell).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseCachedUsage, readCachedUsage, mergeQuota } = require('../../lib/quota');
const { readIdentity } = require('../../lib/identity');
const { latestSession, copySession } = require('../../lib/conversations');
const { encodeProjectDir } = require('../../lib/usage');
const w = require('../../lib/wrapper');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-lib-')));
const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};
const ID = '11111111-2222-3333-4444-555555555555';
const ID2 = '66666666-7777-8888-9999-000000000000';

const cached = (now, extra = {}) => ({
  oauthAccount: { accountUuid: 'u1', emailAddress: 'a@x.com' },
  cachedUsageUtilization: {
    fetchedAtMs: now - 60e3,
    accountUuid: 'u1',
    utilization: {
      five_hour: { utilization: 42, resets_at: new Date(now + 3600e3).toISOString() },
      seven_day: { utilization: 7, resets_at: new Date(now + 3 * 864e5).toISOString() },
      seven_day_opus: { utilization: 60, resets_at: new Date(now + 3 * 864e5).toISOString() },
      seven_day_sonnet: null,
      extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 4000, currency: 'USD', decimal_places: 2 },
      ...extra,
    },
  },
});

test('cached usage: windows, per-model limits, extra usage and age', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const q = parseCachedUsage(cached(now), now);
  assert.deepStrictEqual(q, {
    fiveHour: { usedPct: 42, resetsAt: now + 3600e3 },
    sevenDay: { usedPct: 7, resetsAt: now + 3 * 864e5 },
    models: [{ name: 'Opus', usedPct: 60, resetsAt: now + 3 * 864e5 }],
    extra: { used: 12.5, limit: 40, currency: 'USD' },
    at: now - 60e3,
    source: 'cache',
  });
});

test('cached usage: a window that already reset counts as unused; other logins and junk are ignored', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const reset = parseCachedUsage(cached(now, { five_hour: { utilization: 99, resets_at: new Date(now - 1).toISOString() } }), now);
  assert.deepStrictEqual(reset?.fiveHour, { usedPct: 0, resetsAt: null });
  const other = cached(now);
  other.oauthAccount.accountUuid = 'u2';
  assert.strictEqual(parseCachedUsage(other, now), null, 'saved for another login');
  const loggedOut = cached(now);
  delete loggedOut.oauthAccount;
  assert.strictEqual(parseCachedUsage(loggedOut, now), null, 'nobody signed in');
  assert.strictEqual(parseCachedUsage({ cachedUsageUtilization: 'x' }, now), null);
  assert.strictEqual(parseCachedUsage(null, now), null);
  assert.strictEqual(parseCachedUsage(cached(now, { five_hour: null, seven_day: { utilization: 'x' } }), now), null);
});

test('cached usage: read from .claude.json, parsed again only when it changes', async () => {
  const dir = tmp();
  const file = path.join(dir, '.claude.json');
  assert.strictEqual(await readCachedUsage(file), null, 'missing file');
  write(file, JSON.stringify(cached(Date.now())));
  assert.strictEqual((await readCachedUsage(file))?.fiveHour?.usedPct, 42);
  write(file, '{ not json');
  assert.strictEqual(await readCachedUsage(file), null);
});

test('merge: the newer reading wins and keeps details only the other has', () => {
  const a = {
    fiveHour: { usedPct: 10, resetsAt: null },
    sevenDay: null,
    models: [{ name: 'Opus', usedPct: 5, resetsAt: null }],
    extra: null,
    at: 1,
    source: 'cache',
  };
  const b = { fiveHour: { usedPct: 30, resetsAt: null }, sevenDay: null, at: 2, source: 'statusline' };
  const m = mergeQuota(/** @type {any} */ (a), /** @type {any} */ (b));
  assert.strictEqual(m?.fiveHour?.usedPct, 30);
  assert.strictEqual(m?.source, 'statusline');
  assert.deepStrictEqual(m?.models, a.models);
  assert.strictEqual(mergeQuota(null, /** @type {any} */ (b)), b);
});

test('plan without .credentials.json (macOS Keychain): from the organization type and tier', async () => {
  const dir = tmp();
  write(
    path.join(dir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'm@x.com', organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x' },
    })
  );
  const id = await readIdentity(dir);
  assert.strictEqual(id.plan, 'Max 20x');
  assert.strictEqual(id.loggedIn, true);
  write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'm@x.com', organizationType: 'claude_pro' } }));
  assert.strictEqual((await readIdentity(dir)).plan, 'Pro');
  write(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'm@x.com', organizationType: 'api_org' } }));
  assert.strictEqual((await readIdentity(dir)).plan, null, 'unknown types are not guessed');
});

test('sessions: the latest conversation of the folder is found and copied with its files', async () => {
  const root = tmp();
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  const folder = path.join(root, 'repo');
  const pd = path.join(from, 'projects', encodeProjectDir(folder));
  write(path.join(pd, `${ID}.jsonl`), '{"a":1}\n');
  write(path.join(pd, `${ID2}.jsonl`), '{"b":1}\n{"b":2}\n');
  write(path.join(pd, 'not-a-session.jsonl'), 'x');
  write(path.join(pd, ID2, 'subagents', 'agent-1.jsonl'), 'sub');
  write(path.join(from, 'file-history', ID2, 'f@v1'), 'v1');
  const old = new Date(Date.now() - 60e3);
  fs.utimesSync(path.join(pd, `${ID}.jsonl`), old, old);
  assert.strictEqual(await latestSession(from, [path.join(root, 'elsewhere')]), null);
  const s = await latestSession(from, [folder]);
  assert.strictEqual(s?.id, ID2);

  assert.strictEqual(await copySession(/** @type {any} */ (s), from, to), 'copied');
  const dst = path.join(to, 'projects', encodeProjectDir(folder));
  assert.strictEqual(fs.readFileSync(path.join(dst, `${ID2}.jsonl`), 'utf8'), '{"b":1}\n{"b":2}\n');
  assert.strictEqual(fs.readFileSync(path.join(dst, ID2, 'subagents', 'agent-1.jsonl'), 'utf8'), 'sub');
  assert.strictEqual(fs.readFileSync(path.join(to, 'file-history', ID2, 'f@v1'), 'utf8'), 'v1');

  // The other account continued the conversation: an older, shorter copy never replaces it.
  write(path.join(dst, `${ID2}.jsonl`), '{"b":1}\n{"b":2}\n{"b":3}\n');
  await copySession(/** @type {any} */ (s), from, to);
  assert.ok(fs.readFileSync(path.join(dst, `${ID2}.jsonl`), 'utf8').includes('"b":3'));
});

test('sessions: nothing is copied when both accounts share the history folder', async () => {
  const root = tmp();
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  write(path.join(from, 'projects', '-r', `${ID}.jsonl`), 'x\n');
  fs.mkdirSync(to, { recursive: true });
  fs.symlinkSync(path.join(from, 'projects'), path.join(to, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  const s = { id: ID, file: path.join(from, 'projects', '-r', `${ID}.jsonl`), projectDir: path.join(from, 'projects', '-r') };
  assert.strictEqual(await copySession(s, from, to), 'shared');
  await assert.rejects(copySession({ ...s, id: '../x' }, from, to), /Not a session id/);
});

test(
  'per-chat launcher: resume by newest copy, one-time route for a new chat, pass-through (real shell)',
  { skip: process.platform === 'win32' },
  () => {
    const root = tmp();
    const bridge = path.join(root, 'bridge');
    const home = path.join(root, 'home');
    const base = path.join(home, '.claude');
    const accW = path.join(root, 'acc', 'w');
    const accX = path.join(root, 'acc', 'x');
    write(path.join(bridge, w.SCRIPT_NAME), w.wrapperScript({ bridgeDir: bridge }));
    write(path.join(bridge, w.ACCOUNTS_LIST), [w.BASE, accW, accX].join('\n') + '\n');
    const fake = path.join(root, 'fake-claude');
    write(fake, '#!/bin/sh\nprintf "%s|%s" "${CLAUDE_CONFIG_DIR-unset}" "$*"\n');
    fs.chmodSync(fake, 0o755);
    const route = path.join(bridge, w.ROUTE_DIR, 'win1');
    const run = (/** @type {Record<string, string>} */ extra, /** @type {string[]} */ args) => {
      const e = { PATH: process.env.PATH || '', HOME: home, ...extra };
      return execFileSync('sh', [path.join(bridge, w.SCRIPT_NAME), fake, ...args], { env: e, encoding: 'utf8' });
    };
    assert.strictEqual(run({ CLAUDE_CONFIG_DIR: accX }, ['--verbose']), `${accX}|--verbose`, 'nothing to route');

    // Resume: the newest copy wins; the base profile (~/.claude) is used without the variable.
    write(path.join(base, 'projects', 'p', `${ID}.jsonl`), 'x');
    write(path.join(accW, 'projects', 'p', `${ID}.jsonl`), 'x');
    // Times a minute apart: some shells (bash 3.2, /bin/sh on macOS) compare them in whole seconds.
    const at = (/** @type {number} */ ago) => new Date(Date.now() - ago * 1000);
    fs.utimesSync(path.join(base, 'projects', 'p', `${ID}.jsonl`), at(240), at(240));
    fs.utimesSync(path.join(accW, 'projects', 'p', `${ID}.jsonl`), at(120), at(120));
    assert.strictEqual(run({ CLAUDE_CONFIG_DIR: accX }, [`--resume=${ID}`]), `${accW}|--resume=${ID}`, 'newest copy wins');
    fs.utimesSync(path.join(base, 'projects', 'p', `${ID}.jsonl`), at(60), at(60));
    assert.strictEqual(run({ CLAUDE_CONFIG_DIR: accX }, ['--resume', ID]), `unset|--resume ${ID}`, 'the base profile unsets the variable');
    // A window started with CLAUDE_CONFIG_DIR has its own base profile.
    const otherBase = path.join(root, 'main');
    write(path.join(otherBase, 'projects', 'p', `${ID}.jsonl`), 'x');
    assert.strictEqual(
      run({ CLAUDE_CONFIG_DIR: accX, [w.BASE_VAR]: otherBase }, [`--resume=${ID}`]),
      `${otherBase}|--resume=${ID}`,
      'the base of this window'
    );

    // A route is used by the next new chat only, and never by a resumed conversation.
    write(route, w.routeLine(accX));
    // (The newest copy is the base profile's, touched above.)
    assert.strictEqual(
      run({ [w.WINDOW_VAR]: 'win1', CLAUDE_CONFIG_DIR: accW }, [`--resume=${ID}`]),
      `unset|--resume=${ID}`,
      'resume ignores the route'
    );
    assert.ok(fs.existsSync(route), 'and leaves it for the new chat');
    assert.strictEqual(run({ [w.WINDOW_VAR]: 'win1', CLAUDE_CONFIG_DIR: accW }, ['-p']), `${accX}|-p`, 'the new chat takes it');
    assert.ok(!fs.existsSync(route), 'used up');
    assert.strictEqual(
      run({ [w.WINDOW_VAR]: 'win1', CLAUDE_CONFIG_DIR: accW }, ['-p']),
      `${accW}|-p`,
      'the next one keeps the window account'
    );
    write(route, w.routeLine(accX, Date.now() - (w.ROUTE_TTL_S + 30) * 1000));
    assert.strictEqual(run({ [w.WINDOW_VAR]: 'win1', CLAUDE_CONFIG_DIR: accW }, []), `${accW}|`, 'a stale route is ignored');
    assert.strictEqual(run({ CLAUDE_CONFIG_DIR: accW }, ['--resume=../x*']), `${accW}|--resume=../x*`, 'odd ids are ignored');

    // A wrapper of the user's own still runs, with claude as its first argument.
    const own = path.join(root, 'own-wrapper');
    write(own, '#!/bin/sh\nprintf "own:"\nexec "$@"\n');
    fs.chmodSync(own, 0o755);
    write(path.join(bridge, w.SCRIPT_NAME), w.wrapperScript({ bridgeDir: bridge, original: own }));
    assert.strictEqual(run({ CLAUDE_CONFIG_DIR: accW }, ['-p']), `own:${accW}|-p`);
  }
);

test('sessions: a conversation that went on in both accounts is never overwritten', async () => {
  const root = tmp();
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  const pd = path.join(from, 'projects', '-r');
  const dst = path.join(to, 'projects', '-r', `${ID}.jsonl`);
  const s = { id: ID, file: path.join(pd, `${ID}.jsonl`), projectDir: pd };
  write(s.file, 'a\nb\n');
  write(dst, 'a\nb\n');
  assert.strictEqual(await copySession(s, from, to), 'current', 'same content');
  write(dst, 'a\nb\nc-in-B\n');
  assert.strictEqual(await copySession(s, from, to), 'current', 'B continued it');
  write(s.file, 'a\nb\nd-in-A\ne-in-A\nf-in-A\n');
  assert.strictEqual(await copySession(s, from, to), 'diverged', 'both went on');
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'a\nb\nc-in-B\n', 'B keeps every message it has');
  write(dst, 'a\n');
  assert.strictEqual(await copySession(s, from, to), 'copied', 'A extends B');
  assert.strictEqual(fs.readFileSync(dst, 'utf8'), 'a\nb\nd-in-A\ne-in-A\nf-in-A\n');
});

test('review 4: a longer copy in the other account keeps its own subagent files and checkpoints', async () => {
  const root = tmp();
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  const pd = path.join(from, 'projects', '-r');
  write(path.join(pd, `${ID}.jsonl`), 'a\n');
  write(path.join(pd, ID, 'agent.jsonl'), 'old');
  write(path.join(from, 'file-history', ID, 'f@v1'), 'old');
  const dst = path.join(to, 'projects', '-r');
  write(path.join(dst, `${ID}.jsonl`), 'a\nb\nc\n');
  write(path.join(dst, ID, 'agent.jsonl'), 'new');
  write(path.join(to, 'file-history', ID, 'f@v1'), 'new');
  await copySession({ id: ID, file: path.join(pd, `${ID}.jsonl`), projectDir: pd }, from, to);
  assert.strictEqual(fs.readFileSync(path.join(dst, `${ID}.jsonl`), 'utf8'), 'a\nb\nc\n');
  assert.strictEqual(fs.readFileSync(path.join(dst, ID, 'agent.jsonl'), 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(path.join(to, 'file-history', ID, 'f@v1'), 'utf8'), 'new');
});

test('cached usage: the large .claude.json is never parsed whole; a rewrite for other reasons is not parsed at all', async () => {
  const dir = tmp();
  const file = path.join(dir, '.claude.json');
  const now = Date.now();
  const data = cached(now);
  const projects = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`/p/${i}`, { allowedTools: [], note: '{"tricky": "}]"}' }]));
  write(file, JSON.stringify({ projects, ...data }));
  const parse = JSON.parse;
  /** @type {number[]} */
  const sizes = [];
  JSON.parse = (/** @type {any} */ ...a) => {
    sizes.push(String(a[0]).length);
    return parse(...a);
  };
  try {
    assert.strictEqual((await readCachedUsage(file))?.fiveHour?.usedPct, 42);
    const whole = fs.statSync(file).size;
    assert.ok(sizes.length > 0 && sizes.every((n) => n < whole / 10), `only the small parts: ${sizes.join(',')} of ${whole}`);
    sizes.length = 0;
    write(file, JSON.stringify({ projects: { ...projects, extra: 1 }, ...data })); // same usage, other content
    assert.strictEqual((await readCachedUsage(file))?.fiveHour?.usedPct, 42);
    assert.deepStrictEqual(sizes, [], 'same usage and account: nothing parsed');
    const newer = cached(now + 1000, { five_hour: { utilization: 50, resets_at: new Date(now + 3600e3).toISOString() } });
    write(file, JSON.stringify({ projects, ...newer }));
    assert.strictEqual((await readCachedUsage(file, now + 2000))?.fiveHour?.usedPct, 50);
  } finally {
    JSON.parse = parse;
  }
  // A file cut short while being written: no figures rather than wrong ones.
  write(file, JSON.stringify(data).slice(0, 60));
  assert.strictEqual(await readCachedUsage(file), null);
});

test('review 4.7: large conversations are compared in chunks, across chunk boundaries', async () => {
  const root = tmp();
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  const pd = path.join(from, 'projects', '-r');
  const s = { id: ID, file: path.join(pd, `${ID}.jsonl`), projectDir: pd };
  const dst = path.join(to, 'projects', '-r', `${ID}.jsonl`);
  const big = Buffer.alloc(3 * (1 << 20) + 17, 'a');
  write(s.file, Buffer.concat([big, Buffer.from('more\n')]));
  write(dst, big);
  assert.strictEqual(await copySession(s, from, to), 'copied', 'extends it');
  const changed = Buffer.from(big);
  changed[(1 << 20) + 5] = 98; // one byte differs, past the first chunk
  write(dst, changed);
  assert.strictEqual(await copySession(s, from, to), 'diverged');
  assert.ok(fs.readFileSync(dst).equals(changed), 'kept as it was');
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(dst)).filter((n) => n.includes('.tmp')),
    [],
    'no temporary files left'
  );
});

test('review 4.10: a window filled in from an older reading carries that reading age', () => {
  const fresh = { fiveHour: null, sevenDay: { usedPct: 10, resetsAt: null }, at: 1000, source: 'statusline' };
  const old = { fiveHour: { usedPct: 96, resetsAt: null }, sevenDay: { usedPct: 9, resetsAt: null }, at: 10, source: 'cache' };
  const m = mergeQuota(/** @type {any} */ (fresh), /** @type {any} */ (old));
  assert.strictEqual(m?.fiveHour?.usedPct, 96);
  assert.strictEqual(m?.at, 10, 'shown with its real age');
  const both = mergeQuota(/** @type {any} */ ({ ...fresh, fiveHour: { usedPct: 1, resetsAt: null } }), /** @type {any} */ (old));
  assert.strictEqual(both?.at, 1000);
});

test('launcher: a --continue never takes the route meant for a new chat (real shell)', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const bridge = path.join(root, 'bridge');
  write(path.join(bridge, w.SCRIPT_NAME), w.wrapperScript({ bridgeDir: bridge }));
  const route = path.join(bridge, w.ROUTE_DIR, 'win2');
  write(route, w.routeLine(path.join(root, 'x')));
  const fake = path.join(root, 'fake');
  write(fake, '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-unset}"\n');
  fs.chmodSync(fake, 0o755);
  const out = execFileSync('sh', [path.join(bridge, w.SCRIPT_NAME), fake, '--continue'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: root, [w.WINDOW_VAR]: 'win2', CLAUDE_CONFIG_DIR: path.join(root, 'w') },
  });
  assert.strictEqual(out, path.join(root, 'w'));
  assert.ok(fs.existsSync(route), 'still there for the new chat');
});

test('cached usage: without the time of the saved usage, new figures are still picked up', async () => {
  const dir = tmp();
  const file = path.join(dir, '.claude.json');
  const now = Date.now();
  const noTime = (pct) => {
    const d = cached(now, { five_hour: { utilization: pct, resets_at: new Date(now + 3600e3).toISOString() } });
    delete d.cachedUsageUtilization.fetchedAtMs;
    return JSON.stringify(d);
  };
  write(file, noTime(10));
  assert.strictEqual((await readCachedUsage(file))?.fiveHour?.usedPct, 10);
  write(file, noTime(70) + ' ');
  assert.strictEqual((await readCachedUsage(file))?.fiveHour?.usedPct, 70);
});

test('sessions: a diverged copy is not touched, so it never looks newer than it is', async () => {
  const root = tmp();
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  const pd = path.join(from, 'projects', '-r');
  const s = { id: ID, file: path.join(pd, `${ID}.jsonl`), projectDir: pd };
  const dst = path.join(to, 'projects', '-r', `${ID}.jsonl`);
  write(s.file, 'a\nfrom-A\n');
  write(dst, 'a\nfrom-B\n');
  const past = new Date(Date.now() - 3600e3);
  fs.utimesSync(dst, past, past);
  assert.strictEqual(await copySession(s, from, to), 'diverged');
  assert.ok(fs.statSync(dst).mtimeMs < Date.now() - 1800e3, 'mtime unchanged');
});

test(
  'review 6.1: a fork that cannot be written fails instead of waiting forever',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    const { forkSession } = require('../../lib/conversations');
    const root = tmp();
    const from = path.join(root, 'from');
    const to = path.join(root, 'to');
    const pd = path.join(from, 'projects', '-r');
    write(path.join(pd, `${ID}.jsonl`), `${JSON.stringify({ sessionId: ID, big: 'x'.repeat(1 << 20) })}\n`.repeat(4));
    fs.mkdirSync(path.join(to, 'projects', '-r'), { recursive: true });
    fs.chmodSync(path.join(to, 'projects', '-r'), 0o555);
    try {
      const outcome = await Promise.race([
        forkSession({ id: ID, file: path.join(pd, `${ID}.jsonl`), projectDir: pd }, from, to).then(
          () => 'written',
          (e) => `failed: ${e.code}`
        ),
        new Promise((r) => setTimeout(() => r('hung'), 5000)),
      ]);
      assert.match(String(outcome), /^failed: E(ACCES|PERM)$/);
    } finally {
      fs.chmodSync(path.join(to, 'projects', '-r'), 0o755);
    }
  }
);

test('review 6.6: the conversation a transcript belongs to, including a subagent transcript', () => {
  const { sessionOfFile } = require('../../lib/conversations');
  const root = tmp();
  const pd = path.join(root, 'projects', '-r');
  write(path.join(pd, `${ID}.jsonl`), 'x\n');
  write(path.join(pd, ID, 'subagents', 'agent-a1.jsonl'), 'x\n');
  assert.deepStrictEqual(sessionOfFile(path.join(pd, `${ID}.jsonl`)), { id: ID, file: path.join(pd, `${ID}.jsonl`), projectDir: pd });
  assert.deepStrictEqual(sessionOfFile(path.join(pd, ID, 'subagents', 'agent-a1.jsonl')), {
    id: ID,
    file: path.join(pd, `${ID}.jsonl`),
    projectDir: pd,
  });
  assert.strictEqual(sessionOfFile(path.join(pd, 'notes.jsonl')), null);
});

test('review 6.8: the launcher also reads the short -r form (real shell)', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const bridge = path.join(root, 'bridge');
  write(path.join(bridge, w.SCRIPT_NAME), w.wrapperScript({ bridgeDir: bridge }));
  write(path.join(bridge, w.ACCOUNTS_LIST), path.join(root, 'acc') + '\n');
  write(path.join(root, 'acc', 'projects', 'p', `${ID}.jsonl`), 'x');
  const route = path.join(bridge, w.ROUTE_DIR, 'win3');
  write(route, w.routeLine(path.join(root, 'other')));
  const fake = path.join(root, 'fake');
  write(fake, '#!/bin/sh\nprintf "%s" "${CLAUDE_CONFIG_DIR-unset}"\n');
  fs.chmodSync(fake, 0o755);
  const out = execFileSync('sh', [path.join(bridge, w.SCRIPT_NAME), fake, '-r', ID], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: root, [w.WINDOW_VAR]: 'win3', CLAUDE_CONFIG_DIR: path.join(root, 'w') },
  });
  assert.strictEqual(out, path.join(root, 'acc'), 'routed to the account that has it');
  assert.ok(fs.existsSync(route), 'the new-chat route is left alone');
});
