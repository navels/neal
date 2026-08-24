import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { CoderRoundError } from '../../agents.js';
import { writeDetail } from '../../diagnostic.js';
import type { RunLogger } from '../../logger.js';
import { writeCheckpointRetrospective } from '../../retrospective.js';
import { getCurrentScopeLabel, getParentScopeLabel, isExecutingDerivedPlan } from '../../scopes.js';
import { saveState } from '../../state.js';
import { getDerivedPlanView } from '../../state-views.js';
import type { OrchestrationState, ReviewFindingSource } from '../../types.js';
import { writeExecutionArtifacts } from '../artifacts.js';
import { isCoderFreshSessionRetryableError, isCoderTimeoutError } from '../failures.js';
import { notifyRetry } from '../notifications.js';
import { appendCompletedScope } from '../transitions.js';

const execFile = promisify(execFileCallback);

export type CoderFailurePhase =
  | 'coder_scope'
  | 'coder_plan'
  | 'coder_response'
  | 'coder_optional_response'
  | 'coder_plan_response'
  | 'coder_plan_optional_response'
  | 'interactive_blocked_recovery';

export type CoderFreshSessionRetryPhase = CoderFailurePhase;
type WriterSessionRole = 'planner' | 'coder';

function getWriterSessionRoleForPhase(phase: CoderFailurePhase): WriterSessionRole {
  return phase === 'coder_plan' || phase === 'coder_plan_response' || phase === 'coder_plan_optional_response'
    ? 'planner'
    : 'coder';
}

function getWriterSessionState(args: {
  state: OrchestrationState;
  phase: CoderFailurePhase;
  errorSessionHandle: string | null;
}) {
  const role = getWriterSessionRoleForPhase(args.phase);
  if (role === 'planner') {
    const sessionHandle = args.errorSessionHandle ?? args.state.plannerSessionHandle;
    return {
      role,
      sessionHandle,
      protocol: sessionHandle ? args.state.plannerSessionProtocol ?? 'structured_json_v1' : null,
    };
  }

  const sessionHandle = args.errorSessionHandle ?? args.state.coderSessionHandle;
  return {
    role,
    sessionHandle,
    protocol: sessionHandle ? args.state.coderSessionProtocol ?? 'structured_json_v1' : null,
  };
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

export function printReviewResult(
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
  writeDetail(`${message}\n`, logger, {
    role: 'reviewer',
  });
}

export async function persistCoderFailureState(
  state: OrchestrationState,
  statePath: string,
  phase: CoderFailurePhase,
  error: CoderRoundError,
  logger?: RunLogger,
) {
  const writerSession = getWriterSessionState({ state, phase, errorSessionHandle: error.sessionHandle });
  const failedState = await saveState(statePath, {
    ...state,
    ...(writerSession.role === 'planner'
      ? {
          plannerSessionHandle: writerSession.sessionHandle,
          plannerSessionProtocol: writerSession.protocol,
        }
      : {
          coderSessionHandle: writerSession.sessionHandle,
          coderSessionProtocol: writerSession.protocol,
        }),
    status: 'failed',
  });
  await writeExecutionArtifacts(failedState);
  await writeCheckpointRetrospective(failedState, 'failed');
  await logger?.event('phase.error', {
    phase,
    role: writerSession.role,
    sessionHandle: writerSession.sessionHandle,
    message: error.message,
  });
  return failedState;
}

export async function persistBlockedScope(state: OrchestrationState, statePath: string, reason: string) {
  const scopeLabel = getCurrentScopeLabel(state);
  if (state.completedScopes.some((scope) => scope.number === scopeLabel)) {
    return state;
  }

  const derivedPlan = getDerivedPlanView(state);
  const blockedDuringDerivedPlanReview =
    !derivedPlan?.executing &&
    derivedPlan?.unexecuted === true &&
    derivedPlan.parentScopeNumber === state.currentScopeNumber;

  const nextState = await saveState(statePath, {
    ...state,
    blockedFromPhase: state.blockedFromPhase ?? state.phase,
    completedScopes: appendCompletedScope(state, 'blocked', {
      scopeLabel: getCurrentScopeLabel(state),
      finalCommit: null,
      summary: null,
      commitSubject: null,
      archivedReviewPath: state.archivedReviewPath,
      blocker: reason,
      derivedFromParentScope: isExecutingDerivedPlan(state) ? getParentScopeLabel(state) : null,
      replacedByDerivedPlanPath: blockedDuringDerivedPlanReview ? derivedPlan.path : null,
    }),
  });
  await writeExecutionArtifacts(nextState);
  return nextState;
}

export function shouldRetryCoderWithFreshSession(
  state: OrchestrationState,
  phase: CoderFreshSessionRetryPhase,
  error: CoderRoundError,
) {
  if (!isCoderFreshSessionRetryableError(error) || state.coderRetryCount >= 1) {
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

type ChildProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

function parseProcessRows(output: string): ChildProcessRow[] {
  const rows: ChildProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    });
  }
  return rows;
}

async function findOwnCodexExecChildPids() {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,command=']);
  return parseProcessRows(stdout)
    .filter((row) => row.ppid === process.pid)
    .filter((row) => /\bcodex exec\b/.test(row.command))
    .map((row) => row.pid);
}

async function killOwnCodexExecChildren(logger: RunLogger | undefined, sessionHandle: string) {
  let pids: number[];
  try {
    pids = await findOwnCodexExecChildPids();
  } catch (error) {
    await logger?.event('coder.timeout_cleanup_child_scan_failed', {
      sessionHandle,
      details: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (pids.length === 0) {
    return false;
  }

  const termResults = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      termResults.push({ pid, result: 'signaled' });
    } catch (error) {
      termResults.push({
        pid,
        result: 'failed',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await logger?.event('coder.timeout_cleanup', {
    sessionHandle,
    pids,
    result: 'killed_child_codex_exec',
    signals: termResults,
  });
  return true;
}

export async function bestEffortCleanupTimedOutCoder(sessionHandle: string | null, logger?: RunLogger) {
  if (!sessionHandle) {
    return;
  }

  const killedChild = await killOwnCodexExecChildren(logger, sessionHandle);
  if (killedChild) {
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

function getCoderFreshSessionRetryMessage(
  state: OrchestrationState,
  phase: CoderFreshSessionRetryPhase,
  error: CoderRoundError,
) {
  const reason = isCoderTimeoutError(error) ? 'timed out' : 'hit an unusable resume session';
  const role = getWriterSessionRoleForPhase(phase);
  return state.topLevelMode === 'plan'
    ? `planning phase ${phase} ${reason}; retrying with a fresh ${role} session`
    : `scope ${state.currentScopeNumber} ${reason} in ${phase}; retrying with a fresh ${role} session`;
}

export async function scheduleCoderFreshSessionRetry(
  state: OrchestrationState,
  statePath: string,
  phase: CoderFreshSessionRetryPhase,
  error: CoderRoundError,
  logger?: RunLogger,
) {
  const writerSession = getWriterSessionState({ state, phase, errorSessionHandle: error.sessionHandle });
  if (isCoderTimeoutError(error)) {
    await bestEffortCleanupTimedOutCoder(writerSession.sessionHandle, logger);
  }
  const retryState = await saveState(statePath, {
    ...state,
    ...(writerSession.role === 'planner'
      ? {
          plannerSessionHandle: null,
          plannerSessionProtocol: null,
        }
      : {
          coderSessionHandle: null,
          coderSessionProtocol: null,
        }),
    coderRetryCount: state.coderRetryCount + 1,
    status: 'running',
    phase,
  });
  await writeExecutionArtifacts(retryState);
  await logger?.event('phase.retry', {
    phase,
    role: writerSession.role,
    sessionHandle: writerSession.sessionHandle,
    retryCount: retryState.coderRetryCount,
    message: error.message,
  });
  await notifyRetry(
    retryState,
    getCoderFreshSessionRetryMessage(retryState, phase, error),
    logger,
  );
  return retryState;
}
