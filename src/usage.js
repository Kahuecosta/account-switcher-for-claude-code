'use strict';
// Token usage per account from local session logs, cached and refreshed incrementally.
const path = require('path');
const { rt, notifyChanged } = require('./runtime');
const accounts = require('./accounts');
const { UsageIndex } = require('../lib/usage');

const index = new UsageIndex();
/** @type {{ at: number, accountId: string, data: any } | null} */
let cache = null;
/** @type {NodeJS.Timeout | undefined} */
let debounce;

/** @param {import('./accounts').Account} a */
const computeUsage = (a) => index.summarize(path.join(accounts.configDirOf(a), 'projects'));

async function refreshCurrentUsage() {
  const a = accounts.selectedAccount();
  try {
    cache = { at: Date.now(), accountId: a.id, data: await computeUsage(a) };
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

const dispose = () => debounce && clearTimeout(debounce);

module.exports = { computeUsage, refreshCurrentUsage, scheduleRefresh, usageOf, dispose };
