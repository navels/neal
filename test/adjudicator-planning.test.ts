import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolvePlanningAdjudicationContext,
  runPlanningResponseAdjudication,
  runPlanningReviewerAdjudication,
} from '../src/neal/adjudicator/planning.js';
import { assertAdjudicationTransitionSignal, getAdjudicationSpec } from '../src/neal/adjudicator/specs.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-adjudicator-planning-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return { state: { ...initialState, ...overrides } };
}

test('resolvePlanningAdjudicationContext maps ordinary, derived, and recovery plan review states to the correct spec', async () => {
  const { state: ordinaryState } = await createState({
    topLevelMode: 'plan',
    phase: 'reviewer_plan',
  });
  const ordinary = resolvePlanningAdjudicationContext(ordinaryState);
  assert.equal(ordinary.spec.id, 'plan_review');
  assert.equal(ordinary.reviewMode, 'plan');
  assert.equal(ordinary.reviewTargetPath, ordinaryState.planDoc);

  const { state: derivedState } = await createState({
    phase: 'reviewer_plan',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_4.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
  });
  const derived = resolvePlanningAdjudicationContext(derivedState);
  assert.equal(derived.spec.id, 'derived_plan_review');
  assert.equal(derived.reviewMode, 'derived-plan');
  assert.equal(derived.reviewTargetPath, '/tmp/DERIVED_PLAN_SCOPE_4.md');
  assert.equal(derived.parentPlanDoc, derivedState.planDoc);
  assert.equal(derived.derivedFromScopeNumber, 4);

  const { state: recoveryState } = await createState({
    phase: 'diagnostic_recovery_review',
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-18T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'coder_scope',
      parentScopeLabel: '6',
      blockedReason: 'Need a safer execution shape.',
      question: 'How should this recover?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'abc123',
      effectiveBaselineSource: 'run_base_commit',
      analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_1_ANALYSIS.md',
      recoveryPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
    },
  });
  const recovery = resolvePlanningAdjudicationContext(recoveryState);
  assert.equal(recovery.spec.id, 'recovery_plan_review');
  assert.equal(recovery.reviewMode, 'recovery-plan');
  assert.equal(recovery.reviewTargetPath, '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md');
  assert.equal(recovery.parentPlanDoc, recoveryState.planDoc);
  assert.equal(recovery.recoveryParentScopeLabel, '6');
});

test('planning adjudicator runners preserve mode-specific context when they call injected round runners', async () => {
  const { state } = await createState({
    phase: 'reviewer_plan',
    coderSessionHandle: 'coder-session-8',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_8.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 8,
  });

  let reviewerArgs: any = null;
  const reviewResult = await runPlanningReviewerAdjudication({
    state,
    round: 2,
    reviewMarkdownPath: state.reviewMarkdownPath,
    normalizedPlanPath: join(state.runDir, 'DERIVED_PLAN_SCOPE_8.normalized.md'),
    preparePlanReviewArtifact: async ({ planPath, normalizedPlanPath }) => ({
      executionShape: 'multi_scope',
      reviewedPlanPath: normalizedPlanPath ?? planPath,
      originalPlanPath: planPath,
      validation: {
        ok: true,
        executionShape: 'multi_scope',
        errors: [],
        normalization: {
          applied: true,
          operations: ['normalized execution queue'],
          scopeLabelMappings: [],
        },
      },
    }),
    synthesizePlanReviewFindings: async ({ preparedReview, findings }) => ({
      executionShape: preparedReview?.executionShape ?? null,
      reviewedPlanPath: preparedReview?.reviewedPlanPath ?? state.planDoc,
      findings,
    }),
    runReviewerRound: async (args) => {
      reviewerArgs = args;
      return {
        sessionHandle: 'reviewer-session-8',
        summary: 'Looks good.',
        executionShape: 'multi_scope',
        findings: [],
      };
    },
  });

  assert.equal(reviewResult.context.spec.id, 'derived_plan_review');
  assert.equal(reviewerArgs?.mode, 'derived-plan');
  assert.equal(reviewerArgs?.planDoc, join(state.runDir, 'DERIVED_PLAN_SCOPE_8.normalized.md'));
  assert.equal(reviewerArgs?.parentPlanDoc, state.planDoc);
  assert.equal(reviewerArgs?.derivedFromScopeNumber, 8);

  let responseArgs: any = null;
  const responseResult = await runPlanningResponseAdjudication({
    state,
    mode: 'optional',
    openFindings: [],
    runResponseRound: async (args) => {
      responseArgs = args;
      return {
        sessionHandle: 'coder-session-8b',
        payload: {
          summary: 'No further action needed.',
          outcome: 'responded',
          responses: [],
          blocker: '',
          derivedPlan: '',
        },
      };
    },
  });

  assert.equal(responseResult.context.spec.id, 'derived_plan_review');
  assert.equal(responseArgs?.reviewMode, 'derived-plan');
  assert.equal(responseArgs?.mode, 'optional');
  assert.equal(responseArgs?.planDoc, '/tmp/DERIVED_PLAN_SCOPE_8.md');
  assert.equal(responseArgs?.sessionHandle, 'coder-session-8');
});

test('planning adjudicator runners preserve recovery-plan review context when they call injected round runners', async () => {
  const recoveryPlanPath = '/tmp/DIAGNOSTIC_RECOVERY_2_PLAN.md';
  const { state } = await createState({
    phase: 'diagnostic_recovery_review',
    coderSessionHandle: 'coder-session-recovery',
    diagnosticRecovery: {
      sequence: 2,
      startedAt: '2026-04-18T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'coder_scope',
      parentScopeLabel: '6',
      blockedReason: 'Need a narrower recovery plan.',
      question: 'What recovery plan should replace the failing objective?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'abc123',
      effectiveBaselineSource: 'run_base_commit',
      analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_2_ANALYSIS.md',
      recoveryPlanPath,
    },
  });

  let reviewerArgs: any = null;
  const reviewerResult = await runPlanningReviewerAdjudication({
    state,
    round: 2,
    reviewMarkdownPath: state.reviewMarkdownPath,
    normalizedPlanPath: join(state.runDir, 'DIAGNOSTIC_RECOVERY_2_PLAN.normalized.md'),
    preparePlanReviewArtifact: async ({ planPath, normalizedPlanPath }) => ({
      executionShape: 'multi_scope',
      reviewedPlanPath: normalizedPlanPath ?? planPath,
      originalPlanPath: planPath,
      validation: {
        ok: true,
        executionShape: 'multi_scope',
        errors: [],
        normalization: {
          applied: true,
          operations: ['normalized recovery execution queue'],
          scopeLabelMappings: [],
        },
      },
    }),
    synthesizePlanReviewFindings: async ({ preparedReview, findings }) => ({
      executionShape: preparedReview?.executionShape ?? null,
      reviewedPlanPath: preparedReview?.reviewedPlanPath ?? recoveryPlanPath,
      findings,
    }),
    runReviewerRound: async (args) => {
      reviewerArgs = args;
      return {
        sessionHandle: 'reviewer-session-recovery',
        summary: 'Recovery plan is narrowly scoped.',
        executionShape: 'multi_scope',
        findings: [],
      };
    },
  });

  assert.equal(reviewerResult.context.spec.id, 'recovery_plan_review');
  assert.equal(reviewerArgs?.mode, 'recovery-plan');
  assert.equal(reviewerArgs?.planDoc, join(state.runDir, 'DIAGNOSTIC_RECOVERY_2_PLAN.normalized.md'));
  assert.equal(reviewerArgs?.parentPlanDoc, state.planDoc);
  assert.equal(reviewerArgs?.recoveryParentScopeLabel, '6');
  assert.equal(reviewerArgs?.derivedFromScopeNumber, null);

  let responseArgs: any = null;
  const responseResult = await runPlanningResponseAdjudication({
    state,
    mode: 'blocking',
    openFindings: [
      {
        id: 'R2-F1',
        source: 'reviewer',
        claim: 'The recovery plan needs a tighter adoption boundary.',
        requiredAction: 'Constrain the replacement plan to the current parent objective.',
        severity: 'blocking',
        files: ['PLAN.md'],
        roundSummary: 'Recovery plan is close, but still too broad.',
      },
    ],
    runResponseRound: async (args) => {
      responseArgs = args;
      return {
        sessionHandle: 'coder-session-recovery-b',
        payload: {
          summary: 'Tightened the recovery plan.',
          outcome: 'responded',
          responses: [],
          blocker: '',
          derivedPlan: '',
        },
      };
    },
  });

  assert.equal(responseResult.context.spec.id, 'recovery_plan_review');
  assert.equal(responseArgs?.reviewMode, 'recovery-plan');
  assert.equal(responseArgs?.mode, 'blocking');
  assert.equal(responseArgs?.planDoc, recoveryPlanPath);
  assert.equal(responseArgs?.parentPlanDoc, state.planDoc);
  assert.equal(responseArgs?.recoveryParentScopeLabel, '6');
  assert.equal(responseArgs?.sessionHandle, 'coder-session-recovery');
});

test('planning transition assertions reject impossible live outcomes for the active plan-review spec', () => {
  const spec = getAdjudicationSpec('plan_review');

  assert.throws(
    () => assertAdjudicationTransitionSignal(spec, 'accept_scope', 'test:planning-boundary'),
    /test:planning-boundary resolved transition signal accept_scope for adjudication spec plan_review family plan_review/,
  );
});
