/**
 * Tests for git-config isolation (src/neal/providers/git-config-isolation.ts):
 * agent subprocesses get GIT_CONFIG_GLOBAL pointed at a neal-owned scratch
 * copy of the operator's global config, so an agent-issued
 * `git config --global` can never write the operator's real file (issue #54).
 * Hermetic: temp files only, the process-level cache is reset around each
 * test, and the real HOME is never touched.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { ToolExecutionOptions } from 'ai';

import {
  agentSubprocessEnv,
  gitConfigIsolationEnv,
  resetGitConfigIsolationForTests,
} from '../src/neal/providers/git-config-isolation.js';
import { createCoderToolset } from '../src/neal/providers/openai-compatible-tools.js';

const execFileAsync = promisify(execFile);
const callOptions = { toolCallId: 'test-call', messages: [] } as unknown as ToolExecutionOptions<never>;

const OPERATOR_CONFIG = '[user]\n\tname = Operator Real\n\temail = operator@real.example\n';

/** Points the isolation source at a fixture "operator" global config. */
async function withFixtureGlobalConfig<T>(fn: (sourcePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-gci-src-'));
  const sourcePath = path.join(dir, 'gitconfig');
  await fs.writeFile(sourcePath, OPERATOR_CONFIG);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = sourcePath;
  resetGitConfigIsolationForTests();
  try {
    return await fn(sourcePath);
  } finally {
    if (previous === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = previous;
    }
    resetGitConfigIsolationForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('gitConfigIsolationEnv', () => {
  afterEach(() => {
    resetGitConfigIsolationForTests();
  });

  it('copies the operator global config to a scratch file and nulls the system config', async () => {
    await withFixtureGlobalConfig(async (sourcePath) => {
      const env = gitConfigIsolationEnv();
      assert.notEqual(env.GIT_CONFIG_GLOBAL, sourcePath);
      assert.equal(env.GIT_CONFIG_SYSTEM, os.devNull);
      const scratch = await fs.readFile(env.GIT_CONFIG_GLOBAL, 'utf8');
      assert.equal(scratch, OPERATOR_CONFIG);
    });
  });

  it('is stable across calls so agent writes persist for the run', async () => {
    await withFixtureGlobalConfig(async () => {
      const first = gitConfigIsolationEnv();
      const second = gitConfigIsolationEnv();
      assert.equal(first.GIT_CONFIG_GLOBAL, second.GIT_CONFIG_GLOBAL);
    });
  });

  it('provides an empty scratch config when the operator has none', async () => {
    const missing = path.join(os.tmpdir(), 'neal-gci-definitely-missing', 'gitconfig');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = missing;
    resetGitConfigIsolationForTests();
    try {
      const env = gitConfigIsolationEnv();
      assert.equal(await fs.readFile(env.GIT_CONFIG_GLOBAL, 'utf8'), '');
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previous;
      }
      resetGitConfigIsolationForTests();
    }
  });

  it('agentSubprocessEnv carries the full environment minus undefined entries plus the overrides', async () => {
    await withFixtureGlobalConfig(async () => {
      const env = agentSubprocessEnv();
      assert.equal(env.GIT_CONFIG_SYSTEM, os.devNull);
      assert.equal(env.PATH, process.env.PATH);
      for (const value of Object.values(env)) {
        assert.equal(typeof value, 'string');
      }
    });
  });
});

describe('agent shell git --global writes are sandboxed', () => {
  afterEach(() => {
    resetGitConfigIsolationForTests();
  });

  it('a git config --global write through the run tool lands in the scratch copy, not the operator file', async () => {
    await withFixtureGlobalConfig(async (sourcePath) => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-gci-run-'));
      try {
        const tools = createCoderToolset(rootDir, { runTimeoutMs: 10_000 });
        const result = await tools.run.execute!(
          { command: 'git config --global user.name "Agent Invented" && git config --global user.name' },
          callOptions,
        );
        assert.match(String(result), /exit code: 0/);
        // The agent sees its write take effect...
        assert.match(String(result), /Agent Invented/);
        // ...the scratch copy took the write...
        const scratch = await fs.readFile(gitConfigIsolationEnv().GIT_CONFIG_GLOBAL, 'utf8');
        assert.match(scratch, /Agent Invented/);
        // ...and the operator's file is untouched.
        assert.equal(await fs.readFile(sourcePath, 'utf8'), OPERATOR_CONFIG);
      } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    });
  });

  it('agent git reads still see the operator settings through the copy', async () => {
    await withFixtureGlobalConfig(async () => {
      const env = { ...process.env, ...gitConfigIsolationEnv() };
      const { stdout } = await execFileAsync('git', ['config', '--global', 'user.email'], { env });
      assert.equal(stdout.trim(), 'operator@real.example');
    });
  });
});
