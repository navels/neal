# Risky Multi-Subsystem Plan

## Execution Shape

executionShape: multi_scope

## Goal

Add execution telemetry for plan-review rounds across prompt construction, orchestration, and persisted run state without turning the work into a single broad scope.

## Execution Queue

### Scope 1: Add telemetry state fields
- Goal: Extend `src/neal/types.ts` and `src/neal/state.ts` so plan-review telemetry can be persisted without breaking existing state round-trips.
- Verification: `pnpm typecheck`
- Success Condition: Review-round telemetry fields serialize and load cleanly, and the new state shape remains backwards-compatible with existing tests.

### Scope 2: Emit telemetry from orchestration
- Goal: Update `src/neal/orchestrator.ts` to record the new telemetry at the point where plan-review rounds start, complete, and synthesize structural findings.
- Verification: `pnpm typecheck`; `tsx --test src/neal/plan-review.test.ts`
- Success Condition: Orchestration emits deterministic telemetry for each plan-review round and keeps structural findings on the existing review path.

### Scope 3: Surface telemetry in review artifacts
- Goal: Thread the new telemetry through `src/neal/review.ts` and `src/neal/progress.ts` so wrapper artifacts expose the recorded plan-review timing and shape data.
- Verification: `pnpm typecheck`; `tsx --test src/neal/plan-review.test.ts src/neal/orchestrator.test.ts`
- Success Condition: Review and progress artifacts render the telemetry without changing the surrounding execution contract.
