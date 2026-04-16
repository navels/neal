import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { synthesizePlanReviewFindings } from './orchestrator.js';
import { validatePlanDocument } from './plan-validation.js';
import type { ExecutionShape } from './types.js';

type FixtureExpectation = {
  fileName: string;
  expectedShape: ExecutionShape;
};

const PLAN_FIXTURES: FixtureExpectation[] = [
  { fileName: 'clear-one-shot.md', expectedShape: 'one_shot' },
  { fileName: 'risky-multi-subsystem.md', expectedShape: 'multi_scope' },
  { fileName: 'ambiguous-but-salvageable.md', expectedShape: 'multi_scope' },
  { fileName: 'already-good-neal-executable.md', expectedShape: 'multi_scope' },
];

function getFixturePath(fileName: string) {
  return fileURLToPath(new URL(`./test-fixtures/execution-shape/${fileName}`, import.meta.url));
}

async function readFixture(fileName: string) {
  return readFile(getFixturePath(fileName), 'utf8');
}

test('fixture plans validate with their expected execution shape', async () => {
  for (const fixture of PLAN_FIXTURES) {
    const planDocument = await readFixture(fixture.fileName);
    const result = validatePlanDocument(planDocument);

    assert.deepEqual(
      result,
      {
        ok: true,
        executionShape: fixture.expectedShape,
        errors: [],
      },
      `fixture ${fixture.fileName} should validate as ${fixture.expectedShape}`,
    );
  }
});

test('fixture plans pass plan-review structural synthesis without synthetic findings', async () => {
  for (const fixture of PLAN_FIXTURES) {
    const planPath = getFixturePath(fixture.fileName);
    const findings = await synthesizePlanReviewFindings({
      planPath,
      round: 1,
      roundSummary: `Fixture ${fixture.fileName} remains structurally valid.`,
      findings: [],
    });

    assert.deepEqual(findings, [], `fixture ${fixture.fileName} should not add synthetic findings`);
  }
});

test('already-good fixture keeps reviewer findings intact without structural churn', async () => {
  const planPath = getFixturePath('already-good-neal-executable.md');
  const reviewerFinding = {
    round: 2,
    source: 'reviewer' as const,
    severity: 'non_blocking' as const,
    files: ['src/neal/plan-fixtures.test.ts'],
    claim: 'Consider tightening one verification description.',
    requiredAction: 'Shorten one fixture verification sentence.',
    roundSummary: 'Minor wording suggestion only.',
  };

  const findings = await synthesizePlanReviewFindings({
    planPath,
    round: 2,
    roundSummary: reviewerFinding.roundSummary,
    findings: [reviewerFinding],
  });

  assert.deepEqual(findings, [reviewerFinding]);
});
