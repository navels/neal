# Plan format

Executable neal plan documents follow the format defined here, the canonical
public reference. The validator lives in `src/neal/plan-validation.ts` as
`validatePlanDocument`.
The selected-plan Git contract lives in `src/neal/plan-doc.ts` as
`inspectPlanDocDisposition` and `toPlanDocMetadata`. Scope counting and status
labels come from `getExecutionPlanScopeCount` and
`getCurrentExecutionScopeDescriptor` in `src/neal/scopes.ts`.

Executable plans are instructions for neal's planner/coder/reviewer loop, not
project requirements documents. They should be specific enough that one scope
can be implemented, reviewed, and verified without relying on hidden operator
intent.

## Execution shape

Every executable plan must choose exactly one execution shape. The plan must
include a literal `## Execution Shape` section, and that section must contain
exactly one non-empty line:

- `executionShape: one_shot`
- `executionShape: multi_scope`
- `executionShape: multi_scope_unknown`

Use `one_shot` when the whole task fits in one bounded implementation scope.
Use `multi_scope` when the task has a finite ordered queue of known scopes.
Use `multi_scope_unknown` when neal should repeat one bounded scope template
until a concrete completion rule is satisfied, but the number of iterations is
not knowable when the plan is written.

## One-shot format

`executionShape: one_shot` must not include a literal `## Execution Queue`
section, a literal `## Execution Loop` section, or a standalone
`## Completion Condition` section.

Minimal valid example:

```md
# One Shot

## Execution Shape

executionShape: one_shot

## Objective

Complete one bounded change and verify it.
```

For status display, neal treats a one-shot plan as one known scope. If the
document has a level-one Markdown title, that title can be used as the scope
display title. Otherwise neal falls back to a generic one-scope label.

### `one_shot` is defended through plan refinement, not clamped

An author-declared `executionShape: one_shot` is captured once from the seed
plan document and defended through refinement by both roles' prompts: the
planner is instructed to keep the plan one scope and make the smallest complete
change, and the plan reviewer is instructed to raise a blocking finding if the
refined document declares any other execution shape or adds orchestration
sections. That finding routes through the normal revision loop like any other.

There is deliberately no hard mechanical clamp: if the review loop converges on
a different shape (the reviewer accepts an expansion), neal adopts the refined
document's shape. An earlier version clamped the saved shape back to `one_shot`
unconditionally, which caused non-convergence on complex plans: the planner
could not produce an accurate single-scope plan, so review correctly rejected
it until the round cap failed the run.

This defense applies only to the top-level authored plan. A derived plan
declares and owns its own execution shape. Plans authored `multi_scope` or
`multi_scope_unknown` are unaffected. Refinement may adjust their scope
content as usual.

### Revising a later scope mid-run

Operator guidance during a block can revise a later scope. When a
`neal resume --message` directive calls for changing a scope after the current
one, the coder returns replacement text for that one scope, and neal splices it
into the plan, checks it still parses, and writes it. neal reads the plan fresh
from disk each turn, so the next scope runs against the revised text. The coder
can only revise a scope after the one it's working on, never the current or an
earlier scope, and a consultant-injected directive can't trigger it.

## Multi-scope format

`executionShape: multi_scope` must include a literal `## Execution Queue`
section. It must not include a literal `## Execution Loop` section or a
standalone `## Completion Condition` section.

Inside `## Execution Queue`, use literal scope headings with contiguous numbers
starting at 1:

```md
# Multi Scope

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: First bounded change
- Goal: Implement one bounded slice.
- Verification: `pnpm typecheck`
- Success Condition: The first slice is complete and verified.

### Scope 2: Regression coverage
- Goal: Add focused coverage for the changed behavior.
- Verification: `pnpm test`
- Success Condition: The tests cover the new behavior and still pass.
```

Each scope entry must include these labeled bullets:

- `- Goal:`
- `- Verification:`
- `- Success Condition:`

The queue cannot skip or repeat numbers. neal uses the queue headings to count
known scopes and to show progress labels such as the current scope number and
scope title.

For a concrete in-repo multi-scope plan, see
[../examples/issue-triage-js/PLAN.md](../examples/issue-triage-js/PLAN.md).

## Multi-scope-unknown format

`executionShape: multi_scope_unknown` must include a literal
`## Execution Loop` section with exactly one literal `### Recurring Scope`
entry. It must also include a standalone, non-empty
`## Completion Condition` section. It must not include a literal
`## Execution Queue` section.

Minimal valid example:

```md
# Recurring Scope

## Execution Shape

executionShape: multi_scope_unknown

## Execution Loop

### Recurring Scope
- Goal: Implement one bounded recurring slice.
- Verification: `pnpm typecheck`
- Success Condition: The recurring slice is complete and reviewable.

## Completion Condition

Stop when the explicit completion rule is satisfied.
```

The recurring scope uses the same required bullets as a fixed queue. neal treats
the total scope count as unknown by contract, and status displays the recurring
scope title rather than a finite total.

## Verification and acceptance

A scope should name verification commands that are deterministic and
noninteractive when possible. Examples include typecheck, test, lint, build,
package verification, or a focused smoke command. If a command needs external
state, credentials, network access, or manual setup, call that out in the plan
so neal can distinguish expected manual gates from unexpected blockers.

The success condition should state what must be true after the scope is
complete. It is not a prose summary of the goal. It is the reviewable exit
criterion. Good success conditions mention the changed surface, the expected
behavior or docs state, and the verification evidence required for acceptance.

## Planning normalization

`neal plan` revises the selected plan file in place. It should preserve the
user's product objective while making the document executable by neal and
keeping it practical for a person to review.

Plan mode owns the final execution-shape decision. Its planner/reviewer loop
chooses `one_shot`, `multi_scope`, or `multi_scope_unknown` and records that
choice in the plan's `## Execution Shape` section. An author-declared
`one_shot` remains subject to the defense described above.

The planner inspects the current repository enough to confirm the approach and
identify major dependencies, constraints, and affected subsystems. It adds
moderate-to-high-level implementation detail, scope boundaries, meaningful
verification, and success conditions. It should not try to complete the
implementation in prose. Routine file discovery, exact tests, and local code
choices belong to the execution coder and reviewer.

The plan reviewer checks the approach, major repository constraints, scope
shape, sequencing, verification, and completion conditions. A material omission
that could produce the wrong implementation or make a scope unsafe is a plan
finding. Missing routine implementation detail is not. The refined plan does
not need exhaustive lists of files, symbols, callers, tests, commands, or
assertions.

A repository-wide invariant or global regression guarantee belongs in the plan
only when it is necessary for the requested change to be correct. Otherwise,
the planner narrows or removes it instead of expanding the implementation or
verification scope. The reviewer judges verification against the requested
change rather than requiring complete enforcement of a broader guarantee the
plan introduced itself.

During validation, neal may normalize known legacy plan wording before checking
the final shape. Current normalization can convert legacy queue section
headings to `## Execution Queue`, normalize compatible scope labels to literal
`### Scope N:` headings, and normalize known aliases for the verification and
success-condition bullet labels. Normalization is still bounded by the same
shape rules above. It is not a license to omit the execution shape or required
scope fields.

For `neal plan`, the original selected plan backup is stored under the run
directory at `.neal/runs/<run-id>/PLAN_ORIGINAL.md`. neal does not use a sibling
repository backup directory for that copy.

## Selected plan documents and Git

neal records selected-plan metadata with `inspectPlanDocDisposition` and
`toPlanDocMetadata` from `src/neal/plan-doc.ts`.

A selected plan document is eligible for ordinary Git inclusion only when it is
repo-local, exists, is a regular file, and is not ignored. If that eligible
plan document changes during a run, neal may include it in the final tree using
normal Git staging.

The selected plan document can be the only allowed dirty path at writer-run
start when it is the explicit plan under execution. Dirty work outside that
selected plan still blocks writer-run start and queue continuation.

## Ignored or external plan documents

Ignored plan files, plan files outside the repository, missing paths, and
non-file paths are metadata-only. neal records where they came from, but it does
not force-add them to the repository and does not treat them as package or
source artifacts.

This distinction is useful for ignored local plans under `tmp/` or for plans
stored outside the target repository. Those plans can drive a run, but they
remain operator-local unless the operator intentionally copies their contents
into a tracked document.

## Protocol boundary

neal's terminal control protocol is not Markdown artifact content. Plan files,
derived plans, review notes, recovery guidance, and JSON artifacts should use
their normal schema or prose fields instead of embedding terminal control marker
words. This keeps executable plans portable and prevents transport signals from
being misread as user instructions or repository documentation.
