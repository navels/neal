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
pnpm --dir ~/code/personal/codex-chunked start -- --execute-file /absolute/or/relative/PLAN.md
pnpm --dir ~/code/personal/codex-chunked start -- --execute-text "# Inline Plan"
pnpm --dir ~/code/personal/codex-chunked start -- --plan /absolute/or/relative/PLAN.md
pnpm --dir ~/code/personal/codex-chunked start -- --plan-file /absolute/or/relative/PLAN.md
pnpm --dir ~/code/personal/codex-chunked start -- --plan-text "# Draft Plan" /absolute/or/relative/PLAN.md
pnpm --dir ~/code/personal/codex-chunked start -- --execute /absolute/or/relative/PLAN.md --ignore-local-changes
```

`pnpm build` also refreshes the globally linked `neal` binary.

## Configuration

`neal` reads wrapper runtime settings with this precedence:

1. `~/.config/neal/config.yml`
2. repo `config.yml`
3. built-in defaults

The supported config surface is:

- `neal.*` for wrapper/runtime behavior
- `agent.*` for default coder/reviewer provider and model selection on new runs

Current shape:

```yaml
# config.yml is a commented template in this repo.
# Uncomment any setting you want to override locally for that repository.
#
# neal:
#   phase_heartbeat_ms: 60000
#   max_review_rounds: 20
#   review_stuck_window: 3
#   inactivity_timeout_ms: 600000
#   api_retry_limit: 10
#   interactive_blocked_recovery_max_turns: 3
#   final_completion_continue_execution_max: 2
#
# agent:
#   coder:
#     provider: openai-codex
#     model: null
#   reviewer:
#     provider: anthropic-claude
#     model: null
```

`agent.*` holds the default coder/reviewer provider and model selection for new runs. Shared retry budgets, inactivity timeouts, blocked-recovery caps, heartbeat cadence, review loop limits, final-completion reopen limits, and notification command all live under `neal.*`.

The checked-in [`config.yml`](/Users/lee.nave/code/personal/codex-chunked/config.yml) is a fully commented template showing the supported keys, their defaults, and what each one does. Machine-local overrides such as `neal.notify_bin` and per-role model selection belong in `~/.config/neal/config.yml`; when `neal.notify_bin` is omitted, `neal` falls back to its built-in `~/bin/notify` default.

## Sandbox E2E

If you want to exercise `neal` inside this repository, use your own temporary draft or execution plan and keep the scope constrained to safe paths such as `src/sandbox-helpers/**` and `notes/testing/**`.

The repository no longer carries built-in sandbox plan fixtures. That keeps `plans/` focused on real roadmap and memo docs rather than manual test inputs.

Execution semantics:

- `neal --plan PLAN.md` revises a draft plan in place without making commits
- `neal --plan-file PLAN.md` is the explicit file-mode spelling for planning
- `neal --plan-text "..." PLAN.md` writes the inline draft markdown to the requested plan file path, then runs the normal planning loop against that file
- `neal --execute PLAN.md` executes the plan scope by scope until it completes or blocks; this remains the default file-mode spelling
- `neal --execute-file PLAN.md` is the explicit file-mode spelling for execution
- `neal --execute-text "..."` treats the argument as inline plan markdown, writes a run-owned `INLINE_EXECUTE_PLAN.md` artifact under `.neal/runs/<timestamp>-<id>/`, and runs the normal execute loop against that generated plan file
- `neal --resume [state-file]` resumes the Neal orchestration loop from saved wrapper state
- `neal --resume-coder [state-file]` opens the persisted coder session directly in the matching provider CLI
- `neal --resume-reviewer [state-file]` opens the persisted reviewer session directly in the matching provider CLI
- `neal --summaries [runs-dir]` pages through retrospective reports written under `.neal/runs`
- after an accepted scope, `neal` continues into the next scope automatically when the marker is `AUTONOMY_SCOPE_DONE` (or legacy `AUTONOMY_CHUNK_DONE`) until the plan completes or blocks

Current provider support in this slice is:

- coder providers:
  - `openai-codex`
  - `anthropic-claude`
- reviewer providers:
  - `openai-codex`
  - `anthropic-claude`

Provider and model defaults are configured per role under `agent.coder` and `agent.reviewer`. The config surface is symmetric: the same provider can be used for coder and reviewer with different models when that provider implements both capabilities. In this slice, the configured OpenAI and Anthropic providers both support both roles. Unsupported provider-role combinations fail fast.

Fresh `neal --execute ...` runs require a clean worktree by default. If you intentionally want to start a fresh execute run on top of local changes, pass `--ignore-local-changes`. If a scope was interrupted with in-progress local changes, prefer `neal --resume` instead of starting a new execute run. If a run stopped in `blocked` state and you manually unblocked the persisted coder session, `neal --resume` will automatically re-enter the last blocked coder phase when that phase is resumable.

The direct session-resume commands dispatch by persisted provider:

- `openai-codex` -> `codex resume <handle>`
- `anthropic-claude` -> `claude --resume <handle>`

`neal` treats `.neal/` as its wrapper-owned artifact root. Review notes now live under the current run directory at `.neal/runs/<timestamp>-<id>/REVIEW.md`, with finalized execution reviews archived alongside them as `.neal/runs/<timestamp>-<id>/REVIEW-<final-commit>.md`. Progress artifacts now live beside the review files in the same run directory.

`neal` also writes wrapper-generated consult and retrospective artifacts into the run directory. `CONSULT.md` reflects the latest blocker consultation state, and `RETROSPECTIVE.md` always reflects the latest accepted scope, blocked stop, or completed plan, with checkpoint-specific archives written alongside them so you can inspect whether the review loop is adding value or exposing inefficiencies.

Anthropic reviewer rounds now emit progress to stderr and fail with a clear inactivity timeout instead of silently appearing hung. Transient Anthropic API/internal failures are retried up to `10` times by default. Tune that retry budget in `config.yml`.

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

By default `neal` runs the command configured at `neal.notify_bin` for `blocked`, `complete`, `done`, and `retry`. If you do not set that key, `neal` falls back to `~/bin/notify`, which is why the checked-in repo config omits it.

## Retry Behavior

Transient coder failures are retried on the same session with exponential backoff. Recovery turns tell the coder to reread the plan, inspect repo state, and avoid doing a second scope if the interrupted turn already finished.
