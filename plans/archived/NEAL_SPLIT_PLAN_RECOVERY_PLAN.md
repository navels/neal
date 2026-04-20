# Neal Split-Plan Recovery Plan

## Goal

Add a first-class Neal recovery path for scopes that are not truly blocked but have proven to be the wrong execution shape.

The intended outcome is:

1. The coder can recognize that the current scope should not continue as currently framed.
2. The coder can emit a derived implementation plan for the same target.
3. The reviewer reviews that derived plan before execution continues.
4. The coder responds to reviewer findings on the derived plan.
5. If the derived plan is accepted, Neal adopts it and continues execution without user intervention.
6. If coder and reviewer cannot converge on a safe derived plan, Neal stops in a real blocked state.

This is distinct from `AUTONOMY_BLOCKED`.

`AUTONOMY_BLOCKED` should still mean:

- external input is required, or
- no safe in-repo path remains.

This new path should mean:

- the target is still viable,
- but the current scope/chunk strategy is invalid and should be replaced.

## Motivation

Neal currently has an execution gap for high-fan-out or otherwise unstable scopes.

Typical failure mode:

1. A scope starts as a plausible single chunk.
2. The coder discovers that the target has much wider blast radius than expected.
3. Continuing the current approach would create widespread breakage, failing tests, or an unreviewable commit.
4. The work is not actually blocked.
5. The right answer is a new staged plan:
   - compatibility shim
   - parallel replacement base
   - consumer migration batches
   - narrower intermediate steps

Today this situation is awkward:

- either the coder keeps forcing a bad approach,
- or declares `AUTONOMY_BLOCKED`,
- or relies on implicit human intervention.

Neal should instead support autonomous plan refresh.

## Non-Goals

This feature should not:

- silently rewrite the top-level user plan in place with no audit trail
- allow recursive infinite replanning
- bypass reviewer scrutiny for the derived plan
- turn normal minor scope adjustments into full replanning events

## New Concept: Split-Plan Recovery

Introduce a new coder terminal outcome for execute scopes:

- `AUTONOMY_SPLIT_PLAN`

Meaning:

- the current scope should stop
- the target is still viable
- a derived implementation plan is attached
- Neal should run a plan-review loop on that derived plan

## Derived Plan Requirements

When emitting split-plan recovery, the coder must provide a derived plan artifact with:

1. Scope replacement rationale
   - why the current scope shape is invalid
   - why this is not a real blocker

2. New strategy
   - the safer migration strategy
   - examples:
     - parallel replacement base
     - compatibility shim
     - consumer migration batches
     - helper extraction before consumer migration

3. Ordered derived scopes
   - concrete chunk sequence
   - each chunk should be reviewable and verifiable

4. Verification strategy
   - focused verification per derived scope
   - full-suite requirements

5. Adoption rule
   - whether the derived plan replaces only the current scope
   - or replaces the remainder of the parent plan from this point forward

The plan must be explicit enough to run through the existing plan-review machinery.

## Marker Precedence

The coder must not use split-plan recovery as an easy substitute for normal scope completion.

Prompt-side precedence rules should be explicit:

1. Prefer `AUTONOMY_SCOPE_DONE` when the current scope produced a coherent, reviewable scope result that should be kept.
2. Prefer ordinary retry/recovery inside the current scope when the current approach is still salvageable.
3. Use `AUTONOMY_SPLIT_PLAN` only when:
   - the current scope shape has proven invalid,
   - the current work-in-progress should not be accepted as the scope result,
   - and the right next step is a replacement plan for the same target.
4. Use `AUTONOMY_BLOCKED` only when the target truly cannot continue safely without external input or no safe in-repo path remains.

This means split-plan recovery is not "scope done with extra steps." It is "discard current scope result and replace the scope with a better plan."

## Work-In-Progress Semantics

When split-plan recovery fires, the default behavior should be:

1. capture the current discarded work-in-progress as an audit artifact
2. restore the working tree to the scope base
3. start the derived plan from a clean state

Recommended artifact:

- `.neal/runs/<run-id>/SCOPE_<n>_DISCARDED.diff`

Reasoning:

- discarding WIP by default preserves scope cleanliness
- the diff is still available for audit and human inspection
- the derived plan is not implicitly coupled to half-finished code

Do not leave discarded WIP live in the tree for the derived plan unless a later version adds an explicit "adopt WIP" path.

Recommended first implementation:

1. capture a full audit artifact that includes:
   - staged changes
   - unstaged changes
   - untracked files
2. if the current scope has created intermediate commits that should be discarded, reset back to the parent scope base commit
3. clean the working tree so derived execution starts from the parent scope base with no residual WIP

In other words, "discard" should mean:

- restore the repository to the parent scope base state

not merely:

- clean the current working tree while leaving intermediate scope commits in place

## Wrapper Flow

### 1. Coder emits split-plan recovery

During `coder_scope` or `coder_response`, the coder returns:

- derived plan markdown
- split-plan marker
- explanation of why the current scope should be replaced

Neal persists:

- current scope snapshot
- derived plan markdown
- split-plan metadata

Suggested artifact path:

- `.neal/runs/<run-id>/DERIVED_PLAN_SCOPE_<n>.md`

Suggested metadata fields:

- `derivedPlanPath`
- `derivedFromScopeNumber`
- `derivedPlanStatus`
- `derivedPlanReviewRounds`
- `replacedByDerivedPlanPath`

### 2. Neal enters derived-plan review mode

Neal should then run the existing plan-review loop using the existing plan phases and handlers, scoped to the derived plan.

Recommended implementation:

- do not add a parallel phase family like `reviewer_split_plan`
- instead reuse:
  - `coder_plan`
  - `reviewer_plan`
  - `coder_plan_response`
  - `coder_plan_optional_response`
- with derived-plan metadata on state indicating:
  - this is a split-plan review flow
  - which parent scope it came from
  - where adoption should return

The reviewer should review the derived plan exactly as it would review a top-level `--plan` artifact:

- scope quality
- risk
- verification adequacy
- hidden drift risk
- whether the new sequence actually addresses the failure mode

### 3. Coder responds to plan-review findings

The coder gets the same structured response loop used in plan review today:

- fix the plan
- reject a finding with rationale
- defer non-blocking issues if acceptable under the current policy

### 4. Neal decides

If the derived plan is accepted:

- Neal adopts it
- current execution continues under the derived scope sequence

If the derived plan review fails to converge:

- Neal enters a real blocked state
- the blocked reason should explicitly say:
  - split-plan recovery failed to converge

## Adoption Semantics

This is the most important design choice.

Recommended first behavior:

- the derived plan replaces the current scope only
- not the entire remaining campaign

Why:

- safer
- narrower state transition
- easier to reason about
- less surprising to the user

That means:

1. top-level execute plan remains the parent plan
2. current scope is replaced with a derived sub-plan
3. after the derived sub-plan completes, Neal returns to the parent plan selection flow

After derived plan completion, Neal should treat the derived completion as the completion of the replaced parent scope.

That means:

- do not jump back into the stale parent phase directly
- do not resume the abandoned parent scope body
- instead continue exactly as if the parent scope had completed successfully and the next parent scope selection can begin

For audit and retrospective purposes:

- each derived sub-scope should get its own scope-history entry
- the replaced parent scope should also get a rolled-up entry

Recommended roll-up rule:

- the parent scope's final commit and final review artifacts should resolve to the last accepted derived sub-scope
- the parent scope entry should also point at the derived plan artifact that replaced it

If later needed, broader replacement can be added explicitly.

## Reviewer Gate

The derived plan should not be auto-adopted without review.

Reviewer responsibilities:

- verify the current scope really is the wrong shape
- confirm the new sequence is safer
- ensure the derived plan is concrete enough to execute
- reject vague “I’ll break it into smaller chunks” plans that do not define the chunks

Reviewer findings may explicitly recommend split-plan recovery when the reviewer sees that the current scope shape is wrong, but only the coder may emit the split-plan marker.

That recommendation should ride through the existing review-finding pipeline into the next coder turn. Do not invent a separate split-plan recommendation schema in the first version unless implementation proves the existing finding shape is insufficient.

This gate is the main reason the feature can be trusted without user approval on every split.

## When Split-Plan Recovery Is Allowed

Allow it only when all of the following are true:

1. The target is still in scope for the parent plan.
2. The coder has already attempted reasonable in-repo recovery.
3. The problem is execution shape, not missing external input.
4. The coder can propose a concrete safer sequence.

Examples that should qualify:

- high-fan-out base component refactor needs a parallel `*-glimmer` base
- broad runtime migration needs staged consumer batches
- configuration migration needs infra-first and call-site phases
- helper extraction is required before direct target cleanup

Examples that should not qualify:

- “the work is large” with no concrete replacement strategy
- “tests are failing” without diagnosis
- external dependency or product decision needed

These conditions should not live only in prompts. The wrapper should enforce the structural guardrails described below.

## Guardrails

Add these limits in the first version:

1. At most one split-plan recovery per active scope.
2. Derived plan depth limit of one.
   - no recursive derived plans inside derived plans
3. Derived plan must be review-accepted before execution continues.
4. Derived plan review uses a separate, lower round budget.
5. If derived plan review cannot converge within that lower budget, block.

These guardrails must be wrapper-enforced, not prompt-only.

Recommended state:

- `splitPlanCountForCurrentScope: number`
- `derivedPlanDepth: number`
- `maxDerivedPlanReviewRounds: number` with an initial default of `5`

Required wrapper behavior:

- reject `AUTONOMY_SPLIT_PLAN` if `splitPlanCountForCurrentScope >= 1`
- reject `AUTONOMY_SPLIT_PLAN` if `derivedPlanDepth >= 1`
- treat either rejection as a real blocked/error condition with explicit explanation

## State Model Changes

Add explicit state for split-plan recovery.

Likely additions to session state:

- `derivedPlanPath?: string | null`
- `derivedFromScopeNumber?: number | null`
- `derivedPlanStatus?: 'pending_review' | 'accepted' | 'rejected' | null`
- `parentPhaseBeforeDerivedPlan?: OrchestrationPhase | null`
- `splitPlanCountForCurrentScope?: number`
- `derivedPlanDepth?: number`
- `maxDerivedPlanReviewRounds?: number`

Do not add a second parallel set of split-plan review phases unless reuse of the existing plan-review phases proves impossible.

`parentPhaseBeforeDerivedPlan` is probably not needed under the current adoption semantics. Only add it if implementation proves that a resumed in-flight derived-plan review needs it for state restoration.

## Derived Scope Numbering

To keep audit trails coherent, derived scopes should have stable sub-scope identifiers tied to the replaced parent scope.

Recommended first scheme:

- parent scope `5`
- derived scopes `5.1`, `5.2`, `5.3`

This can be represented as strings in artifacts even if internal counters remain numeric.

The important property is:

- derived work is visibly attached to the replaced parent scope
- completed scope history remains understandable

## Prompting Changes

### Coder execute prompt

Add explicit guidance:

- if the current scope proves to be the wrong execution shape but the target is still viable, do not force the current approach and do not emit `AUTONOMY_BLOCKED`
- instead emit split-plan recovery with a concrete derived plan
- prefer `AUTONOMY_SCOPE_DONE` whenever a coherent scope result should be kept
- use split-plan only when the current scope result should be discarded and replaced

### Reviewer derived-plan review framing

Use the existing reviewer plan-review prompt, but add derived-plan-aware framing.

Review questions should include:

- does the derived plan actually solve the failure mode
- is the new sequence concrete enough
- is the blast radius reduced
- is verification sufficient
- is this truly not a blocker

## Artifacts and Audit Trail

Preserve all of this in the run directory:

- original parent plan
- derived plan artifact
- discarded WIP diff artifact
- derived plan review transcript
- final accepted derived plan if revised
- scope history showing that the current scope was replaced

Recommended scope-history linkage:

- parent scope:
  - `replacedByDerivedPlanPath: string | null`
- derived sub-scope entries:
  - `derivedFromParentScope: string | null`

This needs to be auditable later.

## Resume Behavior

`neal --resume` must resume split-plan recovery correctly.

Cases:

1. paused during derived-plan review
   - resume back into `reviewer_plan`
   - with derived-plan metadata indicating split-plan review flow

2. paused during coder response to derived-plan findings
   - resume back into `coder_plan_response`
   - with derived-plan metadata indicating split-plan review flow

3. accepted derived plan but interrupted before execution restart
   - resume into the first execution phase under the derived plan
   - using the first derived sub-scope identifier for the replaced parent scope

## Notifications

Suggested notifications:

- when split-plan recovery begins:
  - `[neal] PLAN.md: scope N split into derived plan; reviewing`

- when derived plan is accepted:
  - `[neal] PLAN.md: derived plan accepted for scope N`

- when split-plan recovery fails:
  - `[neal] PLAN.md: blocked: derived plan review did not converge`

## Verification

Implementation verification should include:

1. Synthetic run where coder emits split-plan recovery and reviewer accepts it.
2. Synthetic run where reviewer finds blocking issues in the derived plan and coder resolves them.
3. Synthetic run where derived-plan review fails to converge and Neal enters blocked state.
4. Resume coverage for interrupted derived-plan review phases using:
   - `reviewer_plan` + derived-plan metadata
   - `coder_plan_response` + derived-plan metadata
5. Artifact verification that derived plan files and review history are persisted correctly.

## Recommended Implementation Order

1. Define state model, discarded-WIP semantics, and guardrail counters.
2. Add split-plan marker handling in coder scope/result parsing.
3. Persist derived plan artifact, discarded diff artifact, and metadata.
4. Reuse existing plan-review loop for derived plan review rather than adding parallel phases.
5. Add adoption semantics to continue execution under accepted derived plan.
6. Add resume support.
7. Add notifications.
8. Add end-to-end sandbox validation with a synthetic high-fan-out scenario.

## Scoped Execution Queue

Do not implement this feature in one pass. The state-machine and resume risk is too high.

Implement it in these scopes:

### Scope 1: Split-plan detection and persistence only

Goal:

- recognize `AUTONOMY_SPLIT_PLAN`
- persist the derived plan artifact
- capture discarded WIP artifact
- enforce hard split-plan guardrails
- stop in a visible paused/blocked recovery state rather than continuing automatically

Include:

- marker parsing
- discarded-WIP capture
- reset to parent scope base
- `splitPlanCountForCurrentScope`
- `derivedPlanDepth`
- `maxDerivedPlanReviewRounds`
- run-dir artifacts

Do not include:

- derived plan review loop
- derived plan adoption
- execution continuation under derived scopes

Success condition:

- Neal can safely stop after split-plan emission with artifacts and state preserved
- no stale WIP remains in the tree

### Scope 2: Derived plan review loop reuse

Goal:

- run the derived plan through the existing plan-review phases
- let reviewer and coder converge on the derived plan

Include:

- reuse of `coder_plan`, `reviewer_plan`, `coder_plan_response`, and optional plan response phases with derived-plan metadata
- separate `maxDerivedPlanReviewRounds`
- accepted/rejected derived-plan state

Do not include:

- automatic execute-flow adoption after acceptance
- parent-scope completion roll-up

Success condition:

- Neal can review a derived plan and persist acceptance or rejection without continuing execution yet

### Scope 3: Adopt accepted derived plan into execute flow

Goal:

- continue execution under the accepted derived plan
- treat derived completion as completion of the replaced parent scope

Include:

- derived sub-scope numbering
- parent rolled-up scope entry
- sub-scope history entries
- parent final commit/review roll-up from the last accepted derived sub-scope
- post-derived return to normal parent-plan selection flow

Do not include:

- deeper retrospective polish beyond what is required for correct audit history

Success condition:

- a split-plan run can continue autonomously after plan acceptance and complete the replaced scope correctly

### Scope 4: Resume, notifications, and audit polish

Goal:

- make the feature operationally safe under interruption

Include:

- resume into `reviewer_plan` + derived-plan metadata
- resume into `coder_plan_response` + derived-plan metadata
- resume after accepted derived plan but before execution restart
- notification copy for split-plan start, acceptance, and failure
- artifact/report linkage polish

Success condition:

- interrupted derived-plan review and adoption flows resume correctly and remain auditable

## Success Criteria

This feature is successful when:

1. Neal no longer has to treat “first approach too disruptive” as a blocker.
2. A coder can autonomously produce a better execution plan mid-run.
3. The reviewer can validate that plan before execution continues.
4. Neal can continue the run under the accepted derived plan with no user intervention.
5. The process remains auditable and bounded, with no recursive replanning loops.
