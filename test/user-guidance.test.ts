import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBlockedRecoveryCoderPrompt,
  buildCoderPlanResponsePrompt,
  buildCoderResponsePrompt,
  buildFinalCompletionReviewerPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
  buildReviewerPrompt,
  buildScopePrompt,
} from '../src/neal/agents.js';
import { AUTONOMY_BLOCKED, AUTONOMY_DONE } from '../src/neal/prompts/shared.js';
import {
  clearUserGuidanceCache,
  collectGuidanceDiagnostics,
  GUIDANCE_SECTION_HEADER,
  USER_GUIDANCE_MAX_CHARS,
} from '../src/neal/prompts/guidance.js';

function withGuidanceDir(write: (dir: string) => void, run: () => void) {
  const previous = process.env.NEAL_GUIDANCE_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'neal-guidance-'));
  try {
    write(dir);
    process.env.NEAL_GUIDANCE_DIR = dir;
    clearUserGuidanceCache();
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.NEAL_GUIDANCE_DIR;
    } else {
      process.env.NEAL_GUIDANCE_DIR = previous;
    }
    clearUserGuidanceCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

function withGuidanceHome(write: (home: string) => void, run: (home: string) => void) {
  const previousHome = process.env.HOME;
  const previousGuidanceDir = process.env.NEAL_GUIDANCE_DIR;
  const home = mkdtempSync(join(tmpdir(), 'neal-guidance-home-'));
  try {
    process.env.HOME = home;
    delete process.env.NEAL_GUIDANCE_DIR;
    write(home);
    clearUserGuidanceCache();
    run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousGuidanceDir === undefined) {
      delete process.env.NEAL_GUIDANCE_DIR;
    } else {
      process.env.NEAL_GUIDANCE_DIR = previousGuidanceDir;
    }
    clearUserGuidanceCache();
    rmSync(home, { recursive: true, force: true });
  }
}

function writeGuidance(dir: string, role: 'coder' | 'reviewer' | 'planner', body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${role}.md`), body, 'utf8');
}

const SCOPE_REVIEWER_ARGS = {
  planDoc: '/tmp/PLAN.md',
  baseCommit: 'abc',
  headCommit: 'def',
  commits: ['def commit message'],
  diffStat: 'file | 1 +',
  changedFiles: ['file.ts'],
  round: 1,
  reviewMarkdownPath: '/tmp/REVIEW.md',
  parentScopeLabel: '1',
  progressJustification: {
    milestoneTargeted: 'm',
    newEvidence: 'n',
    whyNotRedundant: 'w',
    nextStepUnlocked: 's',
  },
  recentHistorySummary: 'none',
  scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/reviewer-scope-1-round-1',
};

const PLAN_REVIEWER_ARGS = {
  planDoc: '/tmp/PLAN.md',
  round: 1,
  reviewMarkdownPath: '/tmp/REVIEW.md',
};

const COMPLETION_REVIEWER_ARGS = {
  planDoc: '/tmp/PLAN.md',
  packet: {
    executionShape: 'one_shot',
    currentScopeLabel: '1',
    acceptedScopeCount: 1,
    blockedScopeCount: 0,
    verificationOnlyCompletion: false,
    finalCommit: 'def',
    aggregateReviewContext: {
      baseCommit: 'abc',
      headCommit: 'def',
      range: 'abc..def',
      commitSubjects: ['def finish one-shot plan'],
      diffStat: ' src/example.ts | 1 +',
      changedFiles: ['src/example.ts'],
      unavailableReason: null,
    },
    completedScopeSummary: '- Scope 1: accepted',
    scopeAccountingSummary: '1 accepted top-level record',
    terminalChangedFilesSummary: 'src/example.ts',
    planChangedFilesSummary: 'src/example.ts',
    verificationTally: {
      totalRuns: 1,
      distinctCommands: 1,
      passed: 1,
      failed: 0,
      unknown: 0,
      recentFailures: [],
    },
    lastNonEmptyImplementationScope: null,
    continueExecutionCount: 0,
    continueExecutionMax: 2,
  },
  summary: {
    planGoalSatisfied: true,
    whatChangedOverall: 'x',
    verificationSummary: 'x',
    remainingKnownGaps: [],
  },
  scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/final-completion-review',
} as unknown as Parameters<typeof buildFinalCompletionReviewerPrompt>[0];

test('guidance is loaded from preferred ~/.neal guidance files by default', () => {
  withGuidanceHome(
    (home) => {
      writeGuidance(join(home, '.neal', 'guidance'), 'coder', 'Prefer the primary guidance directory.');
    },
    (home) => {
      const prompt = buildScopePrompt('/tmp/PLAN.md', 'progress here');
      assert.match(prompt, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(prompt, /Prefer the primary guidance directory\./);

      const entries = collectGuidanceDiagnostics();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].role, 'coder');
      assert.equal(entries[0].path, join(home, '.neal', 'guidance', 'coder.md'));
    },
  );
});

test('empty preferred guidance is a no-op for the same role', () => {
  withGuidanceHome(
    (home) => {
      writeGuidance(join(home, '.neal', 'guidance'), 'coder', '   \n\n  ');
    },
    () => {
      const prompt = buildScopePrompt('/tmp/PLAN.md', 'progress here');
      assert.doesNotMatch(prompt, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.deepEqual(collectGuidanceDiagnostics(), []);
    },
  );
});

test('NEAL_GUIDANCE_DIR overrides the default guidance directory', () => {
  withGuidanceHome(
    (home) => {
      writeGuidance(join(home, '.neal', 'guidance'), 'coder', 'Primary guidance should not load.');
      writeGuidance(join(home, 'override-guidance'), 'coder', 'Environment override wins.');
    },
    (home) => {
      process.env.NEAL_GUIDANCE_DIR = join(home, 'override-guidance');
      clearUserGuidanceCache();

      const prompt = buildScopePrompt('/tmp/PLAN.md', 'progress here');
      assert.match(prompt, /Environment override wins\./);
      assert.doesNotMatch(prompt, /Primary guidance should not load\./);

      const entries = collectGuidanceDiagnostics();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].path, join(home, 'override-guidance', 'coder.md'));
    },
  );
});

test('guidance is injected into coder-role scope prompts when file exists', () => {
  withGuidanceDir(
    (dir) => writeGuidance(dir, 'coder', 'Always prefer small diffs.'),
    () => {
      const scope = buildScopePrompt('/tmp/PLAN.md', 'progress here');
      assert.match(scope, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(scope, /Always prefer small diffs\./);

      const response = buildCoderResponsePrompt({
        planDoc: '/tmp/PLAN.md',
        progressText: 'progress',
        verificationHint: 'hint',
        openFindings: [],
      });
      assert.match(response, /Always prefer small diffs\./);
    },
  );
});

test('guidance is injected into reviewer-role prompts when file exists', () => {
  withGuidanceDir(
    (dir) => writeGuidance(dir, 'reviewer', 'Be especially strict about tests.'),
    () => {
      const scopeReview = buildReviewerPrompt(SCOPE_REVIEWER_ARGS);
      assert.match(scopeReview, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(scopeReview, /Be especially strict about tests\./);

      const planReview = buildPlanReviewerPrompt(PLAN_REVIEWER_ARGS);
      assert.match(planReview, /Be especially strict about tests\./);

      const completion = buildFinalCompletionReviewerPrompt(COMPLETION_REVIEWER_ARGS);
      assert.match(completion, /Be especially strict about tests\./);
      assert.match(completion, /Squash commit message rules:/);
      assert.match(completion, /non-accept action, set `squashCommitMessage` to null/);
    },
  );
});

test('guidance is injected into planner-role prompts when file exists', () => {
  withGuidanceDir(
    (dir) => writeGuidance(dir, 'planner', 'Explicitly list verification commands.'),
    () => {
      const planning = buildPlanningPrompt('/tmp/PLAN.md');
      assert.match(planning, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(planning, /Explicitly list verification commands\./);

      const planResponse = buildCoderPlanResponsePrompt({
        planDoc: '/tmp/PLAN.md',
        openFindings: [],
      });
      assert.match(planResponse, /Explicitly list verification commands\./);
    },
  );
});

test('guidance is injected into the blocked-recovery prompt', () => {
  withGuidanceDir(
    (dir) => {
      writeGuidance(dir, 'coder', 'Keep recovery responses narrowly scoped.');
    },
    () => {
      const blockedRecovery = buildBlockedRecoveryCoderPrompt({
        planDoc: '/tmp/PLAN.md',
        progressText: 'Current scope: 2',
        recoveryMarkdownPath: '/tmp/RECOVERY.md',
        blockedReason: 'Need operator guidance.',
        operatorGuidance: 'Use the narrower parser fix.',
        maxTurns: 3,
        turnsTaken: 1,
      });
      assert.match(blockedRecovery, /Keep recovery responses narrowly scoped\./);
      assert.match(blockedRecovery, /Choose exactly one recovery action/);
    },
  );
});

test('missing guidance files leave the prompt unchanged and structured completion actions present', () => {
  withGuidanceDir(
    () => {
      // intentionally empty directory
    },
    () => {
      const scope = buildScopePrompt('/tmp/PLAN.md', 'progress');
      assert.doesNotMatch(scope, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(scope, /action` to `done`/);
      assert.match(scope, /action` to `scope_done`/);
      assert.match(scope, /action=`split_plan`/);
      assert.match(scope, /action=`blocked`/);
      assert.doesNotMatch(scope, /Use AUTONOMY_SPLIT_PLAN only/);
      assert.doesNotMatch(scope, /Treat AUTONOMY_BLOCKED as a last resort/);
      assert.doesNotMatch(scope, /Final line must be exactly one of:/);

      const planning = buildPlanningPrompt('/tmp/PLAN.md');
      assert.doesNotMatch(planning, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(planning, new RegExp(AUTONOMY_DONE));
      assert.match(planning, new RegExp(AUTONOMY_BLOCKED));

      const reviewer = buildReviewerPrompt(SCOPE_REVIEWER_ARGS);
      assert.doesNotMatch(reviewer, new RegExp(GUIDANCE_SECTION_HEADER));
      // Assert the structured reviewer field plus the stable skeptical-posture
      // anchors are present, not the verbatim doctrine sentences.
      assert.match(reviewer, /meaningfulProgressAction/);
      assert.match(reviewer, /hostile input/);
      assert.match(reviewer, /execute-mode failure classes/);
    },
  );
});

test('empty or whitespace-only guidance files skip injection', () => {
  withGuidanceDir(
    (dir) => {
      writeGuidance(dir, 'coder', '   \n\n  \t');
      writeGuidance(dir, 'reviewer', '');
      writeGuidance(dir, 'planner', '\n');
    },
    () => {
      assert.doesNotMatch(buildScopePrompt('/tmp/PLAN.md', ''), new RegExp(GUIDANCE_SECTION_HEADER));
      assert.doesNotMatch(buildReviewerPrompt(SCOPE_REVIEWER_ARGS), new RegExp(GUIDANCE_SECTION_HEADER));
      assert.doesNotMatch(buildPlanningPrompt('/tmp/PLAN.md'), new RegExp(GUIDANCE_SECTION_HEADER));
      assert.deepEqual(collectGuidanceDiagnostics(), []);
    },
  );
});

test('guidance is additive: structured actions and contract still present after injection', () => {
  withGuidanceDir(
    (dir) => {
      writeGuidance(dir, 'coder', 'c-guidance');
      writeGuidance(dir, 'planner', 'p-guidance');
    },
    () => {
      const scope = buildScopePrompt('/tmp/PLAN.md', 'progress');
      assert.match(scope, /c-guidance/);
      assert.match(scope, /action` to `done`/);
      assert.match(scope, /action` to `scope_done`/);
      assert.match(scope, /action` to `blocked`/);
      assert.match(scope, /Use action=`split_plan` only when the current scope result should be discarded/);
      assert.match(scope, /Treat action=`blocked` as a last resort, not an early exit/);
      assert.doesNotMatch(scope, /The final line of your response must still be the terminal marker/);
      assert.match(scope, /## Execution Shape/);

      const planning = buildPlanningPrompt('/tmp/PLAN.md');
      assert.match(planning, /p-guidance/);
      assert.match(planning, /Return only a structured planning envelope/);
      assert.match(planning, /`action`: `ready_for_review`/);
      assert.match(planning, /Do not use terminal marker lines for this primary planning response/);
      assert.match(planning, /## Execution Shape/);
    },
  );
});

test('over-cap guidance is truncated at render time with an explicit marker', () => {
  const head = 'HEAD-OF-GUIDANCE '.repeat(4);
  const body = `${head}${'g'.repeat(USER_GUIDANCE_MAX_CHARS)}TAIL-BEYOND-CAP`;
  withGuidanceDir(
    (dir) => writeGuidance(dir, 'coder', body),
    () => {
      const prompt = buildScopePrompt('/tmp/PLAN.md', 'progress here');
      assert.match(prompt, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(prompt, /HEAD-OF-GUIDANCE/);
      assert.match(prompt, /\[truncated \d+ character\(s\)\]/);
      assert.doesNotMatch(prompt, /TAIL-BEYOND-CAP/);

      // Diagnostics report the full character count of the file content.
      const entries = collectGuidanceDiagnostics();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].chars, body.length);
    },
  );
});

test('under-cap guidance is inlined without a truncation marker', () => {
  withGuidanceDir(
    (dir) => writeGuidance(dir, 'coder', 'Short guidance.'),
    () => {
      const prompt = buildScopePrompt('/tmp/PLAN.md', 'progress here');
      assert.match(prompt, /Short guidance\./);
      assert.doesNotMatch(prompt, /\[truncated \d+ character\(s\)\]/);
    },
  );
});

test('collectGuidanceDiagnostics reports only roles whose file has meaningful content', () => {
  withGuidanceDir(
    (dir) => {
      writeGuidance(dir, 'coder', 'abc');
      writeGuidance(dir, 'reviewer', '   ');
    },
    () => {
      const entries = collectGuidanceDiagnostics();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].role, 'coder');
      assert.equal(entries[0].bytes, 3);
      assert.ok(entries[0].path.endsWith('coder.md'));
    },
  );
});
