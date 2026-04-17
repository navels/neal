import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  cleanUntracked,
  getStagedDiff,
  getUnstagedDiff,
  getUntrackedFiles,
  getWorktreeStatus,
  resetHard,
} from '../git.js';
import type { RunLogger } from '../logger.js';
import { saveState } from '../state.js';
import type { OrchestrationState } from '../types.js';
import { flushDerivedPlanNotifications } from './notifications.js';

const WRAPPER_OWNED_PREFIXES = ['.neal/', '.forge/'];
const WRAPPER_OWNED_PATHS = new Set(['.neal', '.forge', '.neal/session.json', '.forge/session.json']);
const MAX_SPLIT_PLANS_PER_SCOPE = 10;

function isWrapperOwnedPath(path: string) {
  return WRAPPER_OWNED_PATHS.has(path) || WRAPPER_OWNED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

export function filterWrapperOwnedWorktreeStatus(statusOutput: string) {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const path = line.length >= 3 ? line.slice(3).trim() : line.trim();
      return !isWrapperOwnedPath(path);
    })
    .join('\n');
}

function getSplitPlanArtifactPaths(state: OrchestrationState) {
  return {
    derivedPlanPath: join(state.runDir, `DERIVED_PLAN_SCOPE_${state.currentScopeNumber}.md`),
    discardedDiffPath: join(state.runDir, `SCOPE_${state.currentScopeNumber}_DISCARDED.diff`),
  };
}

async function captureDiscardedScopeArtifact(cwd: string, artifactPath: string) {
  const [status, stagedDiff, unstagedDiff, untrackedFiles] = await Promise.all([
    getWorktreeStatus(cwd),
    getStagedDiff(cwd),
    getUnstagedDiff(cwd),
    getUntrackedFiles(cwd),
  ]);

  const visibleUntrackedFiles = untrackedFiles.filter((file) => !isWrapperOwnedPath(file));
  const lines = [
    '# Discarded Scope WIP',
    '',
    '## Git Status',
    '```text',
    status || '(clean)',
    '```',
    '',
    '## Staged Diff',
    '```diff',
    stagedDiff || '',
    '```',
    '',
    '## Unstaged Diff',
    '```diff',
    unstagedDiff || '',
    '```',
    '',
    '## Untracked Files',
    visibleUntrackedFiles.length > 0 ? visibleUntrackedFiles.map((file) => `- ${file}`).join('\n') : '(none)',
  ];

  for (const file of visibleUntrackedFiles) {
    lines.push('', `### ${file}`);
    try {
      const content = await readFile(join(cwd, file), 'utf8');
      lines.push('```text', content, '```');
    } catch {
      lines.push('(binary or unreadable file omitted from inline snapshot)');
    }
  }

  await writeFile(artifactPath, `${lines.join('\n')}\n`, 'utf8');
}

async function discardScopeWorktree(state: OrchestrationState) {
  if (!state.baseCommit) {
    throw new Error('Cannot discard scope worktree without a baseCommit');
  }

  await resetHard(state.cwd, state.baseCommit);
  await cleanUntracked(state.cwd, ['.neal', '.forge']);
  const remainingStatus = filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd));
  if (remainingStatus) {
    throw new Error(`Failed to restore worktree to scope base ${state.baseCommit}:\n${remainingStatus}`);
  }
}

type PersistSplitPlanRecoveryArgs = {
  sourcePhase:
    | 'coder_scope'
    | 'reviewer_scope'
    | 'coder_response'
    | 'coder_optional_response'
    | 'reviewer_consult'
    | 'coder_consult_response'
    | 'reviewer_plan'
    | 'coder_plan'
    | 'coder_plan_response'
    | 'coder_plan_optional_response'
    | 'awaiting_derived_plan_execution'
    | 'final_squash';
  derivedPlanMarkdown: string;
  createdCommits: string[];
  logger?: RunLogger;
};

type PersistSplitPlanRecoveryDeps = {
  persistBlockedScope: (state: OrchestrationState, statePath: string, reason: string) => Promise<OrchestrationState>;
  writeExecutionArtifacts: (state: OrchestrationState) => Promise<void>;
};

export async function persistSplitPlanRecovery(
  state: OrchestrationState,
  statePath: string,
  args: PersistSplitPlanRecoveryArgs,
  deps: PersistSplitPlanRecoveryDeps,
) {
  if (state.splitPlanCountForCurrentScope >= MAX_SPLIT_PLANS_PER_SCOPE) {
    const reason = `split-plan recovery rejected: scope ${state.currentScopeNumber} reached the split-plan limit (${MAX_SPLIT_PLANS_PER_SCOPE})`;
    const blockedState = await saveState(statePath, {
      ...state,
      lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: null,
    });
    await deps.writeExecutionArtifacts(blockedState);
    return deps.persistBlockedScope(blockedState, statePath, reason);
  }

  if (state.derivedPlanDepth >= 1) {
    const reason = `split-plan recovery rejected: derived plan depth limit reached for scope ${state.currentScopeNumber}`;
    const blockedState = await saveState(statePath, {
      ...state,
      lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: null,
    });
    await deps.writeExecutionArtifacts(blockedState);
    return deps.persistBlockedScope(blockedState, statePath, reason);
  }

  const { derivedPlanPath, discardedDiffPath } = getSplitPlanArtifactPaths(state);
  await captureDiscardedScopeArtifact(state.cwd, discardedDiffPath);
  await writeFile(derivedPlanPath, `${args.derivedPlanMarkdown.trim()}\n`, 'utf8');
  await discardScopeWorktree(state);

  const nextState = await saveState(statePath, {
    ...state,
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    phase: 'reviewer_plan',
    status: 'running',
    blockedFromPhase: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    interactiveBlockedRecovery: null,
    derivedPlanPath,
    derivedFromScopeNumber: state.currentScopeNumber,
    derivedPlanStatus: 'pending_review',
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: state.splitPlanCountForCurrentScope + 1,
    rounds: [],
    consultRounds: [],
    findings: [],
    createdCommits: [],
    coderRetryCount: 0,
    reviewerSessionHandle: null,
  });

  await deps.writeExecutionArtifacts(nextState);
  await args.logger?.event('split_plan.persisted', {
    scopeNumber: state.currentScopeNumber,
    sourcePhase: args.sourcePhase,
    derivedPlanPath,
    discardedDiffPath,
    createdCommits: args.createdCommits,
  });
  return flushDerivedPlanNotifications(nextState, statePath, args.logger);
}
