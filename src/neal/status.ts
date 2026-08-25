import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import {
  getPlanAndExecuteQueueSummaryPath,
  inspectQueueChildResumeEvidence,
  loadPlanAndExecuteQueueState,
  readQueueChildLink,
  resolveQueueStoredPath,
  type PlanAndExecuteQueueItemStatus,
  type PlanAndExecuteQueueStatus,
  type QueueChildStage,
} from './plan-queue.js';
import {
  buildBlockedGuidance,
  renderBlockedGuidanceSections,
  type BlockedGuidance,
} from './blocked-guidance.js';
import { formatMaybePublicPhase, formatPublicPhase } from './phase-display.js';
import { decideResumeAction, type ResumeDecision, type ResumeLockEvidence } from './resume-decision.js';
import { getChangedFilesForRange, getCommitRange } from './git.js';
import { inspectActiveRunLock } from './run-lock.js';
import { listRuns } from './run-registry.js';
import { formatPublicRunStatus, getRunDisplayStatus, type EffectiveRunStatus, type RunDisplayStatus } from './run-status.js';
import { getRunStatePath, loadState } from './state.js';
import { getDerivedPlanView } from './state-views.js';
import { largestSectionNameFromInputTooLargeMessage } from './providers/input-budget.js';
import type { NealProviderErrorKind, ProviderRole } from './providers/types.js';
import type { SquashResultArtifact } from './squash.js';
import type { OrchestrationState, PlanReviewFindingClass, ResidualReviewDebtItem } from './types.js';
import { getNealBuildMetadata, type NealBuildMetadata } from './version.js';

export { formatPublicPhase } from './phase-display.js';

export type NealHealthClassification =
  | 'ok'
  | 'stale'
  | 'quiet'
  | 'heartbeat_only'
  | 'timed_out'
  | 'blocked'
  | 'paused'
  | 'unknown';

export type NealStatusSnapshot = {
  ok: true;
  runId: string;
  cwd: string;
  statePath: string;
  runDir: string;
  planDoc: string;
  topLevelMode: OrchestrationState['topLevelMode'];
  executionShape: OrchestrationState['executionShape'];
  phase: OrchestrationState['phase'];
  publicPhase: string;
  status: OrchestrationState['status'];
  effectiveStatus: EffectiveRunStatus;
  publicStatus: string;
  nextAction: string;
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
  blockedGuidance: BlockedGuidance | null;
  blocker: NealBlockerStatusSummary;
  manualGate: NealManualGateStatusSummary | null;
  resumeDecision: ResumeDecision;
  currentScopeNumber: number;
  plannerSessionHandle: string | null;
  coderSessionHandle: string | null;
  reviewerSessionHandle: string | null;
  coderRetryCount: number;
  rounds: number;
  createdCommits: number;
  completedScopes: number;
  lastEventAt: string | null;
  lastMeaningfulEventAt: string | null;
  lastCoderEventAt: string | null;
  lastReviewerEventAt: string | null;
  lastMeaningfulEvent: {
    type: string;
    summary: string;
  } | null;
  lock: NealLockStatusSummary;
  health: {
    classification: NealHealthClassification;
    phaseElapsedMs: number | null;
    quietMs: number | null;
    heartbeatOnly: boolean;
    reason: string;
  };
  findings: {
    total: number;
    openBlocking: number;
    openNonBlocking: number;
    fixed: number;
    rejected: number;
    deferred: number;
  };
  planReviewDebt: {
    total: number;
    items: {
      canonicalId: string;
      findingClass: PlanReviewFindingClass | null;
      originRound: number | null;
      inherited: boolean;
    }[];
  };
  commits: NealCommitStatusSummary;
  squash: NealSquashStatusSummary;
  providerError: NealProviderErrorStatusSummary | null;
  finalCompletionStaleness: NealFinalCompletionStalenessSummary;
  build: NealBuildStatusSummary;
  patch: NealPatchStatusSummary;
  derivedPlan: {
    path: string;
    parentScopeNumber: number | null;
    status: OrchestrationState['derivedPlanStatus'];
    scopeIndex: number | null;
    reviewActive: boolean;
    acceptedAwaitingExecution: boolean;
    executing: boolean;
    abandoned: boolean;
  } | null;
  queue?: {
    queueId: string;
    queueStatePath: string;
    itemIndex: number;
    itemCount: number;
    stage: QueueChildStage;
    queueStatus: PlanAndExecuteQueueStatus;
    itemStatus: PlanAndExecuteQueueItemStatus;
    requestedPlanPath: string;
  };
  events: {
    path: string;
    exists: boolean;
    parsedLines: number;
    malformedLines: number;
    truncated: boolean;
  };
  artifacts: {
    runStatePath: string;
    eventsPath: string;
    runNarrativeMarkdownPath: string;
    latestRetrospectiveMarkdownPath: string | null;
    reviewMarkdownPath: string;
    progressJsonPath: string;
    progressMarkdownPath: string;
    recoveryMarkdownPath: string;
    queueSummaryMarkdownPath: string | null;
    archivedReviewPath: string | null;
    invalidDerivedPlanPayloadPath: string | null;
  };
};

export type NealBlockerStatusSummary = {
  active: boolean;
  reason: string | null;
  source: string | null;
  artifactPaths: Array<{ label: string; path: string }>;
};

export type NealManualGateStatusSummary = {
  id: string;
  title: string;
  reason: string;
  instructionsPath: string;
  lastCheckedAt: string | null;
  lastFailure: NonNullable<OrchestrationState['manualGate']>['lastFailure'];
  resumeCommand: string;
};

export type NealCommitStatusSummary = {
  initialBaseCommit: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  createdCommitCount: number;
  acceptedScopeFinalCommits: string[];
};

export type NealSquashStatusSummary = {
  artifactPath: string;
  status: 'missing' | 'pending' | 'complete' | 'malformed';
  replacementCommit: string | null;
  finalHeadCommit: string | null;
  originalBaseCommit: string | null;
  originalFinalCommit: string | null;
  unavailableReason: string | null;
};

export type NealProviderErrorStatusSummary = {
  source: 'provider_event' | 'phase_error';
  timestamp: string;
  provider: string | null;
  role: ProviderRole | null;
  label: string | null;
  sessionHandle: string | null;
  kind: NealProviderErrorKind | null;
  message: string;
  retryable: boolean | null;
  diagnostic: Record<string, unknown> | null;
};

export type NealFinalCompletionStalenessSummary = {
  stale: boolean;
  reason: string | null;
  reviewerOutputObserved: boolean;
  finalCompletionPhaseStartedAt: string | null;
  lastFinalCompletionReviewerOutputAt: string | null;
  finalCompletionPhaseTerminalEventObserved: boolean;
};

export type NealBuildStatusSummary = NealBuildMetadata & {
  source: 'meta' | 'live_fallback';
  agentConfig: OrchestrationState['agentConfig'];
};

export type NealPatchStatusSummary = {
  defaultSubmissionEligible: boolean;
  reason: string;
  source: 'squash_replacement' | 'final_commit' | 'none';
  baseCommit: string | null;
  headCommit: string | null;
  range: string | null;
  commitCount: number | null;
  changedFileCount: number | null;
  changedFiles: string[];
  unavailableReason: string | null;
};

export type NealLockStatusSummary = ResumeLockEvidence;

export type NealStatusListRun = {
  runId: string;
  runDir: string;
  statePath: string;
  planDoc: string;
  topLevelMode: OrchestrationState['topLevelMode'];
  executionShape: OrchestrationState['executionShape'];
  status: OrchestrationState['status'];
  effectiveStatus: EffectiveRunStatus;
  publicStatus: string;
  phase: OrchestrationState['phase'];
  publicPhase: string;
  currentScopeNumber: number;
  waitingForOperatorGuidance: boolean;
  pendingOperatorGuidance: boolean;
  manualGate: NealManualGateStatusSummary | null;
  commits: NealCommitStatusSummary;
  squash: NealSquashStatusSummary;
  providerError: NealProviderErrorStatusSummary | null;
  finalCompletionStaleness: NealFinalCompletionStalenessSummary;
  build: NealBuildStatusSummary;
  patch: NealPatchStatusSummary;
  lock: NealLockStatusSummary;
  createdAt: string;
  updatedAt: string;
  nextAction: string;
  artifacts: NealStatusSnapshot['artifacts'];
};

export type NealStatusListSnapshot = {
  ok: true;
  cwd: string;
  runs: NealStatusListRun[];
};

type NealRunEvent = {
  ts?: unknown;
  type?: unknown;
  data?: Record<string, unknown>;
};

type ParsedEvent = {
  ts: string;
  timeMs: number;
  type: string;
  data: Record<string, unknown>;
};

type EventTail = {
  path: string;
  exists: boolean;
  parsedLines: number;
  malformedLines: number;
  truncated: boolean;
  events: ParsedEvent[];
};

const EVENT_TAIL_BYTES = 256 * 1024;
const STATUS_ERROR_MESSAGE_MAX_LENGTH = 1000;
export const OK_MEANINGFUL_EVENT_MS = 2 * 60 * 1000;
export const QUIET_WARNING_MS = 5 * 60 * 1000;

const PROVIDER_ERROR_KINDS = new Set<NealProviderErrorKind>([
  'timeout',
  'no_progress_timeout',
  'api_error',
  'structured_output_missing',
  'structured_output_invalid',
  'permission_denied',
  'session_unavailable',
  'content_refused',
  'input_too_large',
  'provider_failed',
  'unknown',
]);

const MEANINGFUL_EVENT_TYPES = new Set([
  'coder.thread_started',
  'coder.turn_started',
  'coder.item_started',
  'coder.item_updated',
  'coder.command_execution',
  'coder.file_change',
  'coder.turn_completed',
  'advisor.assistant_text',
  'advisor.task_started',
  'advisor.task_progress',
  'advisor.result',
  'provider.session_started',
  'provider.turn_started',
  'provider.turn_completed',
  'provider.tool_started',
  'provider.tool_progress',
  'provider.command_completed',
  'provider.file_changed',
  'provider.assistant_text',
  'provider.assistant_thinking',
  'provider.structured_output_received',
  'provider.provider_error',
  'provider.turn_liveness_timeout',
  'provider.turn_liveness_retry',
  'provider.turn_liveness_give_up',
  'review.meaningful_progress.advance_parent',
  'execute_finalization.advance_parent',
  'phase.start',
  'phase.complete',
  'phase.retry',
  'run.paused_after_scope',
]);
const STATUS_INTERNAL_EVENT_TYPES = new Set(['narrative.updated']);

export async function buildStatusSnapshot(args: {
  cwd: string;
  statePath: string;
  now?: Date;
}): Promise<NealStatusSnapshot> {
  const statePath = isAbsolute(args.statePath) ? args.statePath : resolve(args.cwd, args.statePath);
  const state = await loadState(statePath);
  const eventsPath = join(state.runDir, 'events.ndjson');
  const tail = await readEventTail(eventsPath);
  const nowMs = (args.now ?? new Date()).getTime();
  const eventSummary = summarizeEvents(tail.events);
  const queue = await summarizeLinkedQueue(state.runDir, state.cwd);
  const displayStatus = getRunDisplayStatus(state);
  const latestRetrospectiveMarkdownPath = await findLatestRetrospectiveMarkdownPath(state.runDir);
  const invalidDerivedPlanPayloadPath = await findCurrentInvalidSplitPlanPayloadArtifactPath(state);
  const runId = basename(state.runDir);
  const blockedGuidance = buildBlockedGuidance({
    state,
    runId,
    waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
  });
  const blocker = summarizeBlocker(state, tail.events, invalidDerivedPlanPayloadPath, blockedGuidance);
  const lock = await inspectActiveRunLock(state.cwd, runId);
  const finalCompletionStaleness = classifyFinalCompletionStaleness({
    state,
    events: tail.events,
    eventSummary,
    nowMs,
    lock,
  });
  const queueResumeEvidence = await inspectQueueChildResumeEvidence({ cwd: state.cwd, runDir: state.runDir });
  const resumeDecision = decideResumeAction({
    state,
    selectedRunId: runId,
    statePath,
    lock,
    queue: queueResumeEvidence,
    retrospectivePath: latestRetrospectiveMarkdownPath,
  });
  const queueSummaryMarkdownPath = queue
    ? getPlanAndExecuteQueueSummaryPath(state.cwd, queue.queueId)
    : null;
  const manualGate = summarizeManualGate(state, runId);
  const health = classifyHealth(state, eventSummary, nowMs, finalCompletionStaleness);
  const publicStatus = formatPublicStatusForDisplayStatus(displayStatus, health);
  const publicPhase = formatPublicPhase(state.phase);
  const providerError = summarizeProviderError(tail.events);
  const nextAction = formatNextAction({
    manualGate,
    resumeDecision,
    finalCompletionStaleness,
    runId,
    blockedGuidance,
    // The Next Action must reflect the run's current failure, not history: the
    // provider-error summary stays on the snapshot as historical information,
    // but it only drives the Next Action while no later provider turn or phase
    // has completed successfully after it.
    providerError: providerError && isProviderErrorActive(tail.events) ? providerError : null,
  });
  const commits = summarizeCommits(state);
  const squash = await summarizeSquashArtifact(state.runDir);
  const build = await summarizeBuild(state);
  const patch = await summarizePatch(state, displayStatus, squash);

  return {
    ok: true,
    runId,
    cwd: state.cwd,
    statePath,
    runDir: state.runDir,
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    executionShape: state.executionShape,
    phase: state.phase,
    publicPhase,
    status: state.status,
    effectiveStatus: displayStatus.effectiveStatus,
    publicStatus,
    nextAction,
    waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
    pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
    blockedGuidance,
    blocker,
    manualGate,
    resumeDecision,
    currentScopeNumber: state.currentScopeNumber,
    plannerSessionHandle: state.plannerSessionHandle,
    coderSessionHandle: state.coderSessionHandle,
    reviewerSessionHandle: state.reviewerSessionHandle,
    coderRetryCount: state.coderRetryCount,
    rounds: state.rounds.length,
    createdCommits: state.createdCommits.length,
    completedScopes: state.completedScopes.length,
    lastEventAt: eventSummary.lastEvent?.ts ?? null,
    lastMeaningfulEventAt: eventSummary.lastMeaningfulEvent?.ts ?? null,
    lastCoderEventAt: eventSummary.lastCoderEvent?.ts ?? null,
    lastReviewerEventAt: eventSummary.lastReviewerEvent?.ts ?? null,
    lastMeaningfulEvent: eventSummary.lastMeaningfulEvent
      ? {
          type: eventSummary.lastMeaningfulEvent.type,
          summary: summarizeEvent(eventSummary.lastMeaningfulEvent),
        }
      : null,
    lock,
    health,
    findings: summarizeFindings(state),
    planReviewDebt: summarizePlanReviewDebt(state),
    commits,
    squash,
    providerError,
    finalCompletionStaleness,
    build,
    patch,
    derivedPlan: summarizeDerivedPlan(state),
    ...(queue ? { queue } : {}),
    events: {
      path: tail.path,
      exists: tail.exists,
      parsedLines: tail.parsedLines,
      malformedLines: tail.malformedLines,
      truncated: tail.truncated,
    },
    artifacts: {
      runStatePath: getRunStatePath(state.runDir),
      eventsPath,
      runNarrativeMarkdownPath: join(state.runDir, 'RUN_NARRATIVE.md'),
      latestRetrospectiveMarkdownPath,
      reviewMarkdownPath: state.reviewMarkdownPath,
      progressJsonPath: state.progressJsonPath,
      progressMarkdownPath: state.progressMarkdownPath,
      recoveryMarkdownPath: state.recoveryMarkdownPath,
      queueSummaryMarkdownPath,
      archivedReviewPath: state.archivedReviewPath,
      invalidDerivedPlanPayloadPath,
    },
  };
}

export async function buildStatusListSnapshot(args: {
  cwd: string;
  now?: Date;
}): Promise<NealStatusListSnapshot> {
  const cwd = resolve(args.cwd);
  const runs = await listRuns(cwd);
  const snapshots = await Promise.all(
    runs.map((run) =>
      buildStatusSnapshot({
        cwd,
        statePath: run.statePath,
        now: args.now,
      }),
    ),
  );

  return {
    ok: true,
    cwd,
    runs: snapshots.map((snapshot, index) => {
      const run = runs[index];

      return {
        runId: snapshot.runId,
        runDir: snapshot.runDir,
        statePath: snapshot.statePath,
        planDoc: snapshot.planDoc,
        topLevelMode: snapshot.topLevelMode,
        executionShape: snapshot.executionShape,
        status: snapshot.status,
        effectiveStatus: snapshot.effectiveStatus,
        publicStatus: snapshot.publicStatus,
        phase: snapshot.phase,
        publicPhase: snapshot.publicPhase,
        currentScopeNumber: snapshot.currentScopeNumber,
        waitingForOperatorGuidance: snapshot.waitingForOperatorGuidance,
        pendingOperatorGuidance: snapshot.pendingOperatorGuidance,
        manualGate: snapshot.manualGate,
        commits: snapshot.commits,
        squash: snapshot.squash,
        providerError: snapshot.providerError,
        finalCompletionStaleness: snapshot.finalCompletionStaleness,
        build: snapshot.build,
        patch: snapshot.patch,
        lock: snapshot.lock,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        nextAction: snapshot.nextAction,
        artifacts: snapshot.artifacts,
      };
    }),
  };
}

export function renderHumanStatusSnapshot(snapshot: NealStatusSnapshot): string {
  const lines = [
    '# Neal Status',
    '',
    `- Run: ${snapshot.runId}`,
    `- Run directory: ${snapshot.runDir}`,
    `- Plan: ${snapshot.planDoc}`,
    `- Mode: ${snapshot.topLevelMode}`,
    `- Status: ${snapshot.publicStatus}`,
    `- Step: ${snapshot.publicPhase}`,
  ];

  if (shouldShowScope(snapshot)) {
    lines.push(`- Current scope: ${snapshot.currentScopeNumber}`);
  }

  lines.push(
    `- Health: ${snapshot.health.classification} - ${snapshot.health.reason}`,
    `- Findings: ${snapshot.findings.openBlocking} open blocking, ${snapshot.findings.openNonBlocking} open non-blocking (${snapshot.findings.total} total)`,
    `- Plan review debt: ${formatPlanReviewDebtLine(snapshot.planReviewDebt)}`,
    `- Operator guidance: waiting=${formatBoolean(snapshot.waitingForOperatorGuidance)}, pending=${formatBoolean(snapshot.pendingOperatorGuidance)}`,
  );

  if (snapshot.lastMeaningfulEvent) {
    lines.push(`- Last progress: ${snapshot.lastMeaningfulEvent.type} - ${snapshot.lastMeaningfulEvent.summary}`);
  } else {
    lines.push('- Last progress: none recorded');
  }

  if (snapshot.queue) {
    lines.push(
      `- Queue: ${snapshot.queue.queueId} item ${snapshot.queue.itemIndex + 1}/${snapshot.queue.itemCount} ${snapshot.queue.stage}; queue ${snapshot.queue.queueStatus}, item ${snapshot.queue.itemStatus}`,
      `- Queue plan: ${snapshot.queue.requestedPlanPath}`,
    );
  }

  if (snapshot.manualGate) {
    lines.push(
      '',
      '## Manual Gate',
      `- ID: ${snapshot.manualGate.id}`,
      `- Title: ${snapshot.manualGate.title}`,
      `- Reason: ${snapshot.manualGate.reason}`,
      `- Instructions: ${snapshot.manualGate.instructionsPath}`,
      `- Last checked: ${snapshot.manualGate.lastCheckedAt ?? 'never'}`,
      `- Resume command: ${snapshot.manualGate.resumeCommand}`,
    );
    if (snapshot.manualGate.lastFailure) {
      lines.push(
        `- Last failure check: ${snapshot.manualGate.lastFailure.checkName}`,
        `- Last failure exit code: ${snapshot.manualGate.lastFailure.exitCode ?? 'none'}`,
        `- Last failure signal: ${snapshot.manualGate.lastFailure.signal ?? 'none'}`,
        `- Last failure stdout tail: ${snapshot.manualGate.lastFailure.stdoutTail || 'empty'}`,
        `- Last failure stderr tail: ${snapshot.manualGate.lastFailure.stderrTail || 'empty'}`,
      );
    } else {
      lines.push('- Last failure: none');
    }
  }

  if (snapshot.derivedPlan) {
    lines.push(`- Derived plan: ${snapshot.derivedPlan.path} (${snapshot.derivedPlan.status ?? 'unknown'})`);
  }

  if (snapshot.providerError) {
    const provider = snapshot.providerError.provider ?? 'unclassified';
    const kind = snapshot.providerError.kind ?? 'unclassified';
    lines.push(`- Provider error: ${provider} ${kind} - ${snapshot.providerError.message}`);
  }

  lines.push(
    `- Active lock: ${formatLockSummary(snapshot.lock)}`,
    `- Squash: ${snapshot.squash.status}${snapshot.squash.replacementCommit ? ` replacement=${snapshot.squash.replacementCommit}` : ''}`,
    `- Patch policy: ${snapshot.patch.defaultSubmissionEligible ? 'eligible' : 'not eligible'} - ${snapshot.patch.reason}`,
  );

  if (snapshot.blocker.active && !snapshot.blockedGuidance) {
    lines.push(
      '',
      '## Blocker',
      `- Reason: ${snapshot.blocker.reason ?? 'unknown'}`,
      `- Source: ${snapshot.blocker.source ?? 'unknown'}`,
    );
    if (snapshot.blocker.artifactPaths.length > 0) {
      lines.push('- Artifacts:');
      for (const artifact of snapshot.blocker.artifactPaths) {
        lines.push(`  - ${artifact.label}: ${artifact.path}`);
      }
    }
  }

  lines.push(
    '',
    '## Artifacts',
    `- Run state: ${snapshot.artifacts.runStatePath}`,
    `- Events: ${snapshot.artifacts.eventsPath}`,
    `- Run narrative: ${snapshot.artifacts.runNarrativeMarkdownPath}`,
    `- Latest retrospective: ${snapshot.artifacts.latestRetrospectiveMarkdownPath ?? 'none found'}`,
    `- Progress: ${snapshot.artifacts.progressMarkdownPath}`,
    `- Progress JSON: ${snapshot.artifacts.progressJsonPath}`,
    `- Review: ${snapshot.artifacts.reviewMarkdownPath}`,
    `- Recovery: ${snapshot.artifacts.recoveryMarkdownPath}`,
  );

  if (snapshot.artifacts.invalidDerivedPlanPayloadPath) {
    lines.push(`- Invalid split-plan payload: ${snapshot.artifacts.invalidDerivedPlanPayloadPath}`);
  }

  if (snapshot.artifacts.queueSummaryMarkdownPath) {
    lines.push(`- Queue summary: ${snapshot.artifacts.queueSummaryMarkdownPath}`);
  }

  if (snapshot.artifacts.archivedReviewPath) {
    lines.push(`- Archived review: ${snapshot.artifacts.archivedReviewPath}`);
  }

  if (snapshot.blockedGuidance) {
    lines.push('', ...renderBlockedGuidanceSections(snapshot.blockedGuidance));
  }

  lines.push('', '## Next Action', `- ${snapshot.nextAction}`);

  return lines.join('\n');
}

export function renderHumanStatusListSnapshot(snapshot: NealStatusListSnapshot): string {
  if (snapshot.runs.length === 0) {
    return 'No Neal runs found.\n';
  }

  const rows = [
    ['RUN ID', 'MODE', 'STATUS', 'STEP', 'PLAN', 'UPDATED', 'NEXT ACTION'],
    ...snapshot.runs.map((run) => [
      run.runId,
      run.topLevelMode,
      run.publicStatus,
      run.publicPhase,
      toDisplayPath(snapshot.cwd, run.planDoc),
      run.updatedAt,
      run.nextAction,
    ]),
  ];
  const widths = rows[0].map((_cell, index) => Math.max(...rows.map((row) => row[index].length)));

  return rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()).join('\n') + '\n';
}

function formatPublicStatusForDisplayStatus(
  displayStatus: RunDisplayStatusForPublicStatus,
  health: NealStatusSnapshot['health'],
) {
  const publicStatus = formatPublicRunStatus({
    effectiveStatus: displayStatus.effectiveStatus,
    waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
    pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
  });
  if (displayStatus.effectiveStatus === 'paused' || health.classification === 'paused') {
    return 'paused';
  }
  if (health.classification === 'stale') {
    return 'stale';
  }
  return publicStatus;
}

type RunDisplayStatusForPublicStatus = Pick<
  RunDisplayStatus,
  'effectiveStatus' | 'waitingForOperatorGuidance' | 'pendingOperatorGuidance'
>;

function shouldShowScope(snapshot: NealStatusSnapshot) {
  return snapshot.topLevelMode === 'execute' && snapshot.phase !== 'done';
}

function formatBoolean(value: boolean) {
  return value ? 'yes' : 'no';
}

function formatPlanReviewDebtLine(debt: NealStatusSnapshot['planReviewDebt']) {
  if (debt.total === 0) {
    return '0';
  }
  const rounds = [...new Set(debt.items.map((item) => item.originRound).filter((round): round is number => round !== null))].sort(
    (a, b) => a - b,
  );
  const roundsSuffix = rounds.length > 0 ? ` (rounds ${rounds.join(', ')})` : '';
  return `${debt.total}${roundsSuffix}`;
}

function formatLockSummary(lock: NealLockStatusSummary) {
  switch (lock.kind) {
    case 'none':
      return 'none';
    case 'live_same_run':
      return `live for this run${typeof lock.pid === 'number' ? ` pid=${lock.pid}` : ''}`;
    case 'stale_same_run':
      return `stale for this run${typeof lock.pid === 'number' ? ` pid=${lock.pid}` : ''}`;
    case 'live_different_run':
      return `live for ${lock.runId}${typeof lock.pid === 'number' ? ` pid=${lock.pid}` : ''}`;
    case 'stale_different_run':
      return `stale for ${lock.runId}${typeof lock.pid === 'number' ? ` pid=${lock.pid}` : ''}`;
    case 'cross_host':
      return `cross-host for ${lock.runId} on ${lock.hostname ?? 'unknown host'}`;
    case 'unreadable':
      return `unreadable - ${lock.reason}`;
  }
}

function formatNextAction(
  snapshot: Pick<
    NealStatusSnapshot,
    'manualGate' | 'resumeDecision' | 'finalCompletionStaleness' | 'runId' | 'blockedGuidance' | 'providerError'
  >,
) {
  if (snapshot.manualGate) {
    return `Complete manual gate ${snapshot.manualGate.id}, then resume this run: ${snapshot.manualGate.resumeCommand}`;
  }
  if (snapshot.finalCompletionStaleness.stale && snapshot.resumeDecision.kind === 'continue') {
    return `Final completion appears stale after reviewer output. Inspect artifacts and recover explicitly after confirming the branch state: neal status --run ${snapshot.runId}`;
  }
  // An input_too_large failure keeps the resume decision at `continue` on
  // purpose: the adapter-boundary preflight re-measures the actual rebuilt
  // prompt against the provider budget on every attempt, so resume is always
  // executable and an unchanged oversized prompt fails fast before any
  // provider call. This branch only redirects the operator to shrink the named
  // input before that resume. Every lever it names works on an existing run:
  // operator guidance files are re-read at every prompt build, and upgrading
  // neal applies the current prompt bounds on resume. Per-run provider
  // rebinding does not exist, so a prompt that cannot fit needs a new run on a
  // provider with a larger or no declared limit.
  if (snapshot.providerError?.kind === 'input_too_large' && snapshot.resumeDecision.kind === 'continue') {
    const largestSection = largestSectionNameFromInputTooLargeMessage(snapshot.providerError.message);
    const namedInput = largestSection ? `the "${largestSection}" prompt section` : 'the oversized prompt input';
    return (
      `The last attempt failed because the prompt exceeded the provider's input limit. ` +
      `Shrink ${namedInput} first (trim operator guidance files, or upgrade neal so the current prompt bounds apply), ` +
      `then resume this run: ${snapshot.resumeDecision.resumeCommand}. ` +
      `If the prompt cannot fit under the limit, start a new run with a provider that has a larger or no input limit.`
    );
  }
  if (snapshot.resumeDecision.kind === 'needs_message' && snapshot.blockedGuidance) {
    const firstOption = snapshot.blockedGuidance.options[0]?.command;
    if (firstOption) {
      return `Needs operator guidance: ${formatSentence(snapshot.blockedGuidance.summary)} Use first resume option: ${firstOption}`;
    }
    return `Needs operator guidance: ${formatSentence(snapshot.blockedGuidance.summary)} Inspect guidance: neal status --run ${snapshot.runId}`;
  }
  return formatNextActionForDecision(snapshot.resumeDecision);
}

export function formatStatusNextActionForState(state: OrchestrationState) {
  const runId = basename(state.runDir);
  const resumeDecision = decideResumeAction({
    state,
    selectedRunId: runId,
    statePath: getRunStatePath(state.runDir),
  });
  return formatNextAction({
    manualGate: summarizeManualGate(state, runId),
    resumeDecision,
    finalCompletionStaleness: {
      stale: false,
      reason: null,
      reviewerOutputObserved: false,
      finalCompletionPhaseStartedAt: null,
      lastFinalCompletionReviewerOutputAt: null,
      finalCompletionPhaseTerminalEventObserved: false,
    },
    runId,
    blockedGuidance: buildBlockedGuidance({ state, runId }),
    // This state-only path has no events access, so it cannot see provider
    // errors and renders the plain decision-based action.
    providerError: null,
  });
}

function formatNextActionForDecision(decision: ResumeDecision) {
  switch (decision.kind) {
    case 'continue':
      return `Resume this run: ${decision.resumeCommand}`;
    case 'needs_message':
      return `Needs operator guidance: ${formatSentence(decision.blocker)} Record guidance and resume: ${decision.messageCommand}`;
    case 'pending_message':
      return `Operator guidance is recorded. Resume this run: ${decision.resumeCommand}`;
    case 'already_running':
      return `${decision.reason} Inspect status: ${decision.statusCommand}`;
    case 'done':
      return decision.retrospectivePath
        ? `No resume needed. Review latest retrospective: ${decision.retrospectivePath}`
        : `No resume needed. Inspect status: ${decision.statusCommand}`;
    case 'cannot_resume':
      return `${decision.reason} Inspect status and artifacts: ${decision.statusCommand}`;
  }
}

function formatSentence(value: string) {
  const trimmed = value.trim();
  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function toDisplayPath(cwd: string, path: string) {
  if (!isAbsolute(path)) {
    return path;
  }
  const relativePath = relative(cwd, path);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath) ? relativePath : path;
}

function summarizeManualGate(state: OrchestrationState, runId: string): NealManualGateStatusSummary | null {
  const gate = state.phase === 'manual_gate' ? state.manualGate : null;
  if (!gate) {
    return null;
  }
  return {
    id: gate.id,
    title: gate.title,
    reason: gate.reason,
    instructionsPath: gate.instructionsPath,
    lastCheckedAt: gate.lastCheckedAt,
    lastFailure: gate.lastFailure,
    resumeCommand: `neal resume --run ${runId}`,
  };
}

async function findLatestRetrospectiveMarkdownPath(runDir: string): Promise<string | null> {
  const defaultPath = join(runDir, 'RETROSPECTIVE.md');
  try {
    const defaultStat = await stat(defaultPath);
    if (defaultStat.isFile()) {
      return defaultPath;
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  const latestName = entries
    .filter((entry) => entry.isFile() && /^RETROSPECTIVE-.+\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);

  return latestName ? join(runDir, latestName) : null;
}

export function summarizeDerivedPlan(state: OrchestrationState): NealStatusSnapshot['derivedPlan'] {
  const derivedPlan = getDerivedPlanView(state);
  if (!derivedPlan) {
    return null;
  }

  return {
    path: derivedPlan.path,
    parentScopeNumber: derivedPlan.parentScopeNumber,
    status: derivedPlan.status,
    scopeIndex: derivedPlan.scopeIndex,
    reviewActive: derivedPlan.reviewActive,
    acceptedAwaitingExecution: derivedPlan.acceptedAwaitingExecution,
    executing: derivedPlan.executing,
    abandoned: derivedPlan.abandoned,
  };
}

async function findCurrentInvalidSplitPlanPayloadArtifactPath(state: OrchestrationState): Promise<string | null> {
  const artifactPath = join(state.runDir, `SCOPE_${state.currentScopeNumber}_INVALID_DERIVED_PLAN.md`);
  const fileStat = await stat(artifactPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  return fileStat?.isFile() ? artifactPath : null;
}

function summarizeBlocker(
  state: OrchestrationState,
  events: ParsedEvent[],
  invalidDerivedPlanPayloadPath: string | null,
  guidance: BlockedGuidance | null = null,
): NealBlockerStatusSummary {
  const blockedLike =
    state.status === 'blocked' ||
    state.status === 'failed' ||
    state.phase === 'blocked' ||
    state.phase === 'interactive_blocked_recovery';
  const artifactPaths = invalidDerivedPlanPayloadPath
    ? [{ label: 'Invalid split-plan payload', path: invalidDerivedPlanPayloadPath }]
    : [];

  if (!blockedLike) {
    return {
      active: false,
      reason: null,
      source: null,
      artifactPaths,
    };
  }

  const candidates: Array<{ reason: string | null; source: string }> = [
    {
      reason: nonEmptyString(state.blockerReason),
      source: 'RUN_STATE.json blocker reason',
    },
    {
      reason: guidance?.category === 'scope_accounting_guardrail' ? guidance.summary : null,
      source: 'blocked guidance',
    },
    {
      reason: state.interactiveBlockedRecovery?.blockedReason ?? null,
      source: 'RUN_STATE.json interactive recovery',
    },
    {
      reason: currentOrLatestBlockedCompletedScopeBlocker(state),
      source: 'RUN_STATE.json completed scopes',
    },
    {
      reason: latestInvalidSplitPlanEventBlocker(events, invalidDerivedPlanPayloadPath),
      source: 'events.ndjson invalid split-plan payload',
    },
  ];
  const candidate = candidates.find((item) => item.reason);

  return {
    active: Boolean(candidate?.reason),
    reason: candidate?.reason ?? null,
    source: candidate?.source ?? null,
    artifactPaths,
  };
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function currentOrLatestBlockedCompletedScopeBlocker(state: OrchestrationState): string | null {
  const blockedScopes = state.completedScopes.filter((scope) => scope.result === 'blocked' && scope.blocker);
  const currentScope = blockedScopes.find((scope) => scope.number === String(state.currentScopeNumber));
  return currentScope?.blocker ?? blockedScopes.at(-1)?.blocker ?? null;
}

function latestInvalidSplitPlanEventBlocker(
  events: ParsedEvent[],
  invalidDerivedPlanPayloadPath: string | null,
): string | null {
  for (const event of [...events].reverse()) {
    if (event.type !== 'split_plan.invalid_payload') {
      continue;
    }
    const validationErrors = stringArrayValue(event.data.validationErrors);
    const artifactPath = invalidDerivedPlanPayloadPath ?? stringValue(event.data.invalidPayloadPath);
    const reason = validationErrors.length > 0
      ? `Invalid split-plan payload: ${validationErrors.join('; ')}`
      : 'Invalid split-plan payload was rejected by plan validation.';
    return artifactPath ? `${reason} Invalid payload artifact: ${artifactPath}` : reason;
  }
  return null;
}

async function summarizeLinkedQueue(
  runDir: string,
  cwd: string,
): Promise<NealStatusSnapshot['queue'] | undefined> {
  const link = await readQueueChildLink(runDir);
  if (!link) {
    return undefined;
  }

  const queueStatePath = resolveQueueStoredPath(cwd, link.queueStatePath);
  const queueState = await loadPlanAndExecuteQueueState(queueStatePath, cwd);
  if (queueState.queueId !== link.queueId) {
    throw new Error(`Invalid queue child link: queue ${link.queueId} does not match state ${queueState.queueId}`);
  }

  const item = queueState.items[link.itemIndex];
  if (!item) {
    throw new Error(`Invalid queue child link: missing queue item ${link.itemIndex}`);
  }

  return {
    queueId: queueState.queueId,
    queueStatePath,
    itemIndex: link.itemIndex,
    itemCount: queueState.items.length,
    stage: link.stage,
    queueStatus: queueState.status,
    itemStatus: item.status,
    requestedPlanPath: item.requestedPlanPath,
  };
}

async function readEventTail(path: string): Promise<EventTail> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        path,
        exists: false,
        parsedLines: 0,
        malformedLines: 0,
        truncated: false,
        events: [],
      };
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    const truncated = stat.size > EVENT_TAIL_BYTES;
    const length = Math.min(stat.size, EVENT_TAIL_BYTES);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (truncated) {
      text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    }
    return parseEventText(path, text, truncated);
  } finally {
    await file.close();
  }
}

function parseEventText(path: string, text: string, truncated: boolean): EventTail {
  const lines = text.split('\n');
  let malformedLines = 0;
  let parsedLines = 0;
  const events: ParsedEvent[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue;
    }

    try {
      const event = JSON.parse(line) as NealRunEvent;
      const parsed = parseRunEvent(event);
      if (parsed) {
        events.push(parsed);
        parsedLines += 1;
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
      if (index === lines.length - 1) {
        continue;
      }
    }
  }

  return {
    path,
    exists: true,
    parsedLines,
    malformedLines,
    truncated,
    events,
  };
}

function parseRunEvent(event: NealRunEvent): ParsedEvent | null {
  if (typeof event.ts !== 'string' || typeof event.type !== 'string') {
    return null;
  }

  const timeMs = Date.parse(event.ts);
  if (!Number.isFinite(timeMs)) {
    return null;
  }

  return {
    ts: new Date(timeMs).toISOString(),
    timeMs,
    type: event.type,
    data: event.data && typeof event.data === 'object' ? event.data : {},
  };
}

function summarizeEvents(events: ParsedEvent[]) {
  let lastEvent: ParsedEvent | null = null;
  let lastMeaningfulEvent: ParsedEvent | null = null;
  let lastCoderEvent: ParsedEvent | null = null;
  let lastReviewerEvent: ParsedEvent | null = null;
  let latestPhaseStart: ParsedEvent | null = null;
  let latestTimeoutCleanupAfterPhaseStart: ParsedEvent | null = null;

  for (const event of events) {
    if (STATUS_INTERNAL_EVENT_TYPES.has(event.type)) {
      continue;
    }
    if (!lastEvent || event.timeMs >= lastEvent.timeMs) {
      lastEvent = event;
    }
    if (isMeaningfulEvent(event)) {
      if (!lastMeaningfulEvent || event.timeMs >= lastMeaningfulEvent.timeMs) {
        lastMeaningfulEvent = event;
      }
    }
    if (isCoderEvent(event) && (!lastCoderEvent || event.timeMs >= lastCoderEvent.timeMs)) {
      lastCoderEvent = event;
    }
    if (isReviewerEvent(event) && (!lastReviewerEvent || event.timeMs >= lastReviewerEvent.timeMs)) {
      lastReviewerEvent = event;
    }
    if (event.type === 'phase.start' && (!latestPhaseStart || event.timeMs >= latestPhaseStart.timeMs)) {
      latestPhaseStart = event;
    }
  }

  if (latestPhaseStart) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === 'coder.timeout_cleanup' && event.timeMs >= latestPhaseStart.timeMs) {
        latestTimeoutCleanupAfterPhaseStart = event;
        break;
      }
    }
  }

  return {
    lastEvent,
    lastMeaningfulEvent,
    lastCoderEvent,
    lastReviewerEvent,
    latestPhaseStart,
    latestTimeoutCleanupAfterPhaseStart,
  };
}

function isMeaningfulEvent(event: ParsedEvent) {
  return MEANINGFUL_EVENT_TYPES.has(event.type) && event.type !== 'phase.heartbeat';
}

function isCoderEvent(event: ParsedEvent) {
  return event.type.startsWith('coder.') || (event.type.startsWith('provider.') && event.data.role === 'coder');
}

function isReviewerEvent(event: ParsedEvent) {
  return (
    event.type.startsWith('advisor.') ||
    (event.type.startsWith('provider.') && event.data.role === 'structured-advisor')
  );
}

function classifyFinalCompletionStaleness(args: {
  state: OrchestrationState;
  events: ParsedEvent[];
  eventSummary: ReturnType<typeof summarizeEvents>;
  nowMs: number;
  lock: NealLockStatusSummary;
}): NealFinalCompletionStalenessSummary {
  const evidence = summarizeFinalCompletionReviewEvidence(args.events);
  const base = {
    stale: false,
    reason: null,
    reviewerOutputObserved: evidence.reviewerOutputObserved,
    finalCompletionPhaseStartedAt: evidence.finalCompletionPhaseStartedAt,
    lastFinalCompletionReviewerOutputAt: evidence.lastFinalCompletionReviewerOutputAt,
    finalCompletionPhaseTerminalEventObserved: evidence.finalCompletionPhaseTerminalEventObserved,
  } satisfies NealFinalCompletionStalenessSummary;

  if (
    args.state.topLevelMode !== 'execute' ||
    args.state.status !== 'running' ||
    args.state.phase !== 'final_completion_review' ||
    args.state.finalCommit === null ||
    args.state.finalCompletionSummary === null ||
    args.state.finalCompletionReviewVerdict !== null ||
    args.state.finalCompletionResolvedAction !== null ||
    !hasAcceptedTerminalCompletedScopeForCurrentPosition(args.state) ||
    !evidence.reviewerOutputObserved ||
    evidence.finalCompletionPhaseTerminalEventObserved ||
    args.lock.kind === 'live_same_run'
  ) {
    return base;
  }

  const quietMs = getQuietMs(args.eventSummary, args.nowMs);
  if (quietMs === null || quietMs < QUIET_WARNING_MS) {
    return base;
  }

  return {
    ...base,
    stale: true,
    reason: 'final completion review has reviewer output but no terminal transition',
  };
}

function summarizeFinalCompletionReviewEvidence(events: ParsedEvent[]): Omit<
  NealFinalCompletionStalenessSummary,
  'stale' | 'reason'
> {
  let latestPhaseStart: ParsedEvent | null = null;
  for (const event of events) {
    if (
      event.type === 'phase.start' &&
      event.data.phase === 'final_completion_review' &&
      (!latestPhaseStart || event.timeMs >= latestPhaseStart.timeMs)
    ) {
      latestPhaseStart = event;
    }
  }

  let lastReviewerOutput: ParsedEvent | null = null;
  let terminalEventObserved = false;
  if (latestPhaseStart) {
    for (const event of events) {
      if (event.timeMs < latestPhaseStart.timeMs) {
        continue;
      }
      if (isFinalCompletionReviewerOutputEvent(event)) {
        if (!lastReviewerOutput || event.timeMs >= lastReviewerOutput.timeMs) {
          lastReviewerOutput = event;
        }
      }
      if (isFinalCompletionPhaseTerminalEvent(event)) {
        terminalEventObserved = true;
      }
    }
  }

  return {
    reviewerOutputObserved: lastReviewerOutput !== null,
    finalCompletionPhaseStartedAt: latestPhaseStart?.ts ?? null,
    lastFinalCompletionReviewerOutputAt: lastReviewerOutput?.ts ?? null,
    finalCompletionPhaseTerminalEventObserved: terminalEventObserved,
  };
}

function isFinalCompletionReviewerOutputEvent(event: ParsedEvent) {
  const label = stringValue(event.data.label);
  return event.type === 'provider.structured_output_received' && Boolean(label?.startsWith('final-completion'));
}

function isFinalCompletionPhaseTerminalEvent(event: ParsedEvent) {
  return (
    (event.type === 'phase.complete' || event.type === 'phase.error') &&
    event.data.phase === 'final_completion_review'
  );
}

function hasAcceptedTerminalCompletedScopeForCurrentPosition(state: OrchestrationState) {
  const currentScopeNumber = String(state.currentScopeNumber);
  return state.completedScopes.some(
    (scope) =>
      scope.number === currentScopeNumber &&
      scope.result === 'accepted' &&
      scope.marker === 'AUTONOMY_DONE' &&
      scope.finalCommit === state.finalCommit,
  );
}

function classifyHealth(
  state: OrchestrationState,
  events: ReturnType<typeof summarizeEvents>,
  nowMs: number,
  finalCompletionStaleness: NealFinalCompletionStalenessSummary,
): NealStatusSnapshot['health'] {
  const phaseStartMs = getPhaseStartMs(state, events);
  const phaseElapsedMs = phaseStartMs === null ? null : Math.max(0, nowMs - phaseStartMs);
  const quietMs = getQuietMs(events, nowMs);
  const heartbeatOnly = isHeartbeatOnly(events);

  const makeHealth = (classification: NealHealthClassification, reason: string): NealStatusSnapshot['health'] => ({
    classification,
    phaseElapsedMs,
    quietMs,
    heartbeatOnly,
    reason,
  });

  if (isBlockedState(state)) {
    return makeHealth('blocked', 'state is blocked or failed');
  }

  if (events.lastMeaningfulEvent?.type === 'run.paused_after_scope') {
    return makeHealth('paused', 'run paused after current scope');
  }

  if (state.status === 'paused') {
    return makeHealth('paused', 'run is paused');
  }

  if (events.lastMeaningfulEvent?.type === 'phase.retry' || events.latestTimeoutCleanupAfterPhaseStart) {
    return makeHealth('timed_out', 'retry or timeout cleanup observed');
  }

  if (state.status === 'done' || state.phase === 'done') {
    return makeHealth('ok', 'run is done');
  }

  if (finalCompletionStaleness.stale) {
    return makeHealth('stale', finalCompletionStaleness.reason ?? 'final completion review appears stale');
  }

  const meaningfulAgeMs = events.lastMeaningfulEvent ? nowMs - events.lastMeaningfulEvent.timeMs : null;
  if (meaningfulAgeMs !== null && meaningfulAgeMs <= OK_MEANINGFUL_EVENT_MS) {
    return makeHealth('ok', 'recent meaningful event');
  }

  const eventAgeMs = events.lastEvent ? nowMs - events.lastEvent.timeMs : null;
  if (heartbeatOnly && eventAgeMs !== null && eventAgeMs <= OK_MEANINGFUL_EVENT_MS) {
    return makeHealth('heartbeat_only', 'recent heartbeat without phase progress');
  }

  if (state.status === 'running' && quietMs !== null && quietMs >= QUIET_WARNING_MS) {
    return makeHealth('quiet', 'no recent meaningful event');
  }

  return makeHealth('unknown', 'insufficient event evidence');
}

function getQuietMs(events: ReturnType<typeof summarizeEvents>, nowMs: number) {
  const quietBasisMs = events.lastMeaningfulEvent?.timeMs ?? events.lastEvent?.timeMs ?? null;
  return quietBasisMs === null ? null : Math.max(0, nowMs - quietBasisMs);
}

function isBlockedState(state: OrchestrationState) {
  const { waitingForOperatorGuidance } = getRunDisplayStatus(state);

  return state.status === 'blocked' || state.status === 'failed' || state.phase === 'blocked' || waitingForOperatorGuidance;
}

function getPhaseStartMs(state: OrchestrationState, events: ReturnType<typeof summarizeEvents>) {
  if (events.latestPhaseStart) {
    return events.latestPhaseStart.timeMs;
  }

  const updatedAtMs = Date.parse(state.updatedAt);
  if (Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }

  const createdAtMs = Date.parse(state.createdAt);
  return Number.isFinite(createdAtMs) ? createdAtMs : null;
}

function isHeartbeatOnly(events: ReturnType<typeof summarizeEvents>) {
  if (events.lastEvent?.type !== 'phase.heartbeat') {
    return false;
  }

  const phaseStartMs = events.latestPhaseStart?.timeMs ?? null;
  if (phaseStartMs === null) {
    return events.lastMeaningfulEvent === null;
  }

  return !events.lastMeaningfulEvent || events.lastMeaningfulEvent.timeMs <= phaseStartMs;
}

function summarizeEvent(event: ParsedEvent) {
  const candidates = [
    event.data.message,
    typeof event.data.phase === 'string' ? formatMaybePublicPhase(event.data.phase) : null,
    typeof event.data.nextPhase === 'string' ? formatMaybePublicPhase(event.data.nextPhase) : null,
    event.data.command,
    event.data.label,
  ];
  const summary = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return summary ?? event.type;
}

function summarizeFindings(state: OrchestrationState): NealStatusSnapshot['findings'] {
  return {
    total: state.findings.length,
    openBlocking: state.findings.filter((finding) => finding.status === 'open' && finding.severity === 'blocking').length,
    openNonBlocking: state.findings.filter((finding) => finding.status === 'open' && finding.severity === 'non_blocking').length,
    fixed: state.findings.filter((finding) => finding.status === 'fixed').length,
    rejected: state.findings.filter((finding) => finding.status === 'rejected').length,
    deferred: state.findings.filter((finding) => finding.status === 'deferred').length,
  };
}

function summarizePlanReviewDebt(state: OrchestrationState): NealStatusSnapshot['planReviewDebt'] {
  const toItem = (item: ResidualReviewDebtItem, inherited: boolean) => ({
    canonicalId: item.canonicalId,
    findingClass: item.findingClass ?? null,
    originRound: item.originRound ?? null,
    inherited,
  });
  const items = [
    ...state.inheritedPlanReviewDebt.map((item) => toItem(item, true)),
    ...state.planReviewDebt.map((item) => toItem(item, false)),
  ];
  return { total: items.length, items };
}

function summarizeCommits(state: OrchestrationState): NealCommitStatusSummary {
  return {
    initialBaseCommit: state.initialBaseCommit,
    baseCommit: state.baseCommit,
    finalCommit: state.finalCommit,
    createdCommitCount: state.createdCommits.length,
    acceptedScopeFinalCommits: state.completedScopes
      .filter((scope) => scope.result === 'accepted' && typeof scope.finalCommit === 'string' && scope.finalCommit.length > 0)
      .map((scope) => scope.finalCommit as string),
  };
}

async function summarizeSquashArtifact(runDir: string): Promise<NealSquashStatusSummary> {
  const artifactPath = join(runDir, 'SQUASH_RESULT.json');
  let artifactText: string;
  try {
    artifactText = await readFile(artifactPath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        artifactPath,
        status: 'missing',
        replacementCommit: null,
        finalHeadCommit: null,
        originalBaseCommit: null,
        originalFinalCommit: null,
        unavailableReason: 'SQUASH_RESULT.json is not present for this run.',
      };
    }
    const reason = error instanceof Error && error.message.trim()
      ? `SQUASH_RESULT.json could not be read: ${truncateStatusMessage(error.message)}`
      : 'SQUASH_RESULT.json could not be read.';
    return malformedSquashSummary(artifactPath, reason);
  }

  try {
    const artifact = parseSquashArtifact(JSON.parse(artifactText));
    if (!artifact) {
      return malformedSquashSummary(artifactPath, 'SQUASH_RESULT.json does not match the expected squash artifact shape.');
    }
    return {
      artifactPath,
      status: artifact.status,
      replacementCommit: artifact.replacementCommit,
      finalHeadCommit: artifact.finalHeadCommit,
      originalBaseCommit: artifact.originalBaseCommit,
      originalFinalCommit: artifact.originalFinalCommit,
      unavailableReason: null,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message.trim()
      ? `SQUASH_RESULT.json could not be parsed: ${truncateStatusMessage(error.message)}`
      : 'SQUASH_RESULT.json could not be parsed.';
    return malformedSquashSummary(artifactPath, reason);
  }
}

function malformedSquashSummary(artifactPath: string, unavailableReason: string): NealSquashStatusSummary {
  return {
    artifactPath,
    status: 'malformed',
    replacementCommit: null,
    finalHeadCommit: null,
    originalBaseCommit: null,
    originalFinalCommit: null,
    unavailableReason,
  };
}

function parseSquashArtifact(value: unknown): Pick<
  SquashResultArtifact,
  'status' | 'replacementCommit' | 'finalHeadCommit' | 'originalBaseCommit' | 'originalFinalCommit'
> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || (record.status !== 'pending' && record.status !== 'complete')) {
    return null;
  }

  const originalBaseCommit = stringValue(record.originalBaseCommit);
  const originalFinalCommit = stringValue(record.originalFinalCommit);
  if (!originalBaseCommit || !originalFinalCommit) {
    return null;
  }

  const replacementCommit = nullableStringValue(record.replacementCommit);
  const finalHeadCommit = nullableStringValue(record.finalHeadCommit);
  if (record.status === 'complete' && (!replacementCommit || !finalHeadCommit)) {
    return null;
  }
  if (record.status === 'pending' && (replacementCommit !== null || finalHeadCommit !== null)) {
    return null;
  }

  return {
    status: record.status,
    replacementCommit,
    finalHeadCommit,
    originalBaseCommit,
    originalFinalCommit,
  };
}

// Events that prove the run progressed past a provider failure: a provider
// turn or structured round finished, or a whole phase completed. A provider
// error followed by any of these is resolved history, not the active failure.
const PROVIDER_ERROR_RESOLUTION_EVENT_TYPES = new Set([
  'provider.turn_completed',
  'provider.structured_output_received',
  'phase.complete',
]);

// True while the latest provider_error event has no later resolution event
// after it in the tail, so conditional guidance keyed off the error (the
// input_too_large Next Action) stops as soon as a retry or resume succeeds.
function isProviderErrorActive(events: ParsedEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index].type;
    if (type === 'provider.provider_error') {
      return true;
    }
    if (PROVIDER_ERROR_RESOLUTION_EVENT_TYPES.has(type)) {
      return false;
    }
  }
  return false;
}

function summarizeProviderError(events: ParsedEvent[]): NealProviderErrorStatusSummary | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'provider.provider_error') {
      continue;
    }
    return {
      source: 'provider_event',
      timestamp: event.ts,
      provider: stringValue(event.data.provider),
      role: providerRoleValue(event.data.role),
      label: stringValue(event.data.label),
      sessionHandle: nullableStringValue(event.data.sessionHandle),
      kind: providerErrorKindValue(event.data.errorKind),
      message: truncateStatusMessage(stringValue(event.data.message) ?? 'Provider failed.'),
      retryable: typeof event.data.retryable === 'boolean' ? event.data.retryable : null,
      diagnostic: providerErrorDiagnosticValue(event.data.providerData),
    };
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'phase.error') {
      continue;
    }
    return {
      source: 'phase_error',
      timestamp: event.ts,
      provider: null,
      role: null,
      label: typeof event.data.phase === 'string' ? formatMaybePublicPhase(event.data.phase) : null,
      sessionHandle: nullableStringValue(event.data.sessionHandle),
      kind: null,
      message: truncateStatusMessage(stringValue(event.data.message) ?? 'Run phase failed.'),
      retryable: null,
      diagnostic: null,
    };
  }

  return null;
}

async function summarizeBuild(state: OrchestrationState): Promise<NealBuildStatusSummary> {
  const metaBuild = await readMetaBuild(join(state.runDir, 'meta.json'));
  if (metaBuild) {
    return {
      ...metaBuild,
      source: 'meta',
      agentConfig: state.agentConfig,
    };
  }

  return {
    ...await getNealBuildMetadata(),
    source: 'live_fallback',
    agentConfig: state.agentConfig,
  };
}

async function readMetaBuild(path: string): Promise<NealBuildMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const build = (parsed as Record<string, unknown>).build;
    if (!build || typeof build !== 'object' || Array.isArray(build)) {
      return null;
    }
    const record = build as Record<string, unknown>;
    const packageVersion = stringValue(record.packageVersion);
    const nodeVersion = stringValue(record.nodeVersion);
    const sourceGitSha = nullableStringValue(record.sourceGitSha);
    if (!packageVersion || !nodeVersion) {
      return null;
    }
    return {
      packageVersion,
      nodeVersion,
      sourceGitSha,
    };
  } catch {
    return null;
  }
}

type PatchCandidate = {
  source: NealPatchStatusSummary['source'];
  baseCommit: string | null;
  headCommit: string | null;
};

async function summarizePatch(
  state: OrchestrationState,
  displayStatus: RunDisplayStatus,
  squash: NealSquashStatusSummary,
): Promise<NealPatchStatusSummary> {
  const candidate = selectPatchCandidate(state, squash);
  const range = candidate.baseCommit && candidate.headCommit ? `${candidate.baseCommit}..${candidate.headCommit}` : null;
  const baseSummary = {
    defaultSubmissionEligible: false,
    source: candidate.source,
    baseCommit: candidate.baseCommit,
    headCommit: candidate.headCommit,
    range,
    commitCount: null,
    changedFileCount: null,
    changedFiles: [],
    unavailableReason: null,
  } satisfies Omit<NealPatchStatusSummary, 'reason'>;

  if (!candidate.baseCommit) {
    return {
      ...baseSummary,
      reason: 'No patch base commit is available.',
      unavailableReason: 'No patch base commit is available.',
    };
  }
  if (!candidate.headCommit) {
    return {
      ...baseSummary,
      reason: 'No patch head commit is available.',
      unavailableReason: 'No patch head commit is available.',
    };
  }

  let commits: string[];
  let changedFiles: string[];
  try {
    [commits, changedFiles] = await Promise.all([
      getCommitRange(state.cwd, candidate.baseCommit, candidate.headCommit),
      getChangedFilesForRange(state.cwd, candidate.baseCommit, candidate.headCommit),
    ]);
  } catch (error) {
    const unavailableReason = error instanceof Error && error.message.trim()
      ? truncateStatusMessage(error.message)
      : 'Git could not read the patch range.';
    return {
      ...baseSummary,
      reason: `Patch range is unavailable: ${unavailableReason}`,
      unavailableReason,
    };
  }

  const populatedSummary = {
    ...baseSummary,
    commitCount: commits.length,
    changedFileCount: changedFiles.length,
    changedFiles,
  };
  if (commits.length === 0 || changedFiles.length === 0) {
    return {
      ...populatedSummary,
      reason: 'Completed run produced an empty patch range.',
    };
  }

  if (squash.status === 'malformed') {
    return {
      ...populatedSummary,
      reason: 'SQUASH_RESULT.json is malformed; default submission requires an auditable patch head.',
      unavailableReason: squash.unavailableReason,
    };
  }
  if (squash.status === 'pending') {
    return {
      ...populatedSummary,
      reason: 'Squash artifact is pending; default submission requires finalized patch metadata.',
    };
  }
  if (!isCleanCompletedExecuteRun(state, displayStatus)) {
    return {
      ...populatedSummary,
      reason: `Run status is ${displayStatus.effectiveStatus}; default submission requires a completed execute run.`,
    };
  }

  return {
    ...populatedSummary,
    defaultSubmissionEligible: true,
    reason: 'Completed execute run has a non-empty patch range.',
  };
}

function selectPatchCandidate(state: OrchestrationState, squash: NealSquashStatusSummary): PatchCandidate {
  if (squash.status === 'complete' && squash.originalBaseCommit && squash.replacementCommit) {
    return {
      source: 'squash_replacement',
      baseCommit: squash.originalBaseCommit,
      headCommit: squash.replacementCommit,
    };
  }

  const baseCommit = state.initialBaseCommit ?? state.baseCommit;
  if (baseCommit || state.finalCommit) {
    return {
      source: 'final_commit',
      baseCommit,
      headCommit: state.finalCommit,
    };
  }

  return {
    source: 'none',
    baseCommit: null,
    headCommit: null,
  };
}

function isCleanCompletedExecuteRun(state: OrchestrationState, displayStatus: RunDisplayStatus) {
  return (
    state.topLevelMode === 'execute' &&
    state.phase === 'done' &&
    state.status === 'done' &&
    displayStatus.effectiveStatus === 'done' &&
    !displayStatus.waitingForOperatorGuidance &&
    !displayStatus.pendingOperatorGuidance
  );
}

function providerRoleValue(value: unknown): ProviderRole | null {
  return value === 'coder' || value === 'structured-advisor' ? value : null;
}

function providerErrorKindValue(value: unknown): NealProviderErrorKind | null {
  return typeof value === 'string' && PROVIDER_ERROR_KINDS.has(value as NealProviderErrorKind)
    ? value as NealProviderErrorKind
    : null;
}

const STATUS_PROVIDER_DIAGNOSTIC_MAX_STRING_LENGTH = 2_000;
const STATUS_PROVIDER_DIAGNOSTIC_MAX_DEPTH = 4;

function providerErrorDiagnosticValue(providerData: unknown): Record<string, unknown> | null {
  if (typeof providerData !== 'object' || providerData === null) {
    return null;
  }
  const diagnostic = (providerData as { diagnostic?: unknown }).diagnostic;
  const sanitized = sanitizeProviderDiagnostic(diagnostic);
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : null;
}

function sanitizeProviderDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > STATUS_PROVIDER_DIAGNOSTIC_MAX_DEPTH) {
    return '[truncated: max depth]';
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.length <= STATUS_PROVIDER_DIAGNOSTIC_MAX_STRING_LENGTH) {
      return value;
    }
    return `${value.slice(0, STATUS_PROVIDER_DIAGNOSTIC_MAX_STRING_LENGTH)}...[truncated ${value.length - STATUS_PROVIDER_DIAGNOSTIC_MAX_STRING_LENGTH} chars]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeProviderDiagnostic(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return null;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sanitizeProviderDiagnostic(nestedValue, depth + 1);
  }
  return output;
}

function nullableStringValue(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function truncateStatusMessage(value: string) {
  if (value.length <= STATUS_ERROR_MESSAGE_MAX_LENGTH) {
    return value;
  }
  return `${value.slice(0, STATUS_ERROR_MESSAGE_MAX_LENGTH - 3)}...`;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
