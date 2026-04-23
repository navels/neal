# neal

`neal` runs a coder/reviewer loop for planning and execution.

Use it from the target repository, not from this repository.

## Installation

Install dependencies and build the CLI:

```bash
pnpm install
pnpm build
```

`pnpm build` refreshes the globally linked `neal` binary.

`neal` also loads environment variables from a standard `.env` file at process startup via `dotenv`, so provider credentials can live in the target repository's `.env`.

## Usage

From the repository you want Neal to operate on:

```bash
cd /path/to/target-repo
```

Common examples:

```bash
# Refine an existing plan file in place.
neal --plan plans/MY_PLAN.md

# Start executing a plan file.
neal --execute plans/MY_PLAN.md

# Refine inline draft text, writing it to the given plan file first.
neal --plan-text "# Goal\n\n..." plans/MY_PLAN.md

# Execute inline plan text without creating a checked-in plan file.
neal --execute-text "# Goal\n\n## Execution Shape\n\nexecutionShape: one_shot\n"

# Resume a stopped or interrupted run.
neal --resume

# Give guidance to a blocked run, then resume it.
neal --recover .neal/session.json --message "Keep the change bounded to the failing test and rerun the required validation gate."
neal --resume .neal/session.json
```

Other useful commands:

```bash
neal --plan-file plans/MY_PLAN.md
neal --execute-file plans/MY_PLAN.md
neal --resume-coder
neal --resume-reviewer
neal --diagnose .neal/session.json --question "What is blocking?" --target "src/foo.ts"
neal --diagnostic-decision .neal/session.json --action adopt
neal --recover .neal/session.json --message "Use the extracted helper approach."
neal --squash plans/MY_PLAN.md
neal --summaries
```

## Configuration

Config precedence is:

1. `~/.config/neal/config.yml`
2. repo `config.yml`
3. built-in defaults

The checked-in [config.yml](/Users/lee.nave/code/personal/codex-chunked/config.yml) is the authoritative template.

There are two config sections:

- `neal.*` for wrapper/runtime behavior
- `agent.*` for default coder/reviewer provider and model selection on new runs

Current shape:

```yaml
# neal:
#   phase_heartbeat_ms: 60000
#   max_review_rounds: 20
#   review_stuck_window: 3
#   inactivity_timeout_ms: 600000
#   api_retry_limit: 10
#   interactive_blocked_recovery_max_turns: 3
#   final_completion_continue_execution_max: 2
#   notify_bin: /absolute/path/to/notify
#
# agent:
#   coder:
#     provider: openai-codex
#     model: null
#   reviewer:
#     provider: anthropic-claude
#     model: null
```

Notes:

- `agent.coder` and `agent.reviewer` set the default provider/model for new `--plan` and `--execute` runs.
- `model: null` means “let the provider choose its default model.”
- `neal.notify_bin` defaults to `~/bin/notify` when omitted.
- machine-local overrides usually belong in `~/.config/neal/config.yml`

## Behavior Notes

- `--plan` revises the target plan in place, creates a backup, and does not make code commits.
- `--execute` requires a clean worktree by default. Use `--ignore-local-changes` only when you intentionally want to start from a dirty tree.
- `--execute-text` writes a run-owned `INLINE_EXECUTE_PLAN.md` under `.neal/runs/<run-id>/`.
- `--plan-text` writes the supplied text to the target plan filename you provide, then runs the normal planning loop against that file.
- run artifacts live under `.neal/runs/<run-id>/`

## Choosing A Plan Shape

Every executable Neal plan must declare exactly one execution shape in a literal `## Execution Shape` section.

- Use `executionShape: one_shot` when the full task can be implemented, reviewed, and verified as one bounded scope.
- Use `executionShape: multi_scope` when the work is a finite ordered queue with a known scope count at authoring time. These plans use `## Execution Queue` plus numbered `### Scope N:` entries.
- Use `executionShape: multi_scope_unknown` when the work repeats one bounded recurring slice at a time, but the total number of slices is intentionally unknown until an explicit stop rule becomes true. These plans use `## Execution Loop`, exactly one `### Recurring Scope`, and a `## Completion Condition`.

Minimal examples:

```md
## Execution Shape

executionShape: one_shot
```

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
- Verification: `tsx --test test/plan-validation.test.ts`
- Success Condition: The new path is covered without regressing existing shapes.
```

```md
## Execution Shape

executionShape: multi_scope_unknown

## Execution Loop

### Recurring Scope
- Goal: Complete one bounded backlog slice.
- Verification: `pnpm typecheck`
- Success Condition: One recurring slice is complete and reviewable.

## Completion Condition

Stop when the backlog no longer contains any unresolved scope-worthy slices.
```

## Notifications

By default `neal` runs the command configured at `neal.notify_bin` for `blocked`, `complete`, `done`, and `retry`.

## Name

The name comes from `anneal`.

To anneal, in metallurgy and optimization, is to converge on a stable solution through repeated, controlled adjustment: heating and cooling a material to remove internal stresses and toughen it.

`neal` keeps the process and drops the `an`.
