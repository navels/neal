import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OrchestrationState } from './types.js';

export function renderConsultMarkdown(state: OrchestrationState) {
  const lines = [
    '# Consult Session',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Phase: ${state.phase}`,
    `- Codex thread: ${state.codexThreadId ?? 'pending'}`,
    `- Claude session: ${state.claudeSessionId ?? 'pending'}`,
    '',
    '## Consult Rounds',
  ];

  if (state.consultRounds.length === 0) {
    lines.push('', 'No consult rounds yet.');
    return `${lines.join('\n')}\n`;
  }

  for (const round of state.consultRounds) {
    lines.push(
      '',
      `### Consult Round ${round.number}`,
      `- Source phase: ${round.sourcePhase}`,
      `- Codex thread: ${round.codexThreadId ?? 'pending'}`,
      `- Claude session: ${round.claudeSessionId ?? 'pending'}`,
      `- Summary: ${round.request.summary}`,
      `- Blocker: ${round.request.blocker}`,
      `- Question: ${round.request.question}`,
      `- Attempts: ${round.request.attempts.join(' | ') || 'n/a'}`,
      `- Relevant files: ${round.request.relevantFiles.join(', ') || 'n/a'}`,
      `- Verification context: ${round.request.verificationContext.join(' | ') || 'n/a'}`,
    );

    if (round.response) {
      lines.push(
        `- Claude summary: ${round.response.summary}`,
        `- Claude diagnosis: ${round.response.diagnosis}`,
        `- Claude confidence: ${round.response.confidence}`,
        `- Claude recoverable: ${round.response.recoverable ? 'yes' : 'no'}`,
        `- Claude recommendations: ${round.response.recommendations.join(' | ') || 'n/a'}`,
        `- Claude rationale: ${round.response.rationale}`,
      );
    } else {
      lines.push('- Claude response: pending');
    }

    if (round.disposition) {
      lines.push(
        `- Codex outcome: ${round.disposition.outcome}`,
        `- Codex decision: ${round.disposition.decision}`,
        `- Codex summary: ${round.disposition.summary}`,
        `- Codex blocker: ${round.disposition.blocker || 'n/a'}`,
        `- Codex rationale: ${round.disposition.rationale}`,
      );
    } else {
      lines.push('- Codex disposition: pending');
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeConsultMarkdown(path: string, state: OrchestrationState) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderConsultMarkdown(state), 'utf8');
}
