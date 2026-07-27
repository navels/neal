import { join } from 'node:path';

import { writeTextAtomic } from './atomic-write.js';
import { renderAdjudicationContractLines } from './adjudicator/artifacts.js';
import { formatPublicPhase } from './phase-display.js';
import {
  getCurrentScopeLabel,
  getExecutionPlanPath,
  getExecutionPlanScopeCountForShape,
  getParentScopeLabel,
  renderRecentAcceptedScopesSummary,
  renderScopeProgressSummary,
} from './scopes.js';
import { getDerivedPlanView, getFinalCompletionView } from './state-views.js';
import type { OrchestrationState } from './types.js';

function getDiscardedDiffPath(state: OrchestrationState) {
  if (!getDerivedPlanView(state)) {
    return null;
  }

  return join(state.runDir, `SCOPE_${state.currentScopeNumber}_DISCARDED.diff`);
}

function getReviewTarget(state: OrchestrationState) {
  const derivedPlan = getDerivedPlanView(state);
  if (derivedPlan) {
    return {
      path: derivedPlan.path,
      label: 'derived plan',
    };
  }

  return {
    path: getExecutionPlanPath(state),
    label: 'plan document',
  };
}

export function renderReviewMarkdown(state: OrchestrationState) {
  const reviewTarget = getReviewTarget(state);
  const derivedPlan = getDerivedPlanView(state);
  const finalCompletion = getFinalCompletionView(state);
  const lastReviewedPlanPath = state.rounds.at(-1)?.reviewedPlanPath ?? null;
  const parentScopeLabel = state.topLevelMode === 'execute' ? getParentScopeLabel(state) : null;
  const lines = [
    '# Review Session',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Review target: ${reviewTarget.path}`,
    `- Review target kind: ${reviewTarget.label}`,
    `- Last reviewed artifact: ${lastReviewedPlanPath ?? 'pending'}`,
    `- Scope: ${getCurrentScopeLabel(state)}`,
    `- Scope progress: ${renderScopeProgressSummary(state, getExecutionPlanScopeCountForShape(state.executionShape))}`,
    `- Current step: ${formatPublicPhase(state.phase)}`,
    `- Execution shape: ${state.executionShape ?? 'pending'}`,
    `- Coder session: ${state.coderSessionHandle ?? 'pending'}`,
    `- Base commit: ${state.baseCommit ?? 'unknown'}`,
    `- Final commit: ${state.finalCommit ?? 'pending'}`,
    `- Last marker: ${state.lastScopeMarker ?? 'pending'}`,
    `- Derived plan: ${derivedPlan?.path ?? 'none'}`,
    `- Derived plan status: ${derivedPlan?.status ?? 'none'}`,
    `- Derived from scope: ${derivedPlan?.parentScopeNumber ?? 'none'}`,
    `- Discarded WIP artifact: ${getDiscardedDiffPath(state) ?? 'none'}`,
  ];

  if (state.topLevelMode === 'execute') {
    lines.push(
      '',
      '## Meaningful Progress',
      `- Active parent objective: ${parentScopeLabel ?? 'none'}`,
    );

    if (state.currentScopeProgressJustification) {
      lines.push(
        `- Coder milestone: ${state.currentScopeProgressJustification.milestoneTargeted}`,
        `- New evidence: ${state.currentScopeProgressJustification.newEvidence}`,
        `- Why not redundant: ${state.currentScopeProgressJustification.whyNotRedundant}`,
        `- Next step unlocked: ${state.currentScopeProgressJustification.nextStepUnlocked}`,
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

    lines.push('', '### Recent Accepted Scope History');
    for (const line of renderRecentAcceptedScopesSummary(state, parentScopeLabel ?? String(state.currentScopeNumber)).split('\n')) {
      lines.push(line);
    }
  }

  const latestCompletedScope = state.completedScopes.at(-1) ?? null;
  if (latestCompletedScope) {
    lines.push(
      '',
      '## Latest Completed Scope',
      `- Scope: ${latestCompletedScope.number}`,
      `- Result: ${latestCompletedScope.result}`,
      `- Summary: ${latestCompletedScope.summary ?? 'none'}`,
      `- Commit subject: ${latestCompletedScope.commitSubject ?? 'pending'}`,
      `- Replaced by derived plan: ${latestCompletedScope.replacedByDerivedPlanPath ?? 'none'}`,
    );
  }

  const contractLines = renderAdjudicationContractLines(state);
  if (contractLines.length > 0) {
    lines.push('', ...contractLines);
  }

  if (finalCompletion?.summary) {
    lines.push(
      '',
      '## Final Completion Summary',
      `- Plan goal satisfied: ${finalCompletion.summary.planGoalSatisfied ? 'yes' : 'no'}`,
      `- What changed overall: ${finalCompletion.summary.whatChangedOverall}`,
      `- Verification summary: ${finalCompletion.summary.verificationSummary}`,
    );

    if (finalCompletion.summary.remainingKnownGaps.length > 0) {
      lines.push('- Remaining known gaps:');
      for (const gap of finalCompletion.summary.remainingKnownGaps) {
        lines.push(`  - ${gap}`);
      }
    } else {
      lines.push('- Remaining known gaps: none');
    }
  }

  if (finalCompletion?.reviewVerdict) {
    lines.push(
      '',
      '## Final Completion Review',
      `- Reviewer action: ${finalCompletion.reviewVerdict.action}`,
      `- Resulting action: ${finalCompletion.effectiveAction ?? finalCompletion.reviewVerdict.action}`,
      `- Reviewer summary: ${finalCompletion.reviewVerdict.summary}`,
      `- Reviewer rationale: ${finalCompletion.reviewVerdict.rationale}`,
      `- Continue-execution cycles used: ${finalCompletion.continueExecutionCount}`,
      `- Continue-execution cap reached: ${finalCompletion.continueExecutionCapReached ? 'yes' : 'no'}`,
    );

    if (finalCompletion.reviewVerdict.missingWork) {
      lines.push(
        `- Missing work summary: ${finalCompletion.reviewVerdict.missingWork.summary}`,
        `- Missing work required outcome: ${finalCompletion.reviewVerdict.missingWork.requiredOutcome}`,
        `- Missing work verification: ${finalCompletion.reviewVerdict.missingWork.verification}`,
      );
    } else {
      lines.push('- Missing work: none');
    }
  }

  lines.push('', '## Review Rounds');

  if (state.rounds.length === 0) {
    lines.push('', 'No review rounds yet.');
  } else {
    for (const round of state.rounds) {
      const normalizationStatus = round.normalizationApplied
        ? round.normalizationOperations.length > 0
          ? round.normalizationOperations.join(' | ')
          : 'applied'
        : 'none';
      const scopeMappings =
        round.normalizationScopeLabelMappings.length > 0
          ? round.normalizationScopeLabelMappings
              .map((mapping) => `${mapping.originalScopeLabel} -> ${mapping.normalizedScopeNumber}`)
              .join(', ')
          : 'none';
      lines.push(
        '',
        `### Round ${round.round}`,
        `- Reviewed artifact: ${round.reviewedPlanPath ?? 'unknown'}`,
        `- Normalization: ${normalizationStatus}`,
        `- Scope label mappings: ${scopeMappings}`,
        `- Reviewer session: ${round.reviewerSessionHandle ?? 'pending'}`,
        `- Open blocking canonicals: ${round.openBlockingCanonicalCount}`,
        `- Findings: ${round.findings.join(', ') || 'none'}`,
      );
    }
  }

  lines.push(
    '',
    '## Findings',
  );

  if (state.findings.length === 0) {
    lines.push('', 'No findings yet.');
  } else {
    const rounds = [...new Set(state.findings.map((finding) => finding.round))].sort((a, b) => a - b);

    for (const round of rounds) {
      lines.push('', `## Round ${round} Findings`);

      for (const finding of state.findings.filter((item) => item.round === round)) {
        lines.push(
          '',
          `### ${finding.id}`,
          `- Canonical ID: ${finding.canonicalId}`,
          `- Source: ${finding.source}`,
          `- Severity: ${finding.severity}`,
          // 'n/a' keeps execute-review findings (which carry no class)
          // semantically unchanged rather than mislabeling them plan_correctness.
          `- Finding class: ${finding.findingClass ?? 'n/a'}`,
          `- Status: ${finding.status}`,
          `- Files: ${finding.files.join(', ') || 'n/a'}`,
          `- Claim: ${finding.claim}`,
          `- Evidence: ${finding.evidence?.trim() || 'n/a'}`,
          `- Required action: ${finding.requiredAction}`,
          `- Round summary: ${finding.roundSummary}`,
          `- Coder disposition: ${finding.coderDisposition ?? 'pending'}`,
          `- Coder commit: ${finding.coderCommit ?? 'pending'}`,
        );
      }
    }
  }

  lines.push('', '## Plan Review Debt');
  appendPlanReviewDebtGroup(lines, 'Inherited', state.inheritedPlanReviewDebt);
  appendPlanReviewDebtGroup(lines, 'Current', state.planReviewDebt);

  return `${lines.join('\n')}\n`;
}

function appendPlanReviewDebtGroup(
  lines: string[],
  label: 'Inherited' | 'Current',
  items: OrchestrationState['planReviewDebt'],
) {
  lines.push('', `### ${label}`);
  if (items.length === 0) {
    lines.push('- none');
    return;
  }
  for (const item of items) {
    lines.push(
      `- ${item.canonicalId}: findingClass=${item.findingClass ?? 'n/a'}; originRound=${item.originRound ?? 'n/a'}; claim=${item.claim}; requiredAction=${item.requiredAction}; coderDisposition=${item.coderDisposition ?? 'none'}`,
    );
  }
}

export async function writeReviewMarkdown(path: string, state: OrchestrationState) {
  await writeTextAtomic(path, renderReviewMarkdown(state));
}
