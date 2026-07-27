import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearConfigCache } from '../src/neal/config.js';
import { synthesizePlanReviewRound } from '../src/neal/adjudicator/planning.js';
import type { OrchestrationState, ReviewFinding } from '../src/neal/types.js';
import type { ReviewFindingInput } from '../src/neal/adjudicator/planning.js';
import { loadPlanReviewLedger, replayPlanReviewLedger } from './helpers/plan-review-ledger.js';

// getReviewStuckWindow resolves through homedir()/.neal/config.yml; pin a
// private, unique HOME so the default review-stuck window (5) is deterministic
// across the flat suite's parallel child processes.
process.env.HOME = join(tmpdir(), 'neal-test-home-plan-review-ledger-replay');

// Baseline (pre-policy) replay: the real run-2 ledger must reproduce its recorded
// negotiation exactly — four forced revision rounds, then acceptance at round 5 —
// through the shared execute.ts open-set/stall/reopen helpers and the current
// resolvePlanReviewDisposition. This pins today's behavior before Scopes 2-4 add
// the class/novelty/debt policy; those scopes must keep this ledger landing at
// round 5 (it carries real plan-correctness defects at rounds 3-4).
test('run-2 issue-16 ledger replays to five rounds: four request_revision then accept_plan', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-ledger-replay-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('run2-issue-16.json');
  assert.equal(ledger.label, 'issue-16-run2');
  assert.equal(ledger.rounds.length, 5);
  assert.equal(ledger.roundLimit, 20);
  assert.equal(ledger.derivedPlanReview, false);

  const result = replayPlanReviewLedger({ ledger, cwd });

  // Rounds 1-4 stay forced revision rounds; round 5 (no open findings) accepts.
  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'request_revision',
    'accept_plan',
  ]);
  // The recorded per-round open-blocking canonical counts: 2, 1, 2, 2, 0.
  assert.deepStrictEqual(result.openBlockingCounts, [2, 1, 2, 2, 0]);

  // Every finding is fixed by the end (zero re-opens), so the accepted plan
  // carries no open blocking debt in the baseline.
  const openBlocking = result.finalFindings.filter(
    (finding) => finding.status === 'open' && finding.severity === 'blocking',
  );
  assert.deepStrictEqual(openBlocking, []);
  assert.deepStrictEqual(
    result.finalFindings.map((finding) => finding.canonicalId),
    ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'],
  );
  assert.ok(result.finalFindings.every((finding) => finding.status === 'fixed'));
});

// The pure synthesizePlanReviewRound reproduces runPlanReviewPhase's prior inline
// results for a representative input: a round-2 top-level plan review where round
// 1 seeded a now-fixed C1 blocking finding and the current round raises a new
// blocking finding (a fresh claim/files signature -> canonical C2).
test('synthesizePlanReviewRound reproduces the prior inline round synthesis for a representative input', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-round-synth-'));
  clearConfigCache(cwd);

  const seededFixedC1: ReviewFinding = {
    id: 'R1-F1',
    canonicalId: 'C1',
    round: 1,
    source: 'reviewer',
    severity: 'blocking',
    files: ['PLAN.md'],
    claim: 'Round one blocking gap.',
    evidence: '',
    requiredAction: 'Fix the round one gap.',
    status: 'fixed',
    roundSummary: 'Round one summary.',
    coderDisposition: 'Fixed in round one.',
    coderCommit: null,
  };

  const state = {
    cwd,
    findings: [seededFixedC1],
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'rev-1',
        reviewedPlanPath: 'PLAN.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'base0', head: 'base0' },
        openBlockingCanonicalCount: 1,
        openBlockingCanonicalIds: ['C1'],
        findings: ['R1-F1'],
      },
    ],
    derivedPlanStatus: null,
  } as unknown as OrchestrationState;

  const findingInput: ReviewFindingInput = {
    round: 2,
    source: 'reviewer',
    severity: 'blocking',
    files: ['OTHER.md'],
    claim: 'Round two blocking gap.',
    evidence: '',
    requiredAction: 'Fix the round two gap.',
    roundSummary: 'Round two summary.',
  };

  const synthesized = synthesizePlanReviewRound({
    state,
    round: 2,
    roundLimit: 20,
    reviewStuckWindow: 5,
    debtRoundThreshold: 3,
    derivedPlanReview: false,
    currentDerivedPlanStatus: null,
    executionShape: 'one_shot',
    findingInputs: [findingInput],
    reviewerSessionHandle: 'rev-2',
    reviewedPlanPath: 'PLAN.md',
    normalizationApplied: false,
    normalizationOperations: [],
    normalizationScopeLabelMappings: [],
    commitRange: { base: 'base1', head: 'head1' },
  });

  const expectedNewFinding: ReviewFinding = {
    round: 2,
    source: 'reviewer',
    severity: 'blocking',
    files: ['OTHER.md'],
    claim: 'Round two blocking gap.',
    evidence: '',
    requiredAction: 'Fix the round two gap.',
    roundSummary: 'Round two summary.',
    id: 'R2-F1',
    canonicalId: 'C2',
    status: 'open',
    coderDisposition: null,
    coderCommit: null,
  };

  assert.deepStrictEqual(synthesized, {
    findings: [expectedNewFinding],
    mergedFindings: [seededFixedC1, expectedNewFinding],
    disposition: {
      planningSignal: 'request_revision',
      phase: 'coder_plan_response',
      status: 'running',
      derivedPlanStatus: null,
      blockedFromPhase: null,
    },
    blockReason: null,
    openBlockingCanonicalCount: 1,
    // The round-forcing plan_correctness/absent-class finding does not convert:
    // plan-review debt stays empty for this representative round.
    planReviewDebt: [],
    roundRecord: {
      round: 2,
      reviewerSessionHandle: 'rev-2',
      reviewedPlanPath: 'PLAN.md',
      normalizationApplied: false,
      normalizationOperations: [],
      normalizationScopeLabelMappings: [],
      commitRange: { base: 'base1', head: 'head1' },
      openBlockingCanonicalCount: 1,
      openBlockingCanonicalIds: ['C2'],
      findings: ['R2-F1'],
    },
  });
});

// Scope 3 positive case: once every open blocking finding at/past the threshold
// is a first-occurrence verification-hardening finding, the round lands
// accepted-with-debt (accept_plan) and those findings convert to recorded
// plan-review debt with their origin round — no extra revision round burned.
test('accept-with-debt ledger lands at the threshold and records the hardening finding as debt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-accept-debt-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope3-accept-with-debt.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  // Threshold is 3 (default): rounds 1-2 force revision, round 3 accepts-with-debt.
  assert.deepStrictEqual(result.dispositions, ['request_revision', 'request_revision', 'accept_plan']);
  // Round 3's open blocking finding is converted, so the recorded round shows 0
  // open blocking canonicals.
  assert.deepStrictEqual(result.openBlockingCounts, [1, 1, 0]);

  // The converted finding is queryable as plan-review debt with its origin round.
  assert.equal(result.finalPlanReviewDebt.length, 1);
  const debtItem = result.finalPlanReviewDebt[0];
  assert.equal(debtItem.canonicalId, 'C3');
  assert.equal(debtItem.findingClass, 'verification_hardening');
  assert.equal(debtItem.originRound, 3);
  assert.equal(debtItem.status, 'deferred');
  // The debt only appears once the threshold round converts it.
  assert.deepStrictEqual(result.planReviewDebtByRound.map((debt) => debt.length), [0, 0, 1]);
  // The converted finding left the open-blocking set (its status is deferred).
  const c3 = result.finalFindings.find((finding) => finding.canonicalId === 'C3');
  assert.equal(c3?.status, 'deferred');
});

// Scope 4 co-occurrence case (the honest non-shortening guarantee): a
// plan-correctness finding past the threshold keeps the round forced, while a
// co-occurring first-occurrence hardening finding is banked as debt on ARRIVAL —
// the round count is not shortened, but the novel hardening ask still converts
// rather than burning a dedicated round for it.
test('a plan_correctness finding past the threshold still forces a revision round while a co-occurring hardening finding banks on arrival', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-planc-past-threshold-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope3-plan-correctness-past-threshold.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  // The plan_correctness finding (C4) keeps every round forced — no early landing.
  assert.deepStrictEqual(result.dispositions, ['request_revision', 'request_revision', 'request_revision']);
  // The co-occurring first-occurrence hardening finding (C3) is banked on arrival
  // at round 3 (threshold 3), even though C4 forces the round.
  assert.equal(result.finalPlanReviewDebt.length, 1);
  assert.equal(result.finalPlanReviewDebt[0].canonicalId, 'C3');
  assert.equal(result.finalPlanReviewDebt[0].findingClass, 'verification_hardening');
  assert.equal(result.finalPlanReviewDebt[0].originRound, 3);
  assert.deepStrictEqual(result.planReviewDebtByRound.map((debt) => debt.length), [0, 0, 1]);
  const c3 = result.finalFindings.find((finding) => finding.canonicalId === 'C3');
  assert.equal(c3?.status, 'deferred');
  // The plan_correctness finding (C4) stays open and round-forcing (no round 4 fixes it).
  const c4 = result.finalFindings.find((finding) => finding.canonicalId === 'C4');
  assert.equal(c4?.status, 'open');
});

// Scope 3 boundary case: a hardening finding arriving BELOW the threshold is
// round-forcing, not debt-convertible.
test('a below-threshold hardening finding forces a revision round with no debt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-below-threshold-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope3-below-threshold-hardening.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, ['request_revision']);
  assert.deepStrictEqual(result.finalPlanReviewDebt, []);
  assert.deepStrictEqual(result.planReviewDebtByRound, [[]]);
});

// Scope 4 arrival accumulation: post-threshold novel hardening findings bank as
// debt on arrival across successive rounds and never extend the round count. Each
// revision round here is driven by a co-occurring plan_correctness finding; the
// final round carries only a hardening finding and lands accepted-with-debt.
test('post-threshold novel hardening findings accumulate as debt without extending the round count', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-novel-hardening-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope4-novel-hardening-accumulates.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  // Every revision round was forced by a plan_correctness finding; the final
  // hardening-only round accepts-with-debt. No hardening ask burned its own round.
  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'request_revision',
    'accept_plan',
  ]);
  // Debt accumulates monotonically as each novel hardening finding arrives.
  assert.deepStrictEqual(result.planReviewDebtByRound.map((debt) => debt.length), [0, 0, 1, 2, 3]);
  // The three converted hardening findings are recorded with their origin rounds.
  assert.deepStrictEqual(
    result.finalPlanReviewDebt.map((debt) => ({
      canonicalId: debt.canonicalId,
      findingClass: debt.findingClass,
      originRound: debt.originRound,
      status: debt.status,
    })),
    [
      { canonicalId: 'C3', findingClass: 'verification_hardening', originRound: 3, status: 'deferred' },
      { canonicalId: 'C5', findingClass: 'verification_hardening', originRound: 4, status: 'deferred' },
      { canonicalId: 'C7', findingClass: 'verification_hardening', originRound: 5, status: 'deferred' },
    ],
  );
});

// Scope 4 cap conversion: at the round cap the convertible set is class-based
// (regardless of first-occurrence), so a re-litigated (second-occurrence)
// hardening finding converts to debt rather than forcing an impossible extra
// round. C3 spans only two rounds, so the reopen convergence block stays quiet.
test('a cap-reached round with only non-reopened hardening open lands accepted-with-debt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-cap-accepts-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope4-cap-hardening-accepts.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'accept_plan',
  ]);
  // The cap round converts the re-raised hardening finding, so it records 0 open.
  assert.deepStrictEqual(result.openBlockingCounts, [1, 1, 1, 0]);
  assert.equal(result.finalPlanReviewDebt.length, 1);
  assert.equal(result.finalPlanReviewDebt[0].canonicalId, 'C3');
  assert.equal(result.finalPlanReviewDebt[0].findingClass, 'verification_hardening');
  // Latest round wins: the debt item carries the cap round (4) as its origin.
  assert.equal(result.finalPlanReviewDebt[0].originRound, 4);
  const c3 = result.finalFindings.filter((finding) => finding.canonicalId === 'C3');
  assert.equal(c3.at(-1)?.status, 'deferred');
});

// Scope 4 cap block: any open plan_correctness finding at the cap terminal-blocks
// the run (no rounds left to force), and the co-occurring hardening finding is
// NOT banked — the run fails rather than converting debt.
test('a cap-reached round with any open plan_correctness finding terminal-blocks without converting debt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-cap-planc-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope4-cap-plan-correctness-blocks.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, ['request_revision', 'request_revision', 'block_for_operator']);
  // Nothing converts: the terminal block leaves the hardening finding open.
  assert.deepStrictEqual(result.finalPlanReviewDebt, []);
  const c3 = result.finalFindings.find((finding) => finding.canonicalId === 'C3');
  assert.equal(c3?.status, 'open');
  const c4 = result.finalFindings.find((finding) => finding.canonicalId === 'C4');
  assert.equal(c4?.status, 'open');
});

// Scope 4 convergence precedence at the cap (reopen): a hardening canonical that
// has appeared as blocking across three distinct rounds trips getReopenedCanonical
// and terminal-blocks at the cap; it is banked as debt on its first arrival but
// dropped from the projection once it reopens, and it is never mis-converted.
test('a cap-reached round whose open hardening canonical is reopened terminal-blocks, not converts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-cap-reopened-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope4-cap-reopened-hardening-blocks.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'request_revision',
    'block_for_operator',
  ]);
  // Banked on first arrival (round 3), dropped when reopened (round 4+), never
  // converted at the cap: the reopen convergence block wins.
  assert.deepStrictEqual(result.planReviewDebtByRound.map((debt) => debt.length), [0, 0, 1, 0, 0]);
  assert.deepStrictEqual(result.finalPlanReviewDebt, []);
});

// Scope 4 convergence precedence at the cap (stall): with review_stuck_window 2,
// an unchanged open-blocking canonical set across the 2-round window trips the
// stall rule and terminal-blocks at the cap; the hardening finding is not
// converted.
test('a cap-reached round whose open hardening canonical is stall-tripped terminal-blocks, not converts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-cap-stalled-'));
  await writeFile(join(cwd, 'neal.yml'), 'neal:\n  review_stuck_window: 2\n', 'utf8');
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope4-cap-stalled-hardening-blocks.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, ['request_revision', 'block_for_operator']);
  assert.deepStrictEqual(result.finalPlanReviewDebt, []);
  const c1 = result.finalFindings.find((finding) => finding.canonicalId === 'C1');
  assert.equal(c1?.status, 'open');
});
