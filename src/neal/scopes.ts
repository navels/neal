import type { OrchestrationState } from './types.js';

export function hasAcceptedDerivedPlan(state: Pick<OrchestrationState, 'topLevelMode' | 'derivedPlanPath' | 'derivedPlanStatus' | 'derivedFromScopeNumber'>) {
  return (
    state.topLevelMode === 'execute' &&
    Boolean(state.derivedPlanPath) &&
    state.derivedPlanStatus === 'accepted' &&
    state.derivedFromScopeNumber !== null
  );
}

export function isExecutingDerivedPlan(
  state: Pick<
    OrchestrationState,
    'topLevelMode' | 'derivedPlanPath' | 'derivedPlanStatus' | 'derivedFromScopeNumber' | 'derivedScopeIndex'
  >,
) {
  return hasAcceptedDerivedPlan(state) && state.derivedScopeIndex !== null;
}

export function getParentScopeLabel(
  state: Pick<OrchestrationState, 'currentScopeNumber' | 'derivedFromScopeNumber'>,
) {
  return String(state.derivedFromScopeNumber ?? state.currentScopeNumber);
}

export function getCurrentScopeLabel(
  state: Pick<
    OrchestrationState,
    'currentScopeNumber' | 'derivedFromScopeNumber' | 'topLevelMode' | 'derivedPlanPath' | 'derivedPlanStatus' | 'derivedScopeIndex'
  >,
) {
  if (isExecutingDerivedPlan(state)) {
    return `${getParentScopeLabel(state)}.${state.derivedScopeIndex}`;
  }

  return String(state.currentScopeNumber);
}

export function getExecutionPlanPath(
  state: Pick<
    OrchestrationState,
    'planDoc' | 'derivedPlanPath' | 'topLevelMode' | 'derivedPlanStatus' | 'derivedFromScopeNumber' | 'derivedScopeIndex'
  >,
) {
  return isExecutingDerivedPlan(state) && state.derivedPlanPath ? state.derivedPlanPath : state.planDoc;
}
