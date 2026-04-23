# Invalid Recurring Unknown-Total Plan

## Execution Shape

executionShape: multi_scope_unknown

## Goal

Demonstrate fixture-backed validation and review failures for malformed recurring scope plans.

## Execution Loop

### Recurring Scope
- Goal: Do one bounded recurring slice.
- Verification: `pnpm typecheck`

### Scope 2: Invalid extra scope
- Goal: This should not appear in an unknown-total loop fixture.
- Verification: `pnpm typecheck`
- Success Condition: Validation rejects the extra heading.

## Completion Condition
