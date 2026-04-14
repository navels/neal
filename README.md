# neal

Run a reviewed autonomous implementation loop from a standalone Node.js tool.

## What it does

- Starts a fresh Codex thread for each scope
- Tells Codex to reread the plan doc and execute exactly one scope
- Treats “blocked” as a wrapper-level stop condition and requires an exact blocker report
- Streams the scope output to stdout while the turn runs
- Parses the terminal `AUTONOMY_*` marker from the final assistant message
- Sends local notifications implemented in this project
- Retries transient Codex transport and generic `exec code 1` failures with backoff
- Stops on `AUTONOMY_DONE` or `AUTONOMY_BLOCKED`
- Lets you press `q` to stop after the current scope completes
- Opens `codex resume <thread-id>` automatically when it exits

## Usage

Install dependencies:

```bash
pnpm install
```

`neal` loads environment variables from a standard `.env` file at process startup via `dotenv`. Because you normally run it from the target repository, provider credentials and overrides can live in that repo's `.env`.

Run from the target repository:

```bash
cd /path/to/repo
pnpm --dir ~/code/personal/codex-chunked start -- --execute /absolute/or/relative/PLAN.md
pnpm --dir ~/code/personal/codex-chunked start -- --execute "fix failing tests"
pnpm --dir ~/code/personal/codex-chunked start -- --execute /absolute/or/relative/PLAN.md --coder-model gpt-5.4 --reviewer-model claude-opus-4-6
```

`pnpm build` also refreshes the globally linked `neal` binary.

## Sandbox E2E

Use the in-repo sandbox plan when you want to exercise `neal` without touching a real project:

```bash
cd /Users/lee.nave/code/personal/codex-chunked
neal --plan notes/testing/NEAL_PLAN_DRAFT.md
neal --execute notes/testing/NEAL_ONE_SHOT_PLAN.md
neal --execute notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md
neal --summaries
```

The sandbox scope is intentionally limited to `src/testing-fixture/**` and `notes/testing/**`. See [`notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md) for the rules and [`notes/testing/SANDBOX_BACKLOG.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/SANDBOX_BACKLOG.md) for the scope queue.

Use [`notes/testing/NEAL_ONE_SHOT_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/NEAL_ONE_SHOT_PLAN.md) when you want a small single-scope validation plan instead of the backlog-style fixture.
Use [`notes/testing/NEAL_PLAN_DRAFT.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/NEAL_PLAN_DRAFT.md) when you want to exercise the non-interactive planning loop.

Execution semantics:

- `neal --plan PLAN.md` revises a draft plan in place without making commits
- `neal --execute PLAN.md` executes the plan scope by scope until it completes or blocks
- `neal --execute "..."` treats the argument as an inline ad hoc execution prompt when it is not an existing file path, writes a wrapper-owned prompt file under `.neal/adhoc/`, and runs the normal execute loop against that generated prompt
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

Fresh `neal --execute ...` runs require a clean worktree. If a scope was interrupted with in-progress local changes, use `neal --resume` instead of starting a new execute run. If a run stopped in `blocked` state and you manually unblocked the persisted Codex thread, `neal --resume` will automatically re-enter the last blocked Codex phase when that phase is resumable.

`neal` treats `.neal/` as its wrapper-owned artifact root. Review notes now live under the current run directory at `.neal/runs/<timestamp>-<id>/REVIEW.md`, with finalized execution reviews archived alongside them as `.neal/runs/<timestamp>-<id>/REVIEW-<final-commit>.md`. Progress artifacts now live beside the review files in the same run directory.

`neal` also writes wrapper-generated consult and retrospective artifacts into the run directory. `CONSULT.md` reflects the latest blocker consultation state, and `RETROSPECTIVE.md` always reflects the latest accepted scope, blocked stop, or completed plan, with checkpoint-specific archives written alongside them so you can inspect whether the review loop is adding value or exposing inefficiencies.

Anthropic reviewer rounds now emit progress to stderr and fail with a clear inactivity timeout instead of silently appearing hung. Override the default 10-minute inactivity timeout with `CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS` if your environment needs a longer review window. Claude review sessions now default to `100` turns via `CLAUDE_REVIEW_MAX_TURNS`, `neal` will continue the same Claude session up to `2` times by default when it hits `error_max_turns` before returning structured findings, and transient Claude API/internal failures are retried up to `2` times by default. Override those limits with `CLAUDE_REVIEW_CONTINUATION_LIMIT` and `CLAUDE_REVIEW_API_RETRY_LIMIT`.

Execute and planning review loops now default to `20` rounds via `NEAL_MAX_REVIEW_ROUNDS`. `neal` also detects `review_stuck` conditions and blocks early when blocking findings keep reopening or the open blocking count fails to decrease across multiple consecutive review rounds. Override that non-reduction window with `NEAL_REVIEW_STUCK_WINDOW`.

Codex turns now get the same treatment. If a Codex streamed turn goes silent for too long, `neal` fails the run with the current thread id instead of hanging indefinitely. Override the default 10-minute Codex inactivity timeout with `CODEX_INACTIVITY_TIMEOUT_MS`. You can also tune wrapper heartbeat logging with `NEAL_PHASE_HEARTBEAT_MS`; set it to `0` to disable phase heartbeats entirely.

In execute mode, a Codex inactivity timeout now triggers one automatic retry on a fresh Codex thread for the current scope phase. `neal` sends a retry notification when that happens. If the fresh-thread retry also times out, the run fails and sends a failure notification.

Planning mode now gets the same one-shot fresh-thread retry for `codex_plan` and `codex_plan_response` inactivity timeouts. When a timed-out Codex phase was running as `resume <threadId>`, `neal` also makes a best-effort attempt to terminate that orphaned resume subprocess before retrying or failing.

For review quality, `neal` gives Claude the authoritative commit range, commit list, diff stat, and changed-file list for the current scope. Claude is expected to inspect that commit range directly with repository tools rather than relying on a wrapper-inlined patch.

If Codex blocks during scope execution or during a review-response pass, `neal` now routes that blocker through a bounded Claude consult loop before stopping. The consult is wrapper-owned and recorded in `CONSULT.md`; Codex remains the implementation owner. New runs default to up to `4` consult rounds per scope. Consult advice is diagnostic only: it cannot authorize baseline failures, waive verification gates, or override explicit user/wrapper policy.

Each `neal` run also writes persistent diagnostics under `.neal/runs/<timestamp>-<id>/`:

- `meta.json`: static run metadata
- `events.ndjson`: structured phase, notification, and failure events
- `stderr.log`: tee of Codex/Claude progress plus wrapper diagnostics

The final CLI JSON output includes `runDir` so you can jump straight to the relevant log directory after a failure.

During execution, `neal` also maintains in that same run directory:

- `plan-progress.json`: authoritative machine-readable progress state
- `PLAN_PROGRESS.md`: rendered human-readable burndown state

Planning mode reuses the same review loop but does not create commits or run final squash. It revises the target plan in place, records review state under the active `.neal/runs/...` directory, and exits once Claude review converges or blocks.

## Notifications

The tool no longer depends on the `work-autonomously` skill. By default it:

- runs `~/bin/notify "<message>"` for `blocked`, `complete`, `done`, and `retry`

Override that command with `AUTONOMY_NOTIFY_BIN` if your local setup differs.

## Retry Behavior

Transient Codex failures are retried on the same thread with exponential backoff. Recovery turns tell Codex to reread the plan, inspect repo state, and avoid doing a second scope if the interrupted turn already finished.
