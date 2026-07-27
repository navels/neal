import {
  CoderRoundError,
  runBlockedRecoveryCoderRound,
} from '../../agents.js';
import {
  CONSULTANT_ELIGIBLE_SOURCE_PHASES,
  buildRecentBlockCandidate,
  isReviewerConsultantPhase,
  runConsultant,
  upsertRecentBlock,
} from '../../adjudicator/consultant.js';
import { UNATTENDED_AUTO_RESUME_GUIDANCE } from '../../blocked-guidance.js';
import { getInteractiveBlockedRecoveryMaxTurns, getConsultantMaxAttempts } from '../../config.js';
import { EXECUTE_FINALIZATION_PHASE } from '../../execute-finalization.js';
import type { RunLogger } from '../../logger.js';
import { hasPendingOperatorGuidance } from '../../run-status.js';
import { getExecutionPlanPath } from '../../scopes.js';
import { loadState, saveState } from '../../state.js';
import { getInteractiveRecoveryView, isActivePendingDerivedPlanReview } from '../../state-views.js';
import type {
  CoderBlockedRecoveryDisposition,
  InteractiveBlockedRecoveryConsultantAdvice,
  InteractiveBlockedRecoveryState,
  OrchestrationState,
  ConsultantVerdict,
  RecentBlockRecord,
} from '../../types.js';
import { writeExecutionArtifacts } from '../artifacts.js';
import { isCoderTimeoutError, shouldNotifyFailure } from '../failures.js';
import { flushDerivedPlanNotifications, notifyBlocked } from '../notifications.js';
import { persistSplitPlanRecovery } from '../split-plan.js';
import {
  bestEffortCleanupTimedOutCoder,
  persistBlockedScope,
  persistCoderFailureState,
  persistUnattendedBlockUnresolvedFailure,
  scheduleCoderFreshSessionRetry,
  shouldRetryCoderWithFreshSession,
} from './shared.js';

// Bounded number of synthesized conservative auto-resumes the execute-mode
// interactive-recovery chokepoint performs under `unattended` before it fails
// cleanly and terminally. Kept a module constant (not a config knob) and held
// at or below `interactive_blocked_recovery_max_turns` (default 3) so an
// auto-resume turn never pushes past the recovery turn cap. Revisit here if the
// unattended push proves too short or too long for headless runs.
export const UNATTENDED_MAX_AUTO_RESUMES = 2;

export class InteractiveBlockedRecoveryPendingTurnError extends Error {
  readonly pendingTurn: number;

  constructor(pendingTurn: number) {
    super(
      `Interactive blocked recovery already has unhandled operator guidance for turn ${pendingTurn}; resume the run before recording more guidance.`,
    );
    this.name = 'InteractiveBlockedRecoveryPendingTurnError';
    this.pendingTurn = pendingTurn;
  }
}

function getInteractiveBlockedRecoverySourcePhase(
  phase: OrchestrationState['phase'] | null,
): InteractiveBlockedRecoveryState['sourcePhase'] {
  switch (phase) {
    case 'coder_plan':
    case 'reviewer_plan':
    case 'coder_plan_response':
    case 'coder_plan_optional_response':
    case 'awaiting_derived_plan_execution':
    case 'coder_scope':
    case 'reviewer_scope':
    case 'coder_response':
    case 'coder_optional_response':
    case EXECUTE_FINALIZATION_PHASE:
    case 'final_completion_review':
      return phase;
    default:
      throw new Error(`Interactive blocked recovery does not support source phase: ${String(phase)}`);
  }
}

function isInteractiveBlockedRecoveryTopLevelMode(state: OrchestrationState) {
  return state.topLevelMode === 'execute';
}

// The generalized consultant triages two block classes whose source phase is in
// `CONSULTANT_ELIGIBLE_SOURCE_PHASES`:
//   - a coder-blocked signal (`coder_scope`/`coder_response`/`coder_optional_response`,
//     which also carries the rerouted split-plan invalid-payload block): the coder
//     emits free-text blockers with no structural prefix, so ANY coder block on these
//     phases is eligible;
//   - a reviewer `review_stuck` deadlock (`reviewer_scope`/`reviewer_plan`): only the
//     structural `review_stuck:` reason the review adjudicator emits for a genuine
//     deadlock is eligible. Ordinary blocking-finding blocks that reach recovery via a
//     reviewer phase are normal review back-and-forth, NOT a deadlock, so they keep
//     today's generic recovery behavior.
// Every other accepted source phase (`coder_plan`, `coder_plan_response`,
// `coder_plan_optional_response`, `awaiting_derived_plan_execution`,
// `execute_finalization`, `final_completion_review`) is ineligible and keeps today's
// generic recovery behavior with zero consultant invocations.
function isConsultantEligibleBlock(
  reason: string,
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'],
): boolean {
  if (!CONSULTANT_ELIGIBLE_SOURCE_PHASES.has(sourcePhase)) {
    return false;
  }
  if (isReviewerConsultantPhase(sourcePhase)) {
    return reason.startsWith('review_stuck:');
  }
  return true;
}

// Whether the per-scope consultant budget allows another invocation. Returns
// false when the disable knob is 0 or `consultantAttemptCount` has reached the
// configured maximum for the current scope. Both the disabled and the
// budget-exhausted cases emit NO `consultant.*` events so they preserve
// the generic recovery path byte-for-byte: a disabled or exhausted consultant
// must be indistinguishable from the consultant never having existed.
// The single uniform budget is shared by both run modes — an invocation consumes
// one unit whether it auto-applies a recoverable verdict (either mode) or, on a
// non-recoverable verdict, finalizes terminally (unattended) or produces advice
// and yields (attended) — and is reset to 0 at every scope boundary (see the
// scope-advance transitions and the split-plan persist) so one scope's
// adjudication never exhausts a later scope.
function isConsultantBudgetAvailable(state: OrchestrationState): boolean {
  const maxAttempts = getConsultantMaxAttempts(state.cwd);
  if (maxAttempts <= 0) {
    return false;
  }
  return state.consultantAttemptCount < maxAttempts;
}

// Unattended interception for every eligible block class. Runs the read-only
// consultant (which may itself short-circuit on an anti-thrash repeat) and, on a
// recoverable verdict with a concrete in-scope directive, enters interactive
// recovery with that directive injected as the pending turn — bounded by a
// SEPARATE counter (`consultantAttemptCount`) that never touches
// `unattendedAutoResumeCount` or the recovery turn cap. A non-recoverable verdict
// (including a thrash repeat) is finalized TERMINALLY rather than silently
// auto-resumed. Every gate that prevents the consultant from running — an
// ineligible source phase, the disabled/exhausted budget, the turn cap, or an
// consultant error — returns null so the caller falls through to the existing
// generic auto-resume / terminal-fail path with `recentBlocks` left unchanged.
// The consultant itself makes zero commits and zero file edits; this function is
// the sole writer of `recentBlocks`, and only on the branches where the
// consultant actually ran.
async function maybeResolveBlockedUnattended(
  state: OrchestrationState,
  statePath: string,
  reason: string,
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'],
  nextRecovery: InteractiveBlockedRecoveryState,
  logger?: RunLogger,
): Promise<OrchestrationState | null> {
  if (!isConsultantEligibleBlock(reason, sourcePhase)) {
    return null;
  }
  if (!isConsultantBudgetAvailable(state)) {
    return null;
  }
  // Never push past the recovery turn cap; if there is no room for a recovery
  // turn, fall through to the generic bound check unchanged.
  if (nextRecovery.turns.length >= nextRecovery.maxTurns) {
    return null;
  }

  await logger?.event('consultant.start', {
    scopeNumber: state.currentScopeNumber,
    sourcePhase,
    blockedReason: reason,
  });

  let verdict: ConsultantVerdict;
  try {
    verdict = await runConsultant(state, reason, sourcePhase, logger);
  } catch (error) {
    // An consultant failure must never crash the run or weaken existing recovery;
    // record the decline and fall through to the generic path with `recentBlocks`
    // unchanged (the consultant did not complete for this block).
    await logger?.event('consultant.declined', {
      scopeNumber: state.currentScopeNumber,
      sourcePhase,
      blockedReason: reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  // The consultant ran (possibly short-circuiting internally on a thrash repeat),
  // so this block is recorded in the anti-thrash window regardless of the verdict.
  // The candidate is built from the PRE-update array and written in this same
  // transition, so a block can never match itself. It MUST be built from the same
  // `state` snapshot `runConsultant` checked: the candidate's evidence
  // fingerprint is derived from `state.createdCommits`, and a divergent snapshot
  // would record a fingerprint the guard never compared against.
  const candidate = buildRecentBlockCandidate(state, reason, sourcePhase);
  const recentBlocks = upsertRecentBlock(state.recentBlocks, candidate);

  const resolutionDirective = verdict.resolutionDirective.trim();
  if (!verdict.recoverable || !resolutionDirective) {
    // Genuine wall (recoverable:false) or a thrash repeat: an unattended run has
    // no operator to escalate to, so finalize TERMINALLY instead of synthesizing a
    // generic auto-resume. The consultant actually ran, so this branch consumes
    // one unit of the shared per-scope budget (`consultantAttemptCount`) exactly
    // like the recoverable branch, and persists the anti-thrash record via the
    // threaded `recentBlocks`. Only the fallback paths where `runConsultant`
    // was never invoked leave the budget untouched.
    await logger?.event('consultant.declined', {
      scopeNumber: state.currentScopeNumber,
      sourcePhase,
      blockedReason: reason,
      recoverable: verdict.recoverable,
      triageCategory: verdict.triageCategory,
      consultantAttemptCount: state.consultantAttemptCount + 1,
    });
    return failUnattendedRecoveryTerminally(
      { ...state, recentBlocks, consultantAttemptCount: state.consultantAttemptCount + 1 },
      statePath,
      'terminal_block',
      state.coderSessionHandle,
      logger,
    );
  }

  await logger?.event('consultant.verdict', {
    scopeNumber: state.currentScopeNumber,
    sourcePhase,
    blockedReason: reason,
    recoverable: verdict.recoverable,
    triageCategory: verdict.triageCategory,
    targetCanonicalIds: verdict.targetCanonicalIds,
    // Report the post-increment count this verdict is about to consume so the
    // verdict and the later `resolved` event agree on the budget figure.
    consultantAttemptCount: state.consultantAttemptCount + 1,
  });

  // Recoverable verdict with a concrete directive: auto-apply it (shared with the
  // attended path) so the coder consumes the directive and the run continues.
  return applyRecoverableConsultantDirective({
    state,
    statePath,
    reason,
    sourcePhase,
    nextRecovery,
    recentBlocks,
    resolutionDirective,
    verdict,
    logger,
  });
}

// Attended interception for every eligible block class. The consultant NEVER
// auto-applies its verdict in attended mode; instead it triages read-only and the
// verdict is returned as advice (plus the updated anti-thrash window) for the
// caller to persist alongside the operator yield. Gated by the SAME eligibility +
// disable knob + per-scope budget as the unattended path; when any gate blocks the
// consultant (ineligible phase, knob 0, exhausted budget, or an consultant
// error) this returns null and the caller yields exactly as today with no advice,
// no budget consumption, and `recentBlocks` unchanged.
//
// The consultant runs BEFORE any `consultant.*` event is emitted, so an
// consultant error degrades to today's plain attended yield with a byte-for-byte
// generic observable surface: zero consultant events, no advice, and no
// counter/`recentBlocks` mutation. The `start`/`verdict` audit pair is emitted only
// once the consultant has actually produced a verdict for this block.
async function buildAttendedConsultantAdvice(
  state: OrchestrationState,
  reason: string,
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'],
  logger?: RunLogger,
): Promise<{
  advice: InteractiveBlockedRecoveryConsultantAdvice;
  recentBlocks: RecentBlockRecord[];
  verdict: ConsultantVerdict;
} | null> {
  if (!isConsultantEligibleBlock(reason, sourcePhase)) {
    return null;
  }
  if (!isConsultantBudgetAvailable(state)) {
    return null;
  }

  let verdict: ConsultantVerdict;
  try {
    verdict = await runConsultant(state, reason, sourcePhase, logger);
  } catch {
    // Degrade to today's plain attended yield: never crash the run, and emit NO
    // `consultant.*` events so the fallback is indistinguishable from the
    // disabled/exhausted/ineligible generic yield.
    return null;
  }

  await logger?.event('consultant.start', {
    scopeNumber: state.currentScopeNumber,
    sourcePhase,
    blockedReason: reason,
  });
  await logger?.event('consultant.verdict', {
    scopeNumber: state.currentScopeNumber,
    sourcePhase,
    blockedReason: reason,
    recoverable: verdict.recoverable,
    triageCategory: verdict.triageCategory,
    targetCanonicalIds: verdict.targetCanonicalIds,
    consultantAttemptCount: state.consultantAttemptCount + 1,
  });

  // Same-snapshot rule as the unattended writer: the recorded candidate's
  // commit-trail evidence fingerprint must come from the `state` the consultant
  // just checked, never a fresher snapshot.
  const candidate = buildRecentBlockCandidate(state, reason, sourcePhase);
  const recentBlocks = upsertRecentBlock(state.recentBlocks, candidate);
  const advice: InteractiveBlockedRecoveryConsultantAdvice = {
    recordedAt: new Date().toISOString(),
    recoverable: verdict.recoverable,
    triageCategory: verdict.triageCategory,
    resolutionDirective: verdict.resolutionDirective,
    rationale: verdict.rationale,
  };
  return { advice, recentBlocks, verdict };
}

// Applies a recoverable consultant verdict — shared by both run modes. Enters
// interactive recovery and injects the consultant's in-scope directive as the
// pending turn, exactly like a human-supplied `neal resume --message`, so the
// coder consumes it and the run continues. Consumes one unit of the per-scope
// consultant budget (`consultantAttemptCount`, never `unattendedAutoResumeCount`)
// and persists the anti-thrash `recentBlocks`. The caller has already emitted the
// `consultant.verdict` audit event for this verdict.
async function applyRecoverableConsultantDirective(args: {
  state: OrchestrationState;
  statePath: string;
  reason: string;
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'];
  nextRecovery: InteractiveBlockedRecoveryState;
  recentBlocks: RecentBlockRecord[];
  resolutionDirective: string;
  verdict: ConsultantVerdict;
  logger?: RunLogger;
}): Promise<OrchestrationState> {
  const { state, statePath, reason, sourcePhase, nextRecovery, recentBlocks, resolutionDirective, verdict, logger } =
    args;
  const enteredState = await saveState(statePath, {
    ...state,
    recentBlocks,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: state.blockedFromPhase ?? state.phase,
    consultantAttemptCount: state.consultantAttemptCount + 1,
    interactiveBlockedRecovery: {
      ...nextRecovery,
      sourcePhase,
      blockedReason: reason,
    },
  });
  await writeExecutionArtifacts(enteredState);
  await logger?.event('interactive_blocked_recovery.entered', {
    scopeNumber: enteredState.currentScopeNumber,
    sourcePhase: enteredState.interactiveBlockedRecovery?.sourcePhase,
    blockedReason: reason,
  });
  const resolvedState = await recordInteractiveBlockedRecoveryGuidance(statePath, resolutionDirective, logger);
  await logger?.event('consultant.resolved', {
    scopeNumber: resolvedState.currentScopeNumber,
    sourcePhase,
    blockedReason: reason,
    recoverable: verdict.recoverable,
    triageCategory: verdict.triageCategory,
    targetCanonicalIds: verdict.targetCanonicalIds,
    consultantAttemptCount: resolvedState.consultantAttemptCount,
  });
  return resolvedState;
}

export async function enterInteractiveBlockedRecovery(
  state: OrchestrationState,
  statePath: string,
  reason: string,
  logger?: RunLogger,
) {
  if (!isInteractiveBlockedRecoveryTopLevelMode(state)) {
    throw new Error('Interactive blocked recovery is only supported for execute-mode runs');
  }

  const sourcePhase = getInteractiveBlockedRecoverySourcePhase(state.blockedFromPhase ?? state.phase);
  const nextRecovery: InteractiveBlockedRecoveryState = state.interactiveBlockedRecovery ?? {
    enteredAt: new Date().toISOString(),
    sourcePhase,
    blockedReason: reason,
    // Keep the operator/coder loop short so recovery remains bounded and auditable.
    maxTurns: getInteractiveBlockedRecoveryMaxTurns(state.cwd),
    lastHandledTurn: 0,
    pendingDirective: null,
    turns: [],
  };

  // Unattended runs have no operator to answer, so instead of yielding-and-halting
  // we either synthesize a conservative auto-resume turn (bounded) or, past the
  // bound, run the shared terminal-fail action. Gate purely on structural state:
  // the persisted counter and the recovery turn cap, never on guidance text.
  if (state.unattended) {
    // Before the generic auto-resume/terminal-fail decision, give the bounded
    // read-only consultant a chance to triage the block: autonomously resolve it
    // with an in-scope directive (recoverable) or finalize terminally (a genuine
    // wall or thrash repeat). Any ineligible source phase, disabled/exhausted
    // budget, turn cap, or consultant error falls through to the existing generic
    // behavior unchanged.
    const consultantResolved = await maybeResolveBlockedUnattended(
      state,
      statePath,
      reason,
      sourcePhase,
      nextRecovery,
      logger,
    );
    if (consultantResolved) {
      return consultantResolved;
    }

    const canAutoResume =
      state.unattendedAutoResumeCount < UNATTENDED_MAX_AUTO_RESUMES &&
      nextRecovery.turns.length < nextRecovery.maxTurns;
    if (!canAutoResume) {
      // Past the bound, finalize any active recovery record into history and land
      // on a terminal failed shape (status:'failed', phase:'blocked',
      // interactiveBlockedRecovery:null) so the run is never persisted as an
      // active/waiting recovery. Reuses the same finalizer as the disposition
      // terminal-fail paths.
      return failUnattendedRecoveryTerminally(state, statePath, 'terminal_block', state.coderSessionHandle, logger);
    }

    const enteredState = await saveState(statePath, {
      ...state,
      phase: 'interactive_blocked_recovery',
      status: 'running',
      blockedFromPhase: state.blockedFromPhase ?? state.phase,
      unattendedAutoResumeCount: state.unattendedAutoResumeCount + 1,
      interactiveBlockedRecovery: {
        ...nextRecovery,
        sourcePhase,
        blockedReason: reason,
      },
    });
    await writeExecutionArtifacts(enteredState);
    await logger?.event('interactive_blocked_recovery.entered', {
      scopeNumber: enteredState.currentScopeNumber,
      sourcePhase: enteredState.interactiveBlockedRecovery?.sourcePhase,
      blockedReason: reason,
    });
    await logger?.event('interactive_blocked_recovery.unattended_auto_resume', {
      scopeNumber: enteredState.currentScopeNumber,
      sourcePhase,
      autoResumeCount: enteredState.unattendedAutoResumeCount,
      maxAutoResumes: UNATTENDED_MAX_AUTO_RESUMES,
    });
    // Reuse the turn-recording helper so the synthesized guidance turn satisfies
    // the same invariants a human-supplied `neal resume --message` would; the run
    // loop then proceeds into runInteractiveBlockedRecoveryPhase to consume it.
    return recordInteractiveBlockedRecoveryGuidance(statePath, UNATTENDED_AUTO_RESUME_GUIDANCE, logger);
  }

  // Attended runs run the same bounded read-only consultant. On a recoverable
  // verdict with a concrete directive, they auto-apply it exactly as unattended
  // runs do — the consultant's advice is acted on in both modes. On a genuine wall
  // (recoverable:false), or when the disable knob / budget / eligibility gate the
  // consultant off, the attended run yields for the operator, carrying the verdict
  // as advice when there is one so the operator sees why it stopped.
  const advisory = await buildAttendedConsultantAdvice(state, reason, sourcePhase, logger);
  if (advisory) {
    const resolutionDirective = advisory.advice.resolutionDirective.trim();
    if (advisory.advice.recoverable && resolutionDirective) {
      return applyRecoverableConsultantDirective({
        state,
        statePath,
        reason,
        sourcePhase,
        nextRecovery,
        recentBlocks: advisory.recentBlocks,
        resolutionDirective,
        verdict: advisory.verdict,
        logger,
      });
    }
  }
  const nextState = await saveState(statePath, {
    ...state,
    ...(advisory
      ? { recentBlocks: advisory.recentBlocks, consultantAttemptCount: state.consultantAttemptCount + 1 }
      : {}),
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: state.blockedFromPhase ?? state.phase,
    interactiveBlockedRecovery: {
      ...nextRecovery,
      sourcePhase,
      blockedReason: reason,
      ...(advisory ? { consultantAdvice: advisory.advice } : {}),
    },
  });
  await writeExecutionArtifacts(nextState);
  await logger?.event('interactive_blocked_recovery.entered', {
    scopeNumber: nextState.currentScopeNumber,
    sourcePhase: nextState.interactiveBlockedRecovery?.sourcePhase,
    blockedReason: reason,
  });
  return nextState;
}

// Whether a caller of `enterInteractiveBlockedRecovery` should emit an attended
// blocked / interactive-recovery notification for the returned state. Notify only
// when an attended run is actually WAITING for the operator. An attended run whose
// block the consultant auto-fixed leaves a pending directive to consume (status
// 'running', a recorded recovery turn) — that is `waitingForOperatorGuidance:
// false`, so it must not notify. Unattended runs never wait here (they auto-resume
// or terminally fail), so `!state.unattended` already excludes them. Gate
// structurally on the derived recovery view, never on text.
export function shouldNotifyInteractiveBlockedRecoveryEntry(state: OrchestrationState): boolean {
  return !state.unattended && (getInteractiveRecoveryView(state)?.waitingForOperatorGuidance ?? false);
}

export async function recordInteractiveBlockedRecoveryGuidance(
  statePath: string,
  operatorGuidance: string,
  logger?: RunLogger,
) {
  const trimmedGuidance = operatorGuidance.trim();
  if (!trimmedGuidance) {
    throw new Error('Recovery guidance must not be empty');
  }

  const state = await loadState(statePath);
  if (state.phase !== 'interactive_blocked_recovery' || !state.interactiveBlockedRecovery) {
    throw new Error(`Run is not in interactive blocked recovery: ${statePath}`);
  }

  const turns = state.interactiveBlockedRecovery.turns;
  if (state.interactiveBlockedRecovery.pendingDirective) {
    throw new InteractiveBlockedRecoveryPendingTurnError(turns.length + 1);
  }

  const pendingTurn = turns.at(-1);
  if (pendingTurn && pendingTurn.number > state.interactiveBlockedRecovery.lastHandledTurn) {
    throw new InteractiveBlockedRecoveryPendingTurnError(pendingTurn.number);
  }

  if (turns.length >= state.interactiveBlockedRecovery.maxTurns) {
    const nextState = await saveState(statePath, {
      ...state,
      interactiveBlockedRecovery: {
        ...state.interactiveBlockedRecovery,
        pendingDirective: {
          recordedAt: new Date().toISOString(),
          operatorGuidance: trimmedGuidance,
          terminalOnly: true,
        },
      },
    });
    await writeExecutionArtifacts(nextState);
    await logger?.event('interactive_blocked_recovery.terminal_directive_recorded', {
      scopeNumber: nextState.currentScopeNumber,
      sourcePhase: nextState.interactiveBlockedRecovery?.sourcePhase,
      recoveryTurn: turns.length,
    });
    return nextState;
  }

  const nextState = await saveState(statePath, {
    ...state,
    interactiveBlockedRecovery: {
      ...state.interactiveBlockedRecovery,
      turns: [
        ...turns,
        {
          number: turns.length + 1,
          recordedAt: new Date().toISOString(),
          operatorGuidance: trimmedGuidance,
          disposition: null,
        },
      ],
    },
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('interactive_blocked_recovery.guidance_recorded', {
    scopeNumber: nextState.currentScopeNumber,
    recoveryTurn: nextState.interactiveBlockedRecovery?.turns.at(-1)?.number,
    sourcePhase: nextState.interactiveBlockedRecovery?.sourcePhase,
  });
  return nextState;
}

export function isResumableBlockedPhase(
  phase: OrchestrationState['phase'] | null,
): phase is
  | 'coder_scope'
  | 'coder_response'
  | 'coder_optional_response'
  | 'coder_plan'
  | 'coder_plan_response'
  | 'coder_plan_optional_response' {
  return (
    phase === 'coder_scope' ||
    phase === 'coder_response' ||
    phase === 'coder_optional_response' ||
    phase === 'coder_plan' ||
    phase === 'coder_plan_response' ||
    phase === 'coder_plan_optional_response'
  );
}

export function hasPendingInteractiveBlockedRecoveryTurn(state: OrchestrationState) {
  return hasPendingOperatorGuidance(state);
}

function withRecordedInteractiveBlockedRecoveryDisposition(
  state: OrchestrationState,
  disposition: CoderBlockedRecoveryDisposition,
  sessionHandle: string | null,
  resultingPhase: OrchestrationState['phase'],
) {
  if (!state.interactiveBlockedRecovery) {
    return state;
  }

  if (state.interactiveBlockedRecovery.pendingDirective) {
    return {
      ...state,
      interactiveBlockedRecovery: {
        ...state.interactiveBlockedRecovery,
        pendingDirective: null,
        turns: [
          ...state.interactiveBlockedRecovery.turns,
          {
            number: state.interactiveBlockedRecovery.turns.length + 1,
            recordedAt: state.interactiveBlockedRecovery.pendingDirective.recordedAt,
            operatorGuidance: state.interactiveBlockedRecovery.pendingDirective.operatorGuidance,
            disposition: {
              recordedAt: new Date().toISOString(),
              sessionHandle,
              action: disposition.action,
              summary: disposition.summary,
              rationale: disposition.rationale,
              blocker: disposition.blocker.trim(),
              replacementPlan: disposition.replacementPlan.trim(),
              resultingPhase,
            },
          },
        ],
      },
    };
  }

  const latestTurn = state.interactiveBlockedRecovery.turns.at(-1);
  if (!latestTurn) {
    return state;
  }

  return {
    ...state,
    interactiveBlockedRecovery: {
      ...state.interactiveBlockedRecovery,
      turns: state.interactiveBlockedRecovery.turns.map((turn) =>
        turn.number === latestTurn.number
          ? {
              ...turn,
              disposition: {
                recordedAt: new Date().toISOString(),
                sessionHandle,
                action: disposition.action,
                summary: disposition.summary,
                rationale: disposition.rationale,
                blocker: disposition.blocker.trim(),
                replacementPlan: disposition.replacementPlan.trim(),
                resultingPhase,
              },
            }
          : turn,
      ),
    },
  };
}

function finalizeInteractiveBlockedRecovery(
  state: OrchestrationState,
  action: CoderBlockedRecoveryDisposition['action'],
  resultPhase: OrchestrationState['phase'],
) {
  if (!state.interactiveBlockedRecovery) {
    return state;
  }

  return {
    ...state,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [
      ...state.interactiveBlockedRecoveryHistory,
      {
        ...state.interactiveBlockedRecovery,
        pendingDirective: null,
        resolvedAt: new Date().toISOString(),
        resolvedByAction: action,
        resultPhase,
      },
    ],
  };
}

async function persistFinalizedInteractiveBlockedRecovery(
  state: OrchestrationState,
  statePath: string,
  disposition: CoderBlockedRecoveryDisposition,
  sessionHandle: string | null,
  resultPhase: OrchestrationState['phase'],
) {
  const finalizedState = finalizeInteractiveBlockedRecovery(
    withRecordedInteractiveBlockedRecoveryDisposition(state, disposition, sessionHandle, resultPhase),
    disposition.action,
    resultPhase,
  );
  const nextState = await saveState(
    statePath,
    {
      ...finalizedState,
      phase: resultPhase,
      status: resultPhase === 'blocked' ? 'blocked' : 'running',
      blockedFromPhase:
        resultPhase === 'blocked' ? state.interactiveBlockedRecovery?.sourcePhase ?? state.blockedFromPhase : null,
    },
  );
  await writeExecutionArtifacts(nextState);
  return nextState;
}

function getInteractiveBlockedRecoveryResumePhase(
  sourcePhase: InteractiveBlockedRecoveryState['sourcePhase'],
): OrchestrationState['phase'] {
  switch (sourcePhase) {
    case 'reviewer_scope':
      return 'coder_response';
    case 'reviewer_plan':
      return 'coder_plan_response';
    case 'awaiting_derived_plan_execution':
      return 'coder_scope';
    default:
      return sourcePhase;
  }
}

// Shared unattended terminal-fail for a recovery disposition. The active
// recovery record is finalized into history (so `interactiveBlockedRecovery`
// becomes null and the lifecycle view is no longer "active"/waiting — required
// because the state invariant ties a non-null record to the recovery phase),
// the run lands on the recovery's source phase for diagnostics, and the shared
// classified terminal-fail action runs (status:'failed', no `notifyBlocked`).
// `state` must carry the disposition already recorded on its latest turn.
async function failUnattendedRecoveryTerminally(
  state: OrchestrationState,
  statePath: string,
  action: CoderBlockedRecoveryDisposition['action'],
  sessionHandle: string | null,
  logger?: RunLogger,
) {
  const recovery = state.interactiveBlockedRecovery;
  const sourcePhase = recovery?.sourcePhase ?? state.blockedFromPhase ?? state.phase;
  // The history record's resultPhase must satisfy the disposition-result invariant
  // (stay_blocked -> recovery, terminal_block/replace -> blocked); the run itself
  // lands on the terminal `blocked` phase with status:'failed', which keeps the
  // lifecycle view out of any waiting/active recovery state.
  const historyResultPhase: OrchestrationState['phase'] =
    action === 'stay_blocked' ? 'interactive_blocked_recovery' : 'blocked';
  await logger?.event('interactive_blocked_recovery.unattended_terminal_fail', {
    scopeNumber: state.currentScopeNumber,
    sourcePhase,
    autoResumeCount: state.unattendedAutoResumeCount,
    maxAutoResumes: UNATTENDED_MAX_AUTO_RESUMES,
  });
  const finalized = recovery ? finalizeInteractiveBlockedRecovery(state, action, historyResultPhase) : state;
  return persistUnattendedBlockUnresolvedFailure(
    {
      ...finalized,
      phase: 'blocked',
      blockedFromPhase: sourcePhase,
      coderSessionHandle: sessionHandle,
      coderSessionProtocol: sessionHandle ? state.coderSessionProtocol : null,
      coderRetryCount: 0,
    },
    statePath,
    'interactive_blocked_recovery',
    logger,
  );
}

// Under `unattended`, a recovery disposition that would otherwise leave the run
// waiting for an operator (`stay_blocked`) is resolved structurally: synthesize
// another conservative auto-resume turn while still under the persisted
// auto-resume cap and the recovery turn cap, otherwise run the shared
// terminal-fail action. `state` must already be persisted in
// `interactive_blocked_recovery` with its recovery record holding the handled
// turns. Gates only on the persisted counter and turn cap, never on text.
async function continueOrTerminateUnattendedRecovery(
  state: OrchestrationState,
  statePath: string,
  sessionHandle: string | null,
  logger?: RunLogger,
) {
  const recovery = state.interactiveBlockedRecovery;
  const canAutoResume =
    !!recovery &&
    state.unattendedAutoResumeCount < UNATTENDED_MAX_AUTO_RESUMES &&
    recovery.turns.length < recovery.maxTurns;
  if (!canAutoResume) {
    return failUnattendedRecoveryTerminally(state, statePath, 'stay_blocked', sessionHandle, logger);
  }

  const incremented = await saveState(statePath, {
    ...state,
    unattendedAutoResumeCount: state.unattendedAutoResumeCount + 1,
  });
  await writeExecutionArtifacts(incremented);
  await logger?.event('interactive_blocked_recovery.unattended_auto_resume', {
    scopeNumber: incremented.currentScopeNumber,
    sourcePhase: recovery.sourcePhase,
    autoResumeCount: incremented.unattendedAutoResumeCount,
    maxAutoResumes: UNATTENDED_MAX_AUTO_RESUMES,
  });
  return recordInteractiveBlockedRecoveryGuidance(statePath, UNATTENDED_AUTO_RESUME_GUIDANCE, logger);
}

export async function applyInteractiveBlockedRecoveryDisposition(
  state: OrchestrationState,
  statePath: string,
  disposition: CoderBlockedRecoveryDisposition,
  sessionHandle: string | null,
  logger?: RunLogger,
) {
  if (state.phase !== 'interactive_blocked_recovery' || !state.interactiveBlockedRecovery) {
    throw new Error(`Run is not in interactive blocked recovery: ${statePath}`);
  }
  if (!isInteractiveBlockedRecoveryTopLevelMode(state)) {
    throw new Error('Interactive blocked recovery is only supported for execute-mode runs');
  }

  const latestTurn = state.interactiveBlockedRecovery.turns.at(-1);
  const terminalDirective = state.interactiveBlockedRecovery.pendingDirective;
  if (!latestTurn && !terminalDirective) {
    throw new Error('Interactive blocked recovery requires recorded operator guidance before a coder response can be applied.');
  }

  if (
    terminalDirective &&
    disposition.action !== 'replace_current_scope' &&
    disposition.action !== 'terminal_block'
  ) {
    throw new Error('Interactive blocked recovery reached its turn cap and now only allows replace_current_scope or terminal_block.');
  }

  const turnNumber = latestTurn?.number ?? state.interactiveBlockedRecovery.turns.length + 1;
  const trimmedBlocker = disposition.blocker.trim();

  await logger?.event('interactive_blocked_recovery.disposition', {
    scopeNumber: state.currentScopeNumber,
    recoveryTurn: turnNumber,
    sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
    action: disposition.action,
    sessionHandle,
  });

  if (disposition.action === 'replace_current_scope') {
    const persistedState = await persistSplitPlanRecovery(
      {
        ...state,
        coderSessionHandle: sessionHandle,
        coderSessionProtocol: sessionHandle ? state.coderSessionProtocol : null,
        status: 'running',
        coderRetryCount: 0,
      },
      statePath,
      {
        sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
        derivedPlanMarkdown: disposition.replacementPlan.trim(),
        createdCommits: [],
        logger,
      },
      {
        persistBlockedScope,
        writeExecutionArtifacts,
      },
    );

    const resultPhase = persistedState.phase === 'blocked' ? 'blocked' : 'reviewer_plan';
    if (state.unattended && resultPhase === 'blocked') {
      // An unattended replacement that could not produce a runnable plan must not
      // leave the run resumable-blocked; finalize recovery and fail cleanly.
      return failUnattendedRecoveryTerminally(
        {
          ...persistedState,
          interactiveBlockedRecovery: withRecordedInteractiveBlockedRecoveryDisposition(
            { ...persistedState, interactiveBlockedRecovery: state.interactiveBlockedRecovery },
            disposition,
            sessionHandle,
            'blocked',
          ).interactiveBlockedRecovery,
        },
        statePath,
        'replace_current_scope',
        sessionHandle,
        logger,
      );
    }
    return persistFinalizedInteractiveBlockedRecovery(
      {
        ...persistedState,
        interactiveBlockedRecovery: state.interactiveBlockedRecovery,
      },
      statePath,
      disposition,
      sessionHandle,
      resultPhase,
    );
  }

  if (disposition.action === 'resume_current_scope') {
    const resumedPhase = getInteractiveBlockedRecoveryResumePhase(state.interactiveBlockedRecovery.sourcePhase);
    const finalizedState = await persistFinalizedInteractiveBlockedRecovery(
      state,
      statePath,
      disposition,
      sessionHandle,
      resumedPhase,
    );
    const nextState = await saveState(statePath, {
      ...finalizedState,
      coderSessionHandle: sessionHandle,
      coderSessionProtocol: sessionHandle ? state.coderSessionProtocol : null,
      phase: resumedPhase,
      status: 'running',
      blockedFromPhase: null,
      coderRetryCount: 0,
    });
    await writeExecutionArtifacts(nextState);
    return nextState;
  }

  if (disposition.action === 'stay_blocked') {
    const recordedState = withRecordedInteractiveBlockedRecoveryDisposition(
      state,
      disposition,
      sessionHandle,
      'interactive_blocked_recovery',
    );
    if (!recordedState.interactiveBlockedRecovery) {
      throw new Error('Interactive blocked recovery state disappeared while recording a stay_blocked disposition.');
    }
    const nextState = await saveState(statePath, {
      ...recordedState,
      coderSessionHandle: sessionHandle,
      coderSessionProtocol: sessionHandle ? state.coderSessionProtocol : null,
      phase: 'interactive_blocked_recovery',
      status: 'running',
      blockedFromPhase: state.interactiveBlockedRecovery.sourcePhase,
      interactiveBlockedRecovery: {
        ...recordedState.interactiveBlockedRecovery,
        blockedReason: trimmedBlocker,
        lastHandledTurn: turnNumber,
        pendingDirective: null,
      },
      coderRetryCount: 0,
    });
    await writeExecutionArtifacts(nextState);
    if (nextState.unattended) {
      // No operator will answer a stay_blocked: synthesize another conservative
      // auto-resume turn under the bounds, or run the shared terminal-fail action.
      return continueOrTerminateUnattendedRecovery(nextState, statePath, sessionHandle, logger);
    }
    return nextState;
  }

  const terminalBlockedState = isActivePendingDerivedPlanReview(state)
    ? {
        ...state,
        derivedPlanStatus: 'rejected' as const,
        derivedScopeIndex: null,
      }
    : state;

  if (state.unattended) {
    // Unattended terminal_block must not take the attended blocked + notifyBlocked
    // path; record the coder's terminal decision for diagnostics, then run the
    // shared classified terminal-fail action (status:'failed', no notifyBlocked).
    const recordedTerminalState = withRecordedInteractiveBlockedRecoveryDisposition(
      terminalBlockedState,
      disposition,
      sessionHandle,
      'blocked',
    );
    return failUnattendedRecoveryTerminally(
      recordedTerminalState,
      statePath,
      'terminal_block',
      sessionHandle,
      logger,
    );
  }

  const finalizedBlockedState = await persistFinalizedInteractiveBlockedRecovery(
    terminalBlockedState,
    statePath,
    disposition,
    sessionHandle,
    'blocked',
  );
  const blockedState = await saveState(statePath, {
    ...finalizedBlockedState,
    coderSessionHandle: sessionHandle,
    coderSessionProtocol: sessionHandle ? state.coderSessionProtocol : null,
    phase: 'blocked',
    status: 'blocked',
    lastScopeMarker: state.lastScopeMarker ?? 'AUTONOMY_BLOCKED',
    blockedFromPhase: state.interactiveBlockedRecovery.sourcePhase,
    coderRetryCount: 0,
  });
  await writeExecutionArtifacts(blockedState);
  const persistedState = await persistBlockedScope(blockedState, statePath, trimmedBlocker);
  await notifyBlocked(persistedState, trimmedBlocker, logger);
  return flushDerivedPlanNotifications(persistedState, statePath, logger, trimmedBlocker);
}

export async function runInteractiveBlockedRecoveryPhase(
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
) {
  if (!state.interactiveBlockedRecovery) {
    throw new Error('Cannot run interactive blocked recovery without blocked-recovery state');
  }

  const latestTurn = state.interactiveBlockedRecovery.turns.at(-1);
  const pendingDirective = state.interactiveBlockedRecovery.pendingDirective;
  const hasPendingTurn = Boolean(latestTurn && latestTurn.number > state.interactiveBlockedRecovery.lastHandledTurn);
  if (!hasPendingTurn && !pendingDirective) {
    throw new Error('Interactive blocked recovery has no pending operator guidance to process.');
  }

  await logger?.event('phase.start', {
    phase: 'interactive_blocked_recovery',
    recoveryTurn: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number,
    sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
    terminalOnly: Boolean(pendingDirective?.terminalOnly),
  });

  let codex;
  try {
    codex = await runBlockedRecoveryCoderRound({
      coder: state.agentConfig.coder,
      cwd: state.cwd,
      planDoc: getExecutionPlanPath(state),
      progressMarkdownPath: state.progressMarkdownPath,
      recoveryMarkdownPath: state.recoveryMarkdownPath,
      blockedReason: state.interactiveBlockedRecovery.blockedReason,
      operatorGuidance: pendingDirective?.operatorGuidance ?? latestTurn?.operatorGuidance ?? state.interactiveBlockedRecovery.blockedReason,
      maxTurns: state.interactiveBlockedRecovery.maxTurns,
      turnsTaken: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number ?? 0,
      terminalOnly: Boolean(pendingDirective?.terminalOnly),
      allowReplacement: true,
      sessionHandle: state.coderSessionHandle,
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderWithFreshSession(state, 'interactive_blocked_recovery', error)) {
        return scheduleCoderFreshSessionRetry(state, statePath, 'interactive_blocked_recovery', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoder(error.sessionHandle ?? state.coderSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, 'interactive_blocked_recovery', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    codex.payload,
    codex.sessionHandle,
    logger,
  );
  await logger?.event('phase.complete', {
    phase: 'interactive_blocked_recovery',
    recoveryTurn: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number,
    action: codex.payload.action,
    nextPhase: nextState.phase,
  });
  return nextState;
}
