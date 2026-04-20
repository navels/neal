## Goal

Improve Neal so that mandatory verification failures and resume flows handle bounded prerequisite repairs and branch drift explicitly instead of degrading into stale consults, repeated split-plan churn, or terminal blocked states.

This plan is intentionally scoped for Neal execution. The implementation touches the orchestrator state machine, consult / blocker handling, and resume logic. That is not one-shot safe.

The target behavior after this work:

1. Neal can distinguish:
   - a true blocker
   - a wrong execution shape that should use split-plan recovery
   - a bounded prerequisite repair outside the active scope
2. Neal can pause an active scope, run a bounded prerequisite repair scope, and then resume the interrupted scope on top of the repair.
3. Neal detects when branch `HEAD` has changed outside the session's known accepted path and stops in an explicit reconciliation-required state instead of reasoning from stale assumptions.
4. Neal invalidates or rechecks stale consult recommendations when the implicated files or branch state have changed.
5. Neal can escalate from repeated consult-guided recovery attempts into split-plan recovery when the blocker proves that the current scope shape is wrong.
6. Operator-facing artifacts and notifications make these states legible.

## Why This Matters

Recent execution exposed a specific failure shape:

- a derived scope correctly passed focused verification
- mandatory full-suite verification failed outside the active sub-scope
- the reviewer produced a concrete bounded repair recommendation
- that recommendation later became stale because branch state advanced beyond the session's execution base
- Neal had no first-class path to absorb the prerequisite repair or reconcile the stale session state

That is neither a normal split-plan case nor a normal terminal blocker. Neal needs a dedicated flow for it.

Recent execution also exposed a second gap:

- consult can correctly diagnose local blocker causes
- coder can correctly follow bounded recovery advice
- after those recovery attempts, the underlying truth may be that the current scope shape is still wrong
- Neal currently has no explicit consult-to-split escalation rule, so the run can fall into terminal `blocked` instead of replacing the scope

That is a distinct protocol gap and should be covered by this same implementation plan.

## Desired Contract

After this implementation:

1. Full-suite failures discovered during mandatory verification are classified as one of:
   - `pre_existing_baseline`
   - `same_campaign_regression`
   - `prerequisite_repair`
   - `true_blocker`
2. `prerequisite_repair` is a first-class recovery path.
3. A prerequisite repair is bounded:
   - concrete failing behavior
   - concrete implicated file or small file set
   - concrete proposed fix direction
   - necessary to satisfy mandatory verification
   - not open-ended product, design, or architecture work
4. Neal may pause the active scope, execute the prerequisite repair as a separate scope, and then resume the interrupted scope from a clean base on top of the repair commit.
5. If branch state has changed outside the session's known path, Neal must reconcile before continuing execution or trusting old consult guidance.
6. If a consult recommendation is stale relative to current branch state or implicated files, Neal must not blindly apply it.
7. If bounded consult-guided recovery attempts disprove the current execution shape, Neal should prefer split-plan recovery over terminal blocked state.

## Execution Shape

executionShape: multi_scope

## Scope Design

Implementation should be delivered in six scopes:

- Scope 1 adds the state model and branch-drift / consult-staleness detection primitives.
- Scope 2 adds classification and prerequisite-repair state transitions.
- Scope 3 pauses active scope execution and runs the prerequisite repair as a bounded side scope.
- Scope 4 resumes the interrupted scope on top of the accepted repair and adds strict branch-drift / stale-consult resume handling.
- Scope 5 adds consult-to-split escalation rules so repeated recoverable consult attempts can replace a wrong-shaped scope instead of falling into terminal blocked.
- Scope 6 finishes artifacts, notifications, and tests that prove the new flow is stable.

Each scope must leave Neal in a coherent, reviewable state with targeted tests.

## Execution Queue

### Scope 1: Add Branch Drift And Consult-Staleness Primitives

- Goal: Extend Neal state and resume-time checks so the orchestrator can detect when branch state or consult assumptions have drifted beyond the persisted session model.
- Expected work: add explicit state for branch drift / prerequisite repair bookkeeping in `src/neal/types.ts`, `src/neal/state.ts`, and orchestrator helpers; track the session's known execution tip separately from ambient `HEAD`; add helper logic that can detect when current `HEAD` is no longer the same as the session's known path; add consult metadata sufficient to invalidate stale recommendations when implicated files or commit context change.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success condition: Neal can load and persist the new metadata cleanly, and resume-time helper tests prove it can detect branch drift and stale consult context without yet changing execution behavior.

### Scope 2: Add Verification-Failure Classification And Prerequisite-Repair State

- Goal: Introduce a first-class classification model for mandatory verification failures and a dedicated prerequisite-repair state path.
- Expected work: define the new classification contract in the reviewer / consult structured output and parsing layer; make the consult schema carry diagnosis context such as diagnosis `HEAD` and implicated files; add state and transition helpers for `prerequisite_repair`; keep the distinction explicit between split-plan recovery, prerequisite repair, and terminal blocked states; reject over-broad prerequisite-repair recommendations that do not meet the boundedness rules; explicitly define what campaign context is supplied to the reviewer so `same_campaign_regression` is classifiable in practice.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`.
- Success condition: Neal can parse and persist `prerequisite_repair` outcomes distinctly from `blocked` and split-plan flows, with tests covering classification and guardrail rejection.

### Scope 3: Pause Active Scope And Execute Prerequisite Repair

- Goal: Make Neal able to pause an active scope and run a bounded prerequisite repair without yet solving resumed execution.
- Expected work: add orchestrator transitions so consult guidance can move an active scope into prerequisite-repair planning / execution; explicitly reuse the existing plan-review and scope execution phases with prerequisite-repair context flags rather than introducing a full parallel phase family; archive the interrupted scope state cleanly; ensure prerequisite-repair completion is recorded separately from ordinary parent-scope completion.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`.
- Success condition: synthetic runs prove Neal can pause an active scope and execute a bounded repair scope without corrupting parent-scope state.

### Scope 4: Resume Interrupted Scope And Add Strict Resume Safeguards

- Goal: Resume the interrupted scope safely after accepted repair and make resume-time drift / staleness handling explicit and strict.
- Expected work: define interrupted-scope WIP semantics; restart the interrupted scope from the new accepted repair base rather than continuing mid-turn; preserve committed work only if implementation proves that rebasing session-created commits is safe, otherwise capture uncommitted or abandoned work as an audit artifact and restart from the new base; add strict resume behavior so any `HEAD` advancement outside the known session path blocks and notifies instead of attempting automatic commit classification; prevent stale consult adoption by re-validating implicated files / diagnosis context before resuming.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`.
- Success condition: synthetic runs prove Neal can resume an interrupted scope after accepted repair, and `neal --resume` stops safely when branch drift or stale consult context is detected.

### Scope 5: Add Consult-To-Split Escalation

- Goal: Teach Neal to escalate from repeated recoverable consults into split-plan recovery when the consult process proves the current scope shape is wrong.
- Expected work: update consult prompts so the reviewer may explicitly recommend split-plan recovery when bounded recovery attempts have ruled out procedural issues and the remaining problem is execution shape; update coder consult-response logic so it prefers `AUTONOMY_SPLIT_PLAN` over terminal `AUTONOMY_BLOCKED` when the consult history now points to a wrong-shaped scope; add explicit state or helper logic for consult escalation count / reasoning if needed; ensure this reuses existing split-plan machinery rather than inventing a separate replacement protocol inside consult handling.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`.
- Success condition: synthetic runs prove Neal can move from consult-guided recovery to split-plan recovery after bounded attempts fail, instead of incorrectly stopping in a terminal blocked state.

### Scope 6: Finish Notifications, Artifacts, And End-To-End Coverage

- Goal: Make the new flow legible to operators and auditable in persisted artifacts.
- Expected work: update progress / consult / retrospective rendering for prerequisite repair, consult-to-split escalation, and branch-drift reconciliation; add notifications that distinguish `blocked`, `split-plan`, `prerequisite repair`, `consult escalation`, and `reconciliation required`; add end-to-end tests for stale-consult invalidation, external branch advancement, resumed execution after prerequisite repair, and consult-driven split-plan escalation; tighten any remaining prompt text so reviewer and coder outputs use the new contract consistently.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`.
- Success condition: artifacts and notifications clearly describe prerequisite repair and branch drift, and the test suite covers the new execution and resume shapes end to end.

## Classification Rules

Mandatory verification failures must be classified explicitly.

`pre_existing_baseline` means:

- the failure existed at campaign start or is already explicitly tolerated by the plan
- the current scope did not introduce or expose a new dependency on it

`same_campaign_regression` means:

- the failure is attributable to accepted or in-progress work from the same Neal campaign
- the campaign itself must absorb the repair

`prerequisite_repair` means:

- the active scope is not the direct cause of the failure
- the failure still must be repaired before mandatory verification can pass
- the repair is bounded, concrete, and in-repo
- the repair is smaller and safer than broadening the active scope in place

`true_blocker` means:

- no bounded in-repo repair path is available
- or the proposed repair is too broad, ambiguous, or externally dependent to run autonomously

These classifications should ride through the existing consult / review pipeline. This does require an explicit consult schema extension for diagnosis context and classification fields; it is not just a prompt tweak.

## Consult Escalation Rules

Consult should remain advisory, but it must be able to conclude that the current scope shape is wrong.

The reviewer should be able to recommend split-plan recovery from consult when all of the following are true:

- the blocker is still in-repo and recoverable
- bounded consult-guided recovery attempts have already ruled out procedural uncertainty or smaller local fixes
- the remaining problem is that the current scope is too broad, too direct, or otherwise wrong-shaped
- another retry of the same scope would be churn rather than progress

The coder should then prefer `AUTONOMY_SPLIT_PLAN` over terminal `AUTONOMY_BLOCKED` unless the coder can make a concrete case that no safe replacement scope exists.

This should not require a separate split-plan protocol inside consult handling. It should feed into the existing split-plan machinery.

The first version does not need a fully automatic consult-attempt counter with complex heuristics. It does need explicit prompt and handler behavior so that:

- reviewer can say "this should split-plan now"
- coder can act on that recommendation during consult response
- Neal does not incorrectly end in terminal `blocked` when the real answer is "replace this scope"

## Prerequisite Repair Semantics

Prerequisite repair is not split-plan recovery.

Split-plan means:

- current scope shape is wrong
- discard current scope attempt
- replace the scope with a better execution plan

Prerequisite repair means:

- current scope remains valid
- mandatory verification discovered a bounded dependency repair outside the active scope
- pause the active scope
- run the repair as an explicit prerequisite scope
- resume the interrupted scope after the repair is accepted

The interrupted scope should preserve:

- original scope number
- original scope intent
- original active plan doc
- its already-completed focused work summary where useful

WIP semantics for the first version should be explicit and conservative:

- the interrupted scope does not continue mid-turn
- after accepted repair, the interrupted scope restarts from scratch against the new repair commit base
- uncommitted interrupted-scope work is captured as an audit artifact and discarded
- if the session created mid-scope commits before the prerequisite repair decision, do not attempt automatic rebase in the first version unless implementation proves this is safe and testable; otherwise stop and require explicit operator intervention

The prerequisite repair should record:

- parent interrupted scope number
- failure classification
- implicated files
- consult rationale
- final accepted repair commit

## Branch Drift Reconciliation

On `neal --resume`, Neal must compare:

- persisted session base and accepted-path metadata
- current `git rev-parse HEAD`
- known created / completed commits from the session

If current `HEAD` advanced outside the session's known path, Neal must not just resume the old phase.

Instead it should:

1. persist a `branch_drift_detected` event
2. mark the session as requiring reconciliation
3. stop and notify rather than attempting automatic commit classification
4. refuse to trust prior consult advice until reconciliation completes

The first version does not need automatic commit classification. It does need a safe stop-and-reconcile path with explicit artifacts and state.

## Consult Staleness Rules

Consult output should carry enough context to detect when it is stale:

- branch `HEAD` at diagnosis time
- implicated file paths
- optional implicated commit range when available

Before Neal adopts a consult recommendation that changes execution behavior, it should check:

- whether current `HEAD` still matches the diagnosis context
- whether implicated files changed since the consult
- whether the proposed shape is already present on disk

If any of those make the consult stale, Neal should:

- log and surface that staleness explicitly
- re-run the relevant focused verification or re-consult instead of blindly applying the old advice

This relies on an explicit consult schema change. The reviewer consult response should carry diagnosis context sufficient for those checks.

## Operator-Facing Behavior

Notifications and artifacts should make these states clear.

Examples of desired copy:

- `[neal] PLAN.md: scope 6 paused for prerequisite repair`
- `[neal] PLAN.md: branch drift detected; reconciliation required before resume`
- `[neal] PLAN.md: consult recommendation is stale; re-validating blocker`

Avoid collapsing all of these into generic `blocked` notifications.

## State Model Changes

The exact names may vary, but Neal likely needs explicit fields for concepts like:

- prerequisite repair status / path
- interrupted parent scope number
- verification failure classification
- consult diagnosis head commit
- consult implicated files
- branch drift status
- session known head / accepted path tip

Keep the additions minimal, but explicit. Do not overload unrelated split-plan fields for prerequisite-repair state.

Phase strategy should also be explicit:

- reuse the existing plan-review and scope execution phases with prerequisite-repair context flags
- do not add a second full parallel phase family unless implementation proves reuse is impossible
- follow the same phase-reuse principle already established in the split-plan recovery work
- reuse the existing split-plan machinery when consult escalates to scope replacement

## Guardrails

The first version should include hard guardrails:

- at most one prerequisite repair per active scope
- no nested prerequisite repairs
- prerequisite repair review should use a small bounded round budget, separate from ordinary execution review if needed
- if the proposed repair is too broad or repair review cannot converge, stop in a real blocked state with explicit reason
- at most a small bounded number of consult-guided recovery attempts per active scope before Neal requires either split-plan or explicit terminal-blocked justification

## Prompting Changes

Reviewer and consult prompts should be updated so they can:

- classify verification failures using the four explicit buckets above
- recommend prerequisite repair only when boundedness conditions are met
- distinguish prerequisite repair from split-plan and true blocked outcomes
- include implicated files and diagnosis context needed for stale-consult checks
- receive enough campaign context to distinguish `same_campaign_regression` from `prerequisite_repair`, such as current run accepted commits or touched-file summary
- explicitly recommend split-plan recovery when consult-guided recovery has disproven the current scope shape

Coder prompts should be updated so the coder:

- does not misuse split-plan when the active scope is still valid but needs a prerequisite repair
- understands that prerequisite repair is a separate bounded scope, not a hidden expansion of the current scope
- prefers split-plan over terminal blocked when consult history shows the current scope has been disproven by bounded recovery attempts

## Verification

Minimum verification for the implementation:

1. State hydration / persistence tests for the new prerequisite-repair and branch-drift metadata.
2. Synthetic classification tests covering:
   - `pre_existing_baseline`
   - `same_campaign_regression`
   - `prerequisite_repair`
   - `true_blocker`
3. Resume tests where `HEAD` advanced outside the known session path and Neal enters reconciliation-required blocked state instead of blindly resuming.
4. Stale consult tests where the implicated file already changed or already matches the proposed fix shape.
5. Synthetic run where an active scope pauses for prerequisite repair, the repair scope is accepted, and the interrupted scope resumes successfully.
6. Negative test where a supposed prerequisite repair is too broad and Neal rejects it into a real blocked state.
7. Synthetic run where consult-guided recovery attempts fail and Neal escalates into split-plan recovery instead of terminal blocked state.
8. Artifact / notification tests proving the operator-visible output distinguishes prerequisite repair, consult escalation, branch drift, and blocked states.

## Acceptance Criteria

This work is complete only when all of the following are true:

1. Neal no longer has to misuse `blocked` or split-plan recovery for bounded prerequisite repairs.
2. Neal can detect branch drift on resume and stop for reconciliation instead of trusting stale state.
3. Neal can detect stale consult guidance and force re-validation or re-consult.
4. Neal can escalate from consult-guided recovery into split-plan recovery when the current scope has been disproven.
5. Tests cover the new state transitions and resume behavior.
6. Operator-visible artifacts and notifications make the new flow understandable without reading source.

## Blocking Rules

Block only if:

- the new flow cannot be expressed safely without a larger orchestrator redesign
- or a required distinction between prerequisite repair and split-plan cannot be made coherently in the existing protocol

Do not block merely because:

- new state fields are needed
- prompts need to be extended
- resume logic becomes more explicit

If a scope discovers that the execution shape here is still too broad, use split-plan recovery on this implementation plan rather than forcing a one-pass orchestrator rewrite.
