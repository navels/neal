## Goal

Add a meaningful-progress gate to execute-mode scope acceptance so Neal stops accepting locally-correct churn when the accepted-scope sequence is no longer converging on the active parent objective.

The finished behavior must keep the existing execute-mode flow centered on:

- `coder_scope`
- `reviewer_scope`
- `final_squash`

The first version should stay in-band with that flow. Do not introduce a separate `meaningful_progress_review` phase family unless implementation proves the existing `reviewer_scope` contract cannot carry the verdict safely.

## Scope Boundaries

Allowed implementation scope:

- `src/neal/orchestrator.ts`
- `src/neal/agents/rounds.ts`
- `src/neal/agents/prompts.ts`
- `src/neal/agents/schemas.ts`
- `src/neal/types.ts`
- `src/neal/state.ts`
- `src/neal/scopes.ts`
- `src/neal/progress.ts`
- `src/neal/review.ts`
- `src/neal/config.ts`
- `config.yml` only if a new documented Neal runtime setting is added
- focused regression coverage under `test/`

Forbidden scope:

- `src/notifier.ts`
- `src/sandbox-helpers/**`
- `dist/**`
- unrelated CLI surface changes outside what is required for execute-mode progress gating
- diagnostic-recovery implementation beyond reusing existing blocked / operator-guidance paths

## Current Integration Points

Ground the implementation in the current repository behavior:

- `runCoderScopePhase` in `src/neal/orchestrator.ts` advances execute mode from `coder_scope` to `reviewer_scope` based on the marker returned by `runCoderScopeRound`.
- `runReviewPhase` in `src/neal/orchestrator.ts` currently asks the reviewer only for `summary` plus review `findings`, then transitions either to coder-response phases or directly to `final_squash`.
- `runFinalSquashPhase` already computes `changedFilesSinceBase`, appends completed scopes through `appendDerivedSubScopeAndParentCompletion`, archives review output, and advances scope state.
- `ProgressScope` in `src/neal/types.ts` already persists accepted / blocked scope history with `derivedFromParentScope`, `finalCommit`, `commitSubject`, and `archivedReviewPath`.
- `getParentScopeLabel`, `getCurrentScopeLabel`, and `isExecutingDerivedPlan` in `src/neal/scopes.ts` already define the current parent-scope semantics for derived execution.
- `renderPlanProgressMarkdown` and `renderReviewMarkdown` already expose persisted state and are the right audit surfaces for the new gate.

Do not ask the future executor to add an extra barrel export step unless a new symbol truly is not already reachable from its current module boundary.

## Parent-Objective Contract

The meaningful-progress gate must reason about the current parent objective exactly this way:

- when no derived plan is active, the parent objective is `currentScopeNumber`
- when executing an accepted derived plan, the parent objective is `derivedFromScopeNumber`
- accepted derived sub-scopes must count toward the original parent objective rather than creating a new independent progress campaign

Use the existing scope helpers in `src/neal/scopes.ts` as the source of truth for this mapping. If they are insufficient, extend them there instead of duplicating parent-objective logic inside `src/neal/orchestrator.ts`.

## Gate Contract

Before Neal accepts an execute-mode scope:

1. The coder must provide a short structured justification describing why the current scope materially advances the active parent objective.
2. Neal must assemble a bounded summary of recent accepted scopes for that same parent objective.
3. The reviewer must evaluate ordinary review findings and meaningful-progress status in the same execute review pass.
4. Neal must not enter `final_squash` unless the reviewer returns a positive meaningful-progress verdict.
5. If the reviewer says progress is not meaningful, Neal must stop before acceptance and route into existing blocked / operator-guidance machinery.

The first version must support reviewer progress actions:

- `accept`
- `block_for_operator`
- `replace_plan`

`replace_plan` does not authorize the reviewer to author a replacement plan. It means Neal should stop before acceptance and route the run into the existing operator-guidance path with explicit context that the current scope shape should be replaced, including `neal --diagnose` as one available next step.

## History Window

Use a rolling default window of the last `5` accepted scopes for the active parent objective.

The summary packet must include, at minimum:

- scope number
- parent scope
- final commit
- commit subject
- changed files or a persisted changed-file summary
- touched-file concentration summary sufficient to reveal repeated hotspot churn

Do not reconstruct this history from arbitrary repository commits. Reuse Neal-owned persisted scope history.

If the implementation adds configurability, do it through `src/neal/config.ts` and `config.yml` using the existing getter pattern with a real default of `5`. If configurability is not implemented in the first pass, keep the default hard-coded and document that choice directly in the code and tests.

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Persist Parent-Objective History Needed For The Gate
- Goal: Extend completed-scope persistence so Neal can summarize accepted scope history for the active parent objective without reconstructing it from scratch at review time.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Accepted scope records carry enough data to build the last-5 parent-objective summary directly from `state.completedScopes`, and derived-plan scopes still map back to the correct parent scope.

Implementation requirements for this scope:

- Extend `ProgressScope` in `src/neal/types.ts` with the minimum additional fields needed for the gate. Prefer persisted changed-file detail or a compact changed-file summary over later git archaeology.
- Update state hydration in `src/neal/state.ts` so older session files remain readable with safe defaults.
- Update `appendCompletedScope` and `appendDerivedSubScopeAndParentCompletion` in `src/neal/orchestrator/transitions.ts` so accepted scopes record the new history data at the moment Neal already knows the final commit and changed files.
- Reuse `changedFilesSinceBase` from `runFinalSquashPhase` in `src/neal/orchestrator.ts` instead of recomputing an equivalent list elsewhere.
- Add a focused helper, preferably near `src/neal/scopes.ts` or in a small new Neal-local helper module, that filters recent accepted scopes by parent objective and returns the bounded rolling window in newest-first or oldest-first order chosen explicitly by tests.
- Add tests covering:
  - top-level accepted scope history
  - derived sub-scope history tied back to `derivedFromScopeNumber`
  - the parent-scope completion record written when a derived plan finishes
  - backward-compatible state hydration

### Scope 2: Add A Structured Coder Progress-Justification Contract To Execute Scope Rounds
- Goal: Make execute-mode coder scope output carry a parseable meaningful-progress justification instead of relying only on a freeform transcript plus terminal marker.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: `runCoderScopeRound` returns a parsed progress-justification payload alongside the existing marker handling, and execute-mode scope continuation still works with current providers.

Implementation requirements for this scope:

- Ground this scope in the current code: `runCoderScopeRound` in `src/neal/agents/rounds.ts` currently returns only `finalResponse`, `sessionHandle`, and `marker`.
- Add an explicit execute-scope payload parser in `src/neal/agents/schemas.ts` for:
  - `milestoneTargeted`
  - `newEvidence`
  - `whyNotRedundant`
  - `nextStepUnlocked`
- Update `buildScopePrompt` in `src/neal/agents/prompts.ts` so the coder includes that structured block while still ending with the required terminal marker.
- Update `runCoderScopeRound` to parse and validate the structured block from the coder response, preserving the existing `AUTONOMY_SCOPE_DONE` / `AUTONOMY_DONE` / `AUTONOMY_BLOCKED` / `AUTONOMY_SPLIT_PLAN` semantics.
- Persist the parsed coder justification in execute-mode state by extending `OrchestrationState` in `src/neal/types.ts` and `createInitialState` / `saveState` / hydration logic in `src/neal/state.ts`.
- Keep plan-mode round contracts unchanged. This scope is only for execute-mode `coder_scope`.
- Add tests proving:
  - valid coder scope output parses successfully
  - missing or malformed progress-justification fields fail fast
  - split-plan output still carries the derived plan body correctly
  - resume and state serialization preserve the new execute-scope payload

### Scope 3: Add Reviewer Meaningful-Progress Verdict To The Existing Execute Review Phase
- Goal: Extend execute-mode reviewer output so the reviewer decides both code-review correctness and parent-objective convergence before Neal can accept the scope.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: `runReviewPhase` cannot transition directly to `final_squash` unless the reviewer returns a positive meaningful-progress verdict for the current parent objective.

Implementation requirements for this scope:

- Extend the execute reviewer schema in `src/neal/agents/schemas.ts`. Do not change plan-review schemas unless a shared helper can be refactored safely without changing behavior.
- The execute reviewer payload must include:
  - ordinary `summary`
  - ordinary `findings`
  - `meaningfulProgressAction`
  - `meaningfulProgressRationale`
- Update `buildReviewerPrompt` in `src/neal/agents/prompts.ts` so the reviewer receives:
  - current diff / commit / changed-file context
  - the coder's parsed progress justification from the current scope
  - the recent accepted-scope summary for the same parent objective
  - an explicit instruction that meaningful-progress authority belongs to the reviewer
- Add a deterministic helper that builds the reviewer-facing recent-history summary from persisted `completedScopes`.
- Update `runReviewerRound` in `src/neal/agents/rounds.ts` and `runReviewPhase` in `src/neal/orchestrator.ts` so the execute reviewer verdict is parsed, logged, and persisted in state.
- Keep this gate inside `reviewer_scope`. Do not add a new phase if the existing transition can carry the extra verdict cleanly.
- Add tests proving:
  - clean convergent scope review still reaches `final_squash`
  - reviewer `block_for_operator` stops before acceptance
  - reviewer `replace_plan` stops before acceptance
  - ordinary blocking findings still route to `coder_response` or `coder_optional_response` as today

### Scope 4: Wire Negative Meaningful-Progress Verdicts Into Existing Recovery Paths
- Goal: Give the new verdict real consequences without inventing a second replacement or blocked-recovery protocol.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`
- Success Condition: Neal refuses to accept non-convergent scopes, surfaces the reason clearly, and reuses existing blocked / operator-guidance machinery instead of silently squashing another commit.

Implementation requirements for this scope:

- In `runReviewPhase`, treat `meaningfulProgressAction === 'accept'` as the only progress outcome that may proceed toward `final_squash`.
- For `block_for_operator`, enter the existing blocked path before acceptance, with an explicit blocker reason that names meaningful-progress failure and the active parent scope.
- For `replace_plan`, also stop before acceptance and route into the existing blocked / interactive operator-guidance path with explicit text that the current scope should be replaced rather than retried.
- Reuse `enterInteractiveBlockedRecovery` and the current blocked notification path in `src/neal/orchestrator.ts`. Do not invent a reviewer-authored replacement-plan artifact here.
- In the operator-facing blocked reason and persisted artifacts, mention `neal --diagnose` as one available next step for the `replace_plan` case, consistent with `plans/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md`.
- Ensure the current scope is not appended to accepted `completedScopes` and `runFinalSquashPhase` is not entered for either negative action.
- Add tests covering:
  - blocked-state transition details for `block_for_operator`
  - blocked-state transition details for `replace_plan`
  - no accepted-scope append on negative progress verdicts
  - resume behavior from the blocked state without corrupting existing split-plan or consult flows

### Scope 5: Add Audit Trail, Progress Rendering, And Regression Coverage For Churn Detection
- Goal: Make the gate auditable in Neal artifacts and prove it catches repeated same-parent churn without regressing ordinary multi-scope execution.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`
- Success Condition: Neal artifacts show the recent-history packet, coder justification, reviewer progress verdict, and resulting action, and regression tests cover both convergent and non-convergent sequences.

Implementation requirements for this scope:

- Update `renderPlanProgressMarkdown` in `src/neal/progress.ts` so current execute progress exposes the latest meaningful-progress context and completed-scope history remains legible.
- Update `renderReviewMarkdown` in `src/neal/review.ts` so the review artifact includes:
  - coder progress justification
  - recent accepted-scope summary for the active parent objective
  - reviewer meaningful-progress action and rationale
- If a compact machine-readable artifact is needed beyond existing state and markdown, write it inside `state.runDir` and keep it Neal-owned.
- Add regression tests for:
  - convergent multi-scope execution that still accepts cleanly
  - repeated same-parent hotspot churn that yields `block_for_operator`
  - repeated same-parent hotspot churn that yields `replace_plan`
  - derived-plan execution where sub-scopes are evaluated against the original parent scope history
  - history-window truncation at `5`
- If a runtime setting is added for the window size, add focused config tests for `src/neal/config.ts` and document the default in `config.yml`.

## Repeated-Scope Selection Rules

Execute scopes strictly in queue order. Do not begin a later scope while an earlier scope still requires one of these outcomes:

- accepted and squashed
- explicitly blocked for operator guidance
- explicitly replaced through existing replacement machinery

For derived execution:

- continue evaluating each derived sub-scope against the original parent objective identified by `derivedFromScopeNumber`
- do not reset the meaningful-progress history window when the derived plan is accepted
- when the derived plan finishes and Neal writes the parent completion record, that record should remain auditable but must not erase the underlying accepted sub-scope history used by the gate

## Verification Standards

Minimum verification for the completed implementation:

- `pnpm exec tsx --test test/orchestrator.test.ts`
- `pnpm exec tsx --test test/review.test.ts`
- `pnpm exec tsx --test test/consult.test.ts`
- `pnpm typecheck`

If a new config getter or config parsing branch is added, include direct coverage for it in the existing test suite or a focused new test file under `test/`.

## Completion Criteria

This plan is complete only when all of the following are true:

- execute-mode coder scope results include a parsed meaningful-progress justification
- execute-mode reviewer results include a parsed meaningful-progress action and rationale
- `runReviewPhase` blocks acceptance when the reviewer says progress is not meaningful
- `runFinalSquashPhase` is reached only after a positive progress verdict
- recent accepted-scope history is computed from Neal-owned persisted scope data for the active parent objective
- derived sub-scopes are evaluated against the original parent objective rather than a fresh independent history
- operator-facing artifacts make the gate decision auditable
- the verification commands above pass

## Blocker Handling

Stop and leave the run blocked if any of these conditions are discovered during implementation:

- the current provider contract cannot safely carry the structured execute-scope payload without a broader provider-layer change
- persisted scope history is too incomplete to produce the required parent-objective summary without unsafe guesswork
- the existing blocked / interactive recovery path cannot represent the `replace_plan` recommendation without changing behavior outside this plan's allowed scope

If blocked, record the concrete missing contract or state gap in Neal-owned artifacts and preserve the existing execute behavior rather than landing a partial gate that can silently accept non-convergent scopes.
