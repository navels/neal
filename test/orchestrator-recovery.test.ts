import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadOrInitialize, runOnePass } from '../src/neal/orchestrator.js';
import { createRunLogger } from '../src/neal/logger.js';
import { recordRecoveryGuidanceForResolvedRun } from '../src/neal/commands/recovery-guidance.js';
import { clearProviderCapabilitiesOverridesForTesting, clearProviderDefinitionRegistrationsForTesting, registerProviderDefinitionForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { type CoderRunPromptArgs, type CoderStructuredPromptArgs, type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { normalizeCliStderr } from './helpers/cli.js';
import { finalizeBlockedPlanReviewResponse, runCoderPlanPhase } from '../src/neal/orchestrator/phases/planning.js';
import { getExecuteRunResultExitCode } from '../src/neal/commands/writer-exit-codes.js';
import { runReviewPhase } from '../src/neal/orchestrator/phases/review.js';
import { applyInteractiveBlockedRecoveryDisposition, enterInteractiveBlockedRecovery, hasPendingInteractiveBlockedRecoveryTurn, recordInteractiveBlockedRecoveryGuidance, shouldNotifyInteractiveBlockedRecoveryEntry, UNATTENDED_MAX_AUTO_RESUMES } from '../src/neal/orchestrator/phases/recovery.js';
import { UNATTENDED_AUTO_RESUME_GUIDANCE } from '../src/neal/blocked-guidance.js';
import { getDefaultAgentConfig, loadState } from '../src/neal/state.js';
import { getPlanReviewGuidanceView, getPublicLifecycleView } from '../src/neal/state-views.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { createResumeFixture, runGit, runNealCliResultInCwd, createExecuteFinalizationFixture, readEventTypes, readEvents, REVIEW_STUCK_REASON, recoverableConsultantVerdict, nonRecoverableConsultantVerdict, installConsultantAdvisorOverride, createConsultantRecoveryFixture, writeConsultantKnobConfig, createUnattendedPendingRecoveryFixture } from './helpers/orchestrator-harness.js';

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

test('unattended enterInteractiveBlockedRecovery auto-resumes with synthesized guidance under the cap', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    unattended: true,
    unattendedAutoResumeCount: 0,
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

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.unattendedAutoResumeCount, 1);
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 1);
  assert.equal(
    nextState.interactiveBlockedRecovery?.turns[0]?.operatorGuidance,
    UNATTENDED_AUTO_RESUME_GUIDANCE,
  );
  // The synthesized turn makes the run loop proceed into recovery (no waiting halt).
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);

  const reloaded = await loadState(statePath);
  assert.equal(reloaded.unattendedAutoResumeCount, 1);
  assert.equal(reloaded.interactiveBlockedRecovery?.turns[0]?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);

  const eventTypes = await readEventTypes(state.runDir);
  assert.ok(eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
  assert.ok(!eventTypes.includes('unattended.block_unresolved'));
});

test('unattended enterInteractiveBlockedRecovery terminal-fails past the auto-resume cap', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    unattended: true,
    unattendedAutoResumeCount: UNATTENDED_MAX_AUTO_RESUMES,
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const failedState = await enterInteractiveBlockedRecovery(
    state,
    statePath,
    'Reviewer still needs an operator decision.',
    logger,
  );

  assert.equal(failedState.status, 'failed');
  assert.equal(failedState.blockedFromPhase, 'reviewer_scope');
  // No synthesized guidance turn, no waiting halt.
  assert.equal(failedState.interactiveBlockedRecovery, null);
  assert.equal(failedState.unattendedAutoResumeCount, UNATTENDED_MAX_AUTO_RESUMES);

  const reloaded = await loadState(statePath);
  assert.equal(reloaded.status, 'failed');

  const events = await readEvents(state.runDir);
  const eventTypes = events.map((event) => event.type as string);
  const classified = events.find((event) => event.type === 'unattended.block_unresolved');
  assert.ok(classified, 'expected a classified unattended.block_unresolved event');
  const classifiedData = classified?.data as Record<string, unknown> | undefined;
  assert.equal(classifiedData?.reason, 'unattended_block_unresolved');
  assert.equal(classifiedData?.site, 'interactive_blocked_recovery');
  assert.equal(classifiedData?.blockedFromPhase, 'reviewer_scope');
  // Mirrors the failed-run path: no attended block notification is emitted.
  assert.ok(!eventTypes.includes('notify.blocked'));
});

test('unattended enterInteractiveBlockedRecovery terminal-fails at the maxTurns boundary', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    unattended: true,
    unattendedAutoResumeCount: 0,
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Prior recovery turns already consumed.',
      maxTurns: 1,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: UNATTENDED_AUTO_RESUME_GUIDANCE,
          disposition: null,
        },
      ],
    },
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const failedState = await enterInteractiveBlockedRecovery(
    state,
    statePath,
    'Blocked again with the recovery turn cap already reached.',
    logger,
  );

  assert.equal(failedState.status, 'failed');
  // The active recovery record is finalized into history, not left active: the
  // failed run must not be persisted as a waiting interactive recovery.
  assert.equal(failedState.interactiveBlockedRecovery, null);
  assert.notEqual(failedState.phase, 'interactive_blocked_recovery');
  assert.equal(failedState.phase, 'blocked');
  assert.equal(failedState.blockedFromPhase, 'reviewer_scope');
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(failedState), false);
  assert.equal(failedState.interactiveBlockedRecoveryHistory.length, 1);
  const lifecycle = getPublicLifecycleView(failedState);
  assert.equal(lifecycle.waitingForOperatorGuidance, false);
  assert.equal(lifecycle.pendingOperatorGuidance, false);
  assert.equal(lifecycle.lifecycle, 'failed');

  const events = await readEvents(state.runDir);
  const classified = events.find((event) => event.type === 'unattended.block_unresolved');
  assert.ok(classified, 'expected a classified unattended.block_unresolved event at the maxTurns boundary');
  assert.equal((classified?.data as Record<string, unknown> | undefined)?.site, 'interactive_blocked_recovery');

  // Resume reload sees a terminal failed run with no pending operator guidance.
  const reloaded = await loadState(statePath);
  assert.equal(reloaded.status, 'failed');
  assert.equal(reloaded.interactiveBlockedRecovery, null);
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(reloaded), false);
  assert.equal(getPublicLifecycleView(reloaded).waitingForOperatorGuidance, false);
});

test('unattended derived-plan-review block routes through the site-A auto-resume', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_plan',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    topLevelMode: 'execute',
    unattended: true,
    unattendedAutoResumeCount: 0,
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
  assert.equal(nextState.unattendedAutoResumeCount, 1);
  assert.equal(nextState.interactiveBlockedRecovery?.turns[0]?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);
});

test('attended enterInteractiveBlockedRecovery still waits for operator guidance', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    unattended: false,
    unattendedAutoResumeCount: 0,
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

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  // No synthesized guidance: the run halts waiting for `neal resume --message`.
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
  assert.equal(nextState.unattendedAutoResumeCount, 0);
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), false);

  const eventTypes = await readEventTypes(state.runDir);
  assert.ok(!eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
  assert.ok(!eventTypes.includes('unattended.block_unresolved'));
});

test('unattended review_stuck recoverable verdict resolves autonomously with an in-scope directive', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  const headBefore = await runGit(cwd, 'rev-parse', 'HEAD');

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 1, 'the consultant must be invoked exactly once');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    // The injected directive — NOT the generic auto-resume guidance — is the pending turn.
    assert.equal(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      recoverableConsultantVerdict().resolutionDirective,
    );
    assert.notEqual(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      UNATTENDED_AUTO_RESUME_GUIDANCE,
    );
    assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);
    // The consultant counter advances; the generic auto-resume budget is untouched.
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.unattendedAutoResumeCount, 0);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('consultant.start'));
    assert.ok(eventTypes.includes('consultant.verdict'));
    assert.ok(eventTypes.includes('consultant.resolved'));
    // The consultant path does not take the generic unattended auto-resume branch.
    assert.ok(!eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));

    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), headBefore, 'consultant turn must make no commits');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unattended review_stuck non-recoverable verdict terminally short-circuits instead of auto-resuming', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ payload: nonRecoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  const headBefore = await runGit(cwd, 'rev-parse', 'HEAD');

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 1, 'the consultant is consulted for an eligible block');
    // Genuine wall under unattended: terminal short-circuit, not a generic auto-resume.
    assert.equal(nextState.status, 'failed');
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.interactiveBlockedRecovery, null);
    assert.equal(nextState.unattendedAutoResumeCount, 0, 'the generic auto-resume budget is untouched');
    // The consultant ran, so the shared per-scope budget is consumed and the
    // anti-thrash window records this block.
    assert.equal(nextState.consultantAttemptCount, 1, 'an consultant-driven terminal short-circuit consumes the budget');
    assert.equal(nextState.recentBlocks.length, 1, 'the adjudicated block is recorded');
    assert.equal(nextState.recentBlocks[0]?.count, 1);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('consultant.declined'));
    assert.ok(eventTypes.includes('unattended.block_unresolved'));
    assert.ok(!eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));

    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), headBefore);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unattended review_stuck consultant error falls through without crashing the run', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({});
  const advisor = installConsultantAdvisorOverride({ throwError: new Error('consultant provider exploded') });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  const headBefore = await runGit(cwd, 'rev-parse', 'HEAD');

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 1);
    // An consultant throw must be swallowed and fall through to the generic path.
    assert.equal(nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);
    assert.equal(nextState.consultantAttemptCount, 0);
    assert.equal(nextState.unattendedAutoResumeCount, 1);

    const events = await readEvents(state.runDir);
    const declined = events.find((event) => event.type === 'consultant.declined');
    assert.ok(declined, 'an consultant throw must emit consultant.declined');
    assert.ok((declined?.data as Record<string, unknown> | undefined)?.error, 'declined event must carry an error field');

    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), headBefore);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unattended review_stuck at the consultant cap is not invoked and takes the generic path', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ consultantAttemptCount: 1 });
  const advisor = installConsultantAdvisorOverride({ payload: recoverableConsultantVerdict() });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  const headBefore = await runGit(cwd, 'rev-parse', 'HEAD');

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 0, 'past the cap the consultant must not be invoked');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.unattendedAutoResumeCount, 1);

    const eventTypes = await readEventTypes(state.runDir);
    // An exhausted budget restores today's generic path byte-for-byte: zero
    // consultant events of any kind.
    assert.ok(
      !eventTypes.some((type) => type.startsWith('consultant.')),
      'an exhausted budget must emit no consultant events',
    );
    assert.ok(eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));

    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), headBefore);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('attended recoverable block auto-applies the consultant directive without yielding', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ unattended: false });
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

    // Attended runs now apply a recoverable verdict just like unattended runs: the
    // directive is injected and consumed, so the run continues rather than yielding.
    assert.equal(advisor.callCount(), 1, 'attended mode triages the eligible block once');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
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

test('attended non-recoverable block records read-only consultant advice and yields', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ unattended: false });
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

    // A genuine wall still yields for the operator, carrying the verdict as advice.
    assert.equal(advisor.callCount(), 1, 'attended mode triages the eligible block once');
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0, 'a genuine wall still waits for guidance');
    assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), true);

    const advice = nextState.interactiveBlockedRecovery?.consultantAdvice;
    assert.ok(advice, 'attended advice must be persisted on the recovery state');
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

test('attended eligible block swallows an consultant error and yields plainly with no events or advice', async () => {
  // The attended consultant error fallback must be indistinguishable from the
  // disabled/exhausted generic yield: the run yields waiting for the operator with
  // no advice, no budget/recentBlocks mutation, and no consultant.* events.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ unattended: false });
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
    // The error is swallowed and the run yields exactly as today's plain attended block.
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0, 'attended run still waits for guidance');
    assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null, 'no advice on the error path');
    assert.equal(nextState.consultantAttemptCount, 0, 'budget unchanged on the error path');
    assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged on the error path');

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(
      !eventTypes.some((type) => type.startsWith('consultant.')),
      'the attended error fallback must emit no consultant events',
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('attended eligible block with the disable knob (0) yields plainly with no advice', async () => {
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({ unattended: false });
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

test('attended eligible block at an exhausted budget yields plainly with no advice', async () => {
  // Knob default is 1; seed consultantAttemptCount at the cap so the budget is
  // exhausted for this scope.
  const { cwd, statePath, state } = await createConsultantRecoveryFixture({
    unattended: false,
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
      'an exhausted budget must emit no consultant events in attended mode either',
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
      // Today's generic unattended auto-resume path is preserved exactly.
      assert.equal(nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);
      assert.equal(nextState.consultantAttemptCount, 0);
      assert.equal(nextState.unattendedAutoResumeCount, 1);
      assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged for an ineligible phase');

      const eventTypes = await readEventTypes(state.runDir);
      assert.ok(
        !eventTypes.some((type) => type.startsWith('consultant.')),
        `no consultant events for ineligible phase ${sourcePhase}`,
      );
      assert.ok(eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  }
});

test('unattended reviewer block without the review_stuck prefix keeps the generic path', async () => {
  // Reviewer phases are adjudicated ONLY for a genuine structural review_stuck
  // deadlock. An ordinary blocking-finding block that reaches recovery via a
  // reviewer phase (no `review_stuck:` prefix) is normal review back-and-forth and
  // must keep today's generic recovery behavior with zero consultant calls.
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
    assert.equal(nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);
    assert.equal(nextState.consultantAttemptCount, 0);
    assert.equal(nextState.unattendedAutoResumeCount, 1);
    assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged for a non-adjudicated reviewer block');

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')));
    assert.ok(eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unattended eligible coder block is triaged by the generalized dispatch regardless of reason prefix', async () => {
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
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
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

test('unattended disabled/exhausted budget leaves recentBlocks unchanged on the generic path', async () => {
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
      assert.equal(nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance, UNATTENDED_AUTO_RESUME_GUIDANCE);
      assert.deepEqual(nextState.recentBlocks, recentBefore, 'recentBlocks unchanged on the unattended fallback');
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
    // record count increments to 2 and the run terminates.
    const secondEntryState: OrchestrationState = {
      ...reloaded,
      phase: 'coder_scope',
      blockedFromPhase: 'coder_scope',
      status: 'running',
      interactiveBlockedRecovery: null,
    };
    const secondState = await enterInteractiveBlockedRecovery(secondEntryState, statePath, reason, logger);
    assert.equal(advisor.callCount(), 1, 'the anti-thrash repeat does not re-invoke the advisor');
    assert.equal(secondState.status, 'failed');
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

test('unattended review_stuck recoverable path emits the audit-grade event sequence in order', async () => {
  // Scope 4: the autonomous decision must be fully reconstructable from the
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

test('unattended stay_blocked under the bounds synthesizes another auto-resume turn', async () => {
  const { statePath, state } = await createUnattendedPendingRecoveryFixture(1);
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'More operator input would help.',
      rationale: 'The path is still ambiguous.',
      blocker: 'Need a concrete decision.',
      replacementPlan: '',
    },
    'coder-session-2',
    logger,
  );

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.unattendedAutoResumeCount, 2);
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 2);
  assert.equal(
    nextState.interactiveBlockedRecovery?.turns[1]?.operatorGuidance,
    UNATTENDED_AUTO_RESUME_GUIDANCE,
  );
  // The synthesized turn keeps the run moving (pending guidance), not waiting.
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);
  assert.equal(getPublicLifecycleView(nextState).waitingForOperatorGuidance, false);
});

test('unattended stay_blocked at the auto-resume cap runs the shared terminal-fail action', async () => {
  const { statePath, state } = await createUnattendedPendingRecoveryFixture(UNATTENDED_MAX_AUTO_RESUMES);
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const failedState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'Still stuck.',
      rationale: 'No further progress without a decision.',
      blocker: 'Need a concrete decision.',
      replacementPlan: '',
    },
    'coder-session-2',
    logger,
  );

  assert.equal(failedState.status, 'failed');
  // Recovery finalized so the lifecycle view is no longer waiting/blocked.
  assert.equal(failedState.interactiveBlockedRecovery, null);
  assert.notEqual(failedState.phase, 'interactive_blocked_recovery');
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(failedState), false);
  const lifecycle = getPublicLifecycleView(failedState);
  assert.equal(lifecycle.waitingForOperatorGuidance, false);
  assert.equal(lifecycle.pendingOperatorGuidance, false);
  assert.equal(failedState.interactiveBlockedRecoveryHistory.at(-1)?.resolvedByAction, 'stay_blocked');

  const events = await readEvents(state.runDir);
  const classified = events.find((event) => event.type === 'unattended.block_unresolved');
  assert.ok(classified, 'expected a classified unattended.block_unresolved event');
  assert.equal((classified?.data as Record<string, unknown> | undefined)?.reason, 'unattended_block_unresolved');
});

test('unattended terminal_block runs the shared terminal-fail action without the attended blocked path', async () => {
  const { statePath, state } = await createUnattendedPendingRecoveryFixture(0);
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const failedState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'terminal_block',
      summary: 'No safe in-repo path remains.',
      rationale: 'The blocker cannot be resolved here.',
      blocker: 'External authorization is required.',
      replacementPlan: '',
    },
    'coder-session-2',
    logger,
  );

  assert.equal(failedState.status, 'failed');
  assert.notEqual(failedState.status, 'blocked');
  assert.equal(failedState.interactiveBlockedRecovery, null);
  assert.notEqual(failedState.phase, 'interactive_blocked_recovery');
  assert.equal(hasPendingInteractiveBlockedRecoveryTurn(failedState), false);
  const lifecycle = getPublicLifecycleView(failedState);
  assert.equal(lifecycle.waitingForOperatorGuidance, false);
  assert.equal(lifecycle.pendingOperatorGuidance, false);
  assert.equal(failedState.interactiveBlockedRecoveryHistory.at(-1)?.resolvedByAction, 'terminal_block');

  const events = await readEvents(state.runDir);
  const eventTypes = events.map((event) => event.type as string);
  assert.ok(eventTypes.includes('unattended.block_unresolved'));
  // The attended blocked notification path is not taken.
  assert.ok(!eventTypes.includes('notify.blocked'));
});

test('unattended site-A terminal-fail run-loop writes a failed retrospective and does not notify blocked', async () => {
  const providerId = 'fake-unattended-terminal-block-coder';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderSessionHandle: 'coder-unattended-terminal',
      coderStructuredResponses: [
        {
          action: 'terminal_block',
          summary: 'No safe in-repo path remains.',
          rationale: 'The blocker cannot be resolved without an operator.',
          blocker: 'External authorization is required before this scope can continue.',
          replacementPlan: '',
        },
      ],
    }),
  );

  try {
    const { cwd, statePath, state } = await createResumeFixture({
      currentScopeNumber: 2,
      phase: 'interactive_blocked_recovery',
      status: 'running',
      blockedFromPhase: 'reviewer_scope',
      coderSessionHandle: 'coder-unattended-terminal',
      unattended: true,
      unattendedAutoResumeCount: 0,
      agentConfig: {
        ...getDefaultAgentConfig(),
        coder: { provider: providerId, model: null },
      },
      interactiveBlockedRecovery: {
        enteredAt: '2026-04-16T00:00:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Reviewer needs an operator decision.',
        maxTurns: 3,
        lastHandledTurn: 0,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-16T00:01:00.000Z',
            operatorGuidance: UNATTENDED_AUTO_RESUME_GUIDANCE,
            disposition: null,
          },
        ],
      },
    });
    const logger = await createRunLogger({
      cwd,
      stateDir: dirname(statePath),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    const finalState = await runOnePass(state, statePath, logger);

    assert.equal(finalState.status, 'failed');
    assert.equal(finalState.phase, 'blocked');
    assert.equal(finalState.interactiveBlockedRecovery, null);

    // The run-loop's terminal retrospective must report the failed status rather
    // than overwrite it as a blocked retrospective.
    const currentRetrospective = await readFile(join(state.runDir, 'RETROSPECTIVE.md'), 'utf8');
    assert.match(currentRetrospective, /Status: failed/);
    assert.doesNotMatch(currentRetrospective, /Status: blocked/);

    const archivedFailed = await readFile(
      join(state.runDir, 'RETROSPECTIVE-failed-scope-2.md'),
      'utf8',
    );
    assert.match(archivedFailed, /Status: failed/);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('unattended.block_unresolved'));
    assert.ok(!eventTypes.includes('notify.blocked'));
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('unattended reviewer-scope block at the auto-resume cap fails without attended notifications', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 1,
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    unattended: true,
    unattendedAutoResumeCount: UNATTENDED_MAX_AUTO_RESUMES,
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
            sessionHandle: 'reviewer-unattended-block',
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
    // Normal caller path (review.ts): under unattended at the auto-resume cap the
    // reviewer block terminal-fails inside enterInteractiveBlockedRecovery, and the
    // caller must not emit any attended blocked / interactive-recovery notification.
    const finalState = await runReviewPhase(reviewState, statePath, logger);

    assert.equal(finalState.status, 'failed');
    assert.notEqual(finalState.phase, 'interactive_blocked_recovery');
    assert.equal(finalState.interactiveBlockedRecovery, null);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('unattended.block_unresolved'));
    assert.ok(!eventTypes.includes('notify.blocked'));
    assert.ok(!eventTypes.includes('notify.interactive_blocked_recovery'));
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

test('unattended top-level plan-review block runs the shared terminal-fail action (site C)', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    interactiveBlockedRecovery: null,
    unattended: true,
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const failedState = await finalizeBlockedPlanReviewResponse(
    state,
    statePath,
    false,
    'Plan review did not converge under the round cap.',
    'reviewer_convergence',
    logger,
  );

  // No operator wait, no pendingPlanReviewGuidance resume mechanism: clean fail.
  assert.equal(failedState.status, 'failed');
  assert.equal(failedState.phase, 'blocked');
  assert.equal(failedState.blockedFromPhase, 'reviewer_plan');
  assert.equal(failedState.pendingPlanReviewGuidance, null);
  // A failed state must carry no recoverable blocker reason (invariant).
  assert.equal(failedState.blockerReason, null);
  assert.equal(failedState.interactiveBlockedRecovery, null);
  // The reviewer-convergence cap terminal-fails (writer exit 3), unchanged.
  assert.equal(
    getExecuteRunResultExitCode({
      finalState: failedState,
      waitingForOperatorGuidance: false,
      waitingForManualGate: false,
      stopRequestedAfterScope: false,
    }),
    3,
  );

  const reloaded = await loadState(statePath);
  assert.equal(reloaded.status, 'failed');
  assert.equal(reloaded.pendingPlanReviewGuidance, null);
  // The top-level plan stage never waits for pendingPlanReviewGuidance resume.
  assert.equal(getPlanReviewGuidanceView(reloaded).waitingForOperatorGuidance, false);

  const events = await readEvents(state.runDir);
  const eventTypes = events.map((event) => event.type as string);
  const classified = events.find((event) => event.type === 'unattended.block_unresolved');
  assert.ok(classified, 'expected a classified unattended.block_unresolved event for site C');
  const classifiedData = classified?.data as Record<string, unknown> | undefined;
  assert.equal(classifiedData?.reason, 'unattended_block_unresolved');
  assert.equal(classifiedData?.site, 'reviewer_plan');
  assert.equal(classifiedData?.blockedFromPhase, 'reviewer_plan');
  // Mirrors the failed-run path: no attended block notification is emitted.
  assert.ok(!eventTypes.includes('notify.blocked'));
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
