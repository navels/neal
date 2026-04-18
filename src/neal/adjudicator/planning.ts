import { runCoderPlanResponseRound, runPlanReviewerRound } from '../agents.js';
import type { RunLogger } from '../logger.js';
import type { OrchestrationState, ReviewFinding } from '../types.js';
import { getAdjudicationSpec, type AdjudicationSpec } from './specs.js';

export type PlanReviewMode = 'plan' | 'derived-plan' | 'recovery-plan';
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
  diagnosticRecoveryPlanReview: boolean;
  reviewTargetPath: string;
  roundLimit: number;
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  recoveryParentScopeLabel?: string | null;
};

type PlanReviewerRoundRunner = typeof runPlanReviewerRound;
type CoderPlanResponseRoundRunner = typeof runCoderPlanResponseRound;

export function isDerivedPlanReviewState(state: OrchestrationState) {
  return state.topLevelMode === 'execute' && Boolean(state.derivedPlanPath) && state.derivedPlanStatus === 'pending_review';
}

export function isDiagnosticRecoveryPlanReviewState(state: OrchestrationState) {
  if (!state.diagnosticRecovery?.recoveryPlanPath) {
    return false;
  }

  if (state.phase === 'diagnostic_recovery_review' || state.phase === 'diagnostic_recovery_adopt') {
    return true;
  }

  if (state.phase === 'blocked' && state.blockedFromPhase === 'diagnostic_recovery_review') {
    return true;
  }

  if (state.phase === 'coder_plan_response' || state.phase === 'coder_plan_optional_response') {
    return state.rounds.at(-1)?.reviewedPlanPath === state.diagnosticRecovery.recoveryPlanPath;
  }

  return false;
}

export function resolvePlanningAdjudicationContext(state: OrchestrationState): PlanningAdjudicationContext {
  const derivedPlanReview = isDerivedPlanReviewState(state);
  const diagnosticRecoveryPlanReview = isDiagnosticRecoveryPlanReviewState(state);

  const reviewMode: PlanReviewMode =
    derivedPlanReview ? 'derived-plan' : diagnosticRecoveryPlanReview ? 'recovery-plan' : 'plan';
  const spec = getAdjudicationSpec(
    reviewMode === 'derived-plan'
      ? 'derived_plan_review'
      : reviewMode === 'recovery-plan'
        ? 'recovery_plan_review'
        : 'plan_review',
  ) as PlanningAdjudicationSpec;

  if (spec.family !== 'plan_review') {
    throw new Error(`Expected planning adjudication spec, received ${spec.id}.`);
  }

  return {
    spec,
    reviewMode,
    derivedPlanReview,
    diagnosticRecoveryPlanReview,
    reviewTargetPath:
      derivedPlanReview && state.derivedPlanPath
        ? state.derivedPlanPath
        : diagnosticRecoveryPlanReview && state.diagnosticRecovery?.recoveryPlanPath
          ? state.diagnosticRecovery.recoveryPlanPath
          : state.planDoc,
    roundLimit: derivedPlanReview ? state.maxDerivedPlanReviewRounds : state.maxRounds,
    parentPlanDoc: derivedPlanReview || diagnosticRecoveryPlanReview ? state.planDoc : undefined,
    derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
    recoveryParentScopeLabel: diagnosticRecoveryPlanReview ? state.diagnosticRecovery?.parentScopeLabel : null,
  };
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
  const reviewerResult = await (args.runReviewerRound ?? runPlanReviewerRound)({
    reviewer: args.state.agentConfig.reviewer,
    cwd: args.state.cwd,
    planDoc: preparedReview.reviewedPlanPath,
    round: args.round,
    reviewMarkdownPath: args.reviewMarkdownPath,
    mode: context.reviewMode,
    parentPlanDoc: context.parentPlanDoc,
    derivedFromScopeNumber: context.derivedFromScopeNumber,
    recoveryParentScopeLabel: context.recoveryParentScopeLabel,
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
  if (!args.state.coderSessionHandle) {
    throw new Error('Cannot run planning response adjudication without an existing coder session.');
  }

  const context = resolvePlanningAdjudicationContext(args.state);
  const response = await (args.runResponseRound ?? runCoderPlanResponseRound)({
    coder: args.state.agentConfig.coder,
    cwd: args.state.cwd,
    planDoc: context.reviewTargetPath,
    openFindings: args.openFindings,
    mode: args.mode,
    sessionHandle: args.state.coderSessionHandle,
    reviewMode: context.reviewMode,
    parentPlanDoc: context.parentPlanDoc,
    derivedFromScopeNumber: context.derivedFromScopeNumber,
    recoveryParentScopeLabel: context.recoveryParentScopeLabel,
    logger: args.logger,
  });

  return {
    context,
    response,
  };
}
