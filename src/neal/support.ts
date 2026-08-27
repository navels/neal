import { writeTextAtomic } from './atomic-write.js';
import { formatPublicPhase } from './phase-display.js';
import type { OrchestrationPhase, OrchestrationState } from './types.js';

function appendInteractiveBlockedRecoverySection(
  lines: string[],
  title: string,
  recovery: NonNullable<OrchestrationState['interactiveBlockedRecovery']> | OrchestrationState['interactiveBlockedRecoveryHistory'][number],
  options?: {
    resolvedAt?: string;
    resolvedByAction?: string;
    resultPhase?: OrchestrationPhase;
  },
) {
  lines.push(
    '',
    title,
    `- Source step: ${formatPublicPhase(recovery.sourcePhase)}`,
    `- Blocked reason: ${recovery.blockedReason}`,
    `- Max turns: ${recovery.maxTurns}`,
  );

  if (options?.resolvedAt && options.resolvedByAction && options.resultPhase) {
    lines.push(
      `- Resolved at: ${options.resolvedAt}`,
      `- Resolution: ${options.resolvedByAction}`,
      `- Result step: ${formatPublicPhase(options.resultPhase)}`,
    );
  }

  if (recovery.pendingDirective) {
    lines.push(
      `- Pending ${recovery.pendingDirective.terminalOnly ? 'terminal' : 'consultant'} directive at ${recovery.pendingDirective.recordedAt}: ${recovery.pendingDirective.operatorGuidance}`,
    );
  }

  if (recovery.consultantAdvice) {
    const advice = recovery.consultantAdvice;
    lines.push(
      `- Consultant advice at ${advice.recordedAt} (read-only, not auto-applied):`,
      `  - Recoverable: ${advice.recoverable ? 'yes' : 'no'}`,
      `  - Triage category: ${advice.triageCategory}`,
      `  - Suggested directive: ${advice.resolutionDirective || 'n/a'}`,
      `  - Rationale: ${advice.rationale}`,
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
      );
      if (turn.disposition.laterScopeNumber > 0) {
        lines.push(
          `- Recovery turn ${turn.number} revised later scope: ${turn.disposition.laterScopeNumber}`,
          `- Recovery turn ${turn.number} revised scope text:`,
          ...turn.disposition.laterScopeBody.split('\n').map((line) => `  ${line}`),
        );
      }
      lines.push(`- Recovery turn ${turn.number} resulting step: ${formatPublicPhase(turn.disposition.resultingPhase)}`);
    } else {
      lines.push(`- Recovery turn ${turn.number} coder response: pending`);
    }
  }
}

export function renderRecoveryMarkdown(state: OrchestrationState) {
  const lines = [
    '# Interactive Blocked Recovery',
    '',
    '## Metadata',
    `- Plan: ${state.planDoc}`,
    `- Current step: ${formatPublicPhase(state.phase)}`,
    `- Coder session: ${state.coderSessionHandle ?? 'pending'}`,
    `- Reviewer session: ${state.reviewerSessionHandle ?? 'pending'}`,
  ];

  if (state.interactiveBlockedRecovery) {
    appendInteractiveBlockedRecoverySection(lines, '## Active Recovery', state.interactiveBlockedRecovery);
  }

  if (state.interactiveBlockedRecoveryHistory.length > 0) {
    for (const [index, recovery] of state.interactiveBlockedRecoveryHistory.entries()) {
      appendInteractiveBlockedRecoverySection(lines, `## Recovery History ${index + 1}`, recovery, {
        resolvedAt: recovery.resolvedAt,
        resolvedByAction: recovery.resolvedByAction,
        resultPhase: recovery.resultPhase,
      });
    }
  }

  if (!state.interactiveBlockedRecovery && state.interactiveBlockedRecoveryHistory.length === 0) {
    lines.push('', 'No interactive blocked recovery yet.');
  }

  return `${lines.join('\n')}\n`;
}

export async function writeRecoveryMarkdown(path: string, state: OrchestrationState) {
  await writeTextAtomic(path, renderRecoveryMarkdown(state));
}
