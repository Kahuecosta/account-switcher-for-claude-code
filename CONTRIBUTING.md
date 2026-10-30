# Contributing

Thanks for helping! Bug reports, ideas, translations and pull requests are all welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs**: run **Claude Accounts: Diagnose** and attach its report to a [bug report](https://github.com/Kahuecosta/account-switcher-for-claude-code/issues/new/choose).
- **Larger changes**: open an issue first, so we can agree on the approach before you write the code.
- **Security issues**: never in public. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 22 (see `.nvmrc`) and VS Code.

```bash
git clone https://github.com/Kahuecosta/account-switcher-for-claude-code.git
cd account-switcher-for-claude-code
npm ci
```

Press **F5** in VS Code with the **Run Extension** configuration, or run `code --extensionDevelopmentPath=.`. The extension has no build step: `src/` and `lib/` are loaded as they are.

To try it without touching your real accounts, start VS Code with a throwaway home folder, for example `HOME=$(mktemp -d) code --extensionDevelopmentPath=.` on Linux or macOS.

## Scripts

| Command                    | What it does                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`            | ESLint, Prettier check, type check (`tsc` over JSDoc) and translation check                                                                                                                     |
| `npm test`                 | Unit tests (`node --test`), with a stub of the `vscode` module                                                                                                                                  |
| `npm run coverage`         | Unit tests with coverage thresholds                                                                                                                                                             |
| `npm run test:integration` | Tests inside a real VS Code (`VSCODE_TEST_VERSION=1.85.0` for the minimum version; use `xvfb-run -a` on Linux without a display)                                                                |
| `npm run format`           | Formats every file with Prettier                                                                                                                                                                |
| `npm run docs`             | Regenerates the settings tables in the READMEs from `package.json`                                                                                                                              |
| `npm run package`          | Builds the `.vsix`                                                                                                                                                                              |
| `npm run screenshots`      | Regenerates the README screenshots and demo GIF from a real VS Code with demo data (Linux: `xvfb-run -a -s "-screen 0 1440x900x24" npm run screenshots`; needs ImageMagick, xdotool and ffmpeg) |

CI runs all of them on Linux, macOS and Windows.

## Code

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code is organized. In short:

- `lib/` holds logic with no VS Code dependency (links, history merge, rules, git, usage, status line bridge). Test it directly.
- `src/` holds the VS Code side. Its tests use the stub in `test/unit/helpers.js`; behavior that depends on VS Code itself (terminals, activation order) belongs in `test/integration/`.
- Plain JavaScript with JSDoc types, checked by `tsc` (`npm run typecheck`). Keep `engines.vscode` and `@types/vscode` in step: do not use APIs newer than the minimum version.
- Anything that changes files in `~/.claude` or account folders must go through `profile.runOperation()`, which takes the cross-window lock, journals every change and rolls back on failure. Never delete user data: move it to the journal's backup folder instead.
- Never read, store or log tokens. Read only the non-secret fields documented in the README.

## Translations

Every user-visible string goes through `t('...')` with a string literal (the check rejects anything else). Manifest strings live in `package.nls.json`.

- To add a string: use `t('Your message with {0}', value)` and add it to every `l10n/bundle.l10n.<lang>.json`.
- To add a language: copy `l10n/bundle.l10n.pt-br.json` and `package.nls.pt-br.json` to the new locale and translate the values. Keep `{0}` placeholders and command names unchanged.
- `npm run l10n` lists missing, stale or mismatched entries.

## Commits and pull requests

Pull requests are squash-merged, and their title becomes the commit message that [release-please](https://github.com/googleapis/release-please) turns into the changelog. Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` for a new feature (minor release)
- `fix: ...` for a bug fix (patch release)
- `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:` for everything else
- `feat!: ...` or a `BREAKING CHANGE:` footer for breaking changes

Write the title for users: it appears in the changelog as is.
