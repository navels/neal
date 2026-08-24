# Troubleshooting

Symptom / cause / fix, in the order you'll hit them. Quoted text is what neal
prints. When in doubt: `neal check`, then `.neal/runs/<run-id>/stderr.log`.

## Install and first run

**Symptom:** install or startup fails on an old Node.
**Cause:** neal requires Node.js >= 24.18.0 (`engines`). `.nvmrc` pins `24.18.0`.
**Fix:** `nvm use` in this repo, or upgrade Node before `npm install -g @navels/neal`.

**Symptom:** `pnpm: command not found` when running from source.
**Cause:** the source path uses pnpm >= 11 via corepack.
**Fix:** `corepack enable && corepack prepare pnpm@11 --activate`, then `pnpm install`.

**Symptom:** `neal` not found after `pnpm run dev:link`.
**Cause:** the dev link registers `bin.neal` with the active Node installation only.
**Fix:** diagnose with `command -v neal` and `npm list -g --depth 0 --link=true`.
After source changes, `pnpm build` again so the linked command sees `dist/`.

**Symptom:** `neal setup` lists a provider with `- runtime not found`.
**Cause:** setup detects local runtime surfaces only (the `@openai/codex-sdk`
entrypoint, an SDK-bundled or on-PATH `claude` executable), never auth.
**Fix:** install the provider's SDK/CLI, then rerun `neal setup` and `neal check`.

## Provider auth failures (`neal check`)

`neal check` sends one small prompt per unique configured provider/model
(interactive TTY only. Non-interactive input prints
`Provider verification skipped: non-interactive input.`). Known failures:

**Symptom:** `Claude Code refused bypass-permissions mode while running as root.`
**Cause:** the Claude provider uses `permissionMode: bypassPermissions`, which
Claude Code refuses under root/sudo.
**Fix:** run neal from a non-root user, then `neal check` again.

**Symptom:** `OpenAI Codex has not trusted this directory yet.`
**Cause:** the Codex CLI's own per-directory trust prompt has not been answered.
**Fix:** complete the provider's normal local trust/setup step for the current
directory (e.g. run the `codex` CLI there once), then `neal check` again.

**Symptom:** `OpenAI Codex could not persist the check session.`
**Fix:** transient. Run `neal check` again. If it repeats, redo the provider's
local setup.

**Symptom:** a `not logged in` message from either vendor CLI.
**Cause:** provider auth is provider-owned, so neal never collects credentials.
**Fix:** complete the provider's normal local auth setup (the `codex` / `claude`
login flows), then `neal check` again.

**Symptom:** `Set providers.openai_compatible.base_url (or OPENAI_COMPATIBLE_BASE_URL) and OPENAI_COMPATIBLE_API_KEY before running Neal.`
(or `No model is resolvable for the openai-compatible ... role`).
**Cause:** `openai-compatible` resolves settings from config first,
with env fallbacks: `base_url` → `OPENAI_COMPATIBLE_BASE_URL`. The key is read
from the env var named by `api_key_env` (default `OPENAI_COMPATIBLE_API_KEY`).
Model from `agent.<role>.model` → `default_model` → `OPENAI_COMPATIBLE_MODEL`.
**Fix:** set the missing key. For OpenRouter: `base_url: https://openrouter.ai/api/v1`,
`api_key_env: OPENROUTER_API_KEY`, and export `OPENROUTER_API_KEY`. (OpenRouter
wraps upstream 429s in HTTP-200 bodies, so neal unwraps and retries them.)

## Runs that won't start

**Symptom:** plan validation errors such as:

```text
Missing required `## Execution Shape` section.
`## Execution Shape` must contain exactly one non-empty line.
```
**Cause:** every executable plan must declare exactly one of
`executionShape: one_shot | multi_scope | multi_scope_unknown`. `multi_scope`
also requires an `## Execution Queue` with contiguous `### Scope N:` headings,
each carrying `- Goal:` / `- Verification:` / `- Success Condition:` bullets.
**Fix:** see [plan-format.md](plan-format.md), or let `neal plan` refine the
document into executable shape.

**Symptom:** a missing-config error naming `agent.coder.provider` or
`agent.reviewer.provider`.
**Cause:** fresh writer runs require explicit coder and reviewer providers.
Built-in defaults are not enough.
**Fix:** `neal setup`, then `neal check`.

**Symptom:** `Cannot start neal execute with a dirty worktree:` followed by
`git status` lines (queues: `Cannot continue neal run with a dirty worktree:`).
**Cause:** writer admission requires a clean worktree. Only the selected plan
document and neal-owned paths (`.neal/`) are exempt. Leftover reviewer scratch
(`build_review/`, `scratch/`, …) gets a
`Likely Neal reviewer scratch leakage detected:` diagnostic but still blocks,
because the paths are not proven neal-owned.
**Fix:** use `neal resume` for in-progress scope work, or commit, stash, move,
or remove the dirty paths and start clean.

**Symptom:** a Git precondition error before any provider runs.
**Fix:** writer commands require a Git repository with an existing `HEAD`
commit. Create the initial baseline commit first.

## Stuck or blocked runs

**Symptom:** the run stops waiting for the operator (exit code 2), either as
`status: "blocked"` or as a waiting-for-guidance recovery state.
**Cause:** an operator stop is a controlled state, not a failure: the run hit
something it may not resolve alone. Before yielding, eligible execute-mode
blocks — coder-reported blocks and structural reviewer `review_stuck`
deadlocks — get one bounded read-only consultant triage; a recoverable verdict
with a concrete directive is applied automatically and the run continues
without stopping. When the consultant is disabled
(`consultant_max_attempts: 0`), its per-scope budget is exhausted, the block
comes from an ineligible phase, or the consultant itself errors, the run
yields with no consultant advice. Advice, when there is any, is carried on
the stop.
**Fix:** follow `neal status` — recovery is site-specific, so what it prints
is the contract. A stop waiting for guidance prints the exact
`neal resume --run <run-id> --message "..."` command (`--message` is only
accepted there). Other blocked states — the final-completion review block,
for example — are not mechanically resumable: `neal resume` reports them as
still blocked, and `neal status` explains the blocker so you can address it
directly.

**Symptom:** `effectiveStatus: "waiting_for_manual_gate"`.
**Cause:** the scope reached expected human work. Instructions are in the
run-local `GATE-<id>.md` file shown by `neal status`.
**Fix:** do the manual step, then `neal resume --run <run-id>`, which re-runs
the gate's checks and resumes the scope when they pass. No `--message` here.

**Symptom:** a run seems hung or died silently.
**Where to look:** raw detail is persisted even when hidden from the terminal:
`.neal/runs/<run-id>/stderr.log` (full transcript) and
`.neal/runs/<run-id>/events.ndjson` (event log, where startup-silence retries
appear as `provider.turn_liveness_*` events). On a live TTY, press `v` for the
low-level detail view. `neal status --json --run <run-id>` carries the latest
`providerError` classification.

## Lock issues

The writer lock is `.neal/active-run.lock`. Writer processes remove it on
normal shutdown and on SIGINT/SIGTERM.

**Symptom:** `another Neal writer run is active in this checkout`.
**Fix:** as printed: `neal resume --run <run-id>` to continue that run, or
wait for it to finish.

**Symptom:** `another Neal process is already resuming this run` (with
`owning pid`). A live same-run lock under another pid is refused, not shared.
**Fix:** wait for that process, or inspect with `neal status --run <run-id>`.

**Symptom:** `stale Neal writer lock found in this checkout` /
`no process with that PID is running on this host.`
**Fix:** `neal resume --run <run-id>` clears stale same-host locks itself. If
you're starting different work instead, inspect the run, then remove the lock
file the message names.

**Symptom:** `Neal writer lock belongs to another host`.
**Fix:** inspect the other host before removing the lock. The message prints
the exact resume command for that checkout.

**Symptom:** `could not read the active Neal writer lock`.
**Fix:** as printed: inspect the named lock file before starting another
writer run. Remove it only after confirming no writer process is active.

## "It squashed when I didn't want it to"

**Symptom:** per-scope commits are gone after a completed run.
**Cause:** completed `neal execute` / `neal run` runs squash run-owned commits
by default, without confirmation.
**Fix:** pass `--no-squash` to keep individual commits. The squashed range is
recorded in `.neal/runs/<run-id>/SQUASH_RESULT.json` and under `squash`
(`originalBaseCommit` / `replacementCommit`) in `neal status --json`.
Standalone `neal squash` is the opposite: it previews, requires interactive TTY
confirmation, and preserves later commits by replaying them on top.
