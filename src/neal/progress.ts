import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OrchestrationState } from './types.js';

type PlanProgressState = {
  version: 1;
  planDoc: string;
  status: OrchestrationState['status'];
  createdAt: string;
  updatedAt: string;
  finalCommit: string | null;
  currentScope: {
    number: number;
    phase: OrchestrationState['phase'];
    marker: OrchestrationState['lastScopeMarker'];
    baseCommit: string | null;
    derivedPlanPath: string | null;
    derivedPlanStatus: OrchestrationState['derivedPlanStatus'];
    splitPlanCount: number;
    derivedPlanDepth: number;
  } | null;
  completedScopes: OrchestrationState['completedScopes'];
};

function buildPlanProgressState(state: OrchestrationState): PlanProgressState {
  return {
    version: 1,
    planDoc: state.planDoc,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finalCommit: state.finalCommit,
    currentScope:
      state.status === 'done'
        ? null
        : {
            number: state.currentScopeNumber,
            phase: state.phase,
            marker: state.lastScopeMarker,
            baseCommit: state.baseCommit,
            derivedPlanPath: state.derivedPlanPath,
            derivedPlanStatus: state.derivedPlanStatus,
            splitPlanCount: state.splitPlanCountForCurrentScope,
            derivedPlanDepth: state.derivedPlanDepth,
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
    `- Status: ${progress.status}`,
    `- Final commit: ${progress.finalCommit ?? 'pending'}`,
  ];

  if (progress.currentScope) {
    lines.push(
      '',
      '## Current Scope',
      `- Number: ${progress.currentScope.number}`,
      `- Phase: ${progress.currentScope.phase}`,
      `- Marker: ${progress.currentScope.marker ?? 'pending'}`,
      `- Base commit: ${progress.currentScope.baseCommit ?? 'unknown'}`,
      `- Derived plan: ${progress.currentScope.derivedPlanPath ?? 'none'}`,
      `- Derived plan status: ${progress.currentScope.derivedPlanStatus ?? 'none'}`,
      `- Split plan count: ${progress.currentScope.splitPlanCount}`,
      `- Derived plan depth: ${progress.currentScope.derivedPlanDepth}`,
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
