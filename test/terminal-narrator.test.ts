import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTerminalNarrator,
  renderTerminalNarrativeEvents,
} from '../src/neal/terminal-narrator.js';
import { configureDiagnosticFooter, resetDiagnosticStateForTests } from '../src/neal/diagnostic.js';
import type { RunLogger } from '../src/neal/logger.js';
import { printReviewResult } from '../src/neal/orchestrator/phases/shared.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState, ReviewFinding } from '../src/neal/types.js';

class FakeFooter {
  readonly writes: string[] = [];

  write(message: string) {
    this.writes.push(message);
  }

  dispose() {}
}

class FakeLogger {
  readonly stderrMessages: string[] = [];

  async stderr(message: string) {
    this.stderrMessages.push(message);
  }

  async event() {}

  asRunLogger() {
    return this as unknown as RunLogger;
  }
}

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-terminal-narrator-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'narrator-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    planDoc,
    [
      '# Narrator Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
      '## Execution Queue',
      '',
      '### Scope 1: Add scope title narration',
      '- Goal: Add scope titles to terminal narration.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: Scope titles appear in narration.',
      '',
      '### Scope 2: Restore narrative view',
      '- Goal: Restore narrative view after detail view.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: Narrative view is restored.',
      '',
    ].join('\n'),
    'utf8',
  );

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    '1111111111111111111111111111111111111111',
  );

  return {
    ...state,
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'R1-F1',
    canonicalId: 'C1',
    round: 1,
    source: 'reviewer',
    severity: 'blocking',
    files: ['src/example.ts'],
    claim: 'A behavior is broken.',
    evidence: 'The test fails.',
    requiredAction: 'Fix the behavior.',
    status: 'open',
    roundSummary: 'Needs work.',
    coderDisposition: null,
    coderCommit: null,
    ...overrides,
  };
}

function scopeAccountingGuardrailState(): Partial<OrchestrationState> {
  const unsafeReason =
    'Unsafe advance_parent for parent objective 4 cannot proceed; failed preconditions: ' +
    'accepted derived plan is not actively executing; parent objective has no prior substantive accepted derived sub-scope. ' +
    'Reviewer rationale: prior accepted benchmark work satisfies scope 4.';

  return {
    status: 'running',
    phase: 'interactive_blocked_recovery',
    currentScopeNumber: 4,
    executionShape: 'multi_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-07T15:41:51.055Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: unsafeReason,
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'block_for_operator',
      rationale: unsafeReason,
    },
    currentScopeProgressJustification: {
      milestoneTargeted: 'Scope 4 blocker guidance fixture',
      newEvidence: 'Focused verification and `pnpm typecheck` passed with an empty current diff.',
      whyNotRedundant: 'Prior accepted benchmark-mode work under parent scope 2 satisfies this objective.',
      nextStepUnlocked: 'The operator can decide whether to accept the already-satisfied scope or verify it directly.',
    },
    rounds: [
      {
        round: 2,
        reviewerSessionHandle: 'reviewer-session',
        reviewedPlanPath: null,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: {
          base: 'base-commit',
          head: 'head-commit',
        },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    findings: [],
    completedScopes: [
      {
        number: '2.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-2-1',
        finalCommit: 'final-2-1',
        summary: 'Implemented benchmark mode.',
        commitSubject: 'add benchmark mode',
        changedFiles: ['benchmark/lib/neal.ts'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-2.1.md',
        blocker: null,
        derivedFromParentScope: '2',
        replacedByDerivedPlanPath: null,
      },
    ],
  };
}

test('terminal narrator emits concise transition lines once per stable signature', async () => {
  const writes: string[] = [];
  const state = await createState({ phase: 'coder_scope', currentScopeNumber: 1 });
  const narrator = createTerminalNarrator({
    write(message) {
      writes.push(message);
    },
  });

  await narrator.start(state);
  await narrator.observe(state);
  await narrator.observe({ ...state, phase: 'reviewer_scope', createdCommits: ['2222222222222222222222222222222222222222'] });
  await narrator.observe({
    ...state,
    phase: 'coder_response',
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-1',
        reviewedPlanPath: null,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: '1111111111111111111111111111111111111111', head: '2222222222222222222222222222222222222222' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [finding()],
  });
  await narrator.observe({ ...state, phase: 'execute_finalization', createdCommits: ['2222222222222222222222222222222222222222'] });
  await narrator.observe({
    ...state,
    currentScopeNumber: 2,
    baseCommit: '3333333333333333333333333333333333333333',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: '1111111111111111111111111111111111111111',
        finalCommit: '3333333333333333333333333333333333333333',
        summary: 'Scope accepted.',
        commitSubject: 'Accept scope',
        changedFiles: ['src/example.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await narrator.observe({
    ...state,
    phase: 'final_completion_review',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the plan.',
      verificationSummary: 'Tests passed.',
      remainingKnownGaps: [],
    },
  });
  await narrator.observe({
    ...state,
    phase: 'done',
    status: 'done',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the plan.',
      verificationSummary: 'Tests passed.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'Complete.',
      rationale: 'The plan goal is satisfied.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Complete plan execution',
        bullets: [
          'Deliver the requested implementation.',
          'Verify the completed result with tests.',
        ],
      },
    },
    finalCompletionResolvedAction: 'accept_complete',
  });

  const output = writes.join('');
  assert.deepEqual(output.trim().split('\n'), [
    '[neal] starting plan execution for PLAN.md',
    'Scope 1/2: Add scope title narration',
    'Coder is implementing.',
    'Reviewer is checking.',
    'Reviewer requested revisions; coder is addressing them.',
    'Reviewer accepted; finalizing.',
    'Scope accepted.',
    'Scope 2/2: Restore narrative view',
    'Coder is implementing.',
    'Reviewer is checking final completion.',
    'Final completion review accepted the implementation.',
    'Implementation complete.',
  ]);
  assert.equal((output.match(/^Scope 1\/2: Add scope title narration$/gm) ?? []).length, 1);
  assert.equal((output.match(/^Scope 2\/2: Restore narrative view$/gm) ?? []).length, 1);
});

test('terminal narrator uses planner wording for plan refinement phases', async () => {
  const writes: string[] = [];
  const state = await createState({ topLevelMode: 'plan', phase: 'coder_plan', status: 'running' });
  const narrator = createTerminalNarrator({
    write(message) {
      writes.push(message);
    },
  });

  await narrator.start(state);
  await narrator.observe(state);
  await narrator.observe({ ...state, phase: 'reviewer_plan' });
  await narrator.observe({ ...state, phase: 'coder_plan_response' });
  await narrator.observe({ ...state, phase: 'coder_plan_optional_response' });

  assert.deepEqual(writes.join('').trim().split('\n'), [
    '[neal] starting plan refinement for PLAN.md',
    'Planner is refining the plan.',
    'Reviewer is checking the plan.',
    'Planner is addressing requested plan revisions.',
    'Planner is handling optional plan follow-up.',
  ]);
});

test('terminal narrator titles final-completion reopen and degrades when the plan is unreadable', async () => {
  const titledState = await createState({
    phase: 'coder_scope',
    currentScopeNumber: 2,
    finalCompletionResolvedAction: 'continue_execution',
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'Continue.',
      rationale: 'More implementation is needed.',
      missingWork: {
        summary: 'Finish scope 2.',
        requiredOutcome: 'Scope 2 complete.',
        verification: 'Run the focused tests.',
      },
      squashCommitMessage: null,
    },
    finalCompletionContinueExecutionCount: 1,
  });
  const titledWrites: string[] = [];
  const titledNarrator = createTerminalNarrator({
    write(message) {
      titledWrites.push(message);
    },
  });

  await titledNarrator.start(titledState);

  const titledOutput = titledWrites.join('');
  assert.match(titledOutput, /Scope 2\/2: Restore narrative view\nCoder is implementing\./);
  assert.match(titledOutput, /Final completion review reopened execution; continuing\./);
  assert.doesNotMatch(titledOutput, /continuing with scope 2\/2: Restore narrative view/);

  const missingPlanState = await createState({
    phase: 'coder_scope',
    currentScopeNumber: 2,
    planDoc: join(tmpdir(), 'neal-missing-plan.md'),
  });
  const missingWrites: string[] = [];
  const missingNarrator = createTerminalNarrator({
    write(message) {
      missingWrites.push(message);
    },
  });

  await missingNarrator.start(missingPlanState);

  assert.match(missingWrites.join(''), /Scope 2\nCoder is implementing\./);
  assert.doesNotMatch(missingWrites.join(''), /Restore narrative view/);

  const invalidRoot = await mkdtemp(join(tmpdir(), 'neal-terminal-narrator-invalid-'));
  const invalidPlanPath = join(invalidRoot, 'PLAN.md');
  await writeFile(
    invalidPlanPath,
    [
      '# Invalid Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
    ].join('\n'),
    'utf8',
  );
  const invalidPlanState = await createState({
    phase: 'coder_scope',
    currentScopeNumber: 2,
    planDoc: invalidPlanPath,
  });
  const invalidWrites: string[] = [];
  const invalidNarrator = createTerminalNarrator({
    write(message) {
      invalidWrites.push(message);
    },
  });

  await invalidNarrator.start(invalidPlanState);

  assert.match(invalidWrites.join(''), /Scope 2\nCoder is implementing\./);
  assert.doesNotMatch(invalidWrites.join(''), /Restore narrative view/);
});

test('terminal narrator announces derived scope context once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-terminal-narrator-derived-'));
  const derivedPlanPath = join(root, 'DERIVED.md');
  await writeFile(
    derivedPlanPath,
    [
      '# Derived Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
      '## Execution Queue',
      '',
      '### Scope 1: Prepare derived plumbing',
      '- Goal: Do the first derived step.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: The first derived step is complete.',
      '',
      '### Scope 2: Add fixture coverage',
      '- Goal: Add derived fixture coverage.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: Fixture coverage is present.',
      '',
    ].join('\n'),
    'utf8',
  );
  const state = await createState({
    phase: 'coder_scope',
    currentScopeNumber: 5,
    derivedPlanPath,
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
  });
  const writes: string[] = [];
  const narrator = createTerminalNarrator({
    write(message) {
      writes.push(message);
    },
  });

  await narrator.start(state);
  await narrator.observe(state);

  const output = writes.join('');
  assert.match(output, /Scope 5\.2: Add fixture coverage\nCoder is implementing\./);
  assert.equal((output.match(/^Scope 5\.2: Add fixture coverage$/gm) ?? []).length, 1);
});

test('terminal narrator distinguishes waiting and pending recovery guidance', async () => {
  const waitingState = await createState({
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-05-17T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 1,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-05-17T00:01:00.000Z',
          operatorGuidance: 'Try a smaller change.',
          origin: 'operator',
          disposition: null,
        },
      ],
    },
  });
  const pendingState = {
    ...waitingState,
    interactiveBlockedRecovery: {
      ...waitingState.interactiveBlockedRecovery!,
      lastHandledTurn: 0,
    },
  };

  assert.deepEqual(renderTerminalNarrativeEvents(waitingState).map((event) => event.line), [
    '[neal] waiting for operator guidance: Neal stopped because scope 1 needs operator guidance before it can continue.; use: neal resume --run narrator-run --message "Continue using this operator guidance. Keep existing verification requirements intact and do not assume any extra authorization."',
  ]);
  assert.deepEqual(renderTerminalNarrativeEvents(pendingState).map((event) => event.line), [
    'Operator guidance is recorded; resuming will process it now.',
  ]);
});

test('terminal narrator uses scope-accounting guidance for known waiting blocks', async () => {
  const state = await createState(scopeAccountingGuardrailState());

  const lines = renderTerminalNarrativeEvents(state).map((event) => event.line);

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /scope-accounting guardrail/);
  assert.match(lines[0] ?? '', /neal resume --run narrator-run --message "Accept scope 4 as already satisfied/);
  assert.doesNotMatch(lines[0] ?? '', /Unsafe advance_parent|failed preconditions|accepted derived plan is not actively executing|--message "\.\.\."/);
});

test('review diagnostics route full reviewer detail away from default terminal output', () => {
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    printReviewResult(
      'review',
      'The implementation needs a fix.',
      [
        {
          source: 'reviewer',
          severity: 'blocking',
          files: ['src/example.ts'],
          claim: 'A detailed reviewer claim.',
          requiredAction: 'Apply a detailed fix.',
        },
      ],
      logger.asRunLogger(),
    );

    assert.deepEqual(footer.writes, []);
    assert.equal(logger.stderrMessages.length, 1);
    assert.match(logger.stderrMessages[0] ?? '', /\[reviewer:review\] summary: The implementation needs a fix\./);
    assert.match(logger.stderrMessages[0] ?? '', /A detailed reviewer claim\./);
  } finally {
    resetDiagnosticStateForTests();
  }
});
