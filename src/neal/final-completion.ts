import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getFinalCompletionContinueExecutionMax } from './config.js';
import {
  getChangedFilesForRange,
  getCommitRange,
  getCommitSubjects,
  getDiffStatForRange,
} from './git.js';
import { toResidualReviewDebt } from './review-debt.js';
import { buildScopeAccountingSummary, getCurrentScopeLabel } from './scopes.js';
import { getDerivedPlanView, getFinalCompletionView } from './state-views.js';
import {
  extractVerificationCommandResults,
  latestCommandResultPerCommand,
  summarizeVerificationCommandResults,
  type RunEvent,
} from './verification-events.js';
import type {
  FinalCompletionAggregateReviewContext,
  FinalCompletionPacket,
  FinalCompletionReferenceScope,
  FinalCompletionTerminalScope,
  OrchestrationState,
  ProgressScope,
  ResidualReviewDebtItem,
  ScopeMarker,
} from './types.js';

function getEventsPath(runDir: string) {
  return join(runDir, 'events.ndjson');
}

function summarizeChangedFiles(files: string[]) {
  if (files.length === 0) {
    return 'none';
  }

  const displayFiles = files.slice(0, 12);
  const lines = displayFiles.map((file) => `- ${file}`);
  if (files.length > displayFiles.length) {
    lines.push(`- ...and ${files.length - displayFiles.length} more`);
  }
  return lines.join('\n');
}

function renderCompletedScopeSummary(scopes: ProgressScope[]) {
  if (scopes.length === 0) {
    return 'No completed scopes recorded.';
  }

  return scopes
    .map((scope) => {
      const changedFiles =
        scope.changedFiles.length > 0
          ? `${scope.changedFiles.length} file(s): ${scope.changedFiles.join(', ')}`
          : 'no changed files';
      const commit = scope.finalCommit ?? 'pending';
      const parent = scope.derivedFromParentScope ? ` | parent ${scope.derivedFromParentScope}` : '';
      const blocker = scope.blocker ? ` | blocker: ${scope.blocker}` : '';
      const residualDebt = scope.residualReviewDebt?.length
        ? ` | residual non-blocking debt: ${scope.residualReviewDebt
            .map((item) => `${item.id} ${item.status}: ${item.claim}`)
            .join('; ')}`
        : '';
      return `- Scope ${scope.number}: ${scope.result} (${scope.marker}) | commit ${commit}${parent} | ${changedFiles}${blocker}${residualDebt}`;
    })
    .join('\n');
}

function uniqueFiles(files: string[]) {
  return [...new Set(files)];
}

function buildTerminalScopeRecord(
  state: OrchestrationState,
  terminalScope: FinalCompletionTerminalScope,
): ProgressScope {
  const marker = (terminalScope.marker ?? state.lastScopeMarker ?? 'AUTONOMY_DONE') as ScopeMarker;
  const derivedPlan = getDerivedPlanView(state);
  return {
    number: getCurrentScopeLabel(state),
    marker,
    result: 'accepted',
    baseCommit: state.baseCommit,
    finalCommit: terminalScope.finalCommit,
    summary: state.currentScopeProgressJustification?.milestoneTargeted ?? null,
    commitSubject: terminalScope.commitSubject,
    changedFiles: [...terminalScope.changedFiles],
    reviewRounds: state.rounds.length,
    findings: state.findings.length,
    residualReviewDebt: toResidualReviewDebt(state.findings),
    archivedReviewPath: terminalScope.archivedReviewPath,
    blocker: null,
    derivedFromParentScope:
      derivedPlan?.parentScopeNumber !== null && derivedPlan?.parentScopeNumber !== undefined
        ? String(derivedPlan.parentScopeNumber)
        : null,
    replacedByDerivedPlanPath: null,
  };
}

function mergeCompletedScopesWithTerminalScope(
  state: OrchestrationState,
  terminalScope: FinalCompletionTerminalScope | null,
) {
  if (!terminalScope) {
    return state.completedScopes;
  }

  const terminalRecord = buildTerminalScopeRecord(state, terminalScope);
  return [
    ...state.completedScopes.filter((scope) => scope.number !== terminalRecord.number),
    terminalRecord,
  ];
}

function toReferenceScope(scope: ProgressScope): FinalCompletionReferenceScope {
  return {
    number: scope.number,
    finalCommit: scope.finalCommit,
    commitSubject: scope.commitSubject,
    changedFiles: [...scope.changedFiles],
    archivedReviewPath: scope.archivedReviewPath,
  };
}

function findLastNonEmptyImplementationScope(
  effectiveScopes: ProgressScope[],
  terminalScope: FinalCompletionTerminalScope | null,
  state: OrchestrationState,
): FinalCompletionReferenceScope | null {
  if (terminalScope && terminalScope.changedFiles.length > 0) {
    return toReferenceScope(buildTerminalScopeRecord(state, terminalScope));
  }

  for (let index = effectiveScopes.length - 1; index >= 0; index -= 1) {
    const scope = effectiveScopes[index];
    if (scope?.result === 'accepted' && scope.changedFiles.length > 0) {
      return toReferenceScope(scope);
    }
  }

  return null;
}

async function loadVerificationCommandResults(runDir: string) {
  try {
    const content = await readFile(getEventsPath(runDir), 'utf8');
    const events = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
    return extractVerificationCommandResults(events);
  } catch {
    return [];
  }
}

function collectResidualReviewDebt(scopes: ProgressScope[]): ResidualReviewDebtItem[] {
  return scopes.flatMap((scope) => scope.residualReviewDebt ?? []);
}

function summarizeResidualReviewDebt(scopes: ProgressScope[]) {
  const items = scopes.flatMap((scope) =>
    (scope.residualReviewDebt ?? []).map((item) => ({
      scope: scope.number,
      ...item,
    })),
  );

  if (items.length === 0) {
    return 'No unresolved non-blocking review debt was recorded for accepted scopes.';
  }

  return items
    .map((item) => {
      const files = item.files.length > 0 ? item.files.join(', ') : 'n/a';
      const disposition = item.coderDisposition ? ` | coder disposition: ${item.coderDisposition}` : '';
      return `- Scope ${item.scope} ${item.id} (${item.status}) | files: ${files} | ${item.claim} | required: ${item.requiredAction}${disposition}`;
    })
    .join('\n');
}

async function loadAggregateReviewContext(
  state: OrchestrationState,
  finalCommit: string | null,
): Promise<FinalCompletionAggregateReviewContext> {
  const baseCommit = state.initialBaseCommit;
  const headCommit = finalCommit;
  const range = baseCommit && headCommit ? `${baseCommit}..${headCommit}` : null;

  if (!baseCommit) {
    return {
      baseCommit,
      headCommit,
      range,
      commitSubjects: [],
      diffStat: '',
      changedFiles: [],
      unavailableReason: 'initialBaseCommit is unavailable, so the aggregate completion range cannot be computed.',
    };
  }

  if (!headCommit) {
    return {
      baseCommit,
      headCommit,
      range,
      commitSubjects: [],
      diffStat: '',
      changedFiles: [],
      unavailableReason: 'finalCommit is unavailable, so the aggregate completion range cannot be computed.',
    };
  }

  try {
    const commits = await getCommitRange(state.cwd, baseCommit, headCommit);
    const [commitSubjects, diffStat, changedFiles] = await Promise.all([
      getCommitSubjects(state.cwd, commits),
      getDiffStatForRange(state.cwd, baseCommit, headCommit),
      getChangedFilesForRange(state.cwd, baseCommit, headCommit),
    ]);

    return {
      baseCommit,
      headCommit,
      range,
      commitSubjects,
      diffStat,
      changedFiles,
      unavailableReason: null,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown git error';
    return {
      baseCommit,
      headCommit,
      range,
      commitSubjects: [],
      diffStat: '',
      changedFiles: [],
      unavailableReason: `Unable to read aggregate completion git context for ${range}: ${reason}`,
    };
  }
}

export async function buildFinalCompletionPacket(args: {
  state: OrchestrationState;
  terminalScope?: FinalCompletionTerminalScope | null;
}): Promise<FinalCompletionPacket> {
  const terminalScope = args.terminalScope ?? null;
  const finalCommit = terminalScope?.finalCommit ?? args.state.finalCommit;
  const effectiveScopes = mergeCompletedScopesWithTerminalScope(args.state, terminalScope);
  const allVerificationCommandResults = await loadVerificationCommandResults(args.state.runDir);
  const verificationCommandResults = latestCommandResultPerCommand(allVerificationCommandResults);
  const verificationCommands = verificationCommandResults.map((result) => result.command);
  const scopeAccounting = buildScopeAccountingSummary(effectiveScopes);
  const terminalChangedFiles = [...(terminalScope?.changedFiles ?? [])];
  const planChangedFiles = uniqueFiles(
    effectiveScopes
      .filter((scope) => scope.result === 'accepted')
      .flatMap((scope) => scope.changedFiles),
  );
  const residualReviewDebt = collectResidualReviewDebt(effectiveScopes);
  const aggregateReviewContext = await loadAggregateReviewContext(args.state, finalCommit);
  const finalCompletion = getFinalCompletionView(args.state);

  return {
    planDoc: args.state.planDoc,
    executionShape: args.state.executionShape,
    currentScopeLabel: getCurrentScopeLabel(args.state),
    finalCommit,
    aggregateReviewContext,
    completedScopeSummary: renderCompletedScopeSummary(effectiveScopes),
    acceptedScopeCount: effectiveScopes.filter((scope) => scope.result === 'accepted').length,
    blockedScopeCount: effectiveScopes.filter((scope) => scope.result === 'blocked').length,
    scopeAccounting,
    scopeAccountingSummary: scopeAccounting.summary,
    verificationOnlyCompletion: terminalChangedFiles.length === 0 && args.state.createdCommits.length === 0,
    terminalChangedFiles,
    terminalChangedFilesSummary: summarizeChangedFiles(terminalChangedFiles),
    planChangedFiles,
    planChangedFilesSummary: summarizeChangedFiles(planChangedFiles),
    residualReviewDebt,
    residualReviewDebtSummary: summarizeResidualReviewDebt(effectiveScopes),
    verificationCommands,
    verificationCommandResults,
    verificationSummary: summarizeVerificationCommandResults(verificationCommandResults),
    lastNonEmptyImplementationScope: findLastNonEmptyImplementationScope(effectiveScopes, terminalScope, args.state),
    continueExecutionCount: finalCompletion?.continueExecutionCount ?? 0,
    continueExecutionMax: Math.max(0, getFinalCompletionContinueExecutionMax(args.state.cwd)),
  };
}
