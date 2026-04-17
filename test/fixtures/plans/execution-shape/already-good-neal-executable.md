# Already Good Neal-Executable Plan

## Execution Shape

executionShape: multi_scope

## Goal

Add fixture-backed regression coverage for execution-shape validation and plan-review synthesis while keeping the work partitioned into deterministic test-only scopes.

## Execution Queue

### Scope 1: Add representative fixture plans
- Goal: Create deterministic markdown fixtures under `src/neal/test-fixtures/execution-shape/` covering one-shot, risky multi-subsystem, ambiguous-but-salvageable, and already-good execution shapes.
- Verification: `pnpm typecheck`; `tsx --test src/neal/plan-fixtures.test.ts`
- Success Condition: The repo contains stable fixture plan documents that encode the intended execution-shape contract for each representative case.

### Scope 2: Assert validator expectations from fixtures
- Goal: Add automated tests that load the fixture markdown files and verify `src/neal/plan-validation.ts` returns the expected execution shape for each plan.
- Verification: `pnpm typecheck`; `tsx --test src/neal/plan-fixtures.test.ts`
- Success Condition: Fixture-backed tests fail if a representative plan stops validating or resolves to the wrong execution shape.

### Scope 3: Assert plan-review synthesis expectations from fixtures
- Goal: Extend the fixture-backed tests so `synthesizePlanReviewFindings` only appends structural findings when a fixture is malformed, and leaves accepted fixture plans unchanged.
- Verification: `pnpm typecheck`; `tsx --test src/neal/plan-fixtures.test.ts src/neal/plan-review.test.ts`
- Success Condition: Valid representative fixtures pass through the `--plan` structural synthesis path without synthetic churn.
