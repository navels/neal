# neal

**neal** — from *anneal*: repeated, controlled adjustment toward a more
stable result.

[![CI](https://github.com/navels/neal/actions/workflows/ci.yml/badge.svg)](https://github.com/navels/neal/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@navels/neal.svg)](https://www.npmjs.com/package/@navels/neal)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **A plan-driven, multi-agent coding loop.** Separate **planner**, **coder**, and **reviewer** roles, each on the provider and model you choose, work together to implement your plan.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/neal-core-flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/neal-core-flow-light.svg">
  <img alt="neal execution flow" src="docs/assets/neal-core-flow-light.svg">
</picture>

neal is a local planner/coder/reviewer loop for your repo. You write a plan, and neal's planner/reviewer loop turns it into a human-reviewable execution plan with an execution shape, manageable scopes, and high-level implementation detail grounded in the current repository. neal then runs each scope with your configured coder and reviewer roles. After every scope is accepted, a final review pass checks the total set of changes against the entire plan. Run artifacts are recorded under `.neal/` so interrupted work can resume.

Two choices explain the design:

- **The coder and reviewer run on different vendors.** The review is genuinely adversarial: a second model with its own blind spots checks the first, instead of one model grading its own work.
- **Each scope starts the coder from a fresh context.** A long plan doesn't drift the way a single agent does as its context fills up.

### Support MusiCares

If neal has been useful to you, please consider donating to MusiCares. It's a
non-profit giving musicians a place to turn to in times of financial, personal,
or medical crisis.

[![Donate to MusiCares](https://img.shields.io/badge/Donate_to-MusiCares-b51f2e.svg)](https://www.musicares.org/about/?form=FUNKYMLRVWU&fundraiser=NTYJWDJE&member=SHEDDUJS)

### What makes neal interesting

- **Roles, not one monolithic agent.** Planner, coder, and reviewer are independent, separately configurable roles. Mix vendors and models per role (e.g. Codex codes, Claude reviews).
- **The reviewer is read-only.** Declared at provider registration and enforced mechanically in each adapter (OS sandbox for Codex, SDK tool allowlist for Claude, a neal-owned jailed toolset for OpenRouter models). See [SECURITY.md](SECURITY.md) and [docs/providers.md](docs/providers.md).
- **`neal compat`.** A built-in harness that qualifies any OpenAI-compatible / OpenRouter model across all three roles and emits a dated PASS/FAIL whitelist. See [docs/compatible-models.md](docs/compatible-models.md).
- **Crash-safe and resumable.** Every run's state and artifacts live under `.neal/`. `neal resume` continues an interrupted run.
- **Bounded autonomous recovery.** neal resolves a class of reviewer/coder deadlocks itself, and escalates genuine blockers.
- **Scopes can split themselves.** When a scope turns out bigger than expected, the coder splits it into a derived sub-plan instead of forcing a bad implementation into one commit. See [docs/plan-format.md](docs/plan-format.md).

For how the pieces fit together, see the [architecture overview](docs/architecture.md).

**Contents:** [Quickstart](#quickstart) ·
[Why neal exists](#why-neal-exists) ·
[Installation](#installation) ·
[Provider setup](#provider-setup) ·
[Command tour](#command-tour) ·
[Commands](#commands) ·
[Exit codes](#command-exit-codes) ·
[Configuration](#configuration) ·
[Artifacts](#artifacts-and-storage) ·
[Plan shape](#plan-shape) ·
[Safety notes](#safety-notes)

## Quickstart

```bash
npm install -g @navels/neal
neal setup          # pick providers for the coder and reviewer roles
neal check          # verify config and provider readiness
```

No Claude or Codex subscription? Pick a qualified model slug from the
[compatibility whitelist](docs/compatible-models.md) and use the OpenRouter
provider (see [Provider setup](#provider-setup)).

Describe a real feature in plain language and write it to a file (e.g., `PLAN.md`):

```md
Add a "Sign in with Google" option to the login page using OAuth 2.0.
Store the resulting session the same way the existing email/password login does.
```

Then run neal from your repository root:

```bash
neal run <path-to-PLAN.md>
```

Note: I usually keep plan docs in a .gitignore-ed directory in my repo but ymmv.

Want to read the refined plan before neal executes it? Run the two steps
separately instead:

```bash
neal plan <path-to-PLAN.md>
# review/update the refined plan, then:
neal execute <path-to-PLAN.md>
```

## Why neal exists

neal grew out of a large frontend upgrade (Ember 3.28 to Ember 5) where the agent would drift over time from its initial instructions, which led to me wanting to break up the work into smaller chunks and reset the agent context before each chunk. I also wanted to incorporate my manual workflow of having Claude review Codex's work, copy/pasting findings and responses until both agents were satisfied with the result, before reviewing myself. I settled on this flow for neal:

- start with a plan of what work needs to be done and how to do it
- neal sends this through the planner/reviewer loop to give it an execution shape, define manageable scopes, and flesh out the implementation approach
- each scope is run through the coder/reviewer loop with the coder starting with a fresh context and the reviewer keeping its context from scope to scope
- when the reviewer is satisfied, neal moves on to the next scope with the previous scope committed
- after all scopes are complete, the entire set of changes is run through the coder/reviewer loop a final time
- if a scope is found to be too large, the coder can split it into a sub-plan
- if the coder is blocked on something, it can consult the reviewer model for assistance
- if neal exits for any reason, `neal resume` will attempt to continue, prompting for direction if the coder was blocked
- run artifacts and state are recorded in `.neal/`

## Installation

```bash
npm install -g @navels/neal
```

neal requires Node.js >= 24.18.0 and drives your configured provider CLIs/SDKs
(OpenAI Codex, Anthropic Claude, or any OpenAI-compatible / OpenRouter model).
See [Provider setup](#provider-setup).

### Run from source / contribute

```bash
corepack enable && pnpm install && pnpm start -- help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor setup, the development
link, verification commands, CI gates, and canonical doc references.

## Provider setup

neal uses separate providers for the planner, coder, and reviewer roles. `neal
setup` writes explicit coder and reviewer defaults to `~/.neal/config.yml`.

A typical config uses Codex for coding and Claude for review:

```yaml
agent:
  coder:
    provider: openai-codex
    model: null
  reviewer:
    provider: anthropic-claude
    model: null
```

`model: null` lets the provider choose its default model. The planner can also be configured
but otherwise inherits from the coder config.

| Provider id | Setup |
| --- | --- |
| `openai-codex` | Complete the normal Codex local setup/login, or use your `OPENAI_API_KEY`. |
| `anthropic-claude` | Complete the normal Claude local setup/login, or use your `ANTHROPIC_API_KEY`. |
| `openai-compatible` | Connect an OpenAI-compatible Chat Completions API such as OpenRouter, DeepSeek, Ollama, or vLLM. |

### OpenRouter and other OpenAI-compatible APIs

Use `openai-compatible` to run models through OpenRouter or another API that
implements OpenAI-compatible Chat Completions. It's separate from
`openai-codex` and doesn't use the Codex CLI or login.

For OpenRouter, export your API key:

```bash
export OPENROUTER_API_KEY=...
```

Then add the endpoint to `~/.neal/config.yml`:

```yaml
providers:
  openai_compatible:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
```

For another compatible API, change the URL and key variable. See
[docs/providers.md](docs/providers.md) for environment-only configuration and
local endpoints.

Run setup once:

```bash
neal setup
```

`neal setup` detects local runtimes and configured OpenAI-compatible settings,
but it doesn't authenticate or send prompts. Choose `openai-compatible` for
each role you want to run through OpenRouter, then enter an OpenRouter model
slug such as `deepseek/deepseek-v3.2`.

To script the same provider for every role:

```bash
neal setup --provider anthropic-claude --all-roles
```

Existing effective provider settings are not overwritten unless you confirm
interactively or pass `--force`.

Then verify the config and live provider access:

```bash
neal check
```

`neal check` prints the effective planner/coder/reviewer choices, then prompts
before sending one small live request to each configured role. In non-interactive
shells, it only validates config and reports that live verification was skipped.

Before using an `openai-compatible` model for real work, run `neal compat` (see
[docs/compat.md](docs/compat.md)). Free or heavily rate-limited model pools
usually fail as coders and are unreliable reviewers. Provider details are in
[docs/providers.md](docs/providers.md), and common setup/auth failures are in
[docs/troubleshooting.md](docs/troubleshooting.md).

## Command tour

Writer commands require a Git repository with an existing `HEAD` commit before
provider execution. Create and commit the repository's initial baseline before
asking neal to plan, run, execute, resume, or squash work.

Use `neal plan` and `neal execute` separately when you want to review the
normalized plan document before execution:

```bash
neal plan PLAN.md
neal execute PLAN.md
neal execute PLAN.md --no-squash
```

Refine and execute one or more plans serially:

```bash
neal run tmp/A.md tmp/B.md
neal run --no-squash tmp/A.md tmp/B.md
```

When a run needs an operator it stops in a
controlled state and the command exits with code `2`; `neal status` says
whether it takes resume guidance or needs inspection. A harness with no
operator available (CI, cron, a benchmark driver) treats that exit as a
failure. See [docs/automation.md](docs/automation.md).

To run an example through neal after configuring providers:

```bash
neal setup
neal check
cd examples/issue-triage-js
neal run PLAN.md
pnpm test
```

See [examples/issue-triage-js/README.md](examples/issue-triage-js/README.md)
for the example guide and safety notes.

Resume interrupted work:

```bash
neal resume
neal resume --run <run-id>
```

Give guidance only when `neal status` or `neal resume` says the selected run is waiting for it:

```bash
neal resume --run <run-id> --message "Keep the change bounded to the failing test and rerun the required validation gate."
```

`neal review` is a separate, plan-free workflow for already-committed work. The
coder proposes findings, the reviewer judges them, and neal rejects any
worktree changes made during the review:

```bash
neal review --last 3
neal review "Focus on auth/session handling." --since origin/main
```

Inspect status:

```bash
neal status
neal status --run <run-id>
neal status --json --run <run-id>
neal status --all
neal status --json --all
```

## Automation contract

neal keeps a stable machine-facing contract for driving it from scripts, CI, and benchmark harnesses: writer exit codes, the `neal status --json` classification schema, patch-submission eligibility, and harness timeout and trace-publishing guidance. See [docs/automation.md](docs/automation.md). [neal-swebench](https://github.com/navels/neal-swebench) drives neal through this contract to benchmark role pairings on SWE-bench Pro.

## Commands

```bash
# Setup
neal setup
neal check
neal compat [--model <slug>] [--role coder|reviewer|planner|all] [--reference openai-codex|anthropic-claude|openai-compatible:<slug>] [--json]

# Plan execution
neal run [--no-squash] <plan.md> [more-plans...]
neal plan <plan.md>
neal execute <plan.md> [--no-squash]
neal resume [--run <run-id>] [--message "..."]

# Plan-free review
neal review [message] (--last <n> | --since <base>)

# Inspection and maintenance
neal status [--json] [--run <run-id>]
neal status [--json] --all
neal squash [plan.md]

# CLI information
neal version
neal help
neal --help
neal -h
```

### Setup

`neal setup` detects available providers and writes coder, reviewer, and optional
planner choices to `~/.neal/config.yml`. `neal check` validates that config and
can make a small live request to each configured role.

`neal compat` is a full-loop smoke test for an `openai-compatible` model, not a
skill benchmark. See [docs/compat.md](docs/compat.md) for the test contract and
[docs/compatible-models.md](docs/compatible-models.md) for the current results.

### Plan execution

`neal run` is the normal workflow. It refines each plan, executes it, and runs
multiple plan arguments in order. Use `neal plan` and `neal execute` separately
when you want to inspect or edit the refined plan before execution.

Writer commands require a Git repository with an existing commit. `neal execute`
and `neal run` can edit files and create commits, then squash their completed
work by default. Pass `--no-squash` to keep the per-scope commits.

`neal resume` continues the current run or a run selected with `--run`. If neal
needs guidance or manual work, `neal resume` and `neal status` explain what is
needed and print the command to continue.

See [docs/state-machine.md](docs/state-machine.md) for operator blocks, manual
gates, and resume behavior, and [docs/plan-format.md](docs/plan-format.md)
for execution shapes and selected-plan handling.

### Plan-free review

`neal review` has the coder propose findings and the reviewer judge them against
already-committed work. Use `--last` or `--since` to choose the commit range and
an optional message to focus the review. The drafting coder still has coder
privileges, so neal checks the worktree after every provider call and fails if
anything changed outside the review artifacts. This is useful for a coordinated
multi-model review of a PR.

### Inspection and maintenance

`neal status` shows the current run, or all runs with `--all`. Its `--json`
forms are the stable automation interface.

`neal squash` rewrites a completed run into one commit. It previews the change
and requires interactive confirmation before rewriting history.

### CLI information

`neal version` prints the package version. `neal help`, `neal --help`, and
`neal -h` print the supported command surface.

## Command exit codes

The writer commands `neal plan`, `neal execute`, `neal run`, and `neal resume`
use this shell contract:

- `0`: completed writer run, completed `neal run` queue, or resume selection
  that was already done.
- `1`: invalid CLI usage, missing setup or configuration, pre-run Git/worktree
  precondition failure, or another thrown error before neal has a writer result.
- `2`: controlled incomplete state: blocked, waiting for operator guidance,
  waiting for a manual gate, paused, already running under a live lock, or
  manual-gate resume checks still failing.
- `3`: failed writer run or failed `neal run` queue after neal has run
  state/result evidence.

`2` means the run stopped for operator intervention; `3` means a genuine
failure. A run that stops for an operator always exits `2`, never `3`. Not
every exit-2 stop resumes with a message: most accept `neal resume`
(optionally with `--message`), but some — a blocked final-completion review —
stay blocked and need `neal status` and artifact inspection instead. Harnesses
that need a hard verdict with no operator attached treat exit `2` as a failure
themselves.

Use `neal status --json` for the stable detailed automation interface. `neal
status` exits `0` when it successfully reports status, even if the reported run
is blocked, paused, waiting for guidance, waiting for a manual gate, or failed.

## Terminal output

neal prints narrative-focused progress by default. The default stream says what the loop is doing at a human level, while raw provider detail, command output, session handles, and reviewer context are kept out of the normal terminal view.

Interactive TTY writer runs accept live keys:

- `v`: switch between narrative and low-level detail views
- `q`: stop after the current scope during execution (`neal execute` or the execution portion of `neal run`)

The read-only long-running `neal review` command also supports the `v` detail toggle. Toggling views is process-local terminal state only. Provider prompts, run state, resume behavior, artifacts, and command semantics stay unchanged.

Low-level detail is still persisted for debugging. Inspect `.neal/runs/<run-id>/stderr.log` and `.neal/runs/<run-id>/events.ndjson` for writer runs, or the corresponding review artifact directory for read-only review loops.

## Configuration

Config precedence is:

1. repo `neal.yml`
2. `~/.neal/config.yml`
3. built-in defaults

Fresh writer-run commands require explicit `agent.coder.provider` and `agent.reviewer.provider` settings from either user or repo config. If either role is missing, neal reports the missing config key. Use `neal setup` for first-time provider/model defaults. Edit YAML manually when you need precise control.

This repository has a commented template [neal.yml](neal.yml).

You can configure the planner independently:

```yaml
agent:
  planner:
    provider: openai-codex
    model: gpt-plan
  coder:
    provider: openai-codex
    model: gpt-code
  reviewer:
    provider: anthropic-claude
    model: null
```

Each role also accepts an optional `effort` reasoning-depth override. Omitting it
or setting `effort: null` keeps the provider default. Supported values are
`minimal, low, medium, high, xhigh` for `openai-codex` and
`low, medium, high, xhigh, max` for `anthropic-claude`. An unsupported value is
rejected before a run starts. `openai-compatible` doesn't currently support an
effort override. Some compatible endpoints expose reasoning controls, but the
accepted values and behavior vary by endpoint and model, so neal leaves them at
the upstream default.

```yaml
agent:
  coder:
    provider: openai-codex
    model: null
    effort: high
  reviewer:
    provider: anthropic-claude
    model: null
    effort: xhigh
```

### Review level

`neal.review_level` sets how strict the scope reviewer and the final-completion
reviewer are about what rises to a blocking finding. It takes one of three
values and defaults to `moderate`:

- `strict`: assume adversarial trust boundaries. Block on any failure reachable
  under the worst case, including hardening gaps and missing defenses against
  local or adversarial actors.
- `moderate`: ordinary trust boundaries. Internal run artifacts aren't security
  boundaries. Block on correctness bugs and failures reachable under normal use;
  don't require defenses against an actor who could already subvert the system.
- `lenient`: correctness and real, reachable bugs only. Minimal robustness,
  style, or hardening demands.

```yaml
neal:
  review_level: moderate
```

Set it in the repo's `neal.yml` or in `~/.neal/config.yml`; the repo value wins.
A blank or null value means unset and falls back to `moderate`. Any other
nonblank value (a typo, say) is rejected before any agent work: `neal check`
fails, every fresh writer command fails at config load, and a `neal resume`
that has selected a run and is about to resume writer work (plain, manual
gate, or `--message`) fails before it takes the writer lock, rewrites run
state, or starts an agent turn. Resume outcomes that never execute writer work
(already done, already running, waiting for operator guidance) are decided
first and don't validate the level.

Under every level a blocking finding has to describe a failure that's actually
reachable under the assumed trust boundaries, and the reviewer still treats the
change as hostile input and tries to falsify it before crediting it. A level
narrows what counts as blocking; it never means trust the coder or skip
inspection. The plan reviewer, the consultant, and `neal review` don't use the
level.

`~/.neal/guidance/reviewer.md` refines the level rather than replacing it. It
can widen or narrow the assumed trust boundaries ("we do defend the run
directory against local processes" makes a local-process attack on the run
directory blockable even at `moderate`) and it can demote or promote finding
categories ("ignore performance, correctness only" makes a performance
regression non-blocking at any level). It can't turn off the reachability
filter, the adversarial stance, or blocking on reachable correctness failures,
including correctness regressions. Guidance that conflicts with that floor is
ignored on that point. See [Custom guidance](#custom-guidance) for where the
file lives.

### Custom guidance

neal supports additive guidance files for local preferences alongside the built-in protocol prompts:

- `~/.neal/guidance/coder.md`
- `~/.neal/guidance/reviewer.md`
- `~/.neal/guidance/planner.md`

Set `NEAL_GUIDANCE_DIR=/path/to/guidance` to load those same `coder.md`, `reviewer.md`, and `planner.md` files from another directory. neal records applied guidance roles, selected paths, and byte counts in run artifacts. Guidance contents stay out of terminal output.

For the two code reviewers, `reviewer.md` layers on top of `neal.review_level`
(see [Review level](#review-level)): it can adjust trust boundaries and finding
categories, but it can't switch off the reachability filter or blocking on
reachable correctness failures.

## Artifacts and storage

Writer run artifacts live under `.neal/runs/<run-id>/`, including the original-plan backup at `.neal/runs/<run-id>/PLAN_ORIGINAL.md` and reviewer scratch space under `.neal/runs/<run-id>/scratch/`. Queue artifacts live under `.neal/queues/<queue-id>/`. Review findings artifacts live under `.neal/reviews/<review-id>/`.

The run-local scratch directory is reserved for reviewer verification artifacts.
Current built-in reviewer prompts are read-only and do not use it. Root-level
scratch directories such as `build_review/` are still ordinary project-tree
dirtiness and must be cleaned up by the operator or committed through the normal
accepted-scope flow.

Project-local `.neal/` is the source of truth for runs, queues, reviews, progress, and audit history. Keep `.neal/` ignored by Git. It may contain prompts, diffs, command output, local paths, provider responses, reviewer scratch files, copied tests, build logs, and project-specific context. Use `neal status --all` to discover run IDs, and use `--run <run-id>` to select a run for `resume` or `status`.

For what may (and may not) be published from a run as public automation or benchmark traces, see [docs/automation.md](docs/automation.md).

The storage layout, artifact classifications, run pointers, and retention guidance are documented in [docs/storage.md](docs/storage.md). Persisted run and queue state boundaries are documented in [docs/state-machine.md](docs/state-machine.md).

## Known limitations

- Writer providers currently run with broad local permissions. See [docs/providers.md](docs/providers.md) and Safety notes for the current provider permission boundaries.
- neal stores project-local artifacts under `.neal/`. Those artifacts may contain prompts, diffs, command output, paths, provider responses, and local context. See [docs/storage.md](docs/storage.md) for artifact retention and privacy details.

## Plan shape

Every executable neal plan must declare exactly one execution shape in a literal `## Execution Shape` section.
The full executable-plan format reference is [docs/plan-format.md](docs/plan-format.md). In practice you can just
let neal format your plan into this shape.

Use `executionShape: one_shot` when the full task can be implemented, reviewed, and verified as one bounded scope:

```md
## Execution Shape

executionShape: one_shot
```

Use `executionShape: multi_scope` when the work is a finite ordered queue:

```md
## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Add parser support
- Goal: Parse the new contract safely.
- Verification: `pnpm typecheck`
- Success Condition: The parser accepts valid input and rejects malformed input.

### Scope 2: Add regression coverage
- Goal: Lock the new behavior in with tests.
- Verification: `pnpm test`
- Success Condition: The new path is covered and existing shapes still pass.
```

Use `executionShape: multi_scope_unknown` when the work repeats one bounded recurring slice at a time, but the total number of slices is intentionally unknown until a stop rule becomes true.

## Safety notes

Writer commands can edit files and create commits in the target repository. Run neal in a disposable checkout, branch, worktree, container, or VM when the repository or provider credentials are sensitive.

Current writer providers run with broad local permissions. The OpenAI Codex provider is configured with `approvalPolicy: never` and `sandboxMode: danger-full-access`. The Claude provider uses `permissionMode: bypassPermissions`. Treat planner and coder providers as capable of modifying the checkout unless you have added external sandboxing. The reviewer role is read-only: OS-sandboxed for the Codex reviewer, and enforced at the SDK/tool-wiring level for the others, so outside Codex the guarantee is only as strong as the adapter. Reviewers can also read files outside the repository unless the adapter jails reads (only `openai-compatible` does). See [SECURITY.md](SECURITY.md).

`neal execute` and `neal run` can create commits and rewrite run-owned commits into a final squash commit by default. Squashed commit messages are semantic summaries of the implemented project change. Plan provenance is kept in neal artifacts instead of commit subjects, bullets, or trailers. Repo-local nonignored selected plan documents may be included in the run's final tree when they changed. Ignored, missing, non-file, or outside-repository plan documents are metadata-only and are not force-added. `neal squash` rewrites history for plan-owned commits after printing a preview and receiving interactive confirmation. neal rejects finalization and squash attempts that would include files matching `.gitignore` rules, even if those files were force-added.

Read-only commands are intentionally narrower: `neal status` and `neal review` skip the writer lock. `neal review` owns only the review artifacts under `.neal/reviews/` and fails if a provider changes anything else. It does not clean up a provider's worktree changes.

Roles carry very different privilege: the coder role (and the inherited planner) executes shell commands and writes files with your privileges in the working directory, while the reviewer role is structurally read-only, enforced per provider adapter. Running an unknown or untrusted model in the coder role (for example via `neal compat` against an arbitrary OpenAI-compatible / OpenRouter slug) grants that model coder-level shell access, so run untrusted models inside a container or disposable sandbox. See [SECURITY.md](SECURITY.md) for the full trust model and how to report a suspected vulnerability.

## Notifications

Notifications are opt-in. If `neal.notify_bin` is configured, neal runs that command with one notification-text argument for `blocked`, `complete`, `done`, and `retry`. Messages start with `[neal] <planName>:` followed by the reason or status. Blocked and interactive-recovery retry messages append `| consultant advice (read-only): triage <category>; suggested directive: <directive>` when consultant advice is available.

`NEAL_NOTIFY_BIN` overrides the configured command. Set it to another path to use that command, or set it to an empty value to disable notifications for the process. Notification command failures never fail or change the result of a run.

`neal check` reports the resolved notification command and, in an interactive terminal, can send a test notification after confirmation.
