import test from 'node:test';
import assert from 'node:assert/strict';

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
  const prompt = buildReviewFindingsReviewPrompt(context, draft, 2);

  assert.match(prompt, /## Plain Language/);
  for (const rule of REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES) {
    assert.ok(prompt.includes(`- ${rule}`), `review prompt should include rule: ${rule}`);
  }
  assert.match(prompt, /wording that breaks the Plain Language rules below/);
  assert.match(prompt, /Keep accepted finalMarkdown read-only, artifact-ready, and written under the Plain Language rules above\./);
});
