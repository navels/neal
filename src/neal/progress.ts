import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OrchestrationState } from './types.js';

type PlanProgressState = {
  version: 1;
  planDoc: string;
  executionMode: OrchestrationState['executionMode'];
  status: OrchestrationState['status'];
  createdAt: string;
  updatedAt: string;
  finalCommit: string | null;
  currentScope: {
    number: number;
    kind: 'one_shot' | 'chunk';
    phase: OrchestrationState['phase'];
    marker: OrchestrationState['lastCodexMarker'];
    baseCommit: string | null;
  } | null;
  completedScopes: OrchestrationState['completedScopes'];
};

function buildPlanProgressState(state: OrchestrationState): PlanProgressState {
  return {
    version: 1,
    planDoc: state.planDoc,
    executionMode: state.executionMode,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finalCommit: state.finalCommit,
    currentScope:
      state.status === 'done'
        ? null
        : {
            number: state.currentScopeNumber,
            kind: state.executionMode === 'chunked' ? 'chunk' : 'one_shot',
            phase: state.phase,
            marker: state.lastCodexMarker,
            baseCommit: state.baseCommit,
          },
    completedScopes: state.completedScopes,
  };
}

export function renderPlanProgressMarkdown(state: OrchestrationState) {
  const progress = buildPlanProgressState(state);
  const lines = [
    '# Plan Progress',
    '',
    '## Metadata',
    `- Plan: ${progress.planDoc}`,
    `- Execution mode: ${progress.executionMode}`,
    `- Status: ${progress.status}`,
    `- Final commit: ${progress.finalCommit ?? 'pending'}`,
  ];

  if (progress.currentScope) {
    lines.push(
      '',
      '## Current Scope',
      `- Number: ${progress.currentScope.number}`,
      `- Kind: ${progress.currentScope.kind}`,
      `- Phase: ${progress.currentScope.phase}`,
      `- Marker: ${progress.currentScope.marker ?? 'pending'}`,
      `- Base commit: ${progress.currentScope.baseCommit ?? 'unknown'}`,
    );
  }

  lines.push('', '## Completed Scopes');
  if (progress.completedScopes.length === 0) {
    lines.push('', 'No completed scopes yet.');
  } else {
    for (const scope of progress.completedScopes) {
      lines.push(
        '',
        `### Scope ${scope.number}`,
        `- Kind: ${scope.kind}`,
        `- Result: ${scope.result}`,
        `- Marker: ${scope.marker}`,
        `- Base commit: ${scope.baseCommit ?? 'unknown'}`,
        `- Final commit: ${scope.finalCommit ?? 'pending'}`,
        `- Commit subject: ${scope.commitSubject ?? 'pending'}`,
        `- Review rounds: ${scope.reviewRounds}`,
        `- Findings: ${scope.findings}`,
        `- Archived review: ${scope.archivedReviewPath ?? 'pending'}`,
        `- Blocker: ${scope.blocker ?? 'none'}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writePlanProgressArtifacts(state: OrchestrationState) {
  const progress = buildPlanProgressState(state);
  await mkdir(dirname(state.progressJsonPath), { recursive: true });
  await writeFile(state.progressJsonPath, JSON.stringify(progress, null, 2) + '\n', 'utf8');
  await writeFile(state.progressMarkdownPath, renderPlanProgressMarkdown(state), 'utf8');
}
