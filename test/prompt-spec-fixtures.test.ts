import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildCoderResponsePrompt,
  buildCoderPlanResponsePrompt,
  buildFinalCompletionReviewerPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
  buildReviewerPrompt,
  buildScopePrompt,
} from '../src/neal/agents.js';
import { getPromptSpec } from '../src/neal/prompts/specs.js';
import { clearUserGuidanceCache } from '../src/neal/prompts/guidance.js';

process.env.NEAL_GUIDANCE_DIR = join(tmpdir(), 'neal-guidance-fixture-tests-does-not-exist');
clearUserGuidanceCache();

type PromptFixture = {
  name: string;
  specId:
    | 'plan_author'
    | 'plan_reviewer'
    | 'recovery_plan_reviewer'
    | 'scope_coder'
    | 'scope_reviewer'
    | 'completion_reviewer';
  variant: string;
  builder:
    | 'buildPlanningPrompt'
    | 'buildPlanReviewerPrompt'
    | 'buildCoderPlanResponsePrompt'
    | 'buildScopePrompt'
    | 'buildCoderResponsePrompt'
    | 'buildReviewerPrompt'
    | 'buildFinalCompletionReviewerPrompt';
  args: Record<string, unknown>;
  contains: string[];
  excludes: string[];
};

const FIXTURE_FILES = [
  'planning/plan-author-primary.json',
  'planning/plan-author-derived-response.json',
  'planning/plan-reviewer-primary.json',
  'planning/recovery-plan-reviewer.json',
  'execute/scope-coder-primary.json',
  'execute/scope-coder-response.json',
  'execute/scope-reviewer-primary.json',
  'specialized/completion-reviewer-final.json',
] as const;

function getFixturePath(fileName: string) {
  return fileURLToPath(new URL(`./fixtures/prompts/${fileName}`, import.meta.url));
}

async function loadFixture(fileName: string): Promise<PromptFixture> {
  const raw = await readFile(getFixturePath(fileName), 'utf8');
  return JSON.parse(raw) as PromptFixture;
}

function renderPrompt(fixture: PromptFixture) {
  switch (fixture.builder) {
    case 'buildPlanningPrompt':
      return buildPlanningPrompt(fixture.args.planDoc as string);
    case 'buildPlanReviewerPrompt':
      return buildPlanReviewerPrompt(fixture.args as Parameters<typeof buildPlanReviewerPrompt>[0]);
    case 'buildCoderPlanResponsePrompt':
      return buildCoderPlanResponsePrompt(fixture.args as Parameters<typeof buildCoderPlanResponsePrompt>[0]);
    case 'buildScopePrompt':
      return buildScopePrompt(fixture.args.planDoc as string, fixture.args.progressText as string);
    case 'buildCoderResponsePrompt':
      return buildCoderResponsePrompt(fixture.args as Parameters<typeof buildCoderResponsePrompt>[0]);
    case 'buildReviewerPrompt':
      return buildReviewerPrompt(fixture.args as Parameters<typeof buildReviewerPrompt>[0]);
    case 'buildFinalCompletionReviewerPrompt':
      return buildFinalCompletionReviewerPrompt(fixture.args as Parameters<typeof buildFinalCompletionReviewerPrompt>[0]);
  }
}

test('prompt fixtures stay aligned with their prompt-spec builders', async () => {
  for (const fileName of FIXTURE_FILES) {
    const fixture = await loadFixture(fileName);
    const spec = getPromptSpec(fixture.specId);
    const variant = spec.variants.find((candidate) => candidate.kind === fixture.variant);

    if (fixture.builder === 'buildPlanningPrompt') {
      assert.equal(spec.baseInstructions.exportName, fixture.builder);
    } else {
      assert.ok(variant, `fixture ${fileName} should map to a declared prompt-spec variant`);
      assert.equal(variant.baseInstructions.exportName, fixture.builder);
    }

    const prompt = renderPrompt(fixture);
    for (const expected of fixture.contains) {
      assert.match(prompt, new RegExp(escapeRegExp(expected)), `${fileName} should include ${expected}`);
    }
    for (const forbidden of fixture.excludes) {
      assert.doesNotMatch(prompt, new RegExp(escapeRegExp(forbidden)), `${fileName} should not include ${forbidden}`);
    }
  }
});

test('prompt fixtures cover the known ambiguity regressions from the prompt-spec plan', async () => {
  const [
    planAuthorPrimary,
    derivedResponse,
    planReviewerPrimary,
    recoveryReviewer,
    scopeCoderPrimary,
    scopeCoderResponse,
    scopeReviewerPrimary,
    completionReviewer,
  ] = await Promise.all(
    FIXTURE_FILES.map((fileName) => loadFixture(fileName)),
  );

  const renderedPrimary = renderPrompt(planAuthorPrimary);
  const renderedDerived = renderPrompt(derivedResponse);
  const renderedReviewer = renderPrompt(planReviewerPrimary);
  const renderedRecoveryReviewer = renderPrompt(recoveryReviewer);
  const renderedScopeCoderPrimary = renderPrompt(scopeCoderPrimary);
  const renderedScopeCoderResponse = renderPrompt(scopeCoderResponse);
  const renderedScopeReviewer = renderPrompt(scopeReviewerPrimary);
  const renderedCompletionReviewer = renderPrompt(completionReviewer);

  assert.match(renderedPrimary, /Choose `multi_scope` when the work changes orchestration or state-machine behavior/);
  assert.match(renderedPrimary, /Choose `multi_scope_unknown` when the work repeats one bounded recurring slice at a time/);
  assert.match(renderedDerived, /same Neal-executable contract as a top-level plan/);
  assert.match(renderedDerived, /### Scope 1: Example scope/);
  assert.match(renderedDerived, /### Recurring Scope/);
  assert.match(renderedReviewer, /echo it in the required `executionShape` field/);
  assert.match(renderedReviewer, /scope granularity, verification concreteness, and resume safety/);
  assert.match(renderedRecoveryReviewer, /candidate recovery plan, not as a brand-new top-level initiative/);
  assert.match(renderedRecoveryReviewer, /active parent objective/);
  assert.match(renderedScopeCoderPrimary, /return AUTONOMY_SPLIT_PLAN instead of forcing the bad shape/);
  assert.match(renderedScopeCoderPrimary, /derived plan must use the same Neal-executable contract as a top-level plan/);
  assert.match(renderedScopeCoderResponse, /not optional to triage\. Respond to every finding exactly once/);
  assert.match(renderedScopeCoderResponse, /Fix local, concrete, low-expansion non-blocking findings by default/);
  assert.match(renderedScopeCoderResponse, /Return outcome=`blocked` only if you are genuinely unable to make or explain a decision on these findings/);
  assert.match(renderedScopeReviewer, /authority for meaningful-progress gating/);
  assert.match(renderedScopeReviewer, /Treat the scope diff as hostile input/);
  assert.match(renderedScopeReviewer, /Those are convergence signals, not proof that the code is sound/);
  assert.match(renderedScopeReviewer, /Bias your search toward execute-mode failure classes/);
  assert.match(renderedScopeReviewer, /Every finding must name the concrete issue/);
  assert.match(renderedScopeReviewer, /active parent objective for meaningful-progress evaluation is scope 5\.2/);
  assert.match(renderedCompletionReviewer, /When you return `continue_execution`, you must provide a non-null `missingWork` object/);
  assert.match(renderedCompletionReviewer, /Use `block_for_operator` when the remaining gap is ambiguous/);
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
