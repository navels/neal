import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getChangedFilesForRange } from './git.js';
import type { FindingSeverity, OrchestrationState } from './types.js';

type RunEvent = {
  ts: string;
  type: string;
  data?: Record<string, unknown>;
};

type RetrospectiveKind = 'scope_accepted' | 'blocked' | 'failed' | 'done';

function getEventsPath(runDir: string) {
  return join(runDir, 'events.ndjson');
}

function getCurrentRetrospectivePath(runDir: string) {
  return join(runDir, 'RETROSPECTIVE.md');
}

function getArchivedRetrospectivePath(state: OrchestrationState, kind: RetrospectiveKind) {
  if (kind === 'scope_accepted') {
    const suffix = state.finalCommit ? `-${state.finalCommit}` : '';
    return join(state.runDir, `RETROSPECTIVE-scope-${state.currentScopeNumber}${suffix}.md`);
  }

  if (kind === 'blocked') {
    return join(state.runDir, `RETROSPECTIVE-blocked-scope-${state.currentScopeNumber}.md`);
  }

  if (kind === 'failed') {
    return join(state.runDir, `RETROSPECTIVE-failed-scope-${state.currentScopeNumber}.md`);
  }

  const suffix = state.finalCommit ? `-${state.finalCommit}` : '';
  return join(state.runDir, `RETROSPECTIVE-final${suffix}.md`);
}

async function loadRunEvents(runDir: string): Promise<RunEvent[]> {
  try {
    const content = await readFile(getEventsPath(runDir), 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  } catch {
    return [];
  }
}

function getScopeEvents(events: RunEvent[], scopeNumber: number) {
  const scopeStartIndexes = events.reduce<number[]>((indexes, event, index) => {
    if (event.type === 'phase.start' && event.data?.phase === 'coder_scope') {
      indexes.push(index);
    }
    return indexes;
  }, []);

  const startIndex = scopeStartIndexes[scopeNumber - 1] ?? 0;
  const endIndex = scopeStartIndexes[scopeNumber] ?? events.length;
  return events.slice(startIndex, endIndex);
}

function countFindingsBySeverity(state: OrchestrationState) {
  return state.findings.reduce(
    (counts, finding) => {
      counts.total += 1;
      counts[finding.severity] += 1;
      return counts;
    },
    { total: 0, blocking: 0, non_blocking: 0 } as Record<FindingSeverity | 'total', number>,
  );
}

function countDispositions(state: OrchestrationState) {
  return state.findings.reduce(
    (counts, finding) => {
      if (finding.status === 'fixed' || finding.status === 'rejected' || finding.status === 'deferred') {
        counts[finding.status] += 1;
      }
      return counts;
    },
    { fixed: 0, rejected: 0, deferred: 0 },
  );
}

function extractCommands(events: RunEvent[]) {
  return events
    .filter((event) => event.type === 'coder.command_execution' || event.type === 'codex.command_execution')
    .map((event) => String(event.data?.command ?? ''))
    .filter(Boolean);
}

function summarizeVerification(commands: string[]) {
  const lintRuns = commands.filter((command) => /\blint\b/.test(command));
  const focusedTests = commands.filter((command) => /\btest:.*(unit|integration|acceptance|focused|exam:changed)\b/.test(command));
  const fullSuites = commands.filter((command) => /\btest:(osl|portal):exam\b/.test(command));

  const lines: string[] = [];
  if (lintRuns.length > 0) {
    lines.push(`- Lint commands: ${lintRuns.length}`);
  }
  if (focusedTests.length > 0) {
    lines.push(`- Focused test commands: ${focusedTests.length}`);
  }
  if (fullSuites.length > 0) {
    lines.push(`- Full-suite commands: ${fullSuites.length}`);
  }
  if (lines.length === 0) {
    lines.push('- No verification commands were recorded in the wrapper event log.');
  }

  return lines.join('\n');
}

function buildAssessment(state: OrchestrationState, scopeEvents: RunEvent[]) {
  const findingCounts = countFindingsBySeverity(state);
  const dispositions = countDispositions(state);
  const continuationCount = scopeEvents.filter(
    (event) => event.type === 'advisor.round_continuation' || event.type === 'claude.review_continuation',
  ).length;
  const phaseErrors = scopeEvents.filter((event) => event.type === 'phase.error');
  const assessments: string[] = [];

  if (findingCounts.blocking > 0 && dispositions.fixed > 0) {
    assessments.push(`- The reviewer added clear value: it surfaced ${findingCounts.blocking} blocking finding(s) and the coder fixed ${dispositions.fixed} before acceptance.`);
  } else if (findingCounts.total === 0) {
    assessments.push('- The reviewer did not raise any findings. Review overhead was low, but the value added in this checkpoint is unclear.');
  } else if (findingCounts.non_blocking > 0 && findingCounts.blocking === 0) {
    assessments.push(`- The reviewer found only non-blocking issues (${findingCounts.non_blocking}). Review added polish more than risk reduction.`);
  }

  if (state.rounds.length > 1) {
    assessments.push(`- The review loop required ${state.rounds.length} passes. This scope may be slightly too broad or under-specified.`);
  }

  if (state.createdCommits.length > 1) {
    assessments.push(`- The coder created ${state.createdCommits.length} commits before final squash. That suggests rework during the scope, which may be acceptable but is worth watching.`);
  }

  if (continuationCount > 0) {
    assessments.push(`- The reviewer needed ${continuationCount} same-session continuation(s) to finish the review. Review prompt scope or tool usage may still be inefficient.`);
  }

  if (phaseErrors.length > 0) {
    assessments.push(`- The wrapper recorded ${phaseErrors.length} phase error event(s) during this checkpoint. Inspect events.ndjson for the exact failure path.`);
  }

  if (assessments.length === 0) {
    assessments.push('- The loop behaved normally and did not expose obvious inefficiencies in this checkpoint.');
  }

  return assessments.join('\n');
}

function summarizeFindings(state: OrchestrationState) {
  if (state.findings.length === 0) {
    return '- No review findings recorded.';
  }

  return state.findings
    .map((finding, index) => {
      const files = finding.files.length > 0 ? finding.files.join(', ') : 'n/a';
      const disposition = finding.coderDisposition ? ` | Coder: ${finding.coderDisposition}` : '';
      return `- ${index + 1}. [${finding.severity}] ${finding.claim} | Files: ${files}${disposition}`;
    })
    .join('\n');
}

function summarizeBlocker(state: OrchestrationState) {
  const latestCompletedScope = state.completedScopes.at(-1) ?? null;
  const persistedBlocker = latestCompletedScope?.blocker?.trim() || null;
  const latestConsult = state.consultRounds.at(-1) ?? null;
  const consultRequestBlocker = latestConsult?.request.blocker?.trim() || null;
  const consultDiagnosis = latestConsult?.response?.diagnosis?.trim() || null;
  const consultRecommendations = latestConsult?.response?.recommendations ?? [];
  const coderDisposition = latestConsult?.disposition?.summary?.trim() || null;
  const coderRemainingBlocker = latestConsult?.disposition?.blocker?.trim() || null;
  const lines: string[] = [];

  if (persistedBlocker) {
    lines.push(`- Final blocker: ${persistedBlocker}`);
  }

  if (consultRequestBlocker && consultRequestBlocker !== persistedBlocker) {
    lines.push(`- Consult request: ${consultRequestBlocker}`);
  }

  if (consultDiagnosis) {
    lines.push(`- Reviewer diagnosis: ${consultDiagnosis}`);
  }

  if (consultRecommendations.length > 0) {
    const display = consultRecommendations.slice(0, 4);
    lines.push(`- Reviewer recommendations: ${display.join(' | ')}`);
    if (consultRecommendations.length > display.length) {
      lines.push(`- Additional recommendations omitted: ${consultRecommendations.length - display.length}`);
    }
  }

  if (coderDisposition) {
    lines.push(`- Coder follow-through: ${coderDisposition}`);
  }

  if (coderRemainingBlocker && coderRemainingBlocker !== persistedBlocker) {
    lines.push(`- Remaining blocker after consult: ${coderRemainingBlocker}`);
  }

  if (lines.length === 0) {
    lines.push('- No blocker summary was captured.');
  }

  return lines.join('\n');
}

function summarizeCompletedScopes(state: OrchestrationState) {
  if (state.completedScopes.length === 0) {
    return '- No completed scopes recorded yet.';
  }

  return state.completedScopes
    .map((scope) => {
      const commit = scope.finalCommit ? ` | Commit: ${scope.finalCommit}` : '';
      const blocker = scope.blocker ? ` | Blocker: ${scope.blocker}` : '';
      return `- Scope ${scope.number}: ${scope.result} (${scope.marker}) | Review rounds: ${scope.reviewRounds} | Findings: ${scope.findings}${commit}${blocker}`;
    })
    .join('\n');
}

function getLatestReviewerSessionHandle(state: OrchestrationState) {
  return state.reviewerSessionHandle ?? state.rounds.at(-1)?.reviewerSessionHandle ?? null;
}

async function summarizeChangedFiles(state: OrchestrationState) {
  if (!state.baseCommit || !state.finalCommit) {
    return '- Changed files unavailable for this checkpoint.';
  }

  const files = await getChangedFilesForRange(state.cwd, state.baseCommit, state.finalCommit);
  if (files.length === 0) {
    return '- No changed files recorded.';
  }

  const displayFiles = files.slice(0, 12);
  const lines = displayFiles.map((file) => `- ${file}`);
  if (files.length > displayFiles.length) {
    lines.push(`- ...and ${files.length - displayFiles.length} more`);
  }
  return lines.join('\n');
}

async function renderRetrospective(state: OrchestrationState, kind: RetrospectiveKind) {
  const events = await loadRunEvents(state.runDir);
  const scopeEvents =
    state.topLevelMode === 'execute'
      ? getScopeEvents(events, state.currentScopeNumber)
      : events;
  const commands = extractCommands(scopeEvents);
  const findings = countFindingsBySeverity(state);
  const dispositions = countDispositions(state);
  const planName = basename(state.planDoc);
  const outcomeTitle =
    kind === 'scope_accepted'
      ? `Scope ${state.currentScopeNumber} accepted`
      : kind === 'blocked'
        ? `Scope ${state.currentScopeNumber} blocked`
        : kind === 'failed'
          ? `Scope ${state.currentScopeNumber} failed`
        : state.topLevelMode === 'plan'
          ? 'Planning run complete'
          : 'Plan implementation complete';
  const outcomeStatus =
    kind === 'scope_accepted'
      ? 'accepted'
      : kind === 'blocked'
        ? 'blocked'
        : kind === 'failed'
          ? 'failed'
          : 'done';

  const changedFiles = await summarizeChangedFiles(state);
  const verificationSummary = summarizeVerification(commands);
  const assessment = buildAssessment(state, scopeEvents);
  const completedScopesSummary = kind === 'done' ? summarizeCompletedScopes(state) : null;
  const latestReviewerSessionHandle = getLatestReviewerSessionHandle(state);
  const blockerSummary = kind === 'blocked' || kind === 'failed' ? summarizeBlocker(state) : null;

  return [
    `# Neal Retrospective`,
    '',
    `## Outcome`,
    `- Plan: ${planName}`,
    `- Mode: ${state.topLevelMode}`,
    `- Summary: ${outcomeTitle}`,
    `- Scope: ${state.currentScopeNumber}`,
    `- Status: ${outcomeStatus}`,
    `- Final commit: ${state.finalCommit ?? 'n/a'}`,
    `- Coder session: ${state.coderSessionHandle ?? 'n/a'}`,
    `- Reviewer session: ${latestReviewerSessionHandle ?? 'n/a'}`,
    `- Reviewer rounds: ${state.rounds.length}`,
    `- Findings: ${findings.total} total (${findings.blocking} blocking, ${findings.non_blocking} non-blocking)`,
    `- Coder dispositions: ${dispositions.fixed} fixed, ${dispositions.rejected} rejected, ${dispositions.deferred} deferred`,
    '',
    `## Work Summary`,
    changedFiles,
    '',
    `## Review Summary`,
    summarizeFindings(state),
    '',
    `## Verification`,
    verificationSummary,
    ...(blockerSummary
      ? [
          '',
          `## Blocker Summary`,
          blockerSummary,
        ]
      : []),
    '',
    `## Assessment`,
    assessment,
    ...(completedScopesSummary
      ? [
          '',
          `## Completed Scopes`,
          completedScopesSummary,
        ]
      : []),
    '',
  ].join('\n');
}

async function writeRetrospectiveFile(path: string, content: string) {
  await writeFile(path, content, 'utf8');
}

export async function writeCheckpointRetrospective(state: OrchestrationState, kind: RetrospectiveKind) {
  const content = await renderRetrospective(state, kind);
  const currentPath = getCurrentRetrospectivePath(state.runDir);
  const archivedPath = getArchivedRetrospectivePath(state, kind);
  await writeRetrospectiveFile(currentPath, content);
  await writeRetrospectiveFile(archivedPath, content);
  return { currentPath, archivedPath };
}
