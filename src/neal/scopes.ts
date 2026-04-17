import type { OrchestrationState, ProgressScope } from './types.js';

export const DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW = 5;

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

export function getCompletedScopeParentObjective(scope: Pick<ProgressScope, 'number' | 'derivedFromParentScope'>) {
  return scope.derivedFromParentScope ?? scope.number;
}

export function getRecentAcceptedScopesForParentObjective(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
  window = DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW,
) {
  return state.completedScopes
    .filter((scope) => scope.result === 'accepted' && getCompletedScopeParentObjective(scope) === parentScopeLabel)
    .filter((scope) => !(scope.derivedFromParentScope === null && scope.replacedByDerivedPlanPath))
    .slice(-Math.max(window, 0));
}

export function renderRecentAcceptedScopesSummary(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
  window = DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW,
) {
  const recentScopes = getRecentAcceptedScopesForParentObjective(state, parentScopeLabel, window);
  if (recentScopes.length === 0) {
    return `No accepted scopes have been recorded yet for parent objective ${parentScopeLabel}.`;
  }

  const touchedFileCounts = new Map<string, number>();
  for (const scope of recentScopes) {
    for (const file of scope.changedFiles) {
      touchedFileCounts.set(file, (touchedFileCounts.get(file) ?? 0) + 1);
    }
  }

  const concentrationSummary =
    touchedFileCounts.size === 0
      ? '(no changed files recorded)'
      : [...touchedFileCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([file, touches]) => `${file} (${touches}/${recentScopes.length} scopes)`)
          .join(', ');

  return [
    `Accepted scope history for parent objective ${parentScopeLabel} (oldest to newest, last ${window} max):`,
    ...recentScopes.map((scope) => {
      const changedFiles = scope.changedFiles.length > 0 ? scope.changedFiles.join(', ') : '(no changed files)';
      return [
        `- Scope ${scope.number}`,
        `  commit: ${scope.finalCommit ?? 'pending'}`,
        `  subject: ${scope.commitSubject ?? 'pending'}`,
        `  parentScope: ${scope.derivedFromParentScope ?? 'none'}`,
        `  changedFiles: ${changedFiles}`,
      ].join('\n');
    }),
    `Touched-file concentration: ${concentrationSummary}`,
  ].join('\n');
}
