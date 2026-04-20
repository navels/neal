## Problem Statement

Recent execution in ovation-apps exposed a second failure mode adjacent to, but distinct from, low-signal churn:

- the current execute loop can become strategically non-convergent
- stopping the churn is necessary, but not sufficient
- recovering often requires stepping outside the current hypothesis chain entirely
- the most useful intervention may be to return to a cleaner baseline, ask a deeper diagnostic question, and author a new recovery plan

In practice, that intervention currently looks like this:

1. pause or stop Neal
2. manually open separate coder / reviewer sessions outside the Neal run
3. ask for fresh diagnostic analysis from a cleaner baseline or branch
4. turn that analysis into a recovery plan
5. review that plan
6. manually decide whether and how to re-enter Neal execution

That workflow can be valuable, but today Neal does not facilitate it. The intervention happens outside the Neal run, the artifacts are disconnected from the canonical execution history, and re-entry depends on operator memory and manual stitching.

This plan adds a narrow diagnostic-recovery capability so Neal can help with that kind of intervention without trying to absorb every possible meta-workflow.

## Goal

Add a first-class diagnostic-recovery workflow to Neal so the operator can pause a strategically failing execute run, commission a bounded diagnostic analysis and recovery plan from a cleaner baseline, review the result, and then decide whether to adopt it back into the current run.

The target behavior after this work:

1. Neal can enter an explicit diagnostic-recovery mode for a paused execute run.
2. The operator can specify a diagnostic question and optional clean baseline context.
3. Neal can produce a diagnostic analysis artifact and a candidate recovery plan artifact.
4. Neal can review that recovery plan using the ordinary plan-review machinery rather than inventing a second review system.
5. The operator can choose whether to adopt the reviewed recovery plan into the active run or leave it as a reference artifact.
6. The entire intervention remains auditable inside Neal artifacts.

## Relationship To Meaningful-Progress Gating

This plan is a follow-on capability to [01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md), not a replacement for it.

The meaningful-progress gate answers:

- "are we still making acceptable progress inside the current execution shape?"

Diagnostic recovery answers a different question:

- "if the current execution shape is no longer useful, can Neal help the operator step out, re-diagnose the problem from a cleaner baseline, and re-enter with a better plan?"

The intended relationship is:

1. meaningful-progress gate detects strategic non-convergence and stops further churn
2. a `replace_plan` or equivalent non-convergence outcome routes the run into an operator-visible recovery path rather than accepting another low-signal scope
3. diagnostic recovery is one explicit next step the operator can choose from that recovery path
4. diagnostic recovery gives the operator a structured way to generate analysis and a recovery plan
5. the operator then decides whether to adopt that recovery plan back into the current run

## Desired Contract

After this implementation:

1. Diagnostic recovery is available only for execute-mode runs.
2. The operator can trigger diagnostic recovery only from a paused, blocked, or interactive-blocked-recovery execute run.
3. Diagnostic recovery requires explicit operator input for:
   - the diagnostic question
   - the target files / component / scope of analysis
   - optional baseline reference or branch
4. Neal produces two explicit artifacts:
   - `DIAGNOSTIC_ANALYSIS.md`
   - `RECOVERY_PLAN.md`
5. The recovery plan goes through ordinary Neal plan review, not a new bespoke review path.
6. Neal does not automatically adopt the recovery plan into the active run.
7. Adoption remains an explicit operator decision.
8. If adopted, the recovery plan replaces only the current parent objective / current scope context rather than silently rewriting unrelated future work.

## Operator Entry Point

The first version should use an explicit dedicated CLI surface rather than overloading ordinary blocked recovery.

Preferred shape:

```text
neal --diagnose [state-file] \
  --question "<diagnostic question>" \
  --target "<files-or-component>" \
  [--baseline <ref-or-branch-or-commit>]
```

This keeps diagnostic recovery visibly distinct from ordinary blocked recovery while still tying it to an existing execute-mode session.

## Non-Goals

This plan should not:

- make Neal a general-purpose research assistant for any arbitrary question
- fully automate branch archaeology or baseline selection
- automatically decide that a recovery plan should replace the active run
- redesign the execute planner, split-plan system, or blocked-recovery system
- create a second planning protocol separate from ordinary Neal plan review
- support every possible analysis artifact type in the first version

## Why This Is Narrow Enough

The goal here is not "Neal can do any intervention workflow."

The goal is only:

1. pause a struggling execute run
2. ask a bounded diagnostic question from a cleaner baseline or clearer context
3. turn the answer into a recovery plan
4. review that plan
5. let the operator decide whether to adopt it

That is a bounded recovery workflow directly motivated by the ovation-apps intervention. It is intentionally smaller than a general meta-orchestrator.

## Baseline Semantics

The first version should support explicit but simple baseline selection.

Supported model:

- operator may specify an optional baseline ref, branch, or commit
- if omitted, Neal should default to a clean starting point for the active parent objective:
  - the active parent objective's `baseCommit` when available
  - otherwise the run's original `baseCommit`
- diagnostic analysis should treat the baseline as read-only context, not as a branch Neal mutates

The first version should not attempt to infer the best baseline automatically.

Read-only baseline access should use non-mutating inspection such as `git show <ref>:<path>` or equivalent read-only git queries. The first version should not `checkout` the baseline into the working tree.

## Adoption Semantics

The first version should keep adoption conservative.

If the operator chooses to adopt the recovery plan:

- adoption replaces only the active parent objective / current scope context, using the same parent-objective unit described in [01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md](/Users/lee.nave/code/personal/codex-chunked/plans/01_NEAL_MEANINGFUL_PROGRESS_GATE_PLAN.md) under `Parent-Objective Semantics`
- the rest of the run remains intact unless explicitly superseded by that replacement
- Neal should record that the active run moved into a diagnostic-recovery-derived plan
- adoption should route through Neal's existing replacement machinery rather than writing bespoke replacement state directly

Concretely, the first version should feed the reviewed `RECOVERY_PLAN.md` into the same replacement path Neal already uses for scope replacement so there remains one authoritative replacement mechanism.

If the operator does not adopt it:

- the artifacts remain in the run directory for reference
- the active run remains paused / blocked / awaiting further operator action

## State Strategy

The first version should add a narrow explicit diagnostic-recovery phase family rather than overloading ordinary blocked recovery with too many extra meanings.

Recommended shape:

- `diagnostic_recovery_collect` — capture operator question / target / baseline
- `diagnostic_recovery_analyze` — coder produces `DIAGNOSTIC_ANALYSIS.md`
- `diagnostic_recovery_author_plan` — coder produces `RECOVERY_PLAN.md`
- `diagnostic_recovery_review` — reuses ordinary plan-review machinery for `RECOVERY_PLAN.md`
- `diagnostic_recovery_adopt` — operator adoption / keep-reference / cancel decision

The plan-review part should still reuse the existing planning review machinery once `RECOVERY_PLAN.md` exists.

The guiding principle:

- dedicated state for entering, tracking, and adopting diagnostic recovery
- shared machinery for reviewing the resulting recovery plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Add Diagnostic-Recovery State And Operator Entry Point

- Goal: Give Neal an explicit way to start a diagnostic-recovery intervention for an execute-mode run.
- Expected work:
  - add the explicit diagnostic-recovery phase family described above
  - add the `neal --diagnose ...` operator entry point for starting diagnostic recovery on the current execute run
  - require explicit operator input for the diagnostic question, target scope/files, and optional baseline reference
  - reject attempts to start diagnostic recovery from an actively-running execute session
  - keep the active execute run canonical while diagnostic recovery is in progress
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`
- Success Condition: Neal can persist, resume, and inspect a diagnostic-recovery session without manual state editing.

### Scope 2: Generate Diagnostic Analysis Artifact

- Goal: Produce a bounded diagnostic analysis artifact from explicit operator input and optional baseline context.
- Expected work:
  - add a diagnostic-analysis prompt/contract for the coder
  - write `DIAGNOSTIC_ANALYSIS.md` into the active run directory using a collision-safe naming scheme
  - support optional baseline context in the prompt contract without mutating that baseline
  - record the analysis artifact path in session state
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal can produce a diagnostic-analysis artifact in the run directory from explicit operator input.

### Scope 3: Generate Recovery Plan Artifact From Diagnostic Analysis

- Goal: Turn the diagnostic analysis into a Neal-owned recovery plan artifact.
- Expected work:
  - add a follow-on recovery-plan authoring prompt/contract that turns the analysis into `RECOVERY_PLAN.md`
  - write the recovery plan under a collision-safe path and record that path in session state
  - keep the recovery plan adoption-safe and Neal-executable
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal can produce a recovery-plan artifact from the diagnostic analysis without leaving the diagnostic-recovery session.

### Scope 4: Reuse Ordinary Neal Plan Review For Recovery Plans

- Goal: Avoid inventing a second review system for diagnostic recovery.
- Expected work:
  - route `RECOVERY_PLAN.md` through the existing Neal plan-review loop and validation rules
  - keep diagnostic recovery plan review clearly linked to the active execute run
  - ensure reviewer artifacts make clear that the reviewed plan is a recovery-plan candidate rather than a fresh top-level execution plan
  - use the recovery-plan path already recorded in session state rather than rescanning the run directory
- Verification: `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm typecheck`
- Success Condition: Diagnostic recovery plans are reviewed with the same plan-review machinery and structural checks as ordinary Neal plans.

### Scope 5: Add Explicit Operator Adoption Or Rejection

- Goal: Make recovery-plan adoption an explicit operator decision with auditable consequences.
- Expected work:
  - add an operator decision point after recovery-plan review
  - support at least:
    - adopt recovery plan
    - keep as reference only and leave the active run paused
    - cancel diagnostic recovery and discard the pending intervention state while preserving artifacts
  - when adopting, replace only the active parent objective / current scope context by routing the reviewed `RECOVERY_PLAN.md` through the existing replacement machinery
  - when not adopting, preserve artifacts and leave the active run safely paused or return it to an ordinary paused state, depending on the explicit operator choice
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`
- Success Condition: Neal never auto-adopts a recovery plan, and operator decisions about adoption are explicit, persisted, and reversible at the state level.

### Scope 6: Add End-To-End Coverage For The Ovation-Apps Style Intervention

- Goal: Prove Neal can facilitate the kind of intervention that previously required manual Codex/Claude orchestration outside the run.
- Expected work:
  - add synthetic scenarios covering:
    - diagnostic recovery from a paused execute run
    - optional baseline selection
    - analysis artifact generation
    - recovery-plan generation
    - recovery-plan review
    - operator adoption
    - operator rejection / reference-only retention
    - collision-safe repeated diagnostic-recovery interventions in the same run
  - ensure artifacts and event logs explain what happened
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm exec tsx --test test/plan-review.test.ts`; `pnpm typecheck`
- Success Condition: Neal can perform a bounded diagnostic-recovery intervention end to end without manual transcript stitching.

## Prompting Requirements

Prompt updates should make these roles explicit:

### Diagnostic Analysis Coder Prompt

- analyze from the specified baseline/context
- answer the operator's diagnostic question directly
- identify what is structurally different or uniquely difficult about the target
- avoid proposing implementation work in the analysis artifact itself beyond what is necessary to motivate a recovery plan

### Recovery Plan Coder Prompt

- turn the diagnostic analysis into an executable recovery plan
- preserve the ordinary Neal-executable plan contract
- keep the recovery plan narrow and adoption-safe

### Reviewer Prompt

- review the recovery plan as a candidate replacement / recovery plan
- apply the ordinary plan-review acceptance rules
- do not auto-author a replacement plan

## Artifact Requirements

At minimum, diagnostic recovery should persist:

- the operator's diagnostic request
- the baseline reference used, if any
- the diagnostic-analysis artifact path
- the recovery-plan artifact path
- recovery-plan review artifacts
- the operator's adoption or rejection decision

All of this should live under the active run directory so the intervention is visible alongside the original execution history.

Artifact naming must be collision-safe across repeated diagnostic-recovery interventions in the same run. The first version should therefore use either numbered or timestamped recovery artifact paths, for example:

- `DIAGNOSTIC_RECOVERY_<N>_ANALYSIS.md`
- `DIAGNOSTIC_RECOVERY_<N>_PLAN.md`

## Guardrails

The first version should include these guardrails:

1. Diagnostic recovery is execute-mode only.
2. Diagnostic recovery is operator-triggered, not automatic.
3. Baseline selection is explicit, not inferred.
4. Recovery plans must still pass ordinary plan review before they can be adopted.
5. Adoption is explicit and never automatic.
6. Adoption replaces only the active parent objective / current scope context unless the operator explicitly chooses a broader change in a later version.

## Verification Strategy

Minimum verification for the full implementation:

1. State hydration / persistence tests for diagnostic-recovery state.
2. Artifact generation tests for `DIAGNOSTIC_ANALYSIS.md` and `RECOVERY_PLAN.md`.
3. Plan-review tests proving recovery plans use the ordinary plan-review pipeline.
4. Tests covering adoption and non-adoption flows.
5. Tests covering explicit baseline references.
6. Tests covering collision-safe repeated interventions in the same run.
7. End-to-end synthetic scenario matching the general ovation-apps intervention shape.

## Acceptance Criteria

This work is complete only when all of the following are true:

1. Neal can start a diagnostic-recovery intervention for an execute-mode run.
2. Neal can produce a diagnostic analysis artifact and a recovery plan artifact from explicit operator input.
3. Recovery plans go through ordinary Neal plan review.
4. Adoption back into the active run is an explicit operator decision.
5. Non-adopted recovery plans remain available as reference artifacts.
6. The whole intervention is auditable from Neal run artifacts without manual transcript stitching.
