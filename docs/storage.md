# Storage contract

neal uses project-local `.neal/` storage as the source of truth for runs, queues,
review artifacts, recovery artifacts, progress, and audit history. User-level
storage is reserved for configuration, guidance, caches, logs, and future
optional discovery helpers.

The storage contract here is product-level. Run and queue ledger state
transition and validation details are documented separately in
[state-machine.md](state-machine.md).

## Public automation surface

`neal status --json` and `neal status --json --all` are the stable automation
contracts. Scripts should prefer them over parsing raw files under `.neal/`.
The status JSON includes public status and phase strings, next action, commit
and patch summaries, provider-error metadata, build metadata, and active writer
lock evidence through `lock.kind`.

The single-run JSON is the authoritative read model for wrappers that already
know a run id. Important stable fields include:

- `runId`, `status`, `effectiveStatus`, `publicStatus`, `phase`,
  `publicPhase`, and `nextAction` for classification and follow-up.
- `waitingForOperatorGuidance`, `pendingOperatorGuidance`, `blocker`,
  `manualGate`, `resumeDecision`, `health`, and `lock` for blocked, waiting,
  paused, timed-out, live-lock, stale-lock, and manually gated states.
- `commits` with `initialBaseCommit`, `baseCommit`, `finalCommit`,
  `createdCommitCount`, and accepted-scope final commits.
- `squash` with the run-local audit artifact path, summary status
  (`missing`, `pending`, `complete`, or `malformed`), replacement/final-head
  commits, original base/final commits, and an unavailable reason when the
  summary cannot provide complete metadata.
- `patch` with the conservative default-submission decision, reason, patch
  source, base/head/range, commit count, changed-file count, changed files, and
  unavailable reason.
- `providerError` with the latest provider failure or unclassified phase error,
  including timestamp, provider id, role, label, session handle, normalized
  error kind, bounded message, and retryability where available.
- `build` with neal package version, neal source Git SHA when available, Node
  version, source marker (`meta` or `live_fallback`), and the persisted
  planner/coder/reviewer agent config.
- `artifacts` with run-local paths for the human narrative, review, progress,
  support, and related diagnostic artifacts.

`neal status --json --all` is the discovery surface. Each listed run is built
from the same status snapshot path, so list entries retain the public status,
phase, next action, commit, squash, provider-error, build, patch, lock, and
artifact summaries. Scripts that need a final decision for one run should still
read that run with `--run <run-id>`.

Status reads are best-effort for optional artifacts. Missing or malformed
`SQUASH_RESULT.json`, unreadable patch ranges, missing run metadata, and old
runs without build metadata are represented in the JSON summary instead of
making status fail. The canonical run ledger still must be readable.

Raw `.neal` files are inspectable support artifacts. Internal JSON files are not
public JSON APIs unless this repository documents that guarantee for a specific
command output.

Storage classifications used below are: stable CLI surface, user-facing human
artifact, support/debug artifact, internal state, and lock/concurrency artifact.
The stable CLI surfaces in this storage contract are `neal status --json` and
`neal status --json --all`. The project-local files are artifacts that support
neal operations and diagnostics.

## Project-local layout

| Path | Classification | Contract |
| --- | --- | --- |
| `.neal/runs/<run-id>/RUN_STATE.json` | Internal state | Child-run ledger. neal validates current v1 state on read, but scripts should use `neal status --json` rather than depend on this file as a public API. |
| `.neal/runs/<run-id>/events.ndjson` | Support/debug artifact | Append-only event log for audit, diagnostics, command output references, and provider/runtime events. Readers should tolerate malformed or partial final lines where implemented. |
| `.neal/runs/<run-id>/stderr.log` | Support/debug artifact | Append-only stderr transcript for writer runs. It includes visible narrative lines plus low-level detail such as provider/tool telemetry, command output, reviewer context, and heartbeat diagnostics that may be hidden from the normal terminal stream. |
| `.neal/runs/<run-id>/meta.json` | Support/debug artifact | Run metadata used for diagnostics. New writes include `version: 1`. Metadata alone cannot make a run selectable for squash or status. It is not the stable automation surface. |
| `.neal/runs/<run-id>/PLAN_ORIGINAL.md` | Support/debug artifact | Original plan document backup for `neal plan` runs, written before in-place plan refinement so the pre-refinement input remains inspectable. |
| `.neal/runs/<run-id>/DERIVED_PLAN_SCOPE_<scope>.md` | User-facing human artifact | Replacement execution plan produced when the coder splits an active scope. |
| `.neal/runs/<run-id>/SCOPE_<scope>_INVALID_DERIVED_PLAN.md` | Support/debug artifact | Rejected split-plan payload and its validation errors. Written only when the returned replacement plan is invalid. |
| `.neal/runs/<run-id>/SCOPE_<scope>_DISCARDED.diff` | Support/debug artifact | Scope work preserved before neal resets it while adopting a replacement plan. |
| `.neal/runs/<run-id>/GATE-<id>.md` | User-facing human artifact | Instructions and resume checks for an active manual gate. |
| `.neal/runs/<run-id>/scratch/` | Support/debug artifact | Reserved run-local scratch root for execute-scope and final-completion review. Read-only reviewer prompts do not use it. It is not durable state, but it remains project-local `.neal/` data for retention and privacy purposes. |
| `.neal/runs/<run-id>/plan-progress.json` | Internal state | Machine-readable v1 progress artifact used by neal context and summaries. |
| `.neal/runs/<run-id>/PLAN_PROGRESS.md` | User-facing human artifact | Human-readable progress summary for the active plan or scope. |
| `.neal/runs/<run-id>/RETROSPECTIVE.md` | User-facing human artifact | Human-readable retrospective or checkpoint summary. Archived variants such as `RETROSPECTIVE-scope-*.md` may also exist. |
| `.neal/runs/<run-id>/RUN_METRICS.json` | Support/debug artifact | Machine-readable metrics paired with the current retrospective. Archived variants such as `RUN_METRICS-scope-*.json` may also exist. |
| `.neal/runs/<run-id>/RUN_NARRATIVE.md` | User-facing human artifact | Human-readable run narrative. It includes a benchmark trace section with status, patch-policy, provider-error, and reproducibility summaries suitable for public result bundles. |
| `.neal/runs/<run-id>/RUN_NARRATIVE.json` | Internal state | Narrative source data that neal may read to update the human narrative. It is not a public trace artifact. |
| `.neal/runs/<run-id>/REVIEW.md` | User-facing human artifact | Scope or plan review history and findings. |
| `.neal/runs/<run-id>/REVIEW-<commit>.md` | User-facing human artifact | Archived review history for an accepted scope commit. |
| `.neal/runs/<run-id>/REVIEWER_CONTEXT.md` | Support/debug artifact | Bounded reviewer-continuity packet rendered for inspection: completed scopes with their changed files, findings, inherited plan-review debt, and citations. |
| `.neal/runs/<run-id>/REVIEWER_CONTEXT.json` | Support/debug artifact | Machine-readable reviewer-continuity packet without the rendered prompt markdown. |
| `.neal/runs/<run-id>/RECOVERY.md` | User-facing human artifact | Interactive blocked-recovery transcript/history for a run. |
| `.neal/runs/<run-id>/FINAL_COMPLETION_REVIEW.md` | User-facing human artifact | Whole-plan final completion review. |
| `.neal/runs/<run-id>/SQUASH_RESULT.json` | Support/debug artifact | Versioned audit artifact from `neal squash`. It records the squash decision/result but is not the stable automation surface. |
| `.neal/runs/<run-id>/QUEUE_LINK.json` | Internal state | Link from a child run back to its parent plan-and-execute queue item. |
| `.neal/queues/<queue-id>/QUEUE_STATE.json` | Internal state | Parent queue ledger. neal validates it on read, but it is not a public JSON API. |
| `.neal/queues/<queue-id>/QUEUE_SUMMARY.md` | User-facing human artifact | Human-readable summary for a plan-and-execute queue. |
| `.neal/reviews/<review-id>/meta.json` | Support/debug artifact | Review metadata for a read-only `neal review` request. |
| `.neal/reviews/<review-id>/events.ndjson` | Support/debug artifact | Append-only review event log. |
| `.neal/reviews/<review-id>/REVIEW_REQUEST.md` | User-facing human artifact | Original review request, selected range, and loop prompts. |
| `.neal/reviews/<review-id>/REVIEW_CONTEXT.json` | Support/debug artifact | Resolved local commit range, changed files, diff stat, and diff used for findings. |
| `.neal/reviews/<review-id>/REVIEW_DRAFT.md` | User-facing human artifact | Human-readable draft findings history for each review loop round. |
| `.neal/reviews/<review-id>/REVIEW_REVIEW.json` | Support/debug artifact | Versioned review loop summary, including outcome, cap, and round reviews. |
| `.neal/reviews/<review-id>/REVIEW_ROUNDS.json` | Support/debug artifact | Versioned round-by-round review draft/review prompt and response history. |
| `.neal/reviews/<review-id>/REVIEW_FINAL.md` | User-facing human artifact | Accepted final reviewed findings artifact, written only after reviewer acceptance. |
| `.neal/current.json` | Internal state | Default writer-run pointer for commands that need the current run. |
| `.neal/current-queue.json` | Internal state | Preferred current plan-and-execute queue pointer. |
| `.neal/active-run.lock` | Lock/concurrency artifact | Active writer-run lock. It prevents unrelated writer commands from mutating the same checkout concurrently. |
| `.neal/NOTES.md` | User-facing human artifact | Optional operator-authored notes included in bounded context packets. neal reads this file but does not create it. |

Writer processes remove their own active lock during normal shutdown and on
`SIGINT`/`SIGTERM`. Timeout wrappers should still launch neal in a process group
and terminate the group, because provider-owned child processes are outside the
lock file contract. After a timeout, call `neal status --json --run <run-id>`
when the run id is known. Treat the wrapper timeout as the primary result while
using `status`, `health`, and `lock.kind` to record whether neal's run state is
still running, cleaned up, live, stale, cross-host, or unreadable.

## Patch automation policy

Default public prediction submission should use only
`patch.defaultSubmissionEligible: true`. neal sets that value only for clean
completed execute runs with a non-empty readable patch range.

When a completed run has a successful squash artifact, the status read model
prefers `squash.originalBaseCommit..squash.replacementCommit` and reports
`patch.source: "squash_replacement"`. Unsquashed completed execute runs fall
back to `commits.initialBaseCommit ?? commits.baseCommit` through
`commits.finalCommit` and report `patch.source: "final_commit"`.

Failed, blocked, paused, running, waiting, provider-error, timed-out,
manual-gate, malformed-squash, pending-squash, unreadable-range, and empty-patch
runs may still report patch-bearing metadata for diagnostics or private
analysis. They are not default-submission eligible, and `patch.reason` explains
why.

## Source of truth

Project-local `.neal/` remains the source of truth for run, queue, review,
recovery, progress, and audit artifacts.

Run-local `.neal/runs/<run-id>/RUN_STATE.json` is the only writer-run ledger
path neal writes. `.neal/current.json` points at the default writer run. It is a
pointer, not a copy of the ledger.

There is no required global run index in v1. Future global discovery, if added,
must be optional and rebuildable from project-local data. It must not become the
only place where run or queue history can be recovered.

## Ledgers and pointers

`.neal/runs/<run-id>/RUN_STATE.json` and
`.neal/queues/<queue-id>/QUEUE_STATE.json` are persisted ledgers. neal validates
them on read. Child-run state uses strict current v1 hydration: missing or
malformed required child-run fields fail instead of receiving defaults. These
ledgers are not public JSON APIs.

neal does not write, read, migrate, or repair a session mirror. Use
`.neal/current.json` as the default writer-run pointer, `neal status --all` to
discover run IDs, and `--run <run-id>` when selecting a specific run for
`resume` or `status`.

Squash discovery requires readable run-local state. Run metadata and progress
artifacts can help humans inspect a run, but they cannot make a run selectable
for `neal squash` without `.neal/runs/<run-id>/RUN_STATE.json`.

## Schema versions and writes

neal-owned JSON schemas use `version: 1` where they are read back as durable
state or audit data. That includes child-run state, current run pointers, queue
state, current queue pointers, queue child links, progress summaries, run
narratives, squash audit results, review artifacts, and the active writer lock.

Run `meta.json` is diagnostic support data. New writes include `version: 1`, but
status, resume, and squash selection derive canonical run facts from run-local
state.

Important replacement artifacts under `.neal/` are written through per-file
atomic replacement helpers so a reader should see either the old complete file
or the new complete file. This is still not a multi-file transaction: related
files such as state, progress, reviews, and pointers can briefly disagree if a
process stops between writes. Append-only event logs remain append-only, and the
active writer lock keeps exclusive file creation for acquisition.

## Retention and privacy

`.neal/` may contain prompts, local paths, command output, diffs, review text,
provider responses, user guidance diagnostics, reviewer scratch files, copied
tests, build logs, and project-specific context. Review `.neal/` before sharing
archives, bug reports, or support bundles.

Public automation bundles should copy `neal status --json` output and
`RUN_NARRATIVE.md` when a safe per-run trace is needed. Do not publish raw run
directories, `RUN_NARRATIVE.json`, `events.ndjson`, `stderr.log`, or internal
state ledgers as benchmark traces.

Run and review artifacts are intentionally inspectable, but they should be
treated as project data. Apply the same retention and access controls you use
for source, logs, and local debugging output.

## Manual cleanup

Manual cleanup is safe only when you no longer need resume, history, diagnostics,
or audit data for the item being removed.

Reasonable manual cleanup options:

- remove old `.neal/runs/<run-id>/` directories when resume and run history for
  those runs are no longer needed
- remove old `.neal/queues/<queue-id>/` directories when queue resume and queue
  history are no longer needed
- remove stale `.neal/current.json` or `.neal/current-queue.json` pointers only
  after confirming they do not point to work you still intend to resume

Deleting run or queue state removes neal's resume and history for that run or
queue. Prefer keeping the full directory until the related work has been merged,
archived, or otherwise recorded somewhere durable.
