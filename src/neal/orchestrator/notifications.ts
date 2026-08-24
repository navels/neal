import { basename } from 'node:path';

import { notify } from '../../notifier.js';
import type { RunLogger } from '../logger.js';
import {
  getCurrentScopeLabel,
  getExecutionPlanPath,
  getExecutionPlanScopeCount,
  getParentScopeLabel,
  renderScopeProgressSegments,
} from '../scopes.js';
import { saveState } from '../state.js';
import { getDerivedPlanView } from '../state-views.js';
import type { OrchestrationState } from '../types.js';

// Concise representation of the read-only consultant advice for the
// operator notification surface. Present only on a run whose active
// interactive-blocked-recovery record carries consultant advice (knob > 0,
// budget available, eligible source phase). Returns '' otherwise so notification
// behavior for recovery states without advice — and terminal blocked
// notifications, where the active record is already finalized to null — is
// unchanged.
function consultantAdviceNotificationSuffix(state: OrchestrationState): string {
  const advice = state.interactiveBlockedRecovery?.consultantAdvice;
  if (!advice) {
    return '';
  }
  const directive = advice.resolutionDirective.trim() || 'n/a';
  return ` | consultant advice (read-only): triage ${advice.triageCategory}; suggested directive: ${directive}`;
}

async function notifyBlocked(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const adviceSuffix = consultantAdviceNotificationSuffix(state);
  await logger?.event('notify.blocked', {
    reason,
    planName,
    consultantAdvice: state.interactiveBlockedRecovery?.consultantAdvice ?? null,
  });
  await notify('blocked', `[neal] ${planName}: ${reason}${adviceSuffix}`, state.cwd);
}

async function notifyInteractiveBlockedRecovery(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  const adviceSuffix = consultantAdviceNotificationSuffix(state);
  await logger?.event('notify.interactive_blocked_recovery', {
    reason,
    planName,
    scopeNumber: scopeLabel,
    consultantAdvice: state.interactiveBlockedRecovery?.consultantAdvice ?? null,
  });
  await notify(
    'retry',
    `[neal] ${planName}: interactive blocked recovery for scope ${scopeLabel}: ${reason}${adviceSuffix}`,
    state.cwd,
  );
}

async function notifyComplete(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const completionLabel = state.topLevelMode === 'plan' ? 'plan complete' : 'implementation complete';
  await logger?.event('notify.complete', { message, planName, completionLabel });
  await notify('complete', `[neal] ${planName}: ${completionLabel}: ${message}`, state.cwd);
}

async function notifyScopeAccepted(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  const totalScopeCount = await getExecutionPlanScopeCount(getExecutionPlanPath(state));
  const { scopeSegment, derivedSegment } = renderScopeProgressSegments(state, totalScopeCount);
  const progressSegment =
    derivedSegment && totalScopeCount.kind !== 'unavailable'
      ? `${scopeSegment} complete (${derivedSegment})`
      : `${scopeSegment} complete`;
  await logger?.event('notify.scope_complete', {
    message,
    planName,
    scopeNumber: scopeLabel,
    totalScopeCount,
  });
  await notify('complete', `[neal] ${planName}: ${progressSegment}: ${message}`, state.cwd);
}

async function notifyRetry(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.retry', {
    message,
    planName,
    scopeNumber: getCurrentScopeLabel(state),
    phase: state.phase,
  });
  await notify('retry', `[neal] ${planName}: ${message}`, state.cwd);
}

async function notifyManualGate(state: OrchestrationState, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const gate = state.manualGate;
  if (!gate) {
    return;
  }
  await logger?.event('notify.manual_gate', {
    planName,
    scopeNumber: getCurrentScopeLabel(state),
    gateId: gate.id,
    title: gate.title,
    instructionsPath: gate.instructionsPath,
  });
  await notify(
    'retry',
    `[neal] ${planName}: waiting for manual gate ${gate.id}: ${gate.title}; resume with neal resume --run ${basename(state.runDir)}`,
    state.cwd,
  );
}

async function notifySplitPlanStarted(state: OrchestrationState, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  const derivedPlan = getDerivedPlanView(state);
  await logger?.event('notify.split_plan_started', {
    planName,
    scopeNumber: scopeLabel,
    derivedPlanPath: derivedPlan?.path ?? null,
  });
  await notify('retry', `[neal] ${planName}: scope ${scopeLabel} split into derived plan; reviewing`, state.cwd);
}

async function notifyDerivedPlanAccepted(state: OrchestrationState, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getParentScopeLabel(state);
  const derivedPlan = getDerivedPlanView(state);
  await logger?.event('notify.derived_plan_accepted', {
    planName,
    scopeNumber: scopeLabel,
    derivedPlanPath: derivedPlan?.path ?? null,
  });
  await notify('complete', `[neal] ${planName}: derived plan accepted for scope ${scopeLabel}`, state.cwd);
}

async function notifyDerivedPlanFailed(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getParentScopeLabel(state);
  const derivedPlan = getDerivedPlanView(state);
  await logger?.event('notify.derived_plan_failed', {
    planName,
    scopeNumber: scopeLabel,
    derivedPlanPath: derivedPlan?.path ?? null,
    reason,
  });
  await notify('blocked', `[neal] ${planName}: blocked: derived plan review did not converge`, state.cwd);
}

async function notifySplitPlanRejected(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  await logger?.event('notify.split_plan_rejected', {
    planName,
    scopeNumber: scopeLabel,
    reason,
  });
  await notify('blocked', `[neal] ${planName}: blocked: split-plan recovery rejected for scope ${scopeLabel}`, state.cwd);
}

function getCurrentScopeBlockedReason(state: OrchestrationState) {
  const currentScope = state.completedScopes.find((scope) => scope.number === getCurrentScopeLabel(state));
  return currentScope?.blocker ?? null;
}

export async function flushDerivedPlanNotifications(
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
  explicitBlockReason?: string,
) {
  let nextState = state;

  if (nextState.topLevelMode !== 'execute') {
    return nextState;
  }

  let derivedPlan = getDerivedPlanView(nextState);

  if (derivedPlan?.notifications.needsSplitPlanStartedNotification) {
    await notifySplitPlanStarted(nextState, logger);
    nextState = await saveState(statePath, {
      ...nextState,
      splitPlanStartedNotified: true,
    });
    derivedPlan = getDerivedPlanView(nextState);
  }

  if (derivedPlan?.notifications.needsDerivedPlanAcceptedNotification) {
    await notifyDerivedPlanAccepted(nextState, logger);
    nextState = await saveState(statePath, {
      ...nextState,
      derivedPlanAcceptedNotified: true,
    });
    derivedPlan = getDerivedPlanView(nextState);
  }

  const blockReason = explicitBlockReason ?? getCurrentScopeBlockedReason(nextState);
  if (nextState.status === 'blocked' && nextState.lastScopeMarker === 'AUTONOMY_SPLIT_PLAN' && !nextState.splitPlanBlockedNotified) {
    if (derivedPlan?.abandoned) {
      await notifyDerivedPlanFailed(nextState, blockReason ?? 'split-plan recovery failed');
    } else {
      await notifySplitPlanRejected(nextState, blockReason ?? 'split-plan recovery rejected');
    }
    nextState = await saveState(statePath, {
      ...nextState,
      splitPlanBlockedNotified: true,
    });
  }

  return nextState;
}

export {
  notifyBlocked,
  notifyComplete,
  notifyDerivedPlanAccepted,
  notifyDerivedPlanFailed,
  notifyInteractiveBlockedRecovery,
  notifyManualGate,
  notifyRetry,
  notifyScopeAccepted,
  notifySplitPlanRejected,
  notifySplitPlanStarted,
};
