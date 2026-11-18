'use strict';
// Asks for a rating at most twice, never during the first week or before the extension was used a few
// times, and never again after "Rate" or "Don't ask again". Nothing is sent anywhere: the button only
// opens the extension's page.
const vscode = require('vscode');
const { K, t, EXTENSION_NAME } = require('./runtime');
const state = require('./state');

const MIN_SWITCHES = 5;
const MIN_AGE_MS = 7 * 864e5;
const RETRY_MS = 30 * 864e5;
const MAX_ASKS = 2;

const MARKETPLACE = 'https://marketplace.visualstudio.com/items?itemName=kahuecosta.claude-code-multi-account&ssr=false#review-details';
const OPEN_VSX = 'https://open-vsx.org/extension/kahuecosta/claude-code-multi-account/reviews';

/** @returns {{ first: number, switches: number, asked: number, lastAsked: number, done: boolean }} */
function get() {
  const r = state.get(K.RATING, null);
  return { first: Date.now(), switches: 0, asked: 0, lastAsked: 0, done: false, ...(r && typeof r === 'object' ? r : {}) };
}

// Called once per activation: records when the extension was first seen.
async function init() {
  if (!state.get(K.RATING, null)) await state.update(K.RATING, get());
}

async function noteSwitch() {
  const r = get();
  if (!r.done) await state.update(K.RATING, { ...r, switches: r.switches + 1 });
}

/** @param {ReturnType<typeof get>} r */
function due(r, now = Date.now()) {
  return (
    !r.done &&
    r.asked < MAX_ASKS &&
    r.switches >= MIN_SWITCHES &&
    now - r.first >= MIN_AGE_MS &&
    (r.asked === 0 || now - r.lastAsked >= RETRY_MS)
  );
}

// VS Code installs from the Marketplace; Cursor, VSCodium, Windsurf and others from Open VSX.
const reviewUrl = () => (/^vscode(-insiders)?$/.test(vscode.env.uriScheme) ? MARKETPLACE : OPEN_VSX);

async function maybeAsk() {
  const r = get();
  if (!due(r) || !vscode.window.state.focused) return;
  await state.update(K.RATING, { ...r, asked: r.asked + 1, lastAsked: Date.now() });
  const rate = t('Rate it');
  const never = t("Don't ask again");
  const pick = await vscode.window.showInformationMessage(
    t('Is {0} useful to you? A rating helps other people find it.', EXTENSION_NAME),
    rate,
    t('Later'),
    never
  );
  if (pick === rate || pick === never) await state.update(K.RATING, { ...get(), done: true });
  if (pick === rate) await vscode.env.openExternal(vscode.Uri.parse(reviewUrl()));
}

module.exports = { init, noteSwitch, maybeAsk, due, reviewUrl, MIN_SWITCHES };
