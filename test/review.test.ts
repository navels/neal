import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildCoderResponsePrompt,
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
  buildReviewerSchema,
  buildReviewerPrompt,
  buildScopePrompt,
  ReviewerRoundError,
  runReviewerRound,
} from '../src/neal/agents.js';
import {
  REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
  resolveReviewedDraftLoopStep,
  validateAdjudicatedLoopContract,
} from '../src/neal/adjudicator/contracts.js';
import {
  ADJUDICATION_ADJACENT_FLOWS,
  ADJUDICATION_SPECS,
  getAdjudicationSpec,
  getReviewerCapability,
  validateAdjudicationSpecContracts,
} from '../src/neal/adjudicator/specs.js';
import { collectEarlierScopeChanges, runExecuteReviewerAdjudication } from '../src/neal/adjudicator/execute.js';
import { clearConfigCache } from '../src/neal/config.js';
import { CONFLICTING_OUTPUT_FORMAT_MARKERS } from '../src/neal/agents/structured-json.js';
import { completionJsonOutputFormatLines } from '../src/neal/prompts/specialized.js';
import { clearUserGuidanceCache } from '../src/neal/prompts/guidance.js';
import type { RunLogger } from '../src/neal/logger.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type {
  ProviderId,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import {
  getChangedFilesForRange,
  getCommitRange,
  getDiffForRange,
  getDiffStatForRange,
  getHeadCommit,
} from '../src/neal/git.js';
import { createReadOnlyToolset } from '../src/neal/providers/openai-compatible-tools.js';
import { buildReviewFindingsReadOnlyInspectionSection } from '../src/neal/review-findings/prompts.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { renderRecoveryMarkdown } from '../src/neal/support.js';
import { buildFinalCompletionPacket } from '../src/neal/final-completion.js';
import { getFinalCompletionReviewArtifactPath, renderFinalCompletionReviewMarkdown } from '../src/neal/final-completion-review.js';
import { notifyBlocked, notifyInteractiveBlockedRecovery } from '../src/neal/orchestrator/notifications.js';
import { appendCompletedScope } from '../src/neal/orchestrator/transitions.js';
import { renderPlanProgressMarkdown, writePlanProgressArtifacts } from '../src/neal/progress.js';
import { getPromptSpec, PROMPT_SPECS } from '../src/neal/prompts/specs.js';
import {
  getCodeReviewFalsificationLines,
  getPreexistingFailureContractLines,
  getRegressionPreservationLines,
  getVerificationSkepticismLines,
} from '../src/neal/prompts/review-doctrine.js';
import { writeCheckpointRetrospective } from '../src/neal/retrospective.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import { getScopeReviewerScratchDir } from '../src/neal/storage-paths.js';
import type { AdjudicationSpec, AdjudicationTransitionSignal } from '../src/neal/adjudicator/specs.js';
import type { OrchestrationState } from '../src/neal/types.js';

// This file exercises notify behavior through its own fixture scripts; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// them. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;


process.env.HOME = join(tmpdir(), 'neal-test-home-review');

// Neutralize configured user guidance for deterministic prompt renders. The
// completion builders call getUserGuidanceLines, which resolves via
// os.homedir() (not process.env.HOME), so a developer's real
// ~/.neal/guidance/*.md could otherwise leak into rendered prompts and, e.g.,
// trip the marker-absent completion assertions. Point NEAL_GUIDANCE_DIR at a
// nonexistent directory and clear the cache, exactly as
// test/prompt-spec-fixtures.test.ts does at module top.
process.env.NEAL_GUIDANCE_DIR = join(tmpdir(), 'neal-review-guidance-does-not-exist');
clearUserGuidanceCache();

const execFileAsync = promisify(execFile);

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-review-artifacts-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /usr/bin/true\n', 'utf8');
  clearConfigCache(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      // Pin the fixture cwd: with the process-cwd default this reads the
      // live repository neal.yml, so a temporary repo-level reviewer
      // override in the developer's checkout would leak into the fixture and
      // flip reviewerNeedsInlineContext mid-suite.
      agentConfig: getDefaultAgentConfig(cwd),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return { root, state: { ...state, ...overrides } };
}

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

test('support and progress artifacts preserve completed interactive blocked recovery history', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'coder_response',
    interactiveBlockedRecoveryHistory: [
      {
        enteredAt: '2026-04-16T00:00:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Review findings stopped converging.',
        maxTurns: 3,
        lastHandledTurn: 1,
        resolvedAt: '2026-04-16T00:03:00.000Z',
        resolvedByAction: 'resume_current_scope',
        resultPhase: 'coder_response',
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-16T00:01:00.000Z',
            operatorGuidance: 'Apply the reviewer feedback and continue this scope.',
            disposition: {
              recordedAt: '2026-04-16T00:02:00.000Z',
              sessionHandle: 'coder-session-4b',
              action: 'resume_current_scope',
              summary: 'The scope can continue.',
              rationale: 'The operator clarified how to proceed.',
              blocker: '',
              replacementPlan: '',
              resultingPhase: 'coder_response',
            },
          },
        ],
      },
    ],
  });

  const recoveryMarkdown = renderRecoveryMarkdown(state);
  assert.match(recoveryMarkdown, /## Recovery History 1/);
  assert.match(recoveryMarkdown, /Resolution: resume_current_scope/);
  assert.match(recoveryMarkdown, /Recovery turn 1 coder action: resume_current_scope/);
  assert.match(recoveryMarkdown, /Recovery turn 1 resulting step: addressing review findings/);

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(progressMarkdown, /Sessions: 1/);
  assert.match(progressMarkdown, /Latest action: resume_current_scope/);
  assert.match(progressMarkdown, /Latest result step: addressing review findings/);
  assert.match(progressMarkdown, /Latest blocked reason: Review findings stopped converging\./);
  assert.match(progressMarkdown, /Latest operator guidance: Apply the reviewer feedback and continue this scope\./);
  assert.match(progressMarkdown, /Latest coder summary: The scope can continue\./);
});

test('interactive blocked recovery notification is distinct from a terminal blocked notification', async () => {
  const { root, state } = await createState({
    currentScopeNumber: 3,
  });
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);
  await writeFile(join(state.cwd, 'neal.yml'), `neal:\n  notify_bin: ${notifyScriptPath}\n`, 'utf8');
  clearConfigCache(state.cwd);

  await notifyInteractiveBlockedRecovery(state, 'Need operator guidance');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /interactive blocked recovery for scope 3: Need operator guidance/);
  assert.doesNotMatch(notifyLog, /: blocked:/);
  // No consultant advice on the recovery record -> the suffix must be absent.
  assert.doesNotMatch(notifyLog, /consultant advice/);
});

async function installNotifyCapture(state: OrchestrationState, root: string) {
  const notifyLogPath = join(root, `notify-${Math.random().toString(36).slice(2)}.log`);
  const notifyScriptPath = join(root, `notify-${Math.random().toString(36).slice(2)}.sh`);
  await writeFile(notifyScriptPath, `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`, 'utf8');
  await chmod(notifyScriptPath, 0o755);
  await writeFile(join(state.cwd, 'neal.yml'), `neal:\n  notify_bin: ${notifyScriptPath}\n`, 'utf8');
  clearConfigCache(state.cwd);
  return notifyLogPath;
}

function recoveryStateWithAdvice(): OrchestrationState['interactiveBlockedRecovery'] {
  return {
    enteredAt: '2026-06-26T00:00:00.000Z',
    sourcePhase: 'reviewer_scope',
    blockedReason: 'Review findings stopped converging.',
    maxTurns: 3,
    lastHandledTurn: 0,
    turns: [],
    pendingDirective: null,
    consultantAdvice: {
      recordedAt: '2026-06-26T00:00:01.000Z',
      recoverable: true,
      triageCategory: 'misunderstanding',
      resolutionDirective: 'Re-read the acceptance criteria and re-run the failing test.',
      rationale: 'The blocker reflects a misread requirement, not an impossible task.',
    },
  };
}

test('attended interactive blocked recovery notification surfaces consultant advice when present', async () => {
  const { root, state } = await createState({
    currentScopeNumber: 3,
    interactiveBlockedRecovery: recoveryStateWithAdvice(),
  });
  const notifyLogPath = await installNotifyCapture(state, root);

  await notifyInteractiveBlockedRecovery(state, 'Need operator guidance');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /interactive blocked recovery for scope 3: Need operator guidance/);
  assert.match(notifyLog, /consultant advice \(read-only\): triage misunderstanding/);
  assert.match(notifyLog, /suggested directive: Re-read the acceptance criteria and re-run the failing test\./);
});

test('attended blocked notification surfaces consultant advice when the recovery record carries it', async () => {
  const { root, state } = await createState({
    currentScopeNumber: 3,
    interactiveBlockedRecovery: recoveryStateWithAdvice(),
  });
  const notifyLogPath = await installNotifyCapture(state, root);

  await notifyBlocked(state, 'Reviewer reported review_stuck');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /Reviewer reported review_stuck/);
  assert.match(notifyLog, /consultant advice \(read-only\): triage misunderstanding/);
  assert.match(notifyLog, /suggested directive: Re-read the acceptance criteria and re-run the failing test\./);
});

test('blocked notification omits consultant advice for a terminal block with no active recovery record', async () => {
  const { root, state } = await createState({
    currentScopeNumber: 3,
    interactiveBlockedRecovery: null,
  });
  const notifyLogPath = await installNotifyCapture(state, root);

  await notifyBlocked(state, 'Coder reported a terminal blocker');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /Coder reported a terminal blocker/);
  assert.doesNotMatch(notifyLog, /consultant advice/);
});

test('execute reviewer prompt includes coder justification and recent parent-objective history', () => {
  const prompt = buildReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base123',
    headCommit: 'head456',
    commits: ['head456 add gate logic'],
    previousHeadCommit: null,
    diffStat: ' src/neal/orchestrator.ts | 10 +++++-----',
    changedFiles: ['src/neal/orchestrator.ts'],
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '5',
    progressJustification: {
      milestoneTargeted: 'Scope 3 reviewer verdict contract',
      newEvidence: 'The execute reviewer schema now includes a meaningful-progress action.',
      whyNotRedundant: 'The old review pass could only judge local correctness.',
      nextStepUnlocked: 'Neal can block acceptance when convergence fails.',
    },
    recentHistorySummary: 'Accepted scope history for parent objective 5...\nTouched-file concentration: src/shared.ts (3/3 scopes)',
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/reviewer-scope-5-round-2',
  });

  // Injected coder justification (progressJustification fields) is echoed back.
  assert.match(prompt, /Scope 3 reviewer verdict contract/);
  // Injected recent parent-objective history is echoed back.
  assert.match(prompt, /Touched-file concentration: src\/shared\.ts \(3\/3 scopes\)/);
  // Injected commit range / scratch directory / parent objective render structurally.
  assert.match(prompt, /git diff base123\.\.head456/);
  assert.match(prompt, /Temporary verification scratch directory: \/tmp\/repo\/\.neal\/runs\/run-123\/scratch\/reviewer-scope-5-round-2/);
  assert.match(prompt, /active parent objective.*scope 5/i);
  // Meaningful-progress contract surfaces its field names and verdict enum values.
  assert.match(prompt, /meaningfulProgressAction/);
  assert.match(prompt, /meaningfulProgressRationale/);
  assert.match(prompt, /`accept`/);
  assert.match(prompt, /`advance_parent`/);
  assert.match(prompt, /`block_for_operator`/);
});

const UNATTENDED_AUTONOMY_LINE =
  'No operator is available to answer. Resolve this autonomously: do not escalate for operator guidance; make your best judgment and keep all verification requirements intact.';

// Shared core of the issue #10 evidence-audit clause. Identical to the literal
// pinned in test/prompt-spec-fixtures.test.ts; the completion summary surface
// voice-matches the tail but carries this exact substring exactly once.
const EVIDENCE_AUDIT_CLAUSE =
  'Before claiming a step is done or a verification passed, confirm the claim against an actual tool or command result from this session';

// The completion-summary surface voice-matches the tail so the summary does not
// claim verification that did not actually run. Deriving the full clause from
// the shared core keeps both pinned together: this literal protects the exact
// voice-matched wording, not just the shared evidence-audit core.
const EVIDENCE_AUDIT_SUMMARY_CLAUSE = `${EVIDENCE_AUDIT_CLAUSE}, and do not claim verification that did not actually run.`;

test('unattended flag renders the no-operator autonomy line into execute prompts only when true', () => {
  const reviewerBaseArgs = {
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base123',
    headCommit: 'head456',
    commits: ['head456 add gate logic'],
    previousHeadCommit: null,
    diffStat: ' src/neal/orchestrator.ts | 10 +++++-----',
    changedFiles: ['src/neal/orchestrator.ts'],
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '5',
    progressJustification: {
      milestoneTargeted: 'm',
      newEvidence: 'e',
      whyNotRedundant: 'w',
      nextStepUnlocked: 'n',
    },
    recentHistorySummary: 'No accepted scopes yet.',
    scratchDir: '/tmp/scratch',
  };

  const attendedReviewer = buildReviewerPrompt(reviewerBaseArgs);
  const unattendedReviewer = buildReviewerPrompt({ ...reviewerBaseArgs, unattended: true });
  assert.doesNotMatch(attendedReviewer, /No operator is available to answer\./);
  assert.ok(unattendedReviewer.includes(UNATTENDED_AUTONOMY_LINE));
  // Attended render is byte-identical to the explicit `unattended: false` render.
  assert.equal(buildReviewerPrompt({ ...reviewerBaseArgs, unattended: false }), attendedReviewer);

  const attendedScope = buildScopePrompt('/tmp/PLAN.md', 'progress text');
  const unattendedScope = buildScopePrompt('/tmp/PLAN.md', 'progress text', { unattended: true });
  assert.doesNotMatch(attendedScope, /No operator is available to answer\./);
  assert.ok(unattendedScope.includes(UNATTENDED_AUTONOMY_LINE));
  assert.equal(buildScopePrompt('/tmp/PLAN.md', 'progress text', { unattended: false }), attendedScope);
});

test('execute reviewer prompt default variant instructs repository inspection without inline context', () => {
  const baseArgs = {
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base123',
    headCommit: 'head456',
    commits: ['head456 add gate logic'],
    previousHeadCommit: null,
    diffStat: ' src/neal/orchestrator.ts | 10 +++++-----',
    changedFiles: ['src/neal/orchestrator.ts'],
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '5',
    progressJustification: {
      milestoneTargeted: 'Scope 5 doctrine defaults',
      newEvidence: 'Tool-access reviewers inspect the repository directly.',
      whyNotRedundant: 'No prior scope asserted the default doctrine.',
      nextStepUnlocked: 'Reviewers inspect the range with their own tools.',
    },
    recentHistorySummary: 'No accepted scopes have been recorded yet for parent objective 5.',
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/reviewer-scope-5-round-2',
  };

  const readCapablePrompt = buildReviewerPrompt(baseArgs);
  assert.match(readCapablePrompt, /Use git commands against the repository, for example: git diff base123\.\.head456/);
  assert.match(readCapablePrompt, /Prior review history is available at \/tmp\/REVIEW\.md/);
  assert.doesNotMatch(readCapablePrompt, /Inlined review context from Neal/);
});

test('execute reviewer prompt read-only variant instructs read-tool inspection without execution or scratch work', () => {
  const baseArgs = {
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base123',
    headCommit: 'head456',
    commits: ['head456 add gate logic'],
    previousHeadCommit: null,
    diffStat: ' src/neal/orchestrator.ts | 10 +++++-----',
    changedFiles: ['src/neal/orchestrator.ts'],
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '5',
    progressJustification: {
      milestoneTargeted: 'Scope 3 read-only doctrine mode',
      newEvidence: 'Read-capable chat reviewers get inspection-only doctrine.',
      whyNotRedundant: 'No prior scope rendered the read-only variant.',
      nextStepUnlocked: 'Generic reviewers can inspect the repository through read tools.',
    },
    recentHistorySummary: 'No accepted scopes have been recorded yet for parent objective 5.',
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/reviewer-scope-5-round-2',
  };
  const prompt = buildReviewerPrompt({ ...baseArgs, accessMode: 'read-only' });

  // Read-only variant names the read-only git_diff tool for commit-range visibility.
  assert.match(prompt, /git_diff/);
  // Path-pointer lines are allowed: the reviewer can read the file (injected REVIEW path).
  assert.match(prompt, /Prior review history is available at \/tmp\/REVIEW\.md/);
  // No execution, scratch-directory, or git-command instructions in read-only mode.
  assert.doesNotMatch(prompt, /Use git commands against the repository/);
  assert.doesNotMatch(prompt, /git diff base123/);
  assert.doesNotMatch(prompt, /Temporary verification scratch directory:/);
  assert.doesNotMatch(prompt, /scratch directory/i);
  // No inline-context channel in read-only mode.
  assert.doesNotMatch(prompt, /Inlined review context from Neal/);
  assert.doesNotMatch(prompt, /inlined below/);

  // Explicit 'tool-access' renders byte-identically to the default.
  assert.equal(buildReviewerPrompt({ ...baseArgs, accessMode: 'tool-access' }), buildReviewerPrompt(baseArgs));
});

test('execute reviewer prompt inlines an empty commit-range diff for a read-only reviewer instead of naming git_diff', () => {
  const baseArgs = {
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base123',
    headCommit: 'head456',
    commits: [],
    previousHeadCommit: null,
    diffStat: '',
    changedFiles: [],
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '5',
    progressJustification: {
      milestoneTargeted: 'Empty-diff read-only scope review',
      newEvidence: 'The selected range produced an empty diff.',
      whyNotRedundant: 'No prior scope exercised the empty inlined-diff path.',
      nextStepUnlocked: 'Native read-only reviewers still see the (empty) range.',
    },
    recentHistorySummary: 'No accepted scopes have been recorded yet for parent objective 5.',
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/reviewer-scope-5-round-1',
  };
  // An empty-string diff is a present (collected) diff, not "not collected", so
  // it still rides the inlined channel rather than falling back to git_diff.
  const prompt = buildReviewerPrompt({ ...baseArgs, accessMode: 'read-only', inlinedRangeDiff: '' });

  // Section header carries the injected commit range; empty diff marker renders.
  assert.match(prompt, /## Inlined commit-range diff from Neal \(base123\.\.head456\)/);
  assert.match(prompt, /\(empty diff\)/);
  // Present (collected) empty diff rides the inlined channel, not the git_diff fallback.
  assert.doesNotMatch(prompt, /git_diff/);
  assert.doesNotMatch(prompt, /Use git commands against the repository/);
});

test('review doctrine builders render read-only inspection phrasing without execution instructions', () => {
  const falsification = getCodeReviewFalsificationLines({
    rangeLabel: 'commit range',
    gitInspectionExamples: 'Use git commands against the repository, for example: git diff a..b.',
    reviewTarget: 'scope diff',
    includeExecuteFailureClasses: true,
    mode: 'read-only',
  }).join('\n');
  // Read-only mode references the read-only git_diff/read tools, not shell git commands.
  assert.match(falsification, /git_diff/);
  assert.match(falsification, /read tools/);
  assert.doesNotMatch(falsification, /git diff/);
  assert.doesNotMatch(falsification, /Use git commands/);
  assert.doesNotMatch(falsification, /inlined/);

  const skepticism = getVerificationSkepticismLines({ reviewTarget: 'scope diff', mode: 'read-only' }).join('\n');
  assert.doesNotMatch(skepticism, /inlined/);

  const regression = getRegressionPreservationLines({ reviewTarget: 'scope diff', mode: 'read-only' }).join('\n');
  // Read-only regression check reads tests rather than running them.
  assert.match(regression, /read tools/);
  assert.doesNotMatch(regression, /running them when available/);
  assert.doesNotMatch(regression, /inlined/);

  const preexisting = getPreexistingFailureContractLines({ reviewTarget: 'scope diff', mode: 'read-only' }).join('\n');
  assert.match(preexisting, /read tools/);
  assert.doesNotMatch(preexisting, /run the most relevant existing tests/);
  assert.doesNotMatch(preexisting, /inlined/);
});

// The read-only doctrine and the review-findings read-only inspection
// section name concrete tools (git_diff, read_file, ...) while the access
// mode is derived from capability flags, not toolset contents. This contract
// test ties the two together: every snake_case tool name those read-only
// instructions reference must exist in the read-only toolset, so a future
// read-only provider cannot silently inherit instructions for a tool it does
// not register.
test('read-only doctrine instructions only reference tools the read-only toolset provides', () => {
  const doctrineText = [
    ...getCodeReviewFalsificationLines({
      rangeLabel: 'commit range',
      gitInspectionExamples: 'Use git commands against the repository.',
      reviewTarget: 'scope diff',
      includeExecuteFailureClasses: true,
      mode: 'read-only',
    }),
    ...getVerificationSkepticismLines({ reviewTarget: 'scope diff', mode: 'read-only' }),
    ...getRegressionPreservationLines({ reviewTarget: 'scope diff', mode: 'read-only' }),
    ...getPreexistingFailureContractLines({ reviewTarget: 'scope diff', mode: 'read-only' }),
    buildReviewFindingsReadOnlyInspectionSection({
      version: 1,
      instruction: 'Review the selected committed range.',
      instructionSource: 'default',
      selector: { kind: 'last', count: 1 },
      baseRef: 'HEAD~1',
      headRef: 'HEAD',
      externalBaseCommit: 'base123',
      externalHeadCommit: 'head456',
      externalCommits: ['head456'],
      externalCommitSubjects: ['head456 subject'],
      externalChangedFiles: ['a.ts'],
      diffStat: ' a.ts | 1 +',
      diff: 'diff --git a/a.ts b/a.ts\n+1\n',
    }),
  ].join('\n');

  const toolsetNames = Object.keys(createReadOnlyToolset(tmpdir()));
  const mentionedToolNames = [...new Set([...doctrineText.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map((match) => match[1]))];
  assert.ok(mentionedToolNames.includes('git_diff'), 'the read-only doctrine must direct reviewers to git_diff');
  assert.ok(mentionedToolNames.includes('read_file'), 'the review-findings read-only section must reference read_file');
  for (const name of mentionedToolNames) {
    assert.ok(
      toolsetNames.includes(name),
      `read-only doctrine references tool ${JSON.stringify(name)} that the read-only toolset does not provide`,
    );
  }
});

test('execute reviewer schema exposes the advance-parent meaningful-progress action', () => {
  const schema = buildReviewerSchema();

  assert.deepEqual([...schema.properties.meaningfulProgressAction.enum], [
    'accept',
    'block_for_operator',
    'replace_plan',
    'advance_parent',
  ]);
});

// A read-only reviewer that exposes its own commit-range diff tool
// (openai-compatible) inspects the range itself, so Neal collects neither the
// full no-read inline context nor an inlined commit-range diff.
// Reviewer session continuity (issue #23): round N+1 of a scope's review
// engagement resumes the reviewer session recorded by round N.
test('execute reviewer adjudication passes the stored reviewer session handle as the resume handle', async () => {
  const { state } = await createState({
    baseCommit: 'base123',
    reviewerSessionHandle: 'reviewer-round-1-thread',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Second review round for the scope.',
      newEvidence: 'The coder addressed round-1 findings.',
      whyNotRedundant: 'Round-2 verification of the fixes.',
      nextStepUnlocked: 'The reviewer can accept or raise follow-up.',
    },
  });
  let receivedResumeHandle: string | null | undefined = undefined;

  await runExecuteReviewerAdjudication({
    state,
    getHeadCommit: async () => 'head456',
    getCommitRange: async () => ['head456 Address round-1 findings'],
    getDiffStatForRange: async () => '1 file changed, 2 insertions(+)',
    getChangedFilesForRange: async () => ['src/example.ts'],
    getDiffForRange: async () => 'diff text',
    runReviewerRound: async (args) => {
      receivedResumeHandle = args.resumeHandle;
      return {
        sessionHandle: 'reviewer-round-2-thread',
        summary: 'Fixes verified.',
        findings: [],
        meaningfulProgress: {
          action: 'accept',
          rationale: 'The scope materially advances the active objective.',
        },
      };
    },
  });

  assert.equal(receivedResumeHandle, 'reviewer-round-1-thread');
});

test('execute reviewer adjudication does not collect unused full diffs for a reviewer with its own range diff tool', async () => {
  const { state } = await createState({
    baseCommit: 'base123',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Review the formatter reconciliation scope.',
      newEvidence: 'The coder committed the formatter reconciliation.',
      whyNotRedundant: 'This is the first reviewer pass for this scope.',
      nextStepUnlocked: 'The reviewer can accept or identify targeted follow-up.',
    },
  });
  state.agentConfig = { ...state.agentConfig, reviewer: { provider: 'openai-compatible', model: null } };
  let reviewerCalled = false;
  let fullDiffCollected = false;
  let scratchDir = '';

  const result = await runExecuteReviewerAdjudication({
    state,
    getHeadCommit: async () => 'head456',
    getCommitRange: async () => ['head456 Reconcile formatter ownership'],
    getDiffStatForRange: async () => '1729 files changed, 15475 insertions(+), 15071 deletions(-)',
    getChangedFilesForRange: async () => ['package.json', 'packages/web/app/components/example.hbs'],
    getDiffForRange: async () => {
      fullDiffCollected = true;
      return 'full diff text';
    },
    runReviewerRound: async (args) => {
      reviewerCalled = true;
      assert.equal(args.baseCommit, 'base123');
      assert.equal(args.headCommit, 'head456');
      assert.equal(args.diffStat, '1729 files changed, 15475 insertions(+), 15071 deletions(-)');
      assert.deepEqual(args.changedFiles, ['package.json', 'packages/web/app/components/example.hbs']);
      assert.equal(Object.hasOwn(args, 'diff'), false);
      assert.equal(Object.hasOwn(args, 'inlineContext'), false);
      assert.equal(args.inlinedRangeDiff, null);
      assert.equal(args.reviewerContext?.purpose, 'reviewer_continuity');
      assert.equal(args.reviewerContext?.promptMarkdown.includes('Reviewer Continuity Context'), true);
      scratchDir = args.scratchDir;
      assert.equal(scratchDir, getScopeReviewerScratchDir(state.runDir, args.parentScopeLabel, args.round));
      await access(scratchDir);

      return {
        sessionHandle: 'reviewer-session',
        summary: 'Scope is acceptable.',
        findings: [],
        meaningfulProgress: {
          action: 'accept',
          rationale: 'The scope materially advances the formatter reconciliation.',
        },
      };
    },
  });

  assert.equal(reviewerCalled, true);
  assert.equal(fullDiffCollected, false);
  await access(scratchDir);
  assert.equal(result.reviewInput.headCommit, 'head456');
  assert.deepEqual(result.reviewInput.changedFiles, ['package.json', 'packages/web/app/components/example.hbs']);
});

// A native read-only reviewer (read tools, no shell, no commit-range diff tool —
// the default anthropic-claude) cannot see the commit-range diff through tools,
// so Neal collects the commit-range diff and threads it on the dedicated
// inlinedRangeDiff channel (not the no-read inlineContext channel).
test('execute reviewer adjudication inlines the commit-range diff for a native read-only reviewer', async () => {
  const { state } = await createState({
    baseCommit: 'base123',
    currentScopeProgressJustification: {
      milestoneTargeted: 'Review the formatter reconciliation scope.',
      newEvidence: 'The coder committed the formatter reconciliation.',
      whyNotRedundant: 'This is the first reviewer pass for this scope.',
      nextStepUnlocked: 'The reviewer can accept or identify targeted follow-up.',
    },
  });
  // The default reviewer (anthropic-claude) is native read-only.
  assert.equal(state.agentConfig.reviewer.provider, 'anthropic-claude');
  let reviewerCalled = false;
  let fullDiffCollected = false;

  await runExecuteReviewerAdjudication({
    state,
    getHeadCommit: async () => 'head456',
    getCommitRange: async () => ['head456 Reconcile formatter ownership'],
    getDiffStatForRange: async () => '1 file changed, 1 insertion(+)',
    getChangedFilesForRange: async () => ['feature.ts'],
    getDiffForRange: async (_cwd, base, head) => {
      fullDiffCollected = true;
      assert.equal(base, 'base123');
      assert.equal(head, 'head456');
      return 'full diff text for native read-only reviewer';
    },
    runReviewerRound: async (args) => {
      reviewerCalled = true;
      // The diff rides the dedicated inlinedRangeDiff channel; the removed
      // no-read inlineContext channel no longer exists on the round args.
      assert.equal(Object.hasOwn(args, 'inlineContext'), false);
      assert.equal(args.inlinedRangeDiff, 'full diff text for native read-only reviewer');

      return {
        sessionHandle: 'reviewer-session',
        summary: 'Scope is acceptable.',
        findings: [],
        meaningfulProgress: {
          action: 'accept',
          rationale: 'The scope materially advances the formatter reconciliation.',
        },
      };
    },
  });

  assert.equal(reviewerCalled, true);
  assert.equal(fullDiffCollected, true);
});

test('review markdown renders reviewer evidence for persisted findings', async () => {
  const { state } = await createState({
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['src/neal/agents/rounds.ts'],
        claim: 'Reviewer findings do not preserve why the issue is credible.',
        evidence: 'The persisted finding includes claim and required action but no supporting scenario or repository-backed rationale.',
        requiredAction: 'Persist a concrete evidence field for reviewer findings and render it in review artifacts.',
        status: 'open',
        roundSummary: 'Reviewer output is under-specified.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });

  const markdown = renderReviewMarkdown(state);
  assert.match(markdown, /- Evidence: The persisted finding includes claim and required action but no supporting scenario or repository-backed rationale\./);
});

test('execute optional coder response prompt makes non-blocking uptake explicit', () => {
  const prompt = buildCoderResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: '## Current Scope\n- Scope: 2\n',
    verificationHint: 'Run focused verification.',
    mode: 'optional',
    openFindings: [
      {
        id: 'R1-F1',
        severity: 'non_blocking',
        files: ['src/neal/adjudicator/execute.ts'],
        claim: 'Optional findings can be silently skipped.',
        requiredAction: 'Require a disposition for every optional finding.',
        roundSummary: 'Non-blocking uptake needs an explicit response.',
      },
    ],
  });

  // Optional-mode response renders the open finding and the disposition enum
  // values the coder must choose from, so every non-blocking finding gets one.
  assert.match(prompt, /R1-F1/);
  assert.match(prompt, /`fixed`/);
  assert.match(prompt, /`rejected`/);
  assert.match(prompt, /`deferred`/);
});

test('prompt spec inventory covers the curated role-task surface with explicit schema targets', () => {
  assert.equal(PROMPT_SPECS.length, 7);
  assert.deepEqual(
    PROMPT_SPECS.map((spec) => spec.id),
    [
      'plan_author',
      'plan_reviewer',
      'scope_coder',
      'scope_reviewer',
      'completion_coder',
      'completion_reviewer',
      'consultant',
    ],
  );

  // Pin the entire consultant spec so any drift in a governance field,
  // input shape, provider variant, note, or the primary variant fails here.
  const consultantInputShape = {
    shapeName: 'BuildConsultantPromptArgs',
    fields: [
      { key: 'blockedReason', source: 'prompt_argument', required: true, description: 'Blocked reason string.' },
      { key: 'inlineContext', source: 'repository_state', required: true, description: 'Neal-inlined adjudication context.' },
    ],
  };
  const consultantSchemaTarget = {
    kind: 'structured_json',
    schemaBuilder: 'buildConsultantSchema',
    parser: 'validateConsultantVerdictPayload',
    providerSurface: 'neal_json_block_protocol',
  };
  const consultantBaseInstructions = {
    kind: 'builder',
    modulePath: 'src/neal/agents/prompts.ts',
    exportName: 'buildConsultantPrompt',
    inputShape: consultantInputShape,
  };
  assert.deepEqual(getPromptSpec('consultant'), {
    id: 'consultant',
    version: 1,
    changelog: [
      {
        version: 1,
        renderSha: '42e41552be1e8cceb0596a26f09892e13cc31adf07e58479d939d289c8b469e3',
      },
    ],
    role: 'reviewer',
    purpose:
      'Triage a blocked Neal run entirely from Neal-inlined context and decide whether the block is an in-scope recoverable misunderstanding or a genuine wall that must escalate to a human.',
    requiredContext: {
      shapeName: 'ConsultantPromptContext',
      fields: [
        {
          key: 'blockedReason',
          source: 'prompt_argument',
          required: true,
          description: 'Blocked reason reported by the stalled coder or reviewer turn.',
        },
        {
          key: 'inlineContext',
          source: 'repository_state',
          required: true,
          description:
            'Neal-inlined adjudication context (plan content, open blocking findings, reviewer-round snapshots, or coder blocker plus changed files) the consultant judges entirely from.',
        },
      ],
    },
    schemaTarget: consultantSchemaTarget,
    baseInstructions: consultantBaseInstructions,
    providerVariants: [
      {
        provider: 'shared',
        status: 'default',
        notes: 'Default wording should stay shared across providers until fixture evidence justifies divergence.',
      },
      {
        provider: 'openai-codex',
        status: 'reserved_for_justified_divergence',
        notes: 'Provider-specific overrides belong in prompt specs only when OpenAI Codex behavior demonstrably differs.',
      },
      {
        provider: 'anthropic-claude',
        status: 'reserved_for_justified_divergence',
        notes: 'Provider-specific overrides belong in prompt specs only when Anthropic Claude behavior demonstrably differs.',
      },
    ],
    evaluationNotes: [
      'Render tests should assert the consultant judges entirely from inlined context and its static instructions carry no repository-access phrasing.',
      'A golden render test pins the exact prompt bytes, including the ALL-CAPS emphasis lines.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'mixed',
    ownershipNotes: [
      'Prompt spec owns the consultant instructions and required context only; anti-thrash guarding, recovery routing, and verdict persistence stay in src/neal/adjudicator/ outside the prompt-spec library.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'adjacent',
        description: 'Read-only blocked-run adjudication round.',
        currentRoundEntrypoints: ['runConsultantRound'],
        baseInstructions: consultantBaseInstructions,
        schemaTarget: consultantSchemaTarget,
      },
    ],
  });

  const scopeReviewer = getPromptSpec('scope_reviewer');
  assert.equal(scopeReviewer.schemaTarget.kind, 'structured_json');
  assert.equal(scopeReviewer.schemaTarget.schemaBuilder, 'buildReviewerSchema');
  assert.equal(scopeReviewer.baseInstructions.modulePath, 'src/neal/prompts/execute.ts');
  assert.equal(scopeReviewer.currentHome, 'src/neal/prompts');
  assert.equal(scopeReviewer.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/execute.ts'), true);
  assert.equal(scopeReviewer.variants.some((variant) => variant.kind === 'meaningful_progress'), true);
  assert.match(
    scopeReviewer.variants.find((variant) => variant.kind === 'meaningful_progress')?.description ?? '',
    /advance_parent/,
  );

  const scopeCoder = getPromptSpec('scope_coder');
  assert.equal(scopeCoder.currentHome, 'mixed');
  assert.equal(scopeCoder.baseInstructions.modulePath, 'src/neal/prompts/execute.ts');
  assert.equal(
    scopeCoder.variants
      .filter((variant) => variant.status === 'migration_target')
      .every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/execute.ts'),
    true,
  );

  const planAuthor = getPromptSpec('plan_author');
  assert.equal(planAuthor.firstMigrationPriority, 1);
  assert.equal(planAuthor.currentHome, 'src/neal/prompts');
  assert.equal(planAuthor.baseInstructions.modulePath, 'src/neal/prompts/planning.ts');
  assert.equal(planAuthor.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/planning.ts'), true);

  const planReviewer = getPromptSpec('plan_reviewer');
  assert.equal(planReviewer.baseInstructions.modulePath, 'src/neal/prompts/planning.ts');
  assert.equal(planReviewer.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/planning.ts'), true);

  const completionCoder = getPromptSpec('completion_coder');
  assert.equal(completionCoder.baseInstructions.modulePath, 'src/neal/prompts/specialized.ts');
  assert.equal(completionCoder.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/specialized.ts'), true);

  const completionReviewer = getPromptSpec('completion_reviewer');
  assert.equal(completionReviewer.baseInstructions.modulePath, 'src/neal/prompts/specialized.ts');
  assert.equal(completionReviewer.variants.every((variant) => variant.baseInstructions.modulePath === 'src/neal/prompts/specialized.ts'), true);
});

test('adjudication spec inventory maps in-scope loops and leaves support-style flows adjacent', async () => {
  assert.deepEqual(
    ADJUDICATION_SPECS.map((spec) => spec.id),
    ['plan_review', 'derived_plan_review', 'execute_review', 'final_completion_review'],
  );

  const executeReview = getAdjudicationSpec('execute_review');
  assert.equal(executeReview.family, 'execute_review');
  assert.equal(executeReview.reviewer.prompt.promptSpecId, 'scope_reviewer');
  assert.deepEqual(
    executeReview.reviewer.capabilities?.map((capability) => `${capability.promptSpecId}:${capability.variantKind}`),
    ['scope_reviewer:meaningful_progress'],
  );
  assert.equal(executeReview.coder.primary.output.protocol, 'structured_json');
  if (executeReview.coder.primary.output.protocol === 'structured_json') {
    assert.equal(executeReview.coder.primary.output.schemaBuilder, 'buildCoderScopeSchema');
    assert.equal(executeReview.coder.primary.output.parser, 'validateCoderScopePayload');
  }

  const planReview = getAdjudicationSpec('plan_review');
  assert.equal(planReview.family, 'plan_review');
  assert.equal(planReview.reviewer.output.schemaBuilder, 'buildPlanReviewerSchema');

  const finalCompletion = getAdjudicationSpec('final_completion_review');
  assert.equal(finalCompletion.family, 'final_completion');
  assert.equal(finalCompletion.coder.response, null);
  assert.equal(finalCompletion.transitionSignals.includes('continue_execution'), true);

  assert.deepEqual(
    ADJUDICATION_ADJACENT_FLOWS.map((flow) => flow.id),
    ['interactive_blocked_recovery'],
  );
  assert.equal(
    ADJUDICATION_ADJACENT_FLOWS.find((flow) => flow.id === 'interactive_blocked_recovery')?.status,
    'adjacent_v1',
  );
});

test('adjudication coder outputs use structured coder schemas and provider surfaces', () => {
  const planReview = getAdjudicationSpec('plan_review');
  assert.equal(planReview.coder.primary.output.protocol, 'structured_json');
  assert.equal(planReview.coder.primary.output.schemaBuilder, 'buildCoderPlanSchema');
  assert.equal(planReview.coder.primary.output.parser, 'validateCoderPlanPayload');
  assert.equal(planReview.coder.primary.output.providerSurface, 'coder_structured_schema');

  for (const specId of ['plan_review', 'derived_plan_review', 'execute_review'] as const) {
    const spec = getAdjudicationSpec(specId);
    assert.equal(spec.coder.primary.output.protocol, 'structured_json');
    assert.equal(spec.coder.primary.output.providerSurface, 'coder_structured_schema');

    if (spec.coder.response) {
      assert.equal(spec.coder.response.output.protocol, 'structured_json');
      assert.equal(spec.coder.response.output.providerSurface, 'coder_structured_schema');
    }
  }

  assert.equal(planReview.coder.response?.output.parser, 'validateCoderPlanResponsePayload');
  assert.equal(getAdjudicationSpec('derived_plan_review').coder.primary.output.parser, 'validateCoderPlanResponsePayload');
  assert.equal(getAdjudicationSpec('execute_review').coder.response?.output.parser, 'validateCoderResponsePayload');
});

test('adjudication specs expose shared loop contract metadata', () => {
  const cases = [
    {
      id: 'plan_review',
      loopKind: 'plan',
      sideEffectPolicy: 'plan_doc_only',
      terminalArtifactKind: 'plan_document',
      roundCapSource: 'state.maxRounds',
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
    },
    {
      id: 'derived_plan_review',
      loopKind: 'plan',
      sideEffectPolicy: 'plan_doc_only',
      terminalArtifactKind: 'derived_plan_document',
      roundCapSource: 'derivedPlan.counters.maxDerivedPlanReviewRounds',
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
    },
    {
      id: 'execute_review',
      loopKind: 'execute',
      sideEffectPolicy: 'code_changes',
      terminalArtifactKind: 'implementation_scope',
      roundCapSource: 'state.maxRounds',
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
    },
    {
      id: 'final_completion_review',
      loopKind: 'final_completion',
      sideEffectPolicy: 'code_changes',
      terminalArtifactKind: 'final_completion_review',
      roundCapSource: 'state.finalCompletionContinueExecutionMax',
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
    },
  ] as const;

  for (const expected of cases) {
    const spec = getAdjudicationSpec(expected.id);
    assert.equal(spec.loopContract.loopKind, expected.loopKind);
    assert.equal(spec.loopContract.sideEffectPolicy, expected.sideEffectPolicy);
    assert.equal(spec.loopContract.terminalArtifact.kind, expected.terminalArtifactKind);
    assert.equal(spec.loopContract.roundCap.source, expected.roundCapSource);
    assert.deepEqual(spec.loopContract.terminalOutcomes, expected.terminalOutcomes);
    assert.equal(spec.loopContract.allowedOutcomes.includes('revise'), true);
    assert.equal(spec.loopContract.roundCap.outcomeWhenReached, 'cap_reached');
  }
});

test('contract-only review loop exposes shared metadata', () => {
  const cases = [
    {
      id: 'review',
      contract: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
      loopKind: 'review',
      sideEffectPolicy: 'read_only',
      artifactKind: 'review_findings',
      storage: '.neal/reviews/<review-id>/REVIEW_FINAL.md',
    },
  ] as const;

  for (const expected of cases) {
    validateAdjudicatedLoopContract(expected.id, expected.contract);
    assert.equal(expected.contract.loopKind, expected.loopKind);
    assert.equal(expected.contract.sideEffectPolicy, expected.sideEffectPolicy);
    assert.equal(expected.contract.terminalArtifact.kind, expected.artifactKind);
    assert.equal(expected.contract.terminalArtifact.storage, expected.storage);
    assert.equal(expected.contract.roundCap.outcomeWhenReached, 'cap_reached');
  }
});

test('shared reviewed-draft loop helper normalizes accept, revise, blocked, and cap outcomes', () => {
  assert.deepEqual(
    resolveReviewedDraftLoopStep({
      ownerId: 'review',
      contract: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
      verdict: 'accepted',
      round: 1,
      maxRounds: 3,
    }),
    {
      outcome: 'accepted',
      terminalOutcome: 'accepted',
      shouldRevise: false,
      capReached: false,
    },
  );

  assert.deepEqual(
    resolveReviewedDraftLoopStep({
      ownerId: 'review',
      contract: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
      verdict: 'revise',
      round: 1,
      maxRounds: 3,
    }),
    {
      outcome: 'revise',
      terminalOutcome: null,
      shouldRevise: true,
      capReached: false,
    },
  );

  assert.deepEqual(
    resolveReviewedDraftLoopStep({
      ownerId: 'review',
      contract: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
      verdict: 'revise',
      round: 3,
      maxRounds: 3,
    }),
    {
      outcome: 'cap_reached',
      terminalOutcome: 'cap_reached',
      shouldRevise: false,
      capReached: true,
    },
  );

  assert.deepEqual(
    resolveReviewedDraftLoopStep({
      ownerId: 'review',
      contract: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
      verdict: 'blocked',
      round: 2,
      maxRounds: 3,
    }).terminalOutcome,
    'blocked',
  );
});

test('adjudication spec validation rejects impossible family transition signals', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'plan_review'
      ? {
          ...spec,
          transitionSignals: [...spec.transitionSignals, 'replace_plan'] as readonly AdjudicationTransitionSignal[],
        }
      : spec,
  );

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec plan_review family plan_review declares impossible transition signal replace_plan\./,
  );
});

test('adjudication spec validation rejects missing runtime transition signals for a spec', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'final_completion_review'
      ? {
          ...spec,
          transitionSignals: spec.transitionSignals.filter(
            (signal): signal is AdjudicationTransitionSignal => signal !== 'continue_execution',
          ),
        }
      : spec,
  );

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec final_completion_review family final_completion is missing runtime transition signal continue_execution\./,
  );
});

test('adjudication spec validation rejects missing shared loop side-effect policy', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'plan_review'
      ? {
          ...spec,
          loopContract: {
            ...spec.loopContract,
            sideEffectPolicy: '' as any,
          },
        }
      : spec,
  );

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec plan_review must declare a valid side-effect policy\./,
  );
});

test('adjudication spec validation rejects missing shared loop terminal outcomes', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'execute_review'
      ? {
          ...spec,
          loopContract: {
            ...spec.loopContract,
            terminalOutcomes: [],
          },
        }
      : spec,
  );

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec execute_review must declare at least one terminal loop outcome\./,
  );
});

test('adjudication spec validation rejects unknown provider surfaces', () => {
  const malformedSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'execute_review'
      ? {
          ...spec,
          coder: {
            ...spec.coder,
            response: spec.coder.response
              ? {
                  ...spec.coder.response,
                  output: {
                    ...spec.coder.response.output,
                    providerSurface: 'unknown_provider_surface',
                  },
                }
              : spec.coder.response,
          },
        }
      : spec,
  ) as any;

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSpecs),
    /Adjudication spec execute_review coder\.response\.output references unknown provider surface unknown_provider_surface\./,
  );
});

test('adjudication spec validation rejects unknown schema builders and parser surfaces', () => {
  const malformedSchemaSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'plan_review'
      ? {
          ...spec,
          coder: {
            ...spec.coder,
            primary: {
              ...spec.coder.primary,
              output: {
                ...spec.coder.primary.output,
                schemaBuilder: 'buildUnknownCoderSchema',
              },
            },
          },
        }
      : spec,
  ) as any;

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedSchemaSpecs),
    /Adjudication spec plan_review coder\.primary\.output references unknown schema builder buildUnknownCoderSchema\./,
  );

  const malformedParserSpecs: readonly AdjudicationSpec[] = ADJUDICATION_SPECS.map((spec) =>
    spec.id === 'execute_review'
      ? {
          ...spec,
          coder: {
            ...spec.coder,
            response: spec.coder.response
              ? {
                  ...spec.coder.response,
                  output: {
                    ...spec.coder.response.output,
                    parser: 'parseUnknownCoderPayload',
                  },
                }
              : spec.coder.response,
          },
        }
      : spec,
  ) as any;

  assert.throws(
    () => validateAdjudicationSpecContracts(malformedParserSpecs),
    /Adjudication spec execute_review coder\.response\.output references unknown parser parseUnknownCoderPayload\./,
  );
});

test('ordinary plan-review artifacts render the active adjudication contract without implying dispatch ownership', async () => {
  const { state } = await createState({
    topLevelMode: 'plan',
    currentScopeNumber: 1,
    phase: 'reviewer_plan',
    executionShape: 'one_shot',
    coderSessionHandle: 'coder-plan-1',
    reviewerSessionHandle: 'reviewer-plan-1',
  });

  const reviewMarkdown = renderReviewMarkdown(state);
  assert.match(reviewMarkdown, /## Adjudication Contract/);
  assert.match(reviewMarkdown, /- Adjudication spec id: plan_review/);
  assert.match(reviewMarkdown, /- Adjudication family: plan_review/);
  assert.match(reviewMarkdown, /- Loop kind: plan/);
  assert.match(reviewMarkdown, /- Side-effect policy: plan_doc_only/);
  assert.match(reviewMarkdown, /- Allowed loop outcomes: accepted, revise, blocked, failed, cap_reached/);
  assert.match(reviewMarkdown, /- Terminal artifact: plan_document at state\.planDoc/);
  assert.match(reviewMarkdown, /- Allowed transition outcomes: accept_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(reviewMarkdown, /- Contract role: validated allowed outcomes for debugging; runtime routing remains explicit elsewhere\./);

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Adjudication Contract/);
  assert.match(progressMarkdown, /- Adjudication spec id: plan_review/);
  assert.match(progressMarkdown, /- Adjudication family: plan_review/);
  assert.match(progressMarkdown, /- Loop kind: plan/);
  assert.match(progressMarkdown, /- Side-effect policy: plan_doc_only/);
  assert.match(progressMarkdown, /- Allowed loop outcomes: accepted, revise, blocked, failed, cap_reached/);
  assert.match(progressMarkdown, /- Terminal artifact: plan_document at state\.planDoc/);
  assert.match(progressMarkdown, /- Allowed transition outcomes: accept_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(progressMarkdown, /- Contract role: validated allowed outcomes for debugging; runtime routing remains explicit elsewhere\./);
});

test('progress and review artifacts omit unknown scope totals when the active shape is multi_scope_unknown', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    executionShape: 'multi_scope_unknown',
    phase: 'reviewer_scope',
    status: 'running',
  });

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /- Progress: scope 4\b/);
  assert.doesNotMatch(progressMarkdown, /- Progress: scope 4\/\?/);

  const reviewMarkdown = renderReviewMarkdown(state);
  assert.match(reviewMarkdown, /- Scope progress: scope 4\b/);
  assert.doesNotMatch(reviewMarkdown, /- Scope progress: scope 4\/\?/);
});

test('progress and review artifacts distinguish derived unknown progress from the parent scope label', async () => {
  const { state } = await createState({
    currentScopeNumber: 6,
    executionShape: 'multi_scope_unknown',
    phase: 'coder_scope',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: 2,
  });

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /- Progress: scope 6\.2 \| derived 2\b/);
  assert.doesNotMatch(progressMarkdown, /derived 2\/\?/);

  const reviewMarkdown = renderReviewMarkdown(state);
  assert.match(reviewMarkdown, /- Scope progress: scope 6\.2 \| derived 2\b/);
  assert.doesNotMatch(reviewMarkdown, /derived 2\/\?/);
});

test('execute review requires meaningful-progress as an adjudication-spec reviewer capability', () => {
  const executeReview = getAdjudicationSpec('execute_review');
  const capability = getReviewerCapability(executeReview, 'meaningful_progress');
  assert.equal(capability.promptSpecId, 'scope_reviewer');
  assert.equal(capability.variantKind, 'meaningful_progress');
  assert.equal(capability.exportName, 'buildReviewerPrompt');

  const malformedExecuteReview = {
    ...executeReview,
    reviewer: {
      ...executeReview.reviewer,
      capabilities: [],
    },
  };

  assert.throws(
    () => getReviewerCapability(malformedExecuteReview, 'meaningful_progress'),
    /execute_review reviewer is missing capability meaningful_progress/,
  );
});

test('final completion packet summarizes whole-plan completion context', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    createdCommits: ['scope-3-commit'],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-2',
        finalCommit: 'final-2',
        commitSubject: 'implement scope 2',
        changedFiles: ['src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-2.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await writeFile(
    join(state.runDir, 'events.ndjson'),
    [
      JSON.stringify({
        ts: '2026-04-29T00:00:00.000Z',
        type: 'coder.command_execution',
        data: {
          itemId: 'cmd-1',
          command: 'pnpm typecheck',
          status: 'completed',
          exitCode: 0,
          cwd: state.cwd,
          gitHead: 'final-3',
          outputLength: 120,
          provider: 'openai-codex',
        },
      }),
      JSON.stringify({
        ts: '2026-04-29T00:01:00.000Z',
        type: 'coder.command_execution',
        data: {
          itemId: 'cmd-2',
          command: 'pnpm exec tsx --test test/review.test.ts',
          status: 'completed',
          exitCode: 0,
          cwd: state.cwd,
          gitHead: 'final-3',
          outputLength: 240,
          provider: 'openai-codex',
        },
      }),
      JSON.stringify({ type: 'coder.command_execution', data: { command: 'git status --short' } }),
      '',
    ].join('\n'),
    'utf8',
  );

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/c.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });

  assert.equal(packet.executionShape, 'multi_scope');
  assert.equal(packet.currentScopeLabel, '3');
  assert.equal(packet.acceptedScopeCount, 3);
  assert.equal(packet.verificationOnlyCompletion, false);
  assert.deepEqual(packet.terminalChangedFiles, ['src/c.ts']);
  assert.deepEqual(packet.planChangedFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.match(packet.completedScopeSummary, /Scope 1: accepted/);
  assert.match(packet.completedScopeSummary, /Scope 3: accepted \(AUTONOMY_DONE\)/);
  assert.match(packet.terminalChangedFilesSummary, /src\/c\.ts/);
  assert.match(packet.planChangedFilesSummary, /src\/a\.ts/);
  assert.match(packet.verificationSummary, /pnpm typecheck/);
  assert.match(packet.verificationSummary, /passed \(exit 0, git final-3/);
  assert.deepEqual(
    packet.verificationCommandResults.map((result) => ({
      command: result.command,
      exitCode: result.exitCode,
      gitHead: result.gitHead,
    })),
    [
      { command: 'pnpm typecheck', exitCode: 0, gitHead: 'final-3' },
      { command: 'pnpm exec tsx --test test/review.test.ts', exitCode: 0, gitHead: 'final-3' },
    ],
  );
  assert.match(packet.scopeAccountingSummary, /3 top-level parent\/objective record/);
  assert.deepEqual(packet.lastNonEmptyImplementationScope, {
    number: '3',
    finalCommit: 'final-3',
    commitSubject: 'finish scope 3',
    changedFiles: ['src/c.ts'],
    archivedReviewPath: '/tmp/review-3.md',
  });
  assert.deepEqual(packet.aggregateReviewContext, {
    baseCommit: 'abc123',
    headCommit: 'final-3',
    range: 'abc123..final-3',
    commitSubjects: [],
    diffStat: '',
    changedFiles: [],
    unavailableReason: packet.aggregateReviewContext.unavailableReason,
  });
  assert.match(packet.aggregateReviewContext.unavailableReason ?? '', /Unable to read aggregate completion git context/);
});

test('final completion packet includes git-backed aggregate review context', async () => {
  const { state } = await createState({
    currentScopeNumber: 1,
    executionShape: 'one_shot',
  });

  await runGit(state.cwd, ['init', '-q']);
  await runGit(state.cwd, ['config', 'user.name', 'Neal Test']);
  await runGit(state.cwd, ['config', 'user.email', 'neal-test@example.com']);
  await runGit(state.cwd, ['add', 'PLAN.md', 'neal.yml']);
  await runGit(state.cwd, ['commit', '-m', 'base plan']);
  const baseCommit = await runGit(state.cwd, ['rev-parse', 'HEAD']);

  await mkdir(join(state.cwd, 'src'), { recursive: true });
  await writeFile(join(state.cwd, 'src', 'feature.ts'), 'export const feature = true;\n', 'utf8');
  await runGit(state.cwd, ['add', 'src/feature.ts']);
  await runGit(state.cwd, ['commit', '-m', 'add aggregate feature']);
  const headCommit = await runGit(state.cwd, ['rev-parse', 'HEAD']);

  const packet = await buildFinalCompletionPacket({
    state: {
      ...state,
      initialBaseCommit: baseCommit,
      finalCommit: headCommit,
      completedScopes: [
        {
          number: '1',
          marker: 'AUTONOMY_DONE',
          result: 'accepted',
          baseCommit,
          finalCommit: headCommit,
          commitSubject: 'add aggregate feature',
          changedFiles: ['src/feature.ts'],
          reviewRounds: 1,
          findings: 0,
          archivedReviewPath: '/tmp/review-1.md',
          blocker: null,
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
    },
    terminalScope: null,
  });

  assert.equal(packet.aggregateReviewContext.baseCommit, baseCommit);
  assert.equal(packet.aggregateReviewContext.headCommit, headCommit);
  assert.equal(packet.aggregateReviewContext.range, `${baseCommit}..${headCommit}`);
  assert.deepEqual(packet.aggregateReviewContext.commitSubjects, [`${headCommit} add aggregate feature`]);
  assert.match(packet.aggregateReviewContext.diffStat, /src\/feature\.ts/);
  assert.deepEqual(packet.aggregateReviewContext.changedFiles, ['src/feature.ts']);
  assert.equal(packet.aggregateReviewContext.unavailableReason, null);
});

test('progress and final completion artifacts preserve residual non-blocking review debt', async () => {
  const residualReviewDebt = [
    {
      id: 'R1-F1',
      canonicalId: 'canonical-debt-1',
      status: 'deferred' as const,
      files: ['src/neal/progress.ts'],
      claim: 'Progress artifacts omit deferred non-blocking findings.',
      evidence: 'Accepted scope retained one deferred finding after optional response.',
      requiredAction: 'Surface deferred review debt in operator-facing artifacts.',
      coderDisposition: 'Deferred because the fix belongs to the next polishing pass.',
      coderCommit: null,
    },
  ];
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-2',
        finalCommit: 'final-2',
        commitSubject: 'implement scope 2',
        changedFiles: ['src/neal/progress.ts'],
        reviewRounds: 2,
        findings: 3,
        residualReviewDebt,
        archivedReviewPath: '/tmp/review-2.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Residual Review Debt/);
  assert.match(progressMarkdown, /- Deferred non-blocking findings: 1/);
  assert.match(progressMarkdown, /- Non-residual findings \(all severities\): 2/);
  assert.match(progressMarkdown, /Scope 2 R1-F1 \(deferred\): Progress artifacts omit deferred non-blocking findings\./);
  assert.match(progressMarkdown, /- Residual open\/deferred non-blocking findings: 1/);

  const packet = await buildFinalCompletionPacket({ state, terminalScope: null });
  assert.deepEqual(packet.residualReviewDebt, residualReviewDebt);
  assert.match(packet.residualReviewDebtSummary, /Scope 2 R1-F1 \(deferred\)/);
  assert.match(packet.completedScopeSummary, /residual non-blocking debt: R1-F1 deferred/);

  const completionMarkdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(completionMarkdown, /## Residual Review Debt/);
  assert.match(completionMarkdown, /accepted-scope leftovers are acceptable residual polish/);
  assert.match(completionMarkdown, /### Scope 2 R1-F1/);
  assert.match(completionMarkdown, /- Coder disposition: Deferred because the fix belongs to the next polishing pass\./);
});

test('accepted completed scopes retain only open or deferred non-blocking findings as residual debt', async () => {
  const { state } = await createState({
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-1',
        reviewedPlanPath: null,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'base', head: 'head' },
        openBlockingCanonicalCount: 0,
        findings: ['R1-F1', 'R1-F2', 'R1-F3'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'deferred-polish',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/final-completion.ts'],
        claim: 'Completion packet should mention deferred polish.',
        evidence: 'The finding remained deferred after optional response.',
        requiredAction: 'Expose it in completion artifacts.',
        status: 'deferred',
        roundSummary: 'One deferred polish item remains.',
        coderDisposition: 'Deferred because it is acceptable residual polish.',
        coderCommit: null,
      },
      {
        id: 'R1-F2',
        canonicalId: 'fixed-polish',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/review.ts'],
        claim: 'Review text had a typo.',
        evidence: 'The typo was present in the first draft.',
        requiredAction: 'Fix the typo.',
        status: 'fixed',
        roundSummary: 'Fixed typo.',
        coderDisposition: 'Fixed in the follow-up commit.',
        coderCommit: 'fix-commit',
      },
      {
        id: 'R1-F3',
        canonicalId: 'blocking-regression',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['src/neal/progress.ts'],
        claim: 'A blocking issue was fixed before acceptance.',
        evidence: 'The reviewer accepted after the fix.',
        requiredAction: 'Keep this out of residual non-blocking debt.',
        status: 'open',
        roundSummary: 'Blocking issue.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });

  const completedScopes = appendCompletedScope(state, 'accepted', {
    finalCommit: 'final-1',
    commitSubject: 'finish scope',
    changedFiles: ['src/neal/final-completion.ts'],
    archivedReviewPath: '/tmp/review-1.md',
    blocker: null,
  });

  assert.equal(completedScopes[0]?.residualReviewDebt?.length, 1);
  assert.equal(completedScopes[0]?.residualReviewDebt?.[0]?.id, 'R1-F1');
});

test('final completion packet models a verification-only terminal scope explicitly', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    executionShape: 'multi_scope',
    createdCommits: [],
    completedScopes: [
      {
        number: '3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-3',
        finalCommit: 'final-3',
        commitSubject: 'implement scope 3',
        changedFiles: ['src/existing.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-3.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await writeFile(
    join(state.runDir, 'events.ndjson'),
    `${JSON.stringify({ type: 'coder.command_execution', data: { command: 'pnpm typecheck' } })}\n`,
    'utf8',
  );

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'head-4',
      commitSubject: 'verification-only finish',
      changedFiles: [],
      archivedReviewPath: '/tmp/review-4.md',
      marker: 'AUTONOMY_DONE',
    },
  });

  assert.equal(packet.verificationOnlyCompletion, true);
  assert.equal(packet.terminalChangedFilesSummary, 'none');
  assert.deepEqual(packet.planChangedFiles, ['src/existing.ts']);
  assert.match(packet.verificationSummary, /pnpm typecheck/);
  assert.deepEqual(packet.lastNonEmptyImplementationScope, {
    number: '3',
    finalCommit: 'final-3',
    commitSubject: 'implement scope 3',
    changedFiles: ['src/existing.ts'],
    archivedReviewPath: '/tmp/review-3.md',
  });
});

test('final completion summary prompt requests compact whole-plan completion JSON', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    createdCommits: ['scope-3-commit'],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  await writeFile(
    join(state.runDir, 'events.ndjson'),
    `${JSON.stringify({ type: 'coder.command_execution', data: { command: 'pnpm typecheck' } })}\n`,
    'utf8',
  );

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/b.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });
  const prompt = buildFinalCompletionSummaryPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
  });

  assert.match(prompt, /Return only JSON that matches the required schema/);
  assert.match(prompt, /planGoalSatisfied/);
  assert.match(prompt, /whatChangedOverall/);
  assert.match(prompt, /verificationOnlyCompletion/);
  assert.match(prompt, /aggregateReviewContext/);
  assert.match(prompt, /completedScopeSummary/);
  assert.match(prompt, /acceptedScopeRecordCount/);
  assert.match(prompt, /scopeAccountingSummary/);
  assert.match(prompt, /verificationCommandResults/);
  assert.match(prompt, /regressions, quality concerns, testing gaps/);
  // The evidence-audit clause (issue #10) renders exactly once on the summary
  // surface, voice-matched so it does not claim verification that did not run.
  assert.equal(
    prompt.split(EVIDENCE_AUDIT_CLAUSE).length - 1,
    1,
    'buildFinalCompletionSummaryPrompt must render the evidence-audit clause exactly once',
  );
  // Pin the complete voice-matched clause, including the summary-specific tail
  // that forbids claiming verification that did not actually run, so a reworded
  // or dropped tail fails even though the shared core would still be present.
  assert.equal(
    prompt.split(EVIDENCE_AUDIT_SUMMARY_CLAUSE).length - 1,
    1,
    'buildFinalCompletionSummaryPrompt must render the full voice-matched clause (no unrun-verification claim) exactly once',
  );
  // The output-format instructions are spliced in as one contiguous block from
  // the guarded helper, and no transport-conflicting fence-prohibition remains.
  assert.ok(
    prompt.includes(completionJsonOutputFormatLines('buildFinalCompletionSummaryPrompt').join('\n')),
    'summary prompt must splice the guarded output-format lines as one contiguous block',
  );
  // The output-format framing must stay transport-neutral: openai-compatible
  // sends this base prompt with no neal-json protocol block below it, so the
  // block must not claim instructions appear "below".
  assert.doesNotMatch(
    completionJsonOutputFormatLines('buildFinalCompletionSummaryPrompt').join('\n'),
    /below/i,
    'summary output-format framing must be transport-neutral (no "protocol below" claim)',
  );
  for (const marker of CONFLICTING_OUTPUT_FORMAT_MARKERS) {
    assert.doesNotMatch(
      prompt,
      new RegExp(marker, 'i'),
      `summary prompt must not contain transport-conflicting marker: ${marker}`,
    );
  }
});

test('final completion reviewer prompt requires a structured whole-plan verdict', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/b.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });
  const prompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
    summary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the completion packet and coder summary contract.',
      verificationSummary: 'Ran review tests and typecheck.',
      remainingKnownGaps: ['Reviewer completion verdict is still needed.'],
    },
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/final-completion-review',
  });

  assert.match(prompt, /whole-plan final completion review/i);
  assert.match(prompt, /Evaluate the totality of the work completed for this plan/);
  assert.match(prompt, /ordinary code review standards/);
  assert.match(prompt, /Treat the whole-plan completion claim as hostile input/);
  assert.match(prompt, /aggregate range abc123\.\.final-3/);
  assert.match(prompt, /Trace the changed runtime path far enough to prove the happy path is reachable/);
  assert.match(prompt, /Temporary verification scratch directory: \/tmp\/repo\/\.neal\/runs\/run-123\/scratch\/final-completion-review/);
  assert.match(prompt, /Do not create project-root scratch directories such as build_review\//);
  assert.match(prompt, /Do not leave project-tree scratch files behind/);
  assert.match(prompt, /Falsify cross-scope runtime invariants and integration behavior before accepting completion/);
  assert.match(prompt, /tests that mock away the risky runtime path/);
  assert.match(prompt, /Treat completion-blocking issues like review findings/);
  assert.match(prompt, /aggregateReviewContext/);
  assert.match(prompt, /completion-review evidence gap/);
  assert.match(prompt, /Do not treat prior per-scope acceptance as sufficient evidence/);
  assert.match(prompt, /scopeAccountingSummary/);
  assert.match(prompt, /verificationCommandResults/);
  assert.match(prompt, /accept_complete/);
  assert.match(prompt, /continue_execution/);
  assert.match(prompt, /block_for_operator/);
  assert.match(prompt, /missingWork/);
  assert.match(prompt, /Squash commit message rules:/);
  assert.match(prompt, /`squashCommitMessage` is project-facing Git history/);
  assert.match(prompt, /Use `squashCommitMessage` only for `accept_complete`/);
  assert.match(prompt, /non-accept action, set `squashCommitMessage` to null/);
  assert.match(prompt, /plan paths, markdown plan filenames, temporary run paths/);
  assert.match(prompt, /scope-numbered or per-scope wording/);
  assert.match(prompt, /Summarize the code or product behavior change, not the plan document/);
  assert.match(prompt, /requiredOutcome/);
  assert.match(prompt, /verificationOnlyCompletion/);
  assert.match(prompt, /continueExecutionCount/);
  assert.match(prompt, /continueExecutionMax/);
  assert.match(prompt, /Identify the shared subsystems the aggregate implementation touches/);
  assert.match(prompt, /remains part of the contract/);
  assert.match(prompt, /running them when available/);
  assert.match(prompt, /re-audit unrelated parts of the project/);
  assert.match(prompt, /inside the required acceptance surface when the plan explicitly requires/);
  assert.match(prompt, /neither fixed nor surfaced as a blocking concern is a blocking finding/);
  assert.match(prompt, /scope drift rather than extra credit/);
  assert.match(prompt, /run the most relevant existing tests or reproduce the reported behavior/);
  assert.match(prompt, /predates the aggregate implementation/);
  // The output-format instructions are spliced in as one contiguous block from
  // the guarded helper, and no transport-conflicting fence-prohibition remains.
  assert.ok(
    prompt.includes(completionJsonOutputFormatLines('buildFinalCompletionReviewerPrompt').join('\n')),
    'reviewer prompt must splice the guarded output-format lines as one contiguous block',
  );
  // The output-format framing must stay transport-neutral: openai-compatible
  // sends this base prompt with no neal-json protocol block below it, so the
  // block must not claim instructions appear "below".
  assert.doesNotMatch(
    completionJsonOutputFormatLines('buildFinalCompletionReviewerPrompt').join('\n'),
    /below/i,
    'reviewer output-format framing must be transport-neutral (no "protocol below" claim)',
  );
  for (const marker of CONFLICTING_OUTPUT_FORMAT_MARKERS) {
    assert.doesNotMatch(
      prompt,
      new RegExp(marker, 'i'),
      `reviewer prompt must not contain transport-conflicting marker: ${marker}`,
    );
  }
  // Attended completion review omits the unattended autonomy line; the unattended
  // variant renders it while leaving the attended render byte-identical.
  assert.doesNotMatch(prompt, /No operator is available to answer\./);
  const unattendedCompletionPrompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
    summary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the completion packet and coder summary contract.',
      verificationSummary: 'Ran review tests and typecheck.',
      remainingKnownGaps: ['Reviewer completion verdict is still needed.'],
    },
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/final-completion-review',
    unattended: true,
  });
  assert.ok(unattendedCompletionPrompt.includes(UNATTENDED_AUTONOMY_LINE));
  assert.equal(
    buildFinalCompletionReviewerPrompt({
      planDoc: '/tmp/PLAN.md',
      packet,
      summary: {
        planGoalSatisfied: false,
        whatChangedOverall: 'Implemented the completion packet and coder summary contract.',
        verificationSummary: 'Ran review tests and typecheck.',
        remainingKnownGaps: ['Reviewer completion verdict is still needed.'],
      },
      scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/final-completion-review',
      unattended: false,
    }),
    prompt,
  );
});

test('final completion reviewer prompt default variant instructs repository inspection without inline context', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/b.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });
  const summary = {
    planGoalSatisfied: false,
    whatChangedOverall: 'Implemented the completion packet and coder summary contract.',
    verificationSummary: 'Ran review tests and typecheck.',
    remainingKnownGaps: ['Reviewer completion verdict is still needed.'],
  };
  const baseArgs = {
    planDoc: '/tmp/PLAN.md',
    packet,
    summary,
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/final-completion-review',
  };
  const readCapablePrompt = buildFinalCompletionReviewerPrompt(baseArgs);
  assert.match(readCapablePrompt, /Use git commands against the repository, for example: git diff abc123\.\.final-3/);
  assert.match(readCapablePrompt, /Temporary verification scratch directory: /);
  assert.doesNotMatch(readCapablePrompt, /## Inlined review context from Neal/);
});

test('final completion reviewer prompt read-only variant instructs read-tool inspection without execution or scratch work', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'implement scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-1.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: {
      finalCommit: 'final-3',
      commitSubject: 'finish scope 3',
      changedFiles: ['src/b.ts'],
      archivedReviewPath: '/tmp/review-3.md',
      marker: 'AUTONOMY_DONE',
    },
  });
  const summary = {
    planGoalSatisfied: true,
    whatChangedOverall: 'Implemented the read-only doctrine mode.',
    verificationSummary: 'Ran review tests and typecheck.',
    remainingKnownGaps: [],
  };
  const baseArgs = {
    planDoc: '/tmp/PLAN.md',
    packet,
    summary,
    scratchDir: '/tmp/repo/.neal/runs/run-123/scratch/final-completion-review',
  };

  const readOnlyPrompt = buildFinalCompletionReviewerPrompt({ ...baseArgs, accessMode: 'read-only' });
  // Read-only variant names the read-only git_diff/read tools over the injected
  // aggregate range, and drops execution, scratch, and shell-git instructions.
  assert.match(readOnlyPrompt, /git_diff/);
  assert.match(readOnlyPrompt, /read tools/);
  assert.match(readOnlyPrompt, /abc123\.\.final-3/);
  assert.doesNotMatch(readOnlyPrompt, /Use git commands against the repository/);
  assert.doesNotMatch(readOnlyPrompt, /Temporary verification scratch directory:/);
  assert.doesNotMatch(readOnlyPrompt, /scratch directory/i);
  assert.doesNotMatch(readOnlyPrompt, /running them when available/);
  assert.doesNotMatch(readOnlyPrompt, /run the most relevant existing tests/);
  assert.doesNotMatch(readOnlyPrompt, /## Inlined review context from Neal/);
  assert.doesNotMatch(readOnlyPrompt, /inlined below/);

  // Explicit 'tool-access' renders byte-identically to the default.
  assert.equal(
    buildFinalCompletionReviewerPrompt({ ...baseArgs, accessMode: 'tool-access' }),
    buildFinalCompletionReviewerPrompt(baseArgs),
  );

  // An empty-string aggregate diff is a present (collected) diff, so it still
  // rides the inlined channel rather than falling back to git_diff.
  const emptyDiffPrompt = buildFinalCompletionReviewerPrompt({
    ...baseArgs,
    accessMode: 'read-only',
    inlinedRangeDiff: '',
  });
  assert.match(emptyDiffPrompt, /## Inlined commit-range diff from Neal \(abc123\.\.final-3\)/);
  assert.match(emptyDiffPrompt, /\(empty diff\)/);
  assert.match(
    emptyDiffPrompt,
    /The commit-range diff for that aggregate range abc123\.\.final-3 is inlined below and is the source of truth/,
  );
  assert.match(emptyDiffPrompt, /Inspect the change using the inlined commit-range diff below for what changed/);
  assert.doesNotMatch(emptyDiffPrompt, /git_diff/);
  assert.doesNotMatch(emptyDiffPrompt, /Use git commands against the repository/);
});

test('final completion review artifact records coder summary, reviewer verdict, and resulting action', async () => {
  const { state } = await createState({
    currentScopeNumber: 6,
    phase: 'blocked',
    status: 'blocked',
    executionShape: 'multi_scope',
    finalCommit: 'final-6',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionContinueExecutionCount: 2,
    finalCompletionContinueExecutionCapReached: true,
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Completed the planned scopes, but one final gap remained.',
      verificationSummary: 'Ran orchestrator, review, and plan-review coverage.',
      remainingKnownGaps: ['One operator decision is still required.'],
    },
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'Another repair scope would normally be required.',
      rationale: 'The requested completion state still has one concrete missing repair.',
      missingWork: {
        summary: 'Add the remaining audit-trail regression case.',
        requiredOutcome: 'Cover the final-completion operator-block path.',
        verification: 'Run orchestrator tests and typecheck.',
      },
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'block_for_operator',
    reviewerSessionHandle: 'reviewer-final-6',
  });

  const markdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(markdown, /# Final Completion Review/);
  assert.match(markdown, /- What changed overall: Completed the planned scopes, but one final gap remained\./);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: final_completion_review/);
  assert.match(markdown, /- Adjudication family: final_completion/);
  assert.match(markdown, /- Allowed transition outcomes: accept_complete, continue_execution, block_for_operator/);
  assert.match(markdown, /- Reviewer action: continue_execution/);
  assert.match(markdown, /- Resulting action: block_for_operator/);
  assert.match(markdown, /- Missing work summary: Add the remaining audit-trail regression case\./);
  assert.match(markdown, /## Squash Commit Message Draft/);
  assert.match(markdown, /None recorded\./);
  assert.match(markdown, /Run blocked for operator guidance\./);
  assert.equal(getFinalCompletionReviewArtifactPath(state.runDir), join(state.runDir, 'FINAL_COMPLETION_REVIEW.md'));
});

test('final completion review and retrospective surface interactive blocked recovery details', async () => {
  const { state } = await createState({
    currentScopeNumber: 3,
    phase: 'done',
    status: 'done',
    baseCommit: null,
    finalCommit: 'final-3',
    interactiveBlockedRecoveryHistory: [
      {
        enteredAt: '2026-04-16T00:00:00.000Z',
        sourcePhase: 'coder_scope',
        blockedReason: 'The validation gate hit an unrelated baseline failure.',
        maxTurns: 3,
        lastHandledTurn: 1,
        resolvedAt: '2026-04-16T00:03:00.000Z',
        resolvedByAction: 'resume_current_scope',
        resultPhase: 'coder_scope',
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-16T00:01:00.000Z',
            operatorGuidance: 'Broaden the scope to include the blocking test fix.',
            disposition: {
              recordedAt: '2026-04-16T00:02:00.000Z',
              sessionHandle: 'coder-session-3',
              action: 'resume_current_scope',
              summary: 'The blocker is now authorized inside the current scope.',
              rationale: 'The operator folded the test fix into the current scope.',
              blocker: '',
              replacementPlan: '',
              resultingPhase: 'coder_scope',
            },
          },
        ],
      },
    ],
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed all requested cleanup work.',
      verificationSummary: 'Lint and the required test suites passed.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'The plan is complete.',
      rationale: 'All required work landed cleanly.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Complete requested cleanup work',
        bullets: [
          'Finish the requested cleanup behavior across the implementation.',
          'Verify the completed result with lint and required test suites.',
        ],
      },
    },
    finalCompletionResolvedAction: 'accept_complete',
  });

  const completionMarkdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(completionMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(completionMarkdown, /Blocked reason: The validation gate hit an unrelated baseline failure\./);
  assert.match(completionMarkdown, /Turn 1 guidance: Broaden the scope to include the blocking test fix\./);
  assert.match(completionMarkdown, /Turn 1 coder summary: The blocker is now authorized inside the current scope\./);
  assert.match(completionMarkdown, /## Squash Commit Message Draft/);
  assert.match(completionMarkdown, /Complete requested cleanup work/);
  assert.match(completionMarkdown, /- Finish the requested cleanup behavior across the implementation\./);

  const { archivedPath } = await writeCheckpointRetrospective(state, 'done');
  const retrospective = await readFile(archivedPath, 'utf8');
  assert.match(retrospective, /## Interactive Blocked Recovery History/);
  assert.match(retrospective, /Resolution: resume_current_scope/);
  assert.match(retrospective, /Turn 1 guidance: Broaden the scope to include the blocking test fix\./);
});

test('final completion review omits unknown totals for recurring plans', async () => {
  const { state } = await createState({
    currentScopeNumber: 5,
    executionShape: 'multi_scope_unknown',
    phase: 'final_completion_review',
    status: 'running',
  });

  const markdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(markdown, /- Scope progress: scope 5\b/);
  assert.doesNotMatch(markdown, /- Scope progress: scope 5\/\?/);
});

test('final completion packet rolls derived sub-scope history into the whole-plan summary', async () => {
  const { state } = await createState({
    currentScopeNumber: 7,
    executionShape: 'multi_scope',
    completedScopes: [
      {
        number: '7.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-7-1',
        finalCommit: 'final-7-1',
        commitSubject: 'derived scope 7.1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-7.1.md',
        blocker: null,
        derivedFromParentScope: '7',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '7.2',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: 'base-7-2',
        finalCommit: 'final-7-2',
        commitSubject: 'derived scope 7.2',
        changedFiles: ['src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-7.2.md',
        blocker: null,
        derivedFromParentScope: '7',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '7',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: 'base-7',
        finalCommit: 'final-7',
        commitSubject: 'rolled-up parent scope 7',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        reviewRounds: 2,
        findings: 0,
        archivedReviewPath: '/tmp/review-7.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_7.md',
      },
    ],
  });

  const packet = await buildFinalCompletionPacket({ state, terminalScope: null });
  assert.equal(packet.acceptedScopeCount, 3);
  assert.equal(packet.scopeAccounting.acceptedTopLevelScopeRecords, 1);
  assert.equal(packet.scopeAccounting.acceptedDerivedSubScopeRecords, 2);
  assert.match(packet.scopeAccountingSummary, /1 top-level parent\/objective record\(s\), 2 derived sub-scope record\(s\)/);
  assert.match(packet.scopeAccountingSummary, /parent scope replacement\(s\): 7 -> \/tmp\/DERIVED_PLAN_SCOPE_7\.md/);
  assert.match(packet.completedScopeSummary, /Scope 7\.1: accepted \(AUTONOMY_SCOPE_DONE\).*parent 7/);
  assert.match(packet.completedScopeSummary, /Scope 7\.2: accepted \(AUTONOMY_DONE\).*parent 7/);
  assert.match(packet.completedScopeSummary, /Scope 7: accepted \(AUTONOMY_DONE\).*src\/a\.ts, src\/b\.ts/);
  assert.deepEqual(packet.planChangedFiles, ['src/a.ts', 'src/b.ts']);

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Scope Accounting/);
  assert.match(progressMarkdown, /Accepted scope records: 3 total \(1 top-level parent\/objective record\(s\), 2 derived sub-scope record\(s\)\)/);
  assert.match(progressMarkdown, /Scope 7: \/tmp\/DERIVED_PLAN_SCOPE_7\.md/);

  const finalReviewMarkdown = renderFinalCompletionReviewMarkdown(state);
  assert.match(finalReviewMarkdown, /## Scope Accounting/);
  assert.match(finalReviewMarkdown, /Top-level records are the comparable count against the original plan/);
});

test('progress artifact renders current meaningful-progress context and bounded recent history', async () => {
  const { state } = await createState({
    currentScopeNumber: 8,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Audit trail for meaningful-progress gating',
      newEvidence: 'Progress markdown now shows the current gate inputs.',
      whyNotRedundant: 'The prior artifact hid reviewer convergence context.',
      nextStepUnlocked: 'Operators can inspect scope churn without reconstructing session state.',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'block_for_operator',
      rationale: 'The recent scopes revisit the same hotspot without advancing the parent objective.',
    },
    completedScopes: [
      {
        number: '8.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-1',
        finalCommit: 'final-8-1',
        commitSubject: 'scope 8.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.1.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-2',
        finalCommit: 'final-8-2',
        commitSubject: 'scope 8.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.2.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-3',
        finalCommit: 'final-8-3',
        commitSubject: 'scope 8.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.3.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.4',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-4',
        finalCommit: 'final-8-4',
        commitSubject: 'scope 8.4',
        changedFiles: ['src/shared.ts', 'src/d.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.4.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.5',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-5',
        finalCommit: 'final-8-5',
        commitSubject: 'scope 8.5',
        changedFiles: ['src/shared.ts', 'src/e.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.5.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '8.6',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-8-6',
        finalCommit: 'final-8-6',
        commitSubject: 'scope 8.6',
        changedFiles: ['src/shared.ts', 'src/f.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-8.6.md',
        blocker: null,
        derivedFromParentScope: '8',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const markdown = renderPlanProgressMarkdown(state);
  const historySection = markdown.split('## Completed Scopes')[0] ?? markdown;

  assert.match(markdown, /## Meaningful Progress/);
  assert.match(markdown, /- Active parent objective: 8/);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: execute_review/);
  assert.match(markdown, /- Adjudication family: execute_review/);
  assert.match(markdown, /- Allowed transition outcomes: accept_scope, request_revision, optional_revision, block_for_operator, replace_plan, advance_parent/);
  assert.match(markdown, /- Coder milestone: Audit trail for meaningful-progress gating/);
  assert.match(markdown, /- Reviewer action: block_for_operator/);
  assert.match(markdown, /- Reviewer rationale: The recent scopes revisit the same hotspot without advancing the parent objective\./);
  assert.match(historySection, /Accepted scope history for parent objective 8 \(oldest to newest, last 5 max\):/);
  assert.doesNotMatch(historySection, /Scope 8\.1/);
  assert.match(historySection, /Scope 8\.2/);
  assert.match(historySection, /Scope 8\.6/);
  assert.match(historySection, /Touched-file concentration: src\/shared\.ts \(5\/5 scopes\)/);
});

test('plan progress json mirrors meaningful-progress context for external tooling', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    currentScopeProgressJustification: {
      milestoneTargeted: 'JSON audit parity',
      newEvidence: 'plan-progress.json now carries the gate context',
      whyNotRedundant: 'External tooling should not have to scrape markdown',
      nextStepUnlocked: 'Operators can inspect machine-readable progress state',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'replace_plan',
      rationale: 'The current objective needs replacement rather than another retry.',
    },
    completedScopes: [
      {
        number: '4.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-4-1',
        finalCommit: 'final-4-1',
        commitSubject: 'scope 4.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-4.1.md',
        blocker: null,
        derivedFromParentScope: '4',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '4.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-4-2',
        finalCommit: 'final-4-2',
        commitSubject: 'scope 4.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-4.2.md',
        blocker: null,
        derivedFromParentScope: '4',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  await writePlanProgressArtifacts(state);
  const progress = JSON.parse(await readFile(state.progressJsonPath, 'utf8')) as {
    meaningfulProgress: {
      parentObjective: string;
      currentScopeProgressJustification: { milestoneTargeted: string };
      currentScopeMeaningfulProgressVerdict: { action: string };
      recentAcceptedScopeHistory: Array<{ number: string }>;
    };
  };

  assert.equal(progress.meaningfulProgress.parentObjective, '4');
  assert.equal(progress.meaningfulProgress.currentScopeProgressJustification.milestoneTargeted, 'JSON audit parity');
  assert.equal(progress.meaningfulProgress.currentScopeMeaningfulProgressVerdict.action, 'replace_plan');
  assert.deepEqual(
    progress.meaningfulProgress.recentAcceptedScopeHistory.map((scope) => scope.number),
    ['4.1', '4.2'],
  );
});

test('review artifact renders derived-parent meaningful-progress history and verdict', async () => {
  const { state } = await createState({
    currentScopeNumber: 6,
    phase: 'reviewer_scope',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: 3,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Derived scope churn detection',
      newEvidence: 'The review artifact now shows original-parent history for derived execution.',
      whyNotRedundant: 'Derived sub-scopes should not hide the parent convergence story.',
      nextStepUnlocked: 'Reviewers can judge whether the sub-scope still advances parent scope 6.',
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'replace_plan',
      rationale: 'The sub-scope keeps revisiting the same parent hotspot and should be replaced.',
    },
    completedScopes: [
      {
        number: '6.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-6-1',
        finalCommit: 'final-6-1',
        commitSubject: 'scope 6.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-6.1.md',
        blocker: null,
        derivedFromParentScope: '6',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '6.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-6-2',
        finalCommit: 'final-6-2',
        commitSubject: 'scope 6.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-6.2.md',
        blocker: null,
        derivedFromParentScope: '6',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '6',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-6',
        finalCommit: 'final-6',
        commitSubject: 'rolled-up scope 6',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-6.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
      },
    ],
  });

  const markdown = renderReviewMarkdown(state);

  assert.match(markdown, /## Meaningful Progress/);
  assert.match(markdown, /- Active parent objective: 6/);
  assert.match(markdown, /## Adjudication Contract/);
  assert.match(markdown, /- Adjudication spec id: execute_review/);
  assert.match(markdown, /- Adjudication family: execute_review/);
  assert.match(markdown, /- Allowed transition outcomes: accept_scope, request_revision, optional_revision, block_for_operator, replace_plan, advance_parent/);
  assert.match(markdown, /- Coder milestone: Derived scope churn detection/);
  assert.match(markdown, /- Reviewer action: replace_plan/);
  assert.match(markdown, /- Reviewer rationale: The sub-scope keeps revisiting the same parent hotspot and should be replaced\./);
  assert.match(markdown, /### Recent Accepted Scope History/);
  assert.match(markdown, /Accepted scope history for parent objective 6 \(oldest to newest, last 5 max\):/);
  assert.match(markdown, /Scope 6\.1/);
  assert.match(markdown, /Scope 6\.2/);
  assert.doesNotMatch(markdown, /Scope 6\n/);
  assert.match(markdown, /Touched-file concentration: src\/shared\.ts \(2\/2 scopes\)/);
});

test('renderReviewMarkdown surfaces the plan-review debt section and per-finding finding class', async () => {
  const { state } = await createState({
    topLevelMode: 'plan',
    phase: 'reviewer_plan',
    findings: [
      {
        id: 'R3-F1',
        canonicalId: 'C3',
        round: 3,
        source: 'reviewer',
        severity: 'blocking',
        findingClass: 'verification_hardening',
        files: ['PLAN.md'],
        claim: 'Verification should pin the retry-count behavior.',
        evidence: '',
        requiredAction: 'Add an executable oracle for retry counting.',
        status: 'deferred',
        roundSummary: 'Round 3 hardening.',
        coderDisposition: null,
        coderCommit: null,
      },
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        findingClass: 'plan_correctness',
        files: ['PLAN.md'],
        claim: 'The plan omits a required scope.',
        evidence: '',
        requiredAction: 'Add the missing scope.',
        status: 'fixed',
        roundSummary: 'Round 1 correctness.',
        coderDisposition: 'Added the scope.',
        coderCommit: null,
      },
    ],
    planReviewDebt: [
      {
        id: 'R3-F1',
        canonicalId: 'C3',
        status: 'deferred',
        files: ['PLAN.md'],
        claim: 'Verification should pin the retry-count behavior.',
        evidence: '',
        requiredAction: 'Add an executable oracle for retry counting.',
        coderDisposition: null,
        coderCommit: null,
        findingClass: 'verification_hardening',
        originRound: 3,
      },
    ],
    inheritedPlanReviewDebt: [
      {
        id: 'R4-F2',
        canonicalId: 'C9',
        status: 'deferred',
        files: ['PLAN.md'],
        claim: 'Inherited: pin the provenance oracle.',
        evidence: '',
        requiredAction: 'Add a provenance assertion.',
        coderDisposition: null,
        coderCommit: null,
        findingClass: 'verification_hardening',
        originRound: 4,
      },
    ],
  });

  const markdown = renderReviewMarkdown(state);

  // Per-finding finding-class lines.
  assert.match(markdown, /- Finding class: verification_hardening/);
  assert.match(markdown, /- Finding class: plan_correctness/);

  // The dedicated debt section with both groups.
  assert.match(markdown, /## Plan Review Debt/);
  assert.match(markdown, /### Inherited\n- C9: findingClass=verification_hardening; originRound=4; claim=Inherited: pin the provenance oracle\./);
  assert.match(markdown, /### Current\n- C3: findingClass=verification_hardening; originRound=3; claim=Verification should pin the retry-count behavior\./);
});

const REVIEWER_LIVENESS_STARTUP_TIMEOUT_MS = 40;

class ReviewerLivenessFakeLogger {
  readonly stderrMessages: string[] = [];
  readonly events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  async stderr(message: string) {
    this.stderrMessages.push(message);
  }

  async event(type: string, data?: Record<string, unknown>) {
    this.events.push({ type, data });
  }

  asRunLogger() {
    return this as unknown as RunLogger;
  }

  eventTypes() {
    return this.events.map((event) => event.type);
  }
}

async function createReviewerLivenessFixture(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'neal:',
      `  agent_turn_startup_timeout_ms: ${REVIEWER_LIVENESS_STARTUP_TIMEOUT_MS}`,
      '  agent_turn_retry_limit: 1',
      '',
    ].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
  return cwd;
}

function reviewerLivenessRoundArgs(providerId: ProviderId, cwd: string, logger: RunLogger) {
  return {
    reviewer: { provider: providerId, model: null },
    cwd,
    planDoc: '# Plan\n',
    baseCommit: 'base-commit',
    headCommit: 'head-commit',
    commits: ['head-commit'],
    diffStat: '1 file changed',
    changedFiles: ['src/example.ts'],
    round: 1,
    reviewMarkdownPath: join(cwd, 'REVIEW.md'),
    parentScopeLabel: '1',
    progressJustification: {
      milestoneTargeted: 'Reviewer liveness wiring',
      newEvidence: 'The reviewer round ran through the liveness supervisor.',
      whyNotRedundant: 'This covers the structured-advisor startup-silence path.',
      nextStepUnlocked: 'The review verdict can be adjudicated.',
    },
    recentHistorySummary: 'No accepted scopes yet.',
    scratchDir: join(cwd, 'scratch'),
    logger,
  };
}

const reviewerLivenessAcceptPayload = {
  summary: 'Scope changes verified.',
  findings: [],
  meaningfulProgressAction: 'accept',
  meaningfulProgressRationale: 'The scope made meaningful progress.',
};

function reviewerNeverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

test('reviewer round with startup silence is aborted, retried, and succeeds on the second attempt', async () => {
  const providerId = 'fake-reviewer-liveness-retry';
  const cwd = await createReviewerLivenessFixture('neal-reviewer-liveness-retry-');
  const logger = new ReviewerLivenessFakeLogger();
  const trace: string[] = [];
  let runs = 0;

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      structuredAdvisorResponses: [reviewerLivenessAcceptPayload],
      onStructuredAdvisorRun: async (args: StructuredAdvisorRoundArgs) => {
        runs += 1;
        const attempt = runs;
        trace.push(`run:${attempt}`);
        if (attempt === 1) {
          args.signal?.addEventListener('abort', () => trace.push('abort:1'), { once: true });
          await args.events?.({ type: 'turn_started', provider: providerId, role: 'structured-advisor' });
          await reviewerNeverSettles();
          return;
        }
        await args.events?.({ type: 'turn_started', provider: providerId, role: 'structured-advisor' });
      },
    }),
  );

  try {
    const result = await runReviewerRound(
      reviewerLivenessRoundArgs(providerId, cwd, logger.asRunLogger()),
    );

    assert.equal(result.summary, 'Scope changes verified.');
    assert.equal(runs, 2);
    // Attempt 1's abort signal fired before attempt 2's adapter call began.
    assert.deepEqual(trace, ['run:1', 'abort:1', 'run:2']);
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_timeout'));
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_retry'));
    assert.ok(!logger.eventTypes().includes('provider.turn_liveness_give_up'));
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('reviewer round that shows meaningful progress before stalling is not treated as startup silence', async () => {
  const providerId = 'fake-reviewer-liveness-progress';
  const cwd = await createReviewerLivenessFixture('neal-reviewer-liveness-progress-');
  const logger = new ReviewerLivenessFakeLogger();
  let runs = 0;
  let abortedDuringSlowWork: boolean | undefined;

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      structuredAdvisorResponses: [reviewerLivenessAcceptPayload],
      onStructuredAdvisorRun: async (args: StructuredAdvisorRoundArgs) => {
        runs += 1;
        await args.events?.({ type: 'turn_started', provider: providerId, role: 'structured-advisor' });
        await args.events?.({
          type: 'command_completed',
          provider: providerId,
          role: 'structured-advisor',
          command: 'git diff --stat',
        });
        // Stall well past the startup timeout; the disarmed supervisor must
        // leave the adapter's inactivity timeout in charge.
        await new Promise((resolve) => setTimeout(resolve, REVIEWER_LIVENESS_STARTUP_TIMEOUT_MS * 3));
        abortedDuringSlowWork = args.signal?.aborted;
      },
    }),
  );

  try {
    const result = await runReviewerRound(
      reviewerLivenessRoundArgs(providerId, cwd, logger.asRunLogger()),
    );

    assert.equal(result.summary, 'Scope changes verified.');
    assert.equal(runs, 1);
    assert.equal(abortedDuringSlowWork, false);
    assert.ok(!logger.eventTypes().includes('provider.turn_liveness_timeout'));
    assert.ok(!logger.eventTypes().includes('provider.turn_liveness_retry'));
    assert.ok(!logger.eventTypes().includes('provider.turn_liveness_give_up'));
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('reviewer round that exhausts liveness retries surfaces as a no_progress_timeout ReviewerRoundError', async () => {
  const providerId = 'fake-reviewer-liveness-give-up';
  const cwd = await createReviewerLivenessFixture('neal-reviewer-liveness-give-up-');
  const logger = new ReviewerLivenessFakeLogger();
  let runs = 0;

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      onStructuredAdvisorRun: async (args: StructuredAdvisorRoundArgs) => {
        runs += 1;
        await args.events?.({ type: 'turn_started', provider: providerId, role: 'structured-advisor' });
        await reviewerNeverSettles();
      },
    }),
  );

  try {
    await assert.rejects(
      runReviewerRound(reviewerLivenessRoundArgs(providerId, cwd, logger.asRunLogger())),
      (error: unknown) => {
        assert.ok(error instanceof ReviewerRoundError);
        assert.equal(error.kind, 'no_progress_timeout');
        assert.match(error.message, /\btimed out after\b/i);
        assert.match(error.message, /no observable progress/i);
        return true;
      },
    );

    assert.equal(runs, 2);
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_timeout'));
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_retry'));
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_give_up'));
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// --- Production-path scope-review adapter-prompt coverage ---
// These tests drive the real adjudicator (runExecuteReviewerAdjudication) and
// the real round function (runReviewerRound -> buildReviewerPrompt) with a
// capturing structured-advisor adapter, then assert on the FINAL adapter
// prompt. This is what catches a wiring regression (dropped inlinedRangeDiff,
// wrong doctrine, re-added removed inline context) between the adjudicator
// and the round.

const SCOPE_REVIEW_PLAN_SENTINEL = 'Plan body sentinel: inline the supervisor contract.';
const SCOPE_REVIEW_DIFF_SENTINEL = 'const inlineReviewSentinel = "captured-by-scope-review-test";';
const SCOPE_REVIEW_HISTORY_SENTINEL = 'Review history sentinel: prior round R1 had no findings.';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
});

function installCapturingScopeReviewAdvisor(provider: string) {
  const captured: StructuredAdvisorRoundArgs[] = [];
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      captured.push(args as StructuredAdvisorRoundArgs);
      return {
        sessionHandle: null,
        structured: {
          summary: 'Captured reviewer round.',
          findings: [],
          meaningfulProgressAction: 'accept',
          meaningfulProgressRationale: 'Capture-test acceptance.',
        } as TStructured,
      };
    },
  };
  setProviderCapabilitiesOverrideForTesting(provider, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return captured;
}

async function createScopeReviewCaptureFixture(reviewerProvider: string) {
  const root = await mkdtemp(join(tmpdir(), 'neal-scope-review-capture-'));
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

  await writeFile(planDoc, `# Plan\n\n${SCOPE_REVIEW_PLAN_SENTINEL}\n`, 'utf8');
  await writeFile(join(cwd, 'feature.ts'), 'export const base = 1;\n', 'utf8');
  await runGit(cwd, ['add', '-A']);
  await runGit(cwd, ['commit', '--no-verify', '-m', 'base commit']);
  const baseCommit = await runGit(cwd, ['rev-parse', 'HEAD']);

  await writeFile(join(cwd, 'feature.ts'), `export const base = 1;\nexport ${SCOPE_REVIEW_DIFF_SENTINEL}\n`, 'utf8');
  await runGit(cwd, ['add', '-A']);
  await runGit(cwd, ['commit', '--no-verify', '-m', 'scope commit']);

  const reviewMarkdownPath = join(runDir, 'REVIEW.md');
  await writeFile(reviewMarkdownPath, `# Review\n\n${SCOPE_REVIEW_HISTORY_SENTINEL}\n`, 'utf8');

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
        reviewMarkdownPath,
        recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
        maxRounds: 3,
      },
      baseCommit,
    )),
    baseCommit,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Land the inline review sentinel.',
      newEvidence: 'The scope commit adds the sentinel constant.',
      whyNotRedundant: 'No prior scope added the sentinel.',
      nextStepUnlocked: 'The reviewer can adjudicate the scope.',
    },
  };

  return { state };
}

async function runRealScopeReviewAdjudication(state: OrchestrationState) {
  // No runReviewerRound injection: this drives the real rounds.ts ->
  // buildReviewerPrompt -> getStructuredAdvisorAdapter path.
  return runExecuteReviewerAdjudication({
    state,
    getHeadCommit,
    getCommitRange,
    getDiffStatForRange,
    getChangedFilesForRange,
    getDiffForRange,
  });
}

// A native read-only reviewer (read tools, no shell, no commit-range diff tool
// — anthropic-claude/openai-codex) gets the commit-range diff inlined directly
// so it can see exactly what changed, and the read-only doctrine references
// that inlined diff instead of naming a git_diff tool or instructing shell. It
// still reads the repository itself, so Neal does not inline the plan or
// review history and the continuity packet keeps citations.
test('scope review prompt reaching a native read-only structured advisor inlines the commit-range diff and names only its read tools', async () => {
  const { state } = await createScopeReviewCaptureFixture('anthropic-claude');
  const captured = installCapturingScopeReviewAdvisor('anthropic-claude');

  await runRealScopeReviewAdjudication(state);

  assert.equal(captured.length, 1);
  const prompt = captured[0]!.prompt;

  // The commit-range diff is inlined as the source of truth: assert the
  // structural section header, the inlined diff sentinel, and the stable
  // diff-myopia rule anchor — not the verbatim instruction sentences.
  assert.match(prompt, /## Inlined commit-range diff from Neal \(/);
  assert.ok(prompt.includes(SCOPE_REVIEW_DIFF_SENTINEL), 'native read-only reviewer prompt should inline the commit-range diff');
  assert.match(prompt, /Absence from the diff is not evidence of absence from the repository/);

  // No commit-range diff tool naming and no shell/git-command/scratch instructions.
  assert.doesNotMatch(prompt, /git_diff/);
  assert.doesNotMatch(prompt, /Use git commands/);
  assert.doesNotMatch(prompt, /git diff |git show |git log /);
  assert.doesNotMatch(prompt, /Temporary verification scratch directory:/);
  assert.doesNotMatch(prompt, /scratch directory/i);
  assert.doesNotMatch(prompt, /running them when available/);

  // It reads the repository itself: no inline-context framing, plan/history not
  // inlined, continuity packet keeps the tool-access rendering with citations.
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
  assert.equal(prompt.includes(SCOPE_REVIEW_PLAN_SENTINEL), false, 'native read-only reviewer prompt must not inline the plan body');
  assert.equal(
    prompt.includes(SCOPE_REVIEW_HISTORY_SENTINEL),
    false,
    'native read-only reviewer prompt must not inline the review history',
  );
  assert.match(prompt, /Prior review history is available at /);
  assert.match(prompt, /## Citations/);
});

// openai-compatible advisor rounds run a read-only tool loop: the reviewer
// inspects the repository with read tools, so its scope-review prompt must use
// the read-only doctrine (inspection instructions, no execution/scratch/git
// commands) and must not receive Neal-inlined context.
test('scope review prompt reaching a read-only structured advisor instructs read-tool inspection without execution and no inline sections', async () => {
  const { state } = await createScopeReviewCaptureFixture('openai-compatible');
  const captured = installCapturingScopeReviewAdvisor('openai-compatible');

  const result = await runRealScopeReviewAdjudication(state);

  assert.equal(captured.length, 1);
  const round = captured[0]!;
  assert.equal(round.label, 'review');
  const prompt = round.prompt;

  // Read-only inspection routes through the git_diff tool: assert the tool
  // marker and the stat:true overview option are named, plus the stable
  // diff-myopia rule anchor — not the verbatim instruction sentences.
  assert.match(prompt, /git_diff/);
  assert.match(prompt, /stat:true/);
  assert.match(prompt, /Absence from the diff is not evidence of absence from the repository/);
  // Path-pointer lines are allowed: a read-only reviewer can read_file them.
  assert.match(prompt, /Prior review history is available at /);

  // No command-execution, test-running, scratch-directory, or git-command
  // instructions of any kind.
  assert.doesNotMatch(prompt, /Temporary verification scratch directory:/);
  assert.doesNotMatch(prompt, /scratch directory/i);
  assert.doesNotMatch(prompt, /Use git commands/);
  assert.doesNotMatch(prompt, /git diff |git show |git log /);
  assert.doesNotMatch(prompt, /running them when available/);

  // No Neal-inlined context: the reviewer reads the repository itself.
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
  assert.equal(prompt.includes(SCOPE_REVIEW_DIFF_SENTINEL), false, 'read-only reviewer prompt must not inline the diff');
  assert.equal(prompt.includes(SCOPE_REVIEW_PLAN_SENTINEL), false, 'read-only reviewer prompt must not inline the plan body');
  assert.equal(
    prompt.includes(SCOPE_REVIEW_HISTORY_SENTINEL),
    false,
    'read-only reviewer prompt must not inline the review history',
  );

  // The continuity packet uses the tool-access rendering with citation paths.
  assert.match(prompt, /# Reviewer Continuity Context/);
  assert.match(prompt, /## Citations/);

  assert.equal(result.reviewerResult.sessionHandle, null);
  assert.equal(result.reviewerResult.meaningfulProgress.action, 'accept');
});

// Issue #10: the reviewer session is the only long-lived memory across scopes,
// and its record of an earlier scope is the coder's summary. When the current
// diff touches a file an earlier accepted scope changed, the adjudicator hands
// the reviewer that scope's per-file diff so the overlap is read, not recalled.
test('execute reviewer adjudication inlines earlier accepted scopes\' per-file diffs for files the current diff touches again', async () => {
  const { state } = await createState({
    baseCommit: 'base600',
    currentScopeNumber: 6,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Scope 6 adjusts the shared helper.',
      newEvidence: 'The scope commit touches the helper and its test.',
      whyNotRedundant: 'Scope 6 work.',
      nextStepUnlocked: 'The reviewer can adjudicate.',
    },
  });
  const scope = (overrides: Partial<OrchestrationState['completedScopes'][number]>): OrchestrationState['completedScopes'][number] => ({
    number: '1',
    marker: 'AUTONOMY_SCOPE_DONE',
    result: 'accepted',
    baseCommit: 'base100',
    finalCommit: 'final100',
    summary: null,
    commitSubject: null,
    changedFiles: [],
    reviewRounds: 1,
    findings: 0,
    residualReviewDebt: [],
    archivedReviewPath: null,
    blocker: null,
    derivedFromParentScope: null,
    replacedByDerivedPlanPath: null,
    ...overrides,
  });
  state.completedScopes = [
    // Accepted and overlapping on one file: included.
    scope({ number: '3', baseCommit: 'base300', finalCommit: 'final300', changedFiles: ['src/helper.ts', 'src/unrelated.ts'] }),
    // Blocked: skipped even though it overlaps.
    scope({ number: '4', result: 'blocked', marker: 'AUTONOMY_BLOCKED', baseCommit: 'base400', finalCommit: null, changedFiles: ['src/helper.ts'] }),
    // Replaced by a derived plan: its work was reset, so skipped.
    scope({ number: '5', baseCommit: 'base500', finalCommit: 'final500', changedFiles: ['test/helper.test.ts'], replacedByDerivedPlanPath: '/tmp/DERIVED.md' }),
    // Accepted, no overlap: nothing to inline.
    scope({ number: '5b', baseCommit: 'base550', finalCommit: 'final550', changedFiles: ['src/elsewhere.ts'] }),
  ];
  const diffCalls: Array<{ base: string; head: string; paths: readonly string[] }> = [];
  let received: unknown = undefined;

  await runExecuteReviewerAdjudication({
    state,
    getHeadCommit: async () => 'head600',
    getCommitRange: async () => ['head600 Adjust the shared helper'],
    getDiffStatForRange: async () => '2 files changed',
    getChangedFilesForRange: async () => ['src/helper.ts', 'test/helper.test.ts'],
    getDiffForRange: async () => 'current scope diff',
    getDiffForRangePaths: async (_cwd, base, head, paths) => {
      diffCalls.push({ base, head, paths });
      return `diff for ${paths.join(',')} in ${base}..${head}`;
    },
    runReviewerRound: async (args) => {
      received = args.earlierScopeChanges;
      return {
        sessionHandle: null,
        summary: 'Reviewed.',
        findings: [],
        meaningfulProgress: { action: 'accept', rationale: 'Advances the objective.' },
      };
    },
  });

  assert.deepEqual(diffCalls, [{ base: 'base300', head: 'final300', paths: ['src/helper.ts'] }]);
  assert.deepEqual(received, [
    {
      file: 'src/helper.ts',
      scopeNumber: '3',
      baseCommit: 'base300',
      finalCommit: 'final300',
      diff: 'diff for src/helper.ts in base300..final300',
    },
  ]);
});

test('collectEarlierScopeChanges returns nothing and calls no git when no accepted scope overlaps', async () => {
  const { state } = await createState({ baseCommit: 'base200' });
  let calls = 0;
  const changes = await collectEarlierScopeChanges({
    state,
    changedFiles: ['src/new.ts'],
    getDiffForRangePaths: async () => {
      calls += 1;
      return 'unexpected';
    },
  });
  assert.deepEqual(changes, []);
  assert.equal(calls, 0);
});

// The prompt renders the earlier-scope section only with an overlap, and the
// preservation rule in every case: a tool-access reviewer can find earlier
// scope history itself, and the rule must not depend on Neal inlining it.
test('scope reviewer prompt renders earlier-scope per-file diffs when supplied and the preservation rule always', () => {
  const base = {
    planDoc: '/tmp/PLAN.md',
    baseCommit: 'base600',
    headCommit: 'head600',
    commits: ['head600 Adjust the shared helper'],
    diffStat: '2 files changed',
    changedFiles: ['src/helper.ts', 'test/helper.test.ts'],
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    parentScopeLabel: '6',
    progressJustification: {
      milestoneTargeted: 'm',
      newEvidence: 'e',
      whyNotRedundant: 'w',
      nextStepUnlocked: 'n',
    },
    recentHistorySummary: 'none',
    scratchDir: '/tmp/scratch',
  };
  const withOverlap = buildReviewerPrompt({
    ...base,
    earlierScopeChanges: [
      {
        file: 'src/helper.ts',
        scopeNumber: '3',
        baseCommit: 'base300',
        finalCommit: 'final300',
        diff: 'diff --git a/src/helper.ts b/src/helper.ts\n+assert.equal(result, 42);\n',
      },
    ],
  });
  const withoutOverlap = buildReviewerPrompt({ ...base, earlierScopeChanges: [] });

  assert.match(withOverlap, /## Earlier-scope changes to files in this diff/);
  assert.match(withOverlap, /### src\/helper\.ts \(scope 3, base300\.\.final300\)/);
  assert.match(withOverlap, /\+assert\.equal\(result, 42\);/);
  assert.doesNotMatch(withoutOverlap, /## Earlier-scope changes to files in this diff/);
  for (const prompt of [withOverlap, withoutOverlap]) {
    assert.match(prompt, /must preserve what that scope's review accepted/);
    assert.match(prompt, /Weakening or removing a test, assertion, or check that an earlier scope introduced is a blocking finding/);
  }
});
