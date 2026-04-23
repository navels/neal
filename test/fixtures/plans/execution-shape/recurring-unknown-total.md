# Recurring Unknown-Total Plan

## Execution Shape

executionShape: multi_scope_unknown

## Goal

Burn down one bounded recurring integration-fix slice at a time until the known flaky cases are exhausted.

## Execution Loop

### Recurring Scope
- Goal: Land one bounded integration-fix slice, keep the blast radius narrow, and leave the remaining backlog explicit for the next cycle.
- Verification: `pnpm typecheck`; `tsx --test test/orchestrator.test.ts`
- Success Condition: The current recurring slice is implemented, verified, and reviewable without bundling unrelated backlog items into the same scope.

## Completion Condition

Stop when the tracked flaky integration cases no longer contain any remaining fixes that justify another bounded execution scope.
