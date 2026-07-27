import test from 'node:test';
import assert from 'node:assert/strict';

import { validateReviewFindingsReview } from '../src/neal/review-findings/provider.js';

function accepted(finalMarkdown: string) {
  return { verdict: 'accepted', findings: [], warnings: [], finalMarkdown };
}

test('accepted review payload allows benign passive descriptions of the reviewed change', () => {
  // A read-only reviewer legitimately describes the coder's diff in passive voice.
  // These must NOT be flagged as mutation/repair-commit wording (the prior `(fix)
  // (was|has|applied|…)` pattern false-positived on them, failing capable models).
  for (const md of [
    'Accepted. The fix was applied to src/add.js and `node --test` passes.',
    'The fix has been verified — the broken assertion is gone.',
    'Looks correct: the repair was clean and all tests pass.',
    'The change correctly switches `a - b` to `a + b`; accepted.',
  ]) {
    assert.doesNotThrow(
      () => validateReviewFindingsReview(accepted(md)),
      `should accept benign passive description: ${md}`,
    );
  }
});

test('accepted review payload rejects first-person mutation claims and mutating commands', () => {
  for (const md of [
    'I applied the fix and it passes.', // #1 first-person agency
    'We made the change to src/add.js.', // #1 first-person agency
    'I have created an additive fix commit.', // #1 + #2
    'committed the fix and re-ran the tests.', // #3
    'Run `git commit` to land this.', // #4
    'Then run neal execute to finish.', // #5
  ]) {
    assert.throws(
      () => validateReviewFindingsReview(accepted(md)),
      /mutation or repair-commit wording/,
      `should reject self-attribution / mutating command: ${md}`,
    );
  }
});
