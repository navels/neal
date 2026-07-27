import type { OrchestrationPhase } from './types.js';

export const EXECUTE_FINALIZATION_PHASE = 'execute_finalization' as const satisfies OrchestrationPhase;
export type ExecuteFinalizationPhase = typeof EXECUTE_FINALIZATION_PHASE;

export const EXECUTE_FINALIZATION_PUBLIC_LABEL = 'finalizing accepted scope';

export function isExecuteFinalizationPhase(phase: OrchestrationPhase): phase is ExecuteFinalizationPhase {
  return phase === EXECUTE_FINALIZATION_PHASE;
}
