import { join } from 'node:path';

export const NEAL_DIR_NAME = '.neal';
export const RUNS_DIR_NAME = 'runs';
export const QUEUES_DIR_NAME = 'queues';
export const REVIEWS_DIR_NAME = 'reviews';
export const CURRENT_RUN_POINTER_FILE = 'current.json';
export const CURRENT_QUEUE_POINTER_FILE = 'current-queue.json';
export const ACTIVE_RUN_LOCK_FILE = 'active-run.lock';
export const RUN_STATE_FILE = 'RUN_STATE.json';
export const QUEUE_STATE_FILE = 'QUEUE_STATE.json';
export const QUEUE_LINK_FILE = 'QUEUE_LINK.json';
export const QUEUE_SUMMARY_FILE = 'QUEUE_SUMMARY.md';
export const PLAN_ORIGINAL_BACKUP_FILE = 'PLAN_ORIGINAL.md';
export const SCRATCH_DIR_NAME = 'scratch';

export function getNealDir(cwd: string): string {
  return join(cwd, NEAL_DIR_NAME);
}

export function getRunsDir(cwd: string): string {
  return join(getNealDir(cwd), RUNS_DIR_NAME);
}

export function getRunDir(cwd: string, runId: string): string {
  return join(getRunsDir(cwd), runId);
}

export function getQueuesDir(cwd: string): string {
  return join(getNealDir(cwd), QUEUES_DIR_NAME);
}

export function getReviewsDir(cwd: string): string {
  return join(getNealDir(cwd), REVIEWS_DIR_NAME);
}

export function getCurrentRunPointerPath(cwd: string): string {
  return join(getNealDir(cwd), CURRENT_RUN_POINTER_FILE);
}

export function getCurrentPlanAndExecuteQueuePointerPath(cwd: string): string {
  return join(getNealDir(cwd), CURRENT_QUEUE_POINTER_FILE);
}

export function getActiveRunLockPath(cwd: string): string {
  return join(getNealDir(cwd), ACTIVE_RUN_LOCK_FILE);
}

export function getRunStatePath(runDir: string): string {
  return join(runDir, RUN_STATE_FILE);
}

export function getPlanDocumentBackupPath(runDir: string): string {
  return join(runDir, PLAN_ORIGINAL_BACKUP_FILE);
}

export function getRunScratchDir(runDir: string): string {
  return join(runDir, SCRATCH_DIR_NAME);
}

export function getScopeReviewerScratchDir(runDir: string, scopeLabel: string, round: number): string {
  return join(getRunScratchDir(runDir), `reviewer-scope-${sanitizePathSegment(scopeLabel)}-round-${round}`);
}

export function getFinalCompletionReviewerScratchDir(runDir: string): string {
  return join(getRunScratchDir(runDir), 'final-completion-review');
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-');
  return sanitized.length > 0 ? sanitized : 'scope';
}
