import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import {
  getInteractiveBlockedRecoveryMaxTurns,
  getMaxReviewRounds,
  getPhaseHeartbeatMs,
  getReviewStuckWindow,
} from './config.js';
import {
  CoderRoundError,
  ReviewerRoundError,
  runBlockedRecoveryCoderRound,
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
import { writeDiagnostic } from './diagnostic.js';
import {
  flushDerivedPlanNotifications,
  notifyBlocked,
  notifyComplete,
  notifyInteractiveBlockedRecovery,
  notifyRetry,
  notifyScopeAccepted,
} from './orchestrator/notifications.js';
import { filterWrapperOwnedWorktreeStatus, persistSplitPlanRecovery } from './orchestrator/split-plan.js';
import {
  adoptAcceptedDerivedPlan,
  appendCompletedScope,
  appendDerivedSubScopeAndParentCompletion,
  computeNextScopeStateAfterSquash,
  shouldNotifyDerivedPlanAcceptance,
  transitionPlanReviewWithoutOpenFindings,
} from './orchestrator/transitions.js';
import { validatePlanDocument } from './plan-validation.js';
import { writePlanProgressArtifacts } from './progress.js';
import { writeCheckpointRetrospective } from './retrospective.js';
import { renderReviewMarkdown, writeReviewMarkdown } from './review.js';
import { getCurrentScopeLabel, getExecutionPlanPath, getParentScopeLabel, hasAcceptedDerivedPlan, isExecutingDerivedPlan } from './scopes.js';
import { createInitialState, getSessionStatePath, loadState, saveState } from './state.js';
import type {
  AgentConfig,
  CoderBlockedRecoveryDisposition,
  CoderConsultRequest,
  FindingStatus,
  InteractiveBlockedRecoveryState,
  OrchestrationState,
  OrchestratorInit,
  ReviewFinding,
  ReviewFindingSource,
  ScopeMarker,
} from './types.js';

const execFile = promisify(execFileCallback);
export { flushDerivedPlanNotifications };
export { adoptAcceptedDerivedPlan, computeNextScopeStateAfterSquash };

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

type PreparedPlanReview = {
  executionShape: OrchestrationState['executionShape'];
  reviewedPlanPath: string;
  originalPlanPath: string;
  validation: ReturnType<typeof validatePlanDocument>;
};

function getNormalizedPlanArtifactPath(state: OrchestrationState, planPath: string) {
  const parsed = parse(planPath);
  const extension = parsed.ext || '.md';
  return join(state.runDir, `${parsed.name}.normalized${extension}`);
}

export async function preparePlanReviewArtifact(args: {
  planPath: string;
  normalizedPlanPath?: string;
}): Promise<PreparedPlanReview> {
  const planDocument = await readFile(args.planPath, 'utf8');
  const validation = validatePlanDocument(planDocument);
  let reviewedPlanPath = args.planPath;

  if (validation.normalization.applied && args.normalizedPlanPath) {
    await mkdir(dirname(args.normalizedPlanPath), { recursive: true });
    await writeFile(args.normalizedPlanPath, validation.normalization.normalizedDocument, 'utf8');
    reviewedPlanPath = args.normalizedPlanPath;
  }

  return {
    executionShape: validation.executionShape,
    reviewedPlanPath,
    originalPlanPath: args.planPath,
    validation,
  };
}

export async function synthesizePlanReviewFindings(args: {
  planPath: string;
  round: number;
  roundSummary: string;
  findings: ReviewFindingInput[];
  preparedReview?: PreparedPlanReview;
}): Promise<{
  executionShape: OrchestrationState['executionShape'];
  reviewedPlanPath: string;
  findings: ReviewFindingInput[];
}> {
  const preparedReview = args.preparedReview ?? (await preparePlanReviewArtifact({ planPath: args.planPath }));
  const { validation } = preparedReview;

  if (validation.ok) {
    return {
      executionShape: validation.executionShape,
      reviewedPlanPath: preparedReview.reviewedPlanPath,
      findings: args.findings,
    };
  }

  return {
    executionShape: validation.executionShape,
    reviewedPlanPath: preparedReview.reviewedPlanPath,
    findings: [
      ...args.findings,
      ...validation.errors.map((error) => ({
        round: args.round,
        source: 'plan_structure' as const,
        severity: 'blocking' as const,
        files: [preparedReview.originalPlanPath],
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
  intervalMs = getPhaseHeartbeatMs(getState().cwd),
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
    | 'coder_consult_response'
    | 'interactive_blocked_recovery',
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
  options?: {
    ignoreLocalChanges?: boolean;
  },
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
    ignoreLocalChanges: options?.ignoreLocalChanges ?? false,
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

export class InteractiveBlockedRecoveryPendingTurnError extends Error {
  readonly pendingTurn: number;

  constructor(pendingTurn: number) {
    super(
      `Interactive blocked recovery already has unhandled operator guidance for turn ${pendingTurn}; resume the run before recording more guidance.`,
    );
    this.name = 'InteractiveBlockedRecoveryPendingTurnError';
    this.pendingTurn = pendingTurn;
  }
}

function getInteractiveBlockedRecoverySourcePhase(
  phase: OrchestrationState['phase'] | null,
): InteractiveBlockedRecoveryState['sourcePhase'] {
  switch (phase) {
    case 'coder_plan':
    case 'reviewer_plan':
    case 'coder_plan_response':
    case 'coder_plan_optional_response':
    case 'awaiting_derived_plan_execution':
    case 'coder_scope':
    case 'reviewer_scope':
    case 'coder_response':
    case 'coder_optional_response':
    case 'reviewer_consult':
    case 'coder_consult_response':
    case 'final_squash':
      return phase;
    default:
      throw new Error(`Interactive blocked recovery does not support source phase: ${String(phase)}`);
  }
}

async function enterInteractiveBlockedRecovery(
  state: OrchestrationState,
  statePath: string,
  reason: string,
  logger?: RunLogger,
) {
  if (state.topLevelMode !== 'execute') {
    throw new Error('Interactive blocked recovery is only supported for execute-mode runs');
  }

  const sourcePhase = getInteractiveBlockedRecoverySourcePhase(state.blockedFromPhase ?? state.phase);
  const nextRecovery: InteractiveBlockedRecoveryState = state.interactiveBlockedRecovery ?? {
    enteredAt: new Date().toISOString(),
    sourcePhase,
    blockedReason: reason,
    // Keep the operator/coder loop short so recovery remains bounded and auditable.
    maxTurns: getInteractiveBlockedRecoveryMaxTurns(state.cwd),
    lastHandledTurn: 0,
    pendingDirective: null,
    turns: [],
  };

  const nextState = await saveState(statePath, {
    ...state,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: state.blockedFromPhase ?? state.phase,
    interactiveBlockedRecovery: {
      ...nextRecovery,
      sourcePhase,
      blockedReason: reason,
    },
  });
  await writeExecutionArtifacts(nextState);
  await logger?.event('interactive_blocked_recovery.entered', {
    scopeNumber: nextState.currentScopeNumber,
    sourcePhase: nextState.interactiveBlockedRecovery?.sourcePhase,
    blockedReason: reason,
  });
  return nextState;
}

export async function recordInteractiveBlockedRecoveryGuidance(
  statePath: string,
  operatorGuidance: string,
  logger?: RunLogger,
) {
  const trimmedGuidance = operatorGuidance.trim();
  if (!trimmedGuidance) {
    throw new Error('Recovery guidance must not be empty');
  }

  const state = await loadState(statePath);
  if (state.phase !== 'interactive_blocked_recovery' || !state.interactiveBlockedRecovery) {
    throw new Error(`Run is not in interactive blocked recovery: ${statePath}`);
  }

  const turns = state.interactiveBlockedRecovery.turns;
  if (state.interactiveBlockedRecovery.pendingDirective) {
    throw new InteractiveBlockedRecoveryPendingTurnError(turns.length + 1);
  }

  const pendingTurn = turns.at(-1);
  if (pendingTurn && pendingTurn.number > state.interactiveBlockedRecovery.lastHandledTurn) {
    throw new InteractiveBlockedRecoveryPendingTurnError(pendingTurn.number);
  }

  if (turns.length >= state.interactiveBlockedRecovery.maxTurns) {
    const nextState = await saveState(statePath, {
      ...state,
      interactiveBlockedRecovery: {
        ...state.interactiveBlockedRecovery,
        pendingDirective: {
          recordedAt: new Date().toISOString(),
          operatorGuidance: trimmedGuidance,
          terminalOnly: true,
        },
      },
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('interactive_blocked_recovery.terminal_directive_recorded', {
      scopeNumber: nextState.currentScopeNumber,
      sourcePhase: nextState.interactiveBlockedRecovery?.sourcePhase,
      recoveryTurn: turns.length,
    });
    return nextState;
  }

  const nextState = await saveState(statePath, {
    ...state,
    interactiveBlockedRecovery: {
      ...state.interactiveBlockedRecovery,
      turns: [
        ...turns,
        {
          number: turns.length + 1,
          recordedAt: new Date().toISOString(),
          operatorGuidance: trimmedGuidance,
          disposition: null,
        },
      ],
    },
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('interactive_blocked_recovery.guidance_recorded', {
    scopeNumber: nextState.currentScopeNumber,
    recoveryTurn: nextState.interactiveBlockedRecovery?.turns.at(-1)?.number,
    sourcePhase: nextState.interactiveBlockedRecovery?.sourcePhase,
  });
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

function hasPendingInteractiveBlockedRecoveryTurn(state: OrchestrationState) {
  if (state.phase !== 'interactive_blocked_recovery' || !state.interactiveBlockedRecovery) {
    return false;
  }

  return (
    state.interactiveBlockedRecovery.turns.length > state.interactiveBlockedRecovery.lastHandledTurn ||
    Boolean(state.interactiveBlockedRecovery.pendingDirective)
  );
}

function withRecordedInteractiveBlockedRecoveryDisposition(
  state: OrchestrationState,
  disposition: CoderBlockedRecoveryDisposition,
  sessionHandle: string | null,
  resultingPhase: OrchestrationState['phase'],
) {
  if (!state.interactiveBlockedRecovery) {
    return state;
  }

  if (state.interactiveBlockedRecovery.pendingDirective) {
    return {
      ...state,
      interactiveBlockedRecovery: {
        ...state.interactiveBlockedRecovery,
        pendingDirective: null,
        turns: [
          ...state.interactiveBlockedRecovery.turns,
          {
            number: state.interactiveBlockedRecovery.turns.length + 1,
            recordedAt: state.interactiveBlockedRecovery.pendingDirective.recordedAt,
            operatorGuidance: state.interactiveBlockedRecovery.pendingDirective.operatorGuidance,
            disposition: {
              recordedAt: new Date().toISOString(),
              sessionHandle,
              action: disposition.action,
              summary: disposition.summary,
              rationale: disposition.rationale,
              blocker: disposition.blocker.trim(),
              replacementPlan: disposition.replacementPlan.trim(),
              resultingPhase,
            },
          },
        ],
      },
    };
  }

  const latestTurn = state.interactiveBlockedRecovery.turns.at(-1);
  if (!latestTurn) {
    return state;
  }

  return {
    ...state,
    interactiveBlockedRecovery: {
      ...state.interactiveBlockedRecovery,
      turns: state.interactiveBlockedRecovery.turns.map((turn) =>
        turn.number === latestTurn.number
          ? {
              ...turn,
              disposition: {
                recordedAt: new Date().toISOString(),
                sessionHandle,
                action: disposition.action,
                summary: disposition.summary,
                rationale: disposition.rationale,
                blocker: disposition.blocker.trim(),
                replacementPlan: disposition.replacementPlan.trim(),
                resultingPhase,
              },
            }
          : turn,
      ),
    },
  };
}

function finalizeInteractiveBlockedRecovery(
  state: OrchestrationState,
  action: CoderBlockedRecoveryDisposition['action'],
  resultPhase: OrchestrationState['phase'],
) {
  if (!state.interactiveBlockedRecovery) {
    return state;
  }

  return {
    ...state,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [
      ...state.interactiveBlockedRecoveryHistory,
      {
        ...state.interactiveBlockedRecovery,
        pendingDirective: null,
        resolvedAt: new Date().toISOString(),
        resolvedByAction: action,
        resultPhase,
      },
    ],
  };
}

async function persistFinalizedInteractiveBlockedRecovery(
  state: OrchestrationState,
  statePath: string,
  disposition: CoderBlockedRecoveryDisposition,
  sessionHandle: string | null,
  resultPhase: OrchestrationState['phase'],
) {
  const nextState = await saveState(
    statePath,
    finalizeInteractiveBlockedRecovery(
      withRecordedInteractiveBlockedRecoveryDisposition(state, disposition, sessionHandle, resultPhase),
      disposition.action,
      resultPhase,
    ),
  );
  await writeExecutionArtifacts(nextState);
  return nextState;
}

function getInteractiveBlockedRecoveryResumePhase(
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'],
): RunnablePhase {
  switch (sourcePhase) {
    case 'reviewer_scope':
      return 'coder_response';
    case 'reviewer_plan':
      return 'coder_plan_response';
    case 'reviewer_consult':
      return 'coder_consult_response';
    case 'awaiting_derived_plan_execution':
      return 'coder_scope';
    default:
      return sourcePhase;
  }
}

function isTerminalDirectivePending(state: OrchestrationState) {
  return (
    state.phase === 'interactive_blocked_recovery' &&
    Boolean(state.interactiveBlockedRecovery?.pendingDirective)
  );
}

export async function applyInteractiveBlockedRecoveryDisposition(
  state: OrchestrationState,
  statePath: string,
  disposition: CoderBlockedRecoveryDisposition,
  sessionHandle: string | null,
  logger?: RunLogger,
) {
  if (state.phase !== 'interactive_blocked_recovery' || !state.interactiveBlockedRecovery) {
    throw new Error(`Run is not in interactive blocked recovery: ${statePath}`);
  }
  if (state.topLevelMode !== 'execute') {
    throw new Error('Interactive blocked recovery is only supported for execute-mode runs');
  }

  const latestTurn = state.interactiveBlockedRecovery.turns.at(-1);
  const terminalDirective = state.interactiveBlockedRecovery.pendingDirective;
  if (!latestTurn && !terminalDirective) {
    throw new Error('Interactive blocked recovery requires recorded operator guidance before a coder response can be applied.');
  }

  if (
    terminalDirective &&
    disposition.action !== 'replace_current_scope' &&
    disposition.action !== 'terminal_block'
  ) {
    throw new Error('Interactive blocked recovery reached its turn cap and now only allows replace_current_scope or terminal_block.');
  }

  const turnNumber = latestTurn?.number ?? state.interactiveBlockedRecovery.turns.length + 1;
  const trimmedBlocker = disposition.blocker.trim();

  await logger?.event('interactive_blocked_recovery.disposition', {
    scopeNumber: state.currentScopeNumber,
    recoveryTurn: turnNumber,
    sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
    action: disposition.action,
    sessionHandle,
  });

  if (disposition.action === 'replace_current_scope') {
    const persistedState = await persistSplitPlanRecovery(
      {
        ...state,
        coderSessionHandle: sessionHandle,
        status: 'running',
        coderRetryCount: 0,
      },
      statePath,
      {
        sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
        derivedPlanMarkdown: disposition.replacementPlan.trim(),
        createdCommits: [],
        logger,
      },
      {
        persistBlockedScope,
        writeExecutionArtifacts,
      },
    );

    const resultPhase = persistedState.phase === 'blocked' ? 'blocked' : 'reviewer_plan';
    return persistFinalizedInteractiveBlockedRecovery(
      {
        ...persistedState,
        interactiveBlockedRecovery: state.interactiveBlockedRecovery,
      },
      statePath,
      disposition,
      sessionHandle,
      resultPhase,
    );
  }

  if (disposition.action === 'resume_current_scope') {
    const resumedPhase = getInteractiveBlockedRecoveryResumePhase(state.interactiveBlockedRecovery.sourcePhase);
    const finalizedState = await persistFinalizedInteractiveBlockedRecovery(
      state,
      statePath,
      disposition,
      sessionHandle,
      resumedPhase,
    );
    const nextState = await saveState(statePath, {
      ...finalizedState,
      coderSessionHandle: sessionHandle,
      phase: resumedPhase,
      status: 'running',
      blockedFromPhase: null,
      coderRetryCount: 0,
    });
    await writeExecutionArtifacts(nextState);
    return nextState;
  }

  if (disposition.action === 'stay_blocked') {
    const recordedState = withRecordedInteractiveBlockedRecoveryDisposition(
      state,
      disposition,
      sessionHandle,
      'interactive_blocked_recovery',
    );
    if (!recordedState.interactiveBlockedRecovery) {
      throw new Error('Interactive blocked recovery state disappeared while recording a stay_blocked disposition.');
    }
    const nextState = await saveState(statePath, {
      ...recordedState,
      coderSessionHandle: sessionHandle,
      phase: 'interactive_blocked_recovery',
      status: 'running',
      blockedFromPhase: state.interactiveBlockedRecovery.sourcePhase,
      interactiveBlockedRecovery: {
        ...recordedState.interactiveBlockedRecovery,
        blockedReason: trimmedBlocker,
        lastHandledTurn: turnNumber,
        pendingDirective: null,
      },
      coderRetryCount: 0,
    });
    await writeExecutionArtifacts(nextState);
    return nextState;
  }

  const finalizedBlockedState = await persistFinalizedInteractiveBlockedRecovery(
    state,
    statePath,
    disposition,
    sessionHandle,
    'blocked',
  );
  const blockedState = await saveState(statePath, {
    ...finalizedBlockedState,
    coderSessionHandle: sessionHandle,
    phase: 'blocked',
    status: 'blocked',
    lastScopeMarker: state.lastScopeMarker ?? 'AUTONOMY_BLOCKED',
    blockedFromPhase: state.interactiveBlockedRecovery.sourcePhase,
    coderRetryCount: 0,
  });
  await writeExecutionArtifacts(blockedState);
  const persistedState = await persistBlockedScope(blockedState, statePath, trimmedBlocker);
  await notifyBlocked(persistedState, trimmedBlocker, logger);
  return flushDerivedPlanNotifications(persistedState, statePath, logger, trimmedBlocker);
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

async function finalizePlanReviewResponseWithoutOpenFindings(
  state: OrchestrationState,
  statePath: string,
  phase: 'coder_plan_response' | 'coder_plan_optional_response',
  derivedPlanReview: boolean,
  logger?: RunLogger,
) {
  let nextState = await saveState(statePath, transitionPlanReviewWithoutOpenFindings(state, derivedPlanReview));
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

export async function finalizeBlockedPlanReviewResponse(
  state: OrchestrationState,
  statePath: string,
  derivedPlanReview: boolean,
  blocker: string,
  logger?: RunLogger,
) {
  if (state.topLevelMode !== 'execute') {
    if (!derivedPlanReview) {
      await notifyBlocked(state, blocker, logger);
    }
    return flushDerivedPlanNotifications(state, statePath, logger, blocker);
  }

  const persistedState = await enterInteractiveBlockedRecovery(state, statePath, blocker, logger);
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
    | 'coder_plan_optional_response'
    | 'interactive_blocked_recovery',
  error: CoderRoundError,
) {
  if (!isCoderTimeoutError(error) || state.coderRetryCount >= 1) {
    return false;
  }

  if (state.topLevelMode === 'execute') {
    return (
      phase === 'coder_scope' ||
      phase === 'coder_response' ||
      phase === 'coder_optional_response' ||
      phase === 'interactive_blocked_recovery'
    );
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
    | 'coder_plan_optional_response'
    | 'interactive_blocked_recovery',
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, reason, logger);
    await notifyInteractiveBlockedRecovery(persistedState, reason, logger);
    return persistedState;
  }
  return nextState;
}

async function runInteractiveBlockedRecoveryPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.interactiveBlockedRecovery) {
    throw new Error('Cannot run interactive blocked recovery without blocked-recovery state');
  }

  const latestTurn = state.interactiveBlockedRecovery.turns.at(-1);
  const pendingDirective = state.interactiveBlockedRecovery.pendingDirective;
  const hasPendingTurn = Boolean(latestTurn && latestTurn.number > state.interactiveBlockedRecovery.lastHandledTurn);
  if (!hasPendingTurn && !pendingDirective) {
    throw new Error('Interactive blocked recovery has no pending operator guidance to process.');
  }

  await logger?.event('phase.start', {
    phase: 'interactive_blocked_recovery',
    recoveryTurn: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number,
    sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
    terminalOnly: Boolean(pendingDirective?.terminalOnly),
  });

  let codex;
  try {
    codex = await runBlockedRecoveryCoderRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      consultMarkdownPath: state.consultMarkdownPath,
      blockedReason: state.interactiveBlockedRecovery.blockedReason,
      operatorGuidance: pendingDirective?.operatorGuidance ?? latestTurn?.operatorGuidance ?? state.interactiveBlockedRecovery.blockedReason,
      maxTurns: state.interactiveBlockedRecovery.maxTurns,
      turnsTaken: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number ?? 0,
      terminalOnly: Boolean(pendingDirective?.terminalOnly),
      sessionHandle: state.coderSessionHandle,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderTimeout(state, 'interactive_blocked_recovery', error)) {
        return scheduleCoderTimeoutRetry(state, statePath, 'interactive_blocked_recovery', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, 'interactive_blocked_recovery', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    codex.payload,
    codex.sessionHandle,
    logger,
  );
  await logger?.event('phase.complete', {
    phase: 'interactive_blocked_recovery',
    recoveryTurn: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number,
    action: codex.payload.action,
    nextPhase: nextState.phase,
  });
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, reason, logger);
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
  const stalledBlockingCount = hasRepeatedNonReduction(state.rounds, openBlockingCanonicalCount, state.cwd);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const blockReason = reopenedCanonical
    ? `review_stuck: blocking finding ${reopenedCanonical} reopened across multiple reviewer rounds`
    : stalledBlockingCount
      ? `review_stuck: blocking findings did not decrease across ${getReviewStuckWindow(state.cwd)} consecutive reviewer rounds`
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
        reviewedPlanPath: getExecutionPlanPath(state),
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, blockReason, logger);
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
  const reviewTargetPath = getPlanReviewTargetPath(state);
  const preparedReview = await preparePlanReviewArtifact({
    planPath: reviewTargetPath,
    normalizedPlanPath: getNormalizedPlanArtifactPath(state, reviewTargetPath),
  });
  let claude;
  try {
    claude = await runPlanReviewerRound({
      reviewer: state.agentConfig.reviewer,
      cwd: state.cwd,
      planDoc: preparedReview.reviewedPlanPath,
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
    planPath: reviewTargetPath,
    round,
    roundSummary: claude.summary,
    findings: claude.findings.map((finding) => ({
      ...finding,
      source: finding.source,
    })),
    preparedReview,
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
  const stalledBlockingCount = hasRepeatedNonReduction(state.rounds, openBlockingCanonicalCount, state.cwd);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const blockReason = reopenedCanonical
    ? getDerivedPlanBlockedReason(state, `review_stuck: blocking finding ${reopenedCanonical} reopened across multiple reviewer rounds`)
    : stalledBlockingCount
      ? getDerivedPlanBlockedReason(state, `review_stuck: blocking findings did not decrease across ${getReviewStuckWindow(state.cwd)} consecutive reviewer rounds`)
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
        reviewedPlanPath: synthesizedReview.reviewedPlanPath,
        normalizationApplied: preparedReview.validation.normalization.applied,
        normalizationOperations: preparedReview.validation.normalization.operations,
        normalizationScopeLabelMappings: preparedReview.validation.normalization.scopeLabelMappings,
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, blockReason, logger);
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

function hasRepeatedNonReduction(rounds: OrchestrationState['rounds'], currentCount: number, cwd: string) {
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, blocker, logger);
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, blocker, logger);
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
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, blocker, logger);
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
    archivedReviewPath,
  });
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

type RunnablePhase = Extract<
  OrchestrationState['phase'],
  | 'coder_plan'
  | 'reviewer_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'awaiting_derived_plan_execution'
  | 'coder_scope'
  | 'reviewer_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'reviewer_consult'
  | 'coder_consult_response'
  | 'interactive_blocked_recovery'
  | 'final_squash'
>;

const RUNNABLE_PHASES = new Set<RunnablePhase>([
  'coder_plan',
  'reviewer_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
  'awaiting_derived_plan_execution',
  'coder_scope',
  'reviewer_scope',
  'coder_response',
  'coder_optional_response',
  'reviewer_consult',
  'coder_consult_response',
  'interactive_blocked_recovery',
  'final_squash',
]);

function isRunnablePhase(phase: OrchestrationState['phase']): phase is RunnablePhase {
  return RUNNABLE_PHASES.has(phase as RunnablePhase);
}

export async function runOnePass(
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
  options?: {
    shouldStopAfterCurrentScope?: () => boolean;
    onCoderSessionHandle?: (sessionHandle: string | null) => void;
    onDisplayState?: (state: OrchestrationState, phaseStartedAt: number) => void | Promise<void>;
  },
) {
  let currentState = state;

  while (
    isRunnablePhase(currentState.phase) &&
    (currentState.phase !== 'interactive_blocked_recovery' || hasPendingInteractiveBlockedRecoveryTurn(currentState))
  ) {
    const phaseStartedAt = Date.now();
    await options?.onDisplayState?.(currentState, phaseStartedAt);
    const stopHeartbeat = startPhaseHeartbeat(currentState.phase, () => currentState, logger);
    try {
      const currentPhase = currentState.phase;
      const phaseHandlers: Record<RunnablePhase, () => Promise<OrchestrationState>> = {
        coder_plan: async () => {
          const nextState = await runCoderPlanPhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        reviewer_plan: async () => runPlanReviewPhase(currentState, statePath, logger),
        coder_plan_response: async () => {
          const nextState = await runCoderPlanResponsePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        coder_plan_optional_response: async () => {
          const nextState = await runCoderPlanOptionalResponsePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        awaiting_derived_plan_execution: async () => {
          const nextState = await saveState(statePath, adoptAcceptedDerivedPlan(currentState));
          await writeExecutionArtifacts(nextState);
          await logger?.event('phase.complete', {
            phase: 'awaiting_derived_plan_execution',
            nextPhase: nextState.phase,
            scopeNumber: getCurrentScopeLabel(nextState),
            planDoc: getExecutionPlanPath(nextState),
          });
          return nextState;
        },
        coder_scope: async () => {
          const nextState = await runCoderScopePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        reviewer_scope: async () => runReviewPhase(currentState, statePath, logger),
        coder_response: async () => {
          const nextState = await runCoderResponsePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        coder_optional_response: async () => {
          const nextState = await runCoderOptionalResponsePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        reviewer_consult: async () => runConsultPhase(currentState, statePath, logger),
        coder_consult_response: async () => {
          const nextState = await runCoderConsultResponsePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        interactive_blocked_recovery: async () => {
          const nextState = await runInteractiveBlockedRecoveryPhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        final_squash: async () => runFinalSquashPhase(currentState, statePath, logger),
      };

      currentState = await phaseHandlers[currentPhase]();
      await options?.onDisplayState?.(currentState, Date.now());

      if (
        currentPhase === 'final_squash' &&
        currentState.phase === 'coder_scope' &&
        currentState.status === 'running' &&
        options?.shouldStopAfterCurrentScope?.()
      ) {
        await logger?.event('run.paused_after_scope', {
          currentScopeNumber: currentState.currentScopeNumber,
          phase: currentState.phase,
          status: currentState.status,
        });
        return currentState;
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

    if (state.phase === 'interactive_blocked_recovery' && state.interactiveBlockedRecovery) {
      await logger.event('run.resumed_interactive_blocked_recovery', {
        statePath: resumeStatePath,
        sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
        blockedReason: state.interactiveBlockedRecovery.blockedReason,
        recordedTurns: state.interactiveBlockedRecovery.turns.length,
        lastHandledTurn: state.interactiveBlockedRecovery.lastHandledTurn,
      });
    }

    await writeExecutionArtifacts(state);

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

  return initializeOrchestration(planDoc, cwd, agentConfig, topLevelMode, options);
}
