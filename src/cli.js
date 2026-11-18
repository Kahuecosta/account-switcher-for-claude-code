'use strict';
// The claude CLI: the one on PATH, or the binary bundled with the Claude Code extension. Many people only
// have the extension, so terminals opened by this extension get the bundled binary on their PATH.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { OFFICIAL_EXTENSION_ID } = require('./runtime');

const exe = (platform = process.platform) => (platform === 'win32' ? 'claude.exe' : 'claude');

// Same places, in the same order, as the Claude Code extension looks for its own binary.
/** @param {string} extensionPath */
function bundledCandidates(extensionPath, platform = process.platform, arch = process.arch) {
  const dirs = [`${platform}-${arch}`, `${platform}-${arch}-musl`];
  if (platform === 'win32' && arch === 'arm64') dirs.push('win32-x64');
  return [
    ...dirs.map((d) => path.join(extensionPath, 'resources', 'native-binaries', d, exe(platform))),
    path.join(extensionPath, 'resources', 'native-binary', exe(platform)),
  ];
}

/** @returns {string | null} */
function bundledClaude() {
  const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
  if (!ext) return null;
  return bundledCandidates(ext.extensionPath).find((p) => fs.existsSync(p)) || null;
}

/** @param {Record<string, string | undefined>} env */
const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

/** @param {Record<string, string | undefined>} env */
function onPath(env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of String(env[pathKey(env)] || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, 'claude' + ext.toLowerCase())).isFile()) return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

// The binary to run directly (diagnostics): the one the Claude Code panel uses when available.
const claudeExecutable = () => bundledClaude() || 'claude';

// Adds the bundled binary's folder to a terminal environment when `claude` is not on its PATH. It goes
// last, so a claude that the shell's own startup files put on the PATH (not seen by VS Code when it was
// started from a desktop launcher) still comes first.
/** @param {Record<string, string>} env @returns {Record<string, string>} */
function withClaudeOnPath(env) {
  if (onPath(env)) return env;
  const bin = bundledClaude();
  if (!bin) return env;
  const key = pathKey(env);
  return { ...env, [key]: [env[key], path.dirname(bin)].filter(Boolean).join(path.delimiter) };
}

module.exports = { bundledCandidates, bundledClaude, onPath, claudeExecutable, withClaudeOnPath };
