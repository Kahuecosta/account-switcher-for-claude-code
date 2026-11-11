# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). New entries are written by [release-please](https://github.com/googleapis/release-please) from Conventional Commits.

## [1.2.0](https://github.com/Kahuecosta/account-switcher-for-claude-code/compare/v1.1.0...v1.2.0) (2026-11-11)


### Features

* Claude Accounts view in the Explorer, getting-started walkthrough and setup issues in one place ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* commands accept an account argument, vscode:// links and a public API for other extensions ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* Diagnose command with a report of every account, including claude auth status ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* export and import account settings ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* live quota: 5-hour and weekly usage of every account, read from Claude Code's status line ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* log output channel ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* open a terminal as any account without switching the window ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* optional "all except" mode for shared items, and rules, keybindings.json, themes and workflows shared by default ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* rules can name an account by e-mail ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* safer switching, live quota, usage-limit rotation and new account types ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* say when a usage limit resets, and continue the conversation in a terminal as the other account ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* Spanish, French, German, Japanese and Simplified Chinese translations ([95bcc09](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/95bcc09634aab99f7f2b5e291cf02f0572f48048))
* subscription token, API key, Amazon Bedrock and Google Vertex AI accounts, with secrets in VS Code secret storage ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* switch to the account with the most quota left when the current one hits its limit, or before it ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* user-scope MCP servers are shared with shared-profile accounts ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))


### Bug fixes

* a new account never silently reuses a leftover folder that holds another login ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* address CodeQL findings and pass PowerShell status lines their input untouched ([371cf11](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/371cf11b82dac16fbc7077b436d40ec593ded5a4))
* credentials and session state are never linked between accounts, even when listed in sharedItems ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* emoji with joiners, flags and keycaps are accepted as account icons ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* give PowerShell status lines the exact bytes Claude Code sent ([4ffe9cd](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/4ffe9cdc1e241b409519801c7a4091e732a9d749))
* history merges run in the background with progress, can be cancelled, are rolled back on failure and keep backups ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* keep extension state in files so VS Code's storage echoes cannot erase accounts ([382d8bd](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/382d8bd82c6a4981778353c4e20120c266cdd03b))
* live quota passes the status line input to PowerShell status lines on Windows ([5294c4a](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5294c4a44db753252ea9215f1ae55615af9fe3f0))
* log in to the right account: the login terminal of another account no longer inherits the window's account ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* prompt history is kept in chronological order when histories are merged ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* removing an account moves its folder to the trash and removes the rules that point to it ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* repositories are detected without running git, synchronously, in multi-root windows and with any remote name ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* shared items and history use the CLAUDE_CONFIG_DIR VS Code was launched with as the base profile ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* synced repository defaults never apply to a different login on another machine ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* the status bar shows when the Claude Code panel still uses the previous account until the window reloads ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* usage in the tooltip is refreshed, and limit detection follows the current account and every folder of the window ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* workspace settings can no longer turn on history sharing, rules or other folder-changing settings ([5823cc1](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/5823cc15d32619e18b22d1dd295459fd707409fc))
* write account identities in one batch and only when they change ([b38dc9d](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/b38dc9d6c9411a6c924d7e0bedbc153d7c2fc52a))


### Documentation

* add a social preview image and a repository setup script ([612b3c4](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/612b3c462291cabd6d25fc217a832608228d9cc6))
* add screenshots and a demo GIF ([da6f128](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/da6f1285c95319966bf53223f185452dff9cc740))
* rewrite the READMEs and add contributing, security, support and architecture guides ([e83ad78](https://github.com/Kahuecosta/account-switcher-for-claude-code/commit/e83ad78064f3fb7e5669074fbe0bd23757cbfdb5))

## [1.1.0](https://github.com/Kahuecosta/account-switcher-for-claude-code/compare/3de1957...9edef53) (2026-10-17)

### Features

- Account identity: e-mail, plan and organization in the status bar, tooltip and picker. Only non-secret fields are read.
- Per-account color (theme-aware palette), icon or emoji, and status-bar style (`name`, `initials`, `icon`).
- Optional image per account in the picker, chosen from a file, or opt-in Gravatar.
- Inline buttons in the account picker: rename, appearance, log in, remove.
- Default-account rules by folder or git-remote pattern (`claudeAccounts.rules`), plus an **Add default-account rule** command.
- Usage-limit assistant: offers switching accounts when the current one hits its limit.
- **Show usage by account**: tokens today and over the last 7 days, from local logs.
- Per-account environment variables, kept locally.
- **Switch to previous account** command (`Ctrl+Alt+Shift+A` / `Cmd+Alt+Shift+A`).
- Settings Sync for account names, colors, icons and repository defaults.
- Data from 1.0 is migrated automatically.

## 1.0.0 (2026-10-17)

First public release.

- Per-window and per-repository account switching through `CLAUDE_CONFIG_DIR`, with no changes to `~/.claude`, the repository or VS Code settings.
- Shared and isolated profiles, convertible in either direction.
- Optional shared conversation history, merging the existing history of every account.
- Integrated-terminal support.
- Detection of an overriding `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`.
- Detection and repair of broken shared links.
- Import of account folders created by earlier installs.
- English and Brazilian Portuguese UI.
