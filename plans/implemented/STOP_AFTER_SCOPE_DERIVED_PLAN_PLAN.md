# Neal Stop-After-Scope Derived-Plan Boundary Plan

## Execution Shape

executionShape: multi_scope

## Goal

Make `q` stop Neal at the next true scope boundary even when the current scope finishes by adopting an accepted derived plan. The stop-request message in `src/neal/index.ts` must remain unchanged.

## Repository Ground Truth

- `src/neal/index.ts` only captures the operator request and passes `shouldStopAfterCurrentScope()` into `runOnePass(...)`.
- `src/neal/orchestrator.ts` already has a dedicated `awaiting_derived_plan_execution` handler inside `runOnePass(...)`. That handler calls `saveState(statePath, adoptAcceptedDerivedPlan(currentState))`, writes execution artifacts, logs `phase.complete`, and returns the adopted `coder_scope` state.
- `src/neal/orchestrator/transitions.ts` implements `adoptAcceptedDerivedPlan(state)`, which converts `awaiting_derived_plan_execution` into a running `coder_scope` with `derivedScopeIndex: 1` and cleared per-scope review state.
- `src/neal/orchestrator/run-loop.ts` currently pauses only when the post-handler state is a running `coder_scope` and the previous phase was `final_squash` or `final_completion_review`.
- Existing pause-boundary coverage already lives in `test/orchestrator.test.ts`, including `runOnePass honors stop-after-current-scope on the final_squash to coder_scope boundary...`.

## Scope Boundaries

Allowed edits:
- `src/neal/orchestrator/run-loop.ts`
- `test/orchestrator.test.ts`

Conditionally allowed only if Scope 1 proves impossible without it:
- `src/neal/orchestrator.ts`

Forbidden edits:
- `src/neal/index.ts`
- `src/neal/orchestrator/transitions.ts`
- plan-validation logic, split-plan marker semantics, notification wording, retrospective behavior, or unrelated execute/review flow behavior
- runtime source outside the files listed above

## Required Behavior

- Preserve the existing pause behavior after `final_squash -> coder_scope`.
- Preserve the existing pause behavior after `final_completion_review -> coder_scope`.
- Add the same pause behavior after `awaiting_derived_plan_execution -> coder_scope`.
- Pause only after the accepted derived plan has already been adopted into execution state. Do not pause while derived-plan review is still in progress.
- Return a resumable `coder_scope` state that still points at derived-plan execution, meaning the resumed run should continue with the already-adopted derived scope rather than re-running plan review.
- Keep the existing `run.paused_after_scope` event shape and the existing stop-request terminal copy.

## Sequencing Rules

- Execute scopes in order.
- Do not start Scope 2 until Scope 1 has either landed or produced a concrete blocker proving the boundary cannot be fixed inside `run-loop.ts`.
- If Scope 1 requires touching `src/neal/orchestrator.ts`, keep that change minimal and limited to exposing the same post-adoption boundary already present in the current handler. Do not redesign derived-plan adoption.

## Execution Queue

### Scope 1: Extend the run-loop pause boundary to accepted derived-plan adoption
- Goal: Update `src/neal/orchestrator/run-loop.ts` so `shouldStopAfterCurrentScope()` also pauses when a pass enters a running `coder_scope` immediately after the `awaiting_derived_plan_execution` handler adopts an accepted derived plan.
- Files: `src/neal/orchestrator/run-loop.ts`; only touch `src/neal/orchestrator.ts` if the current handler contract cannot expose this boundary cleanly.
- Implementation Notes: Change the existing `pausedAfterScopeBoundary` gate instead of inventing a second pause path. Treat `awaiting_derived_plan_execution` as another valid predecessor for the same post-handler `coder_scope` pause check. Preserve the current logger event and returned state shape. If additional orchestration edits are required, explain why the current `awaiting_derived_plan_execution` handler is insufficient before making them.
- Verification: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts`
- Success Condition: With stop requested, `runOnePass(...)` returns immediately after `awaiting_derived_plan_execution` adopts the accepted derived plan into a running `coder_scope`, while the existing `final_squash` and `final_completion_review` pause boundaries still behave exactly as before.

### Scope 2: Lock the boundary down with regression coverage in the existing orchestrator test file
- Goal: Extend `test/orchestrator.test.ts` with targeted `runOnePass(...)` coverage for the new derived-plan boundary and the unaffected existing boundaries.
- Files: `test/orchestrator.test.ts`
- Implementation Notes: Add tests near the existing stop-after-scope coverage rather than creating a new harness. Build the derived-plan fixture from `createResumeFixture(...)` with `phase: 'awaiting_derived_plan_execution'`, `status: 'running'`, `derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_1.md'`, `derivedPlanStatus: 'accepted'`, `derivedFromScopeNumber` set, `derivedScopeIndex: null`, and `createdCommits: []`; include the path explicitly so `adoptAcceptedDerivedPlan(...)` takes the real adoption path instead of returning the input state unchanged. Assert that the returned state is `phase: 'coder_scope'`, `status: 'running'`, `derivedScopeIndex: 1`, and still references the accepted derived plan. Also assert that the coder-scope handler did not execute when stop was requested by wiring custom `run-loop` handlers or by asserting the saved state and emitted events reflect adoption without derived execution work. Add a no-stop control case proving the loop continues into derived execution when `shouldStopAfterCurrentScope()` is false or omitted. Keep the existing `final_squash -> coder_scope` stop test passing as the regression guard for the ordinary boundary.
- Verification: `pnpm typecheck`; `pnpm exec tsx --test test/orchestrator.test.ts`
- Success Condition: The tests fail if Neal runs derived execution after `q` once an accepted derived plan has been adopted, fail if the legacy post-scope pause boundary regresses, and fail if the new pause rule triggers when no stop request exists.

## Verification Requirements

- Run `pnpm typecheck`.
- Run `pnpm exec tsx --test test/orchestrator.test.ts`.
- Review the affected assertions to confirm all three boundaries are covered:
  - `final_squash -> coder_scope` still pauses when stop is requested.
  - `final_completion_review -> coder_scope` still pauses when stop is requested.
  - `awaiting_derived_plan_execution -> coder_scope` now pauses when stop is requested and continues normally when stop is not requested.

## Completion Criteria

- Pressing `q` during an execute run causes Neal to stop before the first derived sub-scope executes after an accepted derived plan is adopted.
- The returned paused state is a running derived `coder_scope` that remains resumable through the existing resume path.
- No stop-request wording changed in `src/neal/index.ts`.
- No split-plan or derived-plan review semantics changed outside this boundary fix.
- `pnpm typecheck` and `pnpm exec tsx --test test/orchestrator.test.ts` both pass.

## Blocker Handling

Block only if one of these is true:

- The current `awaiting_derived_plan_execution` handler performs irreversible derived-scope work before control returns to `run-loop.ts`, making a post-handler pause semantically too late.
- The existing orchestrator test harness cannot prove the new boundary without broader fixture or API changes outside the allowed surface.

Any blocker report must name:

- the exact function and file where irreversible work happens
- the exact missing seam in the existing test harness
- the smallest additional file change required to complete the fix
