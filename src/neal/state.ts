import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  AgentConfig,
  AgentProvider,
  ConsultRound,
  InteractiveBlockedRecoveryRecord,
  InteractiveBlockedRecoveryState,
  OrchestrationState,
  OrchestratorInit,
  ReviewFinding,
  ReviewRound,
} from './types.js';

const AGENT_PROVIDERS = new Set(['openai-codex', 'anthropic-claude']);

export function getDefaultAgentConfig(): AgentConfig {
  return {
    coder: {
      provider: 'openai-codex',
      model: null,
    },
    reviewer: {
      provider: 'anthropic-claude',
      model: null,
    },
  };
}

function hydrateAgentConfig(value: unknown): AgentConfig {
  const defaults = getDefaultAgentConfig();
  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const config = value as Partial<AgentConfig>;
  const coderProvider = config.coder?.provider;
  const reviewerProvider = config.reviewer?.provider;

  if (typeof coderProvider === 'string' && !AGENT_PROVIDERS.has(coderProvider)) {
    throw new Error(`Invalid session state: unsupported coder provider ${coderProvider}`);
  }

  if (typeof reviewerProvider === 'string' && !AGENT_PROVIDERS.has(reviewerProvider)) {
    throw new Error(`Invalid session state: unsupported reviewer provider ${reviewerProvider}`);
  }

  function hydrateProvider(provider: unknown, fallback: AgentProvider): AgentProvider {
    return typeof provider === 'string' && AGENT_PROVIDERS.has(provider) ? (provider as AgentProvider) : fallback;
  }

  return {
    coder: {
      provider: hydrateProvider(config.coder?.provider, defaults.coder.provider),
      model: typeof config.coder?.model === 'string' ? config.coder.model : null,
    },
    reviewer: {
      provider: hydrateProvider(config.reviewer?.provider, defaults.reviewer.provider),
      model: typeof config.reviewer?.model === 'string' ? config.reviewer.model : null,
    },
  };
}

export function getSessionStatePath(stateDir: string) {
  return join(stateDir, 'session.json');
}

export async function createInitialState(init: OrchestratorInit, baseCommit: string): Promise<OrchestrationState> {
  const now = new Date().toISOString();
  return {
    version: 1,
    planDoc: init.planDoc,
    cwd: init.cwd,
    runDir: init.runDir,
    topLevelMode: init.topLevelMode,
    ignoreLocalChanges: init.ignoreLocalChanges,
    agentConfig: init.agentConfig,
    progressJsonPath: init.progressJsonPath,
    progressMarkdownPath: init.progressMarkdownPath,
    consultMarkdownPath: init.consultMarkdownPath,
    phase: init.topLevelMode === 'plan' ? 'coder_plan' : 'coder_scope',
    createdAt: now,
    updatedAt: now,
    reviewMarkdownPath: init.reviewMarkdownPath,
    archivedReviewPath: null,
    baseCommit,
    finalCommit: null,
    coderSessionHandle: null,
    reviewerSessionHandle: null,
    executionShape: null,
    currentScopeNumber: 1,
    coderRetryCount: 0,
    lastScopeMarker: null,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    splitPlanCountForCurrentScope: 0,
    derivedPlanDepth: 0,
    maxDerivedPlanReviewRounds: 5,
    rounds: [],
    consultRounds: [],
    findings: [],
    createdCommits: [],
    completedScopes: [],
    maxRounds: init.maxRounds,
    maxConsultsPerScope: 4,
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    status: 'running',
  };
}

export async function saveState(path: string, state: OrchestrationState): Promise<OrchestrationState> {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(nextState, null, 2) + '\n', 'utf8');

  return nextState;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateState(value: unknown): asserts value is OrchestrationState {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: expected object');
  }

  const state = value as Partial<OrchestrationState>;

  if (state.version !== 1) {
    throw new Error(`Invalid session state version: ${String(state.version)}`);
  }

  if (typeof state.planDoc !== 'string' || typeof state.cwd !== 'string') {
    throw new Error('Invalid session state: missing planDoc or cwd');
  }

  if (state.topLevelMode !== undefined && state.topLevelMode !== 'plan' && state.topLevelMode !== 'execute') {
    throw new Error(`Invalid session state: invalid topLevelMode ${String(state.topLevelMode)}`);
  }

  if (typeof state.phase !== 'string' || typeof state.status !== 'string') {
    throw new Error('Invalid session state: missing phase or status');
  }

  if (!isStringArray(state.createdCommits) || !Array.isArray(state.rounds) || !Array.isArray(state.findings)) {
    throw new Error('Invalid session state: malformed arrays');
  }

  if (typeof state.reviewMarkdownPath !== 'string') {
    throw new Error('Invalid session state: missing reviewMarkdownPath');
  }
}

function hydrateConsultRound(value: unknown): ConsultRound {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: malformed consult round');
  }

  const round = value as Partial<ConsultRound>;

  return {
    number: typeof round.number === 'number' ? round.number : 0,
    sourcePhase: round.sourcePhase === 'coder_response' ? 'coder_response' : 'coder_scope',
    coderSessionHandle:
      typeof (round as { coderSessionHandle?: unknown }).coderSessionHandle === 'string'
        ? (round as { coderSessionHandle: string }).coderSessionHandle
        : null,
    reviewerSessionHandle:
      typeof (round as { reviewerSessionHandle?: unknown }).reviewerSessionHandle === 'string'
        ? (round as { reviewerSessionHandle: string }).reviewerSessionHandle
        : null,
    request: {
      summary: typeof round.request?.summary === 'string' ? round.request.summary : '',
      blocker: typeof round.request?.blocker === 'string' ? round.request.blocker : '',
      question: typeof round.request?.question === 'string' ? round.request.question : '',
      attempts: isStringArray(round.request?.attempts) ? round.request.attempts : [],
      relevantFiles: isStringArray(round.request?.relevantFiles) ? round.request.relevantFiles : [],
      verificationContext: isStringArray(round.request?.verificationContext) ? round.request.verificationContext : [],
    },
    response:
      round.response && typeof round.response === 'object'
        ? {
            summary: typeof round.response.summary === 'string' ? round.response.summary : '',
            diagnosis: typeof round.response.diagnosis === 'string' ? round.response.diagnosis : '',
            confidence:
              round.response.confidence === 'low' ||
              round.response.confidence === 'medium' ||
              round.response.confidence === 'high'
                ? round.response.confidence
                : 'low',
            recoverable: Boolean(round.response.recoverable),
            recommendations: isStringArray(round.response.recommendations) ? round.response.recommendations : [],
            relevantFiles: isStringArray(round.response.relevantFiles) ? round.response.relevantFiles : [],
            rationale: typeof round.response.rationale === 'string' ? round.response.rationale : '',
          }
        : null,
    disposition:
      round.disposition && typeof round.disposition === 'object'
        ? {
            outcome: round.disposition.outcome === 'blocked' ? 'blocked' : 'resumed',
            summary: typeof round.disposition.summary === 'string' ? round.disposition.summary : '',
            blocker: typeof round.disposition.blocker === 'string' ? round.disposition.blocker : '',
            decision:
              round.disposition.decision === 'partially_followed' || round.disposition.decision === 'rejected'
                ? round.disposition.decision
                : 'followed',
            rationale: typeof round.disposition.rationale === 'string' ? round.disposition.rationale : '',
          }
        : null,
  };
}

function hydrateFinding(value: unknown): ReviewFinding {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: malformed finding');
  }

  const finding = value as Partial<ReviewFinding>;

  return {
    id: typeof finding.id === 'string' ? finding.id : 'UNKNOWN',
    canonicalId: typeof finding.canonicalId === 'string' ? finding.canonicalId : typeof finding.id === 'string' ? finding.id : 'UNKNOWN',
    round: typeof finding.round === 'number' ? finding.round : 0,
    source: finding.source === 'plan_structure' ? 'plan_structure' : 'reviewer',
    severity: finding.severity === 'non_blocking' ? 'non_blocking' : 'blocking',
    files: isStringArray(finding.files) ? finding.files : [],
    claim: typeof finding.claim === 'string' ? finding.claim : '',
    requiredAction: typeof finding.requiredAction === 'string' ? finding.requiredAction : '',
    status:
      finding.status === 'fixed' || finding.status === 'rejected' || finding.status === 'deferred' ? finding.status : 'open',
    roundSummary: typeof finding.roundSummary === 'string' ? finding.roundSummary : '',
    coderDisposition:
      typeof (finding as { coderDisposition?: unknown }).coderDisposition === 'string'
        ? (finding as { coderDisposition: string }).coderDisposition
        : null,
    coderCommit:
      typeof (finding as { coderCommit?: unknown }).coderCommit === 'string'
        ? (finding as { coderCommit: string }).coderCommit
        : null,
  };
}

function hydrateInteractiveBlockedRecovery(value: unknown): InteractiveBlockedRecoveryState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const recovery = value as Partial<InteractiveBlockedRecoveryState>;
  const sourcePhase =
    recovery.sourcePhase === 'coder_plan' ||
    recovery.sourcePhase === 'reviewer_plan' ||
    recovery.sourcePhase === 'coder_plan_response' ||
    recovery.sourcePhase === 'coder_plan_optional_response' ||
    recovery.sourcePhase === 'awaiting_derived_plan_execution' ||
    recovery.sourcePhase === 'coder_scope' ||
    recovery.sourcePhase === 'reviewer_scope' ||
    recovery.sourcePhase === 'coder_response' ||
    recovery.sourcePhase === 'coder_optional_response' ||
    recovery.sourcePhase === 'reviewer_consult' ||
    recovery.sourcePhase === 'coder_consult_response' ||
    recovery.sourcePhase === 'final_squash'
      ? recovery.sourcePhase
      : 'coder_scope';

  return {
    enteredAt: typeof recovery.enteredAt === 'string' ? recovery.enteredAt : new Date(0).toISOString(),
    sourcePhase,
    blockedReason: typeof recovery.blockedReason === 'string' ? recovery.blockedReason : '',
    maxTurns: typeof recovery.maxTurns === 'number' ? recovery.maxTurns : 3,
    lastHandledTurn: typeof recovery.lastHandledTurn === 'number' ? recovery.lastHandledTurn : 0,
    turns: Array.isArray(recovery.turns)
      ? recovery.turns
          .filter(
            (turn): turn is InteractiveBlockedRecoveryState['turns'][number] =>
              Boolean(turn) &&
              typeof turn === 'object' &&
              typeof turn.number === 'number' &&
              typeof turn.recordedAt === 'string' &&
              typeof turn.operatorGuidance === 'string',
          )
          .map((turn) => ({
            number: turn.number,
            recordedAt: turn.recordedAt,
            operatorGuidance: turn.operatorGuidance,
            disposition:
              turn.disposition &&
              typeof turn.disposition === 'object' &&
              typeof turn.disposition.recordedAt === 'string' &&
              typeof turn.disposition.summary === 'string' &&
              typeof turn.disposition.rationale === 'string' &&
              typeof turn.disposition.blocker === 'string' &&
              typeof turn.disposition.replacementPlan === 'string' &&
              typeof turn.disposition.resultingPhase === 'string' &&
              (
                turn.disposition.action === 'resume_current_scope' ||
                turn.disposition.action === 'replace_current_scope' ||
                turn.disposition.action === 'stay_blocked' ||
                turn.disposition.action === 'terminal_block'
              )
                ? {
                    recordedAt: turn.disposition.recordedAt,
                    sessionHandle: typeof turn.disposition.sessionHandle === 'string' ? turn.disposition.sessionHandle : null,
                    action: turn.disposition.action,
                    summary: turn.disposition.summary,
                    rationale: turn.disposition.rationale,
                    blocker: turn.disposition.blocker,
                    replacementPlan: turn.disposition.replacementPlan,
                    resultingPhase: turn.disposition.resultingPhase,
                  }
                : null,
          }))
      : [],
  };
}

function hydrateInteractiveBlockedRecoveryRecord(value: unknown): InteractiveBlockedRecoveryRecord {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: malformed interactive blocked recovery history');
  }

  const record = value as Partial<InteractiveBlockedRecoveryRecord>;
  const hydratedRecovery = hydrateInteractiveBlockedRecovery(record);
  if (!hydratedRecovery) {
    throw new Error('Invalid session state: malformed interactive blocked recovery history');
  }

  return {
    ...hydratedRecovery,
    resolvedAt: typeof record.resolvedAt === 'string' ? record.resolvedAt : new Date(0).toISOString(),
    resolvedByAction:
      record.resolvedByAction === 'resume_current_scope' ||
      record.resolvedByAction === 'replace_current_scope' ||
      record.resolvedByAction === 'stay_blocked' ||
      record.resolvedByAction === 'terminal_block'
        ? record.resolvedByAction
        : 'terminal_block',
    resultPhase: typeof record.resultPhase === 'string' ? record.resultPhase : 'blocked',
  };
}

function hydrateRound(value: unknown): ReviewRound {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: malformed round');
  }

  const round = value as Partial<ReviewRound>;

  return {
    round: typeof round.round === 'number' ? round.round : 0,
    reviewerSessionHandle:
      typeof (round as { reviewerSessionHandle?: unknown }).reviewerSessionHandle === 'string'
        ? (round as { reviewerSessionHandle: string }).reviewerSessionHandle
        : null,
    reviewedPlanPath:
      typeof (round as { reviewedPlanPath?: unknown }).reviewedPlanPath === 'string'
        ? (round as { reviewedPlanPath: string }).reviewedPlanPath
        : null,
    normalizationApplied:
      typeof (round as { normalizationApplied?: unknown }).normalizationApplied === 'boolean'
        ? (round as { normalizationApplied: boolean }).normalizationApplied
        : false,
    normalizationOperations:
      isStringArray((round as { normalizationOperations?: unknown }).normalizationOperations)
        ? ((round as { normalizationOperations: string[] }).normalizationOperations)
        : [],
    normalizationScopeLabelMappings: Array.isArray((round as { normalizationScopeLabelMappings?: unknown }).normalizationScopeLabelMappings)
      ? ((round as { normalizationScopeLabelMappings: ReviewRound['normalizationScopeLabelMappings'] }).normalizationScopeLabelMappings).filter(
          (mapping) =>
            Boolean(mapping) &&
            typeof mapping === 'object' &&
            typeof mapping.normalizedScopeNumber === 'number' &&
            typeof mapping.originalScopeLabel === 'string',
        )
      : [],
    commitRange: {
      base: typeof round.commitRange?.base === 'string' ? round.commitRange.base : '',
      head: typeof round.commitRange?.head === 'string' ? round.commitRange.head : '',
    },
    openBlockingCanonicalCount: typeof round.openBlockingCanonicalCount === 'number' ? round.openBlockingCanonicalCount : 0,
    findings: isStringArray(round.findings) ? round.findings : [],
  };
}

function hydrateCompletedScope(value: unknown): OrchestrationState['completedScopes'][number] {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: malformed completed scope');
  }

  const scope = value as Partial<OrchestrationState['completedScopes'][number]>;

  return {
    number:
      typeof scope.number === 'string'
        ? scope.number
        : typeof scope.number === 'number'
          ? String(scope.number)
          : '0',
    marker:
      scope.marker === 'AUTONOMY_SCOPE_DONE' ||
      scope.marker === 'AUTONOMY_CHUNK_DONE' ||
      scope.marker === 'AUTONOMY_DONE' ||
      scope.marker === 'AUTONOMY_BLOCKED' ||
      scope.marker === 'AUTONOMY_SPLIT_PLAN'
        ? scope.marker
        : 'AUTONOMY_BLOCKED',
    result: scope.result === 'accepted' ? 'accepted' : 'blocked',
    baseCommit: typeof scope.baseCommit === 'string' ? scope.baseCommit : null,
    finalCommit: typeof scope.finalCommit === 'string' ? scope.finalCommit : null,
    commitSubject: typeof scope.commitSubject === 'string' ? scope.commitSubject : null,
    reviewRounds: typeof scope.reviewRounds === 'number' ? scope.reviewRounds : 0,
    findings: typeof scope.findings === 'number' ? scope.findings : 0,
    archivedReviewPath: typeof scope.archivedReviewPath === 'string' ? scope.archivedReviewPath : null,
    blocker: typeof scope.blocker === 'string' ? scope.blocker : null,
    derivedFromParentScope: typeof scope.derivedFromParentScope === 'string' ? scope.derivedFromParentScope : null,
    replacedByDerivedPlanPath: typeof scope.replacedByDerivedPlanPath === 'string' ? scope.replacedByDerivedPlanPath : null,
  };
}

function normalizeStateV1(parsed: OrchestrationState, path: string): OrchestrationState {
  const stateDir = dirname(path);
  const runDir = typeof parsed.runDir === 'string' ? parsed.runDir : join(stateDir, 'runs', 'legacy');
  const progressJsonPath = typeof parsed.progressJsonPath === 'string' ? parsed.progressJsonPath : join(runDir, 'plan-progress.json');
  const progressMarkdownPath =
    typeof parsed.progressMarkdownPath === 'string' ? parsed.progressMarkdownPath : join(runDir, 'PLAN_PROGRESS.md');
  const consultMarkdownPath =
    typeof parsed.consultMarkdownPath === 'string' ? parsed.consultMarkdownPath : join(runDir, 'CONSULT.md');

  return {
    ...parsed,
    runDir,
    topLevelMode: parsed.topLevelMode === 'plan' ? 'plan' : 'execute',
    ignoreLocalChanges: typeof (parsed as { ignoreLocalChanges?: unknown }).ignoreLocalChanges === 'boolean'
      ? (parsed as { ignoreLocalChanges: boolean }).ignoreLocalChanges
      : false,
    agentConfig: hydrateAgentConfig(parsed.agentConfig),
    progressJsonPath,
    progressMarkdownPath,
    consultMarkdownPath,
    phase: parsed.phase,
    coderSessionHandle:
      typeof (parsed as { coderSessionHandle?: unknown }).coderSessionHandle === 'string'
        ? (parsed as { coderSessionHandle: string }).coderSessionHandle
        : null,
    reviewerSessionHandle:
      typeof (parsed as { reviewerSessionHandle?: unknown }).reviewerSessionHandle === 'string'
        ? (parsed as { reviewerSessionHandle: string }).reviewerSessionHandle
        : null,
    executionShape:
      (parsed as { executionShape?: unknown }).executionShape === 'one_shot' ||
      (parsed as { executionShape?: unknown }).executionShape === 'multi_scope'
        ? (parsed as { executionShape: OrchestrationState['executionShape'] }).executionShape
        : null,
    currentScopeNumber: typeof parsed.currentScopeNumber === 'number' ? parsed.currentScopeNumber : 1,
    coderRetryCount:
      typeof (parsed as { coderRetryCount?: unknown }).coderRetryCount === 'number'
        ? (parsed as { coderRetryCount: number }).coderRetryCount
        : 0,
    consultRounds: Array.isArray(parsed.consultRounds) ? parsed.consultRounds.map(hydrateConsultRound) : [],
    lastScopeMarker:
      (parsed as { lastScopeMarker?: unknown }).lastScopeMarker === 'AUTONOMY_SCOPE_DONE' ||
      (parsed as { lastScopeMarker?: unknown }).lastScopeMarker === 'AUTONOMY_CHUNK_DONE' ||
      (parsed as { lastScopeMarker?: unknown }).lastScopeMarker === 'AUTONOMY_DONE' ||
      (parsed as { lastScopeMarker?: unknown }).lastScopeMarker === 'AUTONOMY_BLOCKED' ||
      (parsed as { lastScopeMarker?: unknown }).lastScopeMarker === 'AUTONOMY_SPLIT_PLAN'
        ? (parsed as { lastScopeMarker: OrchestrationState['lastScopeMarker'] }).lastScopeMarker
        : null,
    derivedPlanPath:
      typeof (parsed as { derivedPlanPath?: unknown }).derivedPlanPath === 'string'
        ? (parsed as { derivedPlanPath: string }).derivedPlanPath
        : null,
    derivedFromScopeNumber:
      typeof (parsed as { derivedFromScopeNumber?: unknown }).derivedFromScopeNumber === 'number'
        ? (parsed as { derivedFromScopeNumber: number }).derivedFromScopeNumber
        : null,
    derivedPlanStatus:
      (parsed as { derivedPlanStatus?: unknown }).derivedPlanStatus === 'pending_review' ||
      (parsed as { derivedPlanStatus?: unknown }).derivedPlanStatus === 'accepted' ||
      (parsed as { derivedPlanStatus?: unknown }).derivedPlanStatus === 'rejected'
        ? (parsed as { derivedPlanStatus: OrchestrationState['derivedPlanStatus'] }).derivedPlanStatus
        : null,
    derivedScopeIndex:
      typeof (parsed as { derivedScopeIndex?: unknown }).derivedScopeIndex === 'number'
        ? (parsed as { derivedScopeIndex: number }).derivedScopeIndex
        : null,
    splitPlanStartedNotified:
      typeof (parsed as { splitPlanStartedNotified?: unknown }).splitPlanStartedNotified === 'boolean'
        ? (parsed as { splitPlanStartedNotified: boolean }).splitPlanStartedNotified
        : false,
    derivedPlanAcceptedNotified:
      typeof (parsed as { derivedPlanAcceptedNotified?: unknown }).derivedPlanAcceptedNotified === 'boolean'
        ? (parsed as { derivedPlanAcceptedNotified: boolean }).derivedPlanAcceptedNotified
        : false,
    splitPlanBlockedNotified:
      typeof (parsed as { splitPlanBlockedNotified?: unknown }).splitPlanBlockedNotified === 'boolean'
        ? (parsed as { splitPlanBlockedNotified: boolean }).splitPlanBlockedNotified
        : false,
    splitPlanCountForCurrentScope:
      typeof (parsed as { splitPlanCountForCurrentScope?: unknown }).splitPlanCountForCurrentScope === 'number'
        ? (parsed as { splitPlanCountForCurrentScope: number }).splitPlanCountForCurrentScope
        : 0,
    derivedPlanDepth:
      typeof (parsed as { derivedPlanDepth?: unknown }).derivedPlanDepth === 'number'
        ? (parsed as { derivedPlanDepth: number }).derivedPlanDepth
        : 0,
    maxDerivedPlanReviewRounds:
      typeof (parsed as { maxDerivedPlanReviewRounds?: unknown }).maxDerivedPlanReviewRounds === 'number'
        ? (parsed as { maxDerivedPlanReviewRounds: number }).maxDerivedPlanReviewRounds
        : 5,
    rounds: parsed.rounds.map(hydrateRound),
    findings: parsed.findings.map(hydrateFinding),
    completedScopes: Array.isArray(parsed.completedScopes) ? parsed.completedScopes.map(hydrateCompletedScope) : [],
    maxConsultsPerScope: typeof parsed.maxConsultsPerScope === 'number' ? parsed.maxConsultsPerScope : 4,
    blockedFromPhase: typeof parsed.blockedFromPhase === 'string' ? parsed.blockedFromPhase as OrchestrationState['phase'] : null,
    interactiveBlockedRecovery: hydrateInteractiveBlockedRecovery(
      (parsed as { interactiveBlockedRecovery?: unknown }).interactiveBlockedRecovery,
    ),
    interactiveBlockedRecoveryHistory: Array.isArray((parsed as { interactiveBlockedRecoveryHistory?: unknown }).interactiveBlockedRecoveryHistory)
      ? (parsed as { interactiveBlockedRecoveryHistory: unknown[] }).interactiveBlockedRecoveryHistory.map(
          hydrateInteractiveBlockedRecoveryRecord,
        )
      : [],
  };
}

export async function loadState(path: string): Promise<OrchestrationState> {
  const content = await readFile(path, 'utf8');
  const parsed = JSON.parse(content);
  validateState(parsed);
  return normalizeStateV1(parsed, path);
}
