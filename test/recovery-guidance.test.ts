import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { recordRecoveryGuidanceForResolvedRun } from '../src/neal/commands/recovery-guidance.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-recovery-guidance');

async function withProcessCwd<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await action();
  } finally {
    process.chdir(previousCwd);
  }
}

async function createInteractiveRecoveryFixture(args: {
  runId: string;
  mutate?: (state: OrchestrationState) => OrchestrationState;
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-recovery-guidance-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', args.runId);
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
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
    },
    'base-commit',
  );

  const interactiveState: OrchestrationState = {
    ...initialState,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-25T18:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge.',
      maxTurns: 3,
      lastHandledTurn: 1,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-25T18:01:00.000Z',
          operatorGuidance: 'Keep the fix narrow.',
          disposition: {
            recordedAt: '2026-04-25T18:02:00.000Z',
            sessionHandle: 'coder-recovery-session-1',
            action: 'resume_current_scope',
            summary: 'Guidance handled.',
            rationale: 'The path was clear.',
            blocker: '',
            replacementPlan: '',
            resultingPhase: 'coder_response',
          },
        },
      ],
    },
  };

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, args.mutate?.(interactiveState) ?? interactiveState);

  return {
    cwd,
    runId: basename(runDir),
    runDir,
    statePath,
    state,
  };
}

async function createPlanReviewBlockedFixture(args: {
  runId: string;
  mutate?: (state: OrchestrationState) => OrchestrationState;
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-guidance-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', args.runId);
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'plan',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(cwd),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'base-commit',
  );

  const blockedState: OrchestrationState = {
    ...initialState,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    pendingPlanReviewGuidance: null,
  };

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, args.mutate?.(blockedState) ?? blockedState);

  return {
    cwd,
    runId: basename(runDir),
    runDir,
    statePath,
    state,
  };
}

test('resume --message records ordinary operator guidance for interactive blocked recovery', async () => {
  const fixture = await createInteractiveRecoveryFixture({ runId: '2026-04-25T18-00-00.000Z-guidance' });

  const result = await withProcessCwd(fixture.cwd, () =>
    recordRecoveryGuidanceForResolvedRun({
      target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
      message: 'Try the smaller transition-only fix.',
    }),
  );

  assert.equal(result.kind, 'recorded');
  assert.equal(result.recoveryTurns, 2);
  assert.equal(result.resumeCommand, `neal resume --run ${fixture.runId}`);
  const persisted = await loadState(fixture.statePath);
  assert.equal(persisted.interactiveBlockedRecovery?.turns.length, 2);
  assert.equal(
    persisted.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
    'Try the smaller transition-only fix.',
  );
});

test('resume --message rejects guidance when a turn is already pending without mutating state', async () => {
  const fixture = await createInteractiveRecoveryFixture({
    runId: '2026-04-25T18-00-00.000Z-pending',
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        ...state.interactiveBlockedRecovery!,
        lastHandledTurn: 0,
      },
    }),
  });
  const before = await readFile(fixture.statePath, 'utf8');

  const result = await withProcessCwd(fixture.cwd, () =>
    recordRecoveryGuidanceForResolvedRun({
      target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
      message: 'Record another instruction.',
    }),
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.pendingTurn, 1);
  assert.equal(await readFile(fixture.statePath, 'utf8'), before);
});

test('resume --message outside interactive blocked recovery explains the supported guidance path', async () => {
  const fixture = await createInteractiveRecoveryFixture({
    runId: '2026-04-25T18-00-00.000Z-unsupported',
    mutate: (state) => ({
      ...state,
      phase: 'blocked',
      status: 'blocked',
      interactiveBlockedRecovery: null,
    }),
  });

  await assert.rejects(
    () =>
      withProcessCwd(fixture.cwd, () =>
        recordRecoveryGuidanceForResolvedRun({
          target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
          message: 'Apply this guidance.',
        }),
      ),
    /cannot be mechanically resumed/,
  );
});

test('resume --message rejects failed ordinary execution without changing run state', async () => {
  const fixture = await createInteractiveRecoveryFixture({
    runId: '2026-04-25T18-00-00.000Z-failed-coder-scope',
    mutate: (state) => ({
      ...state,
      phase: 'coder_scope',
      status: 'failed',
      blockedFromPhase: null,
      interactiveBlockedRecovery: null,
    }),
  });
  const before = await readFile(fixture.statePath, 'utf8');

  await assert.rejects(
    () =>
      withProcessCwd(fixture.cwd, () =>
        recordRecoveryGuidanceForResolvedRun({
          target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
          message: 'The prior turn completed; continue to review.',
        }),
      ),
    /Run does not need --message/,
  );

  assert.equal(await readFile(fixture.statePath, 'utf8'), before);
});

test('resume --message records plan-review guidance and transitions to coder plan response', async () => {
  const fixture = await createPlanReviewBlockedFixture({ runId: '2026-05-18T12-00-00.000Z-plan-guidance' });
  const guidance = 'Focus the recovery plan on the reviewer finding only.';

  const result = await withProcessCwd(fixture.cwd, () =>
    recordRecoveryGuidanceForResolvedRun({
      target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
      message: `  ${guidance}  `,
    }),
  );

  assert.equal(result.kind, 'recorded');
  assert.equal(result.resumeCommand, `neal resume --run ${fixture.runId}`);

  const persisted = await loadState(fixture.statePath);
  assert.equal(persisted.phase, 'coder_plan_response');
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.blockedFromPhase, null);
  assert.deepEqual(persisted.pendingPlanReviewGuidance, {
    message: guidance,
    sourcePhase: 'reviewer_plan',
    recordedAt: persisted.pendingPlanReviewGuidance?.recordedAt,
  });
  assert.match(persisted.pendingPlanReviewGuidance?.recordedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(persisted.interactiveBlockedRecovery, null);
  assert.deepEqual(persisted.interactiveBlockedRecoveryHistory, []);

  const serializedEvents = await readFile(join(fixture.runDir, 'events.ndjson'), 'utf8');
  assert.equal(serializedEvents.includes(guidance), false);
  const events = serializedEvents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
  const recordedEvent = events.find((event) => event.type === 'plan_review_guidance.recorded');
  assert.ok(recordedEvent);
  assert.equal(recordedEvent.data?.statePath, fixture.statePath);
  assert.equal(recordedEvent.data?.sourcePhase, 'reviewer_plan');
  assert.equal(recordedEvent.data?.guidanceBytes, Buffer.byteLength(guidance, 'utf8'));
  assert.equal(Object.hasOwn(recordedEvent.data ?? {}, 'message'), false);
});

test('resume --message reports duplicate pending plan-review guidance without mutating state', async () => {
  const fixture = await createPlanReviewBlockedFixture({
    runId: '2026-05-18T12-00-00.000Z-plan-guidance-pending',
    mutate: (state) => ({
      ...state,
      phase: 'coder_plan_response',
      status: 'running',
      blockedFromPhase: null,
      pendingPlanReviewGuidance: {
        message: 'Already recorded.',
        sourcePhase: 'reviewer_plan',
        recordedAt: '2026-05-18T12:00:00.000Z',
      },
    }),
  });
  const before = await readFile(fixture.statePath, 'utf8');

  const result = await withProcessCwd(fixture.cwd, () =>
    recordRecoveryGuidanceForResolvedRun({
      target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
      message: 'Overwrite the recorded guidance.',
    }),
  );

  assert.equal(result.kind, 'pending');
  assert.equal(result.guidanceKind, 'plan_review');
  assert.equal(result.pendingTurn, null);
  assert.equal(result.resumeCommand, `neal resume --run ${fixture.runId}`);
  assert.equal(await readFile(fixture.statePath, 'utf8'), before);
});

test('resume --message rejects empty plan-review guidance without mutating state', async () => {
  const fixture = await createPlanReviewBlockedFixture({ runId: '2026-05-18T12-00-00.000Z-plan-guidance-empty' });
  const before = await readFile(fixture.statePath, 'utf8');

  await assert.rejects(
    () =>
      withProcessCwd(fixture.cwd, () =>
        recordRecoveryGuidanceForResolvedRun({
          target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
          message: '   ',
        }),
      ),
    /Plan review guidance must not be empty/,
  );

  assert.equal(await readFile(fixture.statePath, 'utf8'), before);
});

test('resume --message rejects the excluded initial coder_plan authoring block without mutating state', async () => {
  // The initial coder_plan authoring block is deliberately excluded from the
  // author-input route (Scope 6). With no planner session handle it is a
  // non-mechanically-resumable block, so --message is rejected.
  const fixture = await createPlanReviewBlockedFixture({
    runId: '2026-05-18T12-00-00.000Z-plan-guidance-unsupported',
    mutate: (state) => ({
      ...state,
      blockedFromPhase: 'coder_plan',
      plannerSessionHandle: null,
      plannerSessionProtocol: null,
    }),
  });
  const before = await readFile(fixture.statePath, 'utf8');

  await assert.rejects(
    () =>
      withProcessCwd(fixture.cwd, () =>
        recordRecoveryGuidanceForResolvedRun({
          target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
          message: 'Apply this guidance.',
        }),
      ),
    /cannot be mechanically resumed/,
  );

  assert.equal(await readFile(fixture.statePath, 'utf8'), before);
});

test('resume --message rejects a dirty-worktree response block with no recoverable reason without mutating state', async () => {
  // A dirty-worktree safety block lands at coder_plan_response but records no
  // durable blockerReason, so it is not answerable via --message. With a
  // resumable planner session present it is a bare-resume continue, and
  // recordRecoveryGuidanceForResolvedRun rejects the --message attempt.
  const fixture = await createPlanReviewBlockedFixture({
    runId: '2026-05-18T12-00-00.000Z-plan-guidance-dirty',
    mutate: (state) => ({
      ...state,
      blockedFromPhase: 'coder_plan_response',
      plannerSessionHandle: 'planner-session-1',
      plannerSessionProtocol: 'structured_json_v1',
      blockerReason: null,
      pendingPlanReviewGuidance: null,
    }),
  });
  const before = await readFile(fixture.statePath, 'utf8');

  await assert.rejects(
    () =>
      withProcessCwd(fixture.cwd, () =>
        recordRecoveryGuidanceForResolvedRun({
          target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
          message: 'Apply this guidance.',
        }),
      ),
    /does not need --message/,
  );

  assert.equal(await readFile(fixture.statePath, 'utf8'), before);
});

test('resume --message answers coder-authored plan-response blocks for all origins', async () => {
  // Author-input route for the two coder-authored *response* blocks. Each origin
  // maps to the phase that will actually consume the guidance, records the
  // operator message in pendingPlanReviewGuidance with the origin as sourcePhase,
  // clears the durable blockerReason, and returns the run to running.
  const cases = [
    { origin: 'coder_plan_response', expectedResumePhase: 'coder_plan_response' },
    { origin: 'coder_plan_optional_response', expectedResumePhase: 'coder_plan_optional_response' },
  ] as const;

  for (const [index, { origin, expectedResumePhase }] of cases.entries()) {
    const fixture = await createPlanReviewBlockedFixture({
      runId: `2026-05-18T12-00-00.000Z-plan-guidance-${origin}`,
      mutate: (state) => ({
        ...state,
        blockedFromPhase: origin,
        plannerSessionHandle: 'planner-session-1',
        plannerSessionProtocol: 'structured_json_v1',
        blockerReason: 'The coder needs an operator decision on the plan.',
        pendingPlanReviewGuidance: null,
      }),
    });
    const guidance = `Operator answer for ${origin} number ${index}.`;

    const result = await withProcessCwd(fixture.cwd, () =>
      recordRecoveryGuidanceForResolvedRun({
        target: { statePath: fixture.statePath, selectedRunId: fixture.runId },
        message: `  ${guidance}  `,
      }),
    );

    assert.equal(result.kind, 'recorded');
    const persisted = await loadState(fixture.statePath);
    assert.equal(persisted.phase, expectedResumePhase);
    assert.equal(persisted.status, 'running');
    assert.equal(persisted.blockedFromPhase, null);
    assert.equal(persisted.blockerReason, null);
    assert.deepEqual(persisted.pendingPlanReviewGuidance, {
      message: guidance,
      sourcePhase: origin,
      recordedAt: persisted.pendingPlanReviewGuidance?.recordedAt,
    });

    const serializedEvents = await readFile(join(fixture.runDir, 'events.ndjson'), 'utf8');
    const events = serializedEvents
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
    const recordedEvent = events.find((event) => event.type === 'plan_review_guidance.recorded');
    assert.ok(recordedEvent);
    assert.equal(recordedEvent.data?.sourcePhase, origin);
  }
});
