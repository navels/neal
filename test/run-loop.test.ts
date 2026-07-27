import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInitialState } from '../src/neal/state.js';
import {
  RUNNABLE_PHASES_BY_TOP_LEVEL_MODE,
  RUNNABLE_PHASE_PURPOSE_REGISTRIES,
  RUNNABLE_PHASE_REGISTRY,
  getRunnablePhasesForTopLevelMode,
  isRunnablePhase,
  isRunnablePhaseForTopLevelMode,
  runOnePass,
  type RunnableHandlerKey,
  type RunnablePhase,
  type RunLoopHandlers,
  type RunLoopRuntime,
} from '../src/neal/orchestrator/run-loop.js';
import type { OrchestrationState } from '../src/neal/types.js';

const HANDLER_KEYS = Array.from(new Set(Object.values(RUNNABLE_PHASE_REGISTRY))) as RunnableHandlerKey[];

async function createState(overrides: Partial<OrchestrationState> = {}): Promise<OrchestrationState> {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-run-loop-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'run-loop-test');
  const state = await createInitialState(
    {
      cwd,
      planDoc: join(cwd, 'PLAN.md'),
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: {
        planner: { provider: 'openai-codex', model: 'gpt-test-coder' },
        coder: { provider: 'openai-codex', model: 'gpt-test-coder' },
        reviewer: { provider: 'anthropic-claude', model: 'claude-test-reviewer' },
      },
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 5,
    },
    '1111111111111111111111111111111111111111',
  );

  return {
    ...state,
    ...overrides,
  };
}

function createHandlers(calls: RunnableHandlerKey[]): RunLoopHandlers {
  return Object.fromEntries(
    HANDLER_KEYS.map((handlerKey) => [
      handlerKey,
      async (state: OrchestrationState): Promise<OrchestrationState> => {
        calls.push(handlerKey);
        return {
          ...state,
          phase: 'done',
          status: 'done',
        };
      },
    ]),
  ) as RunLoopHandlers;
}

function createRuntime(options?: {
  hasPendingInteractiveBlockedRecoveryTurn?: (state: OrchestrationState) => boolean;
}) {
  let pendingInteractiveBlockedRecoveryTurnChecks = 0;
  const heartbeatStarts: OrchestrationState['phase'][] = [];
  const heartbeatStops: OrchestrationState['phase'][] = [];
  const checkpointReasons: ('blocked' | 'done' | 'failed')[] = [];
  const runtime: RunLoopRuntime = {
    hasPendingInteractiveBlockedRecoveryTurn: (state) => {
      pendingInteractiveBlockedRecoveryTurnChecks += 1;
      return options?.hasPendingInteractiveBlockedRecoveryTurn?.(state) ?? true;
    },
    startPhaseHeartbeat: (phase) => {
      heartbeatStarts.push(phase);
      return () => {
        heartbeatStops.push(phase);
      };
    },
    writeCheckpointRetrospective: async (_state, reason) => {
      checkpointReasons.push(reason);
    },
  };

  return {
    runtime,
    heartbeatStarts,
    heartbeatStops,
    checkpointReasons,
    get pendingInteractiveBlockedRecoveryTurnChecks() {
      return pendingInteractiveBlockedRecoveryTurnChecks;
    },
  };
}

test('registry keys are runnable phases', () => {
  for (const phase of Object.keys(RUNNABLE_PHASE_REGISTRY) as RunnablePhase[]) {
    assert.equal(isRunnablePhase(phase), true, `${phase} should be runnable`);
    assert.equal(
      ['plan', 'execute'].some((topLevelMode) =>
        isRunnablePhaseForTopLevelMode(phase, topLevelMode as OrchestrationState['topLevelMode'])),
      true,
      `${phase} should belong to at least one top-level mode`,
    );
  }
});

test('purpose registries compose the compatibility dispatch registry', () => {
  const composed = Object.assign({}, ...Object.values(RUNNABLE_PHASE_PURPOSE_REGISTRIES));

  assert.deepEqual(composed, RUNNABLE_PHASE_REGISTRY);
  assert.deepEqual(RUNNABLE_PHASE_PURPOSE_REGISTRIES.plan, {
    coder_plan: 'coder_plan',
    reviewer_plan: 'reviewer_plan',
    coder_plan_response: 'coder_plan_response',
    coder_plan_optional_response: 'coder_plan_response',
  });
  assert.deepEqual(RUNNABLE_PHASE_PURPOSE_REGISTRIES.execute, {
    awaiting_derived_plan_execution: 'awaiting_derived_plan_execution',
    coder_scope: 'coder_scope',
    reviewer_scope: 'reviewer_scope',
    coder_response: 'coder_response',
    coder_optional_response: 'coder_response',
  });
  assert.deepEqual(RUNNABLE_PHASE_PURPOSE_REGISTRIES.recovery, {
    interactive_blocked_recovery: 'interactive_blocked_recovery',
  });
  assert.deepEqual(RUNNABLE_PHASE_PURPOSE_REGISTRIES.executeFinalization, {
    execute_finalization: 'execute_finalization',
    final_completion_review: 'final_completion_review',
  });
});

test('mode helpers expose top-level runnable phase ownership', () => {
  assert.deepEqual(getRunnablePhasesForTopLevelMode('plan'), RUNNABLE_PHASES_BY_TOP_LEVEL_MODE.plan);
  assert.deepEqual(getRunnablePhasesForTopLevelMode('execute'), RUNNABLE_PHASES_BY_TOP_LEVEL_MODE.execute);

  for (const phase of RUNNABLE_PHASES_BY_TOP_LEVEL_MODE.plan) {
    assert.equal(isRunnablePhaseForTopLevelMode(phase, 'plan'), true, `${phase} should be runnable in plan mode`);
  }
  for (const phase of RUNNABLE_PHASES_BY_TOP_LEVEL_MODE.execute) {
    assert.equal(isRunnablePhaseForTopLevelMode(phase, 'execute'), true, `${phase} should be runnable in execute mode`);
  }
});

test('mode helpers exclude phases owned by other top-level modes', () => {
  assert.equal(isRunnablePhaseForTopLevelMode('coder_scope', 'plan'), false);
  assert.equal(isRunnablePhaseForTopLevelMode('interactive_blocked_recovery', 'plan'), false);
  assert.equal(isRunnablePhaseForTopLevelMode('execute_finalization', 'plan'), false);

  assert.equal(isRunnablePhaseForTopLevelMode('coder_plan', 'execute'), false);
});

test('terminal and inactive phases are not runnable', () => {
  const nonRunnablePhases = [
    'done',
    'blocked',
  ] as const satisfies readonly OrchestrationState['phase'][];

  for (const phase of nonRunnablePhases) {
    assert.equal(isRunnablePhase(phase), false, `${phase} should not be runnable`);
    assert.equal(isRunnablePhaseForTopLevelMode(phase, 'plan'), false, `${phase} should not be runnable in plan mode`);
    assert.equal(isRunnablePhaseForTopLevelMode(phase, 'execute'), false, `${phase} should not be runnable in execute mode`);
  }
});

test('alias phases dispatch to their canonical handlers exactly once', async (t) => {
  const aliasCases = [
    { phase: 'coder_plan_optional_response', handlerKey: 'coder_plan_response' },
    { phase: 'coder_optional_response', handlerKey: 'coder_response' },
  ] as const satisfies readonly { phase: RunnablePhase; handlerKey: RunnableHandlerKey }[];

  for (const { phase, handlerKey } of aliasCases) {
    await t.test(`${phase} dispatches to ${handlerKey}`, async () => {
      const calls: RunnableHandlerKey[] = [];
      const runtime = createRuntime();
      const state = await createState({ phase });

      const nextState = await runOnePass({
        state,
        statePath: join(state.runDir, 'RUN_STATE.json'),
        runtime: runtime.runtime,
        handlers: createHandlers(calls),
      });

      assert.deepEqual(calls, [handlerKey]);
      assert.deepEqual(runtime.heartbeatStarts, [phase]);
      assert.deepEqual(runtime.heartbeatStops, [phase]);
      assert.deepEqual(runtime.checkpointReasons, ['done']);
      assert.equal(nextState.phase, 'done');
      assert.equal(nextState.status, 'done');
    });
  }
});

test('interactive blocked recovery waits for a pending operator turn before dispatching', async () => {
  const calls: RunnableHandlerKey[] = [];
  const runtime = createRuntime({
    hasPendingInteractiveBlockedRecoveryTurn: () => false,
  });
  const state = await createState({ phase: 'interactive_blocked_recovery' });

  const nextState = await runOnePass({
    state,
    statePath: join(state.runDir, 'RUN_STATE.json'),
    runtime: runtime.runtime,
    handlers: createHandlers(calls),
  });

  assert.deepEqual(calls, []);
  assert.equal(runtime.pendingInteractiveBlockedRecoveryTurnChecks, 1);
  assert.deepEqual(runtime.heartbeatStarts, []);
  assert.deepEqual(runtime.heartbeatStops, []);
  assert.deepEqual(runtime.checkpointReasons, []);
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
});
