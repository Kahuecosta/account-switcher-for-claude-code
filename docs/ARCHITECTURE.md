# Architecture

The extension sets `CLAUDE_CONFIG_DIR` (and per-account variables) for the window it runs in. Everything else (profiles, history, rules, limits, quota) helps decide **which** folder that is, or keeps the folders in a good state.

## Activation

`activationEvents` is `*` on purpose: the environment must be in place before the Claude Code extension (`onStartupFinished`, or earlier when its panel is restored) starts its CLI. `activate()` therefore does only synchronous work before applying the environment:

1. `repo.detectRepos()` reads `.git` of each workspace folder (no `git` process).
2. `switching.startupAccount()` resolves the repository default or rule, or the remembered selection, from storage that is available synchronously (account identities are persisted for this reason).
3. `environment.applyEnv()` sets `process.env` of the extension host and the terminal environment collection.

Everything that waits (secrets, migrations, MCP mirroring, identities, watchers, prompts) runs afterwards in `afterActivation()`, which activation does not wait for. If the Claude Code extension was already active, the window is marked as needing a reload.

## Modules

| Module                                                                                                                       | Responsibility                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/extension.js`                                                                                                           | Wiring: commands, views, listeners, URI handler, public API                                                     |
| `src/runtime.js`                                                                                                             | Shared context, log, settings, storage keys, paths                                                              |
| `src/accounts.js`                                                                                                            | Account records, synced metadata, environment variables (secrets in SecretStorage), identity cache, limit state |
| `src/environment.js`                                                                                                         | Applying an account to the extension host and terminals; terminals bound to another account (`strictEnv`)       |
| `src/switching.js`                                                                                                           | Selecting an account, reload prompts, repository defaults on startup                                            |
| `src/repo.js`                                                                                                                | Repositories of the window, repository defaults (matched by e-mail across machines), rules                      |
| `src/profile.js`                                                                                                             | Shared items, shared history, deleting folders; every change through `runOperation()`                           |
| `src/identity.js`                                                                                                            | E-mail, plan and organization from Claude Code's files; avatars                                                 |
| `src/limits.js`                                                                                                              | Usage-limit detection in session logs, ranking accounts, switching, reset notifications                         |
| `src/quota.js`                                                                                                               | Live quota: status line bridge installation and snapshots                                                       |
| `src/usage.js`                                                                                                               | Token usage per account (incremental)                                                                           |
| `src/health.js`                                                                                                              | Setup issues, shown as one warning                                                                              |
| `src/diagnostics.js`                                                                                                         | The diagnostics report                                                                                          |
| `src/transfer.js`                                                                                                            | Export and import of account settings                                                                           |
| `src/migrations.js`                                                                                                          | Storage migrations (`schemaVersion`)                                                                            |
| `src/ui/*`                                                                                                                   | Status bar, pickers, Explorer view, formatting                                                                  |
| `lib/links.js`                                                                                                               | Linking, merging and unlinking with a journal and rollback                                                      |
| `lib/statusline.js`                                                                                                          | Status line bridge scripts and snapshot parsing                                                                 |
| `lib/git.js`, `lib/rules.js`, `lib/usage.js`, `lib/identity.js`, `lib/mcp.js`, `lib/lock.js`, `lib/names.js`, `lib/paths.js` | Pure helpers                                                                                                    |

## File-system safety

`profile.runOperation()` wraps every change to `~/.claude` or account folders:

- a lock file in the accounts root, so two windows never change folders at once;
- a progress notification that can be cancelled;
- a `Journal` (`lib/links.js`) that records each step; on failure or cancellation every step is undone in reverse order;
- files that would be deleted or rewritten are moved or copied to `~/.claude-accounts/.backups/<date>-<operation>/` with a `manifest.json` (the last 10 are kept).

Deleting an account folder removes its top-level links first and then moves it to the trash; without a trash, the user must confirm a permanent deletion.

## Storage

VS Code keeps `globalState` as one JSON object per extension; every write is echoed back to the extension host, which replaces the whole object, and the next write sends the whole object again. A late echo of an older write can therefore undo a newer write for good. The extension's state therefore lives in **one file per key** under `<globalStorage>/state/`, written atomically and read fresh (other windows write the same files) — see `src/state.js`.

| Key                                                                   | Content                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `accounts`                                                            | `[{ id, dir, mode, kind }]`                                                                              |
| `accountMeta`                                                         | synced: `{ [id]: { name, color, icon, _t } }`                                                            |
| `repoDefaults`                                                        | synced: `{ [repoKey]: { id, email, _t } }`                                                               |
| `accountEnvironment`                                                  | `{ [id]: { NAME: { value } \| { secret: true } } }`; secret values in SecretStorage as `env:<id>:<NAME>` |
| `accountIdentity`                                                     | last known `{ email, plan, organization, loggedIn }`                                                     |
| `accountLimits`                                                       | `{ [id]: { at, until, kind } }`, shared by all windows                                                   |
| `accountAvatars`, `mcpMirrored`, `dismissedNotices`, `importPrompted` | small local flags and maps                                                                               |
| `selectedAccount`, `previousAccount`                                  | with `claudeAccounts.scope: user`; otherwise in workspaceState (not shared, so not echoed)               |
| `schemaVersion`                                                       | storage version, see `src/migrations.js`                                                                 |

**Synced keys** (`accountMeta`, `repoDefaults`) are mirrored into `globalState` for Settings Sync. Every entry carries a timestamp (`_t`) and removals are kept as tombstones, so `state.pullSynced()` (at activation and when the window gets focus) merges both sides entry by entry with the newest entry winning; a mirror write lost to an echo is repaired by the next pull. On the first run of this storage, `state.init()` copies the `globalState` of earlier versions into the files.

## Tests

- `test/unit/*.test.js`: `node --test`. Each file runs in its own process with the `vscode` stub of `test/unit/helpers.js`.
- `test/integration/*.test.js`: Mocha inside a real VS Code through `@vscode/test-cli` (`.vscode-test.mjs`), on the latest stable and on the minimum supported version.
