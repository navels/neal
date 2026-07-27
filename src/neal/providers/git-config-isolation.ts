/**
 * Git-config isolation for agent subprocesses.
 *
 * Agents (the coder especially) run shell commands with the operator's real
 * environment, so `git config --global ...` writes the operator's actual
 * `~/.gitconfig`. That has happened twice: a coder model hit git identity
 * friction inside a throwaway worktree and "fixed" it globally, clobbering the
 * operator's `[user]` block and breaking commit signing on their machine
 * (issue #54).
 *
 * The defense is environmental, not behavioral: every agent subprocess gets
 * `GIT_CONFIG_GLOBAL` pointed at a neal-owned scratch copy of the operator's
 * global config, and `GIT_CONFIG_SYSTEM` pointed at the null device. Reads
 * behave identically (the copy has the operator's settings, and `includeIf`
 * paths inside it still resolve), agent commits keep the operator's identity
 * and signing config, and a `--global` write succeeds from the agent's point
 * of view — it just lands in the scratch copy instead of the operator's file.
 *
 * One scratch copy per process, created lazily: adapters are constructed per
 * round, and the copy must be stable across rounds so an agent's own global
 * writes persist for the life of the run.
 */
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { devNull, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export type GitConfigIsolationEnv = {
  GIT_CONFIG_GLOBAL: string;
  GIT_CONFIG_SYSTEM: string;
};

let cached: GitConfigIsolationEnv | null = null;

/** Candidate sources for the operator's global config, in git's own precedence. */
function globalConfigSourcePaths(): string[] {
  const fromEnv = process.env.GIT_CONFIG_GLOBAL;
  if (fromEnv !== undefined && fromEnv !== '') {
    return [fromEnv];
  }
  const xdgBase =
    process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== ''
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), '.config');
  // ~/.gitconfig wins over the XDG file when both exist, matching git.
  return [join(homedir(), '.gitconfig'), join(xdgBase, 'git', 'config')];
}

export function gitConfigIsolationEnv(): GitConfigIsolationEnv {
  if (cached !== null) {
    return cached;
  }
  const dir = mkdtempSync(join(tmpdir(), 'neal-git-config-'));
  const scratch = join(dir, 'gitconfig');
  let copied = false;
  for (const source of globalConfigSourcePaths()) {
    try {
      copyFileSync(source, scratch);
      copied = true;
      break;
    } catch {
      // Missing source — try the next candidate.
    }
  }
  if (!copied) {
    // No global config on this machine; give agents an empty one to write to.
    writeFileSync(scratch, '');
  }
  cached = { GIT_CONFIG_GLOBAL: scratch, GIT_CONFIG_SYSTEM: devNull };
  return cached;
}

/**
 * The full environment for an agent subprocess whose SDK replaces (rather
 * than merges with) the parent environment when `env` is provided.
 * `undefined` entries are dropped because those SDKs type env as
 * `Record<string, string>`.
 */
export function agentSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...gitConfigIsolationEnv() };
}

// Test-only: drop the process-level cache so a test can point the source at a
// fixture file. Mirrors disableAgentSettingsIsolation's teardown role.
export function resetGitConfigIsolationForTests(): void {
  cached = null;
}
