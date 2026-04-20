# Neal Transition Signals Validation Plan

## Goal

Make `transitionSignals` in `src/neal/adjudicator/specs.ts` an enforced contract between adjudication specs and the runtime transition outcomes Neal actually supports, without turning `transitionSignals` into a dispatcher or moving state-mutation authority out of the existing orchestrator helpers.

The repository already has the right separation points for this work:

- adjudication-spec metadata and import-time spec validation in `src/neal/adjudicator/specs.ts`
- planning-family context selection in `resolvePlanningAdjudicationContext()` in `src/neal/adjudicator/planning.ts`
- execute-family context selection and reviewer disposition synthesis in `resolveExecuteAdjudicationContext()` and `resolveExecuteReviewDisposition()` in `src/neal/adjudicator/execute.ts`
- final-completion adjudication context in `resolveFinalCompletionAdjudicationContext()` in `src/neal/adjudicator/final-completion.ts`
- explicit planning and scope-completion transitions in `transitionPlanReviewWithoutOpenFindings()` in `src/neal/orchestrator/transitions.ts`
- explicit final-completion routing in `runFinalCompletionReviewPhase()` and `getFinalCompletionReviewBlockReason()` in `src/neal/orchestrator/completion.ts`
- execute and planning response/retry routing in `src/neal/orchestrator.ts`, including `getExecuteResponsePhaseWithoutOpenFindings()`, `getExecuteResponseRetryPhase()`, `getPlanningResponseRetryPhase()`, and `finalizeBlockedPlanReviewResponse()`
- existing operator-facing artifacts in `renderReviewMarkdown()`, `renderPlanProgressMarkdown()`, and `renderFinalCompletionReviewMarkdown()`

## Execution Shape

executionShape: multi_scope

## Scope Boundaries

Allowed paths:

- `src/neal/adjudicator/**`
- `src/neal/orchestrator/**`
- `src/neal/orchestrator.ts`
- `src/neal/review.ts`
- `src/neal/progress.ts`
- `src/neal/final-completion-review.ts`
- `docs/ADJUDICATOR_INVENTORY.md`
- `test/review.test.ts`
- `test/adjudicator-planning.test.ts`
- `test/adjudicator-final-completion.test.ts`
- `test/orchestrator.test.ts`

Forbidden changes:

- do not edit provider integrations under `src/neal/providers/**`
- do not redesign prompt builders or prompt content under `src/neal/prompts/**` unless a type or fixture assertion requires a minimal direct adjustment caused by this contract work
- do not change CLI entry behavior in `src/neal/cli.ts` or `src/neal/index.ts`
- do not introduce a second transition-dispatch abstraction driven by `transitionSignals`
- do not create duplicate family/outcome tables in multiple files when one shared contract surface can serve both spec validation and live outcome checks
- do not broaden this work into consult, interactive blocked recovery, diagnostic analysis, or recovery-plan authoring beyond documentation that already describes them as adjacent flows

## Desired End State

When this plan is complete:

- every in-scope adjudication spec in `ADJUDICATION_SPECS` still declares its allowed `transitionSignals`
- Neal validates those declared signals against one explicit family-level runtime contract
- live planning-family routing rejects impossible outcomes before `transitionPlanReviewWithoutOpenFindings()` or blocked-plan-response routing mutates state
- live execute-family routing rejects impossible outcomes before `resolveExecuteReviewDisposition()` results or execute response retry/settle helpers drive the next phase
- live final-completion routing rejects impossible outcomes before `runFinalCompletionReviewPhase()` persists the next state
- review/progress/final-completion artifacts expose the active adjudication spec and allowed outcomes where that improves debugging
- `docs/ADJUDICATOR_INVENTORY.md` describes `transitionSignals` as validated contract metadata rather than passive labels

## Execution Queue

### Scope 1: Define The Runtime Transition Contract
- Goal: Extend `src/neal/adjudicator/specs.ts` so import-time adjudication-spec validation also checks `transitionSignals` against one explicit family-to-outcome contract derived from the current runtime behavior.
- Verification: `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: `ADJUDICATION_SPECS` fails deterministically when any spec declares an impossible signal or omits a runtime-supported outcome for its family, and the failure names the spec id, family, and signal.

Implementation steps:

- Keep the contract surface in `src/neal/adjudicator/specs.ts` beside `validateAdjudicationSpecContracts()` so the existing import-time validation path remains the single source of truth.
- Add a family-level runtime outcome map for the three current families:
  - `plan_review`
  - `execute_review`
  - `final_completion`
- Encode the runtime-supported outcomes from the current repository state:
  - planning family: `accept_plan`, `accept_derived_plan`, `adopt_recovery_plan`, `request_revision`, `optional_revision`, `block_for_operator`
  - execute family: `accept_scope`, `request_revision`, `optional_revision`, `block_for_operator`, `replace_plan`
  - final-completion family: `accept_complete`, `continue_execution`, `block_for_operator`
- Validate both directions for every in-scope spec:
  - each declared signal must be legal for the spec family
  - each family outcome that the runtime may emit for that spec category must be represented by at least one spec in that family, with per-spec checks written so drift is caught immediately instead of silently tolerated
- Keep `getAdjudicationSpec()` and existing spec exports intact unless a narrowly scoped helper export is needed by runtime checks or tests.
- Update `docs/ADJUDICATOR_INVENTORY.md` and the inventory assertions in `test/review.test.ts` so they describe `transitionSignals` as validated allowed outcomes while preserving the existing statement that runtime transition semantics still live in the transition layer.

### Scope 2: Enforce Live Outcome Checks At Planning, Execute, And Final-Completion Boundaries
- Goal: Reject impossible live outcomes before Neal saves a next state or falls through into generic blocked-state behavior.
- Verification: `pnpm exec tsx --test test/adjudicator-planning.test.ts`; `pnpm exec tsx --test test/adjudicator-final-completion.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`
- Success Condition: Every in-scope adjudication family checks the active spec against the exact high-level outcome it is about to route, and contract drift fails with a targeted error instead of an incidental state-machine mismatch.

Implementation steps:

- Add one small runtime assertion helper in the adjudicator layer that accepts:
  - the active `AdjudicationSpec`
  - the resolved high-level outcome signal
  - a short caller label so the thrown error identifies the boundary that observed the mismatch
- Use existing context resolvers to obtain the active spec instead of re-deriving it from phases:
  - `resolvePlanningAdjudicationContext()`
  - `resolveExecuteAdjudicationContext()`
  - `resolveFinalCompletionAdjudicationContext()`
- Planning-family checks:
  - assert `accept_plan`, `accept_derived_plan`, or `adopt_recovery_plan` before `transitionPlanReviewWithoutOpenFindings()` is applied
  - assert `request_revision` or `optional_revision` before planning response retry routing uses `getPlanningResponseRetryPhase()`
  - assert `block_for_operator` before `finalizeBlockedPlanReviewResponse()` persists a blocked plan-review outcome
- Execute-family checks:
  - keep `resolveExecuteReviewDisposition()` as the place that resolves reviewer findings and meaningful-progress state into `blocked`, `coder_response`, `coder_optional_response`, or `final_squash`
  - map those concrete phases to adjudication outcomes before state mutation:
    - `final_squash` -> `accept_scope`
    - `coder_response` -> `request_revision`
    - `coder_optional_response` -> `optional_revision`
    - `blocked` with meaningful-progress `replace_plan` -> `replace_plan`
    - other execute-review blocked outcomes -> `block_for_operator`
  - assert those signals before orchestrator code applies execute retry routing through `getExecuteResponseRetryPhase()` or settle routing through `getExecuteResponsePhaseWithoutOpenFindings()`
- Final-completion checks:
  - keep `runFinalCompletionReviewPhase()` responsible for resolving `reviewerResult.verdict.action`, the continue-execution cap, and `effectiveAction`
  - assert the final adjudication-level outcome after `effectiveAction` is computed and before `saveState()` writes the resulting phase:
    - `accept_complete`
    - `continue_execution`
    - `block_for_operator`
- Preserve current transition semantics exactly:
  - do not change the return values of `transitionPlanReviewWithoutOpenFindings()`
  - do not change the phase decisions in `resolveExecuteReviewDisposition()`
  - do not change the continue-execution-cap behavior in `runFinalCompletionReviewPhase()`
- Add regression coverage with malformed fixtures or direct helper tests rather than mutating production constants in place during test setup.

### Scope 3: Surface The Active Contract In Existing Artifacts
- Goal: Make the active adjudication spec and allowed transition outcomes visible in the run artifacts Neal already writes for review and completion debugging.
- Verification: `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`
- Success Condition: The rendered markdown artifacts identify the active spec and allowed outcomes where the current run state makes that knowable, and test expectations pin the new output.

Implementation steps:

- Extend existing renderers only:
  - `renderReviewMarkdown()` in `src/neal/review.ts`
  - `renderPlanProgressMarkdown()` in `src/neal/progress.ts`
  - `renderFinalCompletionReviewMarkdown()` in `src/neal/final-completion-review.ts`
- Use existing state and adjudicator helpers to infer the active spec rather than introducing a new persisted state field unless a helper extraction is clearly simpler and safer.
- In review and progress artifacts, surface the active contract only when the current phase implies a concrete in-scope adjudication spec. That includes:
  - ordinary plan review
  - derived-plan review
  - diagnostic recovery plan review
  - execute review / execute response loops
  - final completion review
- Render these fields explicitly:
  - adjudication spec id
  - adjudication family
  - allowed transition outcomes from `transitionSignals`
- Keep the wording explicit that these are allowed outcomes for validation/debugging, not a runtime dispatcher.
- In `renderFinalCompletionReviewMarkdown()`, show the final-completion contract near the existing reviewer verdict and resulting action so the artifact makes the continue-execution versus block-for-operator distinction easier to debug.

### Scope 4: Finish Regression Coverage And Inventory Documentation
- Goal: Leave the repository with durable tests and docs that make future `transitionSignals` drift obvious and expensive to ignore.
- Verification: `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/adjudicator-planning.test.ts`; `pnpm exec tsx --test test/adjudicator-final-completion.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`
- Success Condition: The documentation and regression suite describe the landed contract accurately, and all listed verification commands pass.

Implementation steps:

- Update `docs/ADJUDICATOR_INVENTORY.md` so the ownership split is accurate after this change:
  - adjudication specs declare allowed outcomes
  - import-time validation checks those outcomes against family-supported runtime behavior
  - live routing re-checks resolved outcomes against the active spec
  - state mutation remains in `src/neal/orchestrator/transitions.ts`, `src/neal/orchestrator/completion.ts`, and the phase-routing helpers in `src/neal/orchestrator.ts`
- Expand `test/review.test.ts` to pin the revised inventory language and the new artifact rendering output.
- Add targeted regression coverage for:
  - invalid family-to-signal declarations in `ADJUDICATION_SPECS`
  - planning-family impossible outcomes
  - execute-family impossible outcomes
  - final-completion impossible outcomes
  - artifact rendering of active spec id, family, and allowed transition outcomes

## Repeated Scope Selection Rules

1. Start with the next incomplete scope in numeric order.
2. Do not begin a later scope until the current scope’s verification commands pass.
3. If the repository already contains partial work for the current scope, continue from that state instead of restarting, but do not broaden the scope boundary.
4. If unrelated changes appear outside the allowed paths, ignore them unless they directly block the current scope.
5. If a blocker prevents clean completion of the current scope, stop at that scope and report the blocker instead of skipping ahead.

## Verification

Run the scope-level commands during each scope. Before declaring the whole plan complete, run the full relevant suite:

- `pnpm exec tsx --test test/review.test.ts`
- `pnpm exec tsx --test test/adjudicator-planning.test.ts`
- `pnpm exec tsx --test test/adjudicator-final-completion.test.ts`
- `pnpm exec tsx --test test/orchestrator.test.ts`
- `pnpm typecheck`

## Completion Criteria

This plan is complete when all of the following are true:

- `transitionSignals` are validated against one explicit family-level runtime contract
- live planning, execute, and final-completion routing reject impossible adjudication outcomes before state mutation
- existing review/progress/final-completion artifacts surface the active adjudication contract where the current state makes it knowable
- `docs/ADJUDICATOR_INVENTORY.md` describes the landed contract accurately
- all commands in the verification section pass

## Blocker Handling

Stop if any of the following occur:

- the current runtime boundaries do not expose enough information to identify the active adjudication spec or resolved outcome safely
- enforcing the contract would require redesigning provider APIs, prompt protocols, or CLI entry behavior outside the allowed scope
- existing tests reveal contradictory runtime behavior that cannot be expressed as one coherent family-level outcome contract without first fixing a separate bug
