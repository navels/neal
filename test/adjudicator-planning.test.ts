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
import { createInitialState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { hermeticAgentConfig } from './helpers/hermetic-agent-config.js';

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
      allowedDirtyPaths: [],
      agentConfig: hermeticAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return { state: { ...initialState, ...overrides } };
}

test('resolvePlanningAdjudicationContext maps ordinary and derived plan review states to the correct spec', async () => {
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
    derivedScopeIndex: null,
  });
  const derived = resolvePlanningAdjudicationContext(derivedState);
  assert.equal(derived.spec.id, 'derived_plan_review');
  assert.equal(derived.reviewMode, 'derived-plan');
  assert.equal(derived.reviewTargetPath, '/tmp/DERIVED_PLAN_SCOPE_4.md');
  assert.equal(derived.parentPlanDoc, derivedState.planDoc);
  assert.equal(derived.derivedFromScopeNumber, 4);

  const { state: derivedResponseState } = await createState({
    phase: 'coder_plan_response',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_4.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
  });
  const derivedResponse = resolvePlanningAdjudicationContext(derivedResponseState);
  assert.equal(derivedResponse.spec.id, 'derived_plan_review');
  assert.equal(derivedResponse.reviewMode, 'derived-plan');
  assert.equal(derivedResponse.reviewTargetPath, '/tmp/DERIVED_PLAN_SCOPE_4.md');
  assert.equal(derivedResponse.parentPlanDoc, derivedResponseState.planDoc);
  assert.equal(derivedResponse.derivedFromScopeNumber, 4);

});

test('planning adjudicator runners preserve mode-specific context when they call injected round runners', async () => {
  const { state } = await createState({
    phase: 'reviewer_plan',
    reviewerSessionHandle: 'plan-reviewer-round-1',
    plannerSessionHandle: 'planner-session-8',
    plannerSessionProtocol: 'structured_json_v1',
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
      // Reviewer session continuity (issue #23): refinement round N+1 resumes
      // the reviewer session recorded by round N.
      assert.equal(args.resumeHandle, 'plan-reviewer-round-1');
      assert.equal(
        Object.hasOwn(args, 'inlineContext'),
        false,
        'the removed inlineContext channel must not reach the reviewer round',
      );
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
  assert.equal(reviewerArgs?.reviewerContext?.purpose, 'reviewer_continuity');
  assert.equal(reviewerArgs?.reviewerContext?.promptMarkdown.includes('Reviewer Continuity Context'), true);

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
  assert.equal(responseArgs?.sessionHandle, 'planner-session-8');
});

test('planning response adjudicator forwards plan-review guidance only for top-level plan responses', async () => {
  const planGuidance = {
    message: 'Keep the narrowed plan shape and address the reviewer blocker.',
    sourcePhase: 'reviewer_plan' as const,
    recordedAt: '2026-05-29T00:00:00.000Z',
  };
  const { state: planState } = await createState({
    topLevelMode: 'plan',
    phase: 'coder_plan_response',
    plannerSessionHandle: 'planner-session-plan',
    plannerSessionProtocol: 'structured_json_v1',
    pendingPlanReviewGuidance: planGuidance,
  });

  let planResponseArgs: any = null;
  await runPlanningResponseAdjudication({
    state: planState,
    openFindings: [],
    runResponseRound: async (args) => {
      planResponseArgs = args;
      return {
        sessionHandle: 'coder-session-plan-b',
        payload: {
          summary: 'Addressed the blocking finding.',
          outcome: 'responded',
          responses: [],
          blocker: '',
          derivedPlan: '',
        },
      };
    },
  });

  assert.deepEqual(planResponseArgs?.planReviewGuidance, planGuidance);

  const { state: derivedState } = await createState({
    phase: 'coder_plan_response',
    plannerSessionHandle: 'planner-session-derived',
    plannerSessionProtocol: 'structured_json_v1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_2.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 2,
    derivedScopeIndex: null,
  });

  let derivedResponseArgs: any = null;
  await runPlanningResponseAdjudication({
    state: derivedState,
    openFindings: [],
    runResponseRound: async (args) => {
      derivedResponseArgs = args;
      return {
        sessionHandle: 'coder-session-derived-b',
        payload: {
          summary: 'Addressed the derived-plan finding.',
          outcome: 'responded',
          responses: [],
          blocker: '',
          derivedPlan: '',
        },
      };
    },
  });

  assert.equal(derivedResponseArgs?.reviewMode, 'derived-plan');
  assert.equal(derivedResponseArgs?.planReviewGuidance, undefined);
});

test('planning response adjudicator rejects legacy coder-only sessions without a planner session', async () => {
  const { state } = await createState({
    phase: 'coder_plan_response',
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: 'legacy-coder-plan-session',
    coderSessionProtocol: 'structured_json_v1',
  });
  let providerInvoked = false;

  await assert.rejects(
    () =>
      runPlanningResponseAdjudication({
        state,
        openFindings: [],
        runResponseRound: async () => {
          providerInvoked = true;
          return {
            sessionHandle: 'unexpected-session',
            payload: {
              summary: 'should not run',
              outcome: 'responded',
              responses: [],
              blocker: '',
              derivedPlan: '',
            },
          };
        },
      }),
    /Cannot run planning response adjudication without an existing planner session/,
  );
  assert.equal(providerInvoked, false);
});

test('planning response adjudicator runs a fresh planner session for top-level plan refinement when the planner provider cannot resume sessions', async () => {
  // Regression: a no-resume planner provider (openai-compatible; the planner inherits the coder
  // provider) never persists plannerSessionHandle, so reviewer-requested top-level plan revisions
  // must start a fresh planner session instead of throwing the missing-session invariant.
  const agentConfig = hermeticAgentConfig();
  const { state } = await createState({
    topLevelMode: 'plan',
    phase: 'coder_plan_response',
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    agentConfig: {
      ...agentConfig,
      planner: { provider: 'openai-compatible', model: null, effort: null },
    },
  });

  let responseArgs: any = null;
  const responseResult = await runPlanningResponseAdjudication({
    state,
    openFindings: [
      {
        id: 'R1-F1',
        source: 'reviewer',
        claim: 'The plan needs an explicit verification command.',
        requiredAction: 'Add a verification command to the plan.',
        severity: 'blocking',
        files: [],
        roundSummary: 'Reviewer requested a plan revision.',
      },
    ],
    runResponseRound: async (args) => {
      responseArgs = args;
      return {
        // openai-compatible never persists a session handle; the round returns null.
        sessionHandle: null,
        payload: {
          summary: 'Revised the plan to address the finding.',
          outcome: 'responded',
          responses: [
            {
              id: 'R1-F1',
              decision: 'fixed',
              summary: 'Added the verification command.',
            },
          ],
          blocker: '',
          derivedPlan: '',
        },
      };
    },
  });

  assert.equal(responseResult.context.reviewMode, 'plan');
  assert.equal(responseArgs?.reviewMode, 'plan');
  // The round starts a fresh planner session: resumeHandle/sessionHandle is null.
  assert.equal(responseArgs?.sessionHandle, null);
  assert.equal(responseResult.response.sessionHandle, null);
});

test('planning response adjudicator runs a fresh planner session for derived-plan revisions without a planner session', async () => {
  const { state } = await createState({
    phase: 'coder_plan_response',
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: '3915c8c0-de35-49b1-b04e-9958cbe14c02',
    coderSessionProtocol: 'structured_json_v1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
    derivedScopeIndex: null,
  });

  let responseArgs: any = null;
  const responseResult = await runPlanningResponseAdjudication({
    state,
    openFindings: [
      {
        id: 'F1',
        source: 'reviewer',
        claim: 'Derived plan needs a verification step.',
        requiredAction: 'Add a verification command.',
        severity: 'blocking',
        files: [],
        roundSummary: 'Reviewer flagged a missing verification.',
      },
    ],
    runResponseRound: async (args) => {
      responseArgs = args;
      return {
        sessionHandle: 'fresh-planner-session',
        payload: {
          summary: 'Revised the derived plan.',
          outcome: 'responded',
          responses: [
            {
              id: 'F1',
              decision: 'fixed',
              summary: 'Added verification.',
            },
          ],
          blocker: '',
          derivedPlan: '',
        },
      };
    },
  });

  assert.equal(responseResult.context.reviewMode, 'derived-plan');
  assert.equal(responseArgs?.reviewMode, 'derived-plan');
  assert.equal(responseArgs?.sessionHandle, null);
  assert.equal(responseResult.response.sessionHandle, 'fresh-planner-session');
});

test('planning transition assertions reject impossible live outcomes for the active plan-review spec', () => {
  const spec = getAdjudicationSpec('plan_review');

  assert.throws(
    () => assertAdjudicationTransitionSignal(spec, 'accept_scope', 'test:planning-boundary'),
    /test:planning-boundary resolved transition signal accept_scope for adjudication spec plan_review family plan_review/,
  );
});
