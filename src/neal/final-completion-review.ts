import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { renderAdjudicationContractLines } from './adjudicator/artifacts.js';
import { renderInteractiveBlockedRecoveryHistoryLines } from './recovery-artifacts.js';
import { getCurrentScopeLabel, getExecutionPlanScopeCountForShape, renderScopeProgressSummary } from './scopes.js';
import type { OrchestrationState } from './types.js';

export function getFinalCompletionReviewArtifactPath(runDir: string) {
  return join(runDir, 'FINAL_COMPLETION_REVIEW.md');
}

export function renderFinalCompletionReviewMarkdown(state: OrchestrationState) {
  const lines = [
    '# Final Completion Review',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Phase: ${state.phase}`,
    `- Status: ${state.status}`,
    `- Execution shape: ${state.executionShape ?? 'pending'}`,
    `- Current scope: ${getCurrentScopeLabel(state)}`,
    `- Scope progress: ${renderScopeProgressSummary(state, getExecutionPlanScopeCountForShape(state.executionShape))}`,
    `- Final commit: ${state.finalCommit ?? 'pending'}`,
    `- Last marker: ${state.lastScopeMarker ?? 'pending'}`,
    `- Reviewer session: ${state.reviewerSessionHandle ?? 'pending'}`,
    `- Continue-execution cycles used: ${state.finalCompletionContinueExecutionCount}`,
    `- Continue-execution cap reached: ${state.finalCompletionContinueExecutionCapReached ? 'yes' : 'no'}`,
  ];

  lines.push('', '## Coder Completion Summary');
  if (!state.finalCompletionSummary) {
    lines.push('', 'Pending.');
  } else {
    lines.push(
      `- Plan goal satisfied: ${state.finalCompletionSummary.planGoalSatisfied ? 'yes' : 'no'}`,
      `- What changed overall: ${state.finalCompletionSummary.whatChangedOverall}`,
      `- Verification summary: ${state.finalCompletionSummary.verificationSummary}`,
    );

    if (state.finalCompletionSummary.remainingKnownGaps.length > 0) {
      lines.push('- Remaining known gaps:');
      for (const gap of state.finalCompletionSummary.remainingKnownGaps) {
        lines.push(`  - ${gap}`);
      }
    } else {
      lines.push('- Remaining known gaps: none');
    }
  }

  const contractLines = renderAdjudicationContractLines(state);
  if (contractLines.length > 0) {
    lines.push('', ...contractLines);
  }

  lines.push(...renderInteractiveBlockedRecoveryHistoryLines(state.interactiveBlockedRecoveryHistory));

  lines.push('', '## Reviewer Verdict');
  if (!state.finalCompletionReviewVerdict) {
    lines.push('', 'Pending.');
  } else {
    lines.push(
      `- Reviewer action: ${state.finalCompletionReviewVerdict.action}`,
      `- Resulting action: ${state.finalCompletionResolvedAction ?? state.finalCompletionReviewVerdict.action}`,
      `- Reviewer summary: ${state.finalCompletionReviewVerdict.summary}`,
      `- Reviewer rationale: ${state.finalCompletionReviewVerdict.rationale}`,
    );

    if (state.finalCompletionReviewVerdict.missingWork) {
      lines.push(
        `- Missing work summary: ${state.finalCompletionReviewVerdict.missingWork.summary}`,
        `- Missing work required outcome: ${state.finalCompletionReviewVerdict.missingWork.requiredOutcome}`,
        `- Missing work verification: ${state.finalCompletionReviewVerdict.missingWork.verification}`,
      );
    } else {
      lines.push('- Missing work: none');
    }
  }

  lines.push('', '## Result');
  if (!state.finalCompletionReviewVerdict) {
    lines.push('', 'Final completion review has not settled yet.');
  } else if (state.finalCompletionResolvedAction === 'accept_complete') {
    lines.push('', 'Run completed cleanly.');
  } else if (state.finalCompletionResolvedAction === 'continue_execution') {
    lines.push('', 'Execution reopened with one explicit follow-on scope.');
  } else {
    lines.push('', 'Run blocked for operator guidance.');
  }

  return `${lines.join('\n')}\n`;
}

export async function writeFinalCompletionReviewMarkdown(path: string, state: OrchestrationState) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderFinalCompletionReviewMarkdown(state), 'utf8');
}
