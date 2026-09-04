import { basename } from 'node:path';

import { buildBlockedGuidance } from './blocked-guidance.js';
import { writeNarrative } from './diagnostic.js';
import { EXECUTE_FINALIZATION_PHASE } from './execute-finalization.js';
import type { RunLogger } from './logger.js';
import { formatPublicPhase } from './phase-display.js';
import { formatPublicRunStatus, getRunDisplayStatus } from './run-status.js';
import {
  getCurrentExecutionScopeDescriptor,
  getCurrentScopeLabel,
  type ExecutionPlanScopeDescriptor,
} from './scopes.js';
import {
  getDerivedPlanView,
  getFinalCompletionView,
  getInteractiveRecoveryView,
} from './state-views.js';
import type { OrchestrationState } from './types.js';

export type TerminalNarrativeEvent = {
  signature: string;
  line: string;
};

type TerminalNarratorOptions = {
  logger?: RunLogger;
  write?: (message: string, logger?: RunLogger) => void;
};

export type TerminalNarrator = {
  start: (state: OrchestrationState) => Promise<void>;
  observe: (state: OrchestrationState) => Promise<void>;
};

export type TerminalNarrativeScopeContext = {
  current?: ExecutionPlanScopeDescriptor | null;
  previous?: ExecutionPlanScopeDescriptor | null;
  currentIntroAlreadyPrinted?: boolean;
  previousIntroAlreadyPrinted?: boolean;
  currentIntroSequence?: number;
};

type ScopeNarrationOptions = {
  scopeIntroEstablished: boolean;
};

export function createTerminalNarrator(options: TerminalNarratorOptions = {}): TerminalNarrator {
  const seen = new Set<string>();
  const write = options.write ?? writeNarrative;
  let previous: OrchestrationState | null = null;
  let previousScopeDescriptor: ExecutionPlanScopeDescriptor | null = null;
  let announcedScopeContextKey: string | null = null;
  let scopeIntroSequence = 0;
  let started = false;

  function emit(event: TerminalNarrativeEvent) {
    if (seen.has(event.signature)) {
      return;
    }

    seen.add(event.signature);
    write(`${event.line}\n`, options.logger);
  }

  async function observeState(state: OrchestrationState, includeStartEvent: boolean) {
    const scopeDescriptor = await getNarrativeScopeDescriptor(state);
    const currentScopeContextKey = getScopeContextKey(scopeDescriptor);
    const previousScopeContextKey = getScopeContextKey(previousScopeDescriptor);
    const currentIntroAlreadyPrinted =
      currentScopeContextKey !== null && currentScopeContextKey === announcedScopeContextKey;
    const previousIntroAlreadyPrinted =
      previousScopeContextKey !== null && previousScopeContextKey === announcedScopeContextKey;

    if (includeStartEvent && !started) {
      started = true;
      emit(renderRunStartEvent(state));
    }

    const events = renderTerminalNarrativeEvents(state, previous, {
      current: scopeDescriptor,
      previous: previousScopeDescriptor,
      currentIntroAlreadyPrinted,
      previousIntroAlreadyPrinted,
      currentIntroSequence: scopeIntroSequence + 1,
    });
    for (const event of events) {
      emit(event);
    }

    if (currentScopeContextKey && events.some((event) => event.signature.startsWith('scope-intro:'))) {
      scopeIntroSequence += 1;
      announcedScopeContextKey = currentScopeContextKey;
    }

    previous = state;
    previousScopeDescriptor = scopeDescriptor;
  }

  return {
    async start(state) {
      await observeState(state, true);
    },
    async observe(state) {
      await observeState(state, false);
    },
  };
}

export function renderTerminalNarrativeEvents(
  state: OrchestrationState,
  previous: OrchestrationState | null = null,
  scopeContext: TerminalNarrativeScopeContext = {},
): TerminalNarrativeEvent[] {
  const currentScopeDescriptor = scopeContext.current ?? null;
  const currentIntroAlreadyPrinted = scopeContext.currentIntroAlreadyPrinted ?? false;
  const shouldRenderIntro = shouldRenderCurrentScopeIntro(state, currentScopeDescriptor, currentIntroAlreadyPrinted);
  const scopeIntroEstablished = currentIntroAlreadyPrinted || shouldRenderIntro;

  return [
    ...renderCompletedScopeEvents(
      state,
      previous,
      scopeContext.previous ?? currentScopeDescriptor,
      scopeContext.previousIntroAlreadyPrinted ?? currentIntroAlreadyPrinted,
    ),
    ...(shouldRenderIntro && currentScopeDescriptor
      ? [renderScopeIntroEvent(state, currentScopeDescriptor, scopeContext.currentIntroSequence ?? 0)]
      : []),
    ...renderPhaseEvents(state, currentScopeDescriptor, { scopeIntroEstablished }),
    ...renderFinalCompletionResolutionEvents(state, currentScopeDescriptor, { scopeIntroEstablished }),
    ...renderLifecycleEvents(state, currentScopeDescriptor, { scopeIntroEstablished }),
  ];
}

async function getNarrativeScopeDescriptor(state: OrchestrationState) {
  if (state.topLevelMode !== 'execute') {
    return null;
  }

  return getCurrentExecutionScopeDescriptor(state);
}

function renderRunStartEvent(state: OrchestrationState): TerminalNarrativeEvent {
  const runId = basename(state.runDir);
  const planName = basename(state.planDoc);
  const action = hasPriorRunActivity(state) ? 'resuming' : 'starting';
  const mode = state.topLevelMode === 'plan' ? 'plan refinement' : 'plan execution';

  return {
    signature: `run-start:${runId}`,
    line: `[neal] ${action} ${mode} for ${planName}`,
  };
}

function hasPriorRunActivity(state: OrchestrationState) {
  return Boolean(
    state.rounds.length > 0 ||
      state.completedScopes.length > 0 ||
      state.createdCommits.length > 0 ||
      state.coderSessionHandle ||
      state.reviewerSessionHandle ||
      state.finalCommit ||
      state.interactiveBlockedRecovery ||
      state.interactiveBlockedRecoveryHistory.length > 0 ||
      state.finalCompletionSummary ||
      state.finalCompletionReviewVerdict ||
      state.finalCompletionResolvedAction,
  );
}

function renderCompletedScopeEvents(
  state: OrchestrationState,
  previous: OrchestrationState | null,
  scopeDescriptor: ExecutionPlanScopeDescriptor | null,
  scopeIntroEstablished: boolean,
): TerminalNarrativeEvent[] {
  if (!previous || state.topLevelMode !== 'execute') {
    return [];
  }

  const completedScopes = state.completedScopes.slice(previous.completedScopes.length);
  return completedScopes.map((scope) => ({
    signature: `scope-finalized:${basename(state.runDir)}:${scope.number}:${scope.finalCommit ?? 'pending'}`,
    line: formatCompletedScopeLine(scope.number, scope.result, scopeDescriptor, { scopeIntroEstablished }),
  }));
}

function renderPhaseEvents(
  state: OrchestrationState,
  scopeDescriptor: ExecutionPlanScopeDescriptor | null,
  options: ScopeNarrationOptions,
): TerminalNarrativeEvent[] {
  const runId = basename(state.runDir);
  const scopeLabel = getCurrentScopeLabel(state);
  const scopeReference = formatScopeReference(scopeLabel, scopeDescriptor);
  const phase = state.phase;
  const round = state.rounds.length + 1;
  const recovery = getInteractiveRecoveryView(state);
  const derivedPlan = getDerivedPlanView(state);
  const finalCompletion = getFinalCompletionView(state);
  const displayStatus = getRunDisplayStatus(state);

  if (displayStatus.waitingForOperatorGuidance) {
    const guidance = buildBlockedGuidance({
      state,
      runId,
      waitingForOperatorGuidance: true,
    });
    const firstOption = guidance?.options[0]?.command;
    if (guidance && firstOption) {
      return [
        {
          signature: `operator-waiting:${runId}:${recovery?.sourcePhase ?? state.blockedFromPhase ?? phase}:${recovery?.handledTurn ?? 0}:${guidance.category}`,
          line: `[neal] waiting for operator guidance: ${guidance.summary}; use: ${firstOption}`,
        },
      ];
    }

    return [
      {
        signature: `operator-waiting:${runId}:${recovery?.sourcePhase ?? state.blockedFromPhase ?? phase}:${recovery?.handledTurn ?? 0}`,
        line: `[neal] waiting for operator guidance; use: neal resume --run ${runId} --message "..."`,
      },
    ];
  }

  if (displayStatus.pendingOperatorGuidance) {
    return [
      {
        signature: `operator-pending:${runId}:${recovery?.pendingTurnCount ?? 0}:${recovery?.handledTurn ?? 0}`,
        line: `Operator guidance is recorded; resuming will process it now.`,
      },
    ];
  }

  switch (phase) {
    case 'coder_plan':
      return [
        {
          signature: `phase:${runId}:${phase}:${round}`,
          line: `Planner is refining the plan.`,
        },
      ];
    case 'reviewer_plan':
      return [
        {
          signature: `phase:${runId}:${phase}:${round}:${derivedPlan?.state ?? 'ordinary'}`,
          line: derivedPlan?.reviewActive
            ? `Reviewer is checking the derived plan for scope ${derivedPlan.parentScopeNumber ?? scopeLabel}.`
            : `Reviewer is checking the plan.`,
        },
      ];
    case 'coder_plan_response':
      return [
        {
          signature: `phase:${runId}:${phase}:${round}`,
          line: `Planner is addressing requested plan revisions.`,
        },
      ];
    case 'coder_plan_optional_response':
      return [
        {
          signature: `phase:${runId}:${phase}:${round}`,
          line: `Planner is handling optional plan follow-up.`,
        },
      ];
    case 'awaiting_derived_plan_execution':
      return [
        {
          signature: `phase:${runId}:${phase}:${derivedPlan?.path ?? 'unknown'}`,
          line: `Derived plan accepted; preparing its first scope.`,
        },
      ];
    case 'coder_scope':
      return [
        {
          signature: `phase:${runId}:${phase}:${scopeLabel}:${state.baseCommit ?? 'no-base'}:${state.createdCommits.length}`,
          line: options.scopeIntroEstablished ? `Coder is implementing.` : `Coder is implementing ${scopeReference}.`,
        },
      ];
    case 'manual_gate':
      return [
        {
          signature: `phase:${runId}:${phase}:${state.manualGate?.id ?? 'unknown'}`,
          line: `Run is waiting for manual gate ${state.manualGate?.id ?? 'unknown'}.`,
        },
      ];
    case 'reviewer_scope':
      return [
        {
          signature: `phase:${runId}:${phase}:${scopeLabel}:${round}:${state.createdCommits.at(-1) ?? 'no-commit'}`,
          line: options.scopeIntroEstablished ? `Reviewer is checking.` : `Reviewer is checking ${scopeReference}.`,
        },
      ];
    case 'coder_response':
      return [
        {
          signature: `phase:${runId}:${phase}:${scopeLabel}:${round}`,
          line: options.scopeIntroEstablished
            ? `Reviewer requested revisions; coder is addressing them.`
            : `Reviewer requested revisions for ${scopeReference}; coder is addressing them.`,
        },
      ];
    case 'coder_optional_response':
      return [
        {
          signature: `phase:${runId}:${phase}:${scopeLabel}:${round}`,
          line: options.scopeIntroEstablished
            ? `Reviewer left optional follow-up; coder is handling it.`
            : `Reviewer left optional follow-up for ${scopeReference}; coder is handling it.`,
        },
      ];
    case 'interactive_blocked_recovery':
      return [
        {
          signature: `phase:${runId}:${phase}:${recovery?.sourcePhase ?? state.blockedFromPhase ?? 'unknown'}`,
          line: formatScopeRelatedPhase(recovery?.sourcePhase ?? state.blockedFromPhase ?? phase)
            ? options.scopeIntroEstablished
              ? `Interactive recovery is active for ${formatPublicPhase(recovery?.sourcePhase ?? state.blockedFromPhase ?? phase)}.`
              : `Interactive recovery is active for ${formatPublicPhase(recovery?.sourcePhase ?? state.blockedFromPhase ?? phase)} on ${scopeReference}.`
            : `Interactive recovery is active for ${formatPublicPhase(recovery?.sourcePhase ?? state.blockedFromPhase ?? phase)}.`,
        },
      ];
    case EXECUTE_FINALIZATION_PHASE:
      return [
        {
          signature: `phase:${runId}:${phase}:${scopeLabel}:${state.createdCommits.length}`,
          line: options.scopeIntroEstablished
            ? `Reviewer accepted; finalizing.`
            : `Reviewer accepted ${scopeReference}; finalizing.`,
        },
      ];
    case 'final_completion_review':
      return [
        {
          signature: `phase:${runId}:${phase}:${finalCompletion?.continueExecutionCount ?? 0}`,
          line: `Reviewer is checking final completion.`,
        },
      ];
    case 'done':
    case 'blocked':
      return [];
  }
}

function renderFinalCompletionResolutionEvents(
  state: OrchestrationState,
  scopeDescriptor: ExecutionPlanScopeDescriptor | null,
  options: ScopeNarrationOptions,
): TerminalNarrativeEvent[] {
  if (state.topLevelMode !== 'execute') {
    return [];
  }

  const finalCompletion = getFinalCompletionView(state);
  if (!finalCompletion?.hasResolvedAction) {
    return [];
  }

  const runId = basename(state.runDir);
  const action = finalCompletion.effectiveAction;
  if (action === 'accept_complete') {
    return [
      {
        signature: `final-completion:${runId}:${action}`,
        line: `Final completion review accepted the implementation.`,
      },
    ];
  }
  if (action === 'continue_execution') {
    const scopeReference = formatScopeReference(getCurrentScopeLabel(state), scopeDescriptor);
    return [
      {
        signature: `final-completion:${runId}:${action}:${finalCompletion.continueExecutionCount}`,
        line: options.scopeIntroEstablished
          ? `Final completion review reopened execution; continuing.`
          : `Final completion review reopened execution; continuing with ${scopeReference}.`,
      },
    ];
  }
  if (action === 'block_for_operator') {
    return [
      {
        signature: `final-completion:${runId}:${action}:${finalCompletion.continueExecutionCount}`,
        line: `Final completion review blocked completion for operator guidance.`,
      },
    ];
  }

  return [];
}

function renderLifecycleEvents(
  state: OrchestrationState,
  scopeDescriptor: ExecutionPlanScopeDescriptor | null,
  options: ScopeNarrationOptions,
): TerminalNarrativeEvent[] {
  const displayStatus = getRunDisplayStatus(state);
  const publicStatus = formatPublicRunStatus(displayStatus);
  const runId = basename(state.runDir);
  const scopeReference = formatScopeReference(getCurrentScopeLabel(state), scopeDescriptor);

  if (displayStatus.waitingForOperatorGuidance || displayStatus.pendingOperatorGuidance) {
    return [];
  }

  if (state.status === 'paused') {
    return [
      {
        signature: `lifecycle:${runId}:paused:${state.phase}:${getCurrentScopeLabel(state)}`,
        line: options.scopeIntroEstablished ? `Run paused after this scope.` : `Run paused after ${scopeReference}.`,
      },
    ];
  }

  if (state.status === 'failed') {
    return [
      {
        signature: `lifecycle:${runId}:failed:${state.phase}`,
        line: `Run failed during ${formatPublicPhase(state.phase)}.`,
      },
    ];
  }

  if (state.status === 'blocked') {
    const blockedPhase = state.blockedFromPhase ?? state.phase;
    const blockLine = formatScopeRelatedPhase(blockedPhase)
      ? options.scopeIntroEstablished
        ? `Run is blocked during ${formatPublicPhase(blockedPhase)}.`
        : `Run is blocked during ${formatPublicPhase(blockedPhase)} for ${scopeReference}.`
      : `Run is blocked during ${formatPublicPhase(blockedPhase)}.`;
    const reason = (state.blockerReason ?? state.interactiveBlockedRecovery?.blockedReason ?? '').replace(/\s+/g, ' ').trim();
    return [
      {
        signature: `lifecycle:${runId}:blocked:${blockedPhase}`,
        line: reason ? `${blockLine} ${reason}` : blockLine,
      },
    ];
  }

  if (state.status === 'done') {
    return [
      {
        signature: `lifecycle:${runId}:done:${state.topLevelMode}:${publicStatus}`,
        line: state.topLevelMode === 'plan' ? `Plan refinement complete.` : `Implementation complete.`,
      },
    ];
  }

  return [];
}

function renderScopeIntroEvent(
  state: OrchestrationState,
  scopeDescriptor: ExecutionPlanScopeDescriptor,
  sequence: number,
): TerminalNarrativeEvent {
  const scopeContextKey = getScopeContextKey(scopeDescriptor) ?? scopeDescriptor.display;
  return {
    signature: `scope-intro:${basename(state.runDir)}:${sequence}:${scopeContextKey}`,
    line: capitalizeLeadingScope(scopeDescriptor.display),
  };
}

function shouldRenderCurrentScopeIntro(
  state: OrchestrationState,
  scopeDescriptor: ExecutionPlanScopeDescriptor | null,
  currentIntroAlreadyPrinted: boolean,
) {
  return Boolean(scopeDescriptor && !currentIntroAlreadyPrinted && hasCurrentScopeNarrativeEvent(state));
}

function hasCurrentScopeNarrativeEvent(state: OrchestrationState) {
  if (state.topLevelMode !== 'execute') {
    return false;
  }

  const displayStatus = getRunDisplayStatus(state);
  if (displayStatus.waitingForOperatorGuidance || displayStatus.pendingOperatorGuidance) {
    return false;
  }

  if (isScopeActionPhase(state.phase)) {
    return true;
  }

  if (state.phase === 'interactive_blocked_recovery') {
    const recovery = getInteractiveRecoveryView(state);
    return formatScopeRelatedPhase(recovery?.sourcePhase ?? state.blockedFromPhase ?? state.phase);
  }

  const finalCompletion = getFinalCompletionView(state);
  if (finalCompletion?.hasResolvedAction && finalCompletion.effectiveAction === 'continue_execution') {
    return true;
  }

  if (state.status === 'paused') {
    return true;
  }

  return state.status === 'blocked' && formatScopeRelatedPhase(state.blockedFromPhase ?? state.phase);
}

function formatScopeReference(
  scopeLabel: string,
  descriptor: ExecutionPlanScopeDescriptor | null,
  options: { capitalized?: boolean } = {},
) {
  const reference = descriptor?.scopeLabel === scopeLabel ? descriptor.display : `scope ${scopeLabel}`;
  if (!options.capitalized) {
    return reference;
  }

  return reference[0]?.toUpperCase() + reference.slice(1);
}

function formatCompletedScopeLine(
  scopeLabel: string,
  result: string,
  descriptor: ExecutionPlanScopeDescriptor | null,
  options: ScopeNarrationOptions,
) {
  if (options.scopeIntroEstablished) {
    return result === 'accepted' ? `Scope accepted.` : `Scope blocked.`;
  }

  if (descriptor?.scopeLabel !== scopeLabel || !descriptor.title) {
    return `Scope ${scopeLabel} finalized and ${result}.`;
  }

  const scopeReference = formatScopeReference(scopeLabel, descriptor, { capitalized: true });
  return `${scopeReference.replace(`: ${descriptor.title}`, '')} finalized and ${result}: ${descriptor.title}.`;
}

function getScopeContextKey(descriptor: ExecutionPlanScopeDescriptor | null | undefined) {
  if (!descriptor) {
    return null;
  }

  return JSON.stringify([
    descriptor.planPath,
    descriptor.scopeLabel,
    descriptor.planScopeNumber,
    formatScopeCountKey(descriptor.scopeCount),
    descriptor.title,
    descriptor.display,
  ]);
}

function formatScopeCountKey(scopeCount: ExecutionPlanScopeDescriptor['scopeCount']) {
  return scopeCount.kind === 'known' ? `${scopeCount.kind}:${scopeCount.total}` : scopeCount.kind;
}

function capitalizeLeadingScope(value: string) {
  if (value === '') {
    return value;
  }

  return value[0]!.toUpperCase() + value.slice(1);
}

function isScopeActionPhase(phase: OrchestrationState['phase']) {
  return (
    phase === 'coder_scope' ||
    phase === 'reviewer_scope' ||
    phase === 'coder_response' ||
    phase === 'coder_optional_response' ||
    phase === EXECUTE_FINALIZATION_PHASE
  );
}

function formatScopeRelatedPhase(phase: OrchestrationState['phase']) {
  return (
    phase === 'coder_scope' ||
    phase === 'reviewer_scope' ||
    phase === 'coder_response' ||
    phase === 'coder_optional_response' ||
    phase === EXECUTE_FINALIZATION_PHASE
  );
}
