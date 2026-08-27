# State machine

The product-level storage layout, artifact classifications, run pointers,
retention guidance, and no-global-index decision are documented in
[storage.md](storage.md). What follows covers the persisted ledgers and the
state invariants neal enforces when reading and writing them.

neal keeps two persisted ledgers:

- `OrchestrationState` is the child-run ledger. It lives in each run directory as `RUN_STATE.json` and records one plan or execute writer run.
- `PlanAndExecuteQueueState` is the parent queue ledger. It lives under `.neal/queues/<queue-id>/QUEUE_STATE.json` and tracks serial `neal run` children, their active stage, child run ids, and queue-level stop status.

These ledgers are related but separate. A queue item points at child run state paths. Child runs do not own the queue's status, item ordering, or current queue pointer.

## Hydration and validation

`src/neal/state.ts` owns v1 child-run hydration. It reads JSON, checks the basic shape, requires the current v1 fields neal writes, and rejects unknown enum-like strings while hydrating phase references. Missing or malformed required child-run fields fail load instead of receiving invented defaults.

`src/neal/state-invariants.ts` owns semantic validation after hydration and before save. `assertValidOrchestrationState` is pure: it has no filesystem, git, provider, logger, or clock dependency. The same invariant layer runs when `loadState` returns hydrated state and when `saveState` builds the timestamped next state.

Queue state has its own parser and invariants in `src/neal/plan-queue.ts`, centered on `parsePlanAndExecuteQueueState` and related queue item parsing helpers.

## Schema versions

Persisted JSON that neal reads as durable schema is versioned at v1.
`RUN_STATE.json` hydrates through `normalizeStateV1`. `.neal/current.json`,
queue state, `.neal/current-queue.json`, queue child links, run narratives,
squash audit results, and the active writer lock all have v1 write shapes or
parsers.

Run `meta.json` is support data, not child-run state. Optional context artifacts
such as `plan-progress.json` are written as v1 and read defensively so malformed
or unsupported support data does not replace the canonical run ledger.

## State views and public lifecycle

Persisted v1 child-run state remains record-shaped, but most callers should not
treat `OrchestrationState` as one large nullable programming model.
`src/neal/state-views.ts` exposes typed views over the current v1 fields without
changing the stored JSON shape:

- shared metadata and public lifecycle views
- plan and execute run views
- interactive blocked-recovery views
- derived-plan and final-completion views

The public lifecycle view treats `status` as the product-facing lifecycle owner
and treats `phase` as an internal runnable cursor or diagnostic detail.
`src/neal/run-status.ts` and status rendering build on that lifecycle view so
human output can say `waiting_for_guidance`, `paused`, `blocked`, `failed`, or
`done` without requiring users to interpret raw phase names.

`neal status --json` remains the stable automation surface. It still exposes raw
`phase` and `status` fields for diagnostics, and it preserves derived public
fields such as `effectiveStatus`, `waitingForOperatorGuidance`, and
`pendingOperatorGuidance`.

## Phase and status

Known child-run phases and statuses are centralized in `state-invariants.ts` through `ORCHESTRATION_PHASES`, `ORCHESTRATION_STATUSES`, and their runtime guard helpers. Runnable dispatch is authored in `src/neal/orchestrator/run-loop.ts` as purpose-specific registries for plan, execute, interactive recovery, and execute finalization phases. Those registries are composed into `RUNNABLE_PHASE_REGISTRY` for dispatch and exposed through top-level-mode helpers so tests can assert which phases are runnable for plan and execute runs.

The enforced phase/status relationship is intentionally small:

- `phase === 'done'` if and only if `status === 'done'`.
- `phase === 'blocked'` may use `status === 'blocked'` or `status === 'failed'`.
- `status === 'running'` is invalid with terminal `done` or `blocked` phases.
- Failed states may preserve the phase that failed, because provider, reviewer, coder, or artifact errors are useful to resume and diagnostic tooling only when the failing phase remains visible.

Read-only `neal review` is not a writer-run mode. It writes isolated findings artifacts under `.neal/reviews/<review-id>/` and does not create `OrchestrationState`.

## Recovery state

Interactive blocked recovery is owned by `interactiveBlockedRecovery` while the active phase is `interactive_blocked_recovery`. The invariant layer validates execute-mode ownership, supported source phases, bounded turn counters, contiguous turn numbers, and disposition result phases.

Every block class (coder-blocked signals, reviewer `review_stuck` deadlocks, and
the split-plan invalid-payload block) funnels through the single
`enterInteractiveBlockedRecovery` chokepoint, where the consultant triages it (see
Site A below). The consultant is read-only: it never grants authorization, expands
scope, or waives verification gates. A recoverable verdict acts automatically. A
non-recoverable verdict yields to the operator, carrying the verdict as advice.

Each recovery turn records its `origin` — `operator` for a `neal resume --message`
directive, `consultant` for a consultant injection — and the same marker rides the
turn-cap `pendingDirective`. A later-scope revision is offered only on an
operator-origin turn, so a consultant directive can direct the current scope but
never rewrites a later scope on its own.

Public resume eligibility is classified by `src/neal/resume-decision.ts` before
any recovery mutation. That read-only decision layer combines loaded child-run
state with lock, queue, and retrospective evidence, then returns the shared
vocabulary used by `neal resume`, `neal status`, and run narratives: continue,
needs message, pending message, already running, done, or cannot resume.

Blocked resume eligibility still depends on the planner actions from
`src/neal/resume-planner.ts`, with the orchestrator recovery code applying the
selected actions only after the selected run has been classified as executable.
`state-invariants.ts` mirrors the allowed phase sets so changes to recovery
behavior are visible in focused tests.

## Operator-block sites

Every operator stop lands in a controlled, operator-actionable state, and the
writer exits with code `2` (`src/neal/commands/writer-exit-codes.ts`). Exit `2`
means the run needs operator intervention, not that every stop accepts resume
guidance: sites A and C below take `neal resume --message`, while site B stays
non-mechanically blocked (`neal resume` keeps it blocked) and the operator
inspects `neal status` and the run artifacts instead. A consumer that needs a
hard verdict with no operator available (a benchmark harness, `neal compat`)
treats an exit-2 operator stop as a failure itself.

Block handling never weakens verification, authorization, or squash/grading,
and never removes `block_for_operator` from any decision surface. Every block
branch gates on structural state (`actionResolution.effectiveAction`, `phase`,
`blockedFromPhase`, the derived state views), never on substring-matching
assistant or guidance text.

There are three structural block sites:

- **Site A: execute-mode interactive recovery.** All fresh execute-mode blocks
  funnel through `enterInteractiveBlockedRecovery`
  (`src/neal/orchestrator/phases/recovery.ts`), where the block first gets
  bounded read-only consultant triage (below). A recoverable verdict with a
  concrete directive auto-applies and the run continues. Everything else — a
  non-recoverable verdict, or a consultant gated off by eligibility, budget, or
  error — yields as the operator wait: `status: 'running'` +
  `phase: 'interactive_blocked_recovery'`, carrying any verdict as
  `interactiveBlockedRecovery.consultantAdvice`. The wait notification
  (`notifyBlocked`) fires only when the run is structurally waiting for the
  operator (`shouldNotifyInteractiveBlockedRecoveryEntry` gates on the derived
  waiting-for-guidance view), and the run resumes via `neal resume --message`.
- **The consultant (bounded).** Inside `enterInteractiveBlockedRecovery`,
  eligible blocks are triaged by the read-only consultant
  (`runConsultant`, in `src/neal/adjudicator/consultant.ts`,
  running through the same no-write reviewer plumbing the review/final-completion
  reviewers use, making zero commits and zero file edits). Eligible source phases
  (`CONSULTANT_ELIGIBLE_SOURCE_PHASES`) are the coder-block phases (`coder_scope`
  / `coder_response` / `coder_optional_response`, which also carry the split-plan
  invalid-payload block) and the reviewer `review_stuck` phases (`reviewer_scope` /
  `reviewer_plan`). The consultant first applies an anti-thrash guard
  (`recentBlocks`, keyed on scope identity + source phase + normalized blocker key +
  evidence fingerprint): a same-scope repeat with no new evidence short-circuits to
  `recoverable:false` without an LLM round. Otherwise it returns a verdict
  `{ recoverable, triageCategory, resolutionDirective, rationale }`. A `recoverable`
  `misunderstanding` verdict with a concrete in-scope directive enters recovery with
  that directive injected as the pending turn (consumed exactly like a human
  `neal resume --message`). A `recoverable:false` genuine blocker
  (`authorization` / `external_precondition` / `impossible_task`) persists the
  verdict as `interactiveBlockedRecovery.consultantAdvice` and yields for
  the operator. It is bounded by the counter
  `consultantAttemptCount` against the `consultant_max_attempts` knob
  (default `1`, `0` disables). It's a separate budget that never touches
  `interactiveBlockedRecovery.maxTurns`. Every other
  case (ineligible source phase, disabled/exhausted cap, turn cap, or any
  consultant error) falls through to the operator wait
  unchanged, writing neither `recentBlocks` nor `consultantAdvice`.
  The decisions are auditable from the structured event log via the
  `consultant.{start,verdict,resolved}` events, which
  carry `scopeNumber`, `sourcePhase`, `blockedReason`, and (on `verdict`/`resolved`)
  `recoverable`, `triageCategory`, `targetCanonicalIds`, and the post-increment
  `consultantAttemptCount`.
- **Sites B and C: final-completion review and the top-level plan-review gate.**
  These gates block directly with `status: 'blocked'` and the wait
  notification, bypassing the recovery chokepoint with no consultant routing;
  their own budgets (the final-completion continue-execution cap and the
  review-round/convergence cap) already bound the autonomous effort. Their
  resume semantics differ: site B's `blockedFromPhase`
  (`final_completion_review`) is not in `RESUMABLE_BLOCKED_PHASES`, so
  `neal resume` reports it as keep-blocked, while site C's top-level
  plan-review block is recognized by the plan-review guidance path and resumes
  via `neal resume --message`. Site C is the `topLevelMode !== 'execute'`
  branch of `finalizeBlockedPlanReviewResponse`. Execute-mode
  derived-plan-review blocks (`topLevelMode === 'execute'`) re-enter site A and
  are handled there.

## Resume planning

New-run initialization and existing-run resume reconciliation are separate.
`loadOrInitialize` still provides the command-facing entrypoint, but resume
reconciliation is modeled as explicit `ResumeAction` values from
`planResumeActions` and applied by `applyResumeActions`.

Current resume actions cover stopped-status normalization, restoring a resumable
blocked source phase, keeping non-resumable blocked runs blocked, promoting
accepted or pending unexecuted derived plans, blocking rejected abandoned derived
plans, flushing derived-plan notifications, recovering clean committed
scope work that is waiting for review, waiting for operator guidance, processing
pending operator guidance, and no-op completion for done runs.

`neal resume` is the safe first recovery command for mechanical interruptions.
The command gathers read-only context, asks the shared decision layer what should
happen, and calls `loadRunForResume()` only for decisions that should execute
the selected run. `loadRunForResume()` remains the mutation boundary for resume
normalization, event logging, pointer writes, and execution artifacts.

`neal resume --run <run-id> --message "..."` is the operator-input path only
when the shared decision says interactive recovery is waiting for guidance.
Pending guidance resumes with plain `neal resume --run <run-id>`. Queue
continuation still belongs to `continuePlanAndExecuteQueueFromChildRun` after
the resumed child run finishes. Selecting a child run for resume does not
advance or repair the parent queue by itself.

## Derived plans

Derived-plan fields are child-run state because they describe replacement execution for the active child run, not the parent queue. The invariant layer enforces these ownership rules:

- A non-null `derivedPlanStatus` requires a non-null `derivedPlanPath`.
- A `derivedScopeIndex` requires execute mode, an accepted derived plan, a parent scope number, and a plan path.
- `awaiting_derived_plan_execution` requires an accepted derived plan that has not started executing yet and no active created commits.
- Pending or rejected derived plans cannot have a `derivedScopeIndex`.

Derived-plan execution should continue to flow through the existing orchestrator transition helpers before any future shape refactor changes the persisted fields.

## Final completion

Final-completion review is execute-mode only. The `final_completion_review` phase requires a `finalCompletionSummary`. When a reviewer verdict exists, `finalCompletionResolvedAction` must match the effective action, including the continue-execution cap case where neal resolves to operator blocking instead of starting another scope.

When final completion review asks to continue execution, the orchestrator may clear summary and verdict fields and reopen `coder_scope`. That reopened running state is valid.

Accepted execute scopes also pass through execute finalization before neal either opens the next scope or starts final-completion review. The persisted internal runnable cursor for that step is `execute_finalization`, which is separate from the public `neal squash` command. Public `neal squash` is a post-run command with selection, preview, and interactive TTY confirmation before it rewrites history.

## Atomic writes and locks

`src/neal/atomic-write.ts` provides per-file atomic replacement helpers. State, current run pointers, queue state, queue pointers, queue links, queue summaries, run metadata, progress artifacts, review/final-completion/recovery/split-plan/retrospective artifacts, run narratives, and default squash audit writes use temp-file-plus-rename writes where in scope.

This is not a multi-file transaction. If a process stops between writes, each individual JSON or text file should be either the previous complete file or the next complete file, but related files can briefly disagree. Resume and status commands must continue to tolerate that by resolving run paths and validating loaded state.

The active-run lock is separate. `src/neal/run-lock.ts` uses exclusive creation for `.neal/active-run.lock`. That acquisition path should not be converted to atomic rename because the exclusive-create behavior is the mutual exclusion mechanism.

## Change checklist

When adding a child-run phase:

- Add the phase to `OrchestrationPhase` in `src/neal/types.ts`.
- Add it to `ORCHESTRATION_PHASES` in `src/neal/state-invariants.ts`.
- If it is runnable, add it to `RUNNABLE_PHASE_REGISTRY` in `src/neal/orchestrator/run-loop.ts`.
- Update any recovery or blocked-resume phase sets that should include or exclude it.
- Add tests in `test/state-invariants.test.ts` or `test/run-loop.test.ts` for the new membership and dispatch contract.

When adding a child-run persisted field:

- Add the type in `OrchestrationState`.
- Initialize it in `createInitialState`.
- Parse it in `normalizeStateV1`.
- Validate semantic combinations in `assertValidOrchestrationState` when the field can make state invalid.
- Extend state round-trip or invariant tests.

When adding a queue-state field:

- Add the type in `PlanAndExecuteQueueState` or `PlanAndExecuteQueueItem`.
- Initialize it in queue creation or child transition helpers.
- Parse and validate it in `parsePlanAndExecuteQueueState` or `parsePlanAndExecuteQueueItem`.
- Include it in queue summary or current queue pointer output only when it is operator-facing or needed for resume.

## Future refactor path

Do not jump directly from the current record-shaped `OrchestrationState` to a
persisted discriminated union. The lower-risk path now in place is to keep v1
hydration isolated, keep semantic checks centralized in `state-invariants.ts`,
and route new logic through typed state views and the resume planner.

After those views have stabilized in real runs and tests, a v2 envelope or
discriminated internal TypeScript model can be considered separately. Any future
shape should preserve `neal status --json` as the automation contract and keep
v1 run-local ledgers readable unless an explicit migration command exists.
