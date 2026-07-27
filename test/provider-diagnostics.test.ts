import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureDiagnosticFooter,
  getBufferedDetailSnapshot,
  isDiagnosticDetailVisible,
  resetDiagnosticStateForTests,
  setDiagnosticDetailContext,
  setDiagnosticDetailVisibility,
  showDiagnosticDetailView,
  showDiagnosticNarrativeView,
  writeBufferedDetail,
  writeDetail,
  writeNarrative,
} from '../src/neal/diagnostic.js';
import type { RunLogger } from '../src/neal/logger.js';
import { renderFinalRunOutput } from '../src/neal/commands/runtime.js';
import { writePhaseHeartbeatDetail } from '../src/neal/orchestrator.js';
import { getRunDisplayStatus } from '../src/neal/run-status.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

class FakeFooter {
  readonly writes: string[] = [];

  write(message: string) {
    this.writes.push(message);
  }

  dispose() {}
}

class FakeManagedFooter extends FakeFooter {
  readonly replacementViews: string[] = [];

  isEnabled() {
    return true;
  }

  replaceView(message: string) {
    this.replacementViews.push(message);
  }
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
  const root = await mkdtemp(join(tmpdir(), 'neal-runtime-output-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'runtime-output-test');
  const planDoc = join(cwd, 'PLAN.md');
  const statePath = join(runDir, 'RUN_STATE.json');

  await mkdir(runDir, { recursive: true });
  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: one_shot
`,
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
    'abc123',
  );

  return {
    state: {
      ...state,
      ...overrides,
    },
    statePath,
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

test('explicit diagnostic APIs keep detail artifact-only unless detail visibility is enabled', () => {
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    assert.equal(isDiagnosticDetailVisible(), false);

    setDiagnosticDetailContext({
      runId: 'run-1',
      phase: 'coder_scope',
      scopeNumber: 1,
      provider: 'openai-codex',
      role: 'coder',
      commandSummary: 'pnpm test',
      fileCount: 2,
      timestamp: '2026-05-17T00:00:00.000Z',
    });
    writeNarrative('[neal] summary\n', logger.asRunLogger());
    writeDetail('raw provider output\n', logger.asRunLogger());

    assert.deepEqual(footer.writes, ['[neal] summary\n']);
    assert.deepEqual(logger.stderrMessages, ['[neal] summary\n', 'raw provider output\n']);

    const buffered = getBufferedDetailSnapshot({ runId: 'run-1', phase: 'coder_scope', scopeNumber: 1 });
    assert.equal(buffered.entries.length, 1);
    assert.equal(buffered.entries[0]?.message, 'raw provider output\n');
    assert.deepEqual(buffered.entries[0]?.context, {
      runId: 'run-1',
      phase: 'coder_scope',
      scopeNumber: 1,
      provider: 'openai-codex',
      role: 'coder',
      commandSummary: 'pnpm test',
      fileCount: 2,
      timestamp: '2026-05-17T00:00:00.000Z',
    });
    assert.equal(getBufferedDetailSnapshot({ runId: 'run-2' }).entries.length, 0);

    setDiagnosticDetailVisibility(true);
    writeBufferedDetail({ runId: 'run-1', phase: 'coder_scope' });
    writeDetail('raw provider output visible\n', logger.asRunLogger());

    assert.deepEqual(footer.writes, ['[neal] summary\n', 'raw provider output\n', 'raw provider output visible\n']);
    assert.deepEqual(logger.stderrMessages, [
      '[neal] summary\n',
      'raw provider output\n',
      'raw provider output visible\n',
    ]);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('narrative redraw replays buffered narrative without duplicating persisted stderr', () => {
  const footer = new FakeManagedFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    writeNarrative('first narrative\n', logger.asRunLogger());
    showDiagnosticDetailView();
    writeNarrative('second narrative\n', logger.asRunLogger());
    const stderrBeforeRedraw = [...logger.stderrMessages];

    showDiagnosticNarrativeView();

    assert.deepEqual(footer.writes, ['first narrative\n']);
    assert.deepEqual(footer.replacementViews, ['', 'first narrative\nsecond narrative\n']);
    assert.deepEqual(logger.stderrMessages, stderrBeforeRedraw);
    assert.doesNotMatch(footer.replacementViews.at(-1) ?? '', /omitted from buffer/);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('detail buffer is bounded and reports dropped older entries during replay', () => {
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    for (let index = 0; index < 405; index += 1) {
      writeDetail(`detail ${index}\n`, logger.asRunLogger(), {
        runId: 'run-1',
        phase: 'coder_scope',
      });
    }

    const buffered = getBufferedDetailSnapshot({ runId: 'run-1' });
    assert.equal(buffered.entries.length, 400);
    assert.equal(buffered.droppedEntries, 5);
    assert.ok(buffered.droppedBytes > 0);
    assert.equal(buffered.entries[0]?.message, 'detail 5\n');

    setDiagnosticDetailVisibility(true);
    writeBufferedDetail({ runId: 'run-1' });

    const terminal = footer.writes.join('');
    assert.match(terminal, /earlier detail omitted from buffer \(5 entries, \d+ bytes\)/);
    assert.doesNotMatch(terminal, /detail 0\n/);
    assert.match(terminal, /detail 404\n/);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('narrative redraw reports dropped older entries only after narrative buffer truncation', () => {
  const footer = new FakeManagedFooter();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    for (let index = 0; index < 405; index += 1) {
      writeNarrative(`narrative ${index}\n`);
    }

    showDiagnosticDetailView();
    showDiagnosticNarrativeView();

    const redrawnNarrative = footer.replacementViews.at(-1) ?? '';
    assert.match(redrawnNarrative, /earlier narrative omitted from buffer \(5 entries, \d+ bytes\)/);
    assert.doesNotMatch(redrawnNarrative, /narrative 0\n/);
    assert.match(redrawnNarrative, /narrative 404\n/);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('phase heartbeat detail is hidden from the default terminal but kept for artifacts and replay', async () => {
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  const { state } = await createState({
    phase: 'coder_scope',
    currentScopeNumber: 2,
    coderSessionHandle: 'coder-session-123',
    reviewerSessionHandle: 'reviewer-session-456',
  });
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    writePhaseHeartbeatDetail({
      state,
      phase: 'coder_scope',
      elapsedMs: 61_234,
      logger: logger.asRunLogger(),
    });

    assert.deepEqual(footer.writes, []);
    assert.equal(logger.stderrMessages.length, 1);
    assert.match(logger.stderrMessages[0] ?? '', /heartbeat phase=coder_scope elapsed=61s/);
    assert.match(logger.stderrMessages[0] ?? '', /coder=coder-session-123/);
    assert.match(logger.stderrMessages[0] ?? '', /reviewer=reviewer-session-456/);

    const buffered = getBufferedDetailSnapshot({
      runId: 'runtime-output-test',
      phase: 'coder_scope',
      scopeNumber: 2,
    });
    assert.equal(buffered.entries.length, 1);
    assert.equal(buffered.entries[0]?.message, logger.stderrMessages[0]);

    setDiagnosticDetailVisibility(true);
    writeBufferedDetail({ runId: 'runtime-output-test', phase: 'coder_scope' });
    assert.match(footer.writes.join(''), /heartbeat phase=coder_scope elapsed=61s/);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('final run output is compact and points to the retrospective artifact', async () => {
  const { state, statePath } = await createState({
    phase: 'done',
    status: 'done',
    finalCommit: '1234567890abcdef',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: 'abc123',
        finalCommit: '1234567890abcdef',
        summary: 'Implemented the plan.',
        commitSubject: 'Implement the plan',
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
  await writeFile(
    join(state.runDir, 'RETROSPECTIVE.md'),
    '# Long Retrospective\n\nThis detailed retrospective should stay in the artifact.\n',
    'utf8',
  );

  const output = renderFinalRunOutput(state, statePath, getRunDisplayStatus(state));

  assert.match(output, /Implementation complete\./);
  assert.match(output, /- Status: done/);
  assert.match(output, /- Final commit: 1234567890abcdef/);
  assert.match(output, /- Retrospective: .*RETROSPECTIVE\.md/);
  assert.doesNotMatch(output, /This detailed retrospective should stay in the artifact/);
});

test('final run output directs failed runs to status and resume', async () => {
  const { state, statePath } = await createState({
    phase: 'coder_scope',
    status: 'failed',
  });

  const output = renderFinalRunOutput(state, statePath, getRunDisplayStatus(state));

  assert.match(
    output,
    /## Next Action\n- Inspect failure: neal status --run runtime-output-test; resume when ready: neal resume --run runtime-output-test/,
  );
});

test('final run output directs blocked runs to status and waiting-guidance resume', async () => {
  const { state, statePath } = await createState({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
  });

  const output = renderFinalRunOutput(state, statePath, getRunDisplayStatus(state));

  assert.match(
    output,
    /## Next Action\n- Inspect blocked run: neal status --run runtime-output-test; provide guidance with neal resume --run runtime-output-test --message "\.\.\." only if the run is waiting for operator guidance/,
  );
});

test('final run output includes deterministic waiting-guidance sections before next action', async () => {
  const { state, statePath } = await createState({
    phase: 'interactive_blocked_recovery',
    status: 'blocked',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-02T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Waiting for a scheduled run before manual validation can complete.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
  });

  const output = renderFinalRunOutput(state, statePath, getRunDisplayStatus(state));

  assert.match(output, /## Why Neal Stopped/);
  assert.match(output, /## Resume Options/);
  assert.match(output, /## Useful Artifacts/);
  assert.match(output, /neal resume --run runtime-output-test --message "/);
  assert.match(output, /Waiting for a scheduled run/);
  assert.ok(output.indexOf('## Useful Artifacts') < output.indexOf('## Next Action'));
});

test('final run output uses scope-accounting guidance and a concrete next action', async () => {
  const { state, statePath } = await createState(scopeAccountingGuardrailState());

  const output = renderFinalRunOutput(state, statePath, getRunDisplayStatus(state));
  const firstGuidanceLines = output
    .slice(output.indexOf('## Why Neal Stopped'))
    .split('\n')
    .slice(0, 5)
    .join('\n');

  assert.match(output, /## Why Neal Stopped/);
  assert.match(output, /scope-accounting guardrail/);
  assert.match(output, /Accept already-satisfied scope/);
  assert.match(output, /Continue scope directly/);
  assert.match(output, /Replace with verification-only scope/);
  assert.match(output, /Technical details:/);
  assert.match(output, /advance_parent preconditions failed/);
  assert.match(
    output,
    /## Next Action\n- Use the first resume option above: neal resume --run runtime-output-test --message "Accept scope 4 as already satisfied/,
  );
  assert.doesNotMatch(firstGuidanceLines, /Unsafe advance_parent|failed preconditions|accepted derived plan is not actively executing/);
});
