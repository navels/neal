# Neal Adversarial Review And Non-Blocking Uptake Plan

## Execution Shape

executionShape: multi_scope

## Goal

Strengthen execute-mode review so Neal's reviewer behaves more like a falsification-oriented code reviewer, while also making legitimate non-blocking findings harder to silently discard. The result should preserve Neal's existing blocking vs non-blocking distinction, meaningful-progress gate, split-plan flow, and final-completion flow, but make the review loop more evidence-driven and make residual non-blocking debt explicit when it is not fixed in-scope.

## Repository Grounding

The implementation must be anchored to the current execute-review path that already exists in this repository:

- Reviewer prompt construction lives in `src/neal/prompts/execute.ts` via `buildReviewerPrompt`.
- Coder response prompting for blocking and optional review turns lives in `src/neal/prompts/execute.ts` via `buildCoderResponsePrompt`.
- Reviewer structured output is parsed through `src/neal/agents/rounds.ts` `runReviewerRound` using `src/neal/agents/schemas.ts` `buildReviewerSchema`.
- Coder response structured output is parsed through `src/neal/agents/rounds.ts` `runCoderResponseRound` using `src/neal/agents/schemas.ts` `buildCoderResponseSchema`.
- Execute-review convergence and retry routing live in `src/neal/adjudicator/execute.ts`, especially `resolveExecuteAdjudicationContext`, `resolveExecuteReviewDisposition`, `runExecuteReviewerAdjudication`, `runExecuteResponseAdjudication`, and `synthesizeExecuteResponseState`.
- Review artifacts that expose findings and coder dispositions live in `src/neal/review.ts` `renderReviewMarkdown`.
- Progress artifacts live in `src/neal/progress.ts` `renderPlanProgressMarkdown` and `writePlanProgressArtifacts`.
- Whole-plan completion summary and review surfaces live in `src/neal/final-completion.ts`, `src/neal/final-completion-review.ts`, and `src/neal/orchestrator/completion.ts`.
- Review finding persistence already carries `severity`, `status`, `coderDisposition`, and `coderCommit` in `src/neal/types.ts` `ReviewFinding`.
- Existing prompt and review regression coverage already lives primarily in `test/review.test.ts`, `test/orchestrator.test.ts`, `test/prompt-spec-fixtures.test.ts`, `test/user-guidance.test.ts`, and `test/plan-review.test.ts`.

## Scope Boundaries

Allowed implementation surface:

- `src/neal/prompts/execute.ts`
- `src/neal/agents/schemas.ts`
- `src/neal/agents/rounds.ts`
- `src/neal/adjudicator/execute.ts`
- `src/neal/review.ts`
- `src/neal/progress.ts`
- `src/neal/final-completion.ts`
- `src/neal/final-completion-review.ts`
- `src/neal/orchestrator/completion.ts`
- `src/neal/types.ts`
- `test/review.test.ts`
- `test/orchestrator.test.ts`
- `test/prompt-spec-fixtures.test.ts`
- `test/user-guidance.test.ts`
- `test/plan-review.test.ts`
- `README.md` only if the execute-mode operator contract changes in a way a user must know before running Neal

Forbidden changes:

- Do not change provider adapters or provider selection.
- Do not change notification transport.
- Do not remove the distinction between `blocking` and `non_blocking`.
- Do not turn all non-blocking findings into implicit blockers.
- Do not rewrite planning-mode prompts or planning adjudication unless an execute-mode change requires a shared schema adjustment that cannot be avoided.
- Do not change split-plan, blocked-recovery, or terminal protocol markers unless a concrete execute-review bug requires it.
- Do not edit unrelated runtime source outside the files named above.

## Design Requirements

- The first execute review pass must explicitly bias toward falsification of the scope diff, not validation of the coder narrative.
- Reviewer findings must stay actionable. Each finding must identify a concrete issue, affected file set, and required correction.
- Meaningful-progress evaluation must remain part of execute review, but it must not dilute correctness review or be treated as evidence that the code is good.
- Neal must keep the existing `coder_response` and `coder_optional_response` phases rather than introducing a second parallel response loop.
- Legitimate local non-blocking findings should be fixed by default when the fix is bounded and safe, but the coder must still be able to reject or defer with evidence.
- Unresolved non-blocking findings that remain after a scope is accepted must stay visible in review, progress, and final-completion artifacts as explicit residual debt.
- Final-completion review should evaluate whether residual non-blocking debt is acceptable, not rediscover it from scratch without pipeline context.

## Execution Rules

- Execute scopes in order. Do not start a later scope until the previous scope's success condition is satisfied.
- Keep each scope behavior-preserving outside the intended review-loop changes. If a scope exposes an unrelated bug, note it in the current review artifact or code comments only when needed to complete the scope safely; do not expand implementation beyond this plan.
- When a scope changes a prompt contract or structured payload shape, update deterministic prompt fixtures and the relevant round/adjudication tests in the same scope.
- If a scope can be completed by tightening prompt text only, avoid unnecessary state-shape changes. If stronger behavior requires a persisted field or artifact section, add the smallest viable change and cover it with tests.

## Execution Queue

### Scope 1: Separate adversarial correctness review from convergence metadata
- Goal: Rework execute-mode reviewer instructions and reviewer payload requirements so `buildReviewerPrompt` and `buildReviewerSchema` force an evidence-backed falsification pass before broader quality commentary, and reduce anchoring on coder self-justification and accepted-history context during that first pass.
- Implementation:
  - Update `src/neal/prompts/execute.ts` `buildReviewerPrompt` so the opening review contract explicitly says to inspect the commit range as hostile input, search for ways the change could be wrong, and treat the coder progress justification as convergence context rather than correctness evidence.
  - Preserve meaningful-progress evaluation, but move its framing later in the prompt so correctness review leads and progress justification does not read like approval context.
  - Add explicit execute-mode bug-class review instructions that match this repository's failure modes: persistence/state shape mismatches, resume/recovery transitions, split-plan and execution-shape contract regressions, artifact/reporting mismatches, and verification that does not cover the changed behavior.
  - Extend `src/neal/agents/schemas.ts` `ReviewerFindingPayload` and `buildReviewerSchema` to require at least one new concrete support field for every finding, such as a required `evidence` or `scenario` field, because the current reviewer payload only captures `severity`, `files`, `claim`, and `requiredAction` and does not yet persist why the finding is credible.
  - Thread any new reviewer payload fields through `src/neal/agents/rounds.ts` `runReviewerRound`, `src/neal/adjudicator/execute.ts` synthesis helpers, and `src/neal/review.ts` artifact rendering so the added evidence survives into persisted review output.
  - Keep `meaningfulProgressAction` and `meaningfulProgressRationale` in the reviewer payload. Do not split them into a second schema or a second reviewer round in this scope.
- Verification: `pnpm typecheck && pnpm exec tsx --test test/review.test.ts test/prompt-spec-fixtures.test.ts test/user-guidance.test.ts test/orchestrator.test.ts`
- Success Condition: Execute reviewer prompts and schemas now require a more adversarial, evidence-backed finding style; meaningful-progress still exists but no longer frames the prompt as optimistic context; persisted review artifacts show the stronger finding contract.

### Scope 2: Tighten execute adjudication so optional follow-up is explicit, bounded, and reviewable
- Goal: Keep the existing execute-review state machine, but make `non_blocking` follow-up a deliberate adjudicated phase instead of a soft escape hatch after blocking findings clear.
- Implementation:
  - Update `src/neal/prompts/execute.ts` `buildCoderResponsePrompt` so optional-response mode clearly says that local, concrete, low-expansion non-blocking findings are expected to be fixed unless the coder can justify rejection or deferral.
  - Keep the existing `fixed` / `rejected` / `deferred` response contract in `buildCoderResponseSchema`, but strengthen prompt wording so every non-fixed disposition must explain why the issue is incorrect, unsafe in-scope, or intentionally deferred.
  - In `src/neal/adjudicator/execute.ts`, review `getExecuteResponseOpenFindings`, `runExecuteResponseAdjudication`, and `synthesizeExecuteResponseState` so the optional-response turn remains required whenever open non-blocking findings exist after reviewer acceptance, and so the resulting state records coder dispositions consistently for those findings.
  - Ensure the execute path still routes directly to `final_squash` only when there are no open non-blocking findings left after the optional-response turn.
  - Do not introduce new phases. Reuse `coder_optional_response` and the existing disposition mapping in `mapDecisionToStatus`.
  - Update `src/neal/review.ts` rendering if needed so open, fixed, rejected, and deferred non-blocking findings remain easy to distinguish during the optional-response portion of the loop.
- Verification: `pnpm typecheck && pnpm exec tsx --test test/orchestrator.test.ts test/review.test.ts test/plan-review.test.ts`
- Success Condition: Neal still treats non-blocking findings as non-blocking, but the coder can no longer silently ignore them; each one must be fixed, rejected, or deferred through the existing optional-response path with persisted rationale.

### Scope 3: Expose unresolved non-blocking debt in progress and final-completion artifacts
- Goal: Make unresolved non-blocking findings visible beyond the active review document so accepted scopes do not erase review debt from operator-facing progress and whole-plan completion artifacts.
- Implementation:
  - Update `src/neal/progress.ts` `buildPlanProgressState` and `renderPlanProgressMarkdown` to summarize unresolved execute-review findings, at minimum distinguishing open or deferred non-blocking items from closed findings.
  - Update `src/neal/final-completion.ts` `buildFinalCompletionPacket` to include explicit residual-review-debt context derived from accepted-scope findings, rather than relying only on terminal changed files and verification commands.
  - Update `src/neal/final-completion-review.ts` `renderFinalCompletionReviewMarkdown` so the final reviewer sees unresolved non-blocking debt and can judge whether it is acceptable residual polish or evidence that the scope exited too early.
  - Update `src/neal/orchestrator/completion.ts` only as needed so the completion packet and final-completion artifact writers serialize the new debt summary without altering the existing continue-execution cap or completion routing.
  - Do not treat all unresolved non-blocking findings as automatic final-completion failure. The artifact should expose them; the final reviewer should still decide whether they warrant `accept_complete`, `continue_execution`, or `block_for_operator`.
- Verification: `pnpm typecheck && pnpm exec tsx --test test/review.test.ts test/orchestrator.test.ts test/adjudicator-final-completion.test.ts`
- Success Condition: PLAN progress and final-completion artifacts now carry explicit unresolved non-blocking review debt, and final completion review can evaluate that debt with repository-backed context instead of rediscovering it indirectly.

### Scope 4: Lock the stronger contract with prompt fixtures and review-loop regressions
- Goal: Finish by aligning deterministic fixtures and regression tests with the new execute-review contract so future prompt or adjudication changes cannot quietly revert the adversarial review stance or the explicit non-blocking uptake requirement.
- Implementation:
  - Refresh `test/fixtures/prompts/execute/scope-reviewer-primary.json` and `test/fixtures/prompts/execute/scope-coder-response.json` so they assert the new adversarial-review wording and the stronger non-blocking response expectations.
  - Extend `test/prompt-spec-fixtures.test.ts` and `test/user-guidance.test.ts` only as needed to keep fixture coverage and additive guidance coverage aligned with the revised prompt text.
  - Add or update execute-review assertions in `test/review.test.ts` for review markdown, progress markdown, and final-completion review markdown so new evidence/debt fields are persisted.
  - Add or update `test/orchestrator.test.ts` coverage for the concrete state transitions that matter here: reviewer returns non-blocking findings only, Neal routes to `coder_optional_response`, coder rejects or defers some items, and artifacts preserve those dispositions into completion.
  - Prefer extending the existing test files listed above over inventing new broad test suites unless a new helper needs narrowly scoped unit coverage.
- Verification: `pnpm typecheck && pnpm exec tsx --test test/review.test.ts test/orchestrator.test.ts test/prompt-spec-fixtures.test.ts test/user-guidance.test.ts test/plan-review.test.ts test/adjudicator-final-completion.test.ts`
- Success Condition: The strengthened execute-review contract is covered by deterministic prompt fixtures and state-machine regressions that fail if Neal regresses back to optimistic reviewer framing or silent non-blocking finding loss.

## Completion Criteria

This plan is complete only when all of the following are true:

- Execute reviewer prompting is explicitly adversarial and evidence-driven rather than approval-seeking.
- Reviewer findings in the execute path require more concrete support than summary plus claim alone.
- Meaningful-progress evaluation still works, but it is clearly separated from correctness review intent.
- Neal continues to use `coder_response` and `coder_optional_response` rather than a new parallel response protocol.
- Non-blocking findings that remain after reviewer acceptance must be fixed, rejected, or deferred with a persisted coder rationale.
- Accepted scopes can still finish with unresolved non-blocking findings when justified, but those findings remain visible in progress and final-completion artifacts.
- Final-completion review receives enough residual-debt context to distinguish acceptable leftover polish from work that should have stayed in-scope.
- The concrete verification commands listed in each scope pass without editing unrelated runtime code.

## Blocker Handling

Stop and block only if one of these conditions is reached:

- The minimal reviewer-schema change needed to enforce evidence-backed findings would break current provider structured output in a way that cannot be covered inside `src/neal/agents/schemas.ts` and `src/neal/agents/rounds.ts`.
- Residual non-blocking debt cannot be propagated into final-completion artifacts without a broader `OrchestrationState` redesign outside the allowed files.
- The existing `coder_optional_response` phase cannot represent required non-blocking triage without introducing a new phase or a cross-cutting protocol change outside the allowed scope.

Any blocker report must identify:

- The exact file and function where the contract fails.
- The specific transition or artifact path that cannot preserve the required behavior.
- The smallest additional contract or state-shape change that would unblock the work safely.
