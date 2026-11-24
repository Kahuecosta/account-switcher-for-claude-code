'use strict';
// Warns when a conversation of this window has grown so much that every response re-reads a great deal of
// it, which uses up the plan faster than the work itself.
const vscode = require('vscode');
const { rt, t, cfg } = require('./runtime');
const { contextOf, formatTokens } = require('../lib/usage');

const KEY = 'heavyConversations'; // workspaceState: { [session]: tokens at the last warning, or null: never again }
const RECENT_MS = 15 * 60e3; // older entries are history, not news
const GROWN = 1.5; // warn again once it has grown this much

const threshold = () => Math.max(0, Number(cfg('heavyConversationTokens')) || 0);
/** @param {number | null | undefined} tokens */
const isHeavy = (tokens) => threshold() > 0 && typeof tokens === 'number' && tokens >= threshold();

/** @returns {Record<string, number | null>} */
const warned = () => rt.ctx.workspaceState.get(KEY, {});
/** @param {string} session @param {number | null | undefined} value undefined forgets it */
async function remember(session, value) {
  const all = { ...warned() };
  delete all[session];
  if (value !== undefined) all[session] = value;
  await rt.ctx.workspaceState.update(KEY, Object.fromEntries(Object.entries(all).slice(-50)));
}

// New transcript entries of one conversation of this window, oldest first.
/** @param {any[]} entries */
async function note(entries, now = Date.now()) {
  if (!threshold()) return;
  const last = entries
    .map(contextOf)
    .filter((c) => c !== null)
    .at(-1);
  if (!last || now - last.ts > RECENT_MS) return;
  const before = warned()[last.session];
  if (before === null) return;
  if (last.tokens < threshold()) {
    // Compacted: it may be warned about again if it grows back.
    if (before !== undefined && last.tokens < threshold() / 2) await remember(last.session, undefined);
    return;
  }
  if (before !== undefined && last.tokens < before * GROWN) return;
  await remember(last.session, last.tokens);
  rt.log.info(`Heavy conversation ${last.session}: ${last.tokens} tokens per response`);
  const copy = t('Copy /compact');
  const never = t('Not for this conversation');
  const pick = await vscode.window.showInformationMessage(
    t(
      'This conversation re-reads {0} tokens with every response, which uses up your plan faster. /compact, or a new chat, makes it last longer.',
      formatTokens(last.tokens)
    ),
    copy,
    never
  );
  if (pick === copy) await vscode.env.clipboard.writeText('/compact');
  if (pick === never) await remember(last.session, null);
}

module.exports = { note, isHeavy };
