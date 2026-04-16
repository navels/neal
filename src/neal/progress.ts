import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getCurrentScopeLabel, getParentScopeLabel, isExecutingDerivedPlan } from './scopes.js';
import type { OrchestrationState } from './types.js';

type InteractiveBlockedRecoverySummary = {
  sourcePhase: NonNullable<OrchestrationState['interactiveBlockedRecovery']>['sourcePhase'];
  blockedReason: string;
  turns: number;
  handledTurns: number;
  remainingTurns: number;
};

type InteractiveBlockedRecoveryHistorySummary = {
  sessions: number;
  lastAction: OrchestrationState['interactiveBlockedRecoveryHistory'][number]['resolvedByAction'] | null;
  lastResultPhase: OrchestrationState['interactiveBlockedRecoveryHistory'][number]['resultPhase'] | null;
};

type PlanProgressState = {
  version: 1;
  planDoc: string;
  status: OrchestrationState['status'];
  executionShape: OrchestrationState['executionShape'];
  createdAt: string;
  updatedAt: string;
  finalCommit: string | null;
  currentScope: {
    number: string;
    parentScope: string | null;
    phase: OrchestrationState['phase'];
    marker: OrchestrationState['lastScopeMarker'];
    baseCommit: string | null;
    derivedPlanPath: string | null;
    derivedPlanStatus: OrchestrationState['derivedPlanStatus'];
    splitPlanCount: number;
    derivedPlanDepth: number;
  } | null;
  interactiveBlockedRecovery: InteractiveBlockedRecoverySummary | null;
  interactiveBlockedRecoveryHistory: InteractiveBlockedRecoveryHistorySummary | null;
  completedScopes: OrchestrationState['completedScopes'];
};

function buildPlanProgressState(state: OrchestrationState): PlanProgressState {
  return {
    version: 1,
    planDoc: state.planDoc,
    status: state.status,
    executionShape: state.executionShape,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finalCommit: state.finalCommit,
    currentScope:
      state.status === 'done'
        ? null
        : {
            number: getCurrentScopeLabel(state),
            parentScope: isExecutingDerivedPlan(state) ? getParentScopeLabel(state) : null,
            phase: state.phase,
            marker: state.lastScopeMarker,
            baseCommit: state.baseCommit,
            derivedPlanPath: state.derivedPlanPath,
            derivedPlanStatus: state.derivedPlanStatus,
            splitPlanCount: state.splitPlanCountForCurrentScope,
            derivedPlanDepth: state.derivedPlanDepth,
          },
    interactiveBlockedRecovery: state.interactiveBlockedRecovery
      ? {
          sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
          blockedReason: state.interactiveBlockedRecovery.blockedReason,
          turns: state.interactiveBlockedRecovery.turns.length,
          handledTurns: state.interactiveBlockedRecovery.lastHandledTurn,
          remainingTurns: Math.max(
            state.interactiveBlockedRecovery.maxTurns - state.interactiveBlockedRecovery.turns.length,
            0,
          ),
        }
      : null,
    interactiveBlockedRecoveryHistory:
      state.interactiveBlockedRecoveryHistory.length > 0
        ? {
            sessions: state.interactiveBlockedRecoveryHistory.length,
            lastAction: state.interactiveBlockedRecoveryHistory.at(-1)?.resolvedByAction ?? null,
            lastResultPhase: state.interactiveBlockedRecoveryHistory.at(-1)?.resultPhase ?? null,
          }
        : null,
    completedScopes: state.completedScopes,
  };
}

export function renderPlanProgressMarkdown(state: OrchestrationState) {
  const progress = buildPlanProgressState(state);
  const lines = [
    '# Plan Progress',
    '',
    '## Metadata',
    `- Plan: ${progress.planDoc}`,
    `- Status: ${progress.status}`,
    `- Execution shape: ${progress.executionShape ?? 'pending'}`,
    `- Final commit: ${progress.finalCommit ?? 'pending'}`,
  ];

  if (progress.currentScope) {
    lines.push(
      '',
      '## Current Scope',
      `- Number: ${progress.currentScope.number}`,
      `- Parent scope: ${progress.currentScope.parentScope ?? 'none'}`,
      `- Phase: ${progress.currentScope.phase}`,
      `- Marker: ${progress.currentScope.marker ?? 'pending'}`,
      `- Base commit: ${progress.currentScope.baseCommit ?? 'unknown'}`,
      `- Derived plan: ${progress.currentScope.derivedPlanPath ?? 'none'}`,
      `- Derived plan status: ${progress.currentScope.derivedPlanStatus ?? 'none'}`,
      `- Split plan count: ${progress.currentScope.splitPlanCount}`,
      `- Derived plan depth: ${progress.currentScope.derivedPlanDepth}`,
    );
  }

  if (progress.interactiveBlockedRecovery) {
    lines.push(
      '',
      '## Interactive Blocked Recovery',
      `- Source phase: ${progress.interactiveBlockedRecovery.sourcePhase}`,
      `- Blocked reason: ${progress.interactiveBlockedRecovery.blockedReason}`,
      `- Recorded turns: ${progress.interactiveBlockedRecovery.turns}`,
      `- Handled turns: ${progress.interactiveBlockedRecovery.handledTurns}`,
      `- Remaining turns: ${progress.interactiveBlockedRecovery.remainingTurns}`,
    );
  }

  if (progress.interactiveBlockedRecoveryHistory) {
    lines.push(
      '',
      '## Interactive Blocked Recovery History',
      `- Sessions: ${progress.interactiveBlockedRecoveryHistory.sessions}`,
      `- Latest action: ${progress.interactiveBlockedRecoveryHistory.lastAction ?? 'none'}`,
      `- Latest result phase: ${progress.interactiveBlockedRecoveryHistory.lastResultPhase ?? 'none'}`,
    );
  }

  lines.push('', '## Completed Scopes');
  if (progress.completedScopes.length === 0) {
    lines.push('', 'No completed scopes yet.');
  } else {
    for (const scope of progress.completedScopes) {
      lines.push(
        '',
        `### Scope ${scope.number}`,
        `- Result: ${scope.result}`,
        `- Marker: ${scope.marker}`,
        `- Base commit: ${scope.baseCommit ?? 'unknown'}`,
        `- Final commit: ${scope.finalCommit ?? 'pending'}`,
        `- Commit subject: ${scope.commitSubject ?? 'pending'}`,
        `- Review rounds: ${scope.reviewRounds}`,
        `- Findings: ${scope.findings}`,
        `- Archived review: ${scope.archivedReviewPath ?? 'pending'}`,
        `- Blocker: ${scope.blocker ?? 'none'}`,
        `- Parent scope: ${scope.derivedFromParentScope ?? 'none'}`,
        `- Replaced by derived plan: ${scope.replacedByDerivedPlanPath ?? 'none'}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writePlanProgressArtifacts(state: OrchestrationState) {
  const progress = buildPlanProgressState(state);
  await mkdir(dirname(state.progressJsonPath), { recursive: true });
  await writeFile(state.progressJsonPath, JSON.stringify(progress, null, 2) + '\n', 'utf8');
  await writeFile(state.progressMarkdownPath, renderPlanProgressMarkdown(state), 'utf8');
}
