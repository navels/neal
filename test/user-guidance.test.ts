import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCoderPlanResponsePrompt,
  buildCoderResponsePrompt,
  buildFinalCompletionReviewerPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
  buildReviewerPrompt,
  buildScopePrompt,
} from '../src/neal/agents.js';
import { AUTONOMY_BLOCKED, AUTONOMY_DONE, AUTONOMY_SCOPE_DONE } from '../src/neal/prompts/shared.js';
import {
  clearUserGuidanceCache,
  collectGuidanceDiagnostics,
  GUIDANCE_SECTION_HEADER,
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
    completedScopeSummary: [],
    terminalChangedFilesSummary: [],
    planChangedFilesSummary: [],
    verificationSummary: [],
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
} as unknown as Parameters<typeof buildFinalCompletionReviewerPrompt>[0];

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

test('missing guidance files leave the prompt unchanged and completion markers present', () => {
  withGuidanceDir(
    () => {
      // intentionally empty directory
    },
    () => {
      const scope = buildScopePrompt('/tmp/PLAN.md', 'progress');
      assert.doesNotMatch(scope, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(scope, new RegExp(AUTONOMY_SCOPE_DONE));
      assert.match(scope, new RegExp(AUTONOMY_DONE));

      const planning = buildPlanningPrompt('/tmp/PLAN.md');
      assert.doesNotMatch(planning, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(planning, new RegExp(AUTONOMY_DONE));
      assert.match(planning, new RegExp(AUTONOMY_BLOCKED));

      const reviewer = buildReviewerPrompt(SCOPE_REVIEWER_ARGS);
      assert.doesNotMatch(reviewer, new RegExp(GUIDANCE_SECTION_HEADER));
      assert.match(reviewer, /meaningfulProgressAction/);
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

test('guidance is additive: completion markers and contract still present after injection', () => {
  withGuidanceDir(
    (dir) => {
      writeGuidance(dir, 'coder', 'c-guidance');
      writeGuidance(dir, 'planner', 'p-guidance');
    },
    () => {
      const scope = buildScopePrompt('/tmp/PLAN.md', 'progress');
      assert.match(scope, /c-guidance/);
      assert.match(scope, new RegExp(`- ${AUTONOMY_SCOPE_DONE}`));
      assert.match(scope, new RegExp(`- ${AUTONOMY_DONE}`));
      assert.match(scope, new RegExp(`- ${AUTONOMY_BLOCKED}`));
      assert.match(scope, /## Execution Shape/);

      const planning = buildPlanningPrompt('/tmp/PLAN.md');
      assert.match(planning, /p-guidance/);
      assert.match(planning, new RegExp(`- ${AUTONOMY_DONE}`));
      assert.match(planning, new RegExp(`- ${AUTONOMY_BLOCKED}`));
      assert.match(planning, /## Execution Shape/);
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
