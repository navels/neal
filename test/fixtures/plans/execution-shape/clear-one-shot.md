# Clear One-Shot Plan

## Execution Shape

executionShape: one_shot

## Goal

Add a focused notifier timeout guard in `src/notifier.ts` so local notification failures return quickly and do not stall the wrapper.

## Scope

Limit the change to the notifier helper and any adjacent unit-sized test coverage needed to pin the timeout behavior. Do not widen into orchestrator retry policy or provider integrations.

## Implementation Notes

- Update the notifier command wrapper in `src/notifier.ts` to enforce a bounded child-process wait.
- Preserve the existing YAML-configured `neal.notify_bin` behavior.
- Keep failure handling local to notification dispatch instead of altering caller contracts.

## Verification

- `pnpm typecheck`
- `tsx --test src/neal/orchestrator.test.ts`

## Success Condition

Notification dispatch exits deterministically when the helper hangs, the change remains isolated to the notifier path, and the repo passes the targeted verification commands.
