import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { writeTextAtomic } from './atomic-write.js';
import { getChangedFilesForRange } from './git.js';
import { renderInteractiveBlockedRecoveryHistoryLines } from './recovery-artifacts.js';
import { renderRunMetricsMarkdown, summarizeRunMetrics, type RunMetricsSummary } from './run-metrics.js';
import { getCurrentScopeLabel, getParentScopeLabel } from './scopes.js';
import { getDerivedPlanView, getFinalCompletionView } from './state-views.js';
import {
  extractVerificationCommandResults,
  summarizeVerificationCommandResults,
  type RunEvent,
} from './verification-events.js';
import type { FindingSeverity, OrchestrationState } from './types.js';

type RetrospectiveKind = 'scope_accepted' | 'blocked' | 'failed' | 'done';

function getEventsPath(runDir: string) {
  return join(runDir, 'events.ndjson');
}

function getCurrentRetrospectivePath(runDir: string) {
  return join(runDir, 'RETROSPECTIVE.md');
}

function getArchivedRetrospectivePath(state: OrchestrationState, kind: RetrospectiveKind) {
  const scopeLabel = getCurrentScopeLabel(state);
  if (kind === 'scope_accepted') {
    const suffix = state.finalCommit ? `-${state.finalCommit}` : '';
    return join(state.runDir, `RETROSPECTIVE-scope-${scopeLabel}${suffix}.md`);
  }

  if (kind === 'blocked') {
    return join(state.runDir, `RETROSPECTIVE-blocked-scope-${scopeLabel}.md`);
  }

  if (kind === 'failed') {
    return join(state.runDir, `RETROSPECTIVE-failed-scope-${scopeLabel}.md`);
  }

  const suffix = state.finalCommit ? `-${state.finalCommit}` : '';
  return join(state.runDir, `RETROSPECTIVE-final${suffix}.md`);
}

function getCurrentRunMetricsPath(runDir: string) {
  return join(runDir, 'RUN_METRICS.json');
}

// Mirrors getArchivedRetrospectivePath's scope/kind/commit naming so the
// machine-readable metrics archive lines up with the retrospective archive.
function getArchivedRunMetricsPath(state: OrchestrationState, kind: RetrospectiveKind) {
  const scopeLabel = getCurrentScopeLabel(state);
  if (kind === 'scope_accepted') {
    const suffix = state.finalCommit ? `-${state.finalCommit}` : '';
    return join(state.runDir, `RUN_METRICS-scope-${scopeLabel}${suffix}.json`);
  }

  if (kind === 'blocked') {
    return join(state.runDir, `RUN_METRICS-blocked-scope-${scopeLabel}.json`);
  }

  if (kind === 'failed') {
    return join(state.runDir, `RUN_METRICS-failed-scope-${scopeLabel}.json`);
  }

  const suffix = state.finalCommit ? `-${state.finalCommit}` : '';
  return join(state.runDir, `RUN_METRICS-final${suffix}.json`);
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

function summarizeVerification(events: RunEvent[]) {
  const verificationResults = extractVerificationCommandResults(events);
  const commands = verificationResults.map((result) => result.command);
  const lintRuns = commands.filter((command) => /\blint\b/.test(command));
  const focusedTests = commands.filter((command) => /\btest:.*\b(unit|integration|acceptance|focused|changed)\b/.test(command));
  const fullSuites = commands.filter((command) => /\btest(:all|:full|:ci)?\s*$/.test(command));

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
  if (verificationResults.length === 0) {
    lines.push('- No verification commands were recorded in the wrapper event log.');
  } else {
    lines.push(summarizeVerificationCommandResults(verificationResults));
  }

  return lines.join('\n');
}

function sentenceFromLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/^-+\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function summarizeReviewLoopForNarrative(state: OrchestrationState) {
  const findings = countFindingsBySeverity(state);
  const dispositions = countDispositions(state);

  if (findings.total === 0) {
    return `The reviewer completed ${state.rounds.length} ${pluralize(state.rounds.length, 'round')} without recording findings.`;
  }

  const dispositionParts = [
    dispositions.fixed > 0 ? `${dispositions.fixed} fixed` : null,
    dispositions.rejected > 0 ? `${dispositions.rejected} rejected` : null,
    dispositions.deferred > 0 ? `${dispositions.deferred} deferred` : null,
  ].filter(Boolean);
  const dispositionSummary =
    dispositionParts.length > 0 ? ` The coder dispositions were ${dispositionParts.join(', ')}.` : '';

  return `Across ${state.rounds.length} ${pluralize(state.rounds.length, 'review round')}, the reviewer recorded ${findings.total} ${pluralize(findings.total, 'finding')} (${findings.blocking} blocking, ${findings.non_blocking} non-blocking).${dispositionSummary}`;
}

function summarizeWorkForNarrative(state: OrchestrationState, kind: RetrospectiveKind) {
  const planName = basename(state.planDoc);
  const scopeLabel = getCurrentScopeLabel(state);
  const finalSummary = getFinalCompletionView(state)?.summary ?? null;

  if (kind === 'done' && finalSummary?.whatChangedOverall.trim()) {
    return finalSummary.whatChangedOverall.trim();
  }

  if (kind === 'scope_accepted') {
    return `Neal accepted scope ${scopeLabel} for ${planName} and recorded the checkpoint at commit ${state.finalCommit ?? 'n/a'}.`;
  }

  if (kind === 'blocked') {
    return `Neal stopped on scope ${scopeLabel} for ${planName} because the current work needs operator guidance or a narrower recovery path.`;
  }

  if (kind === 'failed') {
    return `Neal failed while working on scope ${scopeLabel} for ${planName}.`;
  }

  const acceptedScopes = state.completedScopes.filter((scope) => scope.result === 'accepted').length;
  return `Neal completed ${acceptedScopes} accepted ${pluralize(acceptedScopes, 'scope')} for ${planName}.`;
}

function summarizeOutcomeForNarrative(state: OrchestrationState, kind: RetrospectiveKind) {
  const finalSummary = getFinalCompletionView(state)?.summary ?? null;
  if (kind === 'done' && finalSummary) {
    return finalSummary.planGoalSatisfied
      ? 'The final completion check marked the plan goal as satisfied.'
      : 'The final completion check did not mark the plan goal as fully satisfied.';
  }

  if (kind === 'blocked') {
    const latestBlocker = state.completedScopes.at(-1)?.blocker?.trim() || state.interactiveBlockedRecovery?.blockedReason?.trim();
    return latestBlocker ? `The active blocker is: ${latestBlocker}` : 'The run is blocked and needs follow-up before it can continue.';
  }

  if (kind === 'failed') {
    return 'The run ended in a failed state. Inspect the event log and recent artifacts before resuming.';
  }

  return `The run status is ${state.status}.`;
}

function summarizeKnownGapsForNarrative(state: OrchestrationState) {
  const finalCompletion = getFinalCompletionView(state);
  const gaps = finalCompletion?.summary?.remainingKnownGaps.filter((gap) => gap.trim()) ?? [];
  const missingWork = finalCompletion?.reviewVerdict?.missingWork;

  if (gaps.length > 0) {
    const display = gaps.slice(0, 3).join(' ');
    const omitted = gaps.length > 3 ? ` ${gaps.length - 3} additional gap(s) were omitted from this short retrospective.` : '';
    return `Known remaining gaps: ${display}${omitted}`;
  }

  if (missingWork) {
    return `The final reviewer still wanted follow-up: ${missingWork.summary}`;
  }

  return 'No remaining gaps were recorded in the final completion artifacts.';
}

function buildNarrativeRetrospective(args: {
  state: OrchestrationState;
  kind: RetrospectiveKind;
  outcomeTitle: string;
  verificationSummary: string;
}) {
  const { state, kind, outcomeTitle, verificationSummary } = args;
  const paragraphs = [
    `Neal reached "${outcomeTitle}" in ${state.topLevelMode} mode. ${summarizeWorkForNarrative(state, kind)}`,
    `${summarizeOutcomeForNarrative(state, kind)} ${summarizeReviewLoopForNarrative(state)}`,
    `Verification evidence: ${sentenceFromLines(verificationSummary)}`,
  ];

  if (kind === 'done') {
    paragraphs.push(summarizeKnownGapsForNarrative(state));
  }

  const finalReview = getFinalCompletionView(state)?.reviewVerdict ?? null;
  if (finalReview?.summary.trim()) {
    paragraphs.push(`Final reviewer verdict: ${finalReview.summary.trim()}`);
  }

  return paragraphs.join('\n\n');
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
    assessments.push('- The reviewer did not raise any findings.');
  } else if (findingCounts.non_blocking > 0 && findingCounts.blocking === 0) {
    assessments.push(`- The reviewer found only non-blocking issues (${findingCounts.non_blocking}). Review added polish more than risk reduction.`);
  }

  if (state.rounds.length > 1) {
    assessments.push(`- The review loop required ${state.rounds.length} passes. This scope may be slightly too broad or under-specified.`);
  }

  if (state.createdCommits.length > 1) {
    assessments.push(`- The coder created ${state.createdCommits.length} commits before execute finalization. That suggests rework during the scope, which may be acceptable but is worth watching.`);
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
  const recovery = state.interactiveBlockedRecovery;
  const recoveryBlocker = recovery?.blockedReason?.trim() || null;
  const advice = recovery?.consultantAdvice ?? null;
  const lines: string[] = [];

  if (persistedBlocker) {
    lines.push(`- Final blocker: ${persistedBlocker}`);
  }

  if (recoveryBlocker && recoveryBlocker !== persistedBlocker) {
    lines.push(`- Recovery blocker: ${recoveryBlocker}`);
  }

  if (advice) {
    lines.push(
      `- Consultant triage: ${advice.triageCategory} (recoverable: ${advice.recoverable ? 'yes' : 'no'})`,
    );
    if (advice.resolutionDirective.trim()) {
      lines.push(`- Consultant suggested directive: ${advice.resolutionDirective.trim()}`);
    }
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
      const parent = scope.derivedFromParentScope ? ` | Parent: ${scope.derivedFromParentScope}` : '';
      const derivedPlan = scope.replacedByDerivedPlanPath ? ` | Derived plan: ${scope.replacedByDerivedPlanPath}` : '';
      return `- Scope ${scope.number}: ${scope.result} (${scope.marker}) | Review rounds: ${scope.reviewRounds} | Findings: ${scope.findings}${commit}${blocker}${parent}${derivedPlan}`;
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
  const findings = countFindingsBySeverity(state);
  const dispositions = countDispositions(state);
  const planName = basename(state.planDoc);
  const outcomeTitle =
    kind === 'scope_accepted'
      ? `Scope ${getCurrentScopeLabel(state)} accepted`
      : kind === 'blocked'
        ? `Scope ${getCurrentScopeLabel(state)} blocked`
        : kind === 'failed'
          ? `Scope ${getCurrentScopeLabel(state)} failed`
          : state.topLevelMode === 'plan'
            ? 'Planning run complete'
            : 'Implementation complete';
  const outcomeStatus =
    kind === 'scope_accepted'
      ? 'accepted'
      : kind === 'blocked'
        ? 'blocked'
        : kind === 'failed'
          ? 'failed'
          : 'done';

  const changedFiles = await summarizeChangedFiles(state);
  const verificationSummary = summarizeVerification(scopeEvents);
  const metricsEvents = kind === 'done' ? events : scopeEvents;
  const metrics = summarizeRunMetrics(metricsEvents);
  const runMetricsSummary = renderRunMetricsMarkdown(metrics);
  const assessment = buildAssessment(state, scopeEvents);
  const narrativeRetrospective = buildNarrativeRetrospective({
    state,
    kind,
    outcomeTitle,
    verificationSummary,
  });
  const completedScopesSummary = kind === 'done' ? summarizeCompletedScopes(state) : null;
  const latestReviewerSessionHandle = getLatestReviewerSessionHandle(state);
  const blockerSummary = kind === 'blocked' || kind === 'failed' ? summarizeBlocker(state) : null;
  const derivedPlan = getDerivedPlanView(state);
  const showDerivedPlanContext = Boolean(derivedPlan);
  const parentScopeLabel = derivedPlan?.executing ? getParentScopeLabel(state) : null;

  const content = [
    `# Neal Retrospective`,
    '',
    `## Outcome`,
    `- Plan: ${planName}`,
    `- Mode: ${state.topLevelMode}`,
    `- Summary: ${outcomeTitle}`,
    `- Scope: ${getCurrentScopeLabel(state)}`,
    `- Status: ${outcomeStatus}`,
    `- Final commit: ${state.finalCommit ?? 'n/a'}`,
    `- Coder session: ${state.coderSessionHandle ?? 'n/a'}`,
    `- Reviewer session: ${latestReviewerSessionHandle ?? 'n/a'}`,
    `- Reviewer rounds: ${state.rounds.length}`,
    `- Findings: ${findings.total} total (${findings.blocking} blocking, ${findings.non_blocking} non-blocking)`,
    `- Coder dispositions: ${dispositions.fixed} fixed, ${dispositions.rejected} rejected, ${dispositions.deferred} deferred`,
    ...(showDerivedPlanContext
      ? [
          `- Parent scope: ${parentScopeLabel ?? 'none'}`,
          `- Derived plan: ${derivedPlan?.path ?? 'none'}`,
          `- Derived plan status: ${derivedPlan?.status ?? 'none'}`,
        ]
      : []),
    '',
    `## Run Metrics`,
    runMetricsSummary,
    '',
    `## Retrospective`,
    narrativeRetrospective,
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
    ...renderInteractiveBlockedRecoveryHistoryLines(state.interactiveBlockedRecoveryHistory),
    '',
  ].join('\n');

  return { content, metrics };
}

async function writeRetrospectiveFile(path: string, content: string) {
  await writeTextAtomic(path, content);
}

async function writeRunMetricsFile(path: string, metrics: RunMetricsSummary) {
  await writeTextAtomic(path, `${JSON.stringify(metrics, null, 2)}\n`);
}

export async function writeCheckpointRetrospective(state: OrchestrationState, kind: RetrospectiveKind) {
  const { content, metrics } = await renderRetrospective(state, kind);
  const currentPath = getCurrentRetrospectivePath(state.runDir);
  const archivedPath = getArchivedRetrospectivePath(state, kind);
  await writeRetrospectiveFile(currentPath, content);
  await writeRetrospectiveFile(archivedPath, content);

  const currentMetricsPath = getCurrentRunMetricsPath(state.runDir);
  const archivedMetricsPath = getArchivedRunMetricsPath(state, kind);
  await writeRunMetricsFile(currentMetricsPath, metrics);
  await writeRunMetricsFile(archivedMetricsPath, metrics);

  return { currentPath, archivedPath, currentMetricsPath, archivedMetricsPath };
}
