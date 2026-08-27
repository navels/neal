import { EXECUTE_FINALIZATION_PHASE } from './execute-finalization.js';
import type { OrchestrationPhase, OrchestrationState } from './types.js';

type OrchestrationStatus = OrchestrationState['status'];
type CompletedScope = OrchestrationState['completedScopes'][number];
type ScopeMarker = CompletedScope['marker'];
type InteractiveBlockedRecoveryState = NonNullable<OrchestrationState['interactiveBlockedRecovery']>;
type InteractiveBlockedRecoverySourcePhase = InteractiveBlockedRecoveryState['sourcePhase'];
type InteractiveBlockedRecoveryTurnDisposition = NonNullable<
  InteractiveBlockedRecoveryState['turns'][number]['disposition']
>;
type InteractiveBlockedRecoveryAction = InteractiveBlockedRecoveryTurnDisposition['action'];
export type OrchestrationStateValidationSource = 'load' | 'save' | 'test';
export type OrchestrationStateValidationContext = {
  source: OrchestrationStateValidationSource;
  path?: string;
};
type AssertNever<T extends never> = T;

// state.ts requires the current v1 record shape; this layer validates semantic relationships after parsing.
export const ORCHESTRATION_PHASES = [
  'coder_plan',
  'reviewer_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
  'awaiting_derived_plan_execution',
  'coder_scope',
  'manual_gate',
  'reviewer_scope',
  'coder_response',
  'coder_optional_response',
  'interactive_blocked_recovery',
  EXECUTE_FINALIZATION_PHASE,
  'final_completion_review',
  'done',
  'blocked',
] as const satisfies readonly OrchestrationPhase[];

export const ORCHESTRATION_STATUSES = [
  'running',
  'paused',
  'done',
  'blocked',
  'failed',
] as const satisfies readonly OrchestrationStatus[];

export const INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES = [
  'coder_plan',
  'reviewer_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
  'awaiting_derived_plan_execution',
  'coder_scope',
  'reviewer_scope',
  'coder_response',
  'coder_optional_response',
  EXECUTE_FINALIZATION_PHASE,
  'final_completion_review',
] as const satisfies readonly InteractiveBlockedRecoverySourcePhase[];

export const RESUMABLE_BLOCKED_PHASES = [
  'coder_scope',
  'coder_response',
  'coder_optional_response',
  'coder_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
] as const satisfies readonly OrchestrationPhase[];

type _OrchestrationPhaseListIsExhaustive = AssertNever<
  Exclude<OrchestrationPhase, (typeof ORCHESTRATION_PHASES)[number]>
>;
type _OrchestrationStatusListIsExhaustive = AssertNever<
  Exclude<OrchestrationStatus, (typeof ORCHESTRATION_STATUSES)[number]>
>;

const ORCHESTRATION_PHASE_SET = new Set<OrchestrationPhase>(ORCHESTRATION_PHASES);
const ORCHESTRATION_STATUS_SET = new Set<OrchestrationStatus>(ORCHESTRATION_STATUSES);
const INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASE_SET = new Set<InteractiveBlockedRecoverySourcePhase>(
  INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES,
);
const SCOPE_MARKERS = new Set<ScopeMarker>([
  'AUTONOMY_SCOPE_DONE',
  'AUTONOMY_CHUNK_DONE',
  'AUTONOMY_DONE',
  'AUTONOMY_BLOCKED',
  'AUTONOMY_SPLIT_PLAN',
]);
const FINAL_COMPLETION_ACTIONS = new Set<NonNullable<OrchestrationState['finalCompletionResolvedAction']>>([
  'accept_complete',
  'continue_execution',
  'block_for_operator',
]);
const CODER_SESSION_PROTOCOLS = new Set<NonNullable<OrchestrationState['coderSessionProtocol']>>([
  'legacy_marker_v1',
  'structured_json_v1',
]);

function formatInvalidValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function formatValidationContext(context: OrchestrationStateValidationContext): string {
  return context.path ? ` during ${context.source} at ${context.path}` : ` during ${context.source}`;
}

function throwStateInvariant(
  context: OrchestrationStateValidationContext,
  fieldPath: string,
  reason: string,
): never {
  throw new Error(`Invalid run state${formatValidationContext(context)}: invalid ${fieldPath}: ${reason}`);
}

export function isOrchestrationPhase(value: unknown): value is OrchestrationPhase {
  return typeof value === 'string' && ORCHESTRATION_PHASE_SET.has(value as OrchestrationPhase);
}

export function assertOrchestrationPhase(value: unknown, fieldPath = 'phase'): asserts value is OrchestrationPhase {
  if (!isOrchestrationPhase(value)) {
    throw new Error(
      `Invalid run state: invalid ${fieldPath}: expected orchestration phase, received ${formatInvalidValue(value)}`,
    );
  }
}

function assertKnownPhase(
  value: unknown,
  fieldPath: string,
  context: OrchestrationStateValidationContext,
): asserts value is OrchestrationPhase {
  if (!isOrchestrationPhase(value)) {
    throwStateInvariant(context, fieldPath, `expected orchestration phase, received ${formatInvalidValue(value)}`);
  }
}

function assertKnownStatus(
  value: unknown,
  fieldPath: string,
  context: OrchestrationStateValidationContext,
): asserts value is OrchestrationStatus {
  if (!isOrchestrationStatus(value)) {
    throwStateInvariant(context, fieldPath, `expected orchestration status, received ${formatInvalidValue(value)}`);
  }
}

function assertSafeIntegerAtLeast(
  value: unknown,
  fieldPath: string,
  minimum: number,
  context: OrchestrationStateValidationContext,
): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throwStateInvariant(
      context,
      fieldPath,
      `expected safe integer greater than or equal to ${minimum}, received ${formatInvalidValue(value)}`,
    );
  }
}

function assertNonEmptyString(
  value: unknown,
  fieldPath: string,
  context: OrchestrationStateValidationContext,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throwStateInvariant(context, fieldPath, `expected non-empty string, received ${formatInvalidValue(value)}`);
  }
}

function assertNullableSafeIntegerAtLeast(
  value: unknown,
  fieldPath: string,
  minimum: number,
  context: OrchestrationStateValidationContext,
): void {
  if (value !== null) {
    assertSafeIntegerAtLeast(value, fieldPath, minimum, context);
  }
}

function assertOptionalSafeIntegerAtLeast(
  value: unknown,
  fieldPath: string,
  minimum: number,
  context: OrchestrationStateValidationContext,
): void {
  if (value !== undefined) {
    assertSafeIntegerAtLeast(value, fieldPath, minimum, context);
  }
}

function assertUniqueCompletedScopeNumbers(
  completedScopes: OrchestrationState['completedScopes'],
  context: OrchestrationStateValidationContext,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < completedScopes.length; index += 1) {
    const number = completedScopes[index].number;
    if (seen.has(number)) {
      throwStateInvariant(
        context,
        `completedScopes[${index}].number`,
        `duplicate completed scope label ${JSON.stringify(number)}`,
      );
    }
    seen.add(number);
  }
}

function getInteractiveBlockedRecoveryResumePhase(
  sourcePhase: InteractiveBlockedRecoverySourcePhase,
): OrchestrationPhase {
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

function isAllowedInteractiveBlockedRecoveryDispositionResult(args: {
  action: InteractiveBlockedRecoveryAction;
  resultPhase: OrchestrationPhase;
  sourcePhase: InteractiveBlockedRecoverySourcePhase;
}) {
  switch (args.action) {
    case 'resume_current_scope':
      return args.resultPhase === getInteractiveBlockedRecoveryResumePhase(args.sourcePhase);
    case 'replace_current_scope':
      return args.resultPhase === 'reviewer_plan' || args.resultPhase === 'blocked';
    case 'stay_blocked':
      return args.resultPhase === 'interactive_blocked_recovery';
    case 'terminal_block':
      return args.resultPhase === 'blocked';
    default:
      return false;
  }
}

function assertInteractiveBlockedRecoveryDispositionResult(args: {
  action: InteractiveBlockedRecoveryAction;
  resultPhase: OrchestrationPhase;
  sourcePhase: InteractiveBlockedRecoverySourcePhase;
  fieldPath: string;
  context: OrchestrationStateValidationContext;
}) {
  if (
    !isAllowedInteractiveBlockedRecoveryDispositionResult({
      action: args.action,
      resultPhase: args.resultPhase,
      sourcePhase: args.sourcePhase,
    })
  ) {
    throwStateInvariant(
      args.context,
      args.fieldPath,
      `action ${JSON.stringify(args.action)} cannot result in phase ${JSON.stringify(args.resultPhase)} from source phase ${JSON.stringify(args.sourcePhase)}`,
    );
  }
}

function assertValidInteractiveBlockedRecoveryState(args: {
  recovery: InteractiveBlockedRecoveryState;
  fieldPath: string;
  state: OrchestrationState;
  context: OrchestrationStateValidationContext;
}) {
  const { recovery, fieldPath, state, context } = args;
  if (state.topLevelMode !== 'execute') {
    throwStateInvariant(
      context,
      'topLevelMode',
      `interactive blocked recovery is unsupported for ${formatInvalidValue(state.topLevelMode)}`,
    );
  }
  if (!INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASE_SET.has(recovery.sourcePhase)) {
    throwStateInvariant(
      context,
      `${fieldPath}.sourcePhase`,
      `unsupported interactive blocked recovery source phase ${JSON.stringify(recovery.sourcePhase)}`,
    );
  }
  assertSafeIntegerAtLeast(recovery.maxTurns, `${fieldPath}.maxTurns`, 1, context);
  assertSafeIntegerAtLeast(recovery.lastHandledTurn, `${fieldPath}.lastHandledTurn`, 0, context);
  if (recovery.lastHandledTurn > recovery.turns.length) {
    throwStateInvariant(
      context,
      `${fieldPath}.lastHandledTurn`,
      `must not exceed recorded turn count ${recovery.turns.length}`,
    );
  }
  // A recovery that reaches the turn cap and is then resolved by a turn-cap
  // terminal directive records one terminal-resolution turn beyond `maxTurns`,
  // so the recorded count may be `maxTurns + 1`. That extra turn is only ever
  // the terminal resolution: past the cap, new guidance becomes a
  // `pendingDirective` rather than an appended turn, so nothing else can push
  // the count higher.
  if (recovery.turns.length > recovery.maxTurns + 1) {
    throwStateInvariant(
      context,
      `${fieldPath}.turns`,
      `recorded turn count ${recovery.turns.length} exceeds maxTurns ${recovery.maxTurns} by more than the one terminal-resolution turn`,
    );
  }

  if (recovery.pendingDirective) {
    assertNonEmptyString(recovery.pendingDirective.recordedAt, `${fieldPath}.pendingDirective.recordedAt`, context);
    assertNonEmptyString(
      recovery.pendingDirective.operatorGuidance,
      `${fieldPath}.pendingDirective.operatorGuidance`,
      context,
    );
  }

  for (let index = 0; index < recovery.turns.length; index += 1) {
    const turn = recovery.turns[index];
    const expectedTurnNumber = index + 1;
    if (turn.number !== expectedTurnNumber) {
      throwStateInvariant(
        context,
        `${fieldPath}.turns[${index}].number`,
        `expected contiguous turn number ${expectedTurnNumber}, received ${formatInvalidValue(turn.number)}`,
      );
    }

    if (turn.disposition) {
      assertKnownPhase(turn.disposition.resultingPhase, `${fieldPath}.turns[${index}].disposition.resultingPhase`, context);
      assertInteractiveBlockedRecoveryDispositionResult({
        action: turn.disposition.action,
        resultPhase: turn.disposition.resultingPhase,
        sourcePhase: recovery.sourcePhase,
        fieldPath: `${fieldPath}.turns[${index}].disposition.resultingPhase`,
        context,
      });
    }
  }
}

function assertValidInteractiveBlockedRecoveryHistory(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
) {
  for (let index = 0; index < state.interactiveBlockedRecoveryHistory.length; index += 1) {
    const record = state.interactiveBlockedRecoveryHistory[index];
    const fieldPath = `interactiveBlockedRecoveryHistory[${index}]`;
    assertValidInteractiveBlockedRecoveryState({
      recovery: record,
      fieldPath,
      state,
      context,
    });
    assertKnownPhase(record.resultPhase, `${fieldPath}.resultPhase`, context);
    assertInteractiveBlockedRecoveryDispositionResult({
      action: record.resolvedByAction,
      resultPhase: record.resultPhase,
      sourcePhase: record.sourcePhase,
      fieldPath: `${fieldPath}.resultPhase`,
      context,
    });
  }
}

function assertValidInteractiveBlockedRecovery(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
) {
  if (state.phase === 'interactive_blocked_recovery' && !state.interactiveBlockedRecovery) {
    throwStateInvariant(
      context,
      'interactiveBlockedRecovery',
      'expected active recovery state when phase is "interactive_blocked_recovery"',
    );
  }

  if (state.interactiveBlockedRecovery) {
    if (state.phase !== 'interactive_blocked_recovery') {
      throwStateInvariant(
        context,
        'phase',
        `expected "interactive_blocked_recovery" while interactiveBlockedRecovery is active, received ${JSON.stringify(state.phase)}`,
      );
    }

    assertValidInteractiveBlockedRecoveryState({
      recovery: state.interactiveBlockedRecovery,
      fieldPath: 'interactiveBlockedRecovery',
      state,
      context,
    });
  }

  assertValidInteractiveBlockedRecoveryHistory(state, context);
}

function assertValidManualGate(state: OrchestrationState, context: OrchestrationStateValidationContext) {
  const manualGate = state.manualGate;
  if (state.phase === 'manual_gate' && manualGate === null) {
    throwStateInvariant(context, 'manualGate', 'expected active manual gate when phase is "manual_gate"');
  }
  if (state.phase !== 'manual_gate' && manualGate !== null) {
    throwStateInvariant(
      context,
      'phase',
      `expected "manual_gate" while manualGate is active, received ${JSON.stringify(state.phase)}`,
    );
  }
  if (manualGate === null) {
    return;
  }

  if (state.topLevelMode !== 'execute') {
    throwStateInvariant(context, 'topLevelMode', 'manual gates are supported only for execute-mode runs');
  }
  if (state.status !== 'running') {
    throwStateInvariant(
      context,
      'status',
      `expected "running" while manualGate is active, received ${JSON.stringify(state.status)}`,
    );
  }
  if (state.blockedFromPhase !== null) {
    throwStateInvariant(context, 'blockedFromPhase', 'expected null while manualGate is active');
  }

  assertNonEmptyString(manualGate.id, 'manualGate.id', context);
  assertNonEmptyString(manualGate.title, 'manualGate.title', context);
  assertNonEmptyString(manualGate.reason, 'manualGate.reason', context);
  assertNonEmptyString(manualGate.instructionsPath, 'manualGate.instructionsPath', context);
  assertNonEmptyString(manualGate.createdAt, 'manualGate.createdAt', context);
  assertNonEmptyString(manualGate.updatedAt, 'manualGate.updatedAt', context);
  if (manualGate.lastCheckedAt !== null) {
    assertNonEmptyString(manualGate.lastCheckedAt, 'manualGate.lastCheckedAt', context);
  }
  if (manualGate.resumePhase !== 'coder_scope') {
    throwStateInvariant(
      context,
      'manualGate.resumePhase',
      `expected "coder_scope", received ${formatInvalidValue(manualGate.resumePhase)}`,
    );
  }
  if (manualGate.resumeChecks.length === 0) {
    throwStateInvariant(context, 'manualGate.resumeChecks', 'expected at least one resume check');
  }
  for (let index = 0; index < manualGate.resumeChecks.length; index += 1) {
    const check = manualGate.resumeChecks[index];
    const fieldPath = `manualGate.resumeChecks[${index}]`;
    if (check.type !== 'command') {
      throwStateInvariant(context, `${fieldPath}.type`, `expected "command", received ${formatInvalidValue(check.type)}`);
    }
    assertNonEmptyString(check.name, `${fieldPath}.name`, context);
    if (!Array.isArray(check.command) || check.command.length === 0) {
      throwStateInvariant(context, `${fieldPath}.command`, 'expected non-empty string array');
    }
    for (let commandIndex = 0; commandIndex < check.command.length; commandIndex += 1) {
      assertNonEmptyString(check.command[commandIndex], `${fieldPath}.command[${commandIndex}]`, context);
    }
    if (check.cwd !== undefined && check.cwd !== 'repo' && check.cwd !== 'run_dir') {
      throwStateInvariant(
        context,
        `${fieldPath}.cwd`,
        `expected "repo" or "run_dir", received ${formatInvalidValue(check.cwd)}`,
      );
    }
    assertOptionalSafeIntegerAtLeast(check.timeoutMs, `${fieldPath}.timeoutMs`, 1, context);
  }

  if (manualGate.lastFailure !== null) {
    assertNonEmptyString(manualGate.lastFailure.checkName, 'manualGate.lastFailure.checkName', context);
    assertNullableSafeIntegerAtLeast(manualGate.lastFailure.exitCode, 'manualGate.lastFailure.exitCode', 0, context);
    if (manualGate.lastFailure.signal !== null) {
      assertNonEmptyString(manualGate.lastFailure.signal, 'manualGate.lastFailure.signal', context);
    }
    if (typeof manualGate.lastFailure.stdoutTail !== 'string') {
      throwStateInvariant(context, 'manualGate.lastFailure.stdoutTail', 'expected string');
    }
    if (typeof manualGate.lastFailure.stderrTail !== 'string') {
      throwStateInvariant(context, 'manualGate.lastFailure.stderrTail', 'expected string');
    }
  }
}

function assertValidPendingPlanReviewGuidance(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
) {
  const guidance = state.pendingPlanReviewGuidance;
  if (guidance === null) {
    return;
  }

  if (state.topLevelMode !== 'plan') {
    throwStateInvariant(
      context,
      'pendingPlanReviewGuidance',
      `expected null for ${formatInvalidValue(state.topLevelMode)} mode`,
    );
  }
  assertNonEmptyString(guidance.message, 'pendingPlanReviewGuidance.message', context);
  if (
    guidance.sourcePhase !== 'reviewer_plan' &&
    guidance.sourcePhase !== 'coder_plan_response' &&
    guidance.sourcePhase !== 'coder_plan_optional_response'
  ) {
    throwStateInvariant(
      context,
      'pendingPlanReviewGuidance.sourcePhase',
      `expected one of "reviewer_plan", "coder_plan_response", "coder_plan_optional_response", received ${formatInvalidValue(guidance.sourcePhase)}`,
    );
  }
  if (typeof guidance.recordedAt !== 'string') {
    throwStateInvariant(
      context,
      'pendingPlanReviewGuidance.recordedAt',
      `expected string, received ${formatInvalidValue(guidance.recordedAt)}`,
    );
  }
}

function assertValidDerivedPlanState(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
) {
  assertNullableSafeIntegerAtLeast(state.derivedFromScopeNumber, 'derivedFromScopeNumber', 0, context);
  assertNullableSafeIntegerAtLeast(state.derivedScopeIndex, 'derivedScopeIndex', 1, context);

  if (state.derivedPlanStatus !== null && state.derivedPlanPath === null) {
    throwStateInvariant(
      context,
      'derivedPlanPath',
      `expected non-null path when derivedPlanStatus is ${JSON.stringify(state.derivedPlanStatus)}`,
    );
  }
  if (state.derivedPlanPath !== null) {
    assertNonEmptyString(state.derivedPlanPath, 'derivedPlanPath', context);
  }

  if (state.derivedScopeIndex !== null) {
    if (state.topLevelMode !== 'execute') {
      throwStateInvariant(context, 'topLevelMode', 'derived scope execution is supported only for execute-mode runs');
    }
    if (state.derivedPlanStatus !== 'accepted') {
      throwStateInvariant(
        context,
        'derivedPlanStatus',
        `expected "accepted" when derivedScopeIndex is set, received ${formatInvalidValue(state.derivedPlanStatus)}`,
      );
    }
    if (state.derivedPlanPath === null) {
      throwStateInvariant(context, 'derivedPlanPath', 'expected non-null path when derivedScopeIndex is set');
    }
    if (state.derivedFromScopeNumber === null) {
      throwStateInvariant(
        context,
        'derivedFromScopeNumber',
        'expected non-null parent scope when derivedScopeIndex is set',
      );
    }
  }

  if (
    (state.derivedPlanStatus === 'pending_review' || state.derivedPlanStatus === 'rejected') &&
    state.derivedScopeIndex !== null
  ) {
    throwStateInvariant(
      context,
      'derivedScopeIndex',
      `expected null when derivedPlanStatus is ${JSON.stringify(state.derivedPlanStatus)}`,
    );
  }

  if (state.phase === 'awaiting_derived_plan_execution') {
    if (
      state.topLevelMode !== 'execute' ||
      state.derivedPlanStatus !== 'accepted' ||
      state.derivedPlanPath === null ||
      state.derivedFromScopeNumber === null
    ) {
      throwStateInvariant(
        context,
        'derivedPlanStatus',
        'awaiting derived plan execution requires an accepted execute-mode derived plan',
      );
    }
    if (state.derivedScopeIndex !== null) {
      throwStateInvariant(
        context,
        'derivedScopeIndex',
        'expected null before accepted derived plan execution starts',
      );
    }
    if (state.createdCommits.length > 0) {
      throwStateInvariant(
        context,
        'createdCommits',
        'awaiting derived plan execution must not carry active created commits',
      );
    }
  }

  if (
    context.source !== 'load' &&
    state.phase === 'done' &&
    state.derivedScopeIndex === null &&
    (state.derivedPlanStatus === 'accepted' || state.derivedPlanStatus === 'pending_review')
  ) {
    throwStateInvariant(
      context,
      'phase',
      `cannot be "done" while an unexecuted ${state.derivedPlanStatus === 'accepted' ? 'accepted' : 'pending'} derived plan is still active`,
    );
  }
}

function getExpectedFinalCompletionResolvedAction(
  state: OrchestrationState,
): OrchestrationState['finalCompletionResolvedAction'] {
  const verdict = state.finalCompletionReviewVerdict;
  if (!verdict) {
    return null;
  }
  if (verdict.action === 'continue_execution' && state.finalCompletionContinueExecutionCapReached) {
    return 'block_for_operator';
  }
  return verdict.action;
}

function assertValidFinalCompletionState(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
) {
  if (state.phase === 'final_completion_review') {
    if (state.topLevelMode !== 'execute') {
      throwStateInvariant(context, 'topLevelMode', 'final completion review is supported only for execute-mode runs');
    }
    if (!state.finalCompletionSummary) {
      throwStateInvariant(
        context,
        'finalCompletionSummary',
        'expected final completion summary when phase is "final_completion_review"',
      );
    }
  }

  if (state.finalCompletionResolvedAction !== null && !FINAL_COMPLETION_ACTIONS.has(state.finalCompletionResolvedAction)) {
    throwStateInvariant(
      context,
      'finalCompletionResolvedAction',
      `unsupported final completion action ${JSON.stringify(state.finalCompletionResolvedAction)}`,
    );
  }

  if (state.finalCompletionContinueExecutionCapReached) {
    if (state.finalCompletionReviewVerdict?.action !== 'continue_execution') {
      throwStateInvariant(
        context,
        'finalCompletionReviewVerdict.action',
        'expected "continue_execution" when final completion continue-execution cap is reached',
      );
    }
    if (state.finalCompletionResolvedAction !== 'block_for_operator') {
      throwStateInvariant(
        context,
        'finalCompletionResolvedAction',
        'expected "block_for_operator" when final completion continue-execution cap is reached',
      );
    }
  }

  if (state.finalCompletionReviewVerdict && state.finalCompletionResolvedAction === null) {
    throwStateInvariant(
      context,
      'finalCompletionResolvedAction',
      'expected resolved action when finalCompletionReviewVerdict is present',
    );
  }
  if (!state.finalCompletionReviewVerdict && state.finalCompletionResolvedAction !== null) {
    throwStateInvariant(
      context,
      'finalCompletionReviewVerdict',
      'expected verdict when finalCompletionResolvedAction is present',
    );
  }

  if (
    state.finalCompletionReviewVerdict &&
    state.finalCompletionReviewVerdict.action !== 'accept_complete' &&
    state.finalCompletionReviewVerdict.squashCommitMessage !== null
  ) {
    throwStateInvariant(
      context,
      'finalCompletionReviewVerdict.squashCommitMessage',
      `expected null when finalCompletionReviewVerdict.action is ${JSON.stringify(state.finalCompletionReviewVerdict.action)}`,
    );
  }

  const expectedResolvedAction = getExpectedFinalCompletionResolvedAction(state);
  if (expectedResolvedAction && state.finalCompletionResolvedAction !== expectedResolvedAction) {
    throwStateInvariant(
      context,
      'finalCompletionResolvedAction',
      `expected ${JSON.stringify(expectedResolvedAction)} for finalCompletionReviewVerdict.action ${JSON.stringify(state.finalCompletionReviewVerdict?.action)}, received ${formatInvalidValue(state.finalCompletionResolvedAction)}`,
    );
  }

}

function assertValidCompletedScopeAccounting(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
) {
  for (let index = 0; index < state.completedScopes.length; index += 1) {
    const scope = state.completedScopes[index];
    const fieldPath = `completedScopes[${index}]`;
    assertNonEmptyString(scope.number, `${fieldPath}.number`, context);
    if (!SCOPE_MARKERS.has(scope.marker)) {
      throwStateInvariant(
        context,
        `${fieldPath}.marker`,
        `unsupported scope marker ${formatInvalidValue(scope.marker)}`,
      );
    }
    if (scope.result !== 'accepted' && scope.result !== 'blocked') {
      throwStateInvariant(context, `${fieldPath}.result`, `unsupported scope result ${formatInvalidValue(scope.result)}`);
    }
    assertSafeIntegerAtLeast(scope.reviewRounds, `${fieldPath}.reviewRounds`, 0, context);
    assertSafeIntegerAtLeast(scope.findings, `${fieldPath}.findings`, 0, context);

    if (scope.result === 'accepted' && state.topLevelMode === 'execute') {
      assertNonEmptyString(scope.finalCommit, `${fieldPath}.finalCommit`, context);
      assertNonEmptyString(scope.commitSubject, `${fieldPath}.commitSubject`, context);
    }
    if (scope.result === 'blocked') {
      assertNonEmptyString(scope.blocker, `${fieldPath}.blocker`, context);
    }
  }
}

export function assertValidOrchestrationState(
  state: OrchestrationState,
  context: OrchestrationStateValidationContext,
): void {
  // This layer validates the parsed ledger without IO.
  assertKnownPhase(state.phase, 'phase', context);
  assertKnownStatus(state.status, 'status', context);
  if (state.blockedFromPhase !== null) {
    assertKnownPhase(state.blockedFromPhase, 'blockedFromPhase', context);
  }
  if (state.plannerSessionProtocol !== null && !CODER_SESSION_PROTOCOLS.has(state.plannerSessionProtocol)) {
    throwStateInvariant(
      context,
      'plannerSessionProtocol',
      `unsupported planner session protocol ${formatInvalidValue(state.plannerSessionProtocol)}`,
    );
  }
  if (state.plannerSessionHandle === null && state.plannerSessionProtocol !== null) {
    throwStateInvariant(context, 'plannerSessionProtocol', 'must be null when plannerSessionHandle is null');
  }
  if (state.plannerSessionHandle !== null && state.plannerSessionProtocol === null) {
    throwStateInvariant(context, 'plannerSessionProtocol', 'must not be null when plannerSessionHandle is present');
  }
  if (state.coderSessionProtocol !== null && !CODER_SESSION_PROTOCOLS.has(state.coderSessionProtocol)) {
    throwStateInvariant(
      context,
      'coderSessionProtocol',
      `unsupported coder session protocol ${formatInvalidValue(state.coderSessionProtocol)}`,
    );
  }
  if (state.coderSessionHandle === null && state.coderSessionProtocol !== null) {
    throwStateInvariant(context, 'coderSessionProtocol', 'must be null when coderSessionHandle is null');
  }

  if (state.phase === 'done' && state.status !== 'done') {
    throwStateInvariant(
      context,
      'status',
      `expected "done" when phase is "done", received ${JSON.stringify(state.status)}`,
    );
  }

  if (state.status === 'done' && state.phase !== 'done') {
    throwStateInvariant(
      context,
      'phase',
      `expected "done" when status is "done", received ${JSON.stringify(state.phase)}`,
    );
  }

  if (state.phase === 'blocked' && state.status !== 'blocked' && state.status !== 'failed') {
    throwStateInvariant(
      context,
      'status',
      `expected "blocked" or "failed" when phase is "blocked", received ${JSON.stringify(state.status)}`,
    );
  }

  const activeStatusInTerminalPhase =
    (state.status === 'running' || state.status === 'paused') &&
    (state.phase === 'done' || state.phase === 'blocked');
  if (activeStatusInTerminalPhase) {
    throwStateInvariant(
      context,
      'status',
      `cannot be ${JSON.stringify(state.status)} while phase is terminal ${JSON.stringify(state.phase)}`,
    );
  }

  // The durable coder-authored plan-stage blocker reason must never outlive its
  // block: any return to a non-blocked status (running/paused/done/failed) must
  // have cleared it. This catches a missed clear at the next save/load.
  if (state.status !== 'blocked' && state.blockerReason !== null) {
    throwStateInvariant(
      context,
      'blockerReason',
      `expected null when status is ${JSON.stringify(state.status)}, received ${formatInvalidValue(state.blockerReason)}`,
    );
  }

  assertSafeIntegerAtLeast(state.currentScopeNumber, 'currentScopeNumber', 0, context);
  assertSafeIntegerAtLeast(state.coderRetryCount, 'coderRetryCount', 0, context);
  assertSafeIntegerAtLeast(state.consultantAttemptCount, 'consultantAttemptCount', 0, context);
  assertSafeIntegerAtLeast(
    state.finalCompletionContinueExecutionCount,
    'finalCompletionContinueExecutionCount',
    0,
    context,
  );
  assertSafeIntegerAtLeast(state.splitPlanCountForCurrentScope, 'splitPlanCountForCurrentScope', 0, context);
  assertSafeIntegerAtLeast(state.derivedPlanDepth, 'derivedPlanDepth', 0, context);
  assertSafeIntegerAtLeast(state.maxDerivedPlanReviewRounds, 'maxDerivedPlanReviewRounds', 1, context);
  assertSafeIntegerAtLeast(state.maxRounds, 'maxRounds', 1, context);

  assertUniqueCompletedScopeNumbers(state.completedScopes, context);
  assertValidCompletedScopeAccounting(state, context);

  if (state.blockedFromPhase === 'done' || state.blockedFromPhase === 'blocked') {
    throwStateInvariant(
      context,
      'blockedFromPhase',
      `must not reference terminal phase ${JSON.stringify(state.blockedFromPhase)}`,
    );
  }

  assertValidInteractiveBlockedRecovery(state, context);
  assertValidManualGate(state, context);
  assertValidPendingPlanReviewGuidance(state, context);
  assertValidDerivedPlanState(state, context);
  assertValidFinalCompletionState(state, context);
}

export function isOrchestrationStatus(value: unknown): value is OrchestrationStatus {
  return typeof value === 'string' && ORCHESTRATION_STATUS_SET.has(value as OrchestrationStatus);
}

export function assertOrchestrationStatus(value: unknown, fieldPath = 'status'): asserts value is OrchestrationStatus {
  if (!isOrchestrationStatus(value)) {
    throw new Error(
      `Invalid run state: invalid ${fieldPath}: expected orchestration status, received ${formatInvalidValue(value)}`,
    );
  }
}
