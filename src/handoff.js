'use strict';
// Continuing a conversation with another account: the conversation is copied into that account's
// folder and reopened there, in the Claude Code panel or in a terminal. Works with or without shared
// history.
//
// Two claude processes must never write the same conversation, and a conversation that is open keeps its
// claude process (and so its account) until it is closed. So whenever the original may still be running
// (the window switches without a reload, or it runs in a terminal), the conversation continues from a copy
// with a new session id (a fork, like Claude Code's own --fork-session). When the window reloads, every
// open conversation restarts, so the copy keeps its id: the restored tab then continues it as the new
// account.
const vscode = require('vscode');
const { rt, K, t, OFFICIAL_EXTENSION_ID, OPEN_SESSION_COMMAND, errorMessage, fileFolders } = require('./runtime');
const accounts = require('./accounts');
const env = require('./environment');
const live = require('./live');
const { selectAccount, maybeReload } = require('./switching');
const { latestSession, findSession, sessionOfFile, copySession, forkSession, SESSION_ID } = require('../lib/conversations');

/** @typedef {import('./accounts').Account} Account */
/** @typedef {{ id: string, file: string, projectDir: string }} Session */

const RESUME_MAX_AGE_MS = 30 * 60e3;

/**
 * Copies `session` from `from` to `to`. With fork, always under a new session id. Otherwise under the
 * same id, unless the conversation also went on in `to`: then a fork too, so neither account's messages
 * are lost and the id never names two different conversations. A failure is reported here; the caller
 * still switches, and never continues another conversation in its place.
 * @param {Session} session @param {Account} from @param {Account} to @param {{ fork?: boolean }} [opts]
 * @returns {Promise<{ id: string | null, failed: boolean }>}
 */
async function carrySession(session, from, to, { fork = false } = {}) {
  const fromDir = accounts.configDirOf(from);
  const toDir = accounts.configDirOf(to);
  try {
    if (!fork) {
      const result = await copySession(session, fromDir, toDir);
      rt.log.info(`Conversation ${session.id} from ${from.id} to ${to.id}: ${result}`);
      if (result !== 'diverged') return { id: session.id, failed: false };
    }
    const id = await forkSession(session, fromDir, toDir);
    rt.log.info(`Conversation ${session.id} from ${from.id} continues as ${id} in ${to.id}`);
    return { id, failed: false };
  } catch (e) {
    rt.log.error(`Copying the conversation to ${to.id}: ${e instanceof Error && e.stack ? e.stack : e}`);
    vscode.window.showWarningMessage(t('The conversation could not be copied to "{0}": {1}', to.name, errorMessage(e)));
    return { id: null, failed: true };
  }
}

/**
 * The conversation to carry: the one in `file` (the transcript that reported a usage limit) when it is
 * a conversation, otherwise the latest conversation of this window's folders.
 * @param {Account} from @param {string} [file] @returns {Promise<Session | null>}
 */
async function sessionToCarry(from, file) {
  const own = file ? sessionOfFile(file) : null;
  if (own) return own;
  return latestSession(accounts.configDirOf(from), fileFolders());
}

/** @param {Account} a @param {string} id */
async function openConversation(a, id) {
  try {
    await vscode.commands.executeCommand(OPEN_SESSION_COMMAND, id);
    rt.log.info(`Conversation ${id} opened as ${a.id}`);
    return true;
  } catch (e) {
    rt.log.warn(`Opening conversation ${id}: ${e}`);
    const term = t('Continue in terminal');
    const pick = await vscode.window.showWarningMessage(t('The Claude Code panel could not open the conversation.'), term);
    if (pick === term) resumeInTerminal(a, id);
    return false;
  }
}

/**
 * Moves this window to `target` and continues a conversation there: the one in `file` when given (the
 * transcript that reported a usage limit), otherwise the latest of this window's folders. auto: started
 * on its own (onUsageLimit "switch"), so no terminal opens unless asked for.
 * @param {Account} target @param {string} [reason] @param {{ file?: string, auto?: boolean }} [opts]
 */
async function continueInPanel(target, reason, { file, auto = false } = {}) {
  const cur = accounts.selectedAccount();
  if (target.id === cur.id) {
    vscode.window.showInformationMessage(t('This window already uses "{0}".', target.name));
    return;
  }
  if (accounts.isSignedIn(target) === false) {
    const login = t('Log in');
    const pick = await vscode.window.showWarningMessage(t('Account "{0}" is not logged in.', target.name), login);
    if (pick === login) await vscode.commands.executeCommand('claudeAccounts.login', target.id);
    return;
  }
  const session = await sessionToCarry(cur, file);
  if (!session) {
    vscode.window.showInformationMessage(t('No conversation of this folder was found for "{0}". Switching without it.', cur.name));
    return selectAccount(target, reason);
  }
  const official = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);

  // Only the claude CLI: the original may still run in its terminal, so a fork continues in a new one.
  if (!official) {
    const { id } = await carrySession(session, cur, target, { fork: true });
    if (!id || !auto) {
      const how = await selectAccount(target, reason);
      if (id) resumeInTerminal(target, id);
      return how;
    }
    const how = await selectAccount(target, reason, { silent: true });
    const cont = t('Continue in terminal');
    vscode.window
      .showInformationMessage(t('Claude Code account: {0}.', target.name), cont)
      .then((pick) => pick === cont && resumeInTerminal(target, id));
    return how;
  }

  // Claude Code is running and follows the switch without a reload: the conversation's tab keeps its
  // process, so the conversation continues in a new tab, from a fork.
  if (official.isActive && (await live.available())) {
    const { id } = await carrySession(session, cur, target, { fork: true });
    if (!id) return selectAccount(target, reason);
    const how = await selectAccount(target, reason, { silent: true });
    if (how !== 'reload') {
      if (await openConversation(target, id))
        vscode.window.showInformationMessage(
          t('The conversation continues in a new tab as "{0}". The tab you were using stays with "{1}".', target.name, cur.name)
        );
      return how;
    }
    // Claude Code could not be told after all: the copy opens once the window has reloaded.
    await rt.ctx.workspaceState.update(K.RESUME, { id, account: target.id, at: Date.now() });
    await maybeReload(t('Claude Code account: {0}.', target.name));
    return how;
  }

  // The window reloads (or Claude Code has not started yet): the copy keeps its id, and the conversation
  // reopens once the window has. It is copied again then, so messages written before the reload go too.
  const { id } = await carrySession(session, cur, target);
  if (!id) return selectAccount(target, reason);
  await rt.ctx.workspaceState.update(K.RESUME, { id, account: target.id, from: cur.id, at: Date.now() });
  const how = await selectAccount(target, reason);
  if (!env.reloadPending(target.id)) await resumePending();
  return how;
}

// Reopens a conversation carried over before the window reloaded. Called once the window has started.
async function resumePending() {
  const r = rt.ctx.workspaceState.get(K.RESUME);
  if (!r || typeof r.id !== 'string' || !SESSION_ID.test(r.id)) return;
  if (Date.now() - r.at > RESUME_MAX_AGE_MS) {
    await rt.ctx.workspaceState.update(K.RESUME, undefined);
    return;
  }
  const a = accounts.selectedAccount();
  if (a.id === r.account && env.reloadPending(a.id)) return; // still waiting for the reload
  await rt.ctx.workspaceState.update(K.RESUME, undefined);
  if (a.id !== r.account) return; // the window moved on to another account since
  let id = r.id;
  // The original may have gone on after it was copied (the reload came later): copy it again.
  const from = r.from ? accounts.findAccount(r.from) : undefined;
  if (from && from.id !== a.id) {
    const source = await findSession(accounts.configDirOf(from), fileFolders(), r.id);
    if (source) id = (await carrySession(source, from, a)).id || r.id;
  }
  await openConversation(a, id);
}

/** @param {Account} a @param {string | null} id */
function resumeInTerminal(a, id) {
  return env.createAccountTerminal(a, {
    name: t('Claude: {0}', a.name),
    command: id ? `claude --resume ${id}` : 'claude --continue',
    cwd: fileFolders()[0],
    icon: 'comment-discussion',
  });
}

// Opens a terminal as `target` that continues the latest conversation of this window's folders.
/** @param {Account} target */
async function continueInTerminal(target) {
  const cur = accounts.selectedAccount();
  if (target.id === cur.id) return resumeInTerminal(target, null);
  const session = await latestSession(accounts.configDirOf(cur), fileFolders());
  if (!session) {
    // Nothing to carry over: a new conversation, rather than the other account's own latest one passed
    // off as this folder's.
    vscode.window.showInformationMessage(t('No conversation of this folder was found for "{0}". Starting a new one.', cur.name));
    return env.createAccountTerminal(target, {
      name: t('Claude: {0}', target.name),
      command: 'claude',
      cwd: fileFolders()[0],
      icon: 'comment-discussion',
    });
  }
  // Always a fork: the conversation may still be open in a Claude Code tab or another terminal.
  const { id } = await carrySession(session, cur, target, { fork: true });
  if (!id) return undefined; // `claude --continue` would pick up another conversation
  return resumeInTerminal(target, id);
}

module.exports = { continueInPanel, continueInTerminal, resumePending, carrySession, sessionToCarry };
