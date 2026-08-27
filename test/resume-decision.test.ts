import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideResumeAction, type ResumeDecision } from '../src/neal/resume-decision.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState, OrchestratorInit } from '../src/neal/types.js';

const RUN_ID = 'decision-run';

async function createDecisionState(overrides: Partial<OrchestrationState> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-resume-decision-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', RUN_ID);
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

type DecisionOverrides = Partial<Omit<Parameters<typeof decideResumeAction>[0], 'state' | 'selectedRunId' | 'statePath'>>;

function decide(state: OrchestrationState, overrides: DecisionOverrides = {}) {
  return decideResumeAction({
    state,
    selectedRunId: RUN_ID,
    statePath: join(state.runDir, 'RUN_STATE.json'),
    ...overrides,
  });
}

function assertKind<K extends ResumeDecision['kind']>(
  decision: ResumeDecision,
  kind: K,
): Extract<ResumeDecision, { kind: K }> {
  assert.equal(decision.kind, kind);
  return decision as Extract<ResumeDecision, { kind: K }>;
}

test('resume decision continues ordinary failed coder scope runs without guidance', async () => {
  const state = await createDecisionState({
    phase: 'coder_scope',
    status: 'failed',
    interactiveBlockedRecovery: null,
  });

  const decision = assertKind(decide(state), 'continue');

  assert.equal(decision.resumeCommand, `neal resume --run ${RUN_ID}`);
});

test('resume decision treats paused and stale-locked running states as continuable', async () => {
  const pausedState = await createDecisionState({
    phase: 'coder_scope',
    status: 'paused',
  });
  const runningState = await createDecisionState({
    phase: 'coder_scope',
    status: 'running',
  });

  assert.equal(assertKind(decide(pausedState), 'continue').resumeCommand, `neal resume --run ${RUN_ID}`);
  assert.equal(
    assertKind(
      decide(runningState, {
        lock: { kind: 'stale_same_run', runId: RUN_ID, pid: 0 },
      }),
      'continue',
    ).resumeCommand,
    `neal resume --run ${RUN_ID}`,
  );
});

test('resume decision continues restorable blocked and unexecuted derived-plan states', async () => {
  const blockedState = await createDecisionState({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_scope',
    coderSessionHandle: 'coder-session-1',
  });
  const derivedPlanState = await createDecisionState({
    phase: 'done',
    status: 'done',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_4.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
    createdCommits: [],
  });

  assert.equal(assertKind(decide(blockedState), 'continue').resumeCommand, `neal resume --run ${RUN_ID}`);
  assert.equal(assertKind(decide(derivedPlanState), 'continue').resumeCommand, `neal resume --run ${RUN_ID}`);
});

test('resume decision continues a running derived-plan revision without a planner session', async () => {
  // Reproduction state: execute run persisted in coder_plan_response with no planner session,
  // an open blocking finding, and the derived plan still pending review. `neal status` must
  // advertise "Resume this run", i.e. decideResumeAction returns a plain continue.
  const state = await createDecisionState({
    topLevelMode: 'execute',
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
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['PLAN.md'],
        claim: 'The derived plan needs explicit recovery sequencing.',
        evidence: null,
        requiredAction: 'Revise the derived plan.',
        status: 'open',
        roundSummary: 'Recovery sequencing remains unclear.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });

  const decision = assertKind(decide(state), 'continue');
  assert.equal(decision.resumeCommand, `neal resume --run ${RUN_ID}`);
});

test('resume decision asks for message only when interactive recovery is waiting', async () => {
  const state = await createDecisionState({
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-05-16T12:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance on the failing assertion.',
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

  const decision = assertKind(decide(state), 'needs_message');

  assert.equal(decision.blocker, 'Need operator guidance on the failing assertion.');
  assert.equal(decision.messageCommand, `neal resume --run ${RUN_ID} --message "..."`);
  assert.equal(decision.statusCommand, `neal status --run ${RUN_ID}`);
});

test('resume decision resumes when interactive recovery has pending guidance', async () => {
  const state = await createDecisionState({
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-05-16T12:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 0,
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

  const decision = assertKind(decide(state), 'pending_message');

  assert.equal(decision.resumeCommand, `neal resume --run ${RUN_ID}`);
});

test('resume decision asks for message when blocked top-level plan review is waiting for guidance', async () => {
  const state = await createDecisionState({
    topLevelMode: 'plan',
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    pendingPlanReviewGuidance: null,
  });

  const decision = assertKind(decide(state), 'needs_message');

  assert.match(decision.blocker, /blocked from reviewer_plan/);
  assert.doesNotMatch(decision.blocker, /cannot be mechanically resumed/);
  assert.equal(decision.messageCommand, `neal resume --run ${RUN_ID} --message "..."`);
  assert.equal(decision.statusCommand, `neal status --run ${RUN_ID}`);
});

test('resume decision resumes when plan-review guidance is pending', async () => {
  const state = await createDecisionState({
    topLevelMode: 'plan',
    phase: 'coder_plan_response',
    status: 'running',
    pendingPlanReviewGuidance: {
      message: 'Address the review finding with narrower scope wording.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-18T12:00:00.000Z',
    },
  });

  const decision = assertKind(decide(state), 'pending_message');

  assert.equal(decision.reason, 'Operator guidance is recorded and ready for Neal to process.');
  assert.equal(decision.resumeCommand, `neal resume --run ${RUN_ID}`);
});

test('resume decision keeps the initial coder_plan authoring block non-message-resumable', async () => {
  // The initial coder_plan authoring block is deliberately excluded from the
  // author-input route (Scope 6): with no planner session handle it stays a
  // non-mechanically-resumable block, never needs_message.
  const state = await createDecisionState({
    topLevelMode: 'plan',
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan',
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    pendingPlanReviewGuidance: null,
  });

  const decision = assertKind(decide(state), 'cannot_resume');

  assert.match(decision.reason, /coder_plan/);
  assert.match(decision.reason, /cannot be mechanically resumed/);
});

test('resume decision asks for message for coder-authored plan-response blocks over a bare restore', async () => {
  // Both coder-authored *response* blocks are now answerable via --message. The
  // precedence pin: even with a planner session handle present (which would
  // otherwise emit restore_resumable_blocked_phase and let a bare `neal resume`
  // re-run the coder), decideResumeAction evaluates the plan-review guidance
  // predicate first, so the decision is needs_message.
  for (const blockedFromPhase of ['coder_plan_response', 'coder_plan_optional_response'] as const) {
    const withoutSession = await createDecisionState({
      topLevelMode: 'plan',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase,
      plannerSessionHandle: null,
      plannerSessionProtocol: null,
      blockerReason: 'The coder needs an operator decision on the plan.',
      pendingPlanReviewGuidance: null,
    });
    const withoutSessionDecision = assertKind(decide(withoutSession), 'needs_message');
    assert.match(withoutSessionDecision.blocker, new RegExp(`blocked from ${blockedFromPhase}`));

    const withSession = await createDecisionState({
      topLevelMode: 'plan',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase,
      plannerSessionHandle: 'planner-session-1',
      plannerSessionProtocol: 'structured_json_v1',
      blockerReason: 'The coder needs an operator decision on the plan.',
      pendingPlanReviewGuidance: null,
    });
    assertKind(decide(withSession), 'needs_message');
  }
});

test('resume decision keeps a dirty-worktree response block a bare-resume continue, not a message wait', async () => {
  // A dirty-worktree safety block lands at the same response phase as a
  // coder-authored block but sets no durable blockerReason. It must NOT be
  // exposed through the author-input route: with a resumable planner session it
  // stays a bare-resume continue, never needs_message.
  for (const blockedFromPhase of ['coder_plan_response', 'coder_plan_optional_response'] as const) {
    const state = await createDecisionState({
      topLevelMode: 'plan',
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase,
      plannerSessionHandle: 'planner-session-1',
      plannerSessionProtocol: 'structured_json_v1',
      // Dirty-worktree safety block: no recoverable reason recorded.
      blockerReason: null,
      pendingPlanReviewGuidance: null,
    });

    const decision = assertKind(decide(state), 'continue');
    assert.equal(decision.resumeCommand, `neal resume --run ${RUN_ID}`);
  }
});

test('resume decision reports a live same-run lock as already running', async () => {
  const state = await createDecisionState({
    phase: 'coder_scope',
    status: 'failed',
  });

  const decision = assertKind(
    decide(state, {
      lock: { kind: 'live_same_run', runId: RUN_ID, pid: process.pid },
    }),
    'already_running',
  );

  assert.match(decision.reason, /already be running/);
  assert.equal(decision.statusCommand, `neal status --run ${RUN_ID}`);
});

test('resume decision returns done for ordinary completed runs', async () => {
  const state = await createDecisionState({
    phase: 'done',
    status: 'done',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    finalCommit: '2222222222222222222222222222222222222222',
  });
  const retrospectivePath = join(state.runDir, 'RETROSPECTIVE.md');

  const decision = assertKind(
    decide(state, {
      retrospectivePath,
    }),
    'done',
  );

  assert.equal(decision.statusCommand, `neal status --run ${RUN_ID}`);
  assert.equal(decision.retrospectivePath, retrospectivePath);
});

test('resume decision refuses live different-run locks before state recovery', async () => {
  const state = await createDecisionState({
    phase: 'coder_scope',
    status: 'failed',
  });

  const decision = assertKind(
    decide(state, {
      lock: { kind: 'live_different_run', runId: 'other-run', pid: process.pid },
    }),
    'cannot_resume',
  );

  assert.match(decision.reason, /other-run/);
  assert.equal(decision.statusCommand, 'neal status --run other-run');
});

test('resume decision refuses non-restorable blocked runs without making them message-eligible', async () => {
  const state = await createDecisionState({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-1',
  });

  const decision = assertKind(decide(state), 'cannot_resume');

  assert.match(decision.reason, /reviewer_scope/);
  assert.equal(decision.statusCommand, `neal status --run ${RUN_ID}`);
});

test('resume decision includes terminal invalid split-plan diagnostics for non-restorable blocks', async () => {
  const validationReason = 'split-plan payload is not a valid Neal-executable plan: executionShape: multi_scope must not include a `## Completion Condition` section.';
  const state = await createDecisionState({
    phase: 'blocked',
    status: 'blocked',
    currentScopeNumber: 5,
    blockedFromPhase: 'reviewer_scope',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_SPLIT_PLAN',
        result: 'blocked',
        baseCommit: 'base',
        finalCommit: 'scope-head',
        summary: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 0,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: validationReason,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await mkdir(state.runDir, { recursive: true });
  const invalidPayloadPath = join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md');
  await writeFile(invalidPayloadPath, '# Invalid Derived Plan Payload\n', 'utf8');

  const decision = assertKind(decide(state), 'cannot_resume');

  assert.match(decision.reason, /cannot be mechanically resumed/);
  assert.match(decision.reason, /must not include a `## Completion Condition` section/);
  assert.ok(decision.reason.includes(`Invalid payload artifact: ${invalidPayloadPath}`));
});

test('resume decision refuses stale queue child evidence', async () => {
  const state = await createDecisionState({
    phase: 'coder_scope',
    status: 'failed',
  });

  const decision = assertKind(
    decide(state, {
      queue: {
        kind: 'consumed_child',
        reason: 'Queue child has already been consumed by a later item.',
        queueId: 'queue-1',
        itemIndex: 0,
        stage: 'execution',
      },
    }),
    'cannot_resume',
  );

  assert.equal(decision.reason, 'Queue child has already been consumed by a later item.');
});

test('resume decision reports done for a consumed queue child whose run completed', async () => {
  const state = await createDecisionState({
    phase: 'done',
    status: 'done',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    finalCommit: '3333333333333333333333333333333333333333',
  });
  const retrospectivePath = join(state.runDir, 'RETROSPECTIVE.md');

  const decision = assertKind(
    decide(state, {
      queue: {
        kind: 'consumed_child',
        reason: 'Queue execution child has already been consumed.',
        queueId: 'queue-1',
        itemIndex: 0,
        stage: 'execution',
      },
      retrospectivePath,
    }),
    'done',
  );

  assert.match(decision.summary, /already complete/);
  assert.equal(decision.retrospectivePath, retrospectivePath);
});
