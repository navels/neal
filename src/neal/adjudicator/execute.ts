import { runCoderResponseRound, runReviewerRound } from '../agents.js';
import { getReviewStuckWindow } from '../config.js';
import type { RunLogger } from '../logger.js';
import { getExecutionPlanPath, getParentScopeLabel, renderRecentAcceptedScopesSummary } from '../scopes.js';
import type {
  FindingStatus,
  OrchestrationState,
  ReviewFinding,
  ReviewerMeaningfulProgressAction,
} from '../types.js';
import { getAdjudicationSpec, getReviewerCapability, type AdjudicationSpec, type PromptSurfaceReference } from './specs.js';

export type ExecuteAdjudicationSpec = AdjudicationSpec & { family: 'execute_review' };
export type ExecuteReviewFindingInput = Omit<
  ReviewFinding,
  'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'
>;

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

  if (args.meaningfulProgressAction !== 'accept') {
    return {
      phase: 'blocked' as const,
      status: 'blocked' as const,
      blockedFromPhase: 'reviewer_scope' as const,
    };
  }

  if (args.hasOpenNonBlockingFindings) {
    return {
      phase: 'coder_optional_response' as const,
      status: 'running' as const,
      blockedFromPhase: null,
    };
  }

  return {
    phase: 'final_squash' as const,
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
      `One available next step: neal --diagnose`
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

export function countOpenBlockingCanonicals(findings: ReviewFinding[]) {
  return new Set(findings.filter(isOpenBlockingFinding).map((finding) => finding.canonicalId)).size;
}

export function hasRepeatedNonReduction(rounds: OrchestrationState['rounds'], currentCount: number, cwd: string) {
  const counts = [...rounds.map((round) => round.openBlockingCanonicalCount), currentCount];
  const reviewStuckWindow = getReviewStuckWindow(cwd);
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
    '- Rerun full OSL and Portal suites only if your new changes materially invalidate that reviewed baseline or the plan explicitly requires new end-of-scope full-suite verification.',
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

export async function runExecuteReviewerAdjudication(args: {
  state: OrchestrationState;
  logger?: RunLogger;
  getHeadCommit: (cwd: string) => Promise<string>;
  getCommitRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string[]>;
  getDiffStatForRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string>;
  getDiffForRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string>;
  getChangedFilesForRange: (cwd: string, baseCommit: string, headCommit: string) => Promise<string[]>;
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
  const diff = await args.getDiffForRange(args.state.cwd, args.state.baseCommit, headCommit);
  const changedFiles = await args.getChangedFilesForRange(args.state.cwd, args.state.baseCommit, headCommit);
  const reviewerResult = await (args.runReviewerRound ?? runReviewerRound)({
    reviewer: args.state.agentConfig.reviewer,
    cwd: args.state.cwd,
    planDoc: context.planDoc,
    baseCommit: args.state.baseCommit,
    headCommit,
    commits,
    previousHeadCommit,
    diffStat,
    diff,
    changedFiles,
    round: context.round,
    reviewMarkdownPath: args.state.reviewMarkdownPath,
    parentScopeLabel: context.parentScopeLabel,
    progressJustification: args.state.currentScopeProgressJustification,
    recentHistorySummary: context.recentHistorySummary,
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

export function synthesizeExecuteReviewerState(args: {
  state: OrchestrationState;
  context: ExecuteAdjudicationContext;
  headCommit: string;
  reviewerResult: Awaited<ReturnType<ExecuteReviewerRoundRunner>>;
}) {
  let nextCanonicalIndex = getNextCanonicalIndex(args.state.findings);
  const findings = args.reviewerResult.findings.map((finding, index) => {
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
  const mergedFindings = [...args.state.findings, ...findings];
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
  const hasOpenNonBlockingFindings = mergedFindings.some(isOpenNonBlockingFinding);
  const reachedMaxRounds = args.context.round >= args.state.maxRounds;
  const openBlockingCanonicalCount = countOpenBlockingCanonicals(mergedFindings);
  const stalledBlockingCount = hasRepeatedNonReduction(args.state.rounds, openBlockingCanonicalCount, args.state.cwd);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const disposition = resolveExecuteReviewDisposition({
    hasBlockingFindings,
    hasOpenNonBlockingFindings,
    reachedMaxRounds,
    shouldBlockForConvergence,
    meaningfulProgressAction: args.reviewerResult.meaningfulProgress.action,
  });
  const blockReason =
    disposition.status === 'blocked'
      ? getExecuteReviewBlockReason({
          cwd: args.state.cwd,
          reopenedCanonical,
          stalledBlockingCount,
          reachedMaxRounds: reachedMaxRounds && hasBlockingFindings,
          maxRounds: args.state.maxRounds,
          meaningfulProgressAction: args.reviewerResult.meaningfulProgress.action,
          meaningfulProgressRationale: args.reviewerResult.meaningfulProgress.rationale,
          parentScopeLabel: args.context.parentScopeLabel,
        })
      : null;

  return {
    findings,
    mergedFindings,
    disposition,
    blockReason,
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
      coderDisposition: response.summary,
      coderCommit: latestCommit,
    };
  });

  const outcome = args.response.payload.outcome;
  const nextPhase: 'blocked' | 'reviewer_scope' | 'final_squash' =
    outcome === 'blocked' || outcome === 'split_plan'
      ? 'blocked'
      : mode === 'optional'
        ? 'final_squash'
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
