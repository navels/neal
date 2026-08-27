import { basename } from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from './atomic-write.js';
import { renderAdjudicationContractLines } from './adjudicator/artifacts.js';
import { formatPublicPhase } from './phase-display.js';
import { summarizeInteractiveBlockedRecoveryHistory } from './recovery-artifacts.js';
import { getRunDisplayStatus, type EffectiveRunStatus } from './run-status.js';
import {
  buildScopeAccountingSummary,
  getExecutionPlanScopeCountForShape,
  getCurrentScopeLabel,
  getParentScopeLabel,
  getRecentAcceptedScopesForParentObjective,
  renderScopeProgressSummary,
  renderRecentAcceptedScopesSummary,
} from './scopes.js';
import { getDerivedPlanCountersView, getDerivedPlanView, getFinalCompletionView } from './state-views.js';
import type { OrchestrationState, ProgressScope, ResidualReviewDebtItem, ScopeAccountingSummary } from './types.js';

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
  lastBlockedReason: string | null;
  lastOperatorGuidance: string | null;
  lastCoderSummary: string | null;
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

type ResidualReviewDebtSummary = {
  open: number;
  deferred: number;
  nonResidualFindings: number;
  items: (ResidualReviewDebtItem & { scope: string })[];
};

type ManualGateProgressSummary = {
  id: string;
  title: string;
  reason: string;
  instructionsPath: string;
  resumeCommand: string;
  lastCheckedAt: string | null;
  lastFailure: NonNullable<OrchestrationState['manualGate']>['lastFailure'];
};

type PlanProgressState = {
  version: 1;
  planDoc: string;
  status: OrchestrationState['status'];
  effectiveStatus: EffectiveRunStatus;
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
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
    progress: string;
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
  residualReviewDebt: ResidualReviewDebtSummary;
  interactiveBlockedRecovery: InteractiveBlockedRecoverySummary | null;
  interactiveBlockedRecoveryHistory: InteractiveBlockedRecoveryHistorySummary | null;
  manualGate: ManualGateProgressSummary | null;
  scopeAccounting: ScopeAccountingSummary;
  completedScopes: OrchestrationState['completedScopes'];
};

function buildResidualReviewDebtSummary(scopes: ProgressScope[]): ResidualReviewDebtSummary {
  const items = scopes.flatMap((scope) =>
    (scope.residualReviewDebt ?? []).map((item) => ({
      scope: scope.number,
      ...item,
    })),
  );
  return {
    open: items.filter((item) => item.status === 'open').length,
    deferred: items.filter((item) => item.status === 'deferred').length,
    nonResidualFindings: scopes.reduce(
      (total, scope) => total + Math.max(scope.findings - (scope.residualReviewDebt?.length ?? 0), 0),
      0,
    ),
    items,
  };
}

function buildPlanProgressState(state: OrchestrationState): PlanProgressState {
  const displayStatus = getRunDisplayStatus(state);
  const derivedPlan = getDerivedPlanView(state);
  const derivedPlanCounters = getDerivedPlanCountersView(state);
  const finalCompletion = getFinalCompletionView(state);
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
    effectiveStatus: displayStatus.effectiveStatus,
    waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
    pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
    executionShape: state.executionShape,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finalCommit: state.finalCommit,
    finalCompletionSummary: finalCompletion?.summary ?? null,
    finalCompletionReviewVerdict: finalCompletion?.reviewVerdict ?? null,
    finalCompletionResolvedAction: finalCompletion?.resolvedAction ?? null,
    finalCompletionContinueExecutionCount: finalCompletion?.continueExecutionCount ?? 0,
    finalCompletionContinueExecutionCapReached: finalCompletion?.continueExecutionCapReached ?? false,
    currentScope:
      state.status === 'done'
        ? null
        : {
            number: getCurrentScopeLabel(state),
            progress: renderScopeProgressSummary(state, getExecutionPlanScopeCountForShape(state.executionShape)),
            parentScope: derivedPlan?.executing ? getParentScopeLabel(state) : null,
            phase: state.phase,
            marker: state.lastScopeMarker,
            baseCommit: state.baseCommit,
            derivedPlanPath: derivedPlan?.path ?? null,
            derivedPlanStatus: derivedPlan?.status ?? null,
            splitPlanCount: derivedPlanCounters.splitPlanCountForCurrentScope,
            derivedPlanDepth: derivedPlanCounters.derivedPlanDepth,
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
    residualReviewDebt: buildResidualReviewDebtSummary(state.completedScopes.filter((scope) => scope.result === 'accepted')),
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
    interactiveBlockedRecoveryHistory: summarizeInteractiveBlockedRecoveryHistory(state.interactiveBlockedRecoveryHistory),
    manualGate: summarizeManualGate(state),
    scopeAccounting: buildScopeAccountingSummary(state.completedScopes),
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

function pushResidualReviewDebtLines(lines: string[], debt: ResidualReviewDebtSummary) {
  lines.push(
    '',
    '## Residual Review Debt',
    `- Open non-blocking findings: ${debt.open}`,
    `- Deferred non-blocking findings: ${debt.deferred}`,
    `- Non-residual findings (all severities): ${debt.nonResidualFindings}`,
  );

  if (debt.items.length === 0) {
    lines.push('- Items: none');
    return;
  }

  lines.push('- Items:');
  for (const item of debt.items) {
    const files = item.files.length > 0 ? item.files.join(', ') : 'n/a';
    lines.push(`  - Scope ${item.scope} ${item.id} (${item.status}): ${item.claim}`);
    lines.push(`    Files: ${files}`);
    lines.push(`    Required action: ${item.requiredAction}`);
    lines.push(`    Coder disposition: ${item.coderDisposition ?? 'pending'}`);
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
    `- Effective status: ${progress.effectiveStatus}`,
    `- Waiting for operator guidance: ${progress.waitingForOperatorGuidance ? 'yes' : 'no'}`,
    `- Pending operator guidance: ${progress.pendingOperatorGuidance ? 'yes' : 'no'}`,
    `- Execution shape: ${progress.executionShape ?? 'pending'}`,
    `- Final commit: ${progress.finalCommit ?? 'pending'}`,
  ];

  if (progress.currentScope) {
    lines.push(
      '',
      '## Current Scope',
      `- Number: ${progress.currentScope.number}`,
      `- Progress: ${progress.currentScope.progress}`,
      `- Parent scope: ${progress.currentScope.parentScope ?? 'none'}`,
      `- Current step: ${formatPublicPhase(progress.currentScope.phase)}`,
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

  if (state.topLevelMode === 'execute') {
    pushResidualReviewDebtLines(lines, progress.residualReviewDebt);
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
      `- Source step: ${formatPublicPhase(progress.interactiveBlockedRecovery.sourcePhase)}`,
      `- Blocked reason: ${progress.interactiveBlockedRecovery.blockedReason}`,
      `- Recorded turns: ${progress.interactiveBlockedRecovery.turns}`,
      `- Handled turns: ${progress.interactiveBlockedRecovery.handledTurns}`,
      `- Remaining turns: ${progress.interactiveBlockedRecovery.remainingTurns}`,
      `- Pending directive: ${progress.interactiveBlockedRecovery.pendingDirective ?? 'none'}`,
      `- Waiting for operator guidance: ${progress.waitingForOperatorGuidance ? 'yes' : 'no'}`,
      `- Pending operator guidance: ${progress.pendingOperatorGuidance ? 'yes' : 'no'}`,
    );
  }

  if (progress.interactiveBlockedRecoveryHistory) {
    lines.push(
      '',
      '## Interactive Blocked Recovery History',
      `- Sessions: ${progress.interactiveBlockedRecoveryHistory.sessions}`,
      `- Latest action: ${progress.interactiveBlockedRecoveryHistory.lastAction ?? 'none'}`,
      `- Latest result step: ${
        progress.interactiveBlockedRecoveryHistory.lastResultPhase
          ? formatPublicPhase(progress.interactiveBlockedRecoveryHistory.lastResultPhase)
          : 'none'
      }`,
      `- Latest blocked reason: ${progress.interactiveBlockedRecoveryHistory.lastBlockedReason ?? 'none'}`,
      `- Latest operator guidance: ${progress.interactiveBlockedRecoveryHistory.lastOperatorGuidance ?? 'none'}`,
      `- Latest coder summary: ${progress.interactiveBlockedRecoveryHistory.lastCoderSummary ?? 'none'}`,
    );
  }

  if (progress.manualGate) {
    lines.push(
      '',
      '## Manual Gate',
      `- ID: ${progress.manualGate.id}`,
      `- Title: ${progress.manualGate.title}`,
      `- Reason: ${progress.manualGate.reason}`,
      `- Instructions: ${progress.manualGate.instructionsPath}`,
      `- Resume command: ${progress.manualGate.resumeCommand}`,
      `- Last checked: ${progress.manualGate.lastCheckedAt ?? 'never'}`,
    );
    if (progress.manualGate.lastFailure) {
      lines.push(
        `- Last failure check: ${progress.manualGate.lastFailure.checkName}`,
        `- Last failure exit code: ${progress.manualGate.lastFailure.exitCode ?? 'none'}`,
        `- Last failure signal: ${progress.manualGate.lastFailure.signal ?? 'none'}`,
        `- Last failure stdout tail: ${progress.manualGate.lastFailure.stdoutTail || 'empty'}`,
        `- Last failure stderr tail: ${progress.manualGate.lastFailure.stderrTail || 'empty'}`,
      );
    } else {
      lines.push('- Last failure: none');
    }
  }

  lines.push(
    '',
    '## Scope Accounting',
    `- ${progress.scopeAccounting.summary}`,
  );
  if (progress.scopeAccounting.replacedParentScopes.length > 0) {
    lines.push('- Derived parent replacements:');
    for (const replacement of progress.scopeAccounting.replacedParentScopes) {
      lines.push(`  - Scope ${replacement.number}: ${replacement.derivedPlanPath}`);
    }
  } else {
    lines.push('- Derived parent replacements: none');
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
        `- Summary: ${scope.summary ?? 'none'}`,
        `- Commit subject: ${scope.commitSubject ?? 'pending'}`,
        `- Review rounds: ${scope.reviewRounds}`,
        `- Findings: ${scope.findings}`,
        `- Residual open/deferred non-blocking findings: ${scope.residualReviewDebt?.length ?? 0}`,
        `- Archived review: ${scope.archivedReviewPath ?? 'pending'}`,
        `- Blocker: ${scope.blocker ?? 'none'}`,
        `- Parent scope: ${scope.derivedFromParentScope ?? 'none'}`,
        `- Replaced by derived plan: ${scope.replacedByDerivedPlanPath ?? 'none'}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function summarizeManualGate(state: OrchestrationState): ManualGateProgressSummary | null {
  const gate = state.phase === 'manual_gate' ? state.manualGate : null;
  if (!gate) {
    return null;
  }
  return {
    id: gate.id,
    title: gate.title,
    reason: gate.reason,
    instructionsPath: gate.instructionsPath,
    resumeCommand: `neal resume --run ${basename(state.runDir)}`,
    lastCheckedAt: gate.lastCheckedAt,
    lastFailure: gate.lastFailure,
  };
}

export async function writePlanProgressArtifacts(state: OrchestrationState) {
  const progress = buildPlanProgressState(state);
  await writeJsonAtomic(state.progressJsonPath, progress);
  await writeTextAtomic(state.progressMarkdownPath, renderPlanProgressMarkdown(state));
}
