# Account Switcher for Claude Code

Switch between multiple Claude Code accounts in VS Code **per window or per repository**, without modifying your `~/.claude` folder.

> **Not affiliated with Anthropic.** This is a community extension. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

[Português (Brasil)](README.pt-BR.md)

## Features

- **Per-window accounts**: each VS Code window can use a different account at the same time.
- **Default account per repository**: open a repo and its account is applied automatically. Clones of the same repo share the default, because it is keyed by the git remote.
- **Shared or isolated profiles**: a shared account reuses your `settings.json`, `CLAUDE.md`, agents, commands, skills and plugins from `~/.claude` and keeps only its own login. An isolated account keeps everything separate.
- **Optional shared history**: every account sees the same conversations. Turning it on merges the history each account already has instead of discarding it.
- **Terminal integration**: the `claude` CLI in integrated terminals uses the same account as the panel.
- **Know which account you are on**: each account shows its e-mail, plan (e.g. Pro, Max 20x) and organization when Claude Code provides them. It also gets its own color and icon or emoji in the status bar, and an optional image in the account picker.
- **Rules**: make every repo under `~/work/**`, or every repo from `github.com/my-company/*`, use a given account automatically.
- **Usage limit assistant**: when the current account hits its usage limit, the extension offers to switch to another one with a single click.
- **Usage by account**: tokens used today and in the last 7 days, read from Claude Code's local logs.
- **Per-account environment variables**, such as a default model or a proxy, kept on the local machine only.
- **Quick toggle** between the last two accounts with `Ctrl+Alt+Shift+A` (`Cmd+Alt+Shift+A` on macOS).
- **Settings Sync**: account names, colors, icons and repository defaults follow you to other machines. Folders, logins and environment variables stay local.
- **Safe by design**: your original `~/.claude` is the "Default" account and is never deleted or overwritten. Nothing is written to your repository or your VS Code settings.

## Requirements

- VS Code 1.85 or later, or a compatible editor such as Cursor, VSCodium or Windsurf.
- The official Claude Code extension, in a version that honors `CLAUDE_CONFIG_DIR`.

## Getting started

1. Click **Claude: default** in the status bar and choose **Add account…**.
2. Give it a name and pick **Shared** or **Isolated** profile.
3. Choose **Log in**. A terminal opens with the account's environment and runs `claude auth login`.
4. Switch accounts from the status bar at any time. The window reloads so Claude Code picks up the change.
5. Optional: choose **Set default account for this repository…** or **Add default-account rule…**.

Hover over an account in the picker to find buttons that rename it, change its appearance, log in or remove it.

Run `/status` in the Claude Code panel to confirm which account is active.

## How it works

Claude Code reads its configuration directory from the `CLAUDE_CONFIG_DIR` environment variable. Each account is a folder under `~/.claude-accounts/` by default. When a window activates, the extension sets `CLAUDE_CONFIG_DIR` in that window's extension host before Claude Code starts its CLI. It also sets the variable for integrated terminals through VS Code's environment-variable API.

Shared items are symbolic links. On Windows, folders use junctions, which need no admin rights, and files use a symlink or, as a fallback, a hard link. The selected account is stored in the extension's own storage.

The extension uses the `*` activation event on purpose: it must set the environment before the Claude Code extension starts. Activation is cheap and does no network access.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeAccounts.scope` | `workspace` | `workspace`: each window/repo remembers its account. `user`: one account for every window. |
| `claudeAccounts.accountsRoot` | `~/.claude-accounts` | Where account folders are created. |
| `claudeAccounts.sharedItems` | settings.json, CLAUDE.md, agents, commands, skills, hooks, output-styles, plugins | Items shared by shared-profile accounts. |
| `claudeAccounts.shareHistory` | `false` | Use the **Share history across accounts** command to change it, so existing history is merged. |
| `claudeAccounts.historyItems` | projects, history.jsonl, file-history, todos, plans | What counts as history. |
| `claudeAccounts.autoApplyRepoDefault` | `true` | Apply the repository's default account on open. |
| `claudeAccounts.reloadBehavior` | `ask` | `ask`, `always` or `never` reload after switching. |
| `claudeAccounts.applyToTerminal` | `true` | Set `CLAUDE_CONFIG_DIR` in integrated terminals. |
| `claudeAccounts.loginCommand` | `claude auth login` | Command used to log in. |
| `claudeAccounts.statusBarStyle` | `name` | `name`, `initials` or `icon` (most compact). |
| `claudeAccounts.showPlan` | `true` | Show the plan in the status bar and picker. |
| `claudeAccounts.rules` | `[]` | Default-account rules (see below). |
| `claudeAccounts.suggestSwitchOnLimit` | `true` | Offer to switch accounts when the usage limit is hit. |
| `claudeAccounts.gravatar` | `false` | Show Gravatar images in the picker (makes network requests). |

### Rules

Rules are checked in order whenever a repository has no default of its own:

```json
"claudeAccounts.rules": [
  { "pattern": "github.com/my-company/*", "account": "work" },
  { "pattern": "~/personal/**", "account": "Personal" }
]
```

A pattern that starts with `~`, `/` or a drive letter is matched against the folder path. Anything else is matched against the git remote. `*` matches one segment and `**` matches any depth. A pattern without wildcards also matches everything below it. `account` accepts the account id (its folder name) or its name.

## Known limitations

- **Do not put `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables`.** That setting is user-level only and overrides switching in every window. The extension detects this and offers to remove just that entry.
- **The Claude Code panel can restore before this extension activates.** If `/status` shows the wrong account right after startup, reload the window once.
- **Rewritten files break links.** If a tool replaces a shared file instead of editing it, that account gets its own copy. The extension detects this on startup and offers **Relink**, keeping the local version as `.bak-<date>`.
- **macOS** stores credentials in the Keychain. Run `claude auth status` in each account to confirm the logins are separate.
- Your own hooks or scripts that hard-code `~/.claude` keep pointing at the default account. Use `$CLAUDE_CONFIG_DIR` in them instead.

## Account identity and usage

The e-mail, plan and organization come from files Claude Code writes in each account folder. From the credentials file, the extension reads **only** `subscriptionType` and `rateLimitTier`. Tokens are never read into memory beyond parsing, never stored, and never displayed.

These formats are not documented by Anthropic and may change, so every field is optional. On macOS the login lives in the Keychain, so the plan may not be available there.

Usage figures and limit detection come from the session logs in `projects/`. They only cover this machine. While history is shared, usage cannot be split by account.

## Privacy

The extension collects no telemetry. It only runs `git` locally to identify the current repository. The only network request it can make is to gravatar.com, and only if you turn on `claudeAccounts.gravatar`. In that case it sends a SHA-256 hash of the account's e-mail.

## License

[MIT](LICENSE)
