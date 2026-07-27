import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { planResumeActions, type ResumeAction } from './resume-planner.js';
import { getInteractiveRecoveryView, getPlanReviewGuidanceOriginPhase } from './state-views.js';
import type { OrchestrationState } from './types.js';

export type ResumeDecision =
  | { kind: 'continue'; reason: string; resumeCommand: string }
  | { kind: 'needs_message'; blocker: string; messageCommand: string; statusCommand: string }
  | { kind: 'pending_message'; reason: string; resumeCommand: string }
  | { kind: 'already_running'; reason: string; statusCommand: string }
  | { kind: 'done'; summary: string; statusCommand: string; retrospectivePath: string | null }
  | { kind: 'cannot_resume'; reason: string; statusCommand: string };

export type ResumeLockEvidence =
  | { kind: 'none' }
  | { kind: 'live_same_run'; runId: string; lockPath?: string; pid?: number; hostname?: string }
  | { kind: 'stale_same_run'; runId: string; lockPath?: string; pid?: number; hostname?: string }
  | { kind: 'live_different_run'; runId: string; lockPath?: string; pid?: number; hostname?: string }
  | { kind: 'stale_different_run'; runId: string; lockPath?: string; pid?: number; hostname?: string }
  | { kind: 'cross_host'; runId: string; lockPath?: string; pid?: number; hostname?: string }
  | { kind: 'unreadable'; reason: string; lockPath?: string };

export type ResumeQueueEvidence =
  | { kind: 'not_linked' }
  | {
      kind: 'active_child';
      queueId: string;
      itemIndex: number;
      stage: string;
      queueStatus?: string;
      itemStatus?: string;
    }
  | {
      kind: 'consumed_child' | 'stale_child' | 'mismatched_child' | 'mismatched_stage' | 'unreadable';
      reason: string;
      queueId?: string;
      itemIndex?: number;
      stage?: string;
    };

export function decideResumeAction(args: {
  state: OrchestrationState;
  selectedRunId: string;
  statePath: string;
  lock?: ResumeLockEvidence;
  queue?: ResumeQueueEvidence | null;
  retrospectivePath?: string | null;
}): ResumeDecision {
  const resumeCommand = formatResumeCommand(args.selectedRunId);
  const messageCommand = formatMessageCommand(args.selectedRunId);
  const statusCommand = formatStatusCommand(args.selectedRunId);
  const lockDecision = decideLockAction(args.lock, args.selectedRunId, statusCommand);
  if (lockDecision) {
    return lockDecision;
  }

  const queueDecision = decideQueueAction(args.queue, statusCommand);
  if (queueDecision) {
    // A consumed queue child whose run itself completed is the ordinary
    // "nothing left to resume" case, not a queue inconsistency: the queue
    // recorded the outcome and moved on. Report it as done instead of
    // surfacing queue-internal bookkeeping as a resume error.
    if (args.queue?.kind === 'consumed_child' && isOrdinaryDone(planResumeActions(args.state))) {
      return {
        kind: 'done',
        summary: args.retrospectivePath
          ? `Run ${args.selectedRunId} is already complete. Latest retrospective: ${args.retrospectivePath}.`
          : `Run ${args.selectedRunId} is already complete.`,
        statusCommand,
        retrospectivePath: args.retrospectivePath ?? null,
      };
    }
    return queueDecision;
  }

  const interactiveRecovery = getInteractiveRecoveryView(args.state);
  if (interactiveRecovery?.active) {
    if (interactiveRecovery.waitingForOperatorGuidance) {
      return {
        kind: 'needs_message',
        blocker: interactiveRecovery.blockedReason,
        messageCommand,
        statusCommand,
      };
    }

    if (interactiveRecovery.pendingOperatorGuidance) {
      return {
        kind: 'pending_message',
        reason: 'Operator guidance is recorded and ready for Neal to process.',
        resumeCommand,
      };
    }
  }

  if (isWaitingForPlanReviewGuidance(args.state)) {
    return {
      kind: 'needs_message',
      blocker: formatPlanReviewGuidanceBlocker(args.state),
      messageCommand,
      statusCommand,
    };
  }

  if (hasPendingPlanReviewGuidance(args.state)) {
    return {
      kind: 'pending_message',
      reason: 'Operator guidance is recorded and ready for Neal to process.',
      resumeCommand,
    };
  }

  const actions = planResumeActions(args.state);
  if (onlyKeepsBlocked(actions)) {
    return {
      kind: 'cannot_resume',
      reason: formatKeptBlockedReason(args.state),
      statusCommand,
    };
  }

  if (isOrdinaryDone(actions)) {
    return {
      kind: 'done',
      summary: args.retrospectivePath
        ? `Run ${args.selectedRunId} is already complete. Latest retrospective: ${args.retrospectivePath}.`
        : `Run ${args.selectedRunId} is already complete.`,
      statusCommand,
      retrospectivePath: args.retrospectivePath ?? null,
    };
  }

  return {
    kind: 'continue',
    reason: formatContinueReason(actions),
    resumeCommand,
  };
}

function isWaitingForPlanReviewGuidance(state: OrchestrationState): boolean {
  // Shared discriminator: reviewer_plan plus coder-authored *response* blocks
  // (which carry a durable blockerReason); dirty-worktree safety blocks at the
  // same response phase have blockerReason null and are excluded. Evaluated before
  // planResumeActions in decideResumeAction, so this needs_message decision takes
  // precedence over a bare-resume restore of a genuine coder-authored block.
  return getPlanReviewGuidanceOriginPhase(state) !== null;
}

function hasPendingPlanReviewGuidance(state: OrchestrationState): boolean {
  return state.topLevelMode === 'plan' && state.pendingPlanReviewGuidance !== null;
}

function formatPlanReviewGuidanceBlocker(state: OrchestrationState) {
  const blockedFrom = state.blockedFromPhase ? ` from ${state.blockedFromPhase}` : '';
  return `Run is blocked${blockedFrom} and is waiting for operator guidance via neal resume --message.`;
}

function decideLockAction(
  lock: ResumeLockEvidence | undefined,
  selectedRunId: string,
  selectedStatusCommand: string,
): ResumeDecision | null {
  switch (lock?.kind) {
    case undefined:
    case 'none':
    case 'stale_same_run':
    case 'stale_different_run':
      return null;
    case 'live_same_run':
      return {
        kind: 'already_running',
        reason: `Run ${selectedRunId} appears to already be running under the active writer lock.`,
        statusCommand: selectedStatusCommand,
      };
    case 'live_different_run':
      return {
        kind: 'cannot_resume',
        reason: `Another Neal writer run is active in this checkout: ${lock.runId}. Continue it with ${formatResumeCommand(lock.runId)} or inspect it with ${formatStatusCommand(lock.runId)}.`,
        statusCommand: formatStatusCommand(lock.runId),
      };
    case 'cross_host':
      return {
        kind: 'cannot_resume',
        reason: `The active writer lock belongs to host ${lock.hostname ?? 'unknown'} for run ${lock.runId}. Inspect that host before resuming a writer run here.`,
        statusCommand: selectedStatusCommand,
      };
    case 'unreadable':
      return {
        kind: 'cannot_resume',
        reason: `The active writer lock could not be read: ${lock.reason}. Inspect the lock before resuming a writer run.`,
        statusCommand: selectedStatusCommand,
      };
  }
}

function decideQueueAction(
  queue: ResumeQueueEvidence | null | undefined,
  statusCommand: string,
): ResumeDecision | null {
  switch (queue?.kind) {
    case undefined:
    case 'not_linked':
    case 'active_child':
      return null;
    case 'consumed_child':
    case 'stale_child':
    case 'mismatched_child':
    case 'mismatched_stage':
    case 'unreadable':
      return {
        kind: 'cannot_resume',
        reason: queue.reason,
        statusCommand,
      };
  }
}

function onlyKeepsBlocked(actions: ResumeAction[]) {
  const controlActions = actions.filter(
    (action) =>
      action.kind !== 'flush_derived_plan_notifications' &&
      action.kind !== 'log_interactive_blocked_recovery',
  );
  return controlActions.length > 0 && controlActions.every((action) => action.kind === 'keep_blocked');
}

function isOrdinaryDone(actions: ResumeAction[]) {
  return actions.length === 1 && actions[0]?.kind === 'done_noop';
}

function formatKeptBlockedReason(state: OrchestrationState) {
  const blockedFrom = state.blockedFromPhase ? ` from ${state.blockedFromPhase}` : '';
  const diagnostics = formatTerminalBlockDiagnostics(state);
  return diagnostics
    ? `Run is blocked${blockedFrom} and cannot be mechanically resumed. ${diagnostics} Inspect status and artifacts before adding guidance.`
    : `Run is blocked${blockedFrom} and cannot be mechanically resumed. Inspect status and artifacts before adding guidance.`;
}

function formatContinueReason(actions: ResumeAction[]) {
  const actionKinds = actions.map((action) => action.kind).filter((kind) => kind !== 'log_interactive_blocked_recovery');
  if (actionKinds.length === 0) {
    return 'Run is in a resumable state.';
  }
  return `Resume planner selected ${actionKinds.join(', ')}.`;
}

function formatResumeCommand(runId: string) {
  return `neal resume --run ${runId}`;
}

function formatMessageCommand(runId: string) {
  return `neal resume --run ${runId} --message "..."`;
}

function formatStatusCommand(runId: string) {
  return `neal status --run ${runId}`;
}

function formatTerminalBlockDiagnostics(state: OrchestrationState): string | null {
  const invalidPayloadPath = findCurrentInvalidSplitPlanPayloadArtifactPath(state);
  const parts = [
    latestRecoveryBlocker(state) ?? currentOrLatestBlockedCompletedScopeBlocker(state),
    invalidPayloadPath ? `Invalid payload artifact: ${invalidPayloadPath}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' ') : null;
}

function latestRecoveryBlocker(state: OrchestrationState): string | null {
  const active = state.interactiveBlockedRecovery;
  if (active) {
    const candidate =
      nonEmptyString(active.pendingDirective?.operatorGuidance) ?? nonEmptyString(active.blockedReason);
    if (candidate) {
      return candidate;
    }
  }
  for (const record of [...state.interactiveBlockedRecoveryHistory].reverse()) {
    const candidate = nonEmptyString(record.blockedReason);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function currentOrLatestBlockedCompletedScopeBlocker(state: OrchestrationState): string | null {
  const blockedScopes = state.completedScopes.filter((scope) => scope.result === 'blocked' && scope.blocker);
  const currentScope = blockedScopes.find((scope) => scope.number === String(state.currentScopeNumber));
  return currentScope?.blocker ?? blockedScopes.at(-1)?.blocker ?? null;
}

function findCurrentInvalidSplitPlanPayloadArtifactPath(state: OrchestrationState): string | null {
  const artifactPath = join(state.runDir, `SCOPE_${state.currentScopeNumber}_INVALID_DERIVED_PLAN.md`);
  return existsSync(artifactPath) ? artifactPath : null;
}
