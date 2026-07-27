import { readFile, stat } from 'node:fs/promises';

import { validatePlanDocument } from './plan-validation.js';
import { getDerivedPlanIdentityView, type DerivedPlanIdentityFields } from './state-views.js';
import type {
  ExecutionShape,
  OrchestrationState,
  ProgressScope,
  ReviewFinding,
  ReviewerMeaningfulProgressAction,
  ScopeAccountingSummary,
} from './types.js';

export const DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW = 5;
const EXECUTION_PLAN_SCOPE_DESCRIPTOR_CACHE_LIMIT = 32;
const SCOPE_HEADING_TITLE_PATTERN = /^### Scope (\d+):(.*)$/gm;

export type ExecutionPlanScopeCount =
  | { kind: 'known'; total: number }
  | { kind: 'unknown_by_contract' }
  | { kind: 'unavailable' };

export type ExecutionPlanScopeDescriptor = {
  planPath: string;
  scopeLabel: string;
  planScopeNumber: number;
  scopeCount: ExecutionPlanScopeCount;
  title: string | null;
  display: string;
};

type ExecutionPlanDescriptorData = {
  executionShape: ExecutionShape;
  scopeCount: ExecutionPlanScopeCount;
  scopeTitles: Map<number, string>;
};

type CachedExecutionPlanDescriptorData = {
  mtimeMs: number;
  size: number;
  data: ExecutionPlanDescriptorData | null;
};

const executionPlanDescriptorCache = new Map<string, CachedExecutionPlanDescriptorData>();

export function isExecutingDerivedPlan(state: DerivedPlanIdentityFields) {
  return getDerivedPlanIdentityView(state)?.executing ?? false;
}

export function getParentScopeLabel(
  state: Pick<OrchestrationState, 'currentScopeNumber' | 'derivedFromScopeNumber'>,
) {
  return String(state.derivedFromScopeNumber ?? state.currentScopeNumber);
}

export function getCurrentScopeLabel(
  state: Pick<OrchestrationState, 'currentScopeNumber' | 'derivedFromScopeNumber'> & DerivedPlanIdentityFields,
) {
  const derivedPlan = getDerivedPlanIdentityView(state);
  if (derivedPlan?.executing) {
    return `${getParentScopeLabel(state)}.${derivedPlan.scopeIndex}`;
  }

  return String(state.currentScopeNumber);
}

export function getExecutionPlanPath(
  state: Pick<OrchestrationState, 'planDoc'> & DerivedPlanIdentityFields,
) {
  const derivedPlan = getDerivedPlanIdentityView(state);
  return derivedPlan?.executing ? derivedPlan.path : state.planDoc;
}

export function getCompletedScopeParentObjective(scope: Pick<ProgressScope, 'number' | 'derivedFromParentScope'>) {
  return scope.derivedFromParentScope ?? scope.number;
}

export function shouldAdvanceTopLevelScopeNumber(
  state: Pick<OrchestrationState, 'executionShape'>,
) {
  return state.executionShape !== 'one_shot';
}

export function shouldContinueTopLevelExecutionAfterAcceptedScope(
  state: Pick<OrchestrationState, 'executionShape' | 'lastScopeMarker'>,
) {
  if (state.lastScopeMarker === 'AUTONOMY_DONE' || state.lastScopeMarker === 'AUTONOMY_BLOCKED') {
    return false;
  }

  return shouldAdvanceTopLevelScopeNumber(state);
}

export function getExecutionPlanScopeCountForShape(
  executionShape: ExecutionShape | null,
  options?: { knownTotal?: number | null },
): ExecutionPlanScopeCount {
  if (executionShape === 'one_shot') {
    return { kind: 'known', total: 1 };
  }

  if (executionShape === 'multi_scope_unknown') {
    return { kind: 'unknown_by_contract' };
  }

  if (executionShape === 'multi_scope') {
    const knownTotal = options?.knownTotal ?? null;
    if (typeof knownTotal === 'number' && Number.isFinite(knownTotal) && knownTotal > 0) {
      return { kind: 'known', total: knownTotal };
    }
  }

  return { kind: 'unavailable' };
}

export async function getExecutionPlanScopeCount(planPath: string): Promise<ExecutionPlanScopeCount> {
  const data = await getExecutionPlanDescriptorData(planPath);
  return data?.scopeCount ?? { kind: 'unavailable' };
}

export async function getCurrentExecutionScopeDescriptor(
  state: Pick<OrchestrationState, 'planDoc' | 'executionShape' | 'currentScopeNumber' | 'derivedFromScopeNumber'> &
    DerivedPlanIdentityFields,
): Promise<ExecutionPlanScopeDescriptor> {
  const planPath = getExecutionPlanPath(state);
  const data = await getExecutionPlanDescriptorData(planPath);
  const executionShape = data?.executionShape ?? state.executionShape;
  const scopeLabel = getCurrentScopeLabel(state);
  const planScopeNumber = getCurrentPlanScopeNumber(state, executionShape);
  const scopeCount = data?.scopeCount ?? getExecutionPlanScopeCountForShape(executionShape);
  const title = getExecutionPlanScopeTitle(data, planScopeNumber);

  return {
    planPath,
    scopeLabel,
    planScopeNumber,
    scopeCount,
    title,
    display: formatExecutionPlanScopeDisplay({
      scopeLabel,
      scopeCount,
      title,
      includeScopeCount: Boolean(title) && !isExecutingDerivedPlan(state),
    }),
  };
}

function getCurrentPlanScopeNumber(
  state: Pick<OrchestrationState, 'executionShape' | 'currentScopeNumber'> & DerivedPlanIdentityFields,
  executionShape: ExecutionShape | null,
) {
  const derivedPlan = getDerivedPlanIdentityView(state);
  if (derivedPlan?.executing) {
    return derivedPlan.scopeIndex ?? 1;
  }

  if (executionShape === 'one_shot') {
    return 1;
  }

  return state.currentScopeNumber;
}

function getExecutionPlanScopeTitle(data: ExecutionPlanDescriptorData | null | undefined, planScopeNumber: number) {
  if (!data) {
    return null;
  }

  if (data.executionShape === 'multi_scope_unknown') {
    return 'Recurring Scope';
  }

  return data.scopeTitles.get(planScopeNumber) ?? null;
}

function formatExecutionPlanScopeDisplay(args: {
  scopeLabel: string;
  scopeCount: ExecutionPlanScopeCount;
  title: string | null;
  includeScopeCount: boolean;
}) {
  if (!args.title) {
    return `scope ${args.scopeLabel}`;
  }

  const scopeSuffix =
    args.includeScopeCount && args.scopeCount.kind === 'known' ? `/${args.scopeCount.total}` : '';
  return `scope ${args.scopeLabel}${scopeSuffix}: ${args.title}`;
}

async function getExecutionPlanDescriptorData(planPath: string): Promise<ExecutionPlanDescriptorData | null> {
  try {
    const planStat = await stat(planPath);
    const cached = executionPlanDescriptorCache.get(planPath);
    if (cached && cached.mtimeMs === planStat.mtimeMs && cached.size === planStat.size) {
      return cached.data;
    }

    const planDocument = await readFile(planPath, 'utf8');
    const data = parseExecutionPlanDescriptorData(planDocument);
    cacheExecutionPlanDescriptorData(planPath, {
      mtimeMs: planStat.mtimeMs,
      size: planStat.size,
      data,
    });
    return data;
  } catch {
    return null;
  }
}

function cacheExecutionPlanDescriptorData(planPath: string, data: CachedExecutionPlanDescriptorData) {
  if (executionPlanDescriptorCache.has(planPath)) {
    executionPlanDescriptorCache.delete(planPath);
  }

  executionPlanDescriptorCache.set(planPath, data);
  while (executionPlanDescriptorCache.size > EXECUTION_PLAN_SCOPE_DESCRIPTOR_CACHE_LIMIT) {
    const oldestKey = executionPlanDescriptorCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    executionPlanDescriptorCache.delete(oldestKey);
  }
}

function parseExecutionPlanDescriptorData(planDocument: string): ExecutionPlanDescriptorData | null {
  const validation = validatePlanDocument(planDocument);
  if (!validation.ok) {
    return null;
  }

  const normalizedDocument = validation.normalization.normalizedDocument;
  if (validation.executionShape === 'one_shot') {
    const oneShotTitle =
      parseScopeHeadings(normalizedDocument).titles.get(1) ??
      getFirstLevelOneMarkdownTitle(normalizedDocument) ??
      'single-scope plan';
    return {
      executionShape: validation.executionShape,
      scopeCount: { kind: 'known', total: 1 },
      scopeTitles: new Map([[1, oneShotTitle]]),
    };
  }

  if (validation.executionShape === 'multi_scope_unknown') {
    return {
      executionShape: validation.executionShape,
      scopeCount: { kind: 'unknown_by_contract' },
      scopeTitles: new Map(),
    };
  }

  const scopeHeadings = parseScopeHeadings(normalizedDocument);
  if (scopeHeadings.count === 0) {
    return {
      executionShape: validation.executionShape,
      scopeCount: { kind: 'unavailable' },
      scopeTitles: scopeHeadings.titles,
    };
  }

  return {
    executionShape: validation.executionShape,
    scopeCount: { kind: 'known', total: scopeHeadings.count },
    scopeTitles: scopeHeadings.titles,
  };
}

function parseScopeHeadings(planDocument: string) {
  const titles = new Map<number, string>();
  let count = 0;
  for (const match of planDocument.matchAll(SCOPE_HEADING_TITLE_PATTERN)) {
    const scopeNumber = Number(match[1]);
    const title = match[2]?.trim() ?? '';
    if (Number.isSafeInteger(scopeNumber) && scopeNumber > 0) {
      count += 1;
      if (title !== '') {
        titles.set(scopeNumber, title);
      }
    }
  }
  return { count, titles };
}

function getFirstLevelOneMarkdownTitle(planDocument: string) {
  for (const line of planDocument.split(/\r?\n/)) {
    const match = line.trim().match(/^#\s+(.+)$/);
    const title = match?.[1]?.trim() ?? '';
    if (title !== '') {
      return title;
    }
  }

  return null;
}

export function renderScopeProgressSegments(
  state: Pick<OrchestrationState, 'currentScopeNumber' | 'derivedFromScopeNumber'> & DerivedPlanIdentityFields,
  scopeCount: ExecutionPlanScopeCount,
) {
  const scopeLabel = getCurrentScopeLabel(state);
  const scopeSuffix = scopeCount.kind === 'known' ? `/${scopeCount.total}` : '';
  const scopeSegment = `scope ${scopeLabel}${scopeSuffix}`;
  const derivedPlan = getDerivedPlanIdentityView(state);

  if (!derivedPlan?.executing) {
    return {
      scopeSegment,
      derivedSegment: null,
    };
  }

  const derivedIndex = derivedPlan.scopeIndex ?? 1;
  const derivedSuffix = scopeCount.kind === 'known' ? `/${scopeCount.total}` : '';

  return {
    scopeSegment: `scope ${scopeLabel}`,
    derivedSegment: `derived ${derivedIndex}${derivedSuffix}`,
  };
}

export function renderScopeProgressSummary(
  state: Pick<OrchestrationState, 'currentScopeNumber' | 'derivedFromScopeNumber'> & DerivedPlanIdentityFields,
  scopeCount: ExecutionPlanScopeCount,
) {
  const { scopeSegment, derivedSegment } = renderScopeProgressSegments(state, scopeCount);
  return derivedSegment ? `${scopeSegment} | ${derivedSegment}` : scopeSegment;
}

export function getRecentAcceptedScopesForParentObjective(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
  window = DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW,
) {
  return state.completedScopes
    .filter((scope) => scope.result === 'accepted' && getCompletedScopeParentObjective(scope) === parentScopeLabel)
    .filter((scope) => !(scope.derivedFromParentScope === null && scope.replacedByDerivedPlanPath))
    .slice(-Math.max(window, 0));
}

export type EmptyDerivedParentAdvanceSource = 'explicit' | 'fallback';

export type EmptyDerivedParentAdvanceClassification = {
  eligible: boolean;
  failedPreconditions: string[];
  parentScopeLabel: string;
  currentScopeLabel: string;
  priorSubstantiveCount: number;
  priorEmptyCount: number;
  aggregateChangedFiles: string[];
  source: EmptyDerivedParentAdvanceSource;
  reviewerAction: ReviewerMeaningfulProgressAction;
};

export type AlreadySatisfiedTopLevelScopeAcceptanceClassification = {
  eligible: boolean;
  failedPreconditions: string[];
  scopeLabel: string;
  priorAcceptedScopeLabels: string[];
  reviewerAction: ReviewerMeaningfulProgressAction;
};

type ParentAdvanceState = Pick<
  OrchestrationState,
  | 'topLevelMode'
  | 'executionShape'
  | 'currentScopeNumber'
  | 'derivedFromScopeNumber'
  | 'derivedPlanPath'
  | 'derivedPlanStatus'
  | 'derivedScopeIndex'
  | 'completedScopes'
>;

type AlreadySatisfiedTopLevelScopeAcceptanceState = ParentAdvanceState & Pick<
  OrchestrationState,
  'currentScopeProgressJustification'
>;

export function getAcceptedDerivedScopesForParentObjective(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
) {
  return state.completedScopes.filter(
    (scope) =>
      scope.result === 'accepted' &&
      scope.derivedFromParentScope === parentScopeLabel,
  );
}

export function getAcceptedParentScopeForObjective(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
) {
  return state.completedScopes.find(
    (scope) =>
      scope.result === 'accepted' &&
      scope.number === parentScopeLabel &&
      scope.derivedFromParentScope === null,
  ) ?? null;
}

export function getSubstantiveAcceptedDerivedScopesForParentObjective(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
) {
  return getAcceptedDerivedScopesForParentObjective(state, parentScopeLabel)
    .filter((scope) => scope.changedFiles.length > 0);
}

export function getEmptyAcceptedDerivedScopesForParentObjective(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
) {
  return getAcceptedDerivedScopesForParentObjective(state, parentScopeLabel)
    .filter((scope) => scope.changedFiles.length === 0);
}

export function aggregateChangedFilesForAcceptedDerivedScopes(
  scopes: readonly Pick<ProgressScope, 'changedFiles'>[],
) {
  return [...new Set(scopes.flatMap((scope) => scope.changedFiles))];
}

export function classifyEmptyDerivedParentAdvance(args: {
  state: ParentAdvanceState;
  currentChangedFiles: readonly string[];
  currentReviewerFindings: readonly Pick<ReviewFinding, 'severity'>[];
  mergedFindings: readonly Pick<ReviewFinding, 'status'>[];
  reviewerAction: ReviewerMeaningfulProgressAction;
  reviewerRationale: string;
  source: EmptyDerivedParentAdvanceSource;
}): EmptyDerivedParentAdvanceClassification {
  const parentScopeLabel = getParentScopeLabel(args.state);
  const currentScopeLabel = getCurrentScopeLabel(args.state);
  const substantiveScopes = getSubstantiveAcceptedDerivedScopesForParentObjective(args.state, parentScopeLabel);
  const emptyScopes = getEmptyAcceptedDerivedScopesForParentObjective(args.state, parentScopeLabel);
  const aggregateChangedFiles = aggregateChangedFilesForAcceptedDerivedScopes(substantiveScopes);
  const acceptedParentScope = getAcceptedParentScopeForObjective(args.state, parentScopeLabel);
  const failedPreconditions: string[] = [];
  const derivedPlan = getDerivedPlanIdentityView(args.state);

  if (args.source === 'explicit' && args.reviewerAction !== 'advance_parent') {
    failedPreconditions.push('reviewer action is not advance_parent for explicit parent advancement');
  }

  if (args.source === 'fallback' && args.reviewerAction !== 'block_for_operator') {
    failedPreconditions.push('reviewer action is not block_for_operator for fallback parent advancement');
  }

  if (args.state.topLevelMode !== 'execute') {
    failedPreconditions.push('run is not execute mode');
  }

  if (!derivedPlan?.executing) {
    failedPreconditions.push('accepted derived plan is not actively executing');
  }

  if (args.state.executionShape === 'one_shot') {
    failedPreconditions.push('one-shot execution shape cannot advance a parent objective through this path');
  } else if (args.state.executionShape !== 'multi_scope' && args.state.executionShape !== 'multi_scope_unknown') {
    failedPreconditions.push('execution shape is not multi_scope or multi_scope_unknown');
  }

  if (args.currentChangedFiles.length > 0) {
    failedPreconditions.push(`current scope changed-file list is not empty (${args.currentChangedFiles.length})`);
  }

  if (args.currentReviewerFindings.length > 0) {
    failedPreconditions.push(`current reviewer result has findings (${args.currentReviewerFindings.length})`);
  }

  if (args.mergedFindings.some((finding) => finding.status === 'open')) {
    failedPreconditions.push('merged review findings still contain open findings');
  }

  if (substantiveScopes.length === 0) {
    failedPreconditions.push('parent objective has no prior substantive accepted derived sub-scope');
  }

  if (args.source === 'fallback' && emptyScopes.length < 2) {
    failedPreconditions.push('fallback requires at least two prior empty accepted derived sub-scopes');
  }

  if (acceptedParentScope) {
    failedPreconditions.push(`parent objective ${parentScopeLabel} already has an accepted top-level record`);
  }

  if (args.source === 'explicit' && args.reviewerRationale.trim() === '') {
    failedPreconditions.push('reviewer rationale is empty for explicit parent advancement');
  }

  return {
    eligible: failedPreconditions.length === 0,
    failedPreconditions,
    parentScopeLabel,
    currentScopeLabel,
    priorSubstantiveCount: substantiveScopes.length,
    priorEmptyCount: emptyScopes.length,
    aggregateChangedFiles,
    source: args.source,
    reviewerAction: args.reviewerAction,
  };
}

const EXECUTE_PROGRESS_JUSTIFICATION_FIELDS = [
  'milestoneTargeted',
  'newEvidence',
  'whyNotRedundant',
  'nextStepUnlocked',
] as const;

export function classifyAlreadySatisfiedTopLevelScopeAcceptance(args: {
  state: AlreadySatisfiedTopLevelScopeAcceptanceState;
  currentChangedFiles: readonly string[] | null;
  currentReviewerFindings: readonly Pick<ReviewFinding, 'severity'>[];
  mergedFindings: readonly Pick<ReviewFinding, 'status'>[];
  reviewerAction: ReviewerMeaningfulProgressAction;
  reviewerRationale: string;
}): AlreadySatisfiedTopLevelScopeAcceptanceClassification {
  const scopeLabel = getCurrentScopeLabel(args.state);
  const parentScopeLabel = getParentScopeLabel(args.state);
  const derivedPlan = getDerivedPlanIdentityView(args.state);
  const acceptedParentScope = getAcceptedParentScopeForObjective(args.state, parentScopeLabel);
  const priorAcceptedScopeLabels = args.state.completedScopes
    .filter((scope) => scope.result === 'accepted')
    .filter((scope) => !(scope.number === parentScopeLabel && scope.derivedFromParentScope === null))
    .map((scope) => scope.number);
  const failedPreconditions: string[] = [];

  if (args.reviewerAction !== 'advance_parent') {
    failedPreconditions.push('reviewer action is not advance_parent for top-level already-satisfied acceptance');
  }

  if (args.state.topLevelMode !== 'execute') {
    failedPreconditions.push('run is not execute mode');
  }

  if (scopeLabel !== parentScopeLabel) {
    failedPreconditions.push(`current scope ${scopeLabel} is not top-level parent scope ${parentScopeLabel}`);
  }

  if (derivedPlan?.executing) {
    failedPreconditions.push('accepted derived plan is actively executing');
  }

  if (args.state.executionShape === 'one_shot') {
    failedPreconditions.push('one-shot execution shape cannot use top-level already-satisfied acceptance');
  } else if (args.state.executionShape !== 'multi_scope' && args.state.executionShape !== 'multi_scope_unknown') {
    failedPreconditions.push('execution shape is not multi_scope or multi_scope_unknown');
  }

  if (!args.currentChangedFiles) {
    failedPreconditions.push('current scope changed-file list is unavailable');
  } else if (args.currentChangedFiles.length > 0) {
    failedPreconditions.push(`current scope changed-file list is not empty (${args.currentChangedFiles.length})`);
  }

  if (args.currentReviewerFindings.length > 0) {
    failedPreconditions.push(`current reviewer result has findings (${args.currentReviewerFindings.length})`);
  }

  if (args.mergedFindings.some((finding) => finding.status === 'open')) {
    failedPreconditions.push('merged review findings still contain open findings');
  }

  if (args.reviewerRationale.trim() === '') {
    failedPreconditions.push('reviewer rationale is empty for top-level already-satisfied acceptance');
  }

  const progressJustification = args.state.currentScopeProgressJustification;
  if (!progressJustification) {
    failedPreconditions.push('current scope progress justification is missing');
  } else {
    const emptyProgressFields = EXECUTE_PROGRESS_JUSTIFICATION_FIELDS.filter(
      (field) => progressJustification[field].trim() === '',
    );
    if (emptyProgressFields.length > 0) {
      failedPreconditions.push(`current scope progress justification has empty field(s): ${emptyProgressFields.join(', ')}`);
    }
  }

  if (priorAcceptedScopeLabels.length === 0) {
    failedPreconditions.push('no prior accepted completed scope exists before the current top-level scope');
  }

  if (acceptedParentScope) {
    failedPreconditions.push(`top-level scope ${parentScopeLabel} already has an accepted completed-scope record`);
  }

  return {
    eligible: failedPreconditions.length === 0,
    failedPreconditions,
    scopeLabel,
    priorAcceptedScopeLabels,
    reviewerAction: args.reviewerAction,
  };
}

export function renderRecentAcceptedScopesSummary(
  state: Pick<OrchestrationState, 'completedScopes'>,
  parentScopeLabel: string,
  window = DEFAULT_PARENT_OBJECTIVE_HISTORY_WINDOW,
) {
  const recentScopes = getRecentAcceptedScopesForParentObjective(state, parentScopeLabel, window);
  if (recentScopes.length === 0) {
    return `No accepted scopes have been recorded yet for parent objective ${parentScopeLabel}.`;
  }

  const touchedFileCounts = new Map<string, number>();
  for (const scope of recentScopes) {
    for (const file of scope.changedFiles) {
      touchedFileCounts.set(file, (touchedFileCounts.get(file) ?? 0) + 1);
    }
  }

  const concentrationSummary =
    touchedFileCounts.size === 0
      ? '(no changed files recorded)'
      : [...touchedFileCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([file, touches]) => `${file} (${touches}/${recentScopes.length} scopes)`)
          .join(', ');

  return [
    `Accepted scope history for parent objective ${parentScopeLabel} (oldest to newest, last ${window} max):`,
    ...recentScopes.map((scope) => {
      const changedFiles = scope.changedFiles.length > 0 ? scope.changedFiles.join(', ') : '(no changed files)';
      return [
        `- Scope ${scope.number}`,
        `  commit: ${scope.finalCommit ?? 'pending'}`,
        `  subject: ${scope.commitSubject ?? 'pending'}`,
        `  parentScope: ${scope.derivedFromParentScope ?? 'none'}`,
        `  changedFiles: ${changedFiles}`,
      ].join('\n');
    }),
    `Touched-file concentration: ${concentrationSummary}`,
  ].join('\n');
}

export function buildScopeAccountingSummary(scopes: ProgressScope[]): ScopeAccountingSummary {
  const acceptedScopes = scopes.filter((scope) => scope.result === 'accepted');
  const blockedScopes = scopes.filter((scope) => scope.result === 'blocked');
  const acceptedTopLevelScopes = acceptedScopes.filter((scope) => scope.derivedFromParentScope === null);
  const acceptedDerivedSubScopes = acceptedScopes.filter((scope) => scope.derivedFromParentScope !== null);
  const blockedTopLevelScopes = blockedScopes.filter((scope) => scope.derivedFromParentScope === null);
  const blockedDerivedSubScopes = blockedScopes.filter((scope) => scope.derivedFromParentScope !== null);
  const replacedParentScopes = scopes.flatMap((scope) => {
    if (!scope.replacedByDerivedPlanPath) {
      return [];
    }

    return [
      {
        number: scope.number,
        derivedPlanPath: scope.replacedByDerivedPlanPath,
      },
    ];
  });

  const replacementSummary =
    replacedParentScopes.length === 0
      ? 'no parent scopes were replaced by derived plans'
      : `parent scope replacement(s): ${replacedParentScopes
          .map((scope) => `${scope.number} -> ${scope.derivedPlanPath}`)
          .join('; ')}`;

  return {
    acceptedScopeRecords: acceptedScopes.length,
    acceptedTopLevelScopeRecords: acceptedTopLevelScopes.length,
    acceptedDerivedSubScopeRecords: acceptedDerivedSubScopes.length,
    blockedScopeRecords: blockedScopes.length,
    blockedTopLevelScopeRecords: blockedTopLevelScopes.length,
    blockedDerivedSubScopeRecords: blockedDerivedSubScopes.length,
    replacedParentScopes,
    summary:
      `Accepted scope records: ${acceptedScopes.length} total ` +
      `(${acceptedTopLevelScopes.length} top-level parent/objective record(s), ` +
      `${acceptedDerivedSubScopes.length} derived sub-scope record(s)). ` +
      `Blocked scope records: ${blockedScopes.length} total ` +
      `(${blockedTopLevelScopes.length} top-level, ${blockedDerivedSubScopes.length} derived). ` +
      `Top-level records are the comparable count against the original plan; accepted scope records include derived sub-scopes. ` +
      replacementSummary,
  };
}
