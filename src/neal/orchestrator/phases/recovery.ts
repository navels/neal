import { readFile, writeFile } from 'node:fs/promises';

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
import { getInteractiveBlockedRecoveryMaxTurns, getConsultantMaxAttempts } from '../../config.js';
import { EXECUTE_FINALIZATION_PHASE } from '../../execute-finalization.js';
import type { RunLogger } from '../../logger.js';
import { getLaterScopeRevisionEligibility, reviseLaterScope } from '../../plan-scope-revision.js';
import { hasPendingOperatorGuidance } from '../../run-status.js';
import { getExecutionPlanPath } from '../../scopes.js';
import { loadState, saveState } from '../../state.js';
import { getInteractiveRecoveryView, isActivePendingDerivedPlanReview } from '../../state-views.js';
import { getCoderBlockedRecoveryLaterScopeErrors } from '../../agents/schemas.js';
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
  scheduleCoderFreshSessionRetry,
  shouldRetryCoderWithFreshSession,
} from './shared.js';

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
// An invocation consumes one unit whether it auto-applies a recoverable verdict
// or produces advice and yields for the operator, and the budget is reset to 0
// at every scope boundary (see the scope-advance transitions and the split-plan
// persist) so one scope's adjudication never exhausts a later scope.
function isConsultantBudgetAvailable(state: OrchestrationState): boolean {
  const maxAttempts = getConsultantMaxAttempts(state.cwd);
  if (maxAttempts <= 0) {
    return false;
  }
  return state.consultantAttemptCount < maxAttempts;
}

// Consultant interception for every eligible block class. The consultant triages
// read-only and the verdict is returned as advice (plus the updated anti-thrash
// window) for the caller to either auto-apply (recoverable verdict with a
// concrete directive) or persist alongside the operator yield. Gated by the
// eligibility check, the disable knob, and the per-scope budget; when any gate
// blocks the consultant (ineligible phase, knob 0, exhausted budget, or a
// consultant error) this returns null and the caller yields for the operator
// with no advice, no budget consumption, and `recentBlocks` unchanged.
//
// The consultant runs BEFORE any `consultant.*` event is emitted, so a
// consultant error degrades to a plain operator yield with a byte-for-byte
// generic observable surface: zero consultant events, no advice, and no
// counter/`recentBlocks` mutation. The `start`/`verdict` audit pair is emitted only
// once the consultant has actually produced a verdict for this block.
async function buildConsultantAdvice(
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
    // Degrade to a plain operator yield: never crash the run, and emit NO
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

  // Same-snapshot rule: the recorded candidate's commit-trail evidence
  // fingerprint must come from the `state` the consultant just checked, never a
  // fresher snapshot — the candidate's evidence fingerprint is derived from
  // `state.createdCommits`, and a divergent snapshot would record a fingerprint
  // the anti-thrash guard never compared against.
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

// Applies a recoverable consultant verdict. Enters interactive recovery and
// injects the consultant's in-scope directive as the pending turn, exactly like
// a human-supplied `neal resume --message` except that the turn's `origin` is
// `consultant`, so the coder consumes it and the run continues. Consumes one unit of the per-scope consultant budget
// (`consultantAttemptCount`) and persists the anti-thrash `recentBlocks`. The
// caller has already emitted the `consultant.verdict` audit event for this
// verdict.
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
  const resolvedState = await recordInteractiveBlockedRecoveryTurn(statePath, resolutionDirective, 'consultant', logger);
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

  // Give the bounded read-only consultant a chance to triage the block. On a
  // recoverable verdict with a concrete directive, auto-apply it so the coder
  // consumes the directive and the run continues. On a genuine wall
  // (recoverable:false), or when the disable knob / budget / eligibility gate the
  // consultant off, the run yields for the operator, carrying the verdict as
  // advice when there is one so the operator sees why it stopped.
  const advisory = await buildConsultantAdvice(state, reason, sourcePhase, logger);
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

// Whether a caller of `enterInteractiveBlockedRecovery` should emit a blocked /
// interactive-recovery notification for the returned state. Notify only when the
// run is actually WAITING for the operator. A run whose block the consultant
// auto-fixed leaves a pending directive to consume (status 'running', a recorded
// recovery turn) — that is `waitingForOperatorGuidance: false`, so it must not
// notify. Gate structurally on the derived recovery view, never on text.
export function shouldNotifyInteractiveBlockedRecoveryEntry(state: OrchestrationState): boolean {
  return getInteractiveRecoveryView(state)?.waitingForOperatorGuidance ?? false;
}

export async function recordInteractiveBlockedRecoveryGuidance(
  statePath: string,
  operatorGuidance: string,
  logger?: RunLogger,
) {
  return recordInteractiveBlockedRecoveryTurn(statePath, operatorGuidance, 'operator', logger);
}

// Shared by operator guidance (`neal resume --message`) and the consultant
// injection path; `origin` marks the turn with whichever created it.
async function recordInteractiveBlockedRecoveryTurn(
  statePath: string,
  operatorGuidance: string,
  origin: NonNullable<InteractiveBlockedRecoveryState['turns'][number]['origin']>,
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
          origin,
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
            origin: 'operator' as const,
            disposition: {
              recordedAt: new Date().toISOString(),
              sessionHandle,
              action: disposition.action,
              summary: disposition.summary,
              rationale: disposition.rationale,
              blocker: disposition.blocker.trim(),
              replacementPlan: disposition.replacementPlan.trim(),
              laterScopeNumber: disposition.laterScopeNumber,
              laterScopeBody: disposition.laterScopeBody,
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
                laterScopeNumber: disposition.laterScopeNumber,
                laterScopeBody: disposition.laterScopeBody,
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

// Reads the top-level plan (always `state.planDoc`, even while a derived plan
// is executing) at the time the disposition is applied, splices the revised
// scope entry in, and writes the file. The plan is read fresh from disk on
// every later turn, so nothing in state needs to change.
async function applyLaterScopeRevision(
  state: OrchestrationState,
  disposition: CoderBlockedRecoveryDisposition,
  logger?: RunLogger,
) {
  if (disposition.laterScopeNumber === 0 && disposition.laterScopeBody.trim() === '') {
    return;
  }
  if (!isOperatorGuidedRecoveryTurn(state)) {
    throw new Error(
      'Interactive blocked recovery cannot apply the later-scope revision: only operator guidance may direct a later-scope revision, and the pending guidance is not an operator message.',
    );
  }
  const planDocument = await readFile(state.planDoc, 'utf8');
  const errors = getCoderBlockedRecoveryLaterScopeErrors(disposition, {
    allowLaterScopeRevision: true,
    currentScopeNumber: state.currentScopeNumber,
    planDocument,
  });
  if (errors.length > 0) {
    throw new Error(`Interactive blocked recovery cannot apply the later-scope revision: ${errors.join(' ')}`);
  }
  const result = reviseLaterScope({
    planDocument,
    currentScopeNumber: state.currentScopeNumber,
    targetScopeNumber: disposition.laterScopeNumber,
    replacementBody: disposition.laterScopeBody,
  });
  if (!result.ok) {
    throw new Error(`Interactive blocked recovery cannot apply the later-scope revision: ${result.errors.join(' ')}`);
  }
  await writeFile(state.planDoc, result.document, 'utf8');
  await logger?.event('interactive_blocked_recovery.later_scope_revised', {
    scopeNumber: state.currentScopeNumber,
    laterScopeNumber: disposition.laterScopeNumber,
    planDoc: state.planDoc,
  });
}

// Whether the pending guidance is an operator message. Only an operator message
// may direct a later-scope revision. The turn's `origin` marker is set where the
// turn is created: `operator` by `neal resume --message`, `consultant` by the
// consultant-injection path. A turn persisted without the marker, and the
// operator's turn-cap directive (which cannot choose an action that carries a
// revision anyway), do not qualify.
function isOperatorGuidedRecoveryTurn(state: OrchestrationState): boolean {
  const recovery = state.interactiveBlockedRecovery;
  if (!recovery || recovery.pendingDirective) {
    return false;
  }
  const latestTurn = recovery.turns.at(-1);
  return latestTurn !== undefined && latestTurn.number > recovery.lastHandledTurn && latestTurn.origin === 'operator';
}

async function getLaterScopeRevisionOffer(state: OrchestrationState, terminalOnly: boolean) {
  if (terminalOnly || !isOperatorGuidedRecoveryTurn(state)) {
    return null;
  }
  let planDocument: string;
  try {
    planDocument = await readFile(state.planDoc, 'utf8');
  } catch {
    return null;
  }
  const eligibility = getLaterScopeRevisionEligibility(planDocument, state.currentScopeNumber);
  if (!eligibility.eligible) {
    return null;
  }
  return {
    topLevelPlanDoc: state.planDoc,
    planDocument,
    currentScopeNumber: state.currentScopeNumber,
    scopeCount: eligibility.scopeCount,
  };
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
  const pendingDirective = state.interactiveBlockedRecovery.pendingDirective;
  if (!latestTurn && !pendingDirective) {
    throw new Error('Interactive blocked recovery requires recorded operator guidance before a coder response can be applied.');
  }

  if (
    pendingDirective &&
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

  await applyLaterScopeRevision(state, disposition, logger);

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
    return nextState;
  }

  const terminalBlockedState = isActivePendingDerivedPlanReview(state)
    ? {
        ...state,
        derivedPlanStatus: 'rejected' as const,
        derivedScopeIndex: null,
      }
    : state;

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

  const terminalOnly = Boolean(pendingDirective?.terminalOnly);
  await logger?.event('phase.start', {
    phase: 'interactive_blocked_recovery',
    recoveryTurn: pendingDirective ? state.interactiveBlockedRecovery.turns.length : latestTurn?.number,
    sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
    terminalOnly,
  });

  const laterScopeRevision = await getLaterScopeRevisionOffer(state, terminalOnly);

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
      terminalOnly,
      allowReplacement: true,
      laterScopeRevision,
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
