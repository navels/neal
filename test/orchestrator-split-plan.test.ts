import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache } from '../src/neal/config.js';
import { createRunLogger } from '../src/neal/logger.js';
import { flushDerivedPlanNotifications } from '../src/neal/orchestrator/notifications.js';
import { writeExecutionArtifacts } from '../src/neal/orchestrator/artifacts.js';
import { shouldNotifyInteractiveBlockedRecoveryEntry } from '../src/neal/orchestrator/phases/recovery.js';
import { persistBlockedScope } from '../src/neal/orchestrator/phases/shared.js';
import { persistSplitPlanRecovery } from '../src/neal/orchestrator/split-plan.js';
import { writeRepoConfig, createResumeFixture, createInvalidFixedMultiScopePlan, createNotifyCapture, runGit, readRunEvents, createExecuteFinalizationFixture, assertTerminalInvalidSplitPlanBlock, assertSplitPlanGuardrailBlock } from './helpers/orchestrator-harness.js';
import type { SplitPlanRecoverySourcePhase } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-split-plan');

test('persistSplitPlanRecovery allows split-plan attempts up to the configured cap and blocks at 10', async () => {
  const nextState = await assertSplitPlanGuardrailBlock({
    sourcePhase: 'coder_scope',
    stateOverrides: {
      currentScopeNumber: 5,
      splitPlanCountForCurrentScope: 10,
    },
    reasonPattern: /reached the split-plan limit \(10\)/,
  });

  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
  assert.match(
    nextState.completedScopes.at(-1)?.blocker ?? '',
    /reached the split-plan limit \(10\)/,
  );
});

test('persistSplitPlanRecovery blocks at the derived-plan depth limit before validating invalid payloads', async () => {
  const nextState = await assertSplitPlanGuardrailBlock({
    sourcePhase: 'coder_scope',
    stateOverrides: {
      derivedPlanDepth: 1,
      splitPlanCountForCurrentScope: 0,
    },
    reasonPattern: /derived plan depth limit reached for scope 5/,
  });

  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /derived plan depth limit/);
});

test('persistSplitPlanRecovery routes recoverable invalid plan payloads into interactive blocked recovery before resetting scope work', async () => {
  const { cwd, statePath, state, createdCommit, notifyLogPath, notifyScriptPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: 'coder_scope',
    status: 'running',
    unattended: false,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
  });
  // Disable the consultant so the attended reroute yields plainly without a
  // provider call; consultant dispatch is covered by the consultant
  // and recovery tests.
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: ${notifyScriptPath}\n  consultant_max_attempts: 0\n`,
    'utf8',
  );
  clearConfigCache(cwd);
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(
    join(cwd, 'tmp', 'derived-plan.md'),
    '## Execution Shape\n\nexecutionShape: one_shot\n',
    'utf8',
  );
  await writeFile(join(cwd, 'scope.txt'), 'base\nchange\nlocal draft\n', 'utf8');
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_scope',
      derivedPlanMarkdown: `Use tmp/derived-plan.md from commit ${createdCommit}.`,
      createdCommits: [createdCommit],
      logger,
    },
    {
      persistBlockedScope,
      writeExecutionArtifacts,
    },
  );

  // Worktree + commits are preserved; the recoverable reroute does not reset scope work.
  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  assert.equal(await readFile(join(cwd, 'tmp', 'derived-plan.md'), 'utf8'), '## Execution Shape\n\nexecutionShape: one_shot\n');
  const visibleStatus = await runGit(cwd, 'status', '--short', '--', 'scope.txt', 'tmp');
  assert.match(visibleStatus, /M scope\.txt/);
  assert.match(visibleStatus, /\?\? tmp\//);
  await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(join(state.runDir, 'SCOPE_5_DISCARDED.diff'), 'utf8'), /ENOENT/);
  const invalidPayloadArtifact = await readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8');
  assert.match(invalidPayloadArtifact, /This artifact is diagnostic only/);
  assert.match(invalidPayloadArtifact, /Use tmp\/derived-plan\.md from commit/);
  assert.match(invalidPayloadArtifact, /Missing required `## Execution Shape` section/);

  // The recoverable coder block now routes through the single interactive
  // blocked-recovery chokepoint instead of constructing a support round.
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.interactiveBlockedRecovery?.sourcePhase, 'coder_scope');
  assert.match(nextState.interactiveBlockedRecovery?.blockedReason ?? '', /not a valid Neal-executable plan/);
  assert.match(nextState.interactiveBlockedRecovery?.blockedReason ?? '', /Missing required `## Execution Shape` section/);
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.deepEqual(nextState.createdCommits, [createdCommit]);
  assert.equal(nextState.completedScopes.some((scope) => scope.result === 'blocked'), false);
  // No support round is constructed, and the disabled consultant leaves no advice/budget mutation.
  assert.equal(nextState.recentBlocks.length, 0);
  assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null);
  assert.equal(nextState.consultantAttemptCount, 0);
  // Attended reroute yields waiting for the operator and notifies.
  assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), true);

  const events = await readRunEvents(state.runDir);
  const invalidEvent = events.find((event) => event.type === 'split_plan.invalid_payload');
  assert.ok(invalidEvent);
  assert.equal(invalidEvent.data?.scopeNumber, 5);
  assert.equal(invalidEvent.data?.sourcePhase, 'coder_scope');
  assert.equal(invalidEvent.data?.invalidPayloadPath, join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'));
  assert.equal(invalidEvent.data?.resetSkipped, true);
  assert.deepEqual(invalidEvent.data?.createdCommits, [createdCommit]);
  assert.deepEqual(invalidEvent.data?.validationErrors, ['Missing required `## Execution Shape` section.']);
  const recoveryEvent = events.find((event) => event.type === 'split_plan.invalid_payload_recovery_started');
  assert.ok(recoveryEvent);
  assert.equal(recoveryEvent.data?.scopeNumber, 5);
  assert.equal(recoveryEvent.data?.sourcePhase, 'coder_scope');
  assert.equal(recoveryEvent.data?.invalidPayloadPath, join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'));
  assert.deepEqual(recoveryEvent.data?.createdCommits, [createdCommit]);
  // No consultant events on the knob-disabled reroute.
  assert.equal(events.some((event) => event.type.startsWith('consultant.')), false);
  assert.ok(events.some((event) => event.type === 'notify.blocked'));
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /not a valid Neal-executable plan/);
});

test('persistSplitPlanRecovery routes required coder_response invalid plan payloads into interactive blocked recovery', async () => {
  const { cwd, statePath, state, createdCommit, notifyLogPath, notifyScriptPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: 'coder_response',
    status: 'running',
    unattended: false,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
  });
  // Disable the consultant so the attended reroute yields plainly without a provider call.
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: ${notifyScriptPath}\n  consultant_max_attempts: 0\n`,
    'utf8',
  );
  clearConfigCache(cwd);
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_response',
      derivedPlanMarkdown: createInvalidFixedMultiScopePlan(),
      createdCommits: [createdCommit],
      logger,
    },
    {
      persistBlockedScope,
      writeExecutionArtifacts,
    },
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), /ENOENT/);
  await assert.rejects(readFile(join(state.runDir, 'SCOPE_5_DISCARDED.diff'), 'utf8'), /ENOENT/);
  const invalidPayloadArtifact = await readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8');
  assert.match(invalidPayloadArtifact, /Completion Condition/);
  assert.match(invalidPayloadArtifact, /must not include a `## Completion Condition` section/);

  // The recoverable coder_response block routes through interactive blocked recovery.
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, 'coder_response');
  assert.equal(nextState.interactiveBlockedRecovery?.sourcePhase, 'coder_response');
  assert.match(nextState.interactiveBlockedRecovery?.blockedReason ?? '', /must not include a `## Completion Condition` section/);
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.completedScopes.some((scope) => scope.result === 'blocked'), false);
  assert.equal(nextState.recentBlocks.length, 0);
  assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null);
  assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), true);

  const events = await readRunEvents(state.runDir);
  const invalidEvent = events.find((event) => event.type === 'split_plan.invalid_payload');
  assert.ok(invalidEvent);
  assert.equal(invalidEvent.data?.sourcePhase, 'coder_response');
  assert.equal(invalidEvent.data?.resetSkipped, true);
  assert.deepEqual(invalidEvent.data?.createdCommits, [createdCommit]);
  const recoveryEvent = events.find((event) => event.type === 'split_plan.invalid_payload_recovery_started');
  assert.ok(recoveryEvent);
  assert.equal(recoveryEvent.data?.sourcePhase, 'coder_response');
  assert.equal(recoveryEvent.data?.invalidPayloadPath, join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'));
  assert.equal(events.some((event) => event.type.startsWith('consultant.')), false);
  assert.ok(events.some((event) => event.type === 'notify.blocked'));
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /not a valid Neal-executable plan/);
});

for (const scenario of [
  {
    name: 'empty',
    payload: '   \n',
    errorPattern: /Replacement plan payload is empty\./,
  },
  {
    name: 'malformed multi-scope',
    payload: '## Execution Shape\n\nexecutionShape: multi_scope\n',
    errorPattern: /requires a `## Execution Queue` section/,
  },
]) {
  test(`persistSplitPlanRecovery routes recoverable ${scenario.name} plan payloads into interactive recovery before resetting scope work`, async () => {
    const { cwd, statePath, state, createdCommit } = await createExecuteFinalizationFixture({
      currentScopeNumber: 5,
      phase: 'coder_scope',
      status: 'running',
      derivedPlanPath: null,
      derivedPlanStatus: null,
      derivedFromScopeNumber: null,
      derivedScopeIndex: null,
      splitPlanCountForCurrentScope: 0,
    });

    const nextState = await persistSplitPlanRecovery(
      state,
      statePath,
      {
        sourcePhase: 'coder_scope',
        derivedPlanMarkdown: scenario.payload,
        createdCommits: [createdCommit],
      },
      {
        persistBlockedScope,
        writeExecutionArtifacts,
      },
    );

    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
    await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), /ENOENT/);
    const invalidPayloadArtifact = await readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8');
    assert.match(invalidPayloadArtifact, scenario.errorPattern);
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.derivedPlanPath, null);
    assert.equal(nextState.derivedPlanStatus, null);
    assert.equal(nextState.completedScopes.some((scope) => scope.result === 'blocked'), false);
    assert.equal(nextState.interactiveBlockedRecovery?.sourcePhase, 'coder_scope');
    assert.match(nextState.interactiveBlockedRecovery?.blockedReason ?? '', scenario.errorPattern);

    const events = await readRunEvents(state.runDir);
    });
}

for (const scenario of [
  {
    name: 'optional coder response',
    sourcePhase: 'coder_optional_response',
  },
  {
    name: 'reviewer scope',
    sourcePhase: 'reviewer_scope',
  },
  {
    name: 'plan review',
    sourcePhase: 'reviewer_plan',
  },
] satisfies Array<{
  name: string;
  sourcePhase: SplitPlanRecoverySourcePhase;
}>) {
  test(`persistSplitPlanRecovery terminal-blocks invalid payloads from unsupported ${scenario.name} phases`, async () => {
    await assertTerminalInvalidSplitPlanBlock({
      sourcePhase: scenario.sourcePhase,
    });
  });
}

test('persistSplitPlanRecovery persists valid plan payloads and resets abandoned scope work', async () => {
  const { cwd, statePath, state, baseCommit, createdCommit } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: 'coder_scope',
    status: 'running',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
    splitPlanStartedNotified: false,
  });
  const validPlan = `# Replacement Plan

## Execution Shape

executionShape: multi_scope_unknown

## Execution Loop

### Recurring Scope
- Goal: Complete one bounded replacement slice.
- Verification: \`pnpm typecheck\`
- Success Condition: One replacement slice is complete and reviewable.

## Completion Condition

Stop when the replacement queue is exhausted.
`;

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_scope',
      derivedPlanMarkdown: validPlan,
      createdCommits: [createdCommit],
    },
    {
      persistBlockedScope,
      writeExecutionArtifacts,
    },
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), baseCommit);
  assert.equal(nextState.phase, 'reviewer_plan');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.derivedPlanPath, join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'));
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedFromScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.deepEqual(nextState.createdCommits, []);
  assert.equal(await readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), `${validPlan.trim()}\n`);
  await assert.rejects(readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8'), /ENOENT/);
});

test('persistSplitPlanRecovery clears stale derivedScopeIndex when replacing an active derived scope', async () => {
  const { statePath, state } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'coder_scope',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: 5,
    splitPlanCountForCurrentScope: 2,
    createdCommits: [],
  });

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_scope',
      derivedPlanMarkdown: '## Execution Shape\n\nexecutionShape: multi_scope\n\n## Execution Queue\n\n### Scope 1: Replacement\n- Goal: Replace the stale derived scope.\n- Verification: `pnpm typecheck`\n- Success Condition: Replacement plan is ready for review.\n',
      createdCommits: [],
    },
    {
      persistBlockedScope: async (blockedState) => blockedState,
      writeExecutionArtifacts: async () => {},
    },
  );

  assert.equal(nextState.phase, 'reviewer_plan');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedFromScopeNumber, 6);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.createdCommits.length, 0);
});

test('flush sends derived-plan failure notification for blocked derived-plan review', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 11,
    phase: 'blocked',
    status: 'blocked',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_11.md',
    derivedPlanStatus: 'rejected',
    derivedFromScopeNumber: 11,
    splitPlanBlockedNotified: false,
    completedScopes: [
      {
        number: '11',
        marker: 'AUTONOMY_SPLIT_PLAN',
        result: 'blocked',
        baseCommit: 'abc123',
        finalCommit: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'split-plan recovery failed to converge',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_11.md',
      },
    ],
  });
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  const nextState = await flushDerivedPlanNotifications(state, statePath);
  assert.equal(nextState.splitPlanBlockedNotified, true);
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /derived plan review did not converge/);
});
