import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyResumeActions, planResumeActions } from '../src/neal/resume-planner.js';
import { createInitialState, getDefaultAgentConfig, loadState } from '../src/neal/state.js';
import type { OrchestrationState, OrchestratorInit, ReviewFinding } from '../src/neal/types.js';
import { createResumeFixture } from './helpers/orchestrator-harness.js';

async function createPlannerState(overrides: Partial<OrchestrationState> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-resume-planner-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'planner-run');
  const init: OrchestratorInit = {
    cwd,
    planDoc: join(cwd, 'PLAN.md'),
    stateDir,
    runDir,
    topLevelMode: 'execute',
    allowedDirtyPaths: [],
    agentConfig: getDefaultAgentConfig(cwd),
    progressJsonPath: join(runDir, 'plan-progress.json'),
    progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
    reviewMarkdownPath: join(runDir, 'REVIEW.md'),
    recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
    maxRounds: 3,
  };

  return {
    ...(await createInitialState(init, '1111111111111111111111111111111111111111')),
    ...overrides,
  };
}

function actionKinds(state: OrchestrationState) {
  return planResumeActions(state).map((action) => action.kind);
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'R1-F1',
    canonicalId: 'C1',
    round: 1,
    source: 'reviewer',
    severity: 'blocking',
    files: ['PLAN.md'],
    claim: 'The plan needs a narrower execution shape.',
    requiredAction: 'Revise the plan.',
    status: 'open',
    roundSummary: 'Missing execution detail.',
    coderDisposition: null,
    coderCommit: null,
    ...overrides,
  };
}

test('resume planner normalizes paused runs', async () => {
  const state = await createPlannerState({
    phase: 'coder_scope',
    status: 'paused',
  });

  assert.deepEqual(actionKinds(state), [
    'normalize_stopped_status',
    'recover_pending_review_from_clean_committed_scope',
  ]);
});

test('resume planner restores blocked resumable phases', async () => {
  const state = await createPlannerState({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_scope',
    coderSessionHandle: 'coder-session-1',
  });

  assert.deepEqual(actionKinds(state), [
    'restore_resumable_blocked_phase',
    'recover_pending_review_from_clean_committed_scope',
  ]);
});

test('resume planner keeps non-resumable blocked runs blocked', async () => {
  const state = await createPlannerState({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-1',
  });

  assert.deepEqual(actionKinds(state), ['keep_blocked']);
});

test('resume planner distinguishes pending and waiting operator guidance', async () => {
  const waitingState = await createPlannerState({
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-05-16T12:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 1,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-05-16T12:01:00.000Z',
          operatorGuidance: 'Stay inside the current scope.',
          origin: 'operator',
          disposition: null,
        },
      ],
    },
  });
  const pendingState: OrchestrationState = {
    ...waitingState,
    interactiveBlockedRecovery: {
      ...waitingState.interactiveBlockedRecovery!,
      lastHandledTurn: 0,
    },
  };

  assert.deepEqual(actionKinds(waitingState), [
    'wait_for_operator_guidance',
    'log_interactive_blocked_recovery',
  ]);
  assert.deepEqual(actionKinds(pendingState), [
    'process_pending_operator_guidance',
    'log_interactive_blocked_recovery',
  ]);
});

test('resume planner promotes accepted unexecuted derived plans', async () => {
  const state = await createPlannerState({
    phase: 'done',
    status: 'done',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_4.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
    createdCommits: [],
    derivedPlanAcceptedNotified: false,
  });

  assert.deepEqual(actionKinds(state), [
    'promote_accepted_derived_plan',
    'flush_derived_plan_notifications',
  ]);
});

test('resume planner promotes pending unexecuted derived-plan reviews', async () => {
  const state = await createPlannerState({
    phase: 'done',
    status: 'done',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_4.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
    createdCommits: [],
    findings: [makeFinding()],
  });

  const actions = planResumeActions(state);

  assert.deepEqual(
    actions.map((action) => action.kind),
    ['promote_pending_derived_plan_review', 'flush_derived_plan_notifications'],
  );
  assert.equal(actions[0]?.kind === 'promote_pending_derived_plan_review' ? actions[0].phase : null, 'coder_plan_response');
});

test('resume planner treats a running pending-review derived plan as a plain continue', async () => {
  // Reproduction state: an execute run persisted in coder_plan_response with no planner
  // session, an open blocking finding, and the derived plan still pending review. Resume
  // must not keep it blocked or re-promote the derived plan; it is a plain continue.
  const state = await createPlannerState({
    phase: 'coder_plan_response',
    status: 'running',
    blockedFromPhase: null,
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: '3915c8c0-de35-49b1-b04e-9958cbe14c02',
    coderSessionProtocol: 'structured_json_v1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
    derivedScopeIndex: null,
    splitPlanStartedNotified: true,
    findings: [makeFinding()],
  });

  // An empty action set proves there is no keep_blocked and no false derived-plan promotion.
  assert.deepEqual(actionKinds(state), []);
});

test('resume planner blocks rejected abandoned derived plans', async () => {
  const state = await createPlannerState({
    phase: 'done',
    status: 'done',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
    derivedPlanStatus: 'rejected',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: null,
    createdCommits: [],
  });

  assert.deepEqual(actionKinds(state), [
    'block_rejected_abandoned_derived_plan',
    'flush_derived_plan_notifications',
  ]);
});

test('resume planner checks for clean committed scope recovery before review', async () => {
  const state = await createPlannerState({
    phase: 'coder_scope',
    status: 'failed',
    createdCommits: [],
    currentScopeProgressJustification: null,
  });

  assert.deepEqual(actionKinds(state), [
    'normalize_stopped_status',
    'recover_pending_review_from_clean_committed_scope',
  ]);
});

test('resume planner leaves ordinary completed runs as no-op', async () => {
  const state = await createPlannerState({
    phase: 'done',
    status: 'done',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
  });

  assert.deepEqual(actionKinds(state), ['done_noop']);
});

test('restoring a coder-authored plan-response block clears the durable blocker reason on the first running save', async () => {
  // The resume planner is the first blocked->running writer for a coder-authored
  // plan-stage response block. Its restore transition must clear the durable
  // blockerReason so the reason never outlives its block (and the running state
  // satisfies the blockerReason invariant on save).
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan_response',
    plannerSessionHandle: 'planner-session-1',
    plannerSessionProtocol: 'structured_json_v1',
    blockerReason: 'The coder needs an operator decision on the plan.',
    pendingPlanReviewGuidance: null,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
  });

  const actions = planResumeActions(state);
  assert.deepEqual(actions.map((action) => action.kind), ['restore_resumable_blocked_phase']);

  const resumed = await applyResumeActions(state, statePath, undefined, actions);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.phase, 'coder_plan_response');
  assert.equal(resumed.blockerReason, null);

  const reloaded = await loadState(statePath);
  assert.equal(reloaded.status, 'running');
  assert.equal(reloaded.blockerReason, null);
});
