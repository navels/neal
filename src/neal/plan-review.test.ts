import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPlanReviewerPrompt, buildPlanReviewerSchema, buildPlanningPrompt } from './agents.js';
import { renderPlanProgressMarkdown } from './progress.js';
import { renderReviewMarkdown } from './review.js';
import { createInitialState, getDefaultAgentConfig, getSessionStatePath, loadState, saveState } from './state.js';

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
