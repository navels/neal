import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { notify } from '../notifier.js';
import { runClaudeReviewRound, runCodexChunkRound, runCodexResponseRound } from './agents.js';
import { getChangedFilesForRange, getCommitRange, getCommitSubjects, getDiffForRange, getDiffStatForRange, getHeadCommit, getWorktreeStatus, squashCommits } from './git.js';
import { createRunLogger, type RunLogger } from './logger.js';
import { renderReviewMarkdown, writeReviewMarkdown, writeReviewPointer } from './review.js';
import { createInitialState, getSessionStatePath, loadState, saveState } from './state.js';
import type { ExecutionMode, FindingStatus, OrchestrationState, OrchestratorInit, ReviewFinding } from './types.js';

const MAX_INLINE_DIFF_FILES = Number(process.env.CLAUDE_INLINE_DIFF_FILE_LIMIT ?? 40);

export async function initializeOrchestration(planDoc: string, cwd: string, executionMode: ExecutionMode) {
  const absolutePlanDoc = resolve(planDoc);
  const stateDir = join(cwd, '.forge');
  const reviewMarkdownPath = join(cwd, 'REVIEW.md');
  const logger = await createRunLogger({
    cwd,
    stateDir,
    planDoc: absolutePlanDoc,
    executionMode,
  });

  const init: OrchestratorInit = {
    cwd,
    planDoc: absolutePlanDoc,
    stateDir,
    runDir: logger.runDir,
    reviewMarkdownPath,
    maxRounds: 3,
    executionMode,
  };

  await mkdir(stateDir, { recursive: true });

  const baseCommit = await getHeadCommit(cwd);
  const initialState = await createInitialState(init, baseCommit);
  const statePath = getSessionStatePath(stateDir);
  const savedState = await saveState(statePath, initialState);
  await writeReviewMarkdown(reviewMarkdownPath, savedState);
  await logger.event('run.initialized', {
    statePath,
    baseCommit,
    reviewMarkdownPath,
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
  await notify('blocked', `[forge] ${planName}: ${reason}`);
}

async function notifyComplete(state: OrchestrationState, message: string, logger?: RunLogger) {
  const planName = basename(state.planDoc);
  await logger?.event('notify.complete', { message, planName });
  await notify('complete', `[forge] ${planName}: ${message}`);
  await notify('done', message);
}

function filterWrapperOwnedWorktreeStatus(statusOutput: string) {
  const ignoredPaths = new Set(['.forge/session.json', '.codex-claude-chunked/session.json', 'REVIEW.md']);

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
  const codex = await runCodexChunkRound({
    cwd: state.cwd,
    planDoc: state.planDoc,
    executionMode: state.executionMode,
    threadId: state.codexThreadId,
    logger,
  });
  const afterHead = await getHeadCommit(state.cwd);
  const createdCommits = await getCommitRange(state.cwd, beforeHead, afterHead);

  const nextState = await saveState(statePath, {
    ...state,
    codexThreadId: codex.threadId,
    phase: codex.marker === 'AUTONOMY_BLOCKED' ? 'blocked' : 'claude_review',
    status: codex.marker === 'AUTONOMY_BLOCKED' ? 'blocked' : 'running',
    createdCommits: [...state.createdCommits, ...createdCommits],
  });

  await writeReviewMarkdown(nextState.reviewMarkdownPath, nextState);
  await logger?.event('phase.complete', {
    phase: 'codex_chunk',
    executionMode: state.executionMode,
    marker: codex.marker,
    threadId: codex.threadId,
    createdCommits,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    await notifyBlocked(nextState, 'Codex reported a blocker during chunk execution', logger);
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
  const claude = await runClaudeReviewRound({
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

  await writeReviewMarkdown(nextState.reviewMarkdownPath, nextState);
  await logger?.event('phase.complete', {
    phase: 'claude_review',
    round,
    sessionId: claude.sessionId,
    findings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && blockReason) {
    await notifyBlocked(nextState, blockReason, logger);
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
    await writeReviewMarkdown(nextState.reviewMarkdownPath, nextState);
    await logger?.event('phase.complete', {
      phase: 'codex_response',
      openFindings: 0,
      nextPhase: nextState.phase,
    });
    return nextState;
  }

  const beforeHead = await getHeadCommit(state.cwd);
  const codex = await runCodexResponseRound({
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

  await writeReviewMarkdown(nextState.reviewMarkdownPath, nextState);
  await logger?.event('phase.complete', {
    phase: 'codex_response',
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    createdCommits,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const blocker = codex.payload.blocker?.trim() || codex.payload.summary.trim() || 'Codex reported a blocker during review response';
    await notifyBlocked(nextState, blocker, logger);
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
  const finalMessage = commitSubjects.at(-1)?.replace(/^[a-f0-9]+\s+/, '') || 'Finalize chunk work';
  const finalCommit =
    state.createdCommits.length > 0
      ? await squashCommits(state.cwd, state.baseCommit, finalMessage)
      : headCommit;

  const notesDir = join(state.cwd, 'notes');
  await mkdir(notesDir, { recursive: true });
  const archivedReviewPath = join(notesDir, `REVIEW-${finalCommit}.md`);

  const nextState = await saveState(statePath, {
    ...state,
    finalCommit,
    archivedReviewPath,
    phase: 'done',
    status: 'done',
  });

  await writeFile(archivedReviewPath, renderReviewMarkdown(nextState), 'utf8');
  await writeReviewPointer(nextState.reviewMarkdownPath, nextState);
  await logger?.event('phase.complete', {
    phase: 'final_squash',
    finalCommit,
    archivedReviewPath,
  });
  await notifyComplete(nextState, finalMessage, logger);

  return nextState;
}

export async function runOnePass(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  let currentState = state;

  while (
    currentState.phase === 'codex_chunk' ||
    currentState.phase === 'claude_review' ||
    currentState.phase === 'codex_response' ||
    currentState.phase === 'final_squash'
  ) {
    if (currentState.phase === 'codex_chunk') {
      currentState = await runCodexPhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'claude_review') {
      currentState = await runClaudePhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'codex_response') {
      currentState = await runCodexResponsePhase(currentState, statePath, logger);
      continue;
    }

    if (currentState.phase === 'final_squash') {
      currentState = await runFinalSquashPhase(currentState, statePath, logger);
    }
  }

  await logger?.event('run.complete', {
    phase: currentState.phase,
    status: currentState.status,
    finalCommit: currentState.finalCommit,
    archivedReviewPath: currentState.archivedReviewPath,
  });
  return currentState;
}

export async function loadOrInitialize(
  planDoc: string | null,
  cwd: string,
  resumeStatePath?: string,
  executionMode: ExecutionMode = 'one_shot',
) {
  if (resumeStatePath) {
    const state = await loadState(resumeStatePath);
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(resumeStatePath),
      planDoc: state.planDoc,
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

  return initializeOrchestration(planDoc, cwd, executionMode);
}
