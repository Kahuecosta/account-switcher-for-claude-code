'use strict';
// Small formatting helpers shared by the status bar, pickers and tree.
const vscode = require('vscode');
const { t, cfg, COLORS, DEFAULT_ID } = require('../runtime');
const accounts = require('../accounts');
const quota = require('../quota');
const { isCodiconId } = require('../../lib/names');

/** @typedef {import('../accounts').Account} Account */

/** @param {string | undefined} c */
const themeColor = (c) => (c && COLORS.includes(c) ? new vscode.ThemeColor(`claudeAccounts.${c}`) : undefined);

/** @param {Account} a */
const isEmojiIcon = (a) => !!a.icon && !isCodiconId(a.icon);

/** @param {Account} a */
const iconText = (a) => (isEmojiIcon(a) ? /** @type {string} */ (a.icon) : `$(${a.icon || 'account'})`);

// Short name: "default" for the Default account unless it was renamed.
/** @param {Account} a */
const shortName = (a) => (a.id === DEFAULT_ID && !accounts.getMeta()[DEFAULT_ID]?.name ? t('default') : a.name);

/** @param {number} ms */
function relative(ms, now = Date.now()) {
  const mins = Math.max(0, Math.round((ms - now) / 60e3));
  if (mins < 60) return t('in {0} min', mins);
  const h = Math.floor(mins / 60);
  if (h < 48) return t('in {0} h {1} min', h, mins % 60);
  return t('in {0} days', Math.round(h / 24));
}

// The UI language as a locale Intl accepts (pseudo-locales and unknown tags fall back to the default).
function locale() {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf(vscode.env.language)[0];
  } catch {
    return undefined;
  }
}

/** @param {number} ms @param {Intl.DateTimeFormatOptions} opts */
const formatDate = (ms, opts) => new Date(ms).toLocaleString(locale(), opts);

// "14:30", or "Thu 14:30" (in the UI language's own format) when it is not within the next 20 hours.
/** @param {number} ms */
const clock = (ms) =>
  formatDate(
    ms,
    ms - Date.now() > 20 * 3600e3 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }
  );

// "5h 42% · 7d 10%" from live quota, or ''.
/** @param {string} id */
function quotaLine(id) {
  const q = quota.quotaOf(id);
  if (!q) return '';
  const parts = [];
  if (q.fiveHour) parts.push(t('5h {0}%', Math.round(q.fiveHour.usedPct)));
  if (q.sevenDay) parts.push(t('7d {0}%', Math.round(q.sevenDay.usedPct)));
  return parts.join(' · ');
}

// "limit reached, resets 14:30" or ''.
/** @param {string} id */
function limitLine(id) {
  const l = accounts.activeLimit(id);
  if (!l) return '';
  return l.estimated ? t('usage limit reached') : t('usage limit reached, resets {0}', clock(l.until));
}

// Escapes user-provided text for a MarkdownString.
/** @param {string} s */
const md = (s) => String(s).replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, '\\$&');

/** @returns {boolean} */
const showQuota = () => cfg('showQuota') !== false;

module.exports = { formatDate, themeColor, isEmojiIcon, iconText, shortName, relative, clock, quotaLine, limitLine, md, showQuota };
