# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Merge pull requests into `main` with Conventional Commit titles (`feat:`, `fix:`…).
2. release-please opens (and keeps updating) a **release pull request** that bumps `package.json`, updates `CHANGELOG.md` and lists the changes.
3. Merging the release pull request creates the tag and the GitHub release, then the **Publish** workflow:
   - checks that the tag matches `package.json` and that `CHANGELOG.md` has the version;
   - runs the checks and tests, builds the `.vsix` and its `SHA256SUMS.txt`, and creates a build provenance attestation;
   - publishes to the VS Code Marketplace and to Open VSX (in parallel, in the `release` environment);
   - attaches the `.vsix` and checksums to the GitHub release, even if a marketplace failed (rerun the failed job).

## Pre-releases

Run the **Publish** workflow by hand (**Actions → Publish → Run workflow**) with a tag and **pre-release** checked. The Marketplace requires `major.minor.patch` versions, so a pre-release needs its own version number (for example an odd minor version, `1.3.x`, for pre-releases and an even one, `1.4.x`, for stable releases).

## One-time setup

### Environment

Create a `release` environment (**Settings → Environments**) and, optionally, require a reviewer, so nothing is published without an approval.

### VS Code Marketplace

The publisher is `kahuecosta` (<https://marketplace.visualstudio.com/manage>). Choose one way to authenticate:

- **Recommended: Microsoft Entra ID with OIDC (no stored secret).**
  1. In the Azure portal, create an app registration and add a **federated credential** for GitHub Actions: organization `Kahuecosta`, repository `account-switcher-for-claude-code`, entity **Environment**, name `release`.
  2. Add the app as a member of the Marketplace publisher with the **Contributor** role (see the [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).
  3. Set the repository **variables** `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. The workflow then logs in with `azure/login` and publishes with `vsce publish --azure-credential`.
- **Alternative: a Personal Access Token** with the **Marketplace → Manage** scope, stored in the `VSCE_PAT` secret of the `release` environment.

### Open VSX

1. Sign in at <https://open-vsx.org> with GitHub, accept the Eclipse Foundation Publisher Agreement and create an access token.
2. Create the namespace once: `npx ovsx create-namespace kahuecosta -p <token>`.
3. Store the token in the `OVSX_PAT` secret of the `release` environment.

## Checking a build locally

```bash
npm ci
npm run check
npm test
xvfb-run -a npm run test:integration   # or without xvfb-run on macOS and Windows
npm run package
npx vsce ls --no-dependencies          # the files that go into the .vsix
```

Install the `.vsix` with **Extensions: Install from VSIX…** and try the flows in the README, in English and in another display language (**Configure Display Language**).
