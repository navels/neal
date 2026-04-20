# Neal Implementation Plan

## Goal

Build a standalone CLI, `neal <plan-doc>`, that orchestrates a multi-round implementation and review loop between Codex and Claude Code.

This document now serves as historical design context for `neal`. The earlier standalone `codex-chunked` and `codex-claude-chunked` CLI surfaces have been retired.

The key product direction is:

- `neal` is the review-loop tool
- planning and execution should be separate top-level workflows
- chunking is an execution mode, not the core identity
- execution should default to one-shot full-plan mode
- chunked execution should remain available behind an explicit flag

## Revised Design Principles

This plan intentionally favors a lower-risk v1:

- verify the Claude TypeScript SDK before assuming any specific session model
- use wrapper-owned JSON state as the source of truth
- treat human-readable markdown as a rendered artifact, not machine-critical IPC
- planning and execution should both reuse the review loop
- start fresh Codex and Claude sessions for each chunk to avoid context drift
- in one-shot execution, a single Codex implementation session may span the run, but chunked execution should reset both agents at chunk boundaries
- keep the initial module layout small
- make squash mechanics explicit and deterministic

## Top-Level Modes

`neal` should support two top-level workflows:

- `neal --plan [topic-or-plan-doc]`
- `neal --execute <plan-doc>`

`--plan` produces or revises a plan. `--execute` implements an existing plan.

## Execution Modes

Execution itself should support two explicit plan modes:

- `one_shot`
  - default
  - Codex is asked to complete the plan end-to-end if feasible
  - success marker: `AUTONOMY_DONE`
  - failure marker: `AUTONOMY_BLOCKED`
- `chunked`
  - opt-in via `--chunked`
  - Codex is asked to execute exactly one meaningful chunk
  - markers: `AUTONOMY_CHUNK_DONE`, `AUTONOMY_DONE`, `AUTONOMY_BLOCKED`

Chunking is therefore a policy for how work is fed into the review loop, not a separate orchestrator.

## Planning Workflow

`neal --plan` should:

1. Create a plan if none exists yet, or revise a provided draft plan.
2. In v1, prefer non-interactive plan refinement. If required information is missing, emit a short question list and stop rather than assuming an interactive prompt flow.
3. Clarify as needed:
   - objective
   - constraints
   - verification expectations
   - whether the work should be `one_shot` or `chunked`
4. Produce a normalized plan format that is explicitly executable by `neal`.
5. Run the draft through a Codex/Claude review loop until the plan is settled.
6. Write the resulting plan doc to disk.
7. Make no source-code commits and avoid touching runtime code outside plan artifacts.

Plan review should use fresh agent sessions and should not reuse implementation threads.

## Execution Workflow

For each `neal` run:

1. Load the plan doc and its explicit execution mode.
2. Create or resume wrapper state.
3. Direct Codex according to the selected execution mode:
   - one-shot: complete the plan end-to-end if feasible
   - chunked: complete exactly one meaningful chunk
4. Persist created commit hash or hashes plus plan-progress updates.
5. Start a Claude review round and direct Claude to review the new commit range.
6. Have the wrapper write Claude’s findings into `session.json` and render `REVIEW.md`.
7. Resume or continue the current implementation scope only as needed to answer review findings.
8. Repeat review-response rounds until convergence or a hard stop is reached.
9. Use the latest Codex-authored commit subject as the final squash commit message.
10. Have the wrapper perform the squash explicitly.
11. Render final review output and move `REVIEW.md` to `notes/REVIEW-<final-commit-hash>.md`.
12. Update the plan progress doc one last time.
13. Emit final notifications and terminate formally.

In chunked mode:

- each chunk gets fresh Codex and Claude sessions to avoid context drift
- the wrapper should loop across chunks until the plan is fully implemented or blocked
- only the current chunk’s review-response rounds share context with that chunk’s implementation work
- the next chunk starts from the updated plan doc and progress doc, not from prior agent thread history

## Wrapper Ownership

The wrapper, not the agents, owns:

- loop control
- session and thread bookkeeping
- state persistence
- convergence logic
- git bookkeeping
- squash execution
- archival
- notification delivery
- retries and resumability

The agents own:

- implementation work
- review reasoning
- finding dispositions
- commit messages for the work they authored

## CLI Shape

Primary commands:

```bash
neal --plan [TOPIC_OR_PLAN_DOC]
neal --execute /absolute/or/relative/PLAN.md
```

Likely follow-up flags:

- `--chunked`
- `--max-rounds <n>`
- `--state-dir <path>`
- `--review-file <path>`
- `--resume <state-file>`
- `--no-squash`

CLI semantics:

- `neal --plan` without a path should only be supported once a real interaction model exists; until then prefer `neal --plan <draft-or-topic-file>`
- `neal --plan <plan-doc>` reviews and revises an existing draft plan
- `neal --execute <plan-doc>` means one-shot execution unless the plan says otherwise
- `neal --execute --chunked <plan-doc>` is an explicit override for chunked execution when allowed
- `neal --resume [state-file]` resumes using the stored top-level mode and execution mode from `session.json`

## Pre-Implementation Spike

Before building the orchestration, run a short Claude SDK spike and verify:

1. the exact TypeScript package name
2. how to start a programmatic Claude Code session
3. whether a stable session ID is exposed
4. whether session resume is supported and worth using
5. whether structured output is supported directly
6. whether progress or retry events are exposed

Do not commit to the final `claude-agent.ts` design until this spike is complete.

## Proposed v1 Module Layout

Start with a compact module set under `src/neal/`:

- `index.ts`
- `orchestrator.ts`
- `agents.ts`
- `state.ts`
- `review.ts`
- `git.ts`

Defer extra module splits until the code actually grows.

## State Model

Persist wrapper-owned state after every phase so planning or execution can recover from process crashes.

Suggested shape:

```ts
type OrchestrationPhase =
  | 'codex_chunk'
  | 'claude_review'
  | 'codex_response'
  | 'final_squash'
  | 'done'
  | 'blocked';

type ReviewFinding = {
  id: string;
  round: number;
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  requiredAction: string;
  status: 'open' | 'fixed' | 'rejected' | 'deferred';
  claudeSummary: string;
  codexDisposition: string | null;
  codexCommit: string | null;
};

type ReviewRound = {
  round: number;
  claudeSessionId: string | null;
  commitRange: {
    base: string;
    head: string;
  };
  findings: string[];
};

type OrchestrationState = {
  version: 1;
  planDoc: string;
  cwd: string;
  topLevelMode: 'plan' | 'execute';
  executionMode: 'one_shot' | 'chunked';
  phase: OrchestrationPhase;
  createdAt: string;
  updatedAt: string;
  reviewMarkdownPath: string;
  archivedReviewPath: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  codexThreadId: string | null;
  rounds: ReviewRound[];
  findings: ReviewFinding[];
  createdCommits: string[];
  maxRounds: number;
  status: 'running' | 'done' | 'blocked' | 'failed';
};
```

Suggested locations:

- `.neal/session.json`
- repo-root `REVIEW.md`
- `.neal/runs/<timestamp>-<id>/plan-progress.json`
- `.neal/runs/<timestamp>-<id>/PLAN_PROGRESS.md`

## session.json Is Authoritative

`session.json` is the machine-readable source of truth.

It should contain:

- metadata
- top-level mode
- execution mode
- review rounds
- finding records
- Codex dispositions
- commit references
- final status

## Progress Doc Contract

Every executable plan should have a progress doc that the wrapper updates after each chunk or one-shot milestone.

Use the same pattern as review state:

- `plan-progress.json` in the active run directory is authoritative
- `PLAN_PROGRESS.md` in the active run directory is rendered for humans and agent context

The progress doc exists to:

- make burndown inspectable
- record what is already complete
- reduce ambiguity about what remains
- give the wrapper a stronger signal for plan completion

Minimum responsibilities:

- record completed chunks or milestones
- record current status of remaining work
- record blockers or deferred items
- make it obvious whether the plan is truly done

The wrapper should treat the progress doc as part of execution state, not as optional narrative.

The wrapper should parse and update JSON only, then render markdown from that JSON.

## REVIEW.md Is Rendered

`REVIEW.md` should be generated by the wrapper from `session.json` so the user and the agents can inspect the current review state.

Claude and Codex should not be responsible for maintaining markdown structure directly. They should return structured payloads or bounded text that the wrapper inserts into the JSON state and then renders to markdown.

## Codex Agent Responsibilities

`agents.ts` should provide a Codex adapter that:

- starts fresh implementation threads as needed
- reuses the existing transient retry-handling approach that originally came from the legacy Codex-only runner
- prompts Codex for:
  - one-shot implementation and commit
  - chunked implementation and commit
  - review response and finding dispositions

Historical differences from the retired `codex-chunked` runner:

- no automatic interactive `codex resume` handoff on exit
- implementation completion is not final until the Codex-Claude loop converges
- chunked execution should not carry Codex thread context from one chunk into the next

## Claude Agent Responsibilities

`agents.ts` should also provide a Claude adapter backed by the Claude TypeScript SDK.

Prefer fresh Claude sessions for plan review and for each execution chunk. Avoid carrying Claude session context across chunks.

Required capabilities:

- run a review round against:
  - commit range
  - current `session.json`
  - rendered `REVIEW.md`
- return structured findings or reliably parseable structured text

The orchestrator should not depend on Claude session persistence in v1.

## Prompt Contracts

Keep prompt templates local to `orchestrator.ts` or `agents.ts` until they become large enough to split.

Prompt split:

- one-shot implementation prompt
  - read the plan
  - read the progress doc
  - complete it end-to-end if feasible
  - verify relevant work
  - create real commit(s)
  - end with `AUTONOMY_DONE` or `AUTONOMY_BLOCKED`
- chunked implementation prompt
  - read the plan
  - read the progress doc
  - execute exactly one meaningful chunk
  - verify relevant work
  - create a real commit
  - end with `AUTONOMY_CHUNK_DONE`, `AUTONOMY_DONE`, or `AUTONOMY_BLOCKED`
- review-response prompt
  - unchanged in structure
  - always stays on the same implementation scope that Codex already started
- planning prompt
  - create or revise the plan
  - produce an explicit execution mode
  - produce or update the progress doc shape

- plan-review prompt
  - evaluate whether the plan is executable by `neal`
  - tighten scope, verification, and completion criteria
  - make sure chunked vs one-shot is explicit

The wrapper should keep one completion-detection path based on markers rather than inventing separate one-shot and chunked completion heuristics.

## Phased Implementation

### Phase 1: Finish Execution Mode Split

1. Complete `executionMode` support cleanly in runtime state, logger metadata, and CLI output.
2. Keep backward-compatible CLI behavior:
   - `neal --execute PLAN.md`
   - add explicit `--execute`
   - add explicit `--chunked`
3. Split the Codex implementation prompt builder into:
   - `buildOneShotPrompt()`
   - `buildChunkedPrompt()`
4. Enforce the marker contract correctly for one-shot vs chunked execution.
5. Keep review, convergence, squash, archive, and notifications unchanged.

### Phase 2: Add Progress Tracking And Multi-Chunk Execution

1. Add run-scoped `plan-progress.json` plus rendered `PLAN_PROGRESS.md`.
2. Add progress-doc metadata to wrapper state.
3. Update execution prompts to read the progress doc.
4. In chunked execution, start fresh Codex and Claude sessions for each chunk.
5. Add outer execution looping for chunked plans until the plan and progress doc both indicate completion or block.
6. Update the sandbox docs so the existing sandbox plan is invoked explicitly with `neal --execute --chunked ...`.
7. Add isolated validation runs for:
   - one-shot plan in this repo
   - chunked sandbox plan in this repo

### Phase 3: Add Planning Mode

1. Add `topLevelMode` to wrapper state.
2. Add `--plan` workflow for revising a provided draft or topic file.
3. Add planning prompts and plan-review prompts.
4. Keep v1 planning non-interactive:
   - if information is missing, emit questions and stop
   - do not require a live interactive interview loop yet
5. Add a small planning-mode fixture for validation.

## Validation Notes

The current sandbox plan should remain chunk-oriented. Add a second simple one-shot validation plan in this repo rather than trying to overload one plan for both modes. Add at least one small planning-mode fixture so the plan-creation loop can be tested without touching a real repo plan.

Needed prompt families:

- Codex implementation prompt
- Claude initial review prompt
- Codex review-response prompt
- Claude follow-up review prompt

Prompt rules:

- always reference the plan doc
- always reference the rendered review
- require finding IDs in responses
- require explicit dispositions: `fixed`, `rejected`, `deferred`
- forbid rewriting prior history

## Git Model

`git.ts` should own all deterministic git operations.

Wrapper-owned responsibilities:

- capture `baseCommit`
- enumerate commits created during the chunk session
- compute commit ranges for Claude review
- detect whether Codex created new commits in a response round
- perform final squash
- reuse the latest Codex-authored commit subject for the final squashed commit message
- resolve final commit hash
- ensure `notes/` exists before archiving the review file

## Explicit Squash Strategy

For v1, use an explicit soft-reset squash:

1. confirm the wrapper knows `baseCommit`
2. confirm the wrapper knows the created chunk-session commits
3. confirm the working tree is in the expected state
4. run `git reset --soft <baseCommit>`
5. create one new final commit with the wrapper-selected final message

This is preferred over interactive rebase for a scripted workflow.

If the worktree is not in the expected state, stop and report the problem instead of forcing the squash.

## Convergence Logic

Keep convergence logic simple in v1.

Recommended completion rule:

- no open blocking findings remain
- every finding has a Codex disposition
- latest Claude review produced no new blocking findings

Recommended hard stops:

- `maxRounds`, default `3`
- fail if the same finding ID reopens twice
- fail if there is no reduction in open blocking findings across two consecutive Claude reviews

Do not add `maxFixCommitsPerRound` in v1.

## Notifications

Reuse the existing local notification behavior.

Suggested events:

- Codex chunk committed
- Claude review completed
- Codex response round completed
- final convergence
- blocked/failure

Include:

- plan name
- round number
- Codex thread ID
- current commit hash

Claude session ID can be included if the SDK exposes it cleanly, but it should not be required for v1 correctness.

## Failure And Resume Strategy

The orchestration must be resumable.

Resume behavior:

- reload wrapper state from `.neal/session.json`
- inspect `phase`
- resume the Codex thread when needed
- rerun or continue the appropriate Claude review round from current git state and `session.json`

The wrapper should not require durable Claude session resume to recover.

## Open Questions

1. What is the exact Claude TypeScript SDK package name and API surface?
2. Does the SDK support schema-constrained or otherwise stable structured output?
3. Does the SDK expose retry/progress events?
4. Is Claude session resume useful enough to justify in a later phase?
5. What tool-permission model should the Claude adapter run with?

## Success Criteria

The new tool is successful when:

- it runs as `neal <plan-doc>`
- it can complete at least one Codex -> Claude -> Codex -> Claude round-trip
- it persists wrapper state and resumes safely after interruption
- `session.json` remains authoritative and valid
- `REVIEW.md` is rendered cleanly for human inspection
- it converges or stops deterministically
- it produces one final squashed commit
- it archives the review output to `notes/REVIEW-<commit-hash>.md`
