import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { getFinalCompletionView } from '../state-views.js';
import type { OrchestrationState, ReviewFinding } from '../types.js';

export const REVIEWER_CONTEXT_JSON = 'REVIEWER_CONTEXT.json';
export const REVIEWER_CONTEXT_MARKDOWN = 'REVIEWER_CONTEXT.md';

const COMPLETED_SCOPE_LIMIT = 12;
const FINDING_LIMIT = 24;

export type ReviewerContextCitation = {
  label: string;
  path: string;
};

export type ReviewerContextPacket = {
  version: 1;
  createdAt: string;
  purpose: 'reviewer_continuity';
  run: {
    id: string;
    cwd: string;
    runDir: string;
    planDoc: string;
    topLevelMode: OrchestrationState['topLevelMode'];
    executionShape: OrchestrationState['executionShape'];
    phase: OrchestrationState['phase'];
    status: OrchestrationState['status'];
    currentScopeNumber: number;
  };
  completedScopes: {
    number: string;
    result: string;
    marker: string;
    finalCommit: string | null;
    summary: string | null;
    reviewRounds: number;
    findings: number;
    residualReviewDebt: number;
  }[];
  findings: {
    canonicalId: string;
    id: string;
    severity: ReviewFinding['severity'];
    status: ReviewFinding['status'];
    source: ReviewFinding['source'];
    files: string[];
    claim: string;
    requiredAction: string;
  }[];
  // Full plan-review debt items inherited from an accepted plan (via the queue
  // handoff). Surfaced as full items — not a count — because packet.findings is
  // empty for a fresh execution child, so the actionable claim/requiredAction
  // would otherwise be lost.
  inheritedPlanReviewDebt: {
    canonicalId: string;
    findingClass: ReviewFinding['findingClass'] | null;
    originRound: number | null;
    claim: string;
    requiredAction: string;
  }[];
  finalCompletion: {
    state: string;
    effectiveAction: string | null;
    hasSummary: boolean;
    hasReviewVerdict: boolean;
    continueExecutionCount: number;
    continueExecutionCapReached: boolean;
  } | null;
  citations: ReviewerContextCitation[];
  limits: {
    completedScopeLimit: number;
    completedScopeCount: number;
    findingLimit: number;
    findingCount: number;
    truncatedCompletedScopes: boolean;
    truncatedFindings: boolean;
  };
  promptMarkdown: string;
};

export async function buildAndPersistReviewerContextPacket(args: {
  state: OrchestrationState;
  now?: Date;
}): Promise<ReviewerContextPacket> {
  const packet = buildReviewerContextPacket(args);
  await mkdir(args.state.runDir, { recursive: true });
  await writeFile(join(args.state.runDir, REVIEWER_CONTEXT_JSON), JSON.stringify(withoutPromptMarkdown(packet), null, 2) + '\n');
  await writeFile(join(args.state.runDir, REVIEWER_CONTEXT_MARKDOWN), packet.promptMarkdown + '\n');
  return packet;
}

export function buildReviewerContextPacket(args: {
  state: OrchestrationState;
  now?: Date;
}): ReviewerContextPacket {
  const { state } = args;
  const createdAt = (args.now ?? new Date()).toISOString();
  const completedScopeCount = state.completedScopes.length;
  const findingCount = state.findings.length;
  const completedScopes = state.completedScopes.slice(-COMPLETED_SCOPE_LIMIT).map((scope) => ({
    number: scope.number,
    result: scope.result,
    marker: scope.marker,
    finalCommit: scope.finalCommit,
    summary: scope.summary ?? null,
    reviewRounds: scope.reviewRounds,
    findings: scope.findings,
    residualReviewDebt: scope.residualReviewDebt?.length ?? 0,
  }));
  const findings = state.findings.slice(-FINDING_LIMIT).map((finding) => ({
    canonicalId: finding.canonicalId,
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    source: finding.source,
    files: finding.files,
    claim: finding.claim,
    requiredAction: finding.requiredAction,
  }));
  const inheritedPlanReviewDebt = state.inheritedPlanReviewDebt.map((item) => ({
    canonicalId: item.canonicalId,
    findingClass: item.findingClass ?? null,
    originRound: item.originRound ?? null,
    claim: item.claim,
    requiredAction: item.requiredAction,
  }));
  const finalCompletion = summarizeFinalCompletion(state);
  const packetWithoutMarkdown = {
    version: 1 as const,
    createdAt,
    purpose: 'reviewer_continuity' as const,
    run: {
      id: runIdFromDir(state.runDir),
      cwd: state.cwd,
      runDir: toDisplayPath(state.cwd, state.runDir),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      executionShape: state.executionShape,
      phase: state.phase,
      status: state.status,
      currentScopeNumber: state.currentScopeNumber,
    },
    completedScopes,
    findings,
    inheritedPlanReviewDebt,
    finalCompletion,
    citations: buildReviewerContextCitations(state),
    limits: {
      completedScopeLimit: COMPLETED_SCOPE_LIMIT,
      completedScopeCount,
      findingLimit: FINDING_LIMIT,
      findingCount,
      truncatedCompletedScopes: completedScopeCount > completedScopes.length,
      truncatedFindings: findingCount > findings.length,
    },
  };

  return {
    ...packetWithoutMarkdown,
    promptMarkdown: renderReviewerContextMarkdown(packetWithoutMarkdown),
  };
}

function withoutPromptMarkdown(packet: ReviewerContextPacket): Omit<ReviewerContextPacket, 'promptMarkdown'> {
  const { promptMarkdown: _promptMarkdown, ...json } = packet;
  return json;
}

function summarizeFinalCompletion(state: OrchestrationState): ReviewerContextPacket['finalCompletion'] {
  const view = getFinalCompletionView(state);
  if (!view) {
    return null;
  }

  return {
    state: view.state,
    effectiveAction: view.effectiveAction,
    hasSummary: view.hasSummary,
    hasReviewVerdict: view.hasReviewVerdict,
    continueExecutionCount: view.continueExecutionCount,
    continueExecutionCapReached: view.continueExecutionCapReached,
  };
}

function buildReviewerContextCitations(state: OrchestrationState): ReviewerContextCitation[] {
  return [
    { label: 'RUN_STATE.json', path: toDisplayPath(state.cwd, join(state.runDir, 'RUN_STATE.json')) },
    { label: 'PLAN_PROGRESS.md', path: toDisplayPath(state.cwd, state.progressMarkdownPath) },
    { label: 'plan-progress.json', path: toDisplayPath(state.cwd, state.progressJsonPath) },
    { label: 'REVIEW.md', path: toDisplayPath(state.cwd, state.reviewMarkdownPath) },
    { label: 'RECOVERY.md', path: toDisplayPath(state.cwd, state.recoveryMarkdownPath) },
    { label: REVIEWER_CONTEXT_JSON, path: toDisplayPath(state.cwd, join(state.runDir, REVIEWER_CONTEXT_JSON)) },
    { label: REVIEWER_CONTEXT_MARKDOWN, path: toDisplayPath(state.cwd, join(state.runDir, REVIEWER_CONTEXT_MARKDOWN)) },
  ];
}

export function renderReviewerContextMarkdown(packet: Omit<ReviewerContextPacket, 'promptMarkdown'>) {
  const scopeLines = packet.completedScopes.length
    ? packet.completedScopes.map((scope) =>
      `- Scope ${scope.number}: ${scope.result}; marker=${scope.marker}; finalCommit=${scope.finalCommit ?? 'none'}; reviewRounds=${scope.reviewRounds}; findings=${scope.findings}; residualDebt=${scope.residualReviewDebt}; summary=${scope.summary ?? 'none'}`,
    )
    : ['- none'];
  const findingLines = packet.findings.length
    ? packet.findings.map((finding) =>
      `- ${finding.canonicalId} (${finding.id}): ${finding.severity}/${finding.status}; source=${finding.source}; files=${finding.files.join(', ') || 'none'}; claim=${finding.claim}; requiredAction=${finding.requiredAction}`,
    )
    : ['- none'];
  const inheritedDebtLines = packet.inheritedPlanReviewDebt.length
    ? packet.inheritedPlanReviewDebt.map((item) =>
      `- ${item.canonicalId}: findingClass=${item.findingClass ?? 'n/a'}; originRound=${item.originRound ?? 'n/a'}; claim=${item.claim}; requiredAction=${item.requiredAction}`,
    )
    : ['- none'];
  const finalCompletion = packet.finalCompletion;

  return [
    '# Reviewer Continuity Context',
    '',
    'Use this bounded Neal-owned context for continuity only. Inspect cited artifacts or repository state directly before making findings.',
    '',
    '## Run',
    `- id: ${packet.run.id}`,
    `- plan: ${packet.run.planDoc}`,
    `- mode: ${packet.run.topLevelMode}`,
    `- executionShape: ${packet.run.executionShape ?? 'pending'}`,
    `- phase: ${packet.run.phase}`,
    `- status: ${packet.run.status}`,
    `- currentScope: ${packet.run.currentScopeNumber}`,
    '',
    '## Completed Scopes',
    ...scopeLines,
    packet.limits.truncatedCompletedScopes
      ? `- truncated: showing latest ${packet.completedScopes.length} of ${packet.limits.completedScopeCount}`
      : '- truncated: no',
    '',
    '## Findings',
    ...findingLines,
    packet.limits.truncatedFindings
      ? `- truncated: showing latest ${packet.findings.length} of ${packet.limits.findingCount}`
      : '- truncated: no',
    '',
    '## Inherited Plan-Review Debt',
    ...inheritedDebtLines,
    '',
    '## Final Completion',
    finalCompletion
      ? `- state=${finalCompletion.state}; effectiveAction=${finalCompletion.effectiveAction ?? 'none'}; hasSummary=${finalCompletion.hasSummary}; hasReviewVerdict=${finalCompletion.hasReviewVerdict}; continueExecutionCount=${finalCompletion.continueExecutionCount}; capReached=${finalCompletion.continueExecutionCapReached}`
      : '- not applicable',
    '',
    '## Citations',
    ...packet.citations.map((citation) => `- ${citation.label}: ${citation.path}`),
  ].join('\n');
}

function runIdFromDir(runDir: string) {
  const normalized = runDir.replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function toDisplayPath(cwd: string, path: string) {
  const absolutePath = resolve(path);
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return relativePath || '.';
  }
  return absolutePath;
}
