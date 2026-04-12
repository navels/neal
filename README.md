# codex-chunked

Run Codex in chunked autonomous mode from a standalone Node.js tool.

## What it does

- Starts a fresh Codex thread for each chunk
- Tells Codex to reread the plan doc and execute exactly one chunk
- Treats “blocked” as a wrapper-level stop condition and requires an exact blocker report
- Streams the chunk output to stdout while the turn runs
- Parses the terminal `AUTONOMY_*` marker from the final assistant message
- Sends local notifications implemented in this project
- Retries transient Codex transport and generic `exec code 1` failures with backoff
- Stops on `AUTONOMY_DONE` or `AUTONOMY_BLOCKED`
- Lets you press `q` to stop after the current chunk completes
- Opens `codex resume <thread-id>` automatically when it exits

## Usage

Install dependencies:

```bash
pnpm install
```

Run from the target repository so Codex works in that repo:

```bash
cd /path/to/repo
pnpm --dir ~/code/personal/codex-chunked start -- /absolute/or/relative/PLAN.md
```

`pnpm build` also refreshes the globally linked `codex-chunked` binary.

## Sandbox E2E

Use the in-repo sandbox plan when you want to exercise `neal` without touching a real project:

```bash
cd /Users/lee.nave/code/personal/codex-chunked
neal --plan notes/testing/NEAL_PLAN_DRAFT.md
neal --execute notes/testing/NEAL_ONE_SHOT_PLAN.md
neal --execute --chunked notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md
```

The sandbox scope is intentionally limited to `src/testing-fixture/**` and `notes/testing/**`. See [`notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md) for the rules and [`notes/testing/SANDBOX_BACKLOG.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/SANDBOX_BACKLOG.md) for the chunk queue.

Use [`notes/testing/NEAL_ONE_SHOT_PLAN.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/NEAL_ONE_SHOT_PLAN.md) when you want a small end-to-end one-shot validation plan instead of the chunk backlog.
Use [`notes/testing/NEAL_PLAN_DRAFT.md`](/Users/lee.nave/code/personal/codex-chunked/notes/testing/NEAL_PLAN_DRAFT.md) when you want to exercise the non-interactive planning loop.

Execution-mode semantics:

- `neal --plan PLAN.md` revises a draft plan in place without making commits
- `neal --execute PLAN.md` runs one-shot mode by default
- `neal --execute --chunked PLAN.md` opts into chunked mode explicitly
- in chunked mode, `neal` now continues into the next chunk automatically after an accepted `AUTONOMY_CHUNK_DONE` scope until the plan completes or blocks

`neal` treats `.neal/`, `PLAN_PROGRESS.md`, and `plan-progress.json` as wrapper-owned artifacts. Review notes now live under the current run directory at `.neal/runs/<timestamp>-<id>/REVIEW.md`, with finalized execution reviews archived alongside them as `.neal/runs/<timestamp>-<id>/REVIEW-<final-commit>.md`. Progress artifacts remain in the repo root for inspection.

Claude review rounds now emit progress to stderr and fail with a clear inactivity timeout instead of silently appearing hung. Override the default 120-second inactivity timeout with `CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS` if your environment needs a longer review window.

For review quality, `neal` uses a hybrid diff strategy: smaller diffs are inlined directly into Claude’s prompt, while larger diffs fall back to diff stat plus changed-file guidance so Claude can inspect files with `Read`, `Grep`, and `Glob` instead of relying on a truncated patch.

Each `neal` run also writes persistent diagnostics under `.neal/runs/<timestamp>-<id>/`:

- `meta.json`: static run metadata
- `events.ndjson`: structured phase, notification, and failure events
- `stderr.log`: tee of Codex/Claude progress plus wrapper diagnostics

The final CLI JSON output includes `runDir` so you can jump straight to the relevant log directory after a failure.

During execution, `neal` also maintains:

- `plan-progress.json`: authoritative machine-readable progress state
- `PLAN_PROGRESS.md`: rendered human-readable burndown state

Planning mode reuses the same review loop but does not create commits or run final squash. It revises the target plan in place, records review state under the active `.neal/runs/...` directory, and exits once Claude review converges or blocks.

If you want to force the large-diff fallback path during local validation, lower the inline file threshold:

```bash
CLAUDE_INLINE_DIFF_FILE_LIMIT=1 neal --execute --chunked notes/testing/CODEX_CLAUDE_SANDBOX_PLAN.md
```

## Notifications

The tool no longer depends on the `work-autonomously` skill. By default it:

- runs `~/bin/notify "<message>"` for `blocked`, `complete`, `done`, and `retry`

Override that command with `AUTONOMY_NOTIFY_BIN` if your local setup differs.

## Retry Behavior

Transient Codex failures are retried on the same thread with exponential backoff. Recovery turns tell Codex to reread the plan, inspect repo state, and avoid doing a second chunk if the interrupted turn already finished.
