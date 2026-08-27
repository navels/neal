import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import { formatPublicRunStatus, getRunDisplayStatus } from '../src/neal/run-status.js';
import {
  classifyUnexecutedDerivedPlanResumeState,
  getDerivedPlanCountersView,
  getDerivedPlanIdentityView,
  getDerivedPlanView,
  getExecuteRunView,
  getFinalCompletionView,
  getInteractiveRecoveryView,
  getPlanRunView,
  getPlanReviewGuidanceView,
  getPublicLifecycleView,
  getSharedRunMetadataView,
  hasPendingOperatorGuidance,
  needsDerivedPlanNotificationFlush,
  resolveFinalCompletionReviewAction,
} from '../src/neal/state-views.js';
import type {
  OrchestrationState,
  OrchestratorInit,
  TopLevelMode,
} from '../src/neal/types.js';

async function createViewState(topLevelMode: TopLevelMode): Promise<OrchestrationState> {
  const cwd = await mkdtemp(join(tmpdir(), `neal-state-views-${topLevelMode}-`));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', `${topLevelMode}-run`);
  const init: OrchestratorInit = {
    cwd,
    planDoc: join(cwd, 'PLAN.md'),
    planDocBackupPath: join(runDir, 'PLAN.backup.md'),
    stateDir,
    runDir,
    topLevelMode,
    allowedDirtyPaths: [],
    agentConfig: getDefaultAgentConfig(cwd),
    progressJsonPath: join(runDir, 'plan-progress.json'),
    progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
    reviewMarkdownPath: join(runDir, 'REVIEW.md'),
    recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
    maxRounds: 3,
  };

  return createInitialState(init, '1111111111111111111111111111111111111111');
}

test('public lifecycle view follows status for normal running plan and execute runs', async () => {
  const planState = await createViewState('plan');
  const executeState = await createViewState('execute');

  assert.equal(getPublicLifecycleView(planState).lifecycle, 'running');
  assert.equal(getPublicLifecycleView(executeState).lifecycle, 'running');

  const planView = getPlanRunView(planState);
  const executeView = getExecuteRunView(executeState);

  assert.equal(planView?.mode, 'plan');
  assert.equal(planView?.phase, 'coder_plan');
  assert.equal(executeView?.mode, 'execute');
  assert.equal(executeView?.phase, 'coder_scope');
  assert.equal(executeView?.finalCompletion.state, 'not_started');
});

test('public lifecycle view maps paused, done, blocked, and failed from status', async () => {
  const state = await createViewState('execute');
  const cases: {
    status: OrchestrationState['status'];
    phase: OrchestrationState['phase'];
    lifecycle: ReturnType<typeof getPublicLifecycleView>['lifecycle'];
  }[] = [
    { status: 'paused', phase: 'coder_scope', lifecycle: 'paused' },
    { status: 'done', phase: 'done', lifecycle: 'done' },
    { status: 'blocked', phase: 'blocked', lifecycle: 'blocked' },
    { status: 'failed', phase: 'blocked', lifecycle: 'failed' },
  ];

  for (const item of cases) {
    const lifecycle = getPublicLifecycleView({
      ...state,
      status: item.status,
      phase: item.phase,
    });

    assert.equal(lifecycle.lifecycle, item.lifecycle);
    assert.equal(lifecycle.sourceStatus, item.status);
  }
});

test('interactive recovery view distinguishes waiting guidance from pending guidance', async () => {
  const baseState = await createViewState('execute');
  const waitingState: OrchestrationState = {
    ...baseState,
    phase: 'interactive_blocked_recovery',
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
          operatorGuidance: 'Try the narrow fix.',
          origin: 'operator',
          disposition: null,
        },
      ],
    },
  };
  const pendingState: OrchestrationState = {
    ...waitingState,
    interactiveBlockedRecovery: {
      ...waitingState.interactiveBlockedRecovery!,
      lastHandledTurn: 0,
    },
  };

  assert.deepEqual(
    {
      lifecycle: getPublicLifecycleView(waitingState).lifecycle,
      waiting: getInteractiveRecoveryView(waitingState)?.waitingForOperatorGuidance,
      pending: getInteractiveRecoveryView(waitingState)?.pendingOperatorGuidance,
      hasPending: hasPendingOperatorGuidance(waitingState),
    },
    {
      lifecycle: 'waiting_for_guidance',
      waiting: true,
      pending: false,
      hasPending: false,
    },
  );
  assert.deepEqual(
    {
      lifecycle: getPublicLifecycleView(pendingState).lifecycle,
      waiting: getInteractiveRecoveryView(pendingState)?.waitingForOperatorGuidance,
      pending: getInteractiveRecoveryView(pendingState)?.pendingOperatorGuidance,
      hasPending: hasPendingOperatorGuidance(pendingState),
    },
    {
      lifecycle: 'running',
      waiting: false,
      pending: true,
      hasPending: true,
    },
  );
});

test('plan-review guidance view distinguishes waiting guidance from pending guidance', async () => {
  const baseState = await createViewState('plan');
  const waitingState: OrchestrationState = {
    ...baseState,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
  };
  const pendingState: OrchestrationState = {
    ...baseState,
    phase: 'coder_plan_response',
    pendingPlanReviewGuidance: {
      message: 'Use the reviewer feedback to revise the plan.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    },
  };

  assert.deepEqual(
    {
      lifecycle: getPublicLifecycleView(waitingState).lifecycle,
      displayStatus: getRunDisplayStatus(waitingState).effectiveStatus,
      publicStatus: formatPublicRunStatus(getRunDisplayStatus(waitingState)),
      waiting: getPlanReviewGuidanceView(waitingState).waitingForOperatorGuidance,
      pending: getPlanReviewGuidanceView(waitingState).pendingOperatorGuidance,
      hasPending: hasPendingOperatorGuidance(waitingState),
    },
    {
      lifecycle: 'waiting_for_guidance',
      displayStatus: 'waiting_for_operator',
      publicStatus: 'waiting_for_guidance',
      waiting: true,
      pending: false,
      hasPending: false,
    },
  );
  assert.deepEqual(
    {
      lifecycle: getPublicLifecycleView(pendingState).lifecycle,
      displayStatus: getRunDisplayStatus(pendingState).effectiveStatus,
      publicStatus: formatPublicRunStatus(getRunDisplayStatus(pendingState)),
      waiting: getPlanReviewGuidanceView(pendingState).waitingForOperatorGuidance,
      pending: getPlanReviewGuidanceView(pendingState).pendingOperatorGuidance,
      hasPending: hasPendingOperatorGuidance(pendingState),
    },
    {
      lifecycle: 'running',
      displayStatus: 'running',
      publicStatus: 'running',
      waiting: false,
      pending: true,
      hasPending: true,
    },
  );
});

test('plan-review guidance view treats coder-authored response blocks as waiting for guidance', async () => {
  const baseState = await createViewState('plan');

  for (const blockedFromPhase of ['coder_plan_response', 'coder_plan_optional_response'] as const) {
    const waitingState: OrchestrationState = {
      ...baseState,
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase,
      blockerReason: 'The coder needs an operator decision on the plan.',
      pendingPlanReviewGuidance: null,
    };

    assert.deepEqual(
      {
        lifecycle: getPublicLifecycleView(waitingState).lifecycle,
        publicStatus: formatPublicRunStatus(getRunDisplayStatus(waitingState)),
        waiting: getPlanReviewGuidanceView(waitingState).waitingForOperatorGuidance,
        lifecycleWaiting: getPublicLifecycleView(waitingState).waitingForOperatorGuidance,
      },
      {
        lifecycle: 'waiting_for_guidance',
        publicStatus: 'waiting_for_guidance',
        waiting: true,
        lifecycleWaiting: true,
      },
    );

    // Once the operator answers, the run leaves the waiting state with pending guidance.
    const pendingState: OrchestrationState = {
      ...baseState,
      phase: blockedFromPhase,
      status: 'running',
      blockedFromPhase: null,
      blockerReason: null,
      pendingPlanReviewGuidance: {
        message: 'Proceed with the narrower option.',
        sourcePhase: blockedFromPhase,
        recordedAt: '2026-05-29T12:00:00.000Z',
      },
    };
    assert.equal(getPlanReviewGuidanceView(pendingState).waitingForOperatorGuidance, false);
    assert.equal(getPlanReviewGuidanceView(pendingState).pendingOperatorGuidance, true);
    assert.equal(hasPendingOperatorGuidance(pendingState), true);
  }
});

test('plan-review guidance view keeps the initial coder_plan authoring block out of the waiting state', async () => {
  const baseState = await createViewState('plan');
  const coderPlanBlock: OrchestrationState = {
    ...baseState,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan',
    pendingPlanReviewGuidance: null,
  };

  assert.equal(getPlanReviewGuidanceView(coderPlanBlock).waitingForOperatorGuidance, false);
  assert.equal(getPublicLifecycleView(coderPlanBlock).lifecycle, 'blocked');
});

test('plan-review guidance view excludes dirty-worktree response blocks that carry no durable reason', async () => {
  // A dirty-worktree safety block lands at a coder-response phase with
  // blockerReason null. The blockerReason discriminator keeps it a normal blocked
  // state rather than a coder-authored guidance wait.
  const baseState = await createViewState('plan');
  for (const blockedFromPhase of ['coder_plan_response', 'coder_plan_optional_response'] as const) {
    const dirtyWorktreeBlock: OrchestrationState = {
      ...baseState,
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase,
      blockerReason: null,
      pendingPlanReviewGuidance: null,
    };

    assert.equal(getPlanReviewGuidanceView(dirtyWorktreeBlock).waitingForOperatorGuidance, false);
    assert.equal(getPublicLifecycleView(dirtyWorktreeBlock).lifecycle, 'blocked');
    assert.equal(formatPublicRunStatus(getRunDisplayStatus(dirtyWorktreeBlock)), 'blocked');
  }
});

test('public lifecycle view exposes active manual gates without operator-guidance status', async () => {
  const baseState = await createViewState('execute');
  const manualGateState: OrchestrationState = {
    ...baseState,
    phase: 'manual_gate',
    status: 'running',
    blockedFromPhase: null,
    manualGate: {
      id: 'operator-approval',
      title: 'Operator approval',
      reason: 'A user must approve the external deploy.',
      instructionsPath: join(baseState.runDir, 'GATE-operator-approval.md'),
      resumeChecks: [
        {
          type: 'command',
          name: 'approval file exists',
          command: ['test', '-f', 'approved.txt'],
          cwd: 'repo',
          timeoutMs: 1000,
        },
      ],
      resumePhase: 'coder_scope',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
      lastCheckedAt: null,
      lastFailure: null,
    },
  };

  assert.deepEqual(
    {
      lifecycle: getPublicLifecycleView(manualGateState).lifecycle,
      displayStatus: getRunDisplayStatus(manualGateState).effectiveStatus,
      publicStatus: formatPublicRunStatus(getRunDisplayStatus(manualGateState)),
      waitingForOperatorGuidance: getPublicLifecycleView(manualGateState).waitingForOperatorGuidance,
      pendingOperatorGuidance: getPublicLifecycleView(manualGateState).pendingOperatorGuidance,
    },
    {
      lifecycle: 'waiting_for_manual_gate',
      displayStatus: 'waiting_for_manual_gate',
      publicStatus: 'waiting_for_manual_gate',
      waitingForOperatorGuidance: false,
      pendingOperatorGuidance: false,
    },
  );
});

test('mode-specific view helpers return null for invalid mode access', async () => {
  const planState = await createViewState('plan');
  const executeState = await createViewState('execute');

  assert.equal(getExecuteRunView(planState), null);
  assert.equal(getPlanRunView(executeState), null);
  assert.equal(getDerivedPlanView(planState), null);
  assert.equal(getFinalCompletionView(planState), null);
});

test('derived-plan and final-completion views group execute-mode nullable clusters', async () => {
  const state = await createViewState('execute');
  const derivedPlanPath = join(state.runDir, 'DERIVED_PLAN_SCOPE_2.md');
  const executeState: OrchestrationState = {
    ...state,
    phase: 'awaiting_derived_plan_execution',
    derivedPlanPath,
    derivedFromScopeNumber: 2,
    derivedPlanStatus: 'accepted',
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the requested behavior.',
      verificationSummary: 'Ran focused tests.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'Complete.',
      rationale: 'The requested behavior is present.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Complete requested behavior',
        bullets: [
          'Deliver the requested behavior in the execute run.',
          'Verify the completed result with focused tests.',
        ],
      },
    },
    finalCompletionResolvedAction: 'accept_complete',
  };

  const derivedPlan = getDerivedPlanView(executeState);
  const finalCompletion = getFinalCompletionView(executeState);
  const executeView = getExecuteRunView(executeState);
  const metadata = getSharedRunMetadataView(executeState);

  assert.equal(derivedPlan?.state, 'accepted_awaiting_execution');
  assert.equal(derivedPlan?.path, derivedPlanPath);
  assert.equal(derivedPlan?.parentScopeNumber, 2);
  assert.equal(derivedPlan?.unexecuted, true);
  assert.equal(derivedPlan?.unexecutedResumeCandidate, true);
  assert.equal(derivedPlan?.notifications.splitPlanStartedNotified, true);
  assert.equal(derivedPlan?.notifications.derivedPlanAcceptedNotified, true);
  assert.equal(derivedPlan?.notifications.needsDerivedPlanAcceptedNotification, false);
  assert.equal(finalCompletion?.state, 'resolved');
  assert.equal(finalCompletion?.resolvedAction, 'accept_complete');
  assert.equal(executeView?.derivedPlan?.state, 'accepted_awaiting_execution');
  assert.equal(executeView?.finalCompletion.state, 'resolved');
  assert.equal(metadata.lifecycle.lifecycle, 'running');
});

test('final-completion view classifies summary, review, resolved, and capped states', async () => {
  const baseState = await createViewState('execute');
  const summary = {
    planGoalSatisfied: false,
    whatChangedOverall: 'Implemented most of the plan.',
    verificationSummary: 'Ran focused coverage.',
    remainingKnownGaps: ['One final repair remains.'],
  };
  const continueVerdict = {
    action: 'continue_execution' as const,
    summary: 'One follow-on scope remains.',
    rationale: 'The aggregate completion review found missing work.',
    missingWork: {
      summary: 'Finish the final repair.',
      requiredOutcome: 'The plan is complete after the repair.',
      verification: 'Run final completion coverage.',
    },
    squashCommitMessage: null,
  };
  const cases = [
    {
      name: 'not started',
      overrides: {},
      expected: {
        state: 'not_started',
        activeReview: false,
        hasSummary: false,
        effectiveAction: null,
        shouldWriteArtifact: false,
        acceptedComplete: false,
        continuesExecution: false,
        blockedForOperator: false,
      },
    },
    {
      name: 'summary recorded',
      overrides: {
        phase: 'final_completion_review' as const,
        finalCompletionSummary: summary,
      },
      expected: {
        state: 'summary_recorded',
        activeReview: true,
        hasSummary: true,
        effectiveAction: null,
        shouldWriteArtifact: true,
        acceptedComplete: false,
        continuesExecution: false,
        blockedForOperator: false,
      },
    },
    {
      name: 'reviewed without resolved action',
      overrides: {
        phase: 'final_completion_review' as const,
        finalCompletionSummary: summary,
        finalCompletionReviewVerdict: continueVerdict,
      },
      expected: {
        state: 'reviewed',
        activeReview: true,
        hasSummary: true,
        effectiveAction: 'continue_execution',
        shouldWriteArtifact: true,
        acceptedComplete: false,
        continuesExecution: true,
        blockedForOperator: false,
      },
    },
    {
      name: 'accepted complete',
      overrides: {
        phase: 'done' as const,
        status: 'done' as const,
        finalCompletionSummary: summary,
        finalCompletionReviewVerdict: {
          action: 'accept_complete' as const,
          summary: 'Complete.',
          rationale: 'The aggregate review accepted the run.',
          missingWork: null,
          squashCommitMessage: {
            subject: 'Complete requested behavior',
            bullets: [
              'Deliver the requested behavior in the execute run.',
              'Verify the completed result with focused tests.',
            ],
          },
        },
        finalCompletionResolvedAction: 'accept_complete' as const,
      },
      expected: {
        state: 'resolved',
        activeReview: false,
        hasSummary: true,
        effectiveAction: 'accept_complete',
        shouldWriteArtifact: true,
        acceptedComplete: true,
        continuesExecution: false,
        blockedForOperator: false,
      },
    },
    {
      name: 'capped continue execution',
      overrides: {
        phase: 'blocked' as const,
        status: 'blocked' as const,
        finalCompletionSummary: summary,
        finalCompletionReviewVerdict: continueVerdict,
        finalCompletionResolvedAction: 'block_for_operator' as const,
        finalCompletionContinueExecutionCount: 2,
        finalCompletionContinueExecutionCapReached: true,
      },
      expected: {
        state: 'resolved',
        activeReview: false,
        hasSummary: true,
        effectiveAction: 'block_for_operator',
        shouldWriteArtifact: true,
        acceptedComplete: false,
        continuesExecution: false,
        blockedForOperator: true,
      },
    },
  ];

  for (const item of cases) {
    const finalCompletion = getFinalCompletionView({
      ...baseState,
      ...item.overrides,
    });

    assert.deepEqual(
      {
        state: finalCompletion?.state,
        activeReview: finalCompletion?.activeReview,
        hasSummary: finalCompletion?.hasSummary,
        effectiveAction: finalCompletion?.effectiveAction,
        shouldWriteArtifact: finalCompletion?.shouldWriteArtifact,
        acceptedComplete: finalCompletion?.acceptedComplete,
        continuesExecution: finalCompletion?.continuesExecution,
        blockedForOperator: finalCompletion?.blockedForOperator,
      },
      item.expected,
      item.name,
    );
  }
});

test('final-completion action resolution handles accept, continue, cap, and operator block', async () => {
  const baseState = await createViewState('execute');
  const initialCompletion = getFinalCompletionView(baseState);
  assert.ok(initialCompletion);

  assert.deepEqual(
    resolveFinalCompletionReviewAction({
      finalCompletion: initialCompletion,
      reviewerAction: 'accept_complete',
      continueExecutionLimit: 2,
    }),
    {
      reviewerAction: 'accept_complete',
      effectiveAction: 'accept_complete',
      continueExecutionCount: 0,
      continueExecutionLimit: 2,
      continueExecutionCapReached: false,
    },
  );

  assert.deepEqual(
    resolveFinalCompletionReviewAction({
      finalCompletion: initialCompletion,
      reviewerAction: 'continue_execution',
      continueExecutionLimit: 2,
    }),
    {
      reviewerAction: 'continue_execution',
      effectiveAction: 'continue_execution',
      continueExecutionCount: 1,
      continueExecutionLimit: 2,
      continueExecutionCapReached: false,
    },
  );

  const cappedCompletion = getFinalCompletionView({
    ...baseState,
    finalCompletionContinueExecutionCount: 2,
  });
  assert.ok(cappedCompletion);

  assert.deepEqual(
    resolveFinalCompletionReviewAction({
      finalCompletion: cappedCompletion,
      reviewerAction: 'continue_execution',
      continueExecutionLimit: 2,
    }),
    {
      reviewerAction: 'continue_execution',
      effectiveAction: 'block_for_operator',
      continueExecutionCount: 2,
      continueExecutionLimit: 2,
      continueExecutionCapReached: true,
    },
  );

  assert.deepEqual(
    resolveFinalCompletionReviewAction({
      finalCompletion: cappedCompletion,
      reviewerAction: 'block_for_operator',
      continueExecutionLimit: 2,
    }),
    {
      reviewerAction: 'block_for_operator',
      effectiveAction: 'block_for_operator',
      continueExecutionCount: 2,
      continueExecutionLimit: 2,
      continueExecutionCapReached: false,
    },
  );
});

test('derived-plan view classifies pending, active, rejected, and abandoned states', async () => {
  const baseState = await createViewState('execute');
  const derivedPlanPath = join(baseState.runDir, 'DERIVED_PLAN_SCOPE_4.md');
  const cases: {
    name: string;
    overrides: Partial<OrchestrationState>;
    expectedState: NonNullable<ReturnType<typeof getDerivedPlanView>>['state'];
    expected: {
      reviewActive: boolean;
      acceptedAwaitingExecution: boolean;
      executing: boolean;
      abandoned: boolean;
      poisonedCompletedState: boolean;
      needsFlush: boolean;
    };
  }[] = [
    {
      name: 'pending review',
      overrides: {
        phase: 'reviewer_plan',
        status: 'running',
        derivedPlanStatus: 'pending_review',
        derivedScopeIndex: null,
        splitPlanStartedNotified: false,
      },
      expectedState: 'pending_review',
      expected: {
        reviewActive: true,
        acceptedAwaitingExecution: false,
        executing: false,
        abandoned: false,
        poisonedCompletedState: false,
        needsFlush: true,
      },
    },
    {
      name: 'accepted awaiting execution',
      overrides: {
        phase: 'awaiting_derived_plan_execution',
        status: 'running',
        derivedPlanStatus: 'accepted',
        derivedScopeIndex: null,
        derivedPlanAcceptedNotified: false,
      },
      expectedState: 'accepted_awaiting_execution',
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: true,
        executing: false,
        abandoned: false,
        poisonedCompletedState: false,
        needsFlush: true,
      },
    },
    {
      name: 'active derived execution',
      overrides: {
        phase: 'coder_scope',
        status: 'running',
        derivedPlanStatus: 'accepted',
        derivedScopeIndex: 2,
        derivedPlanAcceptedNotified: true,
      },
      expectedState: 'active_execution',
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: false,
        executing: true,
        abandoned: false,
        poisonedCompletedState: false,
        needsFlush: false,
      },
    },
    {
      name: 'rejected plan',
      overrides: {
        phase: 'blocked',
        status: 'blocked',
        lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
        derivedPlanStatus: 'rejected',
        derivedScopeIndex: null,
        splitPlanBlockedNotified: false,
      },
      expectedState: 'rejected',
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: false,
        executing: false,
        abandoned: true,
        poisonedCompletedState: false,
        needsFlush: true,
      },
    },
    {
      name: 'rejected abandoned completed state',
      overrides: {
        phase: 'done',
        status: 'done',
        derivedPlanStatus: 'rejected',
        derivedScopeIndex: null,
      },
      expectedState: 'rejected_abandoned',
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: false,
        executing: false,
        abandoned: true,
        poisonedCompletedState: true,
        needsFlush: false,
      },
    },
  ];

  for (const item of cases) {
    const state: OrchestrationState = {
      ...baseState,
      derivedPlanPath,
      derivedFromScopeNumber: 4,
      ...item.overrides,
    };
    const derivedPlan = getDerivedPlanView(state);
    const identity = getDerivedPlanIdentityView(state);
    const counters = getDerivedPlanCountersView(state);

    assert.equal(derivedPlan?.state, item.expectedState, item.name);
    assert.equal(identity?.path, derivedPlanPath, item.name);
    assert.equal(counters.maxDerivedPlanReviewRounds, state.maxDerivedPlanReviewRounds, item.name);
    assert.deepEqual(
      {
        reviewActive: derivedPlan?.reviewActive,
        acceptedAwaitingExecution: derivedPlan?.acceptedAwaitingExecution,
        executing: derivedPlan?.executing,
        abandoned: derivedPlan?.abandoned,
        poisonedCompletedState: derivedPlan?.poisonedCompletedState,
        needsFlush: needsDerivedPlanNotificationFlush(state),
      },
      item.expected,
      item.name,
    );
  }
});

test('derived-plan notification flush includes terminal split-plan blocks without derived-plan identity', async () => {
  const baseState = await createViewState('execute');
  const blockedState: OrchestrationState = {
    ...baseState,
    phase: 'blocked',
    status: 'blocked',
    currentScopeNumber: 1,
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanBlockedNotified: false,
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SPLIT_PLAN',
        result: 'blocked',
        baseCommit: baseState.baseCommit,
        finalCommit: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 0,
        findings: 0,
        archivedReviewPath: null,
        blocker:
          'split-plan recovery rejected: replacement plan payload is not a valid Neal-executable plan: `executionShape: multi_scope` must not include a `## Completion Condition` section.',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  };

  assert.equal(getDerivedPlanView(blockedState), null);
  assert.equal(needsDerivedPlanNotificationFlush(blockedState), true);
  assert.equal(
    needsDerivedPlanNotificationFlush({
      ...blockedState,
      splitPlanBlockedNotified: true,
    }),
    false,
  );
});

test('derived-plan resume classification lives with the derived-plan view', async () => {
  const baseState = await createViewState('execute');
  const derivedPlanPath = join(baseState.runDir, 'DERIVED_PLAN_SCOPE_6.md');
  const acceptedState: OrchestrationState = {
    ...baseState,
    phase: 'done',
    status: 'done',
    derivedPlanPath,
    derivedFromScopeNumber: 6,
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: null,
    createdCommits: [],
  };
  const pendingState: OrchestrationState = {
    ...acceptedState,
    derivedPlanStatus: 'pending_review',
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['PLAN.md'],
        claim: 'Plan needs a tighter scope.',
        evidence: null,
        requiredAction: 'Revise the derived plan.',
        status: 'open',
        roundSummary: 'Missing detail.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  };
  const rejectedState: OrchestrationState = {
    ...acceptedState,
    derivedPlanStatus: 'rejected',
  };
  // Reproduction state: the derived-plan review is still actively running in its pending-review
  // phase (coder_plan_response) with no blocked phase. An open blocking finding resolves the
  // pending phase to coder_plan_response, but a live running review is already on the right
  // phase, so resume must classify it as a no-op continue rather than re-promoting it.
  const runningPendingState: OrchestrationState = {
    ...pendingState,
    phase: 'coder_plan_response',
    status: 'running',
    blockedFromPhase: null,
  };

  assert.deepEqual(classifyUnexecutedDerivedPlanResumeState(acceptedState), {
    kind: 'accepted',
    phase: 'awaiting_derived_plan_execution',
  });
  assert.deepEqual(classifyUnexecutedDerivedPlanResumeState(pendingState), {
    kind: 'pending_review',
    phase: 'coder_plan_response',
  });
  assert.deepEqual(classifyUnexecutedDerivedPlanResumeState(runningPendingState), {
    kind: 'none',
  });
  assert.equal(classifyUnexecutedDerivedPlanResumeState(rejectedState).kind, 'rejected');
});
