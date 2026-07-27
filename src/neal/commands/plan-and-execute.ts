import process from 'node:process';

import { parsePlanAndExecuteArgs } from '../cli.js';
import { assertWriterProvidersConfigured, getConfiguredUnattended } from '../config.js';
import { assertGitRepositoryWithCommit } from '../git.js';
import { runPlanAndExecuteQueue, type PlanAndExecuteQueueRunnerDeps } from '../plan-queue.js';
import { assertAgentConfigSupportsWriterRun } from '../providers/registry.js';
import type { AgentConfig } from '../types.js';
import { getPlanAndExecuteQueueExitCode, setWriterCommandExitCode } from './writer-exit-codes.js';

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

export async function runPlanAndExecuteCommand(
  args: string[],
  deps?: PlanAndExecuteQueueRunnerDeps,
): Promise<void> {
  const parsedArgs = parsePlanAndExecuteArgs(args, PARSE_ONLY_AGENT_CONFIG);
  const cwd = process.cwd();
  const agentConfig = assertWriterProvidersConfigured(cwd, { context: 'plan-and-execute queue' });
  const parsed = {
    ...parsedArgs,
    agentConfig,
  };
  assertAgentConfigSupportsWriterRun(parsed.agentConfig, { context: 'plan-and-execute queue' });
  await assertGitRepositoryWithCommit(cwd, 'neal run');
  // Flag overrides config: `--unattended` forces true, otherwise fall back to
  // the resolved `agent.unattended` config value (default false).
  const unattended = parsed.unattended || getConfiguredUnattended(cwd);
  const queueState = await runPlanAndExecuteQueue({
    cwd,
    planDocs: parsed.planDocs,
    agentConfig: parsed.agentConfig,
    squashOnCompletion: parsed.squashOnCompletion,
    unattended,
    deps,
  });
  setWriterCommandExitCode(getPlanAndExecuteQueueExitCode(queueState));
}
