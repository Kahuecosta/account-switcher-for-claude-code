#!/usr/bin/env bash
# One-time repository settings (needs an admin of the repository, logged in with `gh auth login`).
# In a Codespace, the built-in token cannot change settings: run `unset GITHUB_TOKEN; gh auth login` first.
# Safe to run again: every step sets a value instead of adding a duplicate (except the ruleset, see below).
set -euo pipefail
R="${1:-Kahuecosta/account-switcher-for-claude-code}"

echo "== About, topics, Discussions and merge options"
gh repo edit "$R" \
  --description "Use multiple Claude Code accounts in VS Code: per window or per repository, with plan, usage limits and one-click switching" \
  --homepage "https://marketplace.visualstudio.com/items?itemName=kahuecosta.claude-code-multi-account" \
  --add-topic vscode-extension,claude-code,claude,anthropic,multi-account,account-switcher,vscode,ai-tools,developer-tools,rate-limit \
  --enable-discussions \
  --enable-merge-commit=false --enable-squash-merge --enable-rebase-merge --delete-branch-on-merge
gh api -X PATCH "repos/$R" -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=COMMIT_MESSAGES >/dev/null

echo "== GitHub Actions may open pull requests (release-please); the default token stays read-only"
gh api -X PUT "repos/$R/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

echo "== Security: private vulnerability reporting, Dependabot alerts and fixes, secret scanning"
gh api -X PUT "repos/$R/private-vulnerability-reporting"
gh api -X PUT "repos/$R/vulnerability-alerts"
gh api -X PUT "repos/$R/automated-security-fixes"
gh api -X PATCH "repos/$R" --input - >/dev/null <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

echo "== Environment \"release\": you approve each publication; only main and v* tags"
uid=$(gh api user -q .id)
gh api -X PUT "repos/$R/environments/release" --input - >/dev/null <<JSON
{"reviewers": [{"type": "User", "id": $uid}], "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
for p in "main:branch" "v*:tag"; do
  gh api -X POST "repos/$R/environments/release/deployment-branch-policies" -f name="${p%%:*}" -f type="${p##*:}" >/dev/null 2>&1 || true
done

echo "== Ruleset for main: pull requests, required checks, no force pushes or deletion"
if gh api "repos/$R/rulesets" -q '.[].name' | grep -qx main; then
  echo "   (a ruleset named \"main\" already exists; edit it in Settings -> Rules -> Rulesets)"
else
  # Repository admins may bypass it, so the release pull request (which has no CI runs) can be merged.
  gh api -X POST "repos/$R/rulesets" --input - >/dev/null <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}],
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"},
    {"type": "pull_request", "parameters": {"required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false, "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": true, "allowed_merge_methods": ["squash", "rebase"]}},
    {"type": "required_status_checks", "parameters": {"strict_required_status_checks_policy": false, "required_status_checks": [
      {"context": "Lint, types, translations, coverage"},
      {"context": "Unit tests (ubuntu-latest)"},
      {"context": "Unit tests (macos-latest)"},
      {"context": "Unit tests (windows-latest)"},
      {"context": "VS Code stable (ubuntu-latest)"},
      {"context": "VS Code stable (macos-latest)"},
      {"context": "VS Code stable (windows-latest)"},
      {"context": "VS Code 1.85.0 (ubuntu-latest)"},
      {"context": "Package"},
      {"context": "lint"}
    ]}}
  ]
}
JSON
fi

echo
echo "Done. Two settings have no API and must be set in the browser:"
echo "  1. Settings -> Code security -> Dependency graph: Enable (the dependency review check needs it)."
echo "  2. Settings -> General -> Social preview: upload images/social-preview.png."
