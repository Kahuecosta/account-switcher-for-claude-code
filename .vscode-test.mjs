import { defineConfig } from '@vscode/test-cli';

// Runs the integration tests inside a real VS Code. VSCODE_TEST_VERSION picks the build
// ("stable", "insiders" or e.g. "1.85.0", the minimum supported version).
export default defineConfig({
  files: 'test/integration/**/*.test.js',
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  workspaceFolder: './test/integration/fixtures/workspace',
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  env: { CLAUDE_ACCOUNTS_TEST: '1' },
  mocha: { ui: 'tdd', timeout: 60000 },
});
