/**
 * Whether neal-driven agent runs should be isolated from the operator's
 * interactive agent config.
 *
 * The native adapters drive the Codex and Claude SDKs, which by default load
 * the operator's own config — the Codex `notify` hook, the Claude
 * `Stop`/`Notification` hooks, `CLAUDE.md`, permissions. In normal use
 * (pipeline, local `neal go`) that is correct: it is the operator's machine
 * and their configured agent behavior, so neal honors it.
 *
 * The one exception is the compat qualification harness (`neal compat`, which
 * `scripts/qualify-sdk.sh` drives). It is a hermetic, repeatable capability
 * probe that runs the whole planner/coder/reviewer matrix — many turns — and
 * must not fire the operator's per-turn notifier hooks or let ambient config
 * skew the verdict. So `runCompat` turns isolation ON for its process, and the
 * native adapters read it here.
 *
 * A process-level env flag (matching NEAL_STOP_AFTER_CURRENT_SCOPE_FILE /
 * NEAL_GUIDANCE_DIR) rather than a threaded option, because compat drives the
 * adapters through the full orchestrator, and the flag would otherwise have to
 * cross every layer between the command and adapter construction.
 */
const ISOLATION_ENV_FLAG = 'NEAL_ISOLATE_AGENT_SETTINGS';

export function enableAgentSettingsIsolation(): void {
  process.env[ISOLATION_ENV_FLAG] = '1';
}

// Symmetric off switch. Production only ever enables (compat, once), but tests
// that exercise the isolated path need a clean teardown so the process-level
// flag does not leak into sibling tests.
export function disableAgentSettingsIsolation(): void {
  delete process.env[ISOLATION_ENV_FLAG];
}

export function agentSettingsIsolated(): boolean {
  return process.env[ISOLATION_ENV_FLAG] === '1';
}
