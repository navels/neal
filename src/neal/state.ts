import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConsultRound, OrchestrationState, OrchestratorInit, ReviewFinding, ReviewRound } from './types.js';

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
    progressJsonPath: init.progressJsonPath,
    progressMarkdownPath: init.progressMarkdownPath,
    consultMarkdownPath: init.consultMarkdownPath,
    phase: init.topLevelMode === 'plan' ? 'codex_plan' : 'codex_scope',
    createdAt: now,
    updatedAt: now,
    reviewMarkdownPath: init.reviewMarkdownPath,
    archivedReviewPath: null,
    baseCommit,
    finalCommit: null,
    codexThreadId: null,
    claudeSessionId: null,
    currentScopeNumber: 1,
    codexRetryCount: 0,
    lastCodexMarker: null,
    rounds: [],
    consultRounds: [],
    findings: [],
    createdCommits: [],
    completedScopes: [],
    maxRounds: init.maxRounds,
    maxConsultsPerScope: 4,
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
    sourcePhase: round.sourcePhase === 'codex_response' ? 'codex_response' : 'codex_scope',
    codexThreadId: typeof round.codexThreadId === 'string' ? round.codexThreadId : null,
    claudeSessionId: typeof round.claudeSessionId === 'string' ? round.claudeSessionId : null,
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
    severity: finding.severity === 'non_blocking' ? 'non_blocking' : 'blocking',
    files: isStringArray(finding.files) ? finding.files : [],
    claim: typeof finding.claim === 'string' ? finding.claim : '',
    requiredAction: typeof finding.requiredAction === 'string' ? finding.requiredAction : '',
    status:
      finding.status === 'fixed' || finding.status === 'rejected' || finding.status === 'deferred' ? finding.status : 'open',
    roundSummary: typeof finding.roundSummary === 'string' ? finding.roundSummary : '',
    codexDisposition: typeof finding.codexDisposition === 'string' ? finding.codexDisposition : null,
    codexCommit: typeof finding.codexCommit === 'string' ? finding.codexCommit : null,
  };
}

function hydrateRound(value: unknown): ReviewRound {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid session state: malformed round');
  }

  const round = value as Partial<ReviewRound>;

  return {
    round: typeof round.round === 'number' ? round.round : 0,
    claudeSessionId: typeof round.claudeSessionId === 'string' ? round.claudeSessionId : null,
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
    number: typeof scope.number === 'number' ? scope.number : 0,
    marker:
      scope.marker === 'AUTONOMY_SCOPE_DONE' ||
      scope.marker === 'AUTONOMY_CHUNK_DONE' ||
      scope.marker === 'AUTONOMY_DONE' ||
      scope.marker === 'AUTONOMY_BLOCKED'
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
  };
}

export async function loadState(path: string): Promise<OrchestrationState> {
  const content = await readFile(path, 'utf8');
  const parsed = JSON.parse(content);
  validateState(parsed);
  const stateDir = dirname(path);
  const runDir = typeof parsed.runDir === 'string' ? parsed.runDir : join(stateDir, 'runs', 'legacy');
  const progressJsonPath = typeof parsed.progressJsonPath === 'string' ? parsed.progressJsonPath : join(runDir, 'plan-progress.json');
  const progressMarkdownPath =
    typeof parsed.progressMarkdownPath === 'string' ? parsed.progressMarkdownPath : join(runDir, 'PLAN_PROGRESS.md');
  const consultMarkdownPath =
    typeof parsed.consultMarkdownPath === 'string' ? parsed.consultMarkdownPath : join(runDir, 'CONSULT.md');
  const rawPhase = (parsed as { phase?: unknown }).phase;
  return {
    ...parsed,
    runDir,
    topLevelMode: parsed.topLevelMode === 'plan' ? 'plan' : 'execute',
    progressJsonPath,
    progressMarkdownPath,
    consultMarkdownPath,
    phase: rawPhase === 'codex_chunk' ? 'codex_scope' : parsed.phase,
    claudeSessionId: typeof parsed.claudeSessionId === 'string' ? parsed.claudeSessionId : null,
    currentScopeNumber: typeof parsed.currentScopeNumber === 'number' ? parsed.currentScopeNumber : 1,
    codexRetryCount: typeof parsed.codexRetryCount === 'number' ? parsed.codexRetryCount : 0,
    consultRounds: Array.isArray(parsed.consultRounds) ? parsed.consultRounds.map(hydrateConsultRound) : [],
    lastCodexMarker:
      parsed.lastCodexMarker === 'AUTONOMY_SCOPE_DONE' ||
      parsed.lastCodexMarker === 'AUTONOMY_CHUNK_DONE' ||
      parsed.lastCodexMarker === 'AUTONOMY_DONE' ||
      parsed.lastCodexMarker === 'AUTONOMY_BLOCKED'
        ? parsed.lastCodexMarker
        : null,
    rounds: parsed.rounds.map(hydrateRound),
    findings: parsed.findings.map(hydrateFinding),
    completedScopes: Array.isArray(parsed.completedScopes) ? parsed.completedScopes.map(hydrateCompletedScope) : [],
    maxConsultsPerScope: typeof parsed.maxConsultsPerScope === 'number' ? parsed.maxConsultsPerScope : 4,
  };
}
