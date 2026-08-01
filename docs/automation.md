# Automation contract

The machine-facing contract for driving neal from scripts, CI, and benchmark
harnesses. [neal-swebench](https://github.com/navels/neal-swebench) is a working
example: a harness that drives neal headless through this contract to benchmark
role pairings on SWE-bench Pro.

Noninteractive harnesses should run `neal execute <plan.md>` for an already
accepted executable plan, or `neal run <plan.md>` when neal should refine and
execute one or more plans as a serial queue. Use `neal resume --run <run-id>` to
continue an interrupted writer run. Pass `--message` only when status says the
run is waiting for operator guidance. After each writer command, classify the
result from the process exit code plus `neal status --json --run <run-id>` when
a run id is known. Use `neal status --json --all` only for run discovery and
queue overview, not as a replacement for exact run-local status.

`neal execute`, `neal run`, and `neal resume` do not prompt for input. They run
with closed stdin and either complete, stop in a controlled state, or fail fast
when setup, configuration, CLI usage, Git state, or worktree preconditions are
invalid. Keyboard controls are available only when stdin is a TTY. `neal setup`
and public `neal squash` remain interactive setup and maintenance commands, not
the harness execution path.

The stable JSON classification fields are:

- `runId`, `status`, `effectiveStatus`, `publicStatus`, `phase`,
  `publicPhase`, and `nextAction` for outcome and follow-up decisions.
- `waitingForOperatorGuidance`, `pendingOperatorGuidance`, `blocker`,
  `manualGate`, `health`, and `lock.kind` for controlled incomplete states,
  timeouts, and stale or live writer-lock evidence.
- `providerError` for the latest provider or phase failure. Provider failures
  expose provider id, role, label, session handle, normalized kind, bounded
  message, retryability, and timestamp without raw provider payloads.
- `commits`, `squash`, and `patch` for patch selection. `patch` includes the
  default-submission decision, reason, base/head/range, source, commit count,
  changed-file count, changed files, and unavailable reason.
- `build` for reproducibility: neal package version, neal source Git SHA when
  available, Node version, whether the values came from run `meta.json` or live
  fallback, and the persisted planner/coder/reviewer agent config.

Default public patch submission is conservative. Submit automatically only when
`patch.defaultSubmissionEligible` is true. neal sets that only for clean
completed execute runs with a non-empty readable patch range. Successful squash
metadata is preferred (`squash.originalBaseCommit..squash.replacementCommit`).
Otherwise completed unsquashed execute runs use
`commits.initialBaseCommit ?? commits.baseCommit` through `commits.finalCommit`.
Failed, blocked, paused, running, provider-error, waiting, timed-out,
malformed-squash, pending-squash, unreadable-range, and empty-patch runs can
still expose patch metadata for analysis, but are not default-submission
eligible.

For public traces, copy `neal status --json --run <run-id>` output and the
run-local `RUN_NARRATIVE.md` path reported at
`artifacts.runNarrativeMarkdownPath`. Do not publish raw run directories,
`RUN_NARRATIVE.json`, `events.ndjson`, `stderr.log`, `RUN_STATE.json`, full
diffs, prompts, provider responses, or provider payloads as benchmark traces.

Writer command exit codes (`0`, `1`, `2`, `3`) are defined in the README's
[Command exit codes](../README.md#command-exit-codes) section.

Harnesses own wall-clock timeouts. Launch neal in a process group, terminate
that group on timeout, wait a short grace period, and force-kill the group if it
does not exit. When a run id is known, call `neal status --json --run <run-id>`
after termination and record the wrapper timeout as the primary classification.
Status JSON stays readable for interrupted runs and includes `lock.kind`, so a
wrapper can distinguish a cleaned-up timeout (`none`) from a still-active or
stale writer lock.
