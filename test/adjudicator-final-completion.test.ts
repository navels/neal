import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  resolveFinalCompletionAdjudicationContext,
  runFinalCompletionReviewerAdjudication,
  runFinalCompletionSummaryAdjudication,
} from '../src/neal/adjudicator/final-completion.js';
import { assertAdjudicationTransitionSignal, getAdjudicationSpec } from '../src/neal/adjudicator/specs.js';
import { clearConfigCache } from '../src/neal/config.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type {
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import { createInitialState } from '../src/neal/state.js';
import { getFinalCompletionReviewerScratchDir } from '../src/neal/storage-paths.js';
import type { FinalCompletionPacket, OrchestrationState } from '../src/neal/types.js';
import { hermeticAgentConfig } from './helpers/hermetic-agent-config.js';

const execFileAsync = promisify(execFile);

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

function createPacket(): FinalCompletionPacket {
  return {
    planDoc: '/tmp/PLAN.md',
    executionShape: 'multi_scope',
    currentScopeLabel: '5',
    finalCommit: 'final-commit',
    aggregateReviewContext: {
      baseCommit: 'base-commit',
      headCommit: 'final-commit',
      range: 'base-commit..final-commit',
      commitSubjects: ['final-commit finish scope 5'],
      diffStat: ' src/neal/orchestrator.ts | 10 +++++-----',
      changedFiles: ['src/neal/orchestrator.ts'],
      unavailableReason: null,
    },
    completedScopeSummary: '- Scope 5: accepted',
    acceptedScopeCount: 5,
    blockedScopeCount: 0,
    scopeAccounting: {
      acceptedScopeRecords: 5,
      acceptedTopLevelScopeRecords: 5,
      acceptedDerivedSubScopeRecords: 0,
      blockedScopeRecords: 0,
      blockedTopLevelScopeRecords: 0,
      blockedDerivedSubScopeRecords: 0,
      replacedParentScopes: [],
      summary: 'Accepted scope records: 5 total (5 top-level parent/objective record(s), 0 derived sub-scope record(s)).',
    },
    scopeAccountingSummary: 'Accepted scope records: 5 total (5 top-level parent/objective record(s), 0 derived sub-scope record(s)).',
    verificationOnlyCompletion: false,
    terminalChangedFiles: ['src/neal/orchestrator.ts'],
    terminalChangedFilesSummary: '- src/neal/orchestrator.ts',
    planChangedFiles: ['src/neal/orchestrator.ts', 'src/neal/adjudicator/final-completion.ts'],
    planChangedFilesSummary: '- src/neal/orchestrator.ts\n- src/neal/adjudicator/final-completion.ts',
    residualReviewDebt: [],
    residualReviewDebtSummary: 'No unresolved non-blocking review debt was recorded for accepted scopes.',
    verificationCommands: ['pnpm exec tsx --test test/orchestrator.test.ts', 'pnpm typecheck'],
    verificationCommandResults: [
      {
        command: 'pnpm exec tsx --test test/orchestrator.test.ts',
        provider: 'openai-codex',
        status: 'completed',
        exitCode: 0,
        cwd: '/tmp/repo',
        gitHead: 'final-commit',
        completedAt: '2026-04-29T00:00:00.000Z',
        itemId: 'cmd-1',
        outputLength: 100,
      },
      {
        command: 'pnpm typecheck',
        provider: 'openai-codex',
        status: 'completed',
        exitCode: 0,
        cwd: '/tmp/repo',
        gitHead: 'final-commit',
        completedAt: '2026-04-29T00:01:00.000Z',
        itemId: 'cmd-2',
        outputLength: 200,
      },
    ],
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
  let scratchDir = '';
  let aggregateDiffCollected = false;
  const reviewerResult = await runFinalCompletionReviewerAdjudication({
    state,
    packet,
    // The default reviewer (anthropic-claude) is native read-only with no
    // commit-range diff tool, so Neal inlines the aggregate diff; inject the
    // diff fetcher to keep the fixture hermetic (the packet's aggregate commits
    // are synthetic and absent from the fixture repo).
    getDiffForRange: async (_cwd, base, head) => {
      aggregateDiffCollected = true;
      assert.equal(base, 'base-commit');
      assert.equal(head, 'final-commit');
      return 'aggregate diff text for native read-only reviewer';
    },
    runReviewerRound: async (args) => {
      reviewerArgs = args;
      scratchDir = args.scratchDir;
      assert.equal(
        Object.hasOwn(args, 'inlineContext'),
        false,
        'the removed inlineContext channel must not reach the reviewer round',
      );
      assert.equal(
        args.inlinedRangeDiff,
        'aggregate diff text for native read-only reviewer',
        'a native read-only reviewer must receive the aggregate diff on the inlinedRangeDiff channel',
      );
      assert.equal(args.reviewerContext?.purpose, 'reviewer_continuity');
      assert.equal(args.reviewerContext?.promptMarkdown.includes('Final Completion'), true);
      assert.equal(scratchDir, getFinalCompletionReviewerScratchDir(state.runDir));
      await access(scratchDir);
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
          squashCommitMessage: null,
        },
      };
    },
  });

  assert.equal(summaryResult.summary.summary.planGoalSatisfied, true);
  assert.equal(reviewerResult.context.spec.id, 'final_completion_review');
  assert.equal(reviewerArgs?.planDoc, state.planDoc);
  assert.deepEqual(reviewerArgs?.packet, packet);
  assert.deepEqual(reviewerArgs?.summary, state.finalCompletionSummary);
  assert.equal(aggregateDiffCollected, true);
  await access(scratchDir);
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

// --- Production-path final-completion adapter-prompt coverage ---
// These tests drive the real adjudicator (runFinalCompletionReviewerAdjudication)
// and the real round function (runReviewerFinalCompletionRound ->
// buildFinalCompletionReviewerPrompt) with a capturing structured-advisor
// adapter, then assert on the FINAL adapter prompt. This is what catches a
// wiring regression (dropped inlinedRangeDiff, wrong doctrine, re-added
// removed inline context) between the adjudicator and the round.

const FINAL_COMPLETION_DIFF_SENTINEL = 'const finalCompletionSentinel = "captured-by-final-completion-test";';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
});

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function installCapturingFinalCompletionAdvisor(provider: string) {
  const captured: StructuredAdvisorRoundArgs[] = [];
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      captured.push(args as StructuredAdvisorRoundArgs);
      return {
        sessionHandle: null,
        structured: {
          action: 'block_for_operator',
          summary: 'Captured final completion round.',
          rationale: 'Capture-test verdict.',
          missingWork: null,
          squashCommitMessage: null,
        } as TStructured,
      };
    },
  };
  setProviderCapabilitiesOverrideForTesting(provider, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return captured;
}

async function createFinalCompletionCaptureFixture(reviewerProvider: string) {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-capture-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /usr/bin/true\n', 'utf8');
  clearConfigCache(cwd);

  await runGit(cwd, ['init']);
  await runGit(cwd, ['config', 'user.email', 'neal-test@example.invalid']);
  await runGit(cwd, ['config', 'user.name', 'Neal Test']);
  await runGit(cwd, ['config', 'commit.gpgsign', 'false']);

  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(join(cwd, 'feature.ts'), 'export const base = 1;\n', 'utf8');
  await runGit(cwd, ['add', '-A']);
  await runGit(cwd, ['commit', '--no-verify', '-m', 'base commit']);
  const baseCommit = await runGit(cwd, ['rev-parse', 'HEAD']);

  await writeFile(join(cwd, 'feature.ts'), `export const base = 1;\nexport ${FINAL_COMPLETION_DIFF_SENTINEL}\n`, 'utf8');
  await runGit(cwd, ['add', '-A']);
  await runGit(cwd, ['commit', '--no-verify', '-m', 'scope commit']);
  const headCommit = await runGit(cwd, ['rev-parse', 'HEAD']);

  const state: OrchestrationState = {
    ...(await createInitialState(
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
          reviewer: { provider: reviewerProvider, model: null },
        },
        progressJsonPath: join(runDir, 'plan-progress.json'),
        progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
        reviewMarkdownPath: join(runDir, 'REVIEW.md'),
        recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
        maxRounds: 3,
      },
      baseCommit,
    )),
    baseCommit,
    phase: 'final_completion_review',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Added the final completion sentinel.',
      verificationSummary: 'Ran the targeted suite.',
      remainingKnownGaps: [],
    },
  };

  return { state, baseCommit, headCommit };
}

function createCapturePacket(args: {
  baseCommit: string | null;
  headCommit: string | null;
  unavailableReason: string | null;
}): FinalCompletionPacket {
  const range = args.baseCommit && args.headCommit ? `${args.baseCommit}..${args.headCommit}` : null;
  return {
    ...createPacket(),
    finalCommit: args.headCommit,
    aggregateReviewContext: {
      baseCommit: args.baseCommit,
      headCommit: args.headCommit,
      range,
      commitSubjects: ['scope commit'],
      diffStat: ' feature.ts | 1 +',
      changedFiles: ['feature.ts'],
      unavailableReason: args.unavailableReason,
    },
  };
}

test('final-completion prompt reaching a native read-only structured advisor inlines the aggregate diff and names only its read tools', async () => {
  const { state, baseCommit, headCommit } = await createFinalCompletionCaptureFixture('anthropic-claude');
  const captured = installCapturingFinalCompletionAdvisor('anthropic-claude');
  const packet = createCapturePacket({ baseCommit, headCommit, unavailableReason: null });

  // No runReviewerRound injection: this drives the real rounds.ts ->
  // buildFinalCompletionReviewerPrompt -> getStructuredAdvisorAdapter path,
  // with the default git getDiffForRange collecting the aggregate diff.
  const result = await runFinalCompletionReviewerAdjudication({ state, packet });

  assert.equal(captured.length, 1);
  const round = captured[0]!;
  assert.equal(round.label, 'final-completion');
  const prompt = round.prompt;

  // The aggregate commit-range diff is inlined as the source of truth.
  assert.match(prompt, /## Inlined commit-range diff from Neal \(/);
  assert.ok(prompt.includes(FINAL_COMPLETION_DIFF_SENTINEL), 'native read-only final-completion prompt should inline the aggregate diff');
  assert.match(
    prompt,
    /The commit-range diff for that aggregate range .* is inlined below and is the source of truth/,
  );
  assert.match(prompt, /Inspect the change using the inlined commit-range diff below for what changed/);

  // No commit-range diff tool naming and no shell/git-command/scratch instructions.
  assert.doesNotMatch(prompt, /git_diff/);
  assert.doesNotMatch(prompt, /Use git commands/);
  assert.doesNotMatch(prompt, /git diff |git show |git log /);
  assert.doesNotMatch(prompt, /Temporary verification scratch directory:/);
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);

  assert.equal(result.reviewerResult.sessionHandle, null);
  assert.equal(result.reviewerResult.verdict.action, 'block_for_operator');
});

test('final-completion prompt for a native read-only structured advisor omits the inlined diff when the aggregate range is unavailable', async () => {
  const { state } = await createFinalCompletionCaptureFixture('anthropic-claude');
  const captured = installCapturingFinalCompletionAdvisor('anthropic-claude');
  const packet = createCapturePacket({
    baseCommit: null,
    headCommit: null,
    unavailableReason: 'aggregate base commit was not recorded for this run',
  });

  await runFinalCompletionReviewerAdjudication({ state, packet });

  assert.equal(captured.length, 1);
  const prompt = captured[0]!.prompt;

  assert.doesNotMatch(prompt, /## Inlined commit-range diff from Neal/);
  assert.equal(prompt.includes(FINAL_COMPLETION_DIFF_SENTINEL), false, 'no aggregate diff should be inlined when the range is unavailable');
  // The reviewer still reads the repository itself and treats the missing range
  // as an evidence gap rather than proof of correctness.
  assert.match(prompt, /treat the missing aggregate range as a completion-review evidence gap/);
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
});
