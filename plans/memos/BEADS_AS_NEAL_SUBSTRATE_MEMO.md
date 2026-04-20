# Decision

Do not use Beads as the underpinning of Neal's core work-chunk, execution-state, resume-state, or audit-trail layer.

At most, consider Beads later as an optional adjacent integration for backlog, dependency-graph, or discovered-work management.

# Question

Should Neal leverage [Beads](https://gastownhall.github.io/beads/) as the substrate for:

- work chunking
- state tracking
- audit / history
- or other related orchestration concerns

# Short Answer

No for the core runtime substrate.

Beads is a much better fit for issue / dependency / workflow-graph management than for Neal's live execution-state machine and resume/audit truth.

# What Beads Appears To Be Good At

Based on the docs, Beads is strongest as:

- a git-backed issue tracker for AI-supervised engineering work
- a dependency-aware work graph
- a workflow engine built around formulas, molecules, and gates
- a way to persist task state outside model context
- a multi-agent coordination layer around issues and workflow steps

Primary references:

- [Beads Introduction](https://gastownhall.github.io/beads/)
- [Beads Architecture Overview](https://gastownhall.github.io/beads/architecture)
- [Beads Workflows](https://gastownhall.github.io/beads/workflows)
- [Beads Molecules](https://gastownhall.github.io/beads/workflows/molecules)
- [Beads Gates](https://gastownhall.github.io/beads/workflows/gates)
- [Beads Multi-Agent](https://gastownhall.github.io/beads/multi-agent)
- [Beads Claude Code Integration](https://gastownhall.github.io/beads/integrations/claude-code)

# Why It Does Not Fit Neal's Core State Layer

## 1. The abstraction is wrong

Neal's core state is runtime orchestration state:

- coder / reviewer / adjudicator phases
- execution vs plan mode
- derived-plan lineage
- diagnostic recovery state
- interactive blocked recovery state
- final completion review state
- exact resume semantics
- run-local session handles
- run-local artifacts and event logs

Beads is centered on issues, dependencies, workflows, and gates.

Those are related concepts, but they are not the same thing. Trying to encode Neal's orchestration state as Beads issues or workflow steps would be a forced mapping and would likely make Neal harder to reason about.

## 2. Neal already needs its own run-local artifacts anyway

Even if Beads were introduced, Neal would still need to persist:

- `RUN_STATE.json`
- `plan-progress.json`
- `REVIEW.md`
- `CONSULT.md`
- stderr / event logs
- session handles
- retrospective and final-completion artifacts
- squash metadata

So Beads would not actually replace Neal's runtime truth. It would become an additional system to reconcile with Neal's own state.

## 3. Beads adds operational weight that Neal does not need at the core

Beads is built around Dolt-backed persistence and optional server/sync modes. That brings real complexity:

- another persistence model
- another CLI/runtime dependency
- sync and backup semantics
- another place where corruption, mismatch, or operator confusion can happen

That is too much weight for Neal's lowest-level runtime substrate, especially when Neal already has a coherent repo-local artifact model.

## 4. Some Beads tradeoffs cut against Neal's goals

The Beads architecture docs explicitly call out tradeoffs such as:

- no real-time collaboration
- manual sync model
- dependency on Dolt
- limits around concurrency and team scale
- repository scoping constraints

Those are acceptable tradeoffs for Beads' own problem domain, but they are not compelling reasons to rebuild Neal's runtime substrate around it.

Reference:

- [Beads Architecture Overview](https://gastownhall.github.io/beads/architecture)

## 5. The default git posture is misaligned with Neal's recent safety direction

Beads' configuration docs describe git automation defaults that include:

- `git.auto_commit = true`
- `git.auto_push = true`

Even if configurable, that is the opposite direction from Neal's increasingly explicit and conservative treatment of repo mutation and remote side effects.

Reference:

- [Beads Configuration](https://gastownhall.github.io/beads/reference/configuration)

# What Is Still Worth Learning From Beads

Beads has several ideas that are worth adopting selectively:

- explicit dependency-aware work graphs
- discovered-work capture as first-class data
- reusable workflow templates
- structured gates for human approval or external waiting conditions
- durable task state outside model context
- machine-readable CLI responses

Those are useful ideas for Neal.

The recommendation is to borrow concepts, not the runtime/storage substrate.

# Where Beads Might Fit Narrowly

If Neal ever integrates with Beads, the right scope would be optional and adjacent, for example:

- backlog / campaign management
- discovered-work graph
- cross-plan dependency tracking
- operator-facing queueing of future work

That would make Beads a companion system, not the source of truth for Neal's live execution state.

# Better Alternatives For Neal's Core

If Neal needs a stronger substrate than its current JSON + artifact model, better fits would be:

## Option 1: Keep the current Neal-owned run artifacts

This remains the best fit if the goal is:

- exact resume
- explicit audit artifacts
- low operational overhead
- repo-local debuggability

## Option 2: Build a Neal-owned event ledger

If the current state model starts to strain, the natural next move is:

- append-only Neal event log
- materialized state derived from the event log
- possibly SQLite or another small local store

That would still be Neal-shaped, instead of issue-tracker-shaped.

## Option 3: Optional external work-graph integration later

If backlog/dependency management becomes important, integrate with something Beads-like later without making it the runtime truth for execution.

# Recommendation

Do not adopt Beads as Neal's core work chunk / state / audit substrate.

Do:

- keep Neal's runtime truth Neal-owned
- continue improving Neal's run-local state and artifact model
- borrow selected Beads concepts where they directly help
- revisit optional Beads integration only if backlog/dependency graph management becomes a real unmet need

Do not:

- migrate Neal's live execution-state machine onto Beads
- treat Beads issues/workflows as the source of truth for resume state
- add Dolt / sync complexity to Neal's lowest-level orchestration layer

# Sources

- [Beads Introduction](https://gastownhall.github.io/beads/)
- [Beads Architecture Overview](https://gastownhall.github.io/beads/architecture)
- [Beads Workflows](https://gastownhall.github.io/beads/workflows)
- [Beads Molecules](https://gastownhall.github.io/beads/workflows/molecules)
- [Beads Gates](https://gastownhall.github.io/beads/workflows/gates)
- [Beads Multi-Agent](https://gastownhall.github.io/beads/multi-agent)
- [Beads Claude Code Integration](https://gastownhall.github.io/beads/integrations/claude-code)
- [Beads Configuration](https://gastownhall.github.io/beads/reference/configuration)
- [Beads GitHub README](https://github.com/gastownhall/beads)
- [Gas Town GitHub README](https://github.com/gastownhall/gastown)
