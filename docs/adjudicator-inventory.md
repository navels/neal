# Adjudicator inventory

## Scope

The current contract for neal's adjudicator layer covers the shared
coder/reviewer loop vocabulary, the typed adjudication specs, the read-only
loops that reuse the same contract, and the consultant.

Two things are explicit:

- neal uses the terms `adjudicator` and `adjudication spec`.
- Only recurring coder/reviewer loop mechanics belong to the shared
  adjudicator. Prompt ownership stays under `src/neal/prompts/` (see
  [prompt-specs.md](prompt-specs.md)) and transition semantics stay in the
  orchestrator layers.

The typed contract for writer-run adjudication specs lives in
[src/neal/adjudicator/specs.ts](../src/neal/adjudicator/specs.ts).
The shared loop vocabulary and side-effect contract live in
[src/neal/adjudicator/contracts.ts](../src/neal/adjudicator/contracts.ts) and
are attached to each in-scope writer-run adjudication spec as `loopContract`
metadata. Read-only `neal review` findings use the same contract-only pattern
with artifacts under `.neal/reviews/<review-id>/`.

## Module map

| Module | Owns |
| --- | --- |
| `src/neal/adjudicator/specs.ts` | `AdjudicationSpec` type, `ADJUDICATION_SPECS` registry, transition-signal validation, `getAdjudicationSpec`, `assertAdjudicationTransitionSignal`, `getReviewerCapability`, `ADJUDICATION_ADJACENT_FLOWS` |
| `src/neal/adjudicator/contracts.ts` | `AdjudicatedLoopContract` vocabulary (loop kind, side-effect policy, allowed/terminal outcomes, round-cap and terminal-artifact metadata), import-time contract validation, `resolveReviewedDraftLoopStep`, `REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT` |
| `src/neal/adjudicator/planning.ts` | Planning-family context resolution plus reviewer and plan-response round adjudication for `plan_review` and `derived_plan_review` |
| `src/neal/adjudicator/execute.ts` | Execute-family context resolution, reviewer and coder-response round adjudication, findings synthesis, convergence detection (reopened canonical, stuck window), disposition resolution |
| `src/neal/adjudicator/final-completion.ts` | Final-completion context resolution plus summary and reviewer round adjudication |
| `src/neal/adjudicator/consultant.ts` | Read-only triage of eligible blocked states (see Consultant below) |
| `src/neal/adjudicator/artifacts.ts` | Resolving the active adjudication contract from run state and rendering it into artifacts |

## Ownership split

- Shared loop contract (`contracts.ts`):
  - loop kind, side-effect policy, allowed outcomes, terminal outcomes,
    round-cap semantics, and terminal artifact metadata
  - import-time validation that every in-scope adjudication spec declares the
    shared contract fields, plus validation for the contract-only
    review-findings loop
  - descriptive metadata only. Runtime phase routing and state mutation stay in
    the transition layer
- Adjudication spec (`specs.ts`):
  - coder and reviewer prompt-surface references, validated at import time
    against the prompt-spec registry
  - coder and reviewer schema builder / parser / provider output surfaces
  - artifact and context-assembly contract
  - convergence rule
  - validated allowed transition outcomes declared per spec
- Adjudicator helpers (`planning.ts`, `execute.ts`, `final-completion.ts`):
  - per-family context resolution from run state
  - reviewer/coder round invocation, including supplying the commit-range diff
    to read-only reviewers that lack their own range-diff tool
  - execute-family findings synthesis, reopened-finding and stuck-window
    detection, and disposition resolution
- Transition layer (`src/neal/orchestrator.ts`, `src/neal/orchestrator/run-loop.ts`,
  `src/neal/orchestrator/phases/*.ts`, `src/neal/orchestrator/transitions.ts`,
  `src/neal/orchestrator/completion.ts`):
  - runnable-phase registries, phase routing, and state mutation
  - live re-check that the resolved outcome is allowed for the active
    adjudication spec (`assertAdjudicationTransitionSignal`)
  - coder-timeout and fresh-session retry handling
  - notification emission
  - split-plan handling
  - interactive blocked-recovery routing
  - adoption/finalization semantics
  - `createdCommits` and final-commit consequences
- Prompt-spec layer:
  - prompt identity, builders, and role/task ownership under
    `src/neal/prompts/` (see [prompt-specs.md](prompt-specs.md))

`transitionSignals` in `specs.ts` are validated allowed outcomes, not a
dispatch table. Import-time validation checks each spec against one explicit
family-level runtime contract (`FAMILY_RUNTIME_TRANSITION_SIGNALS`) and a
per-spec required set (`SPEC_RUNTIME_TRANSITION_SIGNALS`), live routing
re-checks the resolved outcome against the active adjudication spec, and the
transition layer still maps those outcomes explicitly in runtime code rather
than dispatching off `transitionSignals` directly.

## Transition signals

| Spec | Family | Validated transition signals |
| --- | --- | --- |
| `plan_review` | `plan_review` | `accept_plan`, `request_revision`, `optional_revision`, `block_for_operator` |
| `derived_plan_review` | `plan_review` | `accept_derived_plan`, `request_revision`, `optional_revision`, `block_for_operator` |
| `execute_review` | `execute_review` | `accept_scope`, `request_revision`, `optional_revision`, `block_for_operator`, `replace_plan`, `advance_parent` |
| `final_completion_review` | `final_completion` | `accept_complete`, `continue_execution`, `block_for_operator` |

The `AdjudicationTransitionSignal` union also declares `leave_adjacent`, which
no in-scope spec or family currently uses.

## Loop contracts

Every in-scope spec declares allowed outcomes
`accepted, revise, blocked, failed, cap_reached` with terminal outcomes
`accepted, blocked, failed, cap_reached`.

| Spec | Loop kind | Side effects | Round cap source | Terminal artifact |
| --- | --- | --- | --- | --- |
| `plan_review` | `plan` | `plan_doc_only` | `state.maxRounds` (review iterations) | `plan_document` at `state.planDoc` |
| `derived_plan_review` | `plan` | `plan_doc_only` | `derivedPlan.counters.maxDerivedPlanReviewRounds` (review iterations) | `derived_plan_document` at `state.derivedPlanPath` |
| `execute_review` | `execute` | `code_changes` | `state.maxRounds` (review iterations) | `implementation_scope` at `state.createdCommits` plus `state.reviewMarkdownPath` |
| `final_completion_review` | `final_completion` | `code_changes` | `state.finalCompletionContinueExecutionMax` (continued execution) | `final_completion_review` at `FINAL_COMPLETION_REVIEW.md` and `state.finalCompletionReviewVerdict` |

## In-scope adjudication specs

### `plan_review`

- Current loop surfaces: `runCoderPlanRound`, `runPlanReviewerRound`, `runCoderPlanResponseRound(reviewMode=plan)`
- Artifact under review: top-level neal-executable plan markdown
- Prompt surfaces:
  - coder primary: `plan_author.primary` via `buildPlanningPrompt`
  - coder response: `plan_author.response` via `buildCoderPlanResponsePrompt`
  - reviewer: `plan_reviewer.primary` via `buildPlanReviewerPrompt`
- Output contracts:
  - coder primary: `buildCoderPlanSchema` / `validateCoderPlanPayload`
  - coder response: `buildCoderPlanResponseSchema` / `validateCoderPlanResponsePayload`
  - reviewer: `buildPlanReviewerSchema` / `PlanReviewerPayload`
  - provider surfaces: coder primary/response use `coder_structured_schema` and reviewer uses `structured_advisor_schema`
- Convergence rule:
  - settle when reviewer returns no open findings and the plan remains structurally valid
  - revise when findings route back to required or optional plan response
  - block when coder returns structured `action=blocked`. Round code still renders compatibility markers for downstream state
- Transition targets: `accept_plan`, `request_revision`, `optional_revision`, `block_for_operator`

### `derived_plan_review`

- Current loop surfaces: `runPlanReviewerRound(mode=derived-plan)`, `runCoderPlanResponseRound(reviewMode=derived-plan)`
- Artifact under review: derived replacement plan for one stale execute scope
- Prompt surfaces:
  - coder response family: `plan_author.response` via `buildCoderPlanResponsePrompt` (`reviewMode=derived-plan`)
  - reviewer: `plan_reviewer.derived_plan` via `buildPlanReviewerPrompt`
- Output contracts:
  - coder response: `buildCoderPlanResponseSchema` / `validateCoderPlanResponsePayload`
  - reviewer: `buildPlanReviewerSchema` / `PlanReviewerPayload`
  - provider surfaces: coder response uses `coder_structured_schema` and reviewer uses `structured_advisor_schema`
- Convergence rule:
  - settle when reviewer returns no open findings and the derived plan is safe to adopt
  - revise through the same planning-family response loop as ordinary plan review
  - block when coder returns structured `action=blocked` or the derived plan remains invalid
- Transition targets: `accept_derived_plan`, `request_revision`, `optional_revision`, `block_for_operator`

### `execute_review`

- Current loop surfaces: `runCoderScopeRound`, `runReviewerRound`, `runCoderResponseRound`
- Artifact under review: execute-mode scope diff plus persisted meaningful-progress history for the active parent objective
- Prompt surfaces:
  - coder primary: `scope_coder.primary` via `buildScopePrompt`
  - coder response: `scope_coder.response` via `buildCoderResponsePrompt`
  - reviewer: `scope_reviewer.primary` via `buildReviewerPrompt`
  - reviewer capability: `scope_reviewer.meaningful_progress` via `buildReviewerPrompt`
- Output contracts:
  - coder primary: `buildCoderScopeSchema` / `validateCoderScopePayload`
  - coder response: `buildCoderResponseSchema` / `validateCoderResponsePayload`
  - reviewer: `buildReviewerSchema` / `ReviewerPayload`
  - provider surfaces: coder primary/response use `coder_structured_schema` and reviewer uses `structured_advisor_schema`
- Convergence rule:
  - settle when the reviewer returns no blocking findings and
    `meaningfulProgressAction === accept`, including top-level scopes already
    satisfied by prior accepted work (an eligible already-satisfied
    `advance_parent` is downgraded to `accept` with an explanatory rationale)
  - `advance_parent` is a distinct empty-derived-scope parent-advancement
    signal: it settles by finalizing the parent objective only when
    deterministic classification finds it eligible. An eligible empty-derived
    classification can also upgrade a findings-free `block_for_operator` to
    `advance_parent`
  - revise when findings reopen `coder_response` or `coder_optional_response`
  - block when reviewer returns `block_for_operator`, `replace_plan`, or an
    unsafe `advance_parent`, or coder returns structured `action=blocked` /
    `action=split_plan`. Round code still renders compatibility markers for
    downstream state
- Transition targets: `accept_scope`, `request_revision`, `optional_revision`, `block_for_operator`, `replace_plan`, `advance_parent`
- Public review note:
  - `neal review` external ranges use the contract-only read-only
    review-findings loop under `.neal/reviews/<review-id>/`, not the execute
    writer-run adjudication family.

### `final_completion_review`

- Current loop surfaces: `runCoderFinalCompletionSummaryRound`, `runReviewerFinalCompletionRound`
- Artifact under review: whole-plan completion packet assembled after the terminal execute scope settles, including aggregate review context for `initialBaseCommit..finalCommit` when neal can read that range
- Prompt surfaces:
  - coder: `completion_coder.final_completion` via `buildFinalCompletionSummaryPrompt`
  - reviewer: `completion_reviewer.final_completion` via `buildFinalCompletionReviewerPrompt`
- Output contracts:
  - coder: `buildFinalCompletionSummarySchema` / `parseFinalCompletionSummaryPayload`
  - reviewer: `buildFinalCompletionReviewerSchema` / `parseFinalCompletionReviewerPayload`
  - provider surfaces: coder and reviewer both use `structured_advisor_schema`
- Convergence rule:
  - settle when reviewer returns one of the three whole-plan decisions
  - no coder-response revision round exists. `continue_execution` hands control
    back to execute transitions rather than mutating the adjudicator loop
- Transition targets: `accept_complete`, `continue_execution`, `block_for_operator`
- Aggregate review context:
  - `buildFinalCompletionPacket()` derives the aggregate range from the run's
    `initialBaseCommit` and resolved final commit, then records commit
    subjects, diff stat, and changed files when available
  - if the aggregate range cannot be read, the packet records an explicit
    unavailable reason. The reviewer prompt treats that as a completion-review
    evidence gap rather than proof of correctness
  - the final completion reviewer shares the adversarial falsification,
    verification-skepticism, regression-preservation, and
    pre-existing-failure acceptance-surface doctrine from
    `src/neal/prompts/review-doctrine.ts`, but keeps the final-completion
    verdict schema instead of the ordinary scope-review findings schema

## Contract-only read-only loops

### `review`

- Current loop surface: `runNealReviewCli` in `src/neal/review-findings/run.ts`
- Artifact under review: findings draft for a selected local commit range
- Prompt surfaces (own prompts, not shared with `scope_reviewer` or
  `review-doctrine.ts`): `buildReviewFindingsDraftPrompt`,
  `buildReviewFindingsReviewPrompt` in `src/neal/review-findings/prompts.ts`
- Output contracts:
  - draft: `ReviewFindingsDraft`
  - review: `ReviewFindingsReview` with verdict `accepted`, `revise`, or `blocked`
- Convergence rule (resolved through `resolveReviewedDraftLoopStep`):
  - settle when reviewer returns `accepted` with final markdown
  - revise when reviewer returns concrete findings
  - block when reviewer returns `blocked`, provider validation fails, or
    protected writer state changes. `cap_reached` when the configured
    review-round cap is reached without acceptance
- Loop contract (`REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT` in `contracts.ts`):
  - loop kind: `review`
  - side-effect policy: `read_only`
  - round cap source: `neal.max_review_rounds`
  - terminal artifact: `.neal/reviews/<review-id>/REVIEW_FINAL.md`
- State ownership:
  - review artifacts live under `.neal/reviews/<review-id>/`
  - review never becomes a writer-run command path. A read-only guard asserts
    that `.neal/current.json`, `.neal/current-queue.json`, and run-local
    `RUN_STATE.json` files are unchanged after the loop

## Consultant

`src/neal/adjudicator/consultant.ts` (`runConsultant`) is a
read-only triage step for blocked writer runs. It decides whether a block is an
autonomously recoverable misunderstanding (resolvable within the existing
scope with no new authorization, external state, or scope expansion) or a
genuine blocker (`authorization`, `external_precondition`, `impossible_task`)
that must escalate to a human. It is not an adjudication spec: it makes no
commits and no file edits, and only returns a `ConsultantVerdict`.

Gates, enforced at the recovery chokepoint
(`src/neal/orchestrator/phases/recovery.ts`). Any failed gate falls through to
generic recovery with no consultant invocation:

- Source-phase eligibility: `CONSULTANT_ELIGIBLE_SOURCE_PHASES` is
  `reviewer_scope`, `reviewer_plan`, `coder_scope`, `coder_response`,
  `coder_optional_response`. Reviewer phases are eligible only for structural
  `review_stuck:` reasons. Any coder block on the coder phases is eligible.
- Per-scope budget: `state.consultantAttemptCount`, bounded by
  `neal.consultant_max_attempts` (default `1`, `0` disables) and
  reset to `0` at scope boundaries. One invocation consumes one unit whether it
  auto-applies a recoverable verdict (both run modes) or, on a non-recoverable
  verdict, finalizes terminally (unattended) or surfaces the verdict as operator
  advice and yields (attended).
- Anti-thrash window: a block that repeats a `state.recentBlocks` record with
  the same scope identity (`scopeNumber` + `derivedScopeIndex`), the same
  `sourcePhase`, the same normalized blocker key, and no new evidence
  short-circuits to a non-recoverable `impossible_task` verdict without
  running an LLM round. The chokepoint is the sole writer of
  `state.recentBlocks`. The consultant module's window helpers are pure.

Verdict schema constraints (`buildConsultantSchema` /
`validateConsultantVerdictPayload` in `src/neal/agents/schemas.ts`):
`recoverable=true` is valid only with `triageCategory=misunderstanding` plus a
non-empty `resolutionDirective`. `recoverable=false` must not pair with
`misunderstanding`. `rationale` must be non-empty. `targetCanonicalIds` is
optional and defaults to `[]`. A malformed verdict is rejected so it can never
drive an autonomous recovery.

Prompt and round: `buildConsultantPrompt` in
`src/neal/agents/prompts.ts` (a single no-read-safe variant that judges
entirely from neal-inlined context) run through `runConsultantRound`
in `src/neal/agents/rounds.ts`.

## Adjacent or non-adjudicator flows

- `interactive_blocked_recovery` (declared in `ADJUDICATION_ADJACENT_FLOWS`):
  - current entrypoint: `runInteractiveBlockedRecoveryPhase`
  - reason: operator input, coder dispositions, and recovery routing mix rather
    than forming a pure coder/reviewer adjudication loop, so this remains
    transition-layer-owned

## Spec family mapping

- Planning family: `plan_review`, `derived_plan_review`
- Execute family: `execute_review` (meaningful-progress remains a capability of
  this family, not a separate adjudication spec)
- Final-completion family: `final_completion_review`
- Contract-only read-only loops: `review`
- Adjacent read-only triage: the consultant (not a spec)

Shared reviewer doctrine does not collapse these families. It is prompt wording
reused across execute-scope review, plan review, and final completion review.
Schemas, allowed transition outcomes, and artifact/context packets remain
family-specific.

New loop variants should extend the adjudication-spec family or remain
explicitly adjacent. They should not reintroduce custom coder/reviewer loop
wiring inside `src/neal/orchestrator.ts`. When adding or changing a spec, keep
`transitionSignals`, the family runtime contract, and the loop contract in
sync. `specs.ts` and `contracts.ts` validate all three at import time, so
drift fails fast in tests and at startup.
