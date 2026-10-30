'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const sl = require('../../lib/statusline');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-sl-')));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('snapshot parsing: windows, expiry, formats', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const s = (rl) => JSON.stringify({ version: '2.1.312', rate_limits: rl });
  const q = sl.parseSnapshot(
    s({
      five_hour: { used_percentage: 23.5, resets_at: now / 1000 + 3600 },
      seven_day: { used_percentage: 41, resets_at: now / 1000 + 86400 },
    }),
    1,
    now
  );
  assert.deepStrictEqual(q, {
    fiveHour: { usedPct: 23.5, resetsAt: now + 3600e3 },
    sevenDay: { usedPct: 41, resetsAt: now + 86400e3 },
    at: 1,
    version: '2.1.312',
  });
  assert.strictEqual(sl.peakUsage(q), 41);
  const expired = sl.parseSnapshot(
    s({
      five_hour: { used_percentage: 99, resets_at: now / 1000 - 1 },
      seven_day: { used_percentage: 5, resets_at: '2026-11-01T00:00:00Z' },
    }),
    1,
    now
  );
  assert.strictEqual(expired.fiveHour, null, 'a window whose reset passed is dropped');
  assert.strictEqual(expired.sevenDay.resetsAt, Date.parse('2026-11-01T00:00:00Z'), 'ISO reset times are accepted');
  assert.strictEqual(sl.parseSnapshot(JSON.stringify({ model: {} }), 1, now), null, 'no rate_limits (API key, older Claude Code)');
  assert.strictEqual(sl.parseSnapshot('not json', 1, now), null);
  assert.strictEqual(sl.parseSnapshot(s({ five_hour: { used_percentage: 'x' } }), 1, now), null);
  assert.strictEqual(sl.peakUsage(null), null);
  assert.strictEqual(sl.parseSnapshot(s({ five_hour: { used_percentage: 140 } }), 1, now).fiveHour.usedPct, 100);
});

test('install keeps the original status line and other settings; uninstall restores them', async () => {
  const d = tmp();
  const bridge = path.join(d, 'bridge');
  const settings = path.join(d, 'cfg', 'settings.json');
  fs.mkdirSync(path.dirname(settings));
  const original = { type: 'command', command: 'echo mine', padding: 2 };
  fs.writeFileSync(settings, JSON.stringify({ model: 'opus', statusLine: original }));
  const first = await sl.install(settings, bridge, 'linux');
  assert.ok(first.changed);
  const after = readJson(settings);
  assert.strictEqual(after.model, 'opus');
  assert.strictEqual(after.statusLine.padding, 2);
  assert.ok(sl.isBridgeCommand(after.statusLine.command));
  assert.deepStrictEqual(await sl.install(settings, bridge, 'linux'), { changed: false, key: first.key }, 'idempotent');
  assert.strictEqual(fs.readFileSync(path.join(bridge, 'originals', `${first.key}.cmd`), 'utf8'), 'echo mine\n');

  // The user changes the status line later: it becomes the new original.
  fs.writeFileSync(settings, JSON.stringify({ ...after, statusLine: { type: 'command', command: 'echo newer' } }));
  await sl.install(settings, bridge, 'linux');
  assert.ok(await sl.uninstall(settings, bridge));
  assert.deepStrictEqual(readJson(settings), { model: 'opus', statusLine: { type: 'command', command: 'echo newer' } });
  assert.strictEqual(await sl.uninstall(settings, bridge), false, 'nothing to undo');

  // No status line before: uninstall removes the key again.
  const empty = path.join(d, 'empty', 'settings.json');
  await sl.install(empty, bridge, 'linux');
  assert.ok(readJson(empty).statusLine);
  await sl.uninstall(empty, bridge);
  assert.deepStrictEqual(readJson(empty), {});

  // Invalid JSON is never overwritten.
  const bad = path.join(d, 'bad', 'settings.json');
  fs.mkdirSync(path.dirname(bad));
  fs.writeFileSync(bad, '{ nope');
  await assert.rejects(sl.install(bad, bridge, 'linux'));
  assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{ nope');
});

test('the Windows command uses PowerShell with forward slashes', () => {
  const cmd = sl.bridgeCommand('C:\\Users\\me\\.claude-accounts\\.bridge', 'abc', 'win32');
  assert.ok(cmd.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -File "'));
  assert.ok(cmd.includes('C:/Users/me/.claude-accounts/.bridge/claude-accounts-statusline.ps1'));
  assert.ok(sl.bridgeCommand("/home/o'neil/.b", 'k', 'linux').includes(`'/home/o'\\''neil/.b/`), 'POSIX paths are quoted');
});

test('the bridge saves the input and runs the original status line (real shell)', async () => {
  const d = tmp();
  const cfg = path.join(d, 'cfg dir');
  fs.mkdirSync(cfg);
  const settings = path.join(cfg, 'settings.json');
  const echo = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('orig:'+JSON.parse(s).version))"`;
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: echo } }));
  await sl.install(settings, path.join(d, 'bridge dir'));
  const { command } = readJson(settings).statusLine;
  const payload = JSON.stringify({
    version: '2.1.312',
    rate_limits: { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
  });
  const out = execSync(command, {
    input: payload,
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, MSYSTEM: '' },
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  }).toString();
  assert.strictEqual(out.trim(), 'orig:2.1.312');
  const snap = await sl.readSnapshot(cfg);
  assert.strictEqual(snap.fiveHour.usedPct, 42);

  // Without an original status line the bridge prints nothing and still saves the input.
  fs.writeFileSync(settings, '{}');
  await sl.install(settings, path.join(d, 'bridge dir'));
  const out2 = execSync(readJson(settings).statusLine.command, {
    input: payload.replace('42', '7'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, MSYSTEM: '' },
    shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
  }).toString();
  assert.strictEqual(out2.trim(), '');
  assert.strictEqual((await sl.readSnapshot(cfg)).fiveHour.usedPct, 7);
});
