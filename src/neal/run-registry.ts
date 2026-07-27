import { access, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { getRunStatePath, loadState } from './state.js';
import {
  getCurrentRunPointerPath as getStorageCurrentRunPointerPath,
  getRunDir,
  getRunsDir,
} from './storage-paths.js';
import type { OrchestrationState, TopLevelMode } from './types.js';

export type CurrentRunPointer = {
  version: 1;
  runId: string;
  runStatePath: string;
  planDoc: string;
  topLevelMode: TopLevelMode;
  updatedAt: string;
};

export type RunStatePathSource =
  | 'explicit_state_path'
  | 'explicit_run'
  | 'current_pointer';

export type RunStatePathResolution = {
  statePath: string;
  runId: string | null;
  source: RunStatePathSource;
};

export type RunSummary = {
  runId: string;
  runDir: string;
  statePath: string;
  planDoc: string;
  topLevelMode: TopLevelMode;
  status: OrchestrationState['status'];
  phase: OrchestrationState['phase'];
  createdAt: string;
  updatedAt: string;
};

export type ResolveRunStatePathArgs = {
  cwd: string;
  runId?: string | null;
  statePath?: string | null;
  warn?: (message: string) => void;
};

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function getRunIdFromRunDir(runDir: string): string {
  const runId = basename(runDir);
  assertValidRunId(runId);
  return runId;
}

export function getCurrentRunPointerPath(cwd: string): string {
  return getStorageCurrentRunPointerPath(cwd);
}

export function getRunStatePathForRunId(cwd: string, runId: string): string {
  assertValidRunId(runId);
  return getRunStatePath(getRunDir(cwd, runId));
}

export async function writeCurrentRunPointer(state: OrchestrationState): Promise<void> {
  const pointerPath = getCurrentRunPointerPath(state.cwd);
  const pointer: CurrentRunPointer = {
    version: 1,
    runId: getRunIdFromRunDir(state.runDir),
    runStatePath: toRepoRelativePath(state.cwd, getRunStatePath(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    updatedAt: state.updatedAt,
  };

  await writeJsonAtomic(pointerPath, pointer);
}

export async function updateRunPointersAfterStateSave(savedPath: string, state: OrchestrationState): Promise<void> {
  const savedAbsolutePath = resolvePath(state.cwd, savedPath);
  const runStatePath = getRunStatePath(state.runDir);
  if (samePath(savedAbsolutePath, runStatePath) && (await shouldRefreshCurrentPointer(state))) {
    await writeCurrentRunPointer(state);
  }
}

export async function resolveRunStatePath(args: ResolveRunStatePathArgs): Promise<RunStatePathResolution> {
  const cwd = resolve(args.cwd);
  const runId = args.runId?.trim() || null;
  const statePath = args.statePath?.trim() || null;

  if (runId && statePath) {
    throw new Error('runId and statePath are mutually exclusive');
  }

  if (statePath) {
    return {
      statePath: resolvePath(cwd, statePath),
      runId: null,
      source: 'explicit_state_path',
    };
  }

  if (runId) {
    if (runId === 'latest') {
      return resolveCurrentPointer(cwd);
    }

    const exactStatePath = getRunStatePathForRunId(cwd, runId);
    await requireReadableStatePath(exactStatePath, `No run state found for --run ${runId}`);
    return {
      statePath: exactStatePath,
      runId,
      source: 'explicit_run',
    };
  }

  return resolveDefaultRunStatePath(cwd);
}

export async function listRuns(cwd: string): Promise<RunSummary[]> {
  const runsDir = getRunsDir(cwd);
  const entries = await readdir(runsDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  });
  const summaries: RunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) {
      continue;
    }

    const statePath = getRunStatePathForRunId(cwd, entry.name);
    let state: OrchestrationState;
    try {
      state = await loadState(statePath);
    } catch {
      continue;
    }

    summaries.push({
      runId: entry.name,
      runDir: join(runsDir, entry.name),
      statePath,
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      status: state.status,
      phase: state.phase,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  return summaries.sort(compareRunSummariesNewestFirst);
}

function compareRunSummariesNewestFirst(left: RunSummary, right: RunSummary) {
  return (
    compareIsoTimestampDescending(left.updatedAt, right.updatedAt) ||
    compareIsoTimestampDescending(left.createdAt, right.createdAt) ||
    right.runId.localeCompare(left.runId)
  );
}

function compareIsoTimestampDescending(left: string, right: string) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  if (left !== right) {
    return right.localeCompare(left);
  }
  return 0;
}

async function resolveDefaultRunStatePath(cwd: string): Promise<RunStatePathResolution> {
  const current = await tryReadCurrentRunPointer(cwd);
  if (!current) {
    throw new Error('No .neal/current.json pointer found; run neal status --all to choose an explicit run id');
  }

  const statePath = resolvePath(cwd, current.runStatePath);
  await requireReadableStatePath(statePath, 'Current Neal run state is missing');
  return {
    statePath,
    runId: current.runId,
    source: 'current_pointer',
  };
}

async function resolveCurrentPointer(cwd: string): Promise<RunStatePathResolution> {
  const pointer = await tryReadCurrentRunPointer(cwd);
  if (!pointer) {
    throw new Error('No .neal/current.json pointer found for --run latest; use neal status --all to choose an explicit run id');
  }

  const statePath = resolvePath(cwd, pointer.runStatePath);
  await requireReadableStatePath(statePath, `Current Neal run state is missing for --run ${pointer.runId}`);

  return {
    statePath,
    runId: pointer.runId,
    source: 'current_pointer',
  };
}

async function shouldRefreshCurrentPointer(state: OrchestrationState) {
  const current = await tryReadCurrentRunPointer(state.cwd);
  if (!current) {
    return true;
  }

  return current.runId === getRunIdFromRunDir(state.runDir);
}

async function tryReadCurrentRunPointer(cwd: string): Promise<CurrentRunPointer | null> {
  const pointerPath = getCurrentRunPointerPath(cwd);
  let content: string;
  try {
    content = await readFile(pointerPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  return parseCurrentRunPointer(JSON.parse(content));
}

function parseCurrentRunPointer(value: unknown): CurrentRunPointer {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid .neal/current.json: expected object');
  }

  const pointer = value as Partial<CurrentRunPointer>;
  if (
    pointer.version !== 1 ||
    typeof pointer.runId !== 'string' ||
    !isValidRunId(pointer.runId) ||
    typeof pointer.runStatePath !== 'string' ||
    typeof pointer.planDoc !== 'string' ||
    (pointer.topLevelMode !== 'plan' && pointer.topLevelMode !== 'execute') ||
    typeof pointer.updatedAt !== 'string'
  ) {
    throw new Error('Invalid .neal/current.json: malformed current run pointer');
  }

  return {
    version: 1,
    runId: pointer.runId,
    runStatePath: pointer.runStatePath,
    planDoc: pointer.planDoc,
    topLevelMode: pointer.topLevelMode,
    updatedAt: pointer.updatedAt,
  };
}

function assertValidRunId(runId: string): void {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid Neal run id: ${runId}`);
  }
}

function isValidRunId(runId: string) {
  return RUN_ID_PATTERN.test(runId) && runId !== '.' && runId !== '..' && !runId.includes('..');
}

async function requireReadableStatePath(statePath: string, message: string) {
  try {
    await access(statePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new Error(`${message}: ${statePath}`);
    }
    throw error;
  }
}

function resolvePath(cwd: string, path: string) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function samePath(left: string, right: string) {
  return resolve(left) === resolve(right);
}

function toRepoRelativePath(cwd: string, path: string) {
  const relativePath = relative(cwd, path);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) ? relativePath : path;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
