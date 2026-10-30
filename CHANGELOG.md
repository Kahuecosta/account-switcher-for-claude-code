# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). New entries are written by [release-please](https://github.com/googleapis/release-please) from Conventional Commits.

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
