## Problem Statement

Neal already depends heavily on prompts, but today those prompts are mostly embedded implementation detail rather than a first-class curated system.

That creates several problems:

- role/task prompts are easy to duplicate and drift
- prompt changes are hard to reason about because prompt, schema, and context assembly are not treated as one unit
- new features keep adding prompt text without a stable place to capture reusable engineering-task patterns
- model-specific behavior differences become harder to manage as Neal supports multiple providers
- prompt changes are too often judged by anecdote instead of fixtures and regressions

This is starting to matter more, not less.

The current plan sequence already assumes several prompt-sensitive product surfaces:

- plan authoring and plan review
- execute scope coding and scope review, including meaningful-progress evaluation
- diagnostic analysis and recovery-plan authoring/review
- final whole-plan completion review

Those are not random prompts. They are recurring engineering roles/tasks. Neal should treat them that way.

The goal is not to adopt someone else's full methodology wholesale. The goal is to stop treating Neal's prompt layer as scattered text blobs and instead manage it as a small, explicit, versioned library of curated role/task prompt specifications.

## Goal

Add a curated prompt-spec library to Neal so that recurring engineering roles/tasks are defined as explicit prompt specifications paired with schemas, context assembly expectations, and fixture-based evaluation.

The target behavior after this work:

1. Neal has a small explicit library of role/task prompt specs for its recurring engineering workflows.
2. A prompt spec is more than text: it includes the task contract, schema expectations, and the context it assumes.
3. Prompt changes become reviewable as contract changes rather than ad hoc string edits.
4. Neal can reuse the same curated prompt-spec structure across providers while still allowing model-specific variants when justified.
5. Prompt refinement becomes grounded in fixture-based regression coverage rather than taste alone.

## Relationship To Other Plans

This plan should be executed **after**:

- [01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md)
- [02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md)
- [03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md)

and should be completed **before** the later adjudicator refactor in:

- [05_NEAL_LOOP_ENGINE_REFACTOR_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/05_NEAL_LOOP_ENGINE_REFACTOR_PLAN.md)

The sequencing matters:

- the product plans define the real role/task surfaces Neal needs
- this plan turns those surfaces into stable prompt-spec contracts
- the prompt-spec layer should therefore stabilize first
- the adjudicator refactor can then consume those prompt specs instead of refactoring around scattered prompt strings

This plan is therefore a prompt-contract/productization step that should precede, and feed into, the adjudicator refactor rather than compete with it.

## Desired Contract

After this implementation:

1. Neal has an explicit prompt-spec library for recurring engineering roles/tasks.
2. Each prompt spec defines, at minimum:
   - role/task identity
   - prompt content or prompt-builder inputs
   - required context inputs
   - expected structured output schema linkage
   - provider/model-specific variants when necessary
3. Neal's prompt builders compose from that library rather than embedding all role/task guidance inline.
4. Prompt specs can be exercised against fixture inputs without needing full live runs.
5. Prompt-spec regressions are visible in tests and review artifacts.

## Non-Goals

This plan should not:

- adopt a whole external methodology such as mandatory TDD, worktrees, or subagent-first execution
- replace Neal's orchestration phases, transitions, or state model
- turn every prompt into a fully generic template system
- optimize prompts purely for one provider at the expense of the other
- build a large prompt marketplace or user-facing plugin system in the first version

## Why This Is Worth Doing

There is already a real concept in the ecosystem of curated prompts for engineering roles/tasks.

Examples include:

- Superpowers' skills for brainstorming, writing plans, executing plans, code review, debugging, and verification-before-completion
- Anthropic's guidance that persistent agent instructions should be treated as prompts that are refined over time
- OpenAI's guidance that agent prompts, schemas, and evaluations should be developed together rather than as isolated strings

Those sources are useful as inputs, but Neal should not import them wholesale. Neal has its own orchestration contract.

The right move is:

- borrow proven prompt patterns
- encode them as Neal-specific prompt specs
- keep them aligned to Neal phases and schemas
- evaluate them with Neal fixtures

## Prompt-Spec Model

The first version should treat a prompt spec as a small explicit contract, not just a text snippet.

At minimum, a prompt spec should capture:

- `id`
- `role`
- `purpose`
- `requiredContext`
- `schemaTarget`
- `baseInstructions`
- optional provider/model-specific overrides
- optional evaluation notes / linked fixtures

The first version does not need a heavy declarative DSL. A lightweight TypeScript-backed structure is fine as long as the contract is explicit and testable.

Scope 1 should make these fields concrete, not just name them:

- `baseInstructions` should be typed either as a rendered instruction string or as a small prompt-builder function contract with explicit inputs
- `requiredContext` should be typed as an explicit context-shape contract, not just prose documentation
- `schemaTarget` should identify the concrete parser/schema surface the spec is expected to satisfy

## Initial Role/Task Set

The first version should cover the recurring Neal surfaces that are clearly role/task shaped:

- `plan_author`
- `plan_reviewer`
- `scope_coder`
- `scope_reviewer`
- `diagnostic_analyst`
- `recovery_plan_author`
- `recovery_plan_reviewer`
- `completion_coder`
- `completion_reviewer`

Meaningful-progress should be treated differently in the first version:

- today it is a capability layered onto `scope_reviewer`, not a fully separate prompt surface
- the first version of this plan should therefore model meaningful-progress review as a capability/variant of `scope_reviewer`
- if Neal later splits it into its own distinct prompt surface, that can be represented as its own prompt spec then

The important part is to start from the real Neal roles and prompt surfaces that currently exist rather than generic prompt categories.

## Provider Strategy

The first version should assume:

- one shared prompt-spec identity per role/task
- provider-specific variants only where behavior demonstrably differs
- the concrete provider divergence surface lives in Neal's provider adapters, especially [openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts) and [anthropic-claude.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/anthropic-claude.ts), not in ad hoc prompt forks scattered through unrelated modules
- provider-specific divergence should be explicit, localized, and justified in code review or fixture results

The default should be shared semantics, not prompt forks by default.

## Evaluation Strategy

Prompt work should not be judged only by intuition.

The first version should add fixture-driven prompt evaluation at the role/task level. That does not require full model eval infrastructure on day one. A lighter-weight first version is enough:

- golden prompt-render tests for required sections and invariants
- fixture inputs representing representative Neal scenarios
- regression tests for known past failures and ambiguity points derived from concrete Neal incidents, existing plan-review regressions, or committed plan/feedback history
- optional captured-output fixtures where that adds value

The purpose is not to prove the model will always behave perfectly. The purpose is to keep prompt-contract drift visible and intentional.

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Inventory Current Neal Prompt Surfaces And Define Prompt-Spec Contract

- Goal: Make Neal's existing prompt surfaces explicit before refactoring them.
- Expected work:
  - inventory the current prompt builders and classify them by recurring role/task
  - define the prompt-spec contract Neal will use
  - make `baseInstructions`, `requiredContext`, and `schemaTarget` concrete and typed rather than descriptive placeholders
  - decide where the prompt-spec library lives in the codebase
  - identify which current prompts should become the first migrated specs
  - re-read the adjudicator refactor plan and record any ownership-boundary conflicts before choosing the first prompt-spec home
  - keep the contract lightweight and TypeScript-native rather than inventing a heavy configuration language
- Verification: `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`; `test -f docs/PROMPT_SPECS.md || test -f src/neal/prompts/README.md`
- Success Condition: Neal has an explicit prompt-spec contract, an inventory mapping current prompt surfaces to target role/task specs, and a checked-in artifact that records that inventory and contract.

### Scope 2: Add Prompt-Spec Library And Migrate Planning-Side Prompts First

- Goal: Prove the prompt-spec model on the clearest role/task surfaces before touching execute-mode prompts.
- Expected work:
  - create the prompt-spec library module(s)
  - migrate at least `plan_author` and `plan_reviewer` onto the new structure
  - keep plan prompt semantics unchanged unless a migration requires a targeted clarification
  - keep schema linkage explicit so prompt spec and expected output contract stay aligned
- Verification note: this scope does not have a perfect automated proof that the new library is actually consumed; correctness here depends partly on code review and prompt-render assertions rather than a single structural gate
- Verification: `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Planning-side prompt builders compose from explicit prompt specs rather than ad hoc embedded strings.

### Scope 3: Add Fixture-Based Prompt Regression Coverage

- Goal: Make prompt changes reviewable and testable as contract changes.
- Expected work:
  - add fixture-backed tests for migrated prompt specs
  - cover required rendered sections, structural invariants, and at least a few known ambiguity cases
  - include regressions for prompt-shape issues Neal has already encountered, such as execution-shape declaration requirements and plan-review role clarity
  - keep these tests deterministic and independent of live provider calls
- Verification: `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`; `test -d test/fixtures/prompts`
- Success Condition: Prompt-spec regressions are visible in deterministic tests rather than only through live runs.

### Scope 4: Migrate Execute-Mode Review And Progress-Sensitive Prompts

- Goal: Extend the prompt-spec system to Neal's heavier execution roles.
- Expected work:
  - migrate `scope_coder` and `scope_reviewer`
  - represent meaningful-progress review as an explicit capability/variant of `scope_reviewer` rather than inventing a separate role prematurely
  - keep execute-mode prompt semantics and schema bindings explicit
  - avoid folding transition or orchestration semantics into prompt specs
- Verification note: like Scope 2, this scope relies partly on review judgment that the migrated execute-mode prompt builders actually compose from explicit prompt specs rather than merely coexisting with them
- Verification: `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Execute-mode coding/review prompts use the same prompt-spec discipline without absorbing orchestration logic.

### Scope 5: Migrate Diagnostic And Completion Prompt Surfaces

- Goal: Ensure the newer, more specialized Neal flows also benefit from prompt-spec discipline.
- Expected work:
  - migrate `diagnostic_analyst`
  - migrate `recovery_plan_author` and `recovery_plan_reviewer`
  - migrate `completion_coder` and `completion_reviewer`
  - keep provider-specific differences localized if the newer flows need them
- Verification note: keep `test/orchestrator.test.ts` in scope only to the extent that diagnostic-recovery and final-completion prompt wiring is still asserted there once [02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/02_NEAL_DIAGNOSTIC_RECOVERY_PLAN.md) and [03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/03_NEAL_FINAL_COMPLETION_REVIEW_PLAN.md) have landed; if those tests do not exercise prompt-surface wiring, narrow verification accordingly during implementation
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal's diagnostic and final-completion flows use prompt specs instead of bespoke inline prompt text.

### Scope 6: Document Prompt-Spec Usage And Align With The Adjudicator Direction

- Goal: Make the new prompt-spec layer legible to future contributors and compatible with the adjudicator refactor.
- Expected work:
  - document how prompt specs relate to schemas, context assembly, and adjudication specs
  - explain when provider-specific variants are appropriate
  - document how new roles/tasks should be added
  - keep the prompt-spec layer clearly distinct from orchestration transitions and state handling
- Verification: `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm typecheck`; `test -f docs/PROMPT_SPECS.md || test -f src/neal/prompts/README.md`
- Success Condition: Future Neal features have a clear, disciplined place to add new role/task prompt specs without scattering prompt logic again, and the checked-in documentation explains that relationship explicitly.

## Guardrails

The first version should include these guardrails:

1. Neal owns phases, transitions, state, and recovery semantics; prompt specs do not.
2. Prompt specs are role/task-local; they should not become hidden global methodology triggers.
3. Schema linkage must stay explicit; a prompt spec without a clear output contract is incomplete.
4. Provider-specific variants should be added only when shared wording demonstrably fails or becomes misleading.
5. The first version should not import external workflow assumptions such as mandatory worktrees, mandatory TDD, or mandatory subagent dispatch.
6. Prompt specs should be evaluated with fixtures and deterministic rendering tests before relying on live runs alone.
7. This plan should not prematurely choose a permanent ownership boundary that contradicts the later adjudicator refactor; any such boundary decision must be recorded explicitly in Scope 1.

## Artifact Requirements

The first version should produce at least these durable artifacts:

- a prompt-surface inventory document or code-local README identifying the role/task set and migrated prompt specs
- fixture files under `test/fixtures/prompts/` for the migrated roles
- deterministic prompt-render tests that consume those fixtures
- documentation describing how prompt specs, schemas, and context assembly relate

If helpful, a document such as `docs/PROMPT_SPECS.md` or `src/neal/prompts/README.md` is an appropriate home for this material.

## Verification Strategy

Minimum verification for the full implementation:

1. Deterministic tests for rendered prompt-spec structure on migrated roles.
2. Regression coverage for at least a few known prompt ambiguity failures Neal has already encountered.
3. Existing plan/execution tests continue passing after prompt-surface migration.
4. Typecheck coverage proving the prompt-spec contract and schema linkage remain coherent.
5. Checked-in prompt fixtures under `test/fixtures/prompts/`.
6. Documentation explaining how future Neal features should add or extend prompt specs.

## Acceptance Criteria

This plan is complete only when all of the following are true:

1. Neal has an explicit prompt-spec library for recurring engineering roles/tasks.
2. At least planning, execute review, diagnostic, and completion prompt surfaces have migrated onto that structure.
3. Prompt specs are explicitly linked to schemas and required context.
4. Provider-specific variants are possible but localized and not the default.
5. Prompt-spec regressions are visible in deterministic tests and fixtures.
6. The prompt-spec layer is documented and clearly separated from orchestration/state semantics.
