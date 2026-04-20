## Problem Statement

Neal currently has strong review at the scope level, but no distinct final check at the plan-completion boundary.

That creates a real gap:

- each individual scope can be locally correct
- each scope can have green verification and no reviewer findings
- the plan can still land in a state where the overall result is incomplete, mismatched to the plan's stated outcome, or strategically unsatisfying
- Neal can therefore emit `AUTONOMY_DONE` without ever asking "does the finished product, taken as a whole, actually satisfy the completed plan?"
- when the last scope is verification-only and produces no new commit, Neal can still route through ordinary scope review and generate a meaningless empty-diff review pass instead of a real completion decision

This is different from the meaningful-progress problem.

- meaningful-progress asks whether Neal should accept one more scope under the same parent objective
- final completion review asks whether Neal should declare the entire plan complete after the last scope is done

The missing capability is a whole-plan completion gate that runs after all scopes are complete but before Neal emits final completion.

## Goal

Add a final completion review to Neal so that, after the last execution scope finishes, Neal performs one explicit whole-plan review before declaring the plan complete.

The target behavior after this work:

1. After the final scope settles, Neal assembles a whole-plan completion packet.
2. The coder provides a short structured completion summary for the plan as a whole.
3. The reviewer evaluates the completed result against the plan's stated objectives, not just the last scope diff.
4. If the reviewer confirms the plan outcome is complete and coherent, Neal proceeds to normal completion.
5. If the reviewer finds gaps, Neal does not emit `AUTONOMY_DONE`; instead it re-enters execution in a controlled way.
6. If the last scope is verification-only and produces no diff, Neal uses final-completion review directly instead of forcing an ordinary empty-diff scope review.

## Relationship To Other Plans

This plan should be executed **after**:

- [01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md)
- [02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md)

and **before**:

- [05_NEAL_LOOP_ENGINE_REFACTOR_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/05_NEAL_LOOP_ENGINE_REFACTOR_PLAN.md)

The sequencing matters:

- meaningful-progress reduces low-signal churn during execution
- diagnostic recovery gives Neal a structured way to recover when the current execution shape is wrong
- final completion review then ensures the entire completed plan is actually acceptable before finalization
- only after those product semantics are proven should Neal be refactored around a shared adjudicator architecture

## Desired Contract

After this implementation:

1. When Neal reaches the end of the last scope for an execute-mode plan, it does not immediately finalize the run.
2. Instead, Neal performs one explicit final completion review using the full completed-plan context.
3. The coder provides a short structured plan-completion summary.
4. The reviewer remains authoritative and returns a structured final-completion verdict.
5. The first version should support at least these reviewer actions:
   - `accept_complete`
   - `continue_execution`
   - `block_for_operator`
6. `accept_complete` is the only path that may emit `AUTONOMY_DONE`.
7. `continue_execution` reopens execution under the same top-level plan using an explicit new follow-on scope seeded by structured missing-work guidance from the reviewer, rather than forcing manual session surgery.
8. Final completion review artifacts are written to the run directory so the decision is auditable.
9. When the terminal scope has no commit range and no changed files, Neal must not invoke ordinary scope review; it must route directly into final-completion review with verification evidence and whole-plan context.

## Non-Goals

This plan should not:

- replace ordinary per-scope review
- replace the meaningful-progress gate
- replace diagnostic recovery
- require full semantic understanding of arbitrary codebases beyond the existing review model
- redesign plan formats or execution-scope numbering
- add a second independent execution planner

## Why This Is Separate From Meaningful Progress

The two checks operate at different levels:

- meaningful-progress is a rolling, parent-objective convergence gate during execution
- final completion review is a one-time whole-plan gate after execution appears finished

They should not be merged into one verdict because they answer different questions and need different evidence.

## Decision Model

The first version should keep the same authority split Neal already uses elsewhere:

- coder: advisory
- reviewer: authoritative

The coder should not merely say "the plan is done."

The coder should provide a short structured completion summary including:

- `plan_goal_satisfied`
- `what_changed_overall`
- `verification_summary`
- `remaining_known_gaps`

To avoid contradictory completion claims, the first version should commit to parser-level cross-field validation:

- `plan_goal_satisfied` remains boolean in v1
- if `remaining_known_gaps` is non-empty, `plan_goal_satisfied` must be `false`
- if `plan_goal_satisfied` is `true`, `remaining_known_gaps` must be empty

The reviewer then evaluates that claim against:

- the original plan document
- completed scope history
- final repository state / verification context
- any remaining known risks or omissions

## State-Machine Strategy

The first version should use a **dedicated `final_completion_review` phase** inserted after `final_squash` of the last scope and before ordinary completion.

That commitment is the right tradeoff because this step has:

- a different conversational context from ordinary scope review
- a different coder schema
- a different reviewer schema
- different transition semantics
- a once-per-top-level-plan execution frequency

The first version should therefore:

- enter `final_completion_review` exactly once after the last top-level scope settles
- reuse existing coder/reviewer round machinery where practical, but not by flattening this into ordinary scope review
- treat verification-only terminal scopes with empty commit ranges as first-class entries to `final_completion_review`, not as ordinary `reviewer_scope` work
- keep the transition semantics explicit:
  - accepted final review proceeds to ordinary completion
  - rejected final review reopens execution or blocks for operator guidance

## Review Context Requirements

The final reviewer should receive a compact but whole-plan-oriented packet, including at minimum:

- the original plan document
- completed scope summary
- final completion summary from the coder
- final verification summary
- final diff / changed-files summary for the plan as a whole
- any still-open known gaps the coder declared

If the terminal scope is verification-only and the final commit range is empty, the packet should say so explicitly instead of pretending there is a last-scope diff to review:

- `verification_only_completion: true`
- `changed_files_summary: none`
- verification commands that actually ran and whether they passed
- the last non-empty implementation scope / commit for code-context reference

The first version should optimize for signal, not for maximal artifact volume.

## Architectural Reuse Decision

Final-completion review is structurally closer to ordinary plan review than to ordinary scope review: the reviewer is evaluating whether a completed body of work satisfies a stated plan outcome, rather than reviewing a single scope diff in isolation.

The first version should therefore **reuse ordinary plan-review round machinery where practical**:

- reuse the same general reviewer-round execution path and structured review discipline used by plan review
- add whole-plan completion context and completion-specific schemas rather than inventing a wholly bespoke review subsystem
- keep the distinct completion transitions in the execute-mode transition layer

This keeps the implementation aligned with the later adjudicator refactor in [05_NEAL_LOOP_ENGINE_REFACTOR_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/05_NEAL_LOOP_ENGINE_REFACTOR_PLAN.md) without forcing that refactor to clean up avoidable one-off machinery first.

## One-Shot Behavior

The first version should apply the final-completion gate to `executionShape: one_shot` plans as well.

The gate is semantic, not structural:

- a one-shot plan still claims a plan-level goal
- finishing the single scope is not, by itself, proof that the plan outcome is complete

For one-shot plans, the final-completion gate still fires once after the single scope settles and before `AUTONOMY_DONE`.

## Re-Entry Semantics

`continue_execution` is the most sensitive path in this feature and should be specified explicitly.

The first version should behave this way:

- `continue_execution` always creates a new explicit follow-on scope under the same top-level plan rather than reusing or mutating the already-completed last scope
- the reviewer must provide a structured `missing_work` payload when returning `continue_execution`
- that `missing_work` payload becomes the required seed context for the new follow-on scope
- if the original execution queue is already exhausted, Neal appends this follow-on scope after the previously last scope rather than pretending the plan is still complete
- each `continue_execution` follow-on scope counts as an ordinary accepted scope in later history and artifact summaries

To prevent reintroducing unbounded churn:

- add a YAML-backed runtime setting such as `neal.final_completion_continue_execution_max`
- default it to a small fixed value such as `2`
- after that cap is reached for the same top-level plan, Neal must not issue another `continue_execution`; it must route to `block_for_operator` instead

This makes final-completion re-entry a bounded repair mechanism, not a second unbounded execution loop.

## Interaction With Meaningful-Progress Gating

When `continue_execution` reopens execution:

- the reopened follow-on scope remains part of the same top-level plan objective
- meaningful-progress should therefore measure it against the same top-level parent objective history, not treat it as a fresh independent campaign
- a `continue_execution`-driven follow-on scope counts as a normal accepted scope in the meaningful-progress rolling window once accepted

This keeps the two gates aligned:

- meaningful-progress still governs convergence during the reopened execution
- final-completion review still governs whether the whole plan may actually finish

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Add Whole-Plan Completion Summary Plumbing

- Goal: Give Neal enough structured context to review a completed plan as a whole.
- Expected work:
  - add a helper that assembles whole-plan completion context from the plan doc, completed scopes, final changed-file summary, and verification results
  - explicitly model the verification-only terminal case where the last scope has no commit range or changed files
  - define a compact coder completion-summary schema for execute mode with parser-level contradiction checks between `plan_goal_satisfied` and `remaining_known_gaps`
  - keep this separate from ordinary scope-completion payloads
  - avoid expensive or redundant artifact reconstruction where existing run data already exists
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal can deterministically assemble a whole-plan completion packet suitable for a single final review pass.

### Scope 2: Add Coder Final-Completion Summary Contract

- Goal: Require the coder to summarize whole-plan completion explicitly before Neal can declare success.
- Expected work:
  - add the structured coder completion-summary schema
  - enforce that `remaining_known_gaps` and `plan_goal_satisfied` cannot contradict each other
  - update the relevant execute-mode prompt so the coder supplies `plan_goal_satisfied`, `what_changed_overall`, `verification_summary`, and `remaining_known_gaps`
  - keep the output compact and auditable rather than essay-style
  - ensure ordinary non-final scope execution remains unchanged
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal can capture a structured whole-plan completion claim from the coder when execution appears finished.

### Scope 3: Add Reviewer Final-Completion Verdict Before `AUTONOMY_DONE`

- Goal: Make whole-plan completion an explicit reviewer decision rather than an automatic consequence of the last scope finishing.
- Expected work:
  - add a reviewer final-completion verdict schema supporting `accept_complete`, `continue_execution`, and `block_for_operator`
  - require a structured `missing_work` payload whenever the verdict is `continue_execution`
  - provide the reviewer with the whole-plan completion packet rather than just the last-scope context
  - make `accept_complete` the only path that proceeds to ordinary final completion
  - implement this through a dedicated `final_completion_review` phase
  - ensure a terminal verification-only scope with an empty commit range bypasses ordinary `reviewer_scope` and goes straight to `final_completion_review`
  - ensure `continue_execution` reopens execution as a new explicit follow-on scope under the existing top-level plan
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal distinguishes "last scope finished" from "plan is complete" and only finalizes on an explicit reviewer completion verdict.

### Scope 4: Wire Final-Completion Failure Back Into Existing Recovery Paths

- Goal: Ensure a failed final-completion review has controlled consequences instead of leaving the operator with an inconsistent run.
- Expected work:
  - if the reviewer returns `continue_execution`, reopen execution without emitting `AUTONOMY_DONE`
  - bound repeated `continue_execution` cycles with `neal.final_completion_continue_execution_max`
  - if the reviewer returns `block_for_operator`, stop cleanly with an operator-visible explanation
  - keep this compatible with the meaningful-progress and diagnostic-recovery workflows rather than inventing a separate recovery subsystem
  - make the operator-facing message explicit about why final completion was rejected
  - when `block_for_operator` is used because plan-completion strategy is wrong or unclear, explicitly name `neal --diagnose` as one available next step
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal can fail final completion safely and predictably without manual state edits.

### Scope 5: Add Audit Trail And End-To-End Coverage For Whole-Plan Completion

- Goal: Prove the final completion gate is auditable and does not regress ordinary successful runs.
- Expected work:
  - write artifacts that record:
    - coder completion summary
    - reviewer final-completion verdict
    - resulting action
  - add regression tests for:
    - ordinary multi-scope success path leading to `accept_complete`
    - terminal verification-only completion with no diff bypassing ordinary scope review
    - reviewer finding remaining gaps and returning `continue_execution`
    - `continue_execution` requiring structured `missing_work`
    - `continue_execution` being capped and forced to `block_for_operator`
    - reviewer blocking for operator guidance at plan-completion time
    - `executionShape: one_shot` still receiving final-completion review
    - interaction with derived-plan history and completed scope roll-up
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm typecheck`
- Success Condition: Neal has regression-tested, auditable whole-plan completion review that sits cleanly between "last scope finished" and `AUTONOMY_DONE`.

## Prompting Requirements

Prompt updates should make the following explicit:

### Coder

- this is a whole-plan completion summary, not another scope summary
- the coder must state any known remaining gaps explicitly rather than burying them
- the coder must not claim completion if known missing work remains

### Reviewer

- the reviewer is evaluating whole-plan completion, not just the last scope
- the reviewer must compare the completed result against the original plan objectives
- the reviewer should return `continue_execution` only when the remaining work is concrete, bounded, and suitable for one explicit follow-on scope
- when returning `continue_execution`, the reviewer must supply structured `missing_work` guidance rather than prose-only commentary
- the reviewer should use `block_for_operator` when the remaining gap is ambiguous, externally constrained, or needs human direction
- the reviewer must not let repeated `continue_execution` cycles become an unbounded substitute for ordinary plan execution

## Guardrails

The first version should include these guardrails:

1. Final-completion review is execute-mode only.
2. The gate fires exactly once per top-level plan completion attempt; derived plans do not get independent final-completion review.
3. `accept_complete` is the only path that may emit `AUTONOMY_DONE`.
4. A failed final-completion review does not undo already-accepted scopes.
5. `continue_execution` must be bounded by `neal.final_completion_continue_execution_max`.
6. `continue_execution` requires structured reviewer-provided `missing_work`.
7. One-shot plans still receive final-completion review.

## Artifact Requirements

The first version should produce an explicit completion-review artifact such as `FINAL_COMPLETION_REVIEW.md`.

That artifact should persist at minimum:

- coder completion summary
- reviewer final-completion verdict
- resulting action
- any structured `missing_work` payload from `continue_execution`
- whether a `continue_execution` cycle cap contributed to the final action

The artifact should make clear whether the run:

- completed cleanly
- reopened execution
- blocked for operator guidance

## Verification Strategy

Minimum verification for the full implementation:

1. Regression coverage for ordinary multi-scope success leading to `accept_complete`.
2. Regression coverage for `continue_execution` with structured `missing_work`.
3. Regression coverage for `continue_execution` cap enforcement via `neal.final_completion_continue_execution_max`.
4. Regression coverage for `block_for_operator`, including an operator-facing message that names `neal --diagnose` when applicable.
5. Regression coverage for `executionShape: one_shot`.
6. Regression coverage for derived-plan history / completed-scope roll-up in the final completion packet.
7. Typecheck and test coverage proving the final-completion gate sits cleanly between last-scope settlement and `AUTONOMY_DONE`.

## Acceptance Criteria

This plan is complete when all of the following are true:

1. Neal performs an explicit final completion review after the last scope and before `AUTONOMY_DONE`.
2. The coder provides a structured whole-plan completion summary.
3. The reviewer provides a structured authoritative final-completion verdict.
4. `continue_execution` is structured, bounded, and seeded by reviewer-provided `missing_work`.
5. Neal can reopen execution or block for operator guidance instead of finalizing when completion is not credible.
6. The final completion decision is recorded in run artifacts.
7. Ordinary successful multi-scope runs still finalize cleanly when the reviewer accepts whole-plan completion.
8. One-shot plans also pass through the final-completion gate before `AUTONOMY_DONE`.
