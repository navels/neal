## Execution Shape

executionShape: multi_scope

## Goal

Make derived-plan recovery in `neal --execute` use the same Neal-executable plan pipeline as top-level `neal --plan`, while also making that shared pipeline more tolerant and less wasteful when a plan is substantively good but fails Neal's strict markdown contract in minor, recognizable ways.

This should not weaken the core execution-shape contract introduced by [`plans/NEAL_PLAN_EXECUTION_READINESS_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/plans/NEAL_PLAN_EXECUTION_READINESS_PLAN.md). The goal is:

- keep explicit `executionShape`
- keep machine-checkable execution queues
- make derived plans use the same canonical plan format and review pipeline as top-level plans
- reduce review churn caused by trivial structural mismatches
- avoid burning derived-plan review budget on shapes Neal could normalize or explain more clearly

The current failure mode is now concrete:

- reviewer judges the derived plan as well-scoped and ready
- structural validation rejects equivalent-but-not-literal queue formatting
- Neal spends plan-review rounds on markdown repair instead of execution judgment
- derived-plan recovery can block even though the execution target remains viable

That is a tooling problem, not a planning-quality problem.

The highest-value root fix is prompt unification. Today the shared validator is already being used for both top-level and derived-plan review; the main mismatch is that the derived-plan prompt still teaches a different document shape than the validator expects.

## Desired Contract

After this change:

1. Neal continues to require explicit `executionShape` and a parseable execution queue for `multi_scope` plans.
2. Neal accepts, if still justified after prompt and pipeline alignment, a small set of equivalent queue shapes that are common in human-authored and agent-authored derived plans.
3. Derived plans are authored, validated, normalized, and reviewed as the same document type as top-level plans; the only difference is execution context, not markdown schema.
4. When Neal can deterministically normalize a derived plan into the canonical contract, it should do so before spending reviewer-plan budget on avoidable structure findings.
5. When Neal still cannot accept the structure, it should emit precise, low-ambiguity guidance showing the exact accepted shape.
6. Derived-plan recovery should fail for real planning problems, not for superficial markdown shape drift.

## Non-Goals

This plan should not:

- remove the `## Execution Shape` requirement
- allow vague or unordered multi-scope plans
- maintain a separate legacy markdown schema for derived plans
- replace reviewer judgment with parser heuristics
- silently reinterpret materially ambiguous plans
- broaden acceptance to arbitrary markdown formats

## Current Gap

Today [`src/neal/plan-validation.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/plan-validation.ts) requires literal structure:

- `## Execution Shape`
- `executionShape: one_shot|multi_scope`
- `## Execution Queue`
- `### Scope N:`
- `- Goal:`
- `- Verification:`
- `- Success Condition:`

That contract is appropriate as Neal's canonical shape. The gap is that the surrounding system does not handle near-miss plans well, especially in split-plan recovery:

- derived plans already hit the shared validator during review, but their prompt contract still diverges from the top-level planning prompt
- the coder prompt for derived plans still emphasizes older sections like `Ordered Derived Scopes`
- semantically equivalent scope lists like `1. Scope 6.6A` are rejected instead of normalized
- the reviewer may say the plan is ready while the validator still blocks
- the operator sees plan-review churn that looks like substantive disagreement, when it is really parser rigidity

This is the wrong architecture. A derived plan is still a Neal-executable plan. It should be subject to the same document contract and review pipeline as any other plan-shaped artifact Neal produces.

## Proposed Approach

Use three layers, in this order:

1. pipeline unification
2. deterministic pre-validation normalization
3. clearer structural failure feedback

This preserves a strict canonical artifact shape while making Neal less fragile.

Pipeline unification means:

- derived-plan prompts should teach the same canonical plan shape that top-level `--plan` teaches
- derived-plan review should consume the same canonical or normalized artifact shape that top-level plan review consumes
- any tolerance or normalization should be shared plan infrastructure, not a derived-plan-only parser fork

Normalization is secondary. After prompt unification and shared-pipeline alignment land, Neal should re-evaluate whether the proposed alias set is still justified or whether the remaining failures are rightly invalid plans.

## Normalization Rules

Normalization should be conservative and deterministic. It should only rewrite structures that are obviously equivalent to Neal's required contract.

Allowed normalization targets:

1. execution queue header aliases
- accept `## Ordered Derived Scopes` or `## Derived Execution Queue`
- normalize to literal `## Execution Queue`

2. scope-entry aliases
- accept numbered list lines of the form `1. Scope 6.6A`, `2. Scope 6.6B`
- accept headings of the form `### Scope 6.6A:` for derived plans
- normalize these into canonical sequential entries under the queue

3. field-label aliases inside scope entries
- accept `Goal:`
- accept `Exit criteria:` as `Success Condition:`
- accept `Verification strategy:` or `Verification:` as `Verification:`
- normalize them into canonical bullet labels

4. derived-scope labels
- preserve user-facing labels like `6.6A` in prose, but normalize queue numbering to Neal's required contiguous execution order:
  - `### Scope 1: Migrate cartridge-data-inputs to the native base`
  - automatically retain the original derived label in the normalized body, for example `- Goal: Execute former derived scope 6.6A by ...`

Normalization must not guess across ambiguity. If the document cannot be mapped one-to-one into Neal's canonical queue, validation should still fail.

## Where Normalization Applies

Normalization should apply only in planning contexts where Neal owns the artifact lifecycle:

- top-level `neal --plan`
- derived plans emitted via `AUTONOMY_SPLIT_PLAN`

It should run before structural validation and before synthetic plan-structure findings are produced.

It should be implemented as shared plan infrastructure. Derived plans should call into the same normalization and validation path used for top-level planning, not a separate derived-plan-specific code path.

For derived-plan recovery specifically:

- extraction should persist the original coder-authored artifact
- normalization should run in the shared validation path before review
- if Neal persists a normalized artifact, it should do so as a derivative review artifact rather than overwriting the original

The wrapper should persist:

- the original plan artifact as written by the coder
- the normalized artifact actually reviewed and validated by Neal

That keeps auditability intact.

## Artifact Rules

For normalized plans, Neal should preserve both versions:

- original artifact:
  - the exact markdown emitted by the coder
- normalized artifact:
  - a canonical Neal-executable markdown file used for validation and review

For derived-plan recovery, suggested naming:

- original: `DERIVED_PLAN_SCOPE_<n>.md`
- normalized: `DERIVED_PLAN_SCOPE_<n>.normalized.md`

State and review artifacts should clearly indicate when normalization occurred.

## Reviewer Contract

The reviewer should continue judging execution quality, not parser trivia.

That means:

- reviewer prompt should no longer emphasize legacy section names like `Ordered Derived Scopes`
- reviewer should review the normalized plan artifact if normalization succeeded
- structural findings should only surface when normalization could not produce a valid canonical plan

If normalization succeeds, the reviewer should not spend rounds complaining about aliases Neal itself can normalize.

Derived-plan review should therefore be treated as a specialized invocation of the normal plan-review pipeline, not as a separate review product with a different markdown contract.

## Prompt Changes

Update derived-plan prompting in [`src/neal/agents/prompts.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/agents/prompts.ts) so the coder is told to emit the same Neal-executable plan shape that top-level `neal --plan` emits.

The prompt should include a minimal derived-plan template using:

- `## Execution Shape`
- `executionShape: multi_scope`
- `## Execution Queue`
- canonical scope entries with literal `### Scope N:`
- required `- Goal:`, `- Verification:`, `- Success Condition:` bullets

The prompt may still allow richer explanatory sections above or below the queue, but it must make clear that the queue itself is the machine-consumed contract.

If there are derived-plan-specific explanatory sections, they should be additive context only. They must not replace, rename, or compete with the canonical plan sections that Neal validates.

## Validation Behavior

Validation should become a two-stage process:

1. parse and normalize obvious aliases
2. validate the normalized document against the canonical contract

Validation results should include:

- `executionShape`
- whether normalization was applied
- normalized markdown or normalized section data
- concrete errors when canonical validation still fails

Errors should prefer actionable messages like:

- `Found numbered scope list under execution queue; expected canonical scope headings. Neal could not normalize this because scope metadata was incomplete.`
- `Found scope heading but no Verification field for Scope 2.`
- `Found non-canonical derived scope label 6.6A; normalized queue numbering requires an unambiguous title per scope.`

## Notification and Review-Churn Behavior

When Neal normalizes a plan successfully, it should record that fact in artifacts and optionally in the run log, but it should not notify the operator as if a blocker occurred.

When Neal cannot normalize a plan, the first blocking finding should clearly say this is a structural-contract failure, not a substantive review rejection.

For derived-plan recovery specifically, this should reduce false "review did not converge" outcomes caused by parser drift.

Because derived plans should use the same pipeline as top-level plans, any improvement here should benefit both flows unless there is a deliberate reason to scope behavior differently.

Review metadata must make clear which artifact was actually evaluated. If the original extracted artifact and a derivative normalized artifact both exist, the run artifacts should explicitly identify the reviewed artifact so the operator does not have to infer the distinction.

## Implementation Surface

- [`src/neal/agents/prompts.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/agents/prompts.ts)
  - make derived-plan prompts reuse the same canonical plan contract taught by top-level planning prompts
  - remove stale emphasis on legacy derived-plan section names
- [`src/neal/plan-validation.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/plan-validation.ts)
  - add shared normalization pass
  - validate normalized shape
  - return normalization metadata
- plan-review integration in orchestrator / plan-review flow
  - ensure derived-plan review and top-level plan review both consume the same normalization and validation path
  - validate normalized artifact
  - synthesize structure findings only after normalization fails
  - persist original and normalized artifacts
- tests
  - validator normalization cases
  - derived-plan review-loop cases
  - artifact persistence cases

## Risks

1. Over-normalization
- Neal could accidentally reinterpret an ambiguous plan as a concrete queue.
- Mitigation: normalize only exact recognized aliases and preserve failure-by-default outside that set.

2. Audit confusion
- Operators may not know which artifact was actually reviewed.
- Mitigation: persist both artifacts and reference the normalized artifact explicitly in review metadata.

3. Prompt/validator drift
- Prompt says one thing, validator accepts another.
- Mitigation: keep a single canonical template in prompt text and pin it with regression fixtures.

4. Shared-pipeline drift
- Derived plans could continue evolving as a special-case format even after top-level plans have standardized.
- Mitigation: treat the canonical plan contract as shared infrastructure and remove legacy derived-plan-only schema guidance.

## Verification Strategy

Minimum verification:

- `pnpm typecheck`
- validator tests for:
  - canonical one-shot plans
  - canonical multi-scope plans
  - derived-plan aliases that should normalize cleanly
  - one-shot plans that become queue-bearing after alias normalization still fail validation
  - ambiguous plans that must still fail
- plan-review loop tests showing:
  - normalization occurs before synthetic structure findings
  - top-level plan review and derived-plan review both exercise the same normalization and validation path
  - reviewer sees normalized artifact when available
  - derived-plan recovery does not burn rounds on purely normalizable queue shapes
- artifact tests confirming original and normalized plan artifacts are both persisted and clearly linked
- normalization tests confirming derived-label renumbering preserves an explicit mapping from original labels like `6.6A` to canonical queue numbering

## Execution Queue

### Scope 1: Unify the canonical plan contract across top-level and derived plans
- Goal: Update plan and derived-plan prompts so Neal teaches one shared Neal-executable plan shape, and remove stale prompt language that still steers derived-plan coders toward legacy section structures.
- Verification: `pnpm typecheck`; targeted prompt tests or snapshot coverage for plan and derived-plan prompt builders; inspect the prompt text to confirm the same canonical plan template is presented in both contexts and legacy-only section guidance is removed or demoted.
- Success Condition: The coder prompt for both `--plan` and `AUTONOMY_SPLIT_PLAN` clearly presents the same canonical Neal-executable queue shape, with any derived-plan-specific instructions limited to contextual constraints rather than alternate document structure. This scope should be treated as the primary fix, because it addresses the current source of most near-miss derived plans.

### Scope 2: Complete shared review-path alignment for top-level and derived plans
- Goal: Make the shared plan-review path explicit and consistent for both top-level plans and derived plans, so both flows consume the same canonical-or-normalized artifact shape, synthesize structural findings the same way, and record clearly which artifact was reviewed.
- Verification: `pnpm typecheck`; plan-review and derived-plan tests proving both flows exercise the same validation and structural-finding path; artifact tests confirming review metadata identifies the reviewed artifact unambiguously.
- Success Condition: Top-level plan review and derived-plan review behave as the same pipeline with contextual differences only, and there is no remaining ambiguity about which artifact the reviewer actually evaluated.

### Scope 3: Add shared conservative plan normalization if still justified after scopes 1 and 2
- Goal: If prompt unification and shared review-path alignment still leave meaningful near-miss churn, extend [`src/neal/plan-validation.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/plan-validation.ts) with a deterministic normalization pass for a narrow set of equivalent execution-queue aliases and field-label aliases while preserving canonical validation as the final gate.
- Verification: `pnpm typecheck`; direct validator tests covering accepted aliases, preserved failures for ambiguous shapes, exact queue renumbering behavior, one-shot post-normalization rejection behavior, and returned normalization metadata.
- Success Condition: Neal can normalize a narrowly justified set of obvious near-miss queue shapes through shared plan infrastructure, but still rejects ambiguous or incomplete documents with precise errors. If scopes 1 and 2 eliminate the practical need for this tolerance layer, this scope may be reduced or closed out with a documented decision not to expand normalization further.

### Scope 4: Add regression fixtures for real near-miss plan shapes
- Goal: Add fixture documents based on real failure modes, including the ovation-apps style derived plan with numbered scope lines and non-canonical section names, so Neal's tolerance behavior is pinned by tests.
- Verification: `pnpm typecheck`; `pnpm exec tsx --test test/plan-validation.test.ts test/plan-review.test.ts test/orchestrator.test.ts`; fixture-based assertions for both successful normalization and expected hard failures.
- Success Condition: The exact class of structurally near-miss but semantically valid derived plans that triggered avoidable review churn is covered by deterministic regression tests.

## Completion Criteria

This plan is complete when:

1. derived-plan prompts present the canonical Neal queue contract clearly
2. derived plans and top-level plans use the same canonical plan pipeline rather than separate markdown schemas
3. review artifacts make it unambiguous which plan artifact the reviewer actually evaluated
4. Neal can normalize, if still justified after prompt and pipeline unification, a narrow, explicit set of common equivalent queue shapes
5. normalization runs before structural blocking findings are generated
6. reviewers evaluate normalized artifacts when normalization succeeds
7. original and normalized artifacts are both preserved for audit when normalization materially changes the reviewed artifact
8. real-world near-miss derived-plan examples are pinned by regression coverage

When all scopes are complete, end with `AUTONOMY_DONE`.
