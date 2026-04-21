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
  assert.match(prompt, /Choose `multi_scope` when the work changes orchestration or state-machine behavior/);
  assert.match(prompt, /Choose `one_shot` only when the work can realistically be executed, reviewed, and verified as one bounded scope/);
  assert.match(prompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assert.match(prompt, /Never write AUTONOMY_DONE, AUTONOMY_BLOCKED, AUTONOMY_SCOPE_DONE, or AUTONOMY_SPLIT_PLAN into any authored markdown or JSON artifact/);
});

test('planning prompt frames the task as iterative plan refinement', () => {
  const prompt = buildPlanningPrompt('/tmp/PLAN.md');

  assert.match(prompt, /Refine the existing plan document at \/tmp\/PLAN\.md/);
  assert.match(prompt, /Underdeveloped scopes that need more implementation detail/);
  assert.match(prompt, /Vague or missing acceptance criteria/);
  assert.match(prompt, /Ambiguous scope boundaries or hidden assumptions/);
  assert.match(prompt, /Poor or unclear sequencing between scopes/);
  assert.match(prompt, /Verification that is not executable or not concrete/);
  assert.match(prompt, /Produce a substantively improved revision in the same file\./);
  assert.match(prompt, /If the current plan is already strong, do not invent new weaknesses/);
  assert.doesNotMatch(prompt, /Rewrite the draft plan document/);
});

test('plan-mode coder response prompt frames follow-up rounds as continued refinement', () => {
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [],
  });

  assert.match(prompt, /Continue refining the plan document at \/tmp\/PLAN\.md/);
  assert.doesNotMatch(prompt, /Continue rewriting the draft plan document/);
});

test('plan-mode reviewer prompt calls out plan-refinement quality dimensions', () => {
  const prompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  });

  assert.match(prompt, /Focus on plan quality for refinement/);
  assert.match(prompt, /scopes that need more detail/);
  assert.match(prompt, /acceptance criteria that are vague or missing/);
  assert.match(prompt, /ambiguous boundaries/);
  assert.match(prompt, /hidden assumptions about the repository/);
  assert.match(prompt, /weak sequencing/);
  assert.match(prompt, /non-executable verification/);
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

  assert.match(scopePrompt, /Include exactly one progress-justification JSON payload/);
  assert.match(scopePrompt, /milestoneTargeted/);
  assert.match(scopePrompt, /newEvidence/);
  assert.match(scopePrompt, /whyNotRedundant/);
  assert.match(scopePrompt, /nextStepUnlocked/);
  assert.match(scopePrompt, /The final line of your response must still be the terminal marker/);
  assert.match(scopePrompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assert.match(planResponsePrompt, /Protocol markers are terminal-response control signals, not artifact content/);

  assert.match(reviewerPrompt, /same canonical `## Execution Shape` \/ `## Execution Queue` contract as a top-level plan/);
  assert.match(reviewerPrompt, /canonical Neal-executable plan shape/);
});

test('recovery-plan prompts keep review and response anchored to the active run', () => {
  const reviewerPrompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
    mode: 'recovery-plan',
    parentPlanDoc: '/tmp/PLAN.md',
    recoveryParentScopeLabel: '4',
  });
  const planResponsePrompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.md',
    openFindings: [],
    reviewMode: 'recovery-plan',
    parentPlanDoc: '/tmp/PLAN.md',
    recoveryParentScopeLabel: '4',
  });

  assert.match(reviewerPrompt, /diagnostic recovery plan candidate at \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
  assert.match(reviewerPrompt, /parent objective 4/);
  assert.match(reviewerPrompt, /candidate recovery plan, not as a brand-new top-level initiative/);
  assert.match(reviewerPrompt, /same canonical `## Execution Shape` \/ `## Execution Queue` contract as a top-level plan/);

  assert.match(planResponsePrompt, /Continue refining the diagnostic recovery plan candidate at \/tmp\/DIAGNOSTIC_RECOVERY_1_PLAN\.md for parent objective 4/);
  assert.match(planResponsePrompt, /Edit only the diagnostic recovery plan artifact/);
  assert.match(planResponsePrompt, /adopt back into the active run safely/);
  assert.match(planResponsePrompt, /same Neal-executable contract as a top-level plan/);
  assert.match(planResponsePrompt, /Protocol markers are terminal-response control signals, not artifact content/);
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
  assert.match(prompt, /scope granularity, verification concreteness, and resume safety/);
  assert.match(prompt, /name the failing dimension directly/);
  assert.match(prompt, /If the plan is already Neal-executable, confirm that quickly and return no manufactured findings/);
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
      ignoreLocalChanges: false,
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

test('review markdown records the reviewed artifact for each plan-review round', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'plan',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  const markdown = renderReviewMarkdown({
    ...state,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-1',
        reviewedPlanPath: planDoc,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: {
          base: 'abc123',
          head: 'abc123',
        },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
  });

  assert.match(markdown, /Last reviewed artifact: .*PLAN\.md/);
  assert.match(markdown, /### Round 1/);
  assert.match(markdown, /Reviewed artifact: .*PLAN\.md/);
});
