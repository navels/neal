import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeTextAtomic } from './atomic-write.js';
import { renderAdjudicationContractLines } from './adjudicator/artifacts.js';
import { formatPublicPhase } from './phase-display.js';
import { renderInteractiveBlockedRecoveryHistoryLines } from './recovery-artifacts.js';
import {
  buildScopeAccountingSummary,
  getCurrentScopeLabel,
  getExecutionPlanScopeCountForShape,
  renderScopeProgressSummary,
} from './scopes.js';
import { getFinalCompletionView } from './state-views.js';
import { formatSquashMessage } from './squash-message.js';
import type { OrchestrationState, ProgressScope } from './types.js';

export type FinalCompletionUnstructuredOutput = {
  source: 'coder_summary' | 'reviewer_verdict';
  text: string;
  ambiguousMatch?: boolean;
};

export type FinalCompletionReviewRenderOptions = {
  unstructuredOutput?: FinalCompletionUnstructuredOutput | null;
};

export function getFinalCompletionReviewArtifactPath(runDir: string) {
  return join(runDir, 'FINAL_COMPLETION_REVIEW.md');
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function readFinalCompletionUnstructuredOutput(args: {
  runDir: string;
  source: FinalCompletionUnstructuredOutput['source'];
  sessionHandle: string | null;
}): Promise<FinalCompletionUnstructuredOutput | null> {
  let content: string;
  try {
    content = await readFile(join(args.runDir, 'events.ndjson'), 'utf8');
  } catch {
    return null;
  }

  const matchedTexts: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let event: { type?: unknown; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as { type?: unknown; data?: Record<string, unknown> };
    } catch {
      continue;
    }

    const data = event.data ?? {};
    if (
      event.type !== 'provider.assistant_text' ||
      data.provider !== 'anthropic-claude' ||
      data.role !== 'structured-advisor' ||
      data.label !== 'final-completion'
    ) {
      continue;
    }

    const eventSessionHandle = stringValue(data.sessionHandle);
    if (args.sessionHandle && eventSessionHandle !== args.sessionHandle) {
      continue;
    }

    const text = stringValue(data.text);
    if (text) {
      matchedTexts.push(text);
    }
  }

  if (!matchedTexts.length) {
    return null;
  }

  return {
    source: args.source,
    text: matchedTexts.join('\n'),
    ambiguousMatch: !args.sessionHandle,
  };
}

function collectResidualReviewDebt(scopes: ProgressScope[]) {
  return scopes.flatMap((scope) =>
    (scope.residualReviewDebt ?? []).map((item) => ({
      scope: scope.number,
      ...item,
    })),
  );
}

export function renderFinalCompletionReviewMarkdown(
  state: OrchestrationState,
  options: FinalCompletionReviewRenderOptions = {},
) {
  const finalCompletion = getFinalCompletionView(state);
  const summary = finalCompletion?.summary ?? null;
  const reviewVerdict = finalCompletion?.reviewVerdict ?? null;
  const residualDebt = collectResidualReviewDebt(state.completedScopes.filter((scope) => scope.result === 'accepted'));
  const scopeAccounting = buildScopeAccountingSummary(state.completedScopes);
  const lines = [
    '# Final Completion Review',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Current step: ${formatPublicPhase(state.phase)}`,
    `- Status: ${state.status}`,
    `- Execution shape: ${state.executionShape ?? 'pending'}`,
    `- Current scope: ${getCurrentScopeLabel(state)}`,
    `- Scope progress: ${renderScopeProgressSummary(state, getExecutionPlanScopeCountForShape(state.executionShape))}`,
    `- Final commit: ${state.finalCommit ?? 'pending'}`,
    `- Last marker: ${state.lastScopeMarker ?? 'pending'}`,
    `- Reviewer session: ${state.reviewerSessionHandle ?? 'pending'}`,
    `- Continue-execution cycles used: ${finalCompletion?.continueExecutionCount ?? 0}`,
    `- Continue-execution cap reached: ${finalCompletion?.continueExecutionCapReached ? 'yes' : 'no'}`,
  ];

  lines.push('', '## Coder Completion Summary');
  if (!summary) {
    lines.push('', 'Pending.');
  } else {
    lines.push(
      `- Plan goal satisfied: ${summary.planGoalSatisfied ? 'yes' : 'no'}`,
      `- What changed overall: ${summary.whatChangedOverall}`,
      `- Verification summary: ${summary.verificationSummary}`,
    );

    if (summary.remainingKnownGaps.length > 0) {
      lines.push('- Remaining known gaps:');
      for (const gap of summary.remainingKnownGaps) {
        lines.push(`  - ${gap}`);
      }
    } else {
      lines.push('- Remaining known gaps: none');
    }
  }

  if (options.unstructuredOutput?.source === 'coder_summary') {
    lines.push(
      '',
      '## Unstructured Coder Summary Output',
      '',
      'Claude returned this prose but failed to provide SDK structured output.',
    );
    if (options.unstructuredOutput.ambiguousMatch) {
      lines.push('', 'This prose was selected without a failed-session handle, so the match may be ambiguous.');
    }
    lines.push('', options.unstructuredOutput.text);
  }

  const contractLines = renderAdjudicationContractLines(state);
  if (contractLines.length > 0) {
    lines.push('', ...contractLines);
  }

  lines.push(...renderInteractiveBlockedRecoveryHistoryLines(state.interactiveBlockedRecoveryHistory));

  lines.push(
    '',
    '## Scope Accounting',
    `- ${scopeAccounting.summary}`,
  );
  if (scopeAccounting.replacedParentScopes.length > 0) {
    lines.push('- Derived parent replacements:');
    for (const replacement of scopeAccounting.replacedParentScopes) {
      lines.push(`  - Scope ${replacement.number}: ${replacement.derivedPlanPath}`);
    }
  } else {
    lines.push('- Derived parent replacements: none');
  }

  lines.push('', '## Residual Review Debt');
  if (residualDebt.length === 0) {
    lines.push('', 'No unresolved non-blocking review debt was recorded for accepted scopes.');
  } else {
    lines.push(
      '',
      'The final reviewer should decide whether these accepted-scope leftovers are acceptable residual polish or evidence that execution exited too early.',
    );
    for (const item of residualDebt) {
      const files = item.files.length > 0 ? item.files.join(', ') : 'n/a';
      lines.push(
        '',
        `### Scope ${item.scope} ${item.id}`,
        `- Status: ${item.status}`,
        `- Files: ${files}`,
        `- Claim: ${item.claim}`,
        `- Evidence: ${item.evidence?.trim() || 'n/a'}`,
        `- Required action: ${item.requiredAction}`,
        `- Coder disposition: ${item.coderDisposition ?? 'pending'}`,
        `- Coder commit: ${item.coderCommit ?? 'pending'}`,
      );
    }
  }

  lines.push('', '## Reviewer Verdict');
  if (!reviewVerdict) {
    lines.push('', 'Pending.');
  } else {
    lines.push(
      `- Reviewer action: ${reviewVerdict.action}`,
      `- Resulting action: ${finalCompletion?.effectiveAction ?? reviewVerdict.action}`,
      `- Reviewer summary: ${reviewVerdict.summary}`,
      `- Reviewer rationale: ${reviewVerdict.rationale}`,
    );

    if (reviewVerdict.missingWork) {
      lines.push(
        `- Missing work summary: ${reviewVerdict.missingWork.summary}`,
        `- Missing work required outcome: ${reviewVerdict.missingWork.requiredOutcome}`,
        `- Missing work verification: ${reviewVerdict.missingWork.verification}`,
      );
    } else {
      lines.push('- Missing work: none');
    }
  }

  if (options.unstructuredOutput?.source === 'reviewer_verdict') {
    lines.push(
      '',
      '## Unstructured Reviewer Output',
      '',
      'Claude returned this prose but failed to provide SDK structured output.',
    );
    if (options.unstructuredOutput.ambiguousMatch) {
      lines.push('', 'This prose was selected without a failed-session handle, so the match may be ambiguous.');
    }
    lines.push('', options.unstructuredOutput.text);
  }

  lines.push('', '## Squash Commit Message Draft');
  if (!reviewVerdict) {
    lines.push('', 'Pending.');
  } else if (!reviewVerdict.squashCommitMessage && reviewVerdict.action === 'accept_complete') {
    lines.push(
      '',
      'No reviewer-authored squash draft recorded. If squash is requested, Neal will derive the squash message from deterministic fallback generation.',
    );
  } else if (!reviewVerdict.squashCommitMessage) {
    lines.push('', 'None recorded.');
  } else {
    lines.push('', '```text', formatSquashMessage(reviewVerdict.squashCommitMessage), '```');
  }

  lines.push('', '## Result');
  if (!reviewVerdict) {
    lines.push('', 'Final completion review has not settled yet.');
  } else if (finalCompletion?.acceptedComplete) {
    lines.push('', 'Run completed cleanly.');
  } else if (finalCompletion?.continuesExecution) {
    lines.push('', 'Execution reopened with one explicit follow-on scope.');
  } else {
    lines.push('', 'Run blocked for operator guidance.');
  }

  return `${lines.join('\n')}\n`;
}

export async function writeFinalCompletionReviewMarkdown(
  path: string,
  state: OrchestrationState,
  options: FinalCompletionReviewRenderOptions = {},
) {
  await writeTextAtomic(path, renderFinalCompletionReviewMarkdown(state, options));
}
