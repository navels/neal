import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSquashMessage,
  repairReviewerSquashMessageDraft,
  validateReviewerSquashMessageDraft,
} from '../src/neal/squash-message.js';

test('squashCommitMessage validator normalizes reviewer drafts', () => {
  const draft = validateReviewerSquashMessageDraft({
    subject: '  Scope 3: Persist semantic commit drafts  ',
    bullets: [
      '- Store project-facing squash summaries in completion state.',
      '2. Render the accepted draft in final completion artifacts.',
    ],
  });

  assert.deepEqual(draft, {
    subject: 'Persist semantic commit drafts',
    bullets: [
      'Store project-facing squash summaries in completion state.',
      'Render the accepted draft in final completion artifacts.',
    ],
  });
  assert.equal(
    formatSquashMessage(draft),
    [
      'Persist semantic commit drafts',
      '',
      '- Store project-facing squash summaries in completion state.',
      '- Render the accepted draft in final completion artifacts.',
    ].join('\n'),
  );
});

test('squashCommitMessage validator rejects path-like and mechanical drafts', () => {
  assert.throws(
    () =>
      validateReviewerSquashMessageDraft({
        subject: 'Implement tmp/PLAN.md',
        bullets: [
          'Store project-facing squash summaries in completion state.',
          'Render the accepted draft in final completion artifacts.',
        ],
      }),
    /tmp\/ paths/,
  );

  assert.throws(
    () =>
      validateReviewerSquashMessageDraft({
        subject: 'Persist semantic commit drafts',
        bullets: [
          'Store project-facing squash summaries in completion state.',
          'store project-facing squash summaries in completion state.',
        ],
      }),
    /duplicates an earlier bullet/,
  );

  assert.throws(
    () =>
      validateReviewerSquashMessageDraft({
        subject: 'Final cleanup',
        bullets: [
          'Store project-facing squash summaries in completion state.',
          'Render the accepted draft in final completion artifacts.',
        ],
      }),
    /mechanical cleanup/,
  );
});

test('squashCommitMessage repair removes temporary markdown path references', () => {
  const draft = repairReviewerSquashMessageDraft({
    subject: 'Repair final completion squash metadata',
    bullets: [
      '1. Keep project-facing reviewer summaries from `tmp/16_NEAL_FINAL_COMPLETION_SQUASH_RECOVERY_PLAN.md`.',
      '2. Preserve deterministic fallback behavior for accepted null drafts.',
      '3. Render repaired squash metadata in Git history.',
    ],
  });

  assert.deepEqual(draft, {
    subject: 'Repair final completion squash metadata',
    bullets: [
      'Keep project-facing reviewer summaries',
      'Preserve deterministic fallback behavior for accepted null drafts',
      'Render repaired squash metadata in Git history',
    ],
  });
});

test('squashCommitMessage repair collapses duplicate repaired bullets', () => {
  const draft = repairReviewerSquashMessageDraft({
    subject: 'Repair final completion squash metadata',
    bullets: [
      'Store semantic squash summaries in completion state.',
      'store semantic squash summaries in completion state.',
      'Render accepted drafts in final completion artifacts.',
    ],
  });

  assert.deepEqual(draft, {
    subject: 'Repair final completion squash metadata',
    bullets: [
      'Store semantic squash summaries in completion state',
      'Render accepted drafts in final completion artifacts',
    ],
  });
});

test('squashCommitMessage repair rejects drafts with fewer than two useful bullets', () => {
  assert.equal(
    repairReviewerSquashMessageDraft({
      subject: 'Repair final completion squash metadata',
      bullets: [
        'Store semantic squash summaries in completion state.',
        'Complete tmp/16_NEAL_FINAL_COMPLETION_SQUASH_RECOVERY_PLAN.md',
      ],
    }),
    null,
  );
});

test('squashCommitMessage repair rejects wrapper subjects around removed markdown paths', () => {
  assert.equal(
    repairReviewerSquashMessageDraft({
      subject: 'Complete tmp/16_NEAL_FINAL_COMPLETION_SQUASH_RECOVERY_PLAN.md',
      bullets: [
        'Store semantic squash summaries in completion state.',
        'Render accepted drafts in final completion artifacts.',
      ],
    }),
    null,
  );
});
