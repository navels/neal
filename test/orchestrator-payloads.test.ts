import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXECUTE_SCOPE_PROGRESS_PAYLOAD_END, EXECUTE_SCOPE_PROGRESS_PAYLOAD_START, buildFinalCompletionReviewerSchema, buildFinalCompletionSummarySchema, parseExecuteScopeProgressPayload, parseFinalCompletionReviewerPayload, parseFinalCompletionSummaryPayload, stripExecuteScopeProgressPayload } from '../src/neal/agents.js';
import { loadState } from '../src/neal/state.js';
import type { ExecuteScopeProgressJustification, ReviewerMeaningfulProgressVerdict } from '../src/neal/types.js';
import { createResumeFixture } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-payloads');

test('execute scope progress payload parses and strips cleanly from split-plan responses', () => {
  const derivedPlan = [
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: Replace the current scope',
    '- Goal: Narrow the work.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The replacement scope is executable.',
  ].join('\n');
  const response = [
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
    JSON.stringify({
      milestoneTargeted: 'Add the execute-scope progress payload contract.',
      newEvidence: 'The parser and state wiring are implemented.',
      whyNotRedundant: 'This replaces the prior marker-only contract with parseable state.',
      nextStepUnlocked: 'Reviewer prompts can consume the persisted justification next.',
    }),
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
    '',
    derivedPlan,
    '',
    'AUTONOMY_SPLIT_PLAN',
  ].join('\n');

  assert.deepEqual(parseExecuteScopeProgressPayload(response), {
    milestoneTargeted: 'Add the execute-scope progress payload contract.',
    newEvidence: 'The parser and state wiring are implemented.',
    whyNotRedundant: 'This replaces the prior marker-only contract with parseable state.',
    nextStepUnlocked: 'Reviewer prompts can consume the persisted justification next.',
  });
  assert.equal(stripExecuteScopeProgressPayload(response), `${derivedPlan}\n\nAUTONOMY_SPLIT_PLAN`);
});

test('execute scope progress payload parser fails fast on missing required fields', () => {
  const malformed = [
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
    JSON.stringify({
      milestoneTargeted: 'Carry structured justification.',
      newEvidence: '',
      whyNotRedundant: 'The old contract was freeform only.',
      nextStepUnlocked: 'Reviewer integration can use this next.',
    }),
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
    'AUTONOMY_SCOPE_DONE',
  ].join('\n');

  assert.throws(() => parseExecuteScopeProgressPayload(malformed), /empty or missing newEvidence field/);
});

test('final completion summary schema requires the whole-plan completion fields', () => {
  const schema = buildFinalCompletionSummarySchema();

  assert.deepEqual(schema.required, [
    'planGoalSatisfied',
    'whatChangedOverall',
    'verificationSummary',
    'remainingKnownGaps',
  ]);
  assert.equal(schema.properties.planGoalSatisfied.type, 'boolean');
  assert.equal(schema.properties.whatChangedOverall.type, 'string');
  assert.equal(schema.properties.verificationSummary.type, 'string');
  assert.equal(schema.properties.remainingKnownGaps.type, 'array');
});

test('final completion summary parser rejects contradictory completion claims', () => {
  assert.deepEqual(
    parseFinalCompletionSummaryPayload({
      planGoalSatisfied: false,
      whatChangedOverall: 'Added the whole-plan completion packet assembly helper.',
      verificationSummary: 'Ran targeted tests and typecheck.',
      remainingKnownGaps: ['Final completion review is not wired into the execute state machine yet.'],
    }),
    {
      planGoalSatisfied: false,
      whatChangedOverall: 'Added the whole-plan completion packet assembly helper.',
      verificationSummary: 'Ran targeted tests and typecheck.',
      remainingKnownGaps: ['Final completion review is not wired into the execute state machine yet.'],
    },
  );

  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: true,
        whatChangedOverall: 'Added final completion plumbing.',
        verificationSummary: 'Ran pnpm typecheck.',
        remainingKnownGaps: ['Still needs reviewer wiring.'],
      }),
    /planGoalSatisfied=true while remainingKnownGaps is non-empty/,
  );

  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: false,
        whatChangedOverall: 'Added final completion plumbing.',
        verificationSummary: 'Ran pnpm typecheck.',
        remainingKnownGaps: [],
      }),
    /planGoalSatisfied=false with an empty remainingKnownGaps array/,
  );

  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: false,
        whatChangedOverall: 'Added final completion plumbing.',
        verificationSummary: 'Ran pnpm typecheck.',
        remainingKnownGaps: ['  ', ''],
      }),
    /planGoalSatisfied=false with an empty remainingKnownGaps array/,
  );
});

test('final completion parsers reject malformed payload shapes before semantic checks', () => {
  assert.throws(
    () => parseFinalCompletionSummaryPayload([]),
    /Final completion summary payload must be a non-null object/,
  );
  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: true,
        whatChangedOverall: 'Implemented the migration.',
        verificationSummary: false,
        remainingKnownGaps: [],
      }),
    /Final completion summary payload\.verificationSummary must be a string/,
  );
  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'continue_execution',
        summary: 'More work remains.',
        rationale: 'A gap exists.',
        missingWork: 'missing',
        squashCommitMessage: null,
      }),
    /Final completion reviewer verdict payload\.missingWork must be a non-null object/,
  );
});

test('final completion reviewer schema requires verdict action and missing-work contract', () => {
  const schema = buildFinalCompletionReviewerSchema();

  assert.deepEqual(schema.required, ['action', 'summary', 'rationale', 'missingWork', 'squashCommitMessage']);
  assert.equal(schema.properties.action.type, 'string');
  assert.equal(schema.properties.summary.type, 'string');
  assert.equal(schema.properties.rationale.type, 'string');
  assert.deepEqual(schema.properties.missingWork.type, ['object', 'null']);
  assert.deepEqual(schema.properties.squashCommitMessage.type, ['object', 'null']);
  // squashCommitMessage object shape is the contract; its LLM-facing description
  // prose is not, so assert the nested field names instead of the description text.
  assert.ok(schema.properties.squashCommitMessage.properties.subject);
  assert.ok(schema.properties.squashCommitMessage.properties.bullets);
});

test('final completion reviewer parser enforces continue_execution missing-work rules', () => {
  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork: {
        summary: 'Add the final completion reviewer transition.',
        requiredOutcome: 'Wire the reviewer verdict into the execute state machine before completion.',
        verification: 'Run orchestrator and review tests plus typecheck.',
      },
      squashCommitMessage: null,
    }),
    {
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork: {
        summary: 'Add the final completion reviewer transition.',
        requiredOutcome: 'Wire the reviewer verdict into the execute state machine before completion.',
        verification: 'Run orchestrator and review tests plus typecheck.',
      },
      squashCommitMessage: null,
    },
  );

  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'continue_execution',
        summary: 'Need more work.',
        rationale: 'The plan is not complete yet.',
        missingWork: null,
        squashCommitMessage: {
          subject: 'Complete tmp/13_NEAL_FINAL_COMPLETION_STALE_STATUS_RECONCILIATION_PLAN.md',
          bullets: [
            'Persist final completion behavior for the Neal run.',
            'Verify the completed behavior with focused tests.',
          ],
        },
      }),
    /missingWork payload when action=continue_execution/,
  );

  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'continue_execution',
        summary: 'Need more work.',
        rationale: 'The plan is not complete yet.',
        missingWork: {
          summary: 'Add coverage.',
          requiredOutcome: '   ',
          verification: 'Run focused tests.',
        },
        squashCommitMessage: null,
      }),
    /missingWork payload when action=continue_execution/,
  );

  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'accept_complete',
        summary: 'The plan is complete.',
        rationale: 'The reviewer accepted the whole-plan result.',
        missingWork: {
          summary: 'should not be here',
          requiredOutcome: 'n/a',
          verification: 'n/a',
        },
        squashCommitMessage: {
          subject: 'Persist final completion squash drafts',
          bullets: [
            'Store semantic squash summaries in completion state.',
            'Render the draft in final completion artifacts.',
          ],
        },
      }),
    /cannot include missingWork when action=accept_complete/,
  );

  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'block_for_operator',
        summary: 'Operator input is required.',
        rationale: 'The reviewer cannot determine whether the run is complete.',
        missingWork: {
          summary: 'should not be here',
          requiredOutcome: 'n/a',
          verification: 'n/a',
        },
        squashCommitMessage: null,
      }),
    /cannot include missingWork when action=block_for_operator/,
  );
});

test('final completion reviewer parser ignores squashCommitMessage for non-accept verdicts', () => {
  const validSquashDraft = {
    subject: 'Persist final completion squash drafts',
    bullets: [
      'Store semantic squash summaries in completion state.',
      'Render the draft in final completion artifacts.',
    ],
  };
  const invalidSquashDraft = {
    subject: 'Complete tmp/13_NEAL_FINAL_COMPLETION_STALE_STATUS_RECONCILIATION_PLAN.md',
    bullets: [
      'Persist final completion behavior for the Neal run.',
      'Verify the completed behavior with focused tests.',
    ],
  };
  const missingWork = {
    summary: 'Add the final completion reviewer transition.',
    requiredOutcome: 'Wire the reviewer verdict into the execute state machine before completion.',
    verification: 'Run orchestrator and review tests plus typecheck.',
  };

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork,
      squashCommitMessage: validSquashDraft,
    }),
    {
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork,
      squashCommitMessage: invalidSquashDraft,
    }),
    {
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork,
    }),
    {
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'block_for_operator',
      summary: 'Operator input is required.',
      rationale: 'The reviewer cannot determine whether the run is complete.',
      missingWork: null,
      squashCommitMessage: validSquashDraft,
    }),
    {
      action: 'block_for_operator',
      summary: 'Operator input is required.',
      rationale: 'The reviewer cannot determine whether the run is complete.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'block_for_operator',
      summary: 'Operator input is required.',
      rationale: 'The reviewer cannot determine whether the run is complete.',
      missingWork: null,
      squashCommitMessage: invalidSquashDraft,
    }),
    {
      action: 'block_for_operator',
      summary: 'Operator input is required.',
      rationale: 'The reviewer cannot determine whether the run is complete.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'block_for_operator',
      summary: 'Operator input is required.',
      rationale: 'The reviewer cannot determine whether the run is complete.',
      missingWork: null,
    }),
    {
      action: 'block_for_operator',
      summary: 'Operator input is required.',
      rationale: 'The reviewer cannot determine whether the run is complete.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );
});

test('final completion reviewer parser accepts absent squashCommitMessage for accept_complete', () => {
  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Persist final completion squash drafts',
        bullets: [
          'Store semantic squash summaries in completion state.',
          'Render the draft in final completion artifacts.',
        ],
      },
    }),
    {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Persist final completion squash drafts',
        bullets: [
          'Store semantic squash summaries in completion state.',
          'Render the draft in final completion artifacts.',
        ],
      },
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: null,
    }),
    {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
    }),
    {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Complete tmp/13_NEAL_FINAL_COMPLETION_STALE_STATUS_RECONCILIATION_PLAN.md',
        bullets: [
          'Persist final completion behavior for the Neal run.',
          'Verify the completed behavior with focused tests.',
        ],
      },
    }),
    {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );
});

test('final completion reviewer parser repairs recoverable accepted squash drafts', () => {
  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Scope 2: Repair final completion squash metadata',
        bullets: [
          '1. Store semantic squash summaries in completion state.',
          '2. Record tmp/16_NEAL_FINAL_COMPLETION_SQUASH_RECOVERY_PLAN.md',
          '3. Render accepted drafts in final completion artifacts.',
        ],
      },
    }),
    {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Repair final completion squash metadata',
        bullets: [
          'Store semantic squash summaries in completion state',
          'Render accepted drafts in final completion artifacts',
        ],
      },
    },
  );

  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Complete tmp/16_NEAL_FINAL_COMPLETION_SQUASH_RECOVERY_PLAN.md',
        bullets: [
          'Store semantic squash summaries in completion state.',
          'Render accepted drafts in final completion artifacts.',
        ],
      },
    }),
    {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'The reviewer accepted the whole-plan result.',
      missingWork: null,
      squashCommitMessage: null,
    },
  );
});

test('state round-trip preserves current execute-scope progress justification', async () => {
  const justification: ExecuteScopeProgressJustification = {
    milestoneTargeted: 'Scope 2 payload contract',
    newEvidence: 'The response now carries parseable JSON.',
    whyNotRedundant: 'The marker alone cannot support the progress gate.',
    nextStepUnlocked: 'Scope 3 can pass reviewer context deterministically.',
  };
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    currentScopeProgressJustification: justification,
  });

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.cwd, cwd);
  assert.deepEqual(reloadedState.currentScopeProgressJustification, justification);
});

test('state round-trip preserves the final completion summary', async () => {
  const { cwd, statePath } = await createResumeFixture({
    phase: 'done',
    status: 'done',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the packet plumbing but not the reviewer gate.',
      verificationSummary: 'Ran review and orchestrator tests.',
      remainingKnownGaps: ['Reviewer final-completion verdict is not wired yet.'],
    },
  });

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.cwd, cwd);
  assert.deepEqual(reloadedState.finalCompletionSummary, {
    planGoalSatisfied: false,
    whatChangedOverall: 'Implemented the packet plumbing but not the reviewer gate.',
    verificationSummary: 'Ran review and orchestrator tests.',
    remainingKnownGaps: ['Reviewer final-completion verdict is not wired yet.'],
  });
});

test('state round-trip preserves final completion recovery metadata', async () => {
  const { statePath } = await createResumeFixture({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'final_completion_review',
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'One more follow-on scope was requested.',
      rationale: 'The plan is close, but one execution repair remains.',
      missingWork: {
        summary: 'Add the missing final-completion branch.',
        requiredOutcome: 'Wire the remaining reviewer decision into execute-mode completion.',
        verification: 'Run orchestrator and review tests plus typecheck.',
      },
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'block_for_operator',
    finalCompletionContinueExecutionCount: 2,
    finalCompletionContinueExecutionCapReached: true,
  });

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.finalCompletionResolvedAction, 'block_for_operator');
  assert.equal(reloadedState.finalCompletionContinueExecutionCount, 2);
  assert.equal(reloadedState.finalCompletionContinueExecutionCapReached, true);
  assert.equal(reloadedState.finalCompletionReviewVerdict?.action, 'continue_execution');
  assert.equal(reloadedState.finalCompletionReviewVerdict?.missingWork?.summary, 'Add the missing final-completion branch.');
});

test('state round-trip preserves current reviewer meaningful-progress verdict', async () => {
  const verdict: ReviewerMeaningfulProgressVerdict = {
    action: 'replace_plan',
    rationale: 'Recent accepted scopes keep returning to src/shared.ts without moving the parent objective forward.',
  };
  const { statePath } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'blocked',
    status: 'blocked',
    currentScopeMeaningfulProgressVerdict: verdict,
  });

  const reloadedState = await loadState(statePath);
  assert.deepEqual(reloadedState.currentScopeMeaningfulProgressVerdict, verdict);
});
