import { mkdir } from 'node:fs/promises';

import {
  runCoderFinalCompletionSummaryRound,
  runReviewerFinalCompletionRound,
} from '../agents.js';
import { readOnlyReviewerNeedsInlinedDiff } from '../context/inline-review-context.js';
import { buildAndPersistReviewerContextPacket } from '../context/reviewer-context.js';
import { getDiffForRange } from '../git.js';
import type { RunLogger } from '../logger.js';
import { getFinalCompletionView } from '../state-views.js';
import { getFinalCompletionReviewerScratchDir } from '../storage-paths.js';
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
    summary: getFinalCompletionView(args.state)?.summary ?? null,
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
  getDiffForRange?: (cwd: string, baseCommit: string, headCommit: string) => Promise<string>;
}) {
  const finalCompletion = getFinalCompletionView(args.state);
  if (!finalCompletion?.summary) {
    throw new Error('Cannot run final completion reviewer adjudication without a final completion summary.');
  }

  const context = resolveFinalCompletionAdjudicationContext({
    state: args.state,
    packet: args.packet,
  });
  const scratchDir = getFinalCompletionReviewerScratchDir(args.state.runDir);
  await mkdir(scratchDir, { recursive: true });
  // Read-only reviewers with read tools but no commit-range diff tool (native
  // Claude/Codex) get the aggregate commit-range diff inlined directly when the
  // aggregate range is available; read-only reviewers that expose their own
  // commit-range diff tool (openai-compatible) inspect the range with that tool.
  const aggregate = context.packet.aggregateReviewContext;
  const inlinedRangeDiff =
    readOnlyReviewerNeedsInlinedDiff(args.state.agentConfig.reviewer) &&
    aggregate.unavailableReason === null &&
    aggregate.baseCommit &&
    aggregate.headCommit
      ? await (args.getDiffForRange ?? getDiffForRange)(args.state.cwd, aggregate.baseCommit, aggregate.headCommit)
      : null;
  const reviewerResult = await (args.runReviewerRound ?? runReviewerFinalCompletionRound)({
    reviewer: args.state.agentConfig.reviewer,
    cwd: args.state.cwd,
    planDoc: args.state.planDoc,
    packet: context.packet,
    summary: finalCompletion.summary,
    scratchDir,
    reviewerContext: await buildAndPersistReviewerContextPacket({ state: args.state }),
    inlinedRangeDiff,
    unattended: args.state.unattended,
    logger: args.logger,
  });

  return {
    context,
    reviewerResult,
  };
}
