import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderReviewerEvalReport,
  scoreReviewerEval,
  toReviewerEvalObservation,
  type ReviewerEvalFixture,
  type ReviewerEvalObservation,
} from '../src/neal/eval/reviewer-eval.js';

test('toReviewerEvalObservation coerces unknown severities to non_blocking and missing files to empty', () => {
  const observation = toReviewerEvalObservation('fx', [
    { severity: 'blocking', files: ['src/a.ts', 42] },
    { severity: 'weird', files: ['src/b.ts'] },
    { severity: 'non_blocking' },
  ]);
  assert.equal(observation.fixtureId, 'fx');
  assert.deepEqual(observation.findings, [
    { severity: 'blocking', files: ['src/a.ts'] },
    { severity: 'non_blocking', files: ['src/b.ts'] },
    { severity: 'non_blocking', files: [] },
  ]);
});

const DEFECTIVE: ReviewerEvalFixture = {
  id: 'off-by-one',
  kind: 'defective',
  expectedFindings: [{ file: 'src/paginate.ts', defectClass: 'off-by-one', description: 'loop overruns by one' }],
};

const DEFECTIVE_TWO_LABELS: ReviewerEvalFixture = {
  id: 'two-defects',
  kind: 'defective',
  expectedFindings: [
    { file: 'src/a.ts', defectClass: 'null-deref', description: 'unchecked null' },
    { file: 'src/b.ts', defectClass: 'race', description: 'unsynchronized write' },
  ],
};

const CLEAN: ReviewerEvalFixture = {
  id: 'clean-rename',
  kind: 'clean',
  expectedFindings: [],
};

test('perfect recall and precision when the reviewer flags exactly the labeled file', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE],
    [{ fixtureId: 'off-by-one', findings: [{ severity: 'blocking', files: ['src/paginate.ts'] }] }],
  );
  assert.equal(report.recall, 1);
  assert.equal(report.precision, 1);
  assert.equal(report.matchedLabels, 1);
  assert.equal(report.falsePositiveFindings, 0);
  assert.equal(report.fixtures[0].missedLabels.length, 0);
});

test('a miss lowers recall but not precision', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE_TWO_LABELS],
    [{ fixtureId: 'two-defects', findings: [{ severity: 'blocking', files: ['src/a.ts'] }] }],
  );
  assert.equal(report.recall, 0.5);
  assert.equal(report.precision, 1);
  assert.equal(report.matchedLabels, 1);
  assert.equal(report.totalExpectedLabels, 2);
  assert.deepEqual(
    report.fixtures[0].missedLabels.map((label) => label.file),
    ['src/b.ts'],
  );
});

test('a blocking finding on a clean fixture is a false positive that lowers precision', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE, CLEAN],
    [
      { fixtureId: 'off-by-one', findings: [{ severity: 'blocking', files: ['src/paginate.ts'] }] },
      { fixtureId: 'clean-rename', findings: [{ severity: 'blocking', files: ['src/renamed.ts'] }] },
    ],
  );
  assert.equal(report.recall, 1);
  // 1 true positive, 1 false positive => precision 0.5.
  assert.equal(report.precision, 0.5);
  assert.equal(report.cleanFalsePositiveRate, 1);
  assert.equal(report.cleanFixturesFlagged, 1);
  assert.equal(report.falsePositiveFindings, 1);
});

test('non_blocking findings do not count toward recall, precision, or clean false positives', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE, CLEAN],
    [
      { fixtureId: 'off-by-one', findings: [{ severity: 'non_blocking', files: ['src/paginate.ts'] }] },
      { fixtureId: 'clean-rename', findings: [{ severity: 'non_blocking', files: ['src/renamed.ts'] }] },
    ],
  );
  // The defect's file was only flagged non-blocking, so the label is missed.
  assert.equal(report.recall, 0);
  // No blocking findings anywhere => precision is not defined.
  assert.equal(report.precision, null);
  assert.equal(report.totalBlockingFindings, 0);
  assert.equal(report.cleanFalsePositiveRate, 0);
  assert.equal(report.cleanFixturesFlagged, 0);
});

test('recall is null when there are no defective fixtures and precision null when no blocking findings', () => {
  const report = scoreReviewerEval(
    [CLEAN],
    [{ fixtureId: 'clean-rename', findings: [] }],
  );
  assert.equal(report.recall, null);
  assert.equal(report.precision, null);
  assert.equal(report.cleanFalsePositiveRate, 0);
  assert.equal(report.blockingFindingRate, 0);
});

test('file matching normalizes leading ./ and backslashes', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE],
    [{ fixtureId: 'off-by-one', findings: [{ severity: 'blocking', files: ['./src/paginate.ts'] }] }],
  );
  assert.equal(report.recall, 1);
});

test('a missing observation throws rather than counting as perfect recall', () => {
  assert.throws(
    () => scoreReviewerEval([DEFECTIVE], []),
    /no observation for fixture off-by-one/,
  );
});

test('blocking finding rate averages across all fixtures', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE, CLEAN],
    [
      {
        fixtureId: 'off-by-one',
        findings: [
          { severity: 'blocking', files: ['src/paginate.ts'] },
          { severity: 'blocking', files: ['src/paginate.ts'] },
        ],
      },
      { fixtureId: 'clean-rename', findings: [] },
    ],
  );
  assert.equal(report.blockingFindingRate, 1);
});

test('renderReviewerEvalReport produces a table and a summary line', () => {
  const report = scoreReviewerEval(
    [DEFECTIVE, CLEAN],
    [
      { fixtureId: 'off-by-one', findings: [{ severity: 'blocking', files: ['src/paginate.ts'] }] },
      { fixtureId: 'clean-rename', findings: [] },
    ],
  );
  const rendered = renderReviewerEvalReport(report);
  assert.match(rendered, /\| Fixture \| Kind \| Labels hit \| Blocking \| False\+ \|/);
  assert.match(rendered, /off-by-one \| defective \| 1\/1/);
  assert.match(rendered, /Recall 100\.0%/);
  assert.match(rendered, /Precision 100\.0%/);
});
