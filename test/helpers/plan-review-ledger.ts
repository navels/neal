import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { isOpenBlockingFinding, mapDecisionToStatus } from '../../src/neal/adjudicator/execute.js';
import { synthesizePlanReviewRoundFromFindings } from '../../src/neal/adjudicator/planning.js';
import { getPlanReviewDebtRoundThreshold, getReviewStuckWindow } from '../../src/neal/config.js';
import { toPlanReviewDebt } from '../../src/neal/review-debt.js';
import type {
  FindingSeverity,
  OrchestrationState,
  PlanReviewFindingClass,
  ResidualReviewDebtItem,
  ReviewFinding,
  ReviewRound,
} from '../../src/neal/types.js';

// Loader + replay driver for the versioned plan-review ledger fixtures under
// test/fixtures/plan-review-ledgers/ (see that directory's SCHEMA.md). The
// driver replays a recorded/authored negotiation through the SAME pure round
// synthesis policy the runtime uses — synthesizePlanReviewRoundFromFindings, the
// shared core beneath runPlanReviewPhase's synthesizePlanReviewRound — so any
// drift in the real gating/disposition core is caught here. It supplies findings
// with the fixture's trusted, recorded canonicalIds (it never recomputes
// signatures via findCanonicalId), exercising the disposition/gating policy, not
// canonical assignment. It duplicates none of that policy. Reads only committed
// fixtures.

const FINDING_DECISIONS = ['fixed', 'rejected', 'deferred'] as const;
const FINDING_SEVERITIES: readonly FindingSeverity[] = ['blocking', 'non_blocking'];

export type PlanReviewLedgerDecision = (typeof FINDING_DECISIONS)[number];

export type PlanReviewLedgerFinding = {
  canonicalId: string;
  severity: FindingSeverity;
  // Optional; added by Scope 2. The Scope 1 baseline replay driver does not
  // thread it (ReviewFinding carries no findingClass yet) but the loader keeps
  // it so later scopes can extend the harness without re-authoring fixtures.
  findingClass?: string;
  files: string[];
  claimDigest: string;
};

export type PlanReviewLedgerDisposition = {
  canonicalId: string;
  decision: PlanReviewLedgerDecision;
};

export type PlanReviewLedgerRound = {
  round: number;
  reviewerFindings: PlanReviewLedgerFinding[];
  coderDispositions: PlanReviewLedgerDisposition[];
};

export type PlanReviewLedger = {
  schemaVersion: number;
  label: string;
  roundLimit: number;
  derivedPlanReview: boolean;
  rounds: PlanReviewLedgerRound[];
  source?: string;
  description?: string;
};

export type PlanReviewReplayResult = {
  // resolvePlanReviewDisposition().planningSignal per round, in order.
  dispositions: string[];
  // openBlockingCanonicalCount per round, in order.
  openBlockingCounts: number[];
  // The reviewer-round records the driver accumulated (used for stall detection).
  rounds: ReviewRound[];
  // The merged findings after the final round, with statuses applied.
  finalFindings: ReviewFinding[];
  // The plan-review debt projected after each round, in order (Scope 3/4).
  planReviewDebtByRound: ResidualReviewDebtItem[][];
  // The plan-review debt projected from the final merged findings (Scope 3/4).
  finalPlanReviewDebt: ResidualReviewDebtItem[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invalid plan-review ledger fixture: ${message}`);
  }
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}

function parseFinding(value: unknown, where: string): PlanReviewLedgerFinding {
  const record = asRecord(value, `${where} must be an object`);
  assert(typeof record.canonicalId === 'string' && record.canonicalId.length > 0, `${where}.canonicalId must be a non-empty string`);
  assert(
    typeof record.severity === 'string' && FINDING_SEVERITIES.includes(record.severity as FindingSeverity),
    `${where}.severity must be one of: ${FINDING_SEVERITIES.join(', ')}`,
  );
  assert(Array.isArray(record.files) && record.files.every((file) => typeof file === 'string'), `${where}.files must be a string array`);
  assert(typeof record.claimDigest === 'string' && record.claimDigest.length > 0, `${where}.claimDigest must be a non-empty string`);
  if (record.findingClass !== undefined) {
    assert(typeof record.findingClass === 'string', `${where}.findingClass must be a string when present`);
  }
  return {
    canonicalId: record.canonicalId,
    severity: record.severity as FindingSeverity,
    files: record.files as string[],
    claimDigest: record.claimDigest,
    findingClass: record.findingClass as string | undefined,
  };
}

function parseDisposition(value: unknown, where: string): PlanReviewLedgerDisposition {
  const record = asRecord(value, `${where} must be an object`);
  assert(typeof record.canonicalId === 'string' && record.canonicalId.length > 0, `${where}.canonicalId must be a non-empty string`);
  assert(
    typeof record.decision === 'string' && FINDING_DECISIONS.includes(record.decision as PlanReviewLedgerDecision),
    `${where}.decision must be one of: ${FINDING_DECISIONS.join(', ')}`,
  );
  return { canonicalId: record.canonicalId, decision: record.decision as PlanReviewLedgerDecision };
}

export function parsePlanReviewLedger(value: unknown): PlanReviewLedger {
  const record = asRecord(value, 'root must be an object');
  assert(record.schemaVersion === 1, 'schemaVersion must be 1');
  assert(typeof record.label === 'string' && record.label.length > 0, 'label must be a non-empty string');
  assert(typeof record.roundLimit === 'number' && Number.isInteger(record.roundLimit) && record.roundLimit > 0, 'roundLimit must be a positive integer');
  const derivedPlanReview = record.derivedPlanReview ?? false;
  assert(typeof derivedPlanReview === 'boolean', 'derivedPlanReview must be a boolean when present');
  assert(Array.isArray(record.rounds) && record.rounds.length > 0, 'rounds must be a non-empty array');

  const rounds = record.rounds.map((roundValue, index): PlanReviewLedgerRound => {
    const roundRecord = asRecord(roundValue, `rounds[${index}] must be an object`);
    assert(roundRecord.round === index + 1, `rounds[${index}].round must be ${index + 1} (contiguous, 1-based)`);
    assert(Array.isArray(roundRecord.reviewerFindings), `rounds[${index}].reviewerFindings must be an array`);
    assert(Array.isArray(roundRecord.coderDispositions), `rounds[${index}].coderDispositions must be an array`);
    return {
      round: index + 1,
      reviewerFindings: roundRecord.reviewerFindings.map((finding, findingIndex) =>
        parseFinding(finding, `rounds[${index}].reviewerFindings[${findingIndex}]`),
      ),
      coderDispositions: roundRecord.coderDispositions.map((disposition, dispositionIndex) =>
        parseDisposition(disposition, `rounds[${index}].coderDispositions[${dispositionIndex}]`),
      ),
    };
  });

  return {
    schemaVersion: 1,
    label: record.label,
    roundLimit: record.roundLimit,
    derivedPlanReview,
    rounds,
    source: typeof record.source === 'string' ? record.source : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
  };
}

export async function loadPlanReviewLedger(fileName: string): Promise<PlanReviewLedger> {
  const path = fileURLToPath(new URL(`../fixtures/plan-review-ledgers/${fileName}`, import.meta.url));
  const raw = await readFile(path, 'utf8');
  return parsePlanReviewLedger(JSON.parse(raw));
}

function ledgerFindingToReviewFinding(finding: PlanReviewLedgerFinding, round: number, index: number): ReviewFinding {
  return {
    id: `R${round}-F${index + 1}`,
    canonicalId: finding.canonicalId,
    round,
    source: 'reviewer',
    severity: finding.severity,
    // The fixture's declared class reaches the disposition policy exactly as the
    // reviewer-payload normalizer would deliver it (Scope 2/3): an absent class
    // stays undefined and is fail-safe round-forcing at the decision site.
    ...(finding.findingClass !== undefined ? { findingClass: finding.findingClass as PlanReviewFindingClass } : {}),
    files: [...finding.files],
    claim: finding.claimDigest,
    evidence: '',
    requiredAction: '(replay fixture)',
    status: 'open',
    roundSummary: '(replay fixture)',
    coderDisposition: null,
    coderCommit: null,
  };
}

// Replays the ledger round by round through the shared runtime synthesis core.
// Between reviewer rounds it applies the prior round's coder dispositions (via
// mapDecisionToStatus, mirroring runPlanningResponsePhase), then hands the
// current round's trusted-canonical findings and the accumulated prior findings
// to synthesizePlanReviewRoundFromFindings — the exact gating/disposition policy
// runPlanReviewPhase runs. `cwd` selects the review-stuck window via config
// (default 5 for a cwd with no neal config), resolved once at the boundary just
// like runPlanReviewPhase does.
export function replayPlanReviewLedger(args: { ledger: PlanReviewLedger; cwd: string }): PlanReviewReplayResult {
  const { ledger } = args;
  const reviewStuckWindow = getReviewStuckWindow(args.cwd);
  const debtRoundThreshold = getPlanReviewDebtRoundThreshold(args.cwd);
  const dispositions: string[] = [];
  const openBlockingCounts: number[] = [];
  const rounds: ReviewRound[] = [];
  const planReviewDebtByRound: ResidualReviewDebtItem[][] = [];
  let accumulated: ReviewFinding[] = [];

  ledger.rounds.forEach((round, index) => {
    if (index > 0) {
      const priorDispositions = ledger.rounds[index - 1].coderDispositions;
      const decisionByCanonical = new Map(
        priorDispositions.map((disposition) => [disposition.canonicalId, mapDecisionToStatus(disposition.decision)]),
      );
      // Runtime response-eligibility contract: runPlanningResponsePhase presents
      // only the prior round's mode-matching open findings to the coder and now
      // applies each disposition ONLY to a finding in that presented `openFindings`
      // set (an out-of-set `id` is a no-op). These fixtures replay the required
      // `coder_plan_response` path, whose presented set is the open *blocking*
      // findings, so the replay mirrors it with `isOpenBlockingFinding`. A finding
      // that arrival-time debt conversion already flipped to `deferred` (banked as
      // plan-review debt) — or any non-open/non-blocking finding — was never
      // presented, so a disposition a fixture records against it is a no-op,
      // exactly as the real response phase now leaves it banked.
      accumulated = accumulated.map((finding) =>
        isOpenBlockingFinding(finding) && decisionByCanonical.has(finding.canonicalId)
          ? { ...finding, status: decisionByCanonical.get(finding.canonicalId)! }
          : finding,
      );
    }

    const findings = round.reviewerFindings.map((finding, findingIndex) =>
      ledgerFindingToReviewFinding(finding, round.round, findingIndex),
    );

    // Only state.findings (prior findings) and state.rounds (stall snapshots) are
    // read by the pure core; a minimal projection is sufficient.
    const state = {
      cwd: args.cwd,
      findings: accumulated,
      rounds,
    } as unknown as OrchestrationState;

    const synthesized = synthesizePlanReviewRoundFromFindings({
      state,
      round: round.round,
      roundLimit: ledger.roundLimit,
      reviewStuckWindow,
      debtRoundThreshold,
      derivedPlanReview: ledger.derivedPlanReview,
      currentDerivedPlanStatus: null,
      reviewerSessionHandle: null,
      reviewedPlanPath: null,
      normalizationApplied: false,
      normalizationOperations: [],
      normalizationScopeLabelMappings: [],
      commitRange: { base: '', head: '' },
      findings,
    });

    dispositions.push(synthesized.disposition.planningSignal);
    openBlockingCounts.push(synthesized.openBlockingCanonicalCount);
    rounds.push(synthesized.roundRecord);
    planReviewDebtByRound.push(synthesized.planReviewDebt);
    accumulated = synthesized.mergedFindings;
  });

  return {
    dispositions,
    openBlockingCounts,
    rounds,
    finalFindings: accumulated,
    planReviewDebtByRound,
    finalPlanReviewDebt: toPlanReviewDebt(accumulated),
  };
}
