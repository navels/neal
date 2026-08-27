import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getExecuteRunResultExitCode,
  getPlanAndExecuteQueueExitCode,
} from '../src/neal/commands/writer-exit-codes.js';
import type { ExecuteRunResult } from '../src/neal/commands/runtime.js';
import type { OrchestrationState, ReviewRound } from '../src/neal/types.js';

function makeState(overrides: Partial<OrchestrationState>): OrchestrationState {
  return {
    topLevelMode: 'execute',
    derivedPlanPath: null,
    status: 'done',
    phase: 'done',
    pendingPlanReviewGuidance: null,
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
    manualGate: null,
    rounds: [],
    findings: [],
    maxRounds: 5,
    ...overrides,
  } as OrchestrationState;
}

function makeExecuteRunResult(overrides: Partial<OrchestrationState>): ExecuteRunResult {
  return {
    finalState: makeState(overrides),
    waitingForOperatorGuidance: false,
    waitingForManualGate: false,
    stopRequestedAfterScope: false,
  };
}

function makeRound(round: number): ReviewRound {
  return { round } as ReviewRound;
}

test('child run exit codes map terminal success and failure', () => {
  assert.equal(getExecuteRunResultExitCode(makeExecuteRunResult({ status: 'done', phase: 'done' })), 0);
  assert.equal(getExecuteRunResultExitCode(makeExecuteRunResult({ status: 'failed', phase: 'coder_scope' })), 3);
});

test('child run exit codes map controlled incomplete lifecycle states to 2', () => {
  assert.equal(getExecuteRunResultExitCode(makeExecuteRunResult({ status: 'blocked', phase: 'blocked' })), 2);
  assert.equal(getExecuteRunResultExitCode(makeExecuteRunResult({ status: 'paused', phase: 'coder_scope' })), 2);
  assert.equal(getExecuteRunResultExitCode(makeExecuteRunResult({ status: 'running', phase: 'coder_scope' })), 2);
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        status: 'blocked',
        phase: 'interactive_blocked_recovery',
        interactiveBlockedRecovery: {
          enteredAt: '2026-06-04T00:00:00.000Z',
          sourcePhase: 'coder_scope',
          blockedReason: 'Need operator guidance.',
          maxTurns: 3,
          lastHandledTurn: 0,
          turns: [],
        },
      }),
    ),
    2,
  );
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        status: 'blocked',
        phase: 'interactive_blocked_recovery',
        interactiveBlockedRecovery: {
          enteredAt: '2026-06-04T00:00:00.000Z',
          sourcePhase: 'coder_scope',
          blockedReason: 'Need operator guidance.',
          maxTurns: 3,
          lastHandledTurn: 0,
          turns: [
            {
              number: 1,
              recordedAt: '2026-06-04T00:01:00.000Z',
              operatorGuidance: 'Continue with the bounded fix.',
              origin: 'operator',
              disposition: null,
            },
          ],
        },
      }),
    ),
    2,
  );
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        status: 'running',
        phase: 'manual_gate',
        manualGate: {
          id: 'approval',
          title: 'External approval',
          reason: 'Deployment approval is required.',
          instructionsPath: '/tmp/GATE-approval.md',
          resumeChecks: [],
          resumePhase: 'coder_scope',
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
          lastCheckedAt: null,
          lastFailure: null,
        },
      }),
    ),
    2,
  );
});

test('child run exit codes map plan-review guidance waits to 2', () => {
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'blocked',
        phase: 'blocked',
        blockedFromPhase: 'reviewer_plan',
        pendingPlanReviewGuidance: null,
      }),
    ),
    2,
  );
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'running',
        phase: 'coder_plan_response',
        blockedFromPhase: 'reviewer_plan',
        pendingPlanReviewGuidance: {
          message: 'Tighten the scope before continuing.',
          sourcePhase: 'reviewer_plan',
          recordedAt: '2026-06-04T00:00:00.000Z',
        },
      }),
    ),
    2,
  );
});

test('plan-refinement convergence uses the refinement-specific policy', () => {
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'done',
        phase: 'done',
        derivedPlanPath: null,
      }),
    ),
    0,
  );
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'blocked',
        phase: 'blocked',
        derivedPlanPath: null,
        rounds: [makeRound(1), makeRound(2)],
        maxRounds: 5,
      }),
    ),
    2,
  );
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'blocked',
        phase: 'blocked',
        derivedPlanPath: null,
        rounds: [makeRound(1), makeRound(2), makeRound(3)],
        maxRounds: 3,
      }),
    ),
    2,
  );
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'blocked',
        phase: 'blocked',
        derivedPlanPath: null,
        rounds: [],
      }),
    ),
    2,
  );
});

test('plan-refinement states with null convergence fall back to generic child mapping', () => {
  assert.equal(
    getExecuteRunResultExitCode(
      makeExecuteRunResult({
        topLevelMode: 'plan',
        status: 'running',
        phase: 'coder_plan',
        derivedPlanPath: null,
        rounds: [],
      }),
    ),
    2,
  );
});

test('queue exit codes map completed, failed, and controlled incomplete queue states', () => {
  assert.equal(getPlanAndExecuteQueueExitCode({ status: 'completed' }), 0);
  assert.equal(getPlanAndExecuteQueueExitCode({ status: 'failed' }), 3);
  assert.equal(getPlanAndExecuteQueueExitCode({ status: 'blocked' }), 2);
  assert.equal(getPlanAndExecuteQueueExitCode({ status: 'paused' }), 2);
  assert.equal(getPlanAndExecuteQueueExitCode({ status: 'running' }), 2);
});
