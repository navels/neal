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
    `- Coder session: ${state.coderSessionHandle ?? 'pending'}`,
    `- Reviewer session: ${state.reviewerSessionHandle ?? 'pending'}`,
    '',
    '## Consult Rounds',
  ];

  if (state.interactiveBlockedRecovery) {
    lines.push(
      '',
      '## Interactive Blocked Recovery',
      `- Source phase: ${state.interactiveBlockedRecovery.sourcePhase}`,
      `- Blocked reason: ${state.interactiveBlockedRecovery.blockedReason}`,
      `- Max turns: ${state.interactiveBlockedRecovery.maxTurns}`,
    );

    if (state.interactiveBlockedRecovery.turns.length === 0) {
      lines.push('- Operator guidance: pending');
    } else {
      for (const turn of state.interactiveBlockedRecovery.turns) {
        lines.push(
          `- Recovery turn ${turn.number} at ${turn.recordedAt}: ${turn.operatorGuidance}`,
        );
      }
    }
  }

  if (state.consultRounds.length === 0) {
    lines.push('', 'No consult rounds yet.');
    return `${lines.join('\n')}\n`;
  }

  for (const round of state.consultRounds) {
    lines.push(
      '',
      `### Consult Round ${round.number}`,
      `- Source phase: ${round.sourcePhase}`,
      `- Coder session: ${round.coderSessionHandle ?? 'pending'}`,
      `- Reviewer session: ${round.reviewerSessionHandle ?? 'pending'}`,
      `- Summary: ${round.request.summary}`,
      `- Blocker: ${round.request.blocker}`,
      `- Question: ${round.request.question}`,
      `- Attempts: ${round.request.attempts.join(' | ') || 'n/a'}`,
      `- Relevant files: ${round.request.relevantFiles.join(', ') || 'n/a'}`,
      `- Verification context: ${round.request.verificationContext.join(' | ') || 'n/a'}`,
    );

    if (round.response) {
      lines.push(
        `- Reviewer summary: ${round.response.summary}`,
        `- Reviewer diagnosis: ${round.response.diagnosis}`,
        `- Reviewer confidence: ${round.response.confidence}`,
        `- Reviewer recoverable: ${round.response.recoverable ? 'yes' : 'no'}`,
        `- Reviewer recommendations: ${round.response.recommendations.join(' | ') || 'n/a'}`,
        `- Reviewer rationale: ${round.response.rationale}`,
      );
    } else {
      lines.push('- Reviewer response: pending');
    }

    if (round.disposition) {
      lines.push(
        `- Coder outcome: ${round.disposition.outcome}`,
        `- Coder decision: ${round.disposition.decision}`,
        `- Coder summary: ${round.disposition.summary}`,
        `- Coder blocker: ${round.disposition.blocker || 'n/a'}`,
        `- Coder rationale: ${round.disposition.rationale}`,
      );
    } else {
      lines.push('- Coder disposition: pending');
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeConsultMarkdown(path: string, state: OrchestrationState) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderConsultMarkdown(state), 'utf8');
}
