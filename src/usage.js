'use strict';
// Token usage per account from local session logs, cached and refreshed incrementally.
const path = require('path');
const { rt, K, cfg, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const quota = require('./quota');
const state = require('./state');
const { UsageIndex, usedBy } = require('../lib/usage');
const { liveSessions } = require('../lib/sessions');

const index = new UsageIndex();
/** @type {{ at: number, accountId: string, data: any } | null} */
let cache = null;
/** @type {{ accountId: string, list: import('../lib/usage').Conversation[] }} */
let conversations = { accountId: '', list: [] };
/** The latest breakdown of each account, kept while nothing it depends on changes (the views ask often). */
/** @type {Map<string, { deps: any[], value: ReturnType<typeof usedByOf> }>} */
const breakdowns = new Map();
/** @type {NodeJS.Timeout | undefined} */
let debounce;

/** @param {import('./accounts').Account} a */
const computeUsage = (a) => index.summarize(path.join(accounts.configDirOf(a), 'projects'));

async function refreshCurrentUsage() {
  const a = accounts.selectedAccount();
  try {
    cache = { at: Date.now(), accountId: a.id, data: await computeUsage(a) };
    conversations = { accountId: a.id, list: index.conversations(path.join(accounts.configDirOf(a), 'projects')) };
    noteSessions();
    notifyChanged();
  } catch (e) {
    rt.log.warn(`Usage of ${a.id}: ${e}`);
  }
}

// Coalesces bursts of log writes into one refresh.
function scheduleRefresh(delayMs = 30e3) {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = undefined;
    refreshCurrentUsage();
  }, delayMs);
}

/** @param {string} id */
const usageOf = (id) => (cache && cache.accountId === id ? cache.data : null);

// ───────── which account ran a conversation ─────────
// Transcripts do not say it (a conversation keeps the account that started it), but every running claude
// registers in its account's own folder. Seen every minute and remembered.

/** @typedef {ReturnType<typeof usedBy> | null} Used */
const MAX_SESSIONS = 400;
/** @type {Record<string, [string, number][]>} */
const NO_SESSIONS = {};

function noteSessions() {
  try {
    /** @type {Record<string, [string, number][]>} */
    const all = state.get(K.SESSIONS, {});
    /** @type {typeof all} */
    const added = {};
    for (const a of accounts.allAccounts())
      for (const { session, since } of liveSessions(accounts.configDirOf(a))) {
        const list = added[session] || all[session] || [];
        const last = list.at(-1);
        if (last && (last[0] === a.id || last[1] >= since)) continue;
        added[session] = [...list, [a.id, since]];
      }
    if (!Object.keys(added).length) return;
    const entries = Object.entries({ ...all, ...added }).sort(([, x], [, y]) => (x.at(-1)?.[1] || 0) - (y.at(-1)?.[1] || 0));
    state.set(K.SESSIONS, Object.fromEntries(entries.slice(-MAX_SESSIONS)));
  } catch (e) {
    rt.log.warn(`Sessions: ${e}`);
  }
}

// What used up the account's windows: the top conversations of each, as shares of what this computer used
// with it. Null when there is nothing to show.
/** @param {string} id @returns {{ fiveHour: Used, sevenDay: Used } | null} */
function usedByOf(id) {
  const q = quota.quotaOf(id);
  const shared = !!cfg('shareHistory');
  if (!q || (!shared && conversations.accountId !== id)) return null;
  /** @type {Record<string, [string, number][]>} */
  const ran = shared ? state.get(K.SESSIONS, NO_SESSIONS) : NO_SESSIONS;
  const deps = [conversations, shared, ran, q.fiveHour && q.fiveHour.resetsAt, q.sevenDay && q.sevenDay.resetsAt];
  const kept = breakdowns.get(id);
  if (kept && kept.deps.every((d, i) => d === deps[i])) return kept.value;
  const owner = (/** @type {string} */ session, /** @type {number} */ ts) =>
    !shared || (ran[session] || []).filter((r) => r[1] <= ts).at(-1)?.[0] === id;
  const of = (/** @type {{ resetsAt: number | null } | null} */ w, /** @type {number} */ lengthMs) => {
    const u = w && w.resetsAt ? usedBy(conversations.list, { from: w.resetsAt - lengthMs, owner }) : null;
    return u && u.rows.length ? u : null;
  };
  const fiveHour = of(q.fiveHour, 5 * 3600e3);
  const sevenDay = of(q.sevenDay, 7 * 864e5);
  const value = fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
  breakdowns.set(id, { deps, value });
  return value;
}

const dispose = () => debounce && clearTimeout(debounce);

module.exports = { computeUsage, refreshCurrentUsage, scheduleRefresh, usageOf, noteSessions, usedByOf, dispose };
