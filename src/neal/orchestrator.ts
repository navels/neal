import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { getMaxReviewRounds, getPhaseHeartbeatMs, getReviewStuckWindow } from './config.js';
import {
  CoderRoundError,
  ReviewerRoundError,
  runCoderConsultResponseRound,
  runCoderScopeRound,
  runCoderPlanResponseRound,
  runCoderPlanRound,
  runCoderResponseRound,
  runConsultReviewerRound,
  runPlanReviewerRound,
  runReviewerRound,
} from './agents.js';
import { writeConsultMarkdown } from './consult.js';
import {
  getChangedFilesForRange,
  getCommitMessage,
  getCommitRange,
  getCommitSubjects,
  getDiffForRange,
  getDiffStatForRange,
  getHeadCommit,
  getWorktreeStatus,
  squashCommits,
} from './git.js';
import { createRunLogger, type RunLogger } from './logger.js';
import {
  flushDerivedPlanNotifications,
  notifyBlocked,
  notifyComplete,
  notifyRetry,
  notifyScopeAccepted,
} from './orchestrator/notifications.js';
import { filterWrapperOwnedWorktreeStatus, persistSplitPlanRecovery } from './orchestrator/split-plan.js';
import { validatePlanDocument } from './plan-validation.js';
import { writePlanProgressArtifacts } from './progress.js';
import { writeCheckpointRetrospective } from './retrospective.js';
import { renderReviewMarkdown, writeReviewMarkdown } from './review.js';
import { getCurrentScopeLabel, getExecutionPlanPath, getParentScopeLabel, hasAcceptedDerivedPlan, isExecutingDerivedPlan } from './scopes.js';
import { createInitialState, getSessionStatePath, loadState, saveState } from './state.js';
import type {
  AgentConfig,
  CoderConsultRequest,
  FindingStatus,
  OrchestrationState,
  OrchestratorInit,
  ReviewFinding,
  ReviewFindingSource,
  ScopeMarker,
} from './types.js';

const execFile = promisify(execFileCallback);
export { flushDerivedPlanNotifications };

function writeDiagnostic(message: string, logger?: RunLogger) {
  process.stderr.write(message);
  void logger?.stderr(message);
}

function formatReviewFindings(
  findings: Array<{
    source?: ReviewFindingSource;
    severity: 'blocking' | 'non_blocking';
    files: string[];
    claim: string;
    requiredAction: string;
  }>,
) {
  if (findings.length === 0) {
    return '  Findings: none\n';
  }

  return findings
    .map((finding, index) => {
      const files = finding.files.length > 0 ? finding.files.join(', ') : 'n/a';
      const source = finding.source ? ` [${finding.source}]` : '';
      return [
        `  ${index + 1}. [${finding.severity}]${source} ${finding.claim}`,
        `     Files: ${files}`,
        `     Action: ${finding.requiredAction}`,
      ].join('\n');
    })
    .join('\n') + '\n';
}

function printReviewResult(
  kind: 'review' | 'plan-review',
  summary: string,
  findings: Array<{
    source?: ReviewFindingSource;
    severity: 'blocking' | 'non_blocking';
    files: string[];
    claim: string;
    requiredAction: string;
  }>,
  logger?: RunLogger,
) {
  const blocking = findings.filter((finding) => finding.severity === 'blocking').length;
  const nonBlocking = findings.length - blocking;
  const header = kind === 'review' ? '[reviewer:review]' : '[reviewer:plan-review]';
  const message = [
    `${header} summary: ${summary}`,
    `${header} findings: ${blocking} blocking, ${nonBlocking} non-blocking`,
    formatReviewFindings(findings),
  ].join('\n');
  writeDiagnostic(`${message}\n`, logger);
}

type ReviewFindingInput = Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>;

export async function synthesizePlanReviewFindings(args: {
  planPath: string;
  round: number;
  roundSummary: string;
  findings: ReviewFindingInput[];
}): Promise<{ executionShape: OrchestrationState['executionShape']; findings: ReviewFindingInput[] }> {
  const planDocument = await readFile(args.planPath, 'utf8');
  const validation = validatePlanDocument(planDocument);

  if (validation.ok) {
    return {
      executionShape: validation.executionShape,
      findings: args.findings,
    };
  }

  return {
    executionShape: validation.executionShape,
    findings: [
      ...args.findings,
      ...validation.errors.map((error) => ({
        round: args.round,
        source: 'plan_structure' as const,
        severity: 'blocking' as const,
        files: [args.planPath],
        claim: `Plan document structure is invalid: ${error}`,
        requiredAction: 'Revise the plan document so it satisfies the required execution-shape and execution-queue contract.',
        roundSummary: args.roundSummary,
      })),
    ],
  };
}

function startPhaseHeartbeat(
  phase: OrchestrationState['phase'],
  getState: () => OrchestrationState,
  logger?: RunLogger,
  intervalMs = getPhaseHeartbeatMs(),
) {
  if (!logger || intervalMs <= 0) {
    return () => {};
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const state = getState();
    const elapsedMs = Date.now() - startedAt;
    const payload = {
      phase,
      elapsedMs,
      coderSessionHandle: state.coderSessionHandle,
      reviewerSessionHandle: state.reviewerSessionHandle,
      currentScopeNumber: state.currentScopeNumber,
      topLevelMode: state.topLevelMode,
    };
    void logger.event('phase.heartbeat', payload);
    writeDiagnostic(
      `[neal] heartbeat phase=${phase} elapsed=${Math.round(elapsedMs / 1000)}s` +
        `${state.coderSessionHandle ? ` coder=${state.coderSessionHandle}` : ''}` +
        `${state.reviewerSessionHandle ? ` reviewer=${state.reviewerSessionHandle}` : ''}\n`,
      logger,
    );
  }, intervalMs);

  return () => clearInterval(timer);
}

async function persistCoderFailureState(
  state: OrchestrationState,
  statePath: string,
  phase:
    | 'coder_scope'
    | 'coder_plan'
    | 'coder_response'
    | 'coder_optional_response'
    | 'coder_plan_response'
    | 'coder_plan_optional_response'
    | 'coder_consult_response',
  error: CoderRoundError,
  logger?: RunLogger,
) {
  const failedState = await saveState(statePath, {
    ...state,
    coderSessionHandle: error.sessionHandle ?? state.coderSessionHandle,
    status: 'failed',
  });
  await writeExecutionArtifacts(failedState);
  await writeCheckpointRetrospective(failedState, 'failed');
  await logger?.event('phase.error', {
    phase,
    sessionHandle: error.sessionHandle ?? state.coderSessionHandle,
    message: error.message,
  });
  return failedState;
}

function getScopeCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED' || marker === 'AUTONOMY_SPLIT_PLAN') {
    return null;
  }

  return marker === 'AUTONOMY_SCOPE_DONE' || marker === 'AUTONOMY_CHUNK_DONE' || marker === 'AUTONOMY_DONE'
    ? null
    : 'Execution must end with AUTONOMY_SCOPE_DONE, AUTONOMY_DONE, AUTONOMY_SPLIT_PLAN, or AUTONOMY_BLOCKED.';
}

function getPlanningCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED') {
    return null;
  }

  return marker === 'AUTONOMY_DONE' ? null : 'Planning mode must end with AUTONOMY_DONE or AUTONOMY_BLOCKED.';
}

async function writeExecutionArtifacts(state: OrchestrationState) {
  await writeReviewMarkdown(state.reviewMarkdownPath, state);
  await writeConsultMarkdown(state.consultMarkdownPath, state);
  await writePlanProgressArtifacts(state);
}

function countConsultsForCurrentScope(state: OrchestrationState) {
  return state.consultRounds.length;
}

function shouldConsultBlockedCoder(state: OrchestrationState) {
  return state.topLevelMode === 'execute' && countConsultsForCurrentScope(state) < state.maxConsultsPerScope;
}

function buildConsultRequest(args: {
  state: OrchestrationState;
  sourcePhase: 'coder_scope' | 'coder_response';
  blocker: string;
  summary: string;
  relevantFiles: string[];
  verificationContext?: string[];
}) {
  const trimmedSummary = args.summary.trim() || args.blocker.trim() || 'Coder requested blocker help';
  const trimmedBlocker = args.blocker.trim() || trimmedSummary;
  return {
    number: countConsultsForCurrentScope(args.state) + 1,
    sourcePhase: args.sourcePhase,
    coderSessionHandle: args.state.coderSessionHandle,
    reviewerSessionHandle: null,
    request: {
      summary: trimmedSummary,
      blocker: trimmedBlocker,
      question: `What is the best concrete next step to unblock this scope? ${trimmedBlocker}`,
      attempts: [],
      relevantFiles: args.relevantFiles,
      verificationContext: args.verificationContext ?? [],
    } satisfies CoderConsultRequest,
    response: null,
    disposition: null,
  };
}

export async function initializeOrchestration(
  planDoc: string,
  cwd: string,
  agentConfig: AgentConfig,
  topLevelMode: 'plan' | 'execute' = 'execute',
) {
  const absolutePlanDoc = resolve(planDoc);
  const stateDir = join(cwd, '.neal');
  const logger = await createRunLogger({
    cwd,
    stateDir,
    planDoc: absolutePlanDoc,
    topLevelMode,
  });

  const init: OrchestratorInit = {
    cwd,
    planDoc: absolutePlanDoc,
    stateDir,
    runDir: logger.runDir,
    topLevelMode,
    agentConfig,
    progressJsonPath: join(logger.runDir, 'plan-progress.json'),
    progressMarkdownPath: join(logger.runDir, 'PLAN_PROGRESS.md'),
    reviewMarkdownPath: join(logger.runDir, 'REVIEW.md'),
    consultMarkdownPath: join(logger.runDir, 'CONSULT.md'),
    maxRounds: getMaxReviewRounds(cwd),
  };

  await mkdir(stateDir, { recursive: true });

  const baseCommit = await getHeadCommit(cwd);
  const initialState = await createInitialState(init, baseCommit);
  const statePath = getSessionStatePath(stateDir);
  const savedState = await saveState(statePath, initialState);
  await writeExecutionArtifacts(savedState);
  await logger.event('run.initialized', {
    statePath,
    baseCommit,
    topLevelMode,
    agentConfig: savedState.agentConfig,
    reviewMarkdownPath: savedState.reviewMarkdownPath,
    progressJsonPath: savedState.progressJsonPath,
    progressMarkdownPath: savedState.progressMarkdownPath,
  });

  return {
    state: savedState,
    statePath,
    logger,
  };
}

async function persistBlockedScope(state: OrchestrationState, statePath: string, reason: string) {
  const scopeLabel = getCurrentScopeLabel(state);
  if (state.completedScopes.some((scope) => scope.number === scopeLabel)) {
    return state;
  }

  const blockedDuringDerivedPlanReview =
    state.topLevelMode === 'execute' &&
    !isExecutingDerivedPlan(state) &&
    Boolean(state.derivedPlanPath) &&
    state.derivedFromScopeNumber === state.currentScopeNumber;

  const nextState = await saveState(statePath, {
    ...state,
    blockedFromPhase: state.blockedFromPhase ?? state.phase,
    completedScopes: appendCompletedScope(state, 'blocked', {
      scopeLabel: getCurrentScopeLabel(state),
      finalCommit: null,
      commitSubject: null,
      archivedReviewPath: state.archivedReviewPath,
      blocker: reason,
      derivedFromParentScope: isExecutingDerivedPlan(state) ? getParentScopeLabel(state) : null,
      replacedByDerivedPlanPath: blockedDuringDerivedPlanReview ? state.derivedPlanPath : null,
    }),
  });
  await writeExecutionArtifacts(nextState);
  return nextState;
}

function isResumableBlockedPhase(
  phase: OrchestrationState['phase'] | null,
): phase is 'coder_scope' | 'coder_response' | 'coder_optional_response' | 'coder_plan' | 'coder_plan_response' | 'coder_plan_optional_response' {
  return (
    phase === 'coder_scope' ||
    phase === 'coder_response' ||
    phase === 'coder_optional_response' ||
    phase === 'coder_plan' ||
    phase === 'coder_plan_response' ||
    phase === 'coder_plan_optional_response'
  );
}

function normalizeFinalCommitMessage(message: string) {
  const normalizedNewlines = message.replace(/\r\n/g, '\n');
  const convertedEscapes = normalizedNewlines.replace(/\\n(?=- )/g, '\n');
  return convertedEscapes.replace(/\n+$/, '') + '\n';
}

function isCoderTimeoutError(error: CoderRoundError) {
  return /\btimed out after\b/i.test(error.message);
}

function isSplitPlanMarker(marker: string | null): marker is 'AUTONOMY_SPLIT_PLAN' {
  return marker === 'AUTONOMY_SPLIT_PLAN';
}

function isDerivedPlanReviewState(state: OrchestrationState) {
  return state.topLevelMode === 'execute' && Boolean(state.derivedPlanPath) && state.derivedPlanStatus === 'pending_review';
}

function getPlanReviewTargetPath(state: OrchestrationState) {
  return isDerivedPlanReviewState(state) && state.derivedPlanPath ? state.derivedPlanPath : state.planDoc;
}

function getPlanReviewRoundLimit(state: OrchestrationState) {
  return isDerivedPlanReviewState(state) ? state.maxDerivedPlanReviewRounds : state.maxRounds;
}

function getDerivedPlanBlockedReason(state: OrchestrationState, reason: string) {
  if (!isDerivedPlanReviewState(state)) {
    return reason;
  }

  return `split-plan recovery failed to converge: ${reason}`;
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

function shouldNotifyDerivedPlanAcceptance(previousState: OrchestrationState, nextState: OrchestrationState) {
  return (
    previousState.topLevelMode === 'execute' &&
    previousState.derivedPlanStatus !== 'accepted' &&
    nextState.derivedPlanStatus === 'accepted' &&
    nextState.phase === 'awaiting_derived_plan_execution'
  );
}

async function finalizePlanReviewResponseWithoutOpenFindings(
  state: OrchestrationState,
  statePath: string,
  phase: 'coder_plan_response' | 'coder_plan_optional_response',
  derivedPlanReview: boolean,
  logger?: RunLogger,
) {
  let nextState = await saveState(statePath, {
    ...state,
    phase: derivedPlanReview ? 'awaiting_derived_plan_execution' : 'done',
    status: derivedPlanReview ? 'running' : 'done',
    derivedPlanStatus: derivedPlanReview ? 'accepted' : state.derivedPlanStatus,
  });
  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase,
    openFindings: 0,
    nextPhase: nextState.phase,
  });
  nextState = await flushDerivedPlanNotifications(nextState, statePath, logger);
  if (nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

async function finalizeBlockedPlanReviewResponse(
  state: OrchestrationState,
  statePath: string,
  derivedPlanReview: boolean,
  blocker: string,
  logger?: RunLogger,
) {
  const persistedState = await persistBlockedScope(state, statePath, blocker);
  if (!derivedPlanReview) {
    await notifyBlocked(persistedState, blocker, logger);
  }
  return flushDerivedPlanNotifications(persistedState, statePath, logger, blocker);
}

function isTransientApiFailureMessage(message: string, subtype?: string | null) {
  const text = `${subtype ?? ''}\n${message}`.toLowerCase();
  return (
    text.includes('api_error') ||
    text.includes('api error') ||
    text.includes('internal server error') ||
    text.includes('overloaded') ||
    text.includes('rate limit') ||
    text.includes('temporar') ||
    text.includes('try again')
  );
}

function shouldNotifyFailure(error: CoderRoundError | ReviewerRoundError) {
  if (error instanceof CoderRoundError) {
    return isCoderTimeoutError(error) || isTransientApiFailureMessage(error.message);
  }

  return isTransientApiFailureMessage(error.message, error.subtype);
}

function shouldRetryCoderTimeout(
  state: OrchestrationState,
  phase:
    | 'coder_scope'
    | 'coder_plan'
    | 'coder_response'
    | 'coder_optional_response'
    | 'coder_plan_response'
    | 'coder_plan_optional_response',
  error: CoderRoundError,
) {
  if (!isCoderTimeoutError(error) || state.coderRetryCount >= 1) {
    return false;
  }

  if (state.topLevelMode === 'execute') {
    return phase === 'coder_scope' || phase === 'coder_response' || phase === 'coder_optional_response';
  }

  return phase === 'coder_plan' || phase === 'coder_plan_response' || phase === 'coder_plan_optional_response';
}

function escapeForPkillPattern(text: string) {
  return text.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
}

async function bestEffortCleanupTimedOutCoderResume(sessionHandle: string | null, logger?: RunLogger) {
  if (!sessionHandle) {
    return;
  }

  const pattern = `codex.*resume ${escapeForPkillPattern(sessionHandle)}`;
  try {
    await execFile('pkill', ['-f', pattern]);
    await logger?.event('coder.timeout_cleanup', {
      sessionHandle,
      pattern,
      result: 'killed',
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    await logger?.event('coder.timeout_cleanup', {
      sessionHandle,
      pattern,
      result: 'not_found_or_failed',
      details,
    });
  }
}

async function scheduleCoderTimeoutRetry(
  state: OrchestrationState,
  statePath: string,
  phase:
    | 'coder_scope'
    | 'coder_plan'
    | 'coder_response'
    | 'coder_optional_response'
    | 'coder_plan_response'
    | 'coder_plan_optional_response',
  error: CoderRoundError,
  logger?: RunLogger,
) {
  await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? state.coderSessionHandle, logger);
  const retryState = await saveState(statePath, {
    ...state,
    coderSessionHandle: null,
    coderRetryCount: state.coderRetryCount + 1,
    status: 'running',
    phase,
  });
  await writeExecutionArtifacts(retryState);
  await logger?.event('phase.retry', {
    phase,
    sessionHandle: error.sessionHandle ?? state.coderSessionHandle,
    retryCount: retryState.coderRetryCount,
    message: error.message,
  });
  await notifyRetry(
    retryState,
    state.topLevelMode === 'plan'
      ? `planning phase ${phase} timed out; retrying with a fresh coder session`
      : `scope ${retryState.currentScopeNumber} timed out in ${phase}; retrying with a fresh coder session`,
    logger,
  );
  return retryState;
}

async function runCoderScopePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'coder_scope' });
  const beforeHead = await getHeadCommit(state.cwd);
  let workingState = state;
  let codex;
  try {
    codex = await runCoderScopeRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      sessionHandle: state.coderSessionHandle,
      onSessionStarted: async (sessionHandle) => {
        state.coderSessionHandle = sessionHandle;
        workingState = await saveState(statePath, {
          ...workingState,
          coderSessionHandle: sessionHandle,
        });
      },
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(workingState, 'coder_scope', error)) {
        return scheduleCoderTimeoutRetry(workingState, statePath, 'coder_scope', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? workingState.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(workingState, statePath, 'coder_scope', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const afterHead = await getHeadCommit(state.cwd);
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  const completionProblem = getScopeCompletionProblem(codex.marker);
  const splitPlan = isSplitPlanMarker(codex.marker);

  const nextState = await saveState(statePath, {
    ...workingState,
    coderSessionHandle: codex.sessionHandle,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    phase: codex.marker === 'AUTONOMY_BLOCKED' || splitPlan || completionProblem ? 'blocked' : 'reviewer_scope',
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
    nextPhase: nextState.phase,
  });
  if (splitPlan) {
    return persistSplitPlanRecovery(
      nextState,
      statePath,
      {
        sourcePhase: 'coder_scope',
        derivedPlanMarkdown: stripTrailingMarker(codex.finalResponse, 'AUTONOMY_SPLIT_PLAN'),
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
    if (shouldConsultBlockedCoder(nextState)) {
      const consultState = await saveState(statePath, {
        ...nextState,
        phase: 'reviewer_consult',
        status: 'running',
        consultRounds: [
          ...nextState.consultRounds,
          buildConsultRequest({
            state: nextState,
            sourcePhase: 'coder_scope',
            blocker: reason,
            summary: codex.finalResponse.replace(/\s*AUTONOMY_BLOCKED\s*$/m, '').trim(),
            relevantFiles: createdCommits.length > 0 ? await getChangedFilesForRange(state.cwd, beforeHead, afterHead) : [],
          }),
        ],
      });
      await writeExecutionArtifacts(consultState);
      const consultRound = consultState.consultRounds.at(-1);
      await logger?.event('consult.start', {
        scopeNumber: consultState.currentScopeNumber,
        consultRound: consultRound?.number,
        sourcePhase: consultRound?.sourcePhase,
        coderSessionHandle: consultRound?.coderSessionHandle,
        blocker: consultRound?.request.blocker,
      });
      return consultState;
    }
    const persistedState = await persistBlockedScope(nextState, statePath, reason);
    await notifyBlocked(
      persistedState,
      reason,
      logger,
    );
    return persistedState;
  }
  return nextState;
}

async function runCoderPlanPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'coder_plan' });
  let workingState = state;
  let codex;
  try {
    codex = await runCoderPlanRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: state.planDoc,
      sessionHandle: state.coderSessionHandle,
      onSessionStarted: async (sessionHandle) => {
        state.coderSessionHandle = sessionHandle;
        workingState = await saveState(statePath, {
          ...workingState,
          coderSessionHandle: sessionHandle,
        });
      },
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(workingState, 'coder_plan', error)) {
        return scheduleCoderTimeoutRetry(workingState, statePath, 'coder_plan', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? workingState.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(workingState, statePath, 'coder_plan', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const completionProblem = getPlanningCompletionProblem(codex.marker);

  const nextState = await saveState(statePath, {
    ...workingState,
    coderSessionHandle: codex.sessionHandle,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    phase: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'blocked' : 'reviewer_plan',
    status: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'blocked' : 'running',
    blockedFromPhase: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'coder_plan' : null,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_plan',
    marker: codex.marker,
    sessionHandle: codex.sessionHandle,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const reason = completionProblem ?? 'The coder reported a blocker during plan revision';
    const persistedState = await persistBlockedScope(nextState, statePath, reason);
    await notifyBlocked(persistedState, reason, logger);
    return persistedState;
  }
  return nextState;
}

async function runReviewPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.baseCommit) {
    throw new Error('Cannot run reviewer round without baseCommit');
  }

  await logger?.event('phase.start', { phase: 'reviewer_scope', round: state.rounds.length + 1 });
  const headCommit = await getHeadCommit(state.cwd);
  const round = state.rounds.length + 1;
  const previousHeadCommit = state.rounds.at(-1)?.commitRange.head ?? null;
  const commits = await getCommitRange(state.cwd, state.baseCommit, headCommit);
  const diffStat = await getDiffStatForRange(state.cwd, state.baseCommit, headCommit);
  const diff = await getDiffForRange(state.cwd, state.baseCommit, headCommit);
  const changedFiles = await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit);
  let claude;
  try {
    claude = await runReviewerRound({
      reviewer: state.agentConfig.reviewer,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      baseCommit: state.baseCommit,
      headCommit,
      commits,
      previousHeadCommit,
      diffStat,
      diff,
      changedFiles,
      round,
      reviewMarkdownPath: state.reviewMarkdownPath,
      logger,
    });
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      const failedState = await saveState(statePath, {
        ...state,
        reviewerSessionHandle: error.sessionHandle,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'reviewer_scope',
        round,
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

  let nextCanonicalIndex = getNextCanonicalIndex(state.findings);
  const findings = claude.findings.map((finding, index) => {
    const canonicalId = findCanonicalId(state.findings, finding) ?? `C${nextCanonicalIndex++}`;
    return {
      ...finding,
      id: `R${round}-F${index + 1}`,
      canonicalId,
      status: 'open' as const,
      coderDisposition: null,
      coderCommit: null,
    };
  });
  const mergedFindings = [...state.findings, ...findings];
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
  const hasOpenNonBlockingFindings = mergedFindings.some(isOpenNonBlockingFinding);
  const reachedMaxRounds = round >= state.maxRounds;
  const openBlockingCanonicalCount = countOpenBlockingCanonicals(mergedFindings);
  const stalledBlockingCount = hasRepeatedNonReduction(state.rounds, openBlockingCanonicalCount);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const blockReason = reopenedCanonical
    ? `review_stuck: blocking finding ${reopenedCanonical} reopened across multiple reviewer rounds`
    : stalledBlockingCount
      ? `review_stuck: blocking findings did not decrease across ${getReviewStuckWindow()} consecutive reviewer rounds`
      : reachedMaxRounds && hasBlockingFindings
        ? `reached max review rounds (${state.maxRounds}) with blocking findings still open`
        : null;

  const nextState = await saveState(statePath, {
    ...state,
    reviewerSessionHandle: claude.sessionHandle,
    phase: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'coder_response'
        : hasOpenNonBlockingFindings
          ? 'coder_optional_response'
          : 'final_squash',
    status: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'running'
        : 'running',
    rounds: [
      ...state.rounds,
      {
        round,
        reviewerSessionHandle: claude.sessionHandle,
        commitRange: {
          base: state.baseCommit,
          head: headCommit,
        },
        openBlockingCanonicalCount,
        findings: findings.map((finding) => finding.id),
      },
    ],
    findings: mergedFindings,
    blockedFromPhase: shouldBlockForConvergence || (hasBlockingFindings && reachedMaxRounds) ? 'reviewer_scope' : null,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'reviewer_scope',
    round,
    sessionHandle: claude.sessionHandle,
    findings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && blockReason) {
    const persistedState = await persistBlockedScope(nextState, statePath, blockReason);
    await notifyBlocked(persistedState, blockReason, logger);
    return persistedState;
  }
  return nextState;
}

async function runPlanReviewPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'reviewer_plan', round: state.rounds.length + 1 });
  const round = state.rounds.length + 1;
  const derivedPlanReview = isDerivedPlanReviewState(state);
  const roundLimit = getPlanReviewRoundLimit(state);
  let claude;
  try {
    claude = await runPlanReviewerRound({
      reviewer: state.agentConfig.reviewer,
      cwd: state.cwd,
      planDoc: getPlanReviewTargetPath(state),
      round,
      reviewMarkdownPath: state.reviewMarkdownPath,
      mode: derivedPlanReview ? 'derived-plan' : 'plan',
      parentPlanDoc: derivedPlanReview ? state.planDoc : undefined,
      derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
      logger,
    });
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      const failedState = await saveState(statePath, {
        ...state,
        reviewerSessionHandle: error.sessionHandle,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'reviewer_plan',
        round,
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

  const synthesizedReview = await synthesizePlanReviewFindings({
    planPath: getPlanReviewTargetPath(state),
    round,
    roundSummary: claude.summary,
    findings: claude.findings.map((finding) => ({
      ...finding,
      source: finding.source,
    })),
  });
  const normalizedFindingInputs = synthesizedReview.findings;

  printReviewResult('plan-review', claude.summary, normalizedFindingInputs, logger);

  let nextCanonicalIndex = getNextCanonicalIndex(state.findings);
  const findings = normalizedFindingInputs.map((finding, index) => {
    const canonicalId = findCanonicalId(state.findings, finding) ?? `C${nextCanonicalIndex++}`;
    return {
      ...finding,
      id: `R${round}-F${index + 1}`,
      canonicalId,
      status: 'open' as const,
      coderDisposition: null,
      coderCommit: null,
    };
  });
  const mergedFindings = [...state.findings, ...findings];
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
  const hasOpenNonBlockingFindings = mergedFindings.some(isOpenNonBlockingFinding);
  const reachedMaxRounds = round >= roundLimit;
  const openBlockingCanonicalCount = countOpenBlockingCanonicals(mergedFindings);
  const stalledBlockingCount = hasRepeatedNonReduction(state.rounds, openBlockingCanonicalCount);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const blockReason = reopenedCanonical
    ? getDerivedPlanBlockedReason(state, `review_stuck: blocking finding ${reopenedCanonical} reopened across multiple reviewer rounds`)
    : stalledBlockingCount
      ? getDerivedPlanBlockedReason(state, `review_stuck: blocking findings did not decrease across ${getReviewStuckWindow()} consecutive reviewer rounds`)
      : reachedMaxRounds && hasBlockingFindings
        ? getDerivedPlanBlockedReason(state, `reached max review rounds (${roundLimit}) with blocking findings still open`)
        : null;

  const nextState = await saveState(statePath, {
    ...state,
    reviewerSessionHandle: claude.sessionHandle,
    executionShape: synthesizedReview.executionShape,
    phase: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'coder_plan_response'
        : hasOpenNonBlockingFindings
          ? 'coder_plan_optional_response'
          : derivedPlanReview
            ? 'awaiting_derived_plan_execution'
            : 'done',
    status: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'running'
        : derivedPlanReview
          ? 'running'
          : 'done',
    rounds: [
      ...state.rounds,
      {
        round,
        reviewerSessionHandle: claude.sessionHandle,
        commitRange: {
          base: state.baseCommit ?? '',
          head: state.finalCommit ?? state.baseCommit ?? '',
        },
        openBlockingCanonicalCount,
        findings: findings.map((finding) => finding.id),
      },
    ],
    findings: mergedFindings,
    derivedPlanStatus:
      derivedPlanReview && !shouldBlockForConvergence && !hasBlockingFindings && !hasOpenNonBlockingFindings
        ? 'accepted'
        : derivedPlanReview && (shouldBlockForConvergence || (hasBlockingFindings && reachedMaxRounds))
          ? 'rejected'
          : state.derivedPlanStatus,
    blockedFromPhase: shouldBlockForConvergence || (hasBlockingFindings && reachedMaxRounds) ? 'reviewer_plan' : null,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'reviewer_plan',
    round,
    sessionHandle: claude.sessionHandle,
    findings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && blockReason) {
    const persistedState = await persistBlockedScope(nextState, statePath, blockReason);
    if (!derivedPlanReview) {
      await notifyBlocked(persistedState, blockReason, logger);
    }
    return flushDerivedPlanNotifications(persistedState, statePath, logger, blockReason);
  }
  if (shouldNotifyDerivedPlanAcceptance(state, nextState)) {
    return flushDerivedPlanNotifications(nextState, statePath, logger);
  }
  if (nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

async function runConsultPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  const consultRound = state.consultRounds.at(-1);
  if (!consultRound || consultRound.response) {
    throw new Error('Cannot run reviewer consult without a pending consult request');
  }

  await logger?.event('phase.start', { phase: 'reviewer_consult', consultRound: consultRound.number });
  let claude;
  try {
    claude = await runConsultReviewerRound({
      reviewer: state.agentConfig.reviewer,
      cwd: state.cwd,
      planDoc: state.planDoc,
      request: consultRound.request,
      consultMarkdownPath: state.consultMarkdownPath,
      logger,
    });
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      const failedState = await saveState(statePath, {
        ...state,
        reviewerSessionHandle: error.sessionHandle,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'reviewer_consult',
        consultRound: consultRound.number,
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

  const nextState = await saveState(statePath, {
    ...state,
    reviewerSessionHandle: claude.sessionHandle,
    phase: 'coder_consult_response',
    status: 'running',
    consultRounds: state.consultRounds.map((round) =>
      round.number === consultRound.number
        ? {
            ...round,
            reviewerSessionHandle: claude.sessionHandle,
            response: claude.response,
          }
        : round,
    ),
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('consult.response', {
    scopeNumber: nextState.currentScopeNumber,
    consultRound: consultRound.number,
    sourcePhase: consultRound.sourcePhase,
    coderSessionHandle: consultRound.coderSessionHandle,
    reviewerSessionHandle: claude.sessionHandle,
    recoverable: claude.response.recoverable,
  });
  await logger?.event('phase.complete', {
    phase: 'reviewer_consult',
    consultRound: consultRound.number,
    nextPhase: nextState.phase,
  });
  return nextState;
}

function isOpenBlockingFinding(finding: ReviewFinding) {
  return finding.status === 'open' && finding.severity === 'blocking';
}

function isOpenNonBlockingFinding(finding: ReviewFinding) {
  return finding.status === 'open' && finding.severity === 'non_blocking';
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCanonicalSignature(finding: Pick<ReviewFinding, 'claim' | 'files'>) {
  const files = [...finding.files].map((file) => file.trim().toLowerCase()).sort().join('|');
  return `${normalizeText(finding.claim)}::${files}`;
}

function findCanonicalId(existingFindings: ReviewFinding[], finding: Pick<ReviewFinding, 'claim' | 'files'>) {
  const signature = getCanonicalSignature(finding);
  return existingFindings.find((item) => getCanonicalSignature(item) === signature)?.canonicalId ?? null;
}

function getNextCanonicalIndex(findings: ReviewFinding[]) {
  const maxSeen = findings.reduce((max, finding) => {
    const match = /^C(\d+)$/.exec(finding.canonicalId);
    if (!match) {
      return max;
    }

    return Math.max(max, Number(match[1]));
  }, 0);

  return maxSeen + 1;
}

function countOpenBlockingCanonicals(findings: ReviewFinding[]) {
  return new Set(findings.filter(isOpenBlockingFinding).map((finding) => finding.canonicalId)).size;
}

function hasRepeatedNonReduction(rounds: OrchestrationState['rounds'], currentCount: number) {
  const counts = [...rounds.map((round) => round.openBlockingCanonicalCount), currentCount];
  const reviewStuckWindow = getReviewStuckWindow();
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

function getReopenedCanonical(findings: ReviewFinding[]) {
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

function mapDecisionToStatus(decision: 'fixed' | 'rejected' | 'deferred'): FindingStatus {
  switch (decision) {
    case 'fixed':
      return 'fixed';
    case 'rejected':
      return 'rejected';
    case 'deferred':
      return 'deferred';
  }
}

function appendCompletedScope(
  state: OrchestrationState,
  result: 'accepted' | 'blocked',
  details: {
    scopeLabel?: string;
    finalCommit: string | null;
    commitSubject: string | null;
    archivedReviewPath: string | null;
    blocker: string | null;
    marker?: ScopeMarker;
    derivedFromParentScope?: string | null;
    replacedByDerivedPlanPath?: string | null;
  },
) {
  const scopeLabel = details.scopeLabel ?? getCurrentScopeLabel(state);
  const marker = details.marker ?? ((state.lastScopeMarker ?? 'AUTONOMY_BLOCKED') as ScopeMarker);
  return [
    ...state.completedScopes.filter((scope) => scope.number !== scopeLabel),
    {
      number: scopeLabel,
      marker,
      result,
      baseCommit: state.baseCommit,
      finalCommit: details.finalCommit,
      commitSubject: details.commitSubject,
      reviewRounds: state.rounds.length,
      findings: state.findings.length,
      archivedReviewPath: details.archivedReviewPath,
      blocker: details.blocker,
      derivedFromParentScope: details.derivedFromParentScope ?? null,
      replacedByDerivedPlanPath: details.replacedByDerivedPlanPath ?? null,
    },
  ];
}

export function adoptAcceptedDerivedPlan(state: OrchestrationState) {
  if (!hasAcceptedDerivedPlan(state) || !state.derivedPlanPath) {
    return state;
  }
  if (state.phase !== 'awaiting_derived_plan_execution') {
    throw new Error(`Cannot adopt derived plan from phase ${state.phase}`);
  }
  if (state.createdCommits.length > 0) {
    throw new Error('Cannot adopt derived plan after derived execution has already created commits');
  }
  if (state.derivedScopeIndex !== null) {
    throw new Error('Cannot adopt derived plan after derived scope execution has already started');
  }

  return {
    ...state,
    phase: 'coder_scope' as const,
    status: 'running' as const,
    derivedScopeIndex: state.derivedScopeIndex ?? 1,
    coderSessionHandle: null,
    coderRetryCount: 0,
    rounds: [],
    consultRounds: [],
    findings: [],
    createdCommits: [],
    blockedFromPhase: null,
  };
}

type FinalSquashNextStateArgs = {
  state: OrchestrationState;
  finalCommit: string;
  completedScopes: OrchestrationState['completedScopes'];
  archivedReviewPath: string | null;
};

export function computeNextScopeStateAfterSquash({
  state,
  finalCommit,
  completedScopes,
  archivedReviewPath,
}: FinalSquashNextStateArgs): OrchestrationState {
  const derivedExecution = isExecutingDerivedPlan(state);
  const derivedPlanCompleted = derivedExecution && state.lastScopeMarker === 'AUTONOMY_DONE';
  const continueScopes = derivedExecution
    ? true
    : state.lastScopeMarker !== 'AUTONOMY_DONE' && state.lastScopeMarker !== 'AUTONOMY_BLOCKED';

  if (derivedExecution && derivedPlanCompleted) {
    return {
      ...state,
      baseCommit: finalCommit,
      finalCommit: null,
      coderSessionHandle: null,
      currentScopeNumber: state.currentScopeNumber + 1,
      lastScopeMarker: null,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      splitPlanCountForCurrentScope: 0,
      rounds: [],
      consultRounds: [],
      findings: [],
      createdCommits: [],
      completedScopes,
      archivedReviewPath: null,
      phase: 'coder_scope',
      status: 'running',
    };
  }

  if (derivedExecution) {
    return {
      ...state,
      baseCommit: finalCommit,
      finalCommit: null,
      coderSessionHandle: null,
      lastScopeMarker: null,
      derivedScopeIndex: (state.derivedScopeIndex ?? 1) + 1,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      rounds: [],
      consultRounds: [],
      findings: [],
      createdCommits: [],
      completedScopes,
      archivedReviewPath: null,
      phase: 'coder_scope',
      status: 'running',
    };
  }

  if (continueScopes) {
    return {
      ...state,
      baseCommit: finalCommit,
      finalCommit: null,
      coderSessionHandle: null,
      currentScopeNumber: state.currentScopeNumber + 1,
      lastScopeMarker: null,
      derivedPlanPath: null,
      derivedFromScopeNumber: null,
      derivedPlanStatus: null,
      derivedScopeIndex: null,
      splitPlanStartedNotified: false,
      derivedPlanAcceptedNotified: false,
      splitPlanBlockedNotified: false,
      splitPlanCountForCurrentScope: 0,
      rounds: [],
      consultRounds: [],
      findings: [],
      createdCommits: [],
      completedScopes,
      archivedReviewPath: null,
      phase: 'coder_scope',
      status: 'running',
    };
  }

  return {
    ...state,
    finalCommit,
    archivedReviewPath,
    completedScopes,
    phase: 'done',
    status: 'done',
  };
}

function buildVerificationHint(state: OrchestrationState) {
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

async function runCoderResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'coder_response' });
  const openFindings = state.findings.filter(isOpenBlockingFinding);
  if (openFindings.length === 0) {
    let nextState = await saveState(statePath, {
      ...state,
      phase: 'done',
      status: 'done',
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('phase.complete', {
      phase: 'coder_response',
      openFindings: 0,
      nextPhase: nextState.phase,
    });
    return nextState;
  }

  const beforeHead = await getHeadCommit(state.cwd);
  let codex;
  try {
    codex = await runCoderResponseRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      verificationHint: buildVerificationHint(state),
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        source: finding.source,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
        files: finding.files,
        roundSummary: finding.roundSummary,
      })),
      sessionHandle: state.coderSessionHandle,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(state, 'coder_optional_response', error)) {
        return scheduleCoderTimeoutRetry(state, statePath, 'coder_optional_response', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, 'coder_optional_response', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const afterHead = await getHeadCommit(state.cwd);
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  const latestCommit = createdCommits.at(-1) ?? null;
  const responseById = new Map(codex.payload.responses.map((response) => [response.id, response]));

  const findings = state.findings.map((finding) => {
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

  const nextState = await saveState(statePath, {
    ...state,
    coderSessionHandle: codex.sessionHandle,
    findings,
    createdCommits: [...state.createdCommits, ...createdCommits],
    phase: codex.payload.outcome === 'blocked' || codex.payload.outcome === 'split_plan' ? 'blocked' : 'reviewer_scope',
    status: codex.payload.outcome === 'blocked' || codex.payload.outcome === 'split_plan' ? 'blocked' : 'running',
    blockedFromPhase: codex.payload.outcome === 'blocked' ? 'coder_response' : null,
    coderRetryCount: 0,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_response',
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
        sourcePhase: 'coder_response',
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
    const blocker = codex.payload.blocker?.trim() || codex.payload.summary.trim() || 'The coder reported a blocker during review response';
    if (shouldConsultBlockedCoder(nextState)) {
      const consultState = await saveState(statePath, {
        ...nextState,
        phase: 'reviewer_consult',
        status: 'running',
        consultRounds: [
          ...nextState.consultRounds,
          buildConsultRequest({
            state: nextState,
            sourcePhase: 'coder_response',
            blocker,
            summary: codex.payload.summary,
            relevantFiles: [...new Set(openFindings.flatMap((finding) => finding.files))],
          }),
        ],
      });
      await writeExecutionArtifacts(consultState);
      const consultRound = consultState.consultRounds.at(-1);
      await logger?.event('consult.start', {
        scopeNumber: consultState.currentScopeNumber,
        consultRound: consultRound?.number,
        sourcePhase: consultRound?.sourcePhase,
        coderSessionHandle: consultRound?.coderSessionHandle,
        blocker: consultRound?.request.blocker,
      });
      return consultState;
    }
    const persistedState = await persistBlockedScope(nextState, statePath, blocker);
    await notifyBlocked(persistedState, blocker, logger);
    return persistedState;
  }
  return nextState;
}

async function runCoderOptionalResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'coder_optional_response' });
  const openFindings = state.findings.filter(isOpenNonBlockingFinding);
  if (openFindings.length === 0) {
    let nextState = await saveState(statePath, {
      ...state,
      phase: 'final_squash',
      status: 'running',
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('phase.complete', {
      phase: 'coder_optional_response',
      openFindings: 0,
      nextPhase: nextState.phase,
    });
    return nextState;
  }

  const beforeHead = await getHeadCommit(state.cwd);
  let codex;
  try {
    codex = await runCoderResponseRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      verificationHint: buildVerificationHint(state),
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        source: finding.source,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
        files: finding.files,
        roundSummary: finding.roundSummary,
      })),
      mode: 'optional',
      sessionHandle: state.coderSessionHandle,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(state, 'coder_response', error)) {
        return scheduleCoderTimeoutRetry(state, statePath, 'coder_response', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, 'coder_response', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const afterHead = await getHeadCommit(state.cwd);
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  const latestCommit = createdCommits.at(-1) ?? null;
  const responseById = new Map(codex.payload.responses.map((response) => [response.id, response]));

  const findings = state.findings.map((finding) => {
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

  const nextState = await saveState(statePath, {
    ...state,
    coderSessionHandle: codex.sessionHandle,
    findings,
    createdCommits: [...state.createdCommits, ...createdCommits],
    phase: codex.payload.outcome === 'blocked' || codex.payload.outcome === 'split_plan' ? 'blocked' : 'final_squash',
    status: codex.payload.outcome === 'blocked' || codex.payload.outcome === 'split_plan' ? 'blocked' : 'running',
    blockedFromPhase: codex.payload.outcome === 'blocked' ? 'coder_optional_response' : null,
    coderRetryCount: 0,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_optional_response',
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
        sourcePhase: 'coder_optional_response',
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
      'The coder reported a blocker while considering non-blocking review findings';
    const persistedState = await persistBlockedScope(nextState, statePath, blocker);
    await notifyBlocked(persistedState, blocker, logger);
    return persistedState;
  }
  return nextState;
}

async function runCoderConsultResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  const consultRound = state.consultRounds.at(-1);
  if (!consultRound || !consultRound.response || consultRound.disposition) {
    throw new Error('Cannot run coder consult response without a completed consult response');
  }

  await logger?.event('phase.start', { phase: 'coder_consult_response', consultRound: consultRound.number });
  const beforeHead = await getHeadCommit(state.cwd);
  let codex;
  try {
    codex = await runCoderConsultResponseRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      consultMarkdownPath: state.consultMarkdownPath,
      request: consultRound.request,
      response: consultRound.response,
      sessionHandle: state.coderSessionHandle,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      const failedState = await persistCoderFailureState(state, statePath, 'coder_consult_response', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const afterHead = await getHeadCommit(state.cwd);
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  const nextPhase = codex.payload.outcome === 'resumed' ? consultRound.sourcePhase : 'blocked';
  const nextState = await saveState(statePath, {
    ...state,
    coderSessionHandle: codex.sessionHandle,
    createdCommits: [...state.createdCommits, ...createdCommits],
    phase: nextPhase,
    status: codex.payload.outcome === 'resumed' ? 'running' : 'blocked',
    blockedFromPhase: codex.payload.outcome === 'resumed' ? null : consultRound.sourcePhase,
    consultRounds: state.consultRounds.map((round) =>
      round.number === consultRound.number
        ? {
            ...round,
            coderSessionHandle: codex.sessionHandle,
            disposition: codex.payload,
          }
        : round,
    ),
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('consult.disposition', {
    scopeNumber: nextState.currentScopeNumber,
    consultRound: consultRound.number,
    sourcePhase: consultRound.sourcePhase,
    coderSessionHandle: codex.sessionHandle,
    outcome: codex.payload.outcome,
  });
  await logger?.event('phase.complete', {
    phase: 'coder_consult_response',
    consultRound: consultRound.number,
    nextPhase,
    createdCommits,
  });
  if (nextState.status === 'blocked') {
    const blocker = codex.payload.blocker?.trim() || codex.payload.summary.trim() || 'The coder remained blocked after reviewer consultation';
    const persistedState = await persistBlockedScope(nextState, statePath, blocker);
    await notifyBlocked(persistedState, blocker, logger);
    return persistedState;
  }
  return nextState;
}

async function runCoderPlanResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.coderSessionHandle) {
    throw new Error('Cannot run coder plan response phase without an existing coder session');
  }

  await logger?.event('phase.start', { phase: 'coder_plan_response' });
  const derivedPlanReview = isDerivedPlanReviewState(state);
  const openFindings = state.findings.filter(isOpenBlockingFinding);
  if (openFindings.length === 0) {
    return finalizePlanReviewResponseWithoutOpenFindings(state, statePath, 'coder_plan_response', derivedPlanReview, logger);
  }

  let codex;
  try {
    codex = await runCoderPlanResponseRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getPlanReviewTargetPath(state),
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        source: finding.source,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
        files: finding.files,
        roundSummary: finding.roundSummary,
      })),
      sessionHandle: state.coderSessionHandle,
      reviewMode: derivedPlanReview ? 'derived-plan' : 'plan',
      parentPlanDoc: derivedPlanReview ? state.planDoc : undefined,
      derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(state, 'coder_plan_optional_response', error)) {
        return scheduleCoderTimeoutRetry(state, statePath, 'coder_plan_optional_response', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, 'coder_plan_optional_response', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const responseById = new Map(codex.payload.responses.map((response) => [response.id, response]));

  const findings = state.findings.map((finding) => {
    const response = responseById.get(finding.id);
    if (!response) {
      return finding;
    }

    return {
      ...finding,
      status: mapDecisionToStatus(response.decision),
      coderDisposition: response.summary,
      coderCommit: null,
    };
  });

  const nextState = await saveState(statePath, {
    ...state,
    coderSessionHandle: codex.sessionHandle,
    findings,
    phase: codex.payload.outcome === 'blocked' ? 'blocked' : 'reviewer_plan',
    status: codex.payload.outcome === 'blocked' ? 'blocked' : 'running',
    derivedPlanStatus: codex.payload.outcome === 'blocked' && derivedPlanReview ? 'rejected' : state.derivedPlanStatus,
    blockedFromPhase: codex.payload.outcome === 'blocked' ? 'coder_plan_response' : null,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_plan_response',
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const blocker = getDerivedPlanBlockedReason(
      state,
      codex.payload.blocker?.trim() || codex.payload.summary.trim() || 'The coder reported a blocker during plan response',
    );
    return finalizeBlockedPlanReviewResponse(nextState, statePath, derivedPlanReview, blocker, logger);
  }
  return nextState;
}

async function runCoderPlanOptionalResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.coderSessionHandle) {
    throw new Error('Cannot run coder plan optional response phase without an existing coder session');
  }

  await logger?.event('phase.start', { phase: 'coder_plan_optional_response' });
  const derivedPlanReview = isDerivedPlanReviewState(state);
  const openFindings = state.findings.filter(isOpenNonBlockingFinding);
  if (openFindings.length === 0) {
    return finalizePlanReviewResponseWithoutOpenFindings(
      state,
      statePath,
      'coder_plan_optional_response',
      derivedPlanReview,
      logger,
    );
  }

  let codex;
  try {
    codex = await runCoderPlanResponseRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getPlanReviewTargetPath(state),
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        source: finding.source,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
        files: finding.files,
        roundSummary: finding.roundSummary,
      })),
      mode: 'optional',
      sessionHandle: state.coderSessionHandle,
      reviewMode: derivedPlanReview ? 'derived-plan' : 'plan',
      parentPlanDoc: derivedPlanReview ? state.planDoc : undefined,
      derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(state, 'coder_plan_response', error)) {
        return scheduleCoderTimeoutRetry(state, statePath, 'coder_plan_response', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, 'coder_plan_response', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const responseById = new Map(codex.payload.responses.map((response) => [response.id, response]));

  const findings = state.findings.map((finding) => {
    const response = responseById.get(finding.id);
    if (!response) {
      return finding;
    }

    return {
      ...finding,
      status: mapDecisionToStatus(response.decision),
      coderDisposition: response.summary,
      coderCommit: null,
    };
  });

  const nextState = await saveState(statePath, {
    ...state,
    coderSessionHandle: codex.sessionHandle,
    findings,
    phase: codex.payload.outcome === 'blocked' ? 'blocked' : derivedPlanReview ? 'awaiting_derived_plan_execution' : 'done',
    status: codex.payload.outcome === 'blocked' ? 'blocked' : derivedPlanReview ? 'running' : 'done',
    derivedPlanStatus:
      codex.payload.outcome === 'blocked' && derivedPlanReview
        ? 'rejected'
        : derivedPlanReview
          ? 'accepted'
          : state.derivedPlanStatus,
    blockedFromPhase: codex.payload.outcome === 'blocked' ? 'coder_plan_optional_response' : null,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_plan_optional_response',
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const blocker = getDerivedPlanBlockedReason(
      state,
      codex.payload.blocker?.trim() ||
        codex.payload.summary.trim() ||
        'The coder reported a blocker while considering non-blocking plan findings',
    );
    return finalizeBlockedPlanReviewResponse(nextState, statePath, derivedPlanReview, blocker, logger);
  }
  if (shouldNotifyDerivedPlanAcceptance(state, nextState)) {
    return flushDerivedPlanNotifications(nextState, statePath, logger);
  }
  if (nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

export async function runFinalSquashPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.baseCommit) {
    throw new Error('Cannot finalize without a baseCommit');
  }

  await logger?.event('phase.start', { phase: 'final_squash' });
  const headCommit = await getHeadCommit(state.cwd);
  const statusOutput = filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(state.cwd));
  if (statusOutput) {
    throw new Error(`Cannot finalize with a dirty worktree:\n${statusOutput}`);
  }

  const commitSubjects = await getCommitSubjects(state.cwd, state.createdCommits);
  const latestCreatedCommit = state.createdCommits.at(-1) ?? null;
  const rawFinalMessage = latestCreatedCommit
    ? await getCommitMessage(state.cwd, latestCreatedCommit)
    : commitSubjects.at(-1)?.replace(/^[a-f0-9]+\s+/, '') || 'Finalize scope work';
  const finalMessage = normalizeFinalCommitMessage(rawFinalMessage);
  const finalSubject = finalMessage.split(/\r?\n/, 1)[0] || 'Finalize scope work';
  const finalCommit =
    state.createdCommits.length > 0
      ? await squashCommits(state.cwd, state.baseCommit, finalMessage)
      : headCommit;

  const archivedReviewPath = join(state.runDir, `REVIEW-${finalCommit}.md`);
  const archivedReviewState = {
    ...state,
    finalCommit,
    archivedReviewPath,
  };
  const derivedExecution = isExecutingDerivedPlan(state);
  const currentScopeLabel = getCurrentScopeLabel(state);
  const subScopeCompletedScopes = appendCompletedScope(state, 'accepted', {
    scopeLabel: currentScopeLabel,
    finalCommit,
    commitSubject: finalSubject,
    archivedReviewPath,
    blocker: null,
    derivedFromParentScope: derivedExecution ? getParentScopeLabel(state) : null,
  });
  // Inside derived execution, AUTONOMY_DONE means "the derived replacement plan is complete",
  // not "the top-level execute plan is complete". In that case final squash rolls the last
  // derived sub-scope up into the parent scope and resumes parent-plan execution.
  const derivedPlanCompleted = derivedExecution && state.lastScopeMarker === 'AUTONOMY_DONE';
  const completedScopes = derivedPlanCompleted
    ? appendCompletedScope(
        {
          ...state,
          completedScopes: subScopeCompletedScopes,
        },
        'accepted',
        {
          scopeLabel: getParentScopeLabel(state),
          finalCommit,
          commitSubject: finalSubject,
          archivedReviewPath,
          blocker: null,
          marker: 'AUTONOMY_SCOPE_DONE',
          replacedByDerivedPlanPath: state.derivedPlanPath,
        },
      )
    : subScopeCompletedScopes;
  const retrospectiveState = {
    ...archivedReviewState,
    completedScopes,
  };
  const nextState = await saveState(
    statePath,
    computeNextScopeStateAfterSquash({
      state,
      finalCommit,
      completedScopes,
      archivedReviewPath,
    }),
  );
  const continueScopes = nextState.phase === 'coder_scope' && nextState.status === 'running';

  await writeFile(archivedReviewPath, renderReviewMarkdown(archivedReviewState), 'utf8');
  await writeCheckpointRetrospective(retrospectiveState, continueScopes ? 'scope_accepted' : 'done');
  if (continueScopes) {
    await writeExecutionArtifacts(nextState);
  } else {
    await writeReviewMarkdown(nextState.reviewMarkdownPath, { ...nextState, finalCommit, archivedReviewPath });
    await writePlanProgressArtifacts(nextState);
  }
  await logger?.event('phase.complete', {
    phase: 'final_squash',
    finalCommit,
    archivedReviewPath,
    continueScopes,
  });
  if (continueScopes) {
    await notifyScopeAccepted(state, finalSubject, logger);
  } else {
    await notifyComplete(nextState, finalSubject, logger);
  }

  return nextState;
}

export async function runOnePass(
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
  options?: {
    shouldStopAfterCurrentScope?: () => boolean;
    onCoderSessionHandle?: (sessionHandle: string | null) => void;
  },
) {
  let currentState = state;

  while (
    currentState.phase === 'coder_plan' ||
    currentState.phase === 'reviewer_plan' ||
    currentState.phase === 'coder_plan_response' ||
    currentState.phase === 'coder_plan_optional_response' ||
    currentState.phase === 'awaiting_derived_plan_execution' ||
    currentState.phase === 'coder_scope' ||
    currentState.phase === 'reviewer_scope' ||
    currentState.phase === 'coder_response' ||
    currentState.phase === 'coder_optional_response' ||
    currentState.phase === 'reviewer_consult' ||
    currentState.phase === 'coder_consult_response' ||
    currentState.phase === 'final_squash'
  ) {
    const stopHeartbeat = startPhaseHeartbeat(currentState.phase, () => currentState, logger);
    try {
    if (currentState.phase === 'coder_plan') {
      currentState = await runCoderPlanPhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'reviewer_plan') {
      currentState = await runPlanReviewPhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'coder_plan_response') {
      currentState = await runCoderPlanResponsePhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'coder_plan_optional_response') {
      currentState = await runCoderPlanOptionalResponsePhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'awaiting_derived_plan_execution') {
      currentState = await saveState(statePath, adoptAcceptedDerivedPlan(currentState));
      await writeExecutionArtifacts(currentState);
      await logger?.event('phase.complete', {
        phase: 'awaiting_derived_plan_execution',
        nextPhase: currentState.phase,
        scopeNumber: getCurrentScopeLabel(currentState),
        planDoc: getExecutionPlanPath(currentState),
      });
      continue;
    }

    if (currentState.phase === 'coder_scope') {
      currentState = await runCoderScopePhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'reviewer_scope') {
      currentState = await runReviewPhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'coder_response') {
      currentState = await runCoderResponsePhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'coder_optional_response') {
      currentState = await runCoderOptionalResponsePhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'reviewer_consult') {
      currentState = await runConsultPhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'coder_consult_response') {
      currentState = await runCoderConsultResponsePhase(currentState, statePath, logger);
      options?.onCoderSessionHandle?.(currentState.coderSessionHandle);
      continue;
    }

    if (currentState.phase === 'final_squash') {
      currentState = await runFinalSquashPhase(currentState, statePath, logger);
      if (currentState.phase === 'coder_scope' && currentState.status === 'running') {
        if (options?.shouldStopAfterCurrentScope?.()) {
          await logger?.event('run.paused_after_scope', {
            currentScopeNumber: currentState.currentScopeNumber,
            phase: currentState.phase,
            status: currentState.status,
          });
          return currentState;
        }
      }
    }
    } finally {
      stopHeartbeat();
    }
  }

  await logger?.event('run.complete', {
    phase: currentState.phase,
    status: currentState.status,
    finalCommit: currentState.finalCommit,
    archivedReviewPath: currentState.archivedReviewPath,
  });
  if (currentState.phase === 'blocked' || currentState.phase === 'done') {
    await writeCheckpointRetrospective(currentState, currentState.phase === 'blocked' ? 'blocked' : 'done');
  }
  return currentState;
}

function shouldResumeAcceptedDerivedPlan(state: OrchestrationState) {
  return (
    state.topLevelMode === 'execute' &&
    hasAcceptedDerivedPlan(state) &&
    state.derivedScopeIndex === null &&
    state.createdCommits.length === 0 &&
    state.phase !== 'awaiting_derived_plan_execution'
  );
}

export async function loadOrInitialize(
  planDoc: string | null,
  cwd: string,
  agentConfig: AgentConfig,
  resumeStatePath?: string,
  topLevelMode: 'plan' | 'execute' = 'execute',
  options?: {
    ignoreLocalChanges?: boolean;
  },
) {
  if (resumeStatePath) {
    let state = await loadState(resumeStatePath);
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(resumeStatePath),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
      resumedFromStatePath: resumeStatePath,
    });
    await logger.event('run.resumed', {
      statePath: resumeStatePath,
      phase: state.phase,
      status: state.status,
      agentConfig: state.agentConfig,
    });

    if (state.status === 'blocked' && state.coderSessionHandle && isResumableBlockedPhase(state.blockedFromPhase)) {
      state = await saveState(resumeStatePath, {
        ...state,
        phase: state.blockedFromPhase,
        status: 'running',
      });
      await logger.event('run.resumed_from_blocked', {
        statePath: resumeStatePath,
        blockedFromPhase: state.blockedFromPhase,
        coderSessionHandle: state.coderSessionHandle,
      });
    } else if (state.status !== 'done' && state.status !== 'running') {
      const previousStatus = state.status;
      state = await saveState(resumeStatePath, {
        ...state,
        status: 'running',
      });
      await logger.event('run.status_normalized_on_resume', {
        statePath: resumeStatePath,
        phase: state.phase,
        previousStatus,
        normalizedStatus: state.status,
      });
    }

    if (shouldResumeAcceptedDerivedPlan(state)) {
      const previousPhase = state.phase;
      const previousStatus = state.status;
      state = await saveState(resumeStatePath, {
        ...state,
        phase: 'awaiting_derived_plan_execution',
        status: 'running',
        blockedFromPhase: null,
      });
      await logger.event('run.promoted_accepted_derived_plan_on_resume', {
        statePath: resumeStatePath,
        previousPhase,
        previousStatus,
        promotedPhase: state.phase,
        derivedPlanPath: state.derivedPlanPath,
        derivedFromScopeNumber: state.derivedFromScopeNumber,
      });
    }

    state = await flushDerivedPlanNotifications(state, resumeStatePath, logger);

    if (
      state.topLevelMode === 'execute' &&
      state.phase === 'coder_scope' &&
      state.baseCommit &&
      state.finalCommit === null &&
      state.createdCommits.length === 0
    ) {
      const headCommit = await getHeadCommit(state.cwd);
      const worktreeStatus = await getWorktreeStatus(state.cwd);
      const createdCommits = await getCommitRange(state.cwd, state.baseCommit, headCommit);

      if (headCommit !== state.baseCommit && createdCommits.length > 0 && worktreeStatus.trim() === '') {
        state = await saveState(resumeStatePath, {
          ...state,
          createdCommits,
          phase: 'reviewer_scope',
          status: 'running',
          coderRetryCount: 0,
        });
        await logger.event('run.recovered_pending_review_on_resume', {
          statePath: resumeStatePath,
          previousPhase: 'coder_scope',
          recoveredPhase: state.phase,
          baseCommit: state.baseCommit,
          headCommit,
          createdCommits,
        });
      }
    }

    return {
      state,
      statePath: resumeStatePath,
      logger,
    };
  }

  if (!planDoc) {
    throw new Error('planDoc is required when initializing a new orchestration');
  }

  if (topLevelMode === 'execute' && !options?.ignoreLocalChanges) {
    const statusOutput = filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(cwd));
    if (statusOutput) {
      throw new Error(
        `Cannot start neal --execute with a dirty worktree:\n${statusOutput}\n\nUse neal --resume for in-progress scope work, or pass --ignore-local-changes to bypass this check.`,
      );
    }
  }

  return initializeOrchestration(planDoc, cwd, agentConfig, topLevelMode);
}
