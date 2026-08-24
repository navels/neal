import { readFile, rmdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';

import {
  clearDiagnosticFooter,
  configureDiagnosticFooter,
  resetDiagnosticDetailState,
  setDiagnosticDetailContext,
  writeDiagnostic,
  type DiagnosticDetailContext,
} from '../diagnostic.js';
import {
  buildBlockedGuidance,
  renderBlockedGuidanceSections,
  type BlockedGuidance,
} from '../blocked-guidance.js';
import { createInteractiveKeyController, renderInteractiveKeyHint } from '../interactive-controls.js';
import { createRunId, type RunLogger } from '../logger.js';
import { runOnePass } from '../orchestrator.js';
import { writeExecutionArtifacts } from '../orchestrator/artifacts.js';
import {
  countOpenNonBlockingFindings,
  determinePlanRefinementConvergence,
  formatPlanRefinementSummary,
  isPlanRefinementState,
} from '../plan-refinement.js';
import { acquireActiveRunLock, releaseActiveRunLockSync, type ActiveRunLockHandle } from '../run-lock.js';
import { formatPublicRunStatus, getRunDisplayStatus, type RunDisplayStatus } from '../run-status.js';
import { getCurrentScopeLabel } from '../scopes.js';
import { resolveRunStatePath, type RunStatePathSource } from '../run-registry.js';
import { getRunStatePath, loadState, saveState } from '../state.js';
import { getRunDir } from '../storage-paths.js';
import {
  buildSquashCommitMessage,
  buildSquashResultMetadata,
  executeSquashForRun,
  validateSelectedRunForSquash,
  type ExecutedSquashResult,
  type SquashCandidate,
} from '../squash.js';
import { formatPublicPhase, formatStatusNextActionForState } from '../status.js';
import { StatusFooter } from '../status-footer.js';
import { createTerminalNarrator } from '../terminal-narrator.js';
import type { OrchestrationState, TopLevelMode } from '../types.js';

let runLogger: RunLogger | undefined;

export type ExecuteRunResult = {
  finalState: OrchestrationState;
  waitingForOperatorGuidance: boolean;
  waitingForManualGate: boolean;
  stopRequestedAfterScope: boolean;
};

export type ExecuteRunOptions = {
  autoSquashOnCompletion?: boolean;
};

export type PreparedWriterRun = {
  runDir: string;
  runId: string;
  runStatePath: string;
};

export type ResolvedWriterRunSelection = {
  statePath: string;
  state: OrchestrationState;
  selectedRunId: string;
  source: RunStatePathSource;
};

export function getCurrentRunLogger() {
  return runLogger;
}

function warnRunResolution(message: string) {
  writeDiagnostic(`${message}\n`);
}

export async function resolveCliRunStatePath(args: {
  runId: string | null;
}) {
  return resolveRunStatePath({
    cwd: process.cwd(),
    runId: args.runId,
    warn: warnRunResolution,
  });
}

function createPreparedRunDir(cwd: string) {
  return getRunDir(cwd, createRunId());
}

export async function resolveWriterRunSelection(args: {
  cwd?: string;
  runId: string | null;
}): Promise<ResolvedWriterRunSelection> {
  const resolution = await resolveRunStatePath({
    cwd: args.cwd ?? process.cwd(),
    runId: args.runId,
    warn: warnRunResolution,
  });
  const state = await loadState(resolution.statePath);

  return {
    statePath: resolution.statePath,
    state,
    selectedRunId: resolution.runId ?? basename(state.runDir),
    source: resolution.source,
  };
}

export async function withPreparedWriterRun<T>(
  args: {
    cwd: string;
    topLevelMode: TopLevelMode;
    getLockPlanDoc: (prepared: PreparedWriterRun) => string;
  },
  action: (prepared: PreparedWriterRun, markInitialized: () => void) => Promise<T>,
) {
  const runDir = createPreparedRunDir(args.cwd);
  const prepared: PreparedWriterRun = {
    runDir,
    runId: basename(runDir),
    runStatePath: getRunStatePath(runDir),
  };
  const lock = await acquireActiveRunLock({
    cwd: args.cwd,
    runId: prepared.runId,
    runStatePath: prepared.runStatePath,
    planDoc: args.getLockPlanDoc(prepared),
    topLevelMode: args.topLevelMode,
  });

  return withActiveRunLock(lock, async () => {
    let initialized = false;
    try {
      return await action(prepared, () => {
        initialized = true;
      });
    } catch (error) {
      if (!initialized) {
        await removePreparedRunDir(runDir);
      }
      throw error;
    }
  });
}

export async function withActiveRunLock<T>(lock: ActiveRunLockHandle, action: () => Promise<T>) {
  const disarmProcessCleanup = armActiveRunLockProcessCleanup(lock);
  try {
    return await action();
  } finally {
    disarmProcessCleanup();
    await lock.release();
  }
}

function armActiveRunLockProcessCleanup(lock: ActiveRunLockHandle) {
  if (!lock.acquired) {
    return () => {};
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    releaseActiveRunLockSync(lock.lock.cwd, lock.lock.runId);
  };
  const onSigint = () => {
    cleanup();
    disarm();
    process.kill(process.pid, 'SIGINT');
  };
  const onSigterm = () => {
    cleanup();
    disarm();
    process.kill(process.pid, 'SIGTERM');
  };
  const disarm = () => {
    process.off('exit', cleanup);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };

  process.once('exit', cleanup);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return () => {
    disarm();
    cleanup();
  };
}

async function removeDirectoryIfEmpty(path: string) {
  try {
    await rmdir(path);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null;
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
      return;
    }
    throw error;
  }
}

async function removePreparedRunDir(runDir: string) {
  await rm(runDir, { recursive: true, force: true });
  await removeDirectoryIfEmpty(dirname(runDir));
  await removeDirectoryIfEmpty(dirname(dirname(runDir)));
}

function getActiveHandleSummary() {
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  const getActiveRequests = (process as typeof process & { _getActiveRequests?: () => unknown[] })._getActiveRequests;
  const activeResourcesInfo = 'getActiveResourcesInfo' in process ? process.getActiveResourcesInfo?.() ?? [] : [];
  const handles = getActiveHandles ? getActiveHandles.call(process) : [];
  const requests = getActiveRequests ? getActiveRequests.call(process) : [];

  return {
    resourceTypes: Array.from(new Set(activeResourcesInfo)).sort(),
    handles: handles.map(summarizeActiveEntry),
    requests: requests.map(summarizeActiveEntry),
  };
}

function summarizeActiveEntry(entry: unknown) {
  if (!entry || typeof entry !== 'object') {
    return { type: typeof entry };
  }

  const candidate = entry as {
    constructor?: { name?: string };
    fd?: unknown;
    path?: unknown;
    bytesRead?: unknown;
    bytesWritten?: unknown;
    pending?: unknown;
    readable?: unknown;
    writable?: unknown;
    connecting?: unknown;
    destroyed?: unknown;
    localAddress?: unknown;
    localPort?: unknown;
    remoteAddress?: unknown;
    remotePort?: unknown;
  };

  return {
    type: candidate.constructor?.name ?? 'unknown',
    fd: typeof candidate.fd === 'number' ? candidate.fd : undefined,
    path: typeof candidate.path === 'string' ? candidate.path : undefined,
    pending: typeof candidate.pending === 'boolean' ? candidate.pending : undefined,
    readable: typeof candidate.readable === 'boolean' ? candidate.readable : undefined,
    writable: typeof candidate.writable === 'boolean' ? candidate.writable : undefined,
    connecting: typeof candidate.connecting === 'boolean' ? candidate.connecting : undefined,
    destroyed: typeof candidate.destroyed === 'boolean' ? candidate.destroyed : undefined,
    bytesRead: typeof candidate.bytesRead === 'number' ? candidate.bytesRead : undefined,
    bytesWritten: typeof candidate.bytesWritten === 'number' ? candidate.bytesWritten : undefined,
    localAddress: typeof candidate.localAddress === 'string' ? candidate.localAddress : undefined,
    localPort: typeof candidate.localPort === 'number' ? candidate.localPort : undefined,
    remoteAddress: typeof candidate.remoteAddress === 'string' ? candidate.remoteAddress : undefined,
    remotePort: typeof candidate.remotePort === 'number' ? candidate.remotePort : undefined,
  };
}

function armShutdownWatchdog(finalState: OrchestrationState, logger: RunLogger) {
  const armedAt = Date.now();
  const timeout = setTimeout(() => {
    const elapsedMs = Date.now() - armedAt;
    const active = getActiveHandleSummary();
    const resourceSummary = active.resourceTypes.length > 0 ? active.resourceTypes.join(', ') : '(none reported)';
    writeDiagnostic(
      `[neal:debug] process still alive ${elapsedMs}ms after final output; active resources: ${resourceSummary}\n`,
      logger,
    );
    void logger.event('shutdown.hang_detected', {
      elapsedMs,
      phase: finalState.phase,
      status: finalState.status,
      topLevelMode: finalState.topLevelMode,
      runDir: finalState.runDir,
      activeResources: active,
    });
  }, 5000);
  timeout.unref();

  return async () => {
    clearTimeout(timeout);
    await logger.event('shutdown.watchdog_cleared', {
      phase: finalState.phase,
      status: finalState.status,
      runDir: finalState.runDir,
    });
  };
}

function formatFinalSummaryLine(finalState: OrchestrationState, publicStatus: string) {
  if (publicStatus === 'waiting_for_manual_gate') {
    const gate = finalState.manualGate;
    return gate
      ? `Run is waiting for manual gate ${gate.id}: ${gate.title}.`
      : 'Run is waiting for a manual gate.';
  }
  if (publicStatus === 'paused') {
    return 'Run paused after the current scope.';
  }
  if (publicStatus === 'waiting_for_guidance') {
    return 'Run is waiting for guidance.';
  }
  if (publicStatus === 'failed') {
    return 'Run failed.';
  }
  if (publicStatus === 'blocked') {
    return 'Run is blocked.';
  }
  if (publicStatus === 'done') {
    if (finalState.topLevelMode === 'plan') {
      return 'Plan refinement complete.';
    }
    return 'Implementation complete.';
  }
  return 'Run stopped before terminal completion.';
}

function countFinalFindings(finalState: OrchestrationState) {
  const openBlocking = finalState.findings.filter(
    (finding) => finding.severity === 'blocking' && finding.status === 'open',
  ).length;
  const openNonBlocking = finalState.findings.filter(
    (finding) =>
      finding.severity === 'non_blocking' &&
      (finding.status === 'open' || finding.status === 'deferred'),
  ).length;

  return {
    total: finalState.findings.length,
    openBlocking,
    openNonBlocking,
  };
}

function formatFinalNextAction(
  finalState: OrchestrationState,
  displayStatus: RunDisplayStatus,
  runId: string,
  guidance: BlockedGuidance | null,
) {
  if (displayStatus.effectiveStatus === 'waiting_for_manual_gate') {
    return `Complete manual gate ${finalState.manualGate?.id ?? 'unknown'}, then resume this run: neal resume --run ${runId}`;
  }
  if (displayStatus.waitingForOperatorGuidance) {
    const firstOption = guidance?.options[0]?.command;
    if (firstOption) {
      return `Use the first resume option above: ${firstOption}; inspect guidance with: neal status --run ${runId}`;
    }
    return `Inspect waiting run: neal status --run ${runId}; provide guidance: neal resume --run ${runId} --message "..."`;
  }
  if (displayStatus.pendingOperatorGuidance) {
    return `Inspect pending guidance: neal status --run ${runId}; resume with pending guidance: neal resume --run ${runId}`;
  }
  if (finalState.status === 'failed') {
    return `Inspect failure: neal status --run ${runId}; resume when ready: neal resume --run ${runId}`;
  }
  if (finalState.status === 'blocked') {
    return `Inspect blocked run: neal status --run ${runId}; provide guidance with neal resume --run ${runId} --message "..." only if the run is waiting for operator guidance`;
  }
  if (displayStatus.effectiveStatus === 'paused') {
    return `Resume this run: neal resume --run ${runId}`;
  }
  if (finalState.status === 'done') {
    return `No action required. Inspect status with: neal status --run ${runId}`;
  }
  return `Continue this run: neal resume --run ${runId}`;
}

export function renderFinalRunOutput(
  finalState: OrchestrationState,
  statePath: string,
  displayStatus: RunDisplayStatus,
  autoSquashResult: ExecutedSquashResult | null = null,
) {
  const runId = basename(finalState.runDir);
  const publicStatus = formatPublicRunStatus(displayStatus);
  const findings = countFinalFindings(finalState);
  const lines = [
    '# Neal Run Result',
    '',
    formatFinalSummaryLine(finalState, publicStatus),
    '',
    `- Run: ${runId}`,
    `- Plan: ${finalState.planDoc}`,
    `- Mode: ${finalState.topLevelMode}`,
    `- Status: ${publicStatus}`,
    `- Step: ${formatPublicPhase(finalState.phase)}`,
    `- Persisted status: ${finalState.status}`,
    `- Waiting for operator guidance: ${displayStatus.waitingForOperatorGuidance ? 'yes' : 'no'}`,
    `- Pending operator guidance: ${displayStatus.pendingOperatorGuidance ? 'yes' : 'no'}`,
    `- Final commit: ${finalState.finalCommit ?? 'n/a'}`,
    `- Squash commit: ${autoSquashResult?.replacementCommit ?? 'n/a'}`,
    `- Completed scopes: ${finalState.completedScopes.length}`,
    `- Open findings: ${findings.openBlocking} blocking, ${findings.openNonBlocking} non-blocking (${findings.total} total)`,
    '',
    '## Artifacts',
    `- Run state: ${statePath}`,
    `- Run directory: ${finalState.runDir}`,
    `- Events: ${join(finalState.runDir, 'events.ndjson')}`,
    `- Progress: ${finalState.progressMarkdownPath}`,
    `- Review: ${finalState.reviewMarkdownPath}`,
    `- Retrospective: ${join(finalState.runDir, 'RETROSPECTIVE.md')}`,
  ];

  if (autoSquashResult) {
    lines.push(`- Squash result: ${autoSquashResult.artifactPath}`);
  }

  if (finalState.archivedReviewPath) {
    lines.push(`- Archived review: ${finalState.archivedReviewPath}`);
  }

  if (finalState.phase === 'manual_gate' && finalState.manualGate) {
    lines.push(
      '',
      '## Manual Gate',
      `- ID: ${finalState.manualGate.id}`,
      `- Title: ${finalState.manualGate.title}`,
      `- Reason: ${finalState.manualGate.reason}`,
      `- Instructions: ${finalState.manualGate.instructionsPath}`,
      `- Last checked: ${finalState.manualGate.lastCheckedAt ?? 'never'}`,
    );
  }

  const guidance = buildBlockedGuidance({
    state: finalState,
    runId,
    waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
  });
  if (guidance) {
    lines.push('', ...renderBlockedGuidanceSections(guidance));
  }

  lines.push('', '## Next Action', `- ${formatFinalNextAction(finalState, displayStatus, runId, guidance)}`);

  return lines.join('\n');
}

function toSquashCandidate(state: OrchestrationState): SquashCandidate {
  return {
    runDir: state.runDir,
    runId: basename(state.runDir),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    initialBaseCommit: state.initialBaseCommit,
    baseCommit: state.baseCommit,
    finalCommit: state.finalCommit,
    createdCommits: [...state.createdCommits],
    acceptedScopeCount: state.completedScopes.filter((scope) => scope.result === 'accepted').length,
  };
}

async function hasCompletedSquashArtifact(runDir: string) {
  try {
    const parsed = JSON.parse(await readFile(join(runDir, 'SQUASH_RESULT.json'), 'utf8')) as {
      status?: unknown;
      replacementCommit?: unknown;
    };
    return parsed.status === 'complete' && typeof parsed.replacementCommit === 'string';
  } catch {
    return false;
  }
}

async function maybeAutoSquashCompletedRun(
  finalState: OrchestrationState,
  logger: RunLogger,
  options: ExecuteRunOptions,
): Promise<ExecutedSquashResult | null> {
  if (!options.autoSquashOnCompletion || finalState.topLevelMode !== 'execute' || finalState.status !== 'done') {
    return null;
  }
  if (!finalState.finalCommit || (finalState.initialBaseCommit ?? finalState.baseCommit) === finalState.finalCommit) {
    return null;
  }
  if (await hasCompletedSquashArtifact(finalState.runDir)) {
    return null;
  }

  const selected = toSquashCandidate(finalState);
  const validation = await validateSelectedRunForSquash({
    cwd: finalState.cwd,
    selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: finalState.cwd,
    selected,
  });
  const metadata = await buildSquashResultMetadata({
    cwd: finalState.cwd,
    selected,
    validation,
    commitMessage,
  });
  await logger.event('squash.auto_start', {
    runDir: finalState.runDir,
    finalCommit: finalState.finalCommit,
    commitMessageSource: metadata.commitMessageSource,
    planDocDisposition: metadata.planDocDisposition,
  });
  writeDiagnostic('[neal] auto-squashing completed run\n', logger);
  const result = await executeSquashForRun({
    cwd: finalState.cwd,
    selected,
    validation,
    commitMessage,
  });
  await logger.event('squash.auto_complete', {
    runDir: finalState.runDir,
    replacementCommit: result.replacementCommit,
    finalHeadCommit: result.finalHeadCommit,
    artifactPath: result.artifactPath,
    commitMessageSource: result.artifact.metadata.commitMessageSource,
    planDocDisposition: result.artifact.metadata.planDocDisposition,
  });
  writeDiagnostic(`[neal] auto-squash complete: ${result.replacementCommit}\n`, logger);
  return result;
}

export async function executeRun(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger,
  options: ExecuteRunOptions = {},
): Promise<ExecuteRunResult> {
  runLogger = logger;
  let currentDetailContext = getDiagnosticDetailContextForState(state);
  resetDiagnosticDetailState(currentDetailContext);
  const footer = new StatusFooter();
  configureDiagnosticFooter(footer);
  let displayedPhaseStartedAt = Date.now();
  await footer.setState(state, displayedPhaseStartedAt);
  const narrator = createTerminalNarrator({ logger });
  await narrator.start(state);
  const allowStopRequest = state.topLevelMode === 'execute';
  const stopController = createInteractiveKeyController({
    allowStopRequest,
    getDetailFilter() {
      return currentDetailContext;
    },
  });

  try {
    if (process.stdin.isTTY) {
      writeDiagnostic(renderInteractiveKeyHint(allowStopRequest));
    }

    let finalState;
    try {
      try {
        finalState = await runOnePass(state, statePath, logger, {
          shouldStopAfterCurrentScope() {
            return stopController.isStopRequested();
          },
          onDisplayState(nextState, phaseStartedAt) {
            displayedPhaseStartedAt = phaseStartedAt;
            currentDetailContext = getDiagnosticDetailContextForState(nextState);
            setDiagnosticDetailContext(currentDetailContext);
            return footer.setState(nextState, phaseStartedAt).then(() => {
              return narrator.observe(nextState);
            });
          },
        });
      } catch (error) {
        finalState = await loadFailedWriterResultAfterRunError({
          statePath,
          initialState: state,
        });
        if (!finalState) {
          throw error;
        }
      }
    } finally {
      stopController.cleanup();
    }

    currentDetailContext = getDiagnosticDetailContextForState(finalState);
    setDiagnosticDetailContext(currentDetailContext);
    await footer.setState(finalState, displayedPhaseStartedAt);
    await narrator.observe(finalState);

    const pausedAfterScope = stopController.isStopRequested() && isStillRunningAtScopeBoundary(finalState);
    if (pausedAfterScope) {
      finalState = await persistPausedAfterScopeState(finalState, statePath);
      currentDetailContext = getDiagnosticDetailContextForState(finalState);
      setDiagnosticDetailContext(currentDetailContext);
      await footer.setState(finalState, displayedPhaseStartedAt);
      await narrator.observe(finalState);
    }

    const displayStatus = getRunDisplayStatus(finalState);
    const waitingForOperatorGuidance = displayStatus.waitingForOperatorGuidance;
    const waitingForManualGate = displayStatus.effectiveStatus === 'waiting_for_manual_gate';
    const autoSquashResult = await maybeAutoSquashCompletedRun(finalState, logger, options);

    if (waitingForOperatorGuidance) {
      await footer.setState(finalState, displayedPhaseStartedAt);
      await narrator.observe(finalState);
    }

    await logger.event('shutdown.final_output_begin', {
      phase: finalState.phase,
      status: finalState.status,
      effectiveStatus: displayStatus.effectiveStatus,
      waitingForOperatorGuidance,
      waitingForManualGate,
      pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
      shouldResumeLastThread: false,
      lastCoderSessionHandle: finalState.coderSessionHandle,
      runDir: finalState.runDir,
    });

    clearDiagnosticFooter();
    await logger.event('shutdown.footer_cleared', {
      phase: finalState.phase,
      status: finalState.status,
      runDir: finalState.runDir,
    });

    const finalOutput = renderFinalRunOutput(finalState, statePath, displayStatus, autoSquashResult);
    process.stdout.write(finalOutput.trimEnd() + '\n');

    await logger.event('shutdown.final_output_written', {
      phase: finalState.phase,
      status: finalState.status,
      effectiveStatus: displayStatus.effectiveStatus,
      waitingForOperatorGuidance,
      waitingForManualGate,
      pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
      runDir: finalState.runDir,
    });

    if (isPlanRefinementState(finalState)) {
      const convergenceReason = determinePlanRefinementConvergence(finalState);
      if (convergenceReason !== null) {
        const summary = formatPlanRefinementSummary({
          rounds: finalState.rounds.length,
          backupPath: finalState.planDocBackupPath,
          convergenceReason,
          residualNonBlocking: countOpenNonBlockingFindings(finalState),
        });
        writeDiagnostic(`${summary}\n`);
        await logger.event('plan_refinement.summary', {
          rounds: finalState.rounds.length,
          backupPath: finalState.planDocBackupPath,
          convergenceReason,
          residualNonBlocking: countOpenNonBlockingFindings(finalState),
        });
      }
    }

    const clearShutdownWatchdog = armShutdownWatchdog(finalState, logger);

    await clearShutdownWatchdog();

    return {
      finalState,
      waitingForOperatorGuidance,
      waitingForManualGate,
      stopRequestedAfterScope: pausedAfterScope,
    };
  } finally {
    stopController.cleanup();
    resetDiagnosticDetailState();
  }
}

function isStillRunningAtScopeBoundary(state: OrchestrationState) {
  return state.status === 'running' && state.phase === 'coder_scope';
}

async function persistPausedAfterScopeState(state: OrchestrationState, statePath: string) {
  const pausedState = await saveState(statePath, {
    ...state,
    status: 'paused',
  });
  await writeExecutionArtifacts(pausedState);
  return pausedState;
}

async function loadFailedWriterResultAfterRunError(args: {
  statePath: string;
  initialState: OrchestrationState;
}): Promise<OrchestrationState | null> {
  let persistedState;
  try {
    persistedState = await loadState(args.statePath);
  } catch {
    return null;
  }

  if (persistedState.runDir !== args.initialState.runDir || persistedState.status !== 'failed') {
    return null;
  }

  const stateWasUpdated =
    persistedState.status !== args.initialState.status ||
    persistedState.phase !== args.initialState.phase ||
    persistedState.updatedAt !== args.initialState.updatedAt ||
    persistedState.coderSessionHandle !== args.initialState.coderSessionHandle ||
    persistedState.reviewerSessionHandle !== args.initialState.reviewerSessionHandle;
  return stateWasUpdated ? persistedState : null;
}

function getDiagnosticDetailContextForState(state: OrchestrationState): DiagnosticDetailContext {
  return {
    runId: basename(state.runDir),
    phase: state.phase,
    scopeLabel: getCurrentScopeLabel(state),
    scopeNumber: state.currentScopeNumber,
  };
}
