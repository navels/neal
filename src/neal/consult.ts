import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OrchestrationState } from './types.js';

function appendInteractiveBlockedRecoverySection(
  lines: string[],
  title: string,
  recovery: NonNullable<OrchestrationState['interactiveBlockedRecovery']> | OrchestrationState['interactiveBlockedRecoveryHistory'][number],
  options?: {
    resolvedAt?: string;
    resolvedByAction?: string;
    resultPhase?: string;
  },
) {
  lines.push(
    '',
    title,
    `- Source phase: ${recovery.sourcePhase}`,
    `- Blocked reason: ${recovery.blockedReason}`,
    `- Max turns: ${recovery.maxTurns}`,
  );

  if (options?.resolvedAt && options.resolvedByAction && options.resultPhase) {
    lines.push(
      `- Resolved at: ${options.resolvedAt}`,
      `- Resolution: ${options.resolvedByAction}`,
      `- Result phase: ${options.resultPhase}`,
    );
  }

  if (recovery.pendingDirective) {
    lines.push(
      `- Pending terminal directive at ${recovery.pendingDirective.recordedAt}: ${recovery.pendingDirective.operatorGuidance}`,
    );
  }

  if (recovery.turns.length === 0) {
    lines.push('- Operator guidance: pending');
    return;
  }

  for (const turn of recovery.turns) {
    lines.push(
      `- Recovery turn ${turn.number} at ${turn.recordedAt}: ${turn.operatorGuidance}`,
    );

    if (turn.disposition) {
      lines.push(
        `- Recovery turn ${turn.number} coder action: ${turn.disposition.action}`,
        `- Recovery turn ${turn.number} coder summary: ${turn.disposition.summary}`,
        `- Recovery turn ${turn.number} coder blocker: ${turn.disposition.blocker || 'n/a'}`,
        `- Recovery turn ${turn.number} coder rationale: ${turn.disposition.rationale}`,
        `- Recovery turn ${turn.number} resulting phase: ${turn.disposition.resultingPhase}`,
      );
    } else {
      lines.push(`- Recovery turn ${turn.number} coder response: pending`);
    }
  }
}

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
    appendInteractiveBlockedRecoverySection(lines, '## Interactive Blocked Recovery', state.interactiveBlockedRecovery);
  }

  if (state.interactiveBlockedRecoveryHistory.length > 0) {
    for (const [index, recovery] of state.interactiveBlockedRecoveryHistory.entries()) {
      appendInteractiveBlockedRecoverySection(lines, `## Interactive Blocked Recovery History ${index + 1}`, recovery, {
        resolvedAt: recovery.resolvedAt,
        resolvedByAction: recovery.resolvedByAction,
        resultPhase: recovery.resultPhase,
      });
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
