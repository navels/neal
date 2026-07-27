import {
  aggregateChangedFilesForAcceptedDerivedScopes,
  getAcceptedDerivedScopesForParentObjective,
  getAcceptedParentScopeForObjective,
  getCurrentScopeLabel,
  getParentScopeLabel,
  isExecutingDerivedPlan,
  shouldAdvanceTopLevelScopeNumber,
  shouldContinueTopLevelExecutionAfterAcceptedScope,
} from '../scopes.js';
import { toResidualReviewDebt } from '../review-debt.js';
import { getDerivedPlanView, getFinalCompletionView } from '../state-views.js';
import type { OrchestrationState, ScopeMarker } from '../types.js';

const ALREADY_SATISFIED_ACCEPTANCE_RATIONALE_PREFIX = 'Accepted top-level already-satisfied scope';

// Shared scope-boundary reset, computed mechanically from the seven
// scope-boundary transition sites (`adoptAcceptedDerivedPlan`, the three
// next-scope branches of `computeNextScopeStateAfterExecuteFinalization`,
// `computeNextScopeStateAfterParentAdvance`, the split-plan persist in
// split-plan.ts, and the continue-execution reopen in completion.ts): these
// are exactly the fields ALL seven reset to the same value. `status:
// 'running'` is also written identically by all seven, but it stays paired
// with each site's `phase` target (site-local, or in
// `createNextScopeEntryReset` below) so the phase/status transition reads as
// one unit. Everything else genuinely differs per site and stays site-local.
// This is a function, not a constant, so every call returns fresh array
// instances — no two states ever alias the same `rounds`/`findings` array.
type ScopeBoundaryReset = Pick<
  OrchestrationState,
  | 'currentScopeProgressJustification'
  | 'currentScopeMeaningfulProgressVerdict'
  | 'rounds'
  | 'recentBlocks'
  | 'consultantAttemptCount'
  | 'findings'
  | 'planReviewDebt'
  | 'createdCommits'
>;

export function createScopeBoundaryReset(): ScopeBoundaryReset {
  return {
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    // planReviewDebt is a projection of the current findings, so clearing
    // findings must clear it too (toPlanReviewDebt([]) === []); otherwise a new
    // derived-plan negotiation would carry stale current-negotiation debt. The
    // durable inheritedPlanReviewDebt is intentionally NOT reset here — it is
    // write-once and survives scope boundaries.
    planReviewDebt: [],
    createdCommits: [],
  };
}

// Wider reset for the five sites that enter the NEXT scope at a new base
// commit (the three next-scope finalization branches, parent advance, and the
// continue-execution reopen): the shared core plus the fields all five write
// identically. Fields any of the five does not set today stay site-local —
// e.g. `splitPlanCountForCurrentScope` (the derived-continue branch preserves
// it) and the finalCompletion verdict/action fields (the reopen keeps the
// verdict it just resolved).
type NextScopeEntryReset = ScopeBoundaryReset &
  Pick<
    OrchestrationState,
    | 'baseCommit'
    | 'finalCommit'
    | 'archivedReviewPath'
    | 'coderSessionHandle'
    | 'coderSessionProtocol'
    | 'lastScopeMarker'
    | 'finalCompletionSummary'
  > & { phase: 'coder_scope'; status: 'running' };

export function createNextScopeEntryReset(baseCommit: OrchestrationState['baseCommit']): NextScopeEntryReset {
  return {
    ...createScopeBoundaryReset(),
    baseCommit,
    finalCommit: null,
    archivedReviewPath: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    lastScopeMarker: null,
    finalCompletionSummary: null,
    phase: 'coder_scope',
    status: 'running',
  };
}

type AppendCompletedScopeDetails = {
  scopeLabel?: string;
  finalCommit: string | null;
  summary?: string | null;
  commitSubject: string | null;
  changedFiles?: string[];
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
      summary: details.summary ?? null,
      commitSubject: details.commitSubject,
      changedFiles: [...(details.changedFiles ?? [])],
      reviewRounds: state.rounds.length,
      findings: state.findings.length,
      residualReviewDebt: result === 'accepted' ? toResidualReviewDebt(state.findings) : [],
      archivedReviewPath: details.archivedReviewPath,
      blocker: details.blocker,
      derivedFromParentScope: details.derivedFromParentScope ?? null,
      replacedByDerivedPlanPath: details.replacedByDerivedPlanPath ?? null,
    },
  ];
}

export function shouldNotifyDerivedPlanAcceptance(previousState: OrchestrationState, nextState: OrchestrationState) {
  const previousDerivedPlan = getDerivedPlanView(previousState);
  const nextDerivedPlan = getDerivedPlanView(nextState);
  return (
    previousDerivedPlan?.status !== 'accepted' &&
    nextDerivedPlan?.acceptedAwaitingExecution === true &&
    nextState.phase === 'awaiting_derived_plan_execution'
  );
}

export function transitionPlanReviewWithoutOpenFindings(
  state: OrchestrationState,
  reviewMode: 'plan' | 'derived-plan',
): OrchestrationState {
  return {
    ...state,
    phase: reviewMode === 'derived-plan' ? 'awaiting_derived_plan_execution' : 'done',
    status: reviewMode === 'plan' ? 'done' : 'running',
    derivedPlanStatus: reviewMode === 'derived-plan' ? 'accepted' : state.derivedPlanStatus,
  };
}

export function adoptAcceptedDerivedPlan(state: OrchestrationState) {
  const derivedPlan = getDerivedPlanView(state);
  if (derivedPlan?.status !== 'accepted' || derivedPlan.parentScopeNumber === null) {
    return state;
  }
  if (state.phase !== 'awaiting_derived_plan_execution') {
    throw new Error(`Cannot adopt derived plan from phase ${state.phase}`);
  }
  if (state.createdCommits.length > 0) {
    throw new Error('Cannot adopt derived plan after derived execution has already created commits');
  }
  if (derivedPlan.scopeIndex !== null) {
    throw new Error('Cannot adopt derived plan after derived scope execution has already started');
  }

  return {
    ...state,
    ...createScopeBoundaryReset(),
    phase: 'coder_scope' as const,
    status: 'running' as const,
    derivedScopeIndex: derivedPlan.scopeIndex ?? 1,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    coderRetryCount: 0,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    blockedFromPhase: null,
  };
}

type ExecuteFinalizationNextStateArgs = {
  state: OrchestrationState;
  finalCommit: string;
  completedScopes: OrchestrationState['completedScopes'];
  archivedReviewPath: string | null;
};

export function computeNextScopeStateAfterExecuteFinalization({
  state,
  finalCommit,
  completedScopes,
  archivedReviewPath,
}: ExecuteFinalizationNextStateArgs): OrchestrationState {
  const derivedExecution = isExecutingDerivedPlan(state);
  const derivedPlan = getDerivedPlanView(state);
  const finalCompletion = getFinalCompletionView(state);
  const derivedPlanCompleted = derivedExecution && state.lastScopeMarker === 'AUTONOMY_DONE';
  const continueScopes = derivedExecution ? true : shouldContinueTopLevelExecutionAfterAcceptedScope(state);
  const nextTopLevelScopeNumber = shouldAdvanceTopLevelScopeNumber(state)
    ? state.currentScopeNumber + 1
    : state.currentScopeNumber;

  if (derivedExecution && derivedPlanCompleted) {
    return {
      ...state,
      ...createNextScopeEntryReset(finalCommit),
      currentScopeNumber: nextTopLevelScopeNumber,
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      finalCompletionContinueExecutionCapReached: false,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      splitPlanCountForCurrentScope: 0,
      completedScopes,
    };
  }

  if (derivedExecution) {
    return {
      ...state,
      ...createNextScopeEntryReset(finalCommit),
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      finalCompletionContinueExecutionCapReached: false,
      derivedScopeIndex: (derivedPlan?.scopeIndex ?? 1) + 1,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      completedScopes,
    };
  }

  if (continueScopes) {
    return {
      ...state,
      ...createNextScopeEntryReset(finalCommit),
      currentScopeNumber: nextTopLevelScopeNumber,
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      finalCompletionContinueExecutionCapReached: false,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      splitPlanCountForCurrentScope: 0,
      completedScopes,
    };
  }

  return {
    ...state,
    finalCommit,
    archivedReviewPath,
    completedScopes,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    finalCompletionSummary: finalCompletion?.summary ?? null,
    finalCompletionReviewVerdict: finalCompletion?.reviewVerdict ?? null,
    finalCompletionResolvedAction: finalCompletion?.resolvedAction ?? null,
    phase: 'final_completion_review',
    status: 'running',
  };
}

export function appendParentCompletionFromAcceptedDerivedScopes(args: {
  state: OrchestrationState;
  finalCommit: string;
  archivedReviewPath: string;
}) {
  const derivedPlan = getDerivedPlanView(args.state);
  const parentScopeLabel = getParentScopeLabel(args.state);
  if (getAcceptedParentScopeForObjective(args.state, parentScopeLabel)) {
    throw new Error(
      `Cannot append parent completion for objective ${parentScopeLabel}: accepted parent record already exists`,
    );
  }

  const derivedScopes = getAcceptedDerivedScopesForParentObjective(args.state, parentScopeLabel);
  const parentScopeChangedFiles = aggregateChangedFilesForAcceptedDerivedScopes(derivedScopes);
  return appendCompletedScope(args.state, 'accepted', {
    scopeLabel: parentScopeLabel,
    finalCommit: args.finalCommit,
    summary: `advance_parent accepted parent scope ${parentScopeLabel} via prior derived work; the current empty derived sub-scope was not accepted.`,
    commitSubject: `Parent scope ${parentScopeLabel} complete via derived plan`,
    changedFiles: parentScopeChangedFiles,
    archivedReviewPath: args.archivedReviewPath,
    blocker: null,
    marker: 'AUTONOMY_SCOPE_DONE',
    replacedByDerivedPlanPath: derivedPlan?.path ?? null,
  });
}

export function computeNextScopeStateAfterParentAdvance(args: {
  state: OrchestrationState;
  finalCommit: string;
  completedScopes: OrchestrationState['completedScopes'];
}): OrchestrationState {
  const nextTopLevelScopeNumber = shouldAdvanceTopLevelScopeNumber(args.state)
    ? args.state.currentScopeNumber + 1
    : args.state.currentScopeNumber;

  return {
    ...args.state,
    ...createNextScopeEntryReset(args.finalCommit),
    reviewerSessionHandle: null,
    coderRetryCount: 0,
    currentScopeNumber: nextTopLevelScopeNumber,
    manualGate: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    splitPlanCountForCurrentScope: 0,
    completedScopes: args.completedScopes,
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
  };
}

function getAcceptedScopeSummary(state: OrchestrationState) {
  const meaningfulProgressVerdict = state.currentScopeMeaningfulProgressVerdict;
  if (
    !isExecutingDerivedPlan(state) &&
    meaningfulProgressVerdict?.action === 'accept' &&
    meaningfulProgressVerdict.rationale.startsWith(ALREADY_SATISFIED_ACCEPTANCE_RATIONALE_PREFIX)
  ) {
    return meaningfulProgressVerdict.rationale;
  }

  return state.currentScopeProgressJustification?.milestoneTargeted ?? null;
}

export function appendDerivedSubScopeAndParentCompletion(args: {
  state: OrchestrationState;
  finalCommit: string;
  finalSubject: string;
  changedFiles: string[];
  archivedReviewPath: string;
}) {
  const derivedExecution = isExecutingDerivedPlan(args.state);
  const derivedPlan = getDerivedPlanView(args.state);
  const currentScopeLabel = getCurrentScopeLabel(args.state);
  const subScopeCompletedScopes = appendCompletedScope(args.state, 'accepted', {
    scopeLabel: currentScopeLabel,
    finalCommit: args.finalCommit,
    summary: getAcceptedScopeSummary(args.state),
    commitSubject: args.finalSubject,
    changedFiles: args.changedFiles,
    archivedReviewPath: args.archivedReviewPath,
    blocker: null,
    derivedFromParentScope: derivedExecution ? getParentScopeLabel(args.state) : null,
  });
  const derivedPlanCompleted = derivedExecution && args.state.lastScopeMarker === 'AUTONOMY_DONE';
  const parentScopeChangedFiles = derivedPlanCompleted
    ? [
        ...new Set(
            subScopeCompletedScopes
              .filter((scope) => scope.result === 'accepted' && scope.derivedFromParentScope === getParentScopeLabel(args.state))
              .flatMap((scope) => scope.changedFiles),
          ),
      ]
    : args.changedFiles;
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
          summary: null,
          commitSubject: args.finalSubject,
          changedFiles: parentScopeChangedFiles,
          archivedReviewPath: args.archivedReviewPath,
          blocker: null,
          marker: 'AUTONOMY_SCOPE_DONE',
          replacedByDerivedPlanPath: derivedPlan?.path ?? null,
        },
      )
    : subScopeCompletedScopes;
}
