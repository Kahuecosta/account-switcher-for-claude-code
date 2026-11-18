import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

// Runs the integration tests inside a real VS Code. VSCODE_TEST_VERSION picks the build
// ("stable", "insiders" or e.g. "1.85.0", the minimum supported version).
// A short user data folder: macOS limits the path of VS Code's socket to 104 characters.
const userData = (/** @type {string} */ name) => path.join(os.tmpdir(), name);

export default defineConfig([
  {
    label: 'extension',
    files: 'test/integration/**/*.test.js',
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    workspaceFolder: './test/integration/fixtures/workspace',
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData('cas-vsc')}`],
    env: { CLAUDE_ACCOUNTS_TEST: '1' },
    mocha: { ui: 'tdd', timeout: 60000 },
  },
  {
    // With the real Claude Code extension from the Marketplace (npm run test:claude-code): checks what
    // switching without a reload relies on, so a Claude Code release that changes it is noticed.
    label: 'claude-code',
    files: 'test/claude-code/**/*.test.js',
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    workspaceFolder: './test/integration/fixtures/workspace',
    installExtensions: ['anthropic.claude-code'],
    launchArgs: ['--disable-workspace-trust', `--user-data-dir=${userData('cas-cc')}`],
    env: { CLAUDE_ACCOUNTS_TEST: '1', CLAUDE_ACCOUNTS_USER_DATA: userData('cas-cc') },
    mocha: { ui: 'tdd', timeout: 120000 },
  },
]);
