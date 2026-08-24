import { EXECUTE_FINALIZATION_PHASE, isExecuteFinalizationPhase } from '../execute-finalization.js';
import type { RunLogger } from '../logger.js';
import type { OrchestrationState } from '../types.js';

type RunnablePhaseRegistry = Partial<Record<OrchestrationState['phase'], OrchestrationState['phase']>>;

export const PLAN_RUNNABLE_PHASE_REGISTRY = {
  coder_plan: 'coder_plan',
  reviewer_plan: 'reviewer_plan',
  coder_plan_response: 'coder_plan_response',
  coder_plan_optional_response: 'coder_plan_response',
} as const satisfies RunnablePhaseRegistry;

export const EXECUTE_RUNNABLE_PHASE_REGISTRY = {
  awaiting_derived_plan_execution: 'awaiting_derived_plan_execution',
  coder_scope: 'coder_scope',
  reviewer_scope: 'reviewer_scope',
  coder_response: 'coder_response',
  coder_optional_response: 'coder_response',
} as const satisfies RunnablePhaseRegistry;

export const RECOVERY_RUNNABLE_PHASE_REGISTRY = {
  interactive_blocked_recovery: 'interactive_blocked_recovery',
} as const satisfies RunnablePhaseRegistry;

export const EXECUTE_FINALIZATION_RUNNABLE_PHASE_REGISTRY = {
  [EXECUTE_FINALIZATION_PHASE]: EXECUTE_FINALIZATION_PHASE,
  final_completion_review: 'final_completion_review',
} as const satisfies RunnablePhaseRegistry;

export const RUNNABLE_PHASE_PURPOSE_REGISTRIES = {
  plan: PLAN_RUNNABLE_PHASE_REGISTRY,
  execute: EXECUTE_RUNNABLE_PHASE_REGISTRY,
  recovery: RECOVERY_RUNNABLE_PHASE_REGISTRY,
  executeFinalization: EXECUTE_FINALIZATION_RUNNABLE_PHASE_REGISTRY,
} as const;

export const RUNNABLE_PHASE_REGISTRY = {
  ...PLAN_RUNNABLE_PHASE_REGISTRY,
  ...EXECUTE_RUNNABLE_PHASE_REGISTRY,
  ...RECOVERY_RUNNABLE_PHASE_REGISTRY,
  ...EXECUTE_FINALIZATION_RUNNABLE_PHASE_REGISTRY,
} as const satisfies Partial<Record<OrchestrationState['phase'], OrchestrationState['phase']>>;

export type RunnablePhase = keyof typeof RUNNABLE_PHASE_REGISTRY;
export type RunnableHandlerKey = (typeof RUNNABLE_PHASE_REGISTRY)[RunnablePhase];
type AssertNever<T extends never> = T;
type _RunnableHandlerKeyIsRunnablePhase = AssertNever<Exclude<RunnableHandlerKey, RunnablePhase>>;

export const RUNNABLE_PHASES_BY_TOP_LEVEL_MODE = {
  plan: [
    'coder_plan',
    'reviewer_plan',
    'coder_plan_response',
    'coder_plan_optional_response',
  ],
  execute: [
    'reviewer_plan',
    'coder_plan_response',
    'coder_plan_optional_response',
    'awaiting_derived_plan_execution',
    'coder_scope',
    'reviewer_scope',
    'coder_response',
    'coder_optional_response',
    'interactive_blocked_recovery',
    EXECUTE_FINALIZATION_PHASE,
    'final_completion_review',
  ],
} as const satisfies Record<OrchestrationState['topLevelMode'], readonly RunnablePhase[]>;

const RUNNABLE_PHASE_SETS_BY_TOP_LEVEL_MODE: Record<
  OrchestrationState['topLevelMode'],
  ReadonlySet<RunnablePhase>
> = {
  plan: new Set(RUNNABLE_PHASES_BY_TOP_LEVEL_MODE.plan),
  execute: new Set(RUNNABLE_PHASES_BY_TOP_LEVEL_MODE.execute),
};

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
  writeCheckpointRetrospective: (
    state: OrchestrationState,
    reason: 'blocked' | 'done' | 'failed',
  ) => Promise<void>;
};

export type RunLoopHandlers = Record<RunnableHandlerKey, RunnablePhaseHandler>;

export function isRunnablePhase(phase: OrchestrationState['phase']): phase is RunnablePhase {
  return Object.prototype.hasOwnProperty.call(RUNNABLE_PHASE_REGISTRY, phase);
}

export function getRunnablePhasesForTopLevelMode(
  topLevelMode: OrchestrationState['topLevelMode'],
): readonly RunnablePhase[] {
  return RUNNABLE_PHASES_BY_TOP_LEVEL_MODE[topLevelMode];
}

export function isRunnablePhaseForTopLevelMode(
  phase: OrchestrationState['phase'],
  topLevelMode: OrchestrationState['topLevelMode'],
): phase is RunnablePhase {
  return isRunnablePhase(phase) && RUNNABLE_PHASE_SETS_BY_TOP_LEVEL_MODE[topLevelMode].has(phase);
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
      currentState = await handlers[RUNNABLE_PHASE_REGISTRY[currentPhase]](currentState);
      await options?.onDisplayState?.(currentState, Date.now());

      const pausedAfterScopeBoundary =
        currentState.phase === 'coder_scope' &&
        currentState.status === 'running' &&
        (
          isExecuteFinalizationPhase(currentPhase) ||
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
