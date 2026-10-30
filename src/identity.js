'use strict';
// Account identity (e-mail, plan, organization) read from files Claude Code writes, and avatars.
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { rt, t, cfg, DEFAULT_ID, storageDir, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const { readIdentity, identityFiles, mtimeKey } = require('../lib/identity');

/** @typedef {import('./accounts').Account} Account */

const fileKeys = new Map(); // id -> mtimes of the files last read

/** @param {Account} a */
function identityArgs(a) {
  const dir = accounts.configDirOf(a);
  const legacy = a.id === DEFAULT_ID && !rt.ORIGINAL_ENV ? path.join(os.homedir(), '.claude.json') : undefined;
  return { dir, legacy };
}

/** @param {Account} a */
async function refreshIdentity(a) {
  const { dir, legacy } = identityArgs(a);
  const key = await mtimeKey(identityFiles(dir, legacy));
  if (fileKeys.get(a.id) === key && accounts.getIdentity(a.id)) return false;
  const data = await readIdentity(dir, { legacyJsonPath: legacy });
  fileKeys.set(a.id, key);
  const before = JSON.stringify(accounts.getIdentity(a.id));
  await accounts.setIdentity(a.id, data);
  return before !== JSON.stringify(accounts.getIdentity(a.id));
}

async function refreshAllIdentities() {
  const all = accounts.allAccounts();
  const changes = await Promise.all(all.map((a) => refreshIdentity(a).catch((e) => rt.log.warn(`Identity of ${a.id}: ${e}`))));
  if (cfg('gravatar')) await Promise.all(all.map((a) => ensureGravatar(a).catch(() => null)));
  if (changes.some(Boolean) || cfg('gravatar')) notifyChanged();
}

/** @param {Account} a */
function identityLine(a) {
  const id = accounts.getIdentity(a.id);
  const signedIn = accounts.isSignedIn(a);
  if (a.kind && a.kind !== 'subscription') return accounts.kindLabel(a.kind);
  if (!id) return '';
  if (signedIn === false) return t('not logged in');
  return [id.email, cfg('showPlan') ? id.plan : null, id.organization].filter(Boolean).join(' · ');
}

// ───────── avatars ─────────

/** @param {string} email */
const gravatarHash = (email) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** @param {Account} a */
function avatarUri(a) {
  if (a.avatar) {
    const p = storageDir('avatars', a.avatar);
    if (fs.existsSync(p)) return vscode.Uri.file(p);
  }
  if (cfg('gravatar')) {
    const email = accounts.getIdentity(a.id)?.email;
    if (email) {
      const p = storageDir('gravatar', gravatarHash(email) + '.png');
      try {
        if (fs.statSync(p).size > 0) return vscode.Uri.file(p);
      } catch {
        /* not downloaded */
      }
    }
  }
  return undefined;
}

// Opt-in only: the single network request this extension can make.
/** @param {Account} a */
async function ensureGravatar(a) {
  const email = accounts.getIdentity(a.id)?.email;
  if (!email) return;
  const file = storageDir('gravatar', gravatarHash(email) + '.png');
  try {
    const st = await fs.promises.stat(file);
    const maxAge = st.size > 0 ? 7 * 864e5 : 864e5; // empty file = "no gravatar", retry daily
    if (Date.now() - st.mtimeMs < maxAge) return;
  } catch {
    /* not cached */
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const url = `https://www.gravatar.com/avatar/${gravatarHash(email)}?s=64&d=404`;
  const buf = await new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(Buffer.alloc(0));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024)
          req.destroy(); // an avatar is never this big
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
  if (buf) await fs.promises.writeFile(file, buf);
}

module.exports = { refreshIdentity, refreshAllIdentities, identityLine, avatarUri, ensureGravatar, gravatarHash };
