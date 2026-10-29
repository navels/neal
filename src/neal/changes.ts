import { basename, resolve } from 'node:path';

import {
  getChangedFilesForRange,
  getCommitRange,
  getHeadCommit,
  getWorktreeStatus,
  isAncestorCommit,
} from './git.js';
import { resolveRunStatePath } from './run-registry.js';
import { getCurrentScopeLabel } from './scopes.js';
import { loadState } from './state.js';
import type { OrchestrationState } from './types.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  parseWorktreeStatusLine,
} from './worktree-status.js';

export type NealChangeRangeSummary = {
  baseCommit: string | null;
  headCommit: string;
  comparable: boolean;
  changed: boolean | null;
  commits: string[];
  files: string[];
  reason: string | null;
};

export type NealRunChangesSnapshot = {
  ok: true;
  cwd: string;
  runId: string;
  runDir: string;
  planDoc: string;
  topLevelMode: OrchestrationState['topLevelMode'];
  status: OrchestrationState['status'];
  phase: OrchestrationState['phase'];
  scopeLabel: string;
  changed: boolean | null;
  currentScope: NealChangeRangeSummary;
  worktree: {
    changed: boolean;
    status: string[];
    files: string[];
  };
  runTotal: NealChangeRangeSummary;
};

async function summarizeRange(cwd: string, baseCommit: string | null, headCommit: string): Promise<NealChangeRangeSummary> {
  if (baseCommit === null) {
    return {
      baseCommit,
      headCommit,
      comparable: false,
      changed: null,
      commits: [],
      files: [],
      reason: 'The selected run does not record a base commit.',
    };
  }

  if (baseCommit === headCommit) {
    return {
      baseCommit,
      headCommit,
      comparable: true,
      changed: false,
      commits: [],
      files: [],
      reason: null,
    };
  }

  let ancestor: boolean;
  try {
    ancestor = await isAncestorCommit(cwd, baseCommit, headCommit);
  } catch {
    return {
      baseCommit,
      headCommit,
      comparable: false,
      changed: null,
      commits: [],
      files: [],
      reason: 'The recorded base commit is not available in the current checkout.',
    };
  }

  if (!ancestor) {
    return {
      baseCommit,
      headCommit,
      comparable: false,
      changed: null,
      commits: [],
      files: [],
      reason: 'Current HEAD is not descended from the recorded base commit.',
    };
  }

  const [commits, files] = await Promise.all([
    getCommitRange(cwd, baseCommit, headCommit),
    getChangedFilesForRange(cwd, baseCommit, headCommit),
  ]);
  return {
    baseCommit,
    headCommit,
    comparable: true,
    changed: commits.length > 0 || files.length > 0,
    commits,
    files,
    reason: null,
  };
}

function parseFilteredWorktree(statusOutput: string) {
  const status = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const files = [
    ...new Set(
      status
        .map(parseWorktreeStatusLine)
        .filter((entry): entry is NonNullable<ReturnType<typeof parseWorktreeStatusLine>> => entry !== null)
        .flatMap((entry) => entry.paths),
    ),
  ].sort();

  return {
    changed: status.length > 0,
    status,
    files,
  };
}

function combineChanged(committed: boolean | null, worktreeChanged: boolean) {
  if (worktreeChanged || committed === true) {
    return true;
  }
  return committed;
}

export async function buildRunChangesSnapshot(args: {
  cwd: string;
  runId?: string | null;
}): Promise<NealRunChangesSnapshot> {
  const cwd = resolve(args.cwd);
  const resolution = await resolveRunStatePath({
    cwd,
    runId: args.runId ?? null,
  });
  const state = await loadState(resolution.statePath);
  const headCommit = await getHeadCommit(cwd);
  const rawWorktree = await getWorktreeStatus(cwd, { untrackedFiles: 'all' });
  const filteredWorktree = filterAllowedDirtyPathStatus(
    cwd,
    filterWrapperOwnedWorktreeStatus(rawWorktree),
    state.allowedDirtyPaths,
  );

  const [currentScope, runTotal] = await Promise.all([
    summarizeRange(cwd, state.baseCommit, headCommit),
    summarizeRange(cwd, state.initialBaseCommit ?? state.baseCommit, headCommit),
  ]);
  const worktree = parseFilteredWorktree(filteredWorktree);

  return {
    ok: true,
    cwd,
    runId: resolution.runId ?? basename(state.runDir),
    runDir: state.runDir,
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    status: state.status,
    phase: state.phase,
    scopeLabel: getCurrentScopeLabel(state),
    changed: combineChanged(currentScope.changed, worktree.changed),
    currentScope,
    worktree,
    runTotal,
  };
}

function yesNoUnknown(value: boolean | null) {
  return value === null ? 'unknown' : value ? 'yes' : 'no';
}

function shortCommit(value: string | null) {
  return value === null ? 'n/a' : value.slice(0, 12);
}

export function renderHumanRunChanges(snapshot: NealRunChangesSnapshot) {
  const currentFiles = [...new Set([...snapshot.currentScope.files, ...snapshot.worktree.files])].sort();
  const lines = [
    '# Neal Changes',
    '',
    `Run: ${snapshot.runId}`,
    `Status: ${snapshot.status} / ${snapshot.phase}`,
    `Scope: ${snapshot.scopeLabel}`,
    `Changed: ${yesNoUnknown(snapshot.changed)}`,
    `Committed since scope base: ${snapshot.currentScope.commits.length} commit(s), ${snapshot.currentScope.files.length} file(s)`,
    `Uncommitted worktree: ${snapshot.worktree.changed ? `${snapshot.worktree.files.length} file(s)` : 'clean'}`,
    `Run total: ${yesNoUnknown(snapshot.runTotal.changed)} (${snapshot.runTotal.commits.length} commit(s), ${snapshot.runTotal.files.length} file(s))`,
    `Scope base: ${shortCommit(snapshot.currentScope.baseCommit)}`,
    `HEAD: ${shortCommit(snapshot.currentScope.headCommit)}`,
  ];

  if (snapshot.currentScope.reason) {
    lines.push(`Scope comparison: ${snapshot.currentScope.reason}`);
  }
  if (snapshot.runTotal.reason && snapshot.runTotal.reason !== snapshot.currentScope.reason) {
    lines.push(`Run comparison: ${snapshot.runTotal.reason}`);
  }
  if (currentFiles.length > 0) {
    lines.push('', 'Files:', ...currentFiles.map((file) => `- ${file}`));
  }
  if (snapshot.worktree.status.length > 0) {
    lines.push('', 'Worktree status:', ...snapshot.worktree.status.map((line) => `  ${line}`));
  }

  return lines.join('\n');
}
