import {
  runCoderFinalCompletionSummaryRound,
  runReviewerFinalCompletionRound,
} from '../agents.js';
import type { RunLogger } from '../logger.js';
import type { FinalCompletionPacket, FinalCompletionSummary, OrchestrationState } from '../types.js';
import { getAdjudicationSpec, type AdjudicationSpec } from './specs.js';

export type FinalCompletionAdjudicationSpec = AdjudicationSpec & { family: 'final_completion' };

export type FinalCompletionAdjudicationContext = {
  spec: FinalCompletionAdjudicationSpec;
  packet: FinalCompletionPacket;
  summary: FinalCompletionSummary | null;
};

type FinalCompletionSummaryRoundRunner = typeof runCoderFinalCompletionSummaryRound;
type FinalCompletionReviewerRoundRunner = typeof runReviewerFinalCompletionRound;

export function resolveFinalCompletionAdjudicationContext(args: {
  state: OrchestrationState;
  packet: FinalCompletionPacket;
}): FinalCompletionAdjudicationContext {
  const spec = getAdjudicationSpec('final_completion_review') as FinalCompletionAdjudicationSpec;
  if (spec.family !== 'final_completion') {
    throw new Error(`Expected final completion adjudication spec, received ${spec.id}.`);
  }

  return {
    spec,
    packet: args.packet,
    summary: args.state.finalCompletionSummary,
  };
}

export async function runFinalCompletionSummaryAdjudication(args: {
  state: OrchestrationState;
  packet: FinalCompletionPacket;
  logger?: RunLogger;
  runSummaryRound?: FinalCompletionSummaryRoundRunner;
}) {
  const context = resolveFinalCompletionAdjudicationContext({
    state: args.state,
    packet: args.packet,
  });
  const summary = await (args.runSummaryRound ?? runCoderFinalCompletionSummaryRound)({
    coder: args.state.agentConfig.coder,
    cwd: args.state.cwd,
    planDoc: args.state.planDoc,
    packet: context.packet,
    logger: args.logger,
  });

  return {
    context,
    summary,
  };
}

export async function runFinalCompletionReviewerAdjudication(args: {
  state: OrchestrationState;
  packet: FinalCompletionPacket;
  logger?: RunLogger;
  runReviewerRound?: FinalCompletionReviewerRoundRunner;
}) {
  if (!args.state.finalCompletionSummary) {
    throw new Error('Cannot run final completion reviewer adjudication without a final completion summary.');
  }

  const context = resolveFinalCompletionAdjudicationContext({
    state: args.state,
    packet: args.packet,
  });
  const reviewerResult = await (args.runReviewerRound ?? runReviewerFinalCompletionRound)({
    reviewer: args.state.agentConfig.reviewer,
    cwd: args.state.cwd,
    planDoc: args.state.planDoc,
    packet: context.packet,
    summary: args.state.finalCompletionSummary,
    logger: args.logger,
  });

  return {
    context,
    reviewerResult,
  };
}
