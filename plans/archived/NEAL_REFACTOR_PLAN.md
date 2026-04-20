# Neal Refactor Plan

## Execution Shape

executionShape: multi_scope

## Goal

Refactor the Neal codebase where the current implementation has become structurally heavy, with emphasis on:

- reducing the size and responsibility concentration of `src/neal/orchestrator.ts`
- separating prompt/schema concerns from provider round execution in `src/neal/agents.ts`
- making CLI resume/session-launch logic in `src/neal/index.ts` more uniform
- making state normalization in `src/neal/state.ts` more explicit

This is not a behavior-change campaign. The goal is consistency, simplification, and maintainability while preserving the current runtime contract.

## Current Assessment

The current repository structure is mostly correct:

- keep runtime code under `src/`
- keep Neal runtime/orchestration code under `src/neal/`
- keep tests under `test/`
- keep non-test runtime helpers in sibling source directories such as `src/sandbox-helpers/`

The main refactor pressure is concentrated, not global:

1. `src/neal/orchestrator.ts` is now too large and owns too many concerns.
2. `src/neal/agents.ts` mixes prompt construction, schema definitions, and provider round execution.
3. `src/neal/index.ts` still contains duplicated session/resume-launch responsibilities that should be made more uniform.
4. `src/neal/state.ts` is functioning as an implicit migration layer but does not name that responsibility clearly.

Do not flatten `src/neal/` into `src/`.

## Refactor Principles

1. Preserve behavior unless a concrete bug is being fixed as part of the refactor.
2. Prefer extracting cohesive modules over broad “cleanup” edits.
3. Favor pure transition helpers where possible, especially for orchestrator state changes.
4. Keep module boundaries shaped around runtime responsibility, not file-size vanity.
5. Do not rewrite working flows merely for stylistic symmetry.

## Target Architecture

### Orchestrator

Keep `src/neal/orchestrator.ts` as the main entry surface for orchestration, but move secondary concerns out of it.

Phase handlers remain in `src/neal/orchestrator.ts` in this plan. They are not extraction targets here. This refactor is intended to reduce support-surface complexity around the phase handlers, not to replace the orchestrator with a many-file phase-handler directory.

Preferred decomposition:

- `src/neal/orchestrator.ts`
  - top-level orchestration entrypoints
  - phase dispatch
  - high-level initialization/resume coordination
- `src/neal/orchestrator/transitions.ts`
  - pure next-state helpers
  - derived-plan adoption helpers
  - final-squash transition helpers
- `src/neal/orchestrator/notifications.ts`
  - notification policy
  - split-plan notification flushing
  - stateful notification-related persistence helpers when notification state must be saved
- `src/neal/orchestrator/split-plan.ts`
  - split-plan artifact handling
  - discarded-WIP capture/reset
  - derived-plan review/adoption helpers

After extraction, `src/neal/orchestrator.ts` remains the entry file and imports from sibling orchestrator modules. Preserve existing external import paths where practical.

Exact file names may vary, but the extraction should follow those responsibilities.

### Agents

Split `src/neal/agents.ts` into distinct concerns:

- `src/neal/agents/prompts.ts`
  - planning prompt
  - scope prompt
  - review prompt text builders
- `src/neal/agents/schemas.ts`
  - structured payload schemas and payload types tightly coupled to prompt output contracts
- `src/neal/agents/rounds.ts`
  - provider-facing round execution
  - error translation
  - prompt + schema wiring

The goal is to make prompt changes, schema changes, and runtime transport changes independently auditable.

### CLI Entry

Keep `src/neal/index.ts` as the CLI boundary, but make session launch/resume handling more uniform.

Desired shape:

- argument parsing / mode selection stays in `index.ts`
- session-launch helpers are consolidated so provider-specific resume/open behavior is not duplicated or special-cased

Do not move all CLI code out of `index.ts` unless a clear boundary emerges during refactor.

### State

Keep `src/neal/state.ts` as the state module, but make normalization explicit.

Preferred shape:

- retain `validateState(...)`
- add a named normalization step such as `normalizeStateV1(...)`
- keep hydration/defaulting in that normalization layer rather than spreading silent fallback logic across the file

This is not a request for versioned state migrations yet. It is a request to make the current implicit migration behavior explicit.

## Allowed Scope

- `src/neal/**`
- `test/**`
- `README.md` only if command/test instructions need path updates due to moved modules

## Forbidden Scope

- `src/sandbox-helpers/**` unless an import path must be updated due to module extraction
- `dist/**`
- `plans/**` except this plan if a reviewer round requires clarifying the plan itself

## Execution Queue

### Scope 1: Extract orchestrator notification and split-plan support helpers
- Goal: Move notification policy and split-plan support machinery out of `src/neal/orchestrator.ts` into focused modules without changing behavior.
- Verification: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx src/neal/index.ts --help`; `pnpm build`
- Success Condition: `orchestrator.ts` no longer owns notification helper bodies and split-plan artifact/reset helpers directly, tests still pass, CLI boot still works, moved helpers retain coherent runtime boundaries, and any test imports are updated to the new module paths.

### Scope 2: Extract pure orchestrator transition helpers
- Goal: Move derived-plan adoption and final-squash next-state logic into a dedicated transition module, keep the helpers pure, and simplify `runOnePass` phase dispatch into a clearer dispatch table if that can be done without behavior change.
- Verification: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx src/neal/index.ts --help`; `pnpm build`
- Success Condition: `orchestrator.ts` delegates state-transition calculations to extracted pure helpers, existing transition tests still pass, CLI boot still works, any moved test imports are updated, and `runFinalSquashPhase`/derived-plan adoption logic are easier to audit. If phase dispatch is refactored in this scope, it must remain behavior-preserving and simpler than the current branch chain.

### Scope 3: Split agents into prompts, schemas, and rounds
- Goal: Decompose `src/neal/agents.ts` so prompt text, structured schema contracts, and provider round execution are separated into focused modules.
- Verification: `pnpm typecheck`; targeted tests covering plan validation/review flows: `pnpm exec tsx --test test/plan-validation.test.ts test/plan-review.test.ts test/plan-fixtures.test.ts`; `pnpm exec tsx src/neal/index.ts --help`; `pnpm build`
- Success Condition: prompt-only edits no longer require wading through runtime transport code, schema definitions are isolated, runtime behavior of plan/review/coder rounds remains unchanged, and any moved test imports are updated. Do not replace the readable function-per-round pattern with generic round wrappers merely to save lines.

### Scope 4: Normalize CLI session-launch and state normalization seams
- Goal: Simplify `src/neal/index.ts` session-launch helpers and make `src/neal/state.ts` normalization explicit.
- Verification: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts test/plan-validation.test.ts test/plan-review.test.ts test/plan-fixtures.test.ts`; `pnpm exec tsx src/neal/index.ts --help`; `pnpm build`
- Success Condition: resume/open command routing is centralized, `state.ts` has a named normalization layer, and no existing command/test behavior regresses.

## Review Guidance

Reviewer focus should be:

1. Responsibility boundaries
- did the extraction actually reduce coupling, or just move code around?

2. Behavioral preservation
- did any phase-transition, split-plan, or review-loop semantics change unintentionally?

3. Module coherence
- does each new file have one clear runtime reason to exist?

4. Refactor quality
- are imports and names cleaner, or did the change introduce shallow indirection?

The reviewer should block:

- extractions that preserve file size problems by merely renaming them
- refactors that increase indirection without clarifying ownership
- any unintentional behavior drift in orchestration, review flow, resume flow, or split-plan handling

## Verification Strategy

Minimum verification per relevant scope:

- `pnpm typecheck`
- `pnpm build`

And where the touched surface requires it:

- `pnpm exec tsx --test test/orchestrator.test.ts`
- `pnpm exec tsx --test test/plan-validation.test.ts test/plan-review.test.ts test/plan-fixtures.test.ts`

Prefer targeted test runs per scope over always rerunning the entire test set if the touched surface is narrow, but the final scope should leave all relevant tests green.

## Completion Criteria

This plan is complete when:

1. `src/neal/orchestrator.ts` is materially smaller and no longer directly owns notification/helper concerns that now have clear module homes.
2. derived-plan/final-squash state transitions are concentrated in pure helper modules rather than embedded inline in the orchestrator flow.
3. `src/neal/agents.ts` has been decomposed into prompts, schemas, and runtime round execution modules.
4. `src/neal/index.ts` session-launch/resume behavior is centralized and uniform.
5. `src/neal/state.ts` has an explicit normalization layer rather than only implicit hydration fallback.
6. verification remains green after each accepted scope.

When all scopes are complete, end with `AUTONOMY_DONE`.
