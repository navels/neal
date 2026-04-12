import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { notify } from '../notifier.js';
import {
  ClaudeRoundError,
  CodexRoundError,
  runClaudePlanReviewRound,
  runClaudeReviewRound,
  runCodexChunkRound,
  runCodexPlanResponseRound,
  runCodexPlanRound,
  runCodexResponseRound,
} from './agents.js';
import { getChangedFilesForRange, getCommitMessage, getCommitRange, getCommitSubjects, getDiffForRange, getDiffStatForRange, getHeadCommit, getWorktreeStatus, squashCommits } from './git.js';
import { createRunLogger, type RunLogger } from './logger.js';
import { writePlanProgressArtifacts } from './progress.js';
import { writeCheckpointRetrospective } from './retrospective.js';
import { renderReviewMarkdown, writeReviewMarkdown } from './review.js';
import { createInitialState, getSessionStatePath, loadState, saveState } from './state.js';
import type { CodexMarker, ExecutionMode, FindingStatus, OrchestrationState, OrchestratorInit, ReviewFinding } from './types.js';

const MAX_INLINE_DIFF_FILES = Number(process.env.CLAUDE_INLINE_DIFF_FILE_LIMIT ?? 40);
const DEFAULT_PHASE_HEARTBEAT_MS = Number(process.env.NEAL_PHASE_HEARTBEAT_MS ?? 60_000);

function writeDiagnostic(message: string, logger?: RunLogger) {
  process.stderr.write(message);
  void logger?.stderr(message);
}

function formatClaudeFindings(
  findings: Array<{
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
      return [
        `  ${index + 1}. [${finding.severity}] ${finding.claim}`,
        `     Files: ${files}`,
        `     Action: ${finding.requiredAction}`,
      ].join('\n');
    })
    .join('\n') + '\n';
}

function printClaudeReviewResult(
  kind: 'review' | 'plan-review',
  summary: string,
  findings: Array<{
    severity: 'blocking' | 'non_blocking';
    files: string[];
    claim: string;
    requiredAction: string;
  }>,
  logger?: RunLogger,
) {
  const blocking = findings.filter((finding) => finding.severity === 'blocking').length;
  const nonBlocking = findings.length - blocking;
  const header = kind === 'review' ? '[claude:review]' : '[claude:plan-review]';
  const message = [
    `${header} summary: ${summary}`,
    `${header} findings: ${blocking} blocking, ${nonBlocking} non-blocking`,
    formatClaudeFindings(findings),
  ].join('\n');
  writeDiagnostic(`${message}\n`, logger);
}

function startPhaseHeartbeat(
  phase: OrchestrationState['phase'],
  state: OrchestrationState,
  logger?: RunLogger,
  intervalMs = DEFAULT_PHASE_HEARTBEAT_MS,
) {
  if (!logger || intervalMs <= 0) {
    return () => {};
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    const payload = {
      phase,
      elapsedMs,
      codexThreadId: state.codexThreadId,
      claudeSessionId: state.claudeSessionId,
      currentScopeNumber: state.currentScopeNumber,
      topLevelMode: state.topLevelMode,
      executionMode: state.executionMode,
    };
    void logger.event('phase.heartbeat', payload);
    writeDiagnostic(
      `[neal] heartbeat phase=${phase} elapsed=${Math.round(elapsedMs / 1000)}s` +
        `${state.codexThreadId ? ` codex=${state.codexThreadId}` : ''}` +
        `${state.claudeSessionId ? ` claude=${state.claudeSessionId}` : ''}\n`,
      logger,
    );
  }, intervalMs);

  return () => clearInterval(timer);
}

async function persistCodexFailureState(
  state: OrchestrationState,
  statePath: string,
  phase: 'codex_chunk' | 'codex_plan' | 'codex_response' | 'codex_plan_response',
  error: CodexRoundError,
  logger?: RunLogger,
) {
  const failedState = await saveState(statePath, {
    ...state,
    codexThreadId: error.threadId ?? state.codexThreadId,
    status: 'failed',
  });
  await writeExecutionArtifacts(failedState);
  await logger?.event('phase.error', {
    phase,
    threadId: error.threadId ?? state.codexThreadId,
    message: error.message,
  });
  return failedState;
}

function getCodexCompletionProblem(executionMode: ExecutionMode, marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED') {
    return null;
  }

  if (executionMode === 'one_shot') {
    return marker === 'AUTONOMY_DONE' ? null : 'One-shot execution must end with AUTONOMY_DONE or AUTONOMY_BLOCKED.';
  }

  return marker === 'AUTONOMY_CHUNK_DONE' || marker === 'AUTONOMY_DONE'
    ? null
    : 'Chunked execution must end with AUTONOMY_CHUNK_DONE, AUTONOMY_DONE, or AUTONOMY_BLOCKED.';
}

function getPlanningCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED') {
    return null;
  }

  return marker === 'AUTONOMY_DONE' ? null : 'Planning mode must end with AUTONOMY_DONE or AUTONOMY_BLOCKED.';
}

async function writeExecutionArtifacts(state: OrchestrationState) {
  await writeReviewMarkdown(state.reviewMarkdownPath, state);
  await writePlanProgressArtifacts(state);
}

export async function initializeOrchestration(
  planDoc: string,
  cwd: string,
  executionMode: ExecutionMode,
  topLevelMode: 'plan' | 'execute' = 'execute',
) {
  const absolutePlanDoc = resolve(planDoc);
  const stateDir = join(cwd, '.neal');
  const logger = await createRunLogger({
    cwd,
    stateDir,
    planDoc: absolutePlanDoc,
    topLevelMode,
    executionMode,
  });

  const init: OrchestratorInit = {
    cwd,
    planDoc: absolutePlanDoc,
    stateDir,
    runDir: logger.runDir,
    topLevelMode,
    progressJsonPath: join(logger.runDir, 'plan-progress.json'),
    progressMarkdownPath: join(logger.runDir, 'PLAN_PROGRESS.md'),
    reviewMarkdownPath: join(logger.runDir, 'REVIEW.md'),
    maxRounds: 3,
    executionMode,
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
    reviewMarkdownPath: savedState.reviewMarkdownPath,
    progressJsonPath: savedState.progressJsonPath,
    progressMarkdownPath: savedState.progressMarkdownPath,
    executionMode,
  });

  return {
    state: savedState,
    statePath,
    logger,
  };
}

async function notifyBlocked(state: OrchestrationState, reason: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.blocked', { reason, planName });
  await notify('blocked', `[neal] ${planName}: ${reason}`);
}

async function notifyComplete(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.complete', { message, planName });
  await notify('complete', `[neal] ${planName}: ${message}`);
}

async function notifyChunkAccepted(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.chunk_complete', {
    message,
    planName,
    scopeNumber: state.currentScopeNumber,
  });
  await notify('complete', `[neal] ${planName}: chunk ${state.currentScopeNumber} complete: ${message}`);
}

async function persistBlockedScope(state: OrchestrationState, statePath: string, reason: string) {
  if (state.completedScopes.some((scope) => scope.number === state.currentScopeNumber)) {
    return state;
  }

  const nextState = await saveState(statePath, {
    ...state,
    completedScopes: appendCompletedScope(state, 'blocked', {
      finalCommit: null,
      commitSubject: null,
      archivedReviewPath: state.archivedReviewPath,
      blocker: reason,
    }),
  });
  await writeExecutionArtifacts(nextState);
  return nextState;
}

function filterWrapperOwnedWorktreeStatus(statusOutput: string) {
  const ignoredPaths = new Set([
    '.neal/session.json',
    '.forge/session.json',
  ]);

  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const path = line.length >= 3 ? line.slice(3).trim() : line.trim();
      return !ignoredPaths.has(path);
    })
    .join('\n');
}

async function runCodexPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'codex_chunk' });
  const beforeHead = await getHeadCommit(state.cwd);
  let codex;
  try {
    codex = await runCodexChunkRound({
      cwd: state.cwd,
      planDoc: state.planDoc,
      progressMarkdownPath: state.progressMarkdownPath,
      executionMode: state.executionMode,
      threadId: state.codexThreadId,
      logger,
    });
  } catch (error) {
    if (error instanceof CodexRoundError) {
      await persistCodexFailureState(state, statePath, 'codex_chunk', error, logger);
    }
    throw error;
  }
  const afterHead = await getHeadCommit(state.cwd);
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);
  const completionProblem = getCodexCompletionProblem(state.executionMode, codex.marker);

  const nextState = await saveState(statePath, {
    ...state,
    codexThreadId: codex.threadId,
    lastCodexMarker: codex.marker as CodexMarker | null,
    phase: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'blocked' : 'claude_review',
    status: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'blocked' : 'running',
    createdCommits: [...state.createdCommits, ...createdCommits],
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'codex_chunk',
    executionMode: state.executionMode,
    marker: codex.marker,
    threadId: codex.threadId,
    createdCommits,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const reason = completionProblem ?? 'Codex reported a blocker during chunk execution';
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

async function runCodexPlanPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'codex_plan' });
  let codex;
  try {
    codex = await runCodexPlanRound({
      cwd: state.cwd,
      planDoc: state.planDoc,
      threadId: state.codexThreadId,
      logger,
    });
  } catch (error) {
    if (error instanceof CodexRoundError) {
      await persistCodexFailureState(state, statePath, 'codex_plan', error, logger);
    }
    throw error;
  }
  const completionProblem = getPlanningCompletionProblem(codex.marker);

  const nextState = await saveState(statePath, {
    ...state,
    codexThreadId: codex.threadId,
    lastCodexMarker: codex.marker as CodexMarker | null,
    phase: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'blocked' : 'claude_plan_review',
    status: codex.marker === 'AUTONOMY_BLOCKED' || completionProblem ? 'blocked' : 'running',
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'codex_plan',
    marker: codex.marker,
    threadId: codex.threadId,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const reason = completionProblem ?? 'Codex reported a blocker during plan revision';
    const persistedState = await persistBlockedScope(nextState, statePath, reason);
    await notifyBlocked(persistedState, reason, logger);
    return persistedState;
  }
  return nextState;
}

async function runClaudePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.baseCommit) {
    throw new Error('Cannot run Claude review without baseCommit');
  }

  await logger?.event('phase.start', { phase: 'claude_review', round: state.rounds.length + 1 });
  const headCommit = await getHeadCommit(state.cwd);
  const round = state.rounds.length + 1;
  const previousHeadCommit = state.rounds.at(-1)?.commitRange.head ?? null;
  const diffStat = await getDiffStatForRange(state.cwd, state.baseCommit, headCommit);
  const changedFiles = await getChangedFilesForRange(state.cwd, state.baseCommit, headCommit);
  const diff = changedFiles.length <= MAX_INLINE_DIFF_FILES ? await getDiffForRange(state.cwd, state.baseCommit, headCommit) : '';
  let claude;
  try {
    claude = await runClaudeReviewRound({
      cwd: state.cwd,
      planDoc: state.planDoc,
      baseCommit: state.baseCommit,
      headCommit,
      previousHeadCommit,
      diff,
      diffStat,
      changedFiles,
      round,
      reviewMarkdownPath: state.reviewMarkdownPath,
      logger,
    });
  } catch (error) {
    if (error instanceof ClaudeRoundError) {
      const failedState = await saveState(statePath, {
        ...state,
        claudeSessionId: error.sessionId,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'claude_review',
        round,
        sessionId: error.sessionId,
        subtype: error.subtype,
        message: error.message,
      });
    }
    throw error;
  }

  printClaudeReviewResult('review', claude.summary, claude.findings, logger);

  let nextCanonicalIndex = getNextCanonicalIndex(state.findings);
  const findings = claude.findings.map((finding, index) => {
    const canonicalId = findCanonicalId(state.findings, finding) ?? `C${nextCanonicalIndex++}`;
    return {
      ...finding,
      id: `R${round}-F${index + 1}`,
      canonicalId,
      status: 'open' as const,
      codexDisposition: null,
      codexCommit: null,
    };
  });
  const mergedFindings = [...state.findings, ...findings];
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
  const reachedMaxRounds = round >= state.maxRounds;
  const openBlockingCanonicalCount = countOpenBlockingCanonicals(mergedFindings);
  const stalledBlockingCount = hasTwoConsecutiveNonReductions(state.rounds, openBlockingCanonicalCount);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const blockReason = reopenedCanonical
    ? `blocking finding ${reopenedCanonical} reopened across multiple Claude rounds`
    : stalledBlockingCount
      ? 'blocking findings did not decrease for two consecutive Claude rounds'
      : reachedMaxRounds && hasBlockingFindings
        ? `reached max review rounds (${state.maxRounds}) with blocking findings still open`
        : null;

  const nextState = await saveState(statePath, {
    ...state,
    claudeSessionId: claude.sessionId,
    phase: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'codex_response'
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
        claudeSessionId: claude.sessionId,
        commitRange: {
          base: state.baseCommit,
          head: headCommit,
        },
        openBlockingCanonicalCount,
        findings: findings.map((finding) => finding.id),
      },
    ],
    findings: mergedFindings,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'claude_review',
    round,
    sessionId: claude.sessionId,
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

async function runClaudePlanPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'claude_plan_review', round: state.rounds.length + 1 });
  const round = state.rounds.length + 1;
  let claude;
  try {
    claude = await runClaudePlanReviewRound({
      cwd: state.cwd,
      planDoc: state.planDoc,
      round,
      reviewMarkdownPath: state.reviewMarkdownPath,
      logger,
    });
  } catch (error) {
    if (error instanceof ClaudeRoundError) {
      const failedState = await saveState(statePath, {
        ...state,
        claudeSessionId: error.sessionId,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'claude_plan_review',
        round,
        sessionId: error.sessionId,
        subtype: error.subtype,
        message: error.message,
      });
    }
    throw error;
  }

  printClaudeReviewResult('plan-review', claude.summary, claude.findings, logger);

  let nextCanonicalIndex = getNextCanonicalIndex(state.findings);
  const findings = claude.findings.map((finding, index) => {
    const canonicalId = findCanonicalId(state.findings, finding) ?? `C${nextCanonicalIndex++}`;
    return {
      ...finding,
      id: `R${round}-F${index + 1}`,
      canonicalId,
      status: 'open' as const,
      codexDisposition: null,
      codexCommit: null,
    };
  });
  const mergedFindings = [...state.findings, ...findings];
  const hasBlockingFindings = findings.some((finding) => finding.severity === 'blocking');
  const reachedMaxRounds = round >= state.maxRounds;
  const openBlockingCanonicalCount = countOpenBlockingCanonicals(mergedFindings);
  const stalledBlockingCount = hasTwoConsecutiveNonReductions(state.rounds, openBlockingCanonicalCount);
  const reopenedCanonical = getReopenedCanonical(mergedFindings);
  const shouldBlockForConvergence = Boolean(reopenedCanonical || stalledBlockingCount);
  const blockReason = reopenedCanonical
    ? `blocking finding ${reopenedCanonical} reopened across multiple Claude rounds`
    : stalledBlockingCount
      ? 'blocking findings did not decrease for two consecutive Claude rounds'
      : reachedMaxRounds && hasBlockingFindings
        ? `reached max review rounds (${state.maxRounds}) with blocking findings still open`
        : null;

  const nextState = await saveState(statePath, {
    ...state,
    claudeSessionId: claude.sessionId,
    phase: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'codex_plan_response'
        : 'done',
    status: shouldBlockForConvergence
      ? 'blocked'
      : hasBlockingFindings
        ? reachedMaxRounds
          ? 'blocked'
          : 'running'
        : 'done',
    rounds: [
      ...state.rounds,
      {
        round,
        claudeSessionId: claude.sessionId,
        commitRange: {
          base: state.baseCommit ?? '',
          head: state.finalCommit ?? state.baseCommit ?? '',
        },
        openBlockingCanonicalCount,
        findings: findings.map((finding) => finding.id),
      },
    ],
    findings: mergedFindings,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'claude_plan_review',
    round,
    sessionId: claude.sessionId,
    findings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && blockReason) {
    const persistedState = await persistBlockedScope(nextState, statePath, blockReason);
    await notifyBlocked(persistedState, blockReason, logger);
    return persistedState;
  }
  if (nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

function isOpenBlockingFinding(finding: ReviewFinding) {
  return finding.status === 'open' && finding.severity === 'blocking';
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

function hasTwoConsecutiveNonReductions(rounds: OrchestrationState['rounds'], currentCount: number) {
  if (rounds.length < 2) {
    return false;
  }

  const previousCount = rounds[rounds.length - 1].openBlockingCanonicalCount;
  const priorCount = rounds[rounds.length - 2].openBlockingCanonicalCount;
  return currentCount >= previousCount && previousCount >= priorCount;
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

function getCurrentScopeKind(state: OrchestrationState): 'one_shot' | 'chunk' {
  return state.executionMode === 'chunked' ? 'chunk' : 'one_shot';
}

function appendCompletedScope(
  state: OrchestrationState,
  result: 'accepted' | 'blocked',
  details: {
    finalCommit: string | null;
    commitSubject: string | null;
    archivedReviewPath: string | null;
    blocker: string | null;
  },
) {
  const marker = (state.lastCodexMarker ?? 'AUTONOMY_BLOCKED') as CodexMarker;
  return [
    ...state.completedScopes,
    {
      number: state.currentScopeNumber,
      kind: getCurrentScopeKind(state),
      marker,
      result,
      baseCommit: state.baseCommit,
      finalCommit: details.finalCommit,
      commitSubject: details.commitSubject,
      reviewRounds: state.rounds.length,
      findings: state.findings.length,
      archivedReviewPath: details.archivedReviewPath,
      blocker: details.blocker,
    },
  ];
}

async function runCodexResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.codexThreadId) {
    throw new Error('Cannot run Codex response phase without an existing Codex thread');
  }

  await logger?.event('phase.start', { phase: 'codex_response' });
  const openFindings = state.findings.filter(isOpenBlockingFinding);
  if (openFindings.length === 0) {
    const nextState = await saveState(statePath, {
      ...state,
      phase: 'done',
      status: 'done',
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('phase.complete', {
      phase: 'codex_response',
      openFindings: 0,
      nextPhase: nextState.phase,
    });
    return nextState;
  }

  const beforeHead = await getHeadCommit(state.cwd);
  let codex;
  try {
    codex = await runCodexResponseRound({
      cwd: state.cwd,
      planDoc: state.planDoc,
      progressMarkdownPath: state.progressMarkdownPath,
      reviewMarkdownPath: state.reviewMarkdownPath,
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
      })),
      threadId: state.codexThreadId,
      logger,
    });
  } catch (error) {
    if (error instanceof CodexRoundError) {
      await persistCodexFailureState(state, statePath, 'codex_response', error, logger);
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
      codexDisposition: response.summary,
      codexCommit: latestCommit,
    };
  });

  const nextState = await saveState(statePath, {
    ...state,
    codexThreadId: codex.threadId,
    findings,
    createdCommits: [...state.createdCommits, ...createdCommits],
    phase: codex.payload.outcome === 'blocked' ? 'blocked' : 'claude_review',
    status: codex.payload.outcome === 'blocked' ? 'blocked' : 'running',
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'codex_response',
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    createdCommits,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const blocker = codex.payload.blocker?.trim() || codex.payload.summary.trim() || 'Codex reported a blocker during review response';
    const persistedState = await persistBlockedScope(nextState, statePath, blocker);
    await notifyBlocked(persistedState, blocker, logger);
    return persistedState;
  }
  return nextState;
}

async function runCodexPlanResponsePhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  if (!state.codexThreadId) {
    throw new Error('Cannot run Codex plan response phase without an existing Codex thread');
  }

  await logger?.event('phase.start', { phase: 'codex_plan_response' });
  const openFindings = state.findings.filter(isOpenBlockingFinding);
  if (openFindings.length === 0) {
    const nextState = await saveState(statePath, {
      ...state,
      phase: 'done',
      status: 'done',
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('phase.complete', {
      phase: 'codex_plan_response',
      openFindings: 0,
      nextPhase: nextState.phase,
    });
    await notifyComplete(nextState, 'Plan review converged', logger);
    return nextState;
  }

  let codex;
  try {
    codex = await runCodexPlanResponseRound({
      cwd: state.cwd,
      planDoc: state.planDoc,
      reviewMarkdownPath: state.reviewMarkdownPath,
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
      })),
      threadId: state.codexThreadId,
      logger,
    });
  } catch (error) {
    if (error instanceof CodexRoundError) {
      await persistCodexFailureState(state, statePath, 'codex_plan_response', error, logger);
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
      codexDisposition: response.summary,
      codexCommit: null,
    };
  });

  const nextState = await saveState(statePath, {
    ...state,
    codexThreadId: codex.threadId,
    findings,
    phase: codex.payload.outcome === 'blocked' ? 'blocked' : 'claude_plan_review',
    status: codex.payload.outcome === 'blocked' ? 'blocked' : 'running',
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'codex_plan_response',
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const blocker = codex.payload.blocker?.trim() || codex.payload.summary.trim() || 'Codex reported a blocker during plan response';
    const persistedState = await persistBlockedScope(nextState, statePath, blocker);
    await notifyBlocked(persistedState, blocker, logger);
    return persistedState;
  }
  return nextState;
}

async function runFinalSquashPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
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
  const finalMessage = latestCreatedCommit
    ? await getCommitMessage(state.cwd, latestCreatedCommit)
    : commitSubjects.at(-1)?.replace(/^[a-f0-9]+\s+/, '') || 'Finalize chunk work';
  const finalSubject = finalMessage.split(/\r?\n/, 1)[0] || 'Finalize chunk work';
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

  const completedScopes = appendCompletedScope(state, 'accepted', {
    finalCommit,
    commitSubject: finalSubject,
    archivedReviewPath,
    blocker: null,
  });
  const retrospectiveState = {
    ...archivedReviewState,
    completedScopes,
  };
  const continueChunked = state.executionMode === 'chunked' && state.lastCodexMarker === 'AUTONOMY_CHUNK_DONE';
  const nextState = await saveState(
    statePath,
    continueChunked
      ? {
          ...state,
          baseCommit: finalCommit,
          finalCommit: null,
          codexThreadId: null,
          currentScopeNumber: state.currentScopeNumber + 1,
          lastCodexMarker: null,
          rounds: [],
          findings: [],
          createdCommits: [],
          completedScopes,
          archivedReviewPath: null,
          phase: 'codex_chunk',
          status: 'running',
        }
      : {
          ...state,
          finalCommit,
          archivedReviewPath,
          completedScopes,
          phase: 'done',
          status: 'done',
        },
  );

  await writeFile(archivedReviewPath, renderReviewMarkdown(archivedReviewState), 'utf8');
  await writeCheckpointRetrospective(retrospectiveState, continueChunked ? 'chunk_accepted' : 'done');
  if (continueChunked) {
    await writeExecutionArtifacts(nextState);
  } else {
    await writeReviewMarkdown(nextState.reviewMarkdownPath, { ...nextState, finalCommit, archivedReviewPath });
    await writePlanProgressArtifacts(nextState);
  }
  await logger?.event('phase.complete', {
    phase: 'final_squash',
    finalCommit,
    archivedReviewPath,
    continueChunked,
  });
  if (continueChunked) {
    await notifyChunkAccepted(state, finalSubject, logger);
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
    onCodexThread?: (threadId: string | null) => void;
  },
) {
  let currentState = state;

  while (
    currentState.phase === 'codex_plan' ||
    currentState.phase === 'claude_plan_review' ||
    currentState.phase === 'codex_plan_response' ||
    currentState.phase === 'codex_chunk' ||
    currentState.phase === 'claude_review' ||
    currentState.phase === 'codex_response' ||
    currentState.phase === 'final_squash'
  ) {
    const stopHeartbeat = startPhaseHeartbeat(currentState.phase, currentState, logger);
    try {
    if (currentState.phase === 'codex_plan') {
      currentState = await runCodexPlanPhase(currentState, statePath, logger);
      options?.onCodexThread?.(currentState.codexThreadId);
      continue;
    }

    if (currentState.phase === 'claude_plan_review') {
      currentState = await runClaudePlanPhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'codex_plan_response') {
      currentState = await runCodexPlanResponsePhase(currentState, statePath, logger);
      options?.onCodexThread?.(currentState.codexThreadId);
      continue;
    }

    if (currentState.phase === 'codex_chunk') {
      currentState = await runCodexPhase(currentState, statePath, logger);
      options?.onCodexThread?.(currentState.codexThreadId);
      continue;
    }

    if (currentState.phase === 'claude_review') {
      currentState = await runClaudePhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'codex_response') {
      currentState = await runCodexResponsePhase(currentState, statePath, logger);
      options?.onCodexThread?.(currentState.codexThreadId);
      continue;
    }

    if (currentState.phase === 'final_squash') {
      currentState = await runFinalSquashPhase(currentState, statePath, logger);
      if (currentState.executionMode === 'chunked' && currentState.phase === 'codex_chunk' && currentState.status === 'running') {
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

export async function loadOrInitialize(
  planDoc: string | null,
  cwd: string,
  resumeStatePath?: string,
  executionMode: ExecutionMode = 'one_shot',
  topLevelMode: 'plan' | 'execute' = 'execute',
) {
  if (resumeStatePath) {
    const state = await loadState(resumeStatePath);
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(resumeStatePath),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      executionMode: state.executionMode,
      runDir: state.runDir,
      resumedFromStatePath: resumeStatePath,
    });
    await logger.event('run.resumed', {
      statePath: resumeStatePath,
      phase: state.phase,
      status: state.status,
    });
    return {
      state,
      statePath: resumeStatePath,
      logger,
    };
  }

  if (!planDoc) {
    throw new Error('planDoc is required when initializing a new orchestration');
  }

  return initializeOrchestration(planDoc, cwd, executionMode, topLevelMode);
}
