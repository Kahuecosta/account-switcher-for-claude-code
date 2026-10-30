<!-- The title becomes the commit message and the changelog entry: use Conventional Commits,
     e.g. "feat: show quota in the account picker" or "fix: keep the login terminal on its account". -->

## What and why

## How it was tested

- [ ] `npm run check` passes (lint, formatting, types, translations)
- [ ] `npm test` passes, with new tests for new behavior
- [ ] Integration tests pass if the change touches activation, terminals or the environment (`npm run test:integration`)
- [ ] User-visible strings use `t('...')` and every bundle in `l10n/` has a translation
- [ ] `npm run docs` was run if settings changed
