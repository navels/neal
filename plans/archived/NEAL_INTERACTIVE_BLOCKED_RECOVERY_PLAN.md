## Goal

Make blocked-run recovery in Neal easier and more flexible by keeping recovery in-band inside the Neal session, instead of forcing the operator to leave Neal, talk to the coder in isolation, and then manually stitch Neal state back together.

This is intentionally a simpler alternative to a large amount of orchestrator hardening. The aim is not to model every recovery subtype perfectly. The aim is to make blocked recovery conversational, auditable, and low-friction.

The target behavior after this work:

1. When Neal reaches a blocked state, the run can remain open in an explicit interactive recovery mode.
2. The operator can send guidance to the coder through Neal while preserving the canonical Neal session state.
3. The coder can respond with one of a small number of recovery actions:
   - continue current scope
   - replace current scope
   - pause for more operator input
   - stop terminally
4. Neal records that recovery interaction in the run artifacts and then resumes normal orchestration from the chosen action.
5. The operator no longer needs `--resume-coder` plus manual state surgery for common recovery situations.

## Why This Matters

Recent execution exposed a repeated pattern:

- Neal reached `blocked`
- useful recovery required human guidance
- the practical way to provide that guidance was `neal --resume-coder`
- the coder could often recover successfully in isolation
- but Neal's own persisted state no longer matched reality
- manual edits to plan artifacts and `session.json` were then needed to re-enter the structured loop

That is too brittle.

The core problem is not that Neal lacks enough state fields. The core problem is that blocked recovery currently happens outside the Neal session.

## Desired Contract

After this implementation:

1. `blocked` should mean "structured execution paused" rather than "session effectively dead".
2. The operator should have a first-class way to interact with the coder from within Neal while the run remains the canonical source of truth.
3. Recovery should be expressed through a small, explicit set of actions:
   - `resume_current_scope`
   - `replace_current_scope`
   - `stay_blocked`
   - `terminal_block`
4. If the coder proposes a replacement scope, Neal should route that through the existing split-plan / derived-plan machinery rather than inventing a second replacement protocol.
5. If the coder proposes to continue the current scope, Neal should resume normal scope execution without requiring manual transcript reconciliation.
6. All operator interventions and coder responses should be written to Neal artifacts and event logs.

## Execution Shape

executionShape: multi_scope

## Scope Design

Implementation should be delivered in five scopes:

- Scope 1 introduces interactive blocked-recovery state and operator-facing entry points.
- Scope 2 adds coder-facing recovery prompts and a small structured recovery-action contract.
- Scope 3 wires those recovery actions into the orchestrator using existing continuation and split-plan machinery.
- Scope 4 adds artifacts, notifications, and resume handling for interrupted interactive recovery.
- Scope 5 validates the end-to-end recovery flow with synthetic blocked scenarios.

Each scope should be independently reviewable and should keep Neal coherent if execution stops after that scope.

## Execution Queue

### Scope 1: Add Interactive Blocked-Recovery State And Entry Points

- Goal: Give Neal an explicit in-band recovery mode for blocked runs instead of forcing recovery outside the session.
- Expected work: add state and CLI entry points for an interactive blocked-recovery mode; define how a blocked run stays open for operator intervention; ensure the run can record operator recovery input without pretending that normal execution has resumed yet.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success condition: Neal can persist and reload an interactive blocked-recovery state and accept operator recovery input without manual state edits.

### Scope 2: Add A Small Recovery-Action Contract For The Coder

- Goal: Give the coder a constrained way to respond to blocked recovery input.
- Expected work: define a small structured contract for blocked recovery responses with actions like `resume_current_scope`, `replace_current_scope`, `stay_blocked`, and `terminal_block`; update prompts so the coder understands that blocked recovery is now in-band; keep the contract intentionally small and do not recreate the full execution protocol inside blocked recovery.
- Verification: `pnpm exec tsx --test test/consult.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success condition: Neal can parse coder recovery responses deterministically and distinguish "continue", "replace", "need more operator input", and "truly blocked".

### Scope 3: Wire Recovery Actions Into Existing Orchestration Paths

- Goal: Turn blocked-recovery actions into ordinary Neal behavior using the machinery that already exists.
- Expected work: if the coder says `resume_current_scope`, resume the active scope through the normal coder path; if the coder says `replace_current_scope`, route that through the existing split-plan / derived-plan path; if the coder says `stay_blocked`, remain in interactive blocked recovery; if the coder says `terminal_block`, finalize into a real blocked run; explicitly reuse existing split-plan machinery rather than creating a separate plan-replacement system.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm typecheck`.
- Success condition: a blocked run can recover back into normal execution or into split-plan review without leaving Neal or requiring manual session rewriting.

### Scope 4: Add Artifacts, Notifications, And Resume Support

- Goal: Make interactive blocked recovery visible, auditable, and resumable.
- Expected work: record operator interventions and coder recovery responses in run artifacts; add notifications that distinguish interactive blocked recovery from terminal blocked; ensure `neal --resume` can resume an interrupted interactive recovery session; make sure restarting recovery does not lose the current blocker context.
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`.
- Success condition: interrupted interactive recovery sessions resume cleanly and operator-visible artifacts explain what happened.

### Scope 5: Validate The End-To-End Recovery Flow

- Goal: Prove that the new interaction model actually reduces the brittle recovery path we just experienced.
- Expected work: add synthetic scenarios for:
  - blocked scope followed by operator guidance that resumes the current scope
  - blocked scope followed by operator guidance that triggers split-plan replacement
  - blocked scope that remains blocked after more input
  - interrupted interactive recovery resumed later
  - operator intervention recorded without manual session edits
- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm exec tsx --test test/consult.test.ts`; `pnpm exec tsx --test test/review.test.ts`; `pnpm typecheck`.
- Success condition: Neal can handle the common blocked-recovery shapes end to end without leaving the session.

## Recovery Model

The first version should keep the model intentionally small.

When a run is blocked, Neal should offer an in-band recovery turn rather than immediately forcing the operator into an out-of-band coder session.

The operator provides recovery guidance.

The coder responds with exactly one of:

- `resume_current_scope`
- `replace_current_scope`
- `stay_blocked`
- `terminal_block`

These mean:

`resume_current_scope`

- the blocked scope is still the right scope
- the operator guidance gives the coder enough to continue
- Neal should resume normal scope execution

`replace_current_scope`

- the current scope shape is wrong
- the correct answer is to replace the scope
- Neal should reuse the existing split-plan / derived-plan flow

`stay_blocked`

- more operator guidance is needed
- Neal remains in interactive blocked recovery

`terminal_block`

- no safe in-repo path remains
- Neal finalizes to a real blocked run

## Why This Is Simpler

This design deliberately avoids trying to encode every recovery subtype as a separate top-level orchestrator concept.

It does not require:

- full prerequisite-repair semantics in the first version
- complex branch-drift reclassification
- a large number of new recovery phases
- manual transcript / state reconciliation after `--resume-coder`

Instead it does three simpler things:

1. keeps recovery in the Neal session
2. gives the coder a small structured recovery vocabulary
3. maps those recovery actions back onto machinery Neal already has

That is the main simplification.

## Phase Strategy

Do not create a large parallel blocked-recovery phase family if existing phases can be reused.

The likely shape is:

- one explicit interactive blocked-recovery phase or mode
- one coder recovery-response round type
- then hand off to:
  - normal scope execution
  - existing split-plan review
  - blocked terminal state

The guiding principle is:

- add the smallest possible recovery surface
- reuse existing execution and split-plan paths for the heavy lifting

## Operator Experience

The operator should be able to do something like:

- `neal --recover`
- or `neal --resume` when the run is in interactive blocked recovery

and then provide direct guidance that is recorded by Neal.

Examples:

- "stop retrying the direct migration; replace this scope with a narrower plan"
- "preserve the last accepted commit and continue from that base"
- "do not change infrastructure; the blocker is procedural"

Neal should then forward that guidance to the coder inside the session, record the response, and continue from the recovery action chosen by the coder.

## Artifacts And Audit Trail

Neal should record:

- the blocked reason
- the operator recovery guidance
- the coder's structured recovery response
- the resulting action taken
- any replacement plan or resumed scope details

This should live in ordinary Neal run artifacts so the recovery path is auditable.

The operator should not need to inspect external Codex transcripts just to understand what happened.

## Guardrails

The first version should include simple guardrails:

- at most a small bounded number of in-band recovery turns per blocked scope before Neal requires terminal block or scope replacement
- if the coder chooses `replace_current_scope`, it must use existing split-plan validation / review rules
- if the coder chooses `resume_current_scope`, Neal must return to ordinary execution rather than staying in an ambiguous half-blocked mode
- if the operator recovery input or coder response is malformed, Neal should remain safely paused rather than guessing

## Prompting Changes

Prompts should make three things explicit:

1. blocked recovery is now in-band
2. the coder must choose one of the small recovery actions
3. `replace_current_scope` should be used when the blocked problem has proven the current scope shape is wrong

The coder should not be asked to invent a brand-new recovery taxonomy inside the prompt.

Keep the prompt contract narrow.

## Verification

Minimum verification for the implementation:

1. State hydration / persistence tests for interactive blocked-recovery state.
2. Tests for parsing each recovery action:
   - `resume_current_scope`
   - `replace_current_scope`
   - `stay_blocked`
   - `terminal_block`
3. Synthetic run where operator guidance causes the coder to resume the current scope.
4. Synthetic run where operator guidance causes the coder to replace the current scope through split-plan recovery.
5. Synthetic run where the blocked run remains open for another recovery turn.
6. Resume tests for interrupted interactive blocked recovery.
7. Artifact / notification tests proving the run history captures operator intervention and the chosen recovery action.

## Acceptance Criteria

This work is complete only when all of the following are true:

1. Common blocked-recovery situations no longer require `--resume-coder` plus manual session surgery.
2. Neal can keep blocked recovery in-band and auditable.
3. The coder can explicitly choose whether to continue, replace, remain blocked, or stop terminally.
4. Scope replacement from blocked recovery reuses the existing split-plan machinery.
5. Interrupted recovery sessions can be resumed cleanly.
6. Tests cover the end-to-end blocked-recovery flow.

## Blocking Rules

Block only if:

- the existing split-plan / execution machinery cannot be reused coherently from blocked recovery
- or the CLI / session model cannot support in-band recovery without a broader redesign

Do not block merely because:

- a new blocked-recovery phase or mode is needed
- new prompt contracts are needed
- artifacts need to record operator recovery guidance

If a scope in this implementation plan proves too large, split-plan this implementation rather than forcing a one-pass redesign of blocked recovery.
