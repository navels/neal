import process from 'node:process';

import {
  determinePlanRefinementConvergence,
  isPlanRefinementState,
  planRefinementExitCode,
} from '../plan-refinement.js';
import type { PlanAndExecuteQueueState } from '../plan-queue.js';
import { getRunDisplayStatus } from '../run-status.js';
import type { ExecuteRunResult } from './runtime.js';

export type WriterCommandExitCode = 0 | 1 | 2 | 3;

export function getExecuteRunResultExitCode(result: ExecuteRunResult): WriterCommandExitCode {
  if (isPlanRefinementState(result.finalState)) {
    const convergenceReason = determinePlanRefinementConvergence(result.finalState);
    if (convergenceReason !== null) {
      return planRefinementExitCode(convergenceReason) as WriterCommandExitCode;
    }
  }

  const displayStatus = getRunDisplayStatus(result.finalState);
  if (
    displayStatus.effectiveStatus === 'waiting_for_operator' ||
    displayStatus.effectiveStatus === 'waiting_for_manual_gate' ||
    displayStatus.pendingOperatorGuidance
  ) {
    return 2;
  }

  switch (result.finalState.status) {
    case 'done':
      return 0;
    case 'failed':
      return 3;
    case 'blocked':
    case 'paused':
    case 'running':
      return 2;
  }
}

export function getPlanAndExecuteQueueExitCode(
  state: Pick<PlanAndExecuteQueueState, 'status'>,
): WriterCommandExitCode {
  switch (state.status) {
    case 'completed':
      return 0;
    case 'failed':
      return 3;
    case 'blocked':
    case 'paused':
    case 'running':
      return 2;
  }
}

export function setWriterCommandExitCode(code: WriterCommandExitCode): void {
  process.exitCode = code;
}
