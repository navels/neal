# Ovation Apps Derived Near-Miss Plan

## Execution Shape

executionShape: multi_scope

## Goal

Recover a viable split-plan for the ovation-apps cartridge migration without wasting reviewer rounds on queue-shape trivia.

## Ordered Derived Scopes

1. Scope 6.6A: Migrate cartridge-data-inputs to the native base
- Goal: Move the cartridge-data-inputs implementation into the native base layer while preserving the current data contract.
- Verification strategy: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts`
- Exit criteria: The native base owns cartridge-data-inputs and the old entrypoint only delegates through supported interfaces.

2. Scope 6.6B: Remove the compatibility shim
- Goal: Delete the temporary compatibility wrapper and update the remaining callers to use the native base directly.
- Verification strategy: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts test/plan-review.test.ts`
- Exit criteria: No compatibility shim remains and the migration path stays covered by targeted tests.
