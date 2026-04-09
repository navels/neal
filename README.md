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

## Notifications

The tool no longer depends on the `work-autonomously` skill. By default it:

- runs `~/bin/healthcheck.sh codex` for `done`
- runs `~/bin/notify "<message>"` for `blocked`, `complete`, and `retry`

Override those commands with `AUTONOMY_HEALTHCHECK` and `AUTONOMY_NOTIFY_BIN` if your local setup differs.

## Retry Behavior

Transient Codex failures are retried on the same thread with exponential backoff. Recovery turns tell Codex to reread the plan, inspect repo state, and avoid doing a second chunk if the interrupted turn already finished.
