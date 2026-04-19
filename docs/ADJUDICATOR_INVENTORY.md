# Neal Adjudicator Inventory

## Scope

This document started as the Scope 2 inventory for [05_NEAL_ADJUDICATOR_REFACTOR_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/05_NEAL_ADJUDICATOR_REFACTOR_PLAN.md) and now also records the landed state after the refactor scopes.

It makes two things explicit:

- Neal should use the terms `adjudicator` and `adjudication spec`.
- Only the recurring coder/reviewer loop mechanics should move into the shared adjudicator. Prompt ownership and transition semantics stay in their current layers.

The typed contract for this inventory lives in [src/neal/adjudicator/specs.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/adjudicator/specs.ts).

## Precondition Audit

- Informal real-run prerequisite audit: `2026-04-18`
  - scope of the audit: confirm the already-landed meaningful-progress, diagnostic-recovery, final-completion, and prompt-spec flows had all been exercised in real Neal runs before the refactor started
  - evidence posture: this document records the audit checkpoint and the deterministic regression baseline; it is not itself the source log for those runs
- Deterministic regression prerequisite: Scope 1 landed as commit `a437fee3deefad2e7f06a9a43bc1a2729f49775b` (`Add adjudicator refactor regression coverage`).

The original inventory did not add new product behavior. It recorded the adjudicator shape against the already-landed meaningful-progress, diagnostic-recovery, final-completion, and prompt-spec work before the later scopes moved behavior onto that shape.

## Baseline Metrics

- `src/neal/orchestrator.ts`: `3810` lines
- `runOnePass` `phaseHandlers` branches: `17`
- Simplification floors kept for Scope 8:
  - reduce `src/neal/orchestrator.ts` line count by at least 20% from `3810`
  - reduce `phaseHandlers` branch count by at least 3 from `17`
  - make at least 4 prompt/schema bundles share an adjudication-spec family
  - reduce bespoke orchestrator-level coder/reviewer `run*Phase` implementations by at least 4
- Stricter Scope 2 floors adopted: none

## Landed State

- Refactor status:
  - ordinary `--plan` review, derived-plan review, execute review, diagnostic-recovery plan review, and final whole-plan completion review now run through shared adjudication helpers under `src/neal/adjudicator/`
  - shared run-loop mechanics now live in `src/neal/orchestrator/run-loop.ts`
  - final squash and final whole-plan completion transitions now live in `src/neal/orchestrator/completion.ts`
  - prompt builders remain under `src/neal/prompts/`, and consult / interactive blocked recovery remain adjacent rather than forced into the adjudicator family
- Measured simplification outcome after the landed extraction:
  - `src/neal/orchestrator.ts`: `2810` lines
  - `runOnePass` handler entries in `src/neal/orchestrator.ts`: `14`
  - shared phase-loop control moved out of `src/neal/orchestrator.ts` into `src/neal/orchestrator/run-loop.ts`
  - five in-scope adjudication specs now share three explicit adjudication-spec families
  - shared-adjudicator-facing orchestrator-level coder/reviewer adjudication `run*Phase` implementations were reduced from `8` to `4` by collapsing required/optional execute responses and required/optional planning responses into shared helpers
  - the completion/finalization path no longer lives inline in `src/neal/orchestrator.ts`
- Acceptance-criteria readout:
  - the 20% orchestrator line-count floor is met (`2810 <= 3048`)
  - the `runOnePass` handler-count floor is met (`14 <= 14`)
  - the shared-adjudicator-facing orchestrator-level coder/reviewer `run*Phase` reduction floor is met (`4 <= 4` remaining from the baseline `8`)
  - meaningful-progress remains a capability of `execute_review`, not a standalone adjudication spec
  - diagnostic analysis, recovery-plan authoring, consult review, and interactive blocked recovery remain explicitly adjacent
  - prompt-spec ownership stayed under `src/neal/prompts/`

## Ownership Split

- Adjudicator:
  - coder/reviewer round sequencing
  - round counting and reopened-finding / stuck-window mechanics
  - coder-timeout retry
  - round lifecycle logging hooks
- Adjudication spec:
  - coder and reviewer prompt-surface references
  - coder and reviewer schema/parser surfaces
  - artifact/context packet contract
  - convergence rule
  - validated allowed transition outcomes declared per spec
  - import-time contract validation against family-supported runtime behavior
- Transition layer:
  - live routing re-checks that the resolved outcome is allowed for the active adjudication spec
  - notification emission
  - split-plan handling
  - consult and interactive blocked-recovery routing
  - adoption/finalization semantics
  - phase-routing helpers and state mutation in `src/neal/orchestrator.ts`, `src/neal/orchestrator/transitions.ts`, and `src/neal/orchestrator/completion.ts`
  - `createdCommits` and final-commit consequences
- Prompt-spec layer:
  - prompt identity, builders, and role/task ownership under `src/neal/prompts/`

`transitionSignals` in [src/neal/adjudicator/specs.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/adjudicator/specs.ts) are validated allowed outcomes. Import-time adjudication-spec validation checks them against one explicit family-level runtime contract, live routing re-checks the resolved outcome against the active adjudication spec, and the transition layer still maps those outcomes explicitly in runtime code rather than dispatching off `transitionSignals` directly.

## In-Scope Adjudication Specs

### `plan_review`

- Current loop surfaces: `runCoderPlanRound`, `runPlanReviewerRound`, `runCoderPlanResponseRound(reviewMode=plan)`
- Artifact under review: top-level Neal-executable plan markdown
- Prompt surfaces:
  - coder primary: `plan_author.primary` via `buildPlanningPrompt`
  - coder response: `plan_author.response` via `buildCoderPlanResponsePrompt`
  - reviewer: `plan_reviewer.primary` via `buildPlanReviewerPrompt`
- Output contracts:
  - coder primary: terminal marker protocol
  - coder response: `buildCoderPlanResponseSchema` / `parseCoderResponsePayload`
  - reviewer: `buildPlanReviewerSchema` / `PlanReviewerPayload`
- Convergence rule:
  - settle when reviewer returns no open findings and the plan remains structurally valid
  - revise when findings route back to required or optional plan response
  - block when coder returns `AUTONOMY_BLOCKED`
- Transition targets:
  - `accept_plan`
  - `request_revision`
  - `optional_revision`
  - `block_for_operator`

### `derived_plan_review`

- Current loop surfaces: `runPlanReviewerRound(mode=derived-plan)`, `runCoderPlanResponseRound(reviewMode=derived-plan)`
- Artifact under review: derived replacement plan for one stale execute scope
- Prompt surfaces:
  - coder response family: `plan_author.derived_plan` via `buildCoderPlanResponsePrompt`
  - reviewer: `plan_reviewer.derived_plan` via `buildPlanReviewerPrompt`
- Output contracts:
  - coder response: `buildCoderPlanResponseSchema` / `parseCoderResponsePayload`
  - reviewer: `buildPlanReviewerSchema` / `PlanReviewerPayload`
- Convergence rule:
  - settle when reviewer returns no open findings and the derived plan is safe to adopt
  - revise through the same planning-family response loop as ordinary plan review
  - block when coder blocks or the derived plan remains invalid
- Transition targets:
  - `accept_derived_plan`
  - `request_revision`
  - `optional_revision`
  - `block_for_operator`

### `execute_review`

- Current loop surfaces: `runCoderScopeRound`, `runReviewerRound`, `runCoderResponseRound`
- Artifact under review: execute-mode scope diff plus persisted history for the active parent objective
- Prompt surfaces:
  - coder primary: `scope_coder.primary` via `buildScopePrompt`
  - coder response: `scope_coder.response` via `buildCoderResponsePrompt`
  - reviewer: `scope_reviewer.primary` via `buildReviewerPrompt`
  - reviewer capability: `scope_reviewer.meaningful_progress` via `buildReviewerPrompt`
- Output contracts:
  - coder primary: terminal marker protocol plus `parseExecuteScopeProgressPayload`
  - coder response: `buildCoderResponseSchema` / `parseCoderResponsePayload`
  - reviewer: `buildReviewerSchema` / `ReviewerPayload`
- Convergence rule:
  - settle only when the reviewer returns no blocking findings and `meaningfulProgressAction === accept`
  - revise when findings reopen `coder_response` or `coder_optional_response`
  - block when reviewer returns `block_for_operator` or `replace_plan`, or coder blocks/splits the scope
- Transition targets:
  - `accept_scope`
  - `request_revision`
  - `optional_revision`
  - `block_for_operator`
  - `replace_plan`

### `recovery_plan_review`

- Current loop surfaces: `runPlanReviewerRound(mode=recovery-plan)`, `runCoderPlanResponseRound(reviewMode=recovery-plan)`
- Artifact under review: `RECOVERY_PLAN.md` candidate tied to the active execute run
- Prompt surfaces:
  - coder response family: `recovery_plan_author.response` via `buildCoderPlanResponsePrompt`
  - reviewer: `recovery_plan_reviewer.recovery_plan` via `buildPlanReviewerPrompt`
- Output contracts:
  - coder response: `buildCoderPlanResponseSchema` / `parseCoderResponsePayload`
  - reviewer: `buildPlanReviewerSchema` / `PlanReviewerPayload`
- Convergence rule:
  - settle when reviewer returns no open findings and the artifact is safe for operator adoption
  - revise through the same planning-family response loop as other plan review flows
  - block when coder blocks or the recovery plan remains adoption-unsafe
- Transition targets:
  - `adopt_recovery_plan`
  - `request_revision`
  - `optional_revision`
  - `block_for_operator`

### `final_completion_review`

- Current loop surfaces: `runCoderFinalCompletionSummaryRound`, `runReviewerFinalCompletionRound`
- Artifact under review: whole-plan completion packet assembled after the terminal execute scope settles
- Prompt surfaces:
  - coder: `completion_coder.final_completion` via `buildFinalCompletionSummaryPrompt`
  - reviewer: `completion_reviewer.final_completion` via `buildFinalCompletionReviewerPrompt`
- Output contracts:
  - coder: `buildFinalCompletionSummarySchema` / `parseFinalCompletionSummaryPayload`
  - reviewer: `buildFinalCompletionReviewerSchema` / `parseFinalCompletionReviewerPayload`
- Convergence rule:
  - settle when reviewer returns one of the three whole-plan decisions
  - no coder-response revision round exists in v1
  - `continue_execution` hands control back to execute transitions rather than mutating the adjudicator loop
- Transition targets:
  - `accept_complete`
  - `continue_execution`
  - `block_for_operator`

## Adjacent Or Non-Adjudicator Flows

### Adjacent in v1

- `consult_review`
  - reason: consult is an auxiliary scope-assistance loop, not yet a first-class adjudication family
- `interactive_blocked_recovery`
  - reason: operator input and recovery routing are core semantics, so this remains transition-layer-owned for v1

### Single-Coder Adjacent in v1

- `diagnostic_analysis`
  - reason: single-coder authoring round with no reviewer-side revision loop
- `recovery_plan_authoring`
  - reason: single-coder artifact-generation step that feeds review but is not itself an adjudication loop

## Spec Family Mapping

- Planning family:
  - `plan_review`
  - `derived_plan_review`
  - `recovery_plan_review`
- Execute family:
  - `execute_review`
  - meaningful-progress remains a capability of this family, not a separate adjudication spec
- Final-completion family:
  - `final_completion_review`

This is both the inventory contract the intermediate scopes consumed and the landed architecture boundary the completed refactor leaves behind. New loop variants should extend the adjudication-spec family or remain explicitly adjacent; they should not reintroduce bespoke coder/reviewer loop wiring inside `src/neal/orchestrator.ts`.
