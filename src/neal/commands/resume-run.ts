import process from 'node:process';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseResumeArgs } from '../cli.js';
import { assertWriterProvidersConfigured } from '../config.js';
import { writeDiagnostic } from '../diagnostic.js';
import { assertGitRepositoryWithCommit } from '../git.js';
import { loadOrInitialize } from '../orchestrator.js';
import {
  continuePlanAndExecuteQueueFromChildRun,
  inspectQueueChildResumeEvidence,
  type ContinuePlanAndExecuteQueueFromChildRunArgs,
  type PlanAndExecuteQueueState,
} from '../plan-queue.js';
import { assertAgentConfigSupportsResume } from '../providers/registry.js';
import { decideResumeAction, type ResumeDecision, type ResumeLockEvidence } from '../resume-decision.js';
import { runManualGateResumeChecks, type ManualGateCheckFailure } from '../manual-gates.js';
import { writeExecutionArtifacts } from '../orchestrator/artifacts.js';
import {
  ActiveRunLockError,
  acquireActiveRunLock,
  clearStaleActiveRunLockForResume,
  inspectActiveRunLock,
  type ActiveRunLockHandle,
} from '../run-lock.js';
import type { RunLogger } from '../logger.js';
import { getDefaultAgentConfig, saveState } from '../state.js';
import type { OrchestrationState } from '../types.js';
import { recordRecoveryGuidanceForResolvedRun } from './recovery-guidance.js';
import {
  executeRun,
  resolveWriterRunSelection,
  withActiveRunLock,
  type ExecuteRunResult,
  type ResolvedWriterRunSelection,
} from './runtime.js';
import {
  getExecuteRunResultExitCode,
  getPlanAndExecuteQueueExitCode,
  setWriterCommandExitCode,
} from './writer-exit-codes.js';

export type ResumeRunCommandDeps = {
  continueQueueFromChildRun?: (
    args: ContinuePlanAndExecuteQueueFromChildRunArgs,
  ) => Promise<PlanAndExecuteQueueState | null>;
};

type ResumeAlreadyRunningOutcome = { kind: 'already_running' };

type ResumeRunOutcome =
  | { kind: 'resumed_child'; result: ExecuteRunResult }
  | { kind: 'already_done' }
  | ResumeAlreadyRunningOutcome
  | { kind: 'waiting_for_operator_guidance' }
  | { kind: 'manual_gate_check_failed' };

export async function runResumeRunCommand(args: string[], deps: ResumeRunCommandDeps = {}): Promise<void> {
  const parsed = parseResumeArgs(args);
  const cwd = process.cwd();
  const selection = await resolveResumeSelectionOrSetupGuidance(parsed.runId, cwd);
  await assertGitRepositoryWithCommit(selection.state.cwd, 'neal resume');
  const lock = await inspectActiveRunLock(cwd, selection.selectedRunId);
  const decision = decideResumeAction({
    state: selection.state,
    selectedRunId: selection.selectedRunId,
    statePath: selection.statePath,
    lock,
    queue: await inspectQueueChildResumeEvidence({ cwd: selection.state.cwd, runDir: selection.state.runDir }),
    retrospectivePath: await findLatestRetrospectiveMarkdownPath(selection.state.runDir),
  });

  if (parsed.message !== null && isWaitingForManualGate(selection.state)) {
    throw new Error(
      [
        `Run is waiting for manual gate ${selection.state.manualGate.id}: ${selection.state.manualGate.title}`,
        `Complete the manual work and resume without --message: neal resume --run ${selection.selectedRunId}`,
        `Instructions: ${selection.state.manualGate.instructionsPath}`,
      ].join('\n'),
    );
  }

  const result = parsed.message === null
    ? await runPlainResume({ selection, decision, lock })
    : await runMessageResume({ selection, decision, lock, message: parsed.message });

  await applyResumeRunExitCode(result, deps);
}

async function resolveResumeSelectionOrSetupGuidance(runId: string | null, cwd: string): Promise<ResolvedWriterRunSelection> {
  try {
    return await resolveWriterRunSelection({
      runId,
    });
  } catch (error) {
    if (runId === null || runId === 'latest') {
      assertWriterProvidersConfigured(cwd, { context: 'resume writer run' });
    }
    throw error;
  }
}

async function runPlainResume(args: {
  selection: ResolvedWriterRunSelection;
  decision: ResumeDecision;
  lock: ResumeLockEvidence;
}): Promise<ResumeRunOutcome> {
  if (isWaitingForManualGate(args.selection.state)) {
    switch (args.decision.kind) {
      case 'continue':
      case 'pending_message':
        return resumeManualGateRun(args.selection, args.lock);
      case 'already_running':
        process.stdout.write(formatAlreadyRunningMessage(args.decision));
        return { kind: 'already_running' };
      case 'done':
        process.stdout.write(formatDoneMessage(args.decision));
        return { kind: 'already_done' };
      case 'needs_message':
        process.stdout.write(`${formatNeedsMessageResumeRejection(args.decision)}\n`);
        return { kind: 'waiting_for_operator_guidance' };
      case 'cannot_resume':
        throw new Error(formatCannotResumeMessage(args.decision));
    }
  }

  switch (args.decision.kind) {
    case 'continue':
    case 'pending_message':
      return resumeExecutableRun(args.selection, args.lock);
    case 'needs_message':
      process.stdout.write(`${formatNeedsMessageResumeRejection(args.decision)}\n`);
      return { kind: 'waiting_for_operator_guidance' };
    case 'already_running':
      process.stdout.write(formatAlreadyRunningMessage(args.decision));
      return { kind: 'already_running' };
    case 'done':
      process.stdout.write(formatDoneMessage(args.decision));
      return { kind: 'already_done' };
    case 'cannot_resume':
      throw new Error(formatCannotResumeMessage(args.decision));
  }
}

async function runMessageResume(args: {
  selection: ResolvedWriterRunSelection;
  decision: ResumeDecision;
  lock: ResumeLockEvidence;
  message: string;
}): Promise<ResumeRunOutcome> {
  switch (args.decision.kind) {
    case 'needs_message':
      return resumeAfterRecordingGuidance(args.selection, args.lock, args.decision, args.message);
    case 'pending_message':
      throw new Error(
        [
          args.decision.reason,
          `Run \`${args.decision.resumeCommand}\` without --message to let Neal handle it before recording more guidance.`,
        ].join('\n'),
      );
    case 'continue':
      throw new Error(`Run does not need --message. Resume it with: ${args.decision.resumeCommand}`);
    case 'already_running':
      throw new Error(formatAlreadyRunningMessage(args.decision).trimEnd());
    case 'done':
      throw new Error(formatDoneMessage(args.decision).trimEnd());
    case 'cannot_resume':
      throw new Error(formatCannotResumeMessage(args.decision));
  }
}

async function resumeAfterRecordingGuidance(
  selection: ResolvedWriterRunSelection,
  lock: ResumeLockEvidence,
  decision: Extract<ResumeDecision, { kind: 'needs_message' }>,
  message: string,
): Promise<ResumeRunOutcome> {
  return withResumeWriterLock(selection, lock, async () => {
    const guidanceResult = await recordRecoveryGuidanceForResolvedRun({
      target: {
        statePath: selection.statePath,
        selectedRunId: selection.selectedRunId,
      },
      message,
      decision,
    });

    if (guidanceResult.kind === 'pending') {
      throw new Error(formatPendingGuidanceMessage(guidanceResult));
    }

    writeDiagnostic(`[neal] recovery guidance recorded; resuming: ${guidanceResult.resumeCommand}\n`);
    const loaded = {
      state: guidanceResult.nextState,
      statePath: guidanceResult.statePath,
      logger: guidanceResult.logger,
    };
    assertAgentConfigSupportsResume(loaded.state.agentConfig, loaded.state, {
      context: 'resume after recording recovery guidance',
    });
    return {
      kind: 'resumed_child',
      result: await executeResumedRun(loaded.state, loaded.statePath, loaded.logger),
    } satisfies ResumeRunOutcome;
  });
}

function formatPendingGuidanceMessage(guidanceResult: Awaited<ReturnType<typeof recordRecoveryGuidanceForResolvedRun>>) {
  if (guidanceResult.kind !== 'pending') {
    throw new Error('Expected pending guidance result');
  }

  const firstLine = guidanceResult.guidanceKind === 'plan_review'
    ? '[neal] plan-review guidance is already pending.'
    : `[neal] recovery guidance is already pending for turn ${guidanceResult.pendingTurn}.`;
  return [
    firstLine,
    `Run \`${guidanceResult.resumeCommand}\` without --message to let Neal handle it before recording more guidance.`,
  ].join('\n');
}

async function resumeExecutableRun(
  selection: ResolvedWriterRunSelection,
  lock: ResumeLockEvidence,
): Promise<ResumeRunOutcome> {
  return withResumeWriterLock(selection, lock, async () => {
    const loaded = await loadOrInitialize(
      null,
      selection.state.cwd,
      getDefaultAgentConfig(selection.state.cwd),
      selection.statePath,
      selection.state.topLevelMode,
    );
    assertAgentConfigSupportsResume(loaded.state.agentConfig, loaded.state, { context: 'resume writer run' });
    return {
      kind: 'resumed_child',
      result: await executeResumedRun(loaded.state, loaded.statePath, loaded.logger),
    } satisfies ResumeRunOutcome;
  });
}

async function resumeManualGateRun(
  selection: ResolvedWriterRunSelection,
  lock: ResumeLockEvidence,
): Promise<ResumeRunOutcome> {
  return withResumeWriterLock(selection, lock, async () => {
    const loaded = await loadOrInitialize(
      null,
      selection.state.cwd,
      getDefaultAgentConfig(selection.state.cwd),
      selection.statePath,
      selection.state.topLevelMode,
    );
    if (!isWaitingForManualGate(loaded.state)) {
      return {
        kind: 'resumed_child',
        result: await executeResumedRun(loaded.state, loaded.statePath, loaded.logger),
      } satisfies ResumeRunOutcome;
    }

    const checkResult = await runManualGateResumeChecks(loaded.state);
    const checkedAt = new Date().toISOString();
    if (!checkResult.ok) {
      const failedState = await saveState(loaded.statePath, {
        ...loaded.state,
        manualGate: {
          ...loaded.state.manualGate,
          updatedAt: checkedAt,
          lastCheckedAt: checkedAt,
          lastFailure: toPersistedManualGateFailure(checkResult.failure),
        },
      });
      await writeExecutionArtifacts(failedState);
      await loaded.logger.event('manual_gate.check_failed', {
        gateId: failedState.manualGate?.id ?? null,
        checkName: checkResult.failure.checkName,
        exitCode: checkResult.failure.exitCode,
        signal: checkResult.failure.signal,
        instructionsPath: failedState.manualGate?.instructionsPath ?? null,
      });
      process.stdout.write(formatManualGateCheckFailure(failedState, checkResult.failure));
      return { kind: 'manual_gate_check_failed' };
    }

    const gate = loaded.state.manualGate;
    const resumedState = await saveState(loaded.statePath, {
      ...loaded.state,
      phase: gate.resumePhase,
      status: 'running',
      blockedFromPhase: null,
      manualGate: null,
    });
    await writeExecutionArtifacts(resumedState);
    await loaded.logger.event('manual_gate.checks_passed', {
      gateId: gate.id,
      checkNames: checkResult.results.map((result) => result.checkName),
      resumePhase: resumedState.phase,
    });
    return {
      kind: 'resumed_child',
      result: await executeResumedRun(resumedState, loaded.statePath, loaded.logger),
    } satisfies ResumeRunOutcome;
  });
}

function executeResumedRun(
  state: OrchestrationState,
  statePath: string,
  logger: RunLogger,
) {
  return executeRun(state, statePath, logger, {
    // Honor the squash preference persisted at run creation (`--no-squash`)
    // instead of re-deriving it, exactly as `unattended` is. Legacy states
    // missing the field hydrate to true, keeping the historical behavior.
    autoSquashOnCompletion: state.autoSquashOnCompletion,
  });
}

function isWaitingForManualGate(state: OrchestrationState): state is OrchestrationState & {
  phase: 'manual_gate';
  manualGate: NonNullable<OrchestrationState['manualGate']>;
} {
  return state.phase === 'manual_gate' && state.manualGate !== null;
}

function toPersistedManualGateFailure(failure: ManualGateCheckFailure) {
  return {
    checkName: failure.checkName,
    exitCode: failure.exitCode,
    signal: failure.signal,
    stdoutTail: failure.stdoutTail,
    stderrTail: failure.stderrTail,
  };
}

function formatManualGateCheckFailure(state: OrchestrationState, failure: ManualGateCheckFailure) {
  const gate = state.manualGate;
  if (!gate) {
    throw new Error('Expected manual gate state while formatting failed resume check.');
  }
  const runId = basename(state.runDir);
  const status = failure.signal ? `signal ${failure.signal}` : `exit code ${failure.exitCode ?? 'unknown'}`;
  const lines = [
    `[neal] Manual gate ${gate.id} is still waiting: check ${failure.checkName} failed with ${status}.`,
    `[neal] Instructions: ${gate.instructionsPath}`,
    `[neal] Resume after completing the manual work: neal resume --run ${runId}`,
  ];

  if (failure.stdoutTail) {
    lines.push('[neal] stdout tail:', failure.stdoutTail.trimEnd());
  }
  if (failure.stderrTail) {
    lines.push('[neal] stderr tail:', failure.stderrTail.trimEnd());
  }

  return `${lines.join('\n')}\n`;
}

function emitAlreadyRunningOutcome(selection: ResolvedWriterRunSelection): ResumeAlreadyRunningOutcome {
  process.stdout.write(
    formatAlreadyRunningMessage({
      kind: 'already_running',
      reason: `Run ${selection.selectedRunId} appears to already be running under the active writer lock.`,
      statusCommand: `neal status --run ${selection.selectedRunId}`,
    }),
  );
  return { kind: 'already_running' };
}

async function withResumeWriterLock<T extends ResumeRunOutcome>(
  selection: ResolvedWriterRunSelection,
  evidence: ResumeLockEvidence,
  action: () => Promise<T>,
): Promise<T | ResumeAlreadyRunningOutcome> {
  let lock: ActiveRunLockHandle;
  try {
    lock = await acquireResumeWriterLock(selection, evidence);
  } catch (error) {
    // A live same-run lock owned by a different process means a concurrent
    // `neal resume` won the acquisition race after this process passed the
    // read-only decision layer. That is the same operator situation as the
    // shared-handle path below, so it gets the same graceful already-running
    // outcome (exit 2) instead of a hard failure.
    if (error instanceof ActiveRunLockError && error.kind === 'active_same_run') {
      return emitAlreadyRunningOutcome(selection);
    }
    throw error;
  }
  if (!lock.acquired) {
    await lock.release();
    return emitAlreadyRunningOutcome(selection);
  }

  return withActiveRunLock(lock, action);
}

async function applyResumeRunExitCode(
  outcome: ResumeRunOutcome,
  deps: ResumeRunCommandDeps,
): Promise<void> {
  switch (outcome.kind) {
    case 'already_done':
      setWriterCommandExitCode(0);
      return;
    case 'already_running':
    case 'waiting_for_operator_guidance':
    case 'manual_gate_check_failed':
      setWriterCommandExitCode(2);
      return;
    case 'resumed_child': {
      const continueQueueFromChildRun = deps.continueQueueFromChildRun ?? continuePlanAndExecuteQueueFromChildRun;
      const queueState = await continueQueueFromChildRun({
        childResult: outcome.result,
        agentConfig: outcome.result.finalState.agentConfig,
        // Source unattended from the resumed child's persisted state, exactly as
        // agentConfig is, so the queue continuation keeps headless runs headless.
        unattended: outcome.result.finalState.unattended,
        // Likewise source the squash preference from the resumed child's
        // persisted state so remaining queue items keep honoring --no-squash.
        squashOnCompletion: outcome.result.finalState.autoSquashOnCompletion,
      });
      setWriterCommandExitCode(
        queueState
          ? getPlanAndExecuteQueueExitCode(queueState)
          : getExecuteRunResultExitCode(outcome.result),
      );
    }
  }
}

async function acquireResumeWriterLock(
  selection: ResolvedWriterRunSelection,
  evidence: ResumeLockEvidence,
): Promise<ActiveRunLockHandle> {
  const cwd = process.cwd();
  await clearStaleActiveRunLockForResume(cwd, evidence);

  try {
    return await acquireActiveRunLock({
      cwd,
      runId: selection.selectedRunId,
      runStatePath: selection.statePath,
      planDoc: selection.state.planDoc,
      topLevelMode: selection.state.topLevelMode,
    });
  } catch (error) {
    if (!(error instanceof ActiveRunLockError) || error.kind !== 'stale_same_host') {
      throw error;
    }

    const refreshedEvidence = await inspectActiveRunLock(cwd, selection.selectedRunId);
    await clearStaleActiveRunLockForResume(cwd, refreshedEvidence);
    return acquireActiveRunLock({
      cwd,
      runId: selection.selectedRunId,
      runStatePath: selection.statePath,
      planDoc: selection.state.planDoc,
      topLevelMode: selection.state.topLevelMode,
    });
  }
}

function formatNeedsMessageResumeRejection(decision: Extract<ResumeDecision, { kind: 'needs_message' }>) {
  return [
    `Run is waiting for operator guidance: ${decision.blocker}`,
    `Record guidance and resume with: ${decision.messageCommand}`,
    `Inspect status with: ${decision.statusCommand}`,
  ].join('\n');
}

function formatAlreadyRunningMessage(decision: Extract<ResumeDecision, { kind: 'already_running' }>) {
  return [`[neal] ${decision.reason}`, `[neal] Inspect status with: ${decision.statusCommand}`].join('\n') + '\n';
}

function formatDoneMessage(decision: Extract<ResumeDecision, { kind: 'done' }>) {
  const lines = [`[neal] ${decision.summary}`];
  if (decision.retrospectivePath) {
    lines.push(`[neal] Retrospective: ${decision.retrospectivePath}`);
  } else {
    lines.push(`[neal] Inspect status with: ${decision.statusCommand}`);
  }
  return lines.join('\n') + '\n';
}

function formatCannotResumeMessage(decision: Extract<ResumeDecision, { kind: 'cannot_resume' }>) {
  return [decision.reason, `Inspect status and artifacts with: ${decision.statusCommand}`].join('\n');
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

function isNotFoundError(error: unknown) {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
