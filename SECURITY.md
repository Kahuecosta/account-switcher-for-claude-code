# Security policy

This extension manages folders that hold Claude Code logins, so security reports are taken seriously.

## Reporting a vulnerability

Please report vulnerabilities **privately** through [GitHub's private vulnerability reporting](https://github.com/Kahuecosta/account-switcher-for-claude-code/security/advisories/new). Do not open a public issue.

Include what an attacker can do, the steps to reproduce, and the extension, editor and OS versions. You will get an answer within 7 days. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Updates are published to the VS Code Marketplace and Open VSX.

## Scope

In scope, for example:

- Reading, storing, logging or sending credentials or tokens.
- A repository, workspace setting, link (`vscode://` URI) or file content that makes the extension change account folders, share data between accounts, run commands, or switch accounts without the user's consent.
- Deleting or overwriting user data, in `~/.claude` or in account folders.
- Problems in the release process (supply chain).

Out of scope: vulnerabilities in Claude Code itself (report them to [Anthropic](https://www.anthropic.com/responsible-disclosure-policy)) or in VS Code.

## Design notes

- The extension makes no network requests, except to gravatar.com when `claudeAccounts.gravatar` is on.
- It reads only `subscriptionType` and `rateLimitTier` from credential files, and keeps API keys and tokens in VS Code's secret storage.
- Settings that change account folders can only be set in user settings, not by a workspace.
- It never runs `git` or other tools in the workspace; repository information is read from `.git` files.
- Releases are built in GitHub Actions from a tag, with a build provenance attestation and SHA-256 checksums.
