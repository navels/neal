#!/usr/bin/env bash
#
# scripts/bump-native-sdks.sh — open a PR that bumps the native agentic SDKs
# (@openai/codex-sdk, @anthropic-ai/claude-agent-sdk) to their current latest
# releases, ahead of Renovate.
#
# Renovate's native-SDK bucket waits out a 3-day soak (minimumReleaseAge in
# renovate.json) before it proposes a version, and nothing on the dependency
# dashboard can tick past that filter. When neal needs a fix today, the
# sanctioned route is a manual PR; this script is that PR. It resolves each
# package's `latest` dist-tag (so a prerelease is never picked), rewrites the
# two exact pins, refreshes the lockfile, pushes a branch, and opens the PR.
# Leave Renovate's own SDK PR alone: closing it just makes Renovate re-open
# it, and once this PR merges Renovate closes its PR itself as no longer
# needed.
#
# Usage: scripts/bump-native-sdks.sh
#
# The PR still needs qualification before merge:
#   scripts/qualify-sdk.sh <pr-number>
# and is released with scripts/release-sdk-bump.sh <pr-number>.
#
# Requirements: gh (authenticated), git, node, npm, pnpm on PATH. Runs in a
# throwaway git worktree — this checkout's branch, node_modules, and dist are
# not touched.

set -euo pipefail

for tool in gh git node npm pnpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "bump-native-sdks: missing required tool: $tool" >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDKS=("@anthropic-ai/claude-agent-sdk" "@openai/codex-sdk")

WORK="$(mktemp -d "${TMPDIR:-/tmp}/neal-bump-sdks-XXXXXX")"
BRANCH="bump-native-sdks-$(date -u +%Y%m%d-%H%M%S)"
cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" branch -D "$BRANCH" >/dev/null 2>&1 || true
}
trap cleanup EXIT

git -C "$REPO_ROOT" fetch origin main --quiet
git -C "$REPO_ROOT" worktree add --quiet -b "$BRANCH" "$WORK" origin/main
cd "$WORK"

# `npm view <pkg> version` is the `latest` dist-tag, which never points at a
# prerelease.
CHANGES=()
for pkg in "${SDKS[@]}"; do
  current="$(node -p "require('./package.json').dependencies['$pkg']")"
  latest="$(npm view "$pkg" version)"
  if [ "$current" = "$latest" ]; then
    echo "bump-native-sdks: $pkg already at $latest"
    continue
  fi
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.dependencies['$pkg'] = '$latest';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  CHANGES+=("- \`$pkg\` \`$current\` → \`$latest\`")
  echo "bump-native-sdks: $pkg $current -> $latest"
done

if [ "${#CHANGES[@]}" -eq 0 ]; then
  echo "bump-native-sdks: both SDKs are already at their latest release; nothing to do."
  exit 0
fi

pnpm install --lockfile-only --loglevel silent
git add package.json pnpm-lock.yaml
git commit --quiet -m "Update native agentic SDKs to the latest releases"
git push --quiet -u origin "$BRANCH"

CHANGE_LINES="$(printf '%s\n' "${CHANGES[@]}")"
BODY="## Summary

Manual bump of the native agentic SDKs to their current latest releases, ahead of the Renovate soak (see docs/maintenance.md).

## Changes

${CHANGE_LINES}
- \`pnpm-lock.yaml\` refreshed

Qualify before merge: \`scripts/qualify-sdk.sh <this PR>\`. Release with \`scripts/release-sdk-bump.sh <this PR>\`."
PR_URL="$(gh pr create --title "Update native agentic SDKs" --body "$BODY" --base main --head "$BRANCH")"
PR="${PR_URL##*/}"

echo "Opened ${PR_URL}"
echo "Qualify before merge: scripts/qualify-sdk.sh ${PR}"
