import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCoderPlanResponsePrompt,
  buildCoderResponsePrompt,
  buildPlanReviewerPrompt,
  buildPlanReviewerSchema,
  buildPlanningPrompt,
  buildScopePrompt,
} from '../src/neal/agents.js';
import { synthesizePlanReviewFindings } from '../src/neal/orchestrator.js';
import { renderPlanProgressMarkdown } from '../src/neal/progress.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { createInitialState, getDefaultAgentConfig, getSessionStatePath, loadState, saveState } from '../src/neal/state.js';

function hasTopLevelRequiredProperty(schema: ReturnType<typeof buildPlanReviewerSchema>, key: string) {
  return Array.isArray(schema.required) && schema.required.includes(key);
}

test('planning prompt requires an explicit execution-shape declaration', () => {
  const prompt = buildPlanningPrompt('/tmp/PLAN.md');

  assert.match(prompt, /Choose exactly one execution shape: `one_shot` or `multi_scope`\./);
  assert.match(prompt, /Declare that choice in the plan document with a literal `## Execution Shape` section/);
  assert.match(prompt, /executionShape: one_shot/);
  assert.match(prompt, /executionShape: multi_scope/);
});

test('derived-plan prompts require the same canonical Neal-executable contract', () => {
  const scopePrompt = buildScopePrompt('/tmp/PLAN.md', 'Current scope: 1');
  const coderResponsePrompt = buildCoderResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    progressText: 'Current scope: 1',
    verificationHint: 'Run targeted verification.',
    openFindings: [],
  });
  const planResponsePrompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/DERIVED_PLAN.md',
    openFindings: [],
    reviewMode: 'derived-plan',
    parentPlanDoc: '/tmp/PLAN.md',
    derivedFromScopeNumber: 3,
  });
  const reviewerPrompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/DERIVED_PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    mode: 'derived-plan',
    parentPlanDoc: '/tmp/PLAN.md',
    derivedFromScopeNumber: 3,
  });

  for (const prompt of [scopePrompt, coderResponsePrompt, planResponsePrompt]) {
    assert.match(prompt, /same Neal-executable contract as a top-level plan/);
    assert.match(prompt, /## Execution Shape/);
    assert.match(prompt, /executionShape: multi_scope/);
    assert.match(prompt, /## Execution Queue/);
    assert.match(prompt, /### Scope 1: Example scope/);
    assert.doesNotMatch(prompt, /Ordered Derived Scopes/);
  }

  assert.match(reviewerPrompt, /same canonical `## Execution Shape` \/ `## Execution Queue` contract as a top-level plan/);
  assert.match(reviewerPrompt, /canonical Neal-executable plan shape/);
});

test('plan reviewer schema and prompt require executionShape confirmation', () => {
  const schema = buildPlanReviewerSchema();
  const prompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  });

  assert.equal(hasTopLevelRequiredProperty(schema, 'executionShape'), true);
  assert.deepEqual(schema.properties.executionShape.enum, ['one_shot', 'multi_scope']);
  assert.equal(hasTopLevelRequiredProperty(schema, 'summary'), true);
  assert.equal(hasTopLevelRequiredProperty(schema, 'findings'), true);
  assert.equal(hasTopLevelRequiredProperty(schema, 'missingKey'), false);
  assert.match(prompt, /must declare exactly one execution shape/);
  assert.match(prompt, /echo it in the required `executionShape` field/);
});

test('executionShape persists through state round-trip and wrapper artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const statePath = getSessionStatePath(stateDir);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'plan',
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  await saveState(statePath, {
    ...initialState,
    executionShape: 'multi_scope',
  });

  const loaded = await loadState(statePath);

  assert.equal(loaded.executionShape, 'multi_scope');
  assert.match(renderPlanProgressMarkdown(loaded), /- Execution shape: multi_scope/);
  assert.match(renderReviewMarkdown(loaded), /- Execution shape: multi_scope/);
});

test('plan-review synthesis appends structural failures as blocking findings with a distinct source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const planDoc = join(root, 'PLAN.md');

  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: multi_scope
`,
    'utf8',
  );

  const synthesis = await synthesizePlanReviewFindings({
    planPath: planDoc,
    round: 2,
    roundSummary: 'Reviewer found one clarity issue.',
    findings: [
      {
        round: 2,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/agents.ts'],
        claim: 'Clarify one reviewer prompt sentence.',
        requiredAction: 'Tighten the prompt wording.',
        roundSummary: 'Reviewer found one clarity issue.',
      },
    ],
  });

  assert.equal(synthesis.executionShape, 'multi_scope');
  assert.equal(synthesis.reviewedPlanPath, planDoc);
  assert.equal(synthesis.findings.length, 2);
  assert.deepEqual(synthesis.findings[0], {
    round: 2,
    source: 'reviewer',
    severity: 'non_blocking',
    files: ['src/neal/agents.ts'],
    claim: 'Clarify one reviewer prompt sentence.',
    requiredAction: 'Tighten the prompt wording.',
    roundSummary: 'Reviewer found one clarity issue.',
  });
  assert.equal(synthesis.findings[1]?.round, 2);
  assert.equal(synthesis.findings[1]?.source, 'plan_structure');
  assert.equal(synthesis.findings[1]?.severity, 'blocking');
  assert.deepEqual(synthesis.findings[1]?.files, [planDoc]);
  assert.match(synthesis.findings[1]?.claim ?? '', /Plan document structure is invalid/);
  assert.match(synthesis.findings[1]?.claim ?? '', /requires a `## Execution Queue` section/);
  assert.equal(synthesis.findings[1]?.roundSummary, 'Reviewer found one clarity issue.');
});

test('plan-review synthesis leaves valid plans without synthetic findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const planDoc = join(root, 'PLAN.md');

  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: one_shot
`,
    'utf8',
  );

  const synthesis = await synthesizePlanReviewFindings({
    planPath: planDoc,
    round: 1,
    roundSummary: 'Looks good.',
    findings: [],
  });

  assert.equal(synthesis.executionShape, 'one_shot');
  assert.equal(synthesis.reviewedPlanPath, planDoc);
  assert.deepEqual(synthesis.findings, []);
});

test('plan-review synthesis uses document-declared execution shape as the source of truth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const planDoc = join(root, 'PLAN.md');

  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Add validation
- Goal: Add the validator.
- Verification: \`pnpm typecheck\`
- Success Condition: The validator works.
`,
    'utf8',
  );

  const synthesis = await synthesizePlanReviewFindings({
    planPath: planDoc,
    round: 1,
    roundSummary: 'Looks good.',
    findings: [],
  });

  assert.equal(synthesis.executionShape, 'multi_scope');
  assert.equal(synthesis.reviewedPlanPath, planDoc);
  assert.deepEqual(synthesis.findings, []);
});
