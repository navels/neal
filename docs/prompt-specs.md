# Prompt specs inventory

## Scope

The current prompt-spec inventory for neal's recurring engineering
roles/tasks.

- The prompt-spec contract and registry live in
  [src/neal/prompts/specs.ts](../src/neal/prompts/specs.ts).
- Concrete prompt builders live in `src/neal/prompts/planning.ts`,
  `src/neal/prompts/execute.ts`, and `src/neal/prompts/specialized.ts`, with
  shared plan-contract and marker lines in `src/neal/prompts/shared.ts`.
- The interactive blocked-recovery and consultant prompt builders live
  in `src/neal/agents/prompts.ts` (which otherwise re-exports the
  `src/neal/prompts/` builders).
- Schema builders, object validators, and retained compatibility parsers live
  in `src/neal/agents/schemas.ts`.
- Round sequencing lives in `src/neal/agents/rounds.ts`.

Reviewer prompt surfaces share a doctrine helper in
[src/neal/prompts/review-doctrine.ts](../src/neal/prompts/review-doctrine.ts).
That helper owns adversarial posture, falsification, verification skepticism,
regression-preservation, the pre-existing-failure acceptance-surface contract,
finding-quality wording, and the two-way reviewer access mode
(`tool-access` / `read-only`). It does not own schemas, provider
selection, adjudication, or transition behavior. Its consumers are
execute-scope review, plan review, and final completion review. The read-only
`neal review` findings loop uses its own prompts in
`src/neal/review-findings/prompts.ts`.

## Ownership boundary

Prompt specs live under `src/neal/prompts/`.

That boundary is deliberate: the adjudicator owns loop mechanics, not prompt
ownership. Keeping prompt specs in `src/neal/prompts/` avoids baking them back
into `src/neal/agents/rounds.ts` and avoids putting prompt semantics inside the
adjudicator package.

Concrete split:

- prompt-spec library owns role/task prompt identity, required context, schema linkage, and provider-variant metadata
- adjudicator / round runner owns coder-reviewer sequencing, retries, convergence, and transition hooks
- transitions own finalization, adoption, blocked-recovery routing, and commit semantics

## Inventory

### Registered prompt specs

All schema targets are `structured_json` with provider surface
`neal_json_block_protocol`, the prompt-spec metadata name for the runtime
`neal-json-block-v1` JSON-block transport that providers validate locally.

| Prompt spec id | Current builder(s) | Current round entrypoints | Schema target | Notes |
| --- | --- | --- | --- | --- |
| `plan_author` | `buildPlanningPrompt`, `buildCoderPlanResponsePrompt` (`reviewMode=plan`, `reviewMode=derived-plan`) | `runCoderPlanRound`, `runCoderPlanResponseRound` | Primary planning: `buildCoderPlanSchema` / `validateCoderPlanPayload`. Response rounds: `buildCoderPlanResponseSchema` / `validateCoderPlanResponsePayload`. | Primary planning routes new/resumed structured sessions by persisted `plannerSessionProtocol`. Legacy marker parsing is retained only for active `legacy_marker_v1` sessions. |
| `plan_reviewer` | `buildPlanReviewerPrompt` (`mode=plan`, `mode=derived-plan`) | `runPlanReviewerRound` | `buildPlanReviewerSchema` / `PlanReviewerPayload` | Execution-shape confirmation is part of the contract. Reviews material approach, scope, sequencing, and verification defects without turning the plan into an implementation inventory. |
| `scope_coder` | `buildScopePrompt`, `buildCoderResponsePrompt` | `runCoderScopeRound`, `runCoderResponseRound` | Primary execution: `buildCoderScopeSchema` / `validateCoderScopePayload`. Response rounds: `buildCoderResponseSchema` / `validateCoderResponsePayload`. | Primary execution routes new/resumed structured sessions by persisted `coderSessionProtocol`. Legacy marker and progress-payload parsing is retained only for active `legacy_marker_v1` sessions. Also carries an `adjacent`-status blocked-recovery `response` variant (see below). |
| `scope_reviewer` | `buildReviewerPrompt` | `runReviewerRound` | `buildReviewerSchema` / `ReviewerPayload` | Execute-scope review only. `neal review` external ranges use the separate read-only review-findings loop. Meaningful-progress remains a capability variant of `scope_reviewer`, not a new top-level id. Context includes a run-local `scratchDir`, but read-only reviewer prompts omit it. |
| `completion_coder` | `buildFinalCompletionSummaryPrompt` | `runCoderFinalCompletionSummaryRound` | `buildFinalCompletionSummarySchema` / `parseFinalCompletionSummaryPayload` | Structured advisor round, but still a coder-owned role/task. The completion packet includes aggregate review context when neal can compute it. |
| `completion_reviewer` | `buildFinalCompletionReviewerPrompt` | `runReviewerFinalCompletionRound` | `buildFinalCompletionReviewerSchema` / `parseFinalCompletionReviewerPayload` | Whole-plan aggregate review remains distinct from ordinary scope review and keeps its final-completion verdict schema. Context includes a run-local `scratchDir`, but read-only reviewer prompts omit it. |
| `consultant` | `buildConsultantPrompt` | `runConsultantRound` | `buildConsultantSchema` / `validateConsultantVerdictPayload` | Single no-read-safe variant for the read-only consultant. It judges entirely from neal-inlined context and its static instructions pass the shared no-read guard. |

### Adjacent current prompt surfaces

These prompts are real but are not separate top-level prompt-spec ids:

| Current builder | Registry status | Schema target | Why not a top-level id |
| --- | --- | --- | --- |
| `buildBlockedRecoveryCoderPrompt` (`src/neal/agents/prompts.ts`) | Registered as a `scope_coder` `response` variant with status `adjacent` | `buildCoderBlockedRecoveryDispositionSchema` / `validateCoderBlockedRecoveryDispositionPayload` | It is still the same execute-scope owner responding inside blocked recovery. |
| `buildReviewFindingsDraftPrompt`, `buildReviewFindingsReviewPrompt` (`src/neal/review-findings/prompts.ts`) | Not in the prompt-spec registry | `ReviewFindingsDraft` / `ReviewFindingsReview` payloads | Read-only `neal review` findings loop with its own draft/review prompts and read-only rules. |

## Contract expectations

Each prompt spec in `src/neal/prompts/specs.ts` makes these fields explicit:

- `id`
- `role`
- `purpose`
- `requiredContext`
- `schemaTarget`
- `baseInstructions`
- `providerVariants`
- `evaluationNotes`
- `firstMigrationPriority`
- `currentHome`
- `ownershipNotes`
- `variants`

Three implementation details are intentionally concrete:

1. `baseInstructions` names the current prompt-builder function and its explicit input shape.
2. `requiredContext` lists the exact context keys the prompt assumes, including artifact and repository inputs that are not always passed as one raw function argument today.
3. `schemaTarget` names the concrete schema builder plus validator/parser surface.

That keeps prompt specs reviewable as contracts rather than as scattered string literals.

## Prompt-spec wiring

Prompt specs are not the whole execution loop. They are the prompt-facing contract layer that tells neal which role/task is being performed, what context that role/task assumes, and which output contract the result must satisfy.

That wiring is intentionally split across a few modules:

- `src/neal/prompts/specs.ts` owns prompt-spec identity, required-context contracts, schema linkage metadata, and provider-variant policy.
- `src/neal/prompts/review-doctrine.ts` owns shared reviewer posture for execute-scope review, plan review, and final completion review.
- `src/neal/prompts/*.ts` owns the concrete prompt builders that render instructions for planning, execute-mode, and specialized flows.
- `src/neal/agents/schemas.ts` owns the actual schema builders plus validators or retained parsers named by each spec's `schemaTarget`.
- `src/neal/agents/rounds.ts` owns round execution and parsing against those schemas.
- `src/neal/adjudicator/*.ts` owns the adjudication specs that reference prompt surfaces by `(promptSpecId, variantKind, exportName)` (see [adjudicator-inventory.md](adjudicator-inventory.md)).
- `src/neal/orchestrator.ts` and `src/neal/orchestrator/*.ts` own phase transitions, adoption/finalization semantics, blocked-recovery routing, and commit consequences.

That split is deliberate. A prompt spec is incomplete without explicit schema linkage, but it also must not absorb sequencing or state-transition semantics that belong to the orchestrator.

### Context assembly rules

`requiredContext` should be read as a contract for context assembly, not as documentation for a prompt author.

When adding or changing a prompt spec:

1. Every required field in `requiredContext` should have one clear source such as a prompt argument, persisted run artifact, review history packet, repository-state query, orchestrator-state field, or operator input.
2. The corresponding prompt builder in `src/neal/prompts/*.ts` should either accept that data directly or assemble it from a narrowly-scoped helper. Do not hide major context dependencies inside unrelated utilities.
3. If a prompt needs new state, artifact, or repository-derived context, add that dependency at the owning layer first and then link it from the spec. Do not document impossible context.
4. If a field is only used in a variant, keep that distinction explicit in the variant contract instead of pretending it is universally required.
5. Variant `inputShape` keys must stay a subset of the spec's top-level `requiredContext` keys. neal validates that contract at module load so prompt-spec drift fails fast in tests and at startup.

Final completion has one additional context assembly rule: `buildFinalCompletionPacket()` includes `aggregateReviewContext` for the whole implementation range from `initialBaseCommit` to the resolved final commit. When the range can be read, the packet carries commit subjects, diff stat, and changed files. When it cannot, it carries an explicit `unavailableReason` so the reviewer treats the missing aggregate range as evidence to consider instead of silently accepting completion.

Execute-scope and final-completion reviewer context includes a deterministic
run-local `scratchDir` under `.neal/runs/<run-id>/scratch/`. A `tool-access`
prompt tells the reviewer to use that directory for temporary verification
artifacts. A `read-only` prompt omits the directory and forbids scratch work.
Every built-in reviewer currently uses `read-only` mode.

The goal is for reviewers to be able to answer two questions quickly:

- "What does this prompt assume is available?"
- "Where does neal actually get that data?"

### Schema-linkage rules

`schemaTarget` exists so prompt changes remain coupled to the concrete validator or retained parser surface they must satisfy.

The `PromptSchemaTarget` type admits two kinds:

- `structured_json` means the prompt must remain aligned with a named schema builder and validator or retained object parser in `src/neal/agents/schemas.ts`, delivered through the `neal-json-block-v1` transport.
- `terminal_marker` means a legacy prompt is governed by a plain-text final-line protocol. It remains in the type, but no current spec or variant declares it. Every current schema target is `structured_json`.

For coder-owned decisions, `structured_json` maps to
`CoderAdapter.runStructuredPrompt()` via the shared structured-coder helper.
`runPrompt(..., outputSchema)` is retained as raw provider compatibility
outside neal product control paths. It is not the prompt-spec surface for
neal-owned coder decisions. The retained terminal-marker and progress-payload
parsers exist only for active `legacy_marker_v1` primary sessions loaded from
older run state.

If a prompt change would force validator or retained parser behavior to change, treat that as a contract change and review the prompt spec, prompt builder, schema builder, and tests together.

## Provider variants

Provider-specific variants are allowed, but they are not the default escape hatch. Each spec declares `providerVariants` for `shared` (status `default`) plus `openai-codex` and `anthropic-claude` (status `reserved_for_justified_divergence`).

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

The `neal-json-block-v1` JSON-block transport is intentionally an adapter
concern, not a prompt-spec variant: the shared prompt builders own review
substance, schema linkage, and meaningful-progress semantics, while provider
adapters own the local control-block transport instructions so providers
return prose plus a final `neal-json` block that neal validates locally.

## Adjudicator alignment

Adjudication specs in `src/neal/adjudicator/specs.ts` reference prompt surfaces by `(promptSpecId, variantKind, exportName)`, and that linkage is validated at import time against the prompt-spec registry. The relationship is:

- prompt specs define the coder/reviewer role/task contracts that adjudication specs reference
- adjudication specs define which coder prompt, reviewer prompt, schemas, artifact/context packet, and convergence rule belong to a loop
- the adjudicator helpers own loop mechanics such as round invocation and settled-vs-revise synthesis
- execute and plan transitions own operational meaning such as adoption, blocked recovery, replacement, and finalization

That means prompt specs stay separate from:

- phase transitions
- success/block routing
- commit/finalization semantics
- operator-adoption policy

Three current role/task boundaries matter especially:

- `scope_reviewer` keeps meaningful-progress as a capability variant, not a separate top-level prompt id
- `scope_reviewer` and `completion_reviewer` share adversarial doctrine, but they keep separate schemas and adjudication families
- `completion_reviewer` is plan-review-adjacent in the adjudicator family mapping, but its execute-mode completion transitions remain outside prompt ownership

## Adding or extending prompt specs

Add prompt specs in a disciplined order:

1. Confirm the feature is a recurring role/task surface rather than a one-off continuation inside an existing role. If it is only a bounded continuation, prefer a variant on an existing spec.
2. Add or update the prompt spec in `src/neal/prompts/specs.ts` with explicit `requiredContext`, `schemaTarget`, `baseInstructions`, and ownership notes.
3. Implement or update the concrete prompt builder in the relevant `src/neal/prompts/*.ts` module.
4. Keep schema linkage explicit by adding or updating the corresponding schema builder and validator/parser surface in `src/neal/agents/schemas.ts` when structured control output is required.
5. Add or update deterministic fixtures and prompt-render assertions under `test/fixtures/prompts/` and the prompt-spec regression tests.
6. Only after the prompt contract is stable should adjudicator work decide whether the new surface deserves its own adjudication spec or reuses an existing loop family.

Use a new top-level `PromptSpecId` only when the role/task is genuinely distinct in at least one of these ways:

- it has its own durable artifact or output contract
- it has a materially different required-context packet
- it is expected to recur as an independently understandable neal surface

Otherwise prefer a variant such as `response`, `derived_plan`, `meaningful_progress`, or `final_completion`.

## Testing

Deterministic prompt regression coverage has three fixture layers:

- prompt-render assertions for required sections and invariants
- inventory assertions that every curated role/task still points at explicit builders and schema targets
- fixture inputs for known ambiguity cases such as execution-shape declaration and meaningful-progress review

Current coverage:

- planning prompts have dedicated JSON fixtures under `test/fixtures/prompts/planning/`
- execute and completion prompts have deterministic fixture coverage under `test/fixtures/prompts/execute/` and `test/fixtures/prompts/specialized/`
- completion fixtures and render assertions pin aggregate range review, cross-scope invariant review, happy-path reachability, mocked-risk skepticism, and concrete completion-blocking issue quality
- inventory assertions in `test/review.test.ts` pin module ownership, schema targets, and current-home metadata

The blocked-recovery prompt is covered by the same additive guidance model as its owning coder role. The consultant prompt takes no guidance injection (see below).

## User guidance injection

Users can layer their own guidance onto neal's built-in coder, reviewer, and planner prompts without forking the prompt source. The injection surface is deliberately additive: built-in sections still own structured coder envelopes, retained legacy terminal-marker compatibility, reviewer verdict JSON schemas, and the canonical plan contract.

Guidance files (all optional):

- `~/.neal/guidance/coder.md`: injected into scope coder (including the retained legacy variant), scope response, interactive blocked recovery, and final completion summary prompts
- `~/.neal/guidance/reviewer.md`: injected into scope reviewer, plan reviewer, and final completion reviewer prompts
- `~/.neal/guidance/planner.md`: injected into plan author (including the retained legacy variant) and plan response prompts

The consultant prompt and the `neal review` findings prompts take no guidance injection.

By default neal reads those files from `~/.neal/guidance/`. For each role, a
missing or whitespace-only `~/.neal/guidance/<role>.md` file is a no-op. Set
`NEAL_GUIDANCE_DIR` to point at another directory with the same file names for
testing or profile experiments. That override wins over the default directory.

When present, the file contents are appended under a fixed `## User Guidance` section inside the built-in prompt. Structured output contracts, completion markers, and the canonical plan contract survive injection.

Diagnostics: when a neal writer run initializes or resumes, it logs which roles have guidance applied and the byte count to the run's `stderr.log` and as a `run.user_guidance_applied` / `run.user_guidance_scanned` event. That is enough to confirm a guidance file was picked up without dumping contents.

Non-goals: no repo-local `.neal/guidance/` override, no full-prompt replacement, no per-scope guidance variants, and no substitution of built-in sections.

The module lives in [src/neal/prompts/guidance.ts](../src/neal/prompts/guidance.ts). Tests in [test/user-guidance.test.ts](../test/user-guidance.test.ts) cover default-directory loading, the `NEAL_GUIDANCE_DIR` override, empty-file no-op, injection into coder/reviewer/planner and blocked-recovery prompts, additive injection (structured actions and the plan contract survive), and guidance diagnostics.
