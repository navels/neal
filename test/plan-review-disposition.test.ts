import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearConfigCache } from '../src/neal/config.js';
import { buildReviewerContextPacket } from '../src/neal/context/reviewer-context.js';
import { RunLogger } from '../src/neal/logger.js';
import { runPlanningResponsePhase, runPlanReviewPhase } from '../src/neal/orchestrator/phases/planning.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type { CoderStructuredPromptArgs } from '../src/neal/providers/types.js';
import { toPlanReviewDebt } from '../src/neal/review-debt.js';
import { createInitialState, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import type {
  FindingStatus,
  OrchestrationState,
  PlanReviewFindingClass,
  ResidualReviewDebtItem,
  ReviewFinding,
  ReviewRound,
} from '../src/neal/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { hermeticAgentConfig } from './helpers/hermetic-agent-config.js';

// Characterization baseline for every disposition route of runPlanReviewPhase
// (P5 plan, Scope 10), pinned before Scope 11 extracts the planning
// disposition resolver into src/neal/adjudicator/planning.ts. This file is
// immutable through that refactor: if the extracted resolver cannot reproduce
// a behavior pinned here, the refactor is wrong, not this file.
//
// The routes, all derived in orchestrator/phases/planning.ts from the same
// condition set (shouldBlockForConvergence, hasBlockingFindings,
// reachedMaxRounds, hasOpenNonBlockingFindings, derivedPlanReview):
//   1. Blocking revision (blocking findings below the round cap) ->
//      coder_plan_response / running.
//   2. Blocking at the round cap -> blocked / blocked / reviewer_plan, with
//      the max-rounds block reason driving blocked-response finalization.
//   3. Convergence blocking (stalled-window rule) -> blocked / blocked /
//      reviewer_plan, with the review-stuck block reason.
//   4. Non-blocking optional revision -> coder_plan_optional_response /
//      running (no execution test covered this route before this file).
//   5. Top-level acceptance -> done / done, plus the
//      notifyComplete('Plan review converged', ...) call.
//   6. Derived-plan acceptance -> awaiting_derived_plan_execution / running /
//      derivedPlanStatus accepted, plus the derived-plan notification flush.
//   Precedence: blocking + non-blocking findings together route to the
//   blocking-revision disposition, and convergence blocking (reopened
//   blocking canonical) wins over below-cap blocking revision.
//
// The future resolver's fifth output (planningSignal) is not persisted today;
// it is pinned transitively: Scope 11 must keep
// assertAdjudicationTransitionSignal on the resolver-derived signal, and the
// persisted phase/status/derivedPlanStatus/blockedFromPhase pins below
// constrain the signal through the persisted outcomes.

// This file pins notify behavior through its own fixture script; the
// suite-wide NEAL_NOTIFY_BIN= kill switch (pnpm test script) must not shadow
// it. Fixture repo configs pin notify_bin, so this stays hermetic.
delete process.env.NEAL_NOTIFY_BIN;

// This file drives config-reading orchestrator paths; user config resolves
// through homedir()/.neal/config.yml, so pin a private tmp HOME (unique across
// the flat test suite — parallel node:test child processes share tmpdir()).
process.env.HOME = join(tmpdir(), 'neal-test-home-plan-review-disposition');

const BASE_COMMIT = 'abc123';

const ONE_SHOT_PLAN_DOCUMENT = `# Example Plan

## Execution Shape

executionShape: one_shot
`;

const MULTI_SCOPE_PLAN_DOCUMENT = `# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Example scope
- Goal: Implement one bounded slice.
- Verification: \`pnpm typecheck\`
- Success Condition: The bounded slice is complete and verified.
`;

// Shared claim/files so seeded findings and current-round reviewer findings
// map to the same canonical id via findCanonicalId's claim+files signature.
const BLOCKING_CLAIM = 'The plan omits concrete verification.';
const BLOCKING_ACTION = 'Add executable verification commands.';
const CLAIM_FILES = ['PLAN.md'];

async function createPlanReviewDispositionFixture(args: {
  prefix: string;
  reviewerProviderId: string;
  reviewerResponses: unknown[];
  maxRounds?: number;
  reviewStuckWindow?: number;
  planReviewDebtRoundThreshold?: number;
  topLevelMode?: 'plan' | 'execute';
  planDocument?: string;
  derivedPlanDocument?: string;
  stateOverrides?: (paths: { planDoc: string; runDir: string; derivedPlanPath: string | null }) => Partial<OrchestrationState>;
}) {
  const root = await mkdtemp(join(tmpdir(), args.prefix));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');

  await mkdir(runDir, { recursive: true });
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);
  const stuckWindowLine =
    typeof args.reviewStuckWindow === 'number' ? `  review_stuck_window: ${args.reviewStuckWindow}\n` : '';
  const debtThresholdLine =
    typeof args.planReviewDebtRoundThreshold === 'number'
      ? `  plan_review_debt_round_threshold: ${args.planReviewDebtRoundThreshold}\n`
      : '';
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: ${notifyScriptPath}\n${stuckWindowLine}${debtThresholdLine}`,
    'utf8',
  );
  clearConfigCache(cwd);
  await writeFile(planDoc, args.planDocument ?? ONE_SHOT_PLAN_DOCUMENT, 'utf8');

  let derivedPlanPath: string | null = null;
  if (args.derivedPlanDocument !== undefined) {
    derivedPlanPath = join(runDir, 'DERIVED_PLAN_SCOPE_2.md');
    await writeFile(derivedPlanPath, args.derivedPlanDocument, 'utf8');
  }

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: args.reviewerProviderId,
      includeCoderAdapter: false,
      structuredAdvisorResponses: args.reviewerResponses,
    }),
  );

  const statePath = getRunStatePath(runDir);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: args.topLevelMode ?? 'plan',
      allowedDirtyPaths: [],
      agentConfig: {
        ...hermeticAgentConfig(),
        reviewer: { provider: args.reviewerProviderId, model: null, effort: null },
      },
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: args.maxRounds ?? 3,
    },
    BASE_COMMIT,
  );

  const state = await saveState(statePath, {
    ...initialState,
    phase: 'reviewer_plan',
    ...args.stateOverrides?.({ planDoc, runDir, derivedPlanPath }),
  });

  const logger = new RunLogger(runDir);

  return { root, cwd, runDir, planDoc, derivedPlanPath, statePath, state, logger, notifyLogPath };
}

async function readRunEvents(runDir: string) {
  const content = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

function findEvent(events: { type: string; data?: Record<string, unknown> }[], type: string) {
  const event = events.find((candidate) => candidate.type === type);
  assert.ok(event, `expected an event of type ${type}`);
  return event;
}

function eventIndex(events: { type: string }[], type: string) {
  const index = events.findIndex((candidate) => candidate.type === type);
  assert.notEqual(index, -1, `expected an event of type ${type}`);
  return index;
}

function notifyEventTypes(events: { type: string }[]) {
  return events.filter((event) => event.type.startsWith('notify.')).map((event) => event.type);
}

// JSON-normalized deep compare against the persisted state file, so the pin is
// byte-faithful to what saveState serialized (undefined-valued keys dropped).
function assertPersistedState(persisted: Record<string, unknown>, expected: Record<string, unknown>) {
  assert.equal(typeof persisted.updatedAt, 'string');
  assert.deepStrictEqual(
    persisted,
    JSON.parse(JSON.stringify({ ...expected, updatedAt: persisted.updatedAt })),
  );
}

// A prior reviewer round record whose open-blocking snapshot is the C1
// canonical, matching the seeded blocking finding of that round.
function seededReviewRound(round: number, findingIds: string[]): ReviewRound {
  return {
    round,
    reviewerSessionHandle: `seed-reviewer-session-${round}`,
    reviewedPlanPath: 'PLAN.md',
    normalizationApplied: false,
    normalizationOperations: [],
    normalizationScopeLabelMappings: [],
    commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
    openBlockingCanonicalCount: 1,
    openBlockingCanonicalIds: ['C1'],
    findings: findingIds,
  };
}

// A seeded blocking finding on canonical C1 (same claim+files signature the
// current-round reviewer finding will carry).
function seededBlockingFinding(args: { id: string; round: number; status: FindingStatus }): ReviewFinding {
  return {
    id: args.id,
    canonicalId: 'C1',
    round: args.round,
    source: 'reviewer',
    severity: 'blocking',
    files: [...CLAIM_FILES],
    claim: BLOCKING_CLAIM,
    requiredAction: BLOCKING_ACTION,
    status: args.status,
    roundSummary: `Seeded round ${args.round} summary.`,
    coderDisposition: args.status === 'open' ? null : 'Seeded coder disposition.',
    coderCommit: null,
  };
}

// The finding record runPlanReviewPhase appends for a current-round reviewer
// finding: reviewer-round fields plus id/canonical/open bookkeeping.
function recordedFinding(args: {
  round: number;
  index: number;
  canonicalId: string;
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  requiredAction: string;
  roundSummary: string;
}): ReviewFinding {
  return {
    round: args.round,
    source: 'reviewer',
    severity: args.severity,
    files: args.files,
    claim: args.claim,
    requiredAction: args.requiredAction,
    roundSummary: args.roundSummary,
    id: `R${args.round}-F${args.index}`,
    canonicalId: args.canonicalId,
    status: 'open',
    coderDisposition: null,
    coderCommit: null,
  };
}

test('plan review routes blocking findings below the round cap to coder_plan_response and leaves a pending derived review pending', async () => {
  // Derived-plan review deliberately: the blocking-revision route must leave
  // derivedPlanStatus UNCHANGED, and 'pending_review' is a non-default value
  // that distinguishes preservation from a hard-coded null. splitPlanStarted
  // is already notified, so the route must produce no notification at all.
  const summary = 'Round one found a blocking verification gap in the derived plan.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-blocking-revision-',
    reviewerProviderId: 'fake-disposition-blocking-revision-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'multi_scope',
        findings: [
          {
            severity: 'blocking',
            files: [...CLAIM_FILES],
            claim: BLOCKING_CLAIM,
            requiredAction: BLOCKING_ACTION,
          },
        ],
      },
    ],
    maxRounds: 3,
    topLevelMode: 'execute',
    planDocument: '# Parent Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    derivedPlanDocument: MULTI_SCOPE_PLAN_DOCUMENT,
    stateOverrides: ({ derivedPlanPath }) => ({
      currentScopeNumber: 2,
      derivedPlanPath,
      derivedPlanStatus: 'pending_review',
      derivedFromScopeNumber: 2,
      derivedScopeIndex: null,
      splitPlanStartedNotified: true,
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'coder_plan_response');
    assert.equal(result.status, 'running');
    assert.equal(result.derivedPlanStatus, 'pending_review');
    assert.equal(result.blockedFromPhase, null);

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-blocking-revision-reviewer-advisor-session',
      executionShape: 'multi_scope',
      phase: 'coder_plan_response',
      status: 'running',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-blocking-revision-reviewer-advisor-session',
          reviewedPlanPath: fixture.derivedPlanPath,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 1,
          openBlockingCanonicalIds: ['C1'],
          findings: ['R1-F1'],
        },
      ],
      findings: [
        recordedFinding({
          round: 1,
          index: 1,
          canonicalId: 'C1',
          severity: 'blocking',
          files: CLAIM_FILES,
          claim: BLOCKING_CLAIM,
          requiredAction: BLOCKING_ACTION,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: 'pending_review',
      blockedFromPhase: null,
    });
    // The returned state is exactly the persisted one.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.start').data, { phase: 'reviewer_plan', round: 1 });
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-blocking-revision-reviewer-advisor-session',
      findings: 1,
      blockingFindings: 1,
      nextPhase: 'coder_plan_response',
    });
    // No notification of any kind on the blocking-revision route.
    assert.deepStrictEqual(notifyEventTypes(events), []);
    assert.equal(existsSync(fixture.notifyLogPath), false);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan review blocks at the round cap with the max-rounds reason driving blocked-response finalization', async () => {
  const summary = 'Final round still found a blocking verification gap.';
  const blockReason = 'reached max review rounds (1) with blocking findings still open';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-round-cap-',
    reviewerProviderId: 'fake-disposition-round-cap-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'one_shot',
        findings: [
          {
            severity: 'blocking',
            files: [...CLAIM_FILES],
            claim: BLOCKING_CLAIM,
            requiredAction: BLOCKING_ACTION,
          },
        ],
      },
    ],
    maxRounds: 1,
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'blocked');
    assert.equal(result.status, 'blocked');
    assert.equal(result.derivedPlanStatus, null);
    assert.equal(result.blockedFromPhase, 'reviewer_plan');

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-round-cap-reviewer-advisor-session',
      executionShape: 'one_shot',
      phase: 'blocked',
      status: 'blocked',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-round-cap-reviewer-advisor-session',
          reviewedPlanPath: fixture.planDoc,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 1,
          openBlockingCanonicalIds: ['C1'],
          findings: ['R1-F1'],
        },
      ],
      findings: [
        recordedFinding({
          round: 1,
          index: 1,
          canonicalId: 'C1',
          severity: 'blocking',
          files: CLAIM_FILES,
          claim: BLOCKING_CLAIM,
          requiredAction: BLOCKING_ACTION,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: null,
      blockedFromPhase: 'reviewer_plan',
    });
    // Blocked-response finalization on a top-level plan review
    // notifies and returns the persisted blocked state unchanged.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-round-cap-reviewer-advisor-session',
      findings: 1,
      blockingFindings: 1,
      nextPhase: 'blocked',
    });
    assert.deepStrictEqual(findEvent(events, 'notify.blocked').data, {
      reason: blockReason,
      planName: 'PLAN.md',
      consultantAdvice: null,
    });
    assert.ok(eventIndex(events, 'phase.complete') < eventIndex(events, 'notify.blocked'));
    // The blocked notification is the only notification.
    assert.deepStrictEqual(notifyEventTypes(events), ['notify.blocked']);
    assert.equal(await readFile(fixture.notifyLogPath, 'utf8'), `[neal] PLAN.md: ${blockReason}\n`);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan review blocks for convergence via the stalled-window rule with the review-stuck reason', async () => {
  // Round 2 of a maxRounds-10 review: well below the cap, so the block is
  // attributable only to the stalled-window convergence rule (window 2, the
  // same C1 open-blocking snapshot in both rounds). The reopened-canonical
  // trigger stays quiet (C1 spans only two rounds).
  const summary = 'Round two found the same blocking verification gap.';
  const blockReason = 'review_stuck: blocking findings did not decrease across 2 consecutive reviewer rounds';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-stalled-',
    reviewerProviderId: 'fake-disposition-stalled-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'one_shot',
        findings: [
          {
            severity: 'blocking',
            files: [...CLAIM_FILES],
            claim: BLOCKING_CLAIM,
            requiredAction: BLOCKING_ACTION,
          },
        ],
      },
    ],
    maxRounds: 10,
    reviewStuckWindow: 2,
    stateOverrides: () => ({
      rounds: [seededReviewRound(1, ['R1-F1'])],
      findings: [seededBlockingFinding({ id: 'R1-F1', round: 1, status: 'open' })],
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'blocked');
    assert.equal(result.status, 'blocked');
    assert.equal(result.derivedPlanStatus, null);
    assert.equal(result.blockedFromPhase, 'reviewer_plan');

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-stalled-reviewer-advisor-session',
      executionShape: 'one_shot',
      phase: 'blocked',
      status: 'blocked',
      rounds: [
        seededReviewRound(1, ['R1-F1']),
        {
          round: 2,
          reviewerSessionHandle: 'fake-disposition-stalled-reviewer-advisor-session',
          reviewedPlanPath: fixture.planDoc,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 1,
          openBlockingCanonicalIds: ['C1'],
          findings: ['R2-F1'],
        },
      ],
      findings: [
        seededBlockingFinding({ id: 'R1-F1', round: 1, status: 'open' }),
        recordedFinding({
          round: 2,
          index: 1,
          canonicalId: 'C1',
          severity: 'blocking',
          files: CLAIM_FILES,
          claim: BLOCKING_CLAIM,
          requiredAction: BLOCKING_ACTION,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: null,
      blockedFromPhase: 'reviewer_plan',
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 2,
      sessionHandle: 'fake-disposition-stalled-reviewer-advisor-session',
      findings: 1,
      blockingFindings: 1,
      nextPhase: 'blocked',
    });
    assert.deepStrictEqual(findEvent(events, 'notify.blocked').data, {
      reason: blockReason,
      planName: 'PLAN.md',
      consultantAdvice: null,
    });
    assert.ok(eventIndex(events, 'phase.complete') < eventIndex(events, 'notify.blocked'));
    assert.deepStrictEqual(notifyEventTypes(events), ['notify.blocked']);
    assert.equal(await readFile(fixture.notifyLogPath, 'utf8'), `[neal] PLAN.md: ${blockReason}\n`);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan review routes non-blocking findings to coder_plan_optional_response (optional revision)', async () => {
  const summary = 'Round one found only a non-blocking clarity issue.';
  const nonBlockingClaim = 'Clarify one verification sentence.';
  const nonBlockingAction = 'Tighten the verification wording.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-optional-',
    reviewerProviderId: 'fake-disposition-optional-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'one_shot',
        findings: [
          {
            severity: 'non_blocking',
            files: [...CLAIM_FILES],
            claim: nonBlockingClaim,
            requiredAction: nonBlockingAction,
          },
        ],
      },
    ],
    maxRounds: 3,
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'coder_plan_optional_response');
    assert.equal(result.status, 'running');
    assert.equal(result.derivedPlanStatus, null);
    assert.equal(result.blockedFromPhase, null);

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-optional-reviewer-advisor-session',
      executionShape: 'one_shot',
      phase: 'coder_plan_optional_response',
      status: 'running',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-optional-reviewer-advisor-session',
          reviewedPlanPath: fixture.planDoc,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 0,
          openBlockingCanonicalIds: [],
          findings: ['R1-F1'],
        },
      ],
      findings: [
        recordedFinding({
          round: 1,
          index: 1,
          canonicalId: 'C1',
          severity: 'non_blocking',
          files: CLAIM_FILES,
          claim: nonBlockingClaim,
          requiredAction: nonBlockingAction,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: null,
      blockedFromPhase: null,
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-optional-reviewer-advisor-session',
      findings: 1,
      blockingFindings: 0,
      nextPhase: 'coder_plan_optional_response',
    });
    // No notification of any kind on the optional-revision route.
    assert.deepStrictEqual(notifyEventTypes(events), []);
    assert.equal(existsSync(fixture.notifyLogPath), false);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan review routes non-blocking findings in a derived review to the optional route and leaves derivedPlanStatus pending_review', async () => {
  // Derived-plan review deliberately: the optional-revision route must leave
  // derivedPlanStatus UNCHANGED, and 'pending_review' is a non-default value
  // that distinguishes preservation from a hard-coded null (the top-level
  // optional test above can only pin null). The acceptance transition to
  // 'accepted' requires zero open non-blocking findings, so this route must
  // not flip the status. splitPlanStarted is already notified, so the route
  // must produce no notification at all.
  const summary = 'Round one found only a non-blocking clarity issue in the derived plan.';
  const nonBlockingClaim = 'Clarify one verification sentence.';
  const nonBlockingAction = 'Tighten the verification wording.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-optional-derived-',
    reviewerProviderId: 'fake-disposition-optional-derived-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'multi_scope',
        findings: [
          {
            severity: 'non_blocking',
            files: [...CLAIM_FILES],
            claim: nonBlockingClaim,
            requiredAction: nonBlockingAction,
          },
        ],
      },
    ],
    maxRounds: 3,
    topLevelMode: 'execute',
    planDocument: '# Parent Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    derivedPlanDocument: MULTI_SCOPE_PLAN_DOCUMENT,
    stateOverrides: ({ derivedPlanPath }) => ({
      currentScopeNumber: 2,
      derivedPlanPath,
      derivedPlanStatus: 'pending_review',
      derivedFromScopeNumber: 2,
      derivedScopeIndex: null,
      splitPlanStartedNotified: true,
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'coder_plan_optional_response');
    assert.equal(result.status, 'running');
    assert.equal(result.derivedPlanStatus, 'pending_review');
    assert.equal(result.blockedFromPhase, null);

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-optional-derived-reviewer-advisor-session',
      executionShape: 'multi_scope',
      phase: 'coder_plan_optional_response',
      status: 'running',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-optional-derived-reviewer-advisor-session',
          reviewedPlanPath: fixture.derivedPlanPath,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 0,
          openBlockingCanonicalIds: [],
          findings: ['R1-F1'],
        },
      ],
      findings: [
        recordedFinding({
          round: 1,
          index: 1,
          canonicalId: 'C1',
          severity: 'non_blocking',
          files: CLAIM_FILES,
          claim: nonBlockingClaim,
          requiredAction: nonBlockingAction,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: 'pending_review',
      blockedFromPhase: null,
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-optional-derived-reviewer-advisor-session',
      findings: 1,
      blockingFindings: 0,
      nextPhase: 'coder_plan_optional_response',
    });
    // No notification of any kind on the optional-revision route.
    assert.deepStrictEqual(notifyEventTypes(events), []);
    assert.equal(existsSync(fixture.notifyLogPath), false);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan review with no open findings completes a top-level review as done with the converged notification', async () => {
  const summary = 'The plan is executable as written.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-accept-top-',
    reviewerProviderId: 'fake-disposition-accept-top-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'one_shot',
        findings: [],
      },
    ],
    maxRounds: 3,
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'done');
    assert.equal(result.status, 'done');
    assert.equal(result.derivedPlanStatus, null);
    assert.equal(result.blockedFromPhase, null);

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-accept-top-reviewer-advisor-session',
      executionShape: 'one_shot',
      phase: 'done',
      status: 'done',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-accept-top-reviewer-advisor-session',
          reviewedPlanPath: fixture.planDoc,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 0,
          openBlockingCanonicalIds: [],
          findings: [],
        },
      ],
      findings: [],
      derivedPlanStatus: null,
      blockedFromPhase: null,
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-accept-top-reviewer-advisor-session',
      findings: 0,
      blockingFindings: 0,
      nextPhase: 'done',
    });
    // Top-level acceptance fires exactly the plan-review-converged
    // notification, after phase.complete.
    assert.deepStrictEqual(findEvent(events, 'notify.complete').data, {
      message: 'Plan review converged',
      planName: 'PLAN.md',
      completionLabel: 'plan complete',
    });
    assert.ok(eventIndex(events, 'phase.complete') < eventIndex(events, 'notify.complete'));
    assert.deepStrictEqual(notifyEventTypes(events), ['notify.complete']);
    assert.equal(
      await readFile(fixture.notifyLogPath, 'utf8'),
      '[neal] PLAN.md: plan complete: Plan review converged\n',
    );
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('plan review with no open findings accepts a derived plan and flushes the acceptance notification', async () => {
  const summary = 'The derived plan replaces the abandoned scope safely.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-accept-derived-',
    reviewerProviderId: 'fake-disposition-accept-derived-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'multi_scope',
        findings: [],
      },
    ],
    maxRounds: 3,
    topLevelMode: 'execute',
    planDocument: '# Parent Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    derivedPlanDocument: MULTI_SCOPE_PLAN_DOCUMENT,
    // splitPlanStartedNotified stays false: the flush must NOT emit a late
    // split-plan-started notification once the review has already accepted.
    stateOverrides: ({ derivedPlanPath }) => ({
      currentScopeNumber: 2,
      derivedPlanPath,
      derivedPlanStatus: 'pending_review',
      derivedFromScopeNumber: 2,
      derivedScopeIndex: null,
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'awaiting_derived_plan_execution');
    assert.equal(result.status, 'running');
    assert.equal(result.derivedPlanStatus, 'accepted');
    assert.equal(result.blockedFromPhase, null);

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-accept-derived-reviewer-advisor-session',
      executionShape: 'multi_scope',
      phase: 'awaiting_derived_plan_execution',
      status: 'running',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-accept-derived-reviewer-advisor-session',
          reviewedPlanPath: fixture.derivedPlanPath,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 0,
          openBlockingCanonicalIds: [],
          findings: [],
        },
      ],
      findings: [],
      derivedPlanStatus: 'accepted',
      blockedFromPhase: null,
      // The derived-plan notification flush persists the acceptance
      // notification flag; the started flag stays false.
      derivedPlanAcceptedNotified: true,
      splitPlanStartedNotified: false,
    });
    // The returned state is the post-flush persisted state.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-accept-derived-reviewer-advisor-session',
      findings: 0,
      blockingFindings: 0,
      nextPhase: 'awaiting_derived_plan_execution',
    });
    // Exactly one notification: the derived-plan acceptance flush, after
    // phase.complete. No plan-review-converged notification and no late
    // split-plan-started notification.
    assert.deepStrictEqual(findEvent(events, 'notify.derived_plan_accepted').data, {
      planName: 'PLAN.md',
      scopeNumber: '2',
      derivedPlanPath: fixture.derivedPlanPath,
    });
    assert.ok(eventIndex(events, 'phase.complete') < eventIndex(events, 'notify.derived_plan_accepted'));
    assert.deepStrictEqual(notifyEventTypes(events), ['notify.derived_plan_accepted']);
    assert.equal(
      await readFile(fixture.notifyLogPath, 'utf8'),
      '[neal] PLAN.md: derived plan accepted for scope 2\n',
    );
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('blocking plus non-blocking findings together route to the blocking-revision disposition', async () => {
  const summary = 'Round one found one blocking and one non-blocking issue.';
  const nonBlockingClaim = 'Clarify one verification sentence.';
  const nonBlockingAction = 'Tighten the verification wording.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-mixed-',
    reviewerProviderId: 'fake-disposition-mixed-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'one_shot',
        findings: [
          {
            severity: 'blocking',
            files: [...CLAIM_FILES],
            claim: BLOCKING_CLAIM,
            requiredAction: BLOCKING_ACTION,
          },
          {
            severity: 'non_blocking',
            files: [...CLAIM_FILES],
            claim: nonBlockingClaim,
            requiredAction: nonBlockingAction,
          },
        ],
      },
    ],
    maxRounds: 3,
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    // The open non-blocking finding does not divert to the optional route.
    assert.equal(result.phase, 'coder_plan_response');
    assert.equal(result.status, 'running');
    assert.equal(result.derivedPlanStatus, null);
    assert.equal(result.blockedFromPhase, null);

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-mixed-reviewer-advisor-session',
      executionShape: 'one_shot',
      phase: 'coder_plan_response',
      status: 'running',
      rounds: [
        {
          round: 1,
          reviewerSessionHandle: 'fake-disposition-mixed-reviewer-advisor-session',
          reviewedPlanPath: fixture.planDoc,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 1,
          openBlockingCanonicalIds: ['C1'],
          findings: ['R1-F1', 'R1-F2'],
        },
      ],
      findings: [
        recordedFinding({
          round: 1,
          index: 1,
          canonicalId: 'C1',
          severity: 'blocking',
          files: CLAIM_FILES,
          claim: BLOCKING_CLAIM,
          requiredAction: BLOCKING_ACTION,
          roundSummary: summary,
        }),
        recordedFinding({
          round: 1,
          index: 2,
          canonicalId: 'C2',
          severity: 'non_blocking',
          files: CLAIM_FILES,
          claim: nonBlockingClaim,
          requiredAction: nonBlockingAction,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: null,
      blockedFromPhase: null,
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 1,
      sessionHandle: 'fake-disposition-mixed-reviewer-advisor-session',
      findings: 2,
      blockingFindings: 1,
      nextPhase: 'coder_plan_response',
    });
    assert.deepStrictEqual(notifyEventTypes(events), []);
    assert.equal(existsSync(fixture.notifyLogPath), false);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('convergence blocking via a reopened blocking canonical wins over below-cap blocking revision', async () => {
  // Round 3 of a maxRounds-10 review: hasBlockingFindings is true and the cap
  // is far away, so without the convergence rule this round would route to
  // coder_plan_response. C1 was raised in rounds 1 and 2 (fixed each time)
  // and reappears in round 3 — three distinct rounds — so the
  // reopened-canonical rule blocks instead. The stalled-window rule stays
  // quiet (default window 5 > 3 snapshots).
  const summary = 'Round three reopened the same blocking verification gap.';
  const blockReason = 'review_stuck: blocking finding C1 reopened across multiple reviewer rounds';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-reopened-',
    reviewerProviderId: 'fake-disposition-reopened-reviewer',
    reviewerResponses: [
      {
        summary,
        executionShape: 'one_shot',
        findings: [
          {
            severity: 'blocking',
            files: [...CLAIM_FILES],
            claim: BLOCKING_CLAIM,
            requiredAction: BLOCKING_ACTION,
          },
        ],
      },
    ],
    maxRounds: 10,
    stateOverrides: () => ({
      rounds: [seededReviewRound(1, ['R1-F1']), seededReviewRound(2, ['R2-F1'])],
      findings: [
        seededBlockingFinding({ id: 'R1-F1', round: 1, status: 'fixed' }),
        seededBlockingFinding({ id: 'R2-F1', round: 2, status: 'fixed' }),
      ],
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'blocked');
    assert.equal(result.status, 'blocked');
    assert.equal(result.derivedPlanStatus, null);
    assert.equal(result.blockedFromPhase, 'reviewer_plan');

    const persisted = JSON.parse(await readFile(fixture.statePath, 'utf8')) as Record<string, unknown>;
    assertPersistedState(persisted, {
      ...fixture.state,
      reviewerSessionHandle: 'fake-disposition-reopened-reviewer-advisor-session',
      executionShape: 'one_shot',
      phase: 'blocked',
      status: 'blocked',
      rounds: [
        seededReviewRound(1, ['R1-F1']),
        seededReviewRound(2, ['R2-F1']),
        {
          round: 3,
          reviewerSessionHandle: 'fake-disposition-reopened-reviewer-advisor-session',
          reviewedPlanPath: fixture.planDoc,
          normalizationApplied: false,
          normalizationOperations: [],
          normalizationScopeLabelMappings: [],
          commitRange: { base: BASE_COMMIT, head: BASE_COMMIT },
          openBlockingCanonicalCount: 1,
          openBlockingCanonicalIds: ['C1'],
          findings: ['R3-F1'],
        },
      ],
      findings: [
        seededBlockingFinding({ id: 'R1-F1', round: 1, status: 'fixed' }),
        seededBlockingFinding({ id: 'R2-F1', round: 2, status: 'fixed' }),
        recordedFinding({
          round: 3,
          index: 1,
          canonicalId: 'C1',
          severity: 'blocking',
          files: CLAIM_FILES,
          claim: BLOCKING_CLAIM,
          requiredAction: BLOCKING_ACTION,
          roundSummary: summary,
        }),
      ],
      derivedPlanStatus: null,
      blockedFromPhase: 'reviewer_plan',
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), persisted);

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'phase.complete').data, {
      phase: 'reviewer_plan',
      round: 3,
      sessionHandle: 'fake-disposition-reopened-reviewer-advisor-session',
      findings: 1,
      blockingFindings: 1,
      nextPhase: 'blocked',
    });
    assert.deepStrictEqual(findEvent(events, 'notify.blocked').data, {
      reason: blockReason,
      planName: 'PLAN.md',
      consultantAdvice: null,
    });
    assert.ok(eventIndex(events, 'phase.complete') < eventIndex(events, 'notify.blocked'));
    assert.deepStrictEqual(notifyEventTypes(events), ['notify.blocked']);
    assert.equal(await readFile(fixture.notifyLogPath, 'utf8'), `[neal] PLAN.md: ${blockReason}\n`);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// R1-F2 non-erasure guard: a derived-plan review running inside an *execution*
// child must touch only planReviewDebt, never the durable inheritedPlanReviewDebt
// seeded from the queue handoff. Drive a derived-plan reviewer round that raises a
// plan-correctness finding (round-forcing) alongside a first-occurrence
// verification-hardening finding at/past the threshold: Scope 4 banks the
// hardening finding as deferred debt on ARRIVAL (even though the co-occurring
// correctness finding forces a revision), then a coder response round fixes the
// correctness finding. The inherited debt must survive unchanged and still reach
// the reviewer context.
const SEEDED_INHERITED_DEBT: ResidualReviewDebtItem[] = [
  {
    id: 'R4-F2',
    canonicalId: 'C9',
    status: 'deferred',
    files: ['PLAN.md'],
    claim: 'Inherited: pin the provenance oracle.',
    evidence: '',
    requiredAction: 'Add a provenance assertion.',
    coderDisposition: null,
    coderCommit: null,
    findingClass: 'verification_hardening',
    originRound: 4,
  },
];

test('a derived-plan review in an execution child banks derived debt without erasing inherited plan-review debt', async () => {
  const correctnessClaim = 'The derived plan omits a required verification command.';
  const hardeningClaim = 'The derived plan should also pin the already-specified retry-count behavior.';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-inherited-debt-',
    reviewerProviderId: 'fake-disposition-inherited-debt-reviewer',
    reviewerResponses: [
      {
        summary: 'Round one raised a correctness gap and a hardening ask in the derived plan.',
        executionShape: 'multi_scope',
        findings: [
          {
            severity: 'blocking',
            findingClass: 'plan_correctness',
            files: [...CLAIM_FILES],
            claim: correctnessClaim,
            requiredAction: 'Add the missing verification command.',
          },
          {
            severity: 'blocking',
            findingClass: 'verification_hardening',
            files: [...CLAIM_FILES],
            claim: hardeningClaim,
            requiredAction: 'Add an executable oracle for retry counting.',
          },
        ],
      },
    ],
    maxRounds: 5,
    // Threshold 1 so a first-occurrence hardening finding qualifies at round 1.
    planReviewDebtRoundThreshold: 1,
    topLevelMode: 'execute',
    planDocument: '# Parent Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    derivedPlanDocument: MULTI_SCOPE_PLAN_DOCUMENT,
    stateOverrides: ({ derivedPlanPath }) => ({
      currentScopeNumber: 2,
      derivedPlanPath,
      derivedPlanStatus: 'pending_review',
      derivedFromScopeNumber: 2,
      derivedScopeIndex: null,
      splitPlanStartedNotified: true,
      inheritedPlanReviewDebt: SEEDED_INHERITED_DEBT,
    }),
  });

  // Scope 4 banks the hardening finding as debt on arrival, so by the response
  // round the only open blocking finding is the correctness gap (R1-F1); the coder
  // fixes it. R1-F2 is already deferred debt and is not re-dispositioned here.
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('unexpected text plan-response prompt');
        },
        async runStructuredPrompt<TStructured>(_args: CoderStructuredPromptArgs) {
          return {
            sessionHandle: 'derived-plan-response-session',
            structured: {
              outcome: 'responded',
              summary: 'Fixed the correctness gap; the hardening ask is already recorded debt.',
              blocker: '',
              responses: [{ id: 'R1-F1', decision: 'fixed', summary: 'Added the verification command.' }],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    // Reviewer round: a round-forcing correctness finding co-occurs, so the round
    // does not accept-with-debt; it requests a revision. Scope 4 still banks the
    // first-occurrence past-threshold hardening finding as debt on arrival.
    const reviewed = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);
    assert.equal(reviewed.phase, 'coder_plan_response');
    assert.equal(reviewed.status, 'running');
    // The reviewer round must not have touched the inherited debt.
    assert.deepStrictEqual(reviewed.inheritedPlanReviewDebt, SEEDED_INHERITED_DEBT);
    // Scope 4 arrival conversion: the hardening finding (C2, threshold 1, round 1)
    // is banked as deferred plan-review debt immediately, even though the
    // co-occurring correctness finding forces this revision round.
    assert.deepStrictEqual(reviewed.planReviewDebt.map((debt) => debt.canonicalId), ['C2']);
    assert.equal(reviewed.findings.find((finding) => finding.canonicalId === 'C2')?.status, 'deferred');

    // Coder response round: fixes the correctness finding; the banked hardening
    // finding stays recorded debt.
    const responded = await runPlanningResponsePhase(reviewed, fixture.statePath, 'coder_plan_response', fixture.logger);
    assert.equal(responded.phase, 'reviewer_plan');

    const persisted = await loadState(fixture.statePath);
    // (a) The durable inherited debt is unchanged after both phases.
    assert.deepStrictEqual(persisted.inheritedPlanReviewDebt, SEEDED_INHERITED_DEBT);
    // (b) The derived-plan hardening finding landed in the distinct planReviewDebt.
    assert.equal(persisted.planReviewDebt.length, 1);
    assert.equal(persisted.planReviewDebt[0].canonicalId, 'C2');
    assert.equal(persisted.planReviewDebt[0].findingClass, 'verification_hardening');
    assert.equal(persisted.planReviewDebt[0].originRound, 1);
    assert.equal(persisted.planReviewDebt[0].status, 'deferred');
    // The two debt arrays are genuinely distinct (no cross-contamination).
    assert.notDeepStrictEqual(persisted.planReviewDebt, persisted.inheritedPlanReviewDebt);

    // (c) The reviewer context still surfaces the exact inherited items.
    const packet = buildReviewerContextPacket({ state: persisted });
    assert.deepStrictEqual(packet.inheritedPlanReviewDebt, [
      {
        canonicalId: 'C9',
        findingClass: 'verification_hardening',
        originRound: 4,
        claim: 'Inherited: pin the provenance oracle.',
        requiredAction: 'Add a provenance assertion.',
      },
    ]);
    assert.match(packet.promptMarkdown, /## Inherited Plan-Review Debt/);
    assert.match(packet.promptMarkdown, /- C9: findingClass=verification_hardening; originRound=4/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// R2-F1 regression: the blocking disposition must key on the MERGED open
// round-forcing set, not the current reviewer payload. A prior round raised a
// blocking finding (C1) the coder left unresolved (still open); the current
// reviewer round returns NO findings. Below the cap this must request another
// revision — never accept the plan while a round-forcing blocker is open.
test('an empty reviewer round over a prior unresolved blocking finding forces another revision, never accepts (R2-F1)', async () => {
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-empty-over-open-',
    reviewerProviderId: 'fake-disposition-empty-over-open-reviewer',
    reviewerResponses: [
      { summary: 'Round two found nothing new to add.', executionShape: 'one_shot', findings: [] },
    ],
    // maxRounds 10 keeps round 2 below the cap; with only two rounds neither the
    // reopen (>=3 rounds) nor the stall (window 5) convergence rule fires.
    maxRounds: 10,
    stateOverrides: () => ({
      rounds: [seededReviewRound(1, ['R1-F1'])],
      findings: [seededBlockingFinding({ id: 'R1-F1', round: 1, status: 'open' })],
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    // Must request another revision, NOT accept, while C1 stays open.
    assert.equal(result.phase, 'coder_plan_response');
    assert.equal(result.status, 'running');
    assert.equal(result.blockedFromPhase, null);
    const c1 = result.findings.find((finding) => finding.canonicalId === 'C1');
    assert.equal(c1?.status, 'open');
    assert.equal(result.rounds.at(-1)?.openBlockingCanonicalCount, 1);
    assert.deepStrictEqual(result.rounds.at(-1)?.openBlockingCanonicalIds, ['C1']);
    assert.deepStrictEqual(result.planReviewDebt, []);
    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(notifyEventTypes(events), []);
    assert.equal(existsSync(fixture.notifyLogPath), false);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// R2-F1 regression at the round cap: the same still-open round-forcing blocker
// under an empty final reviewer round must block with the max-rounds reason
// (blockReason derived from the merged invariant), not accept.
test('an empty reviewer round over a prior unresolved blocking finding blocks at the cap with the max-rounds reason (R2-F1)', async () => {
  const blockReason = 'reached max review rounds (2) with blocking findings still open';
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-disp-empty-over-open-cap-',
    reviewerProviderId: 'fake-disposition-empty-over-open-cap-reviewer',
    reviewerResponses: [
      { summary: 'Final round found nothing new to add.', executionShape: 'one_shot', findings: [] },
    ],
    maxRounds: 2,
    stateOverrides: () => ({
      rounds: [seededReviewRound(1, ['R1-F1'])],
      findings: [seededBlockingFinding({ id: 'R1-F1', round: 1, status: 'open' })],
    }),
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    assert.equal(result.phase, 'blocked');
    assert.equal(result.status, 'blocked');
    assert.equal(result.blockedFromPhase, 'reviewer_plan');
    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'notify.blocked').data, {
      reason: blockReason,
      planName: 'PLAN.md',
      consultantAdvice: null,
    });
    assert.deepStrictEqual(notifyEventTypes(events), ['notify.blocked']);
    assert.equal(await readFile(fixture.notifyLogPath, 'utf8'), `[neal] PLAN.md: ${blockReason}\n`);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// Scope 4 real-path novelty/cap coverage: these tests drive runPlanReviewPhase
// (and runPlanningResponsePhase) with a fake reviewer that supplies findings with
// NO preassigned canonical IDs, so the real findCanonicalId claim+files signature
// path assigns and reuses canonicals — the arrival conversion, the second-occurrence
// round-forcing, the 3rd-round reopen block, and the debt lifecycle are exercised
// end-to-end, not only through the recorded-canonical replay harness.

const SCOPE4_HARDENING_CLAIM = 'Verification should pin the already-specified retry-count behavior with an executable oracle.';
const SCOPE4_HARDENING_ACTION = 'Add an executable oracle for the retry-count behavior.';
const SCOPE4_HARDENING2_CLAIM = 'Verification should add coverage of the already-specified idle-timeout path.';
const SCOPE4_HARDENING2_ACTION = 'Add idle-timeout path coverage.';
const SCOPE4_CORRECTNESS_CLAIM = 'The plan instructs editing a model field that does not exist.';
const SCOPE4_CORRECTNESS_ACTION = 'Remove the impossible model-field edit.';

function scope4ReviewerFinding(args: {
  severity: 'blocking' | 'non_blocking';
  findingClass: 'plan_correctness' | 'verification_hardening';
  claim: string;
  requiredAction: string;
}) {
  return {
    severity: args.severity,
    findingClass: args.findingClass,
    files: [...CLAIM_FILES],
    claim: args.claim,
    requiredAction: args.requiredAction,
  };
}

// A stateful openai-codex coder override for multi-round plan-response replay:
// each runStructuredPrompt call returns the next queued payload (clamping at the
// last), so a single test can drive several coder_plan_response rounds with
// distinct dispositions. It returns a fixed planner session handle so the
// plan-response adjudication's session-resume guard stays satisfied across rounds.
function fakePlannerCoderOverride(responses: unknown[]) {
  let callIndex = 0;
  return {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('unexpected text plan-response prompt');
        },
        async runStructuredPrompt<TStructured>(_args: CoderStructuredPromptArgs) {
          const structured = responses[Math.min(callIndex, responses.length - 1)];
          callIndex += 1;
          return { sessionHandle: 'planner-session', structured: structured as TStructured };
        },
      };
    },
  };
}

// (a) A first-occurrence past-threshold hardening finding (a fresh claim/files
// signature -> a newly allocated canonical) banks as deferred debt on arrival and
// the top-level review accepts-with-debt in the same round — no revision round.
test('(Scope 4a) a novel post-threshold hardening finding banks as deferred debt on arrival with no revision round', async () => {
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-scope4-arrival-',
    reviewerProviderId: 'fake-scope4-arrival-reviewer',
    reviewerResponses: [
      {
        summary: 'Round one raised only a verification-hardening ask.',
        executionShape: 'one_shot',
        findings: [
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING_CLAIM,
            requiredAction: SCOPE4_HARDENING_ACTION,
          }),
        ],
      },
    ],
    maxRounds: 5,
    // Threshold 1 so a first-occurrence hardening finding qualifies at round 1.
    planReviewDebtRoundThreshold: 1,
  });

  try {
    const result = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);

    // Accepted-with-debt via the acceptance transition (top-level -> done).
    assert.equal(result.phase, 'done');
    assert.equal(result.status, 'done');
    assert.equal(result.blockedFromPhase, null);
    // The finding is converted to deferred on arrival and leaves the open set.
    const finding = result.findings.find((item) => item.canonicalId === 'C1');
    assert.equal(finding?.status, 'deferred');
    assert.equal(finding?.findingClass, 'verification_hardening');
    assert.equal(result.rounds.at(-1)?.openBlockingCanonicalCount, 0);
    assert.deepStrictEqual(result.rounds.at(-1)?.openBlockingCanonicalIds, []);
    // The debt is recorded with its origin round.
    assert.deepStrictEqual(
      result.planReviewDebt.map((debt) => ({
        canonicalId: debt.canonicalId,
        findingClass: debt.findingClass,
        originRound: debt.originRound,
        status: debt.status,
      })),
      [{ canonicalId: 'C1', findingClass: 'verification_hardening', originRound: 1, status: 'deferred' }],
    );
    // Durable across a state reload.
    const persisted = await loadState(fixture.statePath);
    assert.deepStrictEqual(persisted.planReviewDebt, result.planReviewDebt);
    assert.equal(persisted.findings.find((item) => item.canonicalId === 'C1')?.status, 'deferred');
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// (b) The second occurrence of the same claim/files signature (canonical-reused by
// findCanonicalId, before the 3-round reopen) stays open, is absent from debt, and
// forces a revision round — the middle case that distinguishes novelty from
// thoroughness.
test('(Scope 4b) a second occurrence of a hardening signature stays open, forces a revision, and is absent from debt', async () => {
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-scope4-second-occ-',
    reviewerProviderId: 'fake-scope4-second-occ-reviewer',
    reviewerResponses: [
      {
        summary: 'Round one raised a hardening ask and a correctness gap.',
        executionShape: 'one_shot',
        findings: [
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING_CLAIM,
            requiredAction: SCOPE4_HARDENING_ACTION,
          }),
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'plan_correctness',
            claim: SCOPE4_CORRECTNESS_CLAIM,
            requiredAction: SCOPE4_CORRECTNESS_ACTION,
          }),
        ],
      },
      {
        summary: 'Round two re-raised the same hardening ask.',
        executionShape: 'one_shot',
        findings: [
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING_CLAIM,
            requiredAction: SCOPE4_HARDENING_ACTION,
          }),
        ],
      },
    ],
    maxRounds: 10,
    planReviewDebtRoundThreshold: 1,
    stateOverrides: () => ({ plannerSessionHandle: 'planner-session', plannerSessionProtocol: 'structured_json_v1' }),
  });

  setProviderCapabilitiesOverrideForTesting(
    'openai-codex',
    fakePlannerCoderOverride([
      {
        outcome: 'responded',
        summary: 'Fixed the correctness gap.',
        blocker: '',
        responses: [{ id: 'R1-F2', decision: 'fixed', summary: 'Removed the impossible model-field edit.' }],
      },
    ]),
  );

  try {
    // Round 1: the hardening finding (C1) banks on arrival; the correctness finding
    // (C2) forces a revision.
    const round1 = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);
    assert.equal(round1.phase, 'coder_plan_response');
    assert.deepStrictEqual(round1.planReviewDebt.map((debt) => debt.canonicalId), ['C1']);

    // Coder fixes the correctness gap.
    const resp1 = await runPlanningResponsePhase(round1, fixture.statePath, 'coder_plan_response', fixture.logger);
    assert.equal(resp1.phase, 'reviewer_plan');
    assert.deepStrictEqual(resp1.planReviewDebt.map((debt) => debt.canonicalId), ['C1']);

    // Round 2: the re-raised hardening signature reuses canonical C1 as a repeat
    // occurrence — it stays open (not banked) and forces another revision.
    const round2 = await runPlanReviewPhase(resp1, fixture.statePath, fixture.logger);
    assert.equal(round2.phase, 'coder_plan_response');
    assert.equal(round2.status, 'running');
    assert.equal(round2.blockedFromPhase, null);
    const secondOccurrence = round2.findings.find((item) => item.canonicalId === 'C1' && item.round === 2);
    assert.equal(secondOccurrence?.status, 'open');
    // The banked first occurrence is dropped from the projection once its canonical
    // reopens — no stale debt item survives.
    assert.deepStrictEqual(round2.planReviewDebt, []);
    assert.equal(round2.rounds.at(-1)?.openBlockingCanonicalCount, 1);
    assert.deepStrictEqual(round2.rounds.at(-1)?.openBlockingCanonicalIds, ['C1']);

    const persisted = await loadState(fixture.statePath);
    assert.deepStrictEqual(persisted.planReviewDebt, []);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// (c) A hardening signature raised for a 3rd blocking round trips
// getReopenedCanonical and terminal-blocks (convergence precedence), and is NOT
// mis-converted to debt even though it is hardening-class.
test('(Scope 4c) a hardening signature repeated for a 3rd blocking round trips the reopen block, not debt conversion', async () => {
  const blockReason = 'review_stuck: blocking finding C1 reopened across multiple reviewer rounds';
  const reReviewFinding = {
    summary: 'The same hardening ask remains.',
    executionShape: 'one_shot',
    findings: [
      scope4ReviewerFinding({
        severity: 'blocking',
        findingClass: 'verification_hardening',
        claim: SCOPE4_HARDENING_CLAIM,
        requiredAction: SCOPE4_HARDENING_ACTION,
      }),
    ],
  };
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-scope4-reopen-',
    reviewerProviderId: 'fake-scope4-reopen-reviewer',
    reviewerResponses: [
      {
        summary: 'Round one raised a hardening ask and a correctness gap.',
        executionShape: 'one_shot',
        findings: [
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING_CLAIM,
            requiredAction: SCOPE4_HARDENING_ACTION,
          }),
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'plan_correctness',
            claim: SCOPE4_CORRECTNESS_CLAIM,
            requiredAction: SCOPE4_CORRECTNESS_ACTION,
          }),
        ],
      },
      reReviewFinding,
      reReviewFinding,
    ],
    maxRounds: 10,
    planReviewDebtRoundThreshold: 1,
    stateOverrides: () => ({ plannerSessionHandle: 'planner-session', plannerSessionProtocol: 'structured_json_v1' }),
  });

  setProviderCapabilitiesOverrideForTesting(
    'openai-codex',
    fakePlannerCoderOverride([
      {
        outcome: 'responded',
        summary: 'Fixed the correctness gap.',
        blocker: '',
        responses: [{ id: 'R1-F2', decision: 'fixed', summary: 'Removed the impossible model-field edit.' }],
      },
      {
        outcome: 'responded',
        summary: 'Reworked the hardening oracle.',
        blocker: '',
        responses: [{ id: 'R2-F1', decision: 'fixed', summary: 'Reworked the retry-count oracle.' }],
      },
    ]),
  );

  try {
    // Round 1: C1 hardening banks, C2 correctness forces.
    const round1 = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);
    assert.equal(round1.phase, 'coder_plan_response');
    const resp1 = await runPlanningResponsePhase(round1, fixture.statePath, 'coder_plan_response', fixture.logger);
    assert.equal(resp1.phase, 'reviewer_plan');

    // Round 2: the re-raised C1 is a repeat occurrence — forces a revision.
    const round2 = await runPlanReviewPhase(resp1, fixture.statePath, fixture.logger);
    assert.equal(round2.phase, 'coder_plan_response');
    const resp2 = await runPlanningResponsePhase(round2, fixture.statePath, 'coder_plan_response', fixture.logger);
    assert.equal(resp2.phase, 'reviewer_plan');

    // Round 3: C1 now spans three distinct blocking rounds -> reopen convergence
    // block, terminal-blocked, and NOT converted to debt.
    const round3 = await runPlanReviewPhase(resp2, fixture.statePath, fixture.logger);
    assert.equal(round3.phase, 'blocked');
    assert.equal(round3.status, 'blocked');
    assert.equal(round3.blockedFromPhase, 'reviewer_plan');
    // The reopened hardening canonical is not banked as debt.
    assert.deepStrictEqual(round3.planReviewDebt, []);
    const c1LatestOpen = round3.findings.find((item) => item.canonicalId === 'C1' && item.round === 3);
    assert.equal(c1LatestOpen?.status, 'open');

    const events = await readRunEvents(fixture.runDir);
    assert.deepStrictEqual(findEvent(events, 'notify.blocked').data, {
      reason: blockReason,
      planName: 'PLAN.md',
      consultantAdvice: null,
    });

    const persisted = await loadState(fixture.statePath);
    assert.deepStrictEqual(persisted.planReviewDebt, []);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// (d) Multi-round debt lifecycle: a post-threshold first-occurrence hardening
// finding (C1) banks in the same round a co-occurring correctness finding (C2)
// forces a revision; a later round re-raises C1 (reused -> open -> dropped from
// debt) alongside a fresh hardening finding (C3, banked); the coder then fixes C1.
// state.planReviewDebt never carries a stale or duplicate C1 item, and the final
// debt carried to the queue handoff matches exactly the final finding statuses.
test('(Scope 4d) the plan-review debt projection carries neither stale nor duplicate items across a reopen-and-fix lifecycle', async () => {
  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-scope4-lifecycle-',
    reviewerProviderId: 'fake-scope4-lifecycle-reviewer',
    reviewerResponses: [
      {
        summary: 'Round one raised a hardening ask and a correctness gap.',
        executionShape: 'one_shot',
        findings: [
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING_CLAIM,
            requiredAction: SCOPE4_HARDENING_ACTION,
          }),
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'plan_correctness',
            claim: SCOPE4_CORRECTNESS_CLAIM,
            requiredAction: SCOPE4_CORRECTNESS_ACTION,
          }),
        ],
      },
      {
        summary: 'Round two re-raised the first hardening ask and added a new one.',
        executionShape: 'one_shot',
        findings: [
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING_CLAIM,
            requiredAction: SCOPE4_HARDENING_ACTION,
          }),
          scope4ReviewerFinding({
            severity: 'blocking',
            findingClass: 'verification_hardening',
            claim: SCOPE4_HARDENING2_CLAIM,
            requiredAction: SCOPE4_HARDENING2_ACTION,
          }),
        ],
      },
    ],
    maxRounds: 10,
    planReviewDebtRoundThreshold: 1,
    stateOverrides: () => ({ plannerSessionHandle: 'planner-session', plannerSessionProtocol: 'structured_json_v1' }),
  });

  setProviderCapabilitiesOverrideForTesting(
    'openai-codex',
    fakePlannerCoderOverride([
      {
        outcome: 'responded',
        summary: 'Fixed the correctness gap.',
        blocker: '',
        responses: [{ id: 'R1-F2', decision: 'fixed', summary: 'Removed the impossible model-field edit.' }],
      },
      {
        outcome: 'responded',
        summary: 'Reworked the retry-count oracle.',
        blocker: '',
        responses: [{ id: 'R2-F1', decision: 'fixed', summary: 'Reworked the retry-count oracle.' }],
      },
    ]),
  );

  const debtCanonicals = (state: OrchestrationState) => state.planReviewDebt.map((debt) => debt.canonicalId).sort();

  try {
    // Round 1: C1 hardening banks, C2 correctness forces.
    const round1 = await runPlanReviewPhase(fixture.state, fixture.statePath, fixture.logger);
    assert.equal(round1.phase, 'coder_plan_response');
    assert.deepStrictEqual(debtCanonicals(round1), ['C1']);
    assert.deepStrictEqual(debtCanonicals(await loadState(fixture.statePath)), ['C1']);

    // Response 1: fix the correctness gap; the banked hardening debt persists.
    const resp1 = await runPlanningResponsePhase(round1, fixture.statePath, 'coder_plan_response', fixture.logger);
    assert.equal(resp1.phase, 'reviewer_plan');
    assert.deepStrictEqual(debtCanonicals(resp1), ['C1']);
    assert.deepStrictEqual(debtCanonicals(await loadState(fixture.statePath)), ['C1']);

    // Round 2: C1 reopens (dropped from debt) while a fresh hardening finding (C3)
    // banks. No stale C1 and no duplicate.
    const round2 = await runPlanReviewPhase(resp1, fixture.statePath, fixture.logger);
    assert.equal(round2.phase, 'coder_plan_response');
    assert.deepStrictEqual(debtCanonicals(round2), ['C3']);
    assert.equal(round2.findings.find((item) => item.canonicalId === 'C1' && item.round === 2)?.status, 'open');
    assert.equal(round2.findings.find((item) => item.canonicalId === 'C3')?.status, 'deferred');
    assert.deepStrictEqual(debtCanonicals(await loadState(fixture.statePath)), ['C3']);

    // Response 2: fix the reopened C1; C3 debt remains, C1 stays out of debt.
    const resp2 = await runPlanningResponsePhase(round2, fixture.statePath, 'coder_plan_response', fixture.logger);
    assert.equal(resp2.phase, 'reviewer_plan');
    assert.deepStrictEqual(debtCanonicals(resp2), ['C3']);

    const persisted = await loadState(fixture.statePath);
    // The final debt implied by the final statuses: only C3 (deferred hardening).
    // This is exactly what completePlanningStage carries to the queue item.
    assert.deepStrictEqual(
      persisted.planReviewDebt.map((debt) => ({
        canonicalId: debt.canonicalId,
        findingClass: debt.findingClass,
        originRound: debt.originRound,
        status: debt.status,
      })),
      [{ canonicalId: 'C3', findingClass: 'verification_hardening', originRound: 2, status: 'deferred' }],
    );
    // C1 was fixed and is absent from the projection (no stale/duplicate item).
    assert.equal(persisted.findings.find((item) => item.canonicalId === 'C1' && item.round === 2)?.status, 'fixed');
    assert.equal(persisted.planReviewDebt.filter((debt) => debt.canonicalId === 'C1').length, 0);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
    clearProviderDefinitionRegistrationsForTesting();
  }
});

// Response-eligibility regression: runPlanningResponsePhase must apply coder
// dispositions ONLY to findings it presented this invocation (the mode-matching
// open set — open blocking for a required response), because the response `id`
// schema is an unconstrained z.string(). A planner that names a finding outside
// that set — an already-`deferred` banked-debt finding, an open *non-blocking*
// finding (wrong mode for a required response), a prior-round `fixed`/`rejected`
// finding, or an unknown id — must not mutate any of them, so a banked hardening
// finding cannot be silently un-banked and toPlanReviewDebt's reservation
// survives persistence. Without the openFindings-membership guard, the buggy
// path applied every returned response across all state.findings and dropped the
// C1 debt reservation. This drives the real runtime response phase (not only the
// recorded-canonical replay harness), whose eligibility guard now matches.
function eligibilityRegressionFinding(args: {
  id: string;
  canonicalId: string;
  round: number;
  severity: 'blocking' | 'non_blocking';
  findingClass?: PlanReviewFindingClass;
  status: FindingStatus;
  claim: string;
  requiredAction: string;
}): ReviewFinding {
  return {
    id: args.id,
    canonicalId: args.canonicalId,
    round: args.round,
    source: 'reviewer',
    severity: args.severity,
    ...(args.findingClass !== undefined ? { findingClass: args.findingClass } : {}),
    files: [...CLAIM_FILES],
    claim: args.claim,
    evidence: '',
    requiredAction: args.requiredAction,
    status: args.status,
    roundSummary: `Seeded round ${args.round} summary.`,
    coderDisposition: args.status === 'open' ? null : `Seeded ${args.status} disposition.`,
    coderCommit: null,
  };
}

test('a plan-response disposition targeting a non-presented finding id is a no-op and never erases banked plan-review debt', async () => {
  // Seeded plan-response state: one banked deferred hardening finding (C1, the
  // debt reservation), one presented open blocking correctness finding (C2), plus
  // three findings the required response can never present — an open non-blocking
  // finding (C3, wrong mode), a prior-round fixed finding (C4), and a prior-round
  // rejected finding (C5).
  const seededFindings: ReviewFinding[] = [
    eligibilityRegressionFinding({
      id: 'R1-F1',
      canonicalId: 'C1',
      round: 1,
      severity: 'blocking',
      findingClass: 'verification_hardening',
      status: 'deferred',
      claim: 'Verification should pin the retry-count behavior with an executable oracle.',
      requiredAction: 'Add an executable oracle for the retry-count behavior.',
    }),
    eligibilityRegressionFinding({
      id: 'R1-F2',
      canonicalId: 'C2',
      round: 1,
      severity: 'blocking',
      findingClass: 'plan_correctness',
      status: 'open',
      claim: 'The plan instructs editing a model field that does not exist.',
      requiredAction: 'Remove the impossible model-field edit.',
    }),
    eligibilityRegressionFinding({
      id: 'R1-F3',
      canonicalId: 'C3',
      round: 1,
      severity: 'non_blocking',
      status: 'open',
      claim: 'A non-blocking nicety the required response never presents.',
      requiredAction: 'Consider the optional nicety later.',
    }),
    eligibilityRegressionFinding({
      id: 'R1-F4',
      canonicalId: 'C4',
      round: 1,
      severity: 'blocking',
      findingClass: 'plan_correctness',
      status: 'fixed',
      claim: 'A correctness gap already fixed in a prior round.',
      requiredAction: 'Keep the prior fix.',
    }),
    eligibilityRegressionFinding({
      id: 'R1-F5',
      canonicalId: 'C5',
      round: 1,
      severity: 'blocking',
      findingClass: 'plan_correctness',
      status: 'rejected',
      claim: 'A demand already rejected in a prior round.',
      requiredAction: 'Keep the prior rejection.',
    }),
  ];

  const fixture = await createPlanReviewDispositionFixture({
    prefix: 'neal-plan-review-response-eligibility-',
    reviewerProviderId: 'fake-response-eligibility-reviewer',
    reviewerResponses: [],
    maxRounds: 10,
    planReviewDebtRoundThreshold: 1,
    stateOverrides: () => ({
      phase: 'coder_plan_response',
      status: 'running',
      plannerSessionHandle: 'planner-session',
      plannerSessionProtocol: 'structured_json_v1',
      findings: seededFindings,
      planReviewDebt: toPlanReviewDebt(seededFindings),
    }),
  });

  // Sanity: the seed is a valid debt reservation before the response runs.
  assert.deepStrictEqual(
    fixture.state.planReviewDebt.map((debt) => debt.canonicalId),
    ['C1'],
  );

  setProviderCapabilitiesOverrideForTesting(
    'openai-codex',
    fakePlannerCoderOverride([
      {
        outcome: 'responded',
        summary: 'Fixed the presented correctness gap; also named several non-presented findings.',
        blocker: '',
        responses: [
          // Legitimate: C2 is the only presented (open blocking) finding.
          { id: 'R1-F2', decision: 'fixed', summary: 'Removed the impossible model-field edit.' },
          // Illegitimate targets that must all be no-ops:
          { id: 'R1-F1', decision: 'fixed', summary: 'Tried to un-bank the deferred hardening debt.' },
          { id: 'R1-F3', decision: 'fixed', summary: 'Tried to resolve an open non-blocking finding.' },
          { id: 'R1-F4', decision: 'rejected', summary: 'Tried to re-litigate a previously fixed finding.' },
          { id: 'R1-F5', decision: 'fixed', summary: 'Tried to flip a previously rejected finding.' },
          { id: 'no-such-finding', decision: 'rejected', summary: 'Unknown id.' },
        ],
      },
    ]),
  );

  try {
    const responded = await runPlanningResponsePhase(
      fixture.state,
      fixture.statePath,
      'coder_plan_response',
      fixture.logger,
    );

    const statusByCanonical = (state: OrchestrationState) =>
      Object.fromEntries(state.findings.map((finding) => [finding.canonicalId, finding.status]));

    // Only the presented C2 changed; every non-presented finding kept its status.
    assert.deepStrictEqual(statusByCanonical(responded), {
      C1: 'deferred',
      C2: 'fixed',
      C3: 'open',
      C4: 'fixed',
      C5: 'rejected',
    });
    // The out-of-band responses left no coder disposition on the non-presented
    // findings (their seeded dispositions are unchanged, C1's banked one intact).
    assert.equal(responded.findings.find((finding) => finding.canonicalId === 'C1')?.coderDisposition, 'Seeded deferred disposition.');
    assert.equal(responded.findings.find((finding) => finding.canonicalId === 'C2')?.coderDisposition, 'Removed the impossible model-field edit.');
    assert.equal(responded.findings.find((finding) => finding.canonicalId === 'C3')?.coderDisposition, null);
    // The banked C1 hardening reservation survived the response round.
    assert.deepStrictEqual(
      responded.planReviewDebt.map((debt) => ({
        canonicalId: debt.canonicalId,
        findingClass: debt.findingClass,
        originRound: debt.originRound,
        status: debt.status,
      })),
      [{ canonicalId: 'C1', findingClass: 'verification_hardening', originRound: 1, status: 'deferred' }],
    );
    assert.equal(responded.phase, 'reviewer_plan');
    assert.equal(responded.status, 'running');

    // Durable across a reload of the persisted RUN_STATE.json.
    const persisted = await loadState(fixture.statePath);
    assert.deepStrictEqual(statusByCanonical(persisted), {
      C1: 'deferred',
      C2: 'fixed',
      C3: 'open',
      C4: 'fixed',
      C5: 'rejected',
    });
    assert.deepStrictEqual(persisted.planReviewDebt, responded.planReviewDebt);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
    clearProviderDefinitionRegistrationsForTesting();
  }
});
