# Goal

Add an interactive Neal supervisor mode that gives the operator a persistent, high-level terminal session for starting, observing, and steering Neal work without exposing the raw coder/reviewer log stream as the primary interface.

This mode should be inspired by the value of Gas Town's Mayor:

- one operator-facing coordination session
- high-level summaries instead of nonstop raw worker output
- ability to dispatch work and inspect status from one place

But it should be implemented on top of Neal's existing run/orchestrator/provider architecture, not by adopting Gas Town's tmux-first worker-control implementation.

# Problem Statement

Neal's current operator interaction model is command-by-command:

- run `neal --plan`, `neal --execute`, `neal --research`, `neal --resume`, etc.
- watch stderr logging stream while work happens
- inspect artifacts or session state separately when more detail is needed

This is workable but not ideal for long-running or repeated Neal use because:

- the default live output is noisier than the operator often wants
- there is no persistent operator-facing control surface
- switching between runs or checking overall status requires separate commands
- the operator sees low-level progress details before higher-level summaries

Gas Town's Mayor demonstrates a useful product idea here:

- a persistent top-level coordination session
- summary-first visibility
- operator commands from one place
- worker detail available on demand rather than by default

That is a good fit for Neal at the UX level.

However, Gas Town's implementation is heavily tmux/session/wrapper driven. Neal should not copy that substrate:

- Gas Town orchestrates black-box terminal CLIs through tmux sessions, respawn, wrapper scripts, and send-keys patterns
- Neal already has its own orchestrator state, persisted run artifacts, provider adapters, and session handles
- copying the tmux-first implementation would make Neal more brittle, not less

The right move is to add a Neal-native interactive supervisory front-end on top of Neal's current runtime model.

# Research Findings

Review of `~/code/personal/gastown` suggests:

1. The Mayor concept is productively valuable

- a persistent coordinator session
- summary-over-logs operator experience
- centralized dispatch and observation

2. Gas Town's implementation approach is not the right one for Neal

- tmux sessions are the core control plane
- wrappers like `gt-codex` and `gt-opencode` run `gt prime` before launching agent CLIs
- role coordination uses tmux lifecycle, mail, nudges, and process detection
- many workflows rely on terminal/session mechanics rather than Neal-style run/orchestrator state

Relevant sources inspected:

- [~/code/personal/gastown/README.md](/Users/lee.nave/code/personal/gastown/README.md)
- [~/code/personal/gastown/docs/design/architecture.md](/Users/lee.nave/code/personal/gastown/docs/design/architecture.md)
- [~/code/personal/gastown/docs/agent-provider-integration.md](/Users/lee.nave/code/personal/gastown/docs/agent-provider-integration.md)
- [~/code/personal/gastown/internal/mayor/manager.go](/Users/lee.nave/code/personal/gastown/internal/mayor/manager.go)
- [~/code/personal/gastown/internal/session/lifecycle.go](/Users/lee.nave/code/personal/gastown/internal/session/lifecycle.go)
- [~/code/personal/gastown/internal/wrappers/scripts/gt-codex](/Users/lee.nave/code/personal/gastown/internal/wrappers/scripts/gt-codex)
- [~/code/personal/gastown/internal/cmd/seance.go](/Users/lee.nave/code/personal/gastown/internal/cmd/seance.go)

Conclusion from that research:

- Neal should borrow the interaction model, not the runtime mechanics
- the supervisor should be Neal-native and run-aware
- tmux should be optional or absent in the first version

# Desired Contract

Add a new top-level interactive mode, tentatively:

```text
neal --supervise
```

The supervisor should:

1. Start a persistent operator-facing interactive session

- one command opens a Neal control surface
- the session remains available while the operator dispatches and inspects work

2. Be summary-first

- the default view should show current runs, modes, phases, elapsed time, and high-level status
- raw stderr-style logs should be secondary or opt-in

3. Orchestrate existing Neal modes

- allow launching or resuming `plan`, `execute`, `research`, and relevant recovery flows from within the supervisor
- the supervisor should not invent a separate execution substrate

4. Preserve Neal's current run truth

- `.neal/runs/*`, `RUN_STATE.json`, progress JSON/markdown, review artifacts, and existing provider session handles remain the source of truth
- the supervisor is a control plane and presentation layer, not a replacement persistence model

5. Support drill-down

- from a summary view, the operator can inspect:
  - current run state
  - latest review findings
  - research or plan artifacts
  - recent event/log output when needed

6. Avoid tmux dependence in v1

- the first version should run as a Neal-owned terminal REPL/TUI shell
- no send-keys orchestration
- no tmux worker pane management

# Non-Goals

This plan should not:

- replace Neal's existing non-interactive CLI commands
- replace Neal's run artifact model
- adopt Gas Town's tmux-based worker/session lifecycle model
- require multiplexed worker terminals in the first version
- add multi-agent worker swarms or workspace-manager concepts outside Neal's current scope
- become a full-screen terminal UI framework project in v1

# Product Shape

The first version should likely be a lightweight interactive shell rather than a full-screen TUI.

Reasons:

- faster to implement and easier to harden
- aligns with Neal's current CLI architecture
- can still provide summary-first output and command dispatch
- avoids overcommitting to a terminal UI substrate too early

The shell should support commands such as:

- `status`
- `runs`
- `show <run>`
- `tail <run>`
- `plan <path>`
- `execute <path>`
- `research <path-or-text>`
- `resume <run-or-state>`
- `diagnose <run>`
- `help`
- `quit`

The exact command set may change, but the key is that the supervisor should be one persistent interaction loop for Neal operations.

# UX Principles

1. Summary first

The operator should see concise state such as:

- run id
- mode
- plan or research target
- current phase
- status
- elapsed time
- whether operator guidance is needed

2. Raw detail on demand

The operator should be able to ask for:

- current review findings
- recent stderr/event output
- artifact paths
- latest memo/plan/review content

but Neal should not dump those by default.

3. No duplicate truth

The supervisor should present existing Neal run state rather than maintaining an independent parallel state machine.

4. Clear operator actions

If a run is blocked or awaiting guidance, the supervisor should clearly say what the next available Neal action is.

# Architecture Strategy

The supervisor should be a front-end layer over existing Neal capabilities.

It should reuse:

- existing CLI/run initialization paths where practical
- existing run state loading and validation
- existing artifact rendering and summary helpers
- existing provider-backed orchestration

It should not:

- take over direct control of coder/reviewer provider sessions in a new way
- bypass Neal's persisted run lifecycle

The clean architecture is:

- Neal core orchestrator remains unchanged as the execution engine
- supervisor mode becomes a persistent command loop that calls into Neal operations and renders Neal state

# Gas Town Comparison

Gas Town's Mayor is useful as a product reference, but not as an implementation template.

What to borrow:

- persistent top-level coordinator UX
- summary-over-logs presentation
- one-place dispatch and observation

What not to borrow:

- tmux as Neal's core control plane
- wrapper-script priming as the main execution substrate
- send-keys and pane lifecycle as the coordination mechanism
- session-respawn logic as the primary run model

# Guardrails

1. The supervisor must not become a second source of truth for run state.
2. The supervisor must not require tmux in the first version.
3. The supervisor must use existing Neal orchestration flows rather than inventing a separate worker-control mechanism.
4. The default operator experience must be summary-first, not raw-log-first.
5. Existing non-interactive CLI commands must remain first-class and continue to work independently.

# Verification Strategy

Verification should cover:

- entering and exiting supervisor mode cleanly
- launching existing Neal operations from the supervisor
- status/runs/show/tail style read paths reflecting real run state
- blocked/awaiting-guidance runs surfacing the correct next actions
- no divergence between supervisor-rendered state and persisted run artifacts

The first version can rely heavily on command-loop and state-render tests rather than provider live tests.

# Scope 1: Supervisor Shell Skeleton

Add the new top-level mode and interactive command loop.

Goal:

- add `neal --supervise`
- implement a persistent interactive shell with `help`, `quit`, and a minimal command parser
- make the shell resilient to ordinary bad input

Verification:

- `pnpm typecheck`
- targeted tests for shell startup, command parsing, and shutdown

Success Condition:

- Neal can start a persistent supervisor session and accept a small set of interactive commands.

# Scope 2: Summary and Inspection Commands

Add run-aware summary and drill-down views.

Goal:

- implement commands like `status`, `runs`, and `show <run>`
- render high-level summaries from existing run state and artifacts
- support a lightweight `tail` or recent-event view for detail on demand

Verification:

- `pnpm typecheck`
- targeted tests for rendering summary output from representative run fixtures

Success Condition:

- The supervisor presents existing Neal runs in a concise, useful, summary-first way.

# Scope 3: Dispatch Existing Neal Operations

Enable the supervisor to launch and resume Neal work.

Goal:

- support starting `plan`, `execute`, and `research` flows from the supervisor
- support resuming existing runs
- surface the launched run back into the supervisor summary view

Verification:

- `pnpm typecheck`
- tests that the supervisor dispatches the same underlying Neal operations as the standalone CLI

Success Condition:

- The supervisor can act as an operator control plane for ordinary Neal work without bypassing Neal's existing run lifecycle.

# Scope 4: Blocked/Guidance UX

Make the supervisor useful during interruptions and operator decisions.

Goal:

- surface waiting-for-operator-guidance states clearly
- show the next likely Neal actions
- make drill-down into review findings and relevant artifacts easy

Verification:

- `pnpm typecheck`
- tests for blocked and awaiting-guidance run rendering

Success Condition:

- The supervisor is meaningfully better than raw stderr logging for managing blocked or long-running Neal work.

# Scope 5: Polish and Documentation

Document the new mode and refine the operator experience.

Goal:

- add README coverage
- tighten command help text
- make summary formatting and error output clean and stable

Verification:

- `pnpm typecheck`
- targeted tests for usage/help output

Success Condition:

- The supervisor mode is discoverable, understandable, and clearly positioned as a Neal-native coordinator interface.

# Recommended Implementation Order

1. Build the shell skeleton first.
2. Add summary/inspection views next.
3. Then dispatch existing Neal operations from within the shell.
4. Add blocked/guidance UX after the control flow is stable.
5. Finish with docs and polish.

# Final Notes

This feature is worthwhile because it captures the best part of the Mayor idea without importing the parts of Gas Town that do not fit Neal.

The first version should remain intentionally modest:

- interactive shell, not full TUI
- Neal-native run orchestration, not tmux worker control
- summary-first operator UX, not raw log streaming

When all scopes are complete, end with `AUTONOMY_DONE`.
