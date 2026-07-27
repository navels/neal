import { hostname } from 'node:os';
import process from 'node:process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeTextAtomic } from './atomic-write.js';
import { ACTIVE_RUN_LOCK_FILE, getActiveRunLockPath as getStorageActiveRunLockPath } from './storage-paths.js';
import type { ResumeLockEvidence } from './resume-decision.js';
import type { TopLevelMode } from './types.js';

export type ActiveRunLock = {
  version: 1;
  runId: string;
  runStatePath: string;
  planDoc: string;
  topLevelMode: TopLevelMode;
  pid: number;
  hostname: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
};

export type ActiveRunLockHandle = {
  lockPath: string;
  lock: ActiveRunLock;
  acquired: boolean;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
};

export type ActiveRunLockErrorKind =
  | 'active_same_run'
  | 'active_different_run'
  | 'stale_same_host'
  | 'cross_host'
  | 'unreadable';

export class ActiveRunLockError extends Error {
  readonly kind: ActiveRunLockErrorKind;
  readonly lockPath: string;
  readonly lock: ActiveRunLock | null;

  constructor(kind: ActiveRunLockErrorKind, lockPath: string, lock: ActiveRunLock | null, message: string) {
    super(message);
    this.name = 'ActiveRunLockError';
    this.kind = kind;
    this.lockPath = lockPath;
    this.lock = lock;
  }
}

export type AcquireActiveRunLockArgs = {
  cwd: string;
  runId: string;
  runStatePath: string;
  planDoc: string;
  topLevelMode: TopLevelMode;
};

export type RefreshActiveRunLockArgs = {
  cwd: string;
  runId: string;
  runStatePath: string;
  planDoc: string;
  topLevelMode: TopLevelMode;
};

const LOCK_VERSION = 1;

export function getActiveRunLockPath(cwd: string): string {
  return getStorageActiveRunLockPath(cwd);
}

export async function inspectActiveRunLock(cwd: string, requestedRunId: string): Promise<ResumeLockEvidence> {
  const lockPath = getActiveRunLockPath(resolve(cwd));
  let lock: ActiveRunLock;
  try {
    lock = await readActiveRunLock(lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { kind: 'none' };
    }
    return {
      kind: 'unreadable',
      lockPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (lock.hostname !== hostname()) {
    return {
      kind: 'cross_host',
      runId: lock.runId,
      lockPath,
      pid: lock.pid,
      hostname: lock.hostname,
    };
  }

  const live = isProcessAlive(lock.pid);
  if (lock.runId === requestedRunId) {
    return {
      kind: live ? 'live_same_run' : 'stale_same_run',
      runId: lock.runId,
      lockPath,
      pid: lock.pid,
      hostname: lock.hostname,
    };
  }

  return {
    kind: live ? 'live_different_run' : 'stale_different_run',
    runId: lock.runId,
    lockPath,
    pid: lock.pid,
    hostname: lock.hostname,
  };
}

export async function clearStaleActiveRunLockForResume(
  cwd: string,
  evidence: ResumeLockEvidence,
): Promise<void> {
  if (evidence.kind !== 'stale_same_run' && evidence.kind !== 'stale_different_run') {
    return;
  }

  const lockPath = evidence.lockPath ?? getActiveRunLockPath(resolve(cwd));
  let lock: ActiveRunLock;
  try {
    lock = await readActiveRunLock(lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (
    lock.hostname !== hostname() ||
    lock.runId !== evidence.runId ||
    lock.pid !== evidence.pid ||
    isProcessAlive(lock.pid)
  ) {
    return;
  }

  await rm(lockPath, { force: true });
}

export async function acquireActiveRunLock(args: AcquireActiveRunLockArgs): Promise<ActiveRunLockHandle> {
  const cwd = resolve(args.cwd);
  const lockPath = getActiveRunLockPath(cwd);
  const now = new Date().toISOString();
  const lock: ActiveRunLock = {
    version: LOCK_VERSION,
    runId: args.runId,
    runStatePath: toRepoRelativePath(cwd, args.runStatePath),
    planDoc: args.planDoc,
    topLevelMode: args.topLevelMode,
    pid: process.pid,
    hostname: hostname(),
    cwd,
    startedAt: now,
    updatedAt: now,
  };

  await mkdir(dirname(lockPath), { recursive: true });

  try {
    const file = await open(lockPath, 'wx');
    try {
      await file.writeFile(JSON.stringify(lock, null, 2) + '\n', 'utf8');
    } finally {
      await file.close();
    }
    return createOwnedHandle(lockPath, lock);
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }

  const existing = await readActiveRunLock(lockPath).catch((error: unknown) => {
    throw new ActiveRunLockError(
      'unreadable',
      lockPath,
      null,
      [
        '[neal] could not read the active Neal writer lock',
        `[neal] lock: ${lockPath}`,
        `[neal] error: ${error instanceof Error ? error.message : String(error)}`,
        '[neal] inspect the lock file before starting another writer run.',
      ].join('\n'),
    );
  });
  assertCanShareExistingLock(lockPath, existing, args.runId);

  return {
    lockPath,
    lock: existing,
    acquired: false,
    async release() {},
    async refresh() {},
  };
}

export async function refreshActiveRunLock(args: RefreshActiveRunLockArgs): Promise<void> {
  const cwd = resolve(args.cwd);
  const lockPath = getActiveRunLockPath(cwd);
  let lock: ActiveRunLock;
  try {
    lock = await readActiveRunLock(lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (lock.runId !== args.runId || lock.pid !== process.pid || lock.hostname !== hostname()) {
    return;
  }

  const nextLock: ActiveRunLock = {
    ...lock,
    runStatePath: toRepoRelativePath(cwd, args.runStatePath),
    planDoc: args.planDoc,
    topLevelMode: args.topLevelMode,
    updatedAt: new Date().toISOString(),
  };
  // Replace the lock via temp-file rename so a crash mid-refresh can never
  // leave a truncated lock that later commands classify as unreadable.
  await writeTextAtomic(lockPath, JSON.stringify(nextLock, null, 2) + '\n');
}

export async function releaseActiveRunLock(cwd: string, runId: string): Promise<void> {
  const lockPath = getActiveRunLockPath(resolve(cwd));
  let lock: ActiveRunLock;
  try {
    lock = await readActiveRunLock(lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  if (lock.runId !== runId || lock.pid !== process.pid || lock.hostname !== hostname()) {
    return;
  }

  await rm(lockPath, { force: true });
}

export function releaseActiveRunLockSync(cwd: string, runId: string): void {
  const lockPath = getActiveRunLockPath(resolve(cwd));
  let lock: ActiveRunLock;
  try {
    lock = parseActiveRunLock(JSON.parse(readFileSync(lockPath, 'utf8')), lockPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    return;
  }

  if (lock.runId !== runId || lock.pid !== process.pid || lock.hostname !== hostname()) {
    return;
  }

  rmSync(lockPath, { force: true });
}

export async function readActiveRunLock(lockPathOrCwd: string): Promise<ActiveRunLock> {
  const lockPath = lockPathOrCwd.endsWith(ACTIVE_RUN_LOCK_FILE) ? lockPathOrCwd : getActiveRunLockPath(lockPathOrCwd);
  const content = await readFile(lockPath, 'utf8');
  return parseActiveRunLock(JSON.parse(content), lockPath);
}

function createOwnedHandle(lockPath: string, lock: ActiveRunLock): ActiveRunLockHandle {
  return {
    lockPath,
    lock,
    acquired: true,
    release: () => releaseActiveRunLock(lock.cwd, lock.runId),
    refresh: () =>
      refreshActiveRunLock({
        cwd: lock.cwd,
        runId: lock.runId,
        runStatePath: lock.runStatePath,
        planDoc: lock.planDoc,
        topLevelMode: lock.topLevelMode,
      }),
  };
}

function assertCanShareExistingLock(lockPath: string, lock: ActiveRunLock, requestedRunId: string): void {
  if (lock.hostname !== hostname()) {
    throw new ActiveRunLockError('cross_host', lockPath, lock, formatCrossHostLockMessage(lockPath, lock));
  }

  if (!isProcessAlive(lock.pid)) {
    throw new ActiveRunLockError('stale_same_host', lockPath, lock, formatStaleLockMessage(lockPath, lock));
  }

  if (lock.runId !== requestedRunId) {
    throw new ActiveRunLockError('active_different_run', lockPath, lock, formatActiveLockMessage(lockPath, lock));
  }

  // Sharing an existing lock is only legitimate for the same process
  // re-entering its own run. A live same-run lock under another pid means a
  // concurrent writer already owns this run's state and worktree.
  if (lock.pid !== process.pid) {
    throw new ActiveRunLockError('active_same_run', lockPath, lock, formatActiveSameRunLockMessage(lockPath, lock));
  }
}

function formatActiveLockMessage(lockPath: string, lock: ActiveRunLock): string {
  return [
    '[neal] another Neal writer run is active in this checkout',
    `[neal] active run: ${lock.runId}`,
    `[neal] plan: ${lock.planDoc}`,
    `[neal] pid: ${lock.pid}`,
    `[neal] lock: ${lockPath}`,
    `[neal] use \`neal resume --run ${lock.runId}\` to continue it, or wait for the active run to finish.`,
  ].join('\n');
}

function formatActiveSameRunLockMessage(lockPath: string, lock: ActiveRunLock): string {
  return [
    '[neal] another Neal process is already resuming this run',
    `[neal] active run: ${lock.runId}`,
    `[neal] plan: ${lock.planDoc}`,
    `[neal] owning pid: ${lock.pid}`,
    `[neal] lock: ${lockPath}`,
    `[neal] wait for that process to finish, or inspect it with \`neal status --run ${lock.runId}\`.`,
  ].join('\n');
}

function formatStaleLockMessage(lockPath: string, lock: ActiveRunLock): string {
  return [
    '[neal] stale Neal writer lock found in this checkout',
    `[neal] active run: ${lock.runId}`,
    `[neal] plan: ${lock.planDoc}`,
    `[neal] pid: ${lock.pid}`,
    `[neal] lock: ${lockPath}`,
    '[neal] no process with that PID is running on this host.',
    `[neal] inspect the run, then remove ${lockPath} if no Neal writer process is active.`,
    `[neal] exact resume command: neal resume --run ${lock.runId}`,
  ].join('\n');
}

function formatCrossHostLockMessage(lockPath: string, lock: ActiveRunLock): string {
  return [
    '[neal] Neal writer lock belongs to another host',
    `[neal] active run: ${lock.runId}`,
    `[neal] plan: ${lock.planDoc}`,
    `[neal] pid: ${lock.pid}`,
    `[neal] host: ${lock.hostname}`,
    `[neal] lock: ${lockPath}`,
    '[neal] inspect the other host before removing this lock or starting another writer run.',
    `[neal] exact resume command on that checkout: neal resume --run ${lock.runId}`,
  ].join('\n');
}

function parseActiveRunLock(value: unknown, lockPath: string): ActiveRunLock {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid active Neal writer lock at ${lockPath}: expected object`);
  }

  const lock = value as Partial<ActiveRunLock>;
  if (
    lock.version !== LOCK_VERSION ||
    typeof lock.runId !== 'string' ||
    typeof lock.runStatePath !== 'string' ||
    typeof lock.planDoc !== 'string' ||
    (lock.topLevelMode !== 'plan' && lock.topLevelMode !== 'execute') ||
    typeof lock.pid !== 'number' ||
    typeof lock.hostname !== 'string' ||
    typeof lock.cwd !== 'string' ||
    typeof lock.startedAt !== 'string' ||
    typeof lock.updatedAt !== 'string'
  ) {
    throw new Error(`Invalid active Neal writer lock at ${lockPath}: malformed lock`);
  }

  return {
    version: LOCK_VERSION,
    runId: lock.runId,
    runStatePath: lock.runStatePath,
    planDoc: lock.planDoc,
    topLevelMode: lock.topLevelMode,
    pid: lock.pid,
    hostname: lock.hostname,
    cwd: lock.cwd,
    startedAt: lock.startedAt,
    updatedAt: lock.updatedAt,
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null;
    return code === 'EPERM';
  }
}

function toRepoRelativePath(cwd: string, path: string) {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) ? relativePath : absolutePath;
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST');
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
