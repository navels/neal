import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import {
  getFinalCompletionContinueExecutionMax,
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
  runCoderFinalCompletionSummaryRound,
  runDiagnosticAnalysisRound,
  runRecoveryPlanRound,
  runCoderScopeRound,
  runCoderPlanResponseRound,
  runCoderPlanRound,
  runCoderResponseRound,
  runConsultReviewerRound,
  runPlanReviewerRound,
  runReviewerFinalCompletionRound,
  runReviewerRound,
} from './agents.js';
import { writeConsultMarkdown } from './consult.js';
import { buildFinalCompletionPacket } from './final-completion.js';
import { getFinalCompletionReviewArtifactPath, writeFinalCompletionReviewMarkdown } from './final-completion-review.js';
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
import {
  getCurrentScopeLabel,
  getExecutionPlanPath,
  getParentScopeLabel,
  hasAcceptedDerivedPlan,
  isExecutingDerivedPlan,
  renderRecentAcceptedScopesSummary,
} from './scopes.js';
import { createInitialState, getSessionStatePath, loadState, saveState } from './state.js';
import type {
  AgentConfig,
  CoderBlockedRecoveryDisposition,
  CoderConsultRequest,
  DiagnosticRecoveryBaselineSource,
  DiagnosticRecoveryDecision,
  DiagnosticRecoveryState,
  FinalCompletionReviewerAction,
  FindingStatus,
  InteractiveBlockedRecoveryState,
  OrchestrationState,
  OrchestratorInit,
  ReviewFinding,
  ReviewFindingSource,
  ReviewerMeaningfulProgressAction,
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
    // Blocking findings take precedence over a non-accept meaningful-progress verdict
    // until the normal review loop has converged or exhausted its round budget.
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
    | 'diagnostic_recovery_analyze'
    | 'diagnostic_recovery_author_plan'
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

function getDiagnosticAnalysisCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED') {
    return null;
  }

  return marker === 'AUTONOMY_DONE'
    ? null
    : 'Diagnostic analysis must end with AUTONOMY_DONE or AUTONOMY_BLOCKED.';
}

function getRecoveryPlanCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED') {
    return null;
  }

  return marker === 'AUTONOMY_DONE'
    ? null
    : 'Diagnostic recovery plan authoring must end with AUTONOMY_DONE or AUTONOMY_BLOCKED.';
}

async function writeExecutionArtifacts(state: OrchestrationState) {
  await writeReviewMarkdown(state.reviewMarkdownPath, state);
  await writeConsultMarkdown(state.consultMarkdownPath, state);
  await writePlanProgressArtifacts(state);
  if (state.topLevelMode === 'execute' && (state.finalCompletionSummary || state.finalCompletionReviewVerdict)) {
    await writeFinalCompletionReviewMarkdown(getFinalCompletionReviewArtifactPath(state.runDir), state);
  }
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
    runDir?: string;
  },
) {
  const absolutePlanDoc = resolve(planDoc);
  const stateDir = join(cwd, '.neal');
  const logger = await createRunLogger({
    cwd,
    stateDir,
    planDoc: absolutePlanDoc,
    topLevelMode,
    runDir: options?.runDir,
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
    case 'final_completion_review':
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

function isPausedExecuteRun(state: OrchestrationState) {
  return (
    state.topLevelMode === 'execute' &&
    state.phase === 'coder_scope' &&
    state.status === 'running' &&
    state.completedScopes.length > 0 &&
    state.createdCommits.length === 0 &&
    state.rounds.length === 0 &&
    state.findings.length === 0 &&
    state.consultRounds.length === 0 &&
    state.coderSessionHandle === null &&
    state.reviewerSessionHandle === null
  );
}

function getDiagnosticRecoveryBlockedReason(state: OrchestrationState) {
  if (state.phase === 'interactive_blocked_recovery') {
    return state.interactiveBlockedRecovery?.blockedReason ?? null;
  }

  if (state.phase === 'blocked') {
    return state.completedScopes.find((scope) => scope.number === getCurrentScopeLabel(state))?.blocker ?? null;
  }

  return null;
}

async function getNextDiagnosticRecoverySequence(runDir: string) {
  const entries = await readdir(runDir).catch(() => []);
  let maxSequence = 0;
  for (const entry of entries) {
    const match = /^DIAGNOSTIC_RECOVERY_(\d+)_(?:ANALYSIS|PLAN)\.md$/.exec(entry);
    if (!match) {
      continue;
    }
    maxSequence = Math.max(maxSequence, Number(match[1]));
  }
  return maxSequence + 1;
}

function resolveDiagnosticRecoveryBaseline(state: OrchestrationState, requestedBaselineRef: string | null): {
  effectiveBaselineRef: string | null;
  effectiveBaselineSource: DiagnosticRecoveryBaselineSource;
} {
  if (requestedBaselineRef) {
    return {
      effectiveBaselineRef: requestedBaselineRef,
      effectiveBaselineSource: 'explicit',
    };
  }

  const parentScopeLabel = getParentScopeLabel(state);
  const activeParentBaseCommit =
    state.completedScopes.find((scope) => scope.number === parentScopeLabel && scope.baseCommit)?.baseCommit ??
    state.completedScopes.find((scope) => scope.derivedFromParentScope === parentScopeLabel && scope.baseCommit)?.baseCommit ??
    state.baseCommit;

  if (activeParentBaseCommit) {
    return {
      effectiveBaselineRef: activeParentBaseCommit,
      effectiveBaselineSource: 'active_parent_base_commit',
    };
  }

  return {
    effectiveBaselineRef: state.initialBaseCommit,
    effectiveBaselineSource: 'run_base_commit',
  };
}

function getResolvedDiagnosticRecoveryPlanPath(state: OrchestrationState) {
  return state.rounds.at(-1)?.reviewedPlanPath ?? state.diagnosticRecovery?.recoveryPlanPath ?? null;
}

function getAdoptableDiagnosticRecoveryPlanPath(state: OrchestrationState) {
  const latestRound = state.rounds.at(-1);
  const reviewedPlanPath = latestRound?.reviewedPlanPath ?? null;

  if (!reviewedPlanPath) {
    throw new Error('Cannot adopt diagnostic recovery without a reviewed recovery plan artifact');
  }

  if ((latestRound?.openBlockingCanonicalCount ?? 0) > 0) {
    throw new Error('Cannot adopt diagnostic recovery while recovery-plan review still has open blocking findings');
  }

  const hasOpenBlockingFindings = state.findings.some(
    (finding) => finding.severity === 'blocking' && finding.status === 'open',
  );
  if (hasOpenBlockingFindings) {
    throw new Error('Cannot adopt diagnostic recovery while recovery-plan review still has open blocking findings');
  }

  return reviewedPlanPath;
}

type StartDiagnosticRecoveryArgs = {
  question: string;
  target: string;
  baselineRef?: string | null;
};

export async function startDiagnosticRecovery(
  statePath: string,
  args: StartDiagnosticRecoveryArgs,
  logger?: RunLogger,
) {
  const question = args.question.trim();
  const target = args.target.trim();
  const requestedBaselineRef = args.baselineRef?.trim() ? args.baselineRef.trim() : null;

  if (!question) {
    throw new Error('Diagnostic recovery requires a non-empty diagnostic question');
  }
  if (!target) {
    throw new Error('Diagnostic recovery requires a non-empty diagnostic target');
  }

  const state = await loadState(statePath);
  if (state.topLevelMode !== 'execute') {
    throw new Error('--diagnose is only supported for execute-mode runs');
  }
  if (state.diagnosticRecovery) {
    throw new Error(`Diagnostic recovery is already active for this run: ${statePath}`);
  }

  const allowedSourcePhase =
    state.phase === 'blocked' || state.phase === 'interactive_blocked_recovery' || isPausedExecuteRun(state);
  if (!allowedSourcePhase) {
    throw new Error(
      'Diagnostic recovery may start only from a paused execute scope, a blocked run, or interactive blocked recovery.',
    );
  }

  const sequence = await getNextDiagnosticRecoverySequence(state.runDir);
  const { effectiveBaselineRef, effectiveBaselineSource } = resolveDiagnosticRecoveryBaseline(state, requestedBaselineRef);
  const diagnosticRecovery: DiagnosticRecoveryState = {
    sequence,
    startedAt: new Date().toISOString(),
    sourcePhase: state.phase === 'blocked' || state.phase === 'interactive_blocked_recovery' ? state.phase : 'coder_scope',
    resumePhase: state.phase === 'blocked' ? state.blockedFromPhase : state.phase,
    parentScopeLabel: getParentScopeLabel(state),
    blockedReason: getDiagnosticRecoveryBlockedReason(state),
    question,
    target,
    requestedBaselineRef,
    effectiveBaselineRef,
    effectiveBaselineSource,
    analysisArtifactPath: join(state.runDir, `DIAGNOSTIC_RECOVERY_${sequence}_ANALYSIS.md`),
    recoveryPlanPath: join(state.runDir, `DIAGNOSTIC_RECOVERY_${sequence}_PLAN.md`),
  };

  const nextState = await saveState(statePath, {
    ...state,
    phase: 'diagnostic_recovery_analyze',
    status: 'running',
    blockedFromPhase: state.phase === 'blocked' ? state.blockedFromPhase : state.phase,
    coderSessionHandle: null,
    reviewerSessionHandle: null,
    coderRetryCount: 0,
    diagnosticRecovery,
  });
  await writeExecutionArtifacts(nextState);
  await logger?.event('diagnostic_recovery.started', {
    statePath,
    scopeNumber: getCurrentScopeLabel(nextState),
    sourcePhase: diagnosticRecovery.sourcePhase,
    resumePhase: diagnosticRecovery.resumePhase,
    parentScopeLabel: diagnosticRecovery.parentScopeLabel,
    effectiveBaselineRef: diagnosticRecovery.effectiveBaselineRef,
    effectiveBaselineSource: diagnosticRecovery.effectiveBaselineSource,
    analysisArtifactPath: diagnosticRecovery.analysisArtifactPath,
    recoveryPlanPath: diagnosticRecovery.recoveryPlanPath,
  });
  return nextState;
}

function finalizeDiagnosticRecoveryRecord(
  state: OrchestrationState,
  decision: DiagnosticRecoveryDecision,
  rationale: string | null,
  resultPhase: OrchestrationState['phase'],
  adoptedPlanPath: string | null,
  reviewArtifactPath: string | null,
) {
  if (!state.diagnosticRecovery) {
    throw new Error('Cannot finalize diagnostic recovery without active diagnostic-recovery state');
  }

  return {
    ...state.diagnosticRecovery,
    resolvedAt: new Date().toISOString(),
    decision,
    rationale,
    resultPhase,
    adoptedPlanPath,
    reviewArtifactPath,
    reviewRoundCount: state.rounds.length,
    reviewFindingCount: state.findings.length,
  };
}

async function archiveDiagnosticRecoveryReviewState(state: OrchestrationState) {
  if (!state.diagnosticRecovery) {
    return null;
  }

  const reviewArtifactPath = join(state.runDir, `DIAGNOSTIC_RECOVERY_${state.diagnosticRecovery.sequence}_REVIEW.md`);
  await writeFile(reviewArtifactPath, renderReviewMarkdown(state), 'utf8');
  return reviewArtifactPath;
}

function getDiagnosticRecoveryResolutionState(
  state: OrchestrationState,
  decision: Exclude<DiagnosticRecoveryDecision, 'adopt_recovery_plan'>,
) {
  const recovery = state.diagnosticRecovery;
  if (!recovery) {
    throw new Error('Cannot resolve diagnostic recovery without active diagnostic-recovery state');
  }

  if (recovery.sourcePhase === 'interactive_blocked_recovery') {
    return {
      phase: 'interactive_blocked_recovery' as const,
      status: 'running' as const,
      blockedFromPhase: state.interactiveBlockedRecovery?.sourcePhase ?? recovery.resumePhase,
    };
  }

  if (recovery.sourcePhase === 'blocked') {
    return {
      phase: 'blocked' as const,
      status: 'blocked' as const,
      blockedFromPhase: recovery.resumePhase,
    };
  }

  return {
    phase: recovery.resumePhase ?? 'coder_scope',
    status: 'running' as const,
    blockedFromPhase: null,
  };
}

function canResolveDiagnosticRecoveryFromState(
  state: OrchestrationState,
  decision: DiagnosticRecoveryDecision,
) {
  if (!state.diagnosticRecovery) {
    return false;
  }

  if (state.phase === 'diagnostic_recovery_adopt') {
    return true;
  }

  if (decision === 'adopt_recovery_plan') {
    return false;
  }

  return (
    state.phase === 'blocked' &&
    (state.blockedFromPhase === 'diagnostic_recovery_analyze' ||
      state.blockedFromPhase === 'diagnostic_recovery_author_plan' ||
      state.blockedFromPhase === 'diagnostic_recovery_review')
  );
}

export async function resolveDiagnosticRecovery(
  statePath: string,
  args: {
    decision: DiagnosticRecoveryDecision;
    rationale?: string | null;
  },
  logger?: RunLogger,
) {
  const state = await loadState(statePath);
  if (state.topLevelMode !== 'execute') {
    throw new Error('Diagnostic recovery resolution is only supported for execute-mode runs');
  }
  if (!canResolveDiagnosticRecoveryFromState(state, args.decision)) {
    throw new Error(`Run is not awaiting a diagnostic recovery decision: ${statePath}`);
  }
  const diagnosticRecovery = state.diagnosticRecovery;
  if (!diagnosticRecovery) {
    throw new Error(`Run is not awaiting a diagnostic recovery decision: ${statePath}`);
  }

  const rationale = args.rationale?.trim() ? args.rationale.trim() : null;
  const resolvedPlanPath =
    args.decision === 'adopt_recovery_plan' ? getAdoptableDiagnosticRecoveryPlanPath(state) : getResolvedDiagnosticRecoveryPlanPath(state);
  const parentScopeNumber = Number.parseInt(diagnosticRecovery.parentScopeLabel, 10);
  const nextDerivedFromScopeNumber = Number.isFinite(parentScopeNumber) ? parentScopeNumber : state.currentScopeNumber;
  const reviewArtifactPath = await archiveDiagnosticRecoveryReviewState(state);
  const restoredState = args.decision === 'adopt_recovery_plan' ? null : getDiagnosticRecoveryResolutionState(state, args.decision);

  const baseState = {
    ...state,
    diagnosticRecovery: null,
    diagnosticRecoveryHistory: [
      ...state.diagnosticRecoveryHistory,
      finalizeDiagnosticRecoveryRecord(
        state,
        args.decision,
        rationale,
        args.decision === 'adopt_recovery_plan' ? 'awaiting_derived_plan_execution' : restoredState!.phase,
        args.decision === 'adopt_recovery_plan' ? resolvedPlanPath : null,
        reviewArtifactPath,
      ),
    ],
  };

  const nextState =
    args.decision === 'adopt_recovery_plan'
      ? await saveState(statePath, {
          ...baseState,
          phase: 'awaiting_derived_plan_execution',
          status: 'running',
          blockedFromPhase: null,
          coderSessionHandle: null,
          reviewerSessionHandle: null,
          coderRetryCount: 0,
          lastScopeMarker: null,
          currentScopeProgressJustification: null,
          currentScopeMeaningfulProgressVerdict: null,
          derivedPlanPath: resolvedPlanPath,
          derivedPlanStatus: 'accepted',
          derivedFromScopeNumber: nextDerivedFromScopeNumber,
          derivedScopeIndex: null,
          interactiveBlockedRecovery: null,
          splitPlanStartedNotified: false,
          derivedPlanAcceptedNotified: false,
          splitPlanBlockedNotified: false,
          splitPlanCountForCurrentScope: 0,
          derivedPlanDepth: 0,
          createdCommits: [],
        })
      : await saveState(statePath, {
          ...baseState,
          phase: restoredState!.phase,
          status: restoredState!.status,
          blockedFromPhase: restoredState!.blockedFromPhase,
          coderSessionHandle: null,
          reviewerSessionHandle: null,
          coderRetryCount: 0,
          lastScopeMarker: restoredState!.phase === 'blocked' ? state.lastScopeMarker ?? 'AUTONOMY_BLOCKED' : null,
          currentScopeProgressJustification: null,
          currentScopeMeaningfulProgressVerdict: null,
          rounds: [],
          findings: [],
          consultRounds: [],
        });

  await writeExecutionArtifacts(nextState);
  await logger?.event('diagnostic_recovery.resolved', {
    statePath,
    decision: args.decision,
    resultPhase: nextState.phase,
    adoptedPlanPath: args.decision === 'adopt_recovery_plan' ? resolvedPlanPath : null,
    parentScopeLabel: diagnosticRecovery.parentScopeLabel,
  });
  return nextState;
}

function isResumableBlockedPhase(
  phase: OrchestrationState['phase'] | null,
): phase is
  | 'coder_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'coder_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'diagnostic_recovery_analyze'
  | 'diagnostic_recovery_author_plan' {
  return (
    phase === 'coder_scope' ||
    phase === 'coder_response' ||
    phase === 'coder_optional_response' ||
    phase === 'coder_plan' ||
    phase === 'coder_plan_response' ||
    phase === 'coder_plan_optional_response' ||
    phase === 'diagnostic_recovery_analyze' ||
    phase === 'diagnostic_recovery_author_plan'
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

function isDiagnosticRecoveryPlanReviewState(state: OrchestrationState) {
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

function getPlanReviewMode(state: OrchestrationState) {
  if (isDerivedPlanReviewState(state)) {
    return 'derived-plan' as const;
  }

  if (isDiagnosticRecoveryPlanReviewState(state)) {
    return 'recovery-plan' as const;
  }

  return 'plan' as const;
}

function getPlanReviewTargetPath(state: OrchestrationState) {
  if (isDerivedPlanReviewState(state) && state.derivedPlanPath) {
    return state.derivedPlanPath;
  }

  if (isDiagnosticRecoveryPlanReviewState(state) && state.diagnosticRecovery?.recoveryPlanPath) {
    return state.diagnosticRecovery.recoveryPlanPath;
  }

  return state.planDoc;
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
  const reviewMode = getPlanReviewMode(state);
  let nextState = await saveState(statePath, transitionPlanReviewWithoutOpenFindings(state, reviewMode));
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
  const diagnosticRecoveryPlanReview = isDiagnosticRecoveryPlanReviewState(state);
  if (state.topLevelMode !== 'execute') {
    if (!derivedPlanReview) {
      await notifyBlocked(state, blocker, logger);
    }
    return flushDerivedPlanNotifications(state, statePath, logger, blocker);
  }

  if (diagnosticRecoveryPlanReview) {
    const nextState = await saveState(statePath, {
      ...state,
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'diagnostic_recovery_review',
    });
    await writeExecutionArtifacts(nextState);
    await notifyBlocked(nextState, blocker, logger);
    return flushDerivedPlanNotifications(nextState, statePath, logger, blocker);
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
    | 'diagnostic_recovery_analyze'
    | 'diagnostic_recovery_author_plan'
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
      phase === 'diagnostic_recovery_analyze' ||
      phase === 'diagnostic_recovery_author_plan' ||
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
    | 'diagnostic_recovery_analyze'
    | 'diagnostic_recovery_author_plan'
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
  if (!state.baseCommit) {
    throw new Error('Cannot run coder scope phase without baseCommit');
  }

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
  const changedFilesSinceBase = await getChangedFilesForRange(state.cwd, state.baseCommit, afterHead);
  const completionProblem = getScopeCompletionProblem(codex.marker);
  const splitPlan = isSplitPlanMarker(codex.marker);
  const verificationOnlyCompletion =
    codex.marker === 'AUTONOMY_DONE' &&
    createdCommits.length === 0 &&
    changedFilesSinceBase.length === 0;

  const nextState = await saveState(statePath, {
    ...workingState,
    coderSessionHandle: codex.sessionHandle,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    currentScopeProgressJustification: codex.progressJustification,
    phase:
      codex.marker === 'AUTONOMY_BLOCKED' || splitPlan || completionProblem
        ? 'blocked'
        : verificationOnlyCompletion
          ? 'final_squash'
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
            summary: codex.responseWithoutProgressPayload.replace(/\s*AUTONOMY_BLOCKED\s*$/m, '').trim(),
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

async function runDiagnosticRecoveryAnalyzePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.diagnosticRecovery) {
    throw new Error('Cannot run diagnostic recovery analysis without diagnostic-recovery state');
  }

  await logger?.event('phase.start', {
    phase: 'diagnostic_recovery_analyze',
    sequence: state.diagnosticRecovery.sequence,
    analysisArtifactPath: state.diagnosticRecovery.analysisArtifactPath,
  });

  let workingState = state;
  let codex;
  try {
    codex = await runDiagnosticAnalysisRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: state.planDoc,
      progressMarkdownPath: state.progressMarkdownPath,
      question: state.diagnosticRecovery.question,
      target: state.diagnosticRecovery.target,
      analysisArtifactPath: state.diagnosticRecovery.analysisArtifactPath,
      baselineRef: state.diagnosticRecovery.effectiveBaselineRef,
      baselineSource: state.diagnosticRecovery.effectiveBaselineSource,
      blockedReason: state.diagnosticRecovery.blockedReason,
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
      if (shouldRetryCoderTimeout(workingState, 'diagnostic_recovery_analyze', error)) {
        return scheduleCoderTimeoutRetry(workingState, statePath, 'diagnostic_recovery_analyze', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? workingState.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(workingState, statePath, 'diagnostic_recovery_analyze', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }

  const completionProblem = getDiagnosticAnalysisCompletionProblem(codex.marker);
  if (codex.marker === 'AUTONOMY_DONE' && !completionProblem && codex.artifactBody.length === 0) {
    throw new Error('Diagnostic recovery analysis returned an empty artifact body.');
  }

  if (!completionProblem && codex.marker === 'AUTONOMY_DONE') {
    await mkdir(dirname(state.diagnosticRecovery.analysisArtifactPath), { recursive: true });
    await writeFile(state.diagnosticRecovery.analysisArtifactPath, `${codex.artifactBody}\n`, 'utf8');
  }

  const completed = codex.marker === 'AUTONOMY_DONE' && !completionProblem;
  const nextState = await saveState(statePath, {
    ...workingState,
    coderSessionHandle: codex.sessionHandle,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    phase: completed ? 'diagnostic_recovery_author_plan' : 'blocked',
    status: completed ? 'running' : 'blocked',
    blockedFromPhase: completed ? null : 'diagnostic_recovery_analyze',
    coderRetryCount: 0,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'diagnostic_recovery_analyze',
    marker: codex.marker,
    sessionHandle: codex.sessionHandle,
    nextPhase: nextState.phase,
    analysisArtifactPath: state.diagnosticRecovery.analysisArtifactPath,
  });
  if (!completed) {
    const reason = completionProblem ?? 'The coder reported a blocker during diagnostic analysis';
    await notifyBlocked(nextState, reason, logger);
  }
  return nextState;
}

async function runDiagnosticRecoveryAuthorPlanPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.diagnosticRecovery) {
    throw new Error('Cannot run diagnostic recovery plan authoring without diagnostic-recovery state');
  }

  await logger?.event('phase.start', {
    phase: 'diagnostic_recovery_author_plan',
    sequence: state.diagnosticRecovery.sequence,
    analysisArtifactPath: state.diagnosticRecovery.analysisArtifactPath,
    recoveryPlanPath: state.diagnosticRecovery.recoveryPlanPath,
  });

  let workingState = state;
  let codex;
  try {
    codex = await runRecoveryPlanRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: state.planDoc,
      progressMarkdownPath: state.progressMarkdownPath,
      question: state.diagnosticRecovery.question,
      target: state.diagnosticRecovery.target,
      analysisArtifactPath: state.diagnosticRecovery.analysisArtifactPath,
      recoveryPlanPath: state.diagnosticRecovery.recoveryPlanPath,
      baselineRef: state.diagnosticRecovery.effectiveBaselineRef,
      baselineSource: state.diagnosticRecovery.effectiveBaselineSource,
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
      if (shouldRetryCoderTimeout(workingState, 'diagnostic_recovery_author_plan', error)) {
        return scheduleCoderTimeoutRetry(workingState, statePath, 'diagnostic_recovery_author_plan', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoderResume(error.sessionHandle ?? workingState.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(workingState, statePath, 'diagnostic_recovery_author_plan', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }

  const completionProblem = getRecoveryPlanCompletionProblem(codex.marker);
  if (codex.marker === 'AUTONOMY_DONE' && !completionProblem && codex.artifactBody.length === 0) {
    throw new Error('Diagnostic recovery plan authoring returned an empty artifact body.');
  }

  if (!completionProblem && codex.marker === 'AUTONOMY_DONE') {
    await mkdir(dirname(state.diagnosticRecovery.recoveryPlanPath), { recursive: true });
    await writeFile(state.diagnosticRecovery.recoveryPlanPath, `${codex.artifactBody}\n`, 'utf8');
  }

  const completed = codex.marker === 'AUTONOMY_DONE' && !completionProblem;
  const nextState = await saveState(statePath, {
    ...workingState,
    coderSessionHandle: codex.sessionHandle,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    phase: completed ? 'diagnostic_recovery_review' : 'blocked',
    status: completed ? 'running' : 'blocked',
    blockedFromPhase: completed ? null : 'diagnostic_recovery_author_plan',
    coderRetryCount: 0,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'diagnostic_recovery_author_plan',
    marker: codex.marker,
    sessionHandle: codex.sessionHandle,
    nextPhase: nextState.phase,
    recoveryPlanPath: state.diagnosticRecovery.recoveryPlanPath,
  });
  if (!completed) {
    const reason = completionProblem ?? 'The coder reported a blocker during recovery plan authoring';
    await notifyBlocked(nextState, reason, logger);
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
  if (!state.currentScopeProgressJustification) {
    throw new Error('Cannot run execute reviewer round without a coder progress justification');
  }

  await logger?.event('phase.start', { phase: 'reviewer_scope', round: state.rounds.length + 1 });
  const headCommit = await getHeadCommit(state.cwd);
  const round = state.rounds.length + 1;
  const parentScopeLabel = getParentScopeLabel(state);
  const previousHeadCommit = state.rounds.at(-1)?.commitRange.head ?? null;
  const commits = await getCommitRange(state.cwd, state.baseCommit, headCommit);
  const diffStat = await getDiffStatForRange(state.cwd, state.baseCommit, headCommit);
  const diff = await getDiffForRange(state.cwd, state.baseCommit, headCommit);
  const changedFiles = await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit);
  const recentHistorySummary = renderRecentAcceptedScopesSummary(state, parentScopeLabel);
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
      parentScopeLabel,
      progressJustification: state.currentScopeProgressJustification,
      recentHistorySummary,
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
  writeDiagnostic(
    `[reviewer:review] meaningful progress: ${claude.meaningfulProgress.action} - ${claude.meaningfulProgress.rationale}\n`,
    logger,
  );

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
  const disposition = resolveExecuteReviewDisposition({
    hasBlockingFindings,
    hasOpenNonBlockingFindings,
    reachedMaxRounds,
    shouldBlockForConvergence,
    meaningfulProgressAction: claude.meaningfulProgress.action,
  });
  const blockReason = disposition.status === 'blocked'
    ? getExecuteReviewBlockReason({
        cwd: state.cwd,
        reopenedCanonical,
        stalledBlockingCount,
        reachedMaxRounds: reachedMaxRounds && hasBlockingFindings,
        maxRounds: state.maxRounds,
        meaningfulProgressAction: claude.meaningfulProgress.action,
        meaningfulProgressRationale: claude.meaningfulProgress.rationale,
        parentScopeLabel,
      })
    : null;

  const nextState = await saveState(statePath, {
    ...state,
    reviewerSessionHandle: claude.sessionHandle,
    phase: disposition.phase,
    status: disposition.status,
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
    blockedFromPhase: disposition.blockedFromPhase,
    currentScopeMeaningfulProgressVerdict: claude.meaningfulProgress,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'reviewer_scope',
    round,
    sessionHandle: claude.sessionHandle,
    findings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    meaningfulProgressAction: claude.meaningfulProgress.action,
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
  const diagnosticRecoveryPlanReview = isDiagnosticRecoveryPlanReviewState(state);
  const reviewMode = getPlanReviewMode(state);
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
      mode: reviewMode,
      parentPlanDoc: derivedPlanReview || diagnosticRecoveryPlanReview ? state.planDoc : undefined,
      derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
      recoveryParentScopeLabel: diagnosticRecoveryPlanReview ? state.diagnosticRecovery?.parentScopeLabel : null,
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
            : diagnosticRecoveryPlanReview
              ? 'diagnostic_recovery_adopt'
            : 'done',
    status: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'running'
        : derivedPlanReview
          ? 'running'
          : diagnosticRecoveryPlanReview
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
    blockedFromPhase:
      shouldBlockForConvergence || (hasBlockingFindings && reachedMaxRounds)
        ? diagnosticRecoveryPlanReview
          ? 'diagnostic_recovery_review'
          : 'reviewer_plan'
        : null,
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
    return finalizeBlockedPlanReviewResponse(nextState, statePath, derivedPlanReview, blockReason, logger);
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
  const reviewMode = getPlanReviewMode(state);
  const diagnosticRecoveryPlanReview = reviewMode === 'recovery-plan';
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
      reviewMode,
      parentPlanDoc: derivedPlanReview || diagnosticRecoveryPlanReview ? state.planDoc : undefined,
      derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
      recoveryParentScopeLabel: diagnosticRecoveryPlanReview ? state.diagnosticRecovery?.parentScopeLabel : null,
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
    phase:
      codex.payload.outcome === 'blocked'
        ? 'blocked'
        : diagnosticRecoveryPlanReview
          ? 'diagnostic_recovery_review'
          : 'reviewer_plan',
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
  const reviewMode = getPlanReviewMode(state);
  const diagnosticRecoveryPlanReview = reviewMode === 'recovery-plan';
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
      reviewMode,
      parentPlanDoc: derivedPlanReview || diagnosticRecoveryPlanReview ? state.planDoc : undefined,
      derivedFromScopeNumber: derivedPlanReview ? state.derivedFromScopeNumber : null,
      recoveryParentScopeLabel: diagnosticRecoveryPlanReview ? state.diagnosticRecovery?.parentScopeLabel : null,
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
    phase:
      codex.payload.outcome === 'blocked'
        ? 'blocked'
        : derivedPlanReview
          ? 'awaiting_derived_plan_execution'
          : diagnosticRecoveryPlanReview
            ? 'diagnostic_recovery_adopt'
            : 'done',
    status:
      codex.payload.outcome === 'blocked'
        ? 'blocked'
        : derivedPlanReview || diagnosticRecoveryPlanReview
          ? 'running'
          : 'done',
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
      const finalCompletion = await runCoderFinalCompletionSummaryRound({
        coder: state.agentConfig.coder,
        cwd: state.cwd,
        planDoc: state.planDoc,
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
        await writeExecutionArtifacts(failedState);
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
      }
      else {
        const failedState = await saveState(statePath, {
          ...state,
          finalCommit,
          archivedReviewPath,
          completedScopes,
          status: 'failed',
        });
        await writeExecutionArtifacts(failedState);
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
    await writeExecutionArtifacts(nextState);
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

export async function runFinalCompletionReviewPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
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

  let reviewerResult;
  try {
    reviewerResult = await runReviewerFinalCompletionRound({
      reviewer: state.agentConfig.reviewer,
      cwd: state.cwd,
      planDoc: state.planDoc,
      packet,
      summary: state.finalCompletionSummary,
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
            currentScopeNumber: state.currentScopeNumber + 1,
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

  await writeExecutionArtifacts(nextState);
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

type RunnablePhase = Extract<
  OrchestrationState['phase'],
  | 'coder_plan'
  | 'diagnostic_recovery_analyze'
  | 'diagnostic_recovery_author_plan'
  | 'diagnostic_recovery_review'
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
  | 'final_completion_review'
>;

const RUNNABLE_PHASES = new Set<RunnablePhase>([
  'coder_plan',
  'diagnostic_recovery_analyze',
  'diagnostic_recovery_author_plan',
  'diagnostic_recovery_review',
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
  'final_completion_review',
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
        diagnostic_recovery_analyze: async () => {
          const nextState = await runDiagnosticRecoveryAnalyzePhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        diagnostic_recovery_author_plan: async () => {
          const nextState = await runDiagnosticRecoveryAuthorPlanPhase(currentState, statePath, logger);
          options?.onCoderSessionHandle?.(nextState.coderSessionHandle);
          return nextState;
        },
        diagnostic_recovery_review: async () => runPlanReviewPhase(currentState, statePath, logger),
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
        final_completion_review: async () => runFinalCompletionReviewPhase(currentState, statePath, logger),
      };

      currentState = await phaseHandlers[currentPhase]();
      await options?.onDisplayState?.(currentState, Date.now());

      const pausedAfterScopeBoundary =
        currentState.phase === 'coder_scope' &&
        currentState.status === 'running' &&
        (currentPhase === 'final_squash' || currentPhase === 'final_completion_review') &&
        options?.shouldStopAfterCurrentScope?.();
      if (pausedAfterScopeBoundary) {
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
    runDir?: string;
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
