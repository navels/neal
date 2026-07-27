import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from './atomic-write.js';
import { buildBlockedGuidance } from './blocked-guidance.js';
import {
  cleanUntrackedPaths as cleanGitUntrackedPaths,
  getWorktreeStatus as getGitWorktreeStatus,
  restoreWorktreePaths as restoreGitWorktreePaths,
} from './git.js';
import { createRunId } from './logger.js';
import { loadOrInitialize } from './orchestrator.js';
import { writeExecutionArtifacts } from './orchestrator/artifacts.js';
import { assertAgentConfigSupportsResume, assertAgentConfigSupportsWriterRun } from './providers/registry.js';
import { writeCurrentRunPointer } from './run-registry.js';
import { formatPublicRunStatus, getRunDisplayStatus } from './run-status.js';
import { getRunStatePath, hydrateResidualReviewDebtItem, loadState, saveState } from './state.js';
import {
  QUEUE_LINK_FILE,
  QUEUE_STATE_FILE,
  QUEUE_SUMMARY_FILE,
  getCurrentPlanAndExecuteQueuePointerPath as getStorageCurrentPlanAndExecuteQueuePointerPath,
  getQueuesDir,
} from './storage-paths.js';
import type { ResumeQueueEvidence } from './resume-decision.js';
import type { AgentConfig, OrchestrationState, ResidualReviewDebtItem } from './types.js';
import {
  executeRun,
  withPreparedWriterRun,
  type ExecuteRunResult,
} from './commands/runtime.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  parseWorktreeStatusLine,
} from './worktree-status.js';


export type PlanAndExecuteQueueStatus = 'running' | 'paused' | 'blocked' | 'failed' | 'completed';

export type PlanAndExecuteQueueItemStatus =
  | 'pending'
  | 'planning'
  | 'planned'
  | 'executing'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'completed';

export type QueueChildStage = 'planning' | 'execution';

export type PlanAndExecuteQueueItem = {
  index: number;
  requestedPlanPath: string;
  resolvedPlanPath: string;
  status: PlanAndExecuteQueueItemStatus;
  planningRunId: string | null;
  planningStatePath: string | null;
  acceptedPlanPath: string | null;
  // Plan-review debt accepted by the planning child, carried across the fresh
  // execution child (the only cross-run channel that reaches the execution
  // reviewer). Default []; populated by completePlanningStage.
  planReviewDebt: ResidualReviewDebtItem[];
  executionRunId: string | null;
  executionStatePath: string | null;
  activeStage: QueueChildStage | null;
  startedAt: string | null;
  completedAt: string | null;
  stopReason: string | null;
};

export type PlanAndExecuteQueueState = {
  version: 1;
  queueId: string;
  cwd: string;
  status: PlanAndExecuteQueueStatus;
  currentIndex: number;
  requestedPlans: string[];
  allowedDirtyPlanPaths: string[];
  items: PlanAndExecuteQueueItem[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  stopReason: string | null;
};

export type CurrentPlanAndExecuteQueuePointer = {
  version: 1;
  queueId: string;
  queueStatePath: string;
  status: PlanAndExecuteQueueStatus;
  currentIndex: number;
  activeStage: QueueChildStage | null;
  activeRunId: string | null;
  updatedAt: string;
};

export type QueueChildLink = {
  version: 1;
  queueId: string;
  queueStatePath: string;
  itemIndex: number;
  stage: QueueChildStage;
  createdAt: string;
};

export type CreatePlanAndExecuteQueueArgs = {
  cwd: string;
  planDocs: string[];
};

export type WriteQueueChildLinkArgs = {
  runDir: string;
  queueId: string;
  queueStatePath: string;
  itemIndex: number;
  stage: QueueChildStage;
  createdAt?: string;
};

export type RunPlanAndExecuteQueueArgs = {
  cwd: string;
  planDocs: string[];
  agentConfig: AgentConfig;
  squashOnCompletion?: boolean;
  unattended?: boolean;
  deps?: PlanAndExecuteQueueRunnerDeps;
};

export type ContinuePlanAndExecuteQueueArgs = {
  state: PlanAndExecuteQueueState;
  agentConfig: AgentConfig;
  squashOnCompletion?: boolean;
  unattended?: boolean;
  deps?: PlanAndExecuteQueueRunnerDeps;
};

export type ContinuePlanAndExecuteQueueFromChildRunArgs = {
  childResult: ExecuteRunResult;
  agentConfig: AgentConfig;
  squashOnCompletion?: boolean;
  unattended?: boolean;
  deps?: PlanAndExecuteQueueRunnerDeps;
};

export type RunFreshPlanAndExecuteChildArgs = {
  queueState: PlanAndExecuteQueueState;
  item: PlanAndExecuteQueueItem;
  stage: QueueChildStage;
  planDoc: string;
  agentConfig: AgentConfig;
  squashOnCompletion: boolean;
  unattended: boolean;
};

export type InitializedQueueChildRun = {
  runId: string;
  runDir: string;
  runStatePath: string;
  statePath: string;
  planDoc: string;
};

export type PlanAndExecuteQueueRunnerDeps = {
  getWorktreeStatus?: (cwd: string) => Promise<string>;
  restoreWorktreePaths?: (cwd: string, paths: string[]) => Promise<void>;
  cleanUntrackedPaths?: (cwd: string, paths: string[]) => Promise<void>;
  runFreshChild?: (
    args: RunFreshPlanAndExecuteChildArgs,
    onInitialized: (child: InitializedQueueChildRun) => Promise<void>,
  ) => Promise<ExecuteRunResult>;
};

const QUEUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const QUEUE_STATUSES = new Set<PlanAndExecuteQueueStatus>([
  'running',
  'paused',
  'blocked',
  'failed',
  'completed',
]);
const QUEUE_ITEM_STATUSES = new Set<PlanAndExecuteQueueItemStatus>([
  'pending',
  'planning',
  'planned',
  'executing',
  'blocked',
  'failed',
  'paused',
  'completed',
]);
const QUEUE_CHILD_STAGES = new Set<QueueChildStage>(['planning', 'execution']);

export function getPlanAndExecuteQueuesDir(cwd: string): string {
  return getQueuesDir(resolve(cwd));
}

export function getPlanAndExecuteQueueDir(cwd: string, queueId: string): string {
  assertValidQueueId(queueId);
  return join(getPlanAndExecuteQueuesDir(cwd), queueId);
}

export function getPlanAndExecuteQueueStatePath(cwd: string, queueId: string): string {
  return join(getPlanAndExecuteQueueDir(cwd, queueId), QUEUE_STATE_FILE);
}

export function getPlanAndExecuteQueueSummaryPath(cwd: string, queueId: string): string {
  return join(getPlanAndExecuteQueueDir(cwd, queueId), QUEUE_SUMMARY_FILE);
}

export function getCurrentPlanAndExecuteQueuePointerPath(cwd: string): string {
  return getStorageCurrentPlanAndExecuteQueuePointerPath(resolve(cwd));
}

export function getQueueChildLinkPath(runDir: string): string {
  return join(runDir, QUEUE_LINK_FILE);
}

export function toQueueStoredPath(cwd: string, path: string): string {
  const absoluteCwd = resolve(cwd);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(absoluteCwd, path);
  const relativePath = relative(absoluteCwd, absolutePath);

  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return normalize(relativePath);
  }

  return absolutePath;
}

export function resolveQueueStoredPath(cwd: string, storedPath: string): string {
  if (typeof storedPath !== 'string' || storedPath.length === 0) {
    throw new Error('Invalid queue path: expected a non-empty string');
  }

  if (isAbsolute(storedPath)) {
    const absolutePath = resolve(storedPath);
    if (storedPath !== absolutePath) {
      throw new Error(`Invalid queue path: absolute paths must be normalized (${storedPath})`);
    }
    return absolutePath;
  }

  const normalizedPath = normalize(storedPath);
  if (
    storedPath !== normalizedPath ||
    normalizedPath === '.' ||
    normalizedPath.startsWith('..') ||
    isAbsolute(normalizedPath)
  ) {
    throw new Error(`Invalid queue path: relative paths must stay within cwd (${storedPath})`);
  }

  const absoluteCwd = resolve(cwd);
  const absolutePath = resolve(absoluteCwd, normalizedPath);
  if (!isPathInside(absoluteCwd, absolutePath)) {
    throw new Error(`Invalid queue path: relative paths must stay within cwd (${storedPath})`);
  }

  return absolutePath;
}

export async function createPlanAndExecuteQueue(
  args: CreatePlanAndExecuteQueueArgs,
): Promise<PlanAndExecuteQueueState> {
  const cwd = resolve(args.cwd);
  if (args.planDocs.length === 0) {
    throw new Error('neal run requires at least one plan file path argument');
  }

  const now = new Date().toISOString();
  const queueId = createRunId();
  const items: PlanAndExecuteQueueItem[] = [];
  const requestedPlans: string[] = [];
  const allowedDirtyPlanPaths: string[] = [];

  for (const [index, planDoc] of args.planDocs.entries()) {
    const resolvedPlanPath = resolveQueueInputPath(cwd, planDoc);
    await requireExistingPlanFile(resolvedPlanPath);
    const requestedPlanPath = toQueueStoredPath(cwd, planDoc);
    const storedResolvedPlanPath = toQueueStoredPath(cwd, resolvedPlanPath);

    requestedPlans.push(requestedPlanPath);
    for (const allowedPath of getAllowedDirtyPlanPaths(cwd, resolvedPlanPath)) {
      if (!allowedDirtyPlanPaths.includes(allowedPath)) {
        allowedDirtyPlanPaths.push(allowedPath);
      }
    }
    items.push({
      index,
      requestedPlanPath,
      resolvedPlanPath: storedResolvedPlanPath,
      status: 'pending',
      planningRunId: null,
      planningStatePath: null,
      acceptedPlanPath: null,
      planReviewDebt: [],
      executionRunId: null,
      executionStatePath: null,
      activeStage: null,
      startedAt: null,
      completedAt: null,
      stopReason: null,
    });
  }

  return savePlanAndExecuteQueueState({
    version: 1,
    queueId,
    cwd,
    status: 'running',
    currentIndex: 0,
    requestedPlans,
    allowedDirtyPlanPaths,
    items,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    stopReason: null,
  });
}

export async function runPlanAndExecuteQueue(
  args: RunPlanAndExecuteQueueArgs,
): Promise<PlanAndExecuteQueueState> {
  assertAgentConfigSupportsWriterRun(args.agentConfig, { context: 'plan-and-execute queue' });

  const queue = await createPlanAndExecuteQueue({
    cwd: args.cwd,
    planDocs: args.planDocs,
  });

  return continuePlanAndExecuteQueue({
    state: queue,
    agentConfig: args.agentConfig,
    squashOnCompletion: args.squashOnCompletion ?? true,
    unattended: args.unattended ?? false,
    deps: args.deps,
  });
}

export async function continuePlanAndExecuteQueue(
  args: ContinuePlanAndExecuteQueueArgs,
): Promise<PlanAndExecuteQueueState> {
  assertAgentConfigSupportsWriterRun(args.agentConfig, { context: 'plan-and-execute queue continuation' });

  const deps = resolveQueueRunnerDeps(args.deps);
  let state = args.state;

  while (state.status === 'running' && state.currentIndex < state.items.length) {
    const item = state.items[state.currentIndex];
    if (!item) {
      break;
    }

    if (item.status === 'pending') {
      state = await runQueueChildStage(
        state,
        item.index,
        'planning',
        args.agentConfig,
        args.squashOnCompletion ?? true,
        args.unattended ?? false,
        deps,
      );
      if (state.status !== 'running') {
        return state;
      }
    }

    const plannedItem = state.items[state.currentIndex];
    if (!plannedItem) {
      break;
    }

    if (plannedItem.status === 'planned') {
      state = await runQueueChildStage(
        state,
        plannedItem.index,
        'execution',
        args.agentConfig,
        args.squashOnCompletion ?? true,
        args.unattended ?? false,
        deps,
      );
      if (state.status !== 'running') {
        return state;
      }
    }

    const completedItem = state.items[state.currentIndex];
    if (!completedItem || completedItem.status !== 'completed') {
      return state;
    }

    state = await advanceQueuePastCompletedItem(state, completedItem.index);
  }

  if (state.status === 'running' && state.currentIndex >= state.items.length) {
    const now = new Date().toISOString();
    state = await savePlanAndExecuteQueueState({
      ...state,
      status: 'completed',
      completedAt: now,
      stopReason: null,
    });
  }

  return state;
}

export async function continuePlanAndExecuteQueueFromChildRun(
  args: ContinuePlanAndExecuteQueueFromChildRunArgs,
): Promise<PlanAndExecuteQueueState | null> {
  assertAgentConfigSupportsResume(args.agentConfig, args.childResult.finalState, {
    context: 'plan-and-execute queue continuation from child run',
  });

  const link = await readQueueChildLink(args.childResult.finalState.runDir);
  if (!link) {
    return null;
  }

  const loadedState = await loadPlanAndExecuteQueueState(link.queueStatePath, args.childResult.finalState.cwd);
  const state = validateLinkedQueueChild(loadedState, link, args.childResult.finalState.runDir);
  if (state === null) {
    return loadedState;
  }
  const deps = resolveQueueRunnerDeps(args.deps);

  const classification = classifyChildResult(link.stage, args.childResult);
  if (classification.kind === 'stopped') {
    await persistQueueStoppedChildState(args.childResult, classification);
    return stopQueueAtItem(
      state,
      link.itemIndex,
      classification.queueStatus,
      classification.itemStatus,
      classification.stopReason,
    );
  }

  const advancedState =
    link.stage === 'planning'
      ? await completePlanningStage(state, link.itemIndex, args.childResult.finalState, deps)
      : await completeExecutionStage(state, link.itemIndex);

  return continuePlanAndExecuteQueue({
    state: advancedState,
    agentConfig: args.agentConfig,
    // Carry the squash preference forward across the cross-process
    // queue-resume handoff the same way unattended is below: the resumed
    // child's persisted run state wins when the caller supplies nothing.
    squashOnCompletion: args.squashOnCompletion ?? args.childResult.finalState.autoSquashOnCompletion,
    // Carry unattended forward across the cross-process queue-resume handoff.
    // The resumed child's persisted finalState is the authoritative source (it
    // was initialized with the value the original `neal run` resolved), so
    // subsequent queue children do not silently revert to attended mode. An
    // explicit caller-supplied value still wins.
    unattended: args.unattended ?? args.childResult.finalState.unattended,
    deps: args.deps,
  });
}

export async function loadPlanAndExecuteQueueState(queueStatePath: string, cwd = process.cwd()): Promise<PlanAndExecuteQueueState> {
  const absoluteQueueStatePath = resolveQueueStoredPath(cwd, queueStatePath);
  const content = await readFile(absoluteQueueStatePath, 'utf8');
  const parsed = JSON.parse(content);
  const state = parsePlanAndExecuteQueueState(parsed);
  const expectedStatePath = getPlanAndExecuteQueueStatePath(state.cwd, state.queueId);

  if (!samePath(absoluteQueueStatePath, expectedStatePath)) {
    throw new Error(
      `Invalid queue state: path ${absoluteQueueStatePath} does not match queue ${state.queueId} at ${expectedStatePath}`,
    );
  }

  return state;
}

export async function savePlanAndExecuteQueueState(
  state: PlanAndExecuteQueueState,
): Promise<PlanAndExecuteQueueState> {
  const nextState = parsePlanAndExecuteQueueState({
    ...state,
    requestedPlans: [...state.requestedPlans],
    allowedDirtyPlanPaths: [...state.allowedDirtyPlanPaths],
    items: state.items.map((item) => ({ ...item })),
    updatedAt: new Date().toISOString(),
  });
  const statePath = getPlanAndExecuteQueueStatePath(nextState.cwd, nextState.queueId);

  await writeJsonAtomic(statePath, nextState);
  await writeCurrentPlanAndExecuteQueuePointer(nextState);
  await writeQueueSummary(nextState);

  return nextState;
}

export async function readCurrentPlanAndExecuteQueuePointer(
  cwd: string,
): Promise<CurrentPlanAndExecuteQueuePointer | null> {
  const pointerPath = getCurrentPlanAndExecuteQueuePointerPath(cwd);
  let content: string;
  try {
    content = await readFile(pointerPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return parseCurrentPlanAndExecuteQueuePointer(JSON.parse(content), resolve(cwd));
}

export async function writeQueueChildLink(args: WriteQueueChildLinkArgs): Promise<QueueChildLink> {
  const link = parseQueueChildLink({
    version: 1,
    queueId: args.queueId,
    queueStatePath: args.queueStatePath,
    itemIndex: args.itemIndex,
    stage: args.stage,
    createdAt: args.createdAt ?? new Date().toISOString(),
  });
  const linkPath = getQueueChildLinkPath(args.runDir);

  await writeJsonAtomic(linkPath, link);

  return link;
}

export async function readQueueChildLink(runDir: string): Promise<QueueChildLink | null> {
  const linkPath = getQueueChildLinkPath(runDir);
  let content: string;
  try {
    content = await readFile(linkPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return parseQueueChildLink(JSON.parse(content));
}

export async function inspectQueueChildResumeEvidence(args: {
  cwd: string;
  runDir: string;
}): Promise<ResumeQueueEvidence> {
  let link: QueueChildLink | null;
  try {
    link = await readQueueChildLink(args.runDir);
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `Queue child link could not be read: ${formatQueueEvidenceError(error)}`,
    };
  }

  if (!link) {
    return { kind: 'not_linked' };
  }

  let state: PlanAndExecuteQueueState;
  try {
    state = await loadPlanAndExecuteQueueState(link.queueStatePath, args.cwd);
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `Queue state for linked child could not be read: ${formatQueueEvidenceError(error)}`,
      queueId: link.queueId,
      itemIndex: link.itemIndex,
      stage: link.stage,
    };
  }

  const classification = classifyLinkedQueueChild(state, link, args.runDir);
  if (classification.kind === 'active') {
    return {
      kind: 'active_child',
      queueId: state.queueId,
      itemIndex: link.itemIndex,
      stage: link.stage,
      queueStatus: state.status,
      itemStatus: classification.item.status,
    };
  }

  return {
    kind: classification.kind,
    reason: classification.reason,
    queueId: link.queueId,
    itemIndex: link.itemIndex,
    stage: link.stage,
  };
}

type ResolvedPlanAndExecuteQueueRunnerDeps = Required<PlanAndExecuteQueueRunnerDeps>;

type StoppedQueueStatus = Extract<PlanAndExecuteQueueStatus, 'paused' | 'blocked' | 'failed'>;
type StoppedQueueItemStatus = Extract<PlanAndExecuteQueueItemStatus, 'paused' | 'blocked' | 'failed'>;

type StoppedChildResult = {
  kind: 'stopped';
  queueStatus: StoppedQueueStatus;
  itemStatus: StoppedQueueItemStatus;
  stopReason: string;
};

type ChildResultClassification =
  | { kind: 'succeeded' }
  | StoppedChildResult;

type LinkedQueueChildClassification =
  | { kind: 'active'; item: PlanAndExecuteQueueItem }
  | {
      kind: 'consumed_child' | 'stale_child' | 'mismatched_child' | 'mismatched_stage';
      reason: string;
    };

function resolveQueueRunnerDeps(deps: PlanAndExecuteQueueRunnerDeps | undefined): ResolvedPlanAndExecuteQueueRunnerDeps {
  return {
    cleanUntrackedPaths: deps?.cleanUntrackedPaths ?? cleanGitUntrackedPaths,
    getWorktreeStatus: deps?.getWorktreeStatus ?? getGitWorktreeStatus,
    restoreWorktreePaths: deps?.restoreWorktreePaths ?? restoreGitWorktreePaths,
    runFreshChild: deps?.runFreshChild ?? runFreshPlanAndExecuteChild,
  };
}

async function runQueueChildStage(
  state: PlanAndExecuteQueueState,
  itemIndex: number,
  stage: QueueChildStage,
  agentConfig: AgentConfig,
  squashOnCompletion: boolean,
  unattended: boolean,
  deps: ResolvedPlanAndExecuteQueueRunnerDeps,
): Promise<PlanAndExecuteQueueState> {
  try {
    await assertQueueWorktreeReady(state, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stopQueueAtItem(state, itemIndex, 'failed', 'failed', message);
    throw error;
  }

  const item = getQueueItemOrThrow(state, itemIndex);
  const planDoc = getQueueStagePlanDoc(state, item, stage);
  let activeState = state;
  let initialized = false;
  let result: ExecuteRunResult;

  try {
    result = await deps.runFreshChild(
      {
        queueState: state,
        item,
        stage,
        planDoc,
        agentConfig,
        squashOnCompletion,
        unattended,
      },
      async (child) => {
        initialized = true;
        activeState = await recordQueueChildInitialized(activeState, itemIndex, stage, child);
      },
    );
    if (!initialized) {
      throw new Error(`Queue ${stage} child did not report initialization`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stopQueueAtItem(activeState, itemIndex, 'failed', 'failed', `${stage} child failed before completion: ${message}`);
    throw error;
  }

  const classification = classifyChildResult(stage, result);
  if (classification.kind === 'stopped') {
    await persistQueueStoppedChildState(result, classification);
    return stopQueueAtItem(
      activeState,
      itemIndex,
      classification.queueStatus,
      classification.itemStatus,
      classification.stopReason,
    );
  }

  if (stage === 'planning') {
    return completePlanningStage(activeState, itemIndex, result.finalState, deps);
  }

  return completeExecutionStage(activeState, itemIndex);
}

function validateLinkedQueueChild(
  state: PlanAndExecuteQueueState,
  link: QueueChildLink,
  childRunDir: string,
): PlanAndExecuteQueueState | null {
  const classification = classifyLinkedQueueChild(state, link, childRunDir);
  if (classification.kind === 'consumed_child') {
    return null;
  }
  if (classification.kind !== 'active') {
    throw new Error(classification.reason);
  }

  const item = classification.item;
  return {
    ...state,
    status: 'running',
    stopReason: null,
    items: replaceQueueItem(state.items, link.itemIndex, {
      ...item,
      status: link.stage === 'planning' ? 'planning' : 'executing',
      stopReason: null,
    }),
  };
}

function classifyLinkedQueueChild(
  state: PlanAndExecuteQueueState,
  link: QueueChildLink,
  childRunDir: string,
): LinkedQueueChildClassification {
  if (state.queueId !== link.queueId) {
    return {
      kind: 'mismatched_child',
      reason: `Invalid queue child link: queue ${link.queueId} does not match state ${state.queueId}`,
    };
  }

  const item = state.items[link.itemIndex];
  if (!item) {
    return {
      kind: 'stale_child',
      reason: `Invalid queue child link: missing queue item ${link.itemIndex}`,
    };
  }

  const childRunId = basename(childRunDir);
  const expectedRunId = getQueueItemRunIdForStage(item, link.stage);
  if (expectedRunId !== childRunId) {
    return {
      kind: 'mismatched_child',
      reason: `Invalid queue child link: ${link.stage} run ${childRunId} does not match queue item ${link.itemIndex}`,
    };
  }

  if (isLinkedChildAlreadyConsumed(state, item, link.stage)) {
    return {
      kind: 'consumed_child',
      reason: `Queue ${link.stage} child ${childRunId} for item ${link.itemIndex + 1} has already been consumed: the queue recorded this run's outcome and moved on, so the run can no longer be resumed through its queue.`,
    };
  }

  if (state.currentIndex !== link.itemIndex) {
    return {
      kind: 'stale_child',
      reason: `Invalid queue child link: queue currentIndex ${state.currentIndex} does not match item ${link.itemIndex}`,
    };
  }

  if (item.activeStage !== link.stage) {
    return {
      kind: 'mismatched_stage',
      reason: `Invalid queue child link: queue item ${link.itemIndex} active stage ${String(item.activeStage)} does not match ${link.stage}`,
    };
  }

  return { kind: 'active', item };
}

function getQueueItemRunIdForStage(item: PlanAndExecuteQueueItem, stage: QueueChildStage): string | null {
  return stage === 'planning' ? item.planningRunId : item.executionRunId;
}

function isLinkedChildAlreadyConsumed(
  state: PlanAndExecuteQueueState,
  item: PlanAndExecuteQueueItem,
  stage: QueueChildStage,
): boolean {
  if (item.index < state.currentIndex) {
    return true;
  }

  if (stage === 'planning') {
    return (
      item.status === 'planned' ||
      item.status === 'executing' ||
      item.status === 'completed' ||
      item.acceptedPlanPath !== null ||
      item.executionRunId !== null
    );
  }

  return item.status === 'completed';
}

async function runFreshPlanAndExecuteChild(
  args: RunFreshPlanAndExecuteChildArgs,
  onInitialized: (child: InitializedQueueChildRun) => Promise<void>,
): Promise<ExecuteRunResult> {
  const cwd = args.queueState.cwd;
  const topLevelMode = getTopLevelModeForStage(args.stage);
  assertAgentConfigSupportsWriterRun(args.agentConfig, { context: `${args.stage} queue child` });

  return withPreparedWriterRun(
    {
      cwd,
      topLevelMode,
      getLockPlanDoc: () => args.planDoc,
    },
    async (prepared, markInitialized) => {
      const planDoc = resolveQueueInputPath(cwd, args.planDoc);
      await requireExistingPlanFile(planDoc);
      const loaded = await loadOrInitialize(
        planDoc,
        cwd,
        args.agentConfig,
        undefined,
        topLevelMode,
        {
          allowedDirtyPaths: args.stage === 'execution' ? [planDoc] : [],
          runDir: prepared.runDir,
          unattended: args.unattended,
          // Seed the queue's resolved squash preference onto the child run
          // state (unstaged: planning children persist it too so a resumed
          // planning child carries it back into queue continuation). Once
          // initialized, the run state is the single source of truth for
          // this run — `neal resume` reads it back from there.
          autoSquashOnCompletion: args.squashOnCompletion,
          // Only the execution child inherits the accepted plan's plan-review
          // debt (into the durable inheritedPlanReviewDebt state field). The
          // planning child recomputes its own planReviewDebt from scratch.
          inheritedPlanReviewDebt: args.stage === 'execution' ? args.item.planReviewDebt : undefined,
        },
      );
      markInitialized();
      assertAgentConfigSupportsWriterRun(loaded.state.agentConfig, { context: `${args.stage} queue child` });
      await onInitialized({
        runId: basename(loaded.state.runDir),
        runDir: loaded.state.runDir,
        runStatePath: getRunStatePath(loaded.state.runDir),
        statePath: loaded.statePath,
        planDoc: loaded.state.planDoc,
      });
      return executeRun(loaded.state, loaded.statePath, loaded.logger, {
        autoSquashOnCompletion: args.stage === 'execution' && args.squashOnCompletion,
        unattended: args.unattended,
      });
    },
  );
}

function getTopLevelModeForStage(stage: QueueChildStage): 'plan' | 'execute' {
  return stage === 'planning' ? 'plan' : 'execute';
}

function getQueueStagePlanDoc(
  state: PlanAndExecuteQueueState,
  item: PlanAndExecuteQueueItem,
  stage: QueueChildStage,
): string {
  if (stage === 'planning') {
    return resolveQueueStoredPath(state.cwd, item.resolvedPlanPath);
  }

  if (!item.acceptedPlanPath) {
    throw new Error(`Cannot start queue item ${item.index} execution before planning has accepted a plan`);
  }
  return resolveQueueStoredPath(state.cwd, item.acceptedPlanPath);
}

function buildInitializedQueueItem(
  cwd: string,
  item: PlanAndExecuteQueueItem,
  stage: QueueChildStage,
  child: InitializedQueueChildRun,
): PlanAndExecuteQueueItem {
  const childStatePath = toQueueStoredPath(cwd, child.runStatePath);
  const baseItem = {
    ...item,
    activeStage: stage,
    startedAt: item.startedAt ?? new Date().toISOString(),
    stopReason: null,
  };

  if (stage === 'planning') {
    return {
      ...baseItem,
      status: 'planning',
      planningRunId: child.runId,
      planningStatePath: childStatePath,
    };
  }

  return {
    ...baseItem,
    status: 'executing',
    executionRunId: child.runId,
    executionStatePath: childStatePath,
  };
}

async function recordQueueChildInitialized(
  state: PlanAndExecuteQueueState,
  itemIndex: number,
  stage: QueueChildStage,
  child: InitializedQueueChildRun,
): Promise<PlanAndExecuteQueueState> {
  const item = getQueueItemOrThrow(state, itemIndex);
  const nextItem = buildInitializedQueueItem(state.cwd, item, stage, child);
  const nextState = await savePlanAndExecuteQueueState({
    ...state,
    status: 'running',
    currentIndex: itemIndex,
    items: replaceQueueItem(state.items, itemIndex, nextItem),
    stopReason: null,
  });

  await writeQueueChildLink({
    runDir: child.runDir,
    queueId: nextState.queueId,
    queueStatePath: toQueueStoredPath(nextState.cwd, getPlanAndExecuteQueueStatePath(nextState.cwd, nextState.queueId)),
    itemIndex,
    stage,
  });
  await writeCurrentRunPointer(await loadState(child.runStatePath));

  return nextState;
}

async function completePlanningStage(
  state: PlanAndExecuteQueueState,
  itemIndex: number,
  finalState: OrchestrationState,
  deps: Pick<ResolvedPlanAndExecuteQueueRunnerDeps, 'getWorktreeStatus' | 'restoreWorktreePaths' | 'cleanUntrackedPaths'>,
): Promise<PlanAndExecuteQueueState> {
  const item = getQueueItemOrThrow(state, itemIndex);

  const acceptedPlanPath = toQueueStoredPath(state.cwd, finalState.planDoc);
  const allowedDirtyPlanPaths = withAllowedDirtyPlanPaths(
    state.allowedDirtyPlanPaths,
    getAllowedDirtyPlanPaths(state.cwd, finalState.planDoc),
  );
  await restoreQueuePlanningSideEffects({ ...state, allowedDirtyPlanPaths }, deps);
  return savePlanAndExecuteQueueState({
    ...state,
    status: 'running',
    allowedDirtyPlanPaths,
    stopReason: null,
    items: replaceQueueItem(state.items, itemIndex, {
      ...item,
      status: 'planned',
      acceptedPlanPath,
      // Carry the accepted plan's current-negotiation debt onto the queue item
      // so the fresh execution child inherits it (both the in-process completion
      // and the cross-process continuePlanAndExecuteQueueFromChildRun resume
      // route through here).
      planReviewDebt: finalState.planReviewDebt,
      activeStage: null,
      stopReason: null,
    }),
  });
}

function getAllowedDirtyPlanPaths(cwd: string, planPath: string): string[] {
  const storedPath = toQueueStoredPath(cwd, planPath);
  if (!isAbsolute(storedPath)) {
    return [storedPath];
  }

  const localPlanSurrogate = basename(storedPath);
  return localPlanSurrogate ? [storedPath, localPlanSurrogate] : [storedPath];
}

function withAllowedDirtyPlanPaths(paths: string[], planPaths: string[]): string[] {
  const nextPaths = [...paths];
  for (const planPath of planPaths) {
    if (!nextPaths.includes(planPath)) {
      nextPaths.push(planPath);
    }
  }
  return nextPaths;
}

async function completeExecutionStage(
  state: PlanAndExecuteQueueState,
  itemIndex: number,
): Promise<PlanAndExecuteQueueState> {
  const item = getQueueItemOrThrow(state, itemIndex);

  return savePlanAndExecuteQueueState({
    ...state,
    status: 'running',
    stopReason: null,
    items: replaceQueueItem(state.items, itemIndex, {
      ...item,
      status: 'completed',
      activeStage: null,
      completedAt: new Date().toISOString(),
      stopReason: null,
    }),
  });
}

async function advanceQueuePastCompletedItem(
  state: PlanAndExecuteQueueState,
  itemIndex: number,
): Promise<PlanAndExecuteQueueState> {
  const nextIndex = itemIndex + 1;
  return savePlanAndExecuteQueueState({
    ...state,
    currentIndex: nextIndex,
  });
}

async function stopQueueAtItem(
  state: PlanAndExecuteQueueState,
  itemIndex: number,
  queueStatus: StoppedQueueStatus,
  itemStatus: StoppedQueueItemStatus,
  stopReason: string,
): Promise<PlanAndExecuteQueueState> {
  const item = getQueueItemOrThrow(state, itemIndex);

  return savePlanAndExecuteQueueState({
    ...state,
    status: queueStatus,
    currentIndex: itemIndex,
    stopReason,
    items: replaceQueueItem(state.items, itemIndex, {
      ...item,
      status: itemStatus,
      stopReason,
    }),
  });
}

function classifyChildResult(stage: QueueChildStage, result: ExecuteRunResult): ChildResultClassification {
  if (result.finalState.status === 'done') {
    return { kind: 'succeeded' };
  }

  if (result.waitingForOperatorGuidance) {
    return classifyStoppedChild(stage, 'blocked', 'blocked', formatOperatorGuidanceChildStop(result));
  }

  if (isManualGateWait(result)) {
    return classifyStoppedChild(
      stage,
      'paused',
      'paused',
      `is waiting for manual gate ${result.finalState.manualGate.id}`,
    );
  }

  if (result.finalState.status === 'blocked') {
    return classifyStoppedChild(stage, 'blocked', 'blocked', 'blocked');
  }

  if (result.finalState.status === 'failed') {
    return classifyStoppedChild(stage, 'failed', 'failed', 'failed');
  }

  if (result.stopRequestedAfterScope) {
    return classifyStoppedChild(stage, 'paused', 'paused', 'paused after stop request');
  }

  if (result.finalState.status === 'paused') {
    return classifyStoppedChild(stage, 'paused', 'paused', 'paused');
  }

  return classifyStoppedChild(
    stage,
    'paused',
    'paused',
    `returned still-running state: status ${result.finalState.status}, phase ${result.finalState.phase}`,
  );
}

function formatOperatorGuidanceChildStop(result: ExecuteRunResult): string {
  const state = result.finalState;
  const runId = basename(state.runDir);
  const childStatePath = toQueueStoredPath(state.cwd, getRunStatePath(state.runDir));
  const displayStatus = getRunDisplayStatus(state);
  const publicStatus = displayStatus.waitingForOperatorGuidance
    ? formatPublicRunStatus(displayStatus)
    : 'waiting_for_guidance';
  const guidance = buildBlockedGuidance({
    state,
    runId,
    waitingForOperatorGuidance: true,
  });
  const summary = guidance?.summary ?? 'Neal is waiting for operator guidance before this child can continue.';
  const nextAction = guidance?.options[0]?.command ?? `neal status --run ${runId}`;

  return (
    `${runId} (${childStatePath}) is waiting for operator guidance (public status: ${publicStatus}). ` +
    `${summary} Next: ${nextAction}`
  );
}

function classifyStoppedChild(
  stage: QueueChildStage,
  queueStatus: StoppedQueueStatus,
  itemStatus: StoppedQueueItemStatus,
  reason: string,
): StoppedChildResult {
  return {
    kind: 'stopped',
    queueStatus,
    itemStatus,
    stopReason: `${stage} child ${reason}`,
  };
}

async function persistQueueStoppedChildState(
  result: ExecuteRunResult,
  classification: StoppedChildResult,
): Promise<void> {
  if (classification.itemStatus !== 'paused' || result.finalState.status !== 'running') {
    return;
  }

  if (isManualGateWait(result)) {
    return;
  }

  const pausedState = await saveState(getRunStatePath(result.finalState.runDir), {
    ...result.finalState,
    status: 'paused',
  });
  await writeExecutionArtifacts(pausedState);
  result.finalState = pausedState;
}

function isManualGateWait(result: ExecuteRunResult): result is ExecuteRunResult & {
  finalState: OrchestrationState & {
    phase: 'manual_gate';
    manualGate: NonNullable<OrchestrationState['manualGate']>;
  };
} {
  return (
    result.waitingForManualGate === true ||
    (result.finalState.phase === 'manual_gate' && result.finalState.manualGate !== null)
  );
}

async function assertQueueWorktreeReady(
  state: PlanAndExecuteQueueState,
  deps: Pick<ResolvedPlanAndExecuteQueueRunnerDeps, 'getWorktreeStatus'>,
): Promise<void> {
  const statusOutput = filterWrapperOwnedWorktreeStatus(await deps.getWorktreeStatus(state.cwd));
  const disallowedStatusOutput = filterAllowedDirtyPlanStatus(state, statusOutput);
  if (disallowedStatusOutput) {
    throw new Error(
      [
        'Cannot continue neal run with a dirty worktree:',
        disallowedStatusOutput,
        '',
        'Only queued plan files may be dirty between queue stages. Commit, stash, or discard unrelated changes before continuing the queue.',
      ].join('\n'),
    );
  }
}

async function restoreQueuePlanningSideEffects(
  state: PlanAndExecuteQueueState,
  deps: Pick<ResolvedPlanAndExecuteQueueRunnerDeps, 'getWorktreeStatus' | 'restoreWorktreePaths' | 'cleanUntrackedPaths'>,
): Promise<void> {
  const statusOutput = filterWrapperOwnedWorktreeStatus(await deps.getWorktreeStatus(state.cwd));
  const disallowedStatusOutput = filterAllowedDirtyPlanStatus(state, statusOutput);
  if (!disallowedStatusOutput) {
    return;
  }

  const { trackedPaths, untrackedPaths } = splitQueueSideEffectPaths(disallowedStatusOutput);
  await deps.restoreWorktreePaths(state.cwd, trackedPaths);
  await deps.cleanUntrackedPaths(state.cwd, untrackedPaths);

  const remainingStatusOutput = filterAllowedDirtyPlanStatus(
    state,
    filterWrapperOwnedWorktreeStatus(await deps.getWorktreeStatus(state.cwd)),
  );
  if (remainingStatusOutput) {
    throw new Error(
      [
        'Cannot continue neal run after cleaning plan-stage side effects:',
        remainingStatusOutput,
        '',
        'Only queued plan files may be dirty between queue stages. Commit, stash, or discard unrelated changes before continuing the queue.',
      ].join('\n'),
    );
  }
}

function splitQueueSideEffectPaths(statusOutput: string): { trackedPaths: string[]; untrackedPaths: string[] } {
  const trackedPaths = new Set<string>();
  const untrackedPaths = new Set<string>();

  for (const line of statusOutput.split('\n').map((entry) => entry.trimEnd()).filter(Boolean)) {
    const entry = parseWorktreeStatusLine(line);
    if (!entry) {
      continue;
    }
    const target = line.startsWith('??') ? untrackedPaths : trackedPaths;
    for (const path of entry.paths) {
      target.add(path);
    }
  }

  return {
    trackedPaths: [...trackedPaths],
    untrackedPaths: [...untrackedPaths],
  };
}

function filterAllowedDirtyPlanStatus(state: PlanAndExecuteQueueState, statusOutput: string): string {
  return filterAllowedDirtyPathStatus(state.cwd, statusOutput, state.allowedDirtyPlanPaths);
}

function getQueueItemOrThrow(state: PlanAndExecuteQueueState, itemIndex: number): PlanAndExecuteQueueItem {
  const item = state.items[itemIndex];
  if (!item) {
    throw new Error(`Invalid queue state: missing item ${itemIndex}`);
  }
  return item;
}

function replaceQueueItem(
  items: PlanAndExecuteQueueItem[],
  itemIndex: number,
  item: PlanAndExecuteQueueItem,
): PlanAndExecuteQueueItem[] {
  return items.map((existing, index) => (index === itemIndex ? item : existing));
}

async function writeCurrentPlanAndExecuteQueuePointer(state: PlanAndExecuteQueueState): Promise<void> {
  const pointerPath = getCurrentPlanAndExecuteQueuePointerPath(state.cwd);
  const pointer = parseCurrentPlanAndExecuteQueuePointer(
    {
      version: 1,
      queueId: state.queueId,
      queueStatePath: toQueueStoredPath(state.cwd, getPlanAndExecuteQueueStatePath(state.cwd, state.queueId)),
      status: state.status,
      currentIndex: state.currentIndex,
      activeStage: getActiveQueueStage(state),
      activeRunId: getActiveQueueRunId(state),
      updatedAt: state.updatedAt,
    },
    state.cwd,
  );

  await writeJsonAtomic(pointerPath, pointer);
}

async function writeQueueSummary(state: PlanAndExecuteQueueState): Promise<void> {
  const summaryPath = getPlanAndExecuteQueueSummaryPath(state.cwd, state.queueId);
  await writeTextAtomic(summaryPath, formatQueueSummary(state));
}

function formatQueueSummary(state: PlanAndExecuteQueueState): string {
  const lines: string[] = [
    '# Neal Plan-And-Execute Queue Summary',
    '',
    `- Queue: ${state.queueId}`,
    `- Status: ${state.status}`,
    `- Cwd: ${state.cwd}`,
    `- Current item: ${formatCurrentQueueItem(state)}`,
    `- Created: ${state.createdAt}`,
    `- Updated: ${state.updatedAt}`,
    `- Completed: ${state.completedAt ?? 'not completed'}`,
    `- Terminal outcome: ${formatQueueTerminalOutcome(state)}`,
    `- Stop reason: ${state.stopReason ?? 'none'}`,
    '',
    '## Items',
    '',
  ];

  for (const item of state.items) {
    lines.push(
      `### Item ${item.index + 1}: ${item.requestedPlanPath}`,
      '',
      `- Status: ${item.status}`,
      `- Active stage: ${item.activeStage ?? 'none'}`,
      `- Planning run: ${formatRunReference(item.planningRunId, item.planningStatePath)}`,
      `- Accepted plan: ${item.acceptedPlanPath ?? 'none'}`,
      `- Execution run: ${formatRunReference(item.executionRunId, item.executionStatePath)}`,
      `- Started: ${item.startedAt ?? 'not started'}`,
      `- Completed: ${item.completedAt ?? 'not completed'}`,
      `- Terminal outcome: ${formatItemTerminalOutcome(item)}`,
      `- Stop reason: ${item.stopReason ?? 'none'}`,
      '',
    );
  }

  return lines.join('\n');
}

function formatCurrentQueueItem(state: PlanAndExecuteQueueState): string {
  if (state.currentIndex >= state.items.length) {
    return `${state.items.length} of ${state.items.length}`;
  }

  return `${state.currentIndex + 1} of ${state.items.length}`;
}

function formatQueueTerminalOutcome(state: PlanAndExecuteQueueState): string {
  return state.status === 'running' ? 'not terminal' : state.status;
}

function formatItemTerminalOutcome(item: PlanAndExecuteQueueItem): string {
  switch (item.status) {
    case 'completed':
    case 'blocked':
    case 'failed':
    case 'paused':
      return item.status;
    default:
      return 'not terminal';
  }
}

function formatRunReference(runId: string | null, statePath: string | null): string {
  if (!runId) {
    return 'none';
  }

  return statePath ? `${runId} (${statePath})` : runId;
}

async function requireExistingPlanFile(planPath: string): Promise<void> {
  let planStat;
  try {
    planStat = await stat(planPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`Plan file does not exist: ${planPath}`);
    }
    throw error;
  }

  if (!planStat.isFile()) {
    throw new Error(`Plan path is not a file: ${planPath}`);
  }
}

function parsePlanAndExecuteQueueState(value: unknown): PlanAndExecuteQueueState {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid queue state: expected object');
  }

  const state = value as Partial<PlanAndExecuteQueueState>;
  if (state.version !== 1) {
    throw new Error(`Invalid queue state version: ${String(state.version)}`);
  }
  const queueId = requireQueueId(state.queueId, 'Invalid queue state: malformed queueId');
  const cwd = requireAbsolutePath(state.cwd, 'Invalid queue state: cwd must be an absolute path');
  const status = requireQueueStatus(state.status, 'Invalid queue state: malformed queue status');
  const currentIndex = requireNonNegativeInteger(state.currentIndex, 'Invalid queue state: malformed currentIndex');

  const requestedPlans = requireStringArray(state.requestedPlans, 'Invalid queue state: malformed requestedPlans');
  if (requestedPlans.length === 0) {
    throw new Error('Invalid queue state: requestedPlans must not be empty');
  }
  const allowedDirtyPlanPaths = requireStringArray(
    state.allowedDirtyPlanPaths,
    'Invalid queue state: malformed allowedDirtyPlanPaths',
  );
  validateStoredPaths(cwd, requestedPlans, 'requestedPlans');
  validateStoredPaths(cwd, allowedDirtyPlanPaths, 'allowedDirtyPlanPaths');

  if (!Array.isArray(state.items) || state.items.length !== requestedPlans.length) {
    throw new Error('Invalid queue state: items must match requestedPlans');
  }
  const items = state.items.map((item, index) => parsePlanAndExecuteQueueItem(item, index, cwd));
  validateQueuePathInvariants(requestedPlans, allowedDirtyPlanPaths, items);
  if (currentIndex > items.length) {
    throw new Error('Invalid queue state: currentIndex is out of range');
  }

  return {
    version: 1,
    queueId,
    cwd,
    status,
    currentIndex,
    requestedPlans,
    allowedDirtyPlanPaths,
    items,
    createdAt: requireString(state.createdAt, 'Invalid queue state: malformed createdAt'),
    updatedAt: requireString(state.updatedAt, 'Invalid queue state: malformed updatedAt'),
    completedAt: requireNullableString(state.completedAt, 'Invalid queue state: malformed completedAt'),
    stopReason: requireNullableString(state.stopReason, 'Invalid queue state: malformed stopReason'),
  };
}

function parsePlanAndExecuteQueueItem(value: unknown, expectedIndex: number, cwd: string): PlanAndExecuteQueueItem {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid queue state: malformed queue item');
  }

  const item = value as Partial<PlanAndExecuteQueueItem>;
  const index = requireNonNegativeInteger(item.index, 'Invalid queue state: malformed queue item index');
  if (index !== expectedIndex) {
    throw new Error('Invalid queue state: non-contiguous item indices');
  }
  const requestedPlanPath = requireString(item.requestedPlanPath, 'Invalid queue state: malformed requestedPlanPath');
  const resolvedPlanPath = requireString(item.resolvedPlanPath, 'Invalid queue state: malformed resolvedPlanPath');
  const acceptedPlanPath = requireNullableString(item.acceptedPlanPath, 'Invalid queue state: malformed acceptedPlanPath');
  const planningStatePath = requireNullableString(item.planningStatePath, 'Invalid queue state: malformed planningStatePath');
  const executionStatePath = requireNullableString(item.executionStatePath, 'Invalid queue state: malformed executionStatePath');

  validateStoredPaths(cwd, [requestedPlanPath, resolvedPlanPath], 'queue item paths');
  validateStoredPaths(cwd, nullableStringsToArray([acceptedPlanPath, planningStatePath, executionStatePath]), 'queue item paths');

  return {
    index,
    requestedPlanPath,
    resolvedPlanPath,
    status: requireQueueItemStatus(item.status, 'Invalid queue state: malformed queue item status'),
    planningRunId: requireNullableString(item.planningRunId, 'Invalid queue state: malformed planningRunId'),
    planningStatePath,
    acceptedPlanPath,
    // Legacy-tolerant: queue items persisted before this field existed default
    // to an empty debt array. Present arrays are hydrated with the shared
    // residual-debt validator so an older/newer field shape is caught.
    planReviewDebt: parseQueueItemPlanReviewDebt(item.planReviewDebt),
    executionRunId: requireNullableString(item.executionRunId, 'Invalid queue state: malformed executionRunId'),
    executionStatePath,
    activeStage: requireNullableQueueChildStage(item.activeStage, 'Invalid queue state: malformed activeStage'),
    startedAt: requireNullableString(item.startedAt, 'Invalid queue state: malformed startedAt'),
    completedAt: requireNullableString(item.completedAt, 'Invalid queue state: malformed item completedAt'),
    stopReason: requireNullableString(item.stopReason, 'Invalid queue state: malformed item stopReason'),
  };
}

function parseQueueItemPlanReviewDebt(value: unknown): ResidualReviewDebtItem[] {
  // Legacy-tolerant ONLY for a genuinely absent field: queue items persisted
  // before this field existed omit it entirely (undefined), and those default to
  // an empty debt array. A PRESENT null (or any other non-array) is corrupted
  // state that would silently erase accepted plan-review debt, so it is rejected
  // as malformed rather than defaulted away.
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid queue state: malformed planReviewDebt');
  }
  return value.map((item, index) => hydrateResidualReviewDebtItem(item, `queue item planReviewDebt[${index}]`));
}

function parseCurrentPlanAndExecuteQueuePointer(
  value: unknown,
  cwd: string,
): CurrentPlanAndExecuteQueuePointer {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid .neal/current-queue.json: expected object');
  }

  const pointer = value as Partial<CurrentPlanAndExecuteQueuePointer>;
  const queueStatePath = requireString(pointer.queueStatePath, 'Invalid .neal/current-queue.json: malformed queueStatePath');
  resolveQueueStoredPath(cwd, queueStatePath);

  return {
    version: pointer.version === 1 ? 1 : fail('Invalid .neal/current-queue.json: malformed queue pointer version'),
    queueId: requireQueueId(pointer.queueId, 'Invalid .neal/current-queue.json: malformed queueId'),
    queueStatePath,
    status: requireQueueStatus(pointer.status, 'Invalid .neal/current-queue.json: malformed queue status'),
    currentIndex: requireNonNegativeInteger(
      pointer.currentIndex,
      'Invalid .neal/current-queue.json: malformed currentIndex',
    ),
    activeStage: requireNullableQueueChildStage(
      pointer.activeStage,
      'Invalid .neal/current-queue.json: malformed activeStage',
    ),
    activeRunId: requireNullableString(pointer.activeRunId, 'Invalid .neal/current-queue.json: malformed activeRunId'),
    updatedAt: requireString(pointer.updatedAt, 'Invalid .neal/current-queue.json: malformed updatedAt'),
  };
}

function parseQueueChildLink(value: unknown): QueueChildLink {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid queue child link: expected object');
  }

  const link = value as Partial<QueueChildLink>;
  return {
    version: link.version === 1 ? 1 : fail('Invalid queue child link: malformed version'),
    queueId: requireQueueId(link.queueId, 'Invalid queue child link: malformed queueId'),
    queueStatePath: requireString(link.queueStatePath, 'Invalid queue child link: malformed queueStatePath'),
    itemIndex: requireNonNegativeInteger(link.itemIndex, 'Invalid queue child link: malformed itemIndex'),
    stage: requireQueueChildStage(link.stage, 'Invalid queue child link: malformed stage'),
    createdAt: requireString(link.createdAt, 'Invalid queue child link: malformed createdAt'),
  };
}

function resolveQueueInputPath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function getActiveQueueStage(state: PlanAndExecuteQueueState): QueueChildStage | null {
  return state.items[state.currentIndex]?.activeStage ?? null;
}

function getActiveQueueRunId(state: PlanAndExecuteQueueState): string | null {
  const item = state.items[state.currentIndex];
  if (!item) {
    return null;
  }
  switch (item.activeStage) {
    case 'planning':
      return item.planningRunId;
    case 'execution':
      return item.executionRunId;
    default:
      return null;
  }
}

function validateStoredPaths(cwd: string, paths: string[], label: string): void {
  for (const path of paths) {
    try {
      resolveQueueStoredPath(cwd, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid queue state: malformed ${label}: ${message}`);
    }
  }
}

function validateQueuePathInvariants(
  requestedPlans: string[],
  allowedDirtyPlanPaths: string[],
  items: PlanAndExecuteQueueItem[],
): void {
  for (const [index, item] of items.entries()) {
    if (item.requestedPlanPath !== requestedPlans[index]) {
      throw new Error('Invalid queue state: item requestedPlanPath must match requestedPlans');
    }
  }

  for (const requestedPlan of requestedPlans) {
    if (!allowedDirtyPlanPaths.includes(requestedPlan)) {
      throw new Error('Invalid queue state: allowedDirtyPlanPaths must include all requested plans');
    }
  }

  for (const item of items) {
    if (item.acceptedPlanPath && !allowedDirtyPlanPaths.includes(item.acceptedPlanPath)) {
      throw new Error('Invalid queue state: allowedDirtyPlanPaths must include accepted plan paths');
    }
  }
}

function nullableStringsToArray(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}

function requireQueueId(value: unknown, message: string): string {
  if (typeof value !== 'string' || !isValidQueueId(value)) {
    throw new Error(message);
  }
  return value;
}

function assertValidQueueId(queueId: string): void {
  requireQueueId(queueId, `Invalid Neal queue id: ${queueId}`);
}

function isValidQueueId(queueId: string): boolean {
  return QUEUE_ID_PATTERN.test(queueId) && queueId !== '.' && queueId !== '..' && !queueId.includes('..');
}

function requireAbsolutePath(value: unknown, message: string): string {
  const stringValue = requireString(value, message);
  if (!isAbsolute(stringValue) || resolve(stringValue) !== stringValue) {
    throw new Error(message);
  }
  return stringValue;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

function requireNullableString(value: unknown, message: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, message);
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(message);
  }
  return [...value];
}

function requireNonNegativeInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(message);
  }
  return value;
}

function requireQueueStatus(value: unknown, message: string): PlanAndExecuteQueueStatus {
  if (typeof value !== 'string' || !QUEUE_STATUSES.has(value as PlanAndExecuteQueueStatus)) {
    throw new Error(message);
  }
  return value as PlanAndExecuteQueueStatus;
}

function requireQueueItemStatus(value: unknown, message: string): PlanAndExecuteQueueItemStatus {
  if (typeof value !== 'string' || !QUEUE_ITEM_STATUSES.has(value as PlanAndExecuteQueueItemStatus)) {
    throw new Error(message);
  }
  return value as PlanAndExecuteQueueItemStatus;
}

function requireQueueChildStage(value: unknown, message: string): QueueChildStage {
  if (typeof value !== 'string' || !QUEUE_CHILD_STAGES.has(value as QueueChildStage)) {
    throw new Error(message);
  }
  return value as QueueChildStage;
}

function requireNullableQueueChildStage(value: unknown, message: string): QueueChildStage | null {
  if (value === null) {
    return null;
  }
  return requireQueueChildStage(value, message);
}

function isPathInside(cwd: string, path: string): boolean {
  const relativePath = relative(cwd, path);
  return relativePath === '' || (relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function formatQueueEvidenceError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function fail(message: string): never {
  throw new Error(message);
}
