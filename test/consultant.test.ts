import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildConsultantPrompt,
  ReviewerRoundError,
  runConsultantRound,
  validateConsultantVerdictPayload,
} from '../src/neal/agents.js';
import { assertPromptBuilder, resolvePrimaryVariant } from '../src/neal/prompts/assert-builder.js';
import { getPromptSpec, type PromptSpec } from '../src/neal/prompts/specs.js';
import {
  CONSULTANT_ELIGIBLE_SOURCE_PHASES,
  buildRecentBlockCandidate,
  findRepeatedRecentBlock,
  runConsultant,
  upsertRecentBlock,
} from '../src/neal/adjudicator/consultant.js';
import {
  NO_READ_PROMPT_FORBIDDEN_MARKERS,
  type InlineReviewerContext,
} from '../src/neal/context/inline-review-context.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type {
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import { createInitialState } from '../src/neal/state.js';
import type { OrchestrationState, ReviewFinding, ReviewRound } from '../src/neal/types.js';

const CONSULTANT_PROVIDER = 'openai-compatible';

const PLAN_SENTINEL = 'Plan body sentinel: resolve the deadlock in scope.';
const FINDING_SENTINEL = 'Finding claim sentinel: reviewer wants stricter validation.';
const ROUND_SENTINEL = 'C1';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
});

function recoverableVerdict() {
  return {
    recoverable: true,
    triageCategory: 'misunderstanding' as const,
    resolutionDirective: 'Apply the validation requiredAction named in finding C1 within the existing scope.',
    targetCanonicalIds: ['C1'],
    rationale: 'The coder and reviewer disagree on an already-specified requirement.',
  };
}

function installConsultantAdvisor(provider: string, payload: unknown) {
  const captured: StructuredAdvisorRoundArgs[] = [];
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      captured.push(args as StructuredAdvisorRoundArgs);
      return { sessionHandle: null, structured: payload as TStructured };
    },
  };
  setProviderCapabilitiesOverrideForTesting(provider, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return captured;
}

function inlineContextFixture(): InlineReviewerContext {
  return {
    sections: [
      { title: 'Execution plan content', body: PLAN_SENTINEL },
      { title: 'Open blocking findings', body: FINDING_SENTINEL },
      { title: 'Recent reviewer-round snapshots', body: `round 1: openBlockingCanonicalIds: ${ROUND_SENTINEL}` },
    ],
  };
}

function assertNoForbiddenMarkers(prompt: string) {
  const lowered = prompt.toLowerCase();
  for (const marker of NO_READ_PROMPT_FORBIDDEN_MARKERS) {
    assert.equal(
      lowered.includes(marker.toLowerCase()),
      false,
      `consultant prompt must not contain forbidden marker: ${marker}`,
    );
  }
}

// (1) Validator: the recoverable-vs-genuine-wall split and rejection of malformed verdicts.
test('validateConsultantVerdictPayload accepts a recoverable misunderstanding with a non-empty directive', () => {
  const verdict = validateConsultantVerdictPayload(recoverableVerdict());
  assert.equal(verdict.recoverable, true);
  assert.equal(verdict.triageCategory, 'misunderstanding');
  assert.ok(verdict.resolutionDirective.trim().length > 0, 'recoverable verdict must carry a non-empty directive');
});

test('validateConsultantVerdictPayload accepts every non-recoverable genuine-wall triage', () => {
  for (const triageCategory of ['authorization', 'external_precondition', 'impossible_task'] as const) {
    const verdict = validateConsultantVerdictPayload({
      recoverable: false,
      triageCategory,
      resolutionDirective: '',
      targetCanonicalIds: [],
      rationale: `Genuine wall: ${triageCategory}.`,
    });
    assert.equal(verdict.recoverable, false);
    assert.equal(verdict.triageCategory, triageCategory);
  }
});

test('validateConsultantVerdictPayload rejects recoverable=true with an empty directive', () => {
  assert.throws(
    () => validateConsultantVerdictPayload({ ...recoverableVerdict(), resolutionDirective: '   ' }),
    /without a non-empty resolutionDirective/,
  );
});

test('validateConsultantVerdictPayload rejects recoverable=true with a triage other than misunderstanding', () => {
  assert.throws(
    () => validateConsultantVerdictPayload({ ...recoverableVerdict(), triageCategory: 'authorization' }),
    /triageCategory other than misunderstanding/,
  );
});

test('validateConsultantVerdictPayload rejects recoverable=false paired with misunderstanding', () => {
  assert.throws(
    () =>
      validateConsultantVerdictPayload({
        recoverable: false,
        triageCategory: 'misunderstanding',
        resolutionDirective: '',
        targetCanonicalIds: [],
        rationale: 'Inconsistent.',
      }),
    /recoverable=false paired with triageCategory=misunderstanding/,
  );
});

test('validateConsultantVerdictPayload rejects an empty rationale', () => {
  assert.throws(
    () => validateConsultantVerdictPayload({ ...recoverableVerdict(), rationale: '  ' }),
    /empty rationale/,
  );
});

test('validateConsultantVerdictPayload defaults an omitted targetCanonicalIds to []', () => {
  const { targetCanonicalIds: _omitted, ...withoutIds } = recoverableVerdict();
  const verdict = validateConsultantVerdictPayload(withoutIds);
  assert.deepEqual(verdict.targetCanonicalIds, [], 'an absent targetCanonicalIds must default to []');
  assert.equal(verdict.recoverable, true);
});

// (2) Prompt builder: inlines the plan/findings/rounds context and its static
// instructions carry no repository-access phrasing.
test('buildConsultantPrompt inlines the context sections and contains no forbidden repository-access phrasing', () => {
  const prompt = buildConsultantPrompt({
    blockedReason: 'review_stuck: reviewer and coder disagree on validation strictness',
    inlineContext: inlineContextFixture(),
  });

  assert.ok(prompt.includes(PLAN_SENTINEL), 'prompt should inline the plan section');
  assert.ok(prompt.includes(FINDING_SENTINEL), 'prompt should inline the open blocking findings section');
  assert.ok(prompt.includes(ROUND_SENTINEL), 'prompt should inline the reviewer-round snapshot section');
  assert.match(prompt, /You do not have repository, file, shell, or tool access of any kind for this review\./);
  assert.match(prompt, /review_stuck: reviewer and coder disagree on validation strictness/);
  assert.match(prompt, /recoverable misunderstanding/);
  assertNoForbiddenMarkers(prompt);
});

// (2b) The generalized prompt carries no reviewer-deadlock-specific framing when
// built for a coder eligible block, and inlines whatever sections it is given.
test('buildConsultantPrompt for a coder block carries no review_stuck/deadlock-specific framing', () => {
  // Use section bodies free of review_stuck/deadlock wording so the assertions
  // probe only the Neal-authored static framing, not inlined dynamic content.
  const CODER_PLAN_SENTINEL = 'Plan body sentinel: implement the new module in scope.';
  const prompt = buildConsultantPrompt({
    blockedReason: 'Coder cannot finish the scope: the new module fails to compile and the in-scope fix is unclear.',
    inlineContext: {
      sections: [
        { title: 'Execution plan content', body: CODER_PLAN_SENTINEL },
        { title: 'Coder blocker summary', body: 'compile failure in the new module' },
        { title: 'Changed files since scope base', body: '- src/feature.ts' },
      ],
    },
  });

  const lowered = prompt.toLowerCase();
  assert.equal(lowered.includes('review_stuck'), false, 'generic prompt framing must not mention review_stuck');
  assert.equal(lowered.includes('deadlock'), false, 'generic prompt framing must not mention deadlock');
  assert.ok(prompt.includes(CODER_PLAN_SENTINEL), 'prompt still inlines the supplied plan section');
  assert.ok(prompt.includes('compile failure in the new module'), 'prompt inlines the supplied coder blocker section');
  assert.match(prompt, /You do not have repository, file, shell, or tool access of any kind for this review\./);
  assertNoForbiddenMarkers(prompt);
});

// (2c) Golden byte-identity: the complete consultant render for fixed args equals
// the pre-registration golden captured before the prompt-registry wiring, proving
// registration changed no rendered bytes (ALL-CAPS emphasis lines included).
test('buildConsultantPrompt renders byte-for-byte identically to the pre-registration golden', async () => {
  const rendered = buildConsultantPrompt({
    blockedReason: 'review_stuck: reviewer and coder disagree on validation strictness',
    inlineContext: inlineContextFixture(),
  });
  const golden = await readFile(
    fileURLToPath(new URL('./fixtures/prompts/agents/consultant.expected.txt', import.meta.url)),
    'utf8',
  );
  assert.equal(rendered, golden);
});

// (2d) Prompt-registry governance parity: the spec binds the builder, and the
// self-binding call would catch an export-name or module-path drift.
test('consultant spec binds buildConsultantPrompt and rejects a wrong export or module path', () => {
  assert.doesNotThrow(() =>
    assertPromptBuilder('consultant', 'buildConsultantPrompt', 'src/neal/agents/prompts.ts'),
  );
  assert.throws(
    () => assertPromptBuilder('consultant', 'buildSomethingElse', 'src/neal/agents/prompts.ts'),
    /does not expose builder buildSomethingElse/,
  );
  assert.throws(
    () => assertPromptBuilder('consultant', 'buildConsultantPrompt', 'src/neal/prompts/specialized.ts'),
    /still points buildConsultantPrompt at src\/neal\/agents\/prompts\.ts/,
  );
});

// (2e) The primary-variant resolver enforces the exact kind === 'primary' predicate
// and the missing-primary throw path.
test('resolvePrimaryVariant returns the primary variant and throws when none is present', () => {
  const primary = resolvePrimaryVariant(getPromptSpec('consultant'), 'consultant');
  assert.equal(primary.kind, 'primary');
  assert.throws(
    () => resolvePrimaryVariant({ variants: [] } as unknown as PromptSpec, 'x'),
    /Prompt spec x is missing a primary variant/,
  );
  assert.throws(
    () => resolvePrimaryVariant({ variants: [{ kind: 'response' }] } as unknown as PromptSpec, 'x'),
    /Prompt spec x is missing a primary variant/,
  );
});

function stripSourceComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// (2f) Wiring contract: the self-binding and primary-variant calls live in the
// consultant builder body itself, not a neighboring helper. Isolate only the
// buildConsultantPrompt body (stopping at the next top-level function,
// which is the non-exported getReviewerContextLines) and strip comments first so
// a commented-out or relocated call cannot satisfy the assertions.
test('buildConsultantPrompt body self-binds via assertPromptBuilder and resolvePrimaryVariant', async () => {
  const source = await readFile(fileURLToPath(new URL('../src/neal/agents/prompts.ts', import.meta.url)), 'utf8');
  const declaration = 'export function buildConsultantPrompt';
  const startIndex = source.indexOf(declaration);
  assert.notEqual(startIndex, -1, 'the consultant builder declaration must exist');
  const afterStart = startIndex + declaration.length;
  const nextMatch = source.slice(afterStart).match(/\n(export )?function /);
  const endIndex = nextMatch ? afterStart + nextMatch.index! : source.length;
  const body = stripSourceComments(source.slice(startIndex, endIndex));

  assert.ok(
    body.includes(
      "assertPromptBuilder('consultant', 'buildConsultantPrompt', 'src/neal/agents/prompts.ts')",
    ),
    'the consultant builder body must self-bind via assertPromptBuilder with its exact id/export/module',
  );
  assert.match(body, /resolvePrimaryVariant\([^)]*'consultant'/);
});

// (3) The no-read guard fires at the real call boundary, and a non-null context clears it.
test('runConsultantRound rejects a no-read reviewer with a null inline context before contacting the adapter', async () => {
  const captured = installConsultantAdvisor(CONSULTANT_PROVIDER, recoverableVerdict());

  await assert.rejects(
    () =>
      runConsultantRound({
        reviewer: { provider: CONSULTANT_PROVIDER, model: null },
        cwd: process.cwd(),
        blockedReason: 'review_stuck: deadlock',
        inlineContext: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewerRoundError, 'guard must throw ReviewerRoundError');
      assert.equal(error.kind, 'provider_failed');
      assert.equal(error.retryable, false);
      assert.equal(error.sessionHandle, null);
      return true;
    },
  );

  assert.equal(captured.length, 0, 'no prompt may reach the structured advisor for a guarded no-read round');
});

test('runConsultantRound with a non-null inline context clears the guard and returns the validated verdict', async () => {
  const captured = installConsultantAdvisor(CONSULTANT_PROVIDER, recoverableVerdict());

  const result = await runConsultantRound({
    reviewer: { provider: CONSULTANT_PROVIDER, model: null },
    cwd: process.cwd(),
    blockedReason: 'review_stuck: deadlock',
    inlineContext: inlineContextFixture(),
  });

  assert.equal(captured.length, 1, 'a non-null inline context must reach the mocked structured advisor');
  assert.equal(captured[0]!.label, 'consultant');
  assert.equal(result.verdict.recoverable, true);
  assert.equal(result.verdict.triageCategory, 'misunderstanding');
});

async function createConsultantStateFixture(reviewerProvider: string): Promise<OrchestrationState> {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-consultant-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'consultant-run');
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, `# Plan\n\n${PLAN_SENTINEL}\n`, 'utf8');

  const findings: ReviewFinding[] = [
    {
      id: 'F1',
      canonicalId: 'C1',
      round: 1,
      source: 'reviewer',
      severity: 'blocking',
      files: ['feature.ts'],
      claim: FINDING_SENTINEL,
      evidence: null,
      requiredAction: 'Add the stricter validation the reviewer expects.',
      status: 'open',
      roundSummary: 'Round 1 summary.',
      coderDisposition: 'Coder believes the validation is already sufficient.',
      coderCommit: null,
    },
    {
      id: 'F2',
      canonicalId: 'C2',
      round: 1,
      source: 'reviewer',
      severity: 'non_blocking',
      files: [],
      claim: 'A non-blocking nit that must not be inlined as blocking.',
      evidence: null,
      requiredAction: 'Optional polish.',
      status: 'open',
      roundSummary: 'Round 1 summary.',
      coderDisposition: null,
      coderCommit: null,
    },
  ];

  const rounds: ReviewRound[] = [
    {
      round: 1,
      reviewerSessionHandle: null,
      reviewedPlanPath: null,
      normalizationApplied: false,
      normalizationOperations: [],
      normalizationScopeLabelMappings: [],
      commitRange: { base: 'base', head: 'head' },
      openBlockingCanonicalCount: 1,
      openBlockingCanonicalIds: [ROUND_SENTINEL],
      findings: ['C1'],
    },
  ];

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
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 5,
    },
    '1111111111111111111111111111111111111111',
  );

  return { ...state, findings, rounds };
}

// Complementary unit check: the consultant always builds a non-null context, so
// even a no-read reviewer never trips the guard, and only the still-open
// blocking findings are inlined.
test('runConsultant inlines plan + open blocking findings for a no-read reviewer and returns the verdict', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const captured = installConsultantAdvisor(CONSULTANT_PROVIDER, recoverableVerdict());

  const verdict = await runConsultant(state, 'review_stuck: reviewer and coder disagree', 'reviewer_scope');

  assert.equal(captured.length, 1, 'the consultant must reach the mocked structured advisor without tripping the guard');
  const prompt = captured[0]!.prompt;
  assert.equal(captured[0]!.label, 'consultant');
  assert.ok(prompt.includes(PLAN_SENTINEL), 'prompt should inline the plan content');
  assert.ok(prompt.includes(FINDING_SENTINEL), 'prompt should inline the open blocking finding claim');
  assert.ok(prompt.includes('C1'), 'prompt should inline the open blocking finding canonical id');
  assert.equal(
    prompt.includes('A non-blocking nit that must not be inlined as blocking.'),
    false,
    'non-blocking findings must not be inlined',
  );
  assertNoForbiddenMarkers(prompt);
  assert.equal(verdict.recoverable, true);
  assert.equal(verdict.triageCategory, 'misunderstanding');
});

// --- Eligibility set ---------------------------------------------------------------
test('CONSULTANT_ELIGIBLE_SOURCE_PHASES covers exactly the three triaged block classes', () => {
  assert.deepEqual(
    [...CONSULTANT_ELIGIBLE_SOURCE_PHASES].sort(),
    ['coder_optional_response', 'coder_response', 'coder_scope', 'reviewer_plan', 'reviewer_scope'],
  );
});

// --- Pure anti-thrash helpers ------------------------------------------------------
// Every candidate below is built via the PRODUCTION builder
// (`buildRecentBlockCandidate`), never a hand-built literal: a hand-built
// fingerprint can assert an escape the production builder is incapable of
// producing, which is exactly the gap that let the dead-escape bug ship.
const CODER_BLOCK_REASON = 'Coder cannot finish the scope: the helper crashes at startup.';

function withCommits(state: OrchestrationState, createdCommits: string[]): OrchestrationState {
  return { ...state, createdCommits };
}

test('findRepeatedRecentBlock matches only on the same scope identity + sourcePhase + normalized key', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const window = upsertRecentBlock(
    [],
    buildRecentBlockCandidate(state, CODER_BLOCK_REASON, 'coder_scope'),
    '2026-01-01T00:00:00.000Z',
  );
  const existing = window[0]!;

  assert.equal(
    findRepeatedRecentBlock(window, buildRecentBlockCandidate(state, CODER_BLOCK_REASON, 'coder_scope')),
    existing,
    'an exact identity match repeats',
  );
  assert.equal(
    findRepeatedRecentBlock(
      window,
      buildRecentBlockCandidate(
        { ...state, currentScopeNumber: state.currentScopeNumber + 1 },
        CODER_BLOCK_REASON,
        'coder_scope',
      ),
    ),
    null,
    'a different scopeNumber is not a repeat',
  );
  assert.equal(
    findRepeatedRecentBlock(
      window,
      buildRecentBlockCandidate({ ...state, derivedScopeIndex: 1 }, CODER_BLOCK_REASON, 'coder_scope'),
    ),
    null,
    'a non-null derivedScopeIndex is not a repeat of a null one',
  );
  assert.equal(
    findRepeatedRecentBlock(window, buildRecentBlockCandidate(state, CODER_BLOCK_REASON, 'coder_response')),
    null,
    'a different sourcePhase is not a repeat',
  );
  assert.equal(
    findRepeatedRecentBlock(window, buildRecentBlockCandidate(state, 'A different blocker entirely.', 'coder_scope')),
    null,
    'a different normalized key is not a repeat',
  );
});

test('findRepeatedRecentBlock treats commits landed since the recorded block as materially new evidence', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const blockedState = withCommits(state, ['a'.repeat(40)]);
  const window = upsertRecentBlock(
    [],
    buildRecentBlockCandidate(blockedState, CODER_BLOCK_REASON, 'coder_scope'),
    '2026-01-01T00:00:00.000Z',
  );

  assert.equal(
    findRepeatedRecentBlock(window, buildRecentBlockCandidate(blockedState, CODER_BLOCK_REASON, 'coder_scope')),
    window[0],
    'the identical blocker with an unchanged commit trail repeats',
  );

  const progressedState = withCommits(blockedState, [...blockedState.createdCommits, 'b'.repeat(40)]);
  assert.equal(
    findRepeatedRecentBlock(window, buildRecentBlockCandidate(progressedState, CODER_BLOCK_REASON, 'coder_scope')),
    null,
    'new commits since the recorded block are new evidence, so the identical blocker is NOT a repeat',
  );

  // The escape is one-shot per commit-trail advance: recording the progressed
  // block appends a fresh record that re-arms the guard, so a further identical
  // block with NO further commits short-circuits again.
  const rearmed = upsertRecentBlock(
    window,
    buildRecentBlockCandidate(progressedState, CODER_BLOCK_REASON, 'coder_scope'),
    '2026-01-02T00:00:00.000Z',
  );
  assert.equal(rearmed.length, 2, 'the new-evidence block is recorded as a fresh record');
  assert.equal(
    findRepeatedRecentBlock(rearmed, buildRecentBlockCandidate(progressedState, CODER_BLOCK_REASON, 'coder_scope')),
    rearmed[1],
    'an identical blocker with no further commits repeats against the fresh record',
  );
});

test('upsertRecentBlock appends a new record and increments count on an exact match', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const candidate = buildRecentBlockCandidate(state, CODER_BLOCK_REASON, 'coder_scope');

  const appended = upsertRecentBlock([], candidate, '2026-02-02T00:00:00.000Z');
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.count, 1);
  assert.equal(appended[0]!.recordedAt, '2026-02-02T00:00:00.000Z');
  assert.equal(appended[0]!.normalizedKey, candidate.normalizedKey);

  const incremented = upsertRecentBlock(
    appended,
    buildRecentBlockCandidate(state, CODER_BLOCK_REASON, 'coder_scope'),
    '2026-03-03T00:00:00.000Z',
  );
  assert.equal(incremented.length, 1, 'an exact match must not append a second record');
  assert.equal(incremented[0]!.count, 2, 'an exact match increments count');
  assert.equal(incremented[0]!.recordedAt, '2026-03-03T00:00:00.000Z', 'an exact match refreshes recordedAt');
  // Purity: the input array is untouched.
  assert.equal(appended[0]!.count, 1);

  const distinct = upsertRecentBlock(
    appended,
    buildRecentBlockCandidate(
      { ...state, currentScopeNumber: state.currentScopeNumber + 1 },
      CODER_BLOCK_REASON,
      'coder_scope',
    ),
    '2026-04-04T00:00:00.000Z',
  );
  assert.equal(distinct.length, 2, 'a different scope identity appends a separate record');
});

// --- Read-path short-circuit -------------------------------------------------------
test('runConsultant short-circuits to recoverable:false on a same-identity seeded repeat without invoking the advisor', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const captured = installConsultantAdvisor(CONSULTANT_PROVIDER, recoverableVerdict());
  const reason = 'review_stuck: reviewer and coder disagree';
  const seededState: OrchestrationState = {
    ...state,
    recentBlocks: upsertRecentBlock(
      [],
      buildRecentBlockCandidate(state, reason, 'reviewer_scope'),
      '2026-01-01T00:00:00.000Z',
    ),
  };

  const verdict = await runConsultant(seededState, reason, 'reviewer_scope');

  assert.equal(captured.length, 0, 'a seeded same-identity repeat must NOT invoke the reviewer round');
  assert.equal(verdict.recoverable, false);
  assert.equal(verdict.triageCategory, 'impossible_task');
  assert.equal(verdict.resolutionDirective, '');
});

test('runConsultant proceeds to a reviewer round when the seeded record is under a different scope identity', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const captured = installConsultantAdvisor(CONSULTANT_PROVIDER, recoverableVerdict());
  const reason = 'review_stuck: reviewer and coder disagree';
  const seededState: OrchestrationState = {
    ...state,
    recentBlocks: upsertRecentBlock(
      [],
      buildRecentBlockCandidate(
        { ...state, currentScopeNumber: state.currentScopeNumber + 1 },
        reason,
        'reviewer_scope',
      ),
      '2026-01-01T00:00:00.000Z',
    ),
  };

  const verdict = await runConsultant(seededState, reason, 'reviewer_scope');

  assert.equal(captured.length, 1, 'a different-scope seed must proceed to the reviewer round');
  assert.equal(verdict.recoverable, true);
  assert.equal(verdict.triageCategory, 'misunderstanding');
});

// The exact production failure the "new evidence" escape exists for: an
// unattended coder blocks twice with identically worded blocker text for
// genuinely DIFFERENT underlying causes, having committed work in between (the
// coder phases append the blocked round's commits before the recovery chokepoint
// runs). The commit-trail fingerprint makes the second block a non-repeat, so
// the consultant RUNS instead of short-circuiting the run to a terminal
// impossible_task without ever looking.
test('runConsultant runs a reviewer round for an identically worded repeat when new commits landed since the recorded block', async () => {
  const state = await createConsultantStateFixture(CONSULTANT_PROVIDER);
  const captured = installConsultantAdvisor(CONSULTANT_PROVIDER, recoverableVerdict());
  const blockedState = withCommits(state, ['a'.repeat(40)]);
  const progressedState: OrchestrationState = {
    ...withCommits(blockedState, [...blockedState.createdCommits, 'b'.repeat(40)]),
    recentBlocks: upsertRecentBlock(
      [],
      buildRecentBlockCandidate(blockedState, CODER_BLOCK_REASON, 'coder_scope'),
      '2026-01-01T00:00:00.000Z',
    ),
  };

  const verdict = await runConsultant(progressedState, CODER_BLOCK_REASON, 'coder_scope');

  assert.equal(captured.length, 1, 'commit-trail evidence must reach the reviewer round instead of short-circuiting');
  assert.equal(verdict.recoverable, true);
  assert.equal(verdict.triageCategory, 'misunderstanding');
});
