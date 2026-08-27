import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import { createInitialState, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';

async function createMinimalStateFixture(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'run-state-provider');
  const planDoc = join(cwd, 'PLAN.md');
  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: {
        planner: { provider: 'openai-codex', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: 'anthropic-claude', model: null },
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
    state,
    statePath: getRunStatePath(runDir),
  };
}

test('state round-trip preserves a fully populated v1 state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-state-roundtrip-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'roundtrip-run');
  const planDoc = join(cwd, 'tmp', 'PLAN.md');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      planDocBackupPath: join(runDir, 'PLAN.backup.md'),
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: {
        planner: { provider: 'openai-codex', model: 'gpt-test-coder', effort: 'high' },
        coder: { provider: 'openai-codex', model: 'gpt-test-coder', effort: 'high' },
        reviewer: { provider: 'anthropic-claude', model: 'claude-test-reviewer', effort: 'xhigh' },
      },
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 7,
    },
    '1111111111111111111111111111111111111111',
  );
  const populatedState: OrchestrationState = {
    ...initialState,
    phase: 'blocked',
    status: 'blocked',
    archivedReviewPath: join(runDir, 'REVIEW-round-2.md'),
    initialBaseCommit: '0000000000000000000000000000000000000000',
    baseCommit: '1111111111111111111111111111111111111111',
    finalCommit: '3333333333333333333333333333333333333333',
    coderSessionHandle: 'coder-session-1',
    coderSessionProtocol: 'structured_json_v1',
    reviewerSessionHandle: 'reviewer-session-1',
    executionShape: 'one_shot',
    currentScopeNumber: 4,
    coderRetryCount: 2,
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Scope 4 execute follow-up',
      newEvidence: 'The latest commit preserves the current execution state.',
      whyNotRedundant: 'This covers a new reviewer finding.',
      nextStepUnlocked: 'Reviewer can re-check the focused fix.',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'replace_plan',
      rationale: 'The current scope shape is no longer converging.',
    },
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Most behavior is implemented, with one follow-on scope remaining.',
      verificationSummary: 'Ran focused provider and orchestrator tests.',
      remainingKnownGaps: ['Whole-plan verification has not run yet.'],
    },
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'One bounded follow-up remains.',
      rationale: 'The final reviewer found one missing verification gate.',
      missingWork: {
        summary: 'Add the missing full-suite verification artifact.',
        requiredOutcome: 'Full verification is present before completion.',
        verification: 'Run pnpm test and pnpm typecheck.',
      },
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'block_for_operator',
    finalCompletionContinueExecutionCount: 2,
    finalCompletionContinueExecutionCapReached: true,
    derivedPlanPath: join(runDir, 'DERIVED_PLAN.md'),
    derivedFromScopeNumber: 3,
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: 2,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: true,
    splitPlanCountForCurrentScope: 2,
    derivedPlanDepth: 1,
    maxDerivedPlanReviewRounds: 6,
    rounds: [
      {
        round: 2,
        reviewerSessionHandle: 'reviewer-session-2',
        reviewedPlanPath: join(runDir, 'DERIVED_PLAN.md'),
        normalizationApplied: true,
        normalizationOperations: ['renumbered scopes'],
        normalizationScopeLabelMappings: [{ normalizedScopeNumber: 1, originalScopeLabel: 'A' }],
        commitRange: {
          base: '1111111111111111111111111111111111111111',
          head: '3333333333333333333333333333333333333333',
        },
        openBlockingCanonicalCount: 1,
        findings: ['R2-F1'],
      },
    ],
    recentBlocks: [
      {
        scopeNumber: 1,
        derivedScopeIndex: null,
        sourcePhase: 'coder_response',
        normalizedKey: 'the provider can emit late background results',
        evidenceFingerprint: 'command failed before tests started',
        count: 1,
        recordedAt: '2026-05-05T22:00:00.000Z',
      },
    ],
    findings: [
      {
        id: 'R2-F1',
        canonicalId: 'C1',
        round: 2,
        source: 'reviewer',
        severity: 'blocking',
        files: ['src/neal/providers/anthropic-claude.ts'],
        claim: 'Late background results can overwrite structured review output.',
        evidence: 'events.ndjson shows a valid structured result followed by an unstructured result.',
        requiredAction: 'Preserve the first structured result for structured rounds.',
        status: 'fixed',
        roundSummary: 'One provider bug was found.',
        coderDisposition: 'Fixed by preserving structured output.',
        coderCommit: '3333333333333333333333333333333333333333',
      },
    ],
    createdCommits: [
      '2222222222222222222222222222222222222222',
      '3333333333333333333333333333333333333333',
    ],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: '0000000000000000000000000000000000000000',
        finalCommit: '2222222222222222222222222222222222222222',
        summary: 'Accepted the initial provider fix.',
        commitSubject: 'Preserve Claude structured results',
        changedFiles: ['src/neal/providers/anthropic-claude.ts'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [
          {
            id: 'R1-F2',
            canonicalId: 'C2',
            status: 'deferred',
            files: ['src/neal/providers/anthropic-claude.ts'],
            claim: 'Provider diagnostics could be clearer.',
            evidence: 'Late results are only visible through raw event logs.',
            requiredAction: 'Consider richer ignored-result diagnostics.',
            coderDisposition: 'Deferred as non-blocking observability work.',
            coderCommit: null,
          },
        ],
        archivedReviewPath: join(runDir, 'REVIEW-scope-1.md'),
        blocker: null,
        derivedFromParentScope: 'parent-1',
        replacedByDerivedPlanPath: join(runDir, 'DERIVED_PARENT.md'),
      },
    ],
    blockedFromPhase: 'final_completion_review',
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [
      {
        enteredAt: '2026-05-05T23:00:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Reviewer found a transition issue.',
        maxTurns: 3,
        lastHandledTurn: 1,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: '2026-05-05T23:01:00.000Z',
            operatorGuidance: 'Keep the recovery narrow.',
            origin: 'operator',
            disposition: null,
          },
        ],
        resolvedAt: '2026-05-05T23:05:00.000Z',
        resolvedByAction: 'resume_current_scope',
        resultPhase: 'coder_response',
      },
    ],
  };
  const statePath = getRunStatePath(runDir);
  const savedState = await saveState(statePath, populatedState);
  const loadedState = await loadState(statePath);

  assert.deepEqual(loadedState, savedState);
});

test('authoredExecutionShape is captured from the seed plan for both plan and execute modes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-state-authored-shape-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'authored-shape-run');
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(
    planDoc,
    `# Seed Plan

## Execution Shape

executionShape: one_shot
`,
    'utf8',
  );

  const initBase = {
    cwd,
    planDoc,
    stateDir,
    runDir,
    allowedDirtyPaths: [] as string[],
    agentConfig: {
      planner: { provider: 'openai-codex', model: null },
      coder: { provider: 'openai-codex', model: null },
      reviewer: { provider: 'anthropic-claude', model: null },
    },
    progressJsonPath: join(runDir, 'plan-progress.json'),
    progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
    reviewMarkdownPath: join(runDir, 'REVIEW.md'),
    recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
    maxRounds: 5,
  };

  const planState = await createInitialState({ ...initBase, topLevelMode: 'plan' }, 'abc123');
  // Plan mode still starts with no adopted shape, but captures the authored one.
  assert.equal(planState.executionShape, null);
  assert.equal(planState.authoredExecutionShape, 'one_shot');

  const executeState = await createInitialState({ ...initBase, topLevelMode: 'execute' }, 'abc123');
  // Execute mode adopts the seed shape and also captures the authored one.
  assert.equal(executeState.executionShape, 'one_shot');
  assert.equal(executeState.authoredExecutionShape, 'one_shot');
});

test('authoredExecutionShape defaults to null when the seed plan is absent and round-trips when set', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-authored-shape-roundtrip-');
  // No seed plan document exists for the minimal fixture, so the captured shape is null.
  assert.equal(state.authoredExecutionShape, null);

  await saveState(statePath, { ...state, authoredExecutionShape: 'one_shot' });
  const loaded = await loadState(statePath);
  assert.equal(loaded.authoredExecutionShape, 'one_shot');

  const rawState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete rawState.authoredExecutionShape;
  await writeFile(statePath, JSON.stringify(rawState, null, 2) + '\n');
  const reloaded = await loadState(statePath);
  assert.equal(reloaded.authoredExecutionShape, null);
});

test('autoSquashOnCompletion round-trips when false and defaults to true for legacy states', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-auto-squash-roundtrip-');
  // New runs default to squash-on-completion unless the init opts out.
  assert.equal(state.autoSquashOnCompletion, true);

  await saveState(statePath, { ...state, autoSquashOnCompletion: false });
  const loaded = await loadState(statePath);
  assert.equal(loaded.autoSquashOnCompletion, false);

  const rawState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete rawState.autoSquashOnCompletion;
  await writeFile(statePath, JSON.stringify(rawState, null, 2) + '\n');
  const reloaded = await loadState(statePath);
  // States persisted before the field existed hydrate to the historical
  // always-squash behavior instead of throwing.
  assert.equal(reloaded.autoSquashOnCompletion, true);
});

test('state hydration treats older accepted squashCommitMessage fields as null', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-squash-message-');
  const acceptedState: OrchestrationState = {
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

  await saveState(statePath, acceptedState);
  const rawState = JSON.parse(await readFile(statePath, 'utf8')) as {
    finalCompletionReviewVerdict: Record<string, unknown>;
  };
  delete rawState.finalCompletionReviewVerdict.squashCommitMessage;
  await writeFile(statePath, JSON.stringify(rawState, null, 2) + '\n');

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.finalCompletionReviewVerdict?.action, 'accept_complete');
  assert.equal(reloadedState.finalCompletionReviewVerdict?.squashCommitMessage, null);
});

test('state hydration discards stored non-accept squashCommitMessage fields', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-non-accept-squash-message-');
  const continueState: OrchestrationState = {
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
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'continue_execution',
    finalCompletionContinueExecutionCount: 1,
  };

  await saveState(statePath, continueState);
  const rawState = JSON.parse(await readFile(statePath, 'utf8')) as {
    finalCompletionReviewVerdict: Record<string, unknown>;
  };
  rawState.finalCompletionReviewVerdict.squashCommitMessage = {
    subject: 'Complete tmp/13_NEAL_FINAL_COMPLETION_STALE_STATUS_RECONCILIATION_PLAN.md',
    bullets: [
      'Persist final completion behavior for the Neal run.',
      'Verify the completed behavior with focused tests.',
    ],
  };
  await writeFile(statePath, JSON.stringify(rawState, null, 2) + '\n');

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.finalCompletionReviewVerdict?.action, 'continue_execution');
  assert.equal(reloadedState.finalCompletionReviewVerdict?.squashCommitMessage, null);
});

test('initial state includes no pending plan-review guidance', async () => {
  const { state } = await createMinimalStateFixture('neal-state-plan-guidance-initial-');

  assert.equal(state.pendingPlanReviewGuidance, null);
});

test('initial state includes no active manual gate', async () => {
  const { state } = await createMinimalStateFixture('neal-state-manual-gate-initial-');

  assert.equal(state.manualGate, null);
});

test('state hydration treats missing manualGate as null', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-manual-gate-');
  await saveState(statePath, state);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete persisted.manualGate;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.manualGate, null);
});

test('state round-trip preserves an active manual gate', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-manual-gate-roundtrip-');
  const { runDir } = state;
  const savedState = await saveState(statePath, {
    ...state,
    phase: 'manual_gate',
    status: 'running',
    blockedFromPhase: null,
    manualGate: {
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
    },
  });

  const loadedState = await loadState(statePath);

  assert.deepEqual(loadedState.manualGate, savedState.manualGate);
  assert.equal(loadedState.phase, 'manual_gate');
  assert.equal(loadedState.status, 'running');
});

test('state hydration treats missing pendingPlanReviewGuidance as null', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-plan-guidance-');
  await saveState(statePath, state);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete persisted.pendingPlanReviewGuidance;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.pendingPlanReviewGuidance, null);
});

test('state round-trip preserves pending plan-review guidance for plan runs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-state-plan-guidance-roundtrip-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'plan-guidance-run');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc: join(cwd, 'PLAN.md'),
      stateDir,
      runDir,
      topLevelMode: 'plan',
      allowedDirtyPaths: [],
      agentConfig: {
        planner: { provider: 'openai-codex', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: 'anthropic-claude', model: null },
      },
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 5,
    },
    '1111111111111111111111111111111111111111',
  );
  const savedState = await saveState(getRunStatePath(runDir), {
    ...initialState,
    phase: 'coder_plan_response',
    pendingPlanReviewGuidance: {
      message: 'Address the reviewer concern with a narrower plan.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T12:00:00.000Z',
    },
  });

  const loadedState = await loadState(getRunStatePath(runDir));

  assert.deepEqual(loadedState.pendingPlanReviewGuidance, savedState.pendingPlanReviewGuidance);
});

test('createInitialState defaults consultantAttemptCount to 0 and resumes as 0 when absent', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-consultant-count-default-');
  assert.equal(state.consultantAttemptCount, 0);

  await saveState(statePath, state);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete persisted.consultantAttemptCount;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);
  assert.equal(loadedState.consultantAttemptCount, 0);
});

test('hydrateFinding tolerantly resolves the plan-review finding class', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-finding-class-');
  // Persist a valid baseline state, then inject a synthetic findings array that
  // exercises each tolerant-read branch via a raw RUN_STATE.json rewrite.
  await saveState(statePath, state);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  const baseFinding = {
    round: 1,
    source: 'reviewer',
    severity: 'blocking',
    files: ['PLAN.md'],
    claim: 'A plan-review finding.',
    requiredAction: 'Do the thing.',
    status: 'open',
    roundSummary: 'Round one summary.',
    coderDisposition: null,
    coderCommit: null,
  };
  persisted.findings = [
    // A recognized class is preserved unchanged.
    { ...baseFinding, id: 'R1-F1', canonicalId: 'C1', findingClass: 'verification_hardening' },
    // A present-but-unknown class coerces to the fail-safe plan_correctness.
    { ...baseFinding, id: 'R1-F2', canonicalId: 'C2', findingClass: 'nice_to_have' },
    // An absent class stays undefined (the field is omitted from the object).
    { ...baseFinding, id: 'R1-F3', canonicalId: 'C3' },
    // An execute-review finding (no class) round-trips with the field still absent.
    {
      ...baseFinding,
      id: 'R1-F4',
      canonicalId: 'C4',
      severity: 'non_blocking',
      source: 'reviewer',
      files: ['src/neal/state.ts'],
      claim: 'An execute-review finding.',
      status: 'fixed',
    },
  ];
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loaded = await loadState(statePath);
  assert.equal(loaded.findings[0].findingClass, 'verification_hardening');
  assert.equal(loaded.findings[1].findingClass, 'plan_correctness');
  assert.equal('findingClass' in loaded.findings[2], false);
  assert.equal('findingClass' in loaded.findings[3], false);
});

test('state hydration accepts advance_parent and rejects unknown reviewer meaningful-progress actions', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-meaningful-progress-action-');
  const savedState = await saveState(statePath, {
    ...state,
    currentScopeMeaningfulProgressVerdict: {
      action: 'advance_parent',
      rationale: 'Prior accepted derived scopes already satisfy the parent objective.',
    },
  });

  const loadedState = await loadState(statePath);
  assert.deepEqual(loadedState.currentScopeMeaningfulProgressVerdict, savedState.currentScopeMeaningfulProgressVerdict);

  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  persisted.currentScopeMeaningfulProgressVerdict = {
    action: 'unknown_parent_action',
    rationale: 'This action is unsupported.',
  };
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  await assert.rejects(
    () => loadState(statePath),
    /currentScopeMeaningfulProgressVerdict\.action: expected one of "accept", "block_for_operator", "replace_plan", "advance_parent", received "unknown_parent_action"/,
  );
});

test('state hydration treats missing coderSessionProtocol with an active handle as legacy marker protocol', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-protocol-');
  await saveState(statePath, {
    ...state,
    coderSessionHandle: 'coder-session-1',
    coderSessionProtocol: 'legacy_marker_v1',
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete persisted.coderSessionProtocol;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.coderSessionProtocol, 'legacy_marker_v1');
});

test('state hydration treats missing coderSessionProtocol without an active handle as null', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-null-protocol-');
  await saveState(statePath, state);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete persisted.coderSessionProtocol;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.coderSessionProtocol, null);
});

test('state hydration migrates pre-upgrade plan-review sessions from coder to planner fields', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-planner-session-');
  await saveState(statePath, {
    ...state,
    topLevelMode: 'plan',
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    coderSessionHandle: 'legacy-plan-session-1',
    coderSessionProtocol: 'structured_json_v1',
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete persisted.plannerSessionHandle;
  delete persisted.plannerSessionProtocol;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.plannerSessionHandle, 'legacy-plan-session-1');
  assert.equal(loadedState.plannerSessionProtocol, 'structured_json_v1');
  assert.equal(loadedState.coderSessionHandle, null);
  assert.equal(loadedState.coderSessionProtocol, null);
});

test('state hydration treats missing planner config as a pre-upgrade coder copy', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-planner-');
  await saveState(statePath, {
    ...state,
    agentConfig: {
      planner: { provider: 'anthropic-claude', model: 'planner-model' },
      coder: { provider: 'openai-codex', model: 'coder-model' },
      reviewer: { provider: 'anthropic-claude', model: null },
    },
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  delete (persisted.agentConfig as Record<string, unknown>).planner;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.deepEqual(loadedState.agentConfig.planner, loadedState.agentConfig.coder);
  assert.deepEqual(loadedState.agentConfig.coder, {
    provider: 'openai-codex',
    model: 'coder-model',
    effort: null,
  });
});

test('state hydration treats a persisted role config lacking effort as null', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-effort-');
  await saveState(statePath, {
    ...state,
    agentConfig: {
      planner: { provider: 'openai-codex', model: 'planner-model', effort: 'high' },
      coder: { provider: 'openai-codex', model: 'coder-model', effort: 'high' },
      reviewer: { provider: 'anthropic-claude', model: null, effort: 'xhigh' },
    },
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  const agentConfig = persisted.agentConfig as Record<string, Record<string, unknown>>;
  delete agentConfig.coder.effort;
  delete agentConfig.reviewer.effort;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.agentConfig.coder.effort, null);
  assert.equal(loadedState.agentConfig.reviewer.effort, null);
  // A persisted effort value is preserved when present.
  assert.equal(loadedState.agentConfig.planner.effort, 'high');
});

test('state hydration rejects invalid persisted provider IDs with registry context', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-invalid-provider-');
  const savedState = await saveState(statePath, state);
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as OrchestrationState;
  persisted.agentConfig.coder.provider = 'missing-provider';
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  await assert.rejects(
    () => loadState(statePath),
    /Invalid run state: invalid agentConfig\.coder\.provider: unsupported provider "missing-provider"; registered providers: openai-codex, anthropic-claude/,
  );
  assert.equal(savedState.agentConfig.coder.provider, 'openai-codex');
});

test('state hydration accepts provider IDs registered through the registry', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-fake-provider-');
  registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: 'fake-state-provider' }));
  try {
    const savedState = await saveState(statePath, {
      ...state,
      agentConfig: {
        planner: { provider: 'fake-state-provider', model: 'fake-coder-model', effort: null },
        coder: { provider: 'fake-state-provider', model: 'fake-coder-model', effort: null },
        reviewer: { provider: 'fake-state-provider', model: 'fake-reviewer-model', effort: null },
      },
    });
    const loadedState = await loadState(statePath);

    assert.deepEqual(loadedState.agentConfig, savedState.agentConfig);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('state hydration defaults a recovery disposition without later-scope fields to no revision', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-later-scope-');
  await saveState(statePath, {
    ...state,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-08-27T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 1,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-08-27T00:01:00.000Z',
          operatorGuidance: 'Keep going.',
          origin: 'operator',
          disposition: {
            recordedAt: '2026-08-27T00:02:00.000Z',
            sessionHandle: 'coder-session-1',
            action: 'stay_blocked',
            summary: 'Still blocked.',
            rationale: 'Need more.',
            blocker: 'Need a decision.',
            replacementPlan: '',
            laterScopeNumber: 0,
            laterScopeBody: '',
            resultingPhase: 'interactive_blocked_recovery',
          },
        },
      ],
    },
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
    interactiveBlockedRecovery: { turns: Array<{ disposition: Record<string, unknown> }> };
  };
  delete persisted.interactiveBlockedRecovery.turns[0].disposition.laterScopeNumber;
  delete persisted.interactiveBlockedRecovery.turns[0].disposition.laterScopeBody;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.interactiveBlockedRecovery?.turns[0]?.disposition?.laterScopeNumber, 0);
  assert.equal(loadedState.interactiveBlockedRecovery?.turns[0]?.disposition?.laterScopeBody, '');
});

test('state hydration treats a recovery turn without an origin marker as unrecorded (null)', async () => {
  const { state, statePath } = await createMinimalStateFixture('neal-state-legacy-turn-origin-');
  await saveState(statePath, {
    ...state,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-08-27T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-08-27T00:01:00.000Z',
          operatorGuidance: 'Keep going.',
          origin: 'operator',
          disposition: null,
        },
      ],
    },
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
    interactiveBlockedRecovery: { turns: Array<Record<string, unknown>> };
  };
  delete persisted.interactiveBlockedRecovery.turns[0].origin;
  await writeFile(statePath, JSON.stringify(persisted, null, 2) + '\n', 'utf8');

  const loadedState = await loadState(statePath);

  assert.equal(loadedState.interactiveBlockedRecovery?.turns[0]?.origin, null);
});
