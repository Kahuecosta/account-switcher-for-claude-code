'use strict';
// Runs inside the extension host (see run.js). Seeds demo accounts, drives the UI and captures the
// window with ImageMagick; the GIF is assembled with ffmpeg.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');

const root = path.join(__dirname, '..', '..');
const mod = (name) => require(path.join(root, 'src', name));
const out = process.env.CAS_SHOTS_OUT;
const tmp = process.env.CAS_SHOTS_TMP;
const home = process.env.HOME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280;
const H = 800;

const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c));
};

function windowId() {
  return execFileSync('xdotool', ['search', '--onlyvisible', '--name', 'Visual Studio Code']).toString().trim().split('\n').pop();
}

function shot(name, crop) {
  const file = path.join(tmp, `${name}.png`);
  execFileSync('import', ['-window', windowId(), file]);
  const args = [file];
  if (crop) args.push('-crop', crop, '+repage');
  args.push(path.join(tmp, `${name}-final.png`));
  execFileSync('convert', args);
  return path.join(tmp, `${name}-final.png`);
}

const keep = (src, name) => fs.copyFileSync(src, path.join(out, 'screenshots', name));

async function seed() {
  const now = Math.floor(Date.now() / 1000);
  const dir = (id) => path.join(home, '.claude-accounts', id);
  // Default account: the original ~/.claude.
  write(path.join(home, '.claude.json'), { oauthAccount: { emailAddress: 'you@example.com', organizationName: 'Personal' } });
  write(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: { subscriptionType: 'pro' } });
  write(path.join(home, '.claude', 'settings.json'), {});
  const demo = [
    {
      id: 'work',
      name: 'Work',
      color: 'teal',
      icon: 'briefcase',
      email: 'dev@acme.example',
      org: 'ACME',
      sub: 'max',
      tier: 'default_claude_max_20x',
      q: [42, 18],
    },
    {
      id: 'side-project',
      name: 'Side project',
      color: 'purple',
      icon: '🚀',
      email: 'me@example.com',
      org: null,
      sub: 'max',
      tier: 'default_claude_max_5x',
      q: [8, 31],
    },
    {
      id: 'client',
      name: 'Client',
      color: 'orange',
      icon: 'organization',
      email: 'contractor@client.example',
      org: 'Client Inc.',
      sub: 'team',
      tier: '',
      q: [71, 64],
    },
  ];
  const accounts = mod('accounts');
  await accounts.saveRecords(demo.map((d) => ({ id: d.id, dir: dir(d.id), mode: d.id === 'client' ? 'isolated' : 'shared' })));
  for (const d of demo) {
    write(path.join(dir(d.id), '.claude.json'), { oauthAccount: { emailAddress: d.email, organizationName: d.org || undefined } });
    write(path.join(dir(d.id), '.credentials.json'), { claudeAiOauth: { subscriptionType: d.sub, rateLimitTier: d.tier } });
    write(path.join(dir(d.id), '.multi-account-statusline.json'), {
      rate_limits: {
        five_hour: { used_percentage: d.q[0], resets_at: now + 2 * 3600 + 17 * 60 },
        seven_day: { used_percentage: d.q[1], resets_at: now + 3 * 86400 },
      },
    });
    await accounts.updateMeta(d.id, { name: d.name, color: d.color, icon: d.icon });
  }
  await accounts.updateMeta('__default__', { color: 'blue' });
  // This repository defaults to Work.
  await mod('repo').saveRepoDefaults({ 'remote:github.com/acme/api': { id: 'work', email: 'dev@acme.example' } });
  await mod('health').dismiss('officialMissing');
  await mod('identity').refreshAllIdentities();
  await mod('quota').refreshAllQuota();
  // Start on Work, as if the window had opened with it.
  // Shared-profile demo accounts get their links like real ones.
  for (const d of demo) if (d.id !== 'client') await mod('profile').setUpNewAccount(accounts.findAccount(d.id));
  await mod('health').refresh();
  console.log(
    'meta',
    JSON.stringify(accounts.getMeta()),
    'issues',
    JSON.stringify(
      mod('health')
        .current()
        .map((i) => i.id)
    )
  );
  const work = accounts.findAccount('work');
  await mod('switching').selectAccount(work, undefined, { silent: true });
  mod('environment').state.startedWithId = 'work';
  mod('runtime').notifyChanged();
}

// Refuses to capture anything if real data could show up.
function assertDemoOnly() {
  const accounts = mod('accounts');
  if (mod('runtime').rt.ORIGINAL_ENV) throw new Error('VS Code was launched with CLAUDE_CONFIG_DIR: refusing to take screenshots');
  if (!home || !home.startsWith(tmp) || require('os').homedir() !== home) throw new Error('Not running in the throwaway home folder');
  for (const a of accounts.allAccounts()) {
    const email = accounts.getIdentity(a.id)?.email;
    if (email && !/@(example\.com|[a-z-]+\.example)$/.test(email))
      throw new Error(`Unexpected e-mail in ${a.id}: refusing to take screenshots`);
  }
}

async function run() {
  fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
  execFileSync('xdotool', [
    'search',
    '--onlyvisible',
    '--name',
    'Visual Studio Code',
    'windowmove',
    '0',
    '0',
    'windowsize',
    String(W),
    String(H),
  ]);
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
  await vscode.commands.executeCommand('notifications.clearAll');
  await seed();
  assertDemoOnly();
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('claudeAccounts.accounts.focus');
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(2500);

  // 1. The account picker.
  vscode.commands.executeCommand('claudeAccounts.switch');
  await sleep(1800);
  const picker = shot('picker');
  keep(picker, 'account-picker.png');
  const frames = [shot('frame-1')];
  execFileSync('xdotool', ['key', 'Down']);
  await sleep(500);
  execFileSync('xdotool', ['key', 'Down']);
  await sleep(700);
  frames.push(shot('frame-2'));
  execFileSync('xdotool', ['key', 'Return']);
  await sleep(1500);
  frames.push(shot('frame-3')); // "Reload the window now?" and the sync icon in the status bar
  await vscode.commands.executeCommand('notifications.clearAll');

  // Back to Work for the other shots.
  await mod('switching').selectAccount(mod('accounts').findAccount('work'), undefined, { silent: true });
  await sleep(1000);

  // 2. The Explorer view and the status bar.
  const view = shot('view');
  keep(view, 'accounts-view.png');

  // 3. Usage limit reached: the best other account is offered.
  mod('limits').onLimitReached(mod('accounts').findAccount('work'), { kind: 'session', resetAt: null });
  await sleep(1800);
  const limit = shot('limit');
  keep(limit, 'usage-limit.png');
  frames.push(limit);
  await vscode.commands.executeCommand('notifications.clearAll');

  // Demo GIF: frames at 1.6 s each, 960 px wide, with a shared palette.
  const list = path.join(tmp, 'frames.txt');
  fs.writeFileSync(list, frames.map((f) => `file '${f}'\nduration 1.6`).join('\n') + `\nfile '${frames.at(-1)}'\n`);
  const palette = path.join(tmp, 'palette.png');
  const scale = 'scale=960:-1:flags=lanczos';
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    `${scale},palettegen=stats_mode=diff`,
    palette,
  ]);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-i',
    palette,
    '-lavfi',
    `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
    '-loop',
    '0',
    path.join(out, 'demo.gif'),
  ]);
  console.log(`Screenshots written to ${path.join(out, 'screenshots')} and ${path.join(out, 'demo.gif')}`);
}

module.exports = { run };
