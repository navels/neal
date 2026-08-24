# Plan-review convergence

Plan review either converges or the run blocks. The reviewer is asked "is this
plan execution-ready?" fresh every round against a document that grows with each
fix, so every individually-defensible new finding forces another full revision
round. The only non-acceptance exits used to be terminal failures: reaching the
round cap, and a plan-stage coder block with no answerable landing. That produced two failure modes in
real runs: long negotiations that keep re-litigating verification strength after
the plan is already correct, and runs that terminally fail when a coder
legitimately needs author input it must not fabricate.

The convergence policy addresses both failure modes as **deterministic
orchestration policy**, not prompt tuning. It never shortens a negotiation that
surfaced a genuine plan-correctness defect, and only stops burning rounds on
verification-hardening demands once the plan itself is correct. And a
coder-authored plan-stage block lands as a
recoverable blocked-with-reason state that an operator can answer via
`neal resume --message` (see
[Coder-authored plan-stage block recovery](#coder-authored-plan-stage-block-recovery)).

The core round policy is a single pure function,
`synthesizePlanReviewRoundFromFindings` in `src/neal/adjudicator/planning.ts`,
shared by the runtime (`runPlanReviewPhase`) and by the fixture replay harness
under `test/fixtures/plan-review-ledgers/` (see that directory's `SCHEMA.md`), so
the policy pinned by the committed ledgers is exactly the policy that runs.

## Finding classes

Every plan-review finding carries a declared `findingClass`:

- **`plan_correctness`**: the plan would build the wrong thing, build an
  unverifiable thing, or contains an impossible or self-contradictory
  instruction. These always force a revision round (or block at the cap). The
  auto-generated plan-structure findings default to `plan_correctness`.
- **`verification_hardening`**: the finding only demands strengthening *how the
  plan will be verified* (more oracles, more pinning, more coverage of
  already-specified behavior) without asserting the plan builds the wrong or an
  unverifiable thing. Past the round threshold these can convert to recorded
  debt instead of forcing another round.

The class has two deliberately different boundaries:

- **Reviewer-payload boundary (strict).** An *absent* class normalizes to
  `plan_correctness`. A *present-but-invalid* class value is rejected exactly as
  an invalid `severity` is: the sequential payload validator throws
  `must be exactly one of: plan_correctness, verification_hardening`, so an
  invalid class is a validation error, never a silent downgrade.
- **Persisted-state boundary (tolerant).** When hydrating a saved run,
  `hydrateFinding` maps a present-but-unknown class to `plan_correctness` and
  leaves an absent class `undefined` (execute-review findings never carry a
  class and must stay unaffected). Older run states load without error.

The system-wide fail-safe does **not** depend on hydration filling absence: the
decision sites convert only an *explicit* `verification_hardening`, so any
absent/`undefined`/unknown class is always round-forcing (blocking).

## The debt round threshold

The knob `neal.plan_review_debt_round_threshold` (default **3**, read via
`getPlanReviewDebtRoundThreshold(cwd)`) is the reviewer round at or past which a
novel verification-hardening finding may convert to debt instead of forcing a
round. Below the threshold, every blocking finding forces a revision round
regardless of class. Early rounds are for genuine convergence, not banking.

## Disposition policy

For each round the policy partitions the merged open blocking findings
(`classifyPlanReviewConvergence`) into `debtConvertible` and `roundForcing`:

Pre-cap, a finding is `debtConvertible` only when **all** of:

- its class is exactly `verification_hardening`
- it is a **first occurrence** of its canonical (the minimum round across all
  merged findings sharing that canonical equals the current round)
- the current round is `>= threshold`.

Everything else is `roundForcing`: any `plan_correctness`/absent/unknown class,
**any repeat occurrence** of an existing canonical (a re-raised point still earns
a dedicated round pre-cap), or any below-threshold round.

From that partition:

- **Arrival-time conversion.** A `debtConvertible` finding banks as `deferred`
  plan-review debt the moment it arrives, even when a co-occurring
  `plan_correctness` or repeat finding forces the round, so novelty-bounded
  hardening asks never extend the round count.
- **Accept-with-recorded-reservations landing.** When every open blocking
  finding is `debtConvertible` and none is `roundForcing`, the round lands
  accepted (`landAcceptedWithDebt`). It reuses the existing acceptance
  transition (`accept_plan` → `done` for top-level plan review,
  `accept_derived_plan` for a derived-plan review), so no adjudication-spec
  outcome is added.

Branch precedence in `resolvePlanReviewDisposition` is strict:

1. convergence block (reopen / stall) →
2. round-forcing blocking findings →
3. accept-with-debt →
4. open non-blocking findings →
5. clean acceptance.

Because `roundForcing` outranks `landAcceptedWithDebt`, a single open
plan-correctness or repeat blocker keeps the round forced even when convertible
hardening findings are present alongside it.

## Cap behavior

At the round cap (`round >= roundLimit`) there are no rounds left to force, so the
convertible predicate becomes **class-only**: *every* open
`verification_hardening` finding converts regardless of first-occurrence or
threshold. The cap contract:

- If the convergence block did **not** fire and *every* open blocking finding is
  `verification_hardening`, the run lands accepted-with-debt (all convert).
- If any open blocking finding is `plan_correctness` (or absent/unknown class),
  the run terminal-blocks with the existing max-rounds reason.

The convergence block keeps precedence at the cap too: a re-opened
(`getReopenedCanonical`, ≥3 blocking rounds of one canonical) or stalled
(`hasRepeatedUnresolvedBlockingCanonicals`) finding, *even hardening-class*,
terminal-blocks rather than converting. So a re-litigated-but-not-reopened
hardening point converts at the cap, but a genuinely stuck one still blocks.

## Plan-review debt: two fields, two lifecycles

Debt is modeled as a **canonical-keyed projection of the current findings**
(`toPlanReviewDebt`), never an accumulator: for each canonical whose
latest-round finding is a `deferred` `verification_hardening` finding, exactly
one debt item is emitted (latest round wins, `originRound` = that finding's
round). A banked canonical that later reopens, is fixed, or is rejected simply
drops out of the projection. The lifecycle is automatic, with no stale or
duplicate entries and no ad-hoc removal rule.

There are two distinct top-level state fields:

- **`planReviewDebt`**: the **current-negotiation** projection. Recomputed as
  `toPlanReviewDebt(mergedFindings)` everywhere the current findings change
  (`synthesizePlanReviewRound` / `runPlanReviewPhase` and
  `runPlanningResponsePhase`). This is what a top-level plan run carries to the
  queue on completion.
- **`inheritedPlanReviewDebt`**: **durable, write-once**. Seeded only at init
  from the queue handoff and **never recomputed by any plan-review phase**.

Two fields are required because an *execution* child re-enters plan review: the
execute runnable-phase registry includes `reviewer_plan`,
`coder_plan_response`, and `coder_plan_optional_response`, so
`runPlanReviewPhase` runs inside the execution child during split-plan recovery.
If a single recomputed field were both seeded from the inherited debt and
recomputed as `toPlanReviewDebt(mergedFindings)`, that derived-plan review would
project only the derived plan's own findings and **erase** the inherited
top-level debt before the next scope reviewer saw it. Keeping
`inheritedPlanReviewDebt` write-once and untouched by any plan-review phase
guarantees a derived-plan review in the execution child can only ever mutate
`planReviewDebt`, never the inherited debt the execution reviewer actually needs.

## Cross-run handoff (and its exclusion)

Plan→execution handoff is **cross-run, not in-process**: `neal run` runs planning
and execution as separate fresh child runs. The durable carrier is the
`PlanAndExecuteQueueItem`:

1. On planning-child completion, `completePlanningStage` copies
   `finalState.planReviewDebt` onto the queue item alongside `acceptedPlanPath`
   (covering both in-process completion and the cross-process resume through
   `continuePlanAndExecuteQueueFromChildRun`).
2. When the fresh execution child starts, `runFreshPlanAndExecuteChild` passes
   the item's debt as the `inheritedPlanReviewDebt` init option **only** for the
   execution stage. `createInitialState` seeds the durable
   `inheritedPlanReviewDebt` state field from it (the recomputed `planReviewDebt`
   always starts empty).
3. `buildReviewerContextPacket` surfaces the inherited debt to the execution
   reviewer as full items (`canonicalId`, `findingClass`, `originRound`,
   `claim`, `requiredAction`) under a dedicated `## Inherited Plan-Review Debt`
   section, not a bare count.

**Exclusion (by design):** cross-run propagation is supported only inside a
single `neal run` queue (planning child → execution child). A standalone
`neal plan` run persists debt only in its own run record. A later
`neal execute`/`neal run` against the accepted plan is a fresh run that
re-reviews the plan and does **not** inherit that debt.

## Where debt is visible

- **`REVIEW.md`** (`renderReviewMarkdown`): each finding line carries
  `- Finding class:` (with `n/a` for classless execute-review findings), and a
  dedicated `## Plan Review Debt` section lists `Inherited:` and `Current:`
  groups.
- **`neal status`** (`buildStatusSnapshot` / `renderHumanStatusSnapshot`): a
  `planReviewDebt` snapshot field sums both arrays with a per-item `inherited`
  flag, rendered as a `Plan review debt:` line.
- **Reviewer context packet**: the `## Inherited Plan-Review Debt` section
  described above.

## Coder-authored plan-stage block recovery

The other non-acceptance exit is a plan-stage coder block. A coder-authored
plan-stage **response** block (a `coder_plan_response` or
`coder_plan_optional_response` block, the only plan-stage path that previously
terminal-failed) lands as the documented blocked contract instead of a terminal
failure. `finalizeBlockedPlanReviewResponse`
(`src/neal/orchestrator/phases/planning.ts`) takes an explicit `blockCause`
(`coder_authored` | `dirty_worktree` | `reviewer_convergence`), and for a
`coder_authored` block on the top-level plan stage, it:

- persists `status: 'blocked'` with a durable `blockerReason` (the coder's
  reported blocker), so the writer exits **2** (not `failed`/exit 3) and the
  reason surfaces in both the JSON and human `neal status` renderings.
- makes the block answerable via `neal resume --message`, reusing the existing
  `pendingPlanReviewGuidance` channel and `runPlanningResponseAdjudication`
  delivery. `recordPlanReviewGuidance`
  (`src/neal/commands/recovery-guidance.ts`) maps the origin to the phase that
  consumes the guidance: a `reviewer_plan` block still delivers to
  `coder_plan_response` (unchanged), while a coder-authored response block returns
  to its own origin phase (a `coder_plan_optional_response` block returns to
  `coder_plan_optional_response`), so the re-run selects the right open findings
  and delivers the guidance instead of accepting on an empty blocking set.
  Recorded guidance forces a response adjudication even when a prior blocked
  response closed every finding, so the operator's answer is never silently
  discarded.

The invariant is that `blockerReason` is `null` whenever `status !== 'blocked'`.
The resume-planner blocked→running transitions clear it so it never outlives its
block.

Only `coder_authored` response blocks take this recoverable landing, and the
durable `blockerReason` is the discriminator. A `dirty_worktree` safety block
(the planner dirtied non-plan files with no operator to clean them) records no
`blockerReason`: it lands at the same response phase but stays a normal blocked
state: it is not reported or answerable as waiting for `--message` guidance, and
it keeps its prior bare-resume behavior when a resumable planner session exists.
Reviewer cap/stall exhaustion (`reviewer_convergence`) likewise lands a normal
blocked state with no `blockerReason` (exit 2).

**Exclusion (the initial `coder_plan` authoring block):** the author-input route
does **not** cover the initial `coder_plan` block. That block already lands
`status: 'blocked'` (exit 2, not a terminal failure) and stays resumable via a
bare `neal resume`. Delivering an operator answer to a re-run authoring round
would require a second guidance-delivery channel this policy deliberately avoids.
Its `--message` route is a deliberate follow-up, not part of this policy.

## Related references

- `docs/plan-format.md`: executable plan shapes and normalization.
- `docs/state-machine.md`: persisted run and queue state invariants.
- `docs/adjudicator-inventory.md`: the shared coder/reviewer loop inventory.
