import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { clearConfigCache } from '../src/neal/config.js';

// The CLI banner and version aliases print package.json's version. Read it
// here so a release version bump cannot break these tests.
const PACKAGE_VERSION: string = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const PACKAGE_VERSION_PATTERN = new RegExp(
  `neal ${PACKAGE_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
);
import { runResumeRunCommand } from '../src/neal/commands/resume-run.js';
import { runNewRunCommand } from '../src/neal/commands/new-run.js';
import { runPlanAndExecuteCommand } from '../src/neal/commands/plan-and-execute.js';
import { runStatusCommand } from '../src/neal/commands/status.js';
import { loadOrInitialize } from '../src/neal/orchestrator.js';
import {
  createPlanAndExecuteQueue,
  getCurrentPlanAndExecuteQueuePointerPath,
  getPlanAndExecuteQueueStatePath,
  loadPlanAndExecuteQueueState,
  savePlanAndExecuteQueueState,
  toQueueStoredPath,
  writeQueueChildLink,
  type InitializedQueueChildRun,
  type PlanAndExecuteQueueRunnerDeps,
  type PlanAndExecuteQueueState,
  type RunFreshPlanAndExecuteChildArgs,
} from '../src/neal/plan-queue.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import { NealProviderError, type CoderStructuredPromptArgs } from '../src/neal/providers/types.js';
import { getCurrentRunPointerPath } from '../src/neal/run-registry.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import { getActiveRunLockPath } from '../src/neal/run-lock.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { runGit } from './helpers/git.js';
import { nealCliInvocation, normalizeCliStderr } from './helpers/cli.js';

const execFileAsync = promisify(execFile);
process.env.HOME = join(tmpdir(), 'neal-test-home-index');

async function runNealCliResult(...args: string[]) {
  return runNealCliResultInCwd(process.cwd(), ...args);
}

async function runNealCliResultInCwd(cwd: string, ...args: string[]) {
  const { command, args: cliArgs } = nealCliInvocation(join(process.cwd(), 'src/neal/index.ts'), args);
  return execFileAsync(command, cliArgs, { cwd });
}

async function runNealCliWithClosedStdinInCwd(cwd: string, args: string[], options: {
  home?: string;
  timeoutMs?: number;
} = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;
  const cliInvocation = nealCliInvocation(join(process.cwd(), 'src/neal/index.ts'), args);
  const child = spawn(
    cliInvocation.command,
    cliInvocation.args,
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.home ? { HOME: options.home } : {}),
      },
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(new Error(`neal ${args.join(' ')} did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }

      resolve({ code, signal, stdout, stderr });
    });
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function noInitialCommitCliMessage(commandLabel: string) {
  return new RegExp(
    escapeRegExp(`[neal] This repository has no commits yet. Create an initial commit before running \`${commandLabel}\`.`),
  );
}

async function withProcessCwd<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await action();
  } finally {
    process.chdir(previousCwd);
  }
}

async function withIsolatedHome<T>(action: (home: string) => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'neal-index-home-'));
  process.env.HOME = home;
  clearConfigCache();
  try {
    return await action(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    clearConfigCache();
  }
}

async function writeExplicitWriterConfig(cwd: string, provider = 'anthropic-claude') {
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'agent:',
      '  coder:',
      `    provider: ${provider}`,
      '  reviewer:',
      `    provider: ${provider}`,
      '',
    ].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
}

async function createUnbornGitRepo(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await runGit(cwd, 'init');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}

function outputChunkToString(chunk: unknown) {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8');
  }
  return String(chunk);
}

async function captureProcessOutput<T>(action: () => Promise<T>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutMock = mock.method(process.stdout, 'write', (chunk: unknown) => {
    stdout.push(outputChunkToString(chunk));
    return true;
  });
  const stderrMock = mock.method(process.stderr, 'write', (chunk: unknown) => {
    stderr.push(outputChunkToString(chunk));
    return true;
  });

  try {
    const result = await action();
    return {
      result,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  } finally {
    stdoutMock.mock.restore();
    stderrMock.mock.restore();
  }
}

async function captureProcessExitCode<T>(action: () => Promise<T>) {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await action();
    return {
      result,
      exitCode: process.exitCode,
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

async function readRunEventTypes(runDir: string) {
  const content = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

async function writeActiveRunLock(cwd: string, runId: string, planDoc: string, topLevelMode: 'plan' | 'execute' = 'execute') {
  const now = new Date().toISOString();
  await mkdir(join(cwd, '.neal'), { recursive: true });
  await writeFile(
    getActiveRunLockPath(cwd),
    JSON.stringify(
      {
        version: 1,
        runId,
        runStatePath: `.neal/runs/${runId}/RUN_STATE.json`,
        planDoc,
        topLevelMode,
        pid: process.pid,
        hostname: hostname(),
        cwd,
        startedAt: now,
        updatedAt: now,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function writeStaleActiveRunLock(cwd: string, runId: string, planDoc: string, topLevelMode: 'plan' | 'execute' = 'execute') {
  const now = new Date().toISOString();
  await mkdir(join(cwd, '.neal'), { recursive: true });
  await writeFile(
    getActiveRunLockPath(cwd),
    JSON.stringify(
      {
        version: 1,
        runId,
        runStatePath: `.neal/runs/${runId}/RUN_STATE.json`,
        planDoc,
        topLevelMode,
        pid: 0,
        hostname: hostname(),
        cwd,
        startedAt: now,
        updatedAt: now,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function coderBlockedStructuredResponse() {
  return {
    action: 'blocked' as const,
    message: 'Still blocked in the fake provider.',
    progress: {
      milestoneTargeted: 'Resume failed coder scope',
      newEvidence: 'The fake provider was invoked by plain resume.',
      whyNotRedundant: 'This exercises the resume command execution path.',
      nextStepUnlocked: 'The run can stop in interactive recovery.',
    },
    manualGate: null,
    derivedPlan: '',
    blockedReason: 'Still blocked in the fake provider.',
  };
}


async function createRepoRunFixture(
  prefix: string,
  options: {
    topLevelMode?: 'plan' | 'execute';
    planDocText?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, options.planDocText ?? '# Plan\n', 'utf8');
  const loaded = await loadOrInitialize(planDoc, cwd, getDefaultAgentConfig(), undefined, options.topLevelMode ?? 'execute', {
    allowedDirtyPaths: ['PLAN.md'],
  });
  return { cwd, loaded };
}

async function createUnbornResumeRunFixture(prefix: string) {
  const cwd = await createUnbornGitRepo(prefix);
  const stateDir = join(cwd, '.neal');
  const runId = 'unborn-resume-run';
  const runDir = join(stateDir, 'runs', runId);
  const planDoc = join(cwd, 'PLAN.md');
  const statePath = getRunStatePath(runDir);
  await writeFile(planDoc, '# Plan\n', 'utf8');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(cwd),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    '0000000000000000000000000000000000000000',
  );
  await saveState(statePath, initialState);
  return { cwd, runId, runDir, statePath };
}

async function attachRunToSingleItemExecutionQueue(args: {
  cwd: string;
  runId: string;
  runDir: string;
  statePath: string;
  queueStatus: 'failed' | 'completed';
  itemStatus: 'failed' | 'completed';
  activeStage: 'execution' | null;
  executionRunId?: string;
}) {
  const queue = await createPlanAndExecuteQueue({
    cwd: args.cwd,
    planDocs: ['PLAN.md'],
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(args.cwd, queue.queueId);
  const stopped = args.itemStatus !== 'completed';
  const savedQueue = await savePlanAndExecuteQueueState({
    ...queue,
    status: args.queueStatus,
    currentIndex: args.queueStatus === 'completed' ? 1 : 0,
    completedAt: args.queueStatus === 'completed' ? new Date().toISOString() : null,
    stopReason: stopped ? 'execution child failed' : null,
    items: [
      {
        ...queue.items[0],
        status: args.itemStatus,
        planningRunId: 'planning-run',
        planningStatePath: '.neal/runs/planning-run/RUN_STATE.json',
        acceptedPlanPath: 'PLAN.md',
        executionRunId: args.executionRunId ?? args.runId,
        executionStatePath: toQueueStoredPath(args.cwd, args.statePath),
        activeStage: args.activeStage,
        startedAt: new Date().toISOString(),
        completedAt: args.itemStatus === 'completed' ? new Date().toISOString() : null,
        stopReason: stopped ? 'execution child failed' : null,
      },
    ],
  });
  await writeQueueChildLink({
    runDir: args.runDir,
    queueId: savedQueue.queueId,
    queueStatePath: toQueueStoredPath(args.cwd, queueStatePath),
    itemIndex: 0,
    stage: 'execution',
  });

  return {
    queue: savedQueue,
    queueStatePath,
  };
}

type RunCommandQueueOutcome = {
  status?: OrchestrationState['status'];
  phase?: OrchestrationState['phase'];
  waitingForOperatorGuidance?: boolean;
  waitingForManualGate?: boolean;
  stopRequestedAfterScope?: boolean;
};

function defaultRunCommandPhaseForStatus(status: OrchestrationState['status']): OrchestrationState['phase'] {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    default:
      return 'coder_scope';
  }
}

function createRunCommandQueueRunner(
  cwd: string,
  outcomes: RunCommandQueueOutcome[],
  worktreeStatusOutputs: string[] = [],
): {
  calls: Array<{ stage: string; planDoc: string; itemIndex: number }>;
  deps: PlanAndExecuteQueueRunnerDeps;
} {
  const calls: Array<{ stage: string; planDoc: string; itemIndex: number }> = [];
  const pendingOutcomes = [...outcomes];
  const pendingWorktreeStatuses = [...worktreeStatusOutputs];

  return {
    calls,
    deps: {
      async getWorktreeStatus() {
        return pendingWorktreeStatuses.shift() ?? '';
      },
      async runFreshChild(
        args: RunFreshPlanAndExecuteChildArgs,
        onInitialized: (child: InitializedQueueChildRun) => Promise<void>,
      ) {
        const callNumber = calls.length + 1;
        calls.push({
          stage: args.stage,
          planDoc: args.planDoc,
          itemIndex: args.item.index,
        });

        const runId = `${args.stage}-${callNumber}`;
        const stateDir = join(cwd, '.neal');
        const runDir = join(stateDir, 'runs', runId);
        const runStatePath = getRunStatePath(runDir);
        await mkdir(runDir, { recursive: true });
        const initialState = await createInitialState(
          {
            cwd,
            planDoc: args.planDoc,
            stateDir,
            runDir,
            topLevelMode: args.stage === 'planning' ? 'plan' : 'execute',
            allowedDirtyPaths: args.stage === 'execution' ? [args.planDoc] : [],
            agentConfig: getDefaultAgentConfig(cwd),
            progressJsonPath: join(runDir, 'plan-progress.json'),
            progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
            reviewMarkdownPath: join(runDir, 'REVIEW.md'),
            recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
            maxRounds: 3,
          },
          'base-commit',
        );
        const savedState = await saveState(runStatePath, initialState);
        await onInitialized({
          runId,
          runDir,
          runStatePath,
          statePath: runStatePath,
          planDoc: savedState.planDoc,
        });

        const outcome = pendingOutcomes.shift() ?? {};
        const status = outcome.status ?? 'done';
        return {
          finalState: {
            ...savedState,
            status,
            phase: outcome.phase ?? defaultRunCommandPhaseForStatus(status),
          },
          waitingForOperatorGuidance: outcome.waitingForOperatorGuidance ?? false,
          waitingForManualGate: outcome.waitingForManualGate ?? false,
          stopRequestedAfterScope: outcome.stopRequestedAfterScope ?? false,
        };
      },
    },
  };
}

async function createRunCommandFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(
    join(cwd, 'PLAN.md'),
    [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeExplicitWriterConfig(cwd, 'fake-run-command-provider');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml');
  await runGit(cwd, 'commit', '-m', 'base commit');
  return { cwd };
}

async function createCliWriterRepoWithoutConfig(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await writeFile(
    join(cwd, 'PLAN.md'),
    [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );
  await runGit(cwd, 'add', 'README.md', 'PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  return { cwd, planPath: 'PLAN.md' };
}

async function createDirectExecuteAdmissionFixture(
  prefix: string,
  options: {
    planPath?: string;
    commitPlan?: boolean;
    ignoredPlan?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  const planPath = options.planPath ?? 'PLAN.md';
  const planDoc = join(cwd, planPath);
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'empty-excludes'), '', 'utf8');
  await runGit(cwd, 'config', 'core.excludesFile', join(root, 'empty-excludes'));
  await mkdir(dirname(planDoc), { recursive: true });
  await writeFile(
    planDoc,
    [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(cwd, 'README.md'), 'base\n', 'utf8');
  if (options.ignoredPlan) {
    await writeFile(join(cwd, '.gitignore'), 'tmp/\n', 'utf8');
  }
  await writeExplicitWriterConfig(cwd, 'fake-direct-execute-admission-provider');

  const commitPaths = ['README.md', 'neal.yml'];
  if (options.ignoredPlan) {
    commitPaths.push('.gitignore');
  }
  if (options.commitPlan) {
    commitPaths.push(planPath);
  }
  await runGit(cwd, 'add', ...commitPaths);
  await runGit(cwd, 'commit', '-m', 'base commit');

  return { cwd, planDoc, planPath };
}

async function assertDirectExecuteReachesProvider(cwd: string, planPath: string) {
  await assert.rejects(
    () => withProcessCwd(cwd, () => captureProcessOutput(() => runNewRunCommand(['execute', planPath]))),
    /direct execute provider reached/,
  );
}

async function runNealCliFailure(...args: string[]) {
  try {
    await runNealCliResult(...args);
    throw new Error(`Expected failure for args: ${args.join(' ')}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: execError.code ?? 1,
    };
  }
}

async function runNealCliFailureInCwd(cwd: string, ...args: string[]) {
  try {
    await runNealCliResultInCwd(cwd, ...args);
    throw new Error(`Expected failure for args: ${args.join(' ')}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: execError.code ?? 1,
    };
  }
}

test('getDefaultAgentConfig reads role defaults from repo config', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-config-agent-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: anthropic-claude',
        '    model: repo-coder-model',
        '  reviewer:',
        '    provider: openai-codex',
        '    model: repo-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );

    clearConfigCache(cwd);
    const config = getDefaultAgentConfig(cwd);
    assert.deepEqual(config, {
      planner: {
        provider: 'anthropic-claude',
        model: 'repo-coder-model',
        effort: null,
      },
      coder: {
        provider: 'anthropic-claude',
        model: 'repo-coder-model',
        effort: null,
      },
      reviewer: {
        provider: 'openai-codex',
        model: 'repo-reviewer-model',
        effort: null,
      },
    });
  });
});

test('getDefaultAgentConfig lets repo config override primary user config', async () => {
  await withIsolatedHome(async (home) => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-config-primary-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: anthropic-claude',
        '    model: repo-coder-model',
        '  reviewer:',
        '    provider: openai-codex',
        '    model: repo-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );
    await mkdir(join(home, '.neal'), { recursive: true });
    await writeFile(
      join(home, '.neal', 'config.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: anthropic-claude',
        '    model: primary-coder-model',
        '  reviewer:',
        '    provider: openai-codex',
        '    model: primary-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );

    clearConfigCache(cwd);
    assert.deepEqual(getDefaultAgentConfig(cwd), {
      planner: {
        provider: 'anthropic-claude',
        model: 'repo-coder-model',
        effort: null,
      },
      coder: {
        provider: 'anthropic-claude',
        model: 'repo-coder-model',
        effort: null,
      },
      reviewer: {
        provider: 'openai-codex',
        model: 'repo-reviewer-model',
        effort: null,
      },
    });
  });
});

test('getDefaultAgentConfig falls back to defaults for blank provider values', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-config-blank-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: "   "',
        '  reviewer:',
        '    provider: null',
        '',
      ].join('\n'),
      'utf8',
    );

    clearConfigCache(cwd);
    assert.deepEqual(getDefaultAgentConfig(cwd), {
      planner: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      coder: {
        provider: 'openai-codex',
        model: null,
        effort: null,
      },
      reviewer: {
        provider: 'anthropic-claude',
        model: null,
        effort: null,
      },
    });
  });
});

test('getDefaultAgentConfig rejects invalid configured providers with registry context', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-config-invalid-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: missing-provider',
        '',
      ].join('\n'),
      'utf8',
    );

    clearConfigCache(cwd);
    assert.throws(
      () => getDefaultAgentConfig(cwd),
      /Invalid provider for agent\.coder\.provider: "missing-provider".*Registered providers: openai-codex, anthropic-claude/,
    );
  });
});

test('getDefaultAgentConfig accepts provider IDs registered through the registry', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-config-fake-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-config-provider',
        '    model: fake-coder-model',
        '  reviewer:',
        '    provider: fake-config-provider',
        '    model: fake-reviewer-model',
        '',
      ].join('\n'),
      'utf8',
    );

    registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: 'fake-config-provider' }));
    try {
      clearConfigCache(cwd);
      assert.deepEqual(getDefaultAgentConfig(cwd), {
        planner: {
          provider: 'fake-config-provider',
          model: 'fake-coder-model',
          effort: null,
        },
        coder: {
          provider: 'fake-config-provider',
          model: 'fake-coder-model',
          effort: null,
        },
        reviewer: {
          provider: 'fake-config-provider',
          model: 'fake-reviewer-model',
          effort: null,
        },
      });
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('plan-mode initialization creates a run-local backup copy and persists its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-plan-backup-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(cwd, 'plans'), { recursive: true });
  const planDoc = join(cwd, 'plans', 'PLAN.md');
  await writeFile(planDoc, '## Goal\n\nBack me up.\n', 'utf8');
  await runGit(cwd, 'add', 'plans/PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const loaded = await loadOrInitialize(
    planDoc,
    cwd,
    getDefaultAgentConfig(),
    undefined,
    'plan',
  );

  assert.equal(loaded.state.planDoc, planDoc);
  assert.equal(loaded.state.planDocBackupPath, join(loaded.state.runDir, 'PLAN_ORIGINAL.md'));
  await access(loaded.state.planDocBackupPath!);
  assert.equal(await readFile(loaded.state.planDocBackupPath!, 'utf8'), '## Goal\n\nBack me up.\n');
  await assert.rejects(() => access(join(cwd, 'plans', 'archive')), { code: 'ENOENT' });

  const persistedState = JSON.parse(await readFile(loaded.statePath, 'utf8')) as {
    planDocBackupPath: string | null;
  };
  assert.equal(persistedState.planDocBackupPath, loaded.state.planDocBackupPath);
});

test('execute-mode initialization does not create a plan backup path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-execute-no-backup-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await runGit(cwd, 'add', 'PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const loaded = await loadOrInitialize(
    planDoc,
    cwd,
    getDefaultAgentConfig(),
    undefined,
    'execute',
  );

  assert.equal(loaded.state.planDocBackupPath, null);
});

test('direct execute admission starts with a clean selected plan document', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const { cwd, planPath } = await createDirectExecuteAdmissionFixture('neal-direct-execute-clean-', {
        commitPlan: true,
      });

      await assertDirectExecuteReachesProvider(cwd, planPath);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('direct execute admission allows a modified selected plan document only', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const { cwd, planDoc, planPath } = await createDirectExecuteAdmissionFixture('neal-direct-execute-modified-', {
        commitPlan: true,
      });
      await writeFile(planDoc, '# Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n\n## Goal\n\nChanged.\n', 'utf8');

      await assertDirectExecuteReachesProvider(cwd, planPath);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('direct execute admission allows an existing untracked selected plan document only', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const { cwd, planPath } = await createDirectExecuteAdmissionFixture('neal-direct-execute-untracked-', {
        commitPlan: false,
      });

      await assertDirectExecuteReachesProvider(cwd, planPath);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('direct execute admission allows a repo-root plan surrogate for an external selected plan', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const root = await mkdtemp(join(tmpdir(), 'neal-direct-execute-external-plan-'));
      const cwd = join(root, 'repo');
      const externalPlan = join(root, 'artifacts', 'PLAN.md');
      await runGit(root, 'init', 'repo');
      await runGit(cwd, 'config', 'user.name', 'Neal Test');
      await runGit(cwd, 'config', 'user.email', 'neal@example.com');
      await runGit(cwd, 'config', 'commit.gpgsign', 'false');
      await writeFile(join(root, 'empty-excludes'), '', 'utf8');
      await runGit(cwd, 'config', 'core.excludesFile', join(root, 'empty-excludes'));
      await mkdir(dirname(externalPlan), { recursive: true });
      await writeFile(
        externalPlan,
        '# External Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
        'utf8',
      );
      await writeFile(join(cwd, 'PLAN.md'), '# Refined Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
      await writeFile(join(cwd, 'README.md'), 'base\n', 'utf8');
      await writeExplicitWriterConfig(cwd, 'fake-direct-execute-admission-provider');
      await runGit(cwd, 'add', 'README.md', 'neal.yml');
      await runGit(cwd, 'commit', '-m', 'base commit');

      await assertDirectExecuteReachesProvider(cwd, externalPlan);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('direct execute admission rejects dirty worktree changes outside the selected plan document', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const { cwd, planDoc, planPath } = await createDirectExecuteAdmissionFixture('neal-direct-execute-unrelated-', {
        commitPlan: true,
      });
      await writeFile(planDoc, '# Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n\n## Goal\n\nChanged.\n', 'utf8');
      await writeFile(join(cwd, 'README.md'), 'base\nunrelated dirty change\n', 'utf8');

      await assert.rejects(
        () => withProcessCwd(cwd, () => captureProcessOutput(() => runNewRunCommand(['execute', planPath]))),
        /Cannot start neal execute with a dirty worktree:[\s\S]*README\.md/,
      );
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('direct execute admission identifies root scratch leakage without deleting it', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const { cwd, planPath } = await createDirectExecuteAdmissionFixture('neal-direct-execute-root-scratch-', {
        commitPlan: true,
      });
      const buildReviewDir = join(cwd, 'build_review');
      const buildReviewLog = join(buildReviewDir, 'log.txt');
      await mkdir(buildReviewDir, { recursive: true });
      await writeFile(buildReviewLog, 'temporary reviewer log\n', 'utf8');

      await assert.rejects(
        () => withProcessCwd(cwd, () => captureProcessOutput(() => runNewRunCommand(['execute', planPath]))),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Cannot start neal execute with a dirty worktree:[\s\S]*build_review\//);
          assert.match(error.message, /Likely Neal reviewer scratch leakage detected/);
          assert.match(error.message, /\.neal\/runs\/<run-id>\/scratch\//);
          return true;
        },
      );

      assert.equal(await readFile(buildReviewLog, 'utf8'), 'temporary reviewer log\n');
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('direct execute admission leaves ignored tmp selected plan documents untracked', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-direct-execute-admission-provider',
        coderError: new Error('direct execute provider reached'),
      }),
    );

    try {
      const { cwd, planPath } = await createDirectExecuteAdmissionFixture('neal-direct-execute-ignored-', {
        planPath: 'tmp/PLAN.md',
        commitPlan: false,
        ignoredPlan: true,
      });

      await assertDirectExecuteReachesProvider(cwd, planPath);
      assert.equal(await runGit(cwd, 'ls-files', '--', 'tmp/PLAN.md'), '');
      assert.equal(await runGit(cwd, 'status', '--short', '--ignored', '--', 'tmp'), '!! tmp/');
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('new writer-run initialization replaces the default current run pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-current-pointer-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  const firstPlan = join(cwd, 'FIRST.md');
  const secondPlan = join(cwd, 'SECOND.md');
  await writeFile(firstPlan, '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await writeFile(secondPlan, '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await runGit(cwd, 'add', 'FIRST.md', 'SECOND.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const first = await loadOrInitialize(firstPlan, cwd, getDefaultAgentConfig(), undefined, 'execute');
  const second = await loadOrInitialize(secondPlan, cwd, getDefaultAgentConfig(), undefined, 'execute');

  const pointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as {
    runId: string;
    runStatePath: string;
    planDoc: string;
    topLevelMode: string;
  };
  assert.equal(pointer.runId, basename(second.state.runDir));
  assert.equal(pointer.runStatePath, `.neal/runs/${basename(second.state.runDir)}/RUN_STATE.json`);
  assert.equal(pointer.planDoc, secondPlan);
  assert.equal(pointer.topLevelMode, 'execute');
  assert.notEqual(pointer.runId, basename(first.state.runDir));
});

test('fresh execute run sets process exit code to 0 when completed', async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(join(tmpdir(), 'neal-execute-exit-code-success-'));
    const cwd = join(root, 'repo');
    await runGit(root, 'init', 'repo');
    await runGit(cwd, 'config', 'user.name', 'Neal Test');
    await runGit(cwd, 'config', 'user.email', 'neal@example.com');
    await runGit(cwd, 'config', 'commit.gpgsign', 'false');
    const planDoc = join(cwd, 'PLAN.md');
    await writeFile(
      planDoc,
      [
        '# Plan',
        '',
        '## Execution Shape',
        '',
        'executionShape: one_shot',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-execute-success-provider',
        '  reviewer:',
        '    provider: fake-execute-success-provider',
        '',
      ].join('\n'),
      'utf8',
    );
    await runGit(cwd, 'add', 'PLAN.md', 'neal.yml');
    await runGit(cwd, 'commit', '-m', 'base commit');

    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-execute-success-provider',
        coderStructuredResponses: [
          {
            action: 'done',
            message: 'Verification-only execute completion.',
            progress: {
              milestoneTargeted: 'Fresh execute exit code',
              newEvidence: 'The fake coder returned a terminal done action.',
              whyNotRedundant: 'This exercises runNewRunCommand exit-code ownership for completed child runs.',
              nextStepUnlocked: 'The command boundary can set a zero process exit code.',
            },
            manualGate: null,
            derivedPlan: '',
            blockedReason: '',
          },
        ],
        structuredAdvisorResponses: [
          {
            planGoalSatisfied: true,
            whatChangedOverall: 'The verification-only execute fixture completed.',
            verificationSummary: 'The fake provider exercised the terminal execute path.',
            remainingKnownGaps: [],
          },
          {
            action: 'accept_complete',
            summary: 'The fresh execute run is complete.',
            rationale: 'The child run reached done through final completion review.',
            missingWork: null,
            squashCommitMessage: {
              subject: 'Complete fresh execute run',
              bullets: [
                'Finish the verification-only execute path.',
                'Confirm the terminal run state completes successfully.',
              ],
            },
          },
        ],
      }),
    );
    clearConfigCache(cwd);

    try {
      const { exitCode } = await captureProcessExitCode(() =>
        withProcessCwd(cwd, () => captureProcessOutput(() => runNewRunCommand(['execute', planDoc]))),
      );

      assert.equal(exitCode, 0);
      const pointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as {
        runStatePath: string;
      };
      const state = await loadState(join(cwd, pointer.runStatePath));
      assert.equal(state.phase, 'done');
      assert.equal(state.status, 'done');
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('fresh execute provider failure sets process exit code to 3 and exposes status provider error', async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(join(tmpdir(), 'neal-execute-exit-code-provider-failure-'));
    const cwd = join(root, 'repo');
    await runGit(root, 'init', 'repo');
    await runGit(cwd, 'config', 'user.name', 'Neal Test');
    await runGit(cwd, 'config', 'user.email', 'neal@example.com');
    await runGit(cwd, 'config', 'commit.gpgsign', 'false');
    const planDoc = join(cwd, 'PLAN.md');
    const providerId = 'fake-execute-failure-provider';
    const sessionHandle = 'fake-execute-failure-session';
    const failureMessage = 'Selected fake model is temporarily unavailable.';
    await writeFile(
      planDoc,
      [
        '# Plan',
        '',
        '## Execution Shape',
        '',
        'executionShape: one_shot',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        `    provider: ${providerId}`,
        '  reviewer:',
        `    provider: ${providerId}`,
        '',
      ].join('\n'),
      'utf8',
    );
    await runGit(cwd, 'add', 'PLAN.md', 'neal.yml');
    await runGit(cwd, 'commit', '-m', 'base commit');

    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: providerId,
        emittedProviderEvents: [
          {
            type: 'provider_error',
            provider: providerId,
            role: 'coder',
            sessionHandle,
            message: failureMessage,
            errorKind: 'api_error',
          },
        ],
        coderError: new NealProviderError({
          message: failureMessage,
          provider: providerId,
          role: 'coder',
          sessionHandle,
          kind: 'api_error',
          retryable: false,
        }),
      }),
    );
    clearConfigCache(cwd);

    try {
      const { exitCode } = await captureProcessExitCode(() =>
        withProcessCwd(cwd, () => captureProcessOutput(() => runNewRunCommand(['execute', planDoc]))),
      );

      assert.equal(exitCode, 3);
      const pointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as {
        runId: string;
        runStatePath: string;
      };
      const state = await loadState(join(cwd, pointer.runStatePath));
      assert.equal(state.phase, 'coder_scope');
      assert.equal(state.status, 'failed');

      const statusOutput = await withProcessCwd(cwd, () =>
        captureProcessOutput(() => runStatusCommand(['status', '--json', '--run', pointer.runId])),
      );
      const statusSnapshot = JSON.parse(statusOutput.stdout) as {
        status: string;
        providerError: {
          source: string;
          provider: string | null;
          role: string | null;
          sessionHandle: string | null;
          kind: string | null;
          message: string;
        } | null;
      };
      assert.equal(statusSnapshot.status, 'failed');
      assert.equal(statusSnapshot.providerError?.source, 'provider_event');
      assert.equal(statusSnapshot.providerError?.provider, providerId);
      assert.equal(statusSnapshot.providerError?.role, 'coder');
      assert.equal(statusSnapshot.providerError?.sessionHandle, sessionHandle);
      assert.equal(statusSnapshot.providerError?.kind, 'api_error');
      assert.match(statusSnapshot.providerError?.message ?? '', /temporarily unavailable/);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('neal run sets process exit code from returned queue status', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: 'fake-run-command-provider' }));

    const cases: Array<{
      name: string;
      outcomes: RunCommandQueueOutcome[];
      expectedExitCode: number;
      expectedCallStages: string[];
    }> = [
      {
        name: 'completed',
        outcomes: [{ status: 'done' }, { status: 'done' }],
        expectedExitCode: 0,
        expectedCallStages: ['planning', 'execution'],
      },
      {
        name: 'blocked',
        outcomes: [{ status: 'blocked' }],
        expectedExitCode: 2,
        expectedCallStages: ['planning'],
      },
      {
        name: 'paused',
        outcomes: [{ status: 'done' }, { status: 'paused' }],
        expectedExitCode: 2,
        expectedCallStages: ['planning', 'execution'],
      },
      {
        name: 'failed',
        outcomes: [{ status: 'failed' }],
        expectedExitCode: 3,
        expectedCallStages: ['planning'],
      },
    ];

    try {
      for (const testCase of cases) {
        const { cwd } = await createRunCommandFixture(`neal-run-${testCase.name}-exit-code-`);
        const runner = createRunCommandQueueRunner(cwd, testCase.outcomes);

        const { exitCode } = await captureProcessExitCode(() =>
          withProcessCwd(cwd, () =>
            captureProcessOutput(() => runPlanAndExecuteCommand(['run', 'PLAN.md'], runner.deps)),
          ),
        );

        assert.equal(exitCode, testCase.expectedExitCode);
        assert.deepEqual(
          runner.calls.map((call) => call.stage),
          testCase.expectedCallStages,
        );
      }
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('neal run propagates queue precondition errors without assigning writer exit code', async () => {
  await withIsolatedHome(async () => {
    registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: 'fake-run-command-provider' }));
    const { cwd } = await createRunCommandFixture('neal-run-dirty-worktree-fatal-');
    const runner = createRunCommandQueueRunner(cwd, [], [' M src/unrelated.ts\n']);

    try {
      const { exitCode } = await captureProcessExitCode(async () => {
        await assert.rejects(
          () => withProcessCwd(cwd, () =>
            captureProcessOutput(() => runPlanAndExecuteCommand(['run', 'PLAN.md'], runner.deps)),
          ),
          /Cannot continue neal run with a dirty worktree/,
        );
      });

      assert.equal(exitCode, undefined);
      assert.equal(runner.calls.length, 0);
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
    }
  });
});

test('closed-stdin writer commands fail fast when provider setup is missing', async () => {
  const { cwd, planPath } = await createCliWriterRepoWithoutConfig('neal-closed-stdin-missing-setup-');
  const home = await mkdtemp(join(tmpdir(), 'neal-closed-stdin-home-'));

  const executeResult = await runNealCliWithClosedStdinInCwd(cwd, ['execute', planPath], { home });
  assert.equal(executeResult.code, 1);
  assert.equal(executeResult.signal, null);
  assert.equal(executeResult.stdout, '');
  assert.match(executeResult.stderr, /Neal is not set up yet\./);
  assert.match(executeResult.stderr, /Run `neal setup` to choose providers/);

  const runResult = await runNealCliWithClosedStdinInCwd(cwd, ['run', planPath], { home });
  assert.equal(runResult.code, 1);
  assert.equal(runResult.signal, null);
  assert.equal(runResult.stdout, '');
  assert.match(runResult.stderr, /Neal is not set up yet\./);
  assert.match(runResult.stderr, /Run `neal setup` to choose providers/);
});

test('unknown command fails before run artifacts are created', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-cleanup-'));
  const result = await runNealCliFailureInCwd(
    cwd,
    'frobnicate',
    'PLAN.md',
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: frobnicate/);
  await assert.rejects(access(join(cwd, '.neal', 'runs')));
  await assert.rejects(access(getActiveRunLockPath(cwd)));
  const nealEntries = await readdir(join(cwd, '.neal')).catch(() => []);
  assert.deepEqual(nealEntries, []);
});

test('neal usage output shows only public subcommands by default', async () => {
  const result = await runNealCliFailure();
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, PACKAGE_VERSION_PATTERN);
  assert.match(result.stderr, /Usage: neal setup/);
  assert.match(result.stderr, /neal plan <plan\.md>/);
  assert.match(result.stderr, /neal execute <plan\.md> \[--no-squash\]/);
  assert.match(result.stderr, /neal run \[--no-squash\] <plan\.md> \[more-plans\.\.\.\]/);
  assert.match(result.stderr, /neal resume \[--run <run-id>\] \[--message "\.\.\."\]/);
  assert.match(result.stderr, /neal review \[message\] \(--last <n> \| --since <base>\)/);
  assert.match(result.stderr, /neal squash \[plan\.md\]/);
  assert.match(result.stderr, /neal check/);
  assert.match(result.stderr, /neal version/);
  assert.match(result.stderr, /neal --version/);
  assert.match(result.stderr, /neal -V/);
  assert.match(result.stderr, /neal help/);
  assert.match(result.stderr, /neal --help/);
  assert.match(result.stderr, /neal -h/);
  assert.doesNotMatch(result.stderr, /# refine plan in place/);
});

test('neal help aliases reject extra arguments through the help usage error', async () => {
  for (const alias of ['help', '--help', '-h']) {
    const result = await runNealCliFailure(alias, 'extra');
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(normalizeCliStderr(result.stderr), '[neal] Usage: neal help\n');
  }
});

test('neal help aliases print the supported usage surface on stdout', async () => {
  for (const alias of ['help', '--help', '-h']) {
    const { stdout, stderr } = await runNealCliResult(alias);
    assert.equal(normalizeCliStderr(stderr), '');
    assert.match(stdout, PACKAGE_VERSION_PATTERN);
    assert.match(stdout, /Usage: neal setup/);
    assert.match(stdout, /neal plan <plan\.md>/);
    assert.match(stdout, /neal review \[message\] \(--last <n> \| --since <base>\)/);
    assert.match(stdout, /neal check/);
    assert.match(stdout, /neal status \[--json\] --all/);
    assert.match(stdout, /neal version/);
    assert.match(stdout, /neal help/);
  }
});

test('neal version aliases print the package version', async () => {
  for (const alias of ['version', '--version', '-V']) {
    const result = await runNealCliResult(alias);
    assert.equal(normalizeCliStderr(result.stderr), '');
    assert.equal(result.stdout, `${PACKAGE_VERSION}\n`);
  }
});

test('local start-script argument separator is ignored for pnpm start compatibility', async () => {
  const helpInvocation = nealCliInvocation(join(process.cwd(), 'src/neal/index.ts'), ['--', 'help']);
  const { stdout } = await execFileAsync(
    helpInvocation.command,
    helpInvocation.args,
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        npm_lifecycle_event: 'start',
      },
    },
  );

  assert.match(stdout, /Usage: neal setup/);
  assert.match(stdout, /neal plan <plan\.md>/);
  assert.match(stdout, /neal check/);
  assert.match(stdout, /neal status \[--json\] --all/);
});

test('unknown top-level commands fail generically', async () => {
  const result = await runNealCliFailure('frobnicate');
  assert.equal(result.code, 1);
  assert.equal(
    normalizeCliStderr(result.stderr),
    '[neal] Unknown command: frobnicate. Run `neal help` for supported commands.\n',
  );
});

test('neal public subcommands route through entrypoint parser validation', async () => {
  const planResult = await runNealCliFailure('plan');
  assert.equal(planResult.code, 1);
  assert.match(planResult.stderr, /neal plan requires a plan file path argument/);

  const executeResult = await runNealCliFailure('execute', 'PLAN.md', '--unexpected');
  assert.equal(executeResult.code, 1);
  assert.match(executeResult.stderr, /unsupported flag: --unexpected/);

  const runResult = await runNealCliFailure('run');
  assert.equal(runResult.code, 1);
  assert.match(runResult.stderr, /neal run requires at least one plan file path argument/);

  const resumeResult = await runNealCliFailure('resume', '--message', 'one', '--message', 'two');
  assert.equal(resumeResult.code, 1);
  assert.match(resumeResult.stderr, /neal resume accepts --message only once/);

  const reviewResult = await runNealCliFailure('review', 'first context', 'second context', '--last', '1');
  assert.equal(reviewResult.code, 1);
  assert.match(reviewResult.stderr, /neal review accepts at most one positional message/);

  const squashResult = await runNealCliFailure('squash', 'PLAN.md', '--unexpected');
  assert.equal(squashResult.code, 1);
  assert.match(squashResult.stderr, /unsupported flag: --unexpected/);

  const checkResult = await runNealCliFailure('check', '--unexpected');
  assert.equal(checkResult.code, 1);
  assert.match(checkResult.stderr, /\[neal\] neal check accepts no arguments/);

  for (const alias of ['version', '--version', '-V']) {
    const versionResult = await runNealCliFailure(alias, '--unexpected');
    assert.equal(versionResult.code, 1);
    assert.match(versionResult.stderr, /Usage: neal version/);
  }
});

test('neal status --all --json lists run-local state paths', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-list-runs-cli-');
  const runId = basename(loaded.state.runDir);
  await mkdir(join(cwd, '.neal', 'reviews', 'review-artifact'), { recursive: true });
  await writeFile(join(cwd, '.neal', 'reviews', 'review-artifact', 'meta.json'), '{"reviewId":"review-artifact"}\n', 'utf8');

  const { stdout, stderr } = await runNealCliResultInCwd(cwd, 'status', '--all', '--json');

  const result = JSON.parse(stdout) as {
    ok: boolean;
    runs: Array<{ runId: string; statePath: string; planDoc: string }>;
  };
  assert.equal(normalizeCliStderr(stderr), '');
  assert.equal(result.ok, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].runId, runId);
  assert.equal(result.runs.some((run) => run.runId === 'review-artifact'), false);
  assert.equal(await realpath(result.runs[0].statePath), await realpath(getRunStatePath(loaded.state.runDir)));
  assert.equal(result.runs[0].planDoc, loaded.state.planDoc);
});

test('neal status --all CLI does not mutate writer-run or queue artifacts', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-list-runs-readonly-cli-');
  const runStatePath = getRunStatePath(loaded.state.runDir);
  const currentPointerPath = getCurrentRunPointerPath(cwd);
  const queueStatePath = getPlanAndExecuteQueueStatePath(cwd, 'queue-readonly');
  const currentQueuePath = getCurrentPlanAndExecuteQueuePointerPath(cwd);
  await mkdir(join(cwd, '.neal', 'queues', 'queue-readonly'), { recursive: true });
  await writeFile(queueStatePath, '{"sentinel":"queue-state"}\n', 'utf8');
  await writeFile(currentQueuePath, '{"sentinel":"current-queue"}\n', 'utf8');

  const beforeRunState = await readFile(runStatePath, 'utf8');
  const beforeCurrentPointer = await readFile(currentPointerPath, 'utf8');
  const beforeQueueState = await readFile(queueStatePath, 'utf8');
  const beforeCurrentQueue = await readFile(currentQueuePath, 'utf8');
  const beforeNealEntries = (await readdir(join(cwd, '.neal'))).sort();
  const beforeStats = {
    runState: await stat(runStatePath),
    currentPointer: await stat(currentPointerPath),
    queueState: await stat(queueStatePath),
    currentQueue: await stat(currentQueuePath),
  };

  await assert.rejects(access(getActiveRunLockPath(cwd)), /ENOENT/);

  const { stdout, stderr } = await runNealCliResultInCwd(cwd, 'status', '--all', '--json');

  const result = JSON.parse(stdout) as { ok: boolean; runs: Array<{ runId: string }> };
  assert.equal(normalizeCliStderr(stderr), '');
  assert.equal(result.ok, true);
  assert.deepEqual(result.runs.map((run) => run.runId), [basename(loaded.state.runDir)]);
  assert.equal(await readFile(runStatePath, 'utf8'), beforeRunState);
  assert.equal(await readFile(currentPointerPath, 'utf8'), beforeCurrentPointer);
  assert.deepEqual((await readdir(join(cwd, '.neal'))).sort(), beforeNealEntries);
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueState);
  assert.equal(await readFile(currentQueuePath, 'utf8'), beforeCurrentQueue);
  assert.equal((await stat(runStatePath)).mtimeMs, beforeStats.runState.mtimeMs);
  assert.equal((await stat(currentPointerPath)).mtimeMs, beforeStats.currentPointer.mtimeMs);
  assert.equal((await stat(queueStatePath)).mtimeMs, beforeStats.queueState.mtimeMs);
  assert.equal((await stat(currentQueuePath)).mtimeMs, beforeStats.currentQueue.mtimeMs);
  await assert.rejects(access(getActiveRunLockPath(cwd)), /ENOENT/);
});

test('status command source stays independent from writer mutation helpers', async () => {
  const source = await readFile(join(process.cwd(), 'src/neal/commands/status.ts'), 'utf8');

  for (const forbidden of [
    'acquireActiveRunLock',
    'withActiveRunLock',
    'saveState',
    'writeCurrentRunPointer',
    'updateRunPointersAfterStateSave',
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden}\\b`));
  }
});

test('read-only run inspection works while another writer lock is live', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-readonly-locked-cli-');
  const runId = basename(loaded.state.runDir);
  await writeActiveRunLock(cwd, 'other-active-run', join(cwd, 'OTHER_PLAN.md'));

  const listResult = await runNealCliResultInCwd(cwd, 'status', '--all', '--json');
  const statusResult = await runNealCliResultInCwd(cwd, 'status', '--json', '--run', runId);

  assert.equal(normalizeCliStderr(listResult.stderr), '');
  assert.equal(JSON.parse(listResult.stdout).runs[0].runId, runId);
  assert.equal(normalizeCliStderr(statusResult.stderr), '');
  assert.equal(JSON.parse(statusResult.stdout).ok, true);
});

test('manual gate lifecycle opens from structured coder output and resumes only after real checks pass', async () => {
  await withIsolatedHome(async () => {
    const root = await mkdtemp(join(tmpdir(), 'neal-manual-gate-lifecycle-'));
    const cwd = join(root, 'repo');
    await runGit(root, 'init', 'repo');
    await runGit(cwd, 'config', 'user.name', 'Neal Test');
    await runGit(cwd, 'config', 'user.email', 'neal@example.com');
    await runGit(cwd, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
    const planDoc = join(cwd, 'PLAN.md');
    await writeFile(planDoc, '# Plan\n\nRequire approval before continuing.\n', 'utf8');
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: fake-manual-gate-provider',
        '  reviewer:',
        '    provider: fake-manual-gate-provider',
        '',
      ].join('\n'),
      'utf8',
    );
    await runGit(cwd, 'add', 'README.md', 'PLAN.md', 'neal.yml');
    await runGit(cwd, 'commit', '-m', 'base commit');

    let structuredCoderCalls = 0;
    registerProviderDefinitionForTesting(
      createFakeProviderDefinition({
        id: 'fake-manual-gate-provider',
        coderStructuredResponses: [
          {
            action: 'manual_gate',
            message: 'Waiting for explicit approval before continuing.',
            progress: {
              milestoneTargeted: 'Approval gate',
              newEvidence: 'The fake coder reached the approval point.',
              whyNotRedundant: 'The lifecycle test must prove gate creation comes from structured coder output.',
              nextStepUnlocked: 'Neal can wait for approval and run deterministic checks on resume.',
            },
            manualGate: {
              id: 'approval',
              title: 'Approval required',
              reason: 'The user must create the approval file before the scope can continue.',
              instructionsMarkdown: 'Create `approved.txt` in the repository root.',
              resumeChecks: [
                {
                  type: 'command',
                  name: 'approval file',
                  command: [
                    process.execPath,
                    '-e',
                    'const fs = require("node:fs"); if (!fs.existsSync("approved.txt")) { process.stdout.write("missing approval file"); process.exit(7); }',
                  ],
                },
              ],
            },
            derivedPlan: '',
            blockedReason: '',
          },
          coderBlockedStructuredResponse(),
        ],
        onCoderStructuredRun() {
          structuredCoderCalls += 1;
        },
      }),
    );
    clearConfigCache(cwd);

    try {
      const freshExecute = await captureProcessExitCode(() =>
        withProcessCwd(cwd, () => captureProcessOutput(() => runNewRunCommand(['execute', planDoc]))),
      );
      assert.equal(freshExecute.exitCode, 2);

      const pointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as {
        runId: string;
        runStatePath: string;
      };
      const statePath = join(cwd, pointer.runStatePath);
      const openedState = await loadState(statePath);
      assert.equal(structuredCoderCalls, 1);
      assert.equal(openedState.phase, 'manual_gate');
      assert.equal(openedState.status, 'running');
      assert.equal(openedState.manualGate?.id, 'approval');
      assert.equal(openedState.manualGate?.lastFailure, null);

      const gateMarkdown = await readFile(join(openedState.runDir, 'GATE-approval.md'), 'utf8');
      assert.match(gateMarkdown, /Approval required/);
      assert.match(gateMarkdown, /Create `approved\.txt`/);
      assert.match(gateMarkdown, new RegExp(`neal resume --run ${escapeRegExp(pointer.runId)}`));

      const statusOutput = await withProcessCwd(cwd, () =>
        captureProcessOutput(() => runStatusCommand(['status', '--json', '--run', pointer.runId])),
      );
      const statusSnapshot = JSON.parse(statusOutput.stdout) as {
        effectiveStatus: string;
        manualGate: { id: string; resumeCommand: string } | null;
      };
      assert.equal(statusSnapshot.effectiveStatus, 'waiting_for_manual_gate');
      assert.equal(statusSnapshot.manualGate?.id, 'approval');
      assert.equal(statusSnapshot.manualGate?.resumeCommand, `neal resume --run ${pointer.runId}`);

      const failingResume = await captureProcessExitCode(() =>
        withProcessCwd(cwd, () =>
          captureProcessOutput(() => runResumeRunCommand(['resume', '--run', pointer.runId])),
        ),
      );
      assert.equal(failingResume.exitCode, 2);
      assert.match(failingResume.result.stdout, /check approval file failed with exit code 7/);
      assert.match(failingResume.result.stdout, /missing approval file/);
      assert.equal(structuredCoderCalls, 1);
      const failedState = await loadState(statePath);
      assert.equal(failedState.phase, 'manual_gate');
      assert.equal(failedState.status, 'running');
      assert.equal(failedState.manualGate?.lastFailure?.checkName, 'approval file');
      assert.equal(failedState.manualGate?.lastFailure?.exitCode, 7);

      await writeFile(join(cwd, 'approved.txt'), 'approved\n', 'utf8');
      await saveState(statePath, {
        ...failedState,
      });

      const passingResume = await captureProcessExitCode(() =>
        withProcessCwd(cwd, () => captureProcessOutput(() => runResumeRunCommand(['resume', '--run', pointer.runId]))),
      );
      assert.equal(passingResume.exitCode, 2);

      assert.equal(structuredCoderCalls, 2);
      const resumedState = await loadState(statePath);
      assert.equal(resumedState.manualGate, null);
      assert.notEqual(resumedState.phase, 'manual_gate');
    } finally {
      clearProviderDefinitionRegistrationsForTesting();
      clearConfigCache(cwd);
    }
  });
});

test('new writer runs fail on an unrelated live active lock before run artifacts are created', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-active-lock-cli-'));
  const planDoc = join(cwd, 'PLAN.md');
  await runGit(cwd, 'init');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await runGit(cwd, 'add', 'PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeExplicitWriterConfig(cwd);
  await writeActiveRunLock(cwd, 'active-run', planDoc);

  const result = await runNealCliFailureInCwd(cwd, 'execute', planDoc);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[neal\] another Neal writer run is active in this checkout/);
  assert.doesNotMatch(result.stderr, /\[neal\] \[neal\]/);
  assert.match(result.stderr, /active run: active-run/);
  assert.match(result.stderr, /neal resume --run active-run/);
  await assert.rejects(access(getCurrentRunPointerPath(cwd)));
  const runEntries = await readdir(join(cwd, '.neal', 'runs')).catch(() => []);
  assert.deepEqual(runEntries, []);
});

test('neal resume --message rejects another message while recovery guidance is pending', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-pending-guidance-cli-');
  const blockedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: new Date().toISOString(),
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: new Date().toISOString(),
          operatorGuidance: 'Handle this first.',
          origin: 'operator',
          disposition: null,
        },
      ],
    },
  });
  const runId = basename(blockedState.runDir);

  const result = await runNealCliFailureInCwd(
    cwd,
    'resume',
    '--run',
    runId,
    '--message',
    'Do one more thing.',
  );

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Operator guidance is recorded and ready for Neal to process/);
  assert.match(result.stderr, new RegExp(`Run \`neal resume --run ${escapeRegExp(runId)}\` without --message`));
  const persisted = JSON.parse(await readFile(getRunStatePath(blockedState.runDir), 'utf8')) as {
    interactiveBlockedRecovery: { turns: Array<{ operatorGuidance: string }> } | null;
  };
  assert.deepEqual(
    persisted.interactiveBlockedRecovery?.turns.map((turn) => turn.operatorGuidance),
    ['Handle this first.'],
  );
});

test('plain neal resume reports waiting guidance as controlled incomplete', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-needs-message-cli-');
  const blockedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: new Date().toISOString(),
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  });
  const runId = basename(blockedState.runDir);
  const before = await readFile(getRunStatePath(blockedState.runDir), 'utf8');

  const { result, exitCode } = await captureProcessExitCode(() =>
    withProcessCwd(cwd, () => captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId]))),
  );

  assert.equal(exitCode, 2);
  assert.match(result.stdout, /Run is waiting for operator guidance: Need operator guidance\./);
  assert.match(result.stdout, new RegExp(`neal resume --run ${escapeRegExp(runId)} --message "\\.\\.\\."`));
  assert.equal(result.stderr, '');
  assert.equal(await readFile(getRunStatePath(blockedState.runDir), 'utf8'), before);
});

test('neal resume --message rejects ordinary failed coder scopes before mutation', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-invalid-guidance-cli-');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'coder_scope',
    status: 'failed',
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
  });
  const runId = basename(failedState.runDir);
  const before = await readFile(getRunStatePath(failedState.runDir), 'utf8');

  const result = await runNealCliFailureInCwd(cwd, 'resume', '--run', runId, '--message', 'Try this.');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Run does not need --message/);
  assert.match(result.stderr, new RegExp(`neal resume --run ${escapeRegExp(runId)}`));
  assert.equal(await readFile(getRunStatePath(failedState.runDir), 'utf8'), before);
});

test('neal resume continues ordinary failed coder scopes without guidance', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-failed-coder-cli-');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'coder_scope',
    status: 'failed',
  });
  const runId = basename(failedState.runDir);
  let promptCalls = 0;

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text coder prompt');
        },
        async runStructuredPrompt<TStructured>() {
          promptCalls += 1;
          return {
            sessionHandle: 'coder-session-resumed',
            structured: coderBlockedStructuredResponse() as TStructured,
          };
        },
      };
    },
  });

  try {
    const { exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(promptCalls, 1);
  const persisted = await readFile(getRunStatePath(failedState.runDir), 'utf8');
  assert.match(persisted, /interactive_blocked_recovery/);
  const eventTypes = await readRunEventTypes(failedState.runDir);
  assert.ok(eventTypes.includes('run.resumed'));
});

test('neal resume on a done run does not call provider execution or mutate state', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-done-cli-');
  const doneState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'done',
    status: 'done',
  });
  const runId = basename(doneState.runDir);
  const before = await readFile(getRunStatePath(doneState.runDir), 'utf8');
  let promptCalls = 0;

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          promptCalls += 1;
          throw new Error('provider should not be called for done resume');
        },
        async runStructuredPrompt() {
          throw new Error('provider should not be called for structured coder prompt');
        },
      };
    },
  });

  try {
    const { result, exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 0);
    assert.match(result.stdout, /already complete/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(promptCalls, 0);
  assert.equal(await readFile(getRunStatePath(doneState.runDir), 'utf8'), before);
});

test('neal resume on a live same-run lock does not duplicate execution', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-live-same-lock-cli-');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'coder_scope',
    status: 'failed',
  });
  const runId = basename(failedState.runDir);
  const before = await readFile(getRunStatePath(failedState.runDir), 'utf8');
  let promptCalls = 0;
  await writeActiveRunLock(cwd, runId, failedState.planDoc);

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          promptCalls += 1;
          throw new Error('provider should not be called for already-running resume');
        },
        async runStructuredPrompt() {
          throw new Error('provider should not be called for structured coder prompt');
        },
      };
    },
  });

  try {
    const { result, exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 2);
    assert.match(result.stdout, /already be running/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(promptCalls, 0);
  assert.equal(await readFile(getRunStatePath(failedState.runDir), 'utf8'), before);
});

test('neal resume clears a stale same-run lock before mechanical recovery', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-stale-same-lock-cli-');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'coder_scope',
    status: 'failed',
  });
  const runId = basename(failedState.runDir);
  let promptCalls = 0;
  await writeStaleActiveRunLock(cwd, runId, failedState.planDoc);

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text coder prompt');
        },
        async runStructuredPrompt<TStructured>() {
          promptCalls += 1;
          return {
            sessionHandle: 'coder-session-stale-lock',
            structured: coderBlockedStructuredResponse() as TStructured,
          };
        },
      };
    },
  });

  try {
    const { exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(promptCalls, 1);
  await assert.rejects(access(getActiveRunLockPath(cwd)), /ENOENT/);
});

test('neal resume rejects manual-gate messages without mutating state', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-manual-gate-message-cli-');
  const now = new Date().toISOString();
  const manualGateState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'manual_gate',
    status: 'running',
    manualGate: {
      id: 'approval',
      title: 'Approval required',
      reason: 'The user must approve deployment.',
      instructionsPath: join(loaded.state.runDir, 'GATE-approval.md'),
      resumeChecks: [
        {
          type: 'command',
          name: 'approval file',
          command: [process.execPath, '-e', 'process.exit(0)'],
        },
      ],
      resumePhase: 'coder_scope',
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastFailure: null,
    },
  });
  const runId = basename(manualGateState.runDir);
  const before = await readFile(getRunStatePath(manualGateState.runDir), 'utf8');

  await assert.rejects(
    () => withProcessCwd(cwd, () => runResumeRunCommand(['resume', '--run', runId, '--message', 'Approved.'])),
    /waiting for manual gate approval/,
  );

  assert.equal(await readFile(getRunStatePath(manualGateState.runDir), 'utf8'), before);
});

test('neal resume keeps failed manual gates open without provider execution', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-manual-gate-fail-cli-');
  const now = new Date().toISOString();
  const manualGateState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'manual_gate',
    status: 'running',
    manualGate: {
      id: 'approval',
      title: 'Approval required',
      reason: 'The user must approve deployment.',
      instructionsPath: join(loaded.state.runDir, 'GATE-approval.md'),
      resumeChecks: [
        {
          type: 'command',
          name: 'approval file',
          command: [process.execPath, '-e', 'process.stdout.write("missing approval"); process.exit(6)'],
        },
      ],
      resumePhase: 'coder_scope',
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastFailure: null,
    },
  });
  const runId = basename(manualGateState.runDir);
  let promptCalls = 0;

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          promptCalls += 1;
          throw new Error('provider should not be called for failed manual gate checks');
        },
        async runStructuredPrompt() {
          promptCalls += 1;
          throw new Error('provider should not be called for failed manual gate checks');
        },
      };
    },
  });

  try {
    const { result, exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 2);
    assert.match(result.stdout, /check approval file failed with exit code 6/);
    assert.match(result.stdout, /missing approval/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(promptCalls, 0);
  const persisted = await loadState(getRunStatePath(manualGateState.runDir));
  assert.equal(persisted.phase, 'manual_gate');
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.manualGate?.lastFailure?.checkName, 'approval file');
  assert.equal(persisted.manualGate?.lastFailure?.exitCode, 6);
  assert.equal(persisted.manualGate?.lastCheckedAt !== null, true);
});

test('neal resume clears passing manual gates before provider execution', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-manual-gate-pass-cli-');
  const now = new Date().toISOString();
  const manualGateState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'manual_gate',
    status: 'running',
    manualGate: {
      id: 'approval',
      title: 'Approval required',
      reason: 'The user must approve deployment.',
      instructionsPath: join(loaded.state.runDir, 'GATE-approval.md'),
      resumeChecks: [
        {
          type: 'command',
          name: 'approval file',
          command: [process.execPath, '-e', 'process.exit(0)'],
        },
      ],
      resumePhase: 'coder_scope',
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastFailure: null,
    },
  });
  const runId = basename(manualGateState.runDir);
  let promptCalls = 0;

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text coder prompt');
        },
        async runStructuredPrompt<TStructured>() {
          promptCalls += 1;
          return {
            sessionHandle: 'coder-session-after-gate',
            structured: coderBlockedStructuredResponse() as TStructured,
          };
        },
      };
    },
  });

  try {
    const { exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(promptCalls, 1);
  const persisted = await loadState(getRunStatePath(manualGateState.runDir));
  assert.equal(persisted.manualGate, null);
  assert.notEqual(persisted.phase, 'manual_gate');
});

test('neal resume auto-squashes execute runs that complete after resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-resume-auto-squash-cli-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(join(cwd, '.gitignore'), 'tmp/\n', 'utf8');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', '.gitignore', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const planDoc = join(cwd, 'tmp', 'PLAN.md');
  await writeFile(planDoc, '# Ignored Resume Auto-Squash Plan\n', 'utf8');
  const loaded = await loadOrInitialize(planDoc, cwd, getDefaultAgentConfig(), undefined, 'execute', {
    allowedDirtyPaths: [planDoc],
  });
  await writeFile(join(cwd, 'feature.txt'), 'implemented\n', 'utf8');
  await runGit(cwd, 'add', 'feature.txt');
  await runGit(cwd, 'commit', '-m', 'Add resumable feature');
  const finalCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'final_completion_review',
    status: 'failed',
    executionShape: 'one_shot',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCommit,
    createdCommits: [finalCommit],
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the resumable feature.',
      verificationSummary: 'The resume auto-squash fixture supplies the verification evidence.',
      remainingKnownGaps: [],
    },
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit,
        finalCommit,
        summary: 'Implemented the resumable feature.',
        commitSubject: 'Add resumable feature',
        changedFiles: ['feature.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const runId = basename(failedState.runDir);
  let reviewerCalls = 0;

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          reviewerCalls += 1;
          return {
            sessionHandle: 'resume-auto-squash-reviewer',
            structured: {
              action: 'accept_complete',
              summary: 'The resumed execute run is complete.',
              rationale: 'The final completion review accepted the resumed implementation.',
              missingWork: null,
              squashCommitMessage: {
                subject: 'Add resumed auto-squash coverage',
                bullets: [
                  'Resume a failed execute run through final completion.',
                  'Squash the resumed run into one replacement commit.',
                ],
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { result, exitCode } = await captureProcessExitCode(() =>
      withProcessCwd(cwd, () => captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId]))),
    );

    assert.equal(exitCode, 0);
    assert.match(result.stdout, /Squash commit:/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(reviewerCalls, 1);
  const replacementCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const rewrittenCount = await runGit(cwd, 'rev-list', '--count', `${baseCommit}..${replacementCommit}`);
  assert.notEqual(replacementCommit, finalCommit);
  assert.equal(rewrittenCount, '1');

  const completedState = await loadState(loaded.statePath);
  assert.equal(completedState.status, 'done');
  assert.equal(completedState.phase, 'done');

  const artifact = JSON.parse(await readFile(join(failedState.runDir, 'SQUASH_RESULT.json'), 'utf8')) as {
    status: string;
    originalFinalCommit: string;
    replacementCommit: string | null;
    metadata: {
      planDocDisposition: string;
      normalizedPlanDoc: string;
    };
  };
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.originalFinalCommit, finalCommit);
  assert.equal(artifact.replacementCommit, replacementCommit);
  assert.equal(artifact.metadata.planDocDisposition, 'ignored');
  assert.equal(artifact.metadata.normalizedPlanDoc, 'tmp/PLAN.md');
});

test('neal resume honors a persisted --no-squash preference instead of auto-squashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-resume-no-squash-cli-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(join(cwd, '.gitignore'), 'tmp/\n', 'utf8');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', '.gitignore', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const planDoc = join(cwd, 'tmp', 'PLAN.md');
  await writeFile(planDoc, '# Ignored Resume No-Squash Plan\n', 'utf8');
  const loaded = await loadOrInitialize(planDoc, cwd, getDefaultAgentConfig(), undefined, 'execute', {
    allowedDirtyPaths: [planDoc],
    // Mirrors `neal execute tmp/PLAN.md --no-squash`.
    autoSquashOnCompletion: false,
  });
  assert.equal(loaded.state.autoSquashOnCompletion, false);
  await writeFile(join(cwd, 'feature.txt'), 'implemented\n', 'utf8');
  await runGit(cwd, 'add', 'feature.txt');
  await runGit(cwd, 'commit', '-m', 'Add resumable feature');
  const finalCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'final_completion_review',
    status: 'failed',
    executionShape: 'one_shot',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCommit,
    createdCommits: [finalCommit],
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the resumable feature.',
      verificationSummary: 'The resume no-squash fixture supplies the verification evidence.',
      remainingKnownGaps: [],
    },
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit,
        finalCommit,
        summary: 'Implemented the resumable feature.',
        commitSubject: 'Add resumable feature',
        changedFiles: ['feature.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const runId = basename(failedState.runDir);
  let reviewerCalls = 0;

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          reviewerCalls += 1;
          return {
            sessionHandle: 'resume-no-squash-reviewer',
            structured: {
              action: 'accept_complete',
              summary: 'The resumed execute run is complete.',
              rationale: 'The final completion review accepted the resumed implementation.',
              missingWork: null,
              squashCommitMessage: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { result, exitCode } = await captureProcessExitCode(() =>
      withProcessCwd(cwd, () => captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId]))),
    );

    assert.equal(exitCode, 0);
    assert.match(result.stdout, /Squash commit: n\/a/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(reviewerCalls, 1);
  // The persisted --no-squash preference survives resume: the run completes
  // with its original history intact and no squash artifact.
  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), finalCommit);
  await assert.rejects(access(join(failedState.runDir, 'SQUASH_RESULT.json')), /ENOENT/);

  const completedState = await loadState(loaded.statePath);
  assert.equal(completedState.status, 'done');
  assert.equal(completedState.phase, 'done');
  assert.equal(completedState.autoSquashOnCompletion, false);
});

test('neal resume advances a failed queue execution child only after the child succeeds', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-queue-child-cli-');
  const runId = basename(loaded.state.runDir);
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'final_completion_review',
    status: 'failed',
    executionShape: 'one_shot',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCommit: loaded.state.baseCommit,
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'The queue execution child completed the requested work.',
      verificationSummary: 'The focused queue resume test provided the verification.',
      remainingKnownGaps: [],
    },
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: loaded.state.baseCommit,
        finalCommit: loaded.state.baseCommit,
        summary: null,
        commitSubject: 'complete queue child',
        changedFiles: [],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const { queueStatePath } = await attachRunToSingleItemExecutionQueue({
    cwd,
    runId,
    runDir: failedState.runDir,
    statePath: loaded.statePath,
    queueStatus: 'failed',
    itemStatus: 'failed',
    activeStage: 'execution',
  });
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');
  let reviewerCalls = 0;

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          reviewerCalls += 1;
          assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
          return {
            sessionHandle: 'queue-child-final-reviewer',
            structured: {
              action: 'accept_complete',
              summary: 'The resumed queue child is complete.',
              rationale: 'The child reached its final completion review and can advance the queue.',
              missingWork: null,
              squashCommitMessage: {
                subject: 'Complete resumed queue child',
                bullets: [
                  'Finish the resumed execution child cleanly.',
                  'Allow the queue to advance after final completion review.',
                ],
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() => runResumeRunCommand(['resume', '--run', runId])),
    ));

    assert.equal(exitCode, 0);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(reviewerCalls, 1);
  const completedQueue = await loadPlanAndExecuteQueueState(queueStatePath);
  assert.equal(completedQueue.status, 'completed');
  assert.equal(completedQueue.currentIndex, 1);
  assert.equal(completedQueue.items[0].status, 'completed');
  assert.equal(completedQueue.items[0].activeStage, null);
  assert.notEqual(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
});

test('neal resume uses returned linked queue stop status as the final exit code', async () => {
  const cases: Array<{ queueStatus: PlanAndExecuteQueueState['status']; expectedExitCode: number }> = [
    { queueStatus: 'paused', expectedExitCode: 2 },
    { queueStatus: 'failed', expectedExitCode: 3 },
  ];

  for (const { queueStatus, expectedExitCode } of cases) {
    const { cwd, loaded } = await createRepoRunFixture(`neal-resume-queue-${queueStatus}-exit-code-cli-`);
    const runId = basename(loaded.state.runDir);
    const failedState = await saveState(loaded.statePath, {
      ...loaded.state,
      phase: 'final_completion_review',
      status: 'failed',
      executionShape: 'one_shot',
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCommit: loaded.state.baseCommit,
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'The linked queue child completed the requested work.',
        verificationSummary: 'The focused queue resume exit-code test provided the verification.',
        remainingKnownGaps: [],
      },
      completedScopes: [
        {
          number: '1',
          marker: 'AUTONOMY_DONE',
          result: 'accepted',
          baseCommit: loaded.state.baseCommit,
          finalCommit: loaded.state.baseCommit,
          summary: null,
          commitSubject: 'complete linked queue child',
          changedFiles: [],
          reviewRounds: 1,
          findings: 0,
          residualReviewDebt: [],
          archivedReviewPath: null,
          blocker: null,
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
    });
    const { queue } = await attachRunToSingleItemExecutionQueue({
      cwd,
      runId,
      runDir: failedState.runDir,
      statePath: loaded.statePath,
      queueStatus: 'failed',
      itemStatus: 'failed',
      activeStage: 'execution',
    });
    let reviewerCalls = 0;
    let continuationCalls = 0;

    setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
      createStructuredAdvisorAdapter() {
        return {
          async runStructuredRound<TStructured>() {
            reviewerCalls += 1;
            return {
              sessionHandle: `queue-child-${queueStatus}-final-reviewer`,
              structured: {
                action: 'accept_complete',
                summary: 'The resumed queue child is complete.',
                rationale: 'The child reached its final completion review and can advance the queue.',
                missingWork: null,
                squashCommitMessage: {
                  subject: 'Complete resumed queue child',
                  bullets: [
                    'Finish the resumed execution child cleanly.',
                    'Allow the queue to advance after final completion review.',
                  ],
                },
              } as TStructured,
            };
          },
        };
      },
    });

    try {
      const { exitCode } = await captureProcessExitCode(() =>
        withProcessCwd(cwd, () =>
          captureProcessOutput(() =>
            runResumeRunCommand(['resume', '--run', runId], {
              async continueQueueFromChildRun(args) {
                continuationCalls += 1;
                assert.equal(args.childResult.finalState.status, 'done');
                return {
                  ...queue,
                  status: queueStatus,
                  stopReason: `queue returned ${queueStatus}`,
                };
              },
            }),
          ),
        ),
      );

      assert.equal(exitCode, expectedExitCode);
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }

    assert.equal(reviewerCalls, 1);
    assert.equal(continuationCalls, 1);
  }
});

test('neal resume refuses consumed queue children before mutation', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-consumed-queue-child-cli-');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'coder_scope',
    status: 'failed',
  });
  const runId = basename(failedState.runDir);
  const { queueStatePath } = await attachRunToSingleItemExecutionQueue({
    cwd,
    runId,
    runDir: failedState.runDir,
    statePath: loaded.statePath,
    queueStatus: 'completed',
    itemStatus: 'completed',
    activeStage: null,
  });
  const beforeRunStateBytes = await readFile(loaded.statePath, 'utf8');
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');

  await assert.rejects(
    () => withProcessCwd(cwd, () => runResumeRunCommand(['resume', '--run', runId])),
    /already been consumed/,
  );

  assert.equal(await readFile(loaded.statePath, 'utf8'), beforeRunStateBytes);
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
});

test('neal resume reports a consumed queue child with a completed run as already done', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-consumed-done-queue-child-cli-');
  const doneState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'done',
    status: 'done',
  });
  const runId = basename(doneState.runDir);
  const { queueStatePath } = await attachRunToSingleItemExecutionQueue({
    cwd,
    runId,
    runDir: doneState.runDir,
    statePath: loaded.statePath,
    queueStatus: 'completed',
    itemStatus: 'completed',
    activeStage: null,
  });
  const beforeRunStateBytes = await readFile(loaded.statePath, 'utf8');
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');

  // The crash-recovery case: the run finished and its queue item completed
  // before resume was attempted. Resume must succeed as an ordinary
  // already-done no-op instead of refusing with queue-internal bookkeeping.
  await withProcessCwd(cwd, () => runResumeRunCommand(['resume', '--run', runId]));

  assert.equal(await readFile(loaded.statePath, 'utf8'), beforeRunStateBytes);
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
});

test('neal resume refuses mismatched queue child links before mutation', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-mismatched-queue-child-cli-');
  const failedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'coder_scope',
    status: 'failed',
  });
  const runId = basename(failedState.runDir);
  const { queueStatePath } = await attachRunToSingleItemExecutionQueue({
    cwd,
    runId,
    runDir: failedState.runDir,
    statePath: loaded.statePath,
    queueStatus: 'failed',
    itemStatus: 'failed',
    activeStage: 'execution',
    executionRunId: 'different-child-run',
  });
  const beforeRunStateBytes = await readFile(loaded.statePath, 'utf8');
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');

  await assert.rejects(
    () => withProcessCwd(cwd, () => runResumeRunCommand(['resume', '--run', runId])),
    /does not match queue item/,
  );

  assert.equal(await readFile(loaded.statePath, 'utf8'), beforeRunStateBytes);
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
});

test('runResumeRunCommand records resume guidance and processes the pending recovery turn', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-message-run-cli-');
  const blockedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: new Date().toISOString(),
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  });
  const runStatePath = getRunStatePath(blockedState.runDir);
  let recoveryPromptCalls = 0;

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text coder recovery prompt');
        },
        async runStructuredPrompt<TStructured>() {
          recoveryPromptCalls += 1;
          return {
            sessionHandle: 'coder-session-recovery-message',
            structured: {
              action: 'stay_blocked',
              summary: 'More guidance is needed.',
              rationale: 'The supplied guidance did not settle the reviewer concern.',
              blocker: 'Need one narrower answer.',
              replacementPlan: '',
              laterScopeNumber: 0,
              laterScopeBody: '',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() =>
        runResumeRunCommand(['resume', '--run', basename(blockedState.runDir), '--message', 'Try one narrow fix.']),
      ),
    ));

    assert.equal(exitCode, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(recoveryPromptCalls, 1);
  const persisted = JSON.parse(await readFile(runStatePath, 'utf8')) as {
    phase: string;
    interactiveBlockedRecovery: {
      lastHandledTurn: number;
      blockedReason: string;
      turns: Array<{ operatorGuidance: string; disposition: { action: string } | null }>;
    } | null;
  };
  assert.equal(persisted.phase, 'interactive_blocked_recovery');
  assert.equal(persisted.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(persisted.interactiveBlockedRecovery?.blockedReason, 'Need one narrower answer.');
  assert.equal(persisted.interactiveBlockedRecovery?.turns[0]?.operatorGuidance, 'Try one narrow fix.');
  assert.equal(persisted.interactiveBlockedRecovery?.turns[0]?.disposition?.action, 'stay_blocked');

  const eventTypes = await readRunEventTypes(blockedState.runDir);
  assert.ok(eventTypes.includes('run.resumed'));
  assert.ok(eventTypes.includes('run.user_guidance_scanned'));
  assert.ok(eventTypes.includes('interactive_blocked_recovery.guidance_recorded'));
});

test('runResumeRunCommand records plan-review guidance and resumes through plan response', async () => {
  const planDocText = [
    '# Recovery Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: Recover plan review',
    '- Goal: Keep plan-review recovery scoped to reviewer findings.',
    '- Verification: `pnpm test`',
    '- Success Condition: Plan-review recovery is verified.',
    '',
  ].join('\n');
  const { cwd, loaded } = await createRepoRunFixture('neal-resume-plan-guidance-cli-', {
    topLevelMode: 'plan',
    planDocText,
  });
  const blockedState = await saveState(loaded.statePath, {
    ...loaded.state,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    coderSessionHandle: 'coder-plan-response-session-a',
    coderSessionProtocol: 'structured_json_v1',
    pendingPlanReviewGuidance: null,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [loaded.state.planDoc],
        claim: 'The recovery plan needs the reviewer guidance incorporated.',
        requiredAction: 'Revise the plan response using the operator guidance.',
        status: 'open',
        roundSummary: 'The reviewer blocked the plan on recovery guidance.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });
  const runId = basename(blockedState.runDir);
  const legacyPersisted = JSON.parse(
    await readFile(getRunStatePath(blockedState.runDir), 'utf8'),
  ) as Record<string, unknown>;
  delete legacyPersisted.plannerSessionHandle;
  delete legacyPersisted.plannerSessionProtocol;
  await writeFile(getRunStatePath(blockedState.runDir), JSON.stringify(legacyPersisted, null, 2) + '\n', 'utf8');
  const guidance = 'Keep the response focused on the reviewer finding.';
  let coderPrompt = '';
  let coderCalls = 0;
  let reviewerCalls = 0;

  const statusBefore = await withProcessCwd(cwd, () =>
    captureProcessOutput(() => runStatusCommand(['status', '--json', '--run', runId])),
  );
  const statusSnapshot = JSON.parse(statusBefore.stdout) as {
    effectiveStatus: string;
    waitingForOperatorGuidance: boolean;
    pendingOperatorGuidance: boolean;
    resumeDecision: { kind: string; messageCommand?: string };
  };
  assert.equal(statusSnapshot.effectiveStatus, 'waiting_for_operator');
  assert.equal(statusSnapshot.waitingForOperatorGuidance, true);
  assert.equal(statusSnapshot.pendingOperatorGuidance, false);
  assert.equal(statusSnapshot.resumeDecision.kind, 'needs_message');
  assert.equal(statusSnapshot.resumeDecision.messageCommand, `neal resume --run ${runId} --message "..."`);

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text plan-response prompt');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          coderCalls += 1;
          coderPrompt = args.prompt;
          return {
            sessionHandle: 'coder-plan-response-session-b',
            structured: {
              outcome: 'responded',
              summary: 'Addressed the blocked plan-review guidance.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Focused the plan response on the reviewer finding.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          reviewerCalls += 1;
          return {
            sessionHandle: 'reviewer-plan-session-b',
            structured: {
              summary: 'Plan review converged after guidance.',
              executionShape: 'multi_scope',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { exitCode } = await captureProcessExitCode(() => withProcessCwd(cwd, () =>
      captureProcessOutput(() =>
        runResumeRunCommand(['resume', '--run', runId, '--message', `  ${guidance}  `]),
      ),
    ));

    assert.equal(exitCode, 0);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.equal(coderCalls, 1);
  assert.equal(reviewerCalls, 1);
  assert.match(coderPrompt, /Operator guidance for this blocked plan-review recovery:/);
  assert.match(coderPrompt, new RegExp(escapeRegExp(guidance)));
  assert.ok(
    coderPrompt.indexOf('Operator guidance for this blocked plan-review recovery:') <
      coderPrompt.indexOf('Open findings:'),
  );

  const persisted = await loadState(getRunStatePath(blockedState.runDir));
  assert.equal(persisted.phase, 'done');
  assert.equal(persisted.status, 'done');
  assert.equal(persisted.blockedFromPhase, null);
  assert.equal(persisted.pendingPlanReviewGuidance, null);
  assert.equal(persisted.interactiveBlockedRecovery, null);
  assert.equal(persisted.plannerSessionHandle, 'coder-plan-response-session-b');
  assert.equal(persisted.coderSessionHandle, null);
  assert.equal(persisted.findings[0]?.status, 'fixed');
  assert.equal(persisted.rounds.length, 1);

  const eventTypes = await readRunEventTypes(blockedState.runDir);
  assert.ok(eventTypes.includes('run.resumed'));
  assert.ok(eventTypes.includes('plan_review_guidance.recorded'));
  assert.ok(eventTypes.includes('phase.complete'));

  const narrative = await readFile(join(blockedState.runDir, 'RUN_NARRATIVE.md'), 'utf8');
  assert.match(narrative, /- Mode: plan/);
  assert.match(narrative, /- Status: done/);
  assert.match(narrative, /- Pending operator guidance: no/);
});

test('neal resume rejects extra positional operands', async () => {
  const { cwd, loaded } = await createRepoRunFixture('neal-run-conflict-cli-');
  const result = await runNealCliFailureInCwd(
    cwd,
    'resume',
    'extra',
    '--run',
    basename(loaded.state.runDir),
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /neal resume accepts only --run <run-id> and optional --message <guidance>/);
});

test('fresh writer commands require explicit setup config before plan file validation', async () => {
  await withIsolatedHome(async () => {
    for (const args of [
      ['plan', 'missing-plan.md'],
      ['execute', 'missing-plan.md'],
      ['run', 'missing-plan.md'],
    ]) {
      const cwd = await mkdtemp(join(tmpdir(), 'neal-index-setup-guard-'));
      const result = await runNealCliFailureInCwd(cwd, ...args);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Neal is not set up yet\./);
      assert.match(
        result.stderr,
        /Run `neal setup` to choose providers, or set agent\.coder\.provider and agent\.reviewer\.provider in neal\.yml\./,
      );
      assert.doesNotMatch(result.stderr, /Plan file does not exist/);
    }
  });
});

test('neal check without explicit writer config prints check-specific setup guidance', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-check-setup-guard-'));
    const result = await runNealCliFailureInCwd(cwd, 'check');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Neal is not set up yet\./);
    assert.match(
      result.stderr,
      /Run `neal setup` to choose providers, then run `neal check` again\./,
    );
  });
});

test('non-writer commands stay outside the explicit writer setup guard', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-guard-free-'));
    const setupGuidance = /Neal is not set up yet/;

    const helpResult = await runNealCliResultInCwd(cwd, 'help');
    assert.doesNotMatch(helpResult.stdout, setupGuidance);

    const statusResult = await runNealCliResultInCwd(cwd, 'status', '--all');
    assert.doesNotMatch(statusResult.stdout, setupGuidance);
    assert.doesNotMatch(statusResult.stderr, setupGuidance);

    const reviewResult = await runNealCliFailureInCwd(cwd, 'review');
    assert.doesNotMatch(reviewResult.stderr, setupGuidance);
    assert.match(reviewResult.stderr, /neal review requires exactly one selector/);

    const squashResult = await runNealCliFailureInCwd(cwd, 'squash', 'PLAN.md', '--unexpected');
    assert.doesNotMatch(squashResult.stderr, setupGuidance);
    assert.match(squashResult.stderr, /unsupported flag: --unexpected/);

    const setupResult = await runNealCliFailureInCwd(cwd, 'setup', '--unknown');
    assert.doesNotMatch(setupResult.stderr, setupGuidance);
    assert.match(setupResult.stderr, /\[neal\] Unknown argument: --unknown/);
  });
});

test('invalid explicit provider config stays an invalid-provider error for writer commands', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-invalid-explicit-provider-'));
    await writeFile(
      join(cwd, 'neal.yml'),
      [
        'agent:',
        '  coder:',
        '    provider: missing-provider',
        '  reviewer:',
        '    provider: anthropic-claude',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runNealCliFailureInCwd(cwd, 'plan', 'missing-plan.md');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid provider for agent\.coder\.provider: "missing-provider"/);
    assert.doesNotMatch(result.stderr, /Run `neal setup`/);
    assert.doesNotMatch(result.stderr, /Plan file does not exist/);
  });
});

test('plain resume without a selectable run requires setup config, while explicit missing runs stay missing-run errors', async () => {
  await withIsolatedHome(async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'neal-index-resume-setup-guard-'));

    const plainResult = await runNealCliFailureInCwd(cwd, 'resume');
    assert.equal(plainResult.code, 1);
    assert.match(plainResult.stderr, /Neal is not set up yet\./);
    assert.match(
      plainResult.stderr,
      /Run `neal setup` to choose providers, or set agent\.coder\.provider and agent\.reviewer\.provider in neal\.yml\./,
    );

    const explicitMissingResult = await runNealCliFailureInCwd(cwd, 'resume', '--run', 'missing-id');
    assert.equal(explicitMissingResult.code, 1);
    assert.match(explicitMissingResult.stderr, /No run state found for --run missing-id/);
    assert.doesNotMatch(explicitMissingResult.stderr, /Run `neal setup`/);
  });
});

test('neal execute reports ordinary file misses directly after explicit writer config is present', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-missing-file-'));
  await runGit(cwd, 'init');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeExplicitWriterConfig(cwd);
  const result = await runNealCliFailureInCwd(cwd, 'execute', 'missing-plan.md');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Plan file does not exist: missing-plan\.md/);
});

test('fresh writer commands keep the generic git repository error outside git worktrees', async () => {
  for (const command of ['plan', 'execute', 'run'] as const) {
    const cwd = await mkdtemp(join(tmpdir(), `neal-index-non-git-${command}-`));
    await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');
    await writeExplicitWriterConfig(cwd);

    const result = await runNealCliFailureInCwd(cwd, command, 'PLAN.md');

    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`neal ${command} requires a Git repository with at least one commit`));
    assert.doesNotMatch(result.stderr, /This repository has no commits yet/);
    assert.doesNotMatch(result.stderr, /ambiguous argument 'HEAD'/);
    await assert.rejects(access(join(cwd, '.neal', 'runs')));
    await assert.rejects(access(getActiveRunLockPath(cwd)));
  }
});

test('history-dependent commands reject unborn git repositories before execution side effects', async () => {
  for (const command of ['plan', 'execute', 'run'] as const) {
    const cwd = await createUnbornGitRepo(`neal-index-no-head-${command}-`);
    await writeFile(join(cwd, 'PLAN.md'), '# Plan\n', 'utf8');
    await writeExplicitWriterConfig(cwd);

    const result = await runNealCliFailureInCwd(cwd, command, 'PLAN.md');

    assert.equal(result.code, 1);
    assert.match(result.stderr, noInitialCommitCliMessage(`neal ${command}`));
    assert.doesNotMatch(result.stderr, /requires a Git repository with at least one commit/);
    assert.doesNotMatch(result.stderr, /ambiguous argument 'HEAD'/);
    await assert.rejects(access(join(cwd, '.neal', 'runs')));
    await assert.rejects(access(getActiveRunLockPath(cwd)));
  }

  {
    const { cwd, statePath } = await createUnbornResumeRunFixture('neal-index-no-head-resume-');
    const beforeState = await readFile(statePath, 'utf8');

    const result = await runNealCliFailureInCwd(cwd, 'resume');

    assert.equal(result.code, 1);
    assert.match(result.stderr, noInitialCommitCliMessage('neal resume'));
    assert.equal(await readFile(statePath, 'utf8'), beforeState);
    await assert.rejects(access(getActiveRunLockPath(cwd)));
  }

  {
    const cwd = await createUnbornGitRepo('neal-index-no-head-review-');

    const result = await runNealCliFailureInCwd(cwd, 'review', 'Review unborn history', '--last', '1');

    assert.equal(result.code, 1);
    assert.match(result.stderr, noInitialCommitCliMessage('neal review'));
    await assert.rejects(access(join(cwd, '.neal', 'reviews')));
  }

  {
    const cwd = await createUnbornGitRepo('neal-index-no-head-squash-');

    const result = await runNealCliFailureInCwd(cwd, 'squash');

    assert.equal(result.code, 1);
    assert.match(result.stderr, noInitialCommitCliMessage('neal squash'));
    await assert.rejects(access(join(cwd, '.neal', 'runs')));
  }
});
