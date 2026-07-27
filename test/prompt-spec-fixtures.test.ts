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
  const renderedScopeCoderPrimary = renderPrompt(scopeCoderPrimary);
  const renderedScopeCoderResponse = renderPrompt(scopeCoderResponse);
  const renderedScopeReviewer = renderPrompt(scopeReviewerPrimary);
  const renderedCompletionReviewer = renderPrompt(completionReviewer);
  const multiScopeCompletionConditionWarning =
    /A `multi_scope` derived plan must not include a standalone `## Completion Condition` section/;
  const canonicalMultiScopeSectionRule =
    /`executionShape: multi_scope` must include a literal `## Execution Queue` section and must not include a literal `## Execution Loop` section or standalone `## Completion Condition` section/;

  // Plan author: execution-shape enum values plus the canonical section-structure rule.
  assert.match(renderedPrimary, /`multi_scope`/);
  assert.match(renderedPrimary, /`multi_scope_unknown`/);
  assert.match(renderedPrimary, canonicalMultiScopeSectionRule);
  // Derived plan: canonical scope headers and the same section-structure rule.
  assert.match(renderedDerived, /### Scope 1: Example scope/);
  assert.match(renderedDerived, /### Recurring Scope/);
  assert.match(renderedDerived, canonicalMultiScopeSectionRule);
  // Plan reviewer: required executionShape field + readiness dimensions; no diff-mode tokens.
  assert.match(renderedReviewer, /`executionShape`/);
  assert.match(renderedReviewer, /scope granularity, verification concreteness, and resume safety/);
  assert.doesNotMatch(renderedReviewer, /Commit range:/);
  assert.doesNotMatch(renderedReviewer, /git diff/);
  assert.doesNotMatch(renderedReviewer, /changed behavior degraded/);
  // Scope coder primary: split_plan/blocked actions, derivedPlan field, multi_scope
  // section rule; protocol markers and terminal-line prose stay out.
  assert.match(renderedScopeCoderPrimary, /action=`split_plan`/);
  assert.match(renderedScopeCoderPrimary, /action=`blocked`/);
  assert.match(renderedScopeCoderPrimary, /`derivedPlan`/);
  assert.match(renderedScopeCoderPrimary, multiScopeCompletionConditionWarning);
  assert.doesNotMatch(renderedScopeCoderPrimary, /Use AUTONOMY_SPLIT_PLAN only/);
  assert.doesNotMatch(renderedScopeCoderPrimary, /Treat AUTONOMY_BLOCKED as a last resort/);
  assert.doesNotMatch(renderedScopeCoderPrimary, /Final line must be exactly one of:/);
  assert.doesNotMatch(renderedScopeCoderPrimary, /The final line of your response must still be the terminal marker/);
  // Scope coder response: disposition outcome enum, derivedPlan field, multi_scope
  // section rule; no leftover terminal-marker prose.
  assert.match(renderedScopeCoderResponse, /outcome=`blocked`/);
  assert.match(renderedScopeCoderResponse, /`derivedPlan`/);
  assert.match(renderedScopeCoderResponse, multiScopeCompletionConditionWarning);
  assert.doesNotMatch(renderedScopeCoderResponse, /The final line of your response must still be the terminal marker/);
  // Scope reviewer: scratch-path markers, injected parent objective, meaningful-progress
  // field/enum surface; old ambiguous escalation wording is gone.
  assert.match(renderedScopeReviewer, /\.neal\/runs\//);
  assert.match(renderedScopeReviewer, /\/scratch\//);
  assert.match(renderedScopeReviewer, /scope 5\.2/);
  assert.match(renderedScopeReviewer, /`accept`/);
  assert.match(renderedScopeReviewer, /`advance_parent`/);
  assert.match(renderedScopeReviewer, /`block_for_operator`/);
  assert.match(renderedScopeReviewer, /meaningfulProgressAction/);
  assert.match(renderedScopeReviewer, /meaningfulProgressRationale/);
  assert.doesNotMatch(renderedScopeReviewer, /any case needing operator judgment/);
  assert.doesNotMatch(renderedScopeReviewer, /any non-empty or uncertain current diff/);
  // Completion reviewer: injected aggregate range, scratch-path markers, verdict
  // action enums, and the squash-commit-message field surface.
  assert.match(renderedCompletionReviewer, /aggregate range base123\.\.abc123/);
  assert.match(renderedCompletionReviewer, /\.neal\/runs\//);
  assert.match(renderedCompletionReviewer, /\/scratch\//);
  assert.match(renderedCompletionReviewer, /`continue_execution`/);
  assert.match(renderedCompletionReviewer, /`missingWork`/);
  assert.match(renderedCompletionReviewer, /Squash commit message rules:/);
  assert.match(renderedCompletionReviewer, /`squashCommitMessage`/);
  assert.match(renderedCompletionReviewer, /`block_for_operator`/);
});

// Shared core of the issue #10 evidence-audit clause. The three coder-facing
// surfaces voice-match the tail (step / finding / verification-not-run), but all
// carry this exact substring, so a single literal pins the exact-once count on
// every surface.
const EVIDENCE_AUDIT_CLAUSE =
  'Before claiming a step is done or a verification passed, confirm the claim against an actual tool or command result from this session';

test('coder prompts render the evidence-audit clause exactly once on every surface and mode', () => {
  const scopePrompt = buildScopePrompt('/tmp/PLAN.md', '## Current Scope\n- Scope: 5.2\n');
  assert.equal(
    scopePrompt.split(EVIDENCE_AUDIT_CLAUSE).length - 1,
    1,
    'buildScopePrompt must render the evidence-audit clause exactly once',
  );

  const responseArgsBase = {
    planDoc: '/tmp/PLAN.md',
    progressText: '## Current Scope\n- Scope: 5.2\n',
    verificationHint: 'Run the focused regression tests before replying.',
    openFindings: [],
  };
  // Render both modes so an optional-only or blocking-only insertion fails, and
  // the exact-count form catches a duplicated clause.
  const blockingResponse = buildCoderResponsePrompt({ ...responseArgsBase, mode: 'blocking' });
  assert.equal(
    blockingResponse.split(EVIDENCE_AUDIT_CLAUSE).length - 1,
    1,
    'buildCoderResponsePrompt (blocking) must render the evidence-audit clause exactly once',
  );

  const optionalResponse = buildCoderResponsePrompt({ ...responseArgsBase, mode: 'optional' });
  assert.equal(
    optionalResponse.split(EVIDENCE_AUDIT_CLAUSE).length - 1,
    1,
    'buildCoderResponsePrompt (optional) must render the evidence-audit clause exactly once',
  );
});

// Issue #12: `buildCoderResponsePrompt` gains two `// model-calibrated:` source
// comments above its tool-appetite lines. Comments are not part of the returned
// line array, so the render must stay byte-for-byte identical. These fixed args
// match the ones used to capture the pre-comment goldens.
const CODER_RESPONSE_GOLDEN_ARGS = {
  planDoc: '/tmp/PLAN.md',
  progressText: '## Current Scope\n- Scope: 5.2\n',
  verificationHint: 'Run the focused regression tests before replying.',
  openFindings: [],
} satisfies Parameters<typeof buildCoderResponsePrompt>[0];

// The two named tool-appetite literals the `// model-calibrated:` comments must
// sit directly above (substrings of the actual returned lines).
const TOOL_APPETITE_LITERALS = [
  'After you have made the necessary commit and run the relevant verification, stop using tools.',
  'Do not keep proving the same fix after you have enough evidence to answer each finding. Summarize the evidence in the structured response instead.',
] as const;

test('buildCoderResponsePrompt renders byte-for-byte identically to its pre-comment goldens in both modes', async () => {
  const blockingGolden = await readFile(
    getFixturePath('execute/coder-response-blocking.expected.txt'),
    'utf8',
  );
  const optionalGolden = await readFile(
    getFixturePath('execute/coder-response-optional.expected.txt'),
    'utf8',
  );

  const blockingRendered = buildCoderResponsePrompt({ ...CODER_RESPONSE_GOLDEN_ARGS, mode: 'blocking' });
  const optionalRendered = buildCoderResponsePrompt({ ...CODER_RESPONSE_GOLDEN_ARGS, mode: 'optional' });

  assert.equal(
    blockingRendered,
    blockingGolden,
    'buildCoderResponsePrompt (blocking) must render byte-for-byte identically after the comments-only edit',
  );
  assert.equal(
    optionalRendered,
    optionalGolden,
    'buildCoderResponsePrompt (optional) must render byte-for-byte identically after the comments-only edit',
  );
});

test('execute.ts carries exactly two model-calibrated comments directly above the two named tool-appetite lines', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../src/neal/prompts/execute.ts', import.meta.url)),
    'utf8',
  );
  const lines = source.split('\n');
  const commentIndices = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().startsWith('// model-calibrated:'))
    .map(({ index }) => index);

  // Rejects a missing tag and any extra tag (including one above a prohibited
  // doctrine line).
  assert.equal(
    commentIndices.length,
    2,
    'execute.ts must contain exactly two // model-calibrated: comments',
  );

  // Each comment sits directly above one of the two named tool-appetite literals.
  const coveredLiterals = new Set<string>();
  for (const i of commentIndices) {
    const next = lines[i + 1] ?? '';
    const matched = TOOL_APPETITE_LITERALS.find((literal) => next.includes(literal));
    assert.ok(
      matched,
      `// model-calibrated: comment at line ${i + 1} must sit directly above a named tool-appetite line`,
    );
    coveredLiterals.add(matched);
  }

  // Across the two comments both named literals are covered exactly once.
  assert.equal(
    coveredLiterals.size,
    TOOL_APPETITE_LITERALS.length,
    'the two model-calibrated comments must cover both named tool-appetite lines, one each',
  );
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
