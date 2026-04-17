# neal

Run a reviewed autonomous implementation loop from a standalone Node.js tool.

## What it does

- Starts a fresh coder session for each scope
- Tells the coder to reread the plan doc and execute exactly one scope
- Treats “blocked” as a wrapper-level stop condition and requires an exact blocker report
- Streams the scope output to stdout while the turn runs
- Parses the terminal `AUTONOMY_*` marker from the final assistant message
- Sends local notifications implemented in this project
- Retries transient coder transport and generic `exec code 1` failures with backoff
- Stops on `AUTONOMY_DONE` or `AUTONOMY_BLOCKED`
- Lets you press `q` to stop after the current scope completes
- Opens `codex resume <thread-id>` automatically when it exits

## Usage

Install dependencies:

```bash
pnpm install
```

`neal` loads environment variables from a standard `.env` file at process startup via `dotenv`. Because you normally run it from the target repository, provider credentials can live in that repo's `.env`.

Run from the target repository:

```bash
cd /path/to/repo
pnpm --dir ~/code/personal/codex-chunked start -- --execute /absolute/or/relative/PLAN.md
pnpm --dir ~/code/personal/codex-chunked start -- --execute "fix failing tests"
pnpm --dir ~/code/personal/codex-chunked start -- --execute /absolute/or/relative/PLAN.md --coder-model gpt-5.4 --reviewer-model claude-opus-4-6
pnpm --dir ~/code/personal/codex-chunked start -- --execute /absolute/or/relative/PLAN.md --ignore-local-changes
```

`pnpm build` also refreshes the globally linked `neal` binary.

## Configuration

`neal` reads wrapper runtime settings with this precedence:

1. CLI flags
2. `~/.config/neal/config.yml`
3. repo `config.yml`
4. built-in defaults

The preferred shared runtime shape lives under `neal.*`:

```yaml
neal:
  phase_heartbeat_ms: 60000
  max_review_rounds: 20
  review_stuck_window: 3
  inactivity_timeout_ms: 600000
  api_retry_limit: 10
  interactive_blocked_recovery_max_turns: 3
  notify_bin: /Users/you/bin/notify

providers:
  openai-codex:
    inactivity_timeout_ms: 600000
  anthropic-claude:
    inactivity_timeout_ms: 600000
    api_retry_limit: 10
    max_turns: 100
    continuation_limit: 2
```

In this slice, `providers.*` should only hold genuinely provider-specific settings. `providers.anthropic-claude.max_turns` and `providers.anthropic-claude.continuation_limit` remain provider-specific; the shared inactivity timeout, retry budget, blocked-recovery cap, heartbeat cadence, review loop limits, and notification command now live under `neal.*`.

## Sandbox E2E

Use the in-repo sandbox plan when you want to exercise `neal` without touching a real project:

```bash
cd /Users/lee.nave/code/personal/codex-chunked
neal --plan notes/testing/NEAL_PLAN_DRAFT.md
neal --execute notes/testing/NEAL_ONE_SHOT_PLAN.md
neal --execute notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md
neal --summaries
```

The sandbox scope is intentionally limited to `src/sandbox-helpers/**` and `notes/testing/**`. See [`notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md) for the rules and [`notes/testing/SANDBOX_BACKLOG.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/SANDBOX_BACKLOG.md) for the scope queue.

Use [`notes/testing/NEAL_ONE_SHOT_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/NEAL_ONE_SHOT_PLAN.md) when you want a small single-scope validation plan instead of the backlog-style fixture.
Use [`notes/testing/NEAL_PLAN_DRAFT.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/NEAL_PLAN_DRAFT.md) when you want to exercise the non-interactive planning loop.

Execution semantics:

- `neal --plan PLAN.md` revises a draft plan in place without making commits
- `neal --execute PLAN.md` executes the plan scope by scope until it completes or blocks
- `neal --execute "..."` treats the argument as an inline ad hoc execution prompt when it is not an existing file path, writes a wrapper-owned prompt file under `.neal/adhoc/`, and runs the normal execute loop against that generated prompt
- `neal --resume [state-file]` resumes the Neal orchestration loop from saved wrapper state
- `neal --resume-coder [state-file]` opens the persisted coder session directly in the matching provider CLI
- `neal --resume-reviewer [state-file]` opens the persisted reviewer session directly in the matching provider CLI
- new runs also accept:
  - `--coder-provider <provider>`
  - `--coder-model <model>`
  - `--reviewer-provider <provider>`
  - `--reviewer-model <model>`
  - these flags apply only to new `--plan` / `--execute` runs, not `--resume`
- `neal --summaries [runs-dir]` pages through retrospective reports written under `.neal/runs`
- after an accepted scope, `neal` continues into the next scope automatically when the marker is `AUTONOMY_SCOPE_DONE` (or legacy `AUTONOMY_CHUNK_DONE`) until the plan completes or blocks

Current provider support in this slice is:

- coder providers:
  - `openai-codex`
  - `anthropic-claude`
- reviewer providers:
  - `openai-codex`
  - `anthropic-claude`

Model overrides are supported for both roles. The config surface is symmetric: the same provider can be used for coder and reviewer with different models when that provider implements both capabilities. In this slice, the configured OpenAI and Anthropic providers both support both roles. Unsupported provider-role combinations fail fast.

Fresh `neal --execute ...` runs require a clean worktree by default. If you intentionally want to start a fresh execute run on top of local changes, pass `--ignore-local-changes`. If a scope was interrupted with in-progress local changes, prefer `neal --resume` instead of starting a new execute run. If a run stopped in `blocked` state and you manually unblocked the persisted coder session, `neal --resume` will automatically re-enter the last blocked coder phase when that phase is resumable.

The direct session-resume commands dispatch by persisted provider:

- `openai-codex` -> `codex resume <handle>`
- `anthropic-claude` -> `claude --resume <handle>`

`neal` treats `.neal/` as its wrapper-owned artifact root. Review notes now live under the current run directory at `.neal/runs/<timestamp>-<id>/REVIEW.md`, with finalized execution reviews archived alongside them as `.neal/runs/<timestamp>-<id>/REVIEW-<final-commit>.md`. Progress artifacts now live beside the review files in the same run directory.

`neal` also writes wrapper-generated consult and retrospective artifacts into the run directory. `CONSULT.md` reflects the latest blocker consultation state, and `RETROSPECTIVE.md` always reflects the latest accepted scope, blocked stop, or completed plan, with checkpoint-specific archives written alongside them so you can inspect whether the review loop is adding value or exposing inefficiencies.

Anthropic reviewer rounds now emit progress to stderr and fail with a clear inactivity timeout instead of silently appearing hung. Anthropic reviewer sessions default to `100` turns and `neal` will continue the same reviewer session up to `2` times by default when it hits `error_max_turns` before returning structured findings. Transient Anthropic API/internal failures are retried up to `10` times by default. Tune those values in `config.yml`.

Execute and planning review loops now default to `20` rounds. `neal` also detects `review_stuck` conditions and blocks early when blocking findings keep reopening or the open blocking count fails to decrease across multiple consecutive review rounds. Tune that non-reduction window in `config.yml`.

Coder turns now get the same treatment. If a streamed coder turn goes silent for too long, `neal` fails the run with the current session id instead of hanging indefinitely. You can also tune wrapper heartbeat logging in `config.yml`; set `neal.phase_heartbeat_ms` to `0` to disable phase heartbeats entirely.

In execute mode, a coder inactivity timeout now triggers one automatic retry on a fresh coder session for the current scope phase. `neal` sends a retry notification when that happens. If the fresh-session retry also times out, the run fails and sends a failure notification.

Planning mode now gets the same one-shot fresh-session retry for `coder_plan` and `coder_plan_response` inactivity timeouts. When a timed-out coder phase was running as `resume <threadId>`, `neal` also makes a best-effort attempt to terminate that orphaned resume subprocess before retrying or failing.

For review quality, `neal` gives the reviewer the authoritative commit range, commit list, diff stat, and changed-file list for the current scope. The reviewer is expected to inspect that commit range directly with repository tools rather than relying on a wrapper-inlined patch.

If the coder blocks during scope execution or during a review-response pass, `neal` now routes that blocker through a bounded reviewer consult loop before stopping. The consult is wrapper-owned and recorded in `CONSULT.md`; the coder remains the implementation owner. New runs default to up to `4` consult rounds per scope. Consult advice is diagnostic only: it cannot authorize baseline failures, waive verification gates, or override explicit user/wrapper policy.

Each `neal` run also writes persistent diagnostics under `.neal/runs/<timestamp>-<id>/`:

- `meta.json`: static run metadata
- `events.ndjson`: structured phase, notification, and failure events
- `stderr.log`: tee of coder/reviewer progress plus wrapper diagnostics

The final CLI JSON output includes `runDir` so you can jump straight to the relevant log directory after a failure.

During execution, `neal` also maintains in that same run directory:

- `plan-progress.json`: authoritative machine-readable progress state
- `PLAN_PROGRESS.md`: rendered human-readable burndown state

Planning mode reuses the same review loop but does not create commits or run final squash. It revises the target plan in place, records review state under the active `.neal/runs/...` directory, and exits once reviewer feedback converges or blocks.

Plan authors should describe execution in terms of scopes:

- single-scope plans should tell the coder to finish the full plan in one scope and normally end with `AUTONOMY_DONE`
- multi-scope plans should make scope selection explicit and normally end each non-final scope with `AUTONOMY_SCOPE_DONE`
- `AUTONOMY_CHUNK_DONE` remains accepted as a legacy compatibility marker, but new plans should use `AUTONOMY_SCOPE_DONE`

## Notifications

The tool no longer depends on the `work-autonomously` skill. By default it runs the command configured at `neal.notify_bin` for `blocked`, `complete`, `done`, and `retry`. The checked-in default is `~/bin/notify`.

## Retry Behavior

Transient coder failures are retried on the same session with exponential backoff. Recovery turns tell the coder to reread the plan, inspect repo state, and avoid doing a second scope if the interrupted turn already finished.
