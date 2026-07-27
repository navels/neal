#!/usr/bin/env bash
#
# scripts/qualify-sdk.sh — behavioral qualification for native agentic-SDK
# bump PRs (@openai/codex-sdk, @anthropic-ai/claude-agent-sdk).
#
# CI typechecks and unit-tests these bumps but cannot exercise the native
# adapters (they need subscription auth), so this script runs the missing
# layer locally: the full test suite plus a live `neal compat --role all`
# pass-through on the bumped adapter, using the Claude/Codex CLI auth already
# present on this machine. On PASS it posts the compat matrix to the PR and
# approves it; on FAIL it posts the evidence and leaves the PR open.
#
# Usage: scripts/qualify-sdk.sh <pr-number> [--merge]
#   --merge  squash-merge the PR after a PASS (default: approve only)
#
# Requirements: gh (authenticated), node + pnpm on PATH, and the relevant
# provider CLI logged in (claude / codex). Runs in a throwaway git worktree —
# this checkout's branch, node_modules, and dist are not touched.

set -euo pipefail

PR="${1:?usage: scripts/qualify-sdk.sh <pr-number> [--merge]}"
MERGE_AFTER="${2:-}"

for tool in gh git node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "qualify-sdk: missing required tool: $tool" >&2; exit 1; }
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/neal-qualify-XXXXXX")"
QBRANCH="qualify-pr-${PR}"

cleanup() {
  cd "$REPO_ROOT" || return
  git worktree remove --force "$WORK/wt" 2>/dev/null || true
  git branch -D "$QBRANCH" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cd "$REPO_ROOT"
git fetch origin "pull/${PR}/head:${QBRANCH}" --force --quiet
git fetch origin main --quiet
git worktree add --quiet "$WORK/wt" "$QBRANCH"
cd "$WORK/wt"

# Which native SDKs does this PR bump? Renovate groups both native SDKs into
# one PR, so qualification loops over every bumped adapter.
DIFF="$(git diff "$(git merge-base HEAD origin/main)" HEAD -- package.json)"
ADAPTERS=()
if grep -q '"@openai/codex-sdk"' <<<"$DIFF"; then
  ADAPTERS+=("@openai/codex-sdk|openai-codex|gpt-5.5")
fi
if grep -q '"@anthropic-ai/claude-agent-sdk"' <<<"$DIFF"; then
  ADAPTERS+=("@anthropic-ai/claude-agent-sdk|anthropic-claude|claude-opus-4-8")
fi
if [ ${#ADAPTERS[@]} -eq 0 ]; then
  echo "qualify-sdk: PR #${PR} does not change a native agentic SDK in package.json." >&2
  echo "(AI-SDK-tier and utility bumps are qualified automatically in CI.)" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm test
pnpm build

# Run compat once per bumped adapter, in parallel — each from a temp cwd
# whose repo-level config pins every role to that adapter WITH AN EXPLICIT
# MODEL (repo-level config takes precedence over ~/.neal/config.yml, so
# nothing leaks in from this machine's personal configuration), and each
# hits a different vendor's API, so there is no shared quota or state to
# race on. Every stderr stream is tee'd live to the terminal, prefixed with
# the provider id so concurrent output stays attributable, while the full
# text is still captured to file for the FAIL-path report below.
PASS="true"
QUALIFIED=""
MATRIX=""
PIDS=()
for entry in "${ADAPTERS[@]}"; do
  IFS='|' read -r PKG PROVIDER MODEL <<<"$entry"
  echo "Qualifying ${PKG} on the ${PROVIDER} adapter (model ${MODEL})."
  COMPAT_CWD="$WORK/compat-cwd-${PROVIDER}"
  mkdir -p "$COMPAT_CWD"
  cat > "$COMPAT_CWD/neal.yml" <<EOF
agent:
  coder:
    provider: ${PROVIDER}
    model: ${MODEL}
  reviewer:
    provider: ${PROVIDER}
    model: ${MODEL}
EOF

  echo "Running live compat qualification for ${PROVIDER} (real provider calls)..."
  ( cd "$COMPAT_CWD" && NEAL_NOTIFY_BIN= node "$WORK/wt/dist/neal/index.js" compat --role all --json ) \
    > "$WORK/compat-${PROVIDER}.json" \
    2> >(tee "$WORK/compat-${PROVIDER}.err" | sed "s/^/[${PROVIDER}] /" >&2) &
  PIDS+=("$!")
done

set +e
for pid in "${PIDS[@]}"; do
  wait "$pid"
done
set -e

for entry in "${ADAPTERS[@]}"; do
  IFS='|' read -r PKG PROVIDER MODEL <<<"$entry"
  ADAPTER_PASS="$(node -e "try{const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(r.overallPass===true))}catch{process.stdout.write('false')}" "$WORK/compat-${PROVIDER}.json")"
  [ "$ADAPTER_PASS" = "true" ] || PASS="false"
  QUALIFIED="${QUALIFIED}${QUALIFIED:+, }\`${PKG}\` (${PROVIDER}/${MODEL}: ${ADAPTER_PASS})"
  # Render the report as a markdown table (scripts/compat-md.mjs) rather than
  # dumping JSON into the PR. Use REPO_ROOT's copy — it is the matched pair of
  # this script and is always present, whereas the qualified worktree (an older
  # SDK-bump branch) may predate the formatter.
  ADAPTER_MD="$(node "$REPO_ROOT/scripts/compat-md.mjs" "$WORK/compat-${PROVIDER}.json" "${PROVIDER} / ${MODEL}")"
  MATRIX="${MATRIX}${MATRIX:+$'\n\n'}${ADAPTER_MD}"
done

if [ "$PASS" = "true" ]; then
  BODY="$(printf '**SDK qualification: PASS** — %s.\n\nFull test suite green locally, and \`neal compat --role all\` passed on a subscription-authenticated machine for every bumped adapter.\n\n<details><summary>compat matrices</summary>\n\n%s\n\n</details>' \
    "$QUALIFIED" "$MATRIX")"
  gh pr review "$PR" --approve --body "$BODY"
  echo "PASS — approved PR #${PR}."
  if [ "$MERGE_AFTER" = "--merge" ]; then
    gh pr merge "$PR" --squash
    echo "Merged PR #${PR}."
  else
    echo "Merge when ready: gh pr merge ${PR} --squash"
  fi
else
  ERR_TAIL="$(tail -n 15 "$WORK"/compat-*.err 2>/dev/null || true)"
  BODY="$(printf '**SDK qualification: FAIL** — %s.\n\n<details><summary>compat matrices</summary>\n\n%s\n\n</details>\n\n<details><summary>stderr tails</summary>\n\n\`\`\`\n%s\n\`\`\`\n</details>' \
    "$QUALIFIED" "$MATRIX" "$ERR_TAIL")"
  gh pr comment "$PR" --body "$BODY"
  echo "FAIL — evidence posted to PR #${PR}; PR left open." >&2
  exit 1
fi
