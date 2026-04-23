import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveFinalCompletionAdjudicationContext,
  runFinalCompletionReviewerAdjudication,
  runFinalCompletionSummaryAdjudication,
} from '../src/neal/adjudicator/final-completion.js';
import { assertAdjudicationTransitionSignal, getAdjudicationSpec } from '../src/neal/adjudicator/specs.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { FinalCompletionPacket, OrchestrationState } from '../src/neal/types.js';

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-adjudicator-final-completion-'));
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

function createPacket(): FinalCompletionPacket {
  return {
    planDoc: '/tmp/PLAN.md',
    executionShape: 'multi_scope',
    currentScopeLabel: '5',
    finalCommit: 'final-commit',
    completedScopeSummary: '- Scope 5: accepted',
    acceptedScopeCount: 5,
    blockedScopeCount: 0,
    verificationOnlyCompletion: false,
    terminalChangedFiles: ['src/neal/orchestrator.ts'],
    terminalChangedFilesSummary: '- src/neal/orchestrator.ts',
    planChangedFiles: ['src/neal/orchestrator.ts', 'src/neal/adjudicator/final-completion.ts'],
    planChangedFilesSummary: '- src/neal/orchestrator.ts\n- src/neal/adjudicator/final-completion.ts',
    residualReviewDebt: [],
    residualReviewDebtSummary: 'No unresolved non-blocking review debt was recorded for accepted scopes.',
    verificationCommands: ['pnpm exec tsx --test test/orchestrator.test.ts', 'pnpm typecheck'],
    verificationSummary: 'Recorded verification commands for this run.',
    lastNonEmptyImplementationScope: {
      number: '5',
      finalCommit: 'final-commit',
      commitSubject: 'finish scope 5',
      changedFiles: ['src/neal/orchestrator.ts'],
      archivedReviewPath: '/tmp/review-final.md',
    },
    continueExecutionCount: 0,
    continueExecutionMax: 1,
  };
}

test('resolveFinalCompletionAdjudicationContext binds the final completion spec to the packet and summary state', async () => {
  const packet = createPacket();
  const { state } = await createState({
    phase: 'final_completion_review',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Added final completion adjudication helpers.',
      verificationSummary: 'Ran adjudicator coverage.',
      remainingKnownGaps: ['Orchestrator wiring still needs to be verified.'],
    },
  });

  const context = resolveFinalCompletionAdjudicationContext({ state, packet });
  assert.equal(context.spec.id, 'final_completion_review');
  assert.equal(context.spec.family, 'final_completion');
  assert.equal(context.packet.finalCommit, 'final-commit');
  assert.equal(context.summary?.whatChangedOverall, 'Added final completion adjudication helpers.');
});

test('final completion adjudicator runners preserve packet and summary context when they call injected round runners', async () => {
  const packet = createPacket();
  const { state } = await createState({
    phase: 'final_completion_review',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Added final completion adjudication helpers.',
      verificationSummary: 'Ran adjudicator coverage.',
      remainingKnownGaps: ['Reviewer transition wiring still needs coverage.'],
    },
  });

  let summaryArgs: any = null;
  const summaryResult = await runFinalCompletionSummaryAdjudication({
    state,
    packet,
    runSummaryRound: async (args) => {
      summaryArgs = args;
      return {
        sessionHandle: 'coder-final-completion-1',
        summary: {
          planGoalSatisfied: true,
          whatChangedOverall: 'Whole-plan context was summarized for the reviewer.',
          verificationSummary: 'Ran final completion adjudicator coverage.',
          remainingKnownGaps: [],
        },
      };
    },
  });

  assert.equal(summaryResult.context.spec.id, 'final_completion_review');
  assert.equal(summaryArgs?.planDoc, state.planDoc);
  assert.deepEqual(summaryArgs?.packet, packet);

  let reviewerArgs: any = null;
  const reviewerResult = await runFinalCompletionReviewerAdjudication({
    state,
    packet,
    runReviewerRound: async (args) => {
      reviewerArgs = args;
      return {
        sessionHandle: 'reviewer-final-completion-1',
        verdict: {
          action: 'continue_execution',
          summary: 'One bounded follow-on scope remains.',
          rationale: 'The final completion review still found one explicit gap.',
          missingWork: {
            summary: 'Add the remaining follow-on scope.',
            requiredOutcome: 'Reopen execution once before final completion.',
            verification: 'Run orchestrator tests plus typecheck.',
          },
        },
      };
    },
  });

  assert.equal(summaryResult.summary.summary.planGoalSatisfied, true);
  assert.equal(reviewerResult.context.spec.id, 'final_completion_review');
  assert.equal(reviewerArgs?.planDoc, state.planDoc);
  assert.deepEqual(reviewerArgs?.packet, packet);
  assert.deepEqual(reviewerArgs?.summary, state.finalCompletionSummary);
  assert.equal(reviewerResult.reviewerResult.verdict.action, 'continue_execution');
});

test('final completion reviewer adjudication rejects missing summary state before calling the reviewer', async () => {
  const packet = createPacket();
  const { state } = await createState({
    phase: 'final_completion_review',
    finalCompletionSummary: null,
  });

  await assert.rejects(
    () =>
      runFinalCompletionReviewerAdjudication({
        state,
        packet,
        runReviewerRound: async () => {
          throw new Error('should not be called');
        },
      }),
    /Cannot run final completion reviewer adjudication without a final completion summary/,
  );
});

test('final completion transition assertions reject impossible live outcomes for the active completion spec', () => {
  const spec = getAdjudicationSpec('final_completion_review');

  assert.throws(
    () => assertAdjudicationTransitionSignal(spec, 'request_revision', 'test:final-completion-boundary'),
    /test:final-completion-boundary resolved transition signal request_revision for adjudication spec final_completion_review family final_completion/,
  );
});
