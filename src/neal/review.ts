import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getCurrentScopeLabel, getExecutionPlanPath } from './scopes.js';
import type { OrchestrationState } from './types.js';

function getDiscardedDiffPath(state: OrchestrationState) {
  if (!state.derivedPlanPath) {
    return null;
  }

  return join(state.runDir, `SCOPE_${state.currentScopeNumber}_DISCARDED.diff`);
}

export function renderReviewMarkdown(state: OrchestrationState) {
  const reviewTarget = state.derivedPlanPath ?? getExecutionPlanPath(state);
  const lastReviewedPlanPath = state.rounds.at(-1)?.reviewedPlanPath ?? null;
  const lines = [
    '# Review Session',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Review target: ${reviewTarget}`,
    `- Last reviewed artifact: ${lastReviewedPlanPath ?? 'pending'}`,
    `- Scope: ${getCurrentScopeLabel(state)}`,
    `- Phase: ${state.phase}`,
    `- Execution shape: ${state.executionShape ?? 'pending'}`,
    `- Coder session: ${state.coderSessionHandle ?? 'pending'}`,
    `- Base commit: ${state.baseCommit ?? 'unknown'}`,
    `- Final commit: ${state.finalCommit ?? 'pending'}`,
    `- Last marker: ${state.lastScopeMarker ?? 'pending'}`,
    `- Derived plan: ${state.derivedPlanPath ?? 'none'}`,
    `- Derived plan status: ${state.derivedPlanStatus ?? 'none'}`,
    `- Derived from scope: ${state.derivedFromScopeNumber ?? 'none'}`,
    `- Discarded WIP artifact: ${getDiscardedDiffPath(state) ?? 'none'}`,
    '',
    '## Review Rounds',
  ];

  if (state.rounds.length === 0) {
    lines.push('', 'No review rounds yet.');
  } else {
    for (const round of state.rounds) {
      lines.push(
        '',
        `### Round ${round.round}`,
        `- Reviewed artifact: ${round.reviewedPlanPath ?? 'unknown'}`,
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
          `- Status: ${finding.status}`,
          `- Files: ${finding.files.join(', ') || 'n/a'}`,
          `- Claim: ${finding.claim}`,
          `- Required action: ${finding.requiredAction}`,
          `- Round summary: ${finding.roundSummary}`,
          `- Coder disposition: ${finding.coderDisposition ?? 'pending'}`,
          `- Coder commit: ${finding.coderCommit ?? 'pending'}`,
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeReviewMarkdown(path: string, state: OrchestrationState) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderReviewMarkdown(state), 'utf8');
}
