import type {
  AgentConfig,
  ExecuteScopeProgressJustification,
  ExecutionShape,
  FinalCompletionReviewerAction,
  FinalCompletionReviewerVerdict,
  FinalCompletionSummary,
  InteractiveBlockedRecoveryState,
  OrchestrationPhase,
  OrchestrationState,
  PendingPlanReviewGuidanceSourcePhase,
  ProgressScope,
  ReviewFinding,
  ReviewRound,
  ReviewerMeaningfulProgressVerdict,
  TopLevelMode,
} from './types.js';

export type PublicRunLifecycle =
  | 'running'
  | 'paused'
  | 'waiting_for_manual_gate'
  | 'waiting_for_guidance'
  | 'blocked'
  | 'failed'
  | 'done';

export type PublicLifecycleView = {
  lifecycle: PublicRunLifecycle;
  sourceStatus: OrchestrationState['status'];
  internalPhase: OrchestrationPhase;
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
};

export type SharedRunMetadataView = {
  version: 1;
  cwd: string;
  runDir: string;
  planDoc: string;
  planDocBackupPath: string | null;
  topLevelMode: TopLevelMode;
  allowedDirtyPaths: string[];
  agentConfig: AgentConfig;
  createdAt: string;
  updatedAt: string;
  progressJsonPath: string;
  progressMarkdownPath: string;
  reviewMarkdownPath: string;
  archivedReviewPath: string | null;
  recoveryMarkdownPath: string;
  plannerSessionHandle: string | null;
  coderSessionHandle: string | null;
  reviewerSessionHandle: string | null;
  lifecycle: PublicLifecycleView;
};

export type PlanRunView = {
  mode: 'plan';
  metadata: SharedRunMetadataView;
  phase: OrchestrationPhase;
  executionShape: ExecutionShape | null;
  planDocBackupPath: string | null;
  rounds: ReviewRound[];
  findings: ReviewFinding[];
  maxRounds: number;
};

export type ExecuteRunView = {
  mode: 'execute';
  metadata: SharedRunMetadataView;
  phase: OrchestrationPhase;
  executionShape: ExecutionShape | null;
  currentScopeNumber: number;
  initialBaseCommit: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  createdCommits: string[];
  completedScopes: ProgressScope[];
  coderRetryCount: number;
  lastScopeMarker: OrchestrationState['lastScopeMarker'];
  currentScopeProgressJustification: ExecuteScopeProgressJustification | null;
  currentScopeMeaningfulProgressVerdict: ReviewerMeaningfulProgressVerdict | null;
  derivedPlan: DerivedPlanView | null;
  finalCompletion: FinalCompletionView;
};

export type InteractiveRecoveryView = {
  kind: 'interactive_blocked_recovery';
  active: boolean;
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'];
  blockedReason: string;
  maxTurns: number;
  handledTurn: number;
  turns: InteractiveBlockedRecoveryState['turns'];
  pendingDirective: InteractiveBlockedRecoveryState['pendingDirective'] | null;
  pendingTurnCount: number;
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
};

export type PlanReviewGuidanceView = {
  kind: 'plan_review_guidance';
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
};

export type DerivedPlanViewState =
  | 'pending_review'
  | 'accepted_awaiting_execution'
  | 'active_execution'
  | 'rejected'
  | 'rejected_abandoned'
  | 'unclassified';

export type DerivedPlanIdentityFields = Pick<
  OrchestrationState,
  'topLevelMode' | 'derivedPlanPath' | 'derivedFromScopeNumber' | 'derivedPlanStatus' | 'derivedScopeIndex'
>;

export type DerivedPlanIdentityView = {
  kind: 'derived_plan_identity';
  path: string;
  parentScopeNumber: number | null;
  status: OrchestrationState['derivedPlanStatus'];
  scopeIndex: number | null;
  hasAcceptedPlan: boolean;
  unexecuted: boolean;
  executing: boolean;
};

export type DerivedPlanCountersView = {
  splitPlanCountForCurrentScope: number;
  derivedPlanDepth: number;
  maxDerivedPlanReviewRounds: number;
};

export type DerivedPlanView = {
  kind: 'derived_plan';
  state: DerivedPlanViewState;
  path: string;
  parentScopeNumber: number | null;
  status: OrchestrationState['derivedPlanStatus'];
  scopeIndex: number | null;
  unexecuted: boolean;
  unexecutedResumeCandidate: boolean;
  reviewActive: boolean;
  acceptedAwaitingExecution: boolean;
  executing: boolean;
  abandoned: boolean;
  poisonedCompletedState: boolean;
  notifications: {
    splitPlanStartedNotified: boolean;
    derivedPlanAcceptedNotified: boolean;
    splitPlanBlockedNotified: boolean;
    needsSplitPlanStartedNotification: boolean;
    needsDerivedPlanAcceptedNotification: boolean;
    needsSplitPlanBlockedNotification: boolean;
  };
  counters: DerivedPlanCountersView;
};

export type PendingDerivedPlanResumePhase =
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response';

export type UnexecutedDerivedPlanResumeDisposition =
  | { kind: 'none' }
  | { kind: 'accepted'; phase: 'awaiting_derived_plan_execution' }
  | { kind: 'pending_review'; phase: PendingDerivedPlanResumePhase }
  | { kind: 'rejected'; blockedFromPhase: 'awaiting_derived_plan_execution'; blocker: string };

export type FinalCompletionViewState = 'not_started' | 'summary_recorded' | 'reviewed' | 'resolved';

export type FinalCompletionActionResolution = {
  reviewerAction: FinalCompletionReviewerAction;
  effectiveAction: FinalCompletionReviewerAction;
  continueExecutionCount: number;
  continueExecutionLimit: number;
  continueExecutionCapReached: boolean;
};

export type FinalCompletionView = {
  kind: 'final_completion';
  state: FinalCompletionViewState;
  activeReview: boolean;
  summary: FinalCompletionSummary | null;
  reviewVerdict: FinalCompletionReviewerVerdict | null;
  resolvedAction: FinalCompletionReviewerAction | null;
  effectiveAction: FinalCompletionReviewerAction | null;
  continueExecutionCount: number;
  continueExecutionCapReached: boolean;
  hasSummary: boolean;
  hasReviewVerdict: boolean;
  hasResolvedAction: boolean;
  shouldWriteArtifact: boolean;
  acceptedComplete: boolean;
  continuesExecution: boolean;
  blockedForOperator: boolean;
};

const PENDING_DERIVED_PLAN_REVIEW_PHASES = new Set<OrchestrationPhase>([
  'reviewer_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
  'interactive_blocked_recovery',
]);

export function getSharedRunMetadataView(state: OrchestrationState): SharedRunMetadataView {
  return {
    version: state.version,
    cwd: state.cwd,
    runDir: state.runDir,
    planDoc: state.planDoc,
    planDocBackupPath: state.planDocBackupPath,
    topLevelMode: state.topLevelMode,
    allowedDirtyPaths: [...state.allowedDirtyPaths],
    agentConfig: {
      planner: { ...state.agentConfig.planner },
      coder: { ...state.agentConfig.coder },
      reviewer: { ...state.agentConfig.reviewer },
    },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    progressJsonPath: state.progressJsonPath,
    progressMarkdownPath: state.progressMarkdownPath,
    reviewMarkdownPath: state.reviewMarkdownPath,
    archivedReviewPath: state.archivedReviewPath,
    recoveryMarkdownPath: state.recoveryMarkdownPath,
    plannerSessionHandle: state.plannerSessionHandle,
    coderSessionHandle: state.coderSessionHandle,
    reviewerSessionHandle: state.reviewerSessionHandle,
    lifecycle: getPublicLifecycleView(state),
  };
}

export function getPublicLifecycleView(state: OrchestrationState): PublicLifecycleView {
  const interactiveRecovery = getInteractiveRecoveryView(state);
  const planGuidance = getPlanReviewGuidanceView(state);
  const waitingForOperatorGuidance =
    (interactiveRecovery?.waitingForOperatorGuidance ?? false) || planGuidance.waitingForOperatorGuidance;
  const pendingOperatorGuidance =
    (interactiveRecovery?.pendingOperatorGuidance ?? false) || planGuidance.pendingOperatorGuidance;
  const waitingForManualGate = state.phase === 'manual_gate' && state.manualGate !== null;

  return {
    lifecycle: waitingForManualGate
      ? 'waiting_for_manual_gate'
      : waitingForOperatorGuidance
        ? 'waiting_for_guidance'
        : state.status,
    sourceStatus: state.status,
    internalPhase: state.phase,
    waitingForOperatorGuidance,
    pendingOperatorGuidance,
  };
}

export function hasPendingOperatorGuidance(state: OrchestrationState): boolean {
  return (
    (getInteractiveRecoveryView(state)?.pendingOperatorGuidance ?? false) ||
    getPlanReviewGuidanceView(state).pendingOperatorGuidance
  );
}

export function getPlanRunView(state: OrchestrationState): PlanRunView | null {
  if (state.topLevelMode !== 'plan') {
    return null;
  }

  return {
    mode: 'plan',
    metadata: getSharedRunMetadataView(state),
    phase: state.phase,
    executionShape: state.executionShape,
    planDocBackupPath: state.planDocBackupPath,
    rounds: [...state.rounds],
    findings: [...state.findings],
    maxRounds: state.maxRounds,
  };
}

export function getExecuteRunView(state: OrchestrationState): ExecuteRunView | null {
  if (state.topLevelMode !== 'execute') {
    return null;
  }

  const finalCompletion = getFinalCompletionView(state);
  if (!finalCompletion) {
    return null;
  }

  return {
    mode: 'execute',
    metadata: getSharedRunMetadataView(state),
    phase: state.phase,
    executionShape: state.executionShape,
    currentScopeNumber: state.currentScopeNumber,
    initialBaseCommit: state.initialBaseCommit,
    baseCommit: state.baseCommit,
    finalCommit: state.finalCommit,
    createdCommits: [...state.createdCommits],
    completedScopes: [...state.completedScopes],
    coderRetryCount: state.coderRetryCount,
    lastScopeMarker: state.lastScopeMarker,
    currentScopeProgressJustification: state.currentScopeProgressJustification,
    currentScopeMeaningfulProgressVerdict: state.currentScopeMeaningfulProgressVerdict,
    derivedPlan: getDerivedPlanView(state),
    finalCompletion,
  };
}

export function getInteractiveRecoveryView(state: OrchestrationState): InteractiveRecoveryView | null {
  const recovery = state.interactiveBlockedRecovery;
  if (!recovery) {
    return null;
  }

  const active = state.phase === 'interactive_blocked_recovery';
  const pendingTurns = recovery.turns.filter((turn) => turn.number > recovery.lastHandledTurn);
  const pendingOperatorGuidance = active && (pendingTurns.length > 0 || Boolean(recovery.pendingDirective));

  return {
    kind: 'interactive_blocked_recovery',
    active,
    sourcePhase: recovery.sourcePhase,
    blockedReason: recovery.blockedReason,
    maxTurns: recovery.maxTurns,
    handledTurn: recovery.lastHandledTurn,
    turns: [...recovery.turns],
    pendingDirective: recovery.pendingDirective ?? null,
    pendingTurnCount: active ? pendingTurns.length : 0,
    waitingForOperatorGuidance: active && !pendingOperatorGuidance,
    pendingOperatorGuidance,
  };
}

// The plan-stage blocked origin that a top-level plan run can answer via
// `neal resume --message`, or null when the run is not in such a wait. The
// reviewer-plan message-resume path is always eligible. A coder-authored
// *response* block (coder_plan_response / coder_plan_optional_response) is
// eligible only when it carries the durable `blockerReason`: Scope 6 sets that
// reason exclusively for coder_authored landings and leaves it null for a
// dirty-worktree safety block, which lands at the same phase but must stay a
// normal blocked state (no --message route, no waiting-for-guidance status). The
// initial `coder_plan` authoring block is deliberately excluded.
export function getPlanReviewGuidanceOriginPhase(
  state: OrchestrationState,
): PendingPlanReviewGuidanceSourcePhase | null {
  if (
    state.topLevelMode !== 'plan' ||
    state.status !== 'blocked' ||
    state.phase !== 'blocked' ||
    state.pendingPlanReviewGuidance !== null
  ) {
    return null;
  }
  if (state.blockedFromPhase === 'reviewer_plan') {
    return 'reviewer_plan';
  }
  if (
    (state.blockedFromPhase === 'coder_plan_response' ||
      state.blockedFromPhase === 'coder_plan_optional_response') &&
    state.blockerReason !== null
  ) {
    return state.blockedFromPhase;
  }
  return null;
}

export function getPlanReviewGuidanceView(state: OrchestrationState): PlanReviewGuidanceView {
  const pendingOperatorGuidance = state.topLevelMode === 'plan' && state.pendingPlanReviewGuidance !== null;
  const waitingForOperatorGuidance = getPlanReviewGuidanceOriginPhase(state) !== null;

  return {
    kind: 'plan_review_guidance',
    waitingForOperatorGuidance,
    pendingOperatorGuidance,
  };
}

export function getDerivedPlanIdentityView(state: DerivedPlanIdentityFields): DerivedPlanIdentityView | null {
  if (state.topLevelMode !== 'execute' || !state.derivedPlanPath) {
    return null;
  }

  const hasAcceptedPlan =
    state.derivedPlanStatus === 'accepted' &&
    state.derivedFromScopeNumber !== null;
  const unexecuted = state.derivedFromScopeNumber !== null && state.derivedScopeIndex === null;
  const executing = hasAcceptedPlan && state.derivedScopeIndex !== null;

  return {
    kind: 'derived_plan_identity',
    path: state.derivedPlanPath,
    parentScopeNumber: state.derivedFromScopeNumber,
    status: state.derivedPlanStatus,
    scopeIndex: state.derivedScopeIndex,
    hasAcceptedPlan,
    unexecuted,
    executing,
  };
}

export function getDerivedPlanCountersView(
  state: Pick<
    OrchestrationState,
    'splitPlanCountForCurrentScope' | 'derivedPlanDepth' | 'maxDerivedPlanReviewRounds'
  >,
): DerivedPlanCountersView {
  return {
    splitPlanCountForCurrentScope: state.splitPlanCountForCurrentScope,
    derivedPlanDepth: state.derivedPlanDepth,
    maxDerivedPlanReviewRounds: state.maxDerivedPlanReviewRounds,
  };
}

export function getDerivedPlanView(state: OrchestrationState): DerivedPlanView | null {
  const identity = getDerivedPlanIdentityView(state);
  if (!identity) {
    return null;
  }

  const viewState = getDerivedPlanViewState(state, identity);
  const poisonedCompletedState = identity.unexecuted && (state.phase === 'done' || state.status === 'done');

  return {
    kind: 'derived_plan',
    state: viewState,
    path: identity.path,
    parentScopeNumber: identity.parentScopeNumber,
    status: identity.status,
    scopeIndex: identity.scopeIndex,
    unexecuted: identity.unexecuted,
    unexecutedResumeCandidate: identity.unexecuted && state.createdCommits.length === 0,
    reviewActive: viewState === 'pending_review',
    acceptedAwaitingExecution: viewState === 'accepted_awaiting_execution',
    executing: identity.executing,
    abandoned: viewState === 'rejected' || viewState === 'rejected_abandoned',
    poisonedCompletedState,
    notifications: {
      splitPlanStartedNotified: state.splitPlanStartedNotified,
      derivedPlanAcceptedNotified: state.derivedPlanAcceptedNotified,
      splitPlanBlockedNotified: state.splitPlanBlockedNotified,
      needsSplitPlanStartedNotification: viewState === 'pending_review' && !state.splitPlanStartedNotified,
      needsDerivedPlanAcceptedNotification: identity.status === 'accepted' && !state.derivedPlanAcceptedNotified,
      needsSplitPlanBlockedNotification:
        state.status === 'blocked' &&
        state.lastScopeMarker === 'AUTONOMY_SPLIT_PLAN' &&
        !state.splitPlanBlockedNotified,
    },
    counters: getDerivedPlanCountersView(state),
  };
}

export function isActivePendingDerivedPlanReview(state: OrchestrationState) {
  return getDerivedPlanView(state)?.state === 'pending_review';
}

export function needsDerivedPlanNotificationFlush(state: OrchestrationState) {
  if (state.topLevelMode !== 'execute') {
    return false;
  }

  const derivedPlan = getDerivedPlanView(state);
  return Boolean(
    derivedPlan?.notifications.needsSplitPlanStartedNotification ||
      derivedPlan?.notifications.needsDerivedPlanAcceptedNotification ||
      derivedPlan?.notifications.needsSplitPlanBlockedNotification ||
      (state.status === 'blocked' &&
        state.lastScopeMarker === 'AUTONOMY_SPLIT_PLAN' &&
        !state.splitPlanBlockedNotified),
  );
}

export function classifyUnexecutedDerivedPlanResumeState(
  state: OrchestrationState,
): UnexecutedDerivedPlanResumeDisposition {
  const derivedPlan = getDerivedPlanView(state);
  if (!derivedPlan?.unexecutedResumeCandidate) {
    return { kind: 'none' };
  }

  if (derivedPlan.acceptedAwaitingExecution) {
    if (
      state.phase === 'awaiting_derived_plan_execution' &&
      state.status === 'running' &&
      state.blockedFromPhase === null
    ) {
      return { kind: 'none' };
    }
    return { kind: 'accepted', phase: 'awaiting_derived_plan_execution' };
  }

  if (derivedPlan.reviewActive) {
    const phase = getPendingDerivedPlanResumePhase(state);
    if (
      state.status === 'running' &&
      (state.phase === phase || state.phase === 'interactive_blocked_recovery') &&
      state.blockedFromPhase === null
    ) {
      return { kind: 'none' };
    }
    if (
      state.status === 'running' &&
      state.blockedFromPhase !== null &&
      PENDING_DERIVED_PLAN_REVIEW_PHASES.has(state.phase)
    ) {
      return { kind: 'none' };
    }
    return { kind: 'pending_review', phase };
  }

  if (derivedPlan.state === 'rejected_abandoned') {
    return {
      kind: 'rejected',
      blockedFromPhase: 'awaiting_derived_plan_execution',
      blocker: getRejectedUnexecutedDerivedPlanBlocker(derivedPlan),
    };
  }

  return { kind: 'none' };
}

export function getFinalCompletionView(state: OrchestrationState): FinalCompletionView | null {
  if (state.topLevelMode !== 'execute') {
    return null;
  }

  const effectiveAction = state.finalCompletionResolvedAction ?? state.finalCompletionReviewVerdict?.action ?? null;

  return {
    kind: 'final_completion',
    state: getFinalCompletionViewState(state),
    activeReview: state.phase === 'final_completion_review',
    summary: state.finalCompletionSummary,
    reviewVerdict: state.finalCompletionReviewVerdict,
    resolvedAction: state.finalCompletionResolvedAction,
    effectiveAction,
    continueExecutionCount: state.finalCompletionContinueExecutionCount,
    continueExecutionCapReached: state.finalCompletionContinueExecutionCapReached,
    hasSummary: state.finalCompletionSummary !== null,
    hasReviewVerdict: state.finalCompletionReviewVerdict !== null,
    hasResolvedAction: state.finalCompletionResolvedAction !== null,
    shouldWriteArtifact:
      state.phase === 'final_completion_review' ||
      state.finalCompletionSummary !== null ||
      state.finalCompletionReviewVerdict !== null,
    acceptedComplete: effectiveAction === 'accept_complete',
    continuesExecution: effectiveAction === 'continue_execution',
    blockedForOperator: effectiveAction === 'block_for_operator',
  };
}

export function requireFinalCompletionView(state: OrchestrationState, context: string): FinalCompletionView {
  const finalCompletion = getFinalCompletionView(state);
  if (!finalCompletion) {
    throw new Error(`Cannot ${context} for a non-execute run`);
  }
  return finalCompletion;
}

export function hasFinalCompletionReviewState(state: OrchestrationState) {
  return getFinalCompletionView(state)?.shouldWriteArtifact ?? false;
}

export function resolveFinalCompletionReviewAction(args: {
  finalCompletion: FinalCompletionView;
  reviewerAction: FinalCompletionReviewerAction;
  continueExecutionLimit: number;
}): FinalCompletionActionResolution {
  const continueExecutionLimit = Math.max(0, args.continueExecutionLimit);
  const continueExecutionCapReached =
    args.reviewerAction === 'continue_execution' &&
    args.finalCompletion.continueExecutionCount >= continueExecutionLimit;
  const effectiveAction =
    args.reviewerAction === 'continue_execution' && continueExecutionCapReached
      ? 'block_for_operator'
      : args.reviewerAction;
  const continueExecutionCount =
    args.reviewerAction === 'continue_execution' && !continueExecutionCapReached
      ? args.finalCompletion.continueExecutionCount + 1
      : args.finalCompletion.continueExecutionCount;

  return {
    reviewerAction: args.reviewerAction,
    effectiveAction,
    continueExecutionCount,
    continueExecutionLimit,
    continueExecutionCapReached,
  };
}

function getPendingDerivedPlanResumePhase(state: Pick<OrchestrationState, 'findings'>): PendingDerivedPlanResumePhase {
  const openFindings = state.findings.filter((finding) => finding.status === 'open');
  if (openFindings.some((finding) => finding.severity === 'blocking')) {
    return 'coder_plan_response';
  }
  if (openFindings.some((finding) => finding.severity === 'non_blocking')) {
    return 'coder_plan_optional_response';
  }
  return 'reviewer_plan';
}

function getRejectedUnexecutedDerivedPlanBlocker(derivedPlan: DerivedPlanView) {
  return [
    `Resume found an abandoned unexecuted derived plan for parent scope ${derivedPlan.parentScopeNumber}.`,
    `Derived plan: ${derivedPlan.path}.`,
    'The run cannot be treated as complete; operator recovery is required before continuing.',
  ].join(' ');
}

function getDerivedPlanViewState(
  state: OrchestrationState,
  identity: DerivedPlanIdentityView,
): DerivedPlanViewState {
  if (identity.status === 'pending_review' && identity.unexecuted) {
    return 'pending_review';
  }
  if (identity.status === 'accepted' && identity.unexecuted) {
    return 'accepted_awaiting_execution';
  }
  if (identity.executing) {
    return 'active_execution';
  }
  if (identity.status === 'rejected' && identity.unexecuted && (state.phase === 'done' || state.status === 'done')) {
    return 'rejected_abandoned';
  }
  if (identity.status === 'rejected') {
    return 'rejected';
  }
  return 'unclassified';
}

function getFinalCompletionViewState(state: OrchestrationState): FinalCompletionViewState {
  if (state.finalCompletionResolvedAction) {
    return 'resolved';
  }
  if (state.finalCompletionReviewVerdict) {
    return 'reviewed';
  }
  if (state.finalCompletionSummary) {
    return 'summary_recorded';
  }
  return 'not_started';
}
