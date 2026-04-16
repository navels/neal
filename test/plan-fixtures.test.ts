import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preparePlanReviewArtifact, synthesizePlanReviewFindings } from '../src/neal/orchestrator.js';
import { validatePlanDocument } from '../src/neal/plan-validation.js';
import type { ExecutionShape } from '../src/neal/types.js';

type FixtureExpectation = {
  fileName: string;
  expectedShape: ExecutionShape;
};

type NearMissFixtureExpectation = {
  fileName: string;
  expectedOk: boolean;
  expectedNormalizationApplied: boolean;
};

const PLAN_FIXTURES: FixtureExpectation[] = [
  { fileName: 'clear-one-shot.md', expectedShape: 'one_shot' },
  { fileName: 'risky-multi-subsystem.md', expectedShape: 'multi_scope' },
  { fileName: 'ambiguous-but-salvageable.md', expectedShape: 'multi_scope' },
  { fileName: 'already-good-neal-executable.md', expectedShape: 'multi_scope' },
];

const DERIVED_NEAR_MISS_FIXTURES: NearMissFixtureExpectation[] = [
  {
    fileName: 'derived-near-miss-ovation-apps.md',
    expectedOk: true,
    expectedNormalizationApplied: true,
  },
  {
    fileName: 'derived-near-miss-ambiguous.md',
    expectedOk: false,
    expectedNormalizationApplied: true,
  },
];

function getFixturePath(fileName: string) {
  return fileURLToPath(new URL(`./fixtures/plans/execution-shape/${fileName}`, import.meta.url));
}

async function readFixture(fileName: string) {
  return readFile(getFixturePath(fileName), 'utf8');
}

test('fixture plans validate with their expected execution shape', async () => {
  for (const fixture of PLAN_FIXTURES) {
    const planDocument = await readFixture(fixture.fileName);
    const result = validatePlanDocument(planDocument);

    assert.equal(result.ok, true, `fixture ${fixture.fileName} should validate successfully`);
    assert.equal(result.executionShape, fixture.expectedShape);
    assert.deepEqual(result.errors, []);
  }
});

test('fixture plans pass plan-review structural synthesis without synthetic findings', async () => {
  for (const fixture of PLAN_FIXTURES) {
    const planPath = getFixturePath(fixture.fileName);
    const synthesis = await synthesizePlanReviewFindings({
      planPath,
      round: 1,
      roundSummary: `Fixture ${fixture.fileName} remains structurally valid.`,
      findings: [],
    });

    assert.equal(synthesis.executionShape, fixture.expectedShape);
    assert.deepEqual(synthesis.findings, [], `fixture ${fixture.fileName} should not add synthetic findings`);
  }
});

test('already-good fixture keeps reviewer findings intact without structural churn', async () => {
  const planPath = getFixturePath('already-good-neal-executable.md');
  const reviewerFinding = {
    round: 2,
    source: 'reviewer' as const,
    severity: 'non_blocking' as const,
    files: ['test/plan-fixtures.test.ts'],
    claim: 'Consider tightening one verification description.',
    requiredAction: 'Shorten one fixture verification sentence.',
    roundSummary: 'Minor wording suggestion only.',
  };

  const synthesis = await synthesizePlanReviewFindings({
    planPath,
    round: 2,
    roundSummary: reviewerFinding.roundSummary,
    findings: [reviewerFinding],
  });

  assert.equal(synthesis.executionShape, 'multi_scope');
  assert.deepEqual(synthesis.findings, [reviewerFinding]);
});

test('derived near-miss fixtures pin normalization outcomes for real split-plan shapes', async () => {
  for (const fixture of DERIVED_NEAR_MISS_FIXTURES) {
    const planDocument = await readFixture(fixture.fileName);
    const result = validatePlanDocument(planDocument);

    assert.equal(
      result.ok,
      fixture.expectedOk,
      `fixture ${fixture.fileName} should match the expected validation outcome`,
    );
    assert.equal(result.executionShape, 'multi_scope');
    assert.equal(result.normalization.applied, fixture.expectedNormalizationApplied);
  }
});

test('ovation-apps derived near-miss fixture normalizes into the canonical execution queue contract', async () => {
  const result = validatePlanDocument(await readFixture('derived-near-miss-ovation-apps.md'));

  assert.equal(result.ok, true);
  assert.equal(result.normalization.applied, true);
  assert.match(result.normalization.normalizedDocument, /## Execution Queue/);
  assert.match(
    result.normalization.normalizedDocument,
    /### Scope 1: Migrate cartridge-data-inputs to the native base/,
  );
  assert.match(
    result.normalization.normalizedDocument,
    /- Goal: \(Former derived scope 6\.6A\) Move the cartridge-data-inputs implementation into the native base layer while preserving the current data contract\./,
  );
  assert.match(
    result.normalization.normalizedDocument,
    /- Verification: `pnpm typecheck`; `pnpm exec tsx --test test\/orchestrator\.test\.ts`/,
  );
  assert.deepEqual(result.normalization.scopeLabelMappings, [
    { normalizedScopeNumber: 1, originalScopeLabel: '6.6A' },
    { normalizedScopeNumber: 2, originalScopeLabel: '6.6B' },
  ]);
});

test('derived near-miss fixtures stay aligned with plan-review synthesis behavior', async () => {
  const acceptedPlanPath = getFixturePath('derived-near-miss-ovation-apps.md');
  const acceptedSynthesis = await synthesizePlanReviewFindings({
    planPath: acceptedPlanPath,
    round: 1,
    roundSummary: 'Normalized near-miss plan remains executable.',
    findings: [],
  });

  assert.equal(acceptedSynthesis.executionShape, 'multi_scope');
  assert.equal(acceptedSynthesis.reviewedPlanPath, acceptedPlanPath);
  assert.deepEqual(acceptedSynthesis.findings, []);

  const rejectedPlanPath = getFixturePath('derived-near-miss-ambiguous.md');
  const rejectedSynthesis = await synthesizePlanReviewFindings({
    planPath: rejectedPlanPath,
    round: 1,
    roundSummary: 'Ambiguous near-miss plan remains structurally invalid.',
    findings: [],
  });

  assert.equal(rejectedSynthesis.executionShape, 'multi_scope');
  assert.equal(rejectedSynthesis.reviewedPlanPath, rejectedPlanPath);
  assert.ok(rejectedSynthesis.findings.length >= 1);
  assert.ok(
    rejectedSynthesis.findings.every((finding) => finding.source === 'plan_structure' && finding.severity === 'blocking'),
  );
  assert.match(
    rejectedSynthesis.findings.map((finding) => finding.claim).join('\n'),
    /must contain at least one `### Scope N:` entry|contains content before the first scope entry/,
  );
});

test('plan review persists a normalized derivative artifact and marks it as the reviewed artifact', async () => {
  const planPath = getFixturePath('derived-near-miss-ovation-apps.md');
  const runDir = await mkdtemp(join(tmpdir(), 'neal-plan-review-artifact-'));
  const normalizedPlanPath = join(runDir, `${basename(planPath, '.md')}.normalized.md`);
  const preparedReview = await preparePlanReviewArtifact({
    planPath,
    normalizedPlanPath,
  });

  assert.equal(preparedReview.reviewedPlanPath, normalizedPlanPath);
  const normalizedDocument = await readFile(normalizedPlanPath, 'utf8');
  assert.match(normalizedDocument, /## Execution Queue/);
  assert.match(normalizedDocument, /### Scope 1: Migrate cartridge-data-inputs to the native base/);

  const synthesis = await synthesizePlanReviewFindings({
    planPath,
    round: 1,
    roundSummary: 'Normalized near-miss plan remains executable.',
    findings: [],
    preparedReview,
  });

  assert.equal(synthesis.reviewedPlanPath, normalizedPlanPath);
  assert.deepEqual(synthesis.findings, []);
});

test('structural findings still point back to the original plan when a normalized derivative remains invalid', async () => {
  const planPath = getFixturePath('derived-near-miss-ambiguous.md');
  const runDir = await mkdtemp(join(tmpdir(), 'neal-plan-review-artifact-'));
  const normalizedPlanPath = join(runDir, `${basename(planPath, '.md')}.normalized.md`);
  const preparedReview = await preparePlanReviewArtifact({
    planPath,
    normalizedPlanPath,
  });

  assert.equal(preparedReview.reviewedPlanPath, normalizedPlanPath);

  const synthesis = await synthesizePlanReviewFindings({
    planPath,
    round: 2,
    roundSummary: 'Ambiguous normalized artifact still fails the contract.',
    findings: [],
    preparedReview,
  });

  assert.equal(synthesis.reviewedPlanPath, normalizedPlanPath);
  assert.ok(synthesis.findings.length >= 1);
  assert.ok(synthesis.findings.every((finding) => finding.files[0] === planPath));
});
