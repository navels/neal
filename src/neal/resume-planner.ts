import type { RunLogger } from './logger.js';
import { flushDerivedPlanNotifications } from './orchestrator/notifications.js';
import { recoverPendingReviewFromCleanCommittedScope } from './orchestrator/phases/coder.js';
import { isResumableBlockedPhase } from './orchestrator/phases/recovery.js';
import { persistBlockedScope } from './orchestrator/phases/shared.js';
import {
  classifyUnexecutedDerivedPlanResumeState,
  getDerivedPlanView,
  getInteractiveRecoveryView,
  needsDerivedPlanNotificationFlush,
  type PendingDerivedPlanResumePhase,
  type UnexecutedDerivedPlanResumeDisposition,
} from './state-views.js';
import { saveState } from './state.js';
import type { OrchestrationPhase, OrchestrationState } from './types.js';

type ResumableBlockedPhase =
  | 'coder_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'coder_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response';
type ResumableBlockedSessionRole = 'planner' | 'coder';

function getResumableBlockedSessionRole(phase: ResumableBlockedPhase): ResumableBlockedSessionRole {
  return phase === 'coder_plan' || phase === 'coder_plan_response' || phase === 'coder_plan_optional_response'
    ? 'planner'
    : 'coder';
}

export type ResumeAction =
  | {
      kind: 'restore_resumable_blocked_phase';
      phase: ResumableBlockedPhase;
      sessionRole: ResumableBlockedSessionRole;
      sessionHandle: string;
    }
  | {
      kind: 'normalize_stopped_status';
      previousStatus: Exclude<OrchestrationState['status'], 'done' | 'running'>;
    }
  | {
      kind: 'keep_blocked';
      blockedFromPhase: OrchestrationPhase | null;
    }
  | {
      kind: 'promote_accepted_derived_plan';
      phase: 'awaiting_derived_plan_execution';
    }
  | {
      kind: 'promote_pending_derived_plan_review';
      phase: PendingDerivedPlanResumePhase;
    }
  | {
      kind: 'block_rejected_abandoned_derived_plan';
      blockedFromPhase: 'awaiting_derived_plan_execution';
      blocker: string;
    }
  | {
      kind: 'flush_derived_plan_notifications';
    }
  | {
      kind: 'recover_pending_review_from_clean_committed_scope';
    }
  | {
      kind: 'wait_for_operator_guidance';
      sourcePhase: OrchestrationPhase;
    }
  | {
      kind: 'process_pending_operator_guidance';
      pendingTurnCount: number;
    }
  | {
      kind: 'log_interactive_blocked_recovery';
      sourcePhase: OrchestrationPhase;
      blockedReason: string;
      recordedTurns: number;
      lastHandledTurn: number;
    }
  | {
      kind: 'done_noop';
    };

export function planResumeActions(state: OrchestrationState): ResumeAction[] {
  const actions: ResumeAction[] = [];
  let plannedState = state;

  const statusAction = planStatusResumeAction(plannedState);
  if (statusAction) {
    actions.push(statusAction);
    plannedState = applyPlannedStatusAction(plannedState, statusAction);
  }

  const derivedPlanResumeDisposition = classifyUnexecutedDerivedPlanResumeState(plannedState);
  const derivedPlanAction = toDerivedPlanResumeAction(derivedPlanResumeDisposition);
  if (derivedPlanAction) {
    actions.push(derivedPlanAction);
    plannedState = applyPlannedDerivedPlanAction(plannedState, derivedPlanAction);
  }

  if (needsDerivedPlanNotificationFlush(plannedState)) {
    actions.push({ kind: 'flush_derived_plan_notifications' });
  }

  if (mayRecoverPendingReviewFromCleanCommittedScope(plannedState)) {
    actions.push({ kind: 'recover_pending_review_from_clean_committed_scope' });
  }

  const interactiveRecovery = getInteractiveRecoveryView(plannedState);
  if (interactiveRecovery?.active) {
    if (interactiveRecovery.pendingOperatorGuidance) {
      actions.push({
        kind: 'process_pending_operator_guidance',
        pendingTurnCount: interactiveRecovery.pendingTurnCount,
      });
    } else if (interactiveRecovery.waitingForOperatorGuidance) {
      actions.push({
        kind: 'wait_for_operator_guidance',
        sourcePhase: interactiveRecovery.sourcePhase,
      });
    }
    actions.push({
      kind: 'log_interactive_blocked_recovery',
      sourcePhase: interactiveRecovery.sourcePhase,
      blockedReason: interactiveRecovery.blockedReason,
      recordedTurns: interactiveRecovery.turns.length,
      lastHandledTurn: interactiveRecovery.handledTurn,
    });
  }

  if (actions.length === 0 && plannedState.status === 'done') {
    actions.push({ kind: 'done_noop' });
  }

  return actions;
}

export async function applyResumeActions(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  actions: ResumeAction[],
) {
  let nextState = state;

  for (const action of actions) {
    switch (action.kind) {
      case 'restore_resumable_blocked_phase':
        nextState = await restoreResumableBlockedPhase(nextState, statePath, logger, action);
        break;
      case 'normalize_stopped_status':
        nextState = await normalizeStoppedStatus(nextState, statePath, logger, action);
        break;
      case 'promote_accepted_derived_plan':
      case 'promote_pending_derived_plan_review':
        nextState = await promoteUnexecutedDerivedPlan(nextState, statePath, logger, action);
        break;
      case 'block_rejected_abandoned_derived_plan':
        nextState = await blockRejectedUnexecutedDerivedPlan(nextState, statePath, logger, action);
        break;
      case 'flush_derived_plan_notifications':
        nextState = await flushDerivedPlanNotifications(nextState, statePath, logger);
        break;
      case 'recover_pending_review_from_clean_committed_scope':
        nextState =
          (await recoverPendingReviewFromCleanCommittedScope(
            nextState,
            statePath,
            logger,
            'run.recovered_pending_review_on_resume',
          )) ?? nextState;
        break;
      case 'log_interactive_blocked_recovery':
        await logger?.event('run.resumed_interactive_blocked_recovery', {
          statePath,
          sourcePhase: action.sourcePhase,
          blockedReason: action.blockedReason,
          recordedTurns: action.recordedTurns,
          lastHandledTurn: action.lastHandledTurn,
        });
        break;
      case 'keep_blocked':
      case 'wait_for_operator_guidance':
      case 'process_pending_operator_guidance':
      case 'done_noop':
        break;
    }
  }

  return nextState;
}

function planStatusResumeAction(state: OrchestrationState): ResumeAction | null {
  if (state.status === 'blocked' && isResumableBlockedPhase(state.blockedFromPhase)) {
    const sessionRole = getResumableBlockedSessionRole(state.blockedFromPhase);
    const sessionHandle = sessionRole === 'planner' ? state.plannerSessionHandle : state.coderSessionHandle;
    if (sessionHandle) {
      return {
        kind: 'restore_resumable_blocked_phase',
        phase: state.blockedFromPhase,
        sessionRole,
        sessionHandle,
      };
    }
  }

  if (state.status === 'blocked' && state.phase === 'blocked') {
    return {
      kind: 'keep_blocked',
      blockedFromPhase: state.blockedFromPhase,
    };
  }

  if (state.status !== 'done' && state.status !== 'running' && state.phase !== 'blocked') {
    return {
      kind: 'normalize_stopped_status',
      previousStatus: state.status,
    };
  }

  return null;
}

function applyPlannedStatusAction(state: OrchestrationState, action: ResumeAction): OrchestrationState {
  switch (action.kind) {
    case 'restore_resumable_blocked_phase':
      return {
        ...state,
        phase: action.phase,
        status: 'running',
        blockerReason: null,
      };
    case 'normalize_stopped_status':
      return {
        ...state,
        status: 'running',
        blockerReason: null,
      };
    default:
      return state;
  }
}

function toDerivedPlanResumeAction(disposition: UnexecutedDerivedPlanResumeDisposition): ResumeAction | null {
  switch (disposition.kind) {
    case 'accepted':
      return {
        kind: 'promote_accepted_derived_plan',
        phase: disposition.phase,
      };
    case 'pending_review':
      return {
        kind: 'promote_pending_derived_plan_review',
        phase: disposition.phase,
      };
    case 'rejected':
      return {
        kind: 'block_rejected_abandoned_derived_plan',
        blockedFromPhase: disposition.blockedFromPhase,
        blocker: disposition.blocker,
      };
    case 'none':
      return null;
  }
}

function applyPlannedDerivedPlanAction(state: OrchestrationState, action: ResumeAction): OrchestrationState {
  switch (action.kind) {
    case 'promote_accepted_derived_plan':
    case 'promote_pending_derived_plan_review':
      return {
        ...state,
        phase: action.phase,
        status: 'running',
        blockedFromPhase: null,
        blockerReason: null,
      };
    case 'block_rejected_abandoned_derived_plan':
      return {
        ...state,
        phase: 'blocked',
        status: 'blocked',
        blockedFromPhase: action.blockedFromPhase,
      };
    default:
      return state;
  }
}

function mayRecoverPendingReviewFromCleanCommittedScope(state: OrchestrationState) {
  return (
    state.topLevelMode === 'execute' &&
    state.phase === 'coder_scope' &&
    Boolean(state.baseCommit) &&
    state.finalCommit === null &&
    state.createdCommits.length === 0
  );
}

async function restoreResumableBlockedPhase(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  action: Extract<ResumeAction, { kind: 'restore_resumable_blocked_phase' }>,
) {
  const nextState = await saveState(statePath, {
    ...state,
    phase: action.phase,
    status: 'running',
    // A coder-authored plan-stage response block persists a durable blockerReason;
    // the resume planner is its first blocked->running writer, so clear it here so
    // the reason never outlives its block (and the state satisfies the invariant).
    blockerReason: null,
  });
  await logger?.event('run.resumed_from_blocked', {
    statePath,
    blockedFromPhase: nextState.blockedFromPhase,
    sessionRole: action.sessionRole,
    sessionHandle: action.sessionHandle,
  });
  return nextState;
}

async function normalizeStoppedStatus(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  action: Extract<ResumeAction, { kind: 'normalize_stopped_status' }>,
) {
  const nextState = await saveState(statePath, {
    ...state,
    status: 'running',
    blockerReason: null,
  });
  await logger?.event('run.status_normalized_on_resume', {
    statePath,
    phase: nextState.phase,
    previousStatus: action.previousStatus,
    normalizedStatus: nextState.status,
  });
  return nextState;
}

async function promoteUnexecutedDerivedPlan(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  action: Extract<
    ResumeAction,
    { kind: 'promote_accepted_derived_plan' | 'promote_pending_derived_plan_review' }
  >,
) {
  const previousPhase = state.phase;
  const previousStatus = state.status;
  const derivedPlan = getDerivedPlanView(state);
  const nextState = await saveState(statePath, {
    ...state,
    phase: action.phase,
    status: 'running',
    blockedFromPhase: null,
    blockerReason: null,
  });
  await logger?.event(
    action.kind === 'promote_accepted_derived_plan'
      ? 'run.promoted_accepted_derived_plan_on_resume'
      : 'run.promoted_pending_derived_plan_on_resume',
    {
      statePath,
      previousPhase,
      previousStatus,
      promotedPhase: nextState.phase,
      derivedPlanPath: derivedPlan?.path ?? null,
      derivedFromScopeNumber: derivedPlan?.parentScopeNumber ?? null,
    },
  );
  return nextState;
}

async function blockRejectedUnexecutedDerivedPlan(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  action: Extract<ResumeAction, { kind: 'block_rejected_abandoned_derived_plan' }>,
) {
  const previousPhase = state.phase;
  const previousStatus = state.status;
  const derivedPlan = getDerivedPlanView(state);
  let nextState = await saveState(statePath, {
    ...state,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: action.blockedFromPhase,
  });
  nextState = await persistBlockedScope(nextState, statePath, action.blocker);
  await logger?.event('run.blocked_rejected_derived_plan_on_resume', {
    statePath,
    previousPhase,
    previousStatus,
    blockedFromPhase: nextState.blockedFromPhase,
    blocker: action.blocker,
    derivedPlanPath: derivedPlan?.path ?? null,
    derivedFromScopeNumber: derivedPlan?.parentScopeNumber ?? null,
  });
  return nextState;
}
