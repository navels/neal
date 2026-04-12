import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { OrchestrationState, OrchestratorInit, ReviewFinding, ReviewRound } from './types.js';

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
    executionMode: init.executionMode,
    phase: 'codex_chunk',
    createdAt: now,
    updatedAt: now,
    reviewMarkdownPath: init.reviewMarkdownPath,
    archivedReviewPath: null,
    baseCommit,
    finalCommit: null,
    codexThreadId: null,
    rounds: [],
    findings: [],
    createdCommits: [],
    maxRounds: init.maxRounds,
    status: 'running',
  };
}

export async function saveState(path: string, state: OrchestrationState) {
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

export async function loadState(path: string) {
  const content = await readFile(path, 'utf8');
  const parsed = JSON.parse(content);
  validateState(parsed);
  const stateDir = dirname(path);
  const runDir = typeof parsed.runDir === 'string' ? parsed.runDir : join(stateDir, 'runs', 'legacy');
  const executionMode =
    parsed.executionMode === undefined
      ? 'chunked'
      : parsed.executionMode === 'one_shot' || parsed.executionMode === 'chunked'
        ? parsed.executionMode
        : (() => {
            throw new Error(`Invalid session state: invalid executionMode ${String(parsed.executionMode)}`);
          })();
  return {
    ...parsed,
    runDir,
    executionMode,
    rounds: parsed.rounds.map(hydrateRound),
    findings: parsed.findings.map(hydrateFinding),
  };
}
