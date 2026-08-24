import { join } from 'node:path';

import { CoderRoundError, FinalCompletionReviewerVerdictError, ReviewerRoundError } from '../agents.js';
import { writeTextAtomic } from '../atomic-write.js';
import {
  runFinalCompletionReviewerAdjudication,
  runFinalCompletionSummaryAdjudication,
  type FinalCompletionAdjudicationContext,
} from '../adjudicator/final-completion.js';
import { assertAdjudicationTransitionSignal } from '../adjudicator/specs.js';
import { stripScopePrefixFromCommitMessage } from '../commit-message.js';
import { getFinalCompletionContinueExecutionMax } from '../config.js';
import { writeDetail } from '../diagnostic.js';
import { buildFinalCompletionPacket } from '../final-completion.js';
import {
  getFinalCompletionReviewArtifactPath,
  readFinalCompletionUnstructuredOutput,
  writeFinalCompletionReviewMarkdown,
  type FinalCompletionUnstructuredOutput,
} from '../final-completion-review.js';
import { EXECUTE_FINALIZATION_PHASE } from '../execute-finalization.js';
import {
  getChangedFilesForRange,
  getCommitRange,
  getCommitMessage,
  getCommitSubjects,
  getHeadCommit,
  getStagedChangedFiles,
  getWorktreeStatus,
  assertNoIgnoredChangedFiles,
  cleanUntracked,
  resetHard,
  squashCommits as createScopeFinalizationCommit,
  stagePath,
} from '../git.js';
import type { RunLogger } from '../logger.js';
import { notifyBlocked, notifyComplete, notifyScopeAccepted } from './notifications.js';
import { inspectPlanDocDisposition, withPlanDocPreserved } from '../plan-doc.js';
import {
  appendDerivedSubScopeAndParentCompletion,
  appendParentCompletionFromAcceptedDerivedScopes,
  computeNextScopeStateAfterExecuteFinalization,
  computeNextScopeStateAfterParentAdvance,
  createNextScopeEntryReset,
} from './transitions.js';
import { writePlanProgressArtifacts } from '../progress.js';
import { writeCheckpointRetrospective } from '../retrospective.js';
import { renderReviewMarkdown, writeReviewMarkdown } from '../review.js';
import { getCurrentScopeLabel, getParentScopeLabel, shouldAdvanceTopLevelScopeNumber } from '../scopes.js';
import { saveState } from '../state.js';
import { getFinalCompletionReviewerScratchDir, getScopeReviewerScratchDir } from '../storage-paths.js';
import {
  requireFinalCompletionView,
  resolveFinalCompletionReviewAction,
} from '../state-views.js';
import type { FinalCompletionReviewerAction, OrchestrationState } from '../types.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  formatDirtyWorktreeDiagnostic,
} from '../worktree-status.js';
import { REVIEWER_CONTENT_REFUSED_BLOCK_REASON, shouldNotifyFailure } from './failures.js';

type ExecutionArtifactWriter = (state: OrchestrationState) => Promise<void>;
type FinalizationRuntime = {
  writeExecutionArtifacts: ExecutionArtifactWriter;
};

async function writeFailedFinalCompletionReviewArtifact(args: {
  state: OrchestrationState;
  source: FinalCompletionUnstructuredOutput['source'];
  sessionHandle: string | null;
}) {
  const unstructuredOutput = await readFinalCompletionUnstructuredOutput({
    runDir: args.state.runDir,
    source: args.source,
    sessionHandle: args.sessionHandle,
  });
  await writeFinalCompletionReviewMarkdown(
    getFinalCompletionReviewArtifactPath(args.state.runDir),
    args.state,
    { unstructuredOutput },
  );
}

async function persistFailedFinalCompletionReview(args: {
  state: OrchestrationState;
  statePath: string;
  error: ReviewerRoundError | FinalCompletionReviewerVerdictError;
  logger?: RunLogger;
  runtime: FinalizationRuntime;
}) {
  const failedState = await saveState(args.statePath, {
    ...args.state,
    phase: 'final_completion_review',
    reviewerSessionHandle: null,
    status: 'failed',
  });
  await args.runtime.writeExecutionArtifacts(failedState);
  await writeFailedFinalCompletionReviewArtifact({
    state: failedState,
    source: 'reviewer_verdict',
    sessionHandle: args.error.sessionHandle,
  });
  await args.logger?.event('phase.error', {
    phase: 'final_completion_review',
    sessionHandle: args.error.sessionHandle,
    subtype: args.error.subtype,
    message: args.error.message,
  });
  return failedState;
}

// Sibling of persistFailedFinalCompletionReview for the terminal blocked
// landing of a reviewer content-safety refusal (`content_refused`). Only a
// ReviewerRoundError can carry that kind; FinalCompletionReviewerVerdictError
// never does, so persistFailedFinalCompletionReview keeps serving the
// verdict-invalid path unchanged. Persists a terminal
// phase:'blocked'/status:'blocked' state so the run ends blocked (exit 2)
// rather than as a generic terminal failure, still writing the failed
// final-completion review artifact and execution artifacts.
async function persistBlockedFinalCompletionReview(args: {
  state: OrchestrationState;
  statePath: string;
  error: ReviewerRoundError;
  logger?: RunLogger;
  runtime: FinalizationRuntime;
}) {
  const blockedState = await saveState(args.statePath, {
    ...args.state,
    phase: 'blocked',
    reviewerSessionHandle: null,
    status: 'blocked',
    blockedFromPhase: null,
    blockerReason: REVIEWER_CONTENT_REFUSED_BLOCK_REASON,
  });
  await args.runtime.writeExecutionArtifacts(blockedState);
  await writeFailedFinalCompletionReviewArtifact({
    state: blockedState,
    source: 'reviewer_verdict',
    sessionHandle: args.error.sessionHandle,
  });
  await args.logger?.event('phase.error', {
    phase: 'final_completion_review',
    sessionHandle: args.error.sessionHandle,
    subtype: args.error.subtype,
    errorKind: args.error.kind,
    message: args.error.message,
  });
  return blockedState;
}

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
  writeDetail(`${message}\n`, logger, {
    phase: 'final_completion_review',
    role: 'reviewer',
  });
}

function getTerminalCompletedScope(state: OrchestrationState) {
  const currentScopeLabel = getCurrentScopeLabel(state);
  return state.completedScopes.find((scope) => scope.number === currentScopeLabel) ?? null;
}

function formatCommitList(commits: readonly string[]) {
  return commits.length > 0 ? commits.join(', ') : '(none)';
}

function haveSameCommitSequence(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((commit, index) => commit === right[index]);
}

function unionChangedFiles(...groups: readonly string[][]) {
  return [...new Set(groups.flat())];
}

function getFinalizationExpectedScratchDirs(state: OrchestrationState): string[] {
  const scratchDirs: string[] = [];
  const lastReviewRound = state.rounds.at(-1)?.round ?? null;
  if (lastReviewRound !== null) {
    scratchDirs.push(getScopeReviewerScratchDir(state.runDir, getParentScopeLabel(state), lastReviewRound));
  }

  if (state.lastScopeMarker === 'AUTONOMY_DONE' || state.finalCompletionSummary) {
    scratchDirs.push(getFinalCompletionReviewerScratchDir(state.runDir));
  }

  return scratchDirs;
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
      'One available next step is to inspect with `neal status` and provide guidance with `neal resume --message "..."` only if the run is waiting for operator guidance.'
    );
  }

  return `final_completion_review: reviewer blocked completion for operator guidance. ${args.rationale} One available next step is to inspect with \`neal status\` and provide guidance with \`neal resume --message "..."\` only if the run is waiting for operator guidance.`;
}

async function discardFinalCompletionReviewerWorktreeChanges(args: {
  state: OrchestrationState;
  logger?: RunLogger;
}) {
  // The plan document is a wrapper-owned overlay, not reviewer dirt: it may be
  // an uncommitted modification of a tracked file (a reset --hard would
  // silently swap in the committed content — a different plan — mid-run) or an
  // untracked seed. Exclude it from the trigger and the post-check, and
  // preserve its bytes across the destructive cleanup.
  const statusOutput = filterAllowedDirtyPathStatus(
    args.state.cwd,
    filterWrapperOwnedWorktreeStatus(
      await getWorktreeStatus(args.state.cwd, { untrackedFiles: 'all' }),
    ),
    [args.state.planDoc],
  );
  if (!statusOutput.trim()) {
    return;
  }

  const headCommit = await getHeadCommit(args.state.cwd);
  await args.logger?.event('final_completion_review.discarded_dirty_worktree', {
    headCommit,
    statusOutput,
    message:
      'Final completion review is read-only; discarding reviewer-created worktree changes before state transition.',
  });
  await withPlanDocPreserved(args.state.planDoc, async () => {
    await resetHard(args.state.cwd, headCommit);
    await cleanUntracked(args.state.cwd, ['.neal/', '.forge/', 'CURRENT_PLAN.md']);
  });

  const remainingStatusOutput = filterAllowedDirtyPathStatus(
    args.state.cwd,
    filterWrapperOwnedWorktreeStatus(
      await getWorktreeStatus(args.state.cwd, { untrackedFiles: 'all' }),
    ),
    [args.state.planDoc],
  );
  if (remainingStatusOutput.trim()) {
    throw new Error(
      `Final completion review left a dirty worktree Neal could not restore:\n${remainingStatusOutput}`,
    );
  }
}

async function runParentAdvanceFinalization(args: {
  state: OrchestrationState;
  statePath: string;
  logger: RunLogger | undefined;
  runtime: FinalizationRuntime;
  headCommit: string;
  statusOutput: string;
}) {
  const { state, statePath, logger, runtime, headCommit, statusOutput } = args;
  if (!state.baseCommit) {
    throw new Error('Cannot advance parent without a baseCommit');
  }
  if (statusOutput) {
    throw new Error(
      `Cannot advance parent with a dirty worktree because resetting an empty derived range would be destructive:\n${statusOutput}`,
    );
  }

  const parentScopeLabel = getParentScopeLabel(state);
  const currentScopeLabel = getCurrentScopeLabel(state);
  const currentRangeCommits = await getCommitRange(state.cwd, state.baseCommit, headCommit);
  const changedFilesSinceBase = await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit);
  if (changedFilesSinceBase.length > 0) {
    throw new Error(
      [
        `Cannot advance parent scope ${parentScopeLabel} through empty derived scope ${currentScopeLabel}: current range has changed files.`,
        ...changedFilesSinceBase.map((file) => `- ${file}`),
      ].join('\n'),
    );
  }
  await assertNoIgnoredChangedFiles(state.cwd, changedFilesSinceBase, 'Execute parent advancement');

  if (headCommit !== state.baseCommit) {
    if (!haveSameCommitSequence(currentRangeCommits, state.createdCommits)) {
      throw new Error(
        [
          `Cannot advance parent scope ${parentScopeLabel} by dropping empty derived scope ${currentScopeLabel}: current range commits do not exactly match Neal-created commits.`,
          `Range commits: ${formatCommitList(currentRangeCommits)}`,
          `Neal-created commits: ${formatCommitList(state.createdCommits)}`,
        ].join('\n'),
      );
    }
    const parentBaseCommit = state.baseCommit;
    await withPlanDocPreserved(state.planDoc, () => resetHard(state.cwd, parentBaseCommit));
  }

  const finalCommit = state.baseCommit;
  const archivedReviewPath = join(state.runDir, `REVIEW-${finalCommit}.md`);
  const completedScopes = appendParentCompletionFromAcceptedDerivedScopes({
    state,
    finalCommit,
    archivedReviewPath,
  });
  const archivedReviewState = {
    ...state,
    finalCommit,
    archivedReviewPath,
    completedScopes,
  };
  const retrospectiveState = archivedReviewState;
  const nextState = await saveState(
    statePath,
    computeNextScopeStateAfterParentAdvance({
      state,
      finalCommit,
      completedScopes,
    }),
  );
  const parentScope = completedScopes.find(
    (scope) => scope.number === parentScopeLabel && scope.derivedFromParentScope === null,
  );
  const aggregateChangedFileCount = parentScope?.changedFiles.length ?? 0;
  const parentAdvanceMessage =
    `advance_parent completed parent scope ${parentScopeLabel} via derived plan; dropped empty derived scope ${currentScopeLabel} without accepting it.`;

  await logger?.event('execute_finalization.advance_parent', {
    message: parentAdvanceMessage,
    parentScopeLabel,
    currentScopeLabel,
    priorDerivedCount: state.completedScopes.filter(
      (scope) => scope.result === 'accepted' && scope.derivedFromParentScope === parentScopeLabel,
    ).length,
    aggregateChangedFileCount,
    droppedCommitCount: currentRangeCommits.length,
    finalParentCommit: finalCommit,
  });
  await writeTextAtomic(
    archivedReviewPath,
    renderReviewMarkdown({ ...archivedReviewState, finalCompletionSummary: null, finalCompletionReviewVerdict: null }),
  );
  await writeCheckpointRetrospective(retrospectiveState, 'scope_accepted');
  await runtime.writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: EXECUTE_FINALIZATION_PHASE,
    finalCommit,
    archivedReviewPath,
    continueScopes: true,
    meaningfulProgressAction: 'advance_parent',
    message: parentAdvanceMessage,
  });
  await notifyScopeAccepted(
    {
      ...state,
      currentScopeNumber: state.derivedFromScopeNumber ?? state.currentScopeNumber,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
    },
    parentScope?.commitSubject ?? `Parent scope ${parentScopeLabel} complete via derived plan`,
    logger,
  );

  return nextState;
}

// Dirty-worktree admission for execute finalization: capture the head commit,
// filter the worktree status down to disallowed dirt, and refuse to finalize
// (with the expected-scratch-dir diagnostic) when any remains.
async function admitFinalizationWorktree(state: OrchestrationState) {
  const headCommit = await getHeadCommit(state.cwd);
  const statusOutput = filterAllowedDirtyPathStatus(
    state.cwd,
    filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd)),
    state.allowedDirtyPaths,
  );
  if (statusOutput) {
    const diagnostic = formatDirtyWorktreeDiagnostic({
      statusOutput,
      expectedScratchDirs: getFinalizationExpectedScratchDirs(state),
    });
    throw new Error([`Cannot finalize with a dirty worktree:\n${statusOutput}`, diagnostic].filter(Boolean).join('\n\n'));
  }
  return { headCommit, statusOutput };
}

// Raw material for final-commit message synthesis: the full message of the
// latest Neal-created commit, falling back to the last recorded subject (with
// any leading hash stripped) and then to the fixed default.
async function readRawFinalCommitMessage(cwd: string, createdCommits: string[]) {
  const commitSubjects = await getCommitSubjects(cwd, createdCommits);
  const latestCreatedCommit = createdCommits.at(-1) ?? null;
  return latestCreatedCommit
    ? await getCommitMessage(cwd, latestCreatedCommit)
    : commitSubjects.at(-1)?.replace(/^[a-f0-9]+\s+/, '') || 'Finalize scope work';
}

// Final-commit message synthesis: strip the scope prefix, normalize newlines
// (falling back to the fixed default when stripping leaves nothing), apply the
// plan-doc-only special case, and derive the subject line.
function synthesizeFinalCommitMessage(args: {
  rawFinalMessage: string;
  finalizationChangedFiles: string[];
  planDocRepoRelativePath: string | null;
}) {
  const strippedFinalMessage = stripScopePrefixFromCommitMessage(args.rawFinalMessage);
  const finalMessage = normalizeFinalCommitMessage(strippedFinalMessage.trim() ? strippedFinalMessage : 'Finalize scope work');
  const onlyChangedFile = args.finalizationChangedFiles.length === 1 ? args.finalizationChangedFiles[0] : null;
  const onlyChangedPlanDoc =
    onlyChangedFile !== null &&
    args.planDocRepoRelativePath !== null &&
    onlyChangedFile === args.planDocRepoRelativePath;
  const finalCommitMessage = onlyChangedPlanDoc ? 'Record Neal plan document\n' : finalMessage;
  const finalSubject = finalCommitMessage.split(/\r?\n/, 1)[0] || 'Finalize scope work';
  return { finalCommitMessage, finalSubject };
}

// CoderRoundError-specific extras for the shared execute-finalization failure
// path. The generic (non-CoderRoundError) branch passes null: it persists the
// seeded coder session fields untouched, writes no failed final-completion
// review artifact, and never notifies.
type CoderSummaryFailureExtras = {
  // error.sessionHandle ?? state.coderSessionHandle: overrides the persisted
  // coder session handle, keys the protocol derivation, names the failed
  // artifact's session, and stamps phase.error.
  sessionHandleOverride: string | null;
  // shouldNotifyFailure(error): gates the notifyBlocked call.
  notify: boolean;
};

// The one shared failure-persistence path for both summary-adjudication catch
// branches. Ordering is pinned by test/execute-finalization-failure.test.ts:
// failed state save, execution artifacts, failed final-completion review
// artifact (coder-round branch only), checkpoint retrospective, phase.error,
// gated notification (coder-round branch only).
async function persistExecuteFinalizationFailure(args: {
  state: OrchestrationState;
  statePath: string;
  runtime: FinalizationRuntime;
  logger: RunLogger | undefined;
  finalCommit: string;
  archivedReviewPath: string;
  completedScopes: OrchestrationState['completedScopes'];
  finalCompletionSummary: OrchestrationState['finalCompletionSummary'];
  errorMessage: string;
  coderRoundExtras: CoderSummaryFailureExtras | null;
}) {
  const { state, coderRoundExtras } = args;
  const failedState = await saveState(args.statePath, {
    ...state,
    finalCommit: args.finalCommit,
    archivedReviewPath: args.archivedReviewPath,
    completedScopes: args.completedScopes,
    ...(coderRoundExtras
      ? {
          coderSessionHandle: coderRoundExtras.sessionHandleOverride,
          coderSessionProtocol: coderRoundExtras.sessionHandleOverride
            ? state.coderSessionProtocol ?? 'structured_json_v1'
            : null,
        }
      : {}),
    status: 'failed',
  });
  await args.runtime.writeExecutionArtifacts(failedState);
  if (coderRoundExtras) {
    await writeFailedFinalCompletionReviewArtifact({
      state: failedState,
      source: 'coder_summary',
      sessionHandle: coderRoundExtras.sessionHandleOverride,
    });
  }
  await writeCheckpointRetrospective(
    {
      ...failedState,
      finalCompletionSummary: args.finalCompletionSummary,
    },
    'failed',
  );
  await args.logger?.event('phase.error', {
    phase: EXECUTE_FINALIZATION_PHASE,
    sessionHandle: coderRoundExtras ? coderRoundExtras.sessionHandleOverride : state.coderSessionHandle,
    message: args.errorMessage,
  });
  if (coderRoundExtras?.notify) {
    await notifyBlocked(failedState, args.errorMessage, args.logger);
  }
}

// Summary adjudication for a terminal finalization: archive the review, build
// the final-completion packet, run the coder final-completion summary round,
// and route BOTH failure branches through the shared persistence helper
// before rethrowing.
async function adjudicateFinalCompletionSummary(args: {
  state: OrchestrationState;
  statePath: string;
  logger: RunLogger | undefined;
  runtime: FinalizationRuntime;
  finalCommit: string;
  archivedReviewPath: string;
  archivedReviewState: OrchestrationState;
  retrospectiveState: OrchestrationState;
  completedScopes: OrchestrationState['completedScopes'];
  finalSubject: string;
  finalizationChangedFiles: string[];
  finalCompletionSummary: OrchestrationState['finalCompletionSummary'];
}) {
  const { state, logger } = args;
  await writeTextAtomic(
    args.archivedReviewPath,
    renderReviewMarkdown({ ...args.archivedReviewState, finalCompletionSummary: null, finalCompletionReviewVerdict: null }),
  );
  const packet = await buildFinalCompletionPacket({
    state: args.retrospectiveState,
    terminalScope: {
      finalCommit: args.finalCommit,
      commitSubject: args.finalSubject,
      changedFiles: args.finalizationChangedFiles,
      archivedReviewPath: args.archivedReviewPath,
      marker: state.lastScopeMarker,
    },
  });
  try {
    const { summary: finalCompletion } = await runFinalCompletionSummaryAdjudication({
      state,
      packet,
      logger,
    });
    return finalCompletion.summary;
  } catch (error) {
    const coderRoundFailure = error instanceof CoderRoundError ? error : null;
    await persistExecuteFinalizationFailure({
      state,
      statePath: args.statePath,
      runtime: args.runtime,
      logger,
      finalCommit: args.finalCommit,
      archivedReviewPath: args.archivedReviewPath,
      completedScopes: args.completedScopes,
      finalCompletionSummary: args.finalCompletionSummary,
      errorMessage: coderRoundFailure
        ? coderRoundFailure.message
        : error instanceof Error
          ? error.message
          : String(error),
      coderRoundExtras: coderRoundFailure
        ? {
            sessionHandleOverride: coderRoundFailure.sessionHandle ?? state.coderSessionHandle,
            notify: shouldNotifyFailure(coderRoundFailure),
          }
        : null,
    });
    throw error;
  }
}

export async function runExecuteFinalizationPhase(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  runtime: FinalizationRuntime,
) {
  if (!state.baseCommit) {
    throw new Error('Cannot finalize without a baseCommit');
  }

  await logger?.event('phase.start', { phase: EXECUTE_FINALIZATION_PHASE });
  const { headCommit, statusOutput } = await admitFinalizationWorktree(state);
  if (state.currentScopeMeaningfulProgressVerdict?.action === 'advance_parent') {
    return runParentAdvanceFinalization({
      state,
      statePath,
      logger,
      runtime,
      headCommit,
      statusOutput,
    });
  }

  const rawFinalMessage = await readRawFinalCommitMessage(state.cwd, state.createdCommits);
  const planDocInspection = await inspectPlanDocDisposition(state.cwd, state.planDoc);
  if (planDocInspection.eligibleForCommit && planDocInspection.repoRelativePath) {
    await stagePath(state.cwd, planDocInspection.repoRelativePath);
  }

  const changedFilesSinceBase = await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit);
  const stagedChangedFiles = await getStagedChangedFiles(state.cwd);
  const finalizationChangedFiles = unionChangedFiles(changedFilesSinceBase, stagedChangedFiles);
  await assertNoIgnoredChangedFiles(state.cwd, finalizationChangedFiles, 'Execute finalization');

  const { finalCommitMessage, finalSubject } = synthesizeFinalCommitMessage({
    rawFinalMessage,
    finalizationChangedFiles,
    planDocRepoRelativePath: planDocInspection.repoRelativePath,
  });
  const finalCommit =
    finalizationChangedFiles.length > 0
      ? await createScopeFinalizationCommit(state.cwd, state.baseCommit, finalCommitMessage)
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
    changedFiles: finalizationChangedFiles,
    archivedReviewPath,
  });
  const retrospectiveState = {
    ...archivedReviewState,
    completedScopes,
  };
  const provisionalNextState = computeNextScopeStateAfterExecuteFinalization({
    state,
    finalCommit,
    completedScopes,
    archivedReviewPath,
  });
  const continueScopes = provisionalNextState.phase === 'coder_scope' && provisionalNextState.status === 'running';
  const initialFinalCompletion = requireFinalCompletionView(state, 'run execute finalization');
  let finalCompletionSummary = initialFinalCompletion.summary;

  if (!continueScopes && !finalCompletionSummary) {
    finalCompletionSummary = await adjudicateFinalCompletionSummary({
      state,
      statePath,
      logger,
      runtime,
      finalCommit,
      archivedReviewPath,
      archivedReviewState,
      retrospectiveState,
      completedScopes,
      finalSubject,
      finalizationChangedFiles,
      finalCompletionSummary,
    });
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

  await writeTextAtomic(
    archivedReviewPath,
    renderReviewMarkdown({ ...archivedReviewState, finalCompletionSummary, finalCompletionReviewVerdict: null }),
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
    phase: EXECUTE_FINALIZATION_PHASE,
    finalCommit,
    archivedReviewPath,
    continueScopes,
  });
  await notifyScopeAccepted(state, finalSubject, logger);

  return nextState;
}

export async function runFinalCompletionReviewPhase(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  runtime: FinalizationRuntime,
) {
  const finalCompletion = requireFinalCompletionView(state, 'run final completion review');
  if (!finalCompletion.summary) {
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
    // A reviewer content-safety refusal ends the run blocked (exit 2) with a
    // durable actionable reason, by RETURNING the terminal blocked state rather
    // than throwing. Only a ReviewerRoundError carries `content_refused`; the
    // verdict-invalid error never does, so it stays on the failed path below.
    if (error instanceof ReviewerRoundError && error.kind === 'content_refused') {
      const blockedState = await persistBlockedFinalCompletionReview({
        state,
        statePath,
        error,
        logger,
        runtime,
      });
      await notifyBlocked(blockedState, REVIEWER_CONTENT_REFUSED_BLOCK_REASON, logger);
      return blockedState;
    }
    if (error instanceof ReviewerRoundError || error instanceof FinalCompletionReviewerVerdictError) {
      const failedState = await persistFailedFinalCompletionReview({
        state,
        statePath,
        error,
        logger,
        runtime,
      });
      if (error instanceof ReviewerRoundError && shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }

  printFinalCompletionReviewResult(reviewerResult.verdict, logger);
  await discardFinalCompletionReviewerWorktreeChanges({ state, logger });

  const continueExecutionLimit = Math.max(0, getFinalCompletionContinueExecutionMax(state.cwd));
  const actionResolution = resolveFinalCompletionReviewAction({
    finalCompletion,
    reviewerAction: reviewerResult.verdict.action,
    continueExecutionLimit,
  });

  const baseState = {
    ...state,
    reviewerSessionHandle: reviewerResult.sessionHandle,
    finalCompletionReviewVerdict: reviewerResult.verdict,
    finalCompletionResolvedAction: actionResolution.effectiveAction,
    finalCompletionContinueExecutionCount: actionResolution.continueExecutionCount,
    finalCompletionContinueExecutionCapReached: actionResolution.continueExecutionCapReached,
  };
  assertAdjudicationTransitionSignal(
    context.spec,
    actionResolution.effectiveAction,
    'orchestrator:final_completion_review',
  );

  const nextState =
    actionResolution.effectiveAction === 'accept_complete'
      ? await saveState(statePath, {
          ...baseState,
          phase: 'done',
          status: 'done',
          blockedFromPhase: null,
        })
      : actionResolution.effectiveAction === 'continue_execution'
        ? await saveState(statePath, {
            ...baseState,
            ...createNextScopeEntryReset(state.finalCommit),
            coderRetryCount: 0,
            currentScopeNumber: shouldAdvanceTopLevelScopeNumber(state)
              ? state.currentScopeNumber + 1
              : state.currentScopeNumber,
            // The reopened follow-on scope is a fresh scope boundary: per-scope
            // budgets reset here exactly as they do at every scope-advance
            // transition, so an earlier scope's adjudication or split-plan
            // consumption never exhausts the reopened scope's budget.
            // (`consultantAttemptCount` resets via the shared next-scope
            // reset spread above.)
            splitPlanCountForCurrentScope: 0,
            blockedFromPhase: null,
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
    resultingAction: actionResolution.effectiveAction,
    continueExecutionCount: actionResolution.continueExecutionCount,
    continueExecutionLimit: actionResolution.continueExecutionLimit,
    continueExecutionCapReached: actionResolution.continueExecutionCapReached,
    reviewerSessionHandle: reviewerResult.sessionHandle,
    nextPhase: nextState.phase,
  });

  if (actionResolution.effectiveAction === 'accept_complete') {
    const finalSubject = terminalScope?.commitSubject ?? 'Finalize scope work';
    await notifyComplete(nextState, finalSubject, logger);
  } else if (actionResolution.effectiveAction === 'block_for_operator') {
    const reason = getFinalCompletionReviewBlockReason({
      reviewerAction:
        reviewerResult.verdict.action === 'accept_complete' ? 'block_for_operator' : reviewerResult.verdict.action,
      effectiveAction: actionResolution.effectiveAction,
      rationale: reviewerResult.verdict.rationale,
      continueExecutionCount: actionResolution.continueExecutionCount,
      continueExecutionLimit: actionResolution.continueExecutionLimit,
      capReached: actionResolution.continueExecutionCapReached,
    });
    await notifyBlocked(nextState, reason, logger);
  }

  return nextState;
}
