import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildBlockedRecoveryCoderPrompt,
  buildCoderPlanResponsePrompt,
  buildCoderResponsePrompt,
  buildConsultantPrompt,
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
  buildReviewerPrompt,
} from '../src/neal/agents.js';
import {
  AGENT_FREE_TEXT_SECTION_MAX_CHARS,
  boundChangedFileList,
  boundCommitSubjectList,
  boundFreeTextValues,
  boundOpenFindingsForPrompt,
  CHANGED_FILE_LIST_LIMIT,
  COMMIT_SUBJECT_LIST_LIMIT,
  GIT_SUMMARY_SECTION_MAX_CHARS,
  OPEN_FINDINGS_PROMPT_ITEM_LIMIT,
} from '../src/neal/context/inline-review-context.js';
import { USER_GUIDANCE_MAX_CHARS } from '../src/neal/prompts/guidance.js';
import { clearUserGuidanceCache } from '../src/neal/prompts/guidance.js';
import type { FinalCompletionPacket, FinalCompletionSummary } from '../src/neal/types.js';

// Deterministic renders: no user-guidance file may bleed into these prompts.
process.env.NEAL_GUIDANCE_DIR = join(tmpdir(), 'neal-guidance-prompt-input-bounds-does-not-exist');
clearUserGuidanceCache();

const TRUNCATION_MARKER = /\[truncated \d+ character\(s\)\]/;

const MANY_FILES = Array.from({ length: 500 }, (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`);

function buildPacket(overrides: Partial<FinalCompletionPacket> = {}): FinalCompletionPacket {
  return {
    planDoc: '/tmp/PLAN.md',
    executionShape: 'multi_scope',
    currentScopeLabel: '2',
    finalCommit: 'head000',
    aggregateReviewContext: {
      baseCommit: 'base000',
      headCommit: 'head000',
      range: 'base000..head000',
      commitSubjects: ['head000 subject'],
      diffStat: ' src/example.ts | 2 +-',
      changedFiles: ['src/example.ts'],
      unavailableReason: null,
    },
    completedScopeSummary: '- Scope 1: accepted',
    acceptedScopeCount: 1,
    blockedScopeCount: 0,
    scopeAccounting: {
      acceptedScopeRecords: 1,
      acceptedTopLevelScopeRecords: 1,
      acceptedDerivedSubScopeRecords: 0,
      blockedScopeRecords: 0,
      blockedTopLevelScopeRecords: 0,
      blockedDerivedSubScopeRecords: 0,
      replacedParentScopes: [],
      summary: '1 accepted top-level record',
    },
    scopeAccountingSummary: '1 accepted top-level record',
    verificationOnlyCompletion: false,
    terminalChangedFiles: ['src/example.ts'],
    terminalChangedFilesSummary: 'src/example.ts',
    planChangedFiles: ['src/example.ts'],
    planChangedFilesSummary: 'src/example.ts',
    residualReviewDebt: [],
    residualReviewDebtSummary: 'none',
    verificationTally: {
      totalRuns: 1,
      distinctCommands: 1,
      passed: 1,
      failed: 0,
      unknown: 0,
      recentFailures: [],
    },
    lastNonEmptyImplementationScope: {
      number: '2',
      finalCommit: 'head000',
      commitSubject: 'subject',
      changedFiles: ['src/example.ts'],
      archivedReviewPath: '/tmp/REVIEW-2.md',
    },
    continueExecutionCount: 0,
    continueExecutionMax: 2,
    ...overrides,
  };
}

const COMPLETION_SUMMARY: FinalCompletionSummary = {
  planGoalSatisfied: true,
  whatChangedOverall: 'Implemented the plan.',
  verificationSummary: 'Ran the suite.',
  remainingKnownGaps: [],
};

const SCOPE_REVIEWER_ARGS = {
  planDoc: '/tmp/PLAN.md',
  baseCommit: 'base000',
  headCommit: 'head000',
  commits: ['head000 subject'],
  diffStat: ' src/example.ts | 2 +-',
  changedFiles: ['src/example.ts'],
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

test('boundChangedFileList keeps short lists intact and collapses long lists with an explicit marker', () => {
  assert.deepEqual(boundChangedFileList(['a.ts', 'b.ts']), ['a.ts', 'b.ts']);

  const atLimit = MANY_FILES.slice(0, CHANGED_FILE_LIST_LIMIT);
  assert.deepEqual(boundChangedFileList(atLimit), atLimit);

  const bounded = boundChangedFileList(MANY_FILES);
  assert.equal(bounded.length, CHANGED_FILE_LIST_LIMIT + 1);
  assert.deepEqual(bounded.slice(0, CHANGED_FILE_LIST_LIMIT), MANY_FILES.slice(0, CHANGED_FILE_LIST_LIMIT));
  assert.equal(bounded[CHANGED_FILE_LIST_LIMIT], `(+${MANY_FILES.length - CHANGED_FILE_LIST_LIMIT} more)`);

  assert.deepEqual(boundChangedFileList(['a.ts', 'b.ts', 'c.ts'], 2), ['a.ts', 'b.ts', '(+1 more)']);
});

test('scope reviewer prompt bounds the changed-file list with a (+N more) marker', () => {
  const prompt = buildReviewerPrompt({ ...SCOPE_REVIEWER_ARGS, changedFiles: MANY_FILES });
  assert.match(prompt, /src\/file-019\.ts/);
  assert.match(prompt, /\(\+480 more\)/);
  assert.doesNotMatch(prompt, /src\/file-020\.ts/);
});

function sumRenderedChars(values: readonly string[]): number {
  return values.reduce((total, value) => total + value.length, 0);
}

test('boundFreeTextValues enforces a fixed aggregate bound including truncation markers', () => {
  // 150 values of 10,000 characters each: 75x the budget in raw input.
  const texts = Array.from({ length: 150 }, (_, index) => `VALUE-${index}-${'v'.repeat(10_000)}`);
  const bounded = boundFreeTextValues(texts);

  assert.equal(bounded.length, texts.length);
  // The rendered total, markers included, never exceeds the fixed budget.
  assert.ok(sumRenderedChars(bounded) <= AGENT_FREE_TEXT_SECTION_MAX_CHARS);
  // Positions are preserved and every value keeps its identifying prefix.
  assert.ok(bounded[0]!.startsWith('VALUE-0-'));
  assert.ok(bounded[149]!.startsWith('VALUE-149-'));
  assert.match(bounded[149]!, TRUNCATION_MARKER);

  // The bound is independent of how large the values grow.
  const larger = boundFreeTextValues(texts.map((text) => `${text}${'v'.repeat(90_000)}`));
  assert.ok(sumRenderedChars(larger) <= AGENT_FREE_TEXT_SECTION_MAX_CHARS);

  // Short values render unchanged when everything fits.
  assert.deepEqual(boundFreeTextValues(['a', 'b', 'c']), ['a', 'b', 'c']);

  // Never mutates the input.
  assert.equal(texts[149]!.length, 'VALUE-149-'.length + 10_000);
});

test('boundFreeTextValues validates its finite cardinality precondition', () => {
  assert.throws(
    () => boundFreeTextValues(Array.from({ length: 1_000 }, () => 'x')),
    /Bound the payload's item cardinality before rendering free text/,
  );
});

test('boundOpenFindingsForPrompt preserves control data exactly and bounds only free text', () => {
  const longPath = `src/${'deeply-nested/'.repeat(35)}module.ts`;
  assert.ok(longPath.length > 450);
  const extraFiles = Array.from({ length: 29 }, (_, index) => `src/extra-${String(index).padStart(2, '0')}.ts`);
  const findings = [
    {
      id: 'R1-F1',
      source: 'reviewer' as const,
      claim: 'c'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000),
      requiredAction: 'action',
      severity: 'blocking' as const,
      files: [longPath, ...extraFiles],
      roundSummary: 'summary',
    },
  ];
  const bounded = boundOpenFindingsForPrompt(findings);

  assert.equal(bounded.length, 1);
  const rendered = bounded[0]!;
  // Identity and control fields are copied exactly, however long the path.
  assert.equal(rendered.id, 'R1-F1');
  assert.equal(rendered.source, 'reviewer');
  assert.equal(rendered.severity, 'blocking');
  assert.equal(rendered.files[0], longPath);
  // The files list length is bounded with an explicit marker; each rendered
  // path stays whole.
  assert.equal(rendered.files.length, CHANGED_FILE_LIST_LIMIT + 1);
  assert.equal(rendered.files.at(-1), '(+10 more)');
  // Free text is bounded with a marker; the input keeps its full text.
  assert.match(rendered.claim, TRUNCATION_MARKER);
  assert.equal(findings[0]!.claim.length, AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000);
  assert.equal(findings[0]!.files.length, 30);
});

test('boundOpenFindingsForPrompt rejects more findings than a response round may present', () => {
  const findings = Array.from({ length: OPEN_FINDINGS_PROMPT_ITEM_LIMIT + 1 }, (_, index) => ({
    id: `R1-F${index + 1}`,
    claim: 'claim',
    requiredAction: 'action',
    roundSummary: 'summary',
    files: ['src/example.ts'],
  }));
  assert.throws(
    () => boundOpenFindingsForPrompt(findings),
    /Bound the selection where the response set is chosen/,
  );
});

test('scope reviewer prompt bounds an oversized early justification field and keeps later fields', () => {
  const progressJustification = {
    milestoneTargeted: 'm',
    newEvidence: 'x'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000),
    whyNotRedundant: 'WHY-NOT-REDUNDANT-SENTINEL',
    nextStepUnlocked: 'NEXT-STEP-SENTINEL',
  };
  const prompt = buildReviewerPrompt({ ...SCOPE_REVIEWER_ARGS, progressJustification });

  // The oversized field renders truncated with a marker; every later field
  // still renders; the full oversized text never reaches the prompt.
  assert.match(prompt, TRUNCATION_MARKER);
  assert.ok(!prompt.includes(progressJustification.newEvidence));
  assert.match(prompt, /WHY-NOT-REDUNDANT-SENTINEL/);
  assert.match(prompt, /NEXT-STEP-SENTINEL/);
  // Render-time only: the payload object keeps its full text.
  assert.equal(progressJustification.newEvidence.length, AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000);
});

test('coder response prompts bound oversized finding text without dropping later findings', () => {
  const openFindings = [
    {
      id: 'R1-F1',
      source: 'reviewer' as const,
      claim: 'y'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000),
      requiredAction: 'action',
      severity: 'non_blocking' as const,
      files: ['src/example.ts'],
      roundSummary: 'y'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000),
    },
    {
      id: 'R1-F2',
      source: 'reviewer' as const,
      claim: 'SECOND-FINDING-CLAIM-SENTINEL',
      requiredAction: 'SECOND-FINDING-ACTION-SENTINEL',
      severity: 'blocking' as const,
      files: ['src/later.ts'],
      roundSummary: 'second summary',
    },
  ];
  const renderedSection = JSON.stringify(boundOpenFindingsForPrompt(openFindings), null, 2);

  const executeResponse = buildCoderResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: 'progress',
    verificationHint: 'hint',
    openFindings,
  });
  const planResponse = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings,
  });

  for (const prompt of [executeResponse, planResponse]) {
    // Exact budget-bounded serialization: valid JSON, every finding id and
    // control field present, oversized text truncated with a marker.
    assert.ok(prompt.includes(renderedSection));
    assert.match(prompt, TRUNCATION_MARKER);
    assert.match(prompt, /"R1-F1"/);
    assert.match(prompt, /"R1-F2"/);
    assert.match(prompt, /SECOND-FINDING-CLAIM-SENTINEL/);
    assert.match(prompt, /SECOND-FINDING-ACTION-SENTINEL/);
    assert.match(prompt, /src\/later\.ts/);
  }

  // Render-time only: the findings keep their full text.
  assert.equal(openFindings[0].roundSummary.length, AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000);
});

test('response prompts at the full per-round finding limit render every identity within the free-text bound', () => {
  const openFindings = Array.from({ length: OPEN_FINDINGS_PROMPT_ITEM_LIMIT }, (_, index) => ({
    id: `R1-F${String(index + 1).padStart(4, '0')}`,
    source: 'reviewer' as const,
    claim: `FINDING-${String(index + 1).padStart(4, '0')}-CLAIM-SENTINEL ${'c'.repeat(5_000)}`,
    requiredAction: `FINDING-${String(index + 1).padStart(4, '0')}-ACTION-SENTINEL`,
    severity: 'non_blocking' as const,
    files: [`src/f-${String(index + 1).padStart(4, '0')}.ts`],
    roundSummary: 'shared round summary',
  }));
  const renderedSection = JSON.stringify(boundOpenFindingsForPrompt(openFindings), null, 2);

  const executeResponse = buildCoderResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: 'progress',
    verificationHint: 'hint',
    openFindings,
  });
  const planResponse = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings,
  });

  for (const prompt of [executeResponse, planResponse]) {
    assert.ok(prompt.includes(renderedSection));
    // Every presented finding keeps its exact identity and control data even
    // though the raw free text is 12x the aggregate budget.
    for (let index = 1; index <= OPEN_FINDINGS_PROMPT_ITEM_LIMIT; index += 1) {
      assert.ok(prompt.includes(`"R1-F${String(index).padStart(4, '0')}"`));
    }
    assert.match(prompt, /FINDING-0050-CLAIM-SENTINEL/);
    assert.match(prompt, /FINDING-0050-ACTION-SENTINEL/);
    assert.match(prompt, TRUNCATION_MARKER);
  }
});

test('completion prompts bound the packet changed-file arrays while the packet keeps every path', () => {
  const packet = buildPacket({
    aggregateReviewContext: {
      baseCommit: 'base000',
      headCommit: 'head000',
      range: 'base000..head000',
      commitSubjects: ['head000 subject'],
      diffStat: ' 500 files changed',
      changedFiles: [...MANY_FILES],
      unavailableReason: null,
    },
    lastNonEmptyImplementationScope: {
      number: '2',
      finalCommit: 'head000',
      commitSubject: 'subject',
      changedFiles: [...MANY_FILES],
      archivedReviewPath: '/tmp/REVIEW-2.md',
    },
  });

  const summaryPrompt = buildFinalCompletionSummaryPrompt({ planDoc: '/tmp/PLAN.md', packet });
  const reviewerPrompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
    summary: COMPLETION_SUMMARY,
    scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/final-completion-review',
  });

  for (const prompt of [summaryPrompt, reviewerPrompt]) {
    assert.match(prompt, /src\/file-019\.ts/);
    assert.match(prompt, /\(\+480 more\)/);
    assert.doesNotMatch(prompt, /src\/file-020\.ts/);
  }

  // The packet itself keeps the full arrays for non-prompt consumers.
  assert.equal(packet.aggregateReviewContext.changedFiles.length, 500);
  assert.equal(packet.lastNonEmptyImplementationScope?.changedFiles.length, 500);
});

test('completion reviewer prompt bounds an oversized coder summary field and keeps later fields', () => {
  const summary: FinalCompletionSummary = {
    ...COMPLETION_SUMMARY,
    whatChangedOverall: 'z'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000),
    remainingKnownGaps: ['REMAINING-GAP-SENTINEL'],
  };
  const prompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet: buildPacket(),
    summary,
    scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/final-completion-review',
  });

  // The oversized field renders truncated with a marker; the fields after it
  // still render; the full oversized text never reaches the prompt.
  assert.match(prompt, TRUNCATION_MARKER);
  assert.ok(!prompt.includes(summary.whatChangedOverall));
  assert.match(prompt, /REMAINING-GAP-SENTINEL/);
  // Render-time only: the stored summary keeps its full text.
  assert.equal(summary.whatChangedOverall.length, AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000);
});

const MANY_COMMIT_SUBJECTS = Array.from(
  { length: 500 },
  (_, index) => `sha-${String(index).padStart(3, '0')} subject-${String(index).padStart(3, '0')}`,
);

test('boundCommitSubjectList keeps short lists intact and collapses long lists with an explicit marker', () => {
  assert.deepEqual(boundCommitSubjectList(['sha1 one', 'sha2 two']), ['sha1 one', 'sha2 two']);

  const bounded = boundCommitSubjectList(MANY_COMMIT_SUBJECTS);
  assert.equal(bounded.length, COMMIT_SUBJECT_LIST_LIMIT + 1);
  assert.deepEqual(bounded.slice(0, COMMIT_SUBJECT_LIST_LIMIT), MANY_COMMIT_SUBJECTS.slice(0, COMMIT_SUBJECT_LIST_LIMIT));
  assert.equal(bounded[COMMIT_SUBJECT_LIST_LIMIT], `(+${MANY_COMMIT_SUBJECTS.length - COMMIT_SUBJECT_LIST_LIMIT} more)`);

  // A pathological subject is truncated with a marker instead of rendering whole.
  const pathological = boundCommitSubjectList([`sha0 ${'s'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 5_000)}`]);
  assert.equal(pathological.length, 1);
  assert.match(pathological[0]!, TRUNCATION_MARKER);
});

test('completion prompts bound the aggregate commit subjects, diff stat, and completed-scope summary', () => {
  const oversizedDiffStat = Array.from(
    { length: 2_000 },
    (_, index) => ` src/stat-${String(index).padStart(4, '0')}.ts | 2 +-`,
  ).join('\n');
  const oversizedScopeSummary = Array.from(
    { length: 300 },
    (_, index) => `- Scope ${index + 1}: accepted | blocker: none | SCOPE-${String(index + 1).padStart(4, '0')}-SENTINEL ${'b'.repeat(2_000)}`,
  ).join('\n');
  const packet = buildPacket({
    aggregateReviewContext: {
      baseCommit: 'base000',
      headCommit: 'head000',
      range: 'base000..head000',
      commitSubjects: [...MANY_COMMIT_SUBJECTS],
      diffStat: oversizedDiffStat,
      changedFiles: ['src/example.ts'],
      unavailableReason: null,
    },
    completedScopeSummary: oversizedScopeSummary,
  });
  assert.ok(oversizedDiffStat.length > GIT_SUMMARY_SECTION_MAX_CHARS);
  assert.ok(oversizedScopeSummary.length > AGENT_FREE_TEXT_SECTION_MAX_CHARS);

  const summaryPrompt = buildFinalCompletionSummaryPrompt({ planDoc: '/tmp/PLAN.md', packet });
  const reviewerPrompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
    summary: COMPLETION_SUMMARY,
    scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/final-completion-review',
  });

  for (const prompt of [summaryPrompt, reviewerPrompt]) {
    // Commit subjects: first 20 render, the rest collapse to an explicit marker.
    assert.match(prompt, /subject-019/);
    assert.doesNotMatch(prompt, /subject-020/);
    assert.match(prompt, /\(\+480 more\)/);
    // Diff stat truncates with a marker instead of rendering every line.
    assert.match(prompt, /src\/stat-0000\.ts/);
    assert.ok(!prompt.includes('src/stat-1999.ts'));
    // Completed-scope summary truncates with a marker; early scopes survive.
    assert.match(prompt, /SCOPE-0001-SENTINEL/);
    assert.ok(!prompt.includes('SCOPE-0300-SENTINEL'));
    assert.match(prompt, TRUNCATION_MARKER);
  }

  // The packet keeps the full values for non-prompt consumers.
  assert.equal(packet.aggregateReviewContext.commitSubjects.length, 500);
  assert.equal(packet.aggregateReviewContext.diffStat, oversizedDiffStat);
  assert.equal(packet.completedScopeSummary, oversizedScopeSummary);
});

test('completion prompt size stays bounded as commit subjects, diff-stat entries, and scope summaries double', () => {
  function packetAt(scale: number): FinalCompletionPacket {
    return buildPacket({
      aggregateReviewContext: {
        baseCommit: 'base000',
        headCommit: 'head000',
        range: 'base000..head000',
        commitSubjects: Array.from({ length: 200 * scale }, (_, index) => `sha-${index} fixed-width subject line`),
        diffStat: Array.from({ length: 1_000 * scale }, (_, index) => ` src/s-${index}.ts | 2 +-`).join('\n'),
        changedFiles: Array.from({ length: 200 * scale }, (_, index) => `src/c-${index}.ts`),
        unavailableReason: null,
      },
      completedScopeSummary: Array.from(
        { length: 100 * scale },
        (_, index) => `- Scope ${index + 1}: accepted ${'x'.repeat(1_000)}`,
      ).join('\n'),
      scopeAccountingSummary: `accounting ${'a'.repeat(30_000 * scale)}`,
      lastNonEmptyImplementationScope: {
        number: '5',
        finalCommit: 'head000',
        commitSubject: `subject ${'s'.repeat(30_000 * scale)}`,
        changedFiles: ['src/example.ts'],
        archivedReviewPath: '/tmp/REVIEW-5.md',
      },
    });
  }

  const single = buildFinalCompletionSummaryPrompt({ planDoc: '/tmp/PLAN.md', packet: packetAt(1) });
  const double = buildFinalCompletionSummaryPrompt({ planDoc: '/tmp/PLAN.md', packet: packetAt(2) });

  // Doubling every run-scaling input moves the prompt only by marker digit
  // widths, not by the input growth.
  assert.ok(Math.abs(double.length - single.length) <= 32);
});

test('scope reviewer prompt bounds the commit list, diff stat, and recent-history summary', () => {
  const oversizedDiffStat = Array.from(
    { length: 2_000 },
    (_, index) => ` src/stat-${String(index).padStart(4, '0')}.ts | 2 +-`,
  ).join('\n');
  const oversizedHistory = `HISTORY-HEAD-SENTINEL ${'h'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 50_000)}`;
  const prompt = buildReviewerPrompt({
    ...SCOPE_REVIEWER_ARGS,
    commits: [...MANY_COMMIT_SUBJECTS],
    diffStat: oversizedDiffStat,
    recentHistorySummary: oversizedHistory,
  });

  assert.match(prompt, /subject-019/);
  assert.doesNotMatch(prompt, /subject-020/);
  assert.match(prompt, /\(\+480 more\)/);
  assert.match(prompt, /src\/stat-0000\.ts/);
  assert.ok(!prompt.includes('src/stat-1999.ts'));
  assert.match(prompt, /HISTORY-HEAD-SENTINEL/);
  assert.ok(!prompt.includes(oversizedHistory));
  assert.match(prompt, TRUNCATION_MARKER);
  // Render-time only: the input strings keep their full text.
  assert.equal(oversizedHistory.length, 'HISTORY-HEAD-SENTINEL '.length + AGENT_FREE_TEXT_SECTION_MAX_CHARS + 50_000);
});

test('completion prompts bound the last-scope commit subject and scope-accounting summary', () => {
  const oversizedSubject = `SUBJECT-HEAD-SENTINEL ${'s'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 50_000)}`;
  const oversizedAccounting = `ACCOUNTING-HEAD-SENTINEL ${'a'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 50_000)}`;
  const packet = buildPacket({
    scopeAccountingSummary: oversizedAccounting,
    lastNonEmptyImplementationScope: {
      number: '2',
      finalCommit: 'head000',
      commitSubject: oversizedSubject,
      changedFiles: ['src/example.ts'],
      archivedReviewPath: '/tmp/REVIEW-2.md',
    },
  });

  const summaryPrompt = buildFinalCompletionSummaryPrompt({ planDoc: '/tmp/PLAN.md', packet });
  const reviewerPrompt = buildFinalCompletionReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    packet,
    summary: COMPLETION_SUMMARY,
    scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/final-completion-review',
  });

  for (const prompt of [summaryPrompt, reviewerPrompt]) {
    assert.match(prompt, /SUBJECT-HEAD-SENTINEL/);
    assert.ok(!prompt.includes(oversizedSubject));
    assert.match(prompt, /ACCOUNTING-HEAD-SENTINEL/);
    assert.ok(!prompt.includes(oversizedAccounting));
    assert.match(prompt, TRUNCATION_MARKER);
  }

  // Render-time only: the packet keeps the full values.
  assert.equal(packet.scopeAccountingSummary, oversizedAccounting);
  assert.equal(packet.lastNonEmptyImplementationScope?.commitSubject, oversizedSubject);

  // A null commit subject is preserved, not coerced into a string.
  const nullSubjectPacket = buildPacket({
    lastNonEmptyImplementationScope: {
      number: '2',
      finalCommit: 'head000',
      commitSubject: null,
      changedFiles: ['src/example.ts'],
      archivedReviewPath: '/tmp/REVIEW-2.md',
    },
  });
  const nullSubjectPrompt = buildFinalCompletionSummaryPrompt({ planDoc: '/tmp/PLAN.md', packet: nullSubjectPacket });
  assert.match(nullSubjectPrompt, /"commitSubject": null/);
});

test('plan response prompt bounds oversized plan-review recovery guidance at the operator-guidance cap', () => {
  const planReviewGuidance = {
    message: `GUIDANCE-HEAD-SENTINEL ${'g'.repeat(USER_GUIDANCE_MAX_CHARS + 50_000)}`,
    sourcePhase: 'reviewer_plan' as const,
    recordedAt: '2026-08-25T00:00:00.000Z',
  };
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [],
    planReviewGuidance,
  });

  assert.match(prompt, /GUIDANCE-HEAD-SENTINEL/);
  assert.ok(!prompt.includes(planReviewGuidance.message));
  assert.match(prompt, TRUNCATION_MARKER);
  // Render-time only: the persisted guidance record keeps its full message.
  assert.equal(planReviewGuidance.message.length, 'GUIDANCE-HEAD-SENTINEL '.length + USER_GUIDANCE_MAX_CHARS + 50_000);
});

test('blocked-recovery and consultant prompts bound oversized blocked reasons and operator guidance', () => {
  const blockedReason = `BLOCKED-REASON-SENTINEL ${'r'.repeat(AGENT_FREE_TEXT_SECTION_MAX_CHARS + 50_000)}`;
  const operatorGuidance = `RECOVERY-GUIDANCE-SENTINEL ${'o'.repeat(USER_GUIDANCE_MAX_CHARS + 50_000)}`;

  const recoveryPrompt = buildBlockedRecoveryCoderPrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: 'progress',
    recoveryMarkdownPath: '/tmp/RECOVERY.md',
    blockedReason,
    operatorGuidance,
    maxTurns: 3,
    turnsTaken: 1,
  });
  assert.match(recoveryPrompt, /BLOCKED-REASON-SENTINEL/);
  assert.ok(!recoveryPrompt.includes(blockedReason));
  assert.match(recoveryPrompt, /RECOVERY-GUIDANCE-SENTINEL/);
  assert.ok(!recoveryPrompt.includes(operatorGuidance));
  assert.match(recoveryPrompt, TRUNCATION_MARKER);

  const consultantPrompt = buildConsultantPrompt({
    blockedReason,
    inlineContext: { sections: [] },
  });
  assert.match(consultantPrompt, /BLOCKED-REASON-SENTINEL/);
  assert.ok(!consultantPrompt.includes(blockedReason));
  assert.match(consultantPrompt, TRUNCATION_MARKER);
});

test('remainingKnownGaps sections stay under one constant as the gap count grows', () => {
  // Fixed-width entries so any per-item scaling beyond the item limit would
  // show up as a rendered-size difference.
  function makeSummary(gapCount: number): FinalCompletionSummary {
    return {
      ...COMPLETION_SUMMARY,
      planGoalSatisfied: false,
      remainingKnownGaps: Array.from(
        { length: gapCount },
        (_, index) => `GAP-${String(index + 1).padStart(4, '0')}-SENTINEL ${'g'.repeat(2_000)}`,
      ),
    };
  }

  const buildPrompt = (summary: FinalCompletionSummary) =>
    buildFinalCompletionReviewerPrompt({
      planDoc: '/tmp/PLAN.md',
      packet: buildPacket(),
      summary,
      scratchDir: '/tmp/repo/.neal/runs/run-1/scratch/final-completion-review',
    });

  const oneFifty = buildPrompt(makeSummary(150));
  const threeHundred = buildPrompt(makeSummary(300));

  // Doubling the gaps changes the prompt only by the digit width of the
  // overflow count: the rendered list is pinned by the item limit and the
  // fixed free-text budget.
  assert.ok(Math.abs(threeHundred.length - oneFifty.length) <= 4);

  // The first hundred gaps keep their identifying prefixes; the rest collapse
  // to the explicit overflow entry.
  assert.match(threeHundred, /GAP-0001-SENTINEL/);
  assert.match(threeHundred, /GAP-0100-SENTINEL/);
  assert.ok(!threeHundred.includes('GAP-0101-SENTINEL'));
  assert.ok(threeHundred.includes('(+200 more remaining known gaps omitted from this prompt)'));
  assert.match(threeHundred, TRUNCATION_MARKER);
});
