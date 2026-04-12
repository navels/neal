import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OrchestrationState } from './types.js';

export function renderReviewMarkdown(state: OrchestrationState) {
  const lines = [
    '# Review Session',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Phase: ${state.phase}`,
    `- Codex thread: ${state.codexThreadId ?? 'pending'}`,
    `- Base commit: ${state.baseCommit ?? 'unknown'}`,
    `- Final commit: ${state.finalCommit ?? 'pending'}`,
    '',
    '## Findings',
  ];

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
          `- Severity: ${finding.severity}`,
          `- Status: ${finding.status}`,
          `- Files: ${finding.files.join(', ') || 'n/a'}`,
          `- Claim: ${finding.claim}`,
          `- Required action: ${finding.requiredAction}`,
          `- Round summary: ${finding.roundSummary}`,
          `- Codex disposition: ${finding.codexDisposition ?? 'pending'}`,
          `- Codex commit: ${finding.codexCommit ?? 'pending'}`,
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
