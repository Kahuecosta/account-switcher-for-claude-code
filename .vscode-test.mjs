import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

// Runs the integration tests inside a real VS Code. VSCODE_TEST_VERSION picks the build
// ("stable", "insiders" or e.g. "1.85.0", the minimum supported version).
export default defineConfig({
  files: 'test/integration/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  workspaceFolder: './test/integration/fixtures/workspace',
  // A short user data folder: macOS limits the path of VS Code's socket to 104 characters.
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${path.join(os.tmpdir(), 'cas-vsc')}`],
  env: { CLAUDE_ACCOUNTS_TEST: '1' },
  mocha: { ui: 'tdd', timeout: 60000 },
});
