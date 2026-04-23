# Neal Unknown Scope Count Plan

## Execution Shape

executionShape: multi_scope

## Goal

Add first-class support for Neal plans whose total scope count is intentionally unknown at authoring time, so planning, validation, execution, review, progress artifacts, resume behavior, and operator-facing status all handle open-ended recurring scopes explicitly instead of pretending a fixed `N/M` queue exists.

## Repository Facts This Plan Must Respect

- The runtime currently only recognizes `one_shot` and `multi_scope` in `src/neal/types.ts`, `src/neal/agents/prompts.ts`, `src/neal/agents/schemas.ts`, `src/neal/plan-validation.ts`, and `src/neal/state.ts`.
- Canonical plan-contract instructions are currently centralized in `src/neal/prompts/shared.ts`; any new execution shape must be added there so planner, reviewer, derived-plan, and recovery-plan prompts stay aligned.
- Scope counting and scope labels currently flow through `src/neal/scopes.ts`, then into `src/neal/status-footer.ts` and `src/neal/orchestrator/notifications.ts`.
- Scope continuation and terminal completion currently flow through `src/neal/orchestrator/transitions.ts`, `src/neal/orchestrator/completion.ts`, and `src/neal/final-completion.ts`.
- Progress and review artifacts already surface execution shape and current scope via `src/neal/progress.ts`, `src/neal/review.ts`, and `src/neal/final-completion-review.ts`.
- There is no `pnpm test` script. Verification must use `pnpm typecheck` plus explicit `tsx --test ...` commands.

## Target Contract

Introduce a third execution shape:
- `executionShape: multi_scope_unknown`

This shape means:
- each executed scope is still bounded and reviewable
- the executor still works one scope at a time
- the total number of scopes is intentionally unknown at plan-authoring time
- the plan must declare one canonical recurring scope template
- the plan must declare an explicit completion condition
- Neal must not derive or display a misleading fixed denominator for this shape
- human-facing scope-progress surfaces must render the unknown denominator explicitly as `?`, not omit it

Canonical plan structure for this shape:
- `## Execution Shape`
- `executionShape: multi_scope_unknown`
- `## Execution Loop`
- `### Recurring Scope`
- required bullets: `- Goal:`, `- Verification:`, `- Success Condition:`
- `## Completion Condition`

Behavioral rules for this shape:
- `AUTONOMY_SCOPE_DONE` means the current recurring slice completed and another bounded slice is still required.
- `AUTONOMY_DONE` means the current recurring slice completed and the explicit completion condition is now satisfied.
- final plan completion must be driven by the completion condition, not by exhausting numbered `### Scope N:` entries.
- derived plans and recovery plans may preserve `multi_scope_unknown` only when the replacement work is itself an open-ended recurring loop; otherwise they should use the smallest valid fixed shape.
- top-level status/notification examples for this shape are `scope 2/?` and `scope 2/? complete`.
- if a derived plan itself uses `multi_scope_unknown`, derived progress should render as `derived 1/?`.

## Scope Boundaries

Allowed implementation surface:
- `src/neal/types.ts`
- `src/neal/state.ts`
- `src/neal/agents/prompts.ts`
- `src/neal/agents/schemas.ts`
- `src/neal/plan-validation.ts`
- `src/neal/scopes.ts`
- `src/neal/status-footer.ts`
- `src/neal/progress.ts`
- `src/neal/review.ts`
- `src/neal/final-completion.ts`
- `src/neal/final-completion-review.ts`
- `src/neal/orchestrator.ts`
- `src/neal/orchestrator/completion.ts`
- `src/neal/orchestrator/notifications.ts`
- `src/neal/orchestrator/transitions.ts`
- `src/neal/prompts/shared.ts`
- `src/neal/prompts/planning.ts`
- `src/neal/prompts/execute.ts`
- `src/neal/prompts/specialized.ts`
- `test/plan-validation.test.ts`
- `test/plan-fixtures.test.ts`
- `test/plan-review.test.ts`
- `test/status-footer.test.ts`
- `test/orchestrator.test.ts`
- `test/review.test.ts`
- prompt/spec fixtures under `test/fixtures/prompts/**` only as needed to keep fixture-based prompt tests aligned
- plan fixtures under `test/fixtures/plans/**` only as needed for the new shape
- `README.md`

Forbidden changes:
- do not change provider integrations under `src/neal/providers/**`
- do not change notification transport in `src/notifier.ts`
- do not change unrelated runtime config behavior in `src/neal/config.ts`
- do not introduce new protocol markers unless an existing marker cannot represent the required behavior
- do not remove or weaken support for existing `one_shot`, fixed `multi_scope`, derived-plan normalization, or split-plan recovery

## Sequencing Rules

- Complete the plan contract, parser, prompt contract, schema enums, and state hydration before changing execution behavior.
- Do not change footer, notification, or progress rendering until the repository has a single source of truth for “known total”, “unknown total”, and “not countable because invalid”, with `?` reserved for “unknown total by contract”.
- Do not change final-completion or scope-transition behavior until validation and state can distinguish fixed multi-scope from unknown-total multi-scope.
- Do not update `README.md` until the runtime path and regression coverage are both in place.

## Execution Queue

### Scope 1: Extend the shape contract through validation, prompts, schemas, and persisted state
- Goal: Add `multi_scope_unknown` to `ExecutionShape` in `src/neal/types.ts`, teach `src/neal/agents/prompts.ts` and `src/neal/agents/schemas.ts` to recognize it, update `src/neal/prompts/shared.ts` so the canonical contract includes the new shape and its required `## Execution Loop` / `## Completion Condition` structure, and extend `src/neal/plan-validation.ts` plus `src/neal/state.ts` so the new shape validates, normalizes, and round-trips through saved session state without regressing existing shapes.
- Verification: `pnpm typecheck`; `tsx --test test/plan-validation.test.ts test/plan-review.test.ts test/plan-fixtures.test.ts`
- Success Condition: A valid `multi_scope_unknown` plan parses and persists cleanly; malformed unknown-total plans fail with specific structural errors; plan-review synthesis and prompt/schema tests accept the third shape without breaking `one_shot` or fixed `multi_scope`.

### Scope 2: Add explicit unknown-total scope counting and operator-facing rendering
- Goal: Refactor `src/neal/scopes.ts` so execution-plan introspection can distinguish fixed totals from unknown totals instead of returning only `number | null`, then thread that richer result through `src/neal/status-footer.ts`, `src/neal/orchestrator/notifications.ts`, `src/neal/progress.ts`, `src/neal/review.ts`, and `src/neal/final-completion-review.ts`. Use `scope X/?` as the canonical rendering for top-level unknown-total progress everywhere Neal surfaces scope progress.
- Verification: `pnpm typecheck`; `tsx --test test/status-footer.test.ts test/review.test.ts test/orchestrator.test.ts`
- Success Condition: Unknown-total plans render top-level progress as `scope X/?` and unknown-total derived progress as `derived N/?` instead of a fake denominator or a silently missing denominator, fixed-shape plans keep their existing denominator behavior, and operator-facing artifacts clearly differentiate “unknown total by contract” from “count unavailable because the plan is invalid or unreadable”.

### Scope 3: Update execution transitions and completion semantics for recurring unknown-total scopes
- Goal: Change execution logic so `multi_scope_unknown` continues after accepted recurring scopes without relying on a pre-counted top-level queue, while still using the existing single-scope execution loop. This includes the transition logic in `src/neal/orchestrator/transitions.ts`, finalization flow in `src/neal/orchestrator/completion.ts`, any shape-dependent checks in `src/neal/orchestrator.ts`, and completion packet generation in `src/neal/final-completion.ts`. Keep `currentScopeNumber` monotonic for top-level recurring scopes so progress artifacts, notifications, and review history stay comparable across fixed and unknown-total runs.
- Verification: `pnpm typecheck`; `tsx --test test/orchestrator.test.ts test/review.test.ts`
- Success Condition: For `multi_scope_unknown`, `AUTONOMY_SCOPE_DONE` advances to the next recurring scope number, `AUTONOMY_DONE` ends the plan only when the completion condition is satisfied, derived-plan behavior remains intact, and fixed-cardinality `multi_scope` behavior still works unchanged.

### Scope 4: Add end-to-end regression coverage and document when to use the new shape
- Goal: Add representative plan fixtures and regression tests for valid and invalid `multi_scope_unknown` plans, recurring-scope continuation, explicit completion, prompt wording, and artifact rendering; then update `README.md` to explain when to use `one_shot`, fixed `multi_scope`, and `multi_scope_unknown`. Use the existing fixture and prompt-test conventions rather than inventing a parallel test harness.
- Verification: `pnpm typecheck`; `tsx --test test/plan-validation.test.ts test/plan-fixtures.test.ts test/plan-review.test.ts test/status-footer.test.ts test/orchestrator.test.ts test/review.test.ts`
- Success Condition: The repository has durable coverage for the new shape across planning and execution flows, and the README gives clear operator guidance for choosing the correct execution shape without referencing planning-only scaffolding.

## Repeated-Scope Selection Rules

- For a `multi_scope_unknown` top-level plan, always execute exactly one recurring scope per coder/reviewer cycle.
- After a recurring scope ends with `AUTONOMY_SCOPE_DONE`, increment `currentScopeNumber` by one and continue with the same recurring-scope template.
- After a recurring scope ends with `AUTONOMY_DONE`, transition into final completion review instead of incrementing again.
- Do not create synthetic numbered `### Scope N:` entries inside the plan document for unknown-total execution. The plan document remains a template plus completion condition; runtime state tracks which recurring iteration is active.
- Derived plans should only preserve `multi_scope_unknown` when the replacement work is genuinely another recurring loop. If the replacement is a bounded finite sequence, normalize it to `multi_scope` or `one_shot`.

## Completion Criteria

The work is complete only when all of the following are true:
- `multi_scope_unknown` is accepted anywhere Neal currently accepts an execution shape, including prompt contracts, reviewer structured output, plan validation, and persisted state hydration.
- the validator enforces `## Execution Loop`, `### Recurring Scope`, required scope bullets, and `## Completion Condition` for the new shape
- status footer, notifications, progress markdown, review markdown, and final-completion review all represent unknown totals explicitly and consistently using `?` as the human-facing denominator for “unknown by contract”
- top-level execution can continue recurring scopes without a fixed denominator and can terminate cleanly on `AUTONOMY_DONE`
- fixed `multi_scope`, `one_shot`, derived-plan normalization, and split-plan behavior remain green
- regression tests cover at least one valid unknown-total plan, one invalid unknown-total plan, recurring continuation, and final completion
- `README.md` explains shape selection using the actual supported shapes in the repository

## Blocker Handling

Block only if one of these becomes true:
- a required runtime distinction between fixed-total and unknown-total execution cannot be represented without widening persisted state beyond the files allowed in this plan
- current protocol markers cannot express the needed transition between recurring continuation and explicit completion without ambiguity that tests demonstrate concretely
- derived-plan or recovery-plan flows require a broader contract redesign instead of a local extension to the current execution-shape model

Any blocker report must name:
- the exact file and function where the assumption breaks
- the specific test or runtime path that proves the breakage
- the smallest contract change required to proceed safely
