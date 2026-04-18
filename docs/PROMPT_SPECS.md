# Neal Prompt Specs Inventory

## Scope

This document records the Scope 1 prompt-spec inventory for Neal's recurring engineering roles/tasks.

It is intentionally behavior-preserving:

- migrated planning, execute, and specialized prompt builders now live under `src/neal/prompts/*.ts`
- adjacent consult and interactive-blocked-recovery prompt builders still live in `src/neal/agents/prompts.ts`
- current schema builders and payload parsers still live in `src/neal/agents/schemas.ts`
- current round sequencing still lives in `src/neal/agents/rounds.ts`

The new prompt-spec contract is defined in [src/neal/prompts/specs.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/prompts/specs.ts).

## Ownership Boundary

Prompt specs should live under `src/neal/prompts/`.

That boundary is deliberate because [plans/05_NEAL_ADJUDICATOR_REFACTOR_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/05_NEAL_ADJUDICATOR_REFACTOR_PLAN.md) makes the later adjudicator responsible for loop mechanics, not prompt ownership. Keeping prompt specs in `src/neal/prompts/` avoids baking them back into `src/neal/agents/rounds.ts`, and also avoids prematurely putting prompt semantics inside the future adjudicator package.

Concrete split:

- prompt-spec library owns role/task prompt identity, required context, schema linkage, and provider-variant metadata
- adjudicator / round runner owns coder-reviewer sequencing, retries, convergence, and transition hooks
- transitions own finalization, adoption, blocked-recovery routing, and commit semantics

This means Scope 1 picks a prompt home without preempting the adjudicator shape from plan 05.

## Referenced Plan Context

The prompt-spec plan references plans 01 through 03 as prerequisites. In the current repository they are present under `plans/archived/` rather than `plans/`.

- [plans/archived/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/archived/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md)
- [plans/archived/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/archived/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md)
- [plans/archived/03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/archived/03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md)
- [plans/05_NEAL_ADJUDICATOR_REFACTOR_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/05_NEAL_ADJUDICATOR_REFACTOR_PLAN.md)

That matters because meaningful-progress, diagnostic recovery, and final completion already define real prompt surfaces Neal must preserve.

## Inventory

### Migration Targets

| Prompt spec id | Current builder(s) | Current round entrypoints | Schema target | Notes |
| --- | --- | --- | --- | --- |
| `plan_author` | `buildPlanningPrompt`, `buildCoderPlanResponsePrompt` (`reviewMode=plan`, `reviewMode=derived-plan`) | `runCoderPlanRound`, `runCoderPlanResponseRound` | terminal marker for initial round; structured JSON for response rounds | First migration target. Derived-plan authoring stays a variant, not a separate top-level spec. |
| `plan_reviewer` | `buildPlanReviewerPrompt` (`mode=plan`, `mode=derived-plan`) | `runPlanReviewerRound` | `buildPlanReviewerSchema` / `PlanReviewerPayload` | First migration target. Execution-shape confirmation is part of the contract. |
| `scope_coder` | `buildScopePrompt`, `buildCoderResponsePrompt` | `runCoderScopeRound`, `runCoderResponseRound` | terminal marker plus progress payload for initial round; structured JSON for response rounds | Execute-mode consult and blocked-recovery prompts stay adjacent variants in v1. |
| `scope_reviewer` | `buildReviewerPrompt` | `runReviewerRound` | `buildReviewerSchema` / `ReviewerPayload` | Meaningful-progress remains a capability variant of `scope_reviewer`, not a new top-level id. |
| `diagnostic_analyst` | `buildDiagnosticAnalysisPrompt` | `runDiagnosticAnalysisRound` | markdown artifact body plus terminal marker | Not part of the later adjudicator loop. |
| `recovery_plan_author` | `buildRecoveryPlanPrompt`, `buildCoderPlanResponsePrompt` (`reviewMode=recovery-plan`) | `runRecoveryPlanRound`, `runCoderPlanResponseRound` | markdown artifact body for initial round; structured JSON for response rounds | Recovery-plan authoring stays separate from adoption semantics. |
| `recovery_plan_reviewer` | `buildPlanReviewerPrompt` (`mode=recovery-plan`) | `runPlanReviewerRound` | `buildPlanReviewerSchema` / `PlanReviewerPayload` | Recovery-plan review is anchored to the active run and parent objective. |
| `completion_coder` | `buildFinalCompletionSummaryPrompt` | `runCoderFinalCompletionSummaryRound` | `buildFinalCompletionSummarySchema` / `parseFinalCompletionSummaryPayload` | Structured advisor round, but still a coder-owned role/task. |
| `completion_reviewer` | `buildFinalCompletionReviewerPrompt` | `runReviewerFinalCompletionRound` | `buildFinalCompletionReviewerSchema` / `parseFinalCompletionReviewerPayload` | Whole-plan completion review remains distinct from ordinary scope review. |

### Adjacent Current Prompt Surfaces

These prompts are real but should not become separate top-level prompt-spec ids in the first version:

| Current builder | Suggested home | Why not a new top-level id yet |
| --- | --- | --- |
| `buildCoderConsultResponsePrompt` | `scope_coder` variant | It is a continuation inside the same execute scope, not a distinct recurring product role. |
| `buildBlockedRecoveryCoderPrompt` | `scope_coder` variant | It is still the same execute-scope owner responding inside blocked recovery. |
| `buildConsultReviewerPrompt` | adjacent reviewer surface outside the first curated set | The current prompt-spec plan does not list consult as part of the initial role/task set. It can be added later if Neal decides consultation is a stable first-class surface. |

## First Migration Order

Scope 2 should migrate the planning side first:

1. `plan_author`
2. `plan_reviewer`

That is the lowest-risk proof because:

- plan prompts already have stable schema linkage
- the scope avoids execute-mode convergence semantics
- the resulting prompt-spec home is reusable by recovery-plan review and later completion review

Scope 4 can then reuse the same contract style for:

- `scope_coder`
- `scope_reviewer` with the meaningful-progress capability

## Contract Expectations

Each prompt spec in `src/neal/prompts/specs.ts` makes these fields explicit:

- `id`
- `role`
- `purpose`
- `requiredContext`
- `schemaTarget`
- `baseInstructions`
- `providerVariants`
- `evaluationNotes`
- `variants`

Three implementation details are intentionally concrete:

1. `baseInstructions` names the current prompt-builder function and its explicit input shape.
2. `requiredContext` lists the exact context keys the prompt assumes, including artifact and repository inputs that are not always passed as one raw function argument today.
3. `schemaTarget` names the concrete schema builder and parser surface, or the terminal-marker/artifact protocol when the prompt is not JSON-schema-driven.

That keeps prompt specs reviewable as contracts rather than as scattered string literals.

## Prompt-Spec Wiring

Prompt specs are not the whole execution loop. They are the prompt-facing contract layer that tells Neal which role/task is being performed, what context that role/task assumes, and which output contract the result must satisfy.

Today that wiring is intentionally split across a few modules:

- `src/neal/prompts/specs.ts` owns prompt-spec identity, required-context contracts, schema linkage metadata, provider-variant policy, and migration-local ownership notes.
- `src/neal/prompts/*.ts` owns the concrete prompt builders that render instructions for planning, execute-mode, and specialized flows.
- `src/neal/agents/schemas.ts` owns the actual schema builders and payload parsers named by each spec's `schemaTarget`.
- `src/neal/agents/rounds.ts` owns round execution and parsing against those schemas.
- `src/neal/orchestrator.ts` and `src/neal/orchestrator/*.ts` own phase transitions, adoption/finalization semantics, blocked-recovery routing, and commit consequences.

That split is deliberate. A prompt spec is incomplete without explicit schema linkage, but it also must not absorb sequencing or state-transition semantics that belong to the orchestrator.

### Context Assembly Rules

`requiredContext` should be read as a contract for context assembly, not just documentation for a prompt author.

When adding or changing a prompt spec:

1. Every required field in `requiredContext` should have one clear source such as a prompt argument, persisted run artifact, review history packet, repository-state query, orchestrator-state field, or operator input.
2. The corresponding prompt builder in `src/neal/prompts/*.ts` should either accept that data directly or assemble it from a narrowly-scoped helper. Do not hide major context dependencies inside unrelated utilities.
3. If a prompt needs new state, artifact, or repository-derived context, add that dependency at the owning layer first and then link it from the spec. Do not document impossible context.
4. If a field is only used in a variant, keep that distinction explicit in the variant contract instead of pretending it is universally required.
5. Variant `inputShape` keys must stay a subset of the spec's top-level `requiredContext` keys. Neal now validates that contract at module load so prompt-spec drift fails fast in tests and startup.

The goal is for reviewers to be able to answer two questions quickly:

- "What does this prompt assume is available?"
- "Where does Neal actually get that data?"

### Schema-Linkage Rules

`schemaTarget` exists so prompt changes remain coupled to the concrete parser surface they must satisfy.

Use these rules:

- `structured_json` means the prompt must remain aligned with a named schema builder and parser in `src/neal/agents/schemas.ts`.
- `terminal_marker` means the prompt is governed by a final-line protocol, and any structured block embedded above that marker still needs an explicit parser called out elsewhere in the spec or variant notes.
- `artifact_markdown` means Neal expects a durable markdown artifact plus the terminal marker protocol, not freeform conversational output.

If a prompt change would force parser behavior to change, treat that as a contract change and review the prompt spec, prompt builder, schema builder, and tests together.

## Provider Variants

Provider-specific variants are allowed, but they are not the default escape hatch.

Use a provider-specific override only when at least one of these is true:

- deterministic fixture coverage shows shared wording is ambiguous or misleading for one provider
- the provider API exposes a materially different structured-output surface that the prompt must acknowledge
- the same shared wording repeatedly causes provider-specific failure modes that cannot be handled in adapter code alone

Do not add provider-specific variants merely because:

- one provider is stylistically different
- a wording preference is subjective
- a single anecdotal run felt better with custom phrasing

Before introducing divergence, prefer this order:

1. tighten the shared prompt wording
2. tighten schema or parser validation
3. localize provider-surface differences in the provider adapters
4. add a prompt-spec provider variant only if the role/task instructions genuinely need to differ

When a provider-specific variant is added, record why the shared wording was insufficient and which fixture or failure evidence justified the fork.

## Adjudicator Alignment

Plan 05's adjudicator direction depends on prompt specs staying role-local and transition-agnostic.

The intended relationship is:

- prompt specs define the coder/reviewer role/task contracts that an adjudication spec can later reference
- adjudication specs define which coder prompt, reviewer prompt, schemas, artifact/context packet, and convergence rule belong to a loop
- the adjudicator owns loop mechanics such as round sequencing, retry behavior, and settled-vs-revise iteration
- execute and plan transitions still own operational meaning such as adoption, blocked recovery, replacement, and finalization

That means prompt specs should stay separate from:

- phase transitions
- success/block routing
- commit/finalization semantics
- operator-adoption policy

Three current role/task boundaries matter especially:

- `scope_reviewer` keeps meaningful-progress as a capability variant, not a separate top-level prompt id in v1
- `diagnostic_analyst` remains outside the later shared adjudicator loop
- `completion_reviewer` is plan-review-adjacent in the future adjudicator design, but its execute-mode completion transitions remain outside prompt ownership

This keeps prompt-spec ownership stable now without forcing the adjudicator refactor to unwind prompt-specific state semantics later.

## Adding Or Extending Prompt Specs

Future Neal features should add prompt specs in a disciplined order.

1. Confirm the feature is a recurring role/task surface rather than a one-off continuation inside an existing role. If it is only a bounded continuation, prefer a variant on an existing spec.
2. Add or update the prompt spec in `src/neal/prompts/specs.ts` with explicit `requiredContext`, `schemaTarget`, `baseInstructions`, and ownership notes.
3. Implement or update the concrete prompt builder in the relevant `src/neal/prompts/*.ts` module.
4. Keep schema linkage explicit by adding or updating the corresponding schema builder / parser surface in `src/neal/agents/schemas.ts` when structured output is required.
5. Add or update deterministic fixtures and prompt-render assertions under `test/fixtures/prompts/` and the prompt-spec regression tests.
6. Only after the prompt contract is stable should later adjudicator work decide whether the new surface deserves its own adjudication spec or reuses an existing loop family.

Use a new top-level `PromptSpecId` only when the role/task is genuinely distinct in at least one of these ways:

- it has its own durable artifact or output contract
- it has a materially different required-context packet
- it is expected to recur as an independently understandable Neal surface

Otherwise prefer a variant such as `response`, `derived_plan`, `recovery_plan`, `meaningful_progress`, or `final_completion`.

## Testing Direction

The prompt-spec plan calls for deterministic prompt regression coverage. The current contract implies three fixture layers:

- prompt-render assertions for required sections and invariants
- inventory assertions that every migrated role/task still points at explicit builders and schema targets
- fixture inputs for known ambiguity cases such as execution-shape declaration and meaningful-progress review

Those layers now exist in mixed depth:

- planning prompts have dedicated JSON fixtures under `test/fixtures/prompts/planning/`
- execute and completion prompts have deterministic fixture coverage under `test/fixtures/prompts/execute/` and `test/fixtures/prompts/specialized/`
- inventory assertions in `test/review.test.ts` pin module ownership, schema targets, and current-home metadata

The remaining deliberate gap is adjacent consult / blocked-recovery prompt surfaces, which still live outside the first curated prompt-spec set.
