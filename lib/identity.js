'use strict';
// Reads non-secret account identity fields written by Claude Code.
// These formats are undocumented and may change; every field is optional.
// Tokens in .credentials.json are never returned, stored or logged.
const fs = require('fs');
const path = require('path');

async function readJson(p) {
  try {
    return JSON.parse(await fs.promises.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

function planLabel(subscriptionType, rateLimitTier) {
  if (!subscriptionType) return null;
  const s = String(subscriptionType).toLowerCase();
  const name = s.charAt(0).toUpperCase() + s.slice(1);
  const m = String(rateLimitTier || '').match(/(\d+)x/i);
  return s === 'max' && m ? `${name} ${m[1]}x` : name;
}

async function mtimeKey(files) {
  const parts = [];
  for (const f of files) {
    try {
      parts.push((await fs.promises.stat(f)).mtimeMs);
    } catch {
      parts.push(0);
    }
  }
  return parts.join(':');
}

function identityFiles(configDir, legacyJsonPath) {
  const files = [path.join(configDir, '.claude.json'), path.join(configDir, '.credentials.json')];
  if (legacyJsonPath) files.push(legacyJsonPath);
  return files;
}

/** @param {string} configDir @param {{ legacyJsonPath?: string }} [opts] */
async function readIdentity(configDir, { legacyJsonPath } = {}) {
  let oauth = null;
  for (const p of [path.join(configDir, '.claude.json'), legacyJsonPath].filter(Boolean)) {
    const j = await readJson(p);
    if (j && j.oauthAccount) {
      oauth = j.oauthAccount;
      break;
    }
  }
  const creds = await readJson(path.join(configDir, '.credentials.json'));
  const c = creds && creds.claudeAiOauth;
  const sub = (c && c.subscriptionType) || (oauth && oauth.subscriptionType);
  const tier = (c && c.rateLimitTier) || (oauth && (oauth.rateLimitTier || oauth.userRateLimitTier));
  return {
    loggedIn: !!(c || oauth),
    email: (oauth && oauth.emailAddress) || null,
    displayName: (oauth && oauth.displayName) || null,
    organization: (oauth && oauth.organizationName) || null,
    plan: planLabel(sub, tier),
  };
}

module.exports = { readIdentity, planLabel, identityFiles, mtimeKey };
