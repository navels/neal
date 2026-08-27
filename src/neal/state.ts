import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { validatePlanDocument } from './plan-validation.js';
import { getRunStatePath as getStorageRunStatePath } from './storage-paths.js';
import type {
  AgentConfig,
  ExecuteScopeProgressJustification,
  FinalCompletionReviewerVerdict,
  FinalCompletionSummary,
  InteractiveBlockedRecoveryRecord,
  InteractiveBlockedRecoveryState,
  InteractiveBlockedRecoveryTurnDisposition,
  CoderSessionProtocol,
  ManualGateResumeCheck,
  ManualGateState,
  OrchestrationPhase,
  OrchestrationState,
  OrchestratorInit,
  PendingPlanReviewGuidance,
  PlanReviewFindingClass,
  RecentBlockRecord,
  ResidualReviewDebtItem,
  ReviewerMeaningfulProgressVerdict,
  ReviewFinding,
  ReviewRound,
  TopLevelMode,
} from './types.js';
import {
  getDefaultCoderEffort,
  getDefaultCoderModel,
  getDefaultCoderProvider,
  getDefaultPlannerEffort,
  getDefaultPlannerModel,
  getDefaultPlannerProvider,
  getDefaultReviewerEffort,
  getDefaultReviewerModel,
  getDefaultReviewerProvider,
} from './config.js';
import { EXECUTE_FINALIZATION_PHASE } from './execute-finalization.js';
import { formatRegisteredProviderIds, isRegisteredProviderId } from './providers/registry.js';
import { updateRunPointersAfterStateSave } from './run-registry.js';
import { refreshActiveRunLock } from './run-lock.js';
import { validateReviewerSquashMessageDraft } from './squash-message.js';
import {
  assertOrchestrationPhase,
  assertOrchestrationStatus,
  assertValidOrchestrationState,
} from './state-invariants.js';

const TOP_LEVEL_MODES = new Set<TopLevelMode>(['plan', 'execute']);
const INTERACTIVE_BLOCKED_RECOVERY_TURN_ORIGINS = ['operator', 'consultant'] as const;

const INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES = new Set<InteractiveBlockedRecoveryState['sourcePhase']>([
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
]);

export function getDefaultAgentConfig(cwd = process.cwd()): AgentConfig {
  return {
    planner: {
      provider: getDefaultPlannerProvider(cwd),
      model: getDefaultPlannerModel(cwd),
      effort: getDefaultPlannerEffort(cwd),
    },
    coder: {
      provider: getDefaultCoderProvider(cwd),
      model: getDefaultCoderModel(cwd),
      effort: getDefaultCoderEffort(cwd),
    },
    reviewer: {
      provider: getDefaultReviewerProvider(cwd),
      model: getDefaultReviewerModel(cwd),
      effort: getDefaultReviewerEffort(cwd),
    },
  };
}

export function getRunStatePath(runDir: string) {
  return getStorageRunStatePath(runDir);
}

// Read the execution shape declared in the seed plan document, regardless of top-level
// mode. Returns null when the plan document is absent (ENOENT). This is the authored
// shape captured write-once at run creation for both `plan` and `execute` modes.
async function readSeedExecutionShape(init: OrchestratorInit): Promise<OrchestrationState['executionShape']> {
  try {
    return validatePlanDocument(await readFile(init.planDoc, 'utf8')).executionShape;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readInitialExecutionShape(init: OrchestratorInit): Promise<OrchestrationState['executionShape']> {
  // Execute mode adopts the seed shape immediately; plan mode starts with no adopted
  // shape (it is established/refined through plan review). Unchanged behavior.
  if (init.topLevelMode !== 'execute') {
    return null;
  }
  return readSeedExecutionShape(init);
}

export async function createInitialState(init: OrchestratorInit, baseCommit: string): Promise<OrchestrationState> {
  const now = new Date().toISOString();
  const executionShape = await readInitialExecutionShape(init);
  // Capture the author-declared shape from the seed plan for all top-level modes, so plan
  // refinement can honor an author-declared `one_shot`. Write-once: never reassigned.
  const authoredExecutionShape = await readSeedExecutionShape(init);

  return {
    version: 1,
    planDoc: init.planDoc,
    planDocBackupPath: init.planDocBackupPath ?? null,
    cwd: init.cwd,
    runDir: init.runDir,
    topLevelMode: init.topLevelMode,
    allowedDirtyPaths: [...init.allowedDirtyPaths],
    agentConfig: init.agentConfig,
    consultantAttemptCount: 0,
    autoSquashOnCompletion: init.autoSquashOnCompletion ?? true,
    progressJsonPath: init.progressJsonPath,
    progressMarkdownPath: init.progressMarkdownPath,
    recoveryMarkdownPath: init.recoveryMarkdownPath,
    phase: init.topLevelMode === 'plan' ? 'coder_plan' : 'coder_scope',
    createdAt: now,
    updatedAt: now,
    reviewMarkdownPath: init.reviewMarkdownPath,
    archivedReviewPath: null,
    initialBaseCommit: baseCommit,
    baseCommit,
    finalCommit: null,
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    reviewerSessionHandle: null,
    executionShape,
    authoredExecutionShape,
    currentScopeNumber: 1,
    coderRetryCount: 0,
    lastScopeMarker: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    manualGate: null,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCount: 0,
    finalCompletionContinueExecutionCapReached: false,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    splitPlanCountForCurrentScope: 0,
    derivedPlanDepth: 0,
    maxDerivedPlanReviewRounds: 5,
    rounds: [],
    recentBlocks: [],
    findings: [],
    createdCommits: [],
    completedScopes: [],
    maxRounds: init.maxRounds,
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    pendingPlanReviewGuidance: null,
    // Current-negotiation plan-review debt always starts empty; it is a
    // projection of the current findings recomputed as review rounds run.
    planReviewDebt: [],
    // Durable inherited plan-review debt is seeded once from the queue handoff
    // (execution stage) and never recomputed; default empty for every other run.
    inheritedPlanReviewDebt: [...(init.inheritedPlanReviewDebt ?? [])],
    // A fresh run starts running, so the blocked-reason invariant requires null.
    blockerReason: null,
    status: 'running',
  };
}

export async function saveState(path: string, state: OrchestrationState): Promise<OrchestrationState> {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
  };

  const runStatePath = getRunStatePath(nextState.runDir);
  if (!(await samePath(path, runStatePath))) {
    throw new Error(`saveState requires the run-local state path: ${runStatePath}; received ${path}`);
  }
  assertValidOrchestrationState(nextState, { source: 'save', path: runStatePath });

  await writeJsonAtomic(runStatePath, nextState);
  await updateRunPointersAfterStateSave(runStatePath, nextState);
  await refreshActiveRunLock({
    cwd: nextState.cwd,
    runId: basename(nextState.runDir),
    runStatePath,
    planDoc: nextState.planDoc,
    topLevelMode: nextState.topLevelMode,
  });

  return nextState;
}

async function samePath(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) {
    return true;
  }

  try {
    if (basename(left) !== basename(right)) {
      return false;
    }
    const leftDir = await realpath(dirname(left));
    const rightDir = await realpath(dirname(right));
    return leftDir === rightDir;
  } catch {
    return false;
  }
}

type StateRecord = Record<string, unknown>;

const EXECUTION_SHAPES = ['one_shot', 'multi_scope', 'multi_scope_unknown'] as const;
const SCOPE_MARKERS = [
  'AUTONOMY_SCOPE_DONE',
  'AUTONOMY_CHUNK_DONE',
  'AUTONOMY_DONE',
  'AUTONOMY_BLOCKED',
  'AUTONOMY_SPLIT_PLAN',
] as const;
const FINAL_COMPLETION_ACTIONS = ['accept_complete', 'continue_execution', 'block_for_operator'] as const;
const REVIEWER_MEANINGFUL_PROGRESS_ACTIONS = ['accept', 'block_for_operator', 'replace_plan', 'advance_parent'] as const;
const REVIEW_FINDING_SOURCES = ['reviewer', 'plan_structure'] as const;
const REVIEW_FINDING_SEVERITIES = ['blocking', 'non_blocking'] as const;
const REVIEW_FINDING_STATUSES = ['open', 'fixed', 'rejected', 'deferred'] as const;
const PLAN_REVIEWER_FINDING_CLASSES = ['plan_correctness', 'verification_hardening'] as const;
const MANUAL_GATE_CHECK_TYPES = ['command'] as const;
const MANUAL_GATE_CHECK_CWDS = ['repo', 'run_dir'] as const;
const MANUAL_GATE_RESUME_PHASES = ['coder_scope'] as const;
const INTERACTIVE_BLOCKED_RECOVERY_ACTIONS = [
  'resume_current_scope',
  'replace_current_scope',
  'stay_blocked',
  'terminal_block',
] as const;
const RESIDUAL_REVIEW_DEBT_STATUSES = ['open', 'deferred'] as const;
const CODER_SESSION_PROTOCOLS = ['legacy_marker_v1', 'structured_json_v1'] as const;
const PLANNER_SESSION_PHASES = new Set<OrchestrationPhase>([
  'coder_plan',
  'reviewer_plan',
  'coder_plan_response',
  'coder_plan_optional_response',
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTopLevelMode(value: unknown): value is TopLevelMode {
  return typeof value === 'string' && TOP_LEVEL_MODES.has(value as TopLevelMode);
}

function formatStateValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function throwInvalidState(fieldPath: string, reason: string): never {
  throw new Error(`Invalid run state: invalid ${fieldPath}: ${reason}`);
}

function isStateRecord(value: unknown): value is StateRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, fieldPath: string): StateRecord {
  if (!isStateRecord(value)) {
    throwInvalidState(fieldPath, `expected object, received ${formatStateValue(value)}`);
  }
  return value;
}

function hasOwn(record: StateRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readRequired(record: StateRecord, key: string, fieldPath = key): unknown {
  if (!hasOwn(record, key)) {
    throwInvalidState(fieldPath, 'missing required field');
  }
  return record[key];
}

function readString(record: StateRecord, key: string, fieldPath = key): string {
  const value = readRequired(record, key, fieldPath);
  if (typeof value !== 'string') {
    throwInvalidState(fieldPath, `expected string, received ${formatStateValue(value)}`);
  }
  return value;
}

function readNullableString(record: StateRecord, key: string, fieldPath = key): string | null {
  const value = readRequired(record, key, fieldPath);
  if (value === null || typeof value === 'string') {
    return value;
  }
  throwInvalidState(fieldPath, `expected string or null, received ${formatStateValue(value)}`);
}

function readOptionalString(record: StateRecord, key: string, fieldPath = key): string | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === 'string') {
    return value;
  }
  throwInvalidState(fieldPath, `expected string, received ${formatStateValue(value)}`);
}

function readOptionalBoolean(record: StateRecord, key: string, fieldPath = key): boolean | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === 'boolean') {
    return value;
  }
  throwInvalidState(fieldPath, `expected boolean, received ${formatStateValue(value)}`);
}

function readOptionalNullableString(record: StateRecord, key: string, fieldPath = key): string | null | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (value === null || typeof value === 'string') {
    return value;
  }
  throwInvalidState(fieldPath, `expected string or null, received ${formatStateValue(value)}`);
}

function hydrateCoderSessionProtocol(state: StateRecord, coderSessionHandle: string | null): CoderSessionProtocol | null {
  const value = readOptionalNullableString(state, 'coderSessionProtocol');
  if (value === undefined) {
    return coderSessionHandle ? 'legacy_marker_v1' : null;
  }
  if (value === null) {
    return null;
  }
  if ((CODER_SESSION_PROTOCOLS as readonly string[]).includes(value)) {
    return value as CoderSessionProtocol;
  }
  throwInvalidState(
    'coderSessionProtocol',
    `expected one of "legacy_marker_v1", "structured_json_v1", or null, received ${formatStateValue(value)}`,
  );
}

function hydrateOptionalCoderSessionProtocol(
  state: StateRecord,
  key: string,
  fieldPath = key,
): CoderSessionProtocol | null {
  const value = readOptionalNullableString(state, key, fieldPath);
  if (value === undefined || value === null) {
    return null;
  }
  if ((CODER_SESSION_PROTOCOLS as readonly string[]).includes(value)) {
    return value as CoderSessionProtocol;
  }
  throwInvalidState(
    fieldPath,
    `expected one of "legacy_marker_v1", "structured_json_v1", or null, received ${formatStateValue(value)}`,
  );
}

function readBoolean(record: StateRecord, key: string, fieldPath = key): boolean {
  const value = readRequired(record, key, fieldPath);
  if (typeof value !== 'boolean') {
    throwInvalidState(fieldPath, `expected boolean, received ${formatStateValue(value)}`);
  }
  return value;
}

function readSafeInteger(record: StateRecord, key: string, fieldPath = key): number {
  const value = readRequired(record, key, fieldPath);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throwInvalidState(fieldPath, `expected safe integer, received ${formatStateValue(value)}`);
  }
  return value;
}

function readNullableSafeInteger(record: StateRecord, key: string, fieldPath = key): number | null {
  const value = readRequired(record, key, fieldPath);
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throwInvalidState(fieldPath, `expected safe integer or null, received ${formatStateValue(value)}`);
}

function readOptionalNullableSafeInteger(
  record: StateRecord,
  key: string,
  fieldPath = key,
): number | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throwInvalidState(fieldPath, `expected safe integer or null, received ${formatStateValue(value)}`);
}

function readStringArray(record: StateRecord, key: string, fieldPath = key): string[] {
  const value = readRequired(record, key, fieldPath);
  if (!isStringArray(value)) {
    throwInvalidState(fieldPath, `expected string array, received ${formatStateValue(value)}`);
  }
  return value;
}

function readOptionalStringArray(record: StateRecord, key: string, fieldPath = key): string[] | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (!isStringArray(value)) {
    throwInvalidState(fieldPath, `expected string array, received ${formatStateValue(value)}`);
  }
  return value;
}

function readArray(record: StateRecord, key: string, fieldPath = key): unknown[] {
  const value = readRequired(record, key, fieldPath);
  if (!Array.isArray(value)) {
    throwInvalidState(fieldPath, `expected array, received ${formatStateValue(value)}`);
  }
  return value;
}

function readRecord(record: StateRecord, key: string, fieldPath = key): StateRecord {
  return requireRecord(readRequired(record, key, fieldPath), fieldPath);
}

function readOptionalNullableRecord(
  record: StateRecord,
  key: string,
  fieldPath = key,
): StateRecord | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  return requireRecord(value, fieldPath);
}

function readEnum<T extends string>(
  record: StateRecord,
  key: string,
  values: readonly T[],
  fieldPath = key,
): T {
  const value = readRequired(record, key, fieldPath);
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  throwInvalidState(
    fieldPath,
    `expected one of ${values.map((item) => JSON.stringify(item)).join(', ')}, received ${formatStateValue(value)}`,
  );
}

function readNullableEnum<T extends string>(
  record: StateRecord,
  key: string,
  values: readonly T[],
  fieldPath = key,
): T | null {
  const value = readRequired(record, key, fieldPath);
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  throwInvalidState(
    fieldPath,
    `expected one of ${values.map((item) => JSON.stringify(item)).join(', ')} or null, received ${formatStateValue(value)}`,
  );
}

function readOptionalEnum<T extends string>(
  record: StateRecord,
  key: string,
  values: readonly T[],
  fieldPath = key,
): T | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  throwInvalidState(
    fieldPath,
    `expected one of ${values.map((item) => JSON.stringify(item)).join(', ')}, received ${formatStateValue(value)}`,
  );
}

function readOptionalNullableEnum<T extends string>(
  record: StateRecord,
  key: string,
  values: readonly T[],
  fieldPath = key,
): T | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  throwInvalidState(
    fieldPath,
    `expected one of ${values.map((item) => JSON.stringify(item)).join(', ')} or null, received ${formatStateValue(value)}`,
  );
}

function readOptionalSafeInteger(record: StateRecord, key: string, fieldPath = key): number | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  throwInvalidState(fieldPath, `expected safe integer, received ${formatStateValue(value)}`);
}

function hydrateOrchestrationPhase(value: unknown, fieldPath: string): OrchestrationPhase {
  assertOrchestrationPhase(value, fieldPath);
  return value;
}

function readOrchestrationPhase(record: StateRecord, key: string, fieldPath = key): OrchestrationPhase {
  return hydrateOrchestrationPhase(readRequired(record, key, fieldPath), fieldPath);
}

function readNullableOrchestrationPhase(record: StateRecord, key: string, fieldPath = key): OrchestrationPhase | null {
  const value = readRequired(record, key, fieldPath);
  if (value === null) {
    return null;
  }
  return hydrateOrchestrationPhase(value, fieldPath);
}

function hydrateAgentConfig(value: unknown, fieldPath = 'agentConfig'): AgentConfig {
  const config = requireRecord(value, fieldPath);

  function hydrateRoleConfig(key: 'planner' | 'coder' | 'reviewer', fallback?: AgentConfig['coder']): AgentConfig[typeof key] {
    const rolePath = `${fieldPath}.${key}`;
    const role = fallback && !(key in config)
      ? fallback
      : readRecord(config, key, rolePath);
    const provider = readString(role, 'provider', `${rolePath}.provider`);
    if (!isRegisteredProviderId(provider)) {
      throwInvalidState(
        `${rolePath}.provider`,
        `unsupported provider ${JSON.stringify(provider)}; registered providers: ${formatRegisteredProviderIds()}`,
      );
    }
    return {
      provider,
      model: readNullableString(role, 'model', `${rolePath}.model`),
      effort: readOptionalNullableString(role, 'effort', `${rolePath}.effort`) ?? null,
    };
  }

  const coder = hydrateRoleConfig('coder');
  return {
    planner: hydrateRoleConfig('planner', coder),
    coder,
    reviewer: hydrateRoleConfig('reviewer'),
  };
}

function hydrateExecuteScopeProgressJustification(
  value: unknown,
  fieldPath = 'currentScopeProgressJustification',
): ExecuteScopeProgressJustification | null {
  if (value === null) {
    return null;
  }
  const justification = requireRecord(value, fieldPath);

  return {
    milestoneTargeted: readString(justification, 'milestoneTargeted', `${fieldPath}.milestoneTargeted`),
    newEvidence: readString(justification, 'newEvidence', `${fieldPath}.newEvidence`),
    whyNotRedundant: readString(justification, 'whyNotRedundant', `${fieldPath}.whyNotRedundant`),
    nextStepUnlocked: readString(justification, 'nextStepUnlocked', `${fieldPath}.nextStepUnlocked`),
  };
}

function hydrateReviewerMeaningfulProgressVerdict(
  value: unknown,
  fieldPath = 'currentScopeMeaningfulProgressVerdict',
): ReviewerMeaningfulProgressVerdict | null {
  if (value === null) {
    return null;
  }
  const verdict = requireRecord(value, fieldPath);
  return {
    action: readEnum(verdict, 'action', REVIEWER_MEANINGFUL_PROGRESS_ACTIONS, `${fieldPath}.action`),
    rationale: readString(verdict, 'rationale', `${fieldPath}.rationale`),
  };
}

function hydrateManualGateResumeCheck(value: unknown, fieldPath: string): ManualGateResumeCheck {
  const check = requireRecord(value, fieldPath);
  return {
    type: readEnum(check, 'type', MANUAL_GATE_CHECK_TYPES, `${fieldPath}.type`),
    name: readString(check, 'name', `${fieldPath}.name`),
    command: readStringArray(check, 'command', `${fieldPath}.command`),
    cwd: readOptionalEnum(check, 'cwd', MANUAL_GATE_CHECK_CWDS, `${fieldPath}.cwd`),
    timeoutMs: readOptionalSafeInteger(check, 'timeoutMs', `${fieldPath}.timeoutMs`),
  };
}

function hydrateManualGateLastFailure(value: unknown, fieldPath: string): ManualGateState['lastFailure'] {
  if (value === null) {
    return null;
  }
  const failure = requireRecord(value, fieldPath);
  return {
    checkName: readString(failure, 'checkName', `${fieldPath}.checkName`),
    exitCode: readNullableSafeInteger(failure, 'exitCode', `${fieldPath}.exitCode`),
    signal: readNullableString(failure, 'signal', `${fieldPath}.signal`),
    stdoutTail: readString(failure, 'stdoutTail', `${fieldPath}.stdoutTail`),
    stderrTail: readString(failure, 'stderrTail', `${fieldPath}.stderrTail`),
  };
}

function hydrateManualGate(record: StateRecord, fieldPath = 'manualGate'): ManualGateState | null {
  if (!hasOwn(record, fieldPath)) {
    return null;
  }
  const value = record[fieldPath];
  if (value === null) {
    return null;
  }
  const gate = requireRecord(value, fieldPath);
  return {
    id: readString(gate, 'id', `${fieldPath}.id`),
    title: readString(gate, 'title', `${fieldPath}.title`),
    reason: readString(gate, 'reason', `${fieldPath}.reason`),
    instructionsPath: readString(gate, 'instructionsPath', `${fieldPath}.instructionsPath`),
    resumeChecks: readArray(gate, 'resumeChecks', `${fieldPath}.resumeChecks`).map((check, index) =>
      hydrateManualGateResumeCheck(check, `${fieldPath}.resumeChecks[${index}]`),
    ),
    resumePhase: readEnum(gate, 'resumePhase', MANUAL_GATE_RESUME_PHASES, `${fieldPath}.resumePhase`),
    createdAt: readString(gate, 'createdAt', `${fieldPath}.createdAt`),
    updatedAt: readString(gate, 'updatedAt', `${fieldPath}.updatedAt`),
    lastCheckedAt: readNullableString(gate, 'lastCheckedAt', `${fieldPath}.lastCheckedAt`),
    lastFailure: hydrateManualGateLastFailure(
      readRequired(gate, 'lastFailure', `${fieldPath}.lastFailure`),
      `${fieldPath}.lastFailure`,
    ),
  };
}

function hydrateFinalCompletionSummary(value: unknown, fieldPath = 'finalCompletionSummary'): FinalCompletionSummary | null {
  if (value === null) {
    return null;
  }
  const summary = requireRecord(value, fieldPath);
  return {
    planGoalSatisfied: readBoolean(summary, 'planGoalSatisfied', `${fieldPath}.planGoalSatisfied`),
    whatChangedOverall: readString(summary, 'whatChangedOverall', `${fieldPath}.whatChangedOverall`),
    verificationSummary: readString(summary, 'verificationSummary', `${fieldPath}.verificationSummary`),
    remainingKnownGaps: readStringArray(summary, 'remainingKnownGaps', `${fieldPath}.remainingKnownGaps`),
  };
}

function hydrateFinalCompletionReviewerVerdict(
  value: unknown,
  fieldPath = 'finalCompletionReviewVerdict',
): FinalCompletionReviewerVerdict | null {
  if (value === null) {
    return null;
  }
  const verdict = requireRecord(value, fieldPath);
  const action = readEnum(verdict, 'action', FINAL_COMPLETION_ACTIONS, `${fieldPath}.action`);
  const squashCommitMessageValue = hasOwn(verdict, 'squashCommitMessage')
    ? readRequired(verdict, 'squashCommitMessage', `${fieldPath}.squashCommitMessage`)
    : null;
  return {
    action,
    summary: readString(verdict, 'summary', `${fieldPath}.summary`),
    rationale: readString(verdict, 'rationale', `${fieldPath}.rationale`),
    missingWork: hydrateFinalCompletionMissingWork(
      readRequired(verdict, 'missingWork', `${fieldPath}.missingWork`),
      `${fieldPath}.missingWork`,
    ),
    squashCommitMessage:
      action === 'accept_complete'
        ? hydrateSquashCommitMessageDraft(squashCommitMessageValue, `${fieldPath}.squashCommitMessage`)
        : null,
  };
}

function hydrateSquashCommitMessageDraft(
  value: unknown,
  fieldPath: string,
): FinalCompletionReviewerVerdict['squashCommitMessage'] {
  if (value === null) {
    return null;
  }

  try {
    return validateReviewerSquashMessageDraft(value, { label: fieldPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throwInvalidState(fieldPath, message);
  }
}

function hydrateFinalCompletionMissingWork(
  value: unknown,
  fieldPath: string,
): FinalCompletionReviewerVerdict['missingWork'] {
  if (value === null) {
    return null;
  }
  const missingWork = requireRecord(value, fieldPath);
  return {
    summary: readString(missingWork, 'summary', `${fieldPath}.summary`),
    requiredOutcome: readString(missingWork, 'requiredOutcome', `${fieldPath}.requiredOutcome`),
    verification: readString(missingWork, 'verification', `${fieldPath}.verification`),
  };
}

function hydrateRecentBlock(value: unknown, fieldPath = 'recentBlocks[]'): RecentBlockRecord {
  const record = requireRecord(value, fieldPath);
  const sourcePhase = readOrchestrationPhase(record, 'sourcePhase', `${fieldPath}.sourcePhase`);
  if (!INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES.has(sourcePhase as InteractiveBlockedRecoveryState['sourcePhase'])) {
    throwInvalidState(
      `${fieldPath}.sourcePhase`,
      `unsupported recent-block source phase ${JSON.stringify(sourcePhase)}`,
    );
  }
  return {
    scopeNumber: readSafeInteger(record, 'scopeNumber', `${fieldPath}.scopeNumber`),
    derivedScopeIndex: readNullableSafeInteger(record, 'derivedScopeIndex', `${fieldPath}.derivedScopeIndex`),
    sourcePhase: sourcePhase as InteractiveBlockedRecoveryState['sourcePhase'],
    normalizedKey: readString(record, 'normalizedKey', `${fieldPath}.normalizedKey`),
    evidenceFingerprint: readString(record, 'evidenceFingerprint', `${fieldPath}.evidenceFingerprint`),
    count: readSafeInteger(record, 'count', `${fieldPath}.count`),
    recordedAt: readString(record, 'recordedAt', `${fieldPath}.recordedAt`),
  };
}

// Tolerant read for the plan-review finding class: an absent key stays
// undefined (execute-review findings and legacy states never set it and must be
// unaffected), a recognized class is kept, and any other present value is
// coerced to the fail-safe plan_correctness rather than throwing like readEnum.
function readTolerantFindingClass(record: StateRecord, key: string): PlanReviewFindingClass | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === 'string' && (PLAN_REVIEWER_FINDING_CLASSES as readonly string[]).includes(value)
    ? (value as PlanReviewFindingClass)
    : 'plan_correctness';
}

function hydrateFinding(value: unknown, fieldPath = 'findings[]'): ReviewFinding {
  const finding = requireRecord(value, fieldPath);
  const evidence = readOptionalNullableString(finding, 'evidence', `${fieldPath}.evidence`);
  const findingClass = readTolerantFindingClass(finding, 'findingClass');
  return {
    id: readString(finding, 'id', `${fieldPath}.id`),
    canonicalId: readString(finding, 'canonicalId', `${fieldPath}.canonicalId`),
    round: readSafeInteger(finding, 'round', `${fieldPath}.round`),
    source: readEnum(finding, 'source', REVIEW_FINDING_SOURCES, `${fieldPath}.source`),
    severity: readEnum(finding, 'severity', REVIEW_FINDING_SEVERITIES, `${fieldPath}.severity`),
    ...(findingClass !== undefined ? { findingClass } : {}),
    files: readStringArray(finding, 'files', `${fieldPath}.files`),
    claim: readString(finding, 'claim', `${fieldPath}.claim`),
    ...(evidence !== undefined ? { evidence } : {}),
    requiredAction: readString(finding, 'requiredAction', `${fieldPath}.requiredAction`),
    status: readEnum(finding, 'status', REVIEW_FINDING_STATUSES, `${fieldPath}.status`),
    roundSummary: readString(finding, 'roundSummary', `${fieldPath}.roundSummary`),
    coderDisposition: readNullableString(finding, 'coderDisposition', `${fieldPath}.coderDisposition`),
    coderCommit: readNullableString(finding, 'coderCommit', `${fieldPath}.coderCommit`),
  };
}

function hydrateInteractiveBlockedRecoveryTurnDisposition(
  value: unknown,
  fieldPath: string,
): InteractiveBlockedRecoveryState['turns'][number]['disposition'] {
  if (value === null) {
    return null;
  }
  const disposition = requireRecord(value, fieldPath);
  return {
    recordedAt: readString(disposition, 'recordedAt', `${fieldPath}.recordedAt`),
    sessionHandle: readNullableString(disposition, 'sessionHandle', `${fieldPath}.sessionHandle`),
    action: readEnum(disposition, 'action', INTERACTIVE_BLOCKED_RECOVERY_ACTIONS, `${fieldPath}.action`),
    summary: readString(disposition, 'summary', `${fieldPath}.summary`),
    rationale: readString(disposition, 'rationale', `${fieldPath}.rationale`),
    blocker: readString(disposition, 'blocker', `${fieldPath}.blocker`),
    replacementPlan: readString(disposition, 'replacementPlan', `${fieldPath}.replacementPlan`),
    laterScopeNumber: readOptionalSafeInteger(disposition, 'laterScopeNumber', `${fieldPath}.laterScopeNumber`) ?? 0,
    laterScopeBody: readOptionalString(disposition, 'laterScopeBody', `${fieldPath}.laterScopeBody`) ?? '',
    resultingPhase: readOrchestrationPhase(disposition, 'resultingPhase', `${fieldPath}.resultingPhase`),
  };
}

function hydrateInteractiveBlockedRecoveryTurn(
  value: unknown,
  fieldPath: string,
): InteractiveBlockedRecoveryState['turns'][number] {
  const turn = requireRecord(value, fieldPath);
  return {
    number: readSafeInteger(turn, 'number', `${fieldPath}.number`),
    recordedAt: readString(turn, 'recordedAt', `${fieldPath}.recordedAt`),
    operatorGuidance: readString(turn, 'operatorGuidance', `${fieldPath}.operatorGuidance`),
    origin: readOptionalNullableEnum(turn, 'origin', INTERACTIVE_BLOCKED_RECOVERY_TURN_ORIGINS, `${fieldPath}.origin`) ?? null,
    disposition: hydrateInteractiveBlockedRecoveryTurnDisposition(
      readRequired(turn, 'disposition', `${fieldPath}.disposition`),
      `${fieldPath}.disposition`,
    ),
  };
}

function hydrateInteractiveBlockedRecoveryDirective(
  value: unknown,
  fieldPath: string,
): InteractiveBlockedRecoveryState['pendingDirective'] {
  if (value === null) {
    return null;
  }
  const directive = requireRecord(value, fieldPath);
  return {
    recordedAt: readString(directive, 'recordedAt', `${fieldPath}.recordedAt`),
    operatorGuidance: readString(directive, 'operatorGuidance', `${fieldPath}.operatorGuidance`),
    terminalOnly: readBoolean(directive, 'terminalOnly', `${fieldPath}.terminalOnly`),
    origin: readOptionalNullableEnum(directive, 'origin', INTERACTIVE_BLOCKED_RECOVERY_TURN_ORIGINS, `${fieldPath}.origin`) ?? null,
  };
}

const CONSULTANT_TRIAGE_CATEGORIES = [
  'misunderstanding',
  'authorization',
  'external_precondition',
  'impossible_task',
] as const;

function hydrateInteractiveBlockedRecoveryConsultantAdvice(
  record: StateRecord,
  fieldPath: string,
): InteractiveBlockedRecoveryState['consultantAdvice'] {
  const advice = readOptionalNullableRecord(record, 'consultantAdvice', `${fieldPath}.consultantAdvice`);
  if (!advice) {
    return undefined;
  }
  return {
    recordedAt: readString(advice, 'recordedAt', `${fieldPath}.consultantAdvice.recordedAt`),
    recoverable: readBoolean(advice, 'recoverable', `${fieldPath}.consultantAdvice.recoverable`),
    triageCategory: readEnum(
      advice,
      'triageCategory',
      CONSULTANT_TRIAGE_CATEGORIES,
      `${fieldPath}.consultantAdvice.triageCategory`,
    ),
    resolutionDirective: readString(advice, 'resolutionDirective', `${fieldPath}.consultantAdvice.resolutionDirective`),
    rationale: readString(advice, 'rationale', `${fieldPath}.consultantAdvice.rationale`),
  };
}

function hydrateInteractiveBlockedRecoveryFields(record: StateRecord, fieldPath: string): InteractiveBlockedRecoveryState {
  const sourcePhase = readOrchestrationPhase(record, 'sourcePhase', `${fieldPath}.sourcePhase`);
  if (!INTERACTIVE_BLOCKED_RECOVERY_SOURCE_PHASES.has(sourcePhase as InteractiveBlockedRecoveryState['sourcePhase'])) {
    throwInvalidState(
      `${fieldPath}.sourcePhase`,
      `unsupported interactive blocked recovery source phase ${JSON.stringify(sourcePhase)}`,
    );
  }

  const advice = hydrateInteractiveBlockedRecoveryConsultantAdvice(record, fieldPath);

  return {
    enteredAt: readString(record, 'enteredAt', `${fieldPath}.enteredAt`),
    sourcePhase: sourcePhase as InteractiveBlockedRecoveryState['sourcePhase'],
    blockedReason: readString(record, 'blockedReason', `${fieldPath}.blockedReason`),
    maxTurns: readSafeInteger(record, 'maxTurns', `${fieldPath}.maxTurns`),
    lastHandledTurn: readSafeInteger(record, 'lastHandledTurn', `${fieldPath}.lastHandledTurn`),
    pendingDirective: hydrateInteractiveBlockedRecoveryDirective(
      readRequired(record, 'pendingDirective', `${fieldPath}.pendingDirective`),
      `${fieldPath}.pendingDirective`,
    ),
    turns: readArray(record, 'turns', `${fieldPath}.turns`).map((turn, index) =>
      hydrateInteractiveBlockedRecoveryTurn(turn, `${fieldPath}.turns[${index}]`),
    ),
    // Only attach the key when persisted advice exists, so a recovery record with
    // no consultant advice round-trips byte-for-byte (no `consultantAdvice:
    // undefined` residue).
    ...(advice ? { consultantAdvice: advice } : {}),
  };
}

function hydrateInteractiveBlockedRecovery(
  value: unknown,
  fieldPath = 'interactiveBlockedRecovery',
): InteractiveBlockedRecoveryState | null {
  if (value === null) {
    return null;
  }
  return hydrateInteractiveBlockedRecoveryFields(requireRecord(value, fieldPath), fieldPath);
}

function hydrateInteractiveBlockedRecoveryRecord(
  value: unknown,
  fieldPath = 'interactiveBlockedRecoveryHistory[]',
): InteractiveBlockedRecoveryRecord {
  const record = requireRecord(value, fieldPath);
  return {
    ...hydrateInteractiveBlockedRecoveryFields(record, fieldPath),
    resolvedAt: readString(record, 'resolvedAt', `${fieldPath}.resolvedAt`),
    resolvedByAction: readEnum(
      record,
      'resolvedByAction',
      INTERACTIVE_BLOCKED_RECOVERY_ACTIONS,
      `${fieldPath}.resolvedByAction`,
    ),
    resultPhase: readOrchestrationPhase(record, 'resultPhase', `${fieldPath}.resultPhase`),
  };
}

function hydratePendingPlanReviewGuidance(
  record: StateRecord,
  fieldPath = 'pendingPlanReviewGuidance',
): PendingPlanReviewGuidance {
  if (!hasOwn(record, fieldPath)) {
    return null;
  }
  const value = record[fieldPath];
  if (value === null) {
    return null;
  }
  const guidance = requireRecord(value, fieldPath);
  return {
    message: readString(guidance, 'message', `${fieldPath}.message`),
    sourcePhase: readEnum(
      guidance,
      'sourcePhase',
      ['reviewer_plan', 'coder_plan_response', 'coder_plan_optional_response'] as const,
      `${fieldPath}.sourcePhase`,
    ),
    recordedAt: readString(guidance, 'recordedAt', `${fieldPath}.recordedAt`),
  };
}

function hydrateRound(value: unknown, fieldPath = 'rounds[]'): ReviewRound {
  const round = requireRecord(value, fieldPath);
  const commitRange = readRecord(round, 'commitRange', `${fieldPath}.commitRange`);
  const openBlockingCanonicalIds = readOptionalStringArray(
    round,
    'openBlockingCanonicalIds',
    `${fieldPath}.openBlockingCanonicalIds`,
  );
  return {
    round: readSafeInteger(round, 'round', `${fieldPath}.round`),
    reviewerSessionHandle: readNullableString(round, 'reviewerSessionHandle', `${fieldPath}.reviewerSessionHandle`),
    reviewedPlanPath: readNullableString(round, 'reviewedPlanPath', `${fieldPath}.reviewedPlanPath`),
    normalizationApplied: readBoolean(round, 'normalizationApplied', `${fieldPath}.normalizationApplied`),
    normalizationOperations: readStringArray(round, 'normalizationOperations', `${fieldPath}.normalizationOperations`),
    normalizationScopeLabelMappings: readArray(
      round,
      'normalizationScopeLabelMappings',
      `${fieldPath}.normalizationScopeLabelMappings`,
    ).map((mapping, index) => {
      const mappingRecord = requireRecord(mapping, `${fieldPath}.normalizationScopeLabelMappings[${index}]`);
      return {
        normalizedScopeNumber: readSafeInteger(
          mappingRecord,
          'normalizedScopeNumber',
          `${fieldPath}.normalizationScopeLabelMappings[${index}].normalizedScopeNumber`,
        ),
        originalScopeLabel: readString(
          mappingRecord,
          'originalScopeLabel',
          `${fieldPath}.normalizationScopeLabelMappings[${index}].originalScopeLabel`,
        ),
      };
    }),
    commitRange: {
      base: readString(commitRange, 'base', `${fieldPath}.commitRange.base`),
      head: readString(commitRange, 'head', `${fieldPath}.commitRange.head`),
    },
    openBlockingCanonicalCount: readSafeInteger(
      round,
      'openBlockingCanonicalCount',
      `${fieldPath}.openBlockingCanonicalCount`,
    ),
    ...(openBlockingCanonicalIds === undefined ? {} : { openBlockingCanonicalIds }),
    findings: readStringArray(round, 'findings', `${fieldPath}.findings`),
  };
}

export function hydrateResidualReviewDebtItem(
  value: unknown,
  fieldPath: string,
): ResidualReviewDebtItem {
  const item = requireRecord(value, fieldPath);
  // findingClass/originRound are declared only for plan-review debt; legacy
  // execute-phase debt carries neither, so both stay optional and undefined when
  // absent. findingClass reuses the tolerant reader (unknown → plan_correctness).
  const findingClass = readTolerantFindingClass(item, 'findingClass');
  const originRound = readOptionalSafeInteger(item, 'originRound', `${fieldPath}.originRound`);
  return {
    id: readString(item, 'id', `${fieldPath}.id`),
    canonicalId: readString(item, 'canonicalId', `${fieldPath}.canonicalId`),
    status: readEnum(item, 'status', RESIDUAL_REVIEW_DEBT_STATUSES, `${fieldPath}.status`),
    files: readStringArray(item, 'files', `${fieldPath}.files`),
    claim: readString(item, 'claim', `${fieldPath}.claim`),
    evidence: readNullableString(item, 'evidence', `${fieldPath}.evidence`),
    requiredAction: readString(item, 'requiredAction', `${fieldPath}.requiredAction`),
    coderDisposition: readNullableString(item, 'coderDisposition', `${fieldPath}.coderDisposition`),
    coderCommit: readNullableString(item, 'coderCommit', `${fieldPath}.coderCommit`),
    ...(findingClass !== undefined ? { findingClass } : {}),
    ...(originRound !== undefined ? { originRound } : {}),
  };
}

function hydrateCompletedScope(
  value: unknown,
  fieldPath = 'completedScopes[]',
): OrchestrationState['completedScopes'][number] {
  const scope = requireRecord(value, fieldPath);
  return {
    number: readString(scope, 'number', `${fieldPath}.number`),
    marker: readEnum(scope, 'marker', SCOPE_MARKERS, `${fieldPath}.marker`),
    result: readEnum(scope, 'result', ['accepted', 'blocked'] as const, `${fieldPath}.result`),
    baseCommit: readNullableString(scope, 'baseCommit', `${fieldPath}.baseCommit`),
    finalCommit: readNullableString(scope, 'finalCommit', `${fieldPath}.finalCommit`),
    summary: readNullableString(scope, 'summary', `${fieldPath}.summary`),
    commitSubject: readNullableString(scope, 'commitSubject', `${fieldPath}.commitSubject`),
    changedFiles: readStringArray(scope, 'changedFiles', `${fieldPath}.changedFiles`),
    reviewRounds: readSafeInteger(scope, 'reviewRounds', `${fieldPath}.reviewRounds`),
    findings: readSafeInteger(scope, 'findings', `${fieldPath}.findings`),
    residualReviewDebt: readArray(scope, 'residualReviewDebt', `${fieldPath}.residualReviewDebt`).map((item, index) =>
      hydrateResidualReviewDebtItem(item, `${fieldPath}.residualReviewDebt[${index}]`),
    ),
    archivedReviewPath: readNullableString(scope, 'archivedReviewPath', `${fieldPath}.archivedReviewPath`),
    blocker: readNullableString(scope, 'blocker', `${fieldPath}.blocker`),
    derivedFromParentScope: readNullableString(scope, 'derivedFromParentScope', `${fieldPath}.derivedFromParentScope`),
    replacedByDerivedPlanPath: readNullableString(
      scope,
      'replacedByDerivedPlanPath',
      `${fieldPath}.replacedByDerivedPlanPath`,
    ),
  };
}

function isLegacyPlannerSessionState(args: {
  phase: OrchestrationPhase;
  blockedFromPhase: OrchestrationPhase | null;
  topLevelMode: TopLevelMode;
}) {
  if (args.topLevelMode !== 'plan') {
    return false;
  }
  return (
    PLANNER_SESSION_PHASES.has(args.phase) ||
    (args.blockedFromPhase !== null && PLANNER_SESSION_PHASES.has(args.blockedFromPhase))
  );
}

function normalizeStateV1(parsed: unknown): OrchestrationState {
  const state = requireRecord(parsed, 'state');
  const version = readRequired(state, 'version');
  if (version !== 1) {
    throw new Error(`Invalid run state version: ${String(version)}`);
  }

  const topLevelMode = readRequired(state, 'topLevelMode');
  if (!isTopLevelMode(topLevelMode)) {
    throwInvalidState(
      'topLevelMode',
      `expected one of "plan", "execute", received ${formatStateValue(topLevelMode)}`,
    );
  }

  assertOrchestrationStatus(readRequired(state, 'status'), 'status');
  const phase = readOrchestrationPhase(state, 'phase');
  const blockedFromPhase = readNullableOrchestrationPhase(state, 'blockedFromPhase');
  const hasPersistedPlannerSessionHandle = hasOwn(state, 'plannerSessionHandle');
  const hasPersistedPlannerSessionProtocol = hasOwn(state, 'plannerSessionProtocol');
  const persistedPlannerSessionHandle = readOptionalNullableString(state, 'plannerSessionHandle') ?? null;
  const persistedPlannerSessionProtocol = hydrateOptionalCoderSessionProtocol(state, 'plannerSessionProtocol');
  const coderSessionHandle = readNullableString(state, 'coderSessionHandle');
  const coderSessionProtocol = hydrateCoderSessionProtocol(state, coderSessionHandle);
  const migrateLegacyPlannerSession =
    !hasPersistedPlannerSessionHandle &&
    !hasPersistedPlannerSessionProtocol &&
    coderSessionHandle !== null &&
    isLegacyPlannerSessionState({ phase, blockedFromPhase, topLevelMode });
  const plannerSessionHandle = migrateLegacyPlannerSession ? coderSessionHandle : persistedPlannerSessionHandle;
  const plannerSessionProtocol = migrateLegacyPlannerSession ? coderSessionProtocol : persistedPlannerSessionProtocol;

  return {
    version: 1,
    planDoc: readString(state, 'planDoc'),
    planDocBackupPath: readNullableString(state, 'planDocBackupPath'),
    cwd: readString(state, 'cwd'),
    runDir: readString(state, 'runDir'),
    topLevelMode,
    allowedDirtyPaths: readStringArray(state, 'allowedDirtyPaths'),
    agentConfig: hydrateAgentConfig(readRequired(state, 'agentConfig'), 'agentConfig'),
    consultantAttemptCount: readOptionalSafeInteger(state, 'consultantAttemptCount') ?? 0,
    // Legacy-tolerant: states persisted before this field existed hydrate to
    // true, preserving the historical always-squash behavior on resume.
    autoSquashOnCompletion: readOptionalBoolean(state, 'autoSquashOnCompletion') ?? true,
    progressJsonPath: readString(state, 'progressJsonPath'),
    progressMarkdownPath: readString(state, 'progressMarkdownPath'),
    recoveryMarkdownPath: readString(state, 'recoveryMarkdownPath'),
    phase,
    createdAt: readString(state, 'createdAt'),
    updatedAt: readString(state, 'updatedAt'),
    reviewMarkdownPath: readString(state, 'reviewMarkdownPath'),
    archivedReviewPath: readNullableString(state, 'archivedReviewPath'),
    initialBaseCommit: readNullableString(state, 'initialBaseCommit'),
    baseCommit: readNullableString(state, 'baseCommit'),
    finalCommit: readNullableString(state, 'finalCommit'),
    plannerSessionHandle,
    plannerSessionProtocol,
    coderSessionHandle: migrateLegacyPlannerSession ? null : coderSessionHandle,
    coderSessionProtocol: migrateLegacyPlannerSession ? null : coderSessionProtocol,
    reviewerSessionHandle: readNullableString(state, 'reviewerSessionHandle'),
    executionShape: readNullableEnum(state, 'executionShape', EXECUTION_SHAPES),
    // Legacy-tolerant: states persisted before this field existed default to null.
    authoredExecutionShape: readOptionalNullableEnum(state, 'authoredExecutionShape', EXECUTION_SHAPES),
    currentScopeNumber: readSafeInteger(state, 'currentScopeNumber'),
    coderRetryCount: readSafeInteger(state, 'coderRetryCount'),
    lastScopeMarker: readNullableEnum(state, 'lastScopeMarker', SCOPE_MARKERS),
    currentScopeProgressJustification: hydrateExecuteScopeProgressJustification(
      readRequired(state, 'currentScopeProgressJustification'),
    ),
    currentScopeMeaningfulProgressVerdict: hydrateReviewerMeaningfulProgressVerdict(
      readRequired(state, 'currentScopeMeaningfulProgressVerdict'),
    ),
    manualGate: hydrateManualGate(state),
    finalCompletionSummary: hydrateFinalCompletionSummary(readRequired(state, 'finalCompletionSummary')),
    finalCompletionReviewVerdict: hydrateFinalCompletionReviewerVerdict(
      readRequired(state, 'finalCompletionReviewVerdict'),
    ),
    finalCompletionResolvedAction: readNullableEnum(
      state,
      'finalCompletionResolvedAction',
      FINAL_COMPLETION_ACTIONS,
    ),
    finalCompletionContinueExecutionCount: readSafeInteger(state, 'finalCompletionContinueExecutionCount'),
    finalCompletionContinueExecutionCapReached: readBoolean(state, 'finalCompletionContinueExecutionCapReached'),
    derivedPlanPath: readNullableString(state, 'derivedPlanPath'),
    derivedFromScopeNumber: readNullableSafeInteger(state, 'derivedFromScopeNumber'),
    derivedPlanStatus: readNullableEnum(
      state,
      'derivedPlanStatus',
      ['pending_review', 'accepted', 'rejected'] as const,
    ),
    derivedScopeIndex: readNullableSafeInteger(state, 'derivedScopeIndex'),
    splitPlanStartedNotified: readBoolean(state, 'splitPlanStartedNotified'),
    derivedPlanAcceptedNotified: readBoolean(state, 'derivedPlanAcceptedNotified'),
    splitPlanBlockedNotified: readBoolean(state, 'splitPlanBlockedNotified'),
    splitPlanCountForCurrentScope: readSafeInteger(state, 'splitPlanCountForCurrentScope'),
    derivedPlanDepth: readSafeInteger(state, 'derivedPlanDepth'),
    maxDerivedPlanReviewRounds: readSafeInteger(state, 'maxDerivedPlanReviewRounds'),
    rounds: readArray(state, 'rounds').map((round, index) => hydrateRound(round, `rounds[${index}]`)),
    recentBlocks: hasOwn(state, 'recentBlocks')
      ? readArray(state, 'recentBlocks').map((record, index) => hydrateRecentBlock(record, `recentBlocks[${index}]`))
      : [],
    findings: readArray(state, 'findings').map((finding, index) => hydrateFinding(finding, `findings[${index}]`)),
    createdCommits: readStringArray(state, 'createdCommits'),
    completedScopes: readArray(state, 'completedScopes').map((scope, index) =>
      hydrateCompletedScope(scope, `completedScopes[${index}]`),
    ),
    maxRounds: readSafeInteger(state, 'maxRounds'),
    blockedFromPhase,
    interactiveBlockedRecovery: hydrateInteractiveBlockedRecovery(readRequired(state, 'interactiveBlockedRecovery')),
    interactiveBlockedRecoveryHistory: readArray(state, 'interactiveBlockedRecoveryHistory').map((record, index) =>
      hydrateInteractiveBlockedRecoveryRecord(record, `interactiveBlockedRecoveryHistory[${index}]`),
    ),
    pendingPlanReviewGuidance: hydratePendingPlanReviewGuidance(state),
    // Both plan-review debt arrays are legacy-tolerant: run states persisted
    // before these fields existed hydrate to an empty array.
    planReviewDebt: hydratePlanReviewDebtArray(state, 'planReviewDebt'),
    inheritedPlanReviewDebt: hydratePlanReviewDebtArray(state, 'inheritedPlanReviewDebt'),
    // Legacy-tolerant: run states persisted before this field existed hydrate to
    // null. The blocked-reason invariant is enforced in assertValidOrchestrationState.
    blockerReason: readOptionalNullableString(state, 'blockerReason') ?? null,
    status: readEnum(state, 'status', ['running', 'paused', 'done', 'blocked', 'failed'] as const),
  };
}

function hydratePlanReviewDebtArray(state: StateRecord, key: string): ResidualReviewDebtItem[] {
  if (!hasOwn(state, key)) {
    return [];
  }
  return readArray(state, key).map((item, index) => hydrateResidualReviewDebtItem(item, `${key}[${index}]`));
}

export async function loadState(path: string): Promise<OrchestrationState> {
  const content = await readFile(path, 'utf8');
  const parsed = JSON.parse(content);
  const state = normalizeStateV1(parsed);
  assertValidOrchestrationState(state, { source: 'load', path });
  return state;
}
