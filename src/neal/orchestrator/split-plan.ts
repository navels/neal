import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeTextAtomic } from '../atomic-write.js';
import { type ExecuteFinalizationPhase } from '../execute-finalization.js';
import {
  cleanUntracked,
  getStagedDiff,
  getUnstagedDiff,
  getUntrackedFiles,
  getWorktreeStatus,
  resetHard,
} from '../git.js';
import type { RunLogger } from '../logger.js';
import { withPlanDocPreserved } from '../plan-doc.js';
import { validatePlanDocument } from '../plan-validation.js';
import { saveState } from '../state.js';
import { getDerivedPlanCountersView } from '../state-views.js';
import type { OrchestrationState } from '../types.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  isWrapperOwnedPath,
} from '../worktree-status.js';
import { flushDerivedPlanNotifications, notifyBlocked } from './notifications.js';
import {
  enterInteractiveBlockedRecovery,
  shouldNotifyInteractiveBlockedRecoveryEntry,
} from './phases/recovery.js';
import { createScopeBoundaryReset } from './transitions.js';

const MAX_SPLIT_PLANS_PER_SCOPE = 10;

function getSplitPlanArtifactPaths(state: OrchestrationState) {
  return {
    derivedPlanPath: join(state.runDir, `DERIVED_PLAN_SCOPE_${state.currentScopeNumber}.md`),
    invalidDerivedPlanPath: join(state.runDir, `SCOPE_${state.currentScopeNumber}_INVALID_DERIVED_PLAN.md`),
    discardedDiffPath: join(state.runDir, `SCOPE_${state.currentScopeNumber}_DISCARDED.diff`),
  };
}

type SplitPlanPayloadValidationResult =
  | {
      ok: true;
      persistedPlanBody: string;
    }
  | {
      ok: false;
      trimmedPayload: string;
      errors: string[];
    };

function validateSplitPlanPayload(derivedPlanMarkdown: string): SplitPlanPayloadValidationResult {
  const trimmedPayload = derivedPlanMarkdown.trim();
  if (!trimmedPayload) {
    return {
      ok: false,
      trimmedPayload,
      errors: ['Replacement plan payload is empty.'],
    };
  }

  const validation = validatePlanDocument(trimmedPayload);
  if (!validation.ok) {
    return {
      ok: false,
      trimmedPayload,
      errors: validation.errors,
    };
  }

  // Persist the normalized document so downstream derived-plan review sees the canonical Neal plan contract.
  return {
    ok: true,
    persistedPlanBody: validation.normalization.applied ? validation.normalization.normalizedDocument.trim() : trimmedPayload,
  };
}

function renderInvalidSplitPlanPayloadArtifact(payload: string, errors: string[]) {
  return [
    '# Invalid Derived Plan Payload',
    '',
    'This artifact is diagnostic only. It is not a reviewable derived plan.',
    '',
    '## Validation Errors',
    '',
    ...errors.map((error) => `- ${error}`),
    '',
    '## Returned Payload',
    '',
    '```markdown',
    payload,
    '```',
    '',
  ].join('\n');
}

function formatInvalidSplitPlanReason(errors: string[]) {
  return `split-plan recovery rejected: replacement plan payload is not a valid Neal-executable plan: ${errors.join('; ')}`;
}

function isRecoverableInvalidSplitPlanSourcePhase(
  sourcePhase: PersistSplitPlanRecoveryArgs['sourcePhase'],
): sourcePhase is 'coder_scope' | 'coder_response' {
  return sourcePhase === 'coder_scope' || sourcePhase === 'coder_response';
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

  await writeTextAtomic(artifactPath, `${lines.join('\n')}\n`);
}

async function discardScopeWorktree(state: OrchestrationState) {
  if (!state.baseCommit) {
    throw new Error('Cannot discard scope worktree without a baseCommit');
  }

  // Preserve the plan-doc overlay (tracked-and-modified or untracked seed)
  // across the reset; it is wrapper-owned, not scope work being discarded.
  const scopeBaseCommit = state.baseCommit;
  await withPlanDocPreserved(state.planDoc, async () => {
    await resetHard(state.cwd, scopeBaseCommit);
    await cleanUntracked(state.cwd, ['.neal', '.forge']);
  });
  const remainingStatus = filterAllowedDirtyPathStatus(
    state.cwd,
    filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd)),
    [state.planDoc],
  );
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
    | 'reviewer_plan'
    | 'coder_plan'
    | 'coder_plan_response'
    | 'coder_plan_optional_response'
    | 'awaiting_derived_plan_execution'
    | ExecuteFinalizationPhase
    | 'final_completion_review';
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
  const derivedPlanCounters = getDerivedPlanCountersView(state);
  if (derivedPlanCounters.splitPlanCountForCurrentScope >= MAX_SPLIT_PLANS_PER_SCOPE) {
    const reason = `split-plan recovery rejected: scope ${state.currentScopeNumber} reached the split-plan limit (${MAX_SPLIT_PLANS_PER_SCOPE})`;
    const blockedState = await saveState(statePath, {
      ...state,
      lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: args.sourcePhase,
      interactiveBlockedRecovery: null,
    });
    await deps.writeExecutionArtifacts(blockedState);
    const persistedState = await deps.persistBlockedScope(blockedState, statePath, reason);
    return flushDerivedPlanNotifications(persistedState, statePath, args.logger, reason);
  }

  if (derivedPlanCounters.derivedPlanDepth >= 1) {
    const reason = `split-plan recovery rejected: derived plan depth limit reached for scope ${state.currentScopeNumber}`;
    const blockedState = await saveState(statePath, {
      ...state,
      lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: args.sourcePhase,
      interactiveBlockedRecovery: null,
    });
    await deps.writeExecutionArtifacts(blockedState);
    const persistedState = await deps.persistBlockedScope(blockedState, statePath, reason);
    return flushDerivedPlanNotifications(persistedState, statePath, args.logger, reason);
  }

  const { derivedPlanPath, invalidDerivedPlanPath, discardedDiffPath } = getSplitPlanArtifactPaths(state);
  const validation = validateSplitPlanPayload(args.derivedPlanMarkdown);
  if (!validation.ok) {
    const reason = formatInvalidSplitPlanReason(validation.errors);
    await writeTextAtomic(
      invalidDerivedPlanPath,
      renderInvalidSplitPlanPayloadArtifact(validation.trimmedPayload, validation.errors),
    );
    await args.logger?.event('split_plan.invalid_payload', {
      scopeNumber: state.currentScopeNumber,
      sourcePhase: args.sourcePhase,
      validationErrors: validation.errors,
      invalidPayloadPath: invalidDerivedPlanPath,
      resetSkipped: true,
      createdCommits: args.createdCommits,
    });
    const recoveryCandidateState = {
      ...state,
      lastScopeMarker: 'AUTONOMY_SPLIT_PLAN' as const,
      blockedFromPhase: args.sourcePhase,
      interactiveBlockedRecovery: null,
      splitPlanBlockedNotified: false,
    };
    if (isRecoverableInvalidSplitPlanSourcePhase(args.sourcePhase)) {
      await args.logger?.event('split_plan.invalid_payload_recovery_started', {
        scopeNumber: state.currentScopeNumber,
        sourcePhase: args.sourcePhase,
        invalidPayloadPath: invalidDerivedPlanPath,
        validationErrors: validation.errors,
        createdCommits: args.createdCommits,
      });
      const persistedState = await enterInteractiveBlockedRecovery(
        {
          ...recoveryCandidateState,
          status: 'blocked',
          currentScopeProgressJustification: null,
          currentScopeMeaningfulProgressVerdict: null,
        },
        statePath,
        reason,
        args.logger,
      );
      if (shouldNotifyInteractiveBlockedRecoveryEntry(persistedState)) {
        await notifyBlocked(persistedState, reason, args.logger);
      }
      return persistedState;
    }
    const blockedState = await saveState(statePath, {
      ...recoveryCandidateState,
      phase: 'blocked',
      status: 'blocked',
      currentScopeProgressJustification: null,
      currentScopeMeaningfulProgressVerdict: null,
    });
    await deps.writeExecutionArtifacts(blockedState);
    const persistedState = await deps.persistBlockedScope(blockedState, statePath, reason);
    return flushDerivedPlanNotifications(persistedState, statePath, args.logger, reason);
  }

  await captureDiscardedScopeArtifact(state.cwd, discardedDiffPath);
  await writeTextAtomic(derivedPlanPath, `${validation.persistedPlanBody}\n`);
  await discardScopeWorktree(state);

  const nextState = await saveState(statePath, {
    ...state,
    ...createScopeBoundaryReset(),
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    phase: 'reviewer_plan',
    status: 'running',
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
    derivedPlanPath,
    derivedFromScopeNumber: state.currentScopeNumber,
    derivedPlanStatus: 'pending_review',
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: state.splitPlanCountForCurrentScope + 1,
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
