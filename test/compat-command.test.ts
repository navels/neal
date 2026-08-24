import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  buildRoleRollups,
  classifyNonAcceptedReviewOutcome,
  classifyReviewerThrownFailure,
  classifyWriterFailure,
  countBlockingFindings,
  deriveCandidateConfig,
  describeReferenceProvider,
  evaluateCoderFixture,
  evaluatePlannerFixture,
  evaluateReviewerFixture,
  formatCompatJson,
  formatCompatTable,
  getCompatExamplesDir,
  isOpenAICompatibleProvider,
  isOperatorStopFinalState,
  loadCompatManifest,
  parseCompatArgs,
  rolesForSelection,
  runCompat,
  runCompatCli,
  summarizeBlockingFindings,
  type CompatFixture,
  type CompatManifest,
  type CompatReport,
} from '../src/neal/commands/compat.js';
import { clearConfigCache, getNotifyBin } from '../src/neal/config.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import type {
  ReviewFindingsDraft,
  ReviewFindingsProviderAdapter,
  ReviewFindingsReview,
  ReviewFindingsRunResult,
} from '../src/neal/review-findings/types.js';
import { CoderRoundError } from '../src/neal/agents/structured-coder.js';
import { NealProviderError } from '../src/neal/providers/types.js';
import type { AgentConfig, OrchestrationState } from '../src/neal/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { runGit } from './helpers/git.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-compat');
// The suite-wide NEAL_NOTIFY_BIN= kill switch keeps these hermetic.

const compatDir = getCompatExamplesDir();

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    callback();
  }

  text() {
    return this.chunks.join('');
  }
}

function fakeConfig(provider: string): AgentConfig {
  return {
    planner: { provider, model: null },
    coder: { provider, model: null },
    reviewer: { provider, model: null },
  };
}

function getFixture(manifest: CompatManifest, id: string): CompatFixture {
  const fixture = manifest.fixtures.find((entry) => entry.id === id);
  assert.ok(fixture, `expected fixture ${id} in the bundled manifest`);
  return fixture;
}

const doneCoderResponse = {
  action: 'done',
  message: 'Applied the smallest complete fix.',
  progress: {
    milestoneTargeted: 'Fix the bundled compat fixture.',
    newEvidence: 'The coder applied the reference change and committed it.',
    whyNotRedundant: 'This is the only scope for the one_shot fixture.',
    nextStepUnlocked: 'The run can finalize cleanly.',
  },
  manualGate: null,
  derivedPlan: '',
  blockedReason: '',
};

const scopeReviewAccept = {
  summary: 'The scope is complete and verified.',
  findings: [],
  meaningfulProgressAction: 'accept',
  meaningfulProgressRationale: 'The coder delivered the bounded fix for this one_shot scope.',
};

const finalCompletionSummary = {
  planGoalSatisfied: true,
  whatChangedOverall: 'Fixed the bundled compat fixture so its test passes.',
  verificationSummary: 'The fixture verifyCommand exercises the change.',
  remainingKnownGaps: [],
};

const finalCompletionAccept = {
  action: 'accept_complete',
  summary: 'The compat fixture run is complete.',
  rationale: 'The coder delivered the reference fix and the run finalized.',
  missingWork: null,
  squashCommitMessage: {
    subject: 'Fix bundled compat fixture',
    bullets: ['Apply the reference fix.', 'Confirm the fixture test passes.'],
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseCompatArgs parses model/role/reference/json with defaults', () => {
  assert.deepEqual(parseCompatArgs(['compat']), {
    model: null,
    role: 'all',
    reference: null,
    json: false,
  });
  assert.deepEqual(
    parseCompatArgs(['compat', '--model', 'deepseek/x', '--role', 'reviewer', '--reference', 'openai-codex', '--json']),
    { model: 'deepseek/x', role: 'reviewer', reference: 'openai-codex', json: true },
  );
  assert.throws(() => parseCompatArgs(['compat', '--role', 'nonsense']), /--role must be one of/);
  assert.throws(() => parseCompatArgs(['compat', '--model']), /--model requires a non-empty value/);
  assert.throws(() => parseCompatArgs(['compat', '--bogus']), /Unknown argument/);
  assert.throws(
    () => parseCompatArgs(['compat', '--reference', 'gpt']),
    /--reference must be a native provider id \(openai-codex or anthropic-claude\)/,
  );
  // openai-compatible:<slug> reference is accepted (a validated OpenRouter partner).
  assert.equal(
    parseCompatArgs(['compat', '--reference', 'openai-compatible:deepseek/deepseek-v4-flash']).reference,
    'openai-compatible:deepseek/deepseek-v4-flash',
  );
  assert.throws(
    () => parseCompatArgs(['compat', '--reference', 'other-provider:foo']),
    /must be openai-compatible:<openrouter-model>/,
  );
  assert.throws(
    () => parseCompatArgs(['compat', '--reference', 'openai-compatible:  ']),
    /must be openai-compatible:<openrouter-model>/,
  );
});

test('isOpenAICompatibleProvider treats only native adapters as native', () => {
  assert.equal(isOpenAICompatibleProvider('openai-codex'), false);
  assert.equal(isOpenAICompatibleProvider('anthropic-claude'), false);
  assert.equal(isOpenAICompatibleProvider('openai-compatible'), true);
});

test('deriveCandidateConfig routes tested role to openai-compatible and reference roles to native', () => {
  const base = fakeConfig('anthropic-claude');
  const candidate = deriveCandidateConfig(base, {
    testedRole: 'reviewer',
    model: 'cand',
    reference: 'openai-codex',
  });
  // Tested role forced onto openai-compatible with the candidate slug.
  assert.deepEqual(candidate.reviewer, { provider: 'openai-compatible', model: 'cand' });
  // Non-tested roles routed onto the native reference adapter + default model.
  assert.deepEqual(candidate.coder, { provider: 'openai-codex', model: 'gpt-5.5' });
  assert.deepEqual(candidate.planner, { provider: 'openai-codex', model: 'gpt-5.5' });
  // Base config is not mutated.
  assert.equal(base.reviewer.provider, 'anthropic-claude');
  assert.equal(base.reviewer.model, null);

  // Neither flag given → pure pass-through, every role unchanged.
  const passthrough = deriveCandidateConfig(base, { testedRole: 'coder', model: null, reference: null });
  assert.deepEqual(passthrough.coder, { provider: 'anthropic-claude', model: null });
  assert.deepEqual(passthrough.reviewer, { provider: 'anthropic-claude', model: null });
  assert.deepEqual(passthrough.planner, { provider: 'anthropic-claude', model: null });
});

test('deriveCandidateConfig routes reference roles onto an openai-compatible OpenRouter reference', () => {
  const base = fakeConfig('anthropic-claude');
  const candidate = deriveCandidateConfig(base, {
    testedRole: 'reviewer',
    model: 'cand',
    reference: 'openai-compatible:deepseek/deepseek-v4-flash',
  });
  // Tested role: the candidate slug on openai-compatible.
  assert.deepEqual(candidate.reviewer, { provider: 'openai-compatible', model: 'cand' });
  // Non-tested roles: the validated OpenRouter reference model, also on openai-compatible.
  assert.deepEqual(candidate.coder, { provider: 'openai-compatible', model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(candidate.planner, { provider: 'openai-compatible', model: 'deepseek/deepseek-v4-flash' });
});

test('rolesForSelection expands all to coder/reviewer/planner', () => {
  assert.deepEqual(rolesForSelection('all'), ['coder', 'reviewer', 'planner']);
  assert.deepEqual(rolesForSelection('reviewer'), ['reviewer']);
});

// A minimal OrchestrationState carrying just the fields the operator-stop
// derivation reads (mirrors test/writer-exit-codes.test.ts).
function makeFinalState(overrides: Partial<OrchestrationState>): OrchestrationState {
  return {
    topLevelMode: 'execute',
    derivedPlanPath: null,
    status: 'failed',
    phase: 'coder_scope',
    pendingPlanReviewGuidance: null,
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
    manualGate: null,
    rounds: [],
    findings: [],
    maxRounds: 5,
    ...overrides,
  } as OrchestrationState;
}

// Site A's operator-wait shape: status stays 'running' while the run waits in
// interactive blocked recovery for `neal resume --message`.
function makeInteractiveRecoveryWaitState(): OrchestrationState {
  return makeFinalState({
    status: 'running',
    phase: 'interactive_blocked_recovery',
    interactiveBlockedRecovery: {
      enteredAt: '2026-08-24T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
    },
  });
}

test('classifyWriterFailure maps run state to taxonomy modes by precedence', () => {
  assert.equal(
    classifyWriterFailure({
      finalState: makeFinalState({}),
      events: [{ type: 'provider.provider_error' }],
      threwDuringRun: false,
    }),
    'provider_failed',
  );
  // provider_failed wins over block_unresolved per the taxonomy ordering.
  assert.equal(
    classifyWriterFailure({
      finalState: makeFinalState({ status: 'blocked', phase: 'blocked' }),
      events: [{ type: 'provider.provider_error' }],
      threwDuringRun: false,
    }),
    'provider_failed',
  );
  assert.equal(
    classifyWriterFailure({ finalState: makeFinalState({}), events: [{ type: 'phase.error' }], threwDuringRun: false }),
    'structured_output',
  );
  assert.equal(classifyWriterFailure({ finalState: null, events: [], threwDuringRun: true }), 'finalization_error');
  assert.equal(classifyWriterFailure({ finalState: null, events: [], threwDuringRun: false }), 'finalization_error');
  assert.equal(classifyWriterFailure({ finalState: makeFinalState({}), events: [], threwDuringRun: false }), 'provider_failed');
});

test('classifyWriterFailure derives block_unresolved from each final operator-stop shape', () => {
  // Site A: the interactive-recovery wait keeps status 'running' but is
  // structurally waiting for the operator.
  assert.equal(
    classifyWriterFailure({ finalState: makeInteractiveRecoveryWaitState(), events: [], threwDuringRun: false }),
    'block_unresolved',
  );
  // Sites B/C: a direct blocked save.
  assert.equal(
    classifyWriterFailure({
      finalState: makeFinalState({ status: 'blocked', phase: 'blocked' }),
      events: [],
      threwDuringRun: false,
    }),
    'block_unresolved',
  );
  // A pending-guidance view (guidance recorded but not yet consumed) is an
  // operator stop even though status is 'running'.
  assert.equal(
    classifyWriterFailure({
      finalState: makeFinalState({
        topLevelMode: 'plan',
        status: 'running',
        phase: 'coder_plan_response',
        blockedFromPhase: 'reviewer_plan',
        pendingPlanReviewGuidance: {
          message: 'Tighten the scope before continuing.',
          sourcePhase: 'reviewer_plan',
          recordedAt: '2026-08-24T00:00:00.000Z',
        },
      }),
      events: [],
      threwDuringRun: false,
    }),
    'block_unresolved',
  );
  // A plain failure (no operator-stop shape) is not an operator stop.
  assert.equal(isOperatorStopFinalState(makeFinalState({})), false);
  assert.equal(isOperatorStopFinalState(makeFinalState({ status: 'done', phase: 'done' })), false);
});

test('classifyWriterFailure attributes coder structured-output errorKinds to structured_output', () => {
  // Schema failures named by the provider error route to structured_output,
  // matching the reviewer path, instead of collapsing to provider_failed.
  for (const kind of ['structured_output_invalid', 'structured_output_missing'] as const) {
    assert.equal(
      classifyWriterFailure({
        finalState: makeFinalState({}),
        events: [{ type: 'provider.provider_error', data: { errorKind: kind } }],
        threwDuringRun: false,
      }),
      'structured_output',
      `${kind} -> structured_output`,
    );
  }
  // Non-structured provider errors stay provider_failed.
  for (const kind of ['api_error', 'timeout', 'permission_denied', 'provider_failed'] as const) {
    assert.equal(
      classifyWriterFailure({
        finalState: makeFinalState({}),
        events: [{ type: 'provider.provider_error', data: { errorKind: kind } }],
        threwDuringRun: false,
      }),
      'provider_failed',
      `${kind} -> provider_failed`,
    );
  }
  // A provider error with no errorKind keeps the generic provider_failed mapping.
  assert.equal(
    classifyWriterFailure({
      finalState: makeFinalState({}),
      events: [{ type: 'provider.provider_error' }],
      threwDuringRun: false,
    }),
    'provider_failed',
  );
});

test('classifyNonAcceptedReviewOutcome maps review outcomes to compat modes', () => {
  assert.equal(classifyNonAcceptedReviewOutcome('blocked'), 'block_unresolved');
  assert.equal(classifyNonAcceptedReviewOutcome('cap_reached'), 'max_step_loop');
  assert.equal(classifyNonAcceptedReviewOutcome('failed'), 'structured_output');
});

test('loadCompatManifest reads and validates the bundled manifest', () => {
  const manifest = loadCompatManifest();
  assert.ok(manifest.fixtures.length >= 3);
  const coder = manifest.fixtures.filter((fixture) => fixture.roles.includes('coder'));
  assert.ok(coder.length >= 2);
  for (const fixture of coder) {
    assert.ok(fixture.planDoc, `${fixture.id} coder fixture must define planDoc`);
    assert.ok(fixture.verifyCommand, `${fixture.id} coder fixture must define verifyCommand`);
  }
});

// ---------------------------------------------------------------------------
// Coder fixture — mandatory no-network integration coverage
// ---------------------------------------------------------------------------

test('evaluateCoderFixture drives the real throwaway run and PASSes when the fix is applied', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  const sourcePath = join(compatDir, fixture.projectDir, 'src', 'add.js');
  const sourceBefore = await readFile(sourcePath, 'utf8');

  const providerId = 'fake-compat-coder-pass';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderStructuredResponses: [doneCoderResponse],
      structuredAdvisorResponses: [scopeReviewAccept, finalCompletionSummary, finalCompletionAccept],
      onCoderStructuredRun: async (args) => {
        // The fake coder applies + commits the reference fix in the throwaway.
        const file = join(args.cwd, 'src', 'add.js');
        const contents = await readFile(file, 'utf8');
        await writeFile(file, contents.replace('a - b', 'a + b'), 'utf8');
        await runGit(args.cwd, 'add', '-A');
        await runGit(args.cwd, 'commit', '-m', 'apply reference fix');
      },
    }),
  );

  let prepared: { throwawayCwd: string; runDir: string; planDoc: string } | null = null;
  try {
    const { cell, run } = await evaluateCoderFixture({
      compatDir,
      fixture,
      candidateConfig: fakeConfig(providerId),
      onPrepared: (info) => {
        prepared = info;
      },
    });

    assert.equal(cell.pass, true, `expected coder PASS, got ${JSON.stringify(cell)}`);
    assert.equal(cell.failureMode, null);
    assert.equal(run.finalStatus, 'done');
    assert.equal(run.verifyExitCode, 0);
    const preparedInfo = prepared as { throwawayCwd: string; runDir: string; planDoc: string } | null;
    assert.ok(preparedInfo, 'onPrepared should have been called');
    assert.notEqual(preparedInfo.throwawayCwd, process.cwd());
    assert.ok(preparedInfo.runDir.startsWith(preparedInfo.throwawayCwd), 'runDir must live under the throwaway cwd');
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }

  // The committed fixture is never mutated by the run.
  assert.equal(await readFile(sourcePath, 'utf8'), sourceBefore);
});

test('evaluateCoderFixture FAILs wrong_or_empty_output when the run completes without fixing', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');

  const providerId = 'fake-compat-coder-noop';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderStructuredResponses: [doneCoderResponse],
      structuredAdvisorResponses: [scopeReviewAccept, finalCompletionSummary, finalCompletionAccept],
      onCoderStructuredRun: async (args) => {
        // Commit a no-op comment change so the scope review runs, but never fix
        // the bug: the run completes yet the verifyCommand still fails.
        const file = join(args.cwd, 'src', 'add.js');
        const contents = await readFile(file, 'utf8');
        await writeFile(file, `${contents}// touched without fixing the bug\n`, 'utf8');
        await runGit(args.cwd, 'add', '-A');
        await runGit(args.cwd, 'commit', '-m', 'touch without fixing');
      },
    }),
  );

  try {
    const { cell, run } = await evaluateCoderFixture({ compatDir, fixture, candidateConfig: fakeConfig(providerId) });
    assert.equal(run.finalStatus, 'done');
    assert.equal(cell.pass, false);
    assert.equal(cell.failureMode, 'wrong_or_empty_output');
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// ---------------------------------------------------------------------------
// Planner fixture (secondary)
// ---------------------------------------------------------------------------

test('evaluatePlannerFixture PASSes when the planner emits a schema-conformant one_shot plan', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'plan-greeting');

  const providerId = 'fake-compat-planner';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderStructuredResponses: [
        {
          action: 'ready_for_review',
          message: 'Drafted the one_shot plan.',
          executionShape: 'one_shot',
          planBody: '# Greeting fix plan\n\n## Goal\n\nReturn `Hello, <name>!` from greet().\n',
          blockedReason: '',
        },
      ],
      structuredAdvisorResponses: [
        { summary: 'Plan review converged.', executionShape: 'one_shot', findings: [] },
      ],
    }),
  );

  try {
    const { cell, run } = await evaluatePlannerFixture({ compatDir, fixture, candidateConfig: fakeConfig(providerId) });
    assert.equal(run.finalStatus, 'done', `planner run did not complete: ${run.errorMessage ?? ''}`);
    assert.equal(cell.pass, true, `expected planner PASS, got ${JSON.stringify(cell)}`);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// ---------------------------------------------------------------------------
// Reviewer fixture — attribution + scoring
// ---------------------------------------------------------------------------

class ScriptedReviewAdapter implements ReviewFindingsProviderAdapter {
  constructor(
    private readonly draftFor: (diff: string) => ReviewFindingsDraft,
    private readonly review: ReviewFindingsReview = {
      verdict: 'accepted',
      findings: [],
      finalMarkdown: '# Review Findings\n\nReviewed.',
      blockedReason: '',
      warnings: [],
    },
  ) {}

  async draftFindings(args: { context: { diff: string } }): Promise<ReviewFindingsDraft> {
    return this.draftFor(args.context.diff);
  }

  async reviewDraft(): Promise<ReviewFindingsReview> {
    return this.review;
  }
}

const zeroFindingsDraft: ReviewFindingsDraft = { summary: 'No issues found.', findings: [], warnings: [] };
const blockingDraft: ReviewFindingsDraft = {
  summary: 'Found a blocking issue.',
  findings: [
    { severity: 'blocking', files: ['src/add.js'], claim: 'broken', evidence: 'wrong operator', requiredAction: 'fix it' },
  ],
  warnings: [],
};
const twoBlockingDraft: ReviewFindingsDraft = {
  summary: 'Found two blocking issues.',
  findings: [
    { severity: 'blocking', files: ['src/add.js'], claim: 'broken', evidence: 'wrong operator', requiredAction: 'fix it' },
    { severity: 'blocking', files: ['src/add.js'], claim: 'also broken', evidence: 'no test', requiredAction: 'add one' },
  ],
  warnings: [],
};

test('evaluateReviewerFixture routes a candidate-config provider into the review path', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  const candidateConfig = deriveCandidateConfig(fakeConfig('openai-compatible'), {
    testedRole: 'reviewer',
    model: 'candidate-slug',
    reference: 'openai-codex',
  });

  const seen: AgentConfig[] = [];
  await evaluateReviewerFixture({
    compatDir,
    fixture,
    candidateConfig,
    createReviewProvider: ({ agentConfig }) => {
      seen.push(agentConfig);
      return new ScriptedReviewAdapter(() => zeroFindingsDraft);
    },
  });

  assert.ok(seen.length >= 1, 'createReviewProvider should be invoked per diff');
  for (const config of seen) {
    assert.equal(
      config.reviewer.provider,
      'openai-compatible',
      'candidate slug must drive the reviewer role on openai-compatible',
    );
    assert.equal(
      config.coder.provider,
      'openai-codex',
      'native reference must drive the coder role',
    );
  }
});

// The broken diff of add-edit-verify installs `a * b`; the good one keeps `a + b`.
function draftsByDiff(good: ReviewFindingsDraft, broken: ReviewFindingsDraft) {
  return () => new ScriptedReviewAdapter((diff) => (diff.includes('a * b') ? broken : good));
}

test('evaluateReviewerFixture scores the pair by discrimination, not absolute zero', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  const candidateConfig = fakeConfig('openai-compatible');
  const run = (createReviewProvider: () => ReviewFindingsProviderAdapter) =>
    evaluateReviewerFixture({ compatDir, fixture, candidateConfig, createReviewProvider });

  // good=0, broken=1 -> PASS.
  const clean = await run(draftsByDiff(zeroFindingsDraft, blockingDraft));
  assert.equal(clean.good.pass, true);
  assert.equal(clean.broken.pass, true);
  assert.equal(clean.good.blockingCount, 0);
  assert.equal(clean.broken.blockingCount, 1);
  assert.equal(clean.good.failureMode, null);
  assert.equal(clean.good.detail, null);

  // good=1, broken=2 -> PASS. Severity calibration is not graded.
  const strict = await run(draftsByDiff(blockingDraft, twoBlockingDraft));
  assert.equal(strict.good.pass, true, 'a blocking finding on the good diff must not FAIL by itself');
  assert.equal(strict.broken.pass, true);
  assert.equal(strict.good.blockingCount, 1);
  assert.equal(strict.broken.blockingCount, 2);

  // good=1, broken=1 -> no discrimination, both FAIL.
  const flat = await run(draftsByDiff(blockingDraft, blockingDraft));
  assert.equal(flat.good.pass, false);
  assert.equal(flat.broken.pass, false);
  assert.equal(flat.good.failureMode, 'wrong_or_empty_output');
  assert.equal(flat.broken.failureMode, 'wrong_or_empty_output');
  assert.match(String(flat.good.detail), /did not discriminate: blocking good=1 >= broken=1/);
  assert.equal(flat.good.blockingCount, 1);
  assert.equal(flat.broken.blockingCount, 1);
  // A failing cell carries its own blocking claim text so the FAIL is diagnosable.
  assert.match(String(flat.good.detail), /blocking: broken — fix it/);

  // good=0, broken=0 -> the broken diff drew nothing, both FAIL.
  const blind = await run(draftsByDiff(zeroFindingsDraft, zeroFindingsDraft));
  assert.equal(blind.good.pass, false);
  assert.equal(blind.broken.pass, false);
  assert.match(String(blind.broken.detail), /no blocking finding on the broken diff/);
  assert.equal(blind.good.blockingCount, 0);
  assert.equal(blind.broken.blockingCount, 0);
});

test('evaluateReviewerFixture never hands committed .neal run state to the reviewer', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  const tempCompatDir = await mkdtemp(join(tmpdir(), 'neal-compat-dotneal-'));
  try {
    cpSync(join(compatDir, 'add-edit-verify'), join(tempCompatDir, 'add-edit-verify'), {
      recursive: true,
    });
    mkdirSync(join(tempCompatDir, 'add-edit-verify', '.neal', 'runs'), { recursive: true });
    await writeFile(
      join(tempCompatDir, 'add-edit-verify', '.neal', 'runs', 'PLAN_ORIGINAL.md'),
      '# Stale\n\nThe helper currently returns the difference.\n',
    );

    const sawDotNeal: boolean[] = [];
    const result = await evaluateReviewerFixture({
      compatDir: tempCompatDir,
      fixture,
      candidateConfig: fakeConfig('openai-compatible'),
      createReviewProvider: ({ cwd }) => {
        sawDotNeal.push(existsSync(join(cwd, '.neal')));
        return new ScriptedReviewAdapter((diff) =>
          diff.includes('a * b') ? blockingDraft : zeroFindingsDraft,
        );
      },
    });

    assert.deepEqual(sawDotNeal, [false, false], 'no reviewer worktree may contain a .neal directory');
    assert.equal(result.good.pass, true);
    assert.equal(result.broken.pass, true);
  } finally {
    await rm(tempCompatDir, { recursive: true, force: true });
  }
});

test('evaluateReviewerFixture maps a non-accepted (blocked) review outcome to block_unresolved', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');

  const blockedReview: ReviewFindingsReview = {
    verdict: 'blocked',
    findings: ['cannot adjudicate'],
    finalMarkdown: '',
    blockedReason: 'cannot adjudicate',
    warnings: [],
  };
  const result = await evaluateReviewerFixture({
    compatDir,
    fixture,
    candidateConfig: fakeConfig('openai-compatible'),
    createReviewProvider: () => new ScriptedReviewAdapter(() => zeroFindingsDraft, blockedReview),
  });

  assert.equal(result.good.pass, false);
  assert.equal(result.good.failureMode, 'block_unresolved');
});

class ThrowingDraftReviewAdapter implements ReviewFindingsProviderAdapter {
  constructor(private readonly error: Error) {}

  async draftFindings(): Promise<ReviewFindingsDraft> {
    throw this.error;
  }

  async reviewDraft(): Promise<ReviewFindingsReview> {
    throw new Error('reviewDraft should not be reached when draftFindings throws');
  }
}

test('classifyReviewerThrownFailure separates provider failures from schema failures', () => {
  const providerError = (kind: NealProviderError['kind']) =>
    new NealProviderError({ message: `${kind} failure`, provider: 'openai-compatible', role: 'structured-advisor', kind });

  // Provider-attributable kinds -> provider_failed.
  for (const kind of ['api_error', 'timeout', 'no_progress_timeout', 'permission_denied', 'session_unavailable', 'provider_failed', 'unknown'] as const) {
    assert.equal(classifyReviewerThrownFailure(providerError(kind), 'failed'), 'provider_failed', `${kind} -> provider_failed`);
  }
  // Structured-output kinds -> structured_output even though the run persisted `failed`.
  assert.equal(classifyReviewerThrownFailure(providerError('structured_output_invalid'), 'failed'), 'structured_output');
  assert.equal(classifyReviewerThrownFailure(providerError('structured_output_missing'), 'failed'), 'structured_output');
  // The real draftFindings path wraps the provider error in a CoderRoundError;
  // the wrapper's .providerError must be unwrapped and classified by kind.
  assert.equal(classifyReviewerThrownFailure(new CoderRoundError(providerError('api_error')), 'failed'), 'provider_failed');
  assert.equal(
    classifyReviewerThrownFailure(new CoderRoundError(providerError('structured_output_invalid')), 'failed'),
    'structured_output',
  );
  // A ReviewerRoundError-shaped wrapper (any object exposing .providerError) unwraps the same way.
  assert.equal(
    classifyReviewerThrownFailure({ providerError: providerError('timeout') }, 'failed'),
    'provider_failed',
  );
  // Non-provider errors collapse to the persisted outcome (schema validation -> structured_output).
  assert.equal(classifyReviewerThrownFailure(new Error('Review provider returned an invalid draft object'), 'failed'), 'structured_output');
  assert.equal(classifyReviewerThrownFailure(new Error('blocked'), 'blocked'), 'block_unresolved');
  assert.equal(classifyReviewerThrownFailure(new Error('cap'), 'cap_reached'), 'max_step_loop');
  assert.equal(classifyReviewerThrownFailure(new Error('no meta'), null), 'provider_failed');
});

test('evaluateReviewerFixture reports a wrapped CoderRoundError provider failure as FAIL(provider_failed)', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  // The real draftFindings path (runCoderStructuredPrompt) wraps a provider
  // NealProviderError in a CoderRoundError before it escapes runNealReviewCli.
  const wrapped = new CoderRoundError(
    new NealProviderError({
      message: 'reviewer model temporarily unavailable',
      provider: 'openai-compatible',
      role: 'coder',
      kind: 'api_error',
    }),
  );

  const result = await evaluateReviewerFixture({
    compatDir,
    fixture,
    candidateConfig: fakeConfig('openai-compatible'),
    createReviewProvider: () => new ThrowingDraftReviewAdapter(wrapped),
  });

  // The run persists `failed`, but the wrapped provider error must keep the
  // cell as provider_failed (not structured_output).
  assert.equal(result.good.pass, false);
  assert.equal(result.good.failureMode, 'provider_failed');
  assert.equal(result.broken.pass, false);
  assert.equal(result.broken.failureMode, 'provider_failed');
});

test('evaluateReviewerFixture marks the pair unscoreable when only one diff review throws', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  const wrapped = new CoderRoundError(
    new NealProviderError({
      message: 'reviewer model temporarily unavailable',
      provider: 'openai-compatible',
      role: 'coder',
      kind: 'api_error',
    }),
  );

  // Throws only for the broken diff; the good diff scores normally.
  class HalfThrowingAdapter implements ReviewFindingsProviderAdapter {
    async draftFindings(args: { context: { diff: string } }): Promise<ReviewFindingsDraft> {
      if (args.context.diff.includes('a * b')) {
        throw wrapped;
      }
      return zeroFindingsDraft;
    }

    async reviewDraft(): Promise<ReviewFindingsReview> {
      return { verdict: 'accepted', findings: [], finalMarkdown: '# Review Findings\n\nReviewed.', blockedReason: '', warnings: [] };
    }
  }

  const result = await evaluateReviewerFixture({
    compatDir,
    fixture,
    candidateConfig: fakeConfig('openai-compatible'),
    createReviewProvider: () => new HalfThrowingAdapter(),
  });

  assert.equal(result.broken.pass, false);
  assert.equal(result.broken.failureMode, 'provider_failed');
  assert.equal(result.broken.blockingCount, null);
  assert.equal(result.good.pass, false);
  assert.equal(result.good.failureMode, 'provider_failed');
  assert.equal(result.good.blockingCount, 0);
  assert.match(String(result.good.detail), /pair unscoreable/);
});

test('evaluateReviewerFixture preserves a wrapped structured-output failure as FAIL(structured_output)', async () => {
  const manifest = loadCompatManifest();
  const fixture = getFixture(manifest, 'add-edit-verify');
  const wrapped = new CoderRoundError(
    new NealProviderError({
      message: 'model never emitted a valid review_findings_draft_payload',
      provider: 'openai-compatible',
      role: 'coder',
      kind: 'structured_output_invalid',
    }),
  );

  const result = await evaluateReviewerFixture({
    compatDir,
    fixture,
    candidateConfig: fakeConfig('openai-compatible'),
    createReviewProvider: () => new ThrowingDraftReviewAdapter(wrapped),
  });

  assert.equal(result.good.failureMode, 'structured_output');
  assert.equal(result.broken.failureMode, 'structured_output');
});

test('countBlockingFindings and summarizeBlockingFindings report the converged draft', () => {
  const base = {
    reviewId: 'r',
    paths: {} as ReviewFindingsRunResult['paths'],
    meta: {} as ReviewFindingsRunResult['meta'],
    context: {} as ReviewFindingsRunResult['context'],
    review: {} as ReviewFindingsRunResult['review'],
    rounds: [],
    outcome: 'accepted' as const,
    finalMarkdown: null,
  };
  assert.equal(countBlockingFindings({ ...base, draft: zeroFindingsDraft } as ReviewFindingsRunResult), 0);
  assert.equal(countBlockingFindings({ ...base, draft: blockingDraft } as ReviewFindingsRunResult), 1);
  assert.equal(countBlockingFindings({ ...base, draft: twoBlockingDraft } as ReviewFindingsRunResult), 2);

  assert.equal(summarizeBlockingFindings([]), '');
  assert.equal(summarizeBlockingFindings(blockingDraft.findings), 'broken — fix it');
  assert.equal(
    summarizeBlockingFindings(twoBlockingDraft.findings),
    'broken — fix it; also broken — add one',
  );
  // Whitespace collapses and both halves truncate at 120 characters.
  const long = summarizeBlockingFindings([
    { severity: 'blocking', files: [], claim: `a\n  ${'b'.repeat(200)}`, evidence: '', requiredAction: 'do it' },
  ]);
  assert.equal(long, `a ${'b'.repeat(118)}… — do it`);
});

// ---------------------------------------------------------------------------
// runCompat orchestration
// ---------------------------------------------------------------------------

async function makeConfiguredCwd(providerId: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-compat-cwd-'));
  await writeFile(
    join(cwd, 'neal.yml'),
    ['agent:', '  coder:', `    provider: ${providerId}`, '  reviewer:', `    provider: ${providerId}`, ''].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
  return cwd;
}

test('runCompat short-circuits to FAIL(protocol) and skips fixtures when the pre-filter throws', async () => {
  const providerId = 'fake-compat-protocol';
  registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: providerId }));
  const cwd = await makeConfiguredCwd(providerId);
  const manifest = loadCompatManifest();

  try {
    const report = await runCompat({
      cwd,
      parsed: { model: 'cand', role: 'all', reference: null, json: false },
      deps: {
        compatDir,
        manifest,
        verifyProviders: async () => {
          throw new Error('candidate could not emit a provider_check_payload');
        },
      },
    });

    assert.equal(report.overallPass, false);
    assert.equal(report.cells.length, 3, 'one protocol cell per targeted role, no fixtures');
    assert.ok(report.cells.every((cell) => cell.failureMode === 'protocol'));
    assert.deepEqual(
      report.cells.map((cell) => cell.role).sort(),
      ['coder', 'planner', 'reviewer'],
    );
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runCompat resolves no notify binary for child runs even when one is configured', async () => {
  const providerId = 'fake-compat-notify-quiet';
  registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: providerId }));
  const cwd = await mkdtemp(join(tmpdir(), 'neal-compat-cwd-'));
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'neal:',
      '  notify_bin: /configured/operator-notify',
      'agent:',
      '  coder:',
      `    provider: ${providerId}`,
      '  reviewer:',
      `    provider: ${providerId}`,
      '',
    ].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
  const savedNotifyEnv = process.env.NEAL_NOTIFY_BIN;
  // Drop the suite-wide NEAL_NOTIFY_BIN= kill switch so the configured
  // notify_bin genuinely resolves before compat starts.
  delete process.env.NEAL_NOTIFY_BIN;

  try {
    assert.equal(getNotifyBin(cwd), '/configured/operator-notify');

    await runCompat({
      cwd,
      parsed: { model: 'cand', role: 'coder', reference: null, json: false },
      deps: {
        compatDir,
        manifest: loadCompatManifest(),
        // Short-circuit at the pre-filter: suppression happens at compat
        // startup, so no fixture needs to run for the structural claim.
        verifyProviders: async () => {
          throw new Error('short-circuit');
        },
      },
    });

    // The defined-but-empty NEAL_NOTIFY_BIN override wins over config: every
    // child run inside this process now resolves no notify binary.
    assert.equal(process.env.NEAL_NOTIFY_BIN, '');
    assert.equal(getNotifyBin(cwd), null, 'a compat run must resolve no notify binary');
  } finally {
    if (savedNotifyEnv === undefined) {
      delete process.env.NEAL_NOTIFY_BIN;
    } else {
      process.env.NEAL_NOTIFY_BIN = savedNotifyEnv;
    }
    clearProviderDefinitionRegistrationsForTesting();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runCompat reviewer role produces a PASS matrix from candidate-config review scoring', async () => {
  const providerId = 'fake-compat-runcompat-reviewer';
  registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: providerId }));
  const cwd = await makeConfiguredCwd(providerId);
  const manifest = loadCompatManifest();
  const trimmed: CompatManifest = {
    fixtures: manifest.fixtures.filter((fixture) => fixture.id === 'add-edit-verify'),
  };

  try {
    const report = await runCompat({
      cwd,
      parsed: { model: 'cand', role: 'reviewer', reference: 'openai-codex', json: false },
      deps: {
        compatDir,
        manifest: trimmed,
        verifyProviders: async () => {},
        // Good diff (a + b) -> zero findings; broken diff (a * b) -> blocking.
        createReviewProvider: () =>
          new ScriptedReviewAdapter((diff) => (diff.includes('a * b') ? blockingDraft : zeroFindingsDraft)),
      },
    });

    assert.equal(report.overallPass, true, `expected reviewer PASS: ${JSON.stringify(report.cells)}`);
    assert.equal(report.cells.length, 2);
    assert.deepEqual(report.cells.map((cell) => cell.diffKind).sort(), ['broken', 'good']);
    assert.ok(report.cells.every((cell) => cell.pass));
    const reviewerRollup = report.roles.find((rollup) => rollup.role === 'reviewer');
    assert.deepEqual(reviewerRollup, { role: 'reviewer', pass: true, cellCount: 2, passCount: 2 });
    // model !== null → candidateProviders reports openai-compatible for every role.
    assert.deepEqual(report.candidateProviders, {
      coder: 'openai-compatible',
      reviewer: 'openai-compatible',
      planner: 'openai-compatible',
    });
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runCompat records FAIL(protocol) for every targeted role when one role pre-filter throws', async () => {
  const providerId = 'fake-compat-partial-protocol';
  registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: providerId }));
  const cwd = await makeConfiguredCwd(providerId);
  const manifest = loadCompatManifest();

  try {
    const report = await runCompat({
      cwd,
      parsed: { model: 'cand', role: 'all', reference: null, json: false },
      deps: {
        compatDir,
        manifest,
        // Only the reviewer candidate config (reviewer model overridden to the
        // candidate slug) fails the pre-filter; coder/planner verify cleanly.
        verifyProviders: async ({ agentConfig }) => {
          if (agentConfig.reviewer.model === 'cand') {
            throw new Error('reviewer candidate could not emit a provider_check_payload');
          }
        },
      },
    });

    assert.equal(report.overallPass, false);
    assert.equal(report.cells.length, 3, 'every targeted role must still record a cell when the candidate fails');
    assert.ok(report.cells.every((cell) => cell.failureMode === 'protocol'));
    assert.deepEqual(report.cells.map((cell) => cell.role).sort(), ['coder', 'planner', 'reviewer']);
    // Every targeted role's rollup carries an explicit failure (no empty rollup).
    for (const rollup of report.roles) {
      assert.equal(rollup.pass, false, `${rollup.role} rollup must FAIL`);
      assert.equal(rollup.cellCount, 1);
    }
    const reviewerCell = report.cells.find((cell) => cell.role === 'reviewer');
    const coderCell = report.cells.find((cell) => cell.role === 'coder');
    assert.match(reviewerCell?.detail ?? '', /provider_check_payload/);
    assert.match(coderCell?.detail ?? '', /pre-filter failed for another targeted role/);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runCompatCli --json writes exactly one JSON object even when a real coder fixture runs', async () => {
  const providerId = 'fake-compat-json-coder';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderStructuredResponses: [doneCoderResponse],
      structuredAdvisorResponses: [scopeReviewAccept, finalCompletionSummary, finalCompletionAccept],
      onCoderStructuredRun: async (args) => {
        const file = join(args.cwd, 'src', 'add.js');
        const contents = await readFile(file, 'utf8');
        await writeFile(file, contents.replace('a - b', 'a + b'), 'utf8');
        await runGit(args.cwd, 'add', '-A');
        await runGit(args.cwd, 'commit', '-m', 'apply reference fix');
      },
    }),
  );
  const cwd = await makeConfiguredCwd(providerId);
  const manifest = loadCompatManifest();
  const trimmed: CompatManifest = {
    fixtures: manifest.fixtures.filter((fixture) => fixture.id === 'add-edit-verify'),
  };
  const reportSink = new CaptureStream();

  try {
    const report = await runCompatCli({
      cwd,
      parsed: { model: null, role: 'coder', reference: null, json: true },
      stdout: reportSink,
      deps: { compatDir, manifest: trimmed, verifyProviders: async () => {} },
    });

    const text = reportSink.text();
    // The run summary that executeRun renders to stdout must not leak here: the
    // report sink must parse as exactly one JSON object equal to the report.
    const parsed = JSON.parse(text) as CompatReport;
    assert.deepEqual(parsed, report);
    assert.equal(text.trim().endsWith('}'), true);
    assert.equal(text.trim().startsWith('{'), true);
    // Exactly one JSON document: a second JSON.parse of any prefix/suffix noise
    // would have thrown above, and the coder cell must be the genuine run result.
    assert.equal(report.cells.length, 1);
    assert.equal(report.cells[0]?.role, 'coder');
    assert.equal(report.cells[0]?.pass, true, `expected coder PASS: ${JSON.stringify(report.cells)}`);
    // model === null → candidateProviders preserves the configured provider per
    // role (the planner inherits the coder provider, so all three are providerId).
    assert.deepEqual(report.candidateProviders, {
      coder: providerId,
      reviewer: providerId,
      planner: providerId,
    });
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('buildRoleRollups marks a role FAIL when any cell fails', () => {
  const rollups = buildRoleRollups(
    [
      { role: 'reviewer', fixtureId: 'a', diffKind: 'good', blockingCount: 0, pass: true, failureMode: null, detail: null },
      { role: 'reviewer', fixtureId: 'a', diffKind: 'broken', blockingCount: 0, pass: false, failureMode: 'wrong_or_empty_output', detail: null },
    ],
    ['reviewer'],
  );
  assert.deepEqual(rollups, [{ role: 'reviewer', pass: false, cellCount: 2, passCount: 1 }]);
});

test('formatCompatJson emits the exact stable schema shape', () => {
  const report: CompatReport = {
    schemaVersion: 2,
    model: 'cand',
    reference: 'ref',
    role: 'reviewer',
    candidateProviders: { coder: 'openai-compatible', reviewer: 'openai-compatible', planner: 'openai-compatible' },
    cells: [
      { role: 'reviewer', fixtureId: 'add-edit-verify', diffKind: 'good', blockingCount: 1, pass: true, failureMode: null, detail: null },
    ],
    roles: [{ role: 'reviewer', pass: true, cellCount: 1, passCount: 1 }],
    overallPass: true,
  };

  const parsed = JSON.parse(formatCompatJson(report)) as CompatReport;
  assert.deepEqual(Object.keys(parsed).sort(), [
    'candidateProviders',
    'cells',
    'model',
    'overallPass',
    'reference',
    'role',
    'roles',
    'schemaVersion',
  ]);
  assert.deepEqual(Object.keys(parsed.cells[0]).sort(), [
    'blockingCount',
    'detail',
    'diffKind',
    'failureMode',
    'fixtureId',
    'pass',
    'role',
  ]);
  assert.deepEqual(parsed, report);
});

test('formatCompatTable describes the reference as a provider, not a model slug', () => {
  const baseReport: Omit<CompatReport, 'model' | 'reference'> = {
    schemaVersion: 2,
    role: 'all',
    candidateProviders: { coder: 'openai-compatible', reviewer: 'openai-compatible', planner: 'openai-compatible' },
    cells: [{ role: 'coder', fixtureId: 'add-edit-verify', diffKind: null, blockingCount: null, pass: true, failureMode: null, detail: null }],
    roles: [{ role: 'coder', pass: true, cellCount: 1, passCount: 1 }],
    overallPass: true,
  };

  // Explicit native reference id is shown verbatim as the reference provider.
  const explicit = formatCompatTable({ ...baseReport, model: 'cand', reference: 'anthropic-claude' });
  assert.match(explicit, /^Reference provider: anthropic-claude$/m);
  assert.equal(describeReferenceProvider({ ...baseReport, model: 'cand', reference: 'openai-codex' }), 'openai-codex');

  // --model set without --reference → implicit openai-codex default, labeled as a provider.
  const implicit = formatCompatTable({ ...baseReport, model: 'cand', reference: null });
  assert.match(implicit, /^Reference provider: openai-codex \(default\)$/m);

  // Neither flag → configured/native pass-through, still labeled as a provider.
  const passthrough = formatCompatTable({ ...baseReport, model: null, reference: null });
  assert.match(passthrough, /^Reference provider: \(configured \/ native pass-through\)$/m);

  // Guard against regressing to the old model-slug wording.
  assert.doesNotMatch(explicit, /Reference model:/);
  assert.doesNotMatch(implicit, /Reference model:/);
});
