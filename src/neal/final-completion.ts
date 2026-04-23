import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getFinalCompletionContinueExecutionMax } from './config.js';
import { toResidualReviewDebt } from './review-debt.js';
import { getCurrentScopeLabel } from './scopes.js';
import type {
  FinalCompletionPacket,
  FinalCompletionReferenceScope,
  FinalCompletionTerminalScope,
  OrchestrationState,
  ProgressScope,
  ResidualReviewDebtItem,
  ScopeMarker,
} from './types.js';

type RunEvent = {
  type?: unknown;
  data?: {
    command?: unknown;
  };
};

function getEventsPath(runDir: string) {
  return join(runDir, 'events.ndjson');
}

function isVerificationCommand(command: string) {
  return /\b(test|tests|typecheck|tsc|lint|build|verify|validation|check|pytest|vitest|jest)\b/i.test(command);
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
    derivedFromParentScope: state.derivedFromScopeNumber !== null ? String(state.derivedFromScopeNumber) : null,
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

async function loadVerificationCommands(runDir: string) {
  try {
    const content = await readFile(getEventsPath(runDir), 'utf8');
    const commands = content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent)
      .filter((event) => event.type === 'coder.command_execution' || event.type === 'codex.command_execution')
      .map((event) => String(event.data?.command ?? '').trim())
      .filter((command) => command.length > 0 && isVerificationCommand(command));
    return [...new Set(commands)];
  } catch {
    return [];
  }
}

function summarizeVerification(commands: string[]) {
  if (commands.length === 0) {
    return 'No verification commands were recorded in events.ndjson.';
  }

  return [
    'Recorded verification commands for this run:',
    ...commands.map((command) => `- ${command}`),
    '- Command exit statuses are not persisted separately in the current run event log.',
  ].join('\n');
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

export async function buildFinalCompletionPacket(args: {
  state: OrchestrationState;
  terminalScope?: FinalCompletionTerminalScope | null;
}): Promise<FinalCompletionPacket> {
  const terminalScope = args.terminalScope ?? null;
  const effectiveScopes = mergeCompletedScopesWithTerminalScope(args.state, terminalScope);
  const verificationCommands = await loadVerificationCommands(args.state.runDir);
  const terminalChangedFiles = [...(terminalScope?.changedFiles ?? [])];
  const planChangedFiles = uniqueFiles(
    effectiveScopes
      .filter((scope) => scope.result === 'accepted')
      .flatMap((scope) => scope.changedFiles),
  );
  const residualReviewDebt = collectResidualReviewDebt(effectiveScopes);

  return {
    planDoc: args.state.planDoc,
    executionShape: args.state.executionShape,
    currentScopeLabel: getCurrentScopeLabel(args.state),
    finalCommit: terminalScope?.finalCommit ?? args.state.finalCommit,
    completedScopeSummary: renderCompletedScopeSummary(effectiveScopes),
    acceptedScopeCount: effectiveScopes.filter((scope) => scope.result === 'accepted').length,
    blockedScopeCount: effectiveScopes.filter((scope) => scope.result === 'blocked').length,
    verificationOnlyCompletion: terminalChangedFiles.length === 0 && args.state.createdCommits.length === 0,
    terminalChangedFiles,
    terminalChangedFilesSummary: summarizeChangedFiles(terminalChangedFiles),
    planChangedFiles,
    planChangedFilesSummary: summarizeChangedFiles(planChangedFiles),
    residualReviewDebt,
    residualReviewDebtSummary: summarizeResidualReviewDebt(effectiveScopes),
    verificationCommands,
    verificationSummary: summarizeVerification(verificationCommands),
    lastNonEmptyImplementationScope: findLastNonEmptyImplementationScope(effectiveScopes, terminalScope, args.state),
    continueExecutionCount: args.state.finalCompletionContinueExecutionCount,
    continueExecutionMax: Math.max(0, getFinalCompletionContinueExecutionMax(args.state.cwd)),
  };
}
