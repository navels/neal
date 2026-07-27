import { CoderRoundError, runCoderScopeRound } from '../../agents.js';
import {
  getExecuteResponseOpenFindings,
  resolveExecuteAdjudicationContext,
  runExecuteResponseAdjudication,
  synthesizeExecuteResponseState,
} from '../../adjudicator/execute.js';
import { assertAdjudicationTransitionSignal } from '../../adjudicator/specs.js';
import {
  commitStagedChanges,
  dropIgnoredPathsFromCurrentCommitRange,
  getChangedFilesForRange,
  getCommitRange,
  getCommitSubjects,
  getHeadCommit,
  getStagedChangedFiles,
  getWorktreeStatus,
  assertNoIgnoredChangedFiles,
  stagePath,
} from '../../git.js';
import { EXECUTE_FINALIZATION_PHASE } from '../../execute-finalization.js';
import type { RunLogger } from '../../logger.js';
import { getCurrentScopeLabel, getExecutionPlanPath } from '../../scopes.js';
import { saveState } from '../../state.js';
import { getDerivedPlanView } from '../../state-views.js';
import type { ExecuteScopeProgressJustification, OrchestrationState, ScopeMarker } from '../../types.js';
import { writeExecutionArtifacts, writeManualGateArtifact } from '../artifacts.js';
import { isCoderTimeoutError, shouldNotifyFailure } from '../failures.js';
import { notifyBlocked, notifyInteractiveBlockedRecovery, notifyManualGate } from '../notifications.js';
import { persistSplitPlanRecovery } from '../split-plan.js';
import { enterInteractiveBlockedRecovery, shouldNotifyInteractiveBlockedRecoveryEntry } from './recovery.js';
import {
  bestEffortCleanupTimedOutCoder,
  persistBlockedScope,
  persistCoderFailureState,
  scheduleCoderFreshSessionRetry,
  shouldRetryCoderWithFreshSession,
} from './shared.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  parseWorktreeStatusLine,
} from '../../worktree-status.js';

export async function recoverPendingReviewFromCleanCommittedScope(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger | undefined,
  eventType: 'run.recovered_pending_review_on_resume' | 'run.recovered_pending_review_after_coder_failure',
) {
  if (
    state.topLevelMode !== 'execute' ||
    state.phase !== 'coder_scope' ||
    !state.baseCommit ||
    state.finalCommit !== null ||
    state.createdCommits.length > 0
  ) {
    return null;
  }

  let headCommit = await getHeadCommit(state.cwd);
  const worktreeStatus = await getWorktreeStatus(state.cwd);
  let createdCommits = await getCommitRange(state.cwd, state.baseCommit, headCommit);

  if (headCommit === state.baseCommit || createdCommits.length === 0 || worktreeStatus.trim() !== '') {
    return null;
  }
  headCommit = await dropIgnoredCoderCommitPaths({
    state,
    beforeHead: state.baseCommit,
    afterHead: headCommit,
    phase: 'coder_scope',
    logger,
  });
  createdCommits = await getCommitRange(state.cwd, state.baseCommit, headCommit);
  if (headCommit === state.baseCommit || createdCommits.length === 0) {
    return null;
  }
  await assertNoIgnoredChangedFiles(
    state.cwd,
    await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit),
    'Recovered coder scope',
  );

  const progressJustification =
    state.currentScopeProgressJustification ??
    (await buildRecoveredPendingReviewProgressJustification(state, createdCommits));

  const recoveredState = await saveState(statePath, {
    ...state,
    createdCommits,
    currentScopeProgressJustification: progressJustification,
    phase: 'reviewer_scope',
    status: 'running',
    coderRetryCount: 0,
  });
  await writeExecutionArtifacts(recoveredState);
  await logger?.event(eventType, {
    statePath,
    previousPhase: 'coder_scope',
    recoveredPhase: recoveredState.phase,
    baseCommit: recoveredState.baseCommit,
    headCommit,
    createdCommits,
    progressJustification,
  });

  return recoveredState;
}

function getScopeCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED' || marker === 'AUTONOMY_SPLIT_PLAN') {
    return null;
  }

  return marker === 'AUTONOMY_SCOPE_DONE' || marker === 'AUTONOMY_CHUNK_DONE' || marker === 'AUTONOMY_DONE'
    ? null
    : 'Execution must end with AUTONOMY_SCOPE_DONE, AUTONOMY_DONE, AUTONOMY_SPLIT_PLAN, or AUTONOMY_BLOCKED.';
}

function isSplitPlanMarker(marker: string | null): marker is 'AUTONOMY_SPLIT_PLAN' {
  return marker === 'AUTONOMY_SPLIT_PLAN';
}

function stripTrailingMarker(text: string, marker: string) {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === marker) {
      lines.splice(index, 1);
      break;
    }
  }

  return lines.join('\n').trim();
}

export function getExecuteResponseRetryPhase(mode: 'required' | 'optional') {
  return mode === 'optional' ? 'coder_optional_response' : 'coder_response';
}

export function getExecuteResponsePhaseWithoutOpenFindings() {
  return {
    phase: EXECUTE_FINALIZATION_PHASE,
    status: 'running' as const,
  };
}

async function recoverPendingReviewFromCleanCommittedResponse(
  state: OrchestrationState,
  statePath: string,
  beforeHead: string,
  phase: 'coder_response' | 'coder_optional_response',
  logger: RunLogger | undefined,
) {
  let afterHead = await getHeadCommit(state.cwd);
  if (afterHead === beforeHead) {
    return null;
  }
  afterHead = await dropIgnoredCoderCommitPaths({
    state,
    beforeHead,
    afterHead,
    phase,
    logger,
  });
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  if (createdCommits.length === 0) {
    return null;
  }
  const worktreeStatus = filterAllowedDirtyPathStatus(
    state.cwd,
    filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd)),
    state.allowedDirtyPaths,
  );
  if (worktreeStatus.trim() !== '') {
    return null;
  }
  const changedFiles = await getChangedFilesForRange(state.cwd, beforeHead, afterHead);
  await assertNoIgnoredChangedFiles(state.cwd, changedFiles, 'Recovered coder review response');

  const recoveredState = await saveState(statePath, {
    ...state,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: null,
    createdCommits: [...state.createdCommits, ...createdCommits],
    coderRetryCount: 0,
  });
  await writeExecutionArtifacts(recoveredState);
  await logger?.event('run.recovered_pending_review_after_coder_response_failure', {
    statePath,
    previousPhase: phase,
    recoveredPhase: recoveredState.phase,
    beforeHead,
    afterHead,
    createdCommits,
    changedFiles,
  });
  return recoveredState;
}

export async function runCoderScopePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.baseCommit) {
    throw new Error('Cannot run coder scope phase without baseCommit');
  }

  await logger?.event('phase.start', { phase: 'coder_scope' });
  const beforeHead = await getHeadCommit(state.cwd);
  let workingState = state;
  let codex;
  const activeCoderSessionProtocol = state.coderSessionHandle
    ? state.coderSessionProtocol
    : 'structured_json_v1';
  try {
    codex = await runCoderScopeRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      sessionHandle: state.coderSessionHandle,
      coderSessionProtocol: state.coderSessionProtocol,
      unattended: state.unattended,
      onSessionStarted: async (sessionHandle) => {
        state.coderSessionHandle = sessionHandle;
        state.coderSessionProtocol = activeCoderSessionProtocol;
        workingState = await saveState(statePath, {
          ...workingState,
          coderSessionHandle: sessionHandle,
          coderSessionProtocol: activeCoderSessionProtocol,
        });
      },
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderWithFreshSession(workingState, 'coder_scope', error)) {
        return scheduleCoderFreshSessionRetry(workingState, statePath, 'coder_scope', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoder(error.sessionHandle ?? workingState.coderSessionHandle, logger);
      }
      const recoveredState = await recoverPendingReviewFromCleanCommittedScope(
        {
          ...workingState,
          coderSessionHandle: error.sessionHandle ?? workingState.coderSessionHandle,
          coderSessionProtocol: (error.sessionHandle ?? workingState.coderSessionHandle)
            ? workingState.coderSessionProtocol ?? activeCoderSessionProtocol
            : null,
        },
        statePath,
        logger,
        'run.recovered_pending_review_after_coder_failure',
      );
      if (recoveredState) {
        return recoveredState;
      }
      const failedState = await persistCoderFailureState(workingState, statePath, 'coder_scope', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  let afterHead = await getHeadCommit(state.cwd);
  afterHead = await dropIgnoredCoderCommitPaths({
    state,
    beforeHead,
    afterHead,
    phase: 'coder_scope',
    logger,
  });
  let createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  if (codex.manualGate) {
    const now = new Date().toISOString();
    const instructionsPath = await writeManualGateArtifact({
      state: workingState,
      ...codex.manualGate,
    });
    const manualGateState = await saveState(statePath, {
      ...workingState,
      coderSessionHandle: codex.sessionHandle,
      coderSessionProtocol: codex.sessionHandle ? activeCoderSessionProtocol : null,
      lastScopeMarker: null,
      currentScopeProgressJustification: codex.progressJustification,
      phase: 'manual_gate',
      status: 'running',
      blockedFromPhase: null,
      manualGate: {
        id: codex.manualGate.id,
        title: codex.manualGate.title,
        reason: codex.manualGate.reason,
        instructionsPath,
        resumeChecks: codex.manualGate.resumeChecks,
        resumePhase: 'coder_scope',
        createdAt: now,
        updatedAt: now,
        lastCheckedAt: null,
        lastFailure: null,
      },
      createdCommits: [...workingState.createdCommits, ...createdCommits],
      coderRetryCount: 0,
    });
    await writeExecutionArtifacts(manualGateState);
    const openedGate = manualGateState.manualGate;
    if (!openedGate) {
      throw new Error('Manual gate state was not persisted after manual_gate coder action.');
    }
    await logger?.event('manual_gate.opened', {
      phase: 'coder_scope',
      gateId: openedGate.id,
      title: openedGate.title,
      instructionsPath,
      resumeChecks: openedGate.resumeChecks.map((check) => check.name),
      sessionHandle: codex.sessionHandle,
      createdCommits,
      nextPhase: manualGateState.phase,
    });
    await notifyManualGate(manualGateState, logger);
    return manualGateState;
  }
  const completionProblem = getScopeCompletionProblem(codex.marker);
  const splitPlan = isSplitPlanMarker(codex.marker);
  const canCommitDirtyCoderWorktree =
    codex.marker !== 'AUTONOMY_BLOCKED' && !splitPlan && !completionProblem;
  if (canCommitDirtyCoderWorktree) {
    const autoCommit = await commitDirtyCoderWorktreeChanges(workingState, logger, 'coder_scope');
    if (autoCommit) {
      afterHead = autoCommit;
      createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
    }
  }
  const changedFilesInCoderRound =
    createdCommits.length > 0 ? await getChangedFilesForRange(state.cwd, beforeHead, afterHead) : [];
  await assertNoIgnoredChangedFiles(state.cwd, changedFilesInCoderRound, 'Coder scope');
  const changedFilesSinceBase = await getChangedFilesForRange(state.cwd, state.baseCommit, afterHead);
  const verificationOnlyCompletion =
    codex.marker === 'AUTONOMY_DONE' &&
    createdCommits.length === 0 &&
    changedFilesSinceBase.length === 0;

  const nextState = await saveState(statePath, {
    ...workingState,
    coderSessionHandle: codex.sessionHandle,
    coderSessionProtocol: codex.sessionHandle ? activeCoderSessionProtocol : null,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    currentScopeProgressJustification: codex.progressJustification,
    phase:
      codex.marker === 'AUTONOMY_BLOCKED' || splitPlan || completionProblem
        ? 'blocked'
        : verificationOnlyCompletion
          ? EXECUTE_FINALIZATION_PHASE
          : 'reviewer_scope',
    status: codex.marker === 'AUTONOMY_BLOCKED' || splitPlan || completionProblem ? 'blocked' : 'running',
    blockedFromPhase: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'coder_scope' : null,
    createdCommits: [...workingState.createdCommits, ...createdCommits],
    coderRetryCount: 0,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_scope',
    marker: codex.marker,
    sessionHandle: codex.sessionHandle,
    createdCommits,
    verificationOnlyCompletion,
    nextPhase: nextState.phase,
  });
  if (splitPlan) {
    return persistSplitPlanRecovery(
      nextState,
      statePath,
      {
        sourcePhase: 'coder_scope',
        derivedPlanMarkdown: stripTrailingMarker(codex.responseWithoutProgressPayload, 'AUTONOMY_SPLIT_PLAN'),
        createdCommits,
        logger,
      },
      {
        persistBlockedScope,
        writeExecutionArtifacts,
      },
    );
  }

  if (nextState.status === 'blocked') {
    const reason = completionProblem ?? 'The coder reported a blocker during scope execution';
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, reason, logger);
    if (shouldNotifyInteractiveBlockedRecoveryEntry(persistedState)) {
      await notifyInteractiveBlockedRecovery(persistedState, reason, logger);
    }
    return persistedState;
  }
  return nextState;
}

export async function runExecuteResponsePhase(
  state: OrchestrationState,
  statePath: string,
  phase: 'coder_response' | 'coder_optional_response',
  logger?: RunLogger,
) {
  const mode = phase === 'coder_optional_response' ? 'optional' : 'required';
  await logger?.event('phase.start', { phase });
  const { spec } = resolveExecuteAdjudicationContext(state);
  const openFindings = getExecuteResponseOpenFindings(state, mode === 'optional' ? 'optional' : undefined);
  if (openFindings.length === 0) {
    assertAdjudicationTransitionSignal(spec, 'accept_scope', `orchestrator:${phase}:settled`);
    const settled = getExecuteResponsePhaseWithoutOpenFindings();
    const nextState = await saveState(statePath, {
      ...state,
      phase: settled.phase,
      status: settled.status,
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('phase.complete', {
      phase,
      openFindings: 0,
      nextPhase: nextState.phase,
    });
    return nextState;
  }

  const beforeHead = await getHeadCommit(state.cwd);
  let codex;
  try {
    ({ response: codex } = await runExecuteResponseAdjudication({
      state,
      mode: mode === 'optional' ? 'optional' : undefined,
      logger,
    }));
  } catch (error) {
    if (error instanceof CoderRoundError) {
      const retryPhase = getExecuteResponseRetryPhase(mode);
      if (shouldRetryCoderWithFreshSession(state, retryPhase, error)) {
        return scheduleCoderFreshSessionRetry(state, statePath, retryPhase, error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoder(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const recoveredState = await recoverPendingReviewFromCleanCommittedResponse(
        state,
        statePath,
        beforeHead,
        retryPhase,
        logger,
      );
      if (recoveredState) {
        return recoveredState;
      }
      const failedState = await persistCoderFailureState(state, statePath, retryPhase, error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  let afterHead = await getHeadCommit(state.cwd);
  afterHead = await dropIgnoredCoderCommitPaths({
    state,
    beforeHead,
    afterHead,
    phase,
    logger,
  });
  let createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  if (codex.payload.outcome === 'responded') {
    const autoCommit = await commitDirtyCoderWorktreeChanges(state, logger, phase);
    if (autoCommit) {
      afterHead = autoCommit;
      afterHead = await dropIgnoredCoderCommitPaths({
        state,
        beforeHead,
        afterHead,
        phase,
        logger,
      });
      createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
    }
  }
  const changedFilesInResponse =
    createdCommits.length > 0 ? await getChangedFilesForRange(state.cwd, beforeHead, afterHead) : [];
  await assertNoIgnoredChangedFiles(state.cwd, changedFilesInResponse, 'Coder review response');
  const responseState = synthesizeExecuteResponseState({
    state,
    mode: mode === 'optional' ? 'optional' : undefined,
    response: codex,
    createdCommits,
  });

  const nextState = await saveState(statePath, {
    ...state,
    coderSessionHandle: codex.sessionHandle,
    coderSessionProtocol: codex.sessionHandle ? state.coderSessionProtocol : null,
    findings: responseState.findings,
    createdCommits: [...state.createdCommits, ...createdCommits],
    phase: responseState.nextPhase,
    status: responseState.nextStatus,
    blockedFromPhase: responseState.blockedFromPhase,
    coderRetryCount: 0,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase,
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    createdCommits,
    nextPhase: nextState.phase,
  });
  if (codex.payload.outcome === 'split_plan') {
    return persistSplitPlanRecovery(
      nextState,
      statePath,
      {
        sourcePhase: phase,
        derivedPlanMarkdown: codex.payload.derivedPlan?.trim() ?? '',
        createdCommits,
        logger,
      },
      {
        persistBlockedScope,
        writeExecutionArtifacts,
      },
    );
  }

  if (nextState.status === 'blocked') {
    const blocker =
      codex.payload.blocker?.trim() ||
      codex.payload.summary.trim() ||
      (mode === 'optional'
        ? 'The coder reported a blocker while considering non-blocking review findings'
        : 'The coder reported a blocker during review response');
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, blocker, logger);
    if (shouldNotifyInteractiveBlockedRecoveryEntry(persistedState)) {
      await notifyBlocked(persistedState, blocker, logger);
    }
    return persistedState;
  }
  return nextState;
}

async function buildRecoveredPendingReviewProgressJustification(
  state: OrchestrationState,
  createdCommits: string[],
): Promise<ExecuteScopeProgressJustification> {
  const commitSubjects = await getCommitSubjects(state.cwd, createdCommits);
  const changedFiles = state.baseCommit
    ? await getChangedFilesForRange(state.cwd, state.baseCommit, createdCommits.at(-1) ?? state.baseCommit)
    : [];
  const derivedPlan = getDerivedPlanView(state);
  const scopeLabel = derivedPlan?.executing
    ? `derived scope ${derivedPlan.scopeIndex} of parent scope ${derivedPlan.parentScopeNumber ?? state.currentScopeNumber}`
    : `scope ${state.currentScopeNumber}`;

  return {
    milestoneTargeted: `Recovered completed coder work for ${scopeLabel}`,
    newEvidence: [
      `Resume detected ${createdCommits.length} committed change(s) after the saved base commit while the worktree was clean.`,
      commitSubjects.length > 0 ? `Commits: ${commitSubjects.join('; ')}` : null,
      changedFiles.length > 0 ? `Changed files: ${changedFiles.join(', ')}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join(' '),
    whyNotRedundant:
      'The previous coder turn failed after creating commits, so this recovered review checkpoint covers committed work that has not yet been adjudicated.',
    nextStepUnlocked:
      'Reviewer can adjudicate the recovered committed scope instead of Neal crashing or rerunning coder work that already produced commits.',
  };
}

async function commitDirtyCoderWorktreeChanges(
  state: OrchestrationState,
  logger: RunLogger | undefined,
  phase: 'coder_scope' | 'coder_response' | 'coder_optional_response',
) {
  const statusOutput = filterAllowedDirtyPathStatus(
    state.cwd,
    filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd)),
    state.allowedDirtyPaths,
  );
  if (!statusOutput) {
    return null;
  }

  const paths = [
    ...new Set(
      statusOutput
        .split('\n')
        .map(parseWorktreeStatusLine)
        .filter((entry): entry is NonNullable<ReturnType<typeof parseWorktreeStatusLine>> => entry !== null)
        .flatMap((entry) => entry.paths),
    ),
  ];
  for (const path of paths) {
    await stagePath(state.cwd, path);
  }

  const stagedChangedFiles = await getStagedChangedFiles(state.cwd);
  if (stagedChangedFiles.length === 0) {
    return null;
  }
  const context = phase === 'coder_scope' ? 'Coder scope' : 'Coder review response';
  await assertNoIgnoredChangedFiles(state.cwd, stagedChangedFiles, context);

  const finalCommit = await commitStagedChanges(state.cwd, `${getAutoCommitSubject(state, phase)}\n`);
  await logger?.event(`${phase}.autocommit_dirty_worktree`, {
    message: phase === 'coder_scope'
      ? 'Created a Neal commit for dirty coder edits after the coder reported scope completion without committing all changes.'
      : 'Created a Neal commit for dirty coder edits after the coder reported review findings were handled without committing all changes.',
    finalCommit,
    changedFiles: stagedChangedFiles,
  });
  return finalCommit;
}

function getAutoCommitSubject(
  state: OrchestrationState,
  phase: 'coder_scope' | 'coder_response' | 'coder_optional_response',
) {
  switch (phase) {
    case 'coder_scope':
      return `Complete scope ${getCurrentScopeLabel(state)}`;
    case 'coder_optional_response':
      return `Address optional review findings for scope ${getCurrentScopeLabel(state)}`;
    case 'coder_response':
      return `Address review findings for scope ${getCurrentScopeLabel(state)}`;
  }
}

async function dropIgnoredCoderCommitPaths(args: {
  state: OrchestrationState;
  beforeHead: string;
  afterHead: string;
  phase: 'coder_scope' | 'coder_response' | 'coder_optional_response';
  logger: RunLogger | undefined;
}): Promise<string> {
  if (args.beforeHead === args.afterHead) {
    return args.afterHead;
  }

  const result = await dropIgnoredPathsFromCurrentCommitRange(args.state.cwd, args.beforeHead, args.afterHead);
  if (result.ignoredFiles.length > 0) {
    await args.logger?.event('coder.ignored_paths_dropped', {
      phase: args.phase,
      baseCommit: args.beforeHead,
      originalHeadCommit: args.afterHead,
      headCommit: result.headCommit,
      createdReplacementCommit: result.createdReplacementCommit,
      ignoredFiles: result.ignoredFiles,
    });
  }

  return result.headCommit;
}
