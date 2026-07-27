import { mkdir } from 'node:fs/promises';

import { runCoderResponseRound, runReviewerRound } from '../agents.js';
import { readOnlyReviewerNeedsInlinedDiff } from '../context/inline-review-context.js';
import { buildAndPersistReviewerContextPacket } from '../context/reviewer-context.js';
import { getReviewStuckWindow } from '../config.js';
import { EXECUTE_FINALIZATION_PHASE, type ExecuteFinalizationPhase } from '../execute-finalization.js';
import type { RunLogger } from '../logger.js';
import {
  classifyAlreadySatisfiedTopLevelScopeAcceptance,
  classifyEmptyDerivedParentAdvance,
  getExecutionPlanPath,
  getParentScopeLabel,
  renderRecentAcceptedScopesSummary,
  type AlreadySatisfiedTopLevelScopeAcceptanceClassification,
  type EmptyDerivedParentAdvanceClassification,
} from '../scopes.js';
import { getScopeReviewerScratchDir } from '../storage-paths.js';
import type {
  FindingStatus,
  OrchestrationState,
  ReviewFinding,
  ReviewerMeaningfulProgressAction,
  ReviewerMeaningfulProgressVerdict,
} from '../types.js';
import { getAdjudicationSpec, getReviewerCapability, type AdjudicationSpec, type PromptSurfaceReference } from './specs.js';

export type ExecuteAdjudicationSpec = AdjudicationSpec & { family: 'execute_review' };

type ExecuteReviewerRoundRunner = typeof runReviewerRound;
type ExecuteResponseRoundRunner = typeof runCoderResponseRound;

export type ExecuteAdjudicationContext = {
  spec: ExecuteAdjudicationSpec;
  planDoc: string;
  round: number;
  parentScopeLabel: string;
  recentHistorySummary: string;
  meaningfulProgressCapability: PromptSurfaceReference;
};

export function resolveExecuteAdjudicationContext(state: OrchestrationState): ExecuteAdjudicationContext {
  const spec = getAdjudicationSpec('execute_review') as ExecuteAdjudicationSpec;
  if (spec.family !== 'execute_review') {
    throw new Error(`Expected execute adjudication spec, received ${spec.id}.`);
  }

  return {
    spec,
    planDoc: getExecutionPlanPath(state),
    round: state.rounds.length + 1,
    parentScopeLabel: getParentScopeLabel(state),
    recentHistorySummary: renderRecentAcceptedScopesSummary(state, getParentScopeLabel(state)),
    meaningfulProgressCapability: getReviewerCapability(spec, 'meaningful_progress'),
  };
}

export function resolveExecuteReviewDisposition(args: {
  hasBlockingFindings: boolean;
  hasOpenNonBlockingFindings: boolean;
  reachedMaxRounds: boolean;
  shouldBlockForConvergence: boolean;
  meaningfulProgressAction: ReviewerMeaningfulProgressAction;
}) {
  if (args.shouldBlockForConvergence) {
    return {
      phase: 'blocked' as const,
      status: 'blocked' as const,
      blockedFromPhase: 'reviewer_scope' as const,
    };
  }

  if (args.hasBlockingFindings) {
    return {
      phase: args.reachedMaxRounds ? ('blocked' as const) : ('coder_response' as const),
      status: args.reachedMaxRounds ? ('blocked' as const) : ('running' as const),
      blockedFromPhase: args.reachedMaxRounds ? ('reviewer_scope' as const) : null,
    };
  }

  const canFinalizeForMeaningfulProgress =
    args.meaningfulProgressAction === 'accept' ||
    args.meaningfulProgressAction === 'advance_parent';

  if (!canFinalizeForMeaningfulProgress) {
    return {
      phase: 'blocked' as const,
      status: 'blocked' as const,
      blockedFromPhase: 'reviewer_scope' as const,
    };
  }

  if (args.hasOpenNonBlockingFindings) {
    if (args.meaningfulProgressAction === 'advance_parent') {
      return {
        phase: 'blocked' as const,
        status: 'blocked' as const,
        blockedFromPhase: 'reviewer_scope' as const,
      };
    }

    return {
      phase: 'coder_optional_response' as const,
      status: 'running' as const,
      blockedFromPhase: null,
    };
  }

  return {
    phase: EXECUTE_FINALIZATION_PHASE,
    status: 'running' as const,
    blockedFromPhase: null,
  };
}

export function getExecuteReviewBlockReason(args: {
  cwd: string;
  reopenedCanonical: string | null;
  stalledBlockingCount: boolean;
  reachedMaxRounds: boolean;
  maxRounds: number;
  meaningfulProgressAction: ReviewerMeaningfulProgressAction;
  meaningfulProgressRationale: string;
  parentScopeLabel: string;
}) {
  if (args.reopenedCanonical) {
    return `review_stuck: blocking finding ${args.reopenedCanonical} reopened across multiple reviewer rounds`;
  }

  if (args.stalledBlockingCount) {
    return `review_stuck: blocking findings did not decrease across ${getReviewStuckWindow(args.cwd)} consecutive reviewer rounds`;
  }

  if (args.reachedMaxRounds) {
    return `reached max review rounds (${args.maxRounds}) with blocking findings still open`;
  }

  if (args.meaningfulProgressAction === 'block_for_operator') {
    return (
      `meaningful_progress: reviewer requested operator guidance before accepting parent objective ` +
      `${args.parentScopeLabel}. ${args.meaningfulProgressRationale}`
    );
  }

  if (args.meaningfulProgressAction === 'replace_plan') {
    return (
      `meaningful_progress: reviewer requested replacing the current scope for parent objective ` +
      `${args.parentScopeLabel} rather than retrying it. ${args.meaningfulProgressRationale} ` +
      `One available next step: inspect with neal status and resume with neal resume when ready.`
    );
  }

  if (args.meaningfulProgressAction === 'advance_parent') {
    return (
      `meaningful_progress: reviewer requested parent advancement for parent objective ` +
      `${args.parentScopeLabel}, but Neal could not finalize it safely. ${args.meaningfulProgressRationale}`
    );
  }

  return null;
}

export function isOpenBlockingFinding(finding: ReviewFinding) {
  return finding.status === 'open' && finding.severity === 'blocking';
}

export function isOpenNonBlockingFinding(finding: ReviewFinding) {
  return finding.status === 'open' && finding.severity === 'non_blocking';
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCanonicalSignature(finding: Pick<ReviewFinding, 'claim' | 'files'>) {
  const files = [...finding.files].map((file) => file.trim().toLowerCase()).sort().join('|');
  return `${normalizeText(finding.claim)}::${files}`;
}

export function findCanonicalId(existingFindings: ReviewFinding[], finding: Pick<ReviewFinding, 'claim' | 'files'>) {
  const signature = getCanonicalSignature(finding);
  return existingFindings.find((item) => getCanonicalSignature(item) === signature)?.canonicalId ?? null;
}

export function getNextCanonicalIndex(findings: ReviewFinding[]) {
  const maxSeen = findings.reduce((max, finding) => {
    const match = /^C(\d+)$/.exec(finding.canonicalId);
    if (!match) {
      return max;
    }

    return Math.max(max, Number(match[1]));
  }, 0);

  return maxSeen + 1;
}

export function getOpenBlockingCanonicalSet(findings: ReviewFinding[]): Set<string> {
  return new Set(findings.filter(isOpenBlockingFinding).map((finding) => finding.canonicalId));
}

function canonicalSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) {
    return false;
  }

  for (const canonicalId of left) {
    if (!right.has(canonicalId)) {
      return false;
    }
  }

  return true;
}

// Pure convergence helper: it takes the already-resolved review-stuck window so
// a side-effect-free caller (the plan-review round core) can resolve config once
// outside and pass the value in. The cwd-taking wrapper below preserves the
// existing public behavior — execute-review keeps calling it — and now resolves
// the window a single time before delegating, so no path reads config twice.
export function hasRepeatedUnresolvedBlockingCanonicalsForWindow(args: {
  rounds: OrchestrationState['rounds'];
  currentOpenBlockingCanonicals: Set<string>;
  reviewStuckWindow: number;
}): boolean {
  if (args.currentOpenBlockingCanonicals.size === 0) {
    return false;
  }

  const { reviewStuckWindow } = args;
  const snapshots: (Set<string> | null)[] = [
    ...args.rounds.map((round) =>
      round.openBlockingCanonicalIds ? new Set(round.openBlockingCanonicalIds) : null,
    ),
    args.currentOpenBlockingCanonicals,
  ];
  if (snapshots.length < reviewStuckWindow) {
    return false;
  }

  const recentSnapshots = snapshots.slice(-reviewStuckWindow);
  if (recentSnapshots.some((snapshot) => snapshot === null)) {
    // Older round records predate canonical-set snapshots; fall back to count-based stuckness.
    return hasRepeatedNonReductionForWindow(args.rounds, args.currentOpenBlockingCanonicals.size, reviewStuckWindow);
  }

  for (let index = 1; index < recentSnapshots.length; index += 1) {
    if (!canonicalSetsEqual(recentSnapshots[index]!, recentSnapshots[index - 1]!)) {
      return false;
    }
  }

  return true;
}

export function hasRepeatedUnresolvedBlockingCanonicals(args: {
  rounds: OrchestrationState['rounds'];
  currentOpenBlockingCanonicals: Set<string>;
  cwd: string;
}): boolean {
  return hasRepeatedUnresolvedBlockingCanonicalsForWindow({
    rounds: args.rounds,
    currentOpenBlockingCanonicals: args.currentOpenBlockingCanonicals,
    reviewStuckWindow: getReviewStuckWindow(args.cwd),
  });
}

export function hasRepeatedNonReductionForWindow(
  rounds: OrchestrationState['rounds'],
  currentCount: number,
  reviewStuckWindow: number,
) {
  const counts = [...rounds.map((round) => round.openBlockingCanonicalCount), currentCount];
  if (counts.length < reviewStuckWindow || currentCount <= 0) {
    return false;
  }

  const recentCounts = counts.slice(-reviewStuckWindow);
  for (let index = 1; index < recentCounts.length; index += 1) {
    if (recentCounts[index] < recentCounts[index - 1]) {
      return false;
    }
  }

  return true;
}

export function hasRepeatedNonReduction(rounds: OrchestrationState['rounds'], currentCount: number, cwd: string) {
  return hasRepeatedNonReductionForWindow(rounds, currentCount, getReviewStuckWindow(cwd));
}

export function getReopenedCanonical(findings: ReviewFinding[]) {
  const roundsByCanonical = new Map<string, Set<number>>();

  for (const finding of findings) {
    if (finding.severity !== 'blocking') {
      continue;
    }

    const rounds = roundsByCanonical.get(finding.canonicalId) ?? new Set<number>();
    rounds.add(finding.round);
    roundsByCanonical.set(finding.canonicalId, rounds);
  }

  for (const [canonicalId, rounds] of roundsByCanonical.entries()) {
    if (rounds.size >= 3) {
      return canonicalId;
    }
  }

  return null;
}

export function mapDecisionToStatus(decision: 'fixed' | 'rejected' | 'deferred'): FindingStatus {
  switch (decision) {
    case 'fixed':
      return 'fixed';
    case 'rejected':
      return 'rejected';
    case 'deferred':
      return 'deferred';
  }
}

export function buildVerificationHint(state: OrchestrationState) {
  const latestRound = state.rounds.at(-1);
  if (!latestRound) {
    return [
      'Verification state hint from neal:',
      '- No prior reviewer round exists for this scope yet.',
      '- Choose verification based on the plan and the concrete changes you make.',
      '- Prefer focused reruns during active fixes. Reserve full-suite reruns for the final gate or for changes that materially invalidate earlier verification.',
    ].join('\n');
  }

  return [
    'Verification state hint from neal:',
    `- This scope already reached reviewer feedback for commit range ${latestRound.commitRange.base}..${latestRound.commitRange.head}.`,
    '- Treat that reviewed head as the current verified baseline unless you find concrete contrary evidence in the repository or review history.',
    '- Prefer focused reruns while addressing review findings.',
    '- Rerun full test suites only if your new changes materially invalidate that reviewed baseline or the plan explicitly requires new end-of-scope full-suite verification.',
  ].join('\n');
}

export function getExecuteResponseOpenFindings(
  state: OrchestrationState,
  mode: 'blocking' | 'optional' = 'blocking',
) {
  const selector = mode === 'optional' ? isOpenNonBlockingFinding : isOpenBlockingFinding;
  return state.findings.filter(selector).map((finding) => ({
    id: finding.id,
    source: finding.source,
    claim: finding.claim,
    requiredAction: finding.requiredAction,
    severity: finding.severity,
    files: finding.files,
    roundSummary: finding.roundSummary,
  }));
}

function validateExecuteResponseCoverage(args: {
  state: OrchestrationState;
  mode: 'blocking' | 'optional';
  response: Awaited<ReturnType<ExecuteResponseRoundRunner>>;
}) {
  const openFindings = getExecuteResponseOpenFindings(args.state, args.mode);
  const expectedIds = new Set(openFindings.map((finding) => finding.id));
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const unknownIds = new Set<string>();
  const missingIds = new Set(expectedIds);

  for (const response of args.response.payload.responses) {
    if (seenIds.has(response.id)) {
      duplicateIds.add(response.id);
    }
    seenIds.add(response.id);

    if (!expectedIds.has(response.id)) {
      unknownIds.add(response.id);
      continue;
    }

    missingIds.delete(response.id);

    if (response.summary.trim().length === 0) {
      throw new Error(`Coder ${args.mode} response returned an empty disposition summary for ${response.id}.`);
    }
  }

  if (duplicateIds.size > 0) {
    throw new Error(`Coder ${args.mode} response returned duplicate finding dispositions: ${[...duplicateIds].join(', ')}`);
  }

  if (unknownIds.size > 0) {
    throw new Error(`Coder ${args.mode} response returned dispositions for non-open findings: ${[...unknownIds].join(', ')}`);
  }

  if (args.response.payload.outcome !== 'responded') {
    return;
  }

  if (missingIds.size > 0) {
    throw new Error(`Coder ${args.mode} response did not disposition every open finding: ${[...missingIds].join(', ')}`);
  }
}

export async function runExecuteReviewerAdjudication(args: {
  state: OrchestrationState;
  logger?: RunLogger;
  getHeadCommit: (cwd: string) => Promise<string>;
  getCommitRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string[]>;
  getDiffStatForRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string>;
  getChangedFilesForRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string[]>;
  getDiffForRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string>;
  runReviewerRound?: ExecuteReviewerRoundRunner;
}) {
  if (!args.state.baseCommit) {
    throw new Error('Cannot run execute reviewer adjudication without baseCommit.');
  }
  if (!args.state.currentScopeProgressJustification) {
    throw new Error('Cannot run execute reviewer adjudication without a coder progress justification.');
  }

  const context = resolveExecuteAdjudicationContext(args.state);
  const previousHeadCommit = args.state.rounds.at(-1)?.commitRange.head ?? null;
  const headCommit = await args.getHeadCommit(args.state.cwd);
  const commits = await args.getCommitRange(args.state.cwd, args.state.baseCommit, headCommit);
  const diffStat = await args.getDiffStatForRange(args.state.cwd, args.state.baseCommit, headCommit);
  const changedFiles = await args.getChangedFilesForRange(args.state.cwd, args.state.baseCommit, headCommit);
  const scratchDir = getScopeReviewerScratchDir(args.state.runDir, context.parentScopeLabel, context.round);
  await mkdir(scratchDir, { recursive: true });
  // Read-only reviewers with read tools but no commit-range diff tool (native
  // Claude/Codex) get the commit-range diff inlined directly so they can see
  // exactly what changed without shell access; read-only reviewers that expose
  // their own commit-range diff tool (openai-compatible) inspect the range with
  // that tool instead.
  const inlinedRangeDiff = readOnlyReviewerNeedsInlinedDiff(args.state.agentConfig.reviewer)
    ? await args.getDiffForRange(args.state.cwd, args.state.baseCommit, headCommit)
    : null;
  const reviewerResult = await (args.runReviewerRound ?? runReviewerRound)({
    reviewer: args.state.agentConfig.reviewer,
    // Resume the reviewer's own session from the previous round of this
    // scope's review engagement (null on round 1: scope-boundary resets clear
    // it). Sessionless providers are filtered at the round layer.
    resumeHandle: args.state.reviewerSessionHandle,
    cwd: args.state.cwd,
    planDoc: context.planDoc,
    baseCommit: args.state.baseCommit,
    headCommit,
    commits,
    previousHeadCommit,
    diffStat,
    changedFiles,
    round: context.round,
    reviewMarkdownPath: args.state.reviewMarkdownPath,
    parentScopeLabel: context.parentScopeLabel,
    progressJustification: args.state.currentScopeProgressJustification,
    recentHistorySummary: context.recentHistorySummary,
    scratchDir,
    reviewerContext: await buildAndPersistReviewerContextPacket({ state: args.state }),
    inlinedRangeDiff,
    unattended: args.state.unattended,
    logger: args.logger,
  });

  return {
    context,
    reviewInput: {
      headCommit,
      changedFiles,
    },
    reviewerResult,
  };
}

function classifyReviewerParentAdvance(args: {
  state: OrchestrationState;
  changedFiles: readonly string[];
  findings: readonly ReviewFinding[];
  mergedFindings: readonly ReviewFinding[];
  meaningfulProgressAction: ReviewerMeaningfulProgressAction;
  meaningfulProgressRationale: string;
}): EmptyDerivedParentAdvanceClassification | null {
  if (args.meaningfulProgressAction !== 'advance_parent' && args.meaningfulProgressAction !== 'block_for_operator') {
    return null;
  }

  return classifyEmptyDerivedParentAdvance({
    state: args.state,
    currentChangedFiles: args.changedFiles,
    currentReviewerFindings: args.findings,
    mergedFindings: args.mergedFindings,
    reviewerAction: args.meaningfulProgressAction,
    reviewerRationale: args.meaningfulProgressRationale,
    source: args.meaningfulProgressAction === 'advance_parent' ? 'explicit' : 'fallback',
  });
}

function classifyReviewerTopLevelAlreadySatisfiedAcceptance(args: {
  state: OrchestrationState;
  changedFiles: readonly string[] | null;
  findings: readonly ReviewFinding[];
  mergedFindings: readonly ReviewFinding[];
  meaningfulProgressAction: ReviewerMeaningfulProgressAction;
  meaningfulProgressRationale: string;
}): AlreadySatisfiedTopLevelScopeAcceptanceClassification | null {
  if (args.meaningfulProgressAction !== 'advance_parent') {
    return null;
  }

  return classifyAlreadySatisfiedTopLevelScopeAcceptance({
    state: args.state,
    currentChangedFiles: args.changedFiles,
    currentReviewerFindings: args.findings,
    mergedFindings: args.mergedFindings,
    reviewerAction: args.meaningfulProgressAction,
    reviewerRationale: args.meaningfulProgressRationale,
  });
}

function formatParentAdvanceChangedFiles(changedFiles: readonly string[]) {
  return changedFiles.length > 0 ? changedFiles.join(', ') : '(no aggregate changed files)';
}

function formatFailedPreconditions(failedPreconditions: readonly string[] | null | undefined, fallback: string) {
  return failedPreconditions && failedPreconditions.length > 0 ? failedPreconditions.join('; ') : fallback;
}

function formatPriorAcceptedScopeLabels(scopeLabels: readonly string[]) {
  return scopeLabels.length > 0 ? scopeLabels.join(', ') : '(none)';
}

function resolveEffectiveMeaningfulProgressVerdict(args: {
  originalAction: ReviewerMeaningfulProgressAction;
  originalRationale: string;
  parentAdvanceClassification: EmptyDerivedParentAdvanceClassification | null;
  alreadySatisfiedTopLevelClassification: AlreadySatisfiedTopLevelScopeAcceptanceClassification | null;
}): ReviewerMeaningfulProgressVerdict {
  if (args.originalAction === 'advance_parent') {
    if (args.parentAdvanceClassification?.eligible) {
      return {
        action: 'advance_parent',
        rationale: args.originalRationale,
      };
    }

    if (args.alreadySatisfiedTopLevelClassification?.eligible) {
      return {
        action: 'accept',
        rationale:
          `Accepted top-level already-satisfied scope ${args.alreadySatisfiedTopLevelClassification.scopeLabel} ` +
          `because prior accepted scope(s) ` +
          `${formatPriorAcceptedScopeLabels(args.alreadySatisfiedTopLevelClassification.priorAcceptedScopeLabels)} ` +
          `already satisfy it. Original reviewer rationale: ${args.originalRationale}`,
      };
    }

    return {
      action: 'block_for_operator',
      rationale:
        `Unsafe advance_parent for parent objective ${args.parentAdvanceClassification?.parentScopeLabel ?? 'unknown'} ` +
        `cannot proceed; failed preconditions: ` +
        `${formatFailedPreconditions(
          args.parentAdvanceClassification?.failedPreconditions,
          'parent-advance classification was unavailable',
        )}. ` +
        (
          args.alreadySatisfiedTopLevelClassification
            ? `Top-level already-satisfied fallback failed preconditions: ${formatFailedPreconditions(
                args.alreadySatisfiedTopLevelClassification.failedPreconditions,
                'none',
              )}. `
            : ''
        ) +
        `Reviewer rationale: ${args.originalRationale}`,
    };
  }

  if (args.originalAction === 'block_for_operator' && args.parentAdvanceClassification?.eligible) {
    return {
      action: 'advance_parent',
      rationale:
        `Deterministic redundant-empty-derived-scope fallback advanced parent objective ` +
        `${args.parentAdvanceClassification.parentScopeLabel} instead of blocking: reviewer returned block_for_operator with no ` +
        `current findings, the active derived scope ${args.parentAdvanceClassification.currentScopeLabel} has an empty diff, ` +
        `${args.parentAdvanceClassification.priorSubstantiveCount} prior substantive accepted derived sub-scope(s) and ` +
        `${args.parentAdvanceClassification.priorEmptyCount} prior empty accepted derived sub-scope(s) already exist, and ` +
        `aggregate changed files are ${formatParentAdvanceChangedFiles(args.parentAdvanceClassification.aggregateChangedFiles)}. ` +
        `Reviewer rationale: ${args.originalRationale}`,
    };
  }

  return {
    action: args.originalAction,
    rationale: args.originalRationale,
  };
}

function shouldCreateNoProgressFinding(args: {
  originalAction: ReviewerMeaningfulProgressAction;
  effectiveAction: ReviewerMeaningfulProgressAction;
  changedFiles: readonly string[];
  findings: readonly ReviewFinding[];
}) {
  return (
    args.originalAction === 'block_for_operator' &&
    args.effectiveAction === 'block_for_operator' &&
    args.changedFiles.length === 0 &&
    args.findings.length === 0
  );
}

export function synthesizeExecuteReviewerState(args: {
  state: OrchestrationState;
  context: ExecuteAdjudicationContext;
  headCommit: string;
  changedFiles?: readonly string[];
  reviewerResult: Awaited<ReturnType<ExecuteReviewerRoundRunner>>;
}) {
  let nextCanonicalIndex = getNextCanonicalIndex(args.state.findings);
  let findings = args.reviewerResult.findings.map((finding, index) => {
    const canonicalId = findCanonicalId(args.state.findings, finding) ?? `C${nextCanonicalIndex++}`;
    return {
      ...finding,
      id: `R${args.context.round}-F${index + 1}`,
      canonicalId,
      status: 'open' as const,
      coderDisposition: null,
      coderCommit: null,
    };
  });
  let mergedFindings = [...args.state.findings, ...findings];
  const reachedMaxRounds = args.context.round >= args.state.maxRounds;
  const changedFiles = args.changedFiles ?? [];
  const parentAdvanceClassification = classifyReviewerParentAdvance({
    state: args.state,
    changedFiles,
    findings,
    mergedFindings,
    meaningfulProgressAction: args.reviewerResult.meaningfulProgress.action,
    meaningfulProgressRationale: args.reviewerResult.meaningfulProgress.rationale,
  });
  const alreadySatisfiedTopLevelClassification = classifyReviewerTopLevelAlreadySatisfiedAcceptance({
    state: args.state,
    changedFiles: args.changedFiles ?? null,
    findings,
    mergedFindings,
    meaningfulProgressAction: args.reviewerResult.meaningfulProgress.action,
    meaningfulProgressRationale: args.reviewerResult.meaningfulProgress.rationale,
  });
  const meaningfulProgressVerdict = resolveEffectiveMeaningfulProgressVerdict({
    originalAction: args.reviewerResult.meaningfulProgress.action,
    originalRationale: args.reviewerResult.meaningfulProgress.rationale,
    parentAdvanceClassification,
    alreadySatisfiedTopLevelClassification,
  });
  if (
    shouldCreateNoProgressFinding({
      originalAction: args.reviewerResult.meaningfulProgress.action,
      effectiveAction: meaningfulProgressVerdict.action,
      changedFiles,
      findings,
    })
  ) {
    findings = [
      ...findings,
      {
        id: `R${args.context.round}-F${findings.length + 1}`,
        canonicalId: findCanonicalId(args.state.findings, {
          claim: 'The scope completed without any file modifications.',
          files: [],
        }) ?? `C${nextCanonicalIndex++}`,
        round: args.context.round,
        source: 'reviewer',
        severity: 'blocking',
        files: [],
        claim: 'The scope completed without any file modifications.',
        evidence:
          `The reviewed commit range ${args.state.baseCommit ?? '(unknown base)'}..${args.headCommit} has no changed files, ` +
          'and the reviewer did not identify a safe already-satisfied or parent-advance path.',
        requiredAction:
          'Either implement a concrete repository change for this scope, or provide reviewer-checkable evidence that the scope is already satisfied so it can be accepted without operator guidance.',
        roundSummary: args.reviewerResult.summary,
        status: 'open',
        coderDisposition: null,
        coderCommit: null,
      },
    ];
    mergedFindings = [...args.state.findings, ...findings];
  }
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
  const hasOpenNonBlockingFindings = mergedFindings.some(isOpenNonBlockingFinding);
  const openBlockingCanonicalSet = getOpenBlockingCanonicalSet(mergedFindings);
  const openBlockingCanonicalIds = [...openBlockingCanonicalSet].sort();
  const openBlockingCanonicalCount = openBlockingCanonicalSet.size;
  // Two stall shapes route to the consultant: the identical canonical set
  // persisting across the window (a hard deadlock on the same findings), and
  // the open-blocking COUNT failing to decrease across the window while the
  // canonicals rotate — the one-novel-finding-per-round trickle, where each
  // round retires a canonical and mints a new one so the set-based detector
  // never fires (observed live: 6 flat rounds of 1 novel finding each, 11
  // rounds total on one scope, zero re-opens).
  const stalledBlockingCount =
    hasRepeatedUnresolvedBlockingCanonicals({
      rounds: args.state.rounds,
      currentOpenBlockingCanonicals: openBlockingCanonicalSet,
      cwd: args.state.cwd,
    }) || hasRepeatedNonReduction(args.state.rounds, openBlockingCanonicalCount, args.state.cwd);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const disposition = resolveExecuteReviewDisposition({
    hasBlockingFindings,
    hasOpenNonBlockingFindings,
    reachedMaxRounds,
    shouldBlockForConvergence,
    meaningfulProgressAction: meaningfulProgressVerdict.action,
  });
  const blockReason =
    disposition.status === 'blocked'
      ? getExecuteReviewBlockReason({
          cwd: args.state.cwd,
          reopenedCanonical,
          stalledBlockingCount,
          reachedMaxRounds: reachedMaxRounds && hasBlockingFindings,
          maxRounds: args.state.maxRounds,
          meaningfulProgressAction: meaningfulProgressVerdict.action,
          meaningfulProgressRationale: meaningfulProgressVerdict.rationale,
          parentScopeLabel: args.context.parentScopeLabel,
        })
      : null;

  return {
    findings,
    mergedFindings,
    disposition,
    blockReason,
    meaningfulProgressVerdict,
    parentAdvanceClassification,
    alreadySatisfiedTopLevelClassification,
    openBlockingCanonicalCount,
    roundRecord: {
      round: args.context.round,
      reviewerSessionHandle: args.reviewerResult.sessionHandle,
      reviewedPlanPath: args.context.planDoc,
      normalizationApplied: false,
      normalizationOperations: [],
      normalizationScopeLabelMappings: [],
      commitRange: {
        base: args.state.baseCommit!,
        head: args.headCommit,
      },
      openBlockingCanonicalCount,
      openBlockingCanonicalIds,
      findings: findings.map((finding) => finding.id),
    },
  };
}

export async function runExecuteResponseAdjudication(args: {
  state: OrchestrationState;
  mode?: 'blocking' | 'optional';
  logger?: RunLogger;
  runResponseRound?: ExecuteResponseRoundRunner;
}) {
  const mode = args.mode ?? 'blocking';
  const context = resolveExecuteAdjudicationContext(args.state);
  const openFindings = getExecuteResponseOpenFindings(args.state, mode);
  const response = await (args.runResponseRound ?? runCoderResponseRound)({
    coder: args.state.agentConfig.coder,
    cwd: args.state.cwd,
    planDoc: context.planDoc,
    progressMarkdownPath: args.state.progressMarkdownPath,
    verificationHint: buildVerificationHint(args.state),
    openFindings,
    mode: mode === 'optional' ? 'optional' : undefined,
    sessionHandle: args.state.coderSessionHandle,
    logger: args.logger,
  });

  return {
    context,
    openFindings,
    response,
  };
}

export function synthesizeExecuteResponseState(args: {
  state: OrchestrationState;
  mode?: 'blocking' | 'optional';
  response: Awaited<ReturnType<ExecuteResponseRoundRunner>>;
  createdCommits: string[];
}) {
  const mode = args.mode ?? 'blocking';
  validateExecuteResponseCoverage({
    state: args.state,
    mode,
    response: args.response,
  });
  const latestCommit = args.createdCommits.at(-1) ?? null;
  const responseById = new Map(args.response.payload.responses.map((response) => [response.id, response]));

  const findings = args.state.findings.map((finding) => {
    const response = responseById.get(finding.id);
    if (!response) {
      return finding;
    }

    return {
      ...finding,
      status: mapDecisionToStatus(response.decision),
      coderDisposition: response.summary.trim(),
      coderCommit: response.decision === 'fixed' ? latestCommit : null,
    };
  });

  const outcome = args.response.payload.outcome;
  const nextPhase: 'blocked' | 'reviewer_scope' | ExecuteFinalizationPhase =
    outcome === 'blocked' || outcome === 'split_plan'
      ? 'blocked'
      : mode === 'optional'
        ? EXECUTE_FINALIZATION_PHASE
        : 'reviewer_scope';

  return {
    findings,
    nextPhase,
    nextStatus: outcome === 'blocked' || outcome === 'split_plan' ? ('blocked' as const) : ('running' as const),
    blockedFromPhase:
      outcome === 'blocked'
        ? mode === 'optional'
          ? ('coder_optional_response' as const)
          : ('coder_response' as const)
        : null,
  };
}
