# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please) and the [Release workflow](../.github/workflows/release.yml):

1. Merge pull requests into `main` with Conventional Commit titles (`feat:`, `fix:`…).
2. release-please opens (and keeps updating) a **release pull request** that bumps `package.json`, updates `CHANGELOG.md` and lists the changes.
3. Merging the release pull request creates the tag and the GitHub release, and the same workflow:
   - checks that the tag matches `package.json` and that `CHANGELOG.md` has the version;
   - runs the checks and tests, builds the `.vsix` and its `SHA256SUMS.txt`, and creates a build provenance attestation;
   - publishes to the VS Code Marketplace and to Open VSX with **trusted publishing** (OIDC; no stored token), from the `release` environment;
   - attaches the `.vsix` and checksums to the GitHub release, even if a marketplace failed (rerun the failed job).

Pull requests created by release-please do not trigger other workflows (GitHub does not run workflows for changes made with the workflow token), so the release pull request has no CI checks of its own; everything it contains was already checked on `main`.

## Pre-releases and republishing

Run **Actions → Release → Run workflow** with an existing tag, and check **pre-release** if needed. The Marketplace requires `major.minor.patch` versions, so a pre-release needs its own version number (for example an odd minor version, `1.3.x`, for pre-releases and an even one, `1.4.x`, for stable releases).

## One-time setup

### GitHub

- **Settings → Actions → General → Workflow permissions**: check **Allow GitHub Actions to create and approve pull requests** (release-please needs it).
- **Settings → Environments → New environment** named `release`. Optionally add yourself as a required reviewer, so nothing is published without your approval, and limit it to the `main` branch and `v*` tags.

### VS Code Marketplace (trusted publishing)

1. Sign in at <https://marketplace.visualstudio.com/manage> with the account that owns the `kahuecosta` publisher.
2. Open the publisher, select **Trusted Publishing**, expand **Create** and fill in:
   - Policy name: `Release workflow`
   - Repository owner: `Kahuecosta`
   - Repository: `account-switcher-for-claude-code`
   - Workflow: `release.yml`
   - Environment: `release`
3. Select **Create**.

The workflow runs `vsce publish --oidc`: GitHub issues a short-lived OIDC token, the Marketplace exchanges it for a 15-minute credential, and nothing is stored. See [Publish Visual Studio Marketplace extensions securely with Trusted Publishing](https://developer.microsoft.com/blog/trusted-publishing-visual-studio-marketplace/).

### Open VSX (trusted publishing)

1. Sign in at <https://open-vsx.org> with GitHub.
2. In your profile, sign the **Eclipse Foundation Open VSX Publisher Agreement** (it asks you to log in with, or create, an Eclipse account).
3. Create the namespace once. Under **Settings → Access Tokens**, generate a token, then run:

   ```bash
   npx ovsx create-namespace kahuecosta -p <token>
   ```

   Delete the token afterwards if you use trusted publishing.

4. Open <https://open-vsx.org/user-settings/trusted-publishers>, add a trusted publisher for the namespace `kahuecosta` with the provider **GitHub Actions**, and identify the workflow: repository `Kahuecosta/account-switcher-for-claude-code`, workflow file `release.yml`, environment `release` (the exact field names may differ slightly; the dialog lists them).

The workflow runs `ovsx publish --trusted-publishing`. See the [Open VSX trusted publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing).

Optionally, ask for the namespace to be verified (the "verified publisher" badge) by opening a [namespace access request](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose).

### Fallback: tokens

If trusted publishing is not available for an account, set the repository variable `PUBLISH_AUTH` to `token` (**Settings → Secrets and variables → Actions → Variables**) and add these secrets to the `release` environment:

- `VSCE_PAT`: a Marketplace Personal Access Token. Azure DevOps stops accepting global Personal Access Tokens on 2026-12-01, so prefer trusted publishing.
- `OVSX_PAT`: an Open VSX access token.

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
