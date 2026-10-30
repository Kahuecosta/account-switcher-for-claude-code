'use strict';
// Captures the README screenshots and demo GIF from a real VS Code running the extension with demo
// data (a throwaway home folder; nothing from your machine is shown).
// Usage (Linux, needs Xvfb, ImageMagick and ffmpeg): xvfb-run -a -s "-screen 0 1440x900x24" npm run screenshots
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const root = path.join(__dirname, '..', '..');

async function main() {
  // VS Code's own terminals set this; the Electron app must not start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Never show the real accounts of the machine that takes the screenshots.
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)_/.test(k)) delete process.env[k];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-shots-')));
  const home = path.join(tmp, 'home');
  const userData = path.join(tmp, 'user-data');
  const workspace = path.join(home, 'src', 'acme-api');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  fs.writeFileSync(path.join(workspace, 'README.md'), '# ACME API\n');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'chat.commandCenter.enabled': false,
        'chat.disableAIFeatures': true,
        'workbench.layoutControl.enabled': false,
        'window.commandCenter': false,
        'window.zoomLevel': 0.5,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.ignoreRecommendations': true,
        'security.workspace.trust.enabled': false,
        'claudeAccounts.liveQuota': true,
        'claudeAccounts.reloadBehavior': 'ask',
      },
      null,
      2
    )
  );
  await runTests({
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'capture.js'),
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes', '--locale=en'],
    extensionTestsEnv: { HOME: home, USERPROFILE: home, CAS_SHOTS_OUT: path.join(root, 'images'), CAS_SHOTS_TMP: tmp },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
