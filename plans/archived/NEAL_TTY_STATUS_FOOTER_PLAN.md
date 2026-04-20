## Execution Shape

executionShape: multi_scope

## Goal

Add a TTY-only live status footer to Neal's diagnostic stream so an interested operator can keep watching the ordinary live log stream while also seeing a pinned summary of the current run state at the bottom of the terminal.

This should improve observability without changing Neal's existing append-only logging model or degrading non-interactive usage.

The intended operator experience is:

- ordinary Neal diagnostic log lines still print as they do today
- when the diagnostic stream is an interactive terminal, Neal keeps a small pinned status area at the bottom
- that footer shows the most important live run state such as current scope, phase, elapsed time, and run status
- when the diagnostic stream is redirected, piped, or otherwise non-interactive, Neal behaves exactly as it does now

## Why This Matters

Right now Neal's diagnostic stream is useful as a historical event stream, but it is weak as a live "what is happening now?" surface.

For long-running executions, an observer often wants to know:

- what scope Neal is on
- whether the run is in coder, reviewer, consult, plan, split-plan, or blocked handling
- how long the current phase has been running
- whether the run is making progress or is stalled

That information exists in Neal state and artifacts, but it is not surfaced in a live, glanceable way.

## Desired Contract

After this implementation:

1. Neal continues to emit ordinary diagnostic log lines exactly as an append-only stream.
2. When `stderr` is a TTY, Neal renders a pinned live status footer beneath the scrolling log output.
3. The footer is purely presentational. It must not become a second source of truth or require changes to orchestration semantics.
4. When `stderr` is not a TTY, the footer is disabled automatically and Neal's diagnostic output remains plain text.
5. Footer rendering must not corrupt ordinary log lines or interfere with the final stdout JSON result.
6. The footer should update on important state transitions and on a bounded timer for elapsed-time freshness.

## Non-Goals

This plan should not:

- replace Neal's existing diagnostic logging
- introduce a full-screen terminal UI
- require third-party terminal state management unless implementation proves a small helper is clearly better than simple ANSI control
- change orchestration state solely to support display cosmetics
- promise exact total-scope counts in flows where the total is not yet knowable

## Display Model

The first version should use a small TTY-only footer rather than a full TUI.

The recommended rendering model is:

- keep diagnostic logs append-only
- before printing an ordinary log line, temporarily clear the footer area
- print the log line
- redraw the footer
- also refresh the footer on a timer while a phase is in progress

Footer redraws should be throttled so a burst of log lines does not force a redraw on every single write. A bounded minimum redraw interval plus redraw-after-line-write behavior is sufficient for the first version.

This keeps the implementation simple and lets Neal preserve its current textual logging behavior.

## Footer Content

The first version should show high-signal, low-churn fields only.

Preferred content:

- plan name
- current scope label
- total scope count when determinable from the current execution plan
- current phase
- elapsed time in current phase
- run status
- review round or consult round when relevant
- whether the current context is a derived-plan review or execution when relevant

Example shapes:

```text
[neal] NEAL_TTY_STATUS_FOOTER_PLAN.md | scope 3/6 | phase: reviewer_plan | elapsed: 02:14 | status: running
```

or, if a second line is justified:

```text
[neal] NEAL_TTY_STATUS_FOOTER_PLAN.md | scope 3/6 | phase: reviewer_plan | elapsed: 02:14 | status: running
[neal] review round: 2 | findings: 1 blocking | derived plan: pending_review
```

Guardrails:

- keep the footer short enough to be stable on narrow terminals
- do not include fields that flicker excessively or require heavy recomputation
- if total scope count is not currently knowable, prefer `scope 3/?` or just `scope 3`

## TTY Rules

Footer rendering should be enabled only when all of the following are true:

- `process.stderr.isTTY` is true
- Neal is not running in a mode where the diagnostic stream is known to be captured as a plain log artifact
- terminal control sequences are safe to emit

Footer rendering should be disabled when:

- stderr is piped or redirected
- terminal dimensions are too small for a stable footer
- the operator explicitly opts out via a config flag or environment variable if implementation adds one

The first version does not need a rich configuration surface, but it should leave room for a future opt-out if needed.

## Status Semantics

The footer should be derived from existing Neal state and runtime context.

It should not require new orchestration concepts.

Key fields should come from:

- current run state
- current phase
- current scope label helpers
- known execution queue data when available
- currently active review / consult round state
- phase heartbeat timing or the same phase-start source already used by the heartbeat machinery

The footer should make a best effort to present:

- `scope N/M` when `M` can be derived reliably
- `scope N/?` or `scope N` when `M` is not knowable
- derived-plan state explicitly when relevant, for example `scope 5.1` or `derived review`

Scope counts should be derived once per plan adoption rather than reparsed on every timer refresh. The cache should live in-memory in the status layer and be recomputed on startup and resume from the persisted plan document rather than being added to session state. The expected first-version rules are:

- top-level `one_shot` plan: total scopes is `1`
- top-level `multi_scope` plan with a valid execution queue: total scopes comes from the parsed queue
- derived-plan execution or review: total scopes comes from the adopted derived plan, not the parent plan
- if no reliable queue count is available: show `?` or omit the total

## Rendering Strategy

The implementation should prefer the smallest robust rendering mechanism.

Start with simple ANSI cursor-control rendering or a tiny helper library only if that clearly reduces edge-case risk.

The footer manager likely needs to handle:

- detect TTY eligibility
- maintain the latest footer text
- clear footer before ordinary diagnostic log writes
- redraw footer after complete line writes
- refresh elapsed-time display on a bounded timer
- throttle redraw frequency to avoid flicker during rapid output
- react safely to terminal resize
- clean up footer state on completion, interruption, or fatal error

Keep the rendering code isolated from orchestration logic.

If agent output can contain ANSI control sequences, footer redraw should happen after complete line writes rather than mid-fragment to reduce corruption risk.

## Implementation Surface

Likely implementation areas:

- [`src/neal/index.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/index.ts)
  - CLI bootstrap wiring for footer enablement
- [`src/neal/orchestrator.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/orchestrator.ts)
  - provide phase and state transitions to the footer surface without changing orchestration semantics
- logging / diagnostic helpers under `src/neal/`
  - centralize ordinary diagnostic writes through a shared wrapper so footer clearing / redraw can happen safely
  - replace scattered direct `process.stderr.write` usage and per-adapter diagnostic writers with the shared path
- current scope / execution-plan helpers under `src/neal/`
  - derive scope labels and total-scope counts when possible
- tests
  - renderer behavior
  - TTY gating
  - ordinary log preservation

If implementation benefits from a new file such as `src/neal/status-footer.ts`, that is preferred over scattering ANSI logic through the orchestrator.

## Risks

1. Log corruption
- Footer redraw logic could interleave badly with ordinary diagnostic writes.
- Mitigation: keep all ordinary diagnostic writes going through a small shared wrapper that clears and redraws the footer consistently.

2. TTY-only behavior leaking into non-interactive output
- ANSI sequences in redirected output would be unacceptable.
- Mitigation: hard-gate on `stderr` TTY detection and cover it with tests.

3. Flicker or noisy updates
- Over-eager redraws could make the display distracting.
- Mitigation: update on important state transitions and a small bounded timer rather than on every low-level event.

4. Misleading scope totals
- Some execution states do not have a stable total scope count.
- Mitigation: show totals only when derivable reliably; otherwise use `?` or omit them.

5. Terminal resize or abrupt exit leaves terminal junk behind
- Resize, Ctrl-C, or fatal exit could leave the footer in a bad state.
- Mitigation: handle resize explicitly, and clean up from the existing stop / exit paths in CLI bootstrap and top-level error handling.

## Verification Strategy

Minimum verification:

- `pnpm typecheck`
- renderer tests proving:
  - footer is disabled when stderr is not a TTY
  - footer text is rendered only in TTY mode
  - ordinary log writes still appear unchanged in order
  - footer redraw does not duplicate or corrupt ordinary log output
- state-derived status tests proving:
  - scope label formatting is correct for ordinary scopes
  - derived-plan scope labels are represented correctly
  - total scope count is shown only when knowable
  - elapsed-time formatting is stable and human-readable
- integration-style tests or harness coverage proving:
  - footer updates on phase transitions
  - footer updates while a phase remains active
  - footer cleanup on completion / blocked / failure does not leave terminal junk behind

The first version of renderer tests should primarily use a mocked writable stream and assert on the emitted write sequence. Data-model tests for scope / phase / elapsed formatting should stay separate from the ANSI rendering tests.

## Execution Queue

### Scope 1: Add A TTY-Only Footer Renderer
- Goal: Introduce a small isolated renderer that can manage a pinned footer on the diagnostic stream without changing Neal's non-interactive output behavior.
- Verification: `pnpm exec tsx --test test/status-footer.test.ts`; `pnpm typecheck`.
- Success Condition: Neal has a dedicated footer-rendering component that is fully disabled outside TTY mode and can safely render footer updates against a mocked terminal stream with deterministic write-sequence tests.

### Scope 2: Derive High-Signal Footer Status From Existing Neal State
- Goal: Build a small status-model layer that turns current Neal state into a concise footer summary without adding new orchestration concepts.
- Verification: `pnpm exec tsx --test test/status-footer.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success Condition: The footer can show plan name, current scope, phase, run status, elapsed time, and review / consult context using existing state and helpers, including cached total-scope counts when knowable and reasonable handling of unknown totals.

### Scope 3: Centralize Diagnostic Writes And Integrate Footer Rendering
- Goal: Route Neal's diagnostic output through a shared wrapper so ordinary log lines and the live footer coexist cleanly on stderr.
- Verification: `pnpm exec tsx --test test/status-footer.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success Condition: In TTY mode, Neal clears and redraws the footer around ordinary diagnostic writes without corrupting the log stream; in non-TTY mode, stderr output is unchanged from today's behavior, and stdout JSON behavior remains untouched.

### Scope 4: Add Timer Refresh, Cleanup, And End-To-End Coverage
- Goal: Make the footer useful during long phases and ensure it cleans up correctly on completion, blocked, and failure paths.
- Verification: `pnpm exec tsx --test test/status-footer.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success Condition: The footer refreshes elapsed time during active phases, updates on phase transitions with bounded redraw frequency, handles terminal resize safely, and does not leave stale terminal state behind when Neal exits, fails, or is interrupted.

## Acceptance Criteria

This work is complete only when all of the following are true:

1. Neal keeps its existing append-only diagnostic log behavior.
2. Interactive terminals on stderr get a live footer showing current run status.
3. Non-interactive stderr output remains plain text with no ANSI pollution.
4. The footer shows high-signal state such as scope, phase, elapsed time, and status.
5. The footer behaves reasonably for derived-plan and unknown-total-scope situations.
6. Tests cover TTY gating, redraw safety, and cleanup behavior.

When all scopes are complete, end with `AUTONOMY_DONE`.
