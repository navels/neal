import { basename } from 'node:path';

import { notify } from '../../notifier.js';
import type { RunLogger } from '../logger.js';
import { getCurrentScopeLabel, getParentScopeLabel } from '../scopes.js';
import { saveState } from '../state.js';
import type { OrchestrationState } from '../types.js';

async function notifyBlocked(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.blocked', { reason, planName });
  await notify('blocked', `[neal] ${planName}: ${reason}`, state.cwd);
}

async function notifyInteractiveBlockedRecovery(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  await logger?.event('notify.interactive_blocked_recovery', {
    reason,
    planName,
    scopeNumber: scopeLabel,
  });
  await notify('retry', `[neal] ${planName}: interactive blocked recovery for scope ${scopeLabel}: ${reason}`, state.cwd);
}

async function notifyComplete(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.complete', { message, planName });
  await notify('complete', `[neal] ${planName}: plan complete: ${message}`, state.cwd);
}

async function notifyScopeAccepted(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  await logger?.event('notify.scope_complete', {
    message,
    planName,
    scopeNumber: scopeLabel,
  });
  await notify('complete', `[neal] ${planName}: scope ${scopeLabel} complete: ${message}`, state.cwd);
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

async function notifySplitPlanStarted(state: OrchestrationState, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  await logger?.event('notify.split_plan_started', {
    planName,
    scopeNumber: scopeLabel,
    derivedPlanPath: state.derivedPlanPath,
  });
  await notify('retry', `[neal] ${planName}: scope ${scopeLabel} split into derived plan; reviewing`, state.cwd);
}

async function notifyDerivedPlanAccepted(state: OrchestrationState, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getParentScopeLabel(state);
  await logger?.event('notify.derived_plan_accepted', {
    planName,
    scopeNumber: scopeLabel,
    derivedPlanPath: state.derivedPlanPath,
  });
  await notify('complete', `[neal] ${planName}: derived plan accepted for scope ${scopeLabel}`, state.cwd);
}

async function notifyDerivedPlanFailed(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  const scopeLabel = getParentScopeLabel(state);
  await logger?.event('notify.derived_plan_failed', {
    planName,
    scopeNumber: scopeLabel,
    derivedPlanPath: state.derivedPlanPath,
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

  if (nextState.derivedPlanPath && nextState.derivedPlanStatus === 'pending_review' && !nextState.splitPlanStartedNotified) {
    await notifySplitPlanStarted(nextState, logger);
    nextState = await saveState(statePath, {
      ...nextState,
      splitPlanStartedNotified: true,
    });
  }

  if (nextState.derivedPlanStatus === 'accepted' && !nextState.derivedPlanAcceptedNotified) {
    await notifyDerivedPlanAccepted(nextState, logger);
    nextState = await saveState(statePath, {
      ...nextState,
      derivedPlanAcceptedNotified: true,
    });
  }

  const blockReason = explicitBlockReason ?? getCurrentScopeBlockedReason(nextState);
  if (nextState.status === 'blocked' && nextState.lastScopeMarker === 'AUTONOMY_SPLIT_PLAN' && !nextState.splitPlanBlockedNotified) {
    if (nextState.derivedPlanPath) {
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
  notifyRetry,
  notifyScopeAccepted,
  notifySplitPlanRejected,
  notifySplitPlanStarted,
};
