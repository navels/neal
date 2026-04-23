import { readFile } from 'node:fs/promises';

import { validatePlanDocument } from './plan-validation.js';
import type { ExecutionShape, OrchestrationState, ProgressScope } from './types.js';

export const DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW = 5;

export type ExecutionPlanScopeCount =
  | { kind: 'known'; total: number }
  | { kind: 'unknown_by_contract' }
  | { kind: 'unavailable' };

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

export function shouldAdvanceTopLevelScopeNumber(
  state: Pick<OrchestrationState, 'executionShape'>,
) {
  return state.executionShape !== 'one_shot';
}

export function shouldContinueTopLevelExecutionAfterAcceptedScope(
  state: Pick<OrchestrationState, 'executionShape' | 'lastScopeMarker'>,
) {
  if (state.lastScopeMarker === 'AUTONOMY_DONE' || state.lastScopeMarker === 'AUTONOMY_BLOCKED') {
    return false;
  }

  return shouldAdvanceTopLevelScopeNumber(state);
}

export function getExecutionPlanScopeCountForShape(
  executionShape: ExecutionShape | null,
  options?: { knownTotal?: number | null },
): ExecutionPlanScopeCount {
  if (executionShape === 'one_shot') {
    return { kind: 'known', total: 1 };
  }

  if (executionShape === 'multi_scope_unknown') {
    return { kind: 'unknown_by_contract' };
  }

  if (executionShape === 'multi_scope') {
    const knownTotal = options?.knownTotal ?? null;
    if (typeof knownTotal === 'number' && Number.isFinite(knownTotal) && knownTotal > 0) {
      return { kind: 'known', total: knownTotal };
    }
  }

  return { kind: 'unavailable' };
}

export async function getExecutionPlanScopeCount(planPath: string): Promise<ExecutionPlanScopeCount> {
  try {
    const planDocument = await readFile(planPath, 'utf8');
    const validation = validatePlanDocument(planDocument);
    if (!validation.ok) {
      return { kind: 'unavailable' };
    }

    if (validation.executionShape === 'one_shot') {
      return { kind: 'known', total: 1 };
    }

    if (validation.executionShape === 'multi_scope_unknown') {
      return { kind: 'unknown_by_contract' };
    }

    const matches = validation.normalization.normalizedDocument.match(/^### Scope \d+:/gm);
    if (!matches || matches.length === 0) {
      return { kind: 'unavailable' };
    }

    return { kind: 'known', total: matches.length };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function renderScopeProgressSegments(
  state: Pick<
    OrchestrationState,
    'currentScopeNumber' | 'derivedFromScopeNumber' | 'topLevelMode' | 'derivedPlanPath' | 'derivedPlanStatus' | 'derivedScopeIndex'
  >,
  scopeCount: ExecutionPlanScopeCount,
) {
  const scopeLabel = getCurrentScopeLabel(state);
  const scopeSuffix = scopeCount.kind === 'known' ? `/${scopeCount.total}` : scopeCount.kind === 'unknown_by_contract' ? '/?' : '';
  const scopeSegment = `scope ${scopeLabel}${scopeSuffix}`;

  if (!isExecutingDerivedPlan(state)) {
    return {
      scopeSegment,
      derivedSegment: null,
    };
  }

  const derivedIndex = state.derivedScopeIndex ?? 1;
  const derivedSuffix =
    scopeCount.kind === 'known' ? `/${scopeCount.total}` : scopeCount.kind === 'unknown_by_contract' ? '/?' : '';

  return {
    scopeSegment: `scope ${scopeLabel}`,
    derivedSegment: `derived ${derivedIndex}${derivedSuffix}`,
  };
}

export function renderScopeProgressSummary(
  state: Pick<
    OrchestrationState,
    'currentScopeNumber' | 'derivedFromScopeNumber' | 'topLevelMode' | 'derivedPlanPath' | 'derivedPlanStatus' | 'derivedScopeIndex'
  >,
  scopeCount: ExecutionPlanScopeCount,
) {
  const { scopeSegment, derivedSegment } = renderScopeProgressSegments(state, scopeCount);
  return derivedSegment ? `${scopeSegment} | ${derivedSegment}` : scopeSegment;
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
