export const SUPPORTED_NEAL_ACTION_TYPES = [
  'inspect_artifact',
  'start_plan_refinement',
  'start_execution',
  'pause_after_scope',
  'recover',
  'resume',
  'squash',
] as const;

export type NealSuggestedActionType = (typeof SUPPORTED_NEAL_ACTION_TYPES)[number];

export type NealArtifactCitation = {
  label: string;
  kind: 'state' | 'run_artifact' | 'plan' | 'guidance' | 'git';
};

export type NealActionTarget = {
  runDirName?: string;
  statePath?: string;
  planPath?: string;
  artifactLabel?: string;
};

export type SuggestedNealAction = {
  type: NealSuggestedActionType;
  label: string;
  target: NealActionTarget;
  rationale?: string;
};

export type NealContextTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type NealContextArtifact = NealArtifactCitation & {
  content: string;
  byteLength: number;
  truncated: boolean;
  omitted: boolean;
  omissionReason: string | null;
};

export type NealContextPack = {
  version: 1;
  createdAt: string;
  cwd: string;
  state: {
    statePath: string;
    statePathSource: 'explicit' | 'current_pointer';
    runDir: string;
    runDirName: string;
    planDoc: string;
    topLevelMode: 'plan' | 'execute';
    executionShape: 'one_shot' | 'multi_scope' | 'multi_scope_unknown' | null;
    phase: string;
    status: string;
    effectiveStatus: string;
    waitingForOperatorGuidance: boolean;
    pendingOperatorGuidance: boolean;
    currentScopeNumber: number;
    blockedFromPhase: string | null;
    lastBlockedReason: string | null;
    interactiveBlockedRecovery: {
      sourcePhase: string;
      blockedReason: string;
      turns: number;
      lastHandledTurn: number;
      pendingDirective: string | null;
      acceptsFreeFormResumeMessage: boolean;
    } | null;
    acceptedResumeMessageShapes: string[];
    latestInteractiveBlockedRecoveryHistory: {
      resolvedByAction: string;
      resultPhase: string;
      blockedReason: string;
      turns: number;
    } | null;
    nextAction: string;
    updatedAt: string;
  } | null;
  artifacts: NealContextArtifact[];
  citations: NealArtifactCitation[];
  suggestedActions: SuggestedNealAction[];
  limits: {
    perArtifactByteLimit: number;
    totalByteLimit: number;
    totalArtifactBytes: number;
    truncatedArtifactCount: number;
    omittedArtifactCount: number;
  };
  warnings: string[];
};

export type NealContextTurnValidationResult =
  | { ok: true; turns: NealContextTurn[] }
  | { ok: false; message: string };

export function isSupportedNealActionType(value: string): value is NealSuggestedActionType {
  return SUPPORTED_NEAL_ACTION_TYPES.includes(value as NealSuggestedActionType);
}

const RUN_SCOPED_ACTION_TYPES = new Set<NealSuggestedActionType>([
  'inspect_artifact',
  'pause_after_scope',
  'recover',
  'resume',
  'squash',
]);
const PLAN_SCOPED_ACTION_TYPES = new Set<NealSuggestedActionType>([
  'start_plan_refinement',
  'start_execution',
]);
const IMPLICIT_RUN_TARGETS = new Set(['latest', 'current']);
const TARGET_STRING_FIELDS = ['runDirName', 'statePath', 'planPath', 'artifactLabel'] as const;
const ACTION_FIELDS = ['type', 'label', 'target', 'rationale'] as const;

export function validateSuggestedNealAction(value: unknown): SuggestedNealAction {
  if (!value || typeof value !== 'object') {
    throw new Error('suggestion must be an object');
  }
  if (containsForbiddenCommandKey(value)) {
    throw new Error('forbidden command payload');
  }

  for (const key of Object.keys(value)) {
    if (!ACTION_FIELDS.includes(key as (typeof ACTION_FIELDS)[number])) {
      throw new Error(`unsupported action field "${key}"`);
    }
  }

  const action = value as Partial<SuggestedNealAction>;
  if (
    typeof action.type !== 'string' ||
    !isSupportedNealActionType(action.type) ||
    typeof action.label !== 'string' ||
    action.label.trim() === '' ||
    !action.target ||
    typeof action.target !== 'object'
  ) {
    throw new Error('invalid action shape');
  }
  const target = validateNealActionTarget(action.type, action.target);

  return {
    type: action.type,
    label: action.label.trim(),
    target,
    ...(typeof action.rationale === 'string' && action.rationale.trim() ? { rationale: action.rationale.trim() } : {}),
  };
}

function validateNealActionTarget(type: NealSuggestedActionType, value: unknown): NealActionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('target must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TARGET_STRING_FIELDS.includes(key as (typeof TARGET_STRING_FIELDS)[number])) {
      throw new Error(`unsupported target field "${key}"`);
    }
  }

  const target: NealActionTarget = {};
  for (const key of TARGET_STRING_FIELDS) {
    const rawValue = record[key];
    if (rawValue === undefined) {
      continue;
    }
    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
      throw new Error(`target.${key} must be a non-empty string`);
    }
    target[key] = rawValue.trim() as never;
  }

  if (target.runDirName) {
    validateRunDirName(target.runDirName);
  }
  if (target.statePath) {
    validateStatePath(target.statePath);
  }

  if (RUN_SCOPED_ACTION_TYPES.has(type) && !target.runDirName && !target.statePath) {
    throw new Error('run-scoped action target must include runDirName or exact statePath');
  }
  if (PLAN_SCOPED_ACTION_TYPES.has(type) && !target.planPath) {
    throw new Error('plan-scoped action target must include planPath');
  }
  if (type === 'inspect_artifact' && !target.artifactLabel) {
    throw new Error('inspect_artifact target must include artifactLabel');
  }

  return target;
}

function validateRunDirName(runDirName: string) {
  const normalized = runDirName.trim().toLowerCase();
  if (IMPLICIT_RUN_TARGETS.has(normalized) || runDirName.includes('/') || runDirName.includes('\\') || runDirName.includes('..')) {
    throw new Error('runDirName must name an explicit run directory');
  }
}

function validateStatePath(statePath: string) {
  const normalized = statePath.trim().replace(/\\/g, '/').toLowerCase();
  if (IMPLICIT_RUN_TARGETS.has(normalized)) {
    throw new Error('statePath must not target an implicit run pointer');
  }
  if (!normalized.endsWith('/run_state.json') && normalized !== 'run_state.json') {
    throw new Error('statePath must target an exact RUN_STATE.json');
  }
}

function containsForbiddenCommandKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Object.hasOwn(value, 'command')) {
    return true;
  }

  return Object.values(value).some((child) => containsForbiddenCommandKey(child));
}
