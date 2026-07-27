import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecuteFinalizationPhase } from '../src/neal/orchestrator.js';
import { getExecuteReviewBlockReason, getOpenBlockingCanonicalSet, hasRepeatedUnresolvedBlockingCanonicals, resolveExecuteAdjudicationContext, resolveExecuteReviewDisposition, synthesizeExecuteResponseState, synthesizeExecuteReviewerState } from '../src/neal/adjudicator/execute.js';
import { assertAdjudicationTransitionSignal, getAdjudicationSpec } from '../src/neal/adjudicator/specs.js';
import { buildFinalCompletionPacket } from '../src/neal/final-completion.js';
import { createRunLogger } from '../src/neal/logger.js';
import { clearProviderCapabilitiesOverridesForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { NealProviderError, type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { writeExecutionArtifacts } from '../src/neal/orchestrator/artifacts.js';
import { buildStatusSnapshot } from '../src/neal/status.js';
import { runReviewPhase } from '../src/neal/orchestrator/phases/review.js';
import { appendCompletedScope, computeNextScopeStateAfterExecuteFinalization } from '../src/neal/orchestrator/transitions.js';
import { renderPlanProgressMarkdown } from '../src/neal/progress.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { getRecentAcceptedScopesForParentObjective, renderRecentAcceptedScopesSummary } from '../src/neal/scopes.js';
import { loadState } from '../src/neal/state.js';
import type { OrchestrationState, ReviewFinding, ReviewerMeaningfulProgressVerdict } from '../src/neal/types.js';
import { createResumeFixture, createOpenPlanReviewFinding, readRunEvents, createEmptyExecuteFinalizationFixture, createParentAdvanceCompletedScopes, createAlreadySatisfiedTopLevelProgress, createAlreadySatisfiedTopLevelCompletedScopes, createCanonicalStucknessRound, createStucknessCwd } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-review');

test('computeNextScopeStateAfterExecuteFinalization rolls up the last derived sub-scope into the parent scope', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '5.2',
      marker: 'AUTONOMY_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-2',
      commitSubject: 'derived scope work',
      changedFiles: ['src/feature-a.ts'],
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-5.2.md',
      blocker: null,
      derivedFromParentScope: '5',
      replacedByDerivedPlanPath: null,
    },
    {
      number: '5',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-2',
      commitSubject: 'derived scope work',
      changedFiles: ['src/feature-a.ts'],
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-5.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    },
  ];
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
    lastScopeMarker: 'AUTONOMY_DONE',
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
  });

  const nextState = computeNextScopeStateAfterExecuteFinalization({
    state,
    finalCommit: 'final-2',
    completedScopes,
    archivedReviewPath: '/tmp/review-5.2.md',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(nextState.baseCommit, 'final-2');
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedFromScopeNumber, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.splitPlanCountForCurrentScope, 0);
  assert.deepEqual(nextState.completedScopes, completedScopes);
});

test('computeNextScopeStateAfterExecuteFinalization keeps recurring unknown-total plans advancing one scope at a time', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
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
  const { state } = await createResumeFixture({
    currentScopeNumber: 4,
    executionShape: 'multi_scope_unknown',
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-1',
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });

  const nextState = computeNextScopeStateAfterExecuteFinalization({
    state,
    finalCommit: 'final-4',
    completedScopes,
    archivedReviewPath: '/tmp/review-4.md',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.baseCommit, 'final-4');
  assert.deepEqual(nextState.completedScopes, completedScopes);
});

test('computeNextScopeStateAfterExecuteFinalization routes one-shot AUTONOMY_SCOPE_DONE into final completion review without inventing a new scope', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '1',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-1',
      commitSubject: 'finish one-shot implementation',
      changedFiles: ['src/one-shot.ts'],
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-1.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: null,
    },
  ];
  const { state } = await createResumeFixture({
    currentScopeNumber: 1,
    executionShape: 'one_shot',
    phase: 'execute_finalization',
    status: 'running',
    baseCommit: 'base-1',
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });

  const nextState = computeNextScopeStateAfterExecuteFinalization({
    state,
    finalCommit: 'final-1',
    completedScopes,
    archivedReviewPath: '/tmp/review-1.md',
  });

  assert.equal(nextState.phase, 'final_completion_review');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 1);
  assert.equal(nextState.finalCommit, 'final-1');
  assert.deepEqual(nextState.completedScopes, completedScopes);
});

test('review and progress reports expose derived-plan audit linkage', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'reviewer_plan',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-1',
        reviewedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
        normalizationApplied: true,
        normalizationOperations: ['Normalized execution queue header `## Ordered Derived Scopes` to `## Execution Queue`.'],
        normalizationScopeLabelMappings: [{ normalizedScopeNumber: 1, originalScopeLabel: '6.6A' }],
        commitRange: {
          base: 'abc123',
          head: 'abc123',
        },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    completedScopes: [
      {
        number: '3',
        marker: 'AUTONOMY_BLOCKED',
        result: 'blocked',
        baseCommit: 'abc123',
        finalCommit: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 2,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'split-plan recovery failed to converge',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
      },
    ],
  });

  const reviewMarkdown = renderReviewMarkdown(state);
  const progressMarkdown = renderPlanProgressMarkdown(state);

  assert.match(reviewMarkdown, /Review target: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
  assert.match(reviewMarkdown, /Last reviewed artifact: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
  assert.match(reviewMarkdown, /### Round 1/);
  assert.match(reviewMarkdown, /Reviewed artifact: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
  assert.match(reviewMarkdown, /Normalization: Normalized execution queue header/);
  assert.match(reviewMarkdown, /Scope label mappings: 6\.6A -> 1/);
  assert.match(reviewMarkdown, /Derived from scope: 3/);
  assert.match(reviewMarkdown, /Discarded WIP artifact: .*SCOPE_3_DISCARDED\.diff/);
  assert.match(reviewMarkdown, /## Adjudication Contract/);
  assert.match(reviewMarkdown, /- Adjudication spec id: derived_plan_review/);
  assert.match(reviewMarkdown, /- Adjudication family: plan_review/);
  assert.match(reviewMarkdown, /- Allowed transition outcomes: accept_derived_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(progressMarkdown, /## Adjudication Contract/);
  assert.match(progressMarkdown, /- Adjudication spec id: derived_plan_review/);
  assert.match(progressMarkdown, /Parent scope: none/);
  assert.match(progressMarkdown, /Replaced by derived plan: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
});

test('writeExecutionArtifacts persists narrative artifacts and emits update events only on content changes', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'coder_scope',
    status: 'running',
    executionShape: 'multi_scope',
  });

  await writeExecutionArtifacts(state);

  const narrativeJsonPath = join(state.runDir, 'RUN_NARRATIVE.json');
  const narrativeMarkdownPath = join(state.runDir, 'RUN_NARRATIVE.md');
  const firstJson = JSON.parse(await readFile(narrativeJsonPath, 'utf8')) as {
    headline: string;
    run: { currentScopeNumber: number | null; status: string | null };
    sourceDigest?: string;
  };
  const firstMarkdown = await readFile(narrativeMarkdownPath, 'utf8');
  let events = await readRunEvents(state.runDir);

  assert.equal(firstJson.run.currentScopeNumber, 2);
  assert.equal(firstJson.run.status, 'running');
  assert.equal(typeof firstJson.sourceDigest, 'string');
  assert.match(firstMarkdown, /# Run Narrative/);
  assert.ok(firstMarkdown.includes(firstJson.headline));
  assert.equal(events.filter((event) => event.type === 'narrative.updated').length, 1);

  await writeExecutionArtifacts(state);
  events = await readRunEvents(state.runDir);
  assert.equal(events.filter((event) => event.type === 'narrative.updated').length, 1);

  await writeExecutionArtifacts({
    ...state,
    phase: 'done',
    status: 'done',
    finalCommit: 'final-commit',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Finished the execution plan.',
      verificationSummary: 'pnpm typecheck passed.',
      remainingKnownGaps: [],
    },
  });
  events = await readRunEvents(state.runDir);
  const finalJson = JSON.parse(await readFile(narrativeJsonPath, 'utf8')) as { run: { status: string | null } };
  assert.equal(finalJson.run.status, 'done');
  assert.equal(events.filter((event) => event.type === 'narrative.updated').length, 2);
});

test('recent accepted scope history for a parent objective keeps oldest-first order within the bounded window', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 9,
    completedScopes: [
      {
        number: '3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-3',
        finalCommit: 'final-3',
        commitSubject: 'scope 3',
        changedFiles: ['src/3.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-3.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-1',
        finalCommit: 'final-5-1',
        commitSubject: 'scope 5.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-2',
        finalCommit: 'final-5-2',
        commitSubject: 'scope 5.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.2.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-3',
        finalCommit: 'final-5-3',
        commitSubject: 'scope 5.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.3.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.4',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-4',
        finalCommit: 'final-5-4',
        commitSubject: 'scope 5.4',
        changedFiles: ['src/shared.ts', 'src/d.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.4.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.5',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-5',
        finalCommit: 'final-5-5',
        commitSubject: 'scope 5.5',
        changedFiles: ['src/shared.ts', 'src/e.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.5.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5',
        finalCommit: 'final-5',
        commitSubject: 'rolled-up scope 5',
        changedFiles: ['src/shared.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
      },
      {
        number: '5.6',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'blocked',
        baseCommit: 'base-5-6',
        finalCommit: null,
        commitSubject: null,
        changedFiles: ['src/shared.ts'],
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'blocked scope',
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const recentHistory = getRecentAcceptedScopesForParentObjective(state, '5');
  assert.deepEqual(recentHistory.map((scope) => scope.number), ['5.1', '5.2', '5.3', '5.4', '5.5']);
  assert.deepEqual(recentHistory.map((scope) => scope.changedFiles), [
    ['src/shared.ts', 'src/a.ts'],
    ['src/shared.ts', 'src/b.ts'],
    ['src/shared.ts', 'src/c.ts'],
    ['src/shared.ts', 'src/d.ts'],
    ['src/shared.ts', 'src/e.ts'],
  ]);
  assert.deepEqual(
    state.completedScopes.find((scope) => scope.number === '5')?.changedFiles,
    ['src/shared.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
  );
});

test('loadState rejects completed scopes missing required current fields', async () => {
  const { statePath, state } = await createResumeFixture({
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'abc123',
        finalCommit: 'def456',
        summary: null,
        commitSubject: 'current scope',
        changedFiles: ['src/current.ts'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const missingTopLevelField = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  delete missingTopLevelField.planDocBackupPath;
  await writeFile(statePath, `${JSON.stringify(missingTopLevelField, null, 2)}\n`, 'utf8');
  await assert.rejects(() => loadState(statePath), /invalid planDocBackupPath: missing required field/);

  const missingCompletedScopeField = JSON.parse(JSON.stringify(state)) as {
    completedScopes: Record<string, unknown>[];
  };
  delete missingCompletedScopeField.completedScopes[0].changedFiles;
  await writeFile(statePath, `${JSON.stringify(missingCompletedScopeField, null, 2)}\n`, 'utf8');
  await assert.rejects(() => loadState(statePath), /invalid completedScopes\[0\]\.changedFiles: missing required field/);

  const missingResidualDebtField = JSON.parse(JSON.stringify(state)) as {
    completedScopes: Record<string, unknown>[];
  };
  delete missingResidualDebtField.completedScopes[0].residualReviewDebt;
  await writeFile(statePath, `${JSON.stringify(missingResidualDebtField, null, 2)}\n`, 'utf8');
  await assert.rejects(
    () => loadState(statePath),
    /invalid completedScopes\[0\]\.residualReviewDebt: missing required field/,
  );
});

test('recent accepted scope summary surfaces repeated hotspot churn for the parent objective', async () => {
  const { state } = await createResumeFixture({
    completedScopes: [
      {
        number: '5.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-2',
        finalCommit: 'final-5-2',
        commitSubject: 'scope 5.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.2.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-3',
        finalCommit: 'final-5-3',
        commitSubject: 'scope 5.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.3.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const summary = renderRecentAcceptedScopesSummary(state, '5');
  assert.match(summary, /Accepted scope history for parent objective 5/);
  assert.match(summary, /Scope 5\.2/);
  assert.match(summary, /Scope 5\.3/);
  assert.match(summary, /Touched-file concentration: src\/shared\.ts \(2\/2 scopes\), src\/b\.ts \(1\/2 scopes\), src\/c\.ts \(1\/2 scopes\)/);
});

test('execute review disposition permits finalization for accept and safe parent advancement only', () => {
  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'accept',
    }),
    {
      phase: 'execute_finalization',
      status: 'running',
      blockedFromPhase: null,
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'advance_parent',
    }),
    {
      phase: 'execute_finalization',
      status: 'running',
      blockedFromPhase: null,
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: true,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'advance_parent',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: true,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'accept',
    }),
    {
      phase: 'coder_optional_response',
      status: 'running',
      blockedFromPhase: null,
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'block_for_operator',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: true,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'block_for_operator',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'replace_plan',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: true,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'replace_plan',
    }),
    {
      phase: 'coder_response',
      status: 'running',
      blockedFromPhase: null,
    },
  );
});

// Regression for the rotating-canonical trickle (issue #1's execute-review
// churn, observed live: one novel blocking finding per round, prior finding
// fixed each round, so the canonical SET changes every round and set-based
// stuckness never fires while the open-blocking COUNT never decreases).
// The count-based non-reduction signal must route this to review_stuck.
test('execute reviewer synthesis blocks a rotating-canonical flat-count trickle as review_stuck', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    rounds: [
      createCanonicalStucknessRound(1, ['C1']),
      createCanonicalStucknessRound(2, ['C2']),
      createCanonicalStucknessRound(3, ['C3']),
      createCanonicalStucknessRound(4, ['C4']),
    ],
    findings: [],
    maxRounds: 20,
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'One more oracle hardening gap.',
      findings: [
        {
          round: context.round,
          source: 'reviewer',
          severity: 'blocking',
          files: ['src/neal/example.ts'],
          claim: 'The oracle can still be bypassed by a fifth novel variant.',
          evidence: 'A control constructed through an aliased loader passes the guard.',
          requiredAction: 'Close the aliased-loader bypass.',
          roundSummary: 'One more oracle hardening gap.',
        },
      ],
      meaningfulProgress: {
        action: 'accept',
        rationale: 'The scope still materially advances the parent objective.',
      },
    },
  });

  assert.equal(reviewerState.disposition.status, 'blocked');
  assert.match(reviewerState.blockReason ?? '', /did not decrease/);
});

test('execute reviewer synthesis does not flag a decreasing blocking count as stuck', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    rounds: [
      createCanonicalStucknessRound(1, ['C1', 'C2']),
      createCanonicalStucknessRound(2, ['C3', 'C4']),
      createCanonicalStucknessRound(3, ['C5', 'C6']),
      createCanonicalStucknessRound(4, ['C7', 'C8']),
    ],
    findings: [],
    maxRounds: 20,
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'One narrower follow-up remains.',
      findings: [
        {
          round: context.round,
          source: 'reviewer',
          severity: 'blocking',
          files: ['src/neal/example.ts'],
          claim: 'A single narrower gap remains after the last fixes.',
          evidence: 'The reduced surface still admits one bypass.',
          requiredAction: 'Close the remaining bypass.',
          roundSummary: 'One narrower follow-up remains.',
        },
      ],
      meaningfulProgress: {
        action: 'accept',
        rationale: 'The scope still materially advances the parent objective.',
      },
    },
  });

  assert.equal(reviewerState.disposition.status, 'running');
  assert.equal(reviewerState.disposition.phase, 'coder_response');
});

test('execute reviewer acceptance with only non-blocking findings routes to optional response', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    rounds: [],
    findings: [],
    maxRounds: 3,
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Only bounded residual polish remains.',
      findings: [
        {
          round: context.round,
          source: 'reviewer',
          severity: 'non_blocking',
          files: ['src/neal/review.ts'],
          claim: 'Review artifacts should preserve optional dispositions.',
          evidence: 'Without optional triage, an accepted scope can lose the coder rationale for non-blocking review debt.',
          requiredAction: 'Route accepted scopes with open non-blocking findings through coder_optional_response.',
          roundSummary: 'Only bounded residual polish remains.',
        },
      ],
      meaningfulProgress: {
        action: 'accept',
        rationale: 'The scope materially advances the parent objective and only non-blocking polish remains.',
      },
    },
  });

  assert.deepEqual(reviewerState.disposition, {
    phase: 'coder_optional_response',
    status: 'running',
    blockedFromPhase: null,
  });
  assert.equal(reviewerState.mergedFindings.length, 1);
  assert.equal(reviewerState.mergedFindings[0].status, 'open');
  assert.equal(reviewerState.mergedFindings[0].evidence, 'Without optional triage, an accepted scope can lose the coder rationale for non-blocking review debt.');
});

test('execute reviewer synthesis keeps safe explicit parent advancement effective', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '5.1',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-5-1',
      finalCommit: 'final-5-1',
      summary: null,
      commitSubject: 'derived scope 5.1',
      changedFiles: ['src/parent.ts'],
      reviewRounds: 1,
      findings: 0,
      residualReviewDebt: [],
      archivedReviewPath: '/tmp/review-5.1.md',
      blocker: null,
      derivedFromParentScope: '5',
      replacedByDerivedPlanPath: null,
    },
  ];
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    executionShape: 'multi_scope',
    currentScopeNumber: 5,
    derivedPlanPath: '/tmp/DERIVED.md',
    derivedFromScopeNumber: 5,
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: 2,
    completedScopes,
    rounds: [],
    findings: [],
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    changedFiles: [],
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Parent scope is complete.',
      findings: [],
      meaningfulProgress: {
        action: 'advance_parent',
        rationale: 'Prior accepted derived work satisfies parent scope 5 and this derived checkpoint is empty.',
      },
    },
  });

  assert.equal(reviewerState.meaningfulProgressVerdict.action, 'advance_parent');
  assert.equal(reviewerState.parentAdvanceClassification?.eligible, true);
  assert.deepEqual(reviewerState.disposition, {
    phase: 'execute_finalization',
    status: 'running',
    blockedFromPhase: null,
  });
});

test('execute reviewer synthesis normalizes top-level already-satisfied advance_parent to accept', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
    rounds: [],
    findings: [],
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    changedFiles: [],
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Scope 4 is already satisfied.',
      findings: [],
      meaningfulProgress: {
        action: 'advance_parent',
        rationale: 'Accepted scopes 1 and 2.3 already satisfy scope 4 and focused verification passed.',
      },
    },
  });

  assert.equal(reviewerState.meaningfulProgressVerdict.action, 'accept');
  assert.match(reviewerState.meaningfulProgressVerdict.rationale, /Accepted top-level already-satisfied scope 4/);
  assert.match(reviewerState.meaningfulProgressVerdict.rationale, /prior accepted scope\(s\) 1, 2\.3/);
  assert.equal(reviewerState.parentAdvanceClassification?.eligible, false);
  assert.equal(reviewerState.alreadySatisfiedTopLevelClassification?.eligible, true);
  assert.deepEqual(reviewerState.disposition, {
    phase: 'execute_finalization',
    status: 'running',
    blockedFromPhase: null,
  });
});

test('execute reviewer synthesis blocks top-level already-satisfied advance_parent with current diff', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
    rounds: [],
    findings: [],
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    changedFiles: ['src/current.ts'],
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Scope 4 is already satisfied.',
      findings: [],
      meaningfulProgress: {
        action: 'advance_parent',
        rationale: 'Accepted scopes 1 and 2.3 already satisfy scope 4 and focused verification passed.',
      },
    },
  });

  assert.equal(reviewerState.meaningfulProgressVerdict.action, 'block_for_operator');
  assert.equal(reviewerState.alreadySatisfiedTopLevelClassification?.eligible, false);
  assert.match(
    reviewerState.meaningfulProgressVerdict.rationale,
    /Top-level already-satisfied fallback failed preconditions: .*changed-file list is not empty/,
  );
  assert.deepEqual(reviewerState.disposition, {
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
  });
});

test('execute reviewer synthesis blocks unsafe explicit parent advancement with failed preconditions', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    executionShape: 'multi_scope',
    currentScopeNumber: 5,
    derivedPlanPath: '/tmp/DERIVED.md',
    derivedFromScopeNumber: 5,
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: 2,
    completedScopes: [
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-1',
        finalCommit: 'final-5-1',
        summary: null,
        commitSubject: 'derived scope 5.1',
        changedFiles: ['src/parent.ts'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
    rounds: [],
    findings: [],
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    changedFiles: ['src/current.ts'],
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Parent scope is complete.',
      findings: [],
      meaningfulProgress: {
        action: 'advance_parent',
        rationale: 'Prior accepted derived work satisfies parent scope 5.',
      },
    },
  });

  assert.equal(reviewerState.meaningfulProgressVerdict.action, 'block_for_operator');
  assert.match(reviewerState.meaningfulProgressVerdict.rationale, /Unsafe advance_parent/);
  assert.match(reviewerState.meaningfulProgressVerdict.rationale, /changed-file list is not empty/);
  assert.equal(reviewerState.parentAdvanceClassification?.eligible, false);
  assert.deepEqual(reviewerState.disposition, {
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
  });
  assert.match(reviewerState.blockReason ?? '', /meaningful_progress: reviewer requested operator guidance/);
});

test('execute reviewer synthesis deterministically converts repeated empty derived block to parent advancement', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    executionShape: 'multi_scope',
    currentScopeNumber: 5,
    derivedPlanPath: '/tmp/DERIVED.md',
    derivedFromScopeNumber: 5,
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: 4,
    completedScopes: [
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-1',
        finalCommit: 'final-5-1',
        summary: null,
        commitSubject: 'derived scope 5.1',
        changedFiles: ['src/parent.ts', 'src/shared.ts'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-2',
        finalCommit: 'final-5-2',
        summary: null,
        commitSubject: 'empty derived scope 5.2',
        changedFiles: [],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-5.2.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-3',
        finalCommit: 'final-5-3',
        summary: null,
        commitSubject: 'empty derived scope 5.3',
        changedFiles: [],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-5.3.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
    rounds: [],
    findings: [],
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    changedFiles: [],
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Parent appears complete.',
      findings: [],
      meaningfulProgress: {
        action: 'block_for_operator',
        rationale: 'The parent objective appears complete, but this empty checkpoint does not add new work.',
      },
    },
  });

  assert.equal(reviewerState.meaningfulProgressVerdict.action, 'advance_parent');
  assert.match(reviewerState.meaningfulProgressVerdict.rationale, /Deterministic redundant-empty-derived-scope fallback/);
  assert.equal(reviewerState.parentAdvanceClassification?.source, 'fallback');
  assert.equal(reviewerState.parentAdvanceClassification?.priorEmptyCount, 2);
  assert.deepEqual(reviewerState.parentAdvanceClassification?.aggregateChangedFiles, ['src/parent.ts', 'src/shared.ts']);
  assert.deepEqual(reviewerState.disposition, {
    phase: 'execute_finalization',
    status: 'running',
    blockedFromPhase: null,
  });
});

test('execute reviewer synthesis converts empty no-progress operator block into coder revision finding', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    executionShape: 'multi_scope',
    currentScopeNumber: 1,
    rounds: [],
    findings: [],
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    changedFiles: [],
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'The commit range contains no file modifications.',
      findings: [],
      meaningfulProgress: {
        action: 'block_for_operator',
        rationale: 'The scope made no changes, so it is unclear how to accept the parent objective.',
      },
    },
  });

  assert.equal(reviewerState.meaningfulProgressVerdict.action, 'block_for_operator');
  assert.equal(reviewerState.findings.length, 1);
  assert.equal(reviewerState.findings[0].severity, 'blocking');
  assert.match(reviewerState.findings[0].claim, /without any file modifications/);
  assert.deepEqual(reviewerState.disposition, {
    phase: 'coder_response',
    status: 'running',
    blockedFromPhase: null,
  });
  assert.equal(reviewerState.blockReason, null);
});

test('review phase persists the effective advance_parent verdict and transition signal', async () => {
  const { statePath, state, cwd } = await createEmptyExecuteFinalizationFixture({
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 4,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Review an empty derived checkpoint.',
      newEvidence: 'The active derived diff is empty.',
      whyNotRedundant: 'Prior accepted derived work already touched the parent files.',
      nextStepUnlocked: 'The parent scope can advance if the reviewer agrees it is complete.',
    },
    completedScopes: [
      ...createParentAdvanceCompletedScopes(),
      {
        number: '5.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-derived-3',
        finalCommit: 'final-derived-3',
        summary: 'Repeated empty verification checkpoint.',
        commitSubject: 'empty derived verification 2',
        changedFiles: [],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-derived-3.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
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
            sessionHandle: 'reviewer-empty-derived-block',
            structured: {
              summary: 'The parent scope is complete and the active derived checkpoint is empty.',
              findings: [],
              meaningfulProgressAction: 'block_for_operator',
              meaningfulProgressRationale: 'The parent is complete, but this checkpoint has no new diff.',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runReviewPhase(state, statePath, logger);

    assert.equal(nextState.phase, 'execute_finalization');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeMeaningfulProgressVerdict?.action, 'advance_parent');
    assert.match(
      nextState.currentScopeMeaningfulProgressVerdict?.rationale ?? '',
      /Deterministic redundant-empty-derived-scope fallback/,
    );
    assert.equal(nextState.rounds.length, 1);
    const events = await readRunEvents(state.runDir);
    const advanceEvent = events.find((event) => event.type === 'review.meaningful_progress.advance_parent');
    assert.ok(advanceEvent);
    assert.equal(advanceEvent.data?.parentScopeLabel, '5');
    assert.equal(advanceEvent.data?.currentScopeLabel, '5.4');
    assert.equal(advanceEvent.data?.source, 'fallback');
    assert.equal(advanceEvent.data?.priorEmptyCount, 2);
    const phaseComplete = events.find(
      (event) => event.type === 'phase.complete' && event.data?.phase === 'reviewer_scope',
    );
    assert.equal(phaseComplete?.data?.meaningfulProgressAction, 'advance_parent');
    assert.equal(phaseComplete?.data?.originalMeaningfulProgressAction, 'block_for_operator');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('review phase persists normalized top-level already-satisfied accept with original advance_parent', async () => {
  const { statePath, state, cwd } = await createEmptyExecuteFinalizationFixture({
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
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
            sessionHandle: 'reviewer-top-level-already-satisfied',
            structured: {
              summary: 'Scope 4 is already satisfied by prior accepted work.',
              findings: [],
              meaningfulProgressAction: 'advance_parent',
              meaningfulProgressRationale:
                'Accepted scopes 1 and 2.3 already satisfy scope 4 and focused verification passed.',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runReviewPhase(state, statePath, logger);

    assert.equal(nextState.phase, 'execute_finalization');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeMeaningfulProgressVerdict?.action, 'accept');
    assert.match(
      nextState.currentScopeMeaningfulProgressVerdict?.rationale ?? '',
      /Accepted top-level already-satisfied scope 4/,
    );
    const events = await readRunEvents(state.runDir);
    assert.equal(events.some((event) => event.type === 'review.meaningful_progress.advance_parent'), false);
    const phaseComplete = events.find(
      (event) => event.type === 'phase.complete' && event.data?.phase === 'reviewer_scope',
    );
    assert.equal(phaseComplete?.data?.meaningfulProgressAction, 'accept');
    assert.equal(phaseComplete?.data?.originalMeaningfulProgressAction, 'advance_parent');
    assert.equal(phaseComplete?.data?.nextPhase, 'execute_finalization');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('top-level already-satisfied advance_parent review accepts and finalizes as ordinary scope completion', async () => {
  const { statePath, state, cwd } = await createEmptyExecuteFinalizationFixture({
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
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
            sessionHandle: 'reviewer-original-scope-4',
            structured: {
              summary: 'Original scope 4 is already satisfied by prior accepted benchmark work.',
              findings: [],
              meaningfulProgressAction: 'advance_parent',
              meaningfulProgressRationale:
                'Parent objective 4 is fully satisfied by prior accepted derived work under parent objective 2, including accepted scope 2.3, and focused verification passed against a clean worktree.',
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
    assert.equal(reviewedState.interactiveBlockedRecovery, null);
    assert.equal(reviewedState.currentScopeMeaningfulProgressVerdict?.action, 'accept');
    assert.match(
      reviewedState.currentScopeMeaningfulProgressVerdict?.rationale ?? '',
      /Accepted top-level already-satisfied scope 4/,
    );

    const reviewMarkdown = await readFile(state.reviewMarkdownPath, 'utf8');
    assert.match(reviewMarkdown, /- Reviewer action: accept/);
    assert.match(reviewMarkdown, /Accepted top-level already-satisfied scope 4/);
    const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /- Reviewer action: accept/);
    assert.match(progressMarkdown, /Accepted top-level already-satisfied scope 4/);
    const progressJson = JSON.parse(await readFile(state.progressJsonPath, 'utf8')) as {
      meaningfulProgress?: {
        currentScopeMeaningfulProgressVerdict?: ReviewerMeaningfulProgressVerdict;
      };
    };
    assert.equal(progressJson.meaningfulProgress?.currentScopeMeaningfulProgressVerdict?.action, 'accept');
    assert.match(
      progressJson.meaningfulProgress?.currentScopeMeaningfulProgressVerdict?.rationale ?? '',
      /Original reviewer rationale: Parent objective 4 is fully satisfied/,
    );

    const finalState = await runExecuteFinalizationPhase(reviewedState, statePath, logger);

    assert.equal(finalState.phase, 'coder_scope');
    assert.equal(finalState.status, 'running');
    assert.equal(finalState.currentScopeNumber, 5);
    assert.equal(finalState.currentScopeMeaningfulProgressVerdict, null);
    assert.equal(finalState.derivedPlanPath, null);
    assert.equal(finalState.derivedFromScopeNumber, null);
    assert.equal(finalState.derivedPlanStatus, null);
    assert.equal(finalState.derivedScopeIndex, null);
    assert.equal(finalState.interactiveBlockedRecovery, null);
    assert.equal(finalState.completedScopes.some((scope) => scope.number === '4.1'), false);
    const completedScope = finalState.completedScopes.find((scope) => scope.number === '4');
    assert.ok(completedScope);
    assert.equal(completedScope.derivedFromParentScope, null);
    assert.equal(completedScope.replacedByDerivedPlanPath, null);
    assert.deepEqual(completedScope.changedFiles, []);
    assert.match(completedScope.summary ?? '', /Accepted top-level already-satisfied scope 4/);

    if (!completedScope.archivedReviewPath) {
      throw new Error('Expected completed scope 4 to record an archived review path.');
    }
    const archivedReview = await readFile(completedScope.archivedReviewPath, 'utf8');
    assert.match(archivedReview, /- Reviewer action: accept/);
    assert.match(archivedReview, /Accepted top-level already-satisfied scope 4/);
    const snapshot = await buildStatusSnapshot({ cwd, statePath });
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.phase, 'coder_scope');

    const events = await readRunEvents(state.runDir);
    assert.equal(events.some((event) => event.type === 'review.meaningful_progress.advance_parent'), false);
    assert.equal(events.some((event) => event.type === 'execute_finalization.advance_parent'), false);
    const reviewPhaseComplete = events.find(
      (event) => event.type === 'phase.complete' && event.data?.phase === 'reviewer_scope',
    );
    assert.equal(reviewPhaseComplete?.data?.meaningfulProgressAction, 'accept');
    assert.equal(reviewPhaseComplete?.data?.originalMeaningfulProgressAction, 'advance_parent');
    assert.equal(reviewPhaseComplete?.data?.nextPhase, 'execute_finalization');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('execute reviewer synthesis does not normalize top-level advance_parent when findings remain open', async () => {
  const openResidualFinding: ReviewFinding = {
    id: 'R1-F1',
    canonicalId: 'C1',
    round: 1,
    source: 'reviewer',
    severity: 'non_blocking',
    files: ['src/current.ts'],
    claim: 'Residual review debt remains.',
    evidence: 'The existing non-blocking finding still needs disposition.',
    requiredAction: 'Resolve the residual finding before accepting the scope.',
    status: 'open',
    roundSummary: 'Residual finding remains open.',
    coderDisposition: null,
    coderCommit: null,
  };
  const currentReviewerFinding = {
    round: 1,
    source: 'reviewer' as const,
    severity: 'non_blocking' as const,
    files: ['src/current.ts'],
    claim: 'The current review found a new issue.',
    evidence: 'A new non-blocking finding still prevents already-satisfied fallback acceptance.',
    requiredAction: 'Disposition the new finding before accepting the scope.',
    roundSummary: 'A current finding remains open.',
  };

  for (const scenario of [
    {
      name: 'current reviewer finding',
      existingFindings: [] as ReviewFinding[],
      reviewerFindings: [currentReviewerFinding],
      expectedPrecondition: /current reviewer result has findings/,
    },
    {
      name: 'open merged finding',
      existingFindings: [openResidualFinding],
      reviewerFindings: [],
      expectedPrecondition: /merged review findings still contain open findings/,
    },
  ]) {
    const { state } = await createResumeFixture({
      phase: 'reviewer_scope',
      executionShape: 'multi_scope',
      currentScopeNumber: 4,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
      completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
      rounds: [],
      findings: scenario.existingFindings,
    });
    const context = resolveExecuteAdjudicationContext(state);

    const reviewerState = synthesizeExecuteReviewerState({
      state,
      context,
      headCommit: `head-${scenario.name}`,
      changedFiles: [],
      reviewerResult: {
        sessionHandle: `reviewer-${scenario.name}`,
        summary: 'Scope 4 appears already satisfied.',
        findings: scenario.reviewerFindings,
        meaningfulProgress: {
          action: 'advance_parent',
          rationale: 'Prior accepted work already satisfies scope 4.',
        },
      },
    });

    assert.equal(reviewerState.meaningfulProgressVerdict.action, 'block_for_operator');
    assert.equal(reviewerState.alreadySatisfiedTopLevelClassification?.eligible, false);
    assert.match(
      reviewerState.meaningfulProgressVerdict.rationale,
      /Top-level already-satisfied fallback failed preconditions:/,
    );
    assert.match(reviewerState.meaningfulProgressVerdict.rationale, scenario.expectedPrecondition);
    assert.notEqual(reviewerState.disposition.phase, 'execute_finalization');
  }
});

test('execute optional response must disposition every open non-blocking finding before execute finalization', async () => {
  const { state } = await createResumeFixture({
    phase: 'coder_optional_response',
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/prompts/execute.ts'],
        claim: 'Prompt should be clearer.',
        evidence: 'The optional prompt does not make bounded fixes the default.',
        requiredAction: 'Clarify optional uptake.',
        status: 'open',
        roundSummary: 'Optional uptake needs explicit triage.',
        coderDisposition: null,
        coderCommit: null,
      },
      {
        id: 'R1-F2',
        canonicalId: 'C2',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/adjudicator/execute.ts'],
        claim: 'Disposition persistence should be explicit.',
        evidence: 'Missing responses would leave an open non-blocking finding while execute finalization proceeds.',
        requiredAction: 'Require one disposition per open non-blocking finding.',
        status: 'open',
        roundSummary: 'Optional uptake needs explicit triage.',
        coderDisposition: null,
        coderCommit: null,
      },
      {
        id: 'R1-F3',
        canonicalId: 'C3',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/review.ts'],
        claim: 'A reviewer suggestion may be incorrect.',
        evidence: 'The optional response contract should preserve evidence-backed rejection rather than reopening the finding.',
        requiredAction: 'Reject incorrect non-blocking findings with a rationale.',
        status: 'open',
        roundSummary: 'Optional uptake needs explicit triage.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });

  assert.throws(
    () =>
      synthesizeExecuteResponseState({
        state,
        mode: 'optional',
        createdCommits: ['fix123'],
        response: {
          sessionHandle: 'coder-session',
          payload: {
            outcome: 'responded',
            summary: 'Handled optional findings.',
            blocker: '',
            derivedPlan: '',
            responses: [
              {
                id: 'R1-F1',
                decision: 'fixed',
                summary: 'Clarified the prompt.',
              },
            ],
          },
        },
      }),
    /did not disposition every open finding: R1-F2/,
  );

  const responseState = synthesizeExecuteResponseState({
    state,
    mode: 'optional',
    createdCommits: ['fix123'],
    response: {
      sessionHandle: 'coder-session',
      payload: {
        outcome: 'responded',
        summary: 'Handled optional findings.',
        blocker: '',
        derivedPlan: '',
        responses: [
          {
            id: 'R1-F1',
            decision: 'fixed',
            summary: 'Clarified the prompt.',
          },
          {
            id: 'R1-F2',
            decision: 'deferred',
            summary: 'The finding is real but should wait for the residual-debt artifact scope.',
          },
          {
            id: 'R1-F3',
            decision: 'rejected',
            summary: 'The suggestion is incorrect because review markdown already preserves rejected dispositions.',
          },
        ],
      },
    },
  });

  assert.equal(responseState.nextPhase, 'execute_finalization');
  assert.equal(responseState.findings[0].status, 'fixed');
  assert.equal(responseState.findings[0].coderDisposition, 'Clarified the prompt.');
  assert.equal(responseState.findings[0].coderCommit, 'fix123');
  assert.equal(responseState.findings[1].status, 'deferred');
  assert.equal(responseState.findings[1].coderDisposition, 'The finding is real but should wait for the residual-debt artifact scope.');
  assert.equal(responseState.findings[1].coderCommit, null);
  assert.equal(responseState.findings[2].status, 'rejected');
  assert.equal(responseState.findings[2].coderDisposition, 'The suggestion is incorrect because review markdown already preserves rejected dispositions.');
  assert.equal(responseState.findings[2].coderCommit, null);

  const acceptedState = {
    ...state,
    phase: responseState.nextPhase,
    status: responseState.nextStatus,
    findings: responseState.findings,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE' as const,
  };
  const completedScopes = appendCompletedScope(acceptedState, 'accepted', {
    finalCommit: 'scope-final',
    commitSubject: 'finish optional uptake',
    changedFiles: ['src/neal/prompts/execute.ts', 'src/neal/adjudicator/execute.ts'],
    archivedReviewPath: '/tmp/review-optional.md',
    blocker: null,
    marker: 'AUTONOMY_SCOPE_DONE',
  });
  const completionPacket = await buildFinalCompletionPacket({
    state: {
      ...acceptedState,
      completedScopes,
      finalCommit: 'scope-final',
      createdCommits: [],
    },
    terminalScope: null,
  });

  assert.deepEqual(
    completionPacket.residualReviewDebt.map((item) => `${item.id}:${item.status}:${item.coderDisposition}`),
    ['R1-F2:deferred:The finding is real but should wait for the residual-debt artifact scope.'],
  );
  assert.match(completionPacket.completedScopeSummary, /residual non-blocking debt: R1-F2 deferred/);
  assert.match(completionPacket.residualReviewDebtSummary, /Scope 1 R1-F2 \(deferred\)/);
  assert.doesNotMatch(completionPacket.residualReviewDebtSummary, /R1-F1/);
  assert.doesNotMatch(completionPacket.residualReviewDebtSummary, /R1-F3/);
});

test('execute adjudication context exposes meaningful-progress through the execute-review capability surface', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    currentScopeNumber: 5,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Keep the execute-review contract explicit',
      newEvidence: 'Execute review now resolves meaningful-progress from the adjudication spec.',
      whyNotRedundant: 'This verifies the shared execute-review family still carries the gating capability.',
      nextStepUnlocked: 'Reviewer disposition can use the same adjudication family without a separate phase.',
    },
  });

  const context = resolveExecuteAdjudicationContext(state);
  assert.equal(context.spec.id, 'execute_review');
  assert.equal(context.meaningfulProgressCapability.promptSpecId, 'scope_reviewer');
  assert.equal(context.meaningfulProgressCapability.variantKind, 'meaningful_progress');
  assert.equal(context.meaningfulProgressCapability.exportName, 'buildReviewerPrompt');
});

test('execute transition assertions reject impossible live outcomes for the active execute-review spec', () => {
  const spec = getAdjudicationSpec('execute_review');

  assert.throws(
    () => assertAdjudicationTransitionSignal(spec, 'accept_complete', 'test:execute-boundary'),
    /test:execute-boundary resolved transition signal accept_complete for adjudication spec execute_review family execute_review/,
  );
});

test('execute review block reason names the parent objective for meaningful-progress operator guidance', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: null,
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'block_for_operator',
    meaningfulProgressRationale: 'The recent scopes are locally correct but no longer converging on the parent objective.',
    parentScopeLabel: '4',
  });

  // Structured block reason: meaningful_progress signal, the parent objective id,
  // and the pass-through reviewer rationale.
  assert.match(reason ?? '', /^meaningful_progress:/);
  assert.match(reason ?? '', /parent objective 4/);
  assert.match(reason ?? '', /The recent scopes are locally correct but no longer converging on the parent objective\./);
});

test('execute review block reason directs replace-plan cases into diagnosis-friendly recovery', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: null,
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'replace_plan',
    meaningfulProgressRationale: 'The current scope keeps revisiting the same hotspot and should be replaced.',
    parentScopeLabel: '4',
  });

  // Structured block reason: meaningful_progress signal + replace-plan semantics
  // for the parent objective, the pass-through rationale, and recovery CLI tokens.
  assert.match(reason ?? '', /^meaningful_progress:/);
  assert.match(reason ?? '', /replacing the current scope for parent objective 4/);
  assert.match(reason ?? '', /The current scope keeps revisiting the same hotspot and should be replaced\./);
  assert.match(reason ?? '', /neal status/);
  assert.match(reason ?? '', /neal resume/);
});

test('execute review block reason explains unsafe parent advancement', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: null,
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'advance_parent',
    meaningfulProgressRationale: 'Open findings remain after the reviewer pass.',
    parentScopeLabel: '4',
  });

  // Structured block reason: meaningful_progress signal + advance_parent semantics
  // for the parent objective, plus the pass-through rationale.
  assert.match(reason ?? '', /^meaningful_progress:/);
  assert.match(reason ?? '', /parent advancement for parent objective 4/);
  assert.match(reason ?? '', /Open findings remain after the reviewer pass\./);
});

test('execute review block reason preserves convergence blockers ahead of meaningful-progress guidance', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: 'C7',
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'replace_plan',
    meaningfulProgressRationale: 'The scope shape is wrong.',
    parentScopeLabel: '2',
  });

  assert.equal(reason, 'review_stuck: blocking finding C7 reopened across multiple reviewer rounds');
});

test('getOpenBlockingCanonicalSet returns only open blocking canonical ids', () => {
  const base = createOpenPlanReviewFinding();
  const findings: ReviewFinding[] = [
    base,
    { ...base, id: 'R1-F2', canonicalId: 'C2', status: 'fixed' },
    { ...base, id: 'R1-F3', canonicalId: 'C3', severity: 'non_blocking' },
    { ...base, id: 'R2-F1', canonicalId: 'C1' },
    { ...base, id: 'R2-F2', canonicalId: 'C4' },
  ];

  assert.deepEqual([...getOpenBlockingCanonicalSet(findings)].sort(), ['C1', 'C4']);
});

test('canonical-set stuckness treats replacing one blocking canonical with another as progress', async () => {
  const cwd = await createStucknessCwd(3);

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, ['C1']), createCanonicalStucknessRound(2, ['C2'])],
      currentOpenBlockingCanonicals: new Set(['C3']),
      cwd,
    }),
    false,
    'a flat blocking count with changing canonical identity is not stuck',
  );
});

test('canonical-set stuckness flags the same unresolved blocking set persisting across the window', async () => {
  const cwd = await createStucknessCwd(3);

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, ['C1']), createCanonicalStucknessRound(2, ['C1'])],
      currentOpenBlockingCanonicals: new Set(['C1']),
      cwd,
    }),
    true,
  );

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, ['C2', 'C1']), createCanonicalStucknessRound(2, ['C1', 'C2'])],
      currentOpenBlockingCanonicals: new Set(['C2', 'C1']),
      cwd,
    }),
    true,
    'set comparison ignores ordering of recorded canonical ids',
  );
});

test('canonical-set stuckness is not triggered by short histories, empty sets, or growing sets', async () => {
  const cwd = await createStucknessCwd(3);

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, ['C1'])],
      currentOpenBlockingCanonicals: new Set(['C1']),
      cwd,
    }),
    false,
    'fewer snapshots than the stuck window is not stuck',
  );

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, ['C1']), createCanonicalStucknessRound(2, ['C1'])],
      currentOpenBlockingCanonicals: new Set(),
      cwd,
    }),
    false,
    'an empty current blocking set is never stuck',
  );

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, ['C1']), createCanonicalStucknessRound(2, ['C1', 'C2'])],
      currentOpenBlockingCanonicals: new Set(['C1', 'C2']),
      cwd,
    }),
    false,
    'a changing (growing) blocking set within the window is not stuck',
  );
});

test('canonical-set stuckness falls back to count-based detection for legacy rounds without canonical ids', async () => {
  const cwd = await createStucknessCwd(3);

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, null, 1), createCanonicalStucknessRound(2, null, 1)],
      currentOpenBlockingCanonicals: new Set(['C3']),
      cwd,
    }),
    true,
    'legacy non-decreasing counts remain stuck',
  );

  assert.equal(
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: [createCanonicalStucknessRound(1, null, 2), createCanonicalStucknessRound(2, null, 1)],
      currentOpenBlockingCanonicals: new Set(['C3']),
      cwd,
    }),
    false,
    'legacy decreasing counts remain not stuck',
  );
});

// Rotation is tolerated BELOW the stuck window: fixing each round's canonical
// and raising one new one is normal review progress for the first few rounds.
// At and past the window, the same shape is the flat-count trickle and blocks
// as review_stuck (see the rotating-canonical regression above) — this test
// pins the bounded tolerance, not unlimited rotation.
test('execute reviewer synthesis keeps revising when each round fixes the prior blocking canonical', async () => {
  const baseFinding = createOpenPlanReviewFinding();
  const priorRounds = [1, 2, 3].map((round) => createCanonicalStucknessRound(round, [`C${round}`]));
  const priorFindings: ReviewFinding[] = [1, 2, 3].map((round) => ({
    ...baseFinding,
    id: `R${round}-F1`,
    canonicalId: `C${round}`,
    round,
    claim: `Distinct blocking safety issue ${round}.`,
    status: round === 3 ? ('open' as const) : ('fixed' as const),
  }));
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    rounds: priorRounds,
    findings: priorFindings,
    maxRounds: 20,
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state: {
      ...state,
      findings: priorFindings.map((finding) =>
        finding.canonicalId === 'C3' ? { ...finding, status: 'fixed' as const } : finding,
      ),
    },
    context,
    headCommit: 'head-4',
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'A new, distinct blocking issue surfaced after the prior one was fixed.',
      findings: [
        {
          round: context.round,
          source: 'reviewer',
          severity: 'blocking',
          files: ['src/neal/safety.ts'],
          claim: 'Distinct blocking safety issue 4.',
          evidence: 'A deeper safety hole was uncovered once the previous canonical was resolved.',
          requiredAction: 'Close the newly surfaced safety hole.',
          roundSummary: 'A new, distinct blocking issue surfaced after the prior one was fixed.',
        },
      ],
      meaningfulProgress: {
        action: 'accept',
        rationale: 'Each round resolves the prior blocking canonical and surfaces a deeper distinct one.',
      },
    },
  });

  assert.deepEqual(reviewerState.roundRecord.openBlockingCanonicalIds, ['C4']);
  assert.equal(reviewerState.openBlockingCanonicalCount, 1);
  assert.deepEqual(
    reviewerState.disposition,
    {
      phase: 'coder_response',
      status: 'running',
      blockedFromPhase: null,
    },
    'a flat blocking count with rotating canonical identity requests revision instead of blocking',
  );
  assert.equal(reviewerState.blockReason, null);
});

test('execute reviewer synthesis still blocks when the same blocking canonical set persists for the window', async () => {
  const baseFinding = createOpenPlanReviewFinding();
  const priorRounds = [1, 2, 3, 4].map((round) => createCanonicalStucknessRound(round, ['C1']));
  const stuckFinding: ReviewFinding = {
    ...baseFinding,
    claim: 'Persistent blocking safety issue.',
  };
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    rounds: priorRounds,
    findings: [stuckFinding],
    maxRounds: 20,
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head-5',
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'The same blocking issue remains open.',
      findings: [],
      meaningfulProgress: {
        action: 'accept',
        rationale: 'No new findings, but the original blocking canonical is still unresolved.',
      },
    },
  });

  assert.deepEqual(reviewerState.roundRecord.openBlockingCanonicalIds, ['C1']);
  assert.deepEqual(reviewerState.disposition, {
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
  });
  assert.match(
    reviewerState.blockReason ?? '',
    /review_stuck: blocking findings did not decrease across 5 consecutive reviewer rounds/,
  );
});

function refusalProviderError() {
  return new NealProviderError({
    message: 'reviewer refused: content was flagged for possible cybersecurity risk',
    provider: 'anthropic-claude',
    role: 'structured-advisor',
    sessionHandle: 'reviewer-refused-session',
    kind: 'content_refused',
    retryable: false,
  });
}

test('review phase returns a terminal blocked state on a content_refused reviewer error', async () => {
  const { statePath, state, cwd } = await createEmptyExecuteFinalizationFixture({
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound() {
          throw refusalProviderError();
        },
      };
    },
  });

  try {
    // The phase must RETURN a terminal blocked state, not reject.
    const blockedState = await runReviewPhase(state, statePath, logger);

    assert.equal(blockedState.phase, 'blocked');
    assert.equal(blockedState.status, 'blocked');
    assert.equal(blockedState.reviewerSessionHandle, null);
    assert.equal(blockedState.blockedFromPhase, null);
    assert.match(blockedState.blockerReason ?? '', /content-safety/);

    // The persisted state matches the returned terminal blocked landing and is
    // not coder-resumable (blockedFromPhase null keeps it out of
    // RESUMABLE_BLOCKED_PHASES).
    const reloaded = await loadState(statePath);
    assert.equal(reloaded.phase, 'blocked');
    assert.equal(reloaded.status, 'blocked');
    assert.equal(reloaded.reviewerSessionHandle, null);
    assert.equal(reloaded.blockedFromPhase, null);
    assert.match(reloaded.blockerReason ?? '', /content-safety/);

    const events = await readRunEvents(state.runDir);
    const phaseError = events.find(
      (event) => event.type === 'phase.error' && event.data?.phase === 'reviewer_scope',
    );
    assert.equal(phaseError?.data?.errorKind, 'content_refused');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('review phase still fails a non-refusal reviewer error and persists status failed', async () => {
  const { statePath, state, cwd } = await createEmptyExecuteFinalizationFixture({
    phase: 'reviewer_scope',
    status: 'running',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: createAlreadySatisfiedTopLevelProgress(),
    completedScopes: createAlreadySatisfiedTopLevelCompletedScopes(),
  });
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound() {
          throw new NealProviderError({
            message: 'reviewer provider failed for an unrelated reason',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            sessionHandle: 'reviewer-failed-session',
            kind: 'provider_failed',
            retryable: false,
          });
        },
      };
    },
  });

  try {
    await assert.rejects(() => runReviewPhase(state, statePath, logger));

    const reloaded = await loadState(statePath);
    assert.equal(reloaded.status, 'failed');
    assert.equal(reloaded.phase, 'reviewer_scope');
    assert.equal(reloaded.blockerReason, null);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
