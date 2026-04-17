import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getCurrentScopeLabel, getExecutionPlanPath, getParentScopeLabel, renderRecentAcceptedScopesSummary } from './scopes.js';
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
  const parentScopeLabel = state.topLevelMode === 'execute' ? getParentScopeLabel(state) : null;
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
