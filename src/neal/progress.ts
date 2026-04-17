import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  getCurrentScopeLabel,
  getParentScopeLabel,
  getRecentAcceptedScopesForParentObjective,
  isExecutingDerivedPlan,
  renderRecentAcceptedScopesSummary,
} from './scopes.js';
import type { OrchestrationState } from './types.js';

type InteractiveBlockedRecoverySummary = {
  sourcePhase: NonNullable<OrchestrationState['interactiveBlockedRecovery']>['sourcePhase'];
  blockedReason: string;
  turns: number;
  handledTurns: number;
  remainingTurns: number;
  pendingDirective: string | null;
};

type InteractiveBlockedRecoveryHistorySummary = {
  sessions: number;
  lastAction: OrchestrationState['interactiveBlockedRecoveryHistory'][number]['resolvedByAction'] | null;
  lastResultPhase: OrchestrationState['interactiveBlockedRecoveryHistory'][number]['resultPhase'] | null;
};

type MeaningfulProgressSummary = {
  parentObjective: string;
  currentScopeProgressJustification: OrchestrationState['currentScopeProgressJustification'];
  currentScopeMeaningfulProgressVerdict: OrchestrationState['currentScopeMeaningfulProgressVerdict'];
  recentAcceptedScopeHistory: {
    number: string;
    finalCommit: string | null;
    commitSubject: string | null;
    parentScope: string | null;
    changedFiles: string[];
  }[];
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
  meaningfulProgress: MeaningfulProgressSummary | null;
  interactiveBlockedRecovery: InteractiveBlockedRecoverySummary | null;
  interactiveBlockedRecoveryHistory: InteractiveBlockedRecoveryHistorySummary | null;
  completedScopes: OrchestrationState['completedScopes'];
};

function buildPlanProgressState(state: OrchestrationState): PlanProgressState {
  const parentScopeLabel = state.topLevelMode === 'execute' ? getParentScopeLabel(state) : null;
  const recentAcceptedScopeHistory =
    state.topLevelMode === 'execute' && parentScopeLabel
      ? getRecentAcceptedScopesForParentObjective(state, parentScopeLabel)
          .map((scope) => ({
            number: scope.number,
            finalCommit: scope.finalCommit,
            commitSubject: scope.commitSubject,
            parentScope: scope.derivedFromParentScope,
            changedFiles: [...scope.changedFiles],
          }))
      : [];

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
    meaningfulProgress:
      state.topLevelMode === 'execute'
        ? {
            parentObjective: parentScopeLabel ?? String(state.currentScopeNumber),
            currentScopeProgressJustification: state.currentScopeProgressJustification,
            currentScopeMeaningfulProgressVerdict: state.currentScopeMeaningfulProgressVerdict,
            recentAcceptedScopeHistory,
          }
        : null,
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
          pendingDirective: state.interactiveBlockedRecovery.pendingDirective?.operatorGuidance ?? null,
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

function pushIndentedMultiline(lines: string[], value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    lines.push('- none');
    return;
  }

  for (const line of trimmed.split('\n')) {
    lines.push(`  ${line}`);
  }
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

  if (state.topLevelMode === 'execute') {
    lines.push(
      '',
      '## Meaningful Progress',
      `- Active parent objective: ${progress.meaningfulProgress?.parentObjective ?? 'none'}`,
    );

    if (state.currentScopeProgressJustification) {
      lines.push(
        '- Coder milestone: ' + state.currentScopeProgressJustification.milestoneTargeted,
        '- New evidence: ' + state.currentScopeProgressJustification.newEvidence,
        '- Why not redundant: ' + state.currentScopeProgressJustification.whyNotRedundant,
        '- Next step unlocked: ' + state.currentScopeProgressJustification.nextStepUnlocked,
      );
    } else {
      lines.push('- Coder justification: pending');
    }

    if (state.currentScopeMeaningfulProgressVerdict) {
      lines.push(
        `- Reviewer action: ${state.currentScopeMeaningfulProgressVerdict.action}`,
        `- Reviewer rationale: ${state.currentScopeMeaningfulProgressVerdict.rationale}`,
      );
    } else {
      lines.push('- Reviewer action: pending', '- Reviewer rationale: pending');
    }

    lines.push('- Recent accepted scope history:');
    pushIndentedMultiline(
      lines,
      renderRecentAcceptedScopesSummary(
        state,
        progress.meaningfulProgress?.parentObjective ?? String(state.currentScopeNumber),
      ),
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
      `- Pending terminal directive: ${progress.interactiveBlockedRecovery.pendingDirective ?? 'none'}`,
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
