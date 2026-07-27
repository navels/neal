import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runExecuteFinalizationPhase, runOnePass } from '../src/neal/orchestrator.js';
import { getFinalCompletionReviewArtifactPath } from '../src/neal/final-completion-review.js';
import { createRunLogger } from '../src/neal/logger.js';
import { clearProviderCapabilitiesOverridesForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { notifyScopeAccepted } from '../src/neal/orchestrator/notifications.js';
import { buildStatusSnapshot } from '../src/neal/status.js';
import { runReviewPhase } from '../src/neal/orchestrator/phases/review.js';
import { appendParentCompletionFromAcceptedDerivedScopes, computeNextScopeStateAfterExecuteFinalization, computeNextScopeStateAfterParentAdvance } from '../src/neal/orchestrator/transitions.js';
import { loadState } from '../src/neal/state.js';
import { getScopeReviewerScratchDir } from '../src/neal/storage-paths.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { writeRepoConfig, createResumeFixture, createNotifyCapture, runGit, readRunEvents, createExecuteFinalizationFixture, createEmptyExecuteFinalizationFixture, createParentAdvanceCompletedScopes, createAlreadySatisfiedTopLevelProgress, createAlreadySatisfiedTopLevelCompletedScopes } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-finalization');

test('execute finalization advances to the next derived sub-scope without rolling up the parent', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath } = await createExecuteFinalizationFixture({
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 1,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, 2);
  assert.equal(nextState.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.equal(nextState.derivedPlanStatus, 'accepted');
  assert.equal(nextState.completedScopes.some((scope) => scope.number === '5.1'), true);
  assert.equal(nextState.completedScopes.some((scope) => scope.number === '5'), false);
  const subScope = nextState.completedScopes.find((scope) => scope.number === '5.1');
  assert.equal(subScope?.derivedFromParentScope, '5');
  assert.equal(subScope?.finalCommit, nextState.baseCommit);
  assert.deepEqual(subScope?.changedFiles, ['scope.txt']);
  const directParent = await runGit(state.cwd, 'rev-parse', `${nextState.baseCommit}^`);
  assert.equal(directParent, state.baseCommit);
  const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${state.baseCommit}..${nextState.baseCommit}`);
  assert.equal(squashedCount, '1');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
  assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.1 complete: derived scope work']);
});

test('execute finalization strips scope prefixes from replacement commit messages', async () => {
  const { statePath, state, notifyLogPath } = await createExecuteFinalizationFixture(
    {
      lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    },
    {
      createdCommitMessage: 'Scope 5: Derived scope work',
    },
  );

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(await runGit(state.cwd, 'log', '-1', '--pretty=%s'), 'Derived scope work');
  const completedScope = nextState.completedScopes.find((scope) => scope.number === '5');
  assert.equal(completedScope?.commitSubject, 'Derived scope work');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 5 complete: Derived scope work');
});

test('execute finalization records normalized already-satisfied acceptance rationale in top-level summary', async () => {
  const { statePath, state, cwd } = await createEmptyExecuteFinalizationFixture({
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    currentScopeMeaningfulProgressVerdict: {
      action: 'accept',
      rationale:
        'Accepted top-level already-satisfied scope 4 because prior accepted scope(s) 1, 2.3 already satisfy it. Original reviewer rationale: Accepted scopes 1 and 2.3 already satisfy scope 4.',
    },
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await runExecuteFinalizationPhase(state, statePath, logger);

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  const completedScope = nextState.completedScopes.find((scope) => scope.number === '4');
  assert.match(completedScope?.summary ?? '', /Accepted top-level already-satisfied scope 4/);
  assert.equal(completedScope?.derivedFromParentScope, null);
  assert.equal(completedScope?.replacedByDerivedPlanPath, null);
  assert.deepEqual(completedScope?.changedFiles, []);
  const events = await readRunEvents(state.runDir);
  assert.equal(events.some((event) => event.type === 'execute_finalization.advance_parent'), false);
});

test('execute finalization includes an eligible changed plan document in the final commit tree', async () => {
  const { statePath, state, cwd } = await createExecuteFinalizationFixture({
    allowedDirtyPaths: ['PLAN.md'],
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n\nFinal implementation notes.\n', 'utf8');

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  const finalCommit = nextState.baseCommit;
  assert.ok(finalCommit);
  assert.equal(await runGit(cwd, 'show', `${finalCommit}:PLAN.md`), '# Plan\n\nFinal implementation notes.');
  assert.deepEqual(
    (await runGit(cwd, 'diff', '--name-only', `${state.baseCommit}..${finalCommit}`)).split('\n').sort(),
    ['PLAN.md', 'scope.txt'],
  );
  const completedScope = nextState.completedScopes.find((scope) => scope.number === '5');
  assert.deepEqual([...(completedScope?.changedFiles ?? [])].sort(), ['PLAN.md', 'scope.txt']);
  assert.equal(await runGit(cwd, 'log', '-1', '--pretty=%s'), 'derived scope work');
});

test('plan document finalization records an eligible plan document when it is the only finalization change', async () => {
  const { statePath, state, cwd, createdCommit } = await createEmptyExecuteFinalizationFixture({
    allowedDirtyPaths: ['PLAN.md'],
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });
  await writeFile(join(cwd, 'PLAN.md'), '# Plan\n\nOnly the plan changed.\n', 'utf8');

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  const finalCommit = nextState.baseCommit;
  assert.ok(finalCommit);
  assert.notEqual(finalCommit, createdCommit);
  assert.equal(await runGit(cwd, 'show', `${finalCommit}:PLAN.md`), '# Plan\n\nOnly the plan changed.');
  assert.equal(await runGit(cwd, 'log', '-1', '--pretty=%s'), 'Record Neal plan document');
  const completedScope = nextState.completedScopes.find((scope) => scope.number === '5');
  assert.deepEqual(completedScope?.changedFiles, ['PLAN.md']);
  assert.equal(completedScope?.commitSubject, 'Record Neal plan document');
});

test('ignored plan document finalization leaves tmp plans out of the commit tree', async () => {
  const { statePath, state, cwd } = await createExecuteFinalizationFixture({
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  await writeFile(join(cwd, '.git', 'info', 'exclude'), 'tmp/\n', 'utf8');
  await writeFile(join(cwd, 'tmp', 'PLAN.md'), '# Ignored Plan\n', 'utf8');

  const nextState = await runExecuteFinalizationPhase(
    {
      ...state,
      planDoc: join(cwd, 'tmp', 'PLAN.md'),
      allowedDirtyPaths: ['tmp/PLAN.md'],
    },
    statePath,
  );
  const finalCommit = nextState.baseCommit;
  assert.ok(finalCommit);
  assert.deepEqual(await runGit(cwd, 'diff', '--name-only', `${state.baseCommit}..${finalCommit}`), 'scope.txt');
  await assert.rejects(() => runGit(cwd, 'show', `${finalCommit}:tmp/PLAN.md`));
  const completedScope = nextState.completedScopes.find((scope) => scope.number === '5');
  assert.deepEqual(completedScope?.changedFiles, ['scope.txt']);
});

test('computeNextScopeStateAfterExecuteFinalization advances a non-terminal derived sub-scope', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 1,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    completedScopes: [
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'derived scope work',
        changedFiles: ['src/feature-a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const nextState = computeNextScopeStateAfterExecuteFinalization({
    state,
    finalCommit: 'final-1',
    completedScopes: state.completedScopes,
    archivedReviewPath: '/tmp/review-5.1.md',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, 2);
  assert.equal(nextState.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.equal(nextState.derivedPlanStatus, 'accepted');
  assert.equal(nextState.splitPlanStartedNotified, false);
  assert.equal(nextState.derivedPlanAcceptedNotified, false);
  assert.equal(nextState.splitPlanBlockedNotified, false);
});

test('the consultant budget resets to 0 when advancing into the next top-level scope and the next derived sub-scope', async () => {
  // R2-F1: consultantAttemptCount is a PER-SCOPE budget. An adjudication consumed
  // in one accepted scope must not exhaust the consultant for a later scope, so the
  // counter resets at every scope boundary.

  // Next top-level scope: a continuing multi_scope_unknown plan advances 4 -> 5.
  const topLevelCompletedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '4',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-4',
      commitSubject: 'finish recurring scope 4',
      changedFiles: ['src/loop.ts'],
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-4.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: null,
    },
  ];
  const { state: topLevelState } = await createResumeFixture({
    currentScopeNumber: 4,
    executionShape: 'multi_scope_unknown',
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-1',
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    consultantAttemptCount: 2,
  });
  assert.equal(topLevelState.consultantAttemptCount, 2, 'budget seeded as consumed in the accepted scope');

  const afterTopLevelAdvance = computeNextScopeStateAfterExecuteFinalization({
    state: topLevelState,
    finalCommit: 'final-4',
    completedScopes: topLevelCompletedScopes,
    archivedReviewPath: '/tmp/review-4.md',
  });
  assert.equal(afterTopLevelAdvance.currentScopeNumber, 5, 'advanced into the next top-level scope');
  assert.equal(
    afterTopLevelAdvance.consultantAttemptCount,
    0,
    'the consultant budget resets for the next top-level scope',
  );

  // Next derived sub-scope: an accepted derived plan advances sub-scope 5.1 -> 5.2.
  const { state: derivedState } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 1,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    consultantAttemptCount: 2,
    completedScopes: [
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'derived scope work',
        changedFiles: ['src/feature-a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const afterDerivedAdvance = computeNextScopeStateAfterExecuteFinalization({
    state: derivedState,
    finalCommit: 'final-1',
    completedScopes: derivedState.completedScopes,
    archivedReviewPath: '/tmp/review-5.1.md',
  });
  assert.equal(afterDerivedAdvance.derivedScopeIndex, 2, 'advanced into the next derived sub-scope');
  assert.equal(
    afterDerivedAdvance.consultantAttemptCount,
    0,
    'the consultant budget resets for the next derived sub-scope',
  );
});

test('execute finalization rolls the last derived sub-scope up into the parent scope and resumes parent execution', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath } = await createExecuteFinalizationFixture({
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
    lastScopeMarker: 'AUTONOMY_DONE',
  });

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedFromScopeNumber, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.derivedScopeIndex, null);
  const subScope = nextState.completedScopes.find((scope) => scope.number === '5.2');
  const parentScope = nextState.completedScopes.find((scope) => scope.number === '5');
  assert.equal(subScope?.derivedFromParentScope, '5');
  assert.equal(parentScope?.marker, 'AUTONOMY_SCOPE_DONE');
  assert.equal(parentScope?.replacedByDerivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.equal(parentScope?.finalCommit, subScope?.finalCommit);
  assert.equal(parentScope?.finalCommit, nextState.baseCommit);
  assert.deepEqual(subScope?.changedFiles, ['scope.txt']);
  assert.deepEqual(parentScope?.changedFiles, ['scope.txt']);
  const directParent = await runGit(state.cwd, 'rev-parse', `${nextState.baseCommit}^`);
  assert.equal(directParent, state.baseCommit);
  const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${state.baseCommit}..${nextState.baseCommit}`);
  assert.equal(squashedCount, '1');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
  assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.2 complete: derived scope work']);
});

test('execute finalization preserves an empty derived scope checkpoint commit without attempting a no-op squash', async () => {
  const { statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath } =
    await createEmptyExecuteFinalizationFixture({
      derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
      derivedPlanStatus: 'accepted',
      derivedFromScopeNumber: 5,
      derivedScopeIndex: 1,
      lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    });

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, 2);
  assert.equal(nextState.baseCommit, createdCommit);
  assert.equal(nextState.completedScopes.some((scope) => scope.number === '5.1'), true);
  const subScope = nextState.completedScopes.find((scope) => scope.number === '5.1');
  assert.equal(subScope?.finalCommit, createdCommit);
  assert.deepEqual(subScope?.changedFiles, []);
  const directParent = await runGit(state.cwd, 'rev-parse', `${createdCommit}^`);
  assert.equal(directParent, baseCommit);
  const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${baseCommit}..${createdCommit}`);
  assert.equal(squashedCount, '1');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
  assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.1 complete: empty derived scope checkpoint']);
});

test('parent advance transition appends only the parent record and clears derived execution state', async () => {
  const completedScopes = createParentAdvanceCompletedScopes();
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-parent',
    finalCommit: 'stale-final',
    archivedReviewPath: '/tmp/stale-review.md',
    coderSessionHandle: 'coder-derived-session',
    coderSessionProtocol: 'structured_json_v1',
    reviewerSessionHandle: 'reviewer-derived-session',
    coderRetryCount: 2,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Empty derived checkpoint.',
      newEvidence: 'The parent objective was already satisfied.',
      whyNotRedundant: 'This checkpoint should retire the parent.',
      nextStepUnlocked: 'Top-level execution can continue.',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'advance_parent',
      rationale: 'Prior derived work satisfies parent scope 5.',
    },
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'stale',
      verificationSummary: 'stale',
      remainingKnownGaps: ['stale'],
    },
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'stale',
      rationale: 'stale',
      missingWork: null,
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'block_for_operator',
    finalCompletionContinueExecutionCapReached: true,
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 3,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: true,
    splitPlanCountForCurrentScope: 2,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-derived-session',
        reviewedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'base-parent', head: 'head-parent' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    recentBlocks: [],
    findings: [],
    createdCommits: ['empty-derived-commit'],
    completedScopes,
    blockedFromPhase: 'reviewer_scope',
  });

  const parentCompletedScopes = appendParentCompletionFromAcceptedDerivedScopes({
    state,
    finalCommit: 'base-parent',
    archivedReviewPath: '/tmp/review-parent.md',
  });
  const nextState = computeNextScopeStateAfterParentAdvance({
    state,
    finalCommit: 'base-parent',
    completedScopes: parentCompletedScopes,
  });

  assert.equal(parentCompletedScopes.some((scope) => scope.number === '5.3'), false);
  const parentScope = parentCompletedScopes.find((scope) => scope.number === '5');
  assert.equal(parentScope?.marker, 'AUTONOMY_SCOPE_DONE');
  assert.equal(parentScope?.commitSubject, 'Parent scope 5 complete via derived plan');
  assert.equal(parentScope?.replacedByDerivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.deepEqual(parentScope?.changedFiles, ['src/parent.ts', 'src/shared.ts']);
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(nextState.baseCommit, 'base-parent');
  assert.equal(nextState.finalCommit, null);
  assert.equal(nextState.archivedReviewPath, null);
  assert.equal(nextState.coderSessionHandle, null);
  assert.equal(nextState.coderSessionProtocol, null);
  assert.equal(nextState.reviewerSessionHandle, null);
  assert.equal(nextState.coderRetryCount, 0);
  assert.equal(nextState.currentScopeProgressJustification, null);
  assert.equal(nextState.currentScopeMeaningfulProgressVerdict, null);
  assert.equal(nextState.finalCompletionSummary, null);
  assert.equal(nextState.finalCompletionReviewVerdict, null);
  assert.equal(nextState.finalCompletionResolvedAction, null);
  assert.equal(nextState.finalCompletionContinueExecutionCapReached, false);
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedFromScopeNumber, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.splitPlanStartedNotified, false);
  assert.equal(nextState.derivedPlanAcceptedNotified, false);
  assert.equal(nextState.splitPlanBlockedNotified, false);
  assert.equal(nextState.splitPlanCountForCurrentScope, 0);
  assert.deepEqual(nextState.rounds, []);
  assert.deepEqual(nextState.findings, []);
  assert.deepEqual(nextState.createdCommits, []);
  assert.equal(nextState.blockedFromPhase, null);
});

test('execute finalization advances parent and drops a Neal-owned empty derived range', async () => {
  const completedScopes = createParentAdvanceCompletedScopes();
  const { statePath, state, cwd, baseCommit, createdCommit, notifyLogPath } =
    await createEmptyExecuteFinalizationFixture({
      derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
      derivedPlanStatus: 'accepted',
      derivedFromScopeNumber: 5,
      derivedScopeIndex: 3,
      lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
      reviewerSessionHandle: 'reviewer-advance-parent',
      currentScopeMeaningfulProgressVerdict: {
        action: 'advance_parent',
        rationale: 'Prior accepted derived work already satisfies parent scope 5.',
      },
      completedScopes,
    });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await runExecuteFinalizationPhase(state, statePath, logger);

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), baseCommit);
  await assert.rejects(() => runGit(cwd, 'merge-base', '--is-ancestor', createdCommit, 'HEAD'));
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(nextState.baseCommit, baseCommit);
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedFromScopeNumber, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.currentScopeMeaningfulProgressVerdict, null);
  assert.deepEqual(nextState.createdCommits, []);
  assert.equal(nextState.completedScopes.some((scope) => scope.number === '5.3'), false);
  const parentScope = nextState.completedScopes.find((scope) => scope.number === '5');
  assert.equal(parentScope?.finalCommit, baseCommit);
  assert.equal(parentScope?.commitSubject, 'Parent scope 5 complete via derived plan');
  assert.equal(parentScope?.replacedByDerivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.deepEqual(parentScope?.changedFiles, ['src/parent.ts', 'src/shared.ts']);

  const archivedReview = await readFile(join(state.runDir, `REVIEW-${baseCommit}.md`), 'utf8');
  assert.match(archivedReview, /advance_parent/);
  const events = await readRunEvents(state.runDir);
  const advanceEvent = events.find((event) => event.type === 'execute_finalization.advance_parent');
  assert.ok(advanceEvent);
  assert.equal(advanceEvent.data?.parentScopeLabel, '5');
  assert.equal(advanceEvent.data?.currentScopeLabel, '5.3');
  assert.equal(advanceEvent.data?.droppedCommitCount, 1);
  assert.equal(advanceEvent.data?.finalParentCommit, baseCommit);
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 5 complete: Parent scope 5 complete via derived plan');
});

test('repeated empty derived fallback advances parent end to end without blocked recovery', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    ...createParentAdvanceCompletedScopes('3'),
    {
      number: '3.6',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-derived-6',
      finalCommit: 'final-derived-6',
      summary: 'Repeated empty verification checkpoint.',
      commitSubject: 'empty derived verification 2',
      changedFiles: [],
      reviewRounds: 1,
      findings: 0,
      residualReviewDebt: [],
      archivedReviewPath: '/tmp/review-derived-6.md',
      blocker: null,
      derivedFromParentScope: '3',
      replacedByDerivedPlanPath: null,
    },
  ];
  const { statePath, state, cwd, baseCommit, createdCommit } =
    await createEmptyExecuteFinalizationFixture({
      currentScopeNumber: 3,
      phase: 'reviewer_scope',
      status: 'running',
      executionShape: 'multi_scope',
      derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
      derivedPlanStatus: 'accepted',
      derivedFromScopeNumber: 3,
      derivedScopeIndex: 7,
      lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
      currentScopeProgressJustification: {
        milestoneTargeted: 'Verify the completed parent objective.',
        newEvidence: 'The active derived scope produced only an empty checkpoint commit.',
        whyNotRedundant: 'Prior accepted derived work already changed the parent files.',
        nextStepUnlocked: 'The parent objective can retire and top-level scope 4 can start.',
      },
      completedScopes,
    });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(dirname(state.runDir)),
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
            sessionHandle: 'reviewer-repeated-empty-fallback',
            structured: {
              summary: 'The parent objective is complete and the active derived checkpoint is empty.',
              findings: [],
              meaningfulProgressAction: 'block_for_operator',
              meaningfulProgressRationale:
                'The parent is complete, but the current empty checkpoint adds no new work.',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const reviewedState = await runReviewPhase(state, statePath, logger);
    assert.equal(reviewedState.phase, 'execute_finalization');
    assert.equal(reviewedState.status, 'running');
    assert.equal(reviewedState.currentScopeMeaningfulProgressVerdict?.action, 'advance_parent');
    assert.equal(reviewedState.interactiveBlockedRecovery, null);

    const finalState = await runExecuteFinalizationPhase(reviewedState, statePath, logger);
    assert.equal(finalState.phase, 'coder_scope');
    assert.equal(finalState.status, 'running');
    assert.equal(finalState.currentScopeNumber, 4);
    assert.equal(finalState.derivedPlanPath, null);
    assert.equal(finalState.derivedFromScopeNumber, null);
    assert.equal(finalState.derivedPlanStatus, null);
    assert.equal(finalState.derivedScopeIndex, null);
    assert.equal(finalState.interactiveBlockedRecovery, null);
    assert.equal(finalState.currentScopeMeaningfulProgressVerdict, null);
    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), baseCommit);
    await assert.rejects(() => runGit(cwd, 'merge-base', '--is-ancestor', createdCommit, 'HEAD'));

    const parentScope = finalState.completedScopes.find((scope) => scope.number === '3');
    assert.equal(parentScope?.result, 'accepted');
    assert.equal(parentScope?.summary?.includes('advance_parent'), true);
    assert.deepEqual(parentScope?.changedFiles, ['src/parent.ts', 'src/shared.ts']);
    assert.equal(finalState.completedScopes.some((scope) => scope.number === '3.7'), false);

    const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /- Number: 4/);
    assert.match(progressMarkdown, /advance_parent accepted parent scope 3/);
    assert.match(progressMarkdown, /Parent scope 3 complete via derived plan/);
    assert.doesNotMatch(progressMarkdown, /### Scope 3\.7/);
    assert.doesNotMatch(progressMarkdown, /## Interactive Blocked Recovery/);

    const progressJson = JSON.parse(await readFile(state.progressJsonPath, 'utf8')) as {
      currentScope: { number: string; derivedPlanPath: string | null } | null;
      completedScopes: OrchestrationState['completedScopes'];
      interactiveBlockedRecovery: unknown;
    };
    assert.equal(progressJson.currentScope?.number, '4');
    assert.equal(progressJson.currentScope?.derivedPlanPath, null);
    assert.equal(progressJson.interactiveBlockedRecovery, null);
    const progressParentScope = progressJson.completedScopes.find((scope) => scope.number === '3');
    assert.equal(progressParentScope?.summary?.includes('advance_parent'), true);
    assert.equal(progressJson.completedScopes.some((scope) => scope.number === '3.7'), false);

    const reviewMarkdown = await readFile(state.reviewMarkdownPath, 'utf8');
    assert.match(reviewMarkdown, /## Latest Completed Scope/);
    assert.match(reviewMarkdown, /advance_parent accepted parent scope 3/);
    assert.match(reviewMarkdown, /Scope: 3/);

    const archivedReview = await readFile(join(state.runDir, `REVIEW-${baseCommit}.md`), 'utf8');
    assert.match(archivedReview, /Reviewer action: advance_parent/);
    assert.match(archivedReview, /Deterministic redundant-empty-derived-scope fallback/);

    const narrativeMarkdown = await readFile(join(state.runDir, 'RUN_NARRATIVE.md'), 'utf8');
    assert.match(narrativeMarkdown, /advance_parent completed parent scope 3/);
    const snapshot = await buildStatusSnapshot({ cwd, statePath });
    assert.match(snapshot.lastMeaningfulEvent?.summary ?? '', /advance_parent completed parent scope 3/);

    const events = await readRunEvents(state.runDir);
    const reviewAdvanceEvent = events.find((event) => event.type === 'review.meaningful_progress.advance_parent');
    assert.equal(reviewAdvanceEvent?.data?.source, 'fallback');
    assert.equal(reviewAdvanceEvent?.data?.priorEmptyCount, 2);
    const finalizationAdvanceEvent = events.find((event) => event.type === 'execute_finalization.advance_parent');
    assert.equal(finalizationAdvanceEvent?.data?.droppedCommitCount, 1);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unsafe explicit parent advancement enters blocked recovery without resetting changed work', async () => {
  const { statePath, state, cwd, createdCommit } = await createExecuteFinalizationFixture({
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 3,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Attempt unsafe parent advancement.',
      newEvidence: 'The current derived range contains real file changes.',
      whyNotRedundant: 'This should prove explicit advance_parent still respects safety gates.',
      nextStepUnlocked: 'Unsafe parent advancement should block before finalization.',
    },
    completedScopes: createParentAdvanceCompletedScopes(),
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(dirname(state.runDir)),
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
            sessionHandle: 'reviewer-unsafe-explicit-advance',
            structured: {
              summary: 'The reviewer incorrectly asks to advance the parent despite a non-empty diff.',
              findings: [],
              meaningfulProgressAction: 'advance_parent',
              meaningfulProgressRationale: 'The parent should advance even though the current diff is non-empty.',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath, logger);
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.blockedFromPhase, 'reviewer_scope');
    assert.equal(nextState.interactiveBlockedRecovery?.sourcePhase, 'reviewer_scope');
    assert.match(nextState.interactiveBlockedRecovery?.blockedReason ?? '', /Unsafe advance_parent/);
    assert.match(nextState.currentScopeMeaningfulProgressVerdict?.rationale ?? '', /current scope changed-file list is not empty/);
    assert.equal(nextState.currentScopeMeaningfulProgressVerdict?.action, 'block_for_operator');
    assert.equal(nextState.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
    assert.equal(nextState.completedScopes.some((scope) => scope.number === '5'), false);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('parent advancement finalization rejects empty commits missing from createdCommits before mutation', async () => {
  const { statePath, state, cwd, createdCommit } = await createEmptyExecuteFinalizationFixture({
    currentScopeMeaningfulProgressVerdict: {
      action: 'advance_parent',
      rationale: 'Prior accepted derived work already satisfies parent scope 5.',
    },
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 3,
    completedScopes: createParentAdvanceCompletedScopes(),
    createdCommits: [],
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  await assert.rejects(
    () => runExecuteFinalizationPhase(state, statePath, logger),
    /current range commits do not exactly match Neal-created commits/,
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  const persisted = await loadState(statePath);
  assert.equal(persisted.phase, 'execute_finalization');
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.equal(persisted.derivedFromScopeNumber, 5);
  assert.equal(persisted.derivedPlanStatus, 'accepted');
  assert.equal(persisted.derivedScopeIndex, 3);
  assert.equal(persisted.currentScopeMeaningfulProgressVerdict?.action, 'advance_parent');
  assert.equal(persisted.completedScopes.some((scope) => scope.number === '5'), false);
});

test('parent advancement finalization rejects dirty worktrees before resetting empty derived ranges', async () => {
  const { statePath, state, cwd, createdCommit } = await createEmptyExecuteFinalizationFixture({
    allowedDirtyPaths: [],
    currentScopeMeaningfulProgressVerdict: {
      action: 'advance_parent',
      rationale: 'Prior accepted derived work already satisfies parent scope 5.',
    },
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 3,
    completedScopes: createParentAdvanceCompletedScopes(),
  });
  const trackedFile = join(cwd, 'scope.txt');
  await writeFile(trackedFile, 'base\nlocal dirty change\n', 'utf8');
  const logger = await createRunLogger({
    cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  await assert.rejects(
    () => runExecuteFinalizationPhase(state, statePath, logger),
    /Cannot finalize with a dirty worktree:[\s\S]*M scope\.txt/,
  );

  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  assert.match(await runGit(cwd, 'status', '--short'), /M scope\.txt/);
  assert.match(await readFile(trackedFile, 'utf8'), /local dirty change/);
  const persisted = await loadState(statePath);
  assert.equal(persisted.phase, 'execute_finalization');
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.equal(persisted.currentScopeMeaningfulProgressVerdict?.action, 'advance_parent');
  assert.equal(persisted.completedScopes.some((scope) => scope.number === '5'), false);
});

test('notifyScopeAccepted includes total scope count when the execution plan is a valid multi-scope doc', async () => {
  const { cwd, state } = await createResumeFixture({
    currentScopeNumber: 2,
  });
  const multiScopePlan = [
    '# Example Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: First',
    '- Goal: Do the first thing.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: First thing done.',
    '',
    '### Scope 2: Second',
    '- Goal: Do the second thing.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: Second thing done.',
    '',
    '### Scope 3: Third',
    '- Goal: Do the third thing.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: Third thing done.',
    '',
  ].join('\n');
  await writeFile(state.planDoc, multiScopePlan, 'utf8');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  await notifyScopeAccepted(state, 'wire up scope 2');

  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 2/3 complete: wire up scope 2');
});

test('notifyScopeAccepted falls back to scope label alone when the plan cannot be validated', async () => {
  const { cwd, state } = await createResumeFixture({
    currentScopeNumber: 1,
  });
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  await notifyScopeAccepted(state, 'scope 1 work');

  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 1 complete: scope 1 work');
});

test('notifyScopeAccepted omits unknown totals for recurring unknown-total plans', async () => {
  const { cwd, state } = await createResumeFixture({
    currentScopeNumber: 2,
    executionShape: 'multi_scope_unknown',
  });
  await writeFile(
    state.planDoc,
    [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope_unknown',
      '',
      '## Execution Loop',
      '',
      '### Recurring Scope',
      '- Goal: Ship one recurring slice.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: One bounded slice is done.',
      '',
      '## Completion Condition',
      '',
      'The backlog is fully drained.',
      '',
    ].join('\n'),
    'utf8',
  );
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  await notifyScopeAccepted(state, 'ship another recurring slice');

  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 2 complete: ship another recurring slice');
});

test('execute finalization tolerates configured dirty paths', async () => {
  const { statePath, state, notifyLogPath, cwd } = await createExecuteFinalizationFixture({
    allowedDirtyPaths: ['FEEDBACK-DERIVED_PLAN.md'],
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the terminal scope before finalization.',
      verificationSummary: 'Pre-recorded summary for terminal execute-finalization coverage.',
      remainingKnownGaps: [],
    },
  });
  const strayFile = join(cwd, 'FEEDBACK-DERIVED_PLAN.md');
  await writeFile(strayFile, 'local notes\n', 'utf8');

  const nextState = await runExecuteFinalizationPhase(state, statePath);
  assert.equal(nextState.phase, 'final_completion_review');
  assert.equal(nextState.status, 'running');
  assert.deepEqual(nextState.allowedDirtyPaths, ['FEEDBACK-DERIVED_PLAN.md']);
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 5 complete: derived scope work');
});

test('execute finalization rejects dirty paths outside the configured allowlist', async () => {
  const { statePath, state, cwd } = await createExecuteFinalizationFixture({
    allowedDirtyPaths: ['PLAN.md'],
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the terminal scope before finalization.',
      verificationSummary: 'Pre-recorded summary for terminal execute-finalization coverage.',
      remainingKnownGaps: [],
    },
  });
  const strayFile = join(cwd, 'FEEDBACK-DERIVED_PLAN.md');
  await writeFile(strayFile, 'local notes\n', 'utf8');

  await assert.rejects(
    () => runExecuteFinalizationPhase(state, statePath),
    /Cannot finalize with a dirty worktree:[\s\S]*FEEDBACK-DERIVED_PLAN\.md/,
  );
});

test('execute finalization tolerates reviewer scratch under the run directory', async () => {
  const { statePath, state, cwd } = await createExecuteFinalizationFixture({
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });
  const scratchFile = join(getScopeReviewerScratchDir(state.runDir, '5', 1), 'log.txt');
  await mkdir(dirname(scratchFile), { recursive: true });
  await writeFile(scratchFile, 'temporary reviewer log\n', 'utf8');

  const nextState = await runExecuteFinalizationPhase(state, statePath);

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(await readFile(scratchFile, 'utf8'), 'temporary reviewer log\n');
  assert.doesNotMatch(await runGit(cwd, 'status', '--short'), /scratch/);
});

test('execute finalization blocks root scratch leakage and leaves it untouched', async () => {
  const { statePath, state, cwd, createdCommit } = await createExecuteFinalizationFixture({
    lastScopeMarker: 'AUTONOMY_DONE',
  });
  const buildReviewDir = join(cwd, 'build_review');
  const buildReviewLog = join(buildReviewDir, 'log.txt');
  await mkdir(buildReviewDir, { recursive: true });
  await writeFile(buildReviewLog, 'temporary reviewer log\n', 'utf8');
  const stateWithReviewRound: OrchestrationState = {
    ...state,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-1',
        reviewedPlanPath: null,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: {
          base: state.baseCommit!,
          head: createdCommit,
        },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
  };

  await assert.rejects(
    () => runExecuteFinalizationPhase(stateWithReviewRound, statePath),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Cannot finalize with a dirty worktree:[\s\S]*build_review\//);
      assert.match(error.message, /Likely Neal reviewer scratch leakage detected/);
      assert.match(error.message, /\.neal\/runs\/test-run\/scratch\/reviewer-scope-5-round-1/);
      assert.match(error.message, /\.neal\/runs\/test-run\/scratch\/final-completion-review/);
      return true;
    },
  );

  assert.equal(await readFile(buildReviewLog, 'utf8'), 'temporary reviewer log\n');
  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), createdCommit);
  assert.match(await runGit(cwd, 'status', '--short'), /\?\? build_review\//);
});

test('execute finalization routes terminal execution into final completion review instead of completing immediately', async () => {
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'coder-final-completion-1',
            structured: {
              planGoalSatisfied: true,
              whatChangedOverall: 'Completed the terminal scope and assembled the whole-plan packet.',
              verificationSummary: 'Ran execute-finalization coverage with the current repository state.',
              remainingKnownGaps: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { statePath, state, notifyLogPath } = await createExecuteFinalizationFixture({
      lastScopeMarker: 'AUTONOMY_DONE',
    });

    const nextState = await runExecuteFinalizationPhase(state, statePath);
    assert.equal(nextState.phase, 'final_completion_review');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.finalCompletionSummary?.planGoalSatisfied, true);
    assert.equal(nextState.finalCommit !== null, true);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /# Final Completion Review/);
    assert.match(completionArtifact, /## Coder Completion Summary/);
    assert.match(completionArtifact, /Completed the terminal scope and assembled the whole-plan packet\./);
    assert.match(completionArtifact, /## Reviewer Verdict/);
    assert.match(completionArtifact, /Pending\./);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 5 complete: derived scope work');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
