import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearConfigCache } from '../src/neal/config.js';
import {
  loadPlanReviewLedger,
  parsePlanReviewLedger,
  replayPlanReviewLedger,
} from './helpers/plan-review-ledger.js';

// Scope 5 corpus acceptance: pin the convergence policy's end-to-end judgments
// against checked-in ledgers — the real issue-16 run-2 negotiation (now with each
// canonical's faithfully assigned findingClass) plus authored positive, negative,
// and at-scale controls. Every fixture replays through the SAME pure round core
// runPlanReviewPhase uses (synthesizePlanReviewRoundFromFindings, via the ledger
// replay driver), so these tests catch any drift in the runtime gating/disposition
// policy. Committed fixtures are the sole runtime source; no test reads
// tmp/ratchet-corpus/.

// getReviewStuckWindow / getPlanReviewDebtRoundThreshold resolve through
// homedir()/.neal/config.yml; pin a private, unique HOME so the defaults
// (review-stuck window 5, debt threshold 3) are deterministic across the flat
// suite's parallel child processes.
process.env.HOME = join(tmpdir(), 'neal-test-home-plan-review-corpus-acceptance');

// The real run-2 ledger, classified: genuine plan_correctness defects surface at
// rounds 3 (C4, C5) and 4 (C7), so those rounds stay forced and the ledger does
// NOT land early — four request_revision rounds then accept_plan at round 5,
// exactly as the pre-policy baseline recorded. The policy honestly does not
// shorten a negotiation that surfaced real defects.
test('run-2 policy ledger keeps its plan_correctness rounds forced: five rounds, no early landing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-corpus-run2-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope5-run2-policy.json');
  assert.equal(ledger.label, 'scope5-run2-policy');
  assert.equal(ledger.rounds.length, 5);

  // The faithfully assigned classes are recorded in the fixture.
  const classByCanonical = new Map<string, string | undefined>();
  for (const round of ledger.rounds) {
    for (const finding of round.reviewerFindings) {
      classByCanonical.set(finding.canonicalId, finding.findingClass);
    }
  }
  assert.deepStrictEqual(
    ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((id) => classByCanonical.get(id)),
    [
      'verification_hardening',
      'plan_correctness',
      'verification_hardening',
      'plan_correctness',
      'plan_correctness',
      'plan_correctness',
      'plan_correctness',
    ],
  );

  const result = replayPlanReviewLedger({ ledger, cwd });

  // Honest non-shortening: still four forced rounds, acceptance only at round 5.
  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'request_revision',
    'accept_plan',
  ]);
  // Rounds 3 and 4 are forced by genuine plan_correctness defects (C4/C5, then
  // C6/C7). With C6 faithfully classified plan_correctness — the unrestricted
  // slug fallback would invent dollar prices for unlisted models, a wrong-output
  // defect, not a coverage gap — it enters round 4's open-blocking set alongside
  // C7 rather than banking on arrival, so the policy reproduces the baseline's
  // recorded per-round open-blocking canonical counts exactly.
  assert.deepStrictEqual(result.openBlockingCounts, [2, 1, 2, 2, 0]);

  // C6 is fixed, not banked as debt: the never-invent-dollars correctness defect
  // was resolved in the negotiation rather than deferred as verification debt.
  // (Check absence before the empty-array assertion below, which narrows the
  // typed array to never[].)
  assert.ok(
    result.finalPlanReviewDebt.every((debt) => debt.canonicalId !== 'C6'),
    'C6 must not appear in the accepted plan-review debt',
  );
  // The accepted plan carries NO plan-review debt at all. No first-occurrence
  // verification_hardening finding ever survives past the threshold unfixed
  // (C1/C3 are pre-threshold and fixed), so nothing converts; every finding —
  // including C6 — was presented to the coder and fixed, and nothing re-opened.
  assert.deepStrictEqual(result.finalPlanReviewDebt, []);
  const c6 = result.finalFindings.find((finding) => finding.canonicalId === 'C6');
  assert.equal(c6?.findingClass, 'plan_correctness');
  assert.equal(c6?.status, 'fixed');
  assert.ok(result.finalFindings.every((finding) => finding.status === 'fixed'));

  // The round-3 and round-4 forcing findings are the recorded plan_correctness
  // defects — the policy did not mislabel them to shorten the negotiation.
  const c4 = result.finalFindings.find((finding) => finding.canonicalId === 'C4');
  const c5 = result.finalFindings.find((finding) => finding.canonicalId === 'C5');
  const c7 = result.finalFindings.find((finding) => finding.canonicalId === 'C7');
  assert.equal(c4?.findingClass, 'plan_correctness');
  assert.equal(c5?.findingClass, 'plan_correctness');
  assert.equal(c7?.findingClass, 'plan_correctness');
});

// Positive convergence: once the post-threshold tail carries ONLY
// verification_hardening findings, the round lands accepted-with-debt and the tail
// reservations are recorded as debt instead of dropped.
test('all-hardening tail lands accepted-with-debt at the threshold and records the tail as debt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-corpus-hardening-tail-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope5-all-hardening-tail.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  // Rounds 1-2 (plan_correctness) force revision; round 3 (== threshold, all
  // hardening) accepts-with-debt.
  assert.deepStrictEqual(result.dispositions, ['request_revision', 'request_revision', 'accept_plan']);
  // The three converted findings leave the open-blocking set, so the threshold
  // round records 0 open blocking canonicals.
  assert.deepStrictEqual(result.openBlockingCounts, [1, 1, 0]);
  // Debt appears only once the threshold round converts the tail.
  assert.deepStrictEqual(result.planReviewDebtByRound.map((debt) => debt.length), [0, 0, 3]);

  // All three tail findings are recorded as deferred plan-review debt with their
  // origin round.
  assert.deepStrictEqual(
    result.finalPlanReviewDebt.map((debt) => ({
      canonicalId: debt.canonicalId,
      findingClass: debt.findingClass,
      originRound: debt.originRound,
      status: debt.status,
    })),
    [
      { canonicalId: 'C3', findingClass: 'verification_hardening', originRound: 3, status: 'deferred' },
      { canonicalId: 'C4', findingClass: 'verification_hardening', originRound: 3, status: 'deferred' },
      { canonicalId: 'C5', findingClass: 'verification_hardening', originRound: 3, status: 'deferred' },
    ],
  );
});

// Negative control: a genuine plan_correctness defect surfacing at round 4 (past
// the threshold) still forces a revision round. The policy must never wave through
// a correctness defect just because refinement has passed the threshold.
test('negative control: a plan_correctness defect at round 4 still forces revision past the threshold', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-corpus-negative-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope5-negative-control.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  // Four forced rounds, no acceptance — the round-4 defect is not waved through.
  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'request_revision',
  ]);
  // Nothing converts: no verification-hardening finding ever appears, so debt stays
  // empty across every round.
  assert.deepStrictEqual(result.finalPlanReviewDebt, []);
  assert.deepStrictEqual(result.planReviewDebtByRound, [[], [], [], []]);
  // The round-4 defect stays an open plan_correctness blocker (never deferred).
  const c4 = result.finalFindings.find((finding) => finding.canonicalId === 'C4');
  assert.equal(c4?.status, 'open');
  assert.equal(c4?.findingClass, 'plan_correctness');
});

// At-scale: many hardening asks accumulate as debt past the threshold WITHOUT
// growing the round count. Six hardening findings convert to debt across a
// negotiation whose round count stays bounded at 5 — every forced round was
// driven by a plan_correctness finding, never by a hardening ask.
test('at-scale: hardening findings accumulate as debt without growing the round count', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-corpus-at-scale-'));
  clearConfigCache(cwd);

  const ledger = await loadPlanReviewLedger('scope5-at-scale.json');
  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'request_revision',
    'accept_plan',
  ]);
  // Debt accumulates monotonically as each novel hardening finding banks on
  // arrival: +2 at round 3, +2 at round 4, +2 at round 5.
  assert.deepStrictEqual(result.planReviewDebtByRound.map((debt) => debt.length), [0, 0, 2, 4, 6]);

  // Six hardening findings converted to debt with their origin rounds.
  assert.deepStrictEqual(
    result.finalPlanReviewDebt.map((debt) => ({
      canonicalId: debt.canonicalId,
      findingClass: debt.findingClass,
      originRound: debt.originRound,
    })),
    [
      { canonicalId: 'C3', findingClass: 'verification_hardening', originRound: 3 },
      { canonicalId: 'C4', findingClass: 'verification_hardening', originRound: 3 },
      { canonicalId: 'C6', findingClass: 'verification_hardening', originRound: 4 },
      { canonicalId: 'C7', findingClass: 'verification_hardening', originRound: 4 },
      { canonicalId: 'C9', findingClass: 'verification_hardening', originRound: 5 },
      { canonicalId: 'C10', findingClass: 'verification_hardening', originRound: 5 },
    ],
  );

  // The bound: more hardening asks converted (6) than rounds run (5). Had each
  // hardening ask forced its own round, the negotiation would have grown by at
  // least six additional rounds.
  assert.ok(result.finalPlanReviewDebt.length > result.dispositions.length);
  assert.equal(result.dispositions.length, 5);
});

// Harness runtime-fidelity guard: a finding that arrival-time conversion banked as
// deferred plan-review debt is not an eligible open finding, so
// runPlanningResponsePhase never presents it and a coder disposition can never
// resolve it. This ledger records a (would-be) `fixed` disposition against the
// banked hardening finding C3; the replay driver must IGNORE it, leaving C3 as
// recorded debt. Without the eligibility guard the disposition would flip C3 to
// fixed and drop it from the projection — the exact defect this test pins.
test('replay ignores a coder disposition recorded against a banked (deferred) finding', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-plan-review-corpus-banked-disposition-'));
  clearConfigCache(cwd);

  const ledger = parsePlanReviewLedger({
    schemaVersion: 1,
    label: 'banked-disposition-guard',
    roundLimit: 20,
    rounds: [
      {
        round: 1,
        reviewerFindings: [
          { canonicalId: 'C1', severity: 'blocking', findingClass: 'plan_correctness', files: ['PLAN.md'], claimDigest: 'A round-one plan-correctness defect.' },
        ],
        coderDispositions: [{ canonicalId: 'C1', decision: 'fixed' }],
      },
      {
        round: 2,
        reviewerFindings: [
          { canonicalId: 'C2', severity: 'blocking', findingClass: 'plan_correctness', files: ['PLAN.md'], claimDigest: 'A round-two plan-correctness defect.' },
        ],
        coderDispositions: [{ canonicalId: 'C2', decision: 'fixed' }],
      },
      {
        round: 3,
        reviewerFindings: [
          { canonicalId: 'C3', severity: 'blocking', findingClass: 'verification_hardening', files: ['src/neal/state.ts'], claimDigest: 'A first-occurrence hardening ask that banks on arrival at the threshold.' },
          { canonicalId: 'C4', severity: 'blocking', findingClass: 'plan_correctness', files: ['PLAN.md'], claimDigest: 'A co-occurring plan-correctness defect that forces the round.' },
        ],
        // C3 banked on arrival (never presented); the recorded C3 disposition must
        // be ignored. C4 was presented (open) and is legitimately fixed.
        coderDispositions: [
          { canonicalId: 'C3', decision: 'fixed' },
          { canonicalId: 'C4', decision: 'fixed' },
        ],
      },
      { round: 4, reviewerFindings: [], coderDispositions: [] },
    ],
  });

  const result = replayPlanReviewLedger({ ledger, cwd });

  assert.deepStrictEqual(result.dispositions, [
    'request_revision',
    'request_revision',
    'request_revision',
    'accept_plan',
  ]);
  // The banked C3 disposition was ignored: C3 stays deferred debt, C4 is fixed.
  assert.deepStrictEqual(
    result.finalPlanReviewDebt.map((debt) => ({ canonicalId: debt.canonicalId, originRound: debt.originRound, status: debt.status })),
    [{ canonicalId: 'C3', originRound: 3, status: 'deferred' }],
  );
  const c3 = result.finalFindings.find((finding) => finding.canonicalId === 'C3');
  const c4 = result.finalFindings.find((finding) => finding.canonicalId === 'C4');
  assert.equal(c3?.status, 'deferred');
  assert.equal(c4?.status, 'fixed');
});
