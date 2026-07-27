import { copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { getMaxReviewRounds, getPhaseHeartbeatMs } from './config.js';
import { getHeadCommit, getWorktreeStatus } from './git.js';
import { createRunLogger, type RunLogger } from './logger.js';
import { writeDetail } from './diagnostic.js';
import { logUserGuidanceApplied } from './prompts/guidance.js';
import { writeExecutionArtifacts } from './orchestrator/artifacts.js';
import {
  runFinalCompletionReviewPhase as runFinalCompletionReviewPhaseImpl,
  runExecuteFinalizationPhase as runExecuteFinalizationPhaseImpl,
} from './orchestrator/completion.js';
import {
  runOnePass as runOnePassLoop,
  type RunLoopHandlers,
  type RunOnePassOptions,
} from './orchestrator/run-loop.js';
import {
  runCoderScopePhase,
  runExecuteResponsePhase,
} from './orchestrator/phases/coder.js';
import {
  hasPendingInteractiveBlockedRecoveryTurn,
  runInteractiveBlockedRecoveryPhase,
} from './orchestrator/phases/recovery.js';
import {
  runAwaitingDerivedPlanExecutionPhase,
  runCoderPlanPhase,
  runPlanReviewPhase,
  runPlanningResponsePhase,
} from './orchestrator/phases/planning.js';
import { runReviewPhase } from './orchestrator/phases/review.js';
import { writeCheckpointRetrospective } from './retrospective.js';
import { applyResumeActions, planResumeActions } from './resume-planner.js';
import { writeCurrentRunPointer } from './run-registry.js';
import { createInitialState, getRunStatePath, loadState, saveState } from './state.js';
import { getNealDir, getPlanDocumentBackupPath } from './storage-paths.js';
import type {
  AgentConfig,
  OrchestrationState,
  OrchestratorInit,
  ResidualReviewDebtItem,
} from './types.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  formatDirtyWorktreeDiagnostic,
} from './worktree-status.js';

export const runFinalCompletionReviewPhase = (
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
) =>
  runFinalCompletionReviewPhaseImpl(state, statePath, logger, {
    writeExecutionArtifacts,
  });
export const runExecuteFinalizationPhase = (
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
) =>
  runExecuteFinalizationPhaseImpl(state, statePath, logger, {
    writeExecutionArtifacts,
  });

function startPhaseHeartbeat(
  phase: OrchestrationState['phase'],
  getState: () => OrchestrationState,
  logger?: RunLogger,
  intervalMs = getPhaseHeartbeatMs(getState().cwd),
) {
  if (!logger || intervalMs <= 0) {
    return () => {};
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const state = getState();
    const elapsedMs = Date.now() - startedAt;
    const payload = {
      phase,
      elapsedMs,
      coderSessionHandle: state.coderSessionHandle,
      reviewerSessionHandle: state.reviewerSessionHandle,
      currentScopeNumber: state.currentScopeNumber,
      topLevelMode: state.topLevelMode,
    };
    void logger.event('phase.heartbeat', payload);
    writePhaseHeartbeatDetail({ state, phase, elapsedMs, logger });
  }, intervalMs);

  return () => clearInterval(timer);
}

export function writePhaseHeartbeatDetail(args: {
  state: OrchestrationState;
  phase: OrchestrationState['phase'];
  elapsedMs: number;
  logger?: RunLogger;
}) {
  writeDetail(
    `[neal] heartbeat phase=${args.phase} elapsed=${Math.round(args.elapsedMs / 1000)}s` +
      `${args.state.coderSessionHandle ? ` coder=${args.state.coderSessionHandle}` : ''}` +
      `${args.state.reviewerSessionHandle ? ` reviewer=${args.state.reviewerSessionHandle}` : ''}\n`,
    args.logger,
    {
      runId: basename(args.state.runDir),
      phase: args.phase,
      scopeNumber: args.state.currentScopeNumber ?? undefined,
    },
  );
}

export async function initializeOrchestration(
  planDoc: string,
  cwd: string,
  agentConfig: AgentConfig,
  topLevelMode: 'plan' | 'execute' = 'execute',
  options?: {
    allowedDirtyPaths?: string[];
    runDir?: string;
    unattended?: boolean;
    autoSquashOnCompletion?: boolean;
    inheritedPlanReviewDebt?: ResidualReviewDebtItem[];
  },
) {
  const absolutePlanDoc = resolve(planDoc);
  const stateDir = getNealDir(cwd);
  const logger = await createRunLogger({
    cwd,
    stateDir,
    planDoc: absolutePlanDoc,
    topLevelMode,
    runDir: options?.runDir,
  });
  const planDocBackupPath =
    topLevelMode === 'plan' ? await createPlanDocumentBackup(absolutePlanDoc, logger.runDir) : null;

  const init: OrchestratorInit = {
    cwd,
    planDoc: absolutePlanDoc,
    planDocBackupPath,
    stateDir,
    runDir: logger.runDir,
    topLevelMode,
    allowedDirtyPaths: options?.allowedDirtyPaths ?? [],
    agentConfig,
    unattended: options?.unattended ?? false,
    autoSquashOnCompletion: options?.autoSquashOnCompletion ?? true,
    progressJsonPath: join(logger.runDir, 'plan-progress.json'),
    progressMarkdownPath: join(logger.runDir, 'PLAN_PROGRESS.md'),
    reviewMarkdownPath: join(logger.runDir, 'REVIEW.md'),
    recoveryMarkdownPath: join(logger.runDir, 'RECOVERY.md'),
    maxRounds: getMaxReviewRounds(cwd),
    // Only the `neal run` queue's execution stage supplies this; every other
    // caller omits it and the durable inherited debt seeds to an empty array.
    inheritedPlanReviewDebt: options?.inheritedPlanReviewDebt,
  };

  await mkdir(stateDir, { recursive: true });

  const baseCommit = await getHeadCommit(cwd);
  const initialState = await createInitialState(init, baseCommit);
  const statePath = getRunStatePath(logger.runDir);
  const savedState = await saveState(statePath, initialState);
  await writeCurrentRunPointer(savedState);
  await writeExecutionArtifacts(savedState);
  await logger.event('run.initialized', {
    statePath,
    baseCommit,
    topLevelMode,
    planDocBackupPath,
    agentConfig: savedState.agentConfig,
    reviewMarkdownPath: savedState.reviewMarkdownPath,
    progressJsonPath: savedState.progressJsonPath,
    progressMarkdownPath: savedState.progressMarkdownPath,
  });
  await logUserGuidanceApplied(logger);

  return {
    state: savedState,
    statePath,
    logger,
  };
}

async function createPlanDocumentBackup(planDoc: string, runDir: string) {
  const backupPath = getPlanDocumentBackupPath(runDir);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(planDoc, backupPath);
  return backupPath;
}

export async function runOnePass(
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
  options?: RunOnePassOptions,
) {
  const runPhaseWithCoderSessionHandle = async (runPhase: () => Promise<OrchestrationState>) => {
    const nextState = await runPhase();
    options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
    return nextState;
  };

  const handlers: RunLoopHandlers = {
    coder_plan: async (currentState) =>
      runPhaseWithCoderSessionHandle(() => runCoderPlanPhase(currentState, statePath, logger)),
    reviewer_plan: async (currentState) => runPlanReviewPhase(currentState, statePath, logger),
    coder_plan_response: async (currentState) =>
      runPhaseWithCoderSessionHandle(() =>
        runPlanningResponsePhase(
          currentState,
          statePath,
          currentState.phase as 'coder_plan_response' | 'coder_plan_optional_response',
          logger,
        )),
    awaiting_derived_plan_execution: async (currentState) =>
      runAwaitingDerivedPlanExecutionPhase(currentState, statePath, logger),
    coder_scope: async (currentState) =>
      runPhaseWithCoderSessionHandle(() => runCoderScopePhase(currentState, statePath, logger)),
    reviewer_scope: async (currentState) => runReviewPhase(currentState, statePath, logger),
    coder_response: async (currentState) =>
      runPhaseWithCoderSessionHandle(() =>
        runExecuteResponsePhase(
          currentState,
          statePath,
          currentState.phase as 'coder_response' | 'coder_optional_response',
          logger,
        )),
    interactive_blocked_recovery: async (currentState) =>
      runPhaseWithCoderSessionHandle(() => runInteractiveBlockedRecoveryPhase(currentState, statePath, logger)),
    execute_finalization: async (currentState) => runExecuteFinalizationPhase(currentState, statePath, logger),
    final_completion_review: async (currentState) =>
      runFinalCompletionReviewPhase(currentState, statePath, logger),
  };

  return runOnePassLoop({
    state,
    statePath,
    logger,
    options,
    runtime: {
      hasPendingInteractiveBlockedRecoveryTurn,
      startPhaseHeartbeat,
      writeCheckpointRetrospective: async (currentState, reason) => {
        await writeCheckpointRetrospective(currentState, reason);
      },
    },
    handlers,
  });
}

export async function loadOrInitialize(
  planDoc: string | null,
  cwd: string,
  agentConfig: AgentConfig,
  resumeStatePath?: string,
  topLevelMode: 'plan' | 'execute' = 'execute',
  options?: {
    allowedDirtyPaths?: string[];
    runDir?: string;
    unattended?: boolean;
    autoSquashOnCompletion?: boolean;
    inheritedPlanReviewDebt?: ResidualReviewDebtItem[];
  },
) {
  if (resumeStatePath) {
    return loadRunForResume(resumeStatePath);
  }

  return initializeNewRun(planDoc, cwd, agentConfig, topLevelMode, options);
}

export async function loadRunForResume(resumeStatePath: string) {
  const initialState = await loadState(resumeStatePath);
  const logger = await createRunLogger({
    cwd: initialState.cwd,
    stateDir: dirname(resumeStatePath),
    planDoc: initialState.planDoc,
    topLevelMode: initialState.topLevelMode,
    runDir: initialState.runDir,
    resumedFromStatePath: resumeStatePath,
  });
  await logger.event('run.resumed', {
    statePath: resumeStatePath,
    phase: initialState.phase,
    status: initialState.status,
    agentConfig: initialState.agentConfig,
  });
  await logUserGuidanceApplied(logger);

  const resumeActions = planResumeActions(initialState);
  const state = await applyResumeActions(initialState, resumeStatePath, logger, resumeActions);
  await writeCurrentRunPointer(state);
  await writeExecutionArtifacts(state);

  return {
    state,
    statePath: resumeStatePath,
    logger,
  };
}

export async function initializeNewRun(
  planDoc: string | null,
  cwd: string,
  agentConfig: AgentConfig,
  topLevelMode: 'plan' | 'execute' = 'execute',
  options?: {
    allowedDirtyPaths?: string[];
    runDir?: string;
    unattended?: boolean;
    autoSquashOnCompletion?: boolean;
    inheritedPlanReviewDebt?: ResidualReviewDebtItem[];
  },
) {
  if (!planDoc) {
    throw new Error('planDoc is required when initializing a new orchestration');
  }

  if (topLevelMode === 'execute') {
    const statusOutput = filterAllowedDirtyPathStatus(
      cwd,
      filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(cwd)),
      getExecuteAdmissionAllowedDirtyPaths(cwd, planDoc, options?.allowedDirtyPaths ?? []),
    );
    if (statusOutput) {
      const diagnostic = formatDirtyWorktreeDiagnostic({
        statusOutput,
        expectedScratchDirs: ['.neal/runs/<run-id>/scratch/'],
      });
      throw new Error(
        [
          `Cannot start neal execute with a dirty worktree:\n${statusOutput}`,
          diagnostic,
          'Use neal resume for in-progress scope work, or start from a clean worktree.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
  }

  return initializeOrchestration(planDoc, cwd, agentConfig, topLevelMode, options);
}

function getExecuteAdmissionAllowedDirtyPaths(cwd: string, planDoc: string, allowedDirtyPaths: string[]): string[] {
  const expandedPaths = [...allowedDirtyPaths];
  const absoluteCwd = resolve(cwd);
  const absolutePlanDoc = resolve(planDoc);
  const relativePlanDoc = relative(absoluteCwd, absolutePlanDoc);
  if (relativePlanDoc && (relativePlanDoc.startsWith('..') || isAbsolute(relativePlanDoc))) {
    const localPlanSurrogate = basename(absolutePlanDoc);
    if (localPlanSurrogate && !expandedPaths.includes(localPlanSurrogate)) {
      expandedPaths.push(localPlanSurrogate);
    }
  }
  return expandedPaths;
}
