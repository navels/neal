import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadOrInitialize } from '../src/neal/orchestrator.js';
import { createRunLogger } from '../src/neal/logger.js';
import { recordRecoveryGuidanceForResolvedRun } from '../src/neal/commands/recovery-guidance.js';
import { clearProviderCapabilitiesOverridesForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { type CoderRunPromptArgs, type CoderStructuredPromptArgs, type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { normalizeCliStderr } from './helpers/cli.js';
import { finalizeBlockedPlanReviewResponse, runCoderPlanPhase } from '../src/neal/orchestrator/phases/planning.js';
import { getExecuteRunResultExitCode } from '../src/neal/commands/writer-exit-codes.js';
import { runReviewPhase } from '../src/neal/orchestrator/phases/review.js';
import { applyInteractiveBlockedRecoveryDisposition, enterInteractiveBlockedRecovery, hasPendingInteractiveBlockedRecoveryTurn, recordInteractiveBlockedRecoveryGuidance, runInteractiveBlockedRecoveryPhase, shouldNotifyInteractiveBlockedRecoveryEntry } from '../src/neal/orchestrator/phases/recovery.js';
import { getCurrentExecutionScopeDescriptor } from '../src/neal/scopes.js';
import { buildRecentBlockCandidate } from '../src/neal/adjudicator/consultant.js';
import { getDefaultAgentConfig, loadState, saveState } from '../src/neal/state.js';
import { getPlanReviewGuidanceView, getPublicLifecycleView } from '../src/neal/state-views.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { createResumeFixture, runGit, runNealCliResultInCwd, createExecuteFinalizationFixture, readEventTypes, readEvents, REVIEW_STUCK_REASON, recoverableConsultantVerdict, nonRecoverableConsultantVerdict, installConsultantAdvisorOverride, createConsultantRecoveryFixture, writeConsultantKnobConfig } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-recovery');

test('resume restores blocked derived-plan coder response sessions', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_4.md';
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan_response',
    plannerSessionHandle: 'planner-session-1',
    plannerSessionProtocol: 'structured_json_v1',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'coder_plan_response');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'pending_review');
  assert.equal(state.derivedFromScopeNumber, 4);
});

test('resume preserves interactive blocked recovery state without resuming execution', async () => {
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    coderSessionHandle: 'coder-session-1',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'interactive_blocked_recovery');
  assert.equal(state.status, 'running');
  assert.equal(state.blockedFromPhase, 'coder_scope');
  assert.equal(state.interactiveBlockedRecovery?.blockedReason, 'Need operator guidance');
  assert.equal(state.interactiveBlockedRecovery?.turns.length, 0);
});

test('resume restores failed interactive blocked recovery state and rewrites artifacts', async () => {
  const { cwd, statePath, state: savedState } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'interactive_blocked_recovery',
    status: 'failed',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Keep the scope and avoid infrastructure edits.',
          disposition: null,
        },
      ],
    },
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'interactive_blocked_recovery');
  assert.equal(state.status, 'running');
  assert.equal(state.interactiveBlockedRecovery?.blockedReason, 'Need operator guidance');
  assert.equal(state.interactiveBlockedRecovery?.turns.length, 1);

  const supportMarkdown = await readFile(savedState.recoveryMarkdownPath, 'utf8');
  assert.match(supportMarkdown, /Keep the scope and avoid infrastructure edits\./);

  const progressMarkdown = await readFile(savedState.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery/);
  assert.match(progressMarkdown, /Handled turns: 0/);
});

test('recordInteractiveBlockedRecoveryGuidance persists operator recovery input and artifacts', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  });

  const nextState = await recordInteractiveBlockedRecoveryGuidance(
    statePath,
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 1);
  assert.match(
    nextState.interactiveBlockedRecovery?.turns[0].operatorGuidance ?? '',
    /Replace this scope with a narrower plan/,
  );

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.interactiveBlockedRecovery?.turns.length, 1);
  assert.equal(
    reloadedState.interactiveBlockedRecovery?.turns[0].operatorGuidance,
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );

  const supportMarkdown = await readFile(state.recoveryMarkdownPath, 'utf8');
  assert.match(supportMarkdown, /## Active Recovery/);
  assert.match(supportMarkdown, /Replace this scope with a narrower plan and keep the last accepted commit\./);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /Effective status: running/);
  assert.match(progressMarkdown, /Pending operator guidance: yes/);
  assert.match(progressMarkdown, /## Interactive Blocked Recovery/);
  assert.match(progressMarkdown, /Recorded turns: 1/);
});

test('execute-mode derived-plan-review convergence block lands the interactive-recovery operator wait', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_plan',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    topLevelMode: 'execute',
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await finalizeBlockedPlanReviewResponse(
    state,
    statePath,
    true,
    'Derived plan review did not converge.',
    'reviewer_convergence',
    logger,
  );

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), false);
  assert.equal(getPublicLifecycleView(nextState).waitingForOperatorGuidance, true);
});

test('enterInteractiveBlockedRecovery waits for operator guidance and maps to writer exit code 2', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await enterInteractiveBlockedRecovery(
    state,
    statePath,
    'Reviewer needs an operator decision before continuing.',
    logger,
  );

  // Site A: the run halts as the `status: 'running'` interactive-recovery wait
  // for `neal resume --message`.
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), false);
  assert.equal(getPublicLifecycleView(nextState).waitingForOperatorGuidance, true);
  assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), true);
  assert.equal(
    getExecuteRunResultExitCode({
      finalState: nextState,
      waitingForOperatorGuidance: true,
      waitingForManualGate: false,
      stopRequestedAfterScope: false,
    }),
    2,
  );
});

test('recoverable block auto-applies the consultant directive without yielding', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    // A recoverable verdict is applied directly: the directive is injected and
    // consumed, so the run continues rather than yielding.
    assert.equal(advisor.callCount(), 1, 'the eligible block is triaged once');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(
      nextState.interactiveBlockedRecovery?.pendingDirective?.operatorGuidance,
      recoverableConsultantVerdict().resolutionDirective,
    );
    assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);
    assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), false, 'an auto-fix must not notify');
    assert.equal(
      nextState.interactiveBlockedRecovery?.consultantAdvice,
      undefined,
      'a recoverable verdict is applied, not persisted as advice',
    );

    // The shared per-scope budget is consumed and the block is recorded.
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.recentBlocks.length, 1);
    assert.equal(nextState.recentBlocks[0]?.count, 1);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('consultant.start'));
    assert.ok(eventTypes.includes('consultant.verdict'));
    assert.ok(eventTypes.includes('consultant.resolved'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('non-recoverable block records read-only consultant advice and yields', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ payload: nonRecoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    // A genuine wall yields for the operator, carrying the verdict as advice.
    assert.equal(advisor.callCount(), 1, 'the eligible block is triaged once');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0, 'a genuine wall still waits for guidance');
    assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), true);

    const advice = nextState.interactiveBlockedRecovery?.consultantAdvice;
    assert.ok(advice, 'consultant advice must be persisted on the recovery state');
    assert.equal(advice?.recoverable, nonRecoverableConsultantVerdict().recoverable);
    assert.equal(advice?.triageCategory, nonRecoverableConsultantVerdict().triageCategory);

    // The shared per-scope budget is consumed and the block is recorded.
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.recentBlocks.length, 1);
    assert.equal(nextState.recentBlocks[0]?.count, 1);

    // The advice survives a serialization round-trip.
    const reloaded = await loadState(statePath);
    assert.equal(reloaded.interactiveBlockedRecovery?.consultantAdvice?.triageCategory, advice?.triageCategory);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('consultant.start'));
    assert.ok(eventTypes.includes('consultant.verdict'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('eligible block swallows an consultant error and yields plainly with no events or advice', async () => {
  // The consultant error fallback must be indistinguishable from the
  // disabled/exhausted generic yield: the run yields waiting for the operator with
  // no advice, no budget/recentBlocks mutation, and no consultant.* events.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ throwError: new Error('consultant provider exploded') });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const recentBefore = state.recentBlocks;
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 1, 'the consultant was attempted before throwing');
    // The error is swallowed and the run yields as a plain operator block.
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0, 'the run still waits for guidance');
    assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null, 'no advice on the error path');
    assert.equal(nextState.consultantAttemptCount, 0, 'budget unchanged on the error path');
    assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged on the error path');

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(
      !eventTypes.some((type) => type.startsWith('consultant.')),
      'the error fallback must emit no consultant events',
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('eligible block with the disable knob (0) yields plainly with no advice', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  await writeConsultantKnobConfig(cwd, 0);
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const recentBefore = state.recentBlocks;
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 0, 'a disabled consultant must never run');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
    assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null, 'no advice when disabled');
    assert.equal(nextState.consultantAttemptCount, 0, 'budget untouched when disabled');
    assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged when disabled');

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')), 'no consultant events when disabled');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('eligible block at an exhausted budget yields plainly with no advice', async () => {
  // Knob default is 1; seed consultantAttemptCount at the cap so the budget is
  // exhausted for this scope.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({
    consultantAttemptCount: 1,
  });
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const recentBefore = state.recentBlocks;
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 0, 'an exhausted budget must not invoke the consultant');
    assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null);
    assert.equal(nextState.consultantAttemptCount, 1, 'the cap is not exceeded');
    assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged at the cap');

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(
      !eventTypes.some((type) => type.startsWith('consultant.')),
      'an exhausted budget must emit no consultant events',
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('an ineligible source phase (coder_plan) keeps the generic recovery path with zero consultant calls', async () => {
  for (const sourcePhase of ['coder_plan', 'coder_plan_response'] as const) {
    const { cwd, statePath, state } = await createConsultantRecoveryFixture({
      phase: sourcePhase,
      blockedFromPhase: sourcePhase,
    });
    const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
    const logger = await createRunLogger({
      cwd,
      stateDir: dirname(statePath),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    try {
      const recentBefore = state.recentBlocks;
      const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

      assert.equal(
        advisor.callCount(),
        0,
        `the ineligible plan-refinement phase ${sourcePhase} must never invoke the consultant`,
      );
      // The generic operator wait is preserved exactly.
      assert.equal(nextState.phase, 'interactive_blocked_recovery');
      assert.equal(nextState.status, 'running');
      assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
      assert.equal(nextState.consultantAttemptCount, 0);
      assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged for an ineligible phase');

      const eventTypes = await readEventTypes(state.runDir);
      assert.ok(
        !eventTypes.some((type) => type.startsWith('consultant.')),
        `no consultant events for ineligible phase ${sourcePhase}`,
      );
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  }
});

test('reviewer block without the review_stuck prefix keeps the generic path', async () => {
  // Reviewer phases are adjudicated ONLY for a genuine structural review_stuck
  // deadlock. An ordinary blocking-finding block that reaches recovery via a
  // reviewer phase (no `review_stuck:` prefix) is normal review back-and-forth and
  // must keep the generic operator wait with zero consultant calls.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const recentBefore = state.recentBlocks;
    const nextState = await enterInteractiveBlockedRecovery(
      state,
      statePath,
      'reached max review rounds without convergence',
      logger,
    );

    assert.equal(advisor.callCount(), 0, 'a non-review_stuck reviewer block must not consult the consultant');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
    assert.equal(nextState.consultantAttemptCount, 0);
    assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged for a non-adjudicated reviewer block');

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('eligible coder block is triaged by the generalized dispatch regardless of reason prefix', async () => {
  // Dispatch is now keyed on the eligible source phase, not a `review_stuck:`
  // reason prefix: a plain coder blocker on coder_scope is adjudicated.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    const nextState = await enterInteractiveBlockedRecovery(
      state,
      statePath,
      'Coder cannot finish the scope: the in-scope fix is unclear.',
      logger,
    );

    assert.equal(advisor.callCount(), 1, 'an eligible coder block is adjudicated');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(
      nextState.interactiveBlockedRecovery?.pendingDirective?.operatorGuidance,
      recoverableConsultantVerdict().resolutionDirective,
    );
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.recentBlocks[0]?.sourcePhase, 'coder_scope');

    const events = await readEvents(state.runDir);
    const start = events.find((event) => event.type === 'consultant.start');
    assert.equal((start?.data as Record<string, unknown> | undefined)?.sourcePhase, 'coder_scope');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('disabled/exhausted budget leaves recentBlocks unchanged on the generic path', async () => {
  for (const overrides of [{ knob: 0, seedCount: 0 }, { knob: 1, seedCount: 1 }] as const) {
    const { cwd, statePath, state } = await createConsultantRecoveryFixture({
      phase: 'coder_scope',
      blockedFromPhase: 'coder_scope',
      consultantAttemptCount: overrides.seedCount,
    });
    if (overrides.knob === 0) {
      await writeConsultantKnobConfig(cwd, 0);
    }
    const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
    const logger = await createRunLogger({
      cwd,
      stateDir: dirname(statePath),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    try {
      const recentBefore = state.recentBlocks;
      const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

      assert.equal(advisor.callCount(), 0, 'no consultant call when disabled/exhausted');
      assert.equal(nextState.phase, 'interactive_blocked_recovery');
      assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
      assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged on the generic fallback');
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  }
});

test('recentBlocks records a real eligible block and a same-scope resumed repeat short-circuits without re-invoking the advisor', async () => {
  // A generous budget isolates the anti-thrash guard from the coarse per-scope cap.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  await writeConsultantKnobConfig(cwd, 5);
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  const reason = 'Coder cannot finish the scope: the module fails to compile and the fix is unclear.';

  try {
    // First real block through the chokepoint persists a count:1 record.
    const firstState = await enterInteractiveBlockedRecovery(state, statePath, reason, logger);
    assert.equal(advisor.callCount(), 1, 'the first eligible block invokes the advisor');
    assert.equal(firstState.recentBlocks.length, 1);
    assert.equal(firstState.recentBlocks[0]?.count, 1);
    assert.equal(firstState.recentBlocks[0]?.scopeNumber, state.currentScopeNumber);

    // loadState round-trips the record unchanged.
    const reloaded = await loadState(statePath);
    assert.deepEqual(reloaded.recentBlocks, firstState.recentBlocks);

    // A resumed second block with the identical blocker in the same scope identity
    // short-circuits to recoverable:false WITHOUT re-invoking the advisor; the
    // record count increments to 2 and the run yields for the operator with the
    // non-recoverable verdict carried as advice.
    const secondEntryState: OrchestrationState = {
      ...reloaded,
      phase: 'coder_scope',
      blockedFromPhase: 'coder_scope',
      status: 'running',
      interactiveBlockedRecovery: null,
    };
    const secondState = await enterInteractiveBlockedRecovery(secondEntryState, statePath, reason, logger);
    assert.equal(advisor.callCount(), 1, 'the anti-thrash repeat does not re-invoke the advisor');
    assert.equal(secondState.phase, 'interactive_blocked_recovery');
    assert.equal(secondState.status, 'running');
    assert.equal(secondState.interactiveBlockedRecovery?.turns.length, 0, 'the repeat waits for the operator');
    assert.equal(secondState.interactiveBlockedRecovery?.consultantAdvice?.recoverable, false);
    assert.equal(secondState.recentBlocks.length, 1, 'the repeat updates the same record');
    assert.equal(secondState.recentBlocks[0]?.count, 2);

    // A control third block with the identical blocker but a DIFFERENT scope
    // identity does invoke the advisor and appends a separate record.
    const afterSecond = await loadState(statePath);
    const thirdEntryState: OrchestrationState = {
      ...afterSecond,
      currentScopeNumber: state.currentScopeNumber + 1,
      phase: 'coder_scope',
      blockedFromPhase: 'coder_scope',
      status: 'running',
      interactiveBlockedRecovery: null,
    };
    const thirdState = await enterInteractiveBlockedRecovery(thirdEntryState, statePath, reason, logger);
    assert.equal(advisor.callCount(), 2, 'a different scope identity invokes the advisor again');
    assert.equal(thirdState.recentBlocks.length, 2, 'a different scope identity appends a separate record');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('review_stuck recoverable path emits the audit-grade event sequence in order', async () => {
  // The autonomous decision must be fully reconstructable from the
  // structured event log alone — stable names, ordered sequence, and audit-grade
  // payload fields on every consultant event.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  try {
    await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    const events = await readEvents(state.runDir);
    const auditedTypes = [
      'consultant.start',
      'consultant.verdict',
      'interactive_blocked_recovery.entered',
      'consultant.resolved',
    ];
    const orderedIndexes = auditedTypes.map((type) =>
      events.findIndex((event) => event.type === type),
    );
    // Each audited event appears exactly once and in the documented order.
    for (let i = 0; i < auditedTypes.length; i += 1) {
      assert.notEqual(orderedIndexes[i], -1, `${auditedTypes[i]} must be emitted`);
      if (i > 0) {
        assert.ok(
          orderedIndexes[i] > orderedIndexes[i - 1],
          `${auditedTypes[i]} must be emitted after ${auditedTypes[i - 1]}`,
        );
      }
    }

    const dataOf = (type: string) =>
      events.find((event) => event.type === type)?.data as Record<string, unknown>;

    // Common audit fields on every consultant event.
    for (const type of [
      'consultant.start',
      'consultant.verdict',
      'consultant.resolved',
    ]) {
      const data = dataOf(type);
      assert.equal(data?.scopeNumber, state.currentScopeNumber, `${type} carries scopeNumber`);
      assert.equal(data?.sourcePhase, 'reviewer_scope', `${type} carries sourcePhase`);
      assert.equal(data?.blockedReason, REVIEW_STUCK_REASON, `${type} carries blockedReason`);
    }

    // Verdict-grade audit fields, including the post-increment counter, on both
    // the verdict and resolved events.
    const verdict = recoverableConsultantVerdict();
    for (const type of ['consultant.verdict', 'consultant.resolved']) {
      const data = dataOf(type);
      assert.equal(data?.recoverable, verdict.recoverable, `${type} carries recoverable`);
      assert.equal(data?.triageCategory, verdict.triageCategory, `${type} carries triageCategory`);
      assert.deepEqual(data?.targetCanonicalIds, verdict.targetCanonicalIds, `${type} carries targetCanonicalIds`);
      assert.equal(data?.consultantAttemptCount, 1, `${type} carries the post-increment consultantAttemptCount`);
    }

    // The entered event keeps its common audit fields so the recovery entry is
    // attributable to this consultant decision.
    const entered = dataOf('interactive_blocked_recovery.entered');
    assert.equal(entered?.scopeNumber, state.currentScopeNumber);
    assert.equal(entered?.sourcePhase, 'reviewer_scope');
    assert.equal(entered?.blockedReason, REVIEW_STUCK_REASON);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('reviewer-scope operator block lands the interactive-recovery wait and notifies', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 1,
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Implement scope 1.',
      newEvidence: 'The coder produced a change for scope 1.',
      whyNotRedundant: 'This is the first scope of the plan.',
      nextStepUnlocked: 'Review can decide whether the scope is complete.',
    },
  });
  // A non-empty current diff keeps `block_for_operator` a genuine operator block
  // (an empty diff would synthesize a no-progress finding routing to revision).
  await writeFile(join(cwd, 'feature.txt'), 'implemented\n', 'utf8');
  await runGit(cwd, 'add', 'feature.txt');
  await runGit(cwd, 'commit', '-m', 'scope 1 implementation');
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const reviewState = { ...state, createdCommits: [createdCommit] };
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'review');
          return {
            sessionHandle: 'reviewer-operator-block',
            structured: {
              summary: 'This objective needs an operator decision.',
              findings: [],
              meaningfulProgressAction: 'block_for_operator',
              meaningfulProgressRationale:
                'The objective genuinely cannot proceed without a decision only an operator can make.',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    // Normal caller path (review.ts): a reviewer block_for_operator enters
    // interactive recovery, waits for the operator, and notifies.
    const finalState = await runReviewPhase(reviewState, statePath, logger);

    assert.equal(finalState.status, 'running');
    assert.equal(finalState.phase, 'interactive_blocked_recovery');
    assert.equal(finalState.interactiveBlockedRecovery?.turns.length, 0);
    assert.equal(getPublicLifecycleView(finalState).waitingForOperatorGuidance, true);
    assert.equal(
      getExecuteRunResultExitCode({
        finalState,
        waitingForOperatorGuidance: true,
        waitingForManualGate: false,
        stopRequestedAfterScope: false,
      }),
      2,
    );

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('notify.blocked'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('recordRecoveryGuidanceForResolvedRun records operator guidance without manual session edits', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  });

  const result = await recordRecoveryGuidanceForResolvedRun({
    target: { statePath, selectedRunId: 'test-run' },
    message: 'Replace this scope with a narrower plan and keep the last accepted commit.',
  });

  assert.equal(result.kind, 'recorded');
  assert.equal(result.nextState.phase, 'interactive_blocked_recovery');
  assert.equal(result.nextState.status, 'running');
  assert.equal(result.statePath, statePath);
  assert.equal(result.runDir, state.runDir);
  assert.equal(result.recoveryTurns, 1);
  assert.equal(result.resumeCommand, 'neal resume --run test-run');

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.interactiveBlockedRecovery?.turns.length, 1);
  assert.equal(
    reloadedState.interactiveBlockedRecovery?.turns[0]?.operatorGuidance,
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );

  const supportMarkdown = await readFile(state.recoveryMarkdownPath, 'utf8');
  assert.match(supportMarkdown, /## Active Recovery/);
  assert.match(supportMarkdown, /Replace this scope with a narrower plan and keep the last accepted commit\./);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery/);
  assert.match(progressMarkdown, /Recorded turns: 1/);
});

test('recordRecoveryGuidanceForResolvedRun rejects recording more guidance while a recovery turn is still pending', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower plan and keep the last accepted commit.',
          disposition: null,
        },
      ],
    },
  });

  const result = await recordRecoveryGuidanceForResolvedRun({
    target: { statePath, selectedRunId: 'test-run' },
    message: 'One more operator instruction.',
  });

  assert.equal(result.kind, 'pending');
  assert.equal(result.statePath, statePath);
  assert.equal(result.runDir, state.runDir);
  assert.equal(result.pendingTurn, 1);
  assert.equal(result.recoveryTurns, 1);
  assert.match(result.message, /Operator guidance is recorded and ready for Neal to process/);
  assert.equal(result.resumeCommand, 'neal resume --run test-run');
});

test('recordRecoveryGuidanceForResolvedRun records a terminal-only directive when interactive blocked recovery hits its turn cap', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 3,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'First operator instruction.',
          disposition: null,
        },
        {
          number: 2,
          recordedAt: '2026-04-16T00:02:00.000Z',
          operatorGuidance: 'Second operator instruction.',
          disposition: null,
        },
        {
          number: 3,
          recordedAt: '2026-04-16T00:03:00.000Z',
          operatorGuidance: 'Third operator instruction.',
          disposition: null,
        },
      ],
    },
  });

  const result = await recordRecoveryGuidanceForResolvedRun({
    target: { statePath, selectedRunId: 'test-run' },
    message: 'One more operator instruction.',
  });

  assert.equal(result.kind, 'recorded');
  assert.equal(result.nextState.phase, 'interactive_blocked_recovery');
  assert.equal(result.nextState.status, 'running');
  assert.equal(result.statePath, statePath);
  assert.equal(result.runDir, state.runDir);
  assert.equal(result.recoveryTurns, 3);
  assert.equal(result.terminalDirectivePending, true);
  assert.equal(result.resumeCommand, 'neal resume --run test-run');

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.interactiveBlockedRecovery?.pendingDirective?.terminalOnly, true);
  assert.equal(
    reloadedState.interactiveBlockedRecovery?.pendingDirective?.operatorGuidance,
    'One more operator instruction.',
  );

  const eventTypes = (await readFile(join(state.runDir, 'events.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
  assert.ok(eventTypes.includes('run.resumed'));
  assert.ok(eventTypes.includes('run.user_guidance_scanned'));
  assert.ok(eventTypes.includes('interactive_blocked_recovery.terminal_directive_recorded'));
});

test('interactive blocked recovery can stay blocked, resume after interruption, and then continue the scope', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-5',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  });

  const afterFirstGuidance = await recordInteractiveBlockedRecoveryGuidance(
    statePath,
    'Do not replace the scope yet; first confirm whether the reviewer feedback can be applied directly.',
  );
  assert.equal(afterFirstGuidance.interactiveBlockedRecovery?.turns.length, 1);

  const stillBlockedState = await applyInteractiveBlockedRecoveryDisposition(
    afterFirstGuidance,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'More operator input is needed.',
      rationale: 'The guidance still leaves the actual remediation path ambiguous.',
      blocker: 'Need a concrete yes/no on whether the reviewer findings should be applied as-is in this scope.',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-5b',
  );

  assert.equal(stillBlockedState.phase, 'interactive_blocked_recovery');
  assert.equal(stillBlockedState.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(stillBlockedState.interactiveBlockedRecoveryHistory.length, 0);

  const resumed = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(resumed.state.phase, 'interactive_blocked_recovery');
  assert.equal(resumed.state.status, 'running');
  assert.equal(resumed.state.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(resumed.state.interactiveBlockedRecovery?.turns.length, 1);

  const afterSecondGuidance = await recordInteractiveBlockedRecoveryGuidance(
    statePath,
    'Apply the reviewer feedback directly and continue this scope.',
  );
  assert.equal(afterSecondGuidance.interactiveBlockedRecovery?.turns.length, 2);

  const finalState = await applyInteractiveBlockedRecoveryDisposition(
    afterSecondGuidance,
    statePath,
    {
      action: 'resume_current_scope',
      summary: 'The scope can continue.',
      rationale: 'The operator clarified that the reviewer feedback should be applied directly.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-5c',
  );

  assert.equal(finalState.phase, 'coder_response');
  assert.equal(finalState.status, 'running');
  assert.equal(finalState.blockedFromPhase, null);
  assert.equal(finalState.interactiveBlockedRecovery, null);
  assert.equal(finalState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'resume_current_scope');
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'coder_response');
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.turns.length, 2);
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'stay_blocked');
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.turns[1]?.disposition?.action, 'resume_current_scope');

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.phase, 'coder_response');
  assert.equal(reloadedState.interactiveBlockedRecovery, null);
  assert.equal(reloadedState.interactiveBlockedRecoveryHistory[0]?.turns.length, 2);

  const supportMarkdown = await readFile(state.recoveryMarkdownPath, 'utf8');
  assert.match(supportMarkdown, /## Recovery History 1/);
  assert.match(supportMarkdown, /Recovery turn 1 coder action: stay_blocked/);
  assert.match(supportMarkdown, /Recovery turn 2 coder action: resume_current_scope/);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(progressMarkdown, /Sessions: 1/);
  assert.match(progressMarkdown, /Latest action: resume_current_scope/);
});

test('interactive blocked recovery resumes through the next ordinary coder path', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-4',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Apply the reviewer feedback and continue this scope.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'resume_current_scope',
      summary: 'The scope can continue.',
      rationale: 'The operator clarified how to proceed.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-4b',
  );

  assert.equal(nextState.phase, 'coder_response');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, null);
  assert.equal(nextState.coderSessionHandle, 'coder-session-4b');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'resume_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'coder_response');
});

test('interactive blocked recovery can route replacement through split-plan machinery', async () => {
  const { statePath, state } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'The current scope shape is wrong.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower derived plan.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'This scope should be replaced.',
      rationale: 'A narrower derived plan is safer.',
      blocker: '',
      replacementPlan:
        '## Goal\n\nReplace the stale scope.\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-6b',
  );

  assert.equal(nextState.phase, 'reviewer_plan');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'replace_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'replace_current_scope');
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedFromScopeNumber, 6);
});

test('interactive blocked recovery blocks invalid replacement plans without resetting scope work', async () => {
  const { cwd, statePath, state, createdCommit } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'The current scope shape is wrong.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower derived plan.',
          disposition: null,
        },
      ],
    },
  });
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(join(cwd, 'tmp', 'replacement-plan.md'), '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await writeFile(join(cwd, 'scope.txt'), 'base\nchange\ninteractive draft\n', 'utf8');

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'This scope should be replaced.',
      rationale: 'A pointer-only replacement is invalid.',
      blocker: '',
      replacementPlan: `Use tmp/replacement-plan.md from commit ${createdCommit}.`,
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-6b',
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  assert.equal(await readFile(join(cwd, 'tmp', 'replacement-plan.md'), 'utf8'), '## Execution Shape\n\nexecutionShape: one_shot\n');
  const visibleStatus = await runGit(cwd, 'status', '--short', '--', 'scope.txt', 'tmp');
  assert.match(visibleStatus, /M scope\.txt/);
  assert.match(visibleStatus, /\?\? tmp\//);
  await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_6.md'), 'utf8'), /ENOENT/);
  const invalidPayloadArtifact = await readFile(join(state.runDir, 'SCOPE_6_INVALID_DERIVED_PLAN.md'), 'utf8');
  assert.match(invalidPayloadArtifact, /Use tmp\/replacement-plan\.md from commit/);
  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'reviewer_scope');
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'replace_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'blocked');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'replace_current_scope');
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /not a valid Neal-executable plan/);
});

test('interactive blocked recovery keeps an existing pending derived plan when replacement payload is invalid', async () => {
  const previousDerivedPlanPath = '/tmp/OLD_DERIVED_PLAN_SCOPE_6.md';
  const { cwd, statePath, state, createdCommit } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: previousDerivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 1,
    splitPlanBlockedNotified: false,
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_plan',
      blockedReason: 'The current derived plan needs replacement.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this derived plan with a narrower valid plan.',
          disposition: null,
        },
      ],
    },
  });
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(join(cwd, 'tmp', 'replacement-plan.md'), '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'Replacement payload was pointer-only.',
      rationale: 'The new plan body was not present in the response.',
      blocker: '',
      replacementPlan: `Use tmp/replacement-plan.md from commit ${createdCommit}.`,
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-6b',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.derivedPlanPath, previousDerivedPlanPath);
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.completedScopes.at(-1)?.replacedByDerivedPlanPath, previousDerivedPlanPath);
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /not a valid Neal-executable plan/);
  await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_6.md'), 'utf8'), /ENOENT/);
});

test('interactive blocked recovery valid replacement starts a fresh pending derived-plan review', async () => {
  const previousDerivedPlanPath = '/tmp/OLD_DERIVED_PLAN_SCOPE_6.md';
  const { statePath, state, notifyLogPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: previousDerivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: null,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: true,
    splitPlanCountForCurrentScope: 1,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-old-derived-plan',
        reviewedPlanPath: previousDerivedPlanPath,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 1,
        findings: [],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [previousDerivedPlanPath],
        claim: 'The old derived plan needs replacement.',
        requiredAction: 'Replace the current scope.',
        status: 'open',
        roundSummary: 'Replacement required.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_plan',
      blockedReason: 'The current derived plan needs replacement.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this derived plan with a fresh valid plan.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'Replacement plan is complete.',
      rationale: 'A fresh bounded derived plan is safer.',
      blocker: '',
      replacementPlan:
        '## Goal\n\nReplace the stale derived plan.\n\n## Execution Shape\n\nexecutionShape: multi_scope\n\n## Execution Queue\n\n### Scope 1: Replacement\n- Goal: Execute the fresh replacement plan.\n- Verification: `pnpm typecheck`\n- Success Condition: The replacement scope is ready.\n',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-6b',
  );

  const expectedDerivedPlanPath = join(state.runDir, 'DERIVED_PLAN_SCOPE_6.md');
  assert.equal(nextState.phase, 'reviewer_plan');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.derivedPlanPath, expectedDerivedPlanPath);
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedFromScopeNumber, 6);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.derivedPlanAcceptedNotified, false);
  assert.equal(nextState.splitPlanBlockedNotified, false);
  assert.deepEqual(nextState.rounds, []);
  assert.deepEqual(nextState.findings, []);
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'replace_current_scope');
  assert.match(await readFile(expectedDerivedPlanPath, 'utf8'), /executionShape: multi_scope/);
  assert.match(await readFile(notifyLogPath, 'utf8'), /scope 6 split into derived plan; reviewing/);
});

test('interactive blocked recovery records a blocked history result when replacement hits the split-plan cap', async () => {
  const { statePath, state } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 10,
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'The current scope shape is wrong.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower derived plan.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'This scope should be replaced.',
      rationale: 'A narrower derived plan is safer.',
      blocker: '',
      replacementPlan:
        '## Goal\n\nReplace the stale scope.\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-6b',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'replace_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'blocked');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'replace_current_scope');
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /split-plan limit/);
});

test('interactive blocked recovery dispositions reject plan-mode sessions', async () => {
  const { statePath, state: baseState } = await createResumeFixture({
    topLevelMode: 'plan',
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    interactiveBlockedRecovery: null,
  });
  const state: OrchestrationState = {
    ...baseState,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_plan',
      blockedReason: 'Plan review stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Keep revising the plan.',
          disposition: null,
        },
      ],
    },
  };

  await assert.rejects(
    () =>
      applyInteractiveBlockedRecoveryDisposition(
        state,
        statePath,
        {
          action: 'resume_current_scope',
          summary: 'Continue the plan review.',
          rationale: 'The operator clarified the path forward.',
          blocker: '',
          replacementPlan: '',
          laterScopeNumber: 0,
          laterScopeBody: '',
        },
        'coder-session-plan',
      ),
    /only supported for execute-mode runs/,
  );
});

test('recordRecoveryGuidanceForResolvedRun accepts blocked top-level plan-review guidance', async () => {
  const { statePath } = await createResumeFixture({
    topLevelMode: 'plan',
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    interactiveBlockedRecovery: null,
  });

  const result = await recordRecoveryGuidanceForResolvedRun({
    target: { statePath, selectedRunId: 'test-run' },
    message: '  Keep revising the plan.  ',
  });
  const persisted = await loadState(statePath);

  assert.equal(result.kind, 'recorded');
  assert.equal(result.nextState.phase, 'coder_plan_response');
  assert.equal(result.nextState.status, 'running');
  assert.equal(result.nextState.blockedFromPhase, null);
  assert.equal(result.nextState.interactiveBlockedRecovery, null);
  assert.equal(result.nextState.pendingPlanReviewGuidance?.message, 'Keep revising the plan.');
  assert.equal(persisted.pendingPlanReviewGuidance?.message, 'Keep revising the plan.');
});

test('blocked top-level plan review does not enter interactive blocked recovery', async () => {
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan_response',
    interactiveBlockedRecovery: null,
  });

  const nextState = await finalizeBlockedPlanReviewResponse(
    state,
    statePath,
    false,
    'Plan review did not converge.',
    'coder_authored',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  // A coder-authored response block persists a durable, recoverable reason.
  assert.equal(nextState.blockerReason, 'Plan review did not converge.');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 0);
});

test('top-level plan-review convergence block stays blocked and maps to writer exit code 2 (site C)', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    interactiveBlockedRecovery: null,
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const blockedState = await finalizeBlockedPlanReviewResponse(
    state,
    statePath,
    false,
    'Plan review did not converge under the round cap.',
    'reviewer_convergence',
    logger,
  );

  // Site C: the reviewer-convergence cap leaves the recognized blocked
  // plan-review state (writer exit 2), resumable via `neal resume --message`.
  assert.equal(blockedState.status, 'blocked');
  assert.equal(blockedState.phase, 'blocked');
  assert.equal(blockedState.blockedFromPhase, 'reviewer_plan');
  // A convergence block carries no coder-authored blocker reason.
  assert.equal(blockedState.blockerReason, null);
  assert.equal(blockedState.interactiveBlockedRecovery, null);
  assert.equal(
    getExecuteRunResultExitCode({
      finalState: blockedState,
      waitingForOperatorGuidance: true,
      waitingForManualGate: false,
      stopRequestedAfterScope: false,
    }),
    2,
  );

  const reloaded = await loadState(statePath);
  assert.equal(reloaded.status, 'blocked');
  assert.equal(reloaded.pendingPlanReviewGuidance, null);
  // The blocked reviewer_plan state is recognized as a message-resume wait.
  assert.equal(getPlanReviewGuidanceView(reloaded).waitingForOperatorGuidance, true);

  const eventTypes = await readEventTypes(state.runDir);
  assert.ok(eventTypes.includes('notify.blocked'));
});

test('plan-mode coder plan block stays blocked without execute-mode recovery', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'coder_plan',
    status: 'running',
    blockedFromPhase: null,
    maxRounds: 20,
  });
  const plannerPrompts: string[] = [];

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          plannerPrompts.push(args.prompt);
          return {
            sessionHandle: 'planner-blocked-session',
            structured: {
              action: 'blocked',
              message: 'The planner cannot produce a safe plan.',
              executionShape: 'multi_scope_unknown',
              planBody: '',
              blockedReason: 'Need a better task boundary before planning can continue.',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const logger = await createRunLogger({
      cwd,
      stateDir: dirname(dirname(state.runDir)),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });
    const nextState = await runCoderPlanPhase(state, statePath, logger);
    const persisted = await loadState(statePath);

    assert.equal(plannerPrompts.length, 1);
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'coder_plan');
    assert.equal(nextState.interactiveBlockedRecovery, null);
    assert.equal(persisted.phase, 'blocked');
    assert.equal(persisted.interactiveBlockedRecovery, null);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('interactive blocked recovery can remain paused after a handled turn', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need clarification.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Do not touch infrastructure, only local code.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'Still blocked.',
      rationale: 'The guidance did not answer the key prerequisite question.',
      blocker: 'Need a concrete yes/no on whether credentials can be rotated in this scope.',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-5b',
  );

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(
    nextState.interactiveBlockedRecovery?.blockedReason,
    'Need a concrete yes/no on whether credentials can be rotated in this scope.',
  );
  assert.equal(nextState.interactiveBlockedRecovery?.turns[0]?.disposition?.action, 'stay_blocked');
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 0);
});

test('neal resume reports when interactive blocked recovery is waiting for operator guidance', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need clarification.',
      maxTurns: 3,
      lastHandledTurn: 1,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Do not touch infrastructure, only local code.',
          disposition: {
            recordedAt: '2026-04-16T00:02:00.000Z',
            sessionHandle: 'coder-session-5b',
            action: 'stay_blocked',
            summary: 'Still blocked.',
            rationale: 'The guidance did not answer the key prerequisite question.',
            blocker: 'Need a concrete yes/no on whether credentials can be rotated in this scope.',
            replacementPlan: '',
            laterScopeNumber: 0,
            laterScopeBody: '',
            resultingPhase: 'interactive_blocked_recovery',
          },
        },
      ],
    },
  });
  await writeFile(
    join(state.runDir, 'RETROSPECTIVE.md'),
    '# Stale Retrospective\n\nThis stale accepted-scope retrospective should not print.\n',
    'utf8',
  );
  const before = await readFile(statePath, 'utf8');

  await assert.rejects(
    () => runNealCliResultInCwd(cwd, 'resume', '--run', 'test-run'),
    (error) => {
      const execError = error as { stdout?: string; stderr?: string; code?: number };
      assert.equal(execError.code, 2);
      assert.match(execError.stdout ?? '', /Run is waiting for operator guidance: Need clarification\./);
      assert.match(execError.stdout ?? '', /neal resume --run test-run --message "\.\.\."/);
      assert.equal(normalizeCliStderr(execError.stderr ?? ''), '');
      assert.doesNotMatch(execError.stdout ?? '', /Stale Retrospective/);
      return true;
    },
  );
  assert.equal(await readFile(statePath, 'utf8'), before);
});

test('interactive blocked recovery can finalize into a terminal blocked run', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 7,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need an external prerequisite.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Try one more time with the same repository constraints.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'terminal_block',
      summary: 'No safe in-repo path remains.',
      rationale: 'The prerequisite must be handled outside Neal first.',
      blocker: 'External credentials must be provisioned before this scope can continue.',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-7b',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'terminal_block');
  assert.equal(nextState.completedScopes.at(-1)?.result, 'blocked');
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /External credentials must be provisioned/);

  const supportMarkdown = await readFile(state.recoveryMarkdownPath, 'utf8');
  assert.match(supportMarkdown, /## Recovery History 1/);
  assert.match(supportMarkdown, /Recovery turn 1 coder action: terminal_block/);
});

test('terminal blocked recovery abandons an active pending derived-plan review as rejected', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_7.md';
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 7,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 7,
    derivedScopeIndex: null,
    splitPlanBlockedNotified: false,
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_plan',
      blockedReason: 'Derived plan review cannot continue safely.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Stop this derived plan and block the parent scope.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'terminal_block',
      summary: 'The derived plan is abandoned.',
      rationale: 'There is no safe replacement or continuation.',
      blocker: 'The derived plan cannot be executed safely without external input.',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    'coder-session-7b',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'reviewer_plan');
  assert.equal(nextState.derivedPlanPath, derivedPlanPath);
  assert.equal(nextState.derivedPlanStatus, 'rejected');
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.splitPlanBlockedNotified, true);
  assert.equal(nextState.completedScopes.at(-1)?.marker, 'AUTONOMY_SPLIT_PLAN');
  assert.equal(nextState.completedScopes.at(-1)?.result, 'blocked');
  assert.equal(nextState.completedScopes.at(-1)?.replacedByDerivedPlanPath, derivedPlanPath);
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /cannot be executed safely/);
});

test('resume keeps derived-plan reviewer rounds runnable after failure normalization', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_7.md';
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 7,
    phase: 'reviewer_plan',
    status: 'failed',
    reviewerSessionHandle: 'reviewer-session-1',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 7,
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'reviewer_plan');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'pending_review');
  assert.equal(state.derivedFromScopeNumber, 7);
});

// --- Operator-directed later-scope revision ----------------------------------

const TOP_LEVEL_PLAN = `# Top-level plan

## Execution Shape

executionShape: multi_scope

## Objective

Ship three slices.

## Execution Queue

### Scope 1: First slice
- Goal: Do the first thing.
- Verification: \`pnpm typecheck\`
- Success Condition: First thing done.

### Scope 2: Second slice
- Goal: Do the second thing.
- Verification: \`pnpm test\`
- Success Condition: Second thing done.

### Scope 3: Third slice
- Goal: Do the third thing.
- Verification: \`pnpm build\`
- Success Condition: Third thing done.

## Boundaries

- Keep it small.
`;

const ONE_SHOT_PLAN = `# One-shot plan

## Execution Shape

executionShape: one_shot

## Objective

Do one thing.
`;

const ALIAS_PLAN = `# Alias plan

## Execution Shape

executionShape: multi_scope

## Ordered Derived Scopes

1. Scope 6.6A: Migrate the inputs
- Goal: Move the implementation.
- Verification strategy: \`pnpm typecheck\`
- Exit criteria: Moved.

2. Scope 6.6B: Remove the shim
- Goal: Delete the wrapper.
- Verification strategy: \`pnpm typecheck\`
- Exit criteria: Gone.
`;

const REVISED_SCOPE_3 = `### Scope 3: Third slice, narrowed
- Goal: Do only the third thing's parser half.
- Verification: \`pnpm build\`
- Success Condition: The parser half is done.`;

const REVISED_SCOPE_2 = `### Scope 2: Second slice, narrowed
- Goal: Do only half of the second thing.
- Verification: \`pnpm test\`
- Success Condition: Half of the second thing is done.`;

function expectedRevisedPlan(planText: string, targetHeading: string, revisedBody: string, nextHeading: string) {
  const start = planText.indexOf(targetHeading);
  const end = planText.indexOf(nextHeading);
  return `${planText.slice(0, start)}${revisedBody}\n\n${planText.slice(end)}`;
}

async function createLaterScopeRevisionFixture(planText: string, overrides: Partial<OrchestrationState> = {}) {
  const fixture = await createResumeFixture({
    currentScopeNumber: 1,
    executionShape: 'multi_scope',
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-1',
    interactiveBlockedRecovery: {
      enteredAt: '2026-08-27T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Scope 3 assumes a parser shape this scope is about to change.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-08-27T00:01:00.000Z',
          operatorGuidance: 'Keep going here; narrow scope 3 to the parser half.',
          disposition: null,
        },
      ],
    },
    ...overrides,
  });
  await writeFile(fixture.state.planDoc, planText, 'utf8');
  const logger = await createRunLogger({
    cwd: fixture.state.cwd,
    stateDir: dirname(fixture.statePath),
    planDoc: fixture.state.planDoc,
    topLevelMode: fixture.state.topLevelMode,
    runDir: fixture.state.runDir,
  });
  return { ...fixture, logger };
}

test('resume_current_scope with a later-scope revision rewrites only that scope in the top-level plan', async () => {
  const { statePath, state, logger } = await createLaterScopeRevisionFixture(TOP_LEVEL_PLAN);

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'resume_current_scope',
      summary: 'Continue this scope; scope 3 is narrowed per the operator.',
      rationale: 'The operator directed scope 3 to cover only the parser half.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 3,
      laterScopeBody: REVISED_SCOPE_3,
    },
    'coder-session-1b',
    logger,
  );

  assert.equal(
    await readFile(state.planDoc, 'utf8'),
    expectedRevisedPlan(TOP_LEVEL_PLAN, '### Scope 3:', REVISED_SCOPE_3, '## Boundaries'),
  );
  assert.equal(nextState.phase, 'coder_response');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  const disposition = nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition;
  assert.equal(disposition?.laterScopeNumber, 3);
  assert.equal(disposition?.laterScopeBody, REVISED_SCOPE_3);

  const reloaded = await loadState(statePath);
  assert.equal(reloaded.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.laterScopeNumber, 3);
  assert.equal(reloaded.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.laterScopeBody, REVISED_SCOPE_3);

  const recoveryMarkdown = await readFile(state.recoveryMarkdownPath, 'utf8');
  assert.match(recoveryMarkdown, /Recovery turn 1 revised later scope: 3/);
  assert.match(recoveryMarkdown, / {2}### Scope 3: Third slice, narrowed/);

  const events = await readEvents(state.runDir);
  const revised = events.find((event) => event.type === 'interactive_blocked_recovery.later_scope_revised');
  assert.deepEqual(revised?.data, { scopeNumber: 1, laterScopeNumber: 3, planDoc: state.planDoc });

  const descriptor = await getCurrentExecutionScopeDescriptor({ ...nextState, currentScopeNumber: 3 });
  assert.equal(descriptor.title, 'Third slice, narrowed');
});

test('stay_blocked with a later-scope revision writes the plan and keeps the run in recovery', async () => {
  const { statePath, state, logger } = await createLaterScopeRevisionFixture(TOP_LEVEL_PLAN);

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'Scope 3 is narrowed; still need a decision for this scope.',
      rationale: 'The operator settled scope 3 but not the current parser change.',
      blocker: 'Need a yes/no on changing the parser shape in this scope.',
      replacementPlan: '',
      laterScopeNumber: 3,
      laterScopeBody: REVISED_SCOPE_3,
    },
    'coder-session-1b',
    logger,
  );

  assert.equal(
    await readFile(state.planDoc, 'utf8'),
    expectedRevisedPlan(TOP_LEVEL_PLAN, '### Scope 3:', REVISED_SCOPE_3, '## Boundaries'),
  );
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(nextState.interactiveBlockedRecovery?.turns[0]?.disposition?.laterScopeNumber, 3);
  assert.equal(nextState.interactiveBlockedRecovery?.turns[0]?.disposition?.laterScopeBody, REVISED_SCOPE_3);
});

test('a later-scope revision paired with replace_current_scope is rejected before any plan write', async () => {
  const { statePath, state, logger } = await createLaterScopeRevisionFixture(TOP_LEVEL_PLAN);

  await assert.rejects(
    () =>
      applyInteractiveBlockedRecoveryDisposition(
        state,
        statePath,
        {
          action: 'replace_current_scope',
          summary: 'Replace this scope and narrow scope 3.',
          rationale: 'Both at once.',
          blocker: '',
          replacementPlan: '## Goal\n\nReplace.\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
          laterScopeNumber: 3,
          laterScopeBody: REVISED_SCOPE_3,
        },
        'coder-session-1b',
        logger,
      ),
    /may accompany only action=resume_current_scope or action=stay_blocked/,
  );

  assert.equal(await readFile(state.planDoc, 'utf8'), TOP_LEVEL_PLAN);
  assert.equal((await loadState(statePath)).phase, 'interactive_blocked_recovery');
});

test('ineligible runs neither offer nor accept a later-scope revision', async () => {
  const cases: Array<{ name: string; planText: string; overrides: Partial<OrchestrationState> }> = [
    { name: 'one-shot plan', planText: ONE_SHOT_PLAN, overrides: { executionShape: 'one_shot' } },
    { name: 'current scope is last', planText: TOP_LEVEL_PLAN, overrides: { currentScopeNumber: 3 } },
    { name: 'alias-form plan', planText: ALIAS_PLAN, overrides: {} },
  ];

  for (const { name, planText, overrides } of cases) {
    const { statePath, state, logger } = await createLaterScopeRevisionFixture(planText, overrides);
    const target = overrides.currentScopeNumber === 3 ? 4 : 2;
    let prompt = '';
    setProviderCapabilitiesOverrideForTesting('openai-codex', {
      createCoderAdapter() {
        return {
          async runPrompt() {
            throw new Error('text coder prompt is not used in blocked recovery');
          },
          async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
            prompt = args.prompt;
            return {
              sessionHandle: 'coder-session-1b',
              structured: {
                action: 'resume_current_scope',
                summary: 'Continue.',
                rationale: 'Operator said to narrow a later scope.',
                blocker: '',
                replacementPlan: '',
                laterScopeNumber: target,
                laterScopeBody: `### Scope ${target}: Narrowed\n- Goal: Less.\n- Verification: \`pnpm test\`\n- Success Condition: Done.`,
              } as TStructured,
            };
          },
        };
      },
    });

    try {
      await assert.rejects(
        () => runInteractiveBlockedRecoveryPhase(state, statePath, logger),
        /A later-scope revision is not available for this round/,
        name,
      );
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }

    assert.ok(!prompt.includes('To revise a later scope'), `${name}: prompt must omit the offer`);
    assert.ok(prompt.includes('Always include `laterScopeNumber` as `0`'), `${name}: prompt keeps the empty-field rule`);
    assert.equal(await readFile(state.planDoc, 'utf8'), planText, `${name}: plan untouched`);
  }
});

test('a one_shot derived plan under a canonical multi_scope parent is still offered the revision, and the write lands in the top-level plan', async () => {
  const derivedPlanText = `# Derived plan for scope 1

## Execution Shape

executionShape: one_shot

## Objective

Do the parser change in one pass.
`;
  const { cwd, statePath, state, logger } = await createLaterScopeRevisionFixture(TOP_LEVEL_PLAN, {
    executionShape: 'one_shot',
  });
  const derivedPlanPath = join(cwd, 'DERIVED_PLAN_SCOPE_1.md');
  await writeFile(derivedPlanPath, derivedPlanText, 'utf8');
  const derivedState: OrchestrationState = {
    ...state,
    derivedPlanPath,
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 1,
    derivedScopeIndex: 1,
  };

  let prompt = '';
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('text coder prompt is not used in blocked recovery');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          prompt = args.prompt;
          return {
            sessionHandle: 'coder-session-1b',
            structured: {
              action: 'resume_current_scope',
              summary: 'Continue the derived plan; scope 2 is narrowed.',
              rationale: 'The operator directed scope 2 of the top-level plan to shrink.',
              blocker: '',
              replacementPlan: '',
              laterScopeNumber: 2,
              laterScopeBody: REVISED_SCOPE_2,
            } as TStructured,
          };
        },
      };
    },
  });

  let nextState: OrchestrationState;
  try {
    nextState = await runInteractiveBlockedRecoveryPhase(derivedState, statePath, logger);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }

  assert.ok(prompt.includes(`Continue blocked recovery for the current neal scope in ${derivedPlanPath}.`));
  assert.ok(prompt.includes(`one later scope of the top-level plan at ${state.planDoc}.`));
  assert.ok(prompt.includes('The current top-level scope is 1; eligible target scopes are 2 through 3.'));
  assert.equal(
    await readFile(state.planDoc, 'utf8'),
    expectedRevisedPlan(TOP_LEVEL_PLAN, '### Scope 2:', REVISED_SCOPE_2, '### Scope 3:'),
  );
  assert.equal(await readFile(derivedPlanPath, 'utf8'), derivedPlanText);
  assert.equal(nextState.phase, 'coder_response');
  assert.equal(nextState.derivedPlanPath, derivedPlanPath);
  assert.equal(nextState.derivedScopeIndex, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.laterScopeNumber, 2);
});

test('a consultant-injected turn is never offered or allowed a later-scope revision, while the following operator turn is', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ currentScopeNumber: 1, executionShape: 'multi_scope' });
  await writeFile(state.planDoc, TOP_LEVEL_PLAN, 'utf8');
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  let consultantTurnState: OrchestrationState;
  try {
    consultantTurnState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
  assert.equal(advisor.callCount(), 1);
  assert.equal(consultantTurnState.interactiveBlockedRecovery?.turns.length, 0);
  assert.equal(consultantTurnState.interactiveBlockedRecovery?.pendingDirective?.terminalOnly, false);
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(consultantTurnState), true);

  const prompts: string[] = [];
  const responses: Array<Record<string, unknown>> = [
    {
      action: 'resume_current_scope',
      summary: 'Apply the directive and narrow scope 3.',
      rationale: 'The consultant directive is in scope; scope 3 was narrowed too.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 3,
      laterScopeBody: REVISED_SCOPE_3,
    },
    {
      action: 'stay_blocked',
      summary: 'The directive alone is not enough.',
      rationale: 'An operator decision is still needed.',
      blocker: 'Need an operator decision on scope 3.',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    {
      action: 'resume_current_scope',
      summary: 'Continue; scope 3 is narrowed per the operator.',
      rationale: 'The operator directed scope 3 to cover only the parser half.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 3,
      laterScopeBody: REVISED_SCOPE_3,
    },
  ];
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('text coder prompt is not used in blocked recovery');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          prompts.push(args.prompt);
          const structured = responses.shift();
          assert.ok(structured, 'unexpected extra coder round');
          return { sessionHandle: `coder-session-${prompts.length}`, structured: structured as TStructured };
        },
      };
    },
  });

  try {
    // The consultant-injected turn: the offer is absent and a revision is rejected.
    await assert.rejects(
      () => runInteractiveBlockedRecoveryPhase(consultantTurnState, statePath, logger),
      /A later-scope revision is not available for this round/,
    );
    assert.ok(!prompts[0]?.includes('To revise a later scope'));
    assert.equal(await readFile(state.planDoc, 'utf8'), TOP_LEVEL_PLAN);

    // A direct apply on the consultant turn is refused as well, before any write.
    await assert.rejects(
      () =>
        applyInteractiveBlockedRecoveryDisposition(
          consultantTurnState,
          statePath,
          {
            action: 'resume_current_scope',
            summary: 'Continue.',
            rationale: 'Narrow scope 3.',
            blocker: '',
            replacementPlan: '',
            laterScopeNumber: 3,
            laterScopeBody: REVISED_SCOPE_3,
          },
          'coder-session-x',
          logger,
        ),
      /only operator guidance may direct a later-scope revision/,
    );
    assert.equal(await readFile(state.planDoc, 'utf8'), TOP_LEVEL_PLAN);

    // The coder consumes the consultant turn without a revision and stays blocked.
    const stayBlockedState = await runInteractiveBlockedRecoveryPhase(consultantTurnState, statePath, logger);
    assert.equal(stayBlockedState.phase, 'interactive_blocked_recovery');
    assert.equal(stayBlockedState.interactiveBlockedRecovery?.lastHandledTurn, 1);

    // An actual operator message on the next turn is offered the revision and it lands.
    const operatorTurnState = await recordInteractiveBlockedRecoveryGuidance(
      statePath,
      'Keep going here; narrow scope 3 to the parser half.',
      logger,
    );
    const resumedState = await runInteractiveBlockedRecoveryPhase(operatorTurnState, statePath, logger);
    assert.ok(prompts[2]?.includes('To revise a later scope'));
    assert.equal(
      await readFile(state.planDoc, 'utf8'),
      expectedRevisedPlan(TOP_LEVEL_PLAN, '### Scope 3:', REVISED_SCOPE_3, '## Boundaries'),
    );
    assert.equal(resumedState.phase, 'coder_response');
    assert.equal(resumedState.interactiveBlockedRecoveryHistory[0]?.turns[1]?.disposition?.laterScopeNumber, 3);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('a pre-existing consultant turn persisted as a turns[] entry is never offered or allowed a revision, while an operator turn with equal timestamps is', async () => {
  const fakeCoder = (structured: Record<string, unknown>, prompts: string[]) => ({
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('text coder prompt is not used in blocked recovery');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          prompts.push(args.prompt);
          return { sessionHandle: 'coder-session-legacy', structured: structured as TStructured };
        },
      };
    },
  });
  const revision = {
    action: 'resume_current_scope' as const,
    summary: 'Continue; scope 3 narrowed.',
    rationale: 'Narrow scope 3.',
    blocker: '',
    replacementPlan: '',
    laterScopeNumber: 3,
    laterScopeBody: REVISED_SCOPE_3,
  };

  // A consultant directive recorded as an ordinary turn by an older version:
  // the only trace is the anti-thrash record for this block with no advice.
  // Timestamps are deliberately unequal and out of order.
  const legacyBase = await createLaterScopeRevisionFixture(TOP_LEVEL_PLAN, {
    interactiveBlockedRecovery: {
      enteredAt: '2026-08-01T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: REVIEW_STUCK_REASON,
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2025-01-01T00:00:00.000Z',
          operatorGuidance: recoverableConsultantVerdict().resolutionDirective,
          disposition: null,
        },
      ],
    },
    consultantAttemptCount: 1,
  });
  const legacyCandidate = buildRecentBlockCandidate(legacyBase.state, REVIEW_STUCK_REASON, 'reviewer_scope');
  const legacy = {
    ...legacyBase,
    state: await saveState(legacyBase.statePath, {
      ...legacyBase.state,
      recentBlocks: [{ ...legacyCandidate, count: 1, recordedAt: '2024-01-01T00:00:00.000Z' }],
    }),
  };
  const legacyPrompts: string[] = [];
  setProviderCapabilitiesOverrideForTesting('openai-codex', fakeCoder(revision, legacyPrompts));
  try {
    await assert.rejects(
      () => runInteractiveBlockedRecoveryPhase(legacy.state, legacy.statePath, legacy.logger),
      /A later-scope revision is not available for this round/,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
  assert.ok(!legacyPrompts[0]?.includes('To revise a later scope'));
  await assert.rejects(
    () => applyInteractiveBlockedRecoveryDisposition(legacy.state, legacy.statePath, revision, 'coder-session-x', legacy.logger),
    /only operator guidance may direct a later-scope revision/,
  );
  assert.equal(await readFile(legacy.state.planDoc, 'utf8'), TOP_LEVEL_PLAN);

  // A genuine operator turn on the same kind of block, recorded with the exact
  // same timestamp as enteredAt: eligible, because no consultant record exists.
  const operator = await createLaterScopeRevisionFixture(TOP_LEVEL_PLAN, {
    interactiveBlockedRecovery: {
      enteredAt: '2026-08-01T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: REVIEW_STUCK_REASON,
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-08-01T00:00:00.000Z',
          operatorGuidance: 'Keep going here; narrow scope 3 to the parser half.',
          disposition: null,
        },
      ],
    },
  });
  const operatorPrompts: string[] = [];
  setProviderCapabilitiesOverrideForTesting('openai-codex', fakeCoder(revision, operatorPrompts));
  let resumedState: OrchestrationState;
  try {
    resumedState = await runInteractiveBlockedRecoveryPhase(operator.state, operator.statePath, operator.logger);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
  assert.ok(operatorPrompts[0]?.includes('To revise a later scope'));
  assert.equal(
    await readFile(operator.state.planDoc, 'utf8'),
    expectedRevisedPlan(TOP_LEVEL_PLAN, '### Scope 3:', REVISED_SCOPE_3, '## Boundaries'),
  );
  assert.equal(resumedState.phase, 'coder_response');
  assert.equal(resumedState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.laterScopeNumber, 3);
});

test('an operator message in a second same-scope recovery after the consultant budget is exhausted is offered and applies a revision', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ currentScopeNumber: 1, executionShape: 'multi_scope' });
  await writeFile(state.planDoc, TOP_LEVEL_PLAN, 'utf8');
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  // First block: the consultant (default budget of 1) applies its directive.
  let firstRecovery: OrchestrationState;
  try {
    firstRecovery = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
  assert.equal(advisor.callCount(), 1);
  assert.equal(firstRecovery.interactiveBlockedRecovery?.pendingDirective?.terminalOnly, false);

  const prompts: string[] = [];
  const responses: Array<Record<string, unknown>> = [
    {
      action: 'resume_current_scope',
      summary: 'Applied the directive.',
      rationale: 'The directive was in scope.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 0,
      laterScopeBody: '',
    },
    {
      action: 'resume_current_scope',
      summary: 'Continue; scope 3 is narrowed per the operator.',
      rationale: 'The operator directed scope 3 to cover only the parser half.',
      blocker: '',
      replacementPlan: '',
      laterScopeNumber: 3,
      laterScopeBody: REVISED_SCOPE_3,
    },
  ];
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('text coder prompt is not used in blocked recovery');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          prompts.push(args.prompt);
          const structured = responses.shift();
          assert.ok(structured, 'unexpected extra coder round');
          return { sessionHandle: `coder-session-${prompts.length}`, structured: structured as TStructured };
        },
      };
    },
  });

  try {
    const resumedOnce = await runInteractiveBlockedRecoveryPhase(firstRecovery, statePath, logger);
    assert.equal(resumedOnce.phase, 'coder_response');
    assert.equal(resumedOnce.interactiveBlockedRecoveryHistory.length, 1);
    assert.equal(resumedOnce.recentBlocks.length, 1);
    assert.equal(resumedOnce.consultantAttemptCount, 1);

    // Second block in the same scope with the same normalized blocker: the
    // budget is exhausted, so the run yields plainly for the operator.
    const secondBlock = await enterInteractiveBlockedRecovery(
      { ...resumedOnce, phase: 'reviewer_scope', blockedFromPhase: 'reviewer_scope', interactiveBlockedRecovery: null },
      statePath,
      REVIEW_STUCK_REASON,
      logger,
    );
    assert.equal(advisor.callCount(), 1, 'the exhausted budget does not re-invoke the consultant');
    assert.equal(secondBlock.interactiveBlockedRecovery?.turns.length, 0);
    assert.equal(secondBlock.interactiveBlockedRecovery?.pendingDirective, null);
    assert.equal(secondBlock.interactiveBlockedRecovery?.consultantAdvice, undefined);
    assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(secondBlock), true);

    const operatorTurn = await recordInteractiveBlockedRecoveryGuidance(
      statePath,
      'Keep going here; narrow scope 3 to the parser half.',
      logger,
    );
    const resumedTwice = await runInteractiveBlockedRecoveryPhase(operatorTurn, statePath, logger);
    assert.ok(prompts[1]?.includes('To revise a later scope'));
    assert.equal(
      await readFile(state.planDoc, 'utf8'),
      expectedRevisedPlan(TOP_LEVEL_PLAN, '### Scope 3:', REVISED_SCOPE_3, '## Boundaries'),
    );
    assert.equal(resumedTwice.phase, 'coder_response');
    assert.equal(resumedTwice.interactiveBlockedRecoveryHistory[1]?.turns[0]?.disposition?.laterScopeNumber, 3);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
