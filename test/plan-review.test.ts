import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCoderPlanResponsePrompt,
  buildCoderPlanResponseSchema,
  buildCoderResponsePrompt,
  buildPlanReviewerPrompt,
  buildPlanReviewerSchema,
  buildPlanningPrompt,
  buildScopePrompt,
  PLAN_REVIEWER_FINDING_CLASSES,
  validatePlanReviewerPayload,
} from '../src/neal/agents.js';
import { clearConfigCache } from '../src/neal/config.js';
import { runPlanningReviewerAdjudication } from '../src/neal/adjudicator/planning.js';
import {
  runPlanReviewPhase,
  runPlanningResponsePhase,
  synthesizePlanReviewFindings,
} from '../src/neal/orchestrator/phases/planning.js';
import { renderPlanProgressMarkdown } from '../src/neal/progress.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type {
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-plan-review');

function hasTopLevelRequiredProperty(schema: ReturnType<typeof buildPlanReviewerSchema>, key: string) {
  return Array.isArray(schema.required) && schema.required.includes(key);
}

function assertStructuredPlanResponsePromptContract(prompt: string) {
  // Assert the disposition enum values and protocol-marker tokens are present,
  // not the verbatim English describing when to use each.
  assert.match(prompt, /`fixed`/);
  assert.match(prompt, /`rejected`/);
  assert.match(prompt, /`deferred`/);
  assert.match(prompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assert.match(prompt, /Never write AUTONOMY_DONE, AUTONOMY_BLOCKED, AUTONOMY_SCOPE_DONE, or AUTONOMY_SPLIT_PLAN into any authored markdown or JSON artifact/);
  assert.doesNotMatch(prompt, /emit exactly one terminal marker/);
  assert.doesNotMatch(prompt, /Final line must be exactly/);
  assert.doesNotMatch(prompt, /The final line of your response must still be the terminal marker/);
}

test('planning prompt requires an explicit execution-shape declaration', () => {
  const prompt = buildPlanningPrompt('/tmp/PLAN.md');

  assert.match(prompt, /Choose exactly one execution shape: `one_shot`, `multi_scope`, or `multi_scope_unknown`\./);
  assert.match(prompt, /Declare that choice in the plan document with a literal `## Execution Shape` section/);
  assert.match(prompt, /executionShape: one_shot/);
  assert.match(prompt, /executionShape: multi_scope/);
  assert.match(prompt, /executionShape: multi_scope_unknown/);
  assert.match(prompt, /Choose `multi_scope` when the work changes orchestration or state-machine behavior/);
  assert.match(prompt, /Choose `multi_scope_unknown` when the work repeats one bounded recurring slice at a time/);
  assert.match(prompt, /Choose `one_shot` only when the work can realistically be executed, reviewed, and verified as one bounded scope/);
  assert.match(prompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assert.match(prompt, /Never write AUTONOMY_DONE, AUTONOMY_BLOCKED, AUTONOMY_SCOPE_DONE, or AUTONOMY_SPLIT_PLAN into any authored markdown or JSON artifact/);
});

test('authoredOneShot flag renders the single-scope reinforcement line only when true', () => {
  // The authoredOneShot flag toggles a one_shot reinforcement marker on only
  // when true; assert presence/absence keyed on the distinctive marker, not the
  // verbatim sentence, plus the structural equality of the false case.
  const planningMarker = /authored as a single-scope/;
  const reviewerMarker = /This plan was authored `one_shot`/;

  const basePlanning = buildPlanningPrompt('/tmp/PLAN.md');
  const oneShotPlanning = buildPlanningPrompt('/tmp/PLAN.md', null, { authoredOneShot: true });
  assert.doesNotMatch(basePlanning, planningMarker);
  assert.match(oneShotPlanning, planningMarker);
  assert.equal(buildPlanningPrompt('/tmp/PLAN.md', null, { authoredOneShot: false }), basePlanning);

  const reviewerArgs = {
    planDoc: '/tmp/PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  };
  const baseReviewer = buildPlanReviewerPrompt(reviewerArgs);
  const oneShotReviewer = buildPlanReviewerPrompt({ ...reviewerArgs, authoredOneShot: true });
  assert.doesNotMatch(baseReviewer, reviewerMarker);
  assert.match(oneShotReviewer, reviewerMarker);
  assert.equal(buildPlanReviewerPrompt({ ...reviewerArgs, authoredOneShot: false }), baseReviewer);
});

test('planning prompt frames the task as iterative plan refinement', () => {
  const prompt = buildPlanningPrompt('/tmp/PLAN.md');

  // Assert the plan-doc path is threaded through and the prompt is framed as
  // refinement (not a from-scratch rewrite); the quality-dimension bullets are
  // prose and are not asserted verbatim.
  assert.match(prompt, /Refine the existing plan document at \/tmp\/PLAN\.md/);
  assert.doesNotMatch(prompt, /Rewrite the draft plan document/);
});

test('planning prompt targets a human-reviewable plan without pre-implementing it in prose', () => {
  const prompt = buildPlanningPrompt('/tmp/PLAN.md');

  assert.match(prompt, /smallest human-reviewable plan/);
  assert.match(prompt, /moderate-to-high-level implementation detail/);
  assert.match(prompt, /leave routine implementation discovery to the coder and reviewer/);
  assert.match(prompt, /Avoid line-by-line change lists, exhaustive inventories/);
  assert.match(prompt, /Use allowed-path lists, forbidden-path lists, and detailed blocker handling only when the task has a real boundary/);
  assert.match(prompt, /A repository-wide invariant or global regression guarantee belongs in the plan only when it is necessary for the requested change to be correct/);
  assert.match(prompt, /narrow or remove it instead of expanding the implementation or verification scope/);
  assert.doesNotMatch(prompt, /enumerate the full blast radius/);
  assert.doesNotMatch(prompt, /every consumer of a changed symbol/);
  assert.doesNotMatch(prompt, /Make the final plan explicit about scope boundaries, allowed scope, forbidden paths/);
});

test('plan-mode coder response prompt frames follow-up rounds as continued refinement', () => {
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [],
  });

  assert.match(prompt, /Continue refining the plan document at \/tmp\/PLAN\.md/);
  assert.doesNotMatch(prompt, /Continue rewriting the draft plan document/);
  assertStructuredPlanResponsePromptContract(prompt);
});

test('plan-mode coder response keeps revisions at the same moderate level of detail', () => {
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [],
  });

  assert.match(prompt, /Keep the revised plan concise, human-reviewable, and at moderate-to-high-level implementation detail/);
  assert.match(prompt, /leave routine discovery to execution/);
  assert.match(prompt, /A repository-wide invariant or global regression guarantee belongs in the plan only when it is necessary for the requested change to be correct/);
  assert.match(prompt, /narrow or remove it instead of expanding the implementation or verification scope/);
  assert.doesNotMatch(prompt, /smallest human-reviewable plan/);
  assert.doesNotMatch(prompt, /use the concrete existing symbol names and exports/);
});

test('plan-mode coder response prompt follows the structured schema without terminal markers', () => {
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [
      {
        id: 'R1-F1',
        source: 'reviewer',
        severity: 'blocking',
        files: ['/tmp/PLAN.md'],
        claim: 'The plan omits concrete verification.',
        requiredAction: 'Add executable verification commands.',
        roundSummary: 'The plan needs stronger validation.',
      },
    ],
  });
  const schema = buildCoderPlanResponseSchema();

  assert.deepEqual(schema.required, ['outcome', 'summary', 'blocker', 'responses']);
  assert.deepEqual(schema.properties.outcome.enum, ['responded', 'blocked']);
  assert.match(prompt, /Always include a `blocker` string\. Use an empty string when outcome=`responded`\./);
  assert.match(prompt, /If required information is missing, return outcome=`blocked`/);
  assert.match(prompt, /"id": "R1-F1"/);
  assertStructuredPlanResponsePromptContract(prompt);
});

test('plan-mode coder response prompt includes plan-review guidance before open findings', () => {
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [
      {
        id: 'R1-F1',
        source: 'reviewer',
        severity: 'blocking',
        files: ['/tmp/PLAN.md'],
        claim: 'The plan omits concrete verification.',
        requiredAction: 'Add executable verification commands.',
        roundSummary: 'The plan needs stronger validation.',
      },
    ],
    planReviewGuidance: {
      message: 'Keep the scope split, but make the resume step explicit.',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-05-29T00:00:00.000Z',
    },
  });

  const guidanceIndex = prompt.indexOf('Operator guidance for this blocked plan-review recovery:');
  const openFindingsIndex = prompt.indexOf('Open findings:');

  assert.notEqual(guidanceIndex, -1);
  assert.notEqual(openFindingsIndex, -1);
  assert.equal(guidanceIndex < openFindingsIndex, true);
  assert.match(prompt, /Keep the scope split, but make the resume step explicit\./);
  assert.match(
    prompt,
    /This guidance supplements the open reviewer findings\. It does not waive plan-contract requirements, verification requirements, or the need to address blocking findings\./,
  );
  assert.match(prompt, /"id": "R1-F1"/);
});

test('plan-mode coder response prompt omits plan-review guidance section when absent', () => {
  const prompt = buildCoderPlanResponsePrompt({
    planDoc: '/tmp/PLAN.md',
    openFindings: [],
  });

  assert.doesNotMatch(prompt, /Operator guidance for this blocked plan-review recovery:/);
  assert.doesNotMatch(prompt, /This guidance supplements the open reviewer findings/);
});

test('plan-mode reviewer prompt calls out plan-refinement quality dimensions', () => {
  const prompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  });

  // Assert the prompt is framed around plan-quality refinement; the individual
  // quality-dimension phrases are prose and are not asserted verbatim.
  assert.match(prompt, /Focus on plan quality for refinement/);
});

test('plan reviewer performs independent material review without becoming code-diff review', () => {
  const prompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  });

  assert.match(prompt, /Review the plan independently and look for material problems/);
  assert.match(prompt, /Missing routine implementation detail is not a finding/);
  assert.match(prompt, /Do not require exhaustive file, symbol, caller, test, command, assertion, line-number, pinned-value, or fixture inventories/);
  assert.match(prompt, /concise enough for a person to review/);
  assert.match(prompt, /A repository-wide invariant or global regression guarantee belongs in the plan only when it is necessary for the requested change to be correct/);
  assert.match(prompt, /do not require additional implementation or verification to satisfy it/);
  assert.match(prompt, /planned checks could allow the requested change itself to be wrong while still appearing complete/);
  assert.match(prompt, /Incomplete enforcement of an unnecessary broader guarantee introduced by the plan is non-blocking/);
  assert.doesNotMatch(prompt, /hostile input/);
  assert.doesNotMatch(prompt, /tests that mock away the risky runtime path/);
  assert.doesNotMatch(prompt, /more oracles, more pinning/);
  assert.doesNotMatch(prompt, /Commit range:/);
  assert.doesNotMatch(prompt, /git diff/);
  assert.doesNotMatch(prompt, /aggregate range/);
  assert.doesNotMatch(prompt, /changed behavior degraded/);
  assert.doesNotMatch(prompt, /If the change removes/);
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
    assert.match(prompt, /executionShape: multi_scope_unknown/);
    assert.match(prompt, /## Execution Loop/);
    assert.match(prompt, /## Completion Condition/);
    assert.match(prompt, /### Scope 1: Example scope/);
    assert.match(prompt, /A `multi_scope` derived plan must not include a standalone `## Completion Condition` section/);
    assert.doesNotMatch(prompt, /Ordered Derived Scopes/);
  }

  // Assert the structured envelope and the action enum tokens are present, not
  // the verbatim English describing when to choose each action.
  assert.match(scopePrompt, /structured execution envelope/);
  assert.match(scopePrompt, /`action` to `done`/);
  assert.match(scopePrompt, /`action` to `blocked`/);
  assert.match(scopePrompt, /action=`split_plan`/);
  assert.match(scopePrompt, /`progress` object/);
  assert.match(scopePrompt, /milestoneTargeted/);
  assert.match(scopePrompt, /newEvidence/);
  assert.match(scopePrompt, /whyNotRedundant/);
  assert.match(scopePrompt, /nextStepUnlocked/);
  assert.doesNotMatch(scopePrompt, /Use AUTONOMY_SPLIT_PLAN only/);
  assert.doesNotMatch(scopePrompt, /Treat AUTONOMY_BLOCKED as a last resort/);
  assert.doesNotMatch(scopePrompt, /Final line must be exactly one of:/);
  assert.doesNotMatch(scopePrompt, /The final line of your response must still be the terminal marker/);
  assert.match(scopePrompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assert.match(planResponsePrompt, /Protocol markers are terminal-response control signals, not artifact content/);
  assertStructuredPlanResponsePromptContract(planResponsePrompt);

  // Assert the structural section marker the reviewer must enforce; the
  // surrounding doctrine sentences are prose and are not asserted verbatim.
  assert.match(reviewerPrompt, /A `multi_scope` derived plan must not include a standalone `## Completion Condition` section/);
});

test('plan reviewer prompt read-only variant points at read-tool inspection without repository command instructions', () => {
  const baseArgs = {
    planDoc: '/tmp/PLAN.md',
    round: 1,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  };
  const prompt = buildPlanReviewerPrompt({ ...baseArgs, accessMode: 'read-only' });

  // Path-pointer and read-tool inspection phrasing are present.
  assert.match(prompt, /Read \/tmp\/REVIEW\.md before finalizing findings/);
  assert.match(prompt, /The reviewed plan content is inlined below; use your read-only file tools to inspect directly referenced companion docs and repository source files before finalizing findings\./);
  assert.match(prompt, /Inspect enough repository context to support material findings/);
  // No generic repository-tools instruction and no inline-context phrasing.
  assert.doesNotMatch(prompt, /Use repository tools to inspect/);
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);

  // Explicit 'tool-access' renders byte-identically to the default.
  assert.equal(buildPlanReviewerPrompt({ ...baseArgs, accessMode: 'tool-access' }), buildPlanReviewerPrompt(baseArgs));

  // The read-capable default variant threads the review path and never renders
  // the removed no-read inlined-context header.
  const readCapablePrompt = buildPlanReviewerPrompt(baseArgs);
  assert.match(readCapablePrompt, /Read \/tmp\/REVIEW\.md before finalizing findings/);
  assert.doesNotMatch(readCapablePrompt, /## Inlined review context from Neal/);
});

test('plan reviewer schema and prompt require executionShape confirmation', () => {
  const schema = buildPlanReviewerSchema();
  const prompt = buildPlanReviewerPrompt({
    planDoc: '/tmp/PLAN.md',
    round: 2,
    reviewMarkdownPath: '/tmp/REVIEW.md',
  });

  assert.equal(hasTopLevelRequiredProperty(schema, 'executionShape'), true);
  assert.deepEqual(schema.properties.executionShape.enum, ['one_shot', 'multi_scope', 'multi_scope_unknown']);
  assert.equal(hasTopLevelRequiredProperty(schema, 'summary'), true);
  assert.equal(hasTopLevelRequiredProperty(schema, 'findings'), true);
  assert.equal(hasTopLevelRequiredProperty(schema, 'missingKey'), false);
  assert.match(prompt, /must declare exactly one execution shape/);
  assert.match(prompt, /echo it in the required `executionShape` field/);
  assert.match(prompt, /scope granularity, verification concreteness, and resume safety/);
  assert.match(prompt, /name the failing dimension directly/);
  assert.match(prompt, /If the plan is already Neal-executable, confirm that quickly and return no manufactured findings/);
});

function planReviewerPayloadWithFinding(finding: Record<string, unknown>) {
  return {
    summary: 'The refined plan is nearly executable.',
    executionShape: 'multi_scope',
    findings: [finding],
  };
}

const BASE_PLAN_REVIEW_FINDING = {
  severity: 'blocking',
  files: ['PLAN.md'],
  claim: 'The verification for scope 2 is thin.',
  requiredAction: 'Pin the disposition sequence with a replay assertion.',
} as const;

test('validatePlanReviewerPayload keeps each valid finding class through normalization', () => {
  for (const findingClass of PLAN_REVIEWER_FINDING_CLASSES) {
    const result = validatePlanReviewerPayload(
      planReviewerPayloadWithFinding({ ...BASE_PLAN_REVIEW_FINDING, findingClass }),
    );
    assert.equal(result.findings[0].findingClass, findingClass);
    // Plan-review findings still force an empty evidence string.
    assert.equal(result.findings[0].evidence, '');
  }
});

test('validatePlanReviewerPayload defaults an absent finding class to plan_correctness', () => {
  // findingClass is optional at the payload boundary: a finding that omits the
  // key entirely normalizes to the fail-safe class.
  const finding: Record<string, unknown> = { ...BASE_PLAN_REVIEW_FINDING };
  assert.equal('findingClass' in finding, false);
  const result = validatePlanReviewerPayload(planReviewerPayloadWithFinding(finding));
  assert.equal(result.findings[0].findingClass, 'plan_correctness');
});

test('validatePlanReviewerPayload rejects a present-but-invalid finding class instead of downgrading it', () => {
  assert.throws(
    () =>
      validatePlanReviewerPayload(
        planReviewerPayloadWithFinding({ ...BASE_PLAN_REVIEW_FINDING, findingClass: 'nice_to_have' }),
      ),
    new Error(
      'Plan reviewer payload.findings[0].findingClass must be exactly one of: plan_correctness, verification_hardening.',
    ),
  );
});

test('executionShape persists through state round-trip and wrapper artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const statePath = getRunStatePath(runDir);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'plan',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  await saveState(statePath, {
    ...initialState,
    executionShape: 'multi_scope_unknown',
  });

  const loaded = await loadState(statePath);

  assert.equal(loaded.executionShape, 'multi_scope_unknown');
  assert.match(renderPlanProgressMarkdown(loaded), /- Execution shape: multi_scope_unknown/);
  assert.match(renderReviewMarkdown(loaded), /- Execution shape: multi_scope_unknown/);
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

test('plan-review synthesis accepts a valid multi-scope-unknown plan without synthetic findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-'));
  const planDoc = join(root, 'PLAN.md');

  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: multi_scope_unknown

## Execution Loop

### Recurring Scope
- Goal: Complete one bounded recurring slice.
- Verification: \`pnpm typecheck\`
- Success Condition: The slice is complete and reviewable.

## Completion Condition

Stop when the explicit completion condition is satisfied.
`,
    'utf8',
  );

  const synthesis = await synthesizePlanReviewFindings({
    planPath: planDoc,
    round: 1,
    roundSummary: 'Looks good.',
    findings: [],
  });

  assert.equal(synthesis.executionShape, 'multi_scope_unknown');
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
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
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

test('plan review keeps requesting revision when each round fixes the prior blocking canonical and surfaces a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-stuckness-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const totalRounds = 5;

  await mkdir(runDir, { recursive: true });
  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: one_shot
`,
    'utf8',
  );
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  review_stuck_window: 5\n', 'utf8');
  clearConfigCache(cwd);

  const statePath = getRunStatePath(runDir);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'plan',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 10,
    },
    'abc123',
  );
  let state = await saveState(statePath, {
    ...initialState,
    phase: 'reviewer_plan',
    agentConfig: {
      ...initialState.agentConfig,
      planner: { provider: 'fake-stuckness-planner', model: null },
      reviewer: { provider: 'fake-stuckness-reviewer', model: null },
    },
    plannerSessionHandle: 'planner-session-stuckness',
    plannerSessionProtocol: 'structured_json_v1',
  });

  const rounds = Array.from({ length: totalRounds }, (_, index) => index + 1);
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-stuckness-reviewer',
      includeCoderAdapter: false,
      structuredAdvisorResponses: rounds.map((round) => ({
        summary: `Fixing the prior blocking issue exposed deeper distinct safety issue ${round}.`,
        executionShape: 'one_shot',
        findings: [
          {
            severity: 'blocking',
            files: [planDoc],
            claim: `Distinct blocking plan safety issue ${round}.`,
            requiredAction: `Resolve distinct blocking plan safety issue ${round}.`,
          },
        ],
      })),
    }),
  );
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-stuckness-planner',
      includeStructuredAdvisorAdapter: false,
      coderSessionHandle: 'planner-session-stuckness',
      coderStructuredResponses: rounds.map((round) => ({
        outcome: 'responded',
        summary: `Revised the plan to resolve distinct blocking plan safety issue ${round}.`,
        blocker: '',
        responses: [
          {
            id: `R${round}-F1`,
            decision: 'fixed',
            summary: `Resolved distinct blocking plan safety issue ${round}.`,
          },
        ],
      })),
    }),
  );

  try {
    for (const round of rounds) {
      state = await runPlanReviewPhase(state, statePath);

      // The open blocking count stays flat at 1 every round, but each round
      // resolves the prior canonical and surfaces a new distinct one, so plan
      // review must request another revision instead of blocking as stuck.
      assert.equal(state.phase, 'coder_plan_response', `round ${round} should request revision, not block`);
      assert.equal(state.status, 'running', `round ${round} should keep the run running`);
      assert.equal(state.rounds.at(-1)?.openBlockingCanonicalCount, 1);

      if (round < totalRounds) {
        state = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
        assert.equal(state.phase, 'reviewer_plan', `round ${round} response should return to plan review`);
        assert.equal(state.status, 'running');
      }
    }
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }

  assert.deepEqual(
    state.rounds.map((round) => round.openBlockingCanonicalIds),
    rounds.map((round) => [`C${round}`]),
    'each round should record a distinct open blocking canonical despite the flat count',
  );
  assert.deepEqual(
    state.rounds.map((round) => round.openBlockingCanonicalCount),
    rounds.map(() => 1),
  );
});

const MULTI_SCOPE_PLAN_DOCUMENT = `# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Example scope
- Goal: Implement one bounded slice.
- Verification: \`pnpm typecheck\`
- Success Condition: The bounded slice is complete and verified.
`;

async function setUpPlanReviewClampFixture(args: {
  prefix: string;
  planDocument: string;
  reviewerExecutionShape: 'one_shot' | 'multi_scope' | 'multi_scope_unknown';
}) {
  const root = await mkdtemp(join(tmpdir(), args.prefix));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, args.planDocument, 'utf8');

  const statePath = getRunStatePath(runDir);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'plan',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 10,
    },
    'abc123',
  );

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-clamp-reviewer',
      includeCoderAdapter: false,
      structuredAdvisorResponses: [
        {
          summary: 'The refined plan looks executable.',
          executionShape: args.reviewerExecutionShape,
          findings: [],
        },
      ],
    }),
  );

  return { cwd, runDir, planDoc, statePath, initialState };
}

test('plan review no longer clamps an author-declared one_shot plan (binding disabled)', async () => {
  const { statePath, initialState } = await setUpPlanReviewClampFixture({
    prefix: 'neal-plan-review-oneshot-noclamp-',
    planDocument: MULTI_SCOPE_PLAN_DOCUMENT,
    reviewerExecutionShape: 'multi_scope',
  });

  // The seed plan declares multi_scope, and the author bound it to one_shot. The one_shot
  // hard clamp was removed (it caused a plan-review non-convergence regression), so refinement
  // now adopts the refined multi_scope shape directly with no injected shape-restoration finding.
  let state = await saveState(statePath, {
    ...initialState,
    phase: 'reviewer_plan',
    authoredExecutionShape: 'one_shot',
    agentConfig: {
      ...initialState.agentConfig,
      reviewer: { provider: 'fake-clamp-reviewer', model: null },
    },
    plannerSessionHandle: 'planner-session-noclamp',
    plannerSessionProtocol: 'structured_json_v1',
  });

  try {
    state = await runPlanReviewPhase(state, statePath);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }

  // The refined multi_scope shape is adopted as-is (no clamp back to one_shot).
  assert.equal(state.executionShape, 'multi_scope');
  // authoredExecutionShape is still captured but no longer enforced.
  assert.equal(state.authoredExecutionShape, 'one_shot');
  // No injected shape-restoration finding.
  assert.equal(state.findings.length, 0);
  assert.equal(state.phase, 'done');
  assert.equal(state.status, 'done');
});

test('plan review leaves an author-declared multi_scope plan unchanged', async () => {
  const { statePath, initialState } = await setUpPlanReviewClampFixture({
    prefix: 'neal-plan-review-multiscope-passthrough-',
    planDocument: MULTI_SCOPE_PLAN_DOCUMENT,
    reviewerExecutionShape: 'multi_scope',
  });

  let state = await saveState(statePath, {
    ...initialState,
    phase: 'reviewer_plan',
    authoredExecutionShape: 'multi_scope',
    agentConfig: {
      ...initialState.agentConfig,
      reviewer: { provider: 'fake-clamp-reviewer', model: null },
    },
    plannerSessionHandle: 'planner-session-passthrough',
    plannerSessionProtocol: 'structured_json_v1',
  });

  try {
    state = await runPlanReviewPhase(state, statePath);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }

  // No clamp, no injected finding: the refined multi_scope shape is adopted as-is.
  assert.equal(state.executionShape, 'multi_scope');
  assert.equal(state.findings.length, 0);
  assert.equal(state.phase, 'done');
  assert.equal(state.status, 'done');
});

test('plan review does not clamp derived-plan reviews even when the parent was authored one_shot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-derived-no-clamp-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const derivedPlanPath = join(runDir, 'DERIVED_PLAN_SCOPE_2.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Parent Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await writeFile(derivedPlanPath, MULTI_SCOPE_PLAN_DOCUMENT, 'utf8');

  const statePath = getRunStatePath(runDir);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 10,
    },
    'abc123',
  );

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-clamp-reviewer',
      includeCoderAdapter: false,
      structuredAdvisorResponses: [
        {
          summary: 'The derived plan replaces the abandoned scope safely.',
          executionShape: 'multi_scope',
          findings: [],
        },
      ],
    }),
  );

  let state = await saveState(statePath, {
    ...initialState,
    phase: 'reviewer_plan',
    // Parent authored one_shot, but the derived plan owns its own (multi_scope) shape.
    authoredExecutionShape: 'one_shot',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 2,
    derivedScopeIndex: null,
    agentConfig: {
      ...initialState.agentConfig,
      reviewer: { provider: 'fake-clamp-reviewer', model: null },
    },
  });

  try {
    state = await runPlanReviewPhase(state, statePath);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }

  // The derived-plan shape is adopted unchanged; no one_shot restoration finding is injected.
  assert.equal(state.executionShape, 'multi_scope');
  assert.equal(state.findings.length, 0);
  assert.equal(state.derivedPlanStatus, 'accepted');
});

// --- Production-path plan-review adapter-prompt coverage ---
// These tests drive the real adjudicator (runPlanningReviewerAdjudication) and
// the real round function (runPlanReviewerRound -> buildPlanReviewerPrompt)
// with a capturing structured-advisor adapter, then assert on the FINAL
// adapter prompt. This is what catches a wiring regression (dropped
// reviewedPlanContent/parentPlanContent, wrong doctrine, re-added removed
// inline context) between the adjudicator and the round.

const PLAN_REVIEW_PLAN_SENTINEL = 'Plan body sentinel: inline the supervisor contract.';
const PLAN_REVIEW_HISTORY_SENTINEL = 'Review history sentinel: prior round R1 had no findings.';
const PLAN_REVIEW_DERIVED_SENTINEL = 'Derived plan body sentinel: replace scope two safely.';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
});

function installCapturingPlanReviewAdvisor(provider: string) {
  const captured: StructuredAdvisorRoundArgs[] = [];
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      captured.push(args as StructuredAdvisorRoundArgs);
      return {
        sessionHandle: null,
        structured: {
          summary: 'Captured plan review round.',
          executionShape: 'multi_scope',
          findings: [],
        } as TStructured,
      };
    },
  };
  setProviderCapabilitiesOverrideForTesting(provider, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return captured;
}

async function createPlanReviewAdjudicationFixture(reviewerProvider: string) {
  const root = await mkdtemp(join(tmpdir(), 'neal-plan-review-adjudication-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, `# Plan\n\n${PLAN_REVIEW_PLAN_SENTINEL}\n`, 'utf8');
  const reviewMarkdownPath = join(runDir, 'REVIEW.md');
  await writeFile(reviewMarkdownPath, `# Review\n\n${PLAN_REVIEW_HISTORY_SENTINEL}\n`, 'utf8');
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  notify_bin: /usr/bin/true\n', 'utf8');
  clearConfigCache(cwd);

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: {
        planner: { provider: 'openai-codex', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: reviewerProvider, model: null },
      },
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath,
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return { state };
}

async function runRealPlanReviewAdjudication(state: Awaited<ReturnType<typeof createPlanReviewAdjudicationFixture>>['state']) {
  // No runReviewerRound injection: this drives the real rounds.ts ->
  // buildPlanReviewerPrompt -> getStructuredAdvisorAdapter path.
  return runPlanningReviewerAdjudication({
    state,
    round: 1,
    reviewMarkdownPath: state.reviewMarkdownPath,
    normalizedPlanPath: join(state.runDir, 'PLAN.normalized.md'),
    preparePlanReviewArtifact: async ({ planPath }) => ({
      executionShape: 'multi_scope' as const,
      reviewedPlanPath: planPath,
      originalPlanPath: planPath,
      validation: {
        ok: true,
        executionShape: 'multi_scope' as const,
        errors: [],
        normalization: { applied: false, operations: [], scopeLabelMappings: [] },
      },
    }),
    synthesizePlanReviewFindings: async (input) => ({
      executionShape: 'multi_scope' as const,
      reviewedPlanPath: input.planPath,
      findings: input.findings,
    }),
  });
}

test('plan-review prompt reaching a read-only structured advisor inlines the plan body without no-read context', async () => {
  const { state } = await createPlanReviewAdjudicationFixture('anthropic-claude');
  const captured = installCapturingPlanReviewAdvisor('anthropic-claude');

  await runRealPlanReviewAdjudication(state);

  assert.equal(captured.length, 1);
  const round = captured[0]!;
  assert.equal(round.label, 'plan-review');
  const prompt = round.prompt;

  assert.match(prompt, /Read .*REVIEW\.md before finalizing findings/);
  assert.match(prompt, /The reviewed plan content is inlined below; use your read-only file tools to inspect directly referenced companion docs and repository source files/);
  assert.match(prompt, /Reviewed plan content from Neal/);
  assert.ok(prompt.includes(PLAN_REVIEW_PLAN_SENTINEL), 'read-only plan-review prompt should inline the plan body');
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
  assert.equal(
    prompt.includes(PLAN_REVIEW_HISTORY_SENTINEL),
    false,
    'read-only plan-review prompt must not inline review history',
  );
});

test('derived plan-review prompt reaching a read-only structured advisor also inlines the parent plan content', async () => {
  const { state } = await createPlanReviewAdjudicationFixture('anthropic-claude');
  const derivedPlanPath = join(state.cwd, 'DERIVED_PLAN.md');
  await writeFile(derivedPlanPath, `# Derived Plan\n\n${PLAN_REVIEW_DERIVED_SENTINEL}\n`, 'utf8');
  const derivedState = {
    ...state,
    derivedPlanPath,
    derivedFromScopeNumber: 2,
    derivedPlanStatus: 'pending_review' as const,
    derivedScopeIndex: null,
  };
  const captured = installCapturingPlanReviewAdvisor('anthropic-claude');

  await runRealPlanReviewAdjudication(derivedState);

  assert.equal(captured.length, 1);
  const prompt = captured[0]!.prompt;

  assert.ok(prompt.includes(PLAN_REVIEW_DERIVED_SENTINEL), 'prompt should inline the derived plan content');
  assert.match(prompt, /Parent plan content from Neal/);
  assert.ok(prompt.includes(PLAN_REVIEW_PLAN_SENTINEL), 'prompt should inline the parent plan content');
  assert.doesNotMatch(prompt, /## Inlined review context from Neal/);
  assert.equal(
    prompt.includes(PLAN_REVIEW_HISTORY_SENTINEL),
    false,
    'derived plan-review prompt must not inline review history',
  );
});
