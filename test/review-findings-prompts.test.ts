import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getRangeDiffArtifactLines } from '../src/neal/prompts/review-doctrine.js';

import {
  REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES,
  buildReviewFindingsDraftPrompt,
  buildReviewFindingsReviewPrompt,
} from '../src/neal/review-findings/prompts.js';
import type { ReviewFindingsContext, ReviewFindingsDraft } from '../src/neal/review-findings/types.js';

const context: ReviewFindingsContext = {
  version: 1,
  instruction: 'Review the selected committed range for regressions.',
  instructionSource: 'default',
  selector: { kind: 'last', count: 1 },
  baseRef: 'HEAD~1',
  headRef: 'HEAD',
  externalBaseCommit: 'base123',
  externalHeadCommit: 'head456',
  externalCommits: ['head456'],
  externalCommitSubjects: ['head456 scope commit'],
  externalChangedFiles: ['feature.ts'],
  diffStat: ' feature.ts | 1 +',
  diff: 'diff --git a/feature.ts b/feature.ts\n+export const added = 1;\n',
};

const draft: ReviewFindingsDraft = {
  summary: 'Draft summary.',
  findings: [
    {
      severity: 'non_blocking',
      files: ['feature.ts'],
      claim: 'The helper drops its error path.',
      evidence: 'The helper swallows its catch block.',
      requiredAction: 'Re-raise or report the swallowed error.',
    },
  ],
  warnings: [],
};

// The accepted artifact is read by a human outside the review, so the draft
// fields and the reviewer's finalMarkdown both carry the plain-language rules.
test('review-findings draft prompt carries the plain-language rules and applies them to every human-read field', () => {
  const prompt = buildReviewFindingsDraftPrompt(context, { round: 1, maxRounds: 3 });

  assert.match(prompt, /## Plain Language/);
  for (const rule of REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES) {
    assert.ok(prompt.includes(`- ${rule}`), `draft prompt should include rule: ${rule}`);
  }
  assert.match(
    prompt,
    /Write the summary, every claim, evidence, requiredAction, and warning under the Plain Language rules above\./,
  );
  // Precision guard stays explicit so plain wording is never read as permission to drop facts.
  assert.match(prompt, /Keep exact file paths, identifiers, numbers, commit SHAs, and command names\./);
});

test('review-findings review prompt treats plain-language violations as a revise reason and binds finalMarkdown to the rules', () => {
  const prompt = buildReviewFindingsReviewPrompt(context, draft, '.neal/reviews/example/range-diff/index.md', 2);

  assert.match(prompt, /## Plain Language/);
  for (const rule of REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES) {
    assert.ok(prompt.includes(`- ${rule}`), `review prompt should include rule: ${rule}`);
  }
  assert.match(prompt, /wording that breaks the Plain Language rules below/);
  assert.match(prompt, /Keep accepted finalMarkdown read-only, artifact-ready, and written under the Plain Language rules above\./);
});

// Captured before the file-delivery change: short, truncated, and empty diffs,
// each on the first draft and a revision draft.
test('review-findings draft prompt bytes remain unchanged', () => {
  const expected = [
    'd0bd97ab2268b217f434c7b3ddd8d8a9ce79769825908156617054cfafcc10fd',
    'fa4c8c513535128949c97ea228261254b120ed3fef98329052563e911beaffd2',
    '99bd0b26accb811bb77b6bb66f6cb934a0e0d94cbfad34595d9916b830728c28',
    '4b411dcdec1e4efd2d055f62bab52e09260f6313df45372e7311833f76d78399',
    '9a34e5a596d5eda1de1a6dbc00575767ac8879c26e5cb6e0900e482ee25b7b48',
    'b05ad473774a35ae0c996446aabb090654260c9536d44f34197c1b64241b8f3e',
  ];
  const actual = [];
  for (const diff of [context.diff, '+x\n'.repeat(8000), '']) {
    for (const options of [{}, { round: 2, maxRounds: 3, previousDraft: draft, reviewFindings: ['Explain the error path.'] }]) {
      actual.push(createHash('sha256').update(buildReviewFindingsDraftPrompt({ ...context, diff }, options)).digest('hex'));
    }
  }
  assert.deepEqual(actual, expected);
});

test('review-findings adjudication uses shared artifact wording without a diff preview for any diff size', () => {
  const indexPath = '.neal/reviews/example/range-diff/index.md';
  for (const diff of [context.diff, `${context.diff}${'+large patch sentinel\n'.repeat(60000)}`, '']) {
    const prompt = buildReviewFindingsReviewPrompt({ ...context, diff }, draft, indexPath);
    assert.ok(prompt.includes(getRangeDiffArtifactLines({ indexPath }).join('\n')));
    assert.match(prompt, /absence from a diff hunk is not evidence of absence from the repository/);
    assert.doesNotMatch(prompt, /Diff preview:|diff --git|export const added|large patch sentinel|diff truncated|git_diff|git diff/);
    assert.doesNotMatch(prompt, /## Inlined Selected-Range Diff|## Read-Only Range Inspection/);
  }
});
