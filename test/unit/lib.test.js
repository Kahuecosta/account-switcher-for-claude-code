'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRemote, matchesPattern, matchRule } = require('../../lib/rules');
const { readIdentity, planLabel } = require('../../lib/identity');
const {
  encodeProjectDir,
  isRateLimitEntry,
  limitInfo,
  summarizeUsage,
  UsageIndex,
  formatTokens,
  totalTokens,
  TailReader,
} = require('../../lib/usage');
const { slugify, initials, isSingleEmoji, maskEmail } = require('../../lib/names');
const { findRepo, parseRemotes, pickRemote, repoInfo } = require('../../lib/git');
const { samePath, isInside, tildify } = require('../../lib/paths');
const { withLock } = require('../../lib/lock');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-lib-')));
const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c);
};

test('slugify: accents, punctuation, Windows reserved names, length', () => {
  assert.strictEqual(slugify('Trabalho Ação!'), 'trabalho-acao');
  assert.strictEqual(slugify('  ---  '), 'account');
  assert.strictEqual(slugify('日本'), 'account');
  assert.strictEqual(slugify('CON'), 'con-account');
  assert.strictEqual(slugify('com1'), 'com1-account');
  assert.strictEqual(slugify('Console'), 'console');
  assert.ok(slugify('x'.repeat(200)).length <= 64);
  assert.ok(!slugify('a'.repeat(63) + ' b').endsWith('-'));
});

test('initials and emoji', () => {
  assert.strictEqual(initials('Trabalho'), 'TR');
  assert.strictEqual(initials('Minha Empresa'), 'ME');
  assert.strictEqual(initials(''), '?');
  assert.ok(isSingleEmoji('🚀'));
  assert.ok(isSingleEmoji('👨‍👩‍👧'), 'ZWJ family is one emoji');
  assert.ok(isSingleEmoji('🇧🇷'), 'flags');
  assert.ok(isSingleEmoji('1️⃣'), 'keycaps');
  assert.ok(isSingleEmoji(' 🧪 '));
  assert.ok(!isSingleEmoji('ab'));
  assert.ok(!isSingleEmoji('🚀🚀'));
  assert.ok(!isSingleEmoji(''));
  assert.strictEqual(maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.strictEqual(maskEmail(null), '');
});

test('paths: samePath, isInside, tildify', () => {
  assert.ok(samePath('/a/b/', '/a/b', 'linux'));
  assert.ok(!samePath('/a/B', '/a/b', 'linux'));
  assert.ok(samePath('/a/B', '/a/b', 'darwin'));
  assert.ok(isInside('/a/b/c', '/a/b', 'linux'));
  assert.ok(isInside('/a/b', '/a/b', 'linux'));
  assert.ok(!isInside('/a/bc', '/a/b', 'linux'));
  assert.ok(!isInside('/a', '/a/b', 'linux'));
  assert.strictEqual(tildify(path.join('/h', 'work', 'x'), '/h'), '~/work/x');
  assert.strictEqual(tildify('/other', '/h'), '/other');
});

test('remotes normalize to the same key', () => {
  const same = [
    'git@github.com:Org/Repo.git',
    'https://github.com/org/repo',
    'ssh://git@github.com/org/repo.git',
    'https://user@github.com/org/repo/',
  ];
  assert.deepStrictEqual(new Set(same.map(normalizeRemote)), new Set(['github.com/org/repo']));
  assert.strictEqual(normalizeRemote('ssh://git@github.com:22/org/repo.git'), 'github.com/org/repo');
});

test('git: repository, worktree and remotes without running git', () => {
  const d = tmp();
  write(
    path.join(d, 'repo', '.git', 'config'),
    '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:up/x.git\n[remote "origin"]\n\turl = "https://github.com/me/x.git" ; comment\n\tfetch = +refs/heads/*\n'
  );
  fs.mkdirSync(path.join(d, 'repo', 'src', 'deep'), { recursive: true });
  assert.strictEqual(findRepo(path.join(d, 'repo', 'src', 'deep')).root, path.join(d, 'repo'));
  assert.deepStrictEqual(repoInfo(path.join(d, 'repo', 'src')), {
    root: path.join(d, 'repo'),
    remote: 'https://github.com/me/x.git',
    remoteName: 'origin',
  });
  // Worktree: .git is a file pointing to <main>/.git/worktrees/wt, whose commondir leads back.
  write(path.join(d, 'repo', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  write(path.join(d, 'wt', '.git'), `gitdir: ${path.join(d, 'repo', '.git', 'worktrees', 'wt')}\n`);
  assert.strictEqual(repoInfo(path.join(d, 'wt')).remote, 'https://github.com/me/x.git');
  assert.deepStrictEqual(repoInfo(path.join(d)), { root: null, remote: null, remoteName: null });
  assert.strictEqual(pickRemote(parseRemotes('[remote "fork"]\nurl = a\n[remote "upstream"]\nurl = b')).name, 'upstream');
  assert.strictEqual(pickRemote(parseRemotes('[remote "fork"]\nurl = a')).name, 'fork');
  assert.strictEqual(pickRemote([]), null);
});

test('rules: path and remote patterns', () => {
  const ctx = { folder: '/home/u/work/api', remote: 'git@github.com:ACME/api.git', home: '/home/u', platform: 'linux' };
  assert.ok(matchesPattern('~/work/**', ctx));
  assert.ok(matchesPattern('~/work', ctx), 'no wildcard = prefix');
  assert.ok(!matchesPattern('~/personal/**', ctx));
  assert.ok(matchesPattern('github.com/acme/*', ctx));
  assert.ok(matchesPattern('github.com/acme', ctx));
  assert.ok(!matchesPattern('github.com/other/*', ctx));
  assert.ok(matchesPattern('**/api', ctx));
  assert.ok(matchesPattern('C:\\Users\\u\\Work\\**', { folder: 'c:\\users\\u\\work\\x', home: 'C:\\Users\\u', platform: 'win32' }));
  const r = matchRule(
    [
      { pattern: '~/personal', account: 'p' },
      { pattern: 'github.com/acme/*', account: 'work' },
    ],
    ctx
  );
  assert.strictEqual(r.account, 'work');
  assert.strictEqual(matchRule([{ pattern: '~/work/**' }], ctx), null, 'rules without account are ignored');
  assert.strictEqual(matchRule('not an array', ctx), null);
});

test('identity: plan, e-mail, logged-out, never secrets', async () => {
  assert.strictEqual(planLabel('max', 'default_claude_max_20x'), 'Max 20x');
  assert.strictEqual(planLabel('pro', null), 'Pro');
  assert.strictEqual(planLabel(undefined, 'x'), null);
  const d = tmp();
  assert.deepStrictEqual(await readIdentity(d), { loggedIn: false, email: null, displayName: null, organization: null, plan: null });
  write(
    path.join(d, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', displayName: 'A', organizationName: 'Org' } })
  );
  write(
    path.join(d, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET', refreshToken: 'SECRET2', subscriptionType: 'pro' } })
  );
  const id = await readIdentity(d);
  assert.deepStrictEqual(id, { loggedIn: true, email: 'a@b.c', displayName: 'A', organization: 'Org', plan: 'Pro' });
  assert.ok(!JSON.stringify(id).includes('SECRET'));
  fs.rmSync(path.join(d, '.credentials.json')); // macOS: no credentials file, only oauthAccount
  assert.strictEqual((await readIdentity(d)).loggedIn, true);
});

test('usage: sums today and 7 days, deduplicates, caches unchanged files', async () => {
  const d = tmp();
  const now = Date.parse('2026-10-17T15:00:00');
  const line = (id, ts, u) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: 'r' + id, message: { id, usage: u } });
  const u = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
  write(
    path.join(d, '-repo', 's1.jsonl'),
    [
      line('m1', now - 3600e3, u),
      line('m1', now - 3600e3, u),
      line('m2', now - 3 * 864e5, u),
      line('m3', now - 10 * 864e5, u),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      'not json',
    ].join('\n') + '\n'
  );
  const r = await summarizeUsage(d, now);
  assert.strictEqual(r.today.messages, 1);
  assert.strictEqual(r.week.messages, 2);
  assert.strictEqual(totalTokens(r.week), 2 * 11110);

  const index = new UsageIndex();
  await index.summarize(d, now);
  const cached = index.files.get(path.join(d, '-repo', 's1.jsonl'));
  await index.summarize(d, now);
  assert.strictEqual(index.files.get(path.join(d, '-repo', 's1.jsonl')), cached, 'unchanged file is not re-read');
  fs.appendFileSync(path.join(d, '-repo', 's1.jsonl'), line('m4', now - 60e3, u) + '\n');
  assert.strictEqual((await index.summarize(d, now)).today.messages, 2, 'changed file is re-read');
  fs.rmSync(path.join(d, '-repo'), { recursive: true });
  assert.strictEqual((await index.summarize(d, now)).week.messages, 0);
  assert.strictEqual(index.files.size, 0, 'deleted files leave the cache');
});

test('formatTokens never rolls over to "1000k"', () => {
  assert.strictEqual(formatTokens(1234567), '1.2M');
  assert.strictEqual(formatTokens(12345), '12k');
  assert.strictEqual(formatTokens(999600), '1.0M');
  assert.strictEqual(formatTokens(1234), '1k');
  assert.strictEqual(formatTokens(999), '999');
  assert.strictEqual(formatTokens(2.5e9), '2.5B');
});

test('usage limits: documented messages, kinds and reset time', () => {
  const err = (text, extra = {}) => ({
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  });
  assert.deepStrictEqual(limitInfo(err("You've hit your session limit · resets 3pm")), { kind: 'session', resetAt: null });
  assert.strictEqual(limitInfo(err("You've hit your weekly limit")).kind, 'weekly');
  assert.strictEqual(limitInfo(err("You've hit your Opus limit")).kind, 'model');
  assert.strictEqual(limitInfo(err("You've hit your monthly spend limit")).kind, 'spend');
  assert.strictEqual(limitInfo(err('API Error', { apiErrorStatus: 429 })).kind, 'unknown');
  assert.strictEqual(limitInfo(err('API Error: Rate limit reached', { error: 'rate_limit' })).kind, 'unknown');
  assert.deepStrictEqual(
    limitInfo({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude AI usage limit reached|1760000000' }] } }),
    { kind: 'session', resetAt: 1760000000000 }
  );
  assert.ok(
    !isRateLimitEntry({
      type: 'assistant',
      message: { content: [{ type: 'text', text: "You've hit your weekly limit? The usage limit of the API is documented here." }] },
    }),
    'normal answers are not errors'
  );
  assert.ok(!isRateLimitEntry(err('Prompt is too long', { error: 'invalid_request' })));
  assert.ok(!isRateLimitEntry(null));
  assert.strictEqual(encodeProjectDir('/home/u/my.repo'), '-home-u-my-repo');
});

test('tail reading: appended lines, partial lines, first read from the tail', async () => {
  const d = tmp();
  const f = path.join(d, 's.jsonl');
  write(f, '{"a":1}\n');
  const tail = new TailReader();
  await tail.prime(f);
  assert.deepStrictEqual(await tail.readNew(f), []);
  fs.appendFileSync(f, '{"b":2}\n{"c":');
  assert.deepStrictEqual(await tail.readNew(f), [{ b: 2 }], 'partial last line waits');
  fs.appendFileSync(f, '3}\n');
  assert.deepStrictEqual(await tail.readNew(f), [{ c: 3 }]);

  // A file seen for the first time is read from its last bytes, skipping the cut-off first line.
  const g = path.join(d, 'big.jsonl');
  write(g, Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(20) })).join('\n') + '\n');
  const small = new TailReader(4 * 1024 * 1024, 200);
  const got = await small.readNew(g);
  assert.ok(got.length > 0 && got.length < 50);
  assert.strictEqual(got[got.length - 1].i, 49);
  assert.ok(
    got.every((o) => typeof o.i === 'number'),
    'no half line parsed'
  );
  // Truncated file starts over.
  fs.writeFileSync(g, '{"z":1}\n');
  assert.deepStrictEqual(await small.readNew(g), [{ z: 1 }]);
});

test('lock: exclusive, released after errors, stale lock taken over', async () => {
  const d = tmp();
  const lock = path.join(d, '.lock');
  let inside = 0;
  await withLock(lock, async () => {
    inside++;
    await assert.rejects(
      withLock(lock, async () => inside++),
      { code: 'ELOCKED' }
    );
  });
  assert.strictEqual(inside, 1);
  assert.ok(!fs.existsSync(lock));
  await assert.rejects(
    withLock(lock, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
  assert.ok(!fs.existsSync(lock), 'released after an error');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, host: os.hostname(), at: Date.now() }));
  assert.strictEqual(await withLock(lock, async () => 'ok'), 'ok', 'dead owner');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, host: 'elsewhere', at: Date.now() - 3600e3 }));
  assert.strictEqual(await withLock(lock, async () => 'ok'), 'ok', 'old lock');
  fs.writeFileSync(lock, 'garbage');
  assert.strictEqual(await withLock(lock, async () => 'ok'), 'ok', 'unreadable lock');
});
