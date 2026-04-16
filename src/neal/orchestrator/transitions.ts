import { getCurrentScopeLabel, getParentScopeLabel, hasAcceptedDerivedPlan, isExecutingDerivedPlan } from '../scopes.js';
import type { OrchestrationState, ScopeMarker } from '../types.js';

type AppendCompletedScopeDetails = {
  scopeLabel?: string;
  finalCommit: string | null;
  commitSubject: string | null;
  archivedReviewPath: string | null;
  blocker: string | null;
  marker?: ScopeMarker;
  derivedFromParentScope?: string | null;
  replacedByDerivedPlanPath?: string | null;
};

export function appendCompletedScope(
  state: OrchestrationState,
  result: 'accepted' | 'blocked',
  details: AppendCompletedScopeDetails,
) {
  const scopeLabel = details.scopeLabel ?? getCurrentScopeLabel(state);
  const marker = details.marker ?? ((state.lastScopeMarker ?? 'AUTONOMY_BLOCKED') as ScopeMarker);
  return [
    ...state.completedScopes.filter((scope) => scope.number !== scopeLabel),
    {
      number: scopeLabel,
      marker,
      result,
      baseCommit: state.baseCommit,
      finalCommit: details.finalCommit,
      commitSubject: details.commitSubject,
      reviewRounds: state.rounds.length,
      findings: state.findings.length,
      archivedReviewPath: details.archivedReviewPath,
      blocker: details.blocker,
      derivedFromParentScope: details.derivedFromParentScope ?? null,
      replacedByDerivedPlanPath: details.replacedByDerivedPlanPath ?? null,
    },
  ];
}

export function shouldNotifyDerivedPlanAcceptance(previousState: OrchestrationState, nextState: OrchestrationState) {
  return (
    previousState.topLevelMode === 'execute' &&
    previousState.derivedPlanStatus !== 'accepted' &&
    nextState.derivedPlanStatus === 'accepted' &&
    nextState.phase === 'awaiting_derived_plan_execution'
  );
}

export function transitionPlanReviewWithoutOpenFindings(
  state: OrchestrationState,
  derivedPlanReview: boolean,
): OrchestrationState {
  return {
    ...state,
    phase: derivedPlanReview ? 'awaiting_derived_plan_execution' : 'done',
    status: derivedPlanReview ? 'running' : 'done',
    derivedPlanStatus: derivedPlanReview ? 'accepted' : state.derivedPlanStatus,
  };
}

export function adoptAcceptedDerivedPlan(state: OrchestrationState) {
  if (!hasAcceptedDerivedPlan(state) || !state.derivedPlanPath) {
    return state;
  }
  if (state.phase !== 'awaiting_derived_plan_execution') {
    throw new Error(`Cannot adopt derived plan from phase ${state.phase}`);
  }
  if (state.createdCommits.length > 0) {
    throw new Error('Cannot adopt derived plan after derived execution has already created commits');
  }
  if (state.derivedScopeIndex !== null) {
    throw new Error('Cannot adopt derived plan after derived scope execution has already started');
  }

  return {
    ...state,
    phase: 'coder_scope' as const,
    status: 'running' as const,
    derivedScopeIndex: state.derivedScopeIndex ?? 1,
    coderSessionHandle: null,
    coderRetryCount: 0,
    rounds: [],
    consultRounds: [],
    findings: [],
    createdCommits: [],
    blockedFromPhase: null,
  };
}

type FinalSquashNextStateArgs = {
  state: OrchestrationState;
  finalCommit: string;
  completedScopes: OrchestrationState['completedScopes'];
  archivedReviewPath: string | null;
};

export function computeNextScopeStateAfterSquash({
  state,
  finalCommit,
  completedScopes,
  archivedReviewPath,
}: FinalSquashNextStateArgs): OrchestrationState {
  const derivedExecution = isExecutingDerivedPlan(state);
  const derivedPlanCompleted = derivedExecution && state.lastScopeMarker === 'AUTONOMY_DONE';
  const continueScopes = derivedExecution
    ? true
    : state.lastScopeMarker !== 'AUTONOMY_DONE' && state.lastScopeMarker !== 'AUTONOMY_BLOCKED';

  if (derivedExecution && derivedPlanCompleted) {
    return {
      ...state,
      baseCommit: finalCommit,
      finalCommit: null,
      coderSessionHandle: null,
      currentScopeNumber: state.currentScopeNumber + 1,
      lastScopeMarker: null,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      splitPlanCountForCurrentScope: 0,
      rounds: [],
      consultRounds: [],
      findings: [],
      createdCommits: [],
      completedScopes,
      archivedReviewPath: null,
      phase: 'coder_scope',
      status: 'running',
    };
  }

  if (derivedExecution) {
    return {
      ...state,
      baseCommit: finalCommit,
      finalCommit: null,
      coderSessionHandle: null,
      lastScopeMarker: null,
      derivedScopeIndex: (state.derivedScopeIndex ?? 1) + 1,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      rounds: [],
      consultRounds: [],
      findings: [],
      createdCommits: [],
      completedScopes,
      archivedReviewPath: null,
      phase: 'coder_scope',
      status: 'running',
    };
  }

  if (continueScopes) {
    return {
      ...state,
      baseCommit: finalCommit,
      finalCommit: null,
      coderSessionHandle: null,
      currentScopeNumber: state.currentScopeNumber + 1,
      lastScopeMarker: null,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      splitPlanCountForCurrentScope: 0,
      rounds: [],
      consultRounds: [],
      findings: [],
      createdCommits: [],
      completedScopes,
      archivedReviewPath: null,
      phase: 'coder_scope',
      status: 'running',
    };
  }

  return {
    ...state,
    finalCommit,
    archivedReviewPath,
    completedScopes,
    phase: 'done',
    status: 'done',
  };
}

export function appendDerivedSubScopeAndParentCompletion(args: {
  state: OrchestrationState;
  finalCommit: string;
  finalSubject: string;
  archivedReviewPath: string;
}) {
  const derivedExecution = isExecutingDerivedPlan(args.state);
  const currentScopeLabel = getCurrentScopeLabel(args.state);
  const subScopeCompletedScopes = appendCompletedScope(args.state, 'accepted', {
    scopeLabel: currentScopeLabel,
    finalCommit: args.finalCommit,
    commitSubject: args.finalSubject,
    archivedReviewPath: args.archivedReviewPath,
    blocker: null,
    derivedFromParentScope: derivedExecution ? getParentScopeLabel(args.state) : null,
  });
  const derivedPlanCompleted = derivedExecution && args.state.lastScopeMarker === 'AUTONOMY_DONE';
  return derivedPlanCompleted
    ? appendCompletedScope(
        {
          ...args.state,
          completedScopes: subScopeCompletedScopes,
        },
        'accepted',
        {
          scopeLabel: getParentScopeLabel(args.state),
          finalCommit: args.finalCommit,
          commitSubject: args.finalSubject,
          archivedReviewPath: args.archivedReviewPath,
          blocker: null,
          marker: 'AUTONOMY_SCOPE_DONE',
          replacedByDerivedPlanPath: args.state.derivedPlanPath,
        },
      )
    : subScopeCompletedScopes;
}
