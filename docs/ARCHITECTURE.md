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

| Key                                  | Store                                    | Content                                                                                                  |
| ------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `accounts`                           | global                                   | `[{ id, dir, mode, kind }]`                                                                              |
| `accountMeta`                        | global, synced                           | `{ [id]: { name, color, icon } }`                                                                        |
| `repoDefaults`                       | global, synced                           | `{ [repoKey]: { id, email } }`                                                                           |
| `accountEnvironment`                 | global                                   | `{ [id]: { NAME: { value } \| { secret: true } } }`; secret values in SecretStorage as `env:<id>:<NAME>` |
| `accountIdentity`                    | global                                   | last known `{ email, plan, organization, loggedIn }`                                                     |
| `accountLimits`                      | global                                   | `{ [id]: { at, until, kind } }`, shared by all windows                                                   |
| `selectedAccount`, `previousAccount` | workspace (or global with `scope: user`) | account ids                                                                                              |
| `lastAppliedRepoDefault`             | workspace                                | id of the repository default last applied in this workspace                                              |
| `schemaVersion`                      | global                                   | storage version, see `src/migrations.js`                                                                 |

## Tests

- `test/unit/*.test.js`: `node --test`. Each file runs in its own process with the `vscode` stub of `test/unit/helpers.js`.
- `test/integration/*.test.js`: Mocha inside a real VS Code through `@vscode/test-cli` (`.vscode-test.mjs`), on the latest stable and on the minimum supported version.
