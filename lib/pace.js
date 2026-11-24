'use strict';
// When a usage window will be used up if it goes on as it did lately.

/**
 * @typedef {{ runsOut: boolean, hitAt: number | null }} Pace runsOut: before the window resets; hitAt: when
 *   it would reach 100%, or null when nothing was used lately
 * @param {{ usedPct: number, resetsAt: number | null } | null | undefined} w
 * @param {{ at: number, lengthMs: number, minSpanMs: number, recentMs?: number, samples?: { at: number, pct: number }[] }} opts
 *   at: when the window was read; samples: earlier readings of this window, oldest first. The pace is that of
 *   the last recentMs when there are readings that old, otherwise the average since the window started; less
 *   than minSpanMs of either says nothing.
 * @returns {Pace | null}
 */
function forecast(w, { at, lengthMs, minSpanMs, recentMs = 0, samples = [] }) {
  if (!w || !w.resetsAt || w.usedPct <= 0 || w.usedPct >= 100) return null;
  const start = { at: w.resetsAt - lengthMs, pct: 0 };
  const recent = samples.find((s) => s.at >= at - recentMs && s.at <= at - minSpanMs);
  const base = recent || start;
  const span = at - base.at;
  if (span < minSpanMs) return null;
  const used = w.usedPct - base.pct;
  if (used <= 0) return { runsOut: false, hitAt: null };
  const hitAt = Math.round(at + ((100 - w.usedPct) * span) / used);
  return { runsOut: hitAt < w.resetsAt, hitAt };
}

module.exports = { forecast };
