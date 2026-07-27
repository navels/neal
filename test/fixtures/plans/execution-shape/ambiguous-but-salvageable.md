# Ambiguous But Salvageable Plan

## Execution Shape

executionShape: multi_scope

## Goal

Tighten resume handling for derived-plan adoption, but do it with explicit checkpoints instead of a vague “clean up resume semantics” rewrite.

## Execution Queue

### Scope 1: Pin adoption preconditions
- Goal: Add tests around `adoptAcceptedDerivedPlan` in `src/neal/orchestrator.ts` that define the allowed adoption phase, commit state, and derived-scope index preconditions.
- Verification: `pnpm typecheck`; `tsx --test src/neal/orchestrator.test.ts`
- Success Condition: Resume/adoption invariants are explicit in failing and passing tests before implementation changes land.

### Scope 2: Narrow the adoption implementation
- Goal: Adjust the derived-plan adoption path in `src/neal/orchestrator.ts` to satisfy the new tests without widening into unrelated resume normalization code.
- Verification: `pnpm typecheck`; `tsx --test src/neal/orchestrator.test.ts`
- Success Condition: Accepted derived plans resume only from the documented pre-execution state and the scope remains limited to adoption logic.

### Scope 3: Document resume progress output
- Goal: Update `src/neal/progress.ts` and any adjacent artifact expectations so the adopted derived-plan state is legible after interruption.
- Verification: `pnpm typecheck`; `tsx --test src/neal/orchestrator.test.ts`
- Success Condition: Progress artifacts clearly show the derived-plan adoption state without introducing new resume phases.
