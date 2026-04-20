# Neal Adjudicator Refactor Plan

## Problem Statement

Neal's behavior increasingly follows a common conversational pattern:

1. coder produces a structured result
2. reviewer evaluates that result
3. coder responds to findings or requests for revision
4. reviewer reevaluates
5. the loop converges, blocks, or redirects into a different flow

That pattern already appears in multiple places:

- ordinary execute-mode scope work
- ordinary plan rewriting / plan review
- derived-plan review
- consult-like reviewer loops and interactive blocked-recovery response flows
- the implemented meaningful-progress gate
- the implemented diagnostic-recovery recovery-plan flow
- the implemented final whole-plan completion review

But today the codebase still exposes these as a collection of partially parallel workflows with distinct orchestration branches, phase handlers, prompt builders, and schema wiring. Much of the actual variation is not in the conversational loop mechanics, but in:

- which artifact is being produced or reviewed
- which prompt/schema bundle applies
- which convergence rule is used
- which state transition follows a settled result

That means Neal is carrying more orchestration complexity than necessary.

The practical problem is not just code size. It is that new features are too likely to be implemented as:

- "add another special-case phase"
- "add another prompt pair with custom wiring"
- "add another branch in the orchestrator"

instead of as:

- "instantiate the same coder/reviewer adjudicator with a different adjudication spec"

This plan refactors Neal around a more explicit reusable adjudicator model so that future features can be added with less duplicated orchestration.

## Goal

Refactor Neal so that its recurring coder/reviewer interaction pattern is implemented through a shared adjudicator plus mode-specific adjudication specifications, rather than through many partially duplicated orchestration branches.

The target behavior after this work:

1. Neal has an explicit reusable adjudicator abstraction for coder/reviewer adjudication.
2. Existing behavior is preserved.
3. The major loop variants are expressed primarily as adjudication specifications rather than bespoke orchestration wiring.
4. Prompt builders, schema parsers, convergence rules, and transition mappings are cleanly separated.
5. The refactor is grounded in the real needs of:
   - ordinary `--plan`
   - ordinary `--execute`
   - meaningful-progress gating
   - diagnostic-recovery plan review
   - final whole-plan completion review
   - curated prompt-spec ownership and reuse
   - adjacent consult / blocked-recovery flows that must either be explicitly included or explicitly left adjacent in v1

## Relationship To The Other Plans

This plan should be executed **after**:

- [01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/implemented/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md)
- [02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/implemented/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md)
- [03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/implemented/03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md)
- [04_NEAL_CURATED_PROMPT_SPECS_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/implemented/04_NEAL_CURATED_PROMPT_SPECS_PLAN.md)

The reason is straightforward:

- those plans now define and implement the real loop variants this refactor must support
- the prompt-spec plan now defines the prompt ownership boundary and stable role/task prompt contracts this refactor must preserve
- doing this refactor first would force the abstraction to guess at future requirements
- doing it second lets the abstraction be shaped by actual product behavior rather than speculation

So this is an architectural follow-on, not a prerequisite.

## Desired Contract

After this implementation:

1. Neal has a shared adjudicator abstraction for coder/reviewer execution.
2. An adjudication specification can define, at minimum:
   - coder prompt surface reference (at minimum: `PromptSpecId` plus the specific variant/export it resolves to)
   - reviewer prompt surface reference (at minimum: `PromptSpecId` plus the specific variant/export it resolves to)
   - coder output schema / parser
   - reviewer output schema / parser
   - reviewed artifact / context builder
   - convergence rule
   - transition mapping on success / block / revision
3. Existing behavior for `--plan` and `--execute` remains unchanged from the operator's perspective.
4. Meaningful-progress gating, diagnostic-recovery plan review, and final whole-plan completion review fit naturally into the same architectural model rather than requiring ad hoc orchestration branches.
5. The orchestrator becomes smaller, more compositional, and easier to extend.
6. The adjudicator consumes prompt builders and prompt-spec contracts where useful, but does not pull prompt rendering or prompt-spec ownership into the adjudicator layer.

## Non-Goals

This plan should not:

- change the user-facing semantics of `--plan` or `--execute`
- redesign Neal's notification system
- eliminate all explicit phase/state handling
- remove genuinely distinct state transitions when they are semantically necessary
- force every Neal interaction into one identical schema
- redesign the already-landed meaningful-progress, diagnostic-recovery, or final whole-plan completion semantics

## Why This Refactor Is Worth Doing

This refactor is worthwhile if and only if it reduces future feature cost without hiding real differences in behavior.

The point is **not** to pretend everything is "just prompts."

The point is to separate:

- the reusable conversational loop mechanics

from:

- the mode-specific semantics of acceptance, blocking, adoption, and continuation

Done well, this should reduce duplication while still preserving the fact that:

- accepted plan rewrite
- accepted execute scope
- accepted meaningful-progress verdict
- accepted diagnostic recovery plan
- accepted final whole-plan completion verdict

do not all mean the same thing operationally.

The prompt-spec work from plan 04 sharpened the corresponding ownership boundary:

- prompt builders and prompt specs live under `src/neal/prompts/`
- agent round runners in `src/neal/agents/rounds.ts` execute coder/reviewer turns against those builders and schemas
- the orchestrator owns state transitions and phase semantics

This refactor should preserve that split. It should not try to turn prompt specs into an adjudicator DSL or relocate prompt ownership into the new adjudicator layer.

## Architectural Direction

The target architecture should look like:

- shared adjudicator
- mode-specific adjudication specifications
- separate transition/adoption layer

The inventory scope should ground in the current implementation surfaces in:

- `src/neal/agents/rounds.ts` — per-turn coder/reviewer round runners
- `src/neal/orchestrator.ts` — phase handlers and the `phaseHandlers` dispatch inside `runOnePass`
- `src/neal/orchestrator/transitions.ts` — the existing transition layer (`computeNextScopeStateAfterSquash`, `appendCompletedScope`, `adoptAcceptedDerivedPlan`, `transitionPlanReviewWithoutOpenFindings`, etc.)
- `src/neal/orchestrator/split-plan.ts` and `src/neal/orchestrator/notifications.ts` — adjacent transition-layer helpers
- `src/neal/prompts/*.ts` and `src/neal/prompts/specs.ts` — the prompt-contract layer the adjudicator must consume but not absorb

### Ownership split

The shared adjudicator owns:

- coder/reviewer round sequencing
- structured result parsing
- round counting and `review_stuck_window` / reopened-finding detection
- coder-timeout retry (a loop-mechanical retry, not a transition decision)
- event/logging hooks that fire around rounds

The adjudication spec owns:

- coder and reviewer prompt-surface references (resolved from prompt specs, including the variant/export actually used)
- schema builder + parser references (named surfaces from `src/neal/agents/schemas.ts`)
- artifact/context assembly inputs
- convergence predicates
- whether another coder response round is required
- transition keys or next-action signals passed to the transition layer

The transition layer (existing `src/neal/orchestrator/transitions.ts` plus notification helpers) owns:

- notification emission (`notifyScopeAccepted`, `notifyBlocked`, `notifyComplete`, interactive-blocked-recovery notifications) — these must remain in the transition layer, not leak into the adjudicator
- split-plan trigger handling (`AUTONOMY_SPLIT_PLAN` coder marker)
- consult trigger handling and interactive-blocked-recovery entry
- blocked-recovery routing
- `continue_execution` reopen state surgery inside final completion review (new scope number, reset rounds/findings/createdCommits)
- adoption/finalization semantics
- `createdCommits` accumulation and final-commit implications

The prompt-spec layer owns (preserved from plan 04):

- prompt identity and role/task boundaries
- prompt builders under `src/neal/prompts/*.ts`
- prompt-contract metadata and fixture expectations under `test/fixtures/prompts/`
- schema-linkage metadata that remains prompt-local rather than adjudicator-owned

### In-scope vs adjacent flows

Only the recovery-plan review sub-flow of diagnostic recovery belongs in the shared adjudicator model. The diagnostic analysis round and the recovery-plan authoring round are single-coder, single-artifact authoring rounds — there is no reviewer-side response loop to share with the adjudicator. Operator adoption is an out-of-band transition, not a loop. These three remain dedicated state transitions.

Final whole-plan completion review should be treated as a plan-review-adjacent adjudication flow:

- it reuses the same general adjudicator/reviewer-round machinery family as ordinary plan review where practical
- it still keeps execute-mode completion transitions (`accept_complete` finalization, `continue_execution` reopen, `block_for_operator` escalation) outside the adjudicator
- it should not be implemented as an avoidable bespoke reviewer loop that the refactor then has to collapse later

Meaningful-progress is a capability of the execute-review adjudication spec (reusing the `scope_reviewer` prompt spec's `meaningful_progress` variant from plan 04), not its own adjudication spec. Its distinct acceptance consequences (`accept`, `block_for_operator`, `replace_plan`) live in the transition layer.

Interactive blocked recovery and consult-like loops should be handled explicitly in the inventory scope. The first implementation may leave them adjacent if the shared adjudicator contract does not absorb them cleanly yet, but that decision must be recorded explicitly rather than left implicit. Plan 04 deliberately kept `buildConsultReviewerPrompt`, `buildCoderConsultResponsePrompt`, and `buildBlockedRecoveryCoderPrompt` at `src/neal/agents/prompts.ts` as adjacent; that boundary is the honest starting point.

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Lock In Regression Coverage For Behaviors The Refactor Must Preserve

- Goal: Build the safety net the refactor will lean on before any orchestration is moved.
- Expected work:
  - add or update regression coverage for the current load-bearing behaviors:
    - review round counting and `review_stuck_window` / reopened-finding detection
    - coder timeout retry behavior
    - heartbeat and logger event sequencing
    - notification emission order
    - `onDisplayState` callback timing for the TTY footer
    - `shouldStopAfterCurrentScope` firing on both `final_squash → coder_scope` and `final_completion_review → coder_scope` reopen boundaries
    - artifact path structure
    - `createdCommits` accumulation semantics across scopes and final squash
    - prompt-spec / prompt-builder ownership boundaries introduced by plan 04 (consumed via `test/prompt-spec-fixtures.test.ts` and the inventory assertions in `test/review.test.ts`)
  - include at least one regression test per in-scope loop variant that would catch a silent behavior change during the later refactor scopes
  - do not alter orchestration wiring in this scope — coverage only
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm exec tsx --test test/prompt-spec-fixtures.test.ts`; `pnpm typecheck`
- Success Condition: Every load-bearing behavior above has at least one deterministic regression test, and the refactor scopes that follow can be evaluated against that coverage.

### Scope 2: Inventory Loop Variants And Define The Adjudicator Contract

- Goal: Make the current shared coder/reviewer loop shape explicit before refactoring behavior around it.
- Expected work:
  - inventory the current loop variants in the orchestrator and agent-round machinery
  - inventory which current conversational flows are truly in-scope for the first adjudicator extraction versus deliberately adjacent:
    - ordinary `--plan`
    - derived-plan review
    - ordinary execute-mode review
    - meaningful-progress execute review (as a capability on top of ordinary execute review)
    - diagnostic-recovery plan review
    - final whole-plan completion review
    - consult / interactive blocked-recovery flows
  - identify the common steps, inputs, and outputs
  - map each in-scope loop variant to its coder `PromptSpecId` and reviewer `PromptSpecId` so the 04→05 linkage is explicit
  - define the adjudicator contract and adjudication-spec contract without changing behavior yet
  - adopt the same module-load validator pattern used by `src/neal/prompts/specs.ts` so structural drift in adjudication specs fails fast at import
  - make the naming decision visible in the inventory doc: use `adjudicator` and `adjudication spec` (not `loop engine` or `loop spec`)
  - record the baseline metrics this plan binds in Acceptance Criteria #5 (current: `src/neal/orchestrator.ts` 3810 lines, 17 `phaseHandlers` branches) and commit any stricter floors the inventory justifies
  - produce a concrete inventory/direction document at `docs/ADJUDICATOR_INVENTORY.md` or `src/neal/adjudicator/README.md` that lists each loop variant, its inputs/outputs, convergence rule, transition targets, and proposed adjudication-spec mapping
  - keep this grounded in the implemented features rather than speculative future modes
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`; `test -f docs/ADJUDICATOR_INVENTORY.md || test -f src/neal/adjudicator/README.md`
- Success Condition: Neal has an explicit, behavior-preserving contract for shared adjudication execution and mode-specific adjudication specs, with a checked-in inventory artifact and recorded baseline metrics.

### Scope 3: Refactor Plan Review Flows Onto The Shared Adjudicator

- Goal: Prove the abstraction is real by moving the planning-side review flows onto it first.
- Expected work:
  - move ordinary `--plan` plan-review looping onto the shared adjudicator
  - move derived-plan review onto the shared adjudicator where it uses the same planning review machinery
  - preserve existing operator-visible behavior, artifacts, and transitions
  - keep special semantics in the transition layer rather than re-embedding them into the adjudicator
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/prompt-spec-fixtures.test.ts`; `pnpm typecheck`
- Success Condition: Planning-side review flows use the shared adjudicator with no regression in behavior.

### Scope 4: Refactor Execute Scope Review Onto The Shared Adjudicator

- Goal: Move ordinary execute-mode scope/review onto the same shared adjudicator after the planning-side migration proves the abstraction.
- Expected work:
  - move ordinary execute-mode scope/review looping onto the shared adjudicator
  - preserve existing operator-visible behavior, artifacts, notifications, retries, and transitions
  - keep special semantics in the transition layer rather than re-embedding them into the adjudicator
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm exec tsx --test test/prompt-spec-fixtures.test.ts`; `pnpm typecheck`
- Success Condition: Ordinary execute-mode review uses the shared adjudicator with no regression in behavior.

### Scope 5: Fit Meaningful-Progress Gating Into The Same Model

- Goal: Ensure the refactor naturally absorbs the meaningful-progress gate rather than forcing another special branch.
- Expected work:
  - preserve the implemented meaningful-progress feature's in-band execute-mode integration rather than turning it into a separate phase family
  - express meaningful-progress as a capability of the execute-review adjudication spec (reusing the `scope_reviewer` prompt spec's `meaningful_progress` variant from plan 04), not as its own adjudication spec
  - keep its distinct acceptance consequences (`accept`, `block_for_operator`, `replace_plan`) in the transition layer
  - avoid reintroducing ad hoc orchestration just for the meaningful-progress feature
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: The meaningful-progress gate fits the shared adjudicator architecture cleanly as an execute-review capability, not a new adjudication spec.

### Scope 6: Fit Diagnostic-Recovery Plan Review Into The Same Model

- Goal: Ensure diagnostic recovery reuses the same conversational infrastructure where appropriate.
- Expected work:
  - express only the recovery-plan review sub-flow through the shared adjudicator / adjudication-spec architecture
  - keep the diagnostic analysis round, recovery-plan authoring round, and operator adoption step as dedicated non-loop transitions, because these are single-coder single-artifact authoring rounds rather than coder/reviewer loops
  - preserve the distinct implemented state and adoption semantics of diagnostic recovery
  - keep plan-review reuse explicit rather than implicit
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Diagnostic-recovery plan review uses the shared adjudicator architecture without flattening its distinct state semantics.

### Scope 7: Fit Final Whole-Plan Completion Review Into The Same Model

- Goal: Ensure final whole-plan completion review uses the same shared adjudication architecture rather than becoming another bespoke loop.
- Expected work:
  - express the final whole-plan completion review through the shared adjudicator / adjudication-spec architecture
  - preserve its distinct whole-plan context and completion transition semantics
  - keep `accept_complete`, `continue_execution`, and `block_for_operator` consequences in the transition layer rather than the adjudicator itself
  - preserve the `finalCompletionContinueExecutionMax` bounding and cap-reached escalation as transition-layer behavior
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Final whole-plan completion review fits the shared adjudicator architecture without flattening its distinct completion semantics.

### Scope 8: Simplify Orchestrator Branching And Lock In Regression Coverage

- Goal: Capture the payoff of the refactor by shrinking bespoke branching and proving the new architecture is stable.
- Expected work:
  - remove superseded ad hoc loop wiring from the orchestrator
  - simplify branching where adjudication specs now express the variation
  - meet the concrete simplification floors bound in Acceptance Criteria #5
  - add regression tests proving the shared adjudicator preserves existing behavior across loop variants
  - document the adjudicator / adjudication-spec / transition-layer split for future contributors
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm exec tsx --test test/prompt-spec-fixtures.test.ts`; `pnpm typecheck`
- Success Condition: The orchestrator is smaller and clearer, the simplification floors are met, and the new adjudicator architecture is documented and regression-tested.

## Adjudication-Spec Requirements

The first version of the adjudication-spec abstraction should be explicit enough to support the current real use cases without over-generalizing.

At minimum, an adjudication spec should be able to express:

- coder prompt surface reference by prompt-spec identity plus the specific variant/export it resolves to, not just the top-level `PromptSpecId`
- reviewer prompt surface reference by prompt-spec identity plus the specific variant/export it resolves to
- coder result parser (named parser surface from `src/neal/agents/schemas.ts`)
- reviewer result parser (named parser surface from `src/neal/agents/schemas.ts`)
- convergence predicate
- whether another coder response round is required
- transition keys or next-action signals passed to the transition layer

The adjudication-spec module should adopt the same module-load validator pattern already in use by `src/neal/prompts/specs.ts`, so structural drift (e.g., a dangling prompt-surface reference or a parser surface that no longer exists) fails fast at import.

Where practical, the first version should prefer imported, typed references over free-form string keys. Use registry-style string names only where an actual registry boundary is necessary.

It is acceptable if some mode-specific context assembly still lives outside the adjudication spec in v1, as long as the adjudication execution itself is genuinely shared.

## Guardrails

The first version should include these architectural guardrails:

1. Do not start this refactor until meaningful-progress, diagnostic-recovery, and final whole-plan completion review have each been exercised against at least one real execute run **and** each feature's deterministic regression tests pass. If the real-run check is informal, record the run identifier or date in the Scope 2 inventory doc so the precondition is auditable. Any plan amendments that result from operational experience must land before the Scope 2 inventory is considered final.
2. Do not hide real semantic differences in a false abstraction.
3. Keep transition/adoption behavior outside the generic adjudicator. Notifications remain in the transition layer and must not leak into the adjudicator.
4. Prefer a small explicit adjudication-spec interface over a highly abstract, hard-to-follow generic framework.
5. Preserve existing operator-visible behavior during the refactor.
6. Preserve the `runOnePass` callback contract for `onDisplayState` and `shouldStopAfterCurrentScope`. The TTY footer depends on `onDisplayState`. The stop-after-scope behavior depends on `shouldStopAfterCurrentScope` firing on **both** the `final_squash → coder_scope` boundary and the `final_completion_review → coder_scope` reopen boundary (added by plan 03). The adjudicator must not swallow either firing point.
7. Preserve the prompt-spec ownership boundary established by plan 04. The adjudicator may consume prompt builders and prompt-spec metadata, but it must not become the new owner of prompt definitions. Adjacent prompts retained at `src/neal/agents/prompts.ts` (consult-reviewer, consult-response, blocked-recovery) stay adjacent until they are explicitly promoted.

## Verification Strategy

Minimum verification for the full implementation:

1. Regression coverage for ordinary `--plan`.
2. Regression coverage for ordinary execute-mode scope/review/finalization.
3. Regression coverage for meaningful-progress gating.
4. Regression coverage for diagnostic-recovery plan review.
5. Regression coverage for final whole-plan completion review (including `continue_execution` reopen, cap-reached escalation, and the verification-only terminal path).
6. Prompt-spec drift detection stays green via `test/prompt-spec-fixtures.test.ts` and inventory assertions in `test/review.test.ts`.
7. Typecheck and test coverage proving the shared adjudicator preserves behavior across loop variants.
8. Documentation of the adjudicator / adjudication-spec / transition-layer split plus the adjudication inventory produced in Scope 2.

## Acceptance Criteria

This work is complete only when all of the following are true:

1. Neal has a real shared adjudicator abstraction for coder/reviewer adjudication.
2. Ordinary `--plan` and `--execute` flows use that shared adjudicator.
3. Meaningful-progress gating, diagnostic-recovery plan review, and final whole-plan completion review fit the same architecture cleanly. Meaningful-progress is a capability of the execute-review adjudication spec, not a separate adjudication spec.
4. Transition/adoption semantics remain explicit and correct.
5. Scope 2 records the baseline (current: `src/neal/orchestrator.ts` at 3810 lines, 17 `phaseHandlers` branches in `runOnePass`) and Scope 8 meets these explicit simplification floors:
   - `src/neal/orchestrator.ts` line count reduced by at least 20% from the Scope 2 baseline
   - `phaseHandlers` branch count in `runOnePass` reduced by at least 3
   - at least 4 prompt/schema bundles share an adjudication spec family
   - the number of bespoke `run*Phase` orchestrator-level implementations involved in coder/reviewer adjudication is reduced by at least 4
   The structural floors are the primary proof of success. The line-count floor is a secondary sanity check, not the main justification for the refactor. Scope 2 may commit stricter floors but not looser ones.
6. The prompt-spec ownership boundary from plan 04 remains intact. No prompt builders have been pulled into the adjudicator layer, and `test/prompt-spec-fixtures.test.ts` plus the prompt-spec inventory assertions still pass.
7. The adjudicator architecture is documented after the refactor. The Scope 2 inventory doc is updated to reflect the landed state in Scope 8.
