import { basename } from 'node:path';

import { RunLogger } from '../logger.js';
import {
  InteractiveBlockedRecoveryPendingTurnError,
  recordInteractiveBlockedRecoveryGuidance,
} from '../orchestrator/phases/recovery.js';
import { writeExecutionArtifacts } from '../orchestrator/artifacts.js';
import { assertAgentConfigSupportsResume } from '../providers/registry.js';
import { formatPublicPhase } from '../phase-display.js';
import { logUserGuidanceApplied } from '../prompts/guidance.js';
import { decideResumeAction, type ResumeDecision } from '../resume-decision.js';
import { getPlanReviewGuidanceOriginPhase } from '../state-views.js';
import { loadState, saveState } from '../state.js';
import type { OrchestrationState } from '../types.js';

export type RecoveryGuidanceTarget = {
  statePath: string;
  selectedRunId: string | null;
};

export type RecoveryGuidanceRecordedResult = {
  kind: 'recorded';
  statePath: string;
  runDir: string;
  nextState: OrchestrationState;
  logger: RunLogger;
  recoveryTurns: number;
  terminalDirectivePending: boolean;
  resumeCommand: string;
};

export type RecoveryGuidancePendingResult = {
  kind: 'pending';
  guidanceKind: 'interactive_blocked_recovery' | 'plan_review';
  statePath: string;
  runDir: string;
  message: string;
  pendingTurn: number | null;
  recoveryTurns: number;
  resumeCommand: string;
};

export type RecoveryGuidanceResult = RecoveryGuidanceRecordedResult | RecoveryGuidancePendingResult;

function getSelectedRunId(state: OrchestrationState, selectedRunId: string | null) {
  return selectedRunId && selectedRunId !== 'latest' ? selectedRunId : basename(state.runDir);
}

function getResumeCommand(state: OrchestrationState, target: RecoveryGuidanceTarget) {
  return `neal resume --run ${getSelectedRunId(state, target.selectedRunId)}`;
}

function getUnsupportedModeMessage(state: OrchestrationState) {
  return `neal resume --message is only supported for execute-mode recovery or blocked plan review; selected run is ${state.topLevelMode}-mode`;
}

function describeGuidanceStateProblem(
  state: OrchestrationState,
  target: RecoveryGuidanceTarget,
) {
  if (state.phase === 'interactive_blocked_recovery' && !state.interactiveBlockedRecovery) {
    return [
      'neal resume --message cannot record guidance because the selected run is waiting for recovery guidance but has no blocked-recovery state.',
      `Run id: ${getSelectedRunId(state, target.selectedRunId)}`,
      `State path: ${target.statePath}`,
    ].join('\n');
  }

  return [
    'neal resume --message can record guidance only while the selected run is waiting in interactive blocked recovery.',
    `Run id: ${getSelectedRunId(state, target.selectedRunId)}`,
    `Current step: ${formatPublicPhase(state.phase)}`,
    `Status: ${state.status}`,
    `State path: ${target.statePath}`,
  ].join('\n');
}

function describePlanReviewGuidanceStateProblem(
  state: OrchestrationState,
  target: RecoveryGuidanceTarget,
) {
  return [
    'neal resume --message can record plan-review guidance only while a top-level plan run is blocked from reviewer_plan with no pending guidance.',
    `Run id: ${getSelectedRunId(state, target.selectedRunId)}`,
    `Current step: ${formatPublicPhase(state.phase)}`,
    `Status: ${state.status}`,
    `Blocked from: ${state.blockedFromPhase ?? 'none'}`,
    `State path: ${target.statePath}`,
  ].join('\n');
}

function getPendingRecoveryTurn(state: OrchestrationState) {
  const recovery = state.interactiveBlockedRecovery;
  if (!recovery) {
    return 0;
  }
  if (recovery.pendingDirective) {
    return recovery.turns.length + 1;
  }
  return recovery.turns.find((turn) => turn.number > recovery.lastHandledTurn)?.number ?? recovery.turns.length;
}

function formatGuidanceDecisionRejection(decision: Exclude<ResumeDecision, { kind: 'needs_message' | 'pending_message' }>) {
  switch (decision.kind) {
    case 'continue':
      return `Run does not need --message. Resume it with: ${decision.resumeCommand}`;
    case 'already_running':
      return `${decision.reason}\nInspect status with: ${decision.statusCommand}`;
    case 'done':
      return decision.retrospectivePath
        ? `${decision.summary}\nReview latest retrospective: ${decision.retrospectivePath}`
        : `${decision.summary}\nInspect status with: ${decision.statusCommand}`;
    case 'cannot_resume':
      return `${decision.reason}\nInspect status and artifacts with: ${decision.statusCommand}`;
  }
}

function isEligiblePlanReviewGuidanceState(state: OrchestrationState) {
  // Shared discriminator: reviewer_plan plus coder-authored *response* blocks
  // (blockerReason non-null). A dirty-worktree safety block lands at the same
  // response phase with blockerReason null and is not answerable via --message.
  return getPlanReviewGuidanceOriginPhase(state) !== null;
}

async function recordPlanReviewGuidance(args: {
  state: OrchestrationState;
  target: RecoveryGuidanceTarget;
  message: string;
  decision: ResumeDecision;
}): Promise<RecoveryGuidanceResult> {
  const resumeCommand = getResumeCommand(args.state, args.target);

  if (args.decision.kind === 'pending_message') {
    return {
      kind: 'pending',
      guidanceKind: 'plan_review',
      statePath: args.target.statePath,
      runDir: args.state.runDir,
      message: args.decision.reason,
      pendingTurn: null,
      recoveryTurns: args.state.interactiveBlockedRecovery?.turns.length ?? 0,
      resumeCommand,
    };
  }

  if (args.decision.kind !== 'needs_message') {
    throw new Error(formatGuidanceDecisionRejection(args.decision));
  }

  const trimmedGuidance = args.message.trim();
  if (!trimmedGuidance) {
    throw new Error('Plan review guidance must not be empty');
  }

  if (!isEligiblePlanReviewGuidanceState(args.state)) {
    throw new Error(describePlanReviewGuidanceStateProblem(args.state, args.target));
  }

  const originPhase = getPlanReviewGuidanceOriginPhase(args.state);
  if (originPhase === null) {
    throw new Error(describePlanReviewGuidanceStateProblem(args.state, args.target));
  }
  // Map the origin block to the phase that will actually consume the guidance:
  // a reviewer_plan block delivers to coder_plan_response (unchanged behavior),
  // while a coder-authored response block returns to its own origin phase so the
  // resumed round selects the right open findings and delivers the guidance
  // instead of accepting on an empty blocking set.
  const resumePhase: 'coder_plan_response' | 'coder_plan_optional_response' =
    originPhase === 'reviewer_plan' ? 'coder_plan_response' : originPhase;

  assertAgentConfigSupportsResume(args.state.agentConfig, args.state, {
    context: 'record plan-review guidance for resume',
  });
  const logger = new RunLogger(args.state.runDir);
  await logger.event('run.resumed', {
    statePath: args.target.statePath,
    phase: args.state.phase,
    status: args.state.status,
    agentConfig: args.state.agentConfig,
  });
  await logUserGuidanceApplied(logger);

  const nextState = await saveState(args.target.statePath, {
    ...args.state,
    phase: resumePhase,
    status: 'running',
    blockedFromPhase: null,
    // Returning to running clears the durable coder-authored blocker reason.
    blockerReason: null,
    pendingPlanReviewGuidance: {
      message: trimmedGuidance,
      sourcePhase: originPhase,
      recordedAt: new Date().toISOString(),
    },
  });
  await writeExecutionArtifacts(nextState);
  await logger.event('plan_review_guidance.recorded', {
    statePath: args.target.statePath,
    sourcePhase: originPhase,
    guidanceBytes: Buffer.byteLength(trimmedGuidance, 'utf8'),
  });

  return {
    kind: 'recorded',
    statePath: args.target.statePath,
    runDir: nextState.runDir,
    nextState,
    logger,
    recoveryTurns: nextState.interactiveBlockedRecovery?.turns.length ?? 0,
    terminalDirectivePending: false,
    resumeCommand,
  };
}

export async function recordRecoveryGuidanceForResolvedRun(args: {
  target: RecoveryGuidanceTarget;
  message: string;
  decision?: ResumeDecision;
}): Promise<RecoveryGuidanceResult> {
  const state = await loadState(args.target.statePath);
  const selectedRunId = getSelectedRunId(state, args.target.selectedRunId);
  const currentStateDecision = decideResumeAction({
    state,
    selectedRunId,
    statePath: args.target.statePath,
  });
  const decision = args.decision?.kind === 'needs_message'
    ? currentStateDecision
    : args.decision ?? currentStateDecision;

  if (state.topLevelMode === 'plan') {
    return recordPlanReviewGuidance({
      state,
      target: args.target,
      message: args.message,
      decision,
    });
  }

  if (state.topLevelMode !== 'execute') {
    throw new Error(getUnsupportedModeMessage(state));
  }

  if (decision.kind === 'pending_message') {
    return {
      kind: 'pending',
      guidanceKind: 'interactive_blocked_recovery',
      statePath: args.target.statePath,
      runDir: state.runDir,
      message: decision.reason,
      pendingTurn: getPendingRecoveryTurn(state),
      recoveryTurns: state.interactiveBlockedRecovery?.turns.length ?? 0,
      resumeCommand: decision.resumeCommand,
    };
  }

  if (decision.kind !== 'needs_message') {
    throw new Error(formatGuidanceDecisionRejection(decision));
  }

  if (state.phase !== 'interactive_blocked_recovery' || !state.interactiveBlockedRecovery) {
    throw new Error(describeGuidanceStateProblem(state, args.target));
  }

  const resumeCommand = getResumeCommand(state, args.target);
  assertAgentConfigSupportsResume(state.agentConfig, state, { context: 'record recovery guidance for resume' });
  const logger = new RunLogger(state.runDir);
  await logger.event('run.resumed', {
    statePath: args.target.statePath,
    phase: state.phase,
    status: state.status,
    agentConfig: state.agentConfig,
  });
  await logUserGuidanceApplied(logger);

  try {
    const nextState = await recordInteractiveBlockedRecoveryGuidance(
      args.target.statePath,
      args.message,
      logger,
    );
    return {
      kind: 'recorded',
      statePath: args.target.statePath,
      runDir: nextState.runDir,
      nextState,
      logger,
      recoveryTurns: nextState.interactiveBlockedRecovery?.turns.length ?? 0,
      terminalDirectivePending: nextState.interactiveBlockedRecovery?.pendingDirective?.terminalOnly ?? false,
      resumeCommand,
    };
  } catch (error) {
    if (error instanceof InteractiveBlockedRecoveryPendingTurnError) {
      return {
        kind: 'pending',
        guidanceKind: 'interactive_blocked_recovery',
        statePath: args.target.statePath,
        runDir: state.runDir,
        message: error.message,
        pendingTurn: error.pendingTurn,
        recoveryTurns: state.interactiveBlockedRecovery.turns.length,
        resumeCommand,
      };
    }
    throw error;
  }
}
