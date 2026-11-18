'use strict';
// Plan usage that Claude Code saves itself: when it checks an account's usage, it stores the answer in
// that account's .claude.json as cachedUsageUtilization. Reading it needs no network and changes no
// file, so it works for every account, including ones this window does not use. The format is
// internal to Claude Code and may change; every field is optional.
const fs = require('fs');

/**
 * @typedef {{ usedPct: number, resetsAt: number | null }} QuotaWindow
 * @typedef {{ name: string, usedPct: number, resetsAt: number | null }} ModelWindow
 * @typedef {{ used: number, limit: number | null, currency: string | null }} ExtraUsage
 * @typedef {{ fiveHour: QuotaWindow | null, sevenDay: QuotaWindow | null, models?: ModelWindow[], extra?: ExtraUsage | null, at: number | null, source: 'cache' | 'statusline', version?: string | null }} Quota
 */

/** @param {unknown} v */
function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') return Date.parse(v) || null;
  return null;
}

// A window whose reset time has passed started again: nothing is used in it until Claude Code says so.
/** @param {any} w @param {number} now @returns {QuotaWindow | null} */
function cachedWindow(w, now) {
  if (!w || typeof w !== 'object' || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  const resetsAt = parseTime(w.resets_at);
  if (resetsAt !== null && resetsAt <= now) return { usedPct: 0, resetsAt: null };
  return { usedPct: Math.max(0, Math.min(100, w.utilization)), resetsAt };
}

const MODEL_WINDOWS = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet'],
];

/** @param {any} e @returns {ExtraUsage | null} */
function extraUsage(e) {
  if (!e || typeof e !== 'object' || e.is_enabled !== true || typeof e.used_credits !== 'number') return null;
  const scale = 10 ** (Number.isInteger(e.decimal_places) ? e.decimal_places : 2);
  return {
    used: e.used_credits / scale,
    limit: typeof e.monthly_limit === 'number' ? e.monthly_limit / scale : null,
    currency: typeof e.currency === 'string' ? e.currency : null,
  };
}

/**
 * Quota from the parsed contents of a .claude.json, or null when it has none for the account signed in
 * there (a saved answer for another login is ignored).
 * @param {any} json @param {number} [now] @returns {Quota | null}
 */
function parseCachedUsage(json, now = Date.now()) {
  const c = json && json.cachedUsageUtilization;
  const u = c && c.utilization;
  if (!u || typeof u !== 'object') return null;
  const signedIn = json.oauthAccount && json.oauthAccount.accountUuid;
  if (!signedIn || (c.accountUuid && c.accountUuid !== signedIn)) return null;
  const fiveHour = cachedWindow(u.five_hour, now);
  const sevenDay = cachedWindow(u.seven_day, now);
  if (!fiveHour && !sevenDay) return null;
  /** @type {ModelWindow[]} */
  const models = [];
  for (const [key, name] of MODEL_WINDOWS) {
    const w = cachedWindow(u[key], now);
    if (w) models.push({ name, ...w });
  }
  return {
    fiveHour,
    sevenDay,
    models,
    extra: extraUsage(u.extra_usage),
    at: typeof c.fetchedAtMs === 'number' ? c.fetchedAtMs : null,
    source: 'cache',
  };
}

// .claude.json can be large (it lists every project) and Claude Code rewrites it often, mostly for other
// reasons. It is read only when its size or time changed, and only the two objects used here are taken
// out of it and parsed; when they are the same text as last time, the earlier result is kept.
/** @type {Map<string, { key: string, sig: string, json: any }>} */
const parsed = new Map();

// The text of the object or array that a top-level `"key":` holds, found by matching brackets outside
// strings; null when the key is missing or the text is cut short (the file is being written).
/** @param {string} text @param {string} key */
function valueText(text, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*`).exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (text[start] !== '{' && text[start] !== '[') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} text @param {string | null} usage @param {string | null} account their text in it
 * @returns {any} the parts used here, or null
 */
function usedParts(text, usage, account) {
  try {
    if (usage !== null || account !== null)
      return {
        cachedUsageUtilization: usage === null ? undefined : JSON.parse(usage),
        oauthAccount: account === null ? undefined : JSON.parse(account),
      };
  } catch {
    /* fall back to the whole file */
  }
  try {
    const json = JSON.parse(text);
    return json && { cachedUsageUtilization: json.cachedUsageUtilization, oauthAccount: json.oauthAccount };
  } catch {
    return null; // being written, or not JSON
  }
}

/** @param {string} jsonPath @param {number} [now] @returns {Promise<Quota | null>} */
async function readCachedUsage(jsonPath, now = Date.now()) {
  // One handle for the check and the read: Claude Code replaces the file often, and the stamp must
  // describe the very text that was read.
  let fh;
  try {
    fh = await fs.promises.open(jsonPath, 'r');
  } catch {
    parsed.delete(jsonPath);
    return null;
  }
  let entry;
  try {
    const st = await fh.stat();
    const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
    entry = parsed.get(jsonPath);
    if (!entry || entry.key !== key) {
      const text = await fh.readFile('utf8');
      const usage = valueText(text, 'cachedUsageUtilization');
      const account = valueText(text, 'oauthAccount');
      const sig = `${usage}\u0000${account}`;
      entry = entry && entry.json && entry.sig === sig ? { ...entry, key } : { key, sig, json: usedParts(text, usage, account) };
      parsed.set(jsonPath, entry);
    }
  } catch {
    return null; // unreadable for now; the next change is read again
  } finally {
    await fh.close();
  }
  return parseCachedUsage(entry.json, now);
}

// The newer of two readings; details only one of them has (per-model limits, extra usage) are kept.
/** @param {Quota | null} a @param {Quota | null} b @returns {Quota | null} */
function mergeQuota(a, b) {
  if (!a || !b) return a || b;
  const [newer, older] = (a.at || 0) >= (b.at || 0) ? [a, b] : [b, a];
  // A window only one of them knows is kept (the status line leaves out windows it has no data for);
  // the merged reading is then only as recent as the older one, so its age is never understated.
  const filled = (!newer.fiveHour && !!older.fiveHour) || (!newer.sevenDay && !!older.sevenDay);
  return {
    ...newer,
    fiveHour: newer.fiveHour || older.fiveHour,
    sevenDay: newer.sevenDay || older.sevenDay,
    at: filled ? older.at : newer.at,
    models: newer.models && newer.models.length ? newer.models : older.models || [],
    extra: newer.extra || older.extra || null,
  };
}

module.exports = { parseCachedUsage, readCachedUsage, mergeQuota };
