#!/usr/bin/env bash
#
# scripts/release-sdk-bump.sh — one-command patch release for a qualified
# dependency-bump PR (the Renovate SDK/AI-SDK bumps).
#
# Automates the full docs/release.md flow for the common case: merge the dep
# PR, open and merge the release-preparation PR (version bump + changelog
# section + all local gates), run the Publish workflow (dry run, then real),
# and hand you the interactive npm 2FA approval. It stops and asks before the
# two irreversible transitions: merging anything, and the real publish.
#
# Scope guard: refuses any PR that is not a pure package.json + pnpm-lock.yaml
# dependency bump, and refuses native agentic-SDK bumps that do not carry a
# "SDK qualification: PASS" review from scripts/qualify-sdk.sh. Releases with
# hand-written changelog content stay manual.
#
# Usage: scripts/release-sdk-bump.sh <dep-pr-number>
#
# Requirements: gh (authenticated), node + pnpm on PATH, npm login able to
# reach the @navels scope (the script prompts for `npm login` when the local
# token is stale).

set -euo pipefail

PR="${1:?usage: scripts/release-sdk-bump.sh <dep-pr-number>}"

for tool in gh git node pnpm npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "release-sdk-bump: missing required tool: $tool" >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
PACKAGE_NAME="$(node -p "require('./package.json').name")"

if git status --porcelain | grep -q .; then
  echo "release-sdk-bump: working tree is not clean; commit or stash first." >&2
  exit 1
fi

# --- validate the dependency PR ---
PR_JSON="$(gh pr view "$PR" --json state,title,files,reviews,headRefOid,baseRefOid)"
PR_STATE="$(node -pe "JSON.parse(process.argv[1]).state" "$PR_JSON")"
PR_TITLE="$(node -pe "JSON.parse(process.argv[1]).title" "$PR_JSON")"
if [ "$PR_STATE" != "OPEN" ]; then
  echo "release-sdk-bump: PR #${PR} is ${PR_STATE}, expected OPEN." >&2
  exit 1
fi

EXTRA_FILES="$(node -pe "
  JSON.parse(process.argv[1]).files
    .map((f) => f.path)
    .filter((p) => p !== 'package.json' && p !== 'pnpm-lock.yaml')
    .join(', ')
" "$PR_JSON")"
if [ -n "$EXTRA_FILES" ]; then
  echo "release-sdk-bump: PR #${PR} touches more than package.json + pnpm-lock.yaml (${EXTRA_FILES})." >&2
  echo "This script only handles pure dependency bumps; release manually per docs/release.md." >&2
  exit 1
fi

# --- diff the dependency blocks between base and head ---
BASE_SHA="$(node -pe "JSON.parse(process.argv[1]).baseRefOid" "$PR_JSON")"
HEAD_SHA="$(node -pe "JSON.parse(process.argv[1]).headRefOid" "$PR_JSON")"
BASE_PKG="$(gh api "repos/{owner}/{repo}/contents/package.json?ref=${BASE_SHA}" -H "Accept: application/vnd.github.raw+json")"
HEAD_PKG="$(gh api "repos/{owner}/{repo}/contents/package.json?ref=${HEAD_SHA}" -H "Accept: application/vnd.github.raw+json")"

# Emits one "kind|package|old|new" line per changed entry, where kind is
# runtime or dev. Version changes to anything other than dependencies /
# devDependencies (or added/removed entries) make the PR out of scope.
DEP_CHANGES="$(node -e "
  const base = JSON.parse(process.argv[1]);
  const head = JSON.parse(process.argv[2]);
  const lines = [];
  for (const [kind, key] of [['runtime', 'dependencies'], ['dev', 'devDependencies']]) {
    const before = base[key] ?? {};
    const after = head[key] ?? {};
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const name of names) {
      if (!(name in before) || !(name in after)) {
        console.error('release-sdk-bump: ' + name + ' was added or removed, not bumped; out of scope.');
        process.exit(1);
      }
      if (before[name] !== after[name]) {
        lines.push([kind, name, before[name], after[name]].join('|'));
      }
    }
  }
  if (!lines.length) {
    console.error('release-sdk-bump: PR changes no dependency versions.');
    process.exit(1);
  }
  process.stdout.write(lines.join('\n'));
" "$BASE_PKG" "$HEAD_PKG")"

# --- native bumps need a qualify-sdk.sh PASS review ---
NATIVE_COUNT="$(grep -cE '^runtime\|(@openai/codex-sdk|@anthropic-ai/claude-agent-sdk)\|' <<<"$DEP_CHANGES" || true)"
if [ "$NATIVE_COUNT" -gt 0 ]; then
  QUALIFIED="$(node -pe "
    JSON.parse(process.argv[1]).reviews.some(
      (r) => r.state === 'APPROVED' && r.body.includes('SDK qualification: PASS'),
    )
  " "$PR_JSON")"
  if [ "$QUALIFIED" != "true" ]; then
    echo "release-sdk-bump: PR #${PR} bumps a native agentic SDK but has no 'SDK qualification: PASS' review." >&2
    echo "Run scripts/qualify-sdk.sh ${PR} first." >&2
    exit 1
  fi
fi

# --- compute the release version and changelog section ---
git fetch origin main --quiet
CURRENT_VERSION="$(node -pe "JSON.parse(process.argv[1]).version" "$BASE_PKG")"
VERSION="$(node -pe "
  const [major, minor, patch] = process.argv[1].split('.').map(Number);
  [major, minor, patch + 1].join('.')
" "$CURRENT_VERSION")"

CHANGELOG_BULLETS="$(node -e "
  const lines = process.argv[1].split('\n').map((l) => l.split('|'));
  const natives = ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk'];
  const fmt = (list) =>
    list.map(([, name, from, to]) => '\`' + name + '\` from \`' + from + '\` to \`' + to + '\`').join(' and ');
  const nativeLines = lines.filter(([kind, name]) => kind === 'runtime' && natives.includes(name));
  const otherRuntime = lines.filter(([kind, name]) => kind === 'runtime' && !natives.includes(name));
  const bullets = [];
  if (nativeLines.length) {
    const which = nativeLines.length > 1 ? 'both native adapters' : 'the native adapter';
    bullets.push('- Updated ' + fmt(nativeLines) + '. Re-qualified ' + which + ' with \`neal compat\`; no behavior change.');
  }
  if (otherRuntime.length) {
    bullets.push('- Updated ' + fmt(otherRuntime) + '.');
  }
  if (!bullets.length) {
    console.error('release-sdk-bump: only devDependencies changed; nothing ships in the package, no release needed.');
    process.exit(1);
  }
  process.stdout.write(bullets.join('\n'));
" "$DEP_CHANGES")"

echo "Dependency PR : #${PR} — ${PR_TITLE}"
echo "Release       : ${CURRENT_VERSION} -> ${VERSION} (patch)"
echo "Changelog     :"
sed 's/^/  /' <<<"$CHANGELOG_BULLETS"
read -r -p "Merge PR #${PR} and release ${VERSION}? Type 'yes' to proceed: " confirm
[ "$confirm" = "yes" ] || { echo "aborted."; exit 1; }

# --- merge the dep PR and prepare the release branch ---
gh pr merge "$PR" --squash
git checkout main --quiet
git pull --ff-only --quiet
RELEASE_BRANCH="release-${VERSION}"
git checkout -b "$RELEASE_BRANCH" --quiet
pnpm version "$VERSION" --no-git-tag-version

node -e "
  const fs = require('fs');
  const path = 'CHANGELOG.md';
  const marker = '## [Unreleased]';
  const today = new Date().toISOString().slice(0, 10);
  const section = '## [' + process.argv[1] + '] - ' + today + '\n\n### Changed\n\n' + process.argv[2];
  const text = fs.readFileSync(path, 'utf8');
  if (!text.includes(marker)) throw new Error('CHANGELOG.md has no ' + marker + ' section.');
  fs.writeFileSync(path, text.replace(marker, marker + '\n\n' + section));
" "$VERSION" "$CHANGELOG_BULLETS"

# --- release gates ---
pnpm install --frozen-lockfile
RELEASE_VERSION="$VERSION" RELEASE_DRY_RUN=true pnpm run validate:release
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node scripts/verify-package.mjs

# --- release-preparation PR ---
git add package.json CHANGELOG.md
git commit -m "Prepare ${VERSION} release" --quiet
git push -u origin "$RELEASE_BRANCH" --quiet
PREP_PR_URL="$(gh pr create --title "Prepare ${VERSION} release" --body "$(printf '## Summary\n\nRelease prep for %s, a patch release covering the dependency bumps from #%s.\n\n## Changes\n\n- Bump `package.json.version` to %s\n- Add the %s changelog section:\n\n%s\n\nAll release gates pass locally via scripts/release-sdk-bump.sh.' "$VERSION" "$PR" "$VERSION" "$VERSION" "$CHANGELOG_BULLETS")")"
PREP_PR="${PREP_PR_URL##*/}"

echo "Waiting for Verify on release-prep PR #${PREP_PR}..."
until gh pr checks "$PREP_PR" 2>/dev/null | grep -qE '^Verify[[:space:]]+(pass|fail)'; do sleep 15; done
if ! gh pr checks "$PREP_PR" | grep -qE '^Verify[[:space:]]+pass'; then
  echo "release-sdk-bump: Verify failed on PR #${PREP_PR}; branch ${RELEASE_BRANCH} left in place." >&2
  exit 1
fi
gh pr merge "$PREP_PR" --squash
git checkout main --quiet
git pull --ff-only --quiet
git branch -D "$RELEASE_BRANCH" --quiet

# --- Publish workflow: dry run, review gate, real run ---
start_publish_run() {
  local dry="$1" run_id=""
  gh workflow run publish.yml -f version="$VERSION" -f dry_run="$dry" >/dev/null
  for _ in $(seq 1 12); do
    sleep 5
    run_id="$(gh run list --workflow publish.yml --limit 1 --json databaseId,status \
      --jq '.[0] | select(.status == "queued" or .status == "in_progress") | .databaseId')"
    [ -n "$run_id" ] && break
  done
  [ -n "$run_id" ] || { echo "release-sdk-bump: dispatched Publish run did not appear." >&2; return 1; }
  echo "$run_id"
}

echo "Running Publish dry run..."
DRY_RUN_ID="$(start_publish_run true)"
gh run watch "$DRY_RUN_ID" --exit-status >/dev/null
echo "Dry run passed: https://github.com/navels/neal/actions/runs/${DRY_RUN_ID}"
read -r -p "Proceed with the real publish? Type 'yes' to proceed: " confirm2
[ "$confirm2" = "yes" ] || { echo "aborted before publish; rerun the workflow manually when ready."; exit 1; }

# Fresh npm auth before the real run so the stage lookup and approval work.
if ! npm whoami >/dev/null 2>&1; then
  echo "npm token is stale; logging in..."
  npm login
fi

echo "Running Publish (real)..."
RUN_ID="$(start_publish_run false)"
echo "Waiting for the Stage publish step on run ${RUN_ID}..."
until gh api "repos/{owner}/{repo}/actions/runs/${RUN_ID}/jobs" \
  --jq '.jobs[0].steps[] | select(.name == "Stage publish") | select(.status == "completed") | .name' 2>/dev/null | grep -q .; do
  sleep 15
done

STAGE_LIST="$(npm stage list "$PACKAGE_NAME" 2>/dev/null || true)"
STAGE_ID="$(grep -F "$VERSION" <<<"$STAGE_LIST" | grep -oE '[0-9a-zA-Z-]{16,}' | grep -v "$PACKAGE_NAME" | head -1 || true)"
if [ -z "$STAGE_ID" ]; then
  echo "Could not extract the stage ID automatically. npm stage list output:"
  echo "$STAGE_LIST"
  read -r -p "Paste the stage ID (or leave empty to approve via npmjs.com yourself): " STAGE_ID
fi
if [ -n "$STAGE_ID" ]; then
  echo "Approving stage ${STAGE_ID} (npm will prompt for 2FA)..."
  npm stage approve "$STAGE_ID"
else
  echo "Approve the stage at npmjs.com; the workflow waits up to 60 minutes."
fi

echo "Waiting for the Publish run to finalize..."
gh run watch "$RUN_ID" --exit-status >/dev/null

# --- verify ---
PUBLISHED="$(npm view "$PACKAGE_NAME" version)"
[ "$PUBLISHED" = "$VERSION" ] || { echo "release-sdk-bump: npm latest is ${PUBLISHED}, expected ${VERSION}." >&2; exit 1; }
gh release view "v${VERSION}" --json tagName --jq .tagName >/dev/null
echo "Released ${PACKAGE_NAME}@${VERSION}: npm latest, tag v${VERSION}, and the GitHub release are all up."
