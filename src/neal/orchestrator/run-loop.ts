import type { RunLogger } from '../logger.js';
import type { OrchestrationState } from '../types.js';

export type RunnablePhase = Extract<
  OrchestrationState['phase'],
  | 'coder_plan'
  | 'diagnostic_recovery_analyze'
  | 'diagnostic_recovery_author_plan'
  | 'diagnostic_recovery_review'
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'awaiting_derived_plan_execution'
  | 'coder_scope'
  | 'reviewer_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'reviewer_consult'
  | 'coder_consult_response'
  | 'interactive_blocked_recovery'
  | 'final_squash'
  | 'final_completion_review'
>;

export type RunnableHandlerKey = Extract<
  RunnablePhase,
  | 'coder_plan'
  | 'diagnostic_recovery_analyze'
  | 'diagnostic_recovery_author_plan'
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'awaiting_derived_plan_execution'
  | 'coder_scope'
  | 'reviewer_scope'
  | 'coder_response'
  | 'reviewer_consult'
  | 'coder_consult_response'
  | 'interactive_blocked_recovery'
  | 'final_squash'
  | 'final_completion_review'
>;

const RUNNABLE_PHASES = new Set<RunnablePhase>([
  'coder_plan',
  'diagnostic_recovery_analyze',
  'diagnostic_recovery_author_plan',
  'diagnostic_recovery_review',
  'reviewer_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
  'awaiting_derived_plan_execution',
  'coder_scope',
  'reviewer_scope',
  'coder_response',
  'coder_optional_response',
  'reviewer_consult',
  'coder_consult_response',
  'interactive_blocked_recovery',
  'final_squash',
  'final_completion_review',
]);

export type RunOnePassOptions = {
  shouldStopAfterCurrentScope?: () => boolean;
  onCoderSessionHandle?: (sessionHandle: string | null) => void;
  onDisplayState?: (state: OrchestrationState, phaseStartedAt: number) => void | Promise<void>;
};

type RunnablePhaseHandler = (state: OrchestrationState) => Promise<OrchestrationState>;

export type RunLoopRuntime = {
  hasPendingInteractiveBlockedRecoveryTurn: (state: OrchestrationState) => boolean;
  startPhaseHeartbeat: (
    phase: OrchestrationState['phase'],
    getState: () => OrchestrationState,
    logger?: RunLogger,
  ) => () => void;
  writeCheckpointRetrospective: (state: OrchestrationState, reason: 'blocked' | 'done') => Promise<void>;
};

export type RunLoopHandlers = {
  coder_plan: RunnablePhaseHandler;
  diagnostic_recovery_analyze: RunnablePhaseHandler;
  diagnostic_recovery_author_plan: RunnablePhaseHandler;
  reviewer_plan: RunnablePhaseHandler;
  coder_plan_response: RunnablePhaseHandler;
  awaiting_derived_plan_execution: RunnablePhaseHandler;
  coder_scope: RunnablePhaseHandler;
  reviewer_scope: RunnablePhaseHandler;
  coder_response: RunnablePhaseHandler;
  reviewer_consult: RunnablePhaseHandler;
  coder_consult_response: RunnablePhaseHandler;
  interactive_blocked_recovery: RunnablePhaseHandler;
  final_squash: RunnablePhaseHandler;
  final_completion_review: RunnablePhaseHandler;
};

const RUNNABLE_PHASE_HANDLER_KEYS: Record<RunnablePhase, RunnableHandlerKey> = {
  coder_plan: 'coder_plan',
  diagnostic_recovery_analyze: 'diagnostic_recovery_analyze',
  diagnostic_recovery_author_plan: 'diagnostic_recovery_author_plan',
  diagnostic_recovery_review: 'reviewer_plan',
  reviewer_plan: 'reviewer_plan',
  coder_plan_response: 'coder_plan_response',
  coder_plan_optional_response: 'coder_plan_response',
  awaiting_derived_plan_execution: 'awaiting_derived_plan_execution',
  coder_scope: 'coder_scope',
  reviewer_scope: 'reviewer_scope',
  coder_response: 'coder_response',
  coder_optional_response: 'coder_response',
  reviewer_consult: 'reviewer_consult',
  coder_consult_response: 'coder_consult_response',
  interactive_blocked_recovery: 'interactive_blocked_recovery',
  final_squash: 'final_squash',
  final_completion_review: 'final_completion_review',
};

export function isRunnablePhase(phase: OrchestrationState['phase']): phase is RunnablePhase {
  return RUNNABLE_PHASES.has(phase as RunnablePhase);
}

export async function runOnePass(args: {
  state: OrchestrationState;
  statePath: string;
  logger?: RunLogger;
  options?: RunOnePassOptions;
  runtime: RunLoopRuntime;
  handlers: RunLoopHandlers;
}) {
  const { state, logger, options, runtime, handlers } = args;
  let currentState = state;

  while (
    isRunnablePhase(currentState.phase) &&
    (currentState.phase !== 'interactive_blocked_recovery' || runtime.hasPendingInteractiveBlockedRecoveryTurn(currentState))
  ) {
    const phaseStartedAt = Date.now();
    await options?.onDisplayState?.(currentState, phaseStartedAt);
    const stopHeartbeat = runtime.startPhaseHeartbeat(currentState.phase, () => currentState, logger);
    try {
      const currentPhase = currentState.phase;
      currentState = await handlers[RUNNABLE_PHASE_HANDLER_KEYS[currentPhase]](currentState);
      await options?.onDisplayState?.(currentState, Date.now());

      const pausedAfterScopeBoundary =
        currentState.phase === 'coder_scope' &&
        currentState.status === 'running' &&
        (
          currentPhase === 'final_squash' ||
          currentPhase === 'final_completion_review' ||
          currentPhase === 'awaiting_derived_plan_execution'
        ) &&
        options?.shouldStopAfterCurrentScope?.();
      if (pausedAfterScopeBoundary) {
        await logger?.event('run.paused_after_scope', {
          currentScopeNumber: currentState.currentScopeNumber,
          phase: currentState.phase,
          status: currentState.status,
        });
        return currentState;
      }
    } finally {
      stopHeartbeat();
    }
  }

  await logger?.event('run.complete', {
    phase: currentState.phase,
    status: currentState.status,
    finalCommit: currentState.finalCommit,
    archivedReviewPath: currentState.archivedReviewPath,
  });
  if (currentState.phase === 'blocked' || currentState.phase === 'done') {
    await runtime.writeCheckpointRetrospective(currentState, currentState.phase === 'blocked' ? 'blocked' : 'done');
  }
  return currentState;
}
