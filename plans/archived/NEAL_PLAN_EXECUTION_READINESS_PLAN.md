# Neal Plan Execution-Readiness Plan

## Execution Shape

executionShape: multi_scope

## Goal

Make `neal --plan` produce plans that are not only well-written, but also ready for clean execution by `neal --execute`.

This feature should make execution readiness part of normal plan acceptance. A plan reviewed by `neal --plan` should end in one of two explicit shapes:

- `one_shot`: safe for a single execute scope
- `multi_scope`: requires an ordered execution queue

This implementation itself is not one-shot safe. It changes:

- reviewer structured-output/schema requirements
- coder and reviewer `--plan` prompts
- wrapper-side structural validation
- `--plan` acceptance behavior when structure is missing
- regression coverage for fixture plans

That is enough cross-cutting behavior that it should be implemented in phases.

## Desired Contract

After this change:

1. `neal --plan` must produce a Neal-executable result, not just a stronger design doc.
2. Execution-readiness failures remain ordinary blocking findings handled by the existing plan-response loop.
3. The wrapper additionally rejects malformed plan shape:
   - missing reviewer `executionShape` in structured output is a schema failure
   - missing or invalid plan-document structure becomes a synthetic blocking finding fed into the same loop
4. `multi_scope` plans must contain a machine-checkable execution queue.

## Required Plan-Document Structure

### Execution shape

Accepted plans must contain a literal `## Execution Shape` section with exactly one line:

- `executionShape: one_shot`
- or `executionShape: multi_scope`

Headers and enum values should be matched exactly by the validator.

Example:

```md
## Execution Shape

executionShape: multi_scope
```

### Multi-scope queue

If `executionShape === 'multi_scope'`, the plan must contain a literal `## Execution Queue` section.

The validator should require:

1. a literal `## Execution Queue` header
2. ordered scope entries using literal `### Scope N:` sub-headings
3. positive integer scope numbers that start at `1` and are contiguous in document order
4. for each scope, these required bullets:
   - `- Goal:`
   - `- Verification:`
   - `- Success Condition:`

Header matching should be exact. Bullet-label matching may be case-insensitive. Multi-line bullet content should be accepted as normal markdown continuation text.

A scope heading without all three required bullets is a validation failure.

Minimal accepted shape:

```md
## Execution Queue

### Scope 1: Persist execution shape metadata
- Goal: Add required execution-shape metadata to the plan review result and plan document.
- Verification: `pnpm typecheck`
- Success Condition: The run persists `executionShape` and rejects malformed values.
```

## Authority Model

- the coder declares `executionShape` in the plan document
- the reviewer confirms that declaration or raises blocking findings if the plan does not satisfy its declared shape
- the reviewer structured output must echo the accepted `executionShape`

Failure handling:

- reviewer structured output missing `executionShape` is a schema violation
- plan-document structure mismatches become synthetic blocking findings in the existing plan-response loop

## Neal-Executable Review Dimensions

The reviewer should assess these dimensions explicitly and name the failing dimension in any blocking finding:

1. Scope granularity
- boundaries prevent accidental widening
- one reviewable risk surface per scope when possible
- diffs stay narrow and auditable

2. Verification concreteness
- verification can be executed directly or selected deterministically from repo context
- no vague “test appropriately” language
- success conditions clearly imply `AUTONOMY_SCOPE_DONE` or `AUTONOMY_DONE`

3. Resume safety
- clean stopping points between scopes
- scope ordering remains understandable after interruption
- no hidden staging assumptions

Signals that a plan needs scoping:

- touches orchestration or state-machine behavior
- changes resume semantics
- changes persistence/schema
- spans multiple independent subsystems
- naturally falls into staged rollout checkpoints
- would be risky to validate in one pass

## Wrapper Changes

Implementation surface:

- [`src/neal/agents.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/agents.ts)
  - coder `--plan` prompt
  - reviewer `--plan` prompt
- [`src/neal/plan-validation.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/plan-validation.ts) (new)
  - validate `## Execution Shape`
  - validate `## Execution Queue`
- `--plan` orchestration path
  - persist `executionShape`
  - synthesize blocking findings from structural validation failures
- regression fixtures/tests for representative plan shapes

## Execution Queue

### Scope 1: Require execution shape in plan review output
- Goal: Add `executionShape` as a required part of the reviewer `--plan` structured output, persist it in plan-run state/artifacts, and update coder/reviewer prompts so the coder declares shape and the reviewer confirms it.
- Verification: `pnpm typecheck`; targeted tests covering malformed reviewer output and persisted plan-run metadata; review the prompt text itself as part of this scope because prompt behavior is part of the load-bearing contract.
- Success Condition: The `--plan` review path fails on reviewer outputs that omit `executionShape`, accepted plan runs persist the field, and prompts explicitly implement the coder-declares / reviewer-confirms contract.

### Scope 2: Add structural plan validation
- Goal: Implement [`src/neal/plan-validation.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/plan-validation.ts) to validate the literal `## Execution Shape` section and, for `multi_scope`, the literal `## Execution Queue` structure defined in `Required Plan-Document Structure`.
- Verification: `pnpm typecheck`; direct validator tests for valid one-shot plans, valid multi-scope plans, missing headers, numbering gaps, and missing required bullets.
- Success Condition: The validator deterministically accepts only plans matching the required document contract and returns concrete validation errors naming the offending section or scope.

### Scope 3: Integrate validation into the existing plan-review loop
- Goal: Feed structural validation failures into the normal `--plan` loop as synthetic blocking findings, without introducing a new acceptance phase.
- Verification: `pnpm typecheck`; plan-loop tests showing that structural validation runs after the reviewer returns, malformed plan shape is appended as a synthetic blocking finding with a distinct source tag, and coder response is required before acceptance.
- Success Condition: The wrapper handles structure failures through the same blocking-finding path as reviewer findings, accepted plans require both zero blocking findings and valid plan structure, and the validation timing/source behavior is explicit and tested.

### Scope 4: Add Neal-executable regression fixtures
- Goal: Add fixture plan documents and regression coverage for four representative cases:
  - clearly one-shot
  - clearly risky multi-subsystem
  - ambiguous but salvageable
  - already well-scoped and Neal-executable
- Verification: `pnpm typecheck`; add deterministic fixture markdown files under `test/fixtures/plans/` (or the repo's chosen equivalent) and cover them with automated tests against `plan-validation.ts` and the `--plan` flow; optional live `neal --plan` smoke runs may be added behind an env-gated path but are not required for the main regression suite.
- Success Condition: Prompt/schema/validation changes are pinned by deterministic fixture plans that verify one-shot plans stay one-shot, risky plans become multi-scope, ambiguous plans resolve into a Neal-executable shape, and already good plans pass without churn.

## Review Guidance

Reviewer prompt changes should require:

- execution-readiness as a first-class review dimension
- blocking findings when a risky plan lacks proper scoping
- blocking findings when a declared `multi_scope` plan is poorly shaped for Neal execution
- fast confirmation on the happy path instead of manufactured findings

Coder prompt changes should require:

- explicit choice between one-shot and multi-scope
- declaration of that choice in the plan document
- rewriting broad plans into a Neal-executable queue rather than leaving scoping implicit

## Split-Plan Interaction

Split-plan recovery remains available even for plans previously accepted by `neal --plan`.

That means:

- this feature should reduce, not eliminate, split-plan recovery
- repeated split-plan events across scopes of a plan-vetted run are evidence that plan-time scoping is still insufficient

## Verification Strategy

Minimum verification for the implementation:

- `pnpm typecheck`
- targeted tests for reviewer schema enforcement
- direct validator tests
- plan-loop tests for synthetic blocking findings
- fixture-plan regression coverage

Execution-readiness findings count against the existing plan-review round budget. If this dimension routinely exhausts the budget, raise it deliberately rather than weakening the requirement.

## Completion Criteria

This plan is complete when:

1. `neal --plan` always produces an explicit `executionShape`
2. reviewer output schema enforces `executionShape`
3. `multi_scope` plans are accepted only when they contain a valid execution queue
4. structural failures feed into the existing plan-response loop as blocking findings
5. fixture-plan coverage shows:
   - clearly one-shot plans remain one-shot
   - risky plans are forced into a scoped queue
   - ambiguous plans are resolved into a Neal-executable shape
   - already well-scoped plans pass without unnecessary review churn

When all scopes are complete, end with `AUTONOMY_DONE`.
