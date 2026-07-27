import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { parseNewRunArgs } from '../cli.js';
import { assertWriterProvidersConfigured, getConfiguredUnattended } from '../config.js';
import { assertGitRepositoryWithCommit } from '../git.js';
import { loadOrInitialize } from '../orchestrator.js';
import { assertAgentConfigSupportsWriterRun } from '../providers/registry.js';
import type { AgentConfig } from '../types.js';
import { executeRun, withPreparedWriterRun } from './runtime.js';
import { getExecuteRunResultExitCode, setWriterCommandExitCode } from './writer-exit-codes.js';

const PARSE_ONLY_AGENT_CONFIG: AgentConfig = {
  planner: {
    provider: 'openai-codex',
    model: null,
  },
  coder: {
    provider: 'openai-codex',
    model: null,
  },
  reviewer: {
    provider: 'anthropic-claude',
    model: null,
  },
};

export async function runNewRunCommand(args: string[]): Promise<void> {
  const parsedArgs = parseNewRunArgs(args, PARSE_ONLY_AGENT_CONFIG);
  const cwd = process.cwd();
  const agentConfig = assertWriterProvidersConfigured(cwd, {
    context: `new ${parsedArgs.topLevelMode} writer run`,
  });
  const parsed = {
    ...parsedArgs,
    agentConfig,
  };
  assertAgentConfigSupportsWriterRun(parsed.agentConfig, { context: `new ${parsed.topLevelMode} writer run` });

  const planDoc = resolve(cwd, parsed.planDoc);
  // Flag overrides config: `--unattended` forces true, otherwise fall back to
  // the resolved `agent.unattended` config value (default false).
  const unattended = parsed.unattended || getConfiguredUnattended(cwd);
  await assertGitRepositoryWithCommit(cwd, `neal ${parsed.topLevelMode}`);
  await requireExistingPlanFile(planDoc, parsed.planDoc);
  const result = await withPreparedWriterRun(
    {
      cwd,
      topLevelMode: parsed.topLevelMode,
      getLockPlanDoc: () => planDoc,
    },
    async (prepared, markInitialized) => {
      const loaded = await loadOrInitialize(planDoc, cwd, parsed.agentConfig, undefined, parsed.topLevelMode, {
        allowedDirtyPaths: parsed.topLevelMode === 'execute' ? [planDoc] : [],
        runDir: prepared.runDir,
        unattended,
        autoSquashOnCompletion: parsed.squashOnCompletion,
      });
      markInitialized();
      assertAgentConfigSupportsWriterRun(loaded.state.agentConfig, { context: `new ${loaded.state.topLevelMode} writer run` });
      return executeRun(loaded.state, loaded.statePath, loaded.logger, {
        // The `--no-squash` flag only seeds the run state; once persisted, the
        // state is the single source of truth so `neal resume` sees the same
        // preference this process does.
        autoSquashOnCompletion: loaded.state.autoSquashOnCompletion,
        unattended,
      });
    },
  );
  setWriterCommandExitCode(getExecuteRunResultExitCode(result));
}

async function requireExistingPlanFile(planDoc: string, displayPath: string): Promise<void> {
  let planStat;
  try {
    planStat = await stat(planDoc);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Plan file does not exist: ${displayPath}`);
    }
    throw error;
  }

  if (!planStat.isFile()) {
    throw new Error(`Plan path is not a file: ${displayPath}`);
  }
}
