import type { OrchestrationState } from './types.js';
import {
  getPublicLifecycleView,
  hasPendingOperatorGuidance as hasPendingOperatorGuidanceFromStateView,
} from './state-views.js';

export type EffectiveRunStatus = OrchestrationState['status'] | 'waiting_for_operator' | 'waiting_for_manual_gate';

export type RunDisplayStatus = {
  effectiveStatus: EffectiveRunStatus;
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
};

export function hasPendingOperatorGuidance(state: OrchestrationState) {
  return hasPendingOperatorGuidanceFromStateView(state);
}

export function getRunDisplayStatus(state: OrchestrationState): RunDisplayStatus {
  const lifecycle = getPublicLifecycleView(state);

  return {
    effectiveStatus:
      lifecycle.lifecycle === 'waiting_for_manual_gate'
        ? 'waiting_for_manual_gate'
        : lifecycle.lifecycle === 'waiting_for_guidance'
          ? 'waiting_for_operator'
          : state.status,
    waitingForOperatorGuidance: lifecycle.waitingForOperatorGuidance,
    pendingOperatorGuidance: lifecycle.pendingOperatorGuidance,
  };
}

export function formatPublicRunStatus(displayStatus: RunDisplayStatus) {
  if (displayStatus.effectiveStatus === 'waiting_for_manual_gate') {
    return 'waiting_for_manual_gate';
  }

  if (displayStatus.waitingForOperatorGuidance) {
    return 'waiting_for_guidance';
  }

  return displayStatus.effectiveStatus;
}
