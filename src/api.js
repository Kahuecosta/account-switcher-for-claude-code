'use strict';
// Public API returned by activate(), for other extensions:
//   const api = vscode.extensions.getExtension('kahuecosta.claude-code-multi-account')?.exports;
const accounts = require('./accounts');
const { switched, selectAccount } = require('./switching');

/** @param {import('./accounts').Account} a */
function toPublic(a) {
  const id = accounts.getIdentity(a.id);
  return Object.freeze({
    id: a.id,
    name: a.name,
    isDefault: a.dir === null,
    mode: a.mode,
    kind: a.kind || 'subscription',
    configDir: accounts.configDirOf(a),
    email: id?.email ?? null,
    plan: id?.plan ?? null,
    organization: id?.organization ?? null,
  });
}

function createApi() {
  return Object.freeze({
    apiVersion: 1,
    /** The account selected in this window. */
    getCurrentAccount: () => toPublic(accounts.selectedAccount()),
    /** Every account, Default first. */
    getAccounts: () => accounts.allAccounts().map(toPublic),
    /**
     * Switches this window to an account (id, name or e-mail). Resolves to false when none matches.
     * @param {string} ref @param {{ reason?: string }} [opts]
     */
    switchAccount: async (ref, opts = {}) => {
      const a = accounts.findAccountByRef(ref);
      if (!a) return false;
      if (a.id !== accounts.selectedAccount().id) await selectAccount(a, opts.reason);
      return true;
    },
    /** Fires after this window switches accounts. */
    onDidChangeAccount: (
      /** @type {(a: ReturnType<typeof toPublic>) => any} */ listener,
      /** @type {any} */ thisArgs,
      /** @type {any} */ disposables
    ) => switched.event((a) => listener.call(thisArgs, toPublic(a)), undefined, disposables),
  });
}

module.exports = { createApi, toPublic };
