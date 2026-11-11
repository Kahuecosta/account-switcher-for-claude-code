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

[`scripts/setup-github.sh`](../scripts/setup-github.sh) applies every repository setting below, plus topics, Discussions, merge options, security features and a ruleset for `main` (run it as a repository admin after `gh auth login`). By hand:

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

### Open VSX

Open VSX accepts a trusted publisher only from the **owner** of the namespace, and only for an extension that already has a published version. So the first version goes out with a token, and trusted publishing takes over afterwards.

1. Sign in at <https://open-vsx.org> with GitHub and sign the **Eclipse Foundation Open VSX Publisher Agreement** in your profile (it asks you to log in with, or create, an Eclipse account).
2. Create the namespace once. Under **Settings → Access Tokens**, generate a token, then run:

   ```bash
   npx ovsx create-namespace kahuecosta -p <token>
   ```

3. Claim ownership of the namespace: open a **Claim namespace ownership** issue at <https://github.com/EclipseFdn/open-vsx.org/issues/new/choose>, naming the namespace `kahuecosta` and linking this repository and the Marketplace listing. Until an owner is granted, the namespace shows a warning icon and extensions in it are marked unverified.
4. Store the token as the `OVSX_PAT` secret of the `release` environment, so the first release can publish.
5. Once you own the namespace and the extension is on Open VSX, open <https://open-vsx.org/user-settings/trusted-publishers>, choose the namespace `kahuecosta` and the provider **GitHub Actions**, and fill in: organization or user `Kahuecosta`, repository `account-switcher-for-claude-code`, workflow `release.yml`, environment `release`.
6. Delete the `OVSX_PAT` secret (and revoke the token). The workflow then runs `ovsx publish --trusted-publishing`.

See the [Open VSX trusted publishing guide](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing) and [namespace access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

### Tokens

Each registry publishes with a token whenever its secret exists in the `release` environment, and with trusted publishing otherwise:

- `VSCE_PAT`: a Marketplace Personal Access Token. Azure DevOps stops accepting global Personal Access Tokens on 2026-12-01, so prefer trusted publishing.
- `OVSX_PAT`: an Open VSX access token (needed for the first version, see above).

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
