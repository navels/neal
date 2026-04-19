import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { renderAdjudicationContractLines } from './adjudicator/artifacts.js';
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

type DiagnosticRecoverySummary = {
  sequence: number;
  sourcePhase: NonNullable<OrchestrationState['diagnosticRecovery']>['sourcePhase'];
  resumePhase: NonNullable<OrchestrationState['diagnosticRecovery']>['resumePhase'];
  parentScopeLabel: string;
  blockedReason: string | null;
  question: string;
  target: string;
  requestedBaselineRef: string | null;
  effectiveBaselineRef: string | null;
  effectiveBaselineSource: NonNullable<OrchestrationState['diagnosticRecovery']>['effectiveBaselineSource'];
  analysisArtifactPath: string;
  recoveryPlanPath: string;
};

type DiagnosticRecoveryHistorySummary = {
  sessions: number;
  lastDecision: OrchestrationState['diagnosticRecoveryHistory'][number]['decision'] | null;
  lastResultPhase: OrchestrationState['diagnosticRecoveryHistory'][number]['resultPhase'] | null;
  lastAdoptedPlanPath: string | null;
  lastReviewArtifactPath: string | null;
  lastReviewRoundCount: number;
  lastReviewFindingCount: number;
};

type MeaningfulProgressSummary = {
  parentObjective: string;
  currentScopeProgressJustification: OrchestrationState['currentScopeProgressJustification'];
  currentScopeMeaningfulProgressVerdict: OrchestrationState['currentScopeMeaningfulProgressVerdict'];
  recentAcceptedScopeHistory: {
    number: string;
    finalCommit: string | null;
    summary: string | null;
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
  finalCompletionSummary: OrchestrationState['finalCompletionSummary'];
  finalCompletionReviewVerdict: OrchestrationState['finalCompletionReviewVerdict'];
  finalCompletionResolvedAction: OrchestrationState['finalCompletionResolvedAction'];
  finalCompletionContinueExecutionCount: number;
  finalCompletionContinueExecutionCapReached: boolean;
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
  diagnosticRecovery: DiagnosticRecoverySummary | null;
  diagnosticRecoveryHistory: DiagnosticRecoveryHistorySummary | null;
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
            summary: scope.summary ?? null,
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
    finalCompletionSummary: state.finalCompletionSummary,
    finalCompletionReviewVerdict: state.finalCompletionReviewVerdict,
    finalCompletionResolvedAction: state.finalCompletionResolvedAction,
    finalCompletionContinueExecutionCount: state.finalCompletionContinueExecutionCount,
    finalCompletionContinueExecutionCapReached: state.finalCompletionContinueExecutionCapReached,
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
    diagnosticRecovery: state.diagnosticRecovery
      ? {
          sequence: state.diagnosticRecovery.sequence,
          sourcePhase: state.diagnosticRecovery.sourcePhase,
          resumePhase: state.diagnosticRecovery.resumePhase,
          parentScopeLabel: state.diagnosticRecovery.parentScopeLabel,
          blockedReason: state.diagnosticRecovery.blockedReason,
          question: state.diagnosticRecovery.question,
          target: state.diagnosticRecovery.target,
          requestedBaselineRef: state.diagnosticRecovery.requestedBaselineRef,
          effectiveBaselineRef: state.diagnosticRecovery.effectiveBaselineRef,
          effectiveBaselineSource: state.diagnosticRecovery.effectiveBaselineSource,
          analysisArtifactPath: state.diagnosticRecovery.analysisArtifactPath,
          recoveryPlanPath: state.diagnosticRecovery.recoveryPlanPath,
        }
      : null,
    diagnosticRecoveryHistory:
      state.diagnosticRecoveryHistory.length > 0
        ? {
            sessions: state.diagnosticRecoveryHistory.length,
            lastDecision: state.diagnosticRecoveryHistory.at(-1)?.decision ?? null,
            lastResultPhase: state.diagnosticRecoveryHistory.at(-1)?.resultPhase ?? null,
            lastAdoptedPlanPath: state.diagnosticRecoveryHistory.at(-1)?.adoptedPlanPath ?? null,
            lastReviewArtifactPath: state.diagnosticRecoveryHistory.at(-1)?.reviewArtifactPath ?? null,
            lastReviewRoundCount: state.diagnosticRecoveryHistory.at(-1)?.reviewRoundCount ?? 0,
            lastReviewFindingCount: state.diagnosticRecoveryHistory.at(-1)?.reviewFindingCount ?? 0,
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

  const contractLines = renderAdjudicationContractLines(state);
  if (contractLines.length > 0) {
    lines.push('', ...contractLines);
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

  if (progress.finalCompletionSummary) {
    lines.push(
      '',
      '## Final Completion Summary',
      `- Plan goal satisfied: ${progress.finalCompletionSummary.planGoalSatisfied ? 'yes' : 'no'}`,
      `- What changed overall: ${progress.finalCompletionSummary.whatChangedOverall}`,
      `- Verification summary: ${progress.finalCompletionSummary.verificationSummary}`,
    );

    if (progress.finalCompletionSummary.remainingKnownGaps.length > 0) {
      lines.push('- Remaining known gaps:');
      for (const gap of progress.finalCompletionSummary.remainingKnownGaps) {
        lines.push(`  - ${gap}`);
      }
    } else {
      lines.push('- Remaining known gaps: none');
    }
  }

  if (progress.finalCompletionReviewVerdict) {
    lines.push(
      '',
      '## Final Completion Review',
      `- Reviewer action: ${progress.finalCompletionReviewVerdict.action}`,
      `- Resulting action: ${progress.finalCompletionResolvedAction ?? progress.finalCompletionReviewVerdict.action}`,
      `- Reviewer summary: ${progress.finalCompletionReviewVerdict.summary}`,
      `- Reviewer rationale: ${progress.finalCompletionReviewVerdict.rationale}`,
      `- Continue-execution cycles used: ${progress.finalCompletionContinueExecutionCount}`,
      `- Continue-execution cap reached: ${progress.finalCompletionContinueExecutionCapReached ? 'yes' : 'no'}`,
    );

    if (progress.finalCompletionReviewVerdict.missingWork) {
      lines.push(
        '- Missing work summary: ' + progress.finalCompletionReviewVerdict.missingWork.summary,
        '- Missing work required outcome: ' + progress.finalCompletionReviewVerdict.missingWork.requiredOutcome,
        '- Missing work verification: ' + progress.finalCompletionReviewVerdict.missingWork.verification,
      );
    } else {
      lines.push('- Missing work: none');
    }
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

  if (progress.diagnosticRecovery) {
    lines.push(
      '',
      '## Diagnostic Recovery',
      `- Sequence: ${progress.diagnosticRecovery.sequence}`,
      `- Source phase: ${progress.diagnosticRecovery.sourcePhase}`,
      `- Resume phase: ${progress.diagnosticRecovery.resumePhase ?? 'none'}`,
      `- Parent scope: ${progress.diagnosticRecovery.parentScopeLabel}`,
      `- Blocked reason: ${progress.diagnosticRecovery.blockedReason ?? 'none'}`,
      `- Question: ${progress.diagnosticRecovery.question}`,
      `- Target: ${progress.diagnosticRecovery.target}`,
      `- Requested baseline: ${progress.diagnosticRecovery.requestedBaselineRef ?? 'defaulted'}`,
      `- Effective baseline: ${progress.diagnosticRecovery.effectiveBaselineRef ?? 'none'}`,
      `- Baseline source: ${progress.diagnosticRecovery.effectiveBaselineSource}`,
      `- Analysis artifact: ${progress.diagnosticRecovery.analysisArtifactPath}`,
      `- Recovery plan artifact: ${progress.diagnosticRecovery.recoveryPlanPath}`,
    );
    if (state.phase === 'diagnostic_recovery_adopt') {
      lines.push('- Next operator step: neal --diagnostic-decision [state-file] --action <adopt|reference|cancel>');
    }
  }

  if (progress.diagnosticRecoveryHistory) {
    lines.push(
      '',
      '## Diagnostic Recovery History',
      `- Sessions: ${progress.diagnosticRecoveryHistory.sessions}`,
      `- Latest decision: ${progress.diagnosticRecoveryHistory.lastDecision ?? 'none'}`,
      `- Latest result phase: ${progress.diagnosticRecoveryHistory.lastResultPhase ?? 'none'}`,
      `- Latest adopted plan: ${progress.diagnosticRecoveryHistory.lastAdoptedPlanPath ?? 'none'}`,
      `- Latest review artifact: ${progress.diagnosticRecoveryHistory.lastReviewArtifactPath ?? 'none'}`,
      `- Latest review rounds: ${progress.diagnosticRecoveryHistory.lastReviewRoundCount}`,
      `- Latest review findings: ${progress.diagnosticRecoveryHistory.lastReviewFindingCount}`,
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
