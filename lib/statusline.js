'use strict';
// Live quota through Claude Code's status line (https://code.claude.com/docs/en/statusline).
// Claude Code passes JSON on stdin to the statusLine command, including rate_limits.five_hour and
// rate_limits.seven_day ({ used_percentage, resets_at }) for Pro and Max subscribers. The bridge
// saves that JSON in the account folder and then runs the user's own status line, unchanged.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./links');

const SNAPSHOT_FILE = '.multi-account-statusline.json';
const SCRIPT_BASE = 'claude-accounts-statusline';
const isBridgeCommand = (/** @type {unknown} */ cmd) => typeof cmd === 'string' && cmd.includes(SCRIPT_BASE);

const SH = `#!/bin/sh
# Multi-Account Switcher for Claude Code: status line bridge.
# Saves the status line input (it includes rate_limits) where the extension can read it,
# then runs your own status line command, if you had one, with the same input.
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
input=$(cat)
if [ -d "$dir" ]; then
  tmp="$dir/${SNAPSHOT_FILE}.$$"
  printf '%s\\n' "$input" > "$tmp" 2>/dev/null && mv -f "$tmp" "$dir/${SNAPSHOT_FILE}" 2>/dev/null
fi
orig="$(dirname "$0")/originals/$1.cmd"
if [ -n "$1" ] && [ -s "$orig" ]; then
  printf '%s\\n' "$input" | /bin/sh "$orig"
fi
`;

const PS1 = `# Multi-Account Switcher for Claude Code: status line bridge.
# Saves the status line input (it includes rate_limits) where the extension can read it,
# then runs your own status line command, if you had one, with the same input.
param([string]$Key)
$ErrorActionPreference = 'Stop'
$ms = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($ms)
$bytes = $ms.ToArray()
$dir = $env:CLAUDE_CONFIG_DIR
if (-not $dir) { $dir = Join-Path $HOME '.claude' }
try {
  if (Test-Path -LiteralPath $dir -PathType Container) {
    $tmp = Join-Path $dir ('${SNAPSHOT_FILE}.' + $PID)
    [System.IO.File]::WriteAllBytes($tmp, $bytes)
    Move-Item -LiteralPath $tmp -Destination (Join-Path $dir '${SNAPSHOT_FILE}') -Force
  }
} catch { }
if (-not $Key) { exit 0 }
$orig = Join-Path $PSScriptRoot ('originals\\' + $Key + '.cmd')
if (-not (Test-Path -LiteralPath $orig) -or -not ([System.IO.File]::ReadAllText($orig).Trim())) { exit 0 }
# Same shell Claude Code would use: Git Bash when it runs under Git Bash, PowerShell otherwise.
$bash = $env:CLAUDE_CODE_GIT_BASH_PATH
if (-not $bash -and $env:MSYSTEM) { $cmd = Get-Command bash -ErrorAction SilentlyContinue; if ($cmd) { $bash = $cmd.Source } }
$psi = New-Object System.Diagnostics.ProcessStartInfo
if ($bash) {
  $psi.FileName = $bash
  $psi.Arguments = '"' + $orig + '"'
} else {
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot ('originals\\' + $Key + '.ps1')) + '"'
}
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
$p.StandardInput.Close()
$p.WaitForExit()
exit $p.ExitCode
`;

// PowerShell does not hand its own stdin to the commands a script runs, so the original command gets
// the status line input through a pipe, as UTF-8.
/** @param {string} cmd */
const psOriginal = (cmd) =>
  [
    '$OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'try { [Console]::OutputEncoding = $OutputEncoding } catch { }',
    '$ms = New-Object System.IO.MemoryStream',
    '[Console]::OpenStandardInput().CopyTo($ms)',
    '$statusLineInput = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())',
    `$statusLineInput | ${cmd}`,
    '',
  ].join('\r\n');

/** @param {string} s */
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** @param {string} bridgeDir @param {string} key @param {string} [platform] */
function bridgeCommand(bridgeDir, key, platform = process.platform) {
  if (platform === 'win32') {
    const script = path.join(bridgeDir, `${SCRIPT_BASE}.ps1`).replace(/\\/g, '/');
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" ${key}`;
  }
  return `sh ${shQuote(path.posix.join(bridgeDir, `${SCRIPT_BASE}.sh`))} ${key}`;
}

/** @param {string} bridgeDir */
async function writeScripts(bridgeDir) {
  await fs.promises.mkdir(path.join(bridgeDir, 'originals'), { recursive: true });
  await writeAtomic(path.join(bridgeDir, `${SCRIPT_BASE}.sh`), SH);
  await writeAtomic(path.join(bridgeDir, `${SCRIPT_BASE}.ps1`), PS1);
  try {
    await fs.promises.chmod(path.join(bridgeDir, `${SCRIPT_BASE}.sh`), 0o755);
  } catch {
    /* Windows */
  }
}

// One key per settings file, so isolated accounts keep their own original status line.
/** @param {string} settingsPath */
async function keyFor(settingsPath) {
  let real = settingsPath;
  try {
    real = await fs.promises.realpath(settingsPath);
  } catch {
    /* not created yet */
  }
  return crypto.createHash('sha256').update(path.resolve(real)).digest('hex').slice(0, 16);
}

/** @param {string} settingsPath */
async function readSettings(settingsPath) {
  let text;
  try {
    text = await fs.promises.readFile(settingsPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  if (!text.trim()) return {};
  const json = JSON.parse(text); // invalid JSON is reported, never overwritten
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${settingsPath} is not a JSON object`);
  return json;
}

// Writes settings.json. A hard-linked file (Windows fallback for shared items) is written in place so
// the link survives; anything else is replaced atomically.
/** @param {string} settingsPath @param {object} json */
async function writeSettings(settingsPath, json) {
  const text = JSON.stringify(json, null, 2) + '\n';
  let real = settingsPath;
  try {
    real = await fs.promises.realpath(settingsPath);
    if ((await fs.promises.stat(real)).nlink > 1) return fs.promises.writeFile(real, text);
  } catch {
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
  }
  await writeAtomic(real, text);
}

/**
 * Wraps the statusLine of a settings file with the bridge. Idempotent; a status line the user changed
 * since the last install becomes the new original.
 * @param {string} settingsPath @param {string} bridgeDir @param {string} [platform]
 */
async function install(settingsPath, bridgeDir, platform = process.platform) {
  await writeScripts(bridgeDir);
  const settings = await readSettings(settingsPath);
  const key = await keyFor(settingsPath);
  const current = settings.statusLine;
  const command = bridgeCommand(bridgeDir, key, platform);
  if (current && isBridgeCommand(current.command)) {
    if (current.command === command) return { changed: false, key };
  } else {
    const orig = path.join(bridgeDir, 'originals', key);
    await writeAtomic(`${orig}.json`, JSON.stringify(current ?? null));
    const cmd = current && current.type === 'command' && typeof current.command === 'string' ? current.command : '';
    await writeAtomic(`${orig}.cmd`, cmd ? cmd + '\n' : '');
    await writeAtomic(`${orig}.ps1`, cmd ? psOriginal(cmd) : '');
  }
  settings.statusLine = { ...(current || {}), type: 'command', command };
  await writeSettings(settingsPath, settings);
  return { changed: true, key };
}

// Restores the original status line. Returns true when the file changed.
/** @param {string} settingsPath @param {string} bridgeDir */
async function uninstall(settingsPath, bridgeDir) {
  let settings;
  try {
    settings = await readSettings(settingsPath);
  } catch {
    return false;
  }
  if (!settings.statusLine || !isBridgeCommand(settings.statusLine.command)) return false;
  const key = await keyFor(settingsPath);
  const orig = path.join(bridgeDir, 'originals', key);
  let original = null;
  try {
    original = JSON.parse(await fs.promises.readFile(`${orig}.json`, 'utf8'));
  } catch {
    /* no record: just remove the bridge */
  }
  if (original) settings.statusLine = original;
  else delete settings.statusLine;
  await writeSettings(settingsPath, settings);
  for (const ext of ['json', 'cmd', 'ps1']) await fs.promises.rm(`${orig}.${ext}`, { force: true });
  return true;
}

/** @param {any} w @param {number} now */
function window(w, now) {
  if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null;
  let resetsAt = null;
  if (typeof w.resets_at === 'number') resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
  else if (typeof w.resets_at === 'string') resetsAt = Date.parse(w.resets_at) || null;
  if (resetsAt !== null && resetsAt <= now) return null; // that window already reset
  return { usedPct: Math.max(0, Math.min(100, w.used_percentage)), resetsAt };
}

// { fiveHour, sevenDay, at } from a saved status line input, or null when it has no quota data.
/** @param {string} text @param {number} at @param {number} [now] */
function parseSnapshot(text, at, now = Date.now()) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const rl = j && j.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const fiveHour = window(rl.five_hour, now);
  const sevenDay = window(rl.seven_day, now);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, at, version: typeof j.version === 'string' ? j.version : null };
}

/** @param {string} configDir @param {number} [now] */
async function readSnapshot(configDir, now = Date.now()) {
  const file = path.join(configDir, SNAPSHOT_FILE);
  try {
    const [text, st] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
    return parseSnapshot(text, st.mtimeMs, now);
  } catch {
    return null;
  }
}

// Highest usage across the known windows, 0-100, or null.
/** @param {{ fiveHour: any, sevenDay: any } | null} q */
function peakUsage(q) {
  const values = q ? [q.fiveHour, q.sevenDay].filter(Boolean).map((w) => w.usedPct) : [];
  return values.length ? Math.max(...values) : null;
}

module.exports = {
  SNAPSHOT_FILE,
  SCRIPT_BASE,
  isBridgeCommand,
  bridgeCommand,
  install,
  uninstall,
  parseSnapshot,
  readSnapshot,
  peakUsage,
  keyFor,
  SH,
  PS1,
};
