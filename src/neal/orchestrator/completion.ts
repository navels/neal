import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CoderRoundError, ReviewerRoundError } from '../agents.js';
import {
  runFinalCompletionReviewerAdjudication,
  runFinalCompletionSummaryAdjudication,
  type FinalCompletionAdjudicationContext,
} from '../adjudicator/final-completion.js';
import { assertAdjudicationTransitionSignal } from '../adjudicator/specs.js';
import { getFinalCompletionContinueExecutionMax } from '../config.js';
import { writeDiagnostic } from '../diagnostic.js';
import { buildFinalCompletionPacket } from '../final-completion.js';
import { getFinalCompletionReviewArtifactPath, writeFinalCompletionReviewMarkdown } from '../final-completion-review.js';
import {
  getChangedFilesForRange,
  getCommitMessage,
  getCommitSubjects,
  getHeadCommit,
  getWorktreeStatus,
  squashCommits,
} from '../git.js';
import type { RunLogger } from '../logger.js';
import { notifyBlocked, notifyComplete, notifyScopeAccepted } from './notifications.js';
import { filterWrapperOwnedWorktreeStatus } from './split-plan.js';
import { appendDerivedSubScopeAndParentCompletion, computeNextScopeStateAfterSquash } from './transitions.js';
import { writePlanProgressArtifacts } from '../progress.js';
import { writeCheckpointRetrospective } from '../retrospective.js';
import { renderReviewMarkdown, writeReviewMarkdown } from '../review.js';
import { getCurrentScopeLabel, shouldAdvanceTopLevelScopeNumber } from '../scopes.js';
import { saveState } from '../state.js';
import type { FinalCompletionReviewerAction, OrchestrationState } from '../types.js';
import { shouldNotifyFailure } from './failures.js';

type ExecutionArtifactWriter = (state: OrchestrationState) => Promise<void>;
type FinalizationRuntime = {
  writeExecutionArtifacts: ExecutionArtifactWriter;
};

function normalizeFinalCommitMessage(message: string) {
  const normalizedNewlines = message.replace(/\r\n/g, '\n');
  const convertedEscapes = normalizedNewlines.replace(/\\n(?=- )/g, '\n');
  return convertedEscapes.replace(/\n+$/, '') + '\n';
}

function printFinalCompletionReviewResult(args: {
  action: FinalCompletionReviewerAction;
  summary: string;
  rationale: string;
}, logger?: RunLogger) {
  const message = [
    `[reviewer:final-completion] action: ${args.action}`,
    `[reviewer:final-completion] summary: ${args.summary}`,
    `[reviewer:final-completion] rationale: ${args.rationale}`,
  ].join('\n');
  writeDiagnostic(`${message}\n`, logger);
}

function getTerminalCompletedScope(state: OrchestrationState) {
  const currentScopeLabel = getCurrentScopeLabel(state);
  return state.completedScopes.find((scope) => scope.number === currentScopeLabel) ?? null;
}

function getFinalCompletionReviewBlockReason(args: {
  reviewerAction: Exclude<FinalCompletionReviewerAction, 'accept_complete'>;
  effectiveAction: Exclude<FinalCompletionReviewerAction, 'accept_complete'>;
  rationale: string;
  continueExecutionCount: number;
  continueExecutionLimit: number;
  capReached: boolean;
}) {
  if (args.effectiveAction === 'continue_execution') {
    return `final_completion_review: reviewer reopened execution. ${args.rationale}`;
  }

  if (args.reviewerAction === 'continue_execution' && args.capReached) {
    return (
      'final_completion_review: reviewer requested more execution, ' +
      `but the continue_execution cap (${args.continueExecutionLimit}) is already exhausted ` +
      `after ${args.continueExecutionCount} reopen cycle(s). ${args.rationale} ` +
      'One available next step is `neal --diagnose`.'
    );
  }

  return `final_completion_review: reviewer blocked completion for operator guidance. ${args.rationale} One available next step is \`neal --diagnose\`.`;
}

export async function runFinalSquashPhase(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  runtime: FinalizationRuntime,
) {
  if (!state.baseCommit) {
    throw new Error('Cannot finalize without a baseCommit');
  }

  await logger?.event('phase.start', { phase: 'final_squash' });
  const headCommit = await getHeadCommit(state.cwd);
  const statusOutput = filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd));
  if (statusOutput && !state.ignoreLocalChanges) {
    throw new Error(`Cannot finalize with a dirty worktree:\n${statusOutput}`);
  }

  const commitSubjects = await getCommitSubjects(state.cwd, state.createdCommits);
  const latestCreatedCommit = state.createdCommits.at(-1) ?? null;
  const rawFinalMessage = latestCreatedCommit
    ? await getCommitMessage(state.cwd, latestCreatedCommit)
    : commitSubjects.at(-1)?.replace(/^[a-f0-9]+\s+/, '') || 'Finalize scope work';
  const finalMessage = normalizeFinalCommitMessage(rawFinalMessage);
  const finalSubject = finalMessage.split(/\r?\n/, 1)[0] || 'Finalize scope work';
  const changedFilesSinceBase = await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit);
  const finalCommit =
    state.createdCommits.length > 0 && changedFilesSinceBase.length > 0
      ? await squashCommits(state.cwd, state.baseCommit, finalMessage)
      : headCommit;

  const archivedReviewPath = join(state.runDir, `REVIEW-${finalCommit}.md`);
  const archivedReviewState = {
    ...state,
    finalCommit,
    archivedReviewPath,
  };
  const completedScopes = appendDerivedSubScopeAndParentCompletion({
    state,
    finalCommit,
    finalSubject,
    changedFiles: changedFilesSinceBase,
    archivedReviewPath,
  });
  const retrospectiveState = {
    ...archivedReviewState,
    completedScopes,
  };
  const provisionalNextState = computeNextScopeStateAfterSquash({
    state,
    finalCommit,
    completedScopes,
    archivedReviewPath,
  });
  const continueScopes = provisionalNextState.phase === 'coder_scope' && provisionalNextState.status === 'running';
  let finalCompletionSummary = state.finalCompletionSummary;

  if (!continueScopes && !finalCompletionSummary) {
    const packet = await buildFinalCompletionPacket({
      state: retrospectiveState,
      terminalScope: {
        finalCommit,
        commitSubject: finalSubject,
        changedFiles: changedFilesSinceBase,
        archivedReviewPath,
        marker: state.lastScopeMarker,
      },
    });
    try {
      const { summary: finalCompletion } = await runFinalCompletionSummaryAdjudication({
        state,
        packet,
        logger,
      });
      finalCompletionSummary = finalCompletion.summary;
    } catch (error) {
      if (error instanceof CoderRoundError) {
        const failedState = await saveState(statePath, {
          ...state,
          finalCommit,
          archivedReviewPath,
          completedScopes,
          coderSessionHandle: error.sessionHandle ?? state.coderSessionHandle,
          status: 'failed',
        });
        await runtime.writeExecutionArtifacts(failedState);
        await writeCheckpointRetrospective(
          {
            ...failedState,
            finalCompletionSummary,
          },
          'failed',
        );
        await logger?.event('phase.error', {
          phase: 'final_squash',
          sessionHandle: error.sessionHandle ?? state.coderSessionHandle,
          message: error.message,
        });
        if (shouldNotifyFailure(error)) {
          await notifyBlocked(failedState, error.message, logger);
        }
      } else {
        const failedState = await saveState(statePath, {
          ...state,
          finalCommit,
          archivedReviewPath,
          completedScopes,
          status: 'failed',
        });
        await runtime.writeExecutionArtifacts(failedState);
        await writeCheckpointRetrospective(
          {
            ...failedState,
            finalCompletionSummary,
          },
          'failed',
        );
        await logger?.event('phase.error', {
          phase: 'final_squash',
          sessionHandle: state.coderSessionHandle,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  const nextState = await saveState(
    statePath,
    continueScopes
      ? {
          ...provisionalNextState,
          finalCompletionSummary,
        }
      : {
          ...provisionalNextState,
          blockedFromPhase: null,
          finalCompletionSummary,
          finalCompletionReviewVerdict: null,
          finalCompletionResolvedAction: null,
          finalCompletionContinueExecutionCapReached: false,
        },
  );

  await writeFile(
    archivedReviewPath,
    renderReviewMarkdown({ ...archivedReviewState, finalCompletionSummary, finalCompletionReviewVerdict: null }),
    'utf8',
  );
  await writeCheckpointRetrospective(retrospectiveState, 'scope_accepted');
  if (continueScopes) {
    await runtime.writeExecutionArtifacts(nextState);
  } else {
    await writeReviewMarkdown(nextState.reviewMarkdownPath, { ...nextState, finalCommit, archivedReviewPath });
    await writePlanProgressArtifacts(nextState);
    await writeFinalCompletionReviewMarkdown(
      getFinalCompletionReviewArtifactPath(nextState.runDir),
      { ...nextState, finalCommit, archivedReviewPath },
    );
  }
  await logger?.event('phase.complete', {
    phase: 'final_squash',
    finalCommit,
    archivedReviewPath,
    continueScopes,
  });
  if (continueScopes) {
    await notifyScopeAccepted(state, finalSubject, logger);
  }

  return nextState;
}

export async function runFinalCompletionReviewPhase(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  runtime: FinalizationRuntime,
) {
  if (!state.finalCompletionSummary) {
    throw new Error('Cannot run final completion review without a final completion summary');
  }

  await logger?.event('phase.start', { phase: 'final_completion_review' });
  const terminalScope = getTerminalCompletedScope(state);
  const packet = await buildFinalCompletionPacket({
    state,
    terminalScope: terminalScope
      ? {
          finalCommit: terminalScope.finalCommit,
          commitSubject: terminalScope.commitSubject,
          changedFiles: terminalScope.changedFiles,
          archivedReviewPath: terminalScope.archivedReviewPath,
          marker: terminalScope.marker,
        }
      : null,
  });

  let context: FinalCompletionAdjudicationContext;
  let reviewerResult;
  try {
    ({ context, reviewerResult } = await runFinalCompletionReviewerAdjudication({
      state,
      packet,
      logger,
    }));
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      const failedState = await saveState(statePath, {
        ...state,
        reviewerSessionHandle: error.sessionHandle,
        status: 'failed',
      });
      await runtime.writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'final_completion_review',
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

  printFinalCompletionReviewResult(reviewerResult.verdict, logger);

  const continueExecutionLimit = Math.max(0, getFinalCompletionContinueExecutionMax(state.cwd));
  const capReached =
    reviewerResult.verdict.action === 'continue_execution' &&
    state.finalCompletionContinueExecutionCount >= continueExecutionLimit;
  const effectiveAction =
    reviewerResult.verdict.action === 'continue_execution' && capReached
      ? 'block_for_operator'
      : reviewerResult.verdict.action;
  const continueExecutionCount =
    reviewerResult.verdict.action === 'continue_execution' && !capReached
      ? state.finalCompletionContinueExecutionCount + 1
      : state.finalCompletionContinueExecutionCount;

  const baseState = {
    ...state,
    reviewerSessionHandle: reviewerResult.sessionHandle,
    finalCompletionReviewVerdict: reviewerResult.verdict,
    finalCompletionResolvedAction: effectiveAction,
    finalCompletionContinueExecutionCount: continueExecutionCount,
    finalCompletionContinueExecutionCapReached: capReached,
  };
  assertAdjudicationTransitionSignal(
    context.spec,
    effectiveAction,
    'orchestrator:final_completion_review',
  );

  const nextState =
    effectiveAction === 'accept_complete'
      ? await saveState(statePath, {
          ...baseState,
          phase: 'done',
          status: 'done',
          blockedFromPhase: null,
        })
      : effectiveAction === 'continue_execution'
        ? await saveState(statePath, {
            ...baseState,
            baseCommit: state.finalCommit,
            finalCommit: null,
            archivedReviewPath: null,
            coderSessionHandle: null,
            coderRetryCount: 0,
            currentScopeNumber: shouldAdvanceTopLevelScopeNumber(state)
              ? state.currentScopeNumber + 1
              : state.currentScopeNumber,
            lastScopeMarker: null,
            currentScopeProgressJustification: null,
            currentScopeMeaningfulProgressVerdict: null,
            finalCompletionSummary: null,
            rounds: [],
            consultRounds: [],
            findings: [],
            createdCommits: [],
            blockedFromPhase: null,
            phase: 'coder_scope',
            status: 'running',
          })
        : await saveState(statePath, {
            ...baseState,
            phase: 'blocked',
            status: 'blocked',
            blockedFromPhase: 'final_completion_review',
          });

  await runtime.writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'final_completion_review',
    action: reviewerResult.verdict.action,
    resultingAction: effectiveAction,
    continueExecutionCount,
    continueExecutionLimit,
    continueExecutionCapReached: capReached,
    reviewerSessionHandle: reviewerResult.sessionHandle,
    nextPhase: nextState.phase,
  });

  if (effectiveAction === 'accept_complete') {
    const finalSubject = terminalScope?.commitSubject ?? 'Finalize scope work';
    await notifyComplete(nextState, finalSubject, logger);
  } else if (effectiveAction === 'block_for_operator') {
    const reason = getFinalCompletionReviewBlockReason({
      reviewerAction:
        reviewerResult.verdict.action === 'accept_complete' ? 'block_for_operator' : reviewerResult.verdict.action,
      effectiveAction,
      rationale: reviewerResult.verdict.rationale,
      continueExecutionCount,
      continueExecutionLimit,
      capReached,
    });
    await notifyBlocked(nextState, reason, logger);
  }

  return nextState;
}
