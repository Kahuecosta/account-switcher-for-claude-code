'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeRemote, matchesPattern, matchRule } = require('../lib/rules');
const { readIdentity, planLabel } = require('../lib/identity');
const { encodeProjectDir, isRateLimitEntry, summarizeUsage, formatTokens, totalTokens, TailReader } = require('../lib/usage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cas-lib-'));
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

test('remotes normalize to the same key', () => {
  const same = ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'ssh://git@github.com/org/repo.git', 'https://user@github.com/org/repo/'];
  assert.deepStrictEqual(new Set(same.map(normalizeRemote)), new Set(['github.com/org/repo']));
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
  const r = matchRule([{ pattern: '~/personal', account: 'p' }, { pattern: 'github.com/acme/*', account: 'work' }], ctx);
  assert.strictEqual(r.account, 'work');
  assert.strictEqual(matchRule([{ pattern: '~/work/**' }], ctx), null, 'rules without account are ignored');
});

test('identity: plan, e-mail, logged-out', async () => {
  assert.strictEqual(planLabel('max', 'default_claude_max_20x'), 'Max 20x');
  assert.strictEqual(planLabel('pro', null), 'Pro');
  assert.strictEqual(planLabel(undefined, 'x'), null);
  const d = tmp();
  assert.deepStrictEqual(await readIdentity(d), { loggedIn: false, email: null, displayName: null, organization: null, plan: null });
  write(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', displayName: 'A', organizationName: 'Org' } }));
  write(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET', refreshToken: 'SECRET2', subscriptionType: 'pro' } }));
  const id = await readIdentity(d);
  assert.deepStrictEqual(id, { loggedIn: true, email: 'a@b.c', displayName: 'A', organization: 'Org', plan: 'Pro' });
  assert.ok(!JSON.stringify(id).includes('SECRET'));
  // macOS: no credentials file, only oauthAccount
  fs.rmSync(path.join(d, '.credentials.json'));
  assert.strictEqual((await readIdentity(d)).loggedIn, true);
});

test('usage: sums today and 7 days, deduplicates repeated responses', async () => {
  const d = tmp();
  const now = Date.parse('2026-10-17T15:00:00');
  const line = (id, ts, u) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: 'r' + id, message: { id, usage: u } });
  const u = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
  write(path.join(d, '-repo', 's1.jsonl'), [
    line('m1', now - 3600e3, u),
    line('m1', now - 3600e3, u), // duplicate
    line('m2', now - 3 * 864e5, u),
    line('m3', now - 10 * 864e5, u), // older than 7 days
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    'not json',
  ].join('\n') + '\n');
  const r = await summarizeUsage(d, now);
  assert.strictEqual(r.today.messages, 1);
  assert.strictEqual(r.week.messages, 2);
  assert.strictEqual(totalTokens(r.week), 2 * 11110);
  assert.strictEqual(formatTokens(1234567), '1.2M');
  assert.strictEqual(formatTokens(12345), '12k');
});

test('rate limit detection and tail reading', async () => {
  assert.ok(isRateLimitEntry({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: Rate limit reached' }] } }));
  assert.ok(isRateLimitEntry({ type: 'assistant', message: { content: [{ type: 'text', text: 'Claude AI usage limit reached|1760000000' }] } }));
  assert.ok(!isRateLimitEntry({ type: 'assistant', message: { content: [{ type: 'text', text: 'The usage limit of the API is documented here.' }] } }), 'normal answers are not errors');
  assert.ok(!isRateLimitEntry({ isApiErrorMessage: true, error: 'invalid_request', message: { content: [{ text: 'Prompt is too long' }] } }));
  assert.strictEqual(encodeProjectDir('/home/u/my.repo'), '-home-u-my-repo');

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
});

test('remote port is ignored and token counts never roll over to "1000k"', () => {
  const { normalizeRemote } = require('../lib/rules');
  const { formatTokens } = require('../lib/usage');
  assert.strictEqual(normalizeRemote('ssh://git@github.com:22/org/repo.git'), 'github.com/org/repo');
  assert.strictEqual(formatTokens(999600), '1.0M');
  assert.strictEqual(formatTokens(1234), '1k');
});
