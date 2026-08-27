import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createInitialState, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import {
  INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES,
  ORCHESTRATION_PHASES,
  ORCHESTRATION_STATUSES,
  RESUMABLE_BLOCKED_PHASES,
  assertOrchestrationPhase,
  assertOrchestrationStatus,
  isOrchestrationPhase,
  isOrchestrationStatus,
} from '../src/neal/state-invariants.js';
import type { OrchestrationState } from '../src/neal/types.js';

type RawState = Record<string, unknown>;

async function createStateFixture(): Promise<{ state: OrchestrationState; statePath: string; runDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-state-invariants-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'state-invariants-run');
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

  return { state, statePath: getRunStatePath(runDir), runDir };
}

async function writeRawState(path: string, state: RawState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function loadMutatedState(
  mutate: (state: RawState, context: { runDir: string }) => void,
): Promise<OrchestrationState> {
  const { state, statePath, runDir } = await createStateFixture();
  const rawState = JSON.parse(JSON.stringify(state)) as RawState;
  mutate(rawState, { runDir });
  await writeRawState(statePath, rawState);
  return loadState(statePath);
}

async function assertLoadRejects(
  mutate: (state: RawState, context: { runDir: string }) => void,
  expected: RegExp,
): Promise<void> {
  await assert.rejects(() => loadMutatedState(mutate), expected);
}

function getExpectedInteractiveResumePhase(sourcePhase: unknown): unknown {
  switch (sourcePhase) {
    case 'reviewer_scope':
      return 'coder_response';
    case 'reviewer_plan':
      return 'coder_plan_response';
    case 'awaiting_derived_plan_execution':
      return 'coder_scope';
    default:
      return sourcePhase;
  }
}

function makeInteractiveBlockedRecovery(
  sourcePhase: unknown = 'coder_scope',
  resultingPhase: unknown = getExpectedInteractiveResumePhase(sourcePhase),
): RawState {
  return {
    enteredAt: '2026-05-06T01:00:00.000Z',
    sourcePhase,
    blockedReason: 'Need operator guidance.',
    maxTurns: 3,
    lastHandledTurn: 1,
    pendingDirective: null,
    turns: [
      {
        number: 1,
        recordedAt: '2026-05-06T01:01:00.000Z',
        operatorGuidance: 'Continue narrowly.',
        origin: 'operator',
        disposition: {
          recordedAt: '2026-05-06T01:02:00.000Z',
          sessionHandle: 'coder-recovery-session',
          action: 'resume_current_scope',
          summary: 'Guidance was applied.',
          rationale: 'The requested path is clear.',
          blocker: '',
          replacementPlan: '',
          laterScopeNumber: 0,
          laterScopeBody: '',
          resultingPhase,
        },
      },
    ],
  };
}

function makeInteractiveBlockedRecoveryRecord(resultPhase: unknown = 'coder_response'): RawState {
  return {
    ...makeInteractiveBlockedRecovery('reviewer_scope'),
    resolvedAt: '2026-05-06T01:05:00.000Z',
    resolvedByAction: 'resume_current_scope',
    resultPhase,
  };
}

function makeManualGate(runDir: string): RawState {
  return {
    id: 'operator-approval',
    title: 'Operator approval',
    reason: 'A user must approve the external deploy.',
    instructionsPath: join(runDir, 'GATE-operator-approval.md'),
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
  };
}

test('runtime phase and status guards expose current memberships', () => {
  assert.ok(ORCHESTRATION_STATUSES.includes('failed'));

  assert.equal(isOrchestrationPhase('coder_scope'), true);
  assert.equal(isOrchestrationPhase('manual_gate'), true);
  assert.equal(isOrchestrationPhase('unknown_phase'), false);
  assert.doesNotThrow(() => assertOrchestrationPhase('reviewer_scope', 'test.phase'));
  assert.throws(() => assertOrchestrationPhase('unknown_phase', 'test.phase'), /test\.phase/);

  assert.equal(isOrchestrationStatus('running'), true);
  assert.equal(isOrchestrationStatus('paused'), true);
  assert.doesNotThrow(() => assertOrchestrationStatus('blocked', 'test.status'));
  assert.throws(() => assertOrchestrationStatus('unknown_status', 'test.status'), /test\.status/);
});

test('recovery phase sets mirror current orchestration contracts', () => {
  assert.deepEqual([...INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES], [
    'coder_plan',
    'reviewer_plan',
    'coder_plan_response',
    'coder_plan_optional_response',
    'awaiting_derived_plan_execution',
    'coder_scope',
    'reviewer_scope',
    'coder_response',
    'coder_optional_response',
    'execute_finalization',
    'final_completion_review',
  ]);
  assert.deepEqual([...RESUMABLE_BLOCKED_PHASES], [
    'coder_scope',
    'coder_response',
    'coder_optional_response',
    'coder_plan',
    'coder_plan_response',
    'coder_plan_optional_response',
  ]);
});

test('coder session protocol accepts valid active handle pairings', async () => {
  const loadedState = await loadMutatedState((state) => {
    state.coderSessionHandle = 'coder-session-1';
    state.coderSessionProtocol = 'structured_json_v1';
  });

  assert.equal(loadedState.coderSessionProtocol, 'structured_json_v1');
});

test('coder session protocol rejects unknown protocol strings', async () => {
  await assertLoadRejects((state) => {
    state.coderSessionHandle = 'coder-session-1';
    state.coderSessionProtocol = 'unknown_protocol';
  }, /coderSessionProtocol/);
});

test('coder session protocol rejects non-null protocol without active handle', async () => {
  await assertLoadRejects((state) => {
    state.coderSessionHandle = null;
    state.coderSessionProtocol = 'legacy_marker_v1';
  }, /coderSessionProtocol.*must be null when coderSessionHandle is null/);
});

test('planner session protocol accepts valid active handle pairings', async () => {
  const loadedState = await loadMutatedState((state) => {
    state.plannerSessionHandle = 'planner-session-1';
    state.plannerSessionProtocol = 'structured_json_v1';
  });

  assert.equal(loadedState.plannerSessionProtocol, 'structured_json_v1');
});

test('planner session protocol rejects unknown protocol strings', async () => {
  await assertLoadRejects((state) => {
    state.plannerSessionHandle = 'planner-session-1';
    state.plannerSessionProtocol = 'unknown_protocol';
  }, /plannerSessionProtocol/);
});

test('planner session protocol rejects non-null protocol without active handle', async () => {
  await assertLoadRejects((state) => {
    state.plannerSessionHandle = null;
    state.plannerSessionProtocol = 'legacy_marker_v1';
  }, /plannerSessionProtocol.*must be null when plannerSessionHandle is null/);
});

test('planner session protocol rejects active handle without protocol', async () => {
  await assertLoadRejects((state) => {
    state.plannerSessionHandle = 'planner-session-1';
    state.plannerSessionProtocol = null;
  }, /plannerSessionProtocol.*must not be null when plannerSessionHandle is present/);
});

test('pending plan-review guidance accepts valid plan-mode states', async () => {
  const blocked = await loadMutatedState((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'blocked';
    state.status = 'blocked';
    state.blockedFromPhase = 'reviewer_plan';
    state.pendingPlanReviewGuidance = {
      message: 'Try again with a smaller plan.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  });
  const running = await loadMutatedState((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_response';
    state.status = 'running';
    state.blockedFromPhase = null;
    state.pendingPlanReviewGuidance = {
      message: 'Try again with a smaller plan.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  });
  const coderResponseOrigin = await loadMutatedState((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_response';
    state.status = 'running';
    state.blockedFromPhase = null;
    state.pendingPlanReviewGuidance = {
      message: 'Answer the coder-authored plan-response block.',
      sourcePhase: 'coder_plan_response',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  });
  const optionalResponseOrigin = await loadMutatedState((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_optional_response';
    state.status = 'running';
    state.blockedFromPhase = null;
    state.pendingPlanReviewGuidance = {
      message: 'Answer the coder-authored optional-response block.',
      sourcePhase: 'coder_plan_optional_response',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  });

  assert.equal(blocked.pendingPlanReviewGuidance?.sourcePhase, 'reviewer_plan');
  assert.equal(running.pendingPlanReviewGuidance?.message, 'Try again with a smaller plan.');
  assert.equal(coderResponseOrigin.pendingPlanReviewGuidance?.sourcePhase, 'coder_plan_response');
  assert.equal(optionalResponseOrigin.pendingPlanReviewGuidance?.sourcePhase, 'coder_plan_optional_response');
});

test('pending plan-review guidance rejects invalid shapes and execute-mode state', async () => {
  await assertLoadRejects((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_response';
    state.pendingPlanReviewGuidance = {
      message: '   ',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  }, /pendingPlanReviewGuidance\.message: expected non-empty string/);

  await assertLoadRejects((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_response';
    state.pendingPlanReviewGuidance = {
      message: 'Try again.',
      sourcePhase: 'coder_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  }, /pendingPlanReviewGuidance\.sourcePhase/);

  await assertLoadRejects((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_response';
    state.pendingPlanReviewGuidance = {
      message: 'Try again.',
      sourcePhase: 'reviewer_plan',
      recordedAt: 123,
    };
  }, /pendingPlanReviewGuidance\.recordedAt: expected string/);

  await assertLoadRejects((state) => {
    state.pendingPlanReviewGuidance = {
      message: 'Try again.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  }, /pendingPlanReviewGuidance: expected null for "execute" mode/);

  await assertLoadRejects((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'coder_plan_optional_response';
    state.pendingPlanReviewGuidance = {
      message: 'Try again.',
      sourcePhase: 'coder_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    };
  }, /pendingPlanReviewGuidance\.sourcePhase/);
});

test('blockerReason is accepted while blocked and rejected once the run returns to running', async () => {
  const blocked = await loadMutatedState((state) => {
    state.topLevelMode = 'plan';
    state.phase = 'blocked';
    state.status = 'blocked';
    state.blockedFromPhase = 'coder_plan_response';
    state.blockerReason = 'The coder needs an operator decision on the plan.';
  });
  assert.equal(blocked.blockerReason, 'The coder needs an operator decision on the plan.');

  // Legacy-tolerant: a run state persisted before the field existed hydrates to null.
  const legacy = await loadMutatedState((state) => {
    delete state.blockerReason;
  });
  assert.equal(legacy.blockerReason, null);

  await assertLoadRejects((state) => {
    state.phase = 'coder_scope';
    state.status = 'running';
    state.blockedFromPhase = null;
    state.blockerReason = 'stale reason that outlived its block';
  }, /blockerReason: expected null when status is "running"/);
});

test('loadState rejects unknown top-level phase and status', async () => {
  await assertLoadRejects((state) => {
    state.topLevelMode = 'review';
  }, /invalid topLevelMode: expected one of "plan", "execute", received "review"/);

  await assertLoadRejects((state) => {
    state.phase = 'unknown_phase';
  }, /invalid phase: expected orchestration phase, received "unknown_phase"/);

  await assertLoadRejects((state) => {
    state.status = 'unknown_status';
  }, /invalid status: expected orchestration status, received "unknown_status"/);
});

test('loadState rejects unknown persisted phase references during hydration', async () => {
  await assertLoadRejects((state) => {
    state.blockedFromPhase = 'unknown_phase';
  }, /blockedFromPhase: expected orchestration phase, received "unknown_phase"/);

  await assertLoadRejects((state) => {
    state.interactiveBlockedRecovery = makeInteractiveBlockedRecovery('unknown_phase');
  }, /interactiveBlockedRecovery\.sourcePhase: expected orchestration phase, received "unknown_phase"/);

  await assertLoadRejects((state) => {
    state.interactiveBlockedRecovery = makeInteractiveBlockedRecovery('coder_scope', 'unknown_phase');
  }, /interactiveBlockedRecovery\.turns\[0\]\.disposition\.resultingPhase: expected orchestration phase, received "unknown_phase"/);

  await assertLoadRejects((state) => {
    state.interactiveBlockedRecoveryHistory = [makeInteractiveBlockedRecoveryRecord('unknown_phase')];
  }, /interactiveBlockedRecoveryHistory\[0\]\.resultPhase: expected orchestration phase, received "unknown_phase"/);
});

test('loadState rejects missing current nullable and phase-reference fields', async () => {
  await assertLoadRejects((state) => {
    delete state.blockedFromPhase;
  }, /invalid blockedFromPhase: missing required field/);

  await assertLoadRejects((state) => {
    const interactiveRecovery = makeInteractiveBlockedRecovery();
    delete interactiveRecovery.sourcePhase;
    state.phase = 'interactive_blocked_recovery';
    state.interactiveBlockedRecovery = interactiveRecovery;
  }, /invalid interactiveBlockedRecovery\.sourcePhase: missing required field/);

  await assertLoadRejects((state) => {
    const interactiveRecoveryRecord = makeInteractiveBlockedRecoveryRecord();
    delete interactiveRecoveryRecord.resultPhase;
    state.interactiveBlockedRecoveryHistory = [interactiveRecoveryRecord];
  }, /invalid interactiveBlockedRecoveryHistory\[0\]\.resultPhase: missing required field/);
});

test('loadState rejects impossible terminal phase and status pairings', async () => {
  await assertLoadRejects((state) => {
    state.phase = 'done';
    state.status = 'running';
  }, /during load.*invalid status: expected "done" when phase is "done"/);

  await assertLoadRejects((state) => {
    state.phase = 'coder_scope';
    state.status = 'done';
  }, /during load.*invalid phase: expected "done" when status is "done"/);

  await assertLoadRejects((state) => {
    state.phase = 'blocked';
    state.status = 'running';
  }, /during load.*invalid status: expected "blocked" or "failed" when phase is "blocked"/);

  await assertLoadRejects((state) => {
    state.phase = 'blocked';
    state.status = 'paused';
  }, /during load.*invalid status: expected "blocked" or "failed" when phase is "blocked"/);
});

test('loadState accepts valid manual gate state and rejects invalid phase/status pairings', async () => {
  const loadedState = await loadMutatedState((state, { runDir }) => {
    state.phase = 'manual_gate';
    state.status = 'running';
    state.blockedFromPhase = null;
    state.manualGate = makeManualGate(runDir);
  });

  assert.equal(loadedState.phase, 'manual_gate');
  assert.equal(loadedState.status, 'running');
  assert.equal(loadedState.manualGate?.resumePhase, 'coder_scope');

  await assertLoadRejects((state) => {
    state.phase = 'manual_gate';
  }, /during load.*invalid manualGate: expected active manual gate/);

  await assertLoadRejects((state, { runDir }) => {
    state.manualGate = makeManualGate(runDir);
  }, /during load.*invalid phase: expected "manual_gate" while manualGate is active/);

  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'manual_gate';
    state.status = 'blocked';
    state.manualGate = makeManualGate(runDir);
  }, /during load.*invalid status: expected "running" while manualGate is active/);

  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'manual_gate';
    state.blockedFromPhase = 'coder_scope';
    state.manualGate = makeManualGate(runDir);
  }, /during load.*invalid blockedFromPhase: expected null while manualGate is active/);
});

test('loadState rejects malformed manual gate fields', async () => {
  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'manual_gate';
    state.manualGate = {
      ...makeManualGate(runDir),
      title: '   ',
    };
  }, /during load.*invalid manualGate\.title: expected non-empty string/);

  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'manual_gate';
    state.manualGate = {
      ...makeManualGate(runDir),
      resumeChecks: [],
    };
  }, /during load.*invalid manualGate\.resumeChecks: expected at least one resume check/);

  await assertLoadRejects((state, { runDir }) => {
    const gate = makeManualGate(runDir);
    (gate.resumeChecks as RawState[])[0].command = [];
    state.phase = 'manual_gate';
    state.manualGate = gate;
  }, /during load.*invalid manualGate\.resumeChecks\[0\]\.command: expected non-empty string array/);

  await assertLoadRejects((state, { runDir }) => {
    const gate = makeManualGate(runDir);
    (gate.resumeChecks as RawState[])[0].timeoutMs = 0;
    state.phase = 'manual_gate';
    state.manualGate = gate;
  }, /during load.*invalid manualGate\.resumeChecks\[0\]\.timeoutMs: expected safe integer greater than or equal to 1/);

  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'manual_gate';
    state.manualGate = {
      ...makeManualGate(runDir),
      lastFailure: {
        checkName: 'approval file exists',
        exitCode: -1,
        signal: null,
        stdoutTail: '',
        stderrTail: 'missing file',
      },
    };
  }, /during load.*invalid manualGate\.lastFailure\.exitCode: expected safe integer greater than or equal to 0/);
});

test('loadState rejects invalid counters, duplicate completed scope labels, and terminal blockedFromPhase', async () => {
  await assertLoadRejects((state) => {
    state.coderRetryCount = -1;
  }, /during load.*invalid coderRetryCount: expected safe integer greater than or equal to 0/);

  await assertLoadRejects((state) => {
    state.consultantAttemptCount = -1;
  }, /during load.*invalid consultantAttemptCount: expected safe integer greater than or equal to 0/);

  await assertLoadRejects((state) => {
    state.maxRounds = 0;
  }, /during load.*invalid maxRounds: expected safe integer greater than or equal to 1/);

  await assertLoadRejects((state) => {
    state.completedScopes = [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: null,
        finalCommit: null,
        summary: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 0,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: null,
        finalCommit: null,
        summary: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 0,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ];
  }, /during load.*invalid completedScopes\[1\]\.number: duplicate completed scope label "1"/);

  await assertLoadRejects((state) => {
    state.blockedFromPhase = 'blocked';
  }, /during load.*invalid blockedFromPhase: must not reference terminal phase "blocked"/);
});

test('saveState rejects invalid state before writing requested or run-local state files', async () => {
  const { state, runDir } = await createStateFixture();
  const runStatePath = getRunStatePath(runDir);
  const invalidState = {
    ...state,
    phase: 'done',
    status: 'running',
  } as OrchestrationState;

  await assert.rejects(
    () => saveState(runStatePath, invalidState),
    /during save.*invalid status: expected "done" when phase is "done"/,
  );

  assert.equal(await pathExists(runStatePath), false);
});

test('saveState requires the run-local state path', async () => {
  const { state, runDir } = await createStateFixture();
  const requestedPath = join(dirname(dirname(runDir)), 'not-run-state.json');
  const runStatePath = getRunStatePath(runDir);

  await assert.rejects(
    () => saveState(requestedPath, state),
    /saveState requires the run-local state path:/,
  );

  assert.equal(await pathExists(requestedPath), false);
  assert.equal(await pathExists(runStatePath), false);
});

test('saveState rejects impossible new derived-plan saves while load keeps recoverable derived-plan states inspectable', async () => {
  const { state, statePath, runDir } = await createStateFixture();
  const derivedPlanPath = join(runDir, 'DERIVED_PLAN.md');

  await assert.rejects(
    () =>
      saveState(statePath, {
        ...state,
        phase: 'done',
        status: 'done',
        derivedPlanPath,
        derivedFromScopeNumber: 1,
        derivedPlanStatus: 'pending_review',
        derivedScopeIndex: null,
      }),
    /during save.*invalid phase: cannot be "done" while an unexecuted pending derived plan is still active/,
  );

  await assert.rejects(
    () =>
      saveState(statePath, {
        ...state,
        phase: 'done',
        status: 'done',
        derivedPlanPath,
        derivedFromScopeNumber: 1,
        derivedPlanStatus: 'accepted',
        derivedScopeIndex: null,
      }),
    /during save.*invalid phase: cannot be "done" while an unexecuted accepted derived plan is still active/,
  );

  await assert.rejects(
    () =>
      saveState(statePath, {
        ...state,
        derivedPlanPath,
        derivedFromScopeNumber: 1,
        derivedPlanStatus: 'rejected',
        derivedScopeIndex: 1,
      }),
    /during save.*invalid derivedPlanStatus: expected "accepted" when derivedScopeIndex is set/,
  );

  const loaded = await loadMutatedState((rawState, context) => {
    rawState.phase = 'done';
    rawState.status = 'done';
    rawState.derivedPlanPath = join(context.runDir, 'DERIVED_PLAN_PENDING_REVIEW.md');
    rawState.derivedFromScopeNumber = 1;
    rawState.derivedPlanStatus = 'pending_review';
    rawState.derivedScopeIndex = null;
  });
  assert.equal(loaded.phase, 'done');
  assert.equal(loaded.derivedPlanStatus, 'pending_review');
});

test('loadState rejects malformed active interactive blocked recovery state', async () => {
  await assertLoadRejects((state) => {
    state.phase = 'interactive_blocked_recovery';
  }, /during load.*invalid interactiveBlockedRecovery: expected active recovery state/);

  await assertLoadRejects((state) => {
    state.interactiveBlockedRecovery = makeInteractiveBlockedRecovery();
  }, /during load.*invalid phase: expected "interactive_blocked_recovery" while interactiveBlockedRecovery is active/);

  await assertLoadRejects((state) => {
    state.phase = 'interactive_blocked_recovery';
    state.interactiveBlockedRecovery = {
      ...makeInteractiveBlockedRecovery(),
      maxTurns: 0,
    };
  }, /during load.*invalid interactiveBlockedRecovery\.maxTurns: expected safe integer greater than or equal to 1/);

  await assertLoadRejects((state) => {
    const recovery = makeInteractiveBlockedRecovery();
    (recovery.turns as RawState[])[0].number = 2;
    state.phase = 'interactive_blocked_recovery';
    state.interactiveBlockedRecovery = recovery;
  }, /during load.*invalid interactiveBlockedRecovery\.turns\[0\]\.number: expected contiguous turn number 1/);

  await assertLoadRejects((state) => {
    state.phase = 'interactive_blocked_recovery';
    state.interactiveBlockedRecovery = makeInteractiveBlockedRecovery('reviewer_scope', 'reviewer_scope');
  }, /during load.*interactiveBlockedRecovery\.turns\[0\]\.disposition\.resultingPhase: action "resume_current_scope" cannot result in phase "reviewer_scope"/);
});

test('loadState rejects malformed derived-plan state', async () => {
  await assertLoadRejects((state) => {
    state.derivedPlanStatus = 'accepted';
  }, /during load.*invalid derivedPlanPath: expected non-null path when derivedPlanStatus is "accepted"/);

  await assertLoadRejects((state, { runDir }) => {
    state.derivedPlanPath = join(runDir, 'DERIVED_PLAN.md');
    state.derivedFromScopeNumber = 1;
    state.derivedPlanStatus = 'pending_review';
    state.derivedScopeIndex = 1;
  }, /during load.*invalid derivedPlanStatus: expected "accepted" when derivedScopeIndex is set/);

  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'awaiting_derived_plan_execution';
    state.derivedPlanPath = join(runDir, 'DERIVED_PLAN.md');
    state.derivedFromScopeNumber = 1;
    state.derivedPlanStatus = 'accepted';
    state.derivedScopeIndex = 1;
  }, /during load.*invalid derivedScopeIndex: expected null before accepted derived plan execution starts/);

  await assertLoadRejects((state, { runDir }) => {
    state.phase = 'awaiting_derived_plan_execution';
    state.derivedPlanPath = join(runDir, 'DERIVED_PLAN.md');
    state.derivedFromScopeNumber = 1;
    state.derivedPlanStatus = 'accepted';
    state.createdCommits = ['2222222222222222222222222222222222222222'];
  }, /during load.*invalid createdCommits: awaiting derived plan execution must not carry active created commits/);
});

test('loadState rejects malformed final-completion state and accepts reopened execution state', async () => {
  await assertLoadRejects((state) => {
    state.phase = 'final_completion_review';
  }, /during load.*invalid finalCompletionSummary: expected final completion summary when phase is "final_completion_review"/);

  await assertLoadRejects((state) => {
    state.finalCompletionContinueExecutionCapReached = true;
    state.finalCompletionReviewVerdict = {
      action: 'block_for_operator',
      summary: 'Block.',
      rationale: 'Operator decision required.',
      missingWork: null,
      squashCommitMessage: null,
    };
    state.finalCompletionResolvedAction = 'block_for_operator';
  }, /during load.*invalid finalCompletionReviewVerdict\.action: expected "continue_execution" when final completion continue-execution cap is reached/);

  await assertLoadRejects((state) => {
    state.finalCompletionReviewVerdict = {
      action: 'continue_execution',
      summary: 'Continue.',
      rationale: 'More work remains.',
      missingWork: {
        summary: 'Add coverage.',
        requiredOutcome: 'Coverage exists.',
        verification: 'Run focused tests.',
      },
      squashCommitMessage: null,
    };
    state.finalCompletionResolvedAction = 'block_for_operator';
    state.finalCompletionContinueExecutionCapReached = false;
  }, /during load.*invalid finalCompletionResolvedAction: expected "continue_execution" for finalCompletionReviewVerdict\.action "continue_execution"/);

  const loaded = await loadMutatedState((state) => {
    state.phase = 'coder_scope';
    state.finalCompletionSummary = null;
    state.finalCompletionReviewVerdict = {
      action: 'continue_execution',
      summary: 'Continue.',
      rationale: 'More work remains.',
      missingWork: {
        summary: 'Add coverage.',
        requiredOutcome: 'Coverage exists.',
        verification: 'Run focused tests.',
      },
      squashCommitMessage: null,
    };
    state.finalCompletionResolvedAction = 'continue_execution';
    state.finalCompletionContinueExecutionCount = 1;
    state.finalCompletionContinueExecutionCapReached = false;
  });

  assert.equal(loaded.phase, 'coder_scope');
  assert.equal(loaded.finalCompletionResolvedAction, 'continue_execution');
});

test('saveState accepts accepted final completion without squashCommitMessage', async () => {
  const { state, statePath } = await createStateFixture();
  const saved = await saveState(statePath, {
    ...state,
    phase: 'done',
    status: 'done',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the requested behavior.',
      verificationSummary: 'Ran the focused tests.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'Complete.',
      rationale: 'The requested behavior is present.',
      missingWork: null,
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'accept_complete',
  });
  const loaded = await loadState(statePath);

  assert.equal(saved.finalCompletionReviewVerdict?.action, 'accept_complete');
  assert.equal(saved.finalCompletionReviewVerdict?.squashCommitMessage, null);
  assert.equal(loaded.finalCompletionReviewVerdict?.action, 'accept_complete');
  assert.equal(loaded.finalCompletionReviewVerdict?.squashCommitMessage, null);
});

test('saveState rejects non-accept final completion with squashCommitMessage', async () => {
  const { state, statePath } = await createStateFixture();

  await assert.rejects(
    () =>
      saveState(statePath, {
        ...state,
        finalCompletionReviewVerdict: {
          action: 'continue_execution',
          summary: 'Continue.',
          rationale: 'More work remains.',
          missingWork: {
            summary: 'Add coverage.',
            requiredOutcome: 'Coverage exists.',
            verification: 'Run focused tests.',
          },
          squashCommitMessage: {
            subject: 'Persist final completion squash drafts',
            bullets: [
              'Store semantic squash summaries in completion state.',
              'Render the draft in final completion artifacts.',
            ],
          },
        },
        finalCompletionResolvedAction: 'continue_execution',
        finalCompletionContinueExecutionCount: 1,
      }),
    /during save.*invalid finalCompletionReviewVerdict\.squashCommitMessage: expected null when finalCompletionReviewVerdict\.action is "continue_execution"/,
  );
});

test('loadState rejects malformed completed scope accounting', async () => {
  await assertLoadRejects((state) => {
    state.completedScopes = [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: '1111111111111111111111111111111111111111',
        finalCommit: null,
        summary: null,
        commitSubject: 'Missing final commit',
        changedFiles: [],
        reviewRounds: 0,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ];
  }, /during load.*invalid completedScopes\[0\]\.finalCommit: expected non-empty string/);

  await assertLoadRejects((state) => {
    state.completedScopes = [
      {
        number: '1',
        marker: 'AUTONOMY_BLOCKED',
        result: 'blocked',
        baseCommit: '1111111111111111111111111111111111111111',
        finalCommit: null,
        summary: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 0,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ];
  }, /during load.*invalid completedScopes\[0\]\.blocker: expected non-empty string/);

  await assertLoadRejects((state) => {
    state.completedScopes = [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: '1111111111111111111111111111111111111111',
        finalCommit: '2222222222222222222222222222222222222222',
        summary: null,
        commitSubject: 'Accepted scope',
        changedFiles: [],
        reviewRounds: -1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ];
  }, /during load.*invalid completedScopes\[0\]\.reviewRounds: expected safe integer greater than or equal to 0/);
});
