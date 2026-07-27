import { ReviewerRoundError } from '../../agents.js';
import {
  resolveExecuteReviewDisposition,
  runExecuteReviewerAdjudication,
  synthesizeExecuteReviewerState,
} from '../../adjudicator/execute.js';
import { assertAdjudicationTransitionSignal } from '../../adjudicator/specs.js';
import {
  getChangedFilesForRange,
  getCommitRange,
  getDiffForRange,
  getDiffStatForRange,
  getHeadCommit,
} from '../../git.js';
import type { RunLogger } from '../../logger.js';
import { writeDetail } from '../../diagnostic.js';
import { saveState } from '../../state.js';
import type {
  OrchestrationState,
  ReviewerMeaningfulProgressAction,
} from '../../types.js';
import { writeExecutionArtifacts } from '../artifacts.js';
import { REVIEWER_CONTENT_REFUSED_BLOCK_REASON, shouldNotifyFailure } from '../failures.js';
import { notifyBlocked } from '../notifications.js';
import { enterInteractiveBlockedRecovery, shouldNotifyInteractiveBlockedRecoveryEntry } from './recovery.js';
import { printReviewResult } from './shared.js';

function getExecuteReviewDispositionSignal(args: {
  phase: ReturnType<typeof resolveExecuteReviewDisposition>['phase'];
  meaningfulProgressAction: ReviewerMeaningfulProgressAction;
}) {
  if (args.phase === 'execute_finalization') {
    return args.meaningfulProgressAction === 'advance_parent' ? ('advance_parent' as const) : ('accept_scope' as const);
  }

  if (args.phase === 'coder_response') {
    return 'request_revision' as const;
  }

  if (args.phase === 'coder_optional_response') {
    return 'optional_revision' as const;
  }

  return args.meaningfulProgressAction === 'replace_plan' ? ('replace_plan' as const) : ('block_for_operator' as const);
}

export async function runReviewPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'reviewer_scope', round: state.rounds.length + 1 });
  let claude;
  let headCommit: string;
  let changedFiles: string[];
  let reviewContext;
  let reviewerSynthesis;
  try {
    ({
      context: reviewContext,
      reviewerResult: claude,
      reviewInput: { headCommit, changedFiles },
    } = await runExecuteReviewerAdjudication({
      state,
      logger,
      getHeadCommit,
      getCommitRange,
      getDiffStatForRange,
      getChangedFilesForRange,
      getDiffForRange,
    }));
    reviewerSynthesis = synthesizeExecuteReviewerState({
      state,
      context: reviewContext,
      headCommit,
      changedFiles,
      reviewerResult: claude,
    });
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      // A content-safety refusal is a distinct, terminal, non-coder-recoverable
      // condition: end the run blocked (exit 2) with a durable actionable reason
      // instead of a generic terminal failure. This must RETURN the terminal
      // blocked state (phase:'blocked'/status:'blocked'), never throw — a thrown
      // error over a persisted blocked state escapes executeRun, and the run loop
      // only exits cleanly on a returned terminal phase.
      if (error.kind === 'content_refused') {
        const blockedState = await saveState(statePath, {
          ...state,
          reviewerSessionHandle: null,
          phase: 'blocked',
          status: 'blocked',
          blockedFromPhase: null,
          blockerReason: REVIEWER_CONTENT_REFUSED_BLOCK_REASON,
        });
        await writeExecutionArtifacts(blockedState);
        await logger?.event('phase.error', {
          phase: 'reviewer_scope',
          round: state.rounds.length + 1,
          sessionHandle: error.sessionHandle,
          subtype: error.subtype,
          errorKind: error.kind,
          message: error.message,
        });
        await notifyBlocked(blockedState, REVIEWER_CONTENT_REFUSED_BLOCK_REASON, logger);
        return blockedState;
      }
      const failedState = await saveState(statePath, {
        ...state,
        reviewerSessionHandle: null,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'reviewer_scope',
        round: state.rounds.length + 1,
        sessionHandle: error.sessionHandle,
        subtype: error.subtype,
        message: error.message,
      });
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }

  printReviewResult('review', claude.summary, claude.findings, logger);
  const meaningfulProgressVerdict = reviewerSynthesis.meaningfulProgressVerdict;
  writeDetail(
    `[reviewer:review] meaningful progress: ${meaningfulProgressVerdict.action} - ${meaningfulProgressVerdict.rationale}\n`,
    logger,
    {
      phase: 'reviewer_scope',
      role: 'reviewer',
    },
  );
  assertAdjudicationTransitionSignal(
    reviewContext.spec,
    getExecuteReviewDispositionSignal({
      phase: reviewerSynthesis.disposition.phase,
      meaningfulProgressAction: meaningfulProgressVerdict.action,
    }),
    'orchestrator:reviewer_scope',
  );

  const adjudicatedState = {
    ...state,
    reviewerSessionHandle: claude.sessionHandle,
    phase: reviewerSynthesis.disposition.phase,
    status: reviewerSynthesis.disposition.status,
    rounds: [
      ...state.rounds,
      reviewerSynthesis.roundRecord,
    ],
    findings: reviewerSynthesis.mergedFindings,
    blockedFromPhase: reviewerSynthesis.disposition.blockedFromPhase,
    currentScopeMeaningfulProgressVerdict: meaningfulProgressVerdict,
  };

  const nextState = await saveState(statePath, adjudicatedState);
  const parentAdvanceClassification = reviewerSynthesis.parentAdvanceClassification;
  const parentAdvanceMessage =
    meaningfulProgressVerdict.action === 'advance_parent'
      ? (
          `advance_parent will advance parent scope ${parentAdvanceClassification?.parentScopeLabel ?? reviewContext.parentScopeLabel} ` +
          `after empty derived scope ${parentAdvanceClassification?.currentScopeLabel ?? 'unknown'} ` +
          'without accepting the current no-op sub-scope.'
        )
      : null;
  if (meaningfulProgressVerdict.action === 'advance_parent') {
    await logger?.event('review.meaningful_progress.advance_parent', {
      message: parentAdvanceMessage ?? 'Advancing parent scope after an empty derived scope.',
      parentScopeLabel: parentAdvanceClassification?.parentScopeLabel ?? reviewContext.parentScopeLabel,
      currentScopeLabel: parentAdvanceClassification?.currentScopeLabel ?? null,
      source: parentAdvanceClassification?.source ?? null,
      priorEmptyCount: parentAdvanceClassification?.priorEmptyCount ?? null,
      priorSubstantiveCount: parentAdvanceClassification?.priorSubstantiveCount ?? null,
      aggregateChangedFileCount: parentAdvanceClassification?.aggregateChangedFiles.length ?? null,
      failedPreconditions: parentAdvanceClassification?.failedPreconditions ?? [],
    });
  }
  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'reviewer_scope',
    round: reviewContext.round,
    sessionHandle: claude.sessionHandle,
    findings: reviewerSynthesis.findings.length,
    blockingFindings: reviewerSynthesis.findings.filter((finding) => finding.severity === 'blocking').length,
    meaningfulProgressAction: meaningfulProgressVerdict.action,
    originalMeaningfulProgressAction: claude.meaningfulProgress.action,
    message: parentAdvanceMessage ?? undefined,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && reviewerSynthesis.blockReason) {
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, reviewerSynthesis.blockReason, logger);
    if (shouldNotifyInteractiveBlockedRecoveryEntry(persistedState)) {
      await notifyBlocked(persistedState, reviewerSynthesis.blockReason, logger);
    }
    return persistedState;
  }
  return nextState;
}
