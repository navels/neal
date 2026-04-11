# Progress

## Completed

- Confirmed the correct Claude TypeScript SDK package is `@anthropic-ai/claude-agent-sdk`, not `@anthropic-ai/claude-code`.
- Installed the Claude Agent SDK and removed the incorrect Claude CLI package dependency.
- Verified the Claude Agent SDK works in this environment with a real one-shot query, including a real `session_id` and successful result payload.
- Added a new separate CLI entrypoint for the future orchestrator:
  - [`src/codex-claude-chunked/index.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/index.ts)
- Added the initial Phase 1 scaffold:
  - [`src/codex-claude-chunked/types.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/types.ts)
  - [`src/codex-claude-chunked/state.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/state.ts)
  - [`src/codex-claude-chunked/review.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/review.ts)
  - [`src/codex-claude-chunked/git.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/git.ts)
  - [`src/codex-claude-chunked/agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/agents.ts)
  - [`src/codex-claude-chunked/orchestrator.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/orchestrator.ts)
- The new initializer already creates:
  - `.forge/session.json`
  - `REVIEW.md`
- Updated [`package.json`](/Users/lee.nave/code/personal/codex-chunked/package.json) to expose the new bin name:
  - `forge`
- Implemented the first real Phase 2 slice:
  - lightweight `session.json` validation in [`state.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/state.ts)
  - `--resume` handling in [`index.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/index.ts)
  - commit-range and diff helpers in [`git.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/git.ts)
  - round-grouped markdown rendering in [`review.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/review.ts)
  - a real Codex chunk round in [`agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/agents.ts)
  - a real Claude structured review round in [`agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/agents.ts)
  - a first one-pass orchestrator in [`orchestrator.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/orchestrator.ts)
- Implemented the next cleanup pass on Phase 2:
  - removed the latent empty-string `planDoc` fallback and tightened init vs. resume flow
  - renamed per-finding `claudeSummary` to `roundSummary`
  - added Codex streamed progress output for the new CLI so long Codex rounds are visible
  - capped inline Claude diff input to avoid unbounded prompt growth on large chunks
- Implemented the next orchestration phase:
  - added a real Codex review-response round in [`agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/agents.ts)
  - updated [`orchestrator.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/orchestrator.ts) so Claude review now branches to `codex_response`, `done`, or `blocked`
  - replaced the one-pass phase transition with a real loop across `codex_chunk`, `claude_review`, and `codex_response`
  - wired Codex finding dispositions back into `session.json` and `REVIEW.md`
- Hardened the multi-round loop:
  - switched Codex review-response turns to streamed execution for visible progress
  - added defensive Codex structured-response parsing with raw-response context on failure
  - introduced wrapper-owned canonical finding IDs in [`types.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/types.ts)
  - added canonical blocking-count tracking per Claude round
  - blocked the loop when the same canonical blocking finding reappears in three rounds
  - blocked the loop when blocking canonical counts fail to decrease for two consecutive Claude rounds
  - added backward-compatible state hydration for older `session.json` files missing canonical IDs or per-round blocking counts
  - updated Claude review prompts to mention the previous review head commit so follow-up reviews can focus on the delta since the last Claude pass
- Implemented the finishing path:
  - added git helpers for worktree checks, commit subjects, diff stats, and soft-reset squash in [`git.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/git.ts)
  - updated [`orchestrator.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/orchestrator.ts) so accepted review rounds transition to `final_squash`
  - implemented wrapper-owned final squash, `notes/REVIEW-<commit>.md` archival, and completion/block notifications
  - set final squashed commit messages to reuse the latest Codex-authored commit subject instead of asking Claude to name the commit
  - updated the CLI JSON output in [`index.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/index.ts) to expose `finalCommit` and `archivedReviewPath`
- Cleaned up final artifacts:
  - added transient wrapper artifact ignores in [`.gitignore`](/Users/lee.nave/code/personal/codex-chunked/.gitignore)
  - changed finalization to write `notes/REVIEW-<commit>.md` directly and regenerate root [`REVIEW.md`](/Users/lee.nave/code/personal/codex-chunked/REVIEW.md) as a final pointer file instead of leaving a deleted review artifact behind
- Completed a real end-to-end sandbox run:
  - the sandbox plan in [`notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md) now runs through Codex chunking, Claude review, final squash, review archival, and completion notification in an isolated scratch repo
- Improved Claude review observability:
  - added stderr-backed Claude progress logging for tool activity and task/status events in [`agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/agents.ts)
  - added a clear Claude inactivity timeout with configurable `CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS`
- Implemented hybrid Claude review input for large diffs:
  - added changed-file enumeration in [`git.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/git.ts)
  - updated [`agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/codex-claude-chunked/agents.ts) so small diffs stay inline, while large diffs switch to diff stat plus changed-file guidance and direct Claude to inspect files with tools
- Added persistent per-run diagnostics for `forge`:
  - each run now creates `.forge/runs/<timestamp>-<id>/`
  - `meta.json` stores run metadata
  - `events.ndjson` records structured orchestration events
  - `stderr.log` captures tee'd Codex, Claude, and wrapper diagnostics
  - `session.json` now stores `runDir`, and CLI JSON output includes it

## Verified

- `pnpm typecheck` passed.
- `pnpm exec tsx src/codex-claude-chunked/index.ts README.md` passed.
- `pnpm build` passed and refreshed the global binaries.
- A real one-pass run launched a live Codex `exec` subprocess from `forge`.
- The one-pass path correctly maintained `.forge/session.json` and rendered `REVIEW.md`.
- `pnpm typecheck` still passed after the Phase 2 cleanup pass.
- `pnpm typecheck` still passed after adding the Codex response round and multi-phase loop.
- `pnpm typecheck` still passed after adding canonical finding identity and convergence safeguards.
- `pnpm typecheck` still passed after adding final squash, archival, and notifications.
- `pnpm typecheck` still passed after switching final review handling to an archived review plus root pointer file.
- `pnpm typecheck` still passed after adding Claude review progress logging and inactivity timeouts.
- `pnpm typecheck` still passed after adding the hybrid large-diff review fallback.
- `pnpm typecheck` still passed after adding persistent run diagnostics.
- A fresh sandbox smoke run confirmed that `forge` now creates and populates:
  - `.forge/runs/<timestamp>-<id>/meta.json`
  - `.forge/runs/<timestamp>-<id>/events.ndjson`
  - `.forge/runs/<timestamp>-<id>/stderr.log`
  during live execution
- A full isolated sandbox run completed end-to-end with:
  - final squashed commit `8ebcd57c98ca5dd70af7f82a62e977ffed278bc9`
  - archived review file `notes/REVIEW-8ebcd57c98ca5dd70af7f82a62e977ffed278bc9.md`
  - completion notification delivered after the run finished
- A forced large-diff-fallback sandbox run also completed end-to-end with:
  - `CLAUDE_INLINE_DIFF_FILE_LIMIT=1`
  - final squashed commit `1a1f31ec02c9552d3775f5b191012367a8c5bad2`
  - archived review file `notes/REVIEW-1a1f31ec02c9552d3775f5b191012367a8c5bad2.md`
  - successful tool-based Claude review fallback instead of inline diff review

## Current State

The repository now has:

- a verified Claude SDK integration path
- a separate `forge` CLI scaffold
- a wrapper-owned `session.json` state model
- a rendered `REVIEW.md` output path
- a multi-phase orchestration path that can:
  - initialize state
  - run a Codex chunk
  - compute commit range and diff
  - run a Claude structured review
  - resume Codex on the same thread to respond to blocking review findings
  - update finding statuses and Codex dispositions
  - track stable canonical finding identities across review rounds
  - stop early when review rounds stall or repeatedly reopen the same blocking issue
  - reuse the latest Codex-authored commit subject for the final squashed commit message
  - squash wrapper-owned commits into one final commit
  - archive `REVIEW.md` to `notes/REVIEW-<commit>.md`
  - leave root `REVIEW.md` as a small final pointer file
  - send local blocked and completion notifications
  - persist per-run diagnostics under `.forge/runs/`
  - persist findings
  - re-render `REVIEW.md`

The loop now supports the full review/finalization lifecycle, has completed both normal and forced-fallback sandbox runs, exposes Claude review progress with a bounded inactivity timeout, persists diagnostics for postmortem inspection, and uses a hybrid review-input strategy for large diffs.

## Next Steps

1. Run one sandbox smoke test after the logging change to confirm the new `runDir` artifacts are created as expected in practice.
2. Keep validating with larger sandbox chunks when you want more confidence in Claude's tool-based fallback on broader diffs.
3. Optionally surface more explicit verification evidence to Claude if false positive "verification not shown" findings continue to appear in practice.
