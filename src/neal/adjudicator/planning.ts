import { resolve } from 'node:path';

import { runCoderPlanResponseRound, runPlanReviewerRound } from '../agents.js';
import { readTextForInlineSection } from '../context/inline-review-context.js';
import { buildAndPersistReviewerContextPacket } from '../context/reviewer-context.js';
import type { RunLogger } from '../logger.js';
import { getProviderDefinition } from '../providers/registry.js';
import { getDerivedPlanView } from '../state-views.js';
import type { AgentRoleConfig, OrchestrationState, ReviewFinding, ReviewRound } from '../types.js';
import {
  findCanonicalId,
  getNextCanonicalIndex,
  getOpenBlockingCanonicalSet,
  getReopenedCanonical,
  hasRepeatedUnresolvedBlockingCanonicalsForWindow,
  isOpenBlockingFinding,
  isOpenNonBlockingFinding,
} from './execute.js';
import { toPlanReviewDebt } from '../review-debt.js';
import type { ResidualReviewDebtItem } from '../types.js';
import { getAdjudicationSpec, type AdjudicationSpec } from './specs.js';

export type PlanReviewMode = 'plan' | 'derived-plan';
export type PlanningAdjudicationSpec = AdjudicationSpec & { family: 'plan_review' };
export type ReviewFindingInput = Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>;

export type PreparedPlanReview = {
  executionShape: OrchestrationState['executionShape'];
  reviewedPlanPath: string;
  originalPlanPath: string;
  validation: {
    ok: boolean;
    executionShape: OrchestrationState['executionShape'];
    errors: string[];
    normalization: {
      applied: boolean;
      operations: string[];
      scopeLabelMappings: {
        normalizedScopeNumber: number;
        originalScopeLabel: string;
      }[];
    };
  };
};

export type PlanningReviewSynthesis = {
  executionShape: OrchestrationState['executionShape'];
  reviewedPlanPath: string;
  findings: ReviewFindingInput[];
};

export type PlanningAdjudicationContext = {
  spec: PlanningAdjudicationSpec;
  reviewMode: PlanReviewMode;
  derivedPlanReview: boolean;
  reviewTargetPath: string;
  roundLimit: number;
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
};

type PlanReviewerRoundRunner = typeof runPlanReviewerRound;
type CoderPlanResponseRoundRunner = typeof runCoderPlanResponseRound;

export function isDerivedPlanReviewState(state: OrchestrationState) {
  return getDerivedPlanView(state)?.reviewActive ?? false;
}

// The planner role runs through the coder adapter, so its session-resume capability comes from
// the provider's coder capabilities. Providers that declare `supportsSessionResume: false`
// (openai-compatible) never persist a planner session handle — a null handle is
// their expected steady state, so top-level plan-refinement responses must start a fresh planner
// session for them instead of treating the missing handle as corrupted state. Resume-capable
// planner providers keep the hard invariant: a missing handle there is a genuine violation.
export function plannerProviderStartsFreshSessions(planner: AgentRoleConfig): boolean {
  return !getProviderDefinition(planner.provider).capabilities.coder.supportsSessionResume;
}

export function resolvePlanningAdjudicationContext(state: OrchestrationState): PlanningAdjudicationContext {
  const derivedPlan = getDerivedPlanView(state);
  const derivedPlanReview = derivedPlan?.reviewActive ?? false;

  const reviewMode: PlanReviewMode = derivedPlanReview ? 'derived-plan' : 'plan';
  const spec = getAdjudicationSpec(
    reviewMode === 'derived-plan'
      ? 'derived_plan_review'
      : 'plan_review',
  ) as PlanningAdjudicationSpec;

  if (spec.family !== 'plan_review') {
    throw new Error(`Expected planning adjudication spec, received ${spec.id}.`);
  }

  return {
    spec,
    reviewMode,
    derivedPlanReview,
    reviewTargetPath:
      derivedPlanReview && derivedPlan
        ? derivedPlan.path
        : state.planDoc,
    roundLimit: derivedPlanReview && derivedPlan ? derivedPlan.counters.maxDerivedPlanReviewRounds : state.maxRounds,
    parentPlanDoc: derivedPlanReview ? state.planDoc : undefined,
    derivedFromScopeNumber: derivedPlanReview && derivedPlan ? derivedPlan.parentScopeNumber : null,
  };
}

// Mirrors resolveExecuteReviewDisposition in adjudicator/execute.ts: one resolver derives every
// disposition-dependent value runPlanReviewPhase persists (plus the transition signal it asserts)
// from the same condition set, so the five outcomes can never drift apart.
// The plan-review acceptance transition, reused by clean acceptance and by the
// accept-with-recorded-reservations landing so both emit identical transition
// signals (`accept_plan` for top-level plan review, `accept_derived_plan` for a
// derived-plan review) — no adjudication-spec change is needed.
function planReviewAcceptanceDisposition(
  derivedPlanReview: boolean,
  currentDerivedPlanStatus: OrchestrationState['derivedPlanStatus'],
) {
  if (derivedPlanReview) {
    return {
      planningSignal: 'accept_derived_plan' as const,
      phase: 'awaiting_derived_plan_execution' as const,
      status: 'running' as const,
      derivedPlanStatus: 'accepted' as const,
      blockedFromPhase: null,
    };
  }

  return {
    planningSignal: 'accept_plan' as const,
    phase: 'done' as const,
    status: 'done' as const,
    derivedPlanStatus: currentDerivedPlanStatus,
    blockedFromPhase: null,
  };
}

export function resolvePlanReviewDisposition(args: {
  shouldBlockForConvergence: boolean;
  // True when the MERGED open findings contain at least one round-forcing
  // blocking finding — a plan-correctness / non-convertible / repeat-occurrence
  // open blocker (classifyPlanReviewConvergence's roundForcing partition). This
  // is deliberately derived from the merged set, not just the current reviewer
  // payload: a prior round's still-open blocker (e.g. one the coder left
  // unresolved) must keep forcing a revision even when the current reviewer
  // round is empty, so an empty round can never accept over an open blocker.
  hasRoundForcingBlockingFindings: boolean;
  // True when this round lands accepted-with-recorded-reservations: every open
  // blocking finding is a debt-convertible verification-hardening finding and
  // none is round-forcing. Takes precedence over open-non-blocking findings and
  // clean acceptance, but NOT over the convergence block or round-forcing
  // blocking findings (see the branch order below).
  landAcceptedWithDebt: boolean;
  reachedMaxRounds: boolean;
  hasOpenNonBlockingFindings: boolean;
  derivedPlanReview: boolean;
  currentDerivedPlanStatus: OrchestrationState['derivedPlanStatus'];
}) {
  if (args.shouldBlockForConvergence) {
    return {
      planningSignal: 'block_for_operator' as const,
      phase: 'blocked' as const,
      status: 'blocked' as const,
      derivedPlanStatus: args.currentDerivedPlanStatus,
      blockedFromPhase: 'reviewer_plan' as const,
    };
  }

  // Round-forcing blocking findings keep their precedence over the
  // accept-with-debt landing: any open plan-correctness / non-convertible /
  // repeat blocker still forces a revision round (or blocks at the cap), even
  // when convertible hardening findings are also present. Because roundForcing
  // and landAcceptedWithDebt are mutually exclusive, no guard is needed here.
  if (args.hasRoundForcingBlockingFindings) {
    return {
      planningSignal: args.reachedMaxRounds ? ('block_for_operator' as const) : ('request_revision' as const),
      phase: args.reachedMaxRounds ? ('blocked' as const) : ('coder_plan_response' as const),
      status: args.reachedMaxRounds ? ('blocked' as const) : ('running' as const),
      derivedPlanStatus: args.currentDerivedPlanStatus,
      blockedFromPhase: args.reachedMaxRounds ? ('reviewer_plan' as const) : null,
    };
  }

  if (args.landAcceptedWithDebt) {
    return planReviewAcceptanceDisposition(args.derivedPlanReview, args.currentDerivedPlanStatus);
  }

  if (args.hasOpenNonBlockingFindings) {
    return {
      planningSignal: 'optional_revision' as const,
      phase: 'coder_plan_optional_response' as const,
      status: 'running' as const,
      derivedPlanStatus: args.currentDerivedPlanStatus,
      blockedFromPhase: null,
    };
  }

  return planReviewAcceptanceDisposition(args.derivedPlanReview, args.currentDerivedPlanStatus);
}

// Pure, class- and novelty-aware partition of the current round's open blocking
// findings, shared by the arrival-time conversion and the disposition-time
// landing. The debt-convertibility predicate depends on whether we are at the
// round cap:
//   Pre-cap (atCap === false): verification_hardening (an explicit match — an
//   absent/undefined class never converts) AND first-occurrence of the canonical
//   (its minimum round across all merged findings equals the current round) AND
//   round >= threshold. Everything else is round-forcing: plan_correctness or any
//   non-hardening/absent class, OR any repeat occurrence of an existing canonical
//   (which still forces a revision round), OR below threshold.
//   At the cap (atCap === true): there are no rounds left to force, so the
//   predicate is class-only — every open verification_hardening finding converts
//   to debt regardless of first-occurrence or threshold, and only a
//   plan_correctness / non-hardening / absent-class finding stays round-forcing
//   (which terminal-blocks the run). A re-litigated-but-not-reopened hardening
//   point therefore converts at the cap rather than failing the run.
// The explicit-hardening gate is the system-wide fail-safe: an unclassified
// finding is always round-forcing (blocking). The 3-round reopen and stall
// terminal blocks are handled separately by shouldBlockForConvergence, which
// keeps precedence over this partition, so a re-opened or stalled hardening
// finding — even at the cap — keeps blocking rather than converting.
export function classifyPlanReviewConvergence(args: {
  mergedFindings: ReviewFinding[];
  round: number;
  debtRoundThreshold: number;
  atCap: boolean;
}): {
  debtConvertible: ReviewFinding[];
  roundForcing: ReviewFinding[];
  landAcceptedWithDebt: boolean;
} {
  const minRoundByCanonical = new Map<string, number>();
  for (const finding of args.mergedFindings) {
    const existing = minRoundByCanonical.get(finding.canonicalId);
    if (existing === undefined || finding.round < existing) {
      minRoundByCanonical.set(finding.canonicalId, finding.round);
    }
  }

  const debtConvertible: ReviewFinding[] = [];
  const roundForcing: ReviewFinding[] = [];
  for (const finding of args.mergedFindings.filter(isOpenBlockingFinding)) {
    const isHardening = finding.findingClass === 'verification_hardening';
    const firstOccurrence = minRoundByCanonical.get(finding.canonicalId) === args.round;
    const convertible = args.atCap
      ? isHardening
      : isHardening && firstOccurrence && args.round >= args.debtRoundThreshold;
    if (convertible) {
      debtConvertible.push(finding);
    } else {
      roundForcing.push(finding);
    }
  }

  return {
    debtConvertible,
    roundForcing,
    landAcceptedWithDebt: roundForcing.length === 0 && debtConvertible.length > 0,
  };
}

// A derived-plan review is split-plan recovery; frame its block reasons so an
// operator sees that the recovery (not the top-level plan) failed to converge.
// `derivedPlanReview` is exactly `isDerivedPlanReviewState(state)` (both read
// `getDerivedPlanView(state)?.reviewActive`), so callers pass the boolean they
// already resolved from the planning adjudication context.
export function getDerivedPlanBlockedReason(derivedPlanReview: boolean, reason: string) {
  if (!derivedPlanReview) {
    return reason;
  }

  return `split-plan recovery failed to converge: ${reason}`;
}

export type PlanReviewRoundSynthesis = {
  findings: ReviewFinding[];
  mergedFindings: ReviewFinding[];
  disposition: ReturnType<typeof resolvePlanReviewDisposition>;
  blockReason: string | null;
  openBlockingCanonicalCount: number;
  roundRecord: ReviewRound;
  // The canonical-keyed plan-review debt projected from the (post-conversion)
  // merged findings for this round. Recomputed here so every findings mutation
  // yields a fresh, non-accumulating projection.
  planReviewDebt: ResidualReviewDebtItem[];
};

// Fields the round record carries that are not derivable from findings alone
// (reviewedPlanPath, the normalization triple, the commit range, and the
// reviewer session handle), plus the already-resolved review-stuck window. The
// caller resolves config so the synthesis core stays IO-free.
export type PlanReviewRoundContext = {
  state: OrchestrationState;
  round: number;
  roundLimit: number;
  reviewStuckWindow: number;
  // The reviewer round at/past which a novel verification-hardening finding
  // converts to plan-review debt (getPlanReviewDebtRoundThreshold). Resolved by
  // the caller so the synthesis core stays IO-free.
  debtRoundThreshold: number;
  derivedPlanReview: boolean;
  currentDerivedPlanStatus: OrchestrationState['derivedPlanStatus'];
  reviewerSessionHandle: string | null;
  reviewedPlanPath: string | null;
  normalizationApplied: boolean;
  normalizationOperations: string[];
  normalizationScopeLabelMappings: {
    normalizedScopeNumber: number;
    originalScopeLabel: string;
  }[];
  commitRange: { base: string; head: string };
};

// The single pure gating/disposition policy for a plan-review round, shared by
// the runtime (synthesizePlanReviewRound, which assigns canonicals from the
// reviewer's raw inputs) and the replay harness (which supplies findings with
// trusted, recorded canonical IDs). Given the current round's already-assigned
// findings plus the prior findings on state.findings, it derives the merged set,
// open sets, convergence signals, disposition, blockReason, and round record. It
// performs no file, git, agent, or configuration IO; the shared stall helper is
// invoked through its window-taking pure variant.
export function synthesizePlanReviewRoundFromFindings(
  args: PlanReviewRoundContext & { findings: ReviewFinding[] },
): PlanReviewRoundSynthesis {
  const { findings } = args;
  const rawMergedFindings = [...args.state.findings, ...findings];
  const reachedMaxRounds = args.round >= args.roundLimit;
  const rawOpenBlockingCanonicalSet = getOpenBlockingCanonicalSet(rawMergedFindings);
  // The convergence block (reopen / stall) is derived from the pre-conversion
  // merged set and keeps precedence over the accept-with-debt landing.
  const stalledBlockingCount = hasRepeatedUnresolvedBlockingCanonicalsForWindow({
    rounds: args.state.rounds,
    currentOpenBlockingCanonicals: rawOpenBlockingCanonicalSet,
    reviewStuckWindow: args.reviewStuckWindow,
  });
  const reopenedCanonical = getReopenedCanonical(rawMergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);

  // Class- and novelty-aware partition of the open blocking findings. Pre-cap, a
  // first-occurrence past-threshold hardening finding is debt-convertible; at the
  // cap (reachedMaxRounds) every open hardening finding is convertible regardless
  // of first-occurrence, so a re-litigated-but-not-reopened hardening point
  // converts instead of failing the run. When every open blocking finding is
  // convertible (and none is round-forcing), the round lands accepted-with-debt
  // and those findings convert to deferred plan-review debt so they leave the
  // open set.
  const convergence = classifyPlanReviewConvergence({
    mergedFindings: rawMergedFindings,
    round: args.round,
    debtRoundThreshold: args.debtRoundThreshold,
    atCap: reachedMaxRounds,
  });
  // Drive the blocking gate off the merged open round-forcing set, not the
  // current reviewer payload. An empty reviewer round over a prior still-open
  // blocker must keep forcing a revision (or block at the cap), never accept.
  const hasRoundForcingBlockingFindings = convergence.roundForcing.length > 0;
  const disposition = resolvePlanReviewDisposition({
    shouldBlockForConvergence,
    hasRoundForcingBlockingFindings,
    landAcceptedWithDebt: !shouldBlockForConvergence && convergence.landAcceptedWithDebt,
    reachedMaxRounds,
    hasOpenNonBlockingFindings: rawMergedFindings.some(isOpenNonBlockingFinding),
    derivedPlanReview: args.derivedPlanReview,
    currentDerivedPlanStatus: args.currentDerivedPlanStatus,
  });

  // Arrival-time debt conversion (Scope 4): pre-cap, a first-occurrence
  // past-threshold hardening finding banks as deferred plan-review debt the moment
  // it arrives, even when a co-occurring plan_correctness / repeat finding forces a
  // revision this round — so novelty-bounded hardening asks never extend the round
  // count. At the cap the convertible set is class-based (every open hardening
  // finding), but it only banks when the round actually lands accepted-with-debt: a
  // co-occurring plan_correctness finding terminal-blocks instead of converting.
  // The convergence block (reopen/stall) keeps precedence: when it fires nothing
  // converts, so a re-opened or stalled hardening finding keeps blocking. The
  // open-blocking round record then reflects the post-flip set.
  const shouldConvertDebt =
    !shouldBlockForConvergence &&
    (reachedMaxRounds ? convergence.landAcceptedWithDebt : convergence.debtConvertible.length > 0);
  const convertedIds = new Set(shouldConvertDebt ? convergence.debtConvertible.map((finding) => finding.id) : []);
  const mergedFindings = convertedIds.size
    ? rawMergedFindings.map((finding) =>
        convertedIds.has(finding.id) ? { ...finding, status: 'deferred' as const } : finding,
      )
    : rawMergedFindings;

  const openBlockingCanonicalSet = convertedIds.size
    ? getOpenBlockingCanonicalSet(mergedFindings)
    : rawOpenBlockingCanonicalSet;
  const openBlockingCanonicalIds = [...openBlockingCanonicalSet].sort();
  const openBlockingCanonicalCount = openBlockingCanonicalSet.size;

  const blockReason = reopenedCanonical
    ? getDerivedPlanBlockedReason(
        args.derivedPlanReview,
        `review_stuck: blocking finding ${reopenedCanonical} reopened across multiple reviewer rounds`,
      )
    : stalledBlockingCount
      ? getDerivedPlanBlockedReason(
          args.derivedPlanReview,
          `review_stuck: blocking findings did not decrease across ${args.reviewStuckWindow} consecutive reviewer rounds`,
        )
      : reachedMaxRounds && hasRoundForcingBlockingFindings
        ? getDerivedPlanBlockedReason(
            args.derivedPlanReview,
            `reached max review rounds (${args.roundLimit}) with blocking findings still open`,
          )
        : null;

  return {
    findings,
    mergedFindings,
    disposition,
    blockReason,
    openBlockingCanonicalCount,
    planReviewDebt: toPlanReviewDebt(mergedFindings),
    roundRecord: {
      round: args.round,
      reviewerSessionHandle: args.reviewerSessionHandle,
      reviewedPlanPath: args.reviewedPlanPath,
      normalizationApplied: args.normalizationApplied,
      normalizationOperations: args.normalizationOperations,
      normalizationScopeLabelMappings: args.normalizationScopeLabelMappings,
      commitRange: args.commitRange,
      openBlockingCanonicalCount,
      openBlockingCanonicalIds,
      findings: findings.map((finding) => finding.id),
    },
  };
}

// Runtime plan-review round core, mirroring synthesizeExecuteReviewerState in
// adjudicator/execute.ts: it assigns canonical IDs to the reviewer's raw finding
// inputs (via findCanonicalId), then routes them through the shared
// synthesizePlanReviewRoundFromFindings policy above, so runtime and replay can
// never drift apart. Config is resolved by the caller (reviewStuckWindow) so this
// stays IO-free.
export function synthesizePlanReviewRound(
  args: PlanReviewRoundContext & {
    executionShape: OrchestrationState['executionShape'];
    findingInputs: ReviewFindingInput[];
  },
): PlanReviewRoundSynthesis {
  let nextCanonicalIndex = getNextCanonicalIndex(args.state.findings);
  const findings: ReviewFinding[] = args.findingInputs.map((finding, index) => {
    const canonicalId = findCanonicalId(args.state.findings, finding) ?? `C${nextCanonicalIndex++}`;
    return {
      ...finding,
      id: `R${args.round}-F${index + 1}`,
      canonicalId,
      status: 'open' as const,
      coderDisposition: null,
      coderCommit: null,
    };
  });

  return synthesizePlanReviewRoundFromFindings({
    state: args.state,
    round: args.round,
    roundLimit: args.roundLimit,
    reviewStuckWindow: args.reviewStuckWindow,
    debtRoundThreshold: args.debtRoundThreshold,
    derivedPlanReview: args.derivedPlanReview,
    currentDerivedPlanStatus: args.currentDerivedPlanStatus,
    reviewerSessionHandle: args.reviewerSessionHandle,
    reviewedPlanPath: args.reviewedPlanPath,
    normalizationApplied: args.normalizationApplied,
    normalizationOperations: args.normalizationOperations,
    normalizationScopeLabelMappings: args.normalizationScopeLabelMappings,
    commitRange: args.commitRange,
    findings,
  });
}

export async function runPlanningReviewerAdjudication(args: {
  state: OrchestrationState;
  round: number;
  reviewMarkdownPath: string;
  normalizedPlanPath: string;
  logger?: RunLogger;
  preparePlanReviewArtifact: (args: {
    planPath: string;
    normalizedPlanPath?: string;
  }) => Promise<PreparedPlanReview>;
  synthesizePlanReviewFindings: (args: {
    planPath: string;
    round: number;
    roundSummary: string;
    findings: ReviewFindingInput[];
    preparedReview?: PreparedPlanReview;
  }) => Promise<PlanningReviewSynthesis>;
  runReviewerRound?: PlanReviewerRoundRunner;
}): Promise<{
  context: PlanningAdjudicationContext;
  preparedReview: PreparedPlanReview;
  reviewerResult: Awaited<ReturnType<PlanReviewerRoundRunner>>;
  synthesizedReview: PlanningReviewSynthesis;
}> {
  const context = resolvePlanningAdjudicationContext(args.state);
  const preparedReview = await args.preparePlanReviewArtifact({
    planPath: context.reviewTargetPath,
    normalizedPlanPath: args.normalizedPlanPath,
  });
  const reviewedPlanContent = await readTextForInlineSection(resolve(args.state.cwd, preparedReview.reviewedPlanPath));
  const parentPlanContent =
    context.reviewMode === 'derived-plan' && context.parentPlanDoc
      ? await readTextForInlineSection(resolve(args.state.cwd, context.parentPlanDoc))
      : null;
  const reviewerResult = await (args.runReviewerRound ?? runPlanReviewerRound)({
    reviewer: args.state.agentConfig.reviewer,
    // Resume the reviewer's own session from the previous refinement round
    // (null on round 1: fresh runs and split-plan recovery both clear it).
    // Sessionless providers are filtered at the round layer.
    resumeHandle: args.state.reviewerSessionHandle,
    cwd: args.state.cwd,
    planDoc: preparedReview.reviewedPlanPath,
    round: args.round,
    reviewMarkdownPath: args.reviewMarkdownPath,
    mode: context.reviewMode,
    parentPlanDoc: context.parentPlanDoc,
    derivedFromScopeNumber: context.derivedFromScopeNumber,
    reviewerContext: await buildAndPersistReviewerContextPacket({ state: args.state }),
    reviewedPlanContent,
    parentPlanContent,
    // Reinforce an author-declared `one_shot` only for the top-level authored plan; derived
    // plans declare and own their own shape and are never clamped.
    authoredOneShot: !context.derivedPlanReview && args.state.authoredExecutionShape === 'one_shot',
    logger: args.logger,
  });
  const synthesizedReview = await args.synthesizePlanReviewFindings({
    planPath: context.reviewTargetPath,
    round: args.round,
    roundSummary: reviewerResult.summary,
    findings: reviewerResult.findings.map((finding) => ({
      ...finding,
      source: finding.source,
    })),
    preparedReview,
  });

  return {
    context,
    preparedReview,
    reviewerResult,
    synthesizedReview,
  };
}

export async function runPlanningResponseAdjudication(args: {
  state: OrchestrationState;
  mode?: 'blocking' | 'optional';
  openFindings: Pick<ReviewFinding, 'id' | 'source' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  logger?: RunLogger;
  runResponseRound?: CoderPlanResponseRoundRunner;
}): Promise<{
  context: PlanningAdjudicationContext;
  response: Awaited<ReturnType<CoderPlanResponseRoundRunner>>;
}> {
  const context = resolvePlanningAdjudicationContext(args.state);
  // Top-level `neal plan` refinement (reviewMode === 'plan') is normally authored by a persisted
  // planner session, so a missing handle is a genuine invariant violation for resume-capable
  // planner providers and must keep throwing. Two paths legitimately run without one:
  // derived-plan revisions (reviewMode === 'derived-plan') are authored by the coder during
  // coder_scope and never create a planner session, and no-resume planner providers
  // (`supportsSessionResume: false`) never persist a handle at all. Both start a fresh planner
  // session (resumeHandle: null).
  if (
    context.reviewMode === 'plan' &&
    !args.state.plannerSessionHandle &&
    !plannerProviderStartsFreshSessions(args.state.agentConfig.planner)
  ) {
    throw new Error('Cannot run planning response adjudication without an existing planner session.');
  }

  const planReviewGuidance =
    args.state.topLevelMode === 'plan' && context.reviewMode === 'plan'
      ? (args.state.pendingPlanReviewGuidance ?? undefined)
      : undefined;
  const response = await (args.runResponseRound ?? runCoderPlanResponseRound)({
    coder: args.state.agentConfig.planner,
    cwd: args.state.cwd,
    planDoc: context.reviewTargetPath,
    openFindings: args.openFindings,
    mode: args.mode,
    sessionHandle: args.state.plannerSessionHandle ?? null,
    reviewMode: context.reviewMode,
    parentPlanDoc: context.parentPlanDoc,
    derivedFromScopeNumber: context.derivedFromScopeNumber,
    planReviewGuidance,
    logger: args.logger,
  });

  return {
    context,
    response,
  };
}
