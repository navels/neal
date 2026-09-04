import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

import { CoderRoundError, ReviewerRoundError, runCoderPlanRound } from '../../agents.js';
import {
  isOpenBlockingFinding,
  isOpenNonBlockingFinding,
  mapDecisionToStatus,
} from '../../adjudicator/execute.js';
import {
  getDerivedPlanBlockedReason,
  isDerivedPlanReviewState,
  plannerProviderStartsFreshSessions,
  resolvePlanningAdjudicationContext,
  runPlanningResponseAdjudication,
  runPlanningReviewerAdjudication,
  synthesizePlanReviewRound,
  type PreparedPlanReview,
} from '../../adjudicator/planning.js';
import { assertAdjudicationTransitionSignal } from '../../adjudicator/specs.js';
import { getPlanReviewDebtRoundThreshold, getReviewStuckWindow } from '../../config.js';
import { OPEN_FINDINGS_PROMPT_ITEM_LIMIT } from '../../context/inline-review-context.js';
import { toPlanReviewDebt } from '../../review-debt.js';
import { writeDiagnostic } from '../../diagnostic.js';
import { getWorktreeStatus } from '../../git.js';
import type { RunLogger } from '../../logger.js';
import { formatPlanRefinementRoundLine, isPlanRefinementState } from '../../plan-refinement.js';
import { validatePlanDocument } from '../../plan-validation.js';
import { getCurrentScopeLabel, getExecutionPlanPath } from '../../scopes.js';
import { saveState } from '../../state.js';
import type {
  OrchestrationState,
  ReviewFinding,
  ScopeMarker,
} from '../../types.js';
import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
} from '../../worktree-status.js';
import { writeExecutionArtifacts } from '../artifacts.js';
import { isCoderTimeoutError, REVIEWER_CONTENT_REFUSED_BLOCK_REASON, shouldNotifyFailure } from '../failures.js';
import {
  flushDerivedPlanNotifications,
  notifyBlocked,
  notifyComplete,
} from '../notifications.js';
import {
  adoptAcceptedDerivedPlan,
  shouldNotifyDerivedPlanAcceptance,
  transitionPlanReviewWithoutOpenFindings,
} from '../transitions.js';
import { enterInteractiveBlockedRecovery, shouldNotifyInteractiveBlockedRecoveryEntry } from './recovery.js';
import {
  bestEffortCleanupTimedOutCoder,
  persistCoderFailureState,
  printReviewResult,
  scheduleCoderFreshSessionRetry,
  shouldRetryCoderWithFreshSession,
} from './shared.js';

type ReviewFindingInput = Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>;

function getNormalizedPlanArtifactPath(state: OrchestrationState, planPath: string) {
  const parsed = parse(planPath);
  const extension = parsed.ext || '.md';
  return join(state.runDir, `${parsed.name}.normalized${extension}`);
}

export async function preparePlanReviewArtifact(args: {
  planPath: string;
  normalizedPlanPath?: string;
}): Promise<PreparedPlanReview> {
  const planDocument = await readFile(args.planPath, 'utf8');
  const validation = validatePlanDocument(planDocument);
  let reviewedPlanPath = args.planPath;

  if (validation.normalization.applied && args.normalizedPlanPath) {
    await mkdir(dirname(args.normalizedPlanPath), { recursive: true });
    await writeFile(args.normalizedPlanPath, validation.normalization.normalizedDocument, 'utf8');
    reviewedPlanPath = args.normalizedPlanPath;
  }

  return {
    executionShape: validation.executionShape,
    reviewedPlanPath,
    originalPlanPath: args.planPath,
    validation,
  };
}

export async function synthesizePlanReviewFindings(args: {
  planPath: string;
  round: number;
  roundSummary: string;
  findings: ReviewFindingInput[];
  preparedReview?: PreparedPlanReview;
}): Promise<{
  executionShape: OrchestrationState['executionShape'];
  reviewedPlanPath: string;
  findings: ReviewFindingInput[];
}> {
  const preparedReview = args.preparedReview ?? (await preparePlanReviewArtifact({ planPath: args.planPath }));
  const { validation } = preparedReview;

  if (validation.ok) {
    return {
      executionShape: validation.executionShape,
      reviewedPlanPath: preparedReview.reviewedPlanPath,
      findings: args.findings,
    };
  }

  return {
    executionShape: validation.executionShape,
    reviewedPlanPath: preparedReview.reviewedPlanPath,
    findings: [
      ...args.findings,
      ...validation.errors.map((error) => ({
        round: args.round,
        source: 'plan_structure' as const,
        severity: 'blocking' as const,
        // Structural defects are always plan-correctness (fail-safe blocking);
        // they must never be treated as convertible verification-hardening debt.
        findingClass: 'plan_correctness' as const,
        files: [preparedReview.originalPlanPath],
        claim: `Plan document structure is invalid: ${error}`,
        requiredAction: 'Revise the plan document so it satisfies the required execution-shape and execution-queue contract.',
        roundSummary: args.roundSummary,
      })),
    ],
  };
}

function getPlanningCompletionProblem(marker: string | null) {
  if (marker === 'AUTONOMY_BLOCKED') {
    return null;
  }

  return marker === 'AUTONOMY_DONE' ? null : 'Planning mode must end with AUTONOMY_DONE or AUTONOMY_BLOCKED.';
}

async function getPlanPhaseDirtyWorktreeBlocker(state: OrchestrationState, phase: 'coder_plan' | 'coder_plan_response' | 'coder_plan_optional_response') {
  const allowedDirtyPaths = [...new Set([...state.allowedDirtyPaths, state.planDoc])];
  let statusOutput: string;
  try {
    statusOutput = await getWorktreeStatus(state.cwd, { untrackedFiles: 'all' });
  } catch (error) {
    if (error instanceof Error && /not a git repository/.test(error.message)) {
      return null;
    }
    throw error;
  }
  const dirtyStatus = filterAllowedDirtyPathStatus(
    state.cwd,
    filterWrapperOwnedWorktreeStatus(statusOutput),
    allowedDirtyPaths,
  );
  if (dirtyStatus.trim() === '') {
    return null;
  }

  return [
    `Planner dirtied non-plan files during ${phase}.`,
    'Plan phases may only update the plan artifact; implementation changes must happen during execution.',
    '',
    'Dirty files:',
    dirtyStatus,
  ].join('\n');
}

async function finalizePlanReviewResponseWithoutOpenFindings(
  state: OrchestrationState,
  statePath: string,
  phase: 'coder_plan_response' | 'coder_plan_optional_response',
  logger?: RunLogger,
) {
  const { spec, reviewMode } = resolvePlanningAdjudicationContext(state);
  const signal = reviewMode === 'derived-plan' ? 'accept_derived_plan' : 'accept_plan';
  assertAdjudicationTransitionSignal(spec, signal, `orchestrator:${phase}:settled`);
  let nextState = await saveState(statePath, {
    ...transitionPlanReviewWithoutOpenFindings(state, reviewMode),
    pendingPlanReviewGuidance: null,
  });
  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase,
    openFindings: 0,
    nextPhase: nextState.phase,
  });
  nextState = await flushDerivedPlanNotifications(nextState, statePath, logger);
  if (nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

// The structural origin of a plan-stage block, passed explicitly by the caller
// because the phase alone cannot separate a genuine coder-authored block from a
// dirty-worktree safety block (both share `blockedFromPhase` on the
// `runPlanningResponsePhase` path). Only `coder_authored` takes the
// blocked-with-reason landing (a durable `blockerReason` the operator answers
// via `neal resume --message`); `dirty_worktree` and `reviewer_convergence`
// block without one.
export type PlanReviewBlockCause = 'coder_authored' | 'dirty_worktree' | 'reviewer_convergence';

export async function finalizeBlockedPlanReviewResponse(
  state: OrchestrationState,
  statePath: string,
  derivedPlanReview: boolean,
  blocker: string,
  blockCause: PlanReviewBlockCause,
  logger?: RunLogger,
) {
  const { spec } = resolvePlanningAdjudicationContext(state);
  assertAdjudicationTransitionSignal(spec, 'block_for_operator', 'orchestrator:planning:block_for_operator');
  if (state.topLevelMode !== 'execute') {
    // Top-level plan stage (`neal run`/`neal plan`).
    if (blockCause === 'coder_authored') {
      // Recoverable landing for a coder-authored *response* block: persist the
      // durable blocker reason and leave `status:'blocked'` (writer exit 2) for
      // an operator to answer via `neal resume --message`.
      const blockedState = await saveState(statePath, {
        ...state,
        blockerReason: blocker,
      });
      if (!derivedPlanReview) {
        await notifyBlocked(blockedState, blocker, logger);
      }
      return flushDerivedPlanNotifications(blockedState, statePath, logger, blocker);
    }
    // A `dirty_worktree` safety block or a `reviewer_convergence` cap/stall
    // block: leave `status:'blocked'` (writer exit 2) without a durable
    // blockerReason. The dirty-worktree case must not be silently converted to
    // the blocked-with-reason landing (the planner dirtied non-plan files), and
    // the convergence cap already bounded the autonomous push.
    if (!derivedPlanReview) {
      await notifyBlocked(state, blocker, logger);
    }
    return flushDerivedPlanNotifications(state, statePath, logger, blocker);
  }

  const persistedState = await enterInteractiveBlockedRecovery(state, statePath, blocker, logger);
  if (!derivedPlanReview && shouldNotifyInteractiveBlockedRecoveryEntry(persistedState)) {
    await notifyBlocked(persistedState, blocker, logger);
  }
  return flushDerivedPlanNotifications(persistedState, statePath, logger, blocker);
}

export function getPlanningResponseRetryPhase(mode: 'required' | 'optional') {
  return mode === 'optional' ? 'coder_plan_optional_response' : 'coder_plan_response';
}

export async function runCoderPlanPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'coder_plan' });
  if (isPlanRefinementState(state)) {
    writeDiagnostic(
      `${formatPlanRefinementRoundLine({ round: state.rounds.length + 1, maxRounds: state.maxRounds })}\n`,
      logger,
    );
  }
  let workingState = state;
  let codex;
  if (state.plannerSessionHandle && state.plannerSessionProtocol === null) {
    throw new Error('Cannot resume planner planning phase without plannerSessionProtocol.');
  }
  const activePlannerSessionProtocol = state.plannerSessionHandle
    ? state.plannerSessionProtocol
    : 'structured_json_v1';
  try {
    codex = await runCoderPlanRound({
      coder: state.agentConfig.planner,
      cwd: state.cwd,
      planDoc: state.planDoc,
      sessionHandle: state.plannerSessionHandle,
      coderSessionProtocol: state.plannerSessionProtocol,
      // Reinforce an author-declared `one_shot` only for the top-level authored plan; the
      // coder_plan phase only runs for top-level `neal plan` refinement (derived-plan
      // revisions run through coder_plan_response).
      authoredOneShot: !isDerivedPlanReviewState(state) && state.authoredExecutionShape === 'one_shot',
      onSessionStarted: async (sessionHandle) => {
        state.plannerSessionHandle = sessionHandle;
        state.plannerSessionProtocol = activePlannerSessionProtocol;
        workingState = await saveState(statePath, {
          ...workingState,
          plannerSessionHandle: sessionHandle,
          plannerSessionProtocol: activePlannerSessionProtocol,
        });
      },
      logger,
    });
  } catch (error) {
    if (error instanceof CoderRoundError) {
      if (shouldRetryCoderWithFreshSession(workingState, 'coder_plan', error)) {
        return scheduleCoderFreshSessionRetry(workingState, statePath, 'coder_plan', error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoder(error.sessionHandle ?? workingState.plannerSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(workingState, statePath, 'coder_plan', error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const completionProblem = getPlanningCompletionProblem(codex.marker);
  const dirtyWorktreeBlocker = await getPlanPhaseDirtyWorktreeBlocker(workingState, 'coder_plan');
  const blocked = codex.marker === 'AUTONOMY_BLOCKED' || Boolean(completionProblem) || Boolean(dirtyWorktreeBlocker);
  // Persist why the planner stopped so `neal status` and the run result can show
  // it. A `coder_plan` block is never answerable via `neal resume --message`
  // (that eligibility keys on `blockedFromPhase`), so a non-null reason here
  // only informs the operator; it does not change resume behavior.
  const reason = blocked
    ? dirtyWorktreeBlocker ?? completionProblem ?? codex.blockedReason ?? 'The planner reported a blocker during plan refinement'
    : null;

  const nextState = await saveState(statePath, {
    ...workingState,
    plannerSessionHandle: codex.sessionHandle,
    plannerSessionProtocol: codex.sessionHandle ? activePlannerSessionProtocol : null,
    lastScopeMarker: codex.marker as ScopeMarker | null,
    phase: blocked ? 'blocked' : 'reviewer_plan',
    status: blocked ? 'blocked' : 'running',
    blockedFromPhase: blocked ? 'coder_plan' : null,
    blockerReason: reason,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'coder_plan',
    marker: codex.marker,
    sessionHandle: codex.sessionHandle,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && reason !== null) {
    if (nextState.topLevelMode !== 'execute') {
      await notifyBlocked(nextState, reason, logger);
      return nextState;
    }
    const persistedState = await enterInteractiveBlockedRecovery(nextState, statePath, reason, logger);
    if (shouldNotifyInteractiveBlockedRecoveryEntry(persistedState)) {
      await notifyBlocked(persistedState, reason, logger);
    }
    return persistedState;
  }
  return nextState;
}

export async function runPlanReviewPhase(state: OrchestrationState, statePath: string, logger?: RunLogger) {
  await logger?.event('phase.start', { phase: 'reviewer_plan', round: state.rounds.length + 1 });
  const round = state.rounds.length + 1;
  const normalizedPlanPath = getNormalizedPlanArtifactPath(state, resolvePlanningAdjudicationContext(state).reviewTargetPath);
  let claude;
  let context;
  let preparedReview;
  let synthesizedReview;
  try {
    ({
      context,
      preparedReview,
      reviewerResult: claude,
      synthesizedReview,
    } = await runPlanningReviewerAdjudication({
      state,
      round,
      reviewMarkdownPath: state.reviewMarkdownPath,
      normalizedPlanPath,
      logger,
      preparePlanReviewArtifact,
      synthesizePlanReviewFindings,
    }));
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      // A content-safety refusal is a distinct, terminal, non-coder-recoverable
      // condition: end the run blocked (exit 2) with a durable actionable reason
      // by RETURNING the terminal blocked state, never throwing (a thrown error
      // over a persisted blocked state escapes executeRun).
      if (error.kind === 'content_refused') {
        const blockedState = await saveState(statePath, {
          ...state,
          reviewerSessionHandle: null,
          phase: 'blocked',
          status: 'blocked',
          blockedFromPhase: null,
          blockerReason: REVIEWER_CONTENT_REFUSED_BLOCK_REASON,
        });
        await writeExecutionArtifacts(blockedState);
        await logger?.event('phase.error', {
          phase: 'reviewer_plan',
          round,
          sessionHandle: error.sessionHandle,
          subtype: error.subtype,
          errorKind: error.kind,
          message: error.message,
        });
        await notifyBlocked(blockedState, REVIEWER_CONTENT_REFUSED_BLOCK_REASON, logger);
        return blockedState;
      }
      const failedState = await saveState(statePath, {
        ...state,
        reviewerSessionHandle: null,
        status: 'failed',
      });
      await writeExecutionArtifacts(failedState);
      await logger?.event('phase.error', {
        phase: 'reviewer_plan',
        round,
        sessionHandle: error.sessionHandle,
        subtype: error.subtype,
        message: error.message,
      });
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const { derivedPlanReview, roundLimit } = context;
  // Plan refinement adopts the refined execution shape directly. An earlier hard clamp —
  // forcing an author-declared `one_shot` plan back to `one_shot` and injecting a blocking
  // shape-restoration finding when refinement expanded it — caused plan-review
  // non-convergence on complex plans: the planner could not produce an accurate
  // single-scope plan, so the reviewer kept (correctly) rejecting until the round cap
  // failed the run. The over-decomposition concern the clamp targeted is better handled
  // as a soft planner-prompt bias than a hard shape clamp.
  const normalizedFindingInputs = synthesizedReview.findings;

  printReviewResult('plan-review', claude.summary, normalizedFindingInputs, logger);

  const { findings, mergedFindings, disposition, blockReason, roundRecord, planReviewDebt } = synthesizePlanReviewRound({
    state,
    round,
    roundLimit,
    reviewStuckWindow: getReviewStuckWindow(state.cwd),
    debtRoundThreshold: getPlanReviewDebtRoundThreshold(state.cwd),
    derivedPlanReview,
    currentDerivedPlanStatus: state.derivedPlanStatus,
    executionShape: synthesizedReview.executionShape,
    findingInputs: normalizedFindingInputs,
    reviewerSessionHandle: claude.sessionHandle,
    reviewedPlanPath: synthesizedReview.reviewedPlanPath,
    normalizationApplied: preparedReview.validation.normalization.applied,
    normalizationOperations: preparedReview.validation.normalization.operations,
    normalizationScopeLabelMappings: preparedReview.validation.normalization.scopeLabelMappings,
    commitRange: {
      base: state.baseCommit ?? '',
      head: state.finalCommit ?? state.baseCommit ?? '',
    },
  });
  assertAdjudicationTransitionSignal(context.spec, disposition.planningSignal, 'orchestrator:reviewer_plan');

  const nextState = await saveState(statePath, {
    ...state,
    reviewerSessionHandle: claude.sessionHandle,
    executionShape: synthesizedReview.executionShape,
    phase: disposition.phase,
    status: disposition.status,
    rounds: [...state.rounds, roundRecord],
    findings: mergedFindings,
    // Recompute the current-negotiation plan-review debt projection from the
    // post-conversion merged findings. Never touches inheritedPlanReviewDebt.
    planReviewDebt,
    derivedPlanStatus: disposition.derivedPlanStatus,
    blockedFromPhase: disposition.blockedFromPhase,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'reviewer_plan',
    round,
    sessionHandle: claude.sessionHandle,
    findings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked' && blockReason) {
    // A reviewer convergence/cap terminal block, never a coder-authored one.
    return finalizeBlockedPlanReviewResponse(
      nextState,
      statePath,
      derivedPlanReview,
      blockReason,
      'reviewer_convergence',
      logger,
    );
  }
  if (shouldNotifyDerivedPlanAcceptance(state, nextState)) {
    return flushDerivedPlanNotifications(nextState, statePath, logger);
  }
  if (nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

export async function runPlanningResponsePhase(
  state: OrchestrationState,
  statePath: string,
  phase: 'coder_plan_response' | 'coder_plan_optional_response',
  logger?: RunLogger,
) {
  const planningContext = resolvePlanningAdjudicationContext(state);
  const { spec, derivedPlanReview } = planningContext;
  // Top-level `neal plan` refinement (reviewMode === 'plan', i.e. !derivedPlanReview) is normally
  // authored by a persisted planner session, so a missing handle stays a hard error for
  // resume-capable planner providers. Derived-plan revisions are authored by the coder and create
  // no planner session, and no-resume planner providers (`supportsSessionResume: false`, e.g.
  // openai-compatible) never persist a planner handle at all — they start a
  // fresh planner session instead.
  if (
    !derivedPlanReview &&
    !state.plannerSessionHandle &&
    !plannerProviderStartsFreshSessions(state.agentConfig.planner)
  ) {
    throw new Error(`Cannot run ${phase} phase without an existing planner session`);
  }
  // Mirror the coder.ts:150-152 pattern: keep the existing protocol for a resumed planner
  // session, otherwise mint 'structured_json_v1' for a freshly created derived-plan session so a
  // non-null sessionHandle is never persisted with a null plannerSessionProtocol.
  const activePlannerSessionProtocol = state.plannerSessionHandle ? state.plannerSessionProtocol : 'structured_json_v1';

  const mode = phase === 'coder_plan_optional_response' ? 'optional' : 'required';
  await logger?.event('phase.start', { phase });
  if (isPlanRefinementState(state)) {
    writeDiagnostic(
      `${formatPlanRefinementRoundLine({ round: state.rounds.length + 1, maxRounds: state.maxRounds })}\n`,
      logger,
    );
  }
  // The bounded finding set for this response round: the prompt and the
  // disposition eligibility below consume this same selection. Findings
  // beyond the per-round limit stay open; when the presented set is fully
  // dispositioned, this phase stays active and presents the next batch (see
  // hasNextResponseBatch below), so the cap never strands a finding.
  const openFindings = state.findings
    .filter(mode === 'optional' ? isOpenNonBlockingFinding : isOpenBlockingFinding)
    .slice(0, OPEN_FINDINGS_PROMPT_ITEM_LIMIT);
  // Recorded operator guidance must reach the planner. If a prior blocked response
  // closed every finding, the guidance would otherwise be silently discarded here
  // (finalizePlanReviewResponseWithoutOpenFindings clears pendingPlanReviewGuidance
  // and accepts the plan) without ever delivering the operator's answer. Force a
  // response adjudication whenever guidance is pending so it is delivered first.
  if (openFindings.length === 0 && state.pendingPlanReviewGuidance === null) {
    return finalizePlanReviewResponseWithoutOpenFindings(state, statePath, phase, logger);
  }

  let codex;
  try {
    ({ response: codex } = await runPlanningResponseAdjudication({
      state,
      mode: mode === 'optional' ? 'optional' : undefined,
      openFindings: openFindings.map((finding) => ({
        id: finding.id,
        source: finding.source,
        claim: finding.claim,
        requiredAction: finding.requiredAction,
        severity: finding.severity,
        files: finding.files,
        roundSummary: finding.roundSummary,
      })),
      logger,
    }));
  } catch (error) {
    if (error instanceof CoderRoundError) {
      const retryPhase = getPlanningResponseRetryPhase(mode);
      if (shouldRetryCoderWithFreshSession(state, retryPhase, error)) {
        return scheduleCoderFreshSessionRetry(state, statePath, retryPhase, error, logger);
      }
      if (isCoderTimeoutError(error)) {
        await bestEffortCleanupTimedOutCoder(error.sessionHandle ?? state.plannerSessionHandle, logger);
      }
      const failedState = await persistCoderFailureState(state, statePath, retryPhase, error, logger);
      if (shouldNotifyFailure(error)) {
        await notifyBlocked(failedState, error.message, logger);
      }
    }
    throw error;
  }
  const responseById = new Map(codex.payload.responses.map((response) => [response.id, response]));
  assertAdjudicationTransitionSignal(
    spec,
    codex.payload.outcome === 'blocked' ? 'block_for_operator' : mode === 'optional' ? 'optional_revision' : 'request_revision',
    `orchestrator:${phase}`,
  );
  const dirtyWorktreeBlocker = await getPlanPhaseDirtyWorktreeBlocker(state, phase);

  // Response-eligibility contract: only findings this invocation actually
  // presented to the coder (the mode-matching `openFindings` set — open blocking
  // for a required response, open non-blocking for an optional one) may be
  // dispositioned. The response `id` schema is an unconstrained `z.string()`, so a
  // planner can name any finding; a response whose `id` is outside `openFindings`
  // — an already-`deferred` banked-debt finding, a prior-round `fixed`/`rejected`
  // finding, a wrong-mode finding (a blocking id in an optional response or the
  // reverse), or an unknown id — is a no-op that never mutates status or
  // coderDisposition. This keeps `toPlanReviewDebt`'s reservation intact (a banked
  // hardening finding cannot be silently un-banked by an out-of-band disposition)
  // and matches the replay harness's open-blocking eligibility guard.
  const openFindingIds = new Set(openFindings.map((finding) => finding.id));

  // Optional responses must disposition every presented finding exactly once,
  // matching execute optional response coverage: a partial optional response
  // would otherwise land acceptance below while presented findings — and every
  // overflow batch beyond the per-round presentation limit — were never
  // resolved. Out-of-set ids keep their documented no-op tolerance.
  if (mode === 'optional' && codex.payload.outcome === 'responded') {
    const seenPresentedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    for (const response of codex.payload.responses) {
      if (!openFindingIds.has(response.id)) {
        continue;
      }
      if (seenPresentedIds.has(response.id)) {
        duplicateIds.add(response.id);
      }
      seenPresentedIds.add(response.id);
    }
    if (duplicateIds.size > 0) {
      throw new Error(
        `Planner optional response returned duplicate finding dispositions: ${[...duplicateIds].join(', ')}`,
      );
    }
    const missingIds = openFindings.map((finding) => finding.id).filter((id) => !seenPresentedIds.has(id));
    if (missingIds.length > 0) {
      throw new Error(
        `Planner optional response did not disposition every presented finding: ${missingIds.join(', ')}`,
      );
    }
  }

  const findings = state.findings.map((finding) => {
    if (!openFindingIds.has(finding.id)) {
      return finding;
    }
    const response = responseById.get(finding.id);
    if (!response) {
      return finding;
    }

    return {
      ...finding,
      status: mapDecisionToStatus(response.decision),
      coderDisposition: response.summary,
      coderCommit: null,
    };
  });

  // Response rounds batch: when the presented set was fully dispositioned but
  // open findings of this round's kind remain (they were beyond the per-round
  // presentation limit), stay in this response phase so the next batch is
  // presented immediately instead of spending a plan-review round per batch.
  // The full-disposition requirement guarantees the backlog strictly shrinks;
  // a partially-skipped presented set falls through to the reviewer so the
  // existing convergence machinery judges it.
  const openSelector = mode === 'optional' ? isOpenNonBlockingFinding : isOpenBlockingFinding;
  const presentedStillOpen = findings.some((finding) => openFindingIds.has(finding.id) && openSelector(finding));
  const hasNextResponseBatch = !presentedStillOpen && findings.some(openSelector);

  const nextState = await saveState(statePath, {
    ...state,
    plannerSessionHandle: codex.sessionHandle,
    plannerSessionProtocol: codex.sessionHandle ? activePlannerSessionProtocol : null,
    findings,
    // Reproject the current-negotiation plan-review debt after applying coder
    // dispositions (a re-defer keeps debt; a fix/reject/reopen drops it). Never
    // touches inheritedPlanReviewDebt.
    planReviewDebt: toPlanReviewDebt(findings),
    phase:
      dirtyWorktreeBlocker || codex.payload.outcome === 'blocked'
        ? 'blocked'
        : hasNextResponseBatch
          ? phase
          : mode === 'optional'
            ? derivedPlanReview
              ? 'awaiting_derived_plan_execution'
              : 'done'
            : 'reviewer_plan',
    status:
      dirtyWorktreeBlocker || codex.payload.outcome === 'blocked'
        ? 'blocked'
        : mode === 'optional' && !derivedPlanReview && !hasNextResponseBatch
          ? 'done'
          : 'running',
    derivedPlanStatus:
      mode === 'optional' && codex.payload.outcome !== 'blocked' && derivedPlanReview && !hasNextResponseBatch
        ? 'accepted'
        : state.derivedPlanStatus,
    blockedFromPhase: dirtyWorktreeBlocker || codex.payload.outcome === 'blocked' ? phase : null,
    pendingPlanReviewGuidance: null,
    // Clear any stale reason as we advance to running/done; the recoverable
    // coder-authored blocked landing re-persists it in finalizeBlockedPlanReviewResponse.
    blockerReason: null,
  });

  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase,
    outcome: codex.payload.outcome,
    respondedFindings: codex.payload.responses.length,
    nextPhase: nextState.phase,
  });
  if (nextState.status === 'blocked') {
    const blocker = getDerivedPlanBlockedReason(
      derivedPlanReview,
      dirtyWorktreeBlocker ||
        codex.payload.blocker?.trim() ||
        codex.payload.summary.trim() ||
        (mode === 'optional'
          ? 'The coder reported a blocker while considering non-blocking plan findings'
          : 'The coder reported a blocker during plan response'),
    );
    // The coder authored the block unless the safety net tripped on a dirtied
    // non-plan worktree; the cause drives the recoverable-vs-terminal landing.
    return finalizeBlockedPlanReviewResponse(
      nextState,
      statePath,
      derivedPlanReview,
      blocker,
      dirtyWorktreeBlocker ? 'dirty_worktree' : 'coder_authored',
      logger,
    );
  }
  if (mode === 'optional' && shouldNotifyDerivedPlanAcceptance(state, nextState)) {
    return flushDerivedPlanNotifications(nextState, statePath, logger);
  }
  if (mode === 'optional' && nextState.status === 'done') {
    await notifyComplete(nextState, 'Plan review converged', logger);
  }
  return nextState;
}

export async function runAwaitingDerivedPlanExecutionPhase(
  state: OrchestrationState,
  statePath: string,
  logger?: RunLogger,
) {
  const nextState = await saveState(statePath, adoptAcceptedDerivedPlan(state));
  await writeExecutionArtifacts(nextState);
  await logger?.event('phase.complete', {
    phase: 'awaiting_derived_plan_execution',
    nextPhase: nextState.phase,
    scopeNumber: getCurrentScopeLabel(nextState),
    planDoc: getExecutionPlanPath(nextState),
  });
  return nextState;
}
