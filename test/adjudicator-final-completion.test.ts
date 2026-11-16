import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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
    verificationTally: {
      totalRuns: 2,
      distinctCommands: 2,
      passed: 2,
      failed: 0,
      unknown: 0,
      recentFailures: [],
    },
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
    // Synthetic commits keep this context-wiring test independent of Git.
    writeRangeDiffArtifact: async ({ cwd, base, head, dir }) => {
      aggregateDiffCollected = true;
      assert.equal(cwd, state.cwd);
      assert.equal(base, 'base-commit');
      assert.equal(head, 'final-commit');
      assert.equal(dir, join(getFinalCompletionReviewerScratchDir(state.runDir), 'range-diff'));
      return { base, head, indexPath: join(dir, 'index.md'), totalBytes: 0, entries: [] };
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
        args.rangeDiffIndexPath,
        relative(state.cwd, join(scratchDir, 'range-diff', 'index.md')),
        'every reviewer receives the repository-relative aggregate index',
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
// wiring regression (dropped rangeDiffIndexPath, wrong doctrine, re-added
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

for (const provider of ['anthropic-claude', 'openai-codex', 'openai-compatible']) {
  test(`final-completion prompt for ${provider} points at the complete aggregate artifact`, async () => {
    const { state, baseCommit, headCommit } = await createFinalCompletionCaptureFixture(provider);
    const captured = installCapturingFinalCompletionAdvisor(provider);
    const packet = createCapturePacket({ baseCommit, headCommit, unavailableReason: null });

    // Exercise adjudication, real round construction and the provider boundary.
    const result = await runFinalCompletionReviewerAdjudication({ state, packet });
    assert.equal(captured.length, 1);
    const round = captured[0]!;
    assert.equal(round.label, 'final-completion');
    const dir = join(getFinalCompletionReviewerScratchDir(state.runDir), 'range-diff');
    assert.ok(round.prompt.includes(relative(state.cwd, join(dir, 'index.md'))));
    const index = await readFile(join(dir, 'index.md'), 'utf8');
    assert.ok(index.includes(`${baseCommit}..${headCommit}`));
    assert.match(index, /feature\.ts/);
    assert.ok((await readFile(join(dir, '0001.patch'), 'utf8')).includes(FINAL_COMPLETION_DIFF_SENTINEL));
    assert.equal(round.prompt.includes(FINAL_COMPLETION_DIFF_SENTINEL), false);
    assert.match(round.prompt, /patch files are the source of truth/);
    assert.doesNotMatch(round.prompt, /git_diff|git diff |git show |git log |Inlined commit-range diff/);
    assert.doesNotMatch(round.prompt, /Temporary verification scratch directory:/);
    assert.doesNotMatch(round.prompt, /## Inlined review context from Neal/);
    assert.equal(result.reviewerResult.sessionHandle, null);
    assert.equal(result.reviewerResult.verdict.action, 'block_for_operator');
  });
}

test('final-completion review writes no artifact when the aggregate range is unavailable', async () => {
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

  await assert.rejects(access(join(getFinalCompletionReviewerScratchDir(state.runDir), 'range-diff')));
  assert.doesNotMatch(prompt, /Commit-range diff index|git_diff|git diff |Inlined commit-range diff/);
  assert.equal(prompt.includes(FINAL_COMPLETION_DIFF_SENTINEL), false, 'no aggregate diff should be delivered when the range is unavailable');
  // The reviewer still reads the repository itself and treats the missing range
  // as an evidence gap rather than proof of correctness.
  assert.match(prompt, /treat the missing aggregate range as a completion-review evidence gap/);
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
});

test('final-completion round resolves neal.review_level from the repository config and passes it to the built prompt', async () => {
  const { state, baseCommit, headCommit } = await createFinalCompletionCaptureFixture('anthropic-claude');
  await writeFile(join(state.cwd, 'neal.yml'), 'neal:\n  notify_bin: /usr/bin/true\n  review_level: lenient\n', 'utf8');
  clearConfigCache(state.cwd);
  const captured = installCapturingFinalCompletionAdvisor('anthropic-claude');
  const packet = createCapturePacket({ baseCommit, headCommit, unavailableReason: null });

  await runFinalCompletionReviewerAdjudication({ state, packet });

  assert.equal(captured.length, 1);
  const prompt = captured[0]!.prompt;
  assert.match(prompt, /Review level: lenient\./);
  assert.doesNotMatch(prompt, /Review level: moderate\./);
  assert.match(prompt, /A finding category that the review level or the User Guidance section has demoted or ignored is not missing work/);
});

test('issue 116: final review delivers more than 200,000 characters and every changed entry, then rewrites after continuation', async () => {
  const { state, baseCommit } = await createFinalCompletionCaptureFixture('openai-compatible');
  const captured = installCapturingFinalCompletionAdvisor('openai-compatible');
  const addedPaths = Array.from({ length: 24 }, (_, i) => `entry-${String(i).padStart(2, '0')}.txt`);
  addedPaths.push('large.txt');
  for (const path of addedPaths) {
    const text = path === 'large.txt' ? 'large patch line\n'.repeat(30_000) : `content for ${path}\n`;
    await writeFile(join(state.cwd, path), text);
  }
  await runGit(state.cwd, ['add', '--', ...addedPaths]);
  await runGit(state.cwd, ['commit', '--no-verify', '-m', 'large aggregate range']);
  const largeHead = await runGit(state.cwd, ['rev-parse', 'HEAD']);
  const packet = createCapturePacket({ baseCommit, headCommit: largeHead, unavailableReason: null });
  packet.aggregateReviewContext.changedFiles = ['feature.ts', ...addedPaths];
  await runFinalCompletionReviewerAdjudication({ state, packet });

  const dir = join(getFinalCompletionReviewerScratchDir(state.runDir), 'range-diff');
  const index = await readFile(join(dir, 'index.md'), 'utf8');
  const patchNames = [...index.matchAll(/\b\d{4}\.patch\b/g)].map((match) => match[0]);
  assert.equal(patchNames.length, 26, 'the authoritative index must include entries beyond the 20-file preview');
  for (const path of packet.aggregateReviewContext.changedFiles) assert.ok(index.includes(path), path);
  const patches = await Promise.all(patchNames.map((name) => readFile(join(dir, name))));
  const delivered = Buffer.concat(patches);
  assert.ok(delivered.length > 400_000, 'exercise both the former inline cap and a large single patch');
  const { stdout: expected } = await execFileAsync('git', [
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--find-renames', `${baseCommit}..${largeHead}`,
  ], { cwd: state.cwd, encoding: 'buffer' });
  assert.deepEqual(delivered, expected, 'all aggregate diff bytes must reach the artifact');
  const prompt = captured[0]!.prompt;
  assert.match(prompt, /\(\+6 more\)/);
  assert.match(prompt, /inline diff stat and changed-file list are previews only/);
  assert.doesNotMatch(prompt, /\[truncated|Inlined commit-range diff|git_diff|git diff |large patch line/);

  // Execution continues, with the aggregate range still rooted at the initial base.
  await runGit(state.cwd, ['rm', '--', ...addedPaths]);
  await writeFile(join(state.cwd, 'feature.ts'), 'export const base = 1;\nexport const continuation = true;\n');
  await runGit(state.cwd, ['add', '--', 'feature.ts']);
  await runGit(state.cwd, ['commit', '--no-verify', '-m', 'continued execution']);
  const nextHead = await runGit(state.cwd, ['rev-parse', 'HEAD']);
  await runFinalCompletionReviewerAdjudication({
    state,
    packet: createCapturePacket({ baseCommit, headCommit: nextHead, unavailableReason: null }),
  });
  assert.deepEqual((await readdir(dir)).sort(), ['0001.patch', 'index.md']);
  const nextIndex = await readFile(join(dir, 'index.md'), 'utf8');
  assert.ok(nextIndex.includes(`${baseCommit}..${nextHead}`));
  assert.equal(nextIndex.includes(largeHead), false);
  const nextPatch = await readFile(join(dir, '0001.patch'), 'utf8');
  assert.match(nextPatch, /continuation = true/);
  assert.equal(nextPatch.includes(FINAL_COMPLETION_DIFF_SENTINEL), false);
  assert.equal(captured.length, 2);

  // A later unavailable range must not expose the previous review's evidence.
  await runFinalCompletionReviewerAdjudication({
    state,
    packet: createCapturePacket({ baseCommit, headCommit: nextHead, unavailableReason: 'aggregate range is unreadable' }),
    writeRangeDiffArtifact: async () => { throw new Error('unavailable ranges must not be collected'); },
  });
  await assert.rejects(access(dir));
  assert.doesNotMatch(captured[2]!.prompt, /Commit-range diff index|git_diff|git diff /);
  assert.match(captured[2]!.prompt, /aggregate range is unreadable/);
});

test('an empty aggregate range still supplies an authoritative zero-entry index', async () => {
  const { state, baseCommit } = await createFinalCompletionCaptureFixture('openai-codex');
  const captured = installCapturingFinalCompletionAdvisor('openai-codex');
  await runFinalCompletionReviewerAdjudication({
    state,
    packet: createCapturePacket({ baseCommit, headCommit: baseCommit, unavailableReason: null }),
  });
  const dir = join(getFinalCompletionReviewerScratchDir(state.runDir), 'range-diff');
  assert.deepEqual(await readdir(dir), ['index.md']);
  assert.match(await readFile(join(dir, 'index.md'), 'utf8'), /Entries: 0/);
  assert.match(captured[0]!.prompt, /Commit-range diff index.*range-diff\/index\.md/);
});
