import type { InteractiveBlockedRecoveryRecord, OrchestrationState } from './types.js';

function summarizeTurn(record: InteractiveBlockedRecoveryRecord, turn: InteractiveBlockedRecoveryRecord['turns'][number]) {
  const lines = [
    `- Turn ${turn.number} guidance: ${turn.operatorGuidance}`,
  ];

  if (turn.disposition) {
    lines.push(
      `- Turn ${turn.number} coder action: ${turn.disposition.action}`,
      `- Turn ${turn.number} coder summary: ${turn.disposition.summary}`,
      `- Turn ${turn.number} resulting phase: ${turn.disposition.resultingPhase}`,
    );
  } else if (turn.number <= record.lastHandledTurn) {
    lines.push(`- Turn ${turn.number} coder response: handled without a persisted disposition summary`);
  } else {
    lines.push(`- Turn ${turn.number} coder response: pending`);
  }

  return lines;
}

export function summarizeInteractiveBlockedRecoveryHistory(
  history: OrchestrationState['interactiveBlockedRecoveryHistory'],
) {
  if (history.length === 0) {
    return null;
  }

  const latest = history.at(-1) ?? null;
  return {
    sessions: history.length,
    lastAction: latest?.resolvedByAction ?? null,
    lastResultPhase: latest?.resultPhase ?? null,
    lastBlockedReason: latest?.blockedReason ?? null,
    lastOperatorGuidance: latest?.turns.at(-1)?.operatorGuidance ?? null,
    lastCoderSummary: latest?.turns.at(-1)?.disposition?.summary ?? null,
  };
}

export function renderInteractiveBlockedRecoveryHistoryLines(
  history: OrchestrationState['interactiveBlockedRecoveryHistory'],
  heading = '## Interactive Blocked Recovery History',
) {
  if (history.length === 0) {
    return [] as string[];
  }

  const lines = ['', heading];
  for (const [index, record] of history.entries()) {
    lines.push(
      `### Recovery Session ${index + 1}`,
      `- Source phase: ${record.sourcePhase}`,
      `- Blocked reason: ${record.blockedReason}`,
      `- Turns used: ${record.turns.length}/${record.maxTurns}`,
      `- Resolved at: ${record.resolvedAt}`,
      `- Resolution: ${record.resolvedByAction}`,
      `- Result phase: ${record.resultPhase}`,
    );

    if (record.pendingDirective) {
      lines.push(`- Pending directive at resolution: ${record.pendingDirective.operatorGuidance}`);
    }

    if (record.turns.length === 0) {
      lines.push('- Operator guidance: none recorded');
      continue;
    }

    for (const turn of record.turns) {
      lines.push(...summarizeTurn(record, turn));
    }
  }

  return lines;
}
