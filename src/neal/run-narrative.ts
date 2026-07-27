import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  RecentEvent,
  RunNarrativeArtifactAvailability,
  RunNarrativeArtifactPaths,
  RunNarrativeBenchmarkTrace,
  RunNarrativeSummary,
} from './run-narrative-types.js';
import { isSupportedNealActionType, type SuggestedNealAction } from './context/shared.js';

import { buildBlockedGuidance, type BlockedGuidance } from './blocked-guidance.js';
import { getRunStatePath, loadState } from './state.js';
import { writeTextAtomic } from './atomic-write.js';
import { buildStatusSnapshot, summarizeDerivedPlan, type NealStatusSnapshot as StatusSnapshot } from './status.js';
import { formatMaybePublicPhase } from './phase-display.js';
import { decideResumeAction, type ResumeDecision } from './resume-decision.js';
import { formatPublicRunStatus, getRunDisplayStatus, type RunDisplayStatus } from './run-status.js';
import { getFinalCompletionView } from './state-views.js';
import type { OrchestrationState } from './types.js';
import { extractCommandResults } from './verification-events.js';

const EVENT_TAIL_BYTES = 128 * 1024;
const OPTIONAL_JSON_BYTES = 128 * 1024;
const MAX_HEADLINE_LENGTH = 180;
const MAX_SUMMARY_LENGTH = 320;
const MAX_COMMAND_LENGTH = 160;
const MAX_LIST_ITEMS = 5;
const MAX_WARNINGS = 10;
const RUN_NARRATIVE_JSON = 'RUN_NARRATIVE.json';
const RUN_NARRATIVE_MARKDOWN = 'RUN_NARRATIVE.md';
const RUN_NARRATIVE_UPDATED_EVENT = 'narrative.updated';

export type RunNarrativeArtifactExcerpt = {
  label: string;
  content: string;
};

export type BuildRunNarrativeSummaryArgs = {
  cwd: string;
  statePath: string;
  state?: OrchestrationState;
  snapshot?: StatusSnapshot | null;
  eventTail?: RecentEvent[] | null;
  artifactExcerpts?: RunNarrativeArtifactExcerpt[];
  now?: Date;
  preferArtifact?: boolean;
};

type ProgressRecord = Record<string, unknown> | null;

export function getRunNarrativeJsonArtifactPath(runDir: string) {
  return join(runDir, RUN_NARRATIVE_JSON);
}

export function getRunNarrativeMarkdownArtifactPath(runDir: string) {
  return join(runDir, RUN_NARRATIVE_MARKDOWN);
}

export async function buildRunNarrativeSummary(args: BuildRunNarrativeSummaryArgs): Promise<RunNarrativeSummary> {
  const cwd = resolve(args.cwd);
  const statePath = resolvePath(cwd, args.statePath);
  const generatedAt = (args.now ?? new Date()).toISOString();
  const warnings: string[] = [];
  const state = args.state ?? await loadNarrativeState(statePath, warnings);

  if (!state) {
    const artifacts = await buildArtifactInfo(cwd, null, statePath, warnings);
    return {
      version: 1,
      generatedAt,
      headline: 'Run state is unavailable.',
      run: {
        cwd,
        statePath: toDisplayPath(cwd, statePath),
        runDir: null,
        runDirName: null,
        planPath: null,
        topLevelMode: null,
        phase: null,
        status: null,
        effectiveStatus: null,
        waitingForOperatorGuidance: false,
        pendingOperatorGuidance: false,
        currentScopeNumber: null,
        derivedPlan: null,
        manualGate: null,
        health: null,
      },
      latestActivity: {
        at: null,
        type: null,
        summary: 'No run state could be read.',
        source: null,
      },
      findings: emptyFindingCounts(),
      verification: {
        commands: [],
        lastCommand: null,
        summary: 'No verification commands found.',
        source: null,
      },
      blocker: {
        active: false,
        summary: null,
        technicalDetails: [],
        sources: [],
      },
      benchmarkTrace: unavailableBenchmarkTrace(null),
      recommendedAction: null,
      artifactAvailability: artifacts.availability,
      artifactPaths: artifacts.paths,
      warnings: boundList(warnings, MAX_WARNINGS),
    };
  }

  const eventTail = filterNarrativeInternalEvents(
    args.eventTail ?? await readNarrativeEventTail(join(state.runDir, 'events.ndjson'), warnings),
  );
  const progress = await readProgressJson(state.progressJsonPath, warnings);
  const artifactExcerpts = args.artifactExcerpts ?? [];
  const sourceDigest = buildRunNarrativeSourceDigest({
    state,
    eventTail,
    progress,
    artifactExcerpts,
  });

  const snapshot = args.snapshot === undefined
    ? await buildSnapshot(cwd, statePath, warnings, args.now)
    : args.snapshot;

  if (args.preferArtifact !== false) {
    const artifact = await readFreshRunNarrativeArtifact({
      cwd,
      state,
      sourceDigest,
      snapshot,
      warnings,
    });
    if (artifact) {
      return artifact;
    }
  }

  const displayStatus = getNarrativeDisplayStatus(state, snapshot);
  const artifacts = await buildArtifactInfo(cwd, state, statePath, warnings);
  const latestActivity = buildLatestActivity(state, snapshot, eventTail);
  const findings = snapshot?.findings ?? summarizeStateFindings(state);
  const verification = buildVerificationSummary(state, progress, eventTail);
  const blockedGuidance = snapshot?.blockedGuidance ?? buildBlockedGuidance({ state, runId: basename(state.runDir) });
  const blocker = buildBlockerSummary(state, progress, eventTail, artifactExcerpts, blockedGuidance);
  const resumeDecision = snapshot?.resumeDecision ?? decideResumeAction({
    state,
    selectedRunId: basename(state.runDir),
    statePath: getRunStatePath(state.runDir),
  });
  const recommendedAction = buildRecommendedAction({
    cwd,
    state,
    artifactAvailability: artifacts.availability,
    resumeDecision,
    blockedGuidance,
  });
  const derivedPlan = snapshot?.derivedPlan ?? summarizeDerivedPlan(state);
  const manualGate = snapshot?.manualGate ?? summarizeManualGate(state);
  const benchmarkTrace = buildBenchmarkTrace({
    state,
    snapshot,
    displayStatus,
  });

  return {
    version: 1,
    generatedAt,
    sourceDigest,
    headline: buildHeadline(state, snapshot, displayStatus, blocker, latestActivity),
    run: {
      cwd: state.cwd,
      statePath: toDisplayPath(cwd, statePath),
      runDir: toDisplayPath(cwd, state.runDir),
      runDirName: basename(state.runDir),
      planPath: toDisplayPath(cwd, state.planDoc),
      topLevelMode: state.topLevelMode,
      phase: state.phase,
      status: state.status,
      effectiveStatus: displayStatus.effectiveStatus,
      waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
      pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
      currentScopeNumber: state.currentScopeNumber,
      derivedPlan,
      manualGate,
      health: snapshot?.health ?? null,
    },
    latestActivity,
    findings,
    verification,
    blocker,
    benchmarkTrace,
    recommendedAction,
    artifactAvailability: artifacts.availability,
    artifactPaths: artifacts.paths,
    warnings: boundList(warnings, MAX_WARNINGS),
  };
}

export function renderRunNarrativeMarkdown(summary: RunNarrativeSummary) {
  const lines = [
    '# Run Narrative',
    '',
    '## Metadata',
    `- Generated at: ${summary.generatedAt}`,
    `- Source digest: ${summary.sourceDigest ?? 'none'}`,
    `- Run directory: ${summary.run.runDir ?? 'unknown'}`,
    `- State path: ${summary.run.statePath}`,
    `- Plan: ${summary.run.planPath ?? 'unknown'}`,
    `- Mode: ${summary.run.topLevelMode ?? 'unknown'}`,
    `- Status: ${summary.run.status ?? 'unknown'}`,
    `- Effective status: ${summary.run.effectiveStatus ?? 'unknown'}`,
    `- Waiting for operator guidance: ${summary.run.waitingForOperatorGuidance ? 'yes' : 'no'}`,
    `- Pending operator guidance: ${summary.run.pendingOperatorGuidance ? 'yes' : 'no'}`,
    `- Step: ${formatMaybePublicPhase(summary.run.phase) ?? 'unknown'}`,
    `- Current scope: ${summary.run.currentScopeNumber ?? 'none'}`,
    `- Derived plan: ${formatDerivedPlanMetadata(summary.run.derivedPlan)}`,
    `- Manual gate: ${formatManualGateMetadata(summary.run.manualGate)}`,
    `- Health: ${summary.run.health?.classification ?? 'unknown'}`,
    '',
    '## Benchmark Trace',
    `- Public status: ${summary.benchmarkTrace.publicStatus ?? 'unknown'}`,
    `- Public phase: ${summary.benchmarkTrace.publicPhase ?? 'unknown'}`,
    `- Patch eligible: ${summary.benchmarkTrace.patch.defaultSubmissionEligible ? 'yes' : 'no'} - ${summary.benchmarkTrace.patch.reason}`,
    `- Patch source: ${summary.benchmarkTrace.patch.source}`,
    `- Patch range: ${formatBenchmarkPatchRange(summary.benchmarkTrace)}`,
    `- Changed files: ${summary.benchmarkTrace.patch.changedFileCount ?? 'unknown'}`,
    `- Squash replacement commit: ${summary.benchmarkTrace.squash.replacementCommit ?? 'none'}`,
    `- Provider error: ${formatBenchmarkProviderError(summary.benchmarkTrace.providerError)}`,
    `- Neal build: ${formatBenchmarkBuild(summary.benchmarkTrace)}`,
    `- Planner: ${formatBenchmarkAgentRole(summary.benchmarkTrace.agent.planner)}`,
    `- Coder: ${formatBenchmarkAgentRole(summary.benchmarkTrace.agent.coder)}`,
    `- Reviewer: ${formatBenchmarkAgentRole(summary.benchmarkTrace.agent.reviewer)}`,
    `- Public trace artifact: ${formatRunNarrativeMarkdownArtifact(summary)}`,
    `- Status command: ${formatStatusJsonCommand(summary)}`,
    '',
    '## Headline',
    summary.headline,
    '',
    '## Latest Activity',
    `- At: ${summary.latestActivity.at ?? 'unknown'}`,
    `- Type: ${summary.latestActivity.type ?? 'unknown'}`,
    `- Source: ${summary.latestActivity.source ?? 'unknown'}`,
    `- Summary: ${summary.latestActivity.summary}`,
    '',
    '## Findings',
    `- Total: ${summary.findings.total}`,
    `- Open blocking: ${summary.findings.openBlocking}`,
    `- Open non-blocking: ${summary.findings.openNonBlocking}`,
    `- Fixed: ${summary.findings.fixed}`,
    `- Rejected: ${summary.findings.rejected}`,
    `- Deferred: ${summary.findings.deferred}`,
    '',
    '## Verification',
    `- Summary: ${summary.verification.summary}`,
    `- Last command: ${summary.verification.lastCommand ?? 'none'}`,
    `- Source: ${summary.verification.source ?? 'unknown'}`,
  ];

  if (summary.verification.commands.length > 0) {
    lines.push('- Commands:');
    for (const command of summary.verification.commands) {
      lines.push(`  - ${command}`);
    }
  } else {
    lines.push('- Commands: none');
  }

  lines.push(
    '',
    '## Blocker',
    `- Active: ${summary.blocker.active ? 'yes' : 'no'}`,
    `- Summary: ${summary.blocker.summary ?? 'none'}`,
  );

  if (summary.blocker.sources.length > 0) {
    lines.push('- Sources:');
    for (const source of summary.blocker.sources) {
      lines.push(`  - ${source}`);
    }
  } else {
    lines.push('- Sources: none');
  }
  if (summary.blocker.technicalDetails.length > 0) {
    lines.push('- Technical details:');
    for (const detail of summary.blocker.technicalDetails) {
      lines.push(`  - ${detail}`);
    }
  }

  lines.push('', '## Recommended Action');
  if (summary.recommendedAction) {
    lines.push(
      `- Type: ${summary.recommendedAction.type}`,
      `- Label: ${summary.recommendedAction.label}`,
      `- Rationale: ${summary.recommendedAction.rationale ?? 'none'}`,
      `- Run directory: ${summary.recommendedAction.target.runDirName ?? 'none'}`,
      `- State path: ${summary.recommendedAction.target.statePath ?? 'none'}`,
      `- Plan path: ${summary.recommendedAction.target.planPath ?? 'none'}`,
      `- Artifact label: ${summary.recommendedAction.target.artifactLabel ?? 'none'}`,
    );
  } else {
    lines.push('- Type: none');
  }

  lines.push('', '## Artifact References');
  for (const [key, artifactPath] of Object.entries(summary.artifactPaths)) {
    const available = summary.artifactAvailability[key as keyof RunNarrativeSummary['artifactAvailability']];
    lines.push(`- ${key}: ${available ? artifactPath ?? 'available' : 'missing'}`);
  }

  lines.push('', '## Warnings');
  if (summary.warnings.length > 0) {
    for (const warning of summary.warnings) {
      lines.push(`- ${warning}`);
    }
  } else {
    lines.push('- none');
  }

  return `${lines.join('\n')}\n`;
}

export async function writeRunNarrativeArtifacts(state: OrchestrationState) {
  const statePath = getRunStatePath(state.runDir);
  await mkdir(state.runDir, { recursive: true });
  await appendFile(join(state.runDir, 'events.ndjson'), '', 'utf8');
  const summary = await buildRunNarrativeSummary({
    cwd: state.cwd,
    statePath,
    state,
    now: dateFromIso(state.updatedAt) ?? new Date(),
    preferArtifact: false,
  });
  const jsonPath = getRunNarrativeJsonArtifactPath(state.runDir);
  const markdownPath = getRunNarrativeMarkdownArtifactPath(state.runDir);
  const existingSummary = await readStoredRunNarrativeArtifact(jsonPath, []);
  const summaryToWrite =
    existingSummary?.sourceDigest && existingSummary.sourceDigest === summary.sourceDigest
      ? { ...summary, generatedAt: existingSummary.generatedAt }
      : summary;
  const nextJson = serializeRunNarrativeSummary(summaryToWrite);
  const nextMarkdown = renderRunNarrativeMarkdown(summaryToWrite);
  const existingJson = await readOptionalText(jsonPath);
  const existingMarkdown = await readOptionalText(markdownPath);

  if (existingJson === nextJson && existingMarkdown === nextMarkdown) {
    return {
      changed: false,
      jsonPath,
      markdownPath,
      summary: summaryToWrite,
    };
  }

  await writeTextAtomic(jsonPath, nextJson);
  await writeTextAtomic(markdownPath, nextMarkdown);
  await appendNarrativeUpdatedEvent(state, {
    jsonPath,
    markdownPath,
    summary: summaryToWrite,
  });

  return {
    changed: true,
    jsonPath,
    markdownPath,
    summary: summaryToWrite,
  };
}

async function loadNarrativeState(statePath: string, warnings: string[]): Promise<OrchestrationState | null> {
  try {
    return await loadState(statePath);
  } catch (error) {
    warnings.push(`RUN_STATE.json: ${error instanceof Error ? error.message : 'failed to read state'}`);
    return null;
  }
}

async function buildSnapshot(cwd: string, statePath: string, warnings: string[], now?: Date): Promise<StatusSnapshot | null> {
  try {
    return await buildStatusSnapshot({ cwd, statePath, now });
  } catch (error) {
    warnings.push(`status snapshot: ${error instanceof Error ? error.message : 'failed to build snapshot'}`);
    return null;
  }
}

function buildHeadline(
  state: OrchestrationState,
  snapshot: StatusSnapshot | null | undefined,
  displayStatus: RunDisplayStatus,
  blocker: RunNarrativeSummary['blocker'],
  latestActivity: RunNarrativeSummary['latestActivity'],
) {
  const derivedPlan = snapshot?.derivedPlan ?? summarizeDerivedPlan(state);
  const unexecutedDerivedPlanInDoneState = Boolean(
    derivedPlan &&
    !derivedPlan.executing &&
    (state.status === 'done' || state.phase === 'done'),
  );
  const status = displayStatus.waitingForOperatorGuidance
    ? 'waiting for operator guidance'
    : state.status === 'done'
      ? 'done'
      : displayStatus.effectiveStatus;
  const scope = describeNarrativeScope(state, derivedPlan);
  const health = snapshot?.health.classification;
  const basis = blocker.active && blocker.summary
    ? blocker.summary
    : latestActivity.summary;
  if (unexecutedDerivedPlanInDoneState && derivedPlan) {
    return truncateText(
      `Neal has an unexecuted ${derivedPlan.status ?? 'unknown'} derived plan for parent scope ${
        derivedPlan.parentScopeNumber ?? state.currentScopeNumber
      }${health ? ` with ${health} health` : ''}: ${basis}`,
      MAX_HEADLINE_LENGTH,
    );
  }
  return truncateText(
    `Neal ${status} in ${scope}${health ? ` with ${health} health` : ''}: ${basis}`,
    MAX_HEADLINE_LENGTH,
  );
}

function describeNarrativeScope(state: OrchestrationState, derivedPlan: StatusSnapshot['derivedPlan']) {
  if (!derivedPlan) {
    return state.status === 'done' ? 'completed' : `scope ${state.currentScopeNumber}`;
  }

  const parentScopeNumber = derivedPlan.parentScopeNumber ?? state.currentScopeNumber;
  if (derivedPlan.reviewActive) {
    return `derived-plan review for parent scope ${parentScopeNumber}`;
  }
  if (derivedPlan.acceptedAwaitingExecution) {
    return `accepted derived plan awaiting execution for parent scope ${parentScopeNumber}`;
  }
  if (derivedPlan.executing) {
    return `derived scope ${parentScopeNumber}.${derivedPlan.scopeIndex}`;
  }
  if (derivedPlan.abandoned) {
    return `abandoned derived plan for parent scope ${parentScopeNumber}`;
  }
  return `derived plan for parent scope ${parentScopeNumber}`;
}

function getNarrativeDisplayStatus(state: OrchestrationState, snapshot: StatusSnapshot | null | undefined) {
  if (snapshot) {
    return {
      effectiveStatus: snapshot.effectiveStatus,
      waitingForOperatorGuidance: snapshot.waitingForOperatorGuidance,
      pendingOperatorGuidance: snapshot.pendingOperatorGuidance,
    };
  }

  return getRunDisplayStatus(state);
}

function buildLatestActivity(
  state: OrchestrationState,
  snapshot: StatusSnapshot | null | undefined,
  eventTail: RecentEvent[],
): RunNarrativeSummary['latestActivity'] {
  if (snapshot?.lastMeaningfulEvent) {
    return {
      at: snapshot.lastMeaningfulEventAt,
      type: snapshot.lastMeaningfulEvent.type,
      summary: truncateText(snapshot.lastMeaningfulEvent.summary, MAX_SUMMARY_LENGTH),
      source: 'status snapshot',
    };
  }

  const latestEvent = [...eventTail].reverse().find((event) => event.ts || event.type);
  if (latestEvent) {
    return {
      at: latestEvent.ts,
      type: latestEvent.type,
      summary: summarizeEvent(latestEvent),
      source: 'events.ndjson',
    };
  }

  return {
    at: state.updatedAt,
    type: 'state.updated',
    summary: 'No run events found; using the latest state timestamp.',
    source: 'RUN_STATE.json',
  };
}

function buildVerificationSummary(
  state: OrchestrationState,
  progress: ProgressRecord,
  eventTail: RecentEvent[],
): RunNarrativeSummary['verification'] {
  const commands = boundList(uniquePreservingOrder(
    extractCommandResults(eventTail)
      .map((result) => result.command),
  ).slice(-MAX_LIST_ITEMS).map((command) => truncateText(command, MAX_COMMAND_LENGTH)), MAX_LIST_ITEMS);
  const lastCommand = commands.at(-1) ?? null;
  if (lastCommand) {
    return {
      commands,
      lastCommand,
      summary: `Last observed command: ${lastCommand}`,
      source: 'events.ndjson',
    };
  }

  const progressFinalSummary = stringValue(asRecord(progress?.finalCompletionSummary)?.verificationSummary);
  const stateFinalSummary = getFinalCompletionView(state)?.summary?.verificationSummary ?? null;
  const summary = progressFinalSummary ?? stateFinalSummary;
  if (summary) {
    return {
      commands: [],
      lastCommand: null,
      summary: truncateText(summary, MAX_SUMMARY_LENGTH),
      source: progressFinalSummary ? 'plan-progress.json' : 'RUN_STATE.json',
    };
  }

  return {
    commands: [],
    lastCommand: null,
    summary: 'No verification commands found.',
    source: null,
  };
}

function buildBenchmarkTrace(args: {
  state: OrchestrationState;
  snapshot: StatusSnapshot | null | undefined;
  displayStatus?: RunDisplayStatus;
}): RunNarrativeBenchmarkTrace {
  const snapshot = args.snapshot;
  if (snapshot) {
    return {
      publicStatus: snapshot.publicStatus,
      publicPhase: snapshot.publicPhase,
      patch: {
        defaultSubmissionEligible: snapshot.patch.defaultSubmissionEligible,
        reason: truncateText(snapshot.patch.reason, MAX_SUMMARY_LENGTH),
        source: snapshot.patch.source,
        baseCommit: snapshot.patch.baseCommit,
        headCommit: snapshot.patch.headCommit,
        range: snapshot.patch.range,
        changedFileCount: snapshot.patch.changedFileCount,
      },
      squash: {
        replacementCommit: snapshot.squash.replacementCommit,
      },
      providerError: snapshot.providerError
        ? {
            provider: snapshot.providerError.provider,
            role: snapshot.providerError.role,
            kind: snapshot.providerError.kind,
            message: truncateText(snapshot.providerError.message, MAX_SUMMARY_LENGTH),
          }
        : null,
      build: {
        packageVersion: snapshot.build.packageVersion,
        sourceGitSha: snapshot.build.sourceGitSha,
        nodeVersion: snapshot.build.nodeVersion,
      },
      agent: agentTraceFromConfig(snapshot.build.agentConfig),
    };
  }

  const displayStatus = args.displayStatus ?? getRunDisplayStatus(args.state);
  const baseCommit = args.state.initialBaseCommit ?? args.state.baseCommit;
  const headCommit = args.state.finalCommit;
  const patchSource: RunNarrativeBenchmarkTrace['patch']['source'] = baseCommit || headCommit ? 'final_commit' : 'none';
  return {
    ...unavailableBenchmarkTrace(args.state.agentConfig),
    publicStatus: formatPublicRunStatus(displayStatus),
    publicPhase: formatMaybePublicPhase(args.state.phase) ?? args.state.phase,
    patch: {
      defaultSubmissionEligible: false,
      reason: 'Status snapshot unavailable; patch policy could not be evaluated.',
      source: patchSource,
      baseCommit,
      headCommit,
      range: baseCommit && headCommit ? `${baseCommit}..${headCommit}` : null,
      changedFileCount: null,
    },
  };
}

function unavailableBenchmarkTrace(agentConfig: OrchestrationState['agentConfig'] | null): RunNarrativeBenchmarkTrace {
  return {
    publicStatus: null,
    publicPhase: null,
    patch: {
      defaultSubmissionEligible: false,
      reason: 'Status snapshot unavailable; patch policy could not be evaluated.',
      source: 'none',
      baseCommit: null,
      headCommit: null,
      range: null,
      changedFileCount: null,
    },
    squash: {
      replacementCommit: null,
    },
    providerError: null,
    build: {
      packageVersion: null,
      sourceGitSha: null,
      nodeVersion: null,
    },
    agent: agentTraceFromConfig(agentConfig),
  };
}

function agentTraceFromConfig(agentConfig: OrchestrationState['agentConfig'] | null): RunNarrativeBenchmarkTrace['agent'] {
  return {
    planner: {
      provider: agentConfig?.planner.provider ?? null,
      model: agentConfig?.planner.model ?? null,
    },
    coder: {
      provider: agentConfig?.coder.provider ?? null,
      model: agentConfig?.coder.model ?? null,
    },
    reviewer: {
      provider: agentConfig?.reviewer.provider ?? null,
      model: agentConfig?.reviewer.model ?? null,
    },
  };
}

function buildBlockerSummary(
  state: OrchestrationState,
  progress: ProgressRecord,
  eventTail: RecentEvent[],
  artifactExcerpts: RunNarrativeArtifactExcerpt[],
  guidance: BlockedGuidance | null,
): RunNarrativeSummary['blocker'] {
  const candidates: { summary: string | null; source: string }[] = [
    {
      summary: guidance?.category === 'scope_accounting_guardrail' ? guidance.summary : null,
      source: 'blocked guidance',
    },
    {
      summary: state.interactiveBlockedRecovery?.blockedReason ?? null,
      source: 'RUN_STATE.json interactive recovery',
    },
    {
      summary: currentOrLatestBlockedCompletedScopeBlocker(state),
      source: 'RUN_STATE.json completed scopes',
    },
    {
      summary: firstOpenBlockingFinding(state),
      source: 'RUN_STATE.json findings',
    },
    {
      summary: stringValue(asRecord(progress?.interactiveBlockedRecovery)?.blockedReason),
      source: 'plan-progress.json interactive recovery',
    },
    {
      summary: latestEventBlocker(eventTail),
      source: 'events.ndjson',
    },
    {
      summary: firstArtifactBlockerLine(artifactExcerpts),
      source: 'artifact excerpt',
    },
  ];
  const first = candidates.find((candidate) => candidate.summary);
  const sources = candidates
    .filter((candidate) => candidate.summary)
    .map((candidate) => candidate.source);
  const active =
    Boolean(first?.summary) &&
    (state.status === 'blocked' ||
      state.status === 'failed' ||
      state.phase === 'blocked' ||
      state.phase === 'interactive_blocked_recovery' ||
      state.findings.some((finding) => finding.status === 'open' && finding.severity === 'blocking'));

  return {
    active,
    summary: first?.summary ? truncateText(first.summary, MAX_SUMMARY_LENGTH) : null,
    technicalDetails: boundList(
      (guidance?.category === 'scope_accounting_guardrail' ? guidance.technicalDetails : [])
        .map((detail) => truncateText(detail, MAX_SUMMARY_LENGTH)),
      MAX_LIST_ITEMS,
    ),
    sources: boundList(uniquePreservingOrder(sources), MAX_LIST_ITEMS),
  };
}

function buildRecommendedAction(args: {
  cwd: string;
  state: OrchestrationState;
  artifactAvailability: RunNarrativeArtifactAvailability;
  resumeDecision: ResumeDecision;
  blockedGuidance: BlockedGuidance | null;
}): SuggestedNealAction | null {
  const target = {
    runDirName: basename(args.state.runDir),
    statePath: toDisplayPath(args.cwd, getRunStatePath(args.state.runDir)),
  };

  switch (args.resumeDecision.kind) {
    case 'continue':
      return {
        type: 'resume',
        label: 'Resume selected run',
        target,
        rationale: args.resumeDecision.reason,
      };
    case 'pending_message':
      return {
        type: 'resume',
        label: 'Resume recovery guidance',
        target,
        rationale: args.resumeDecision.reason,
      };
    case 'needs_message':
      return {
        type: 'recover',
        label: 'Record recovery guidance',
        target,
        rationale: args.blockedGuidance?.category === 'scope_accounting_guardrail'
          ? args.blockedGuidance.summary
          : args.resumeDecision.blocker,
      };
    case 'cannot_resume':
      return {
        type: 'recover',
        label: 'Inspect resume blocker',
        target,
        rationale: args.resumeDecision.reason,
      };
    case 'already_running':
      return {
        type: 'inspect_artifact',
        label: 'Inspect running run',
        target: {
          ...target,
          artifactLabel: 'RUN_STATE.json',
        },
        rationale: args.resumeDecision.reason,
      };
    case 'done':
      if (args.state.topLevelMode === 'plan' && args.state.status === 'done') {
        return {
          type: 'start_execution',
          label: 'Start execution from approved plan',
          target: {
            ...target,
            planPath: toDisplayPath(args.cwd, args.state.planDoc),
          },
          rationale: 'The selected planning run is complete.',
        };
      }
      return null;
  }

  if (args.artifactAvailability.runStateJson) {
    return {
      type: 'inspect_artifact',
      label: 'Inspect RUN_STATE.json',
      target: {
        ...target,
        artifactLabel: 'RUN_STATE.json',
      },
      rationale: 'Review the canonical run-local state before taking action.',
    };
  }

  return null;
}

async function readProgressJson(progressJsonPath: string, warnings: string[]): Promise<ProgressRecord> {
  const fileStat = await stat(progressJsonPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    warnings.push(`plan-progress.json: ${error.message}`);
    return null;
  });
  if (!fileStat) {
    return null;
  }
  if (!fileStat.isFile()) {
    warnings.push('plan-progress.json: not a file');
    return null;
  }
  if (fileStat.size > OPTIONAL_JSON_BYTES) {
    warnings.push(`plan-progress.json: exceeds ${OPTIONAL_JSON_BYTES} byte read limit`);
    return null;
  }
  try {
    return asRecord(JSON.parse(await readFile(progressJsonPath, 'utf8')));
  } catch (error) {
    warnings.push(`plan-progress.json: ${error instanceof Error ? error.message : 'failed to parse JSON'}`);
    return null;
  }
}

async function readNarrativeEventTail(eventsPath: string, warnings: string[]): Promise<RecentEvent[]> {
  let file;
  try {
    file = await open(eventsPath, 'r');
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    warnings.push(`events.ndjson: ${error instanceof Error ? error.message : 'failed to read events'}`);
    return [];
  }

  try {
    const fileStat = await file.stat();
    const length = Math.min(fileStat.size, EVENT_TAIL_BYTES);
    const start = fileStat.size - length;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (fileStat.size > EVENT_TAIL_BYTES) {
      text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as { ts?: unknown; type?: unknown; data?: unknown };
          if (typeof parsed.type !== 'string') {
            return [];
          }
          return [
            {
              ts: typeof parsed.ts === 'string' && Number.isFinite(Date.parse(parsed.ts))
                ? new Date(Date.parse(parsed.ts)).toISOString()
                : null,
              type: parsed.type,
              data: parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
                ? parsed.data as Record<string, unknown>
                : {},
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(-100);
  } finally {
    await file.close();
  }
}

async function buildArtifactInfo(
  cwd: string,
  state: OrchestrationState | null,
  statePath: string,
  warnings: string[],
): Promise<{ availability: RunNarrativeArtifactAvailability; paths: RunNarrativeArtifactPaths }> {
  const paths: Record<keyof RunNarrativeArtifactPaths, string | null> = {
    runStateJson: state ? getRunStatePath(state.runDir) : statePath,
    eventsNdjson: state ? join(state.runDir, 'events.ndjson') : null,
    planProgressJson: state?.progressJsonPath ?? null,
    reviewMarkdown: state?.reviewMarkdownPath ?? null,
    progressMarkdown: state?.progressMarkdownPath ?? null,
    recoveryMarkdown: state?.recoveryMarkdownPath ?? null,
    archivedReviewMarkdown: state?.archivedReviewPath ?? null,
    invalidDerivedPlanPayload: state ? getCurrentInvalidSplitPlanPayloadArtifactPath(state) : null,
  };
  const availabilityEntries = await Promise.all(
    Object.entries(paths).map(async ([key, artifactPath]) => {
      if (!artifactPath) {
        return [key, false] as const;
      }
      const fileStat = await stat(artifactPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          warnings.push(`${basename(artifactPath)}: ${error.message}`);
        }
        return null;
      });
      return [key, fileStat?.isFile() ?? false] as const;
    }),
  );

  return {
    availability: Object.fromEntries(availabilityEntries) as RunNarrativeArtifactAvailability,
    paths: Object.fromEntries(
      Object.entries(paths).map(([key, artifactPath]) => [key, artifactPath ? toDisplayPath(cwd, artifactPath) : null]),
    ) as RunNarrativeArtifactPaths,
  };
}

async function readFreshRunNarrativeArtifact(args: {
  cwd: string;
  state: OrchestrationState;
  sourceDigest: string;
  snapshot: StatusSnapshot | null | undefined;
  warnings: string[];
}): Promise<RunNarrativeSummary | null> {
  const jsonPath = getRunNarrativeJsonArtifactPath(args.state.runDir);
  const summary = await readStoredRunNarrativeArtifact(jsonPath, args.warnings);
  if (!summary) {
    return null;
  }
  if (summary.sourceDigest !== args.sourceDigest) {
    return null;
  }
  if (summary.run.runDirName !== basename(args.state.runDir)) {
    return null;
  }
  if (summary.run.status !== args.state.status || summary.run.phase !== args.state.phase) {
    return null;
  }
  if (summary.run.currentScopeNumber !== args.state.currentScopeNumber) {
    return null;
  }
  if (!summary.run.health) {
    return null;
  }
  if (
    args.state.topLevelMode === 'execute' &&
    args.state.status === 'done' &&
    summary.recommendedAction?.type === 'squash'
  ) {
    return null;
  }
  const runStatePath = toDisplayPath(args.cwd, getRunStatePath(args.state.runDir));
  const snapshotDisplayStatus = args.snapshot
    ? getNarrativeDisplayStatus(args.state, args.snapshot)
    : null;
  const benchmarkTrace = buildBenchmarkTrace({
    state: args.state,
    snapshot: args.snapshot,
    displayStatus: snapshotDisplayStatus ?? undefined,
  });
  return {
    ...summary,
    benchmarkTrace,
    run: {
      ...summary.run,
      statePath: runStatePath,
      ...(snapshotDisplayStatus
        ? {
            effectiveStatus: snapshotDisplayStatus.effectiveStatus,
            waitingForOperatorGuidance: snapshotDisplayStatus.waitingForOperatorGuidance,
            pendingOperatorGuidance: snapshotDisplayStatus.pendingOperatorGuidance,
          }
        : {}),
      derivedPlan: args.snapshot ? args.snapshot.derivedPlan : summary.run.derivedPlan,
      manualGate: args.snapshot ? args.snapshot.manualGate : summary.run.manualGate,
      health: args.snapshot ? args.snapshot.health : summary.run.health,
    },
  };
}

async function readStoredRunNarrativeArtifact(
  jsonPath: string,
  warnings: string[],
): Promise<RunNarrativeSummary | null> {
  const fileStat = await stat(jsonPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      warnings.push(`${RUN_NARRATIVE_JSON}: ${error.message}`);
    }
    return null;
  });
  if (!fileStat) {
    return null;
  }
  if (!fileStat.isFile()) {
    warnings.push(`${RUN_NARRATIVE_JSON}: not a file`);
    return null;
  }
  if (fileStat.size > OPTIONAL_JSON_BYTES) {
    warnings.push(`${RUN_NARRATIVE_JSON}: exceeds ${OPTIONAL_JSON_BYTES} byte read limit`);
    return null;
  }
  try {
    return parseRunNarrativeArtifact(JSON.parse(await readFile(jsonPath, 'utf8')), warnings);
  } catch (error) {
    warnings.push(`${RUN_NARRATIVE_JSON}: ${error instanceof Error ? error.message : 'failed to parse JSON'}`);
    return null;
  }
}

function parseRunNarrativeArtifact(value: unknown, warnings: string[]): RunNarrativeSummary | null {
  const artifact = asRecord(value);
  if (!artifact) {
    warnings.push(`${RUN_NARRATIVE_JSON}: malformed narrative object`);
    return null;
  }
  if (artifact.version !== 1 || typeof artifact.generatedAt !== 'string') {
    warnings.push(`${RUN_NARRATIVE_JSON}: unsupported narrative artifact version`);
    return null;
  }
  if (typeof artifact.headline !== 'string' || !isRunInfo(artifact.run)) {
    warnings.push(`${RUN_NARRATIVE_JSON}: missing required narrative fields`);
    return null;
  }
  if (
    !isLatestActivity(artifact.latestActivity) ||
    !isFindings(artifact.findings) ||
    !isVerification(artifact.verification) ||
    !isBlocker(artifact.blocker) ||
    !isBenchmarkTrace(artifact.benchmarkTrace) ||
    !isArtifactAvailability(artifact.artifactAvailability) ||
    !isArtifactPaths(artifact.artifactPaths) ||
    !isStringArray(artifact.warnings)
  ) {
    warnings.push(`${RUN_NARRATIVE_JSON}: malformed narrative shape`);
    return null;
  }
  return {
    version: 1,
    generatedAt: artifact.generatedAt,
    sourceDigest: typeof artifact.sourceDigest === 'string' ? artifact.sourceDigest : undefined,
    headline: artifact.headline,
    run: {
      ...artifact.run,
      derivedPlan: parseDerivedPlanInfo(asRecord(artifact.run)?.derivedPlan),
      manualGate: parseManualGateInfo(asRecord(artifact.run)?.manualGate),
    },
    latestActivity: artifact.latestActivity,
    findings: artifact.findings,
    verification: artifact.verification,
    blocker: parseBlockerInfo(artifact.blocker),
    benchmarkTrace: artifact.benchmarkTrace,
    recommendedAction: isSuggestedAction(artifact.recommendedAction) ? artifact.recommendedAction : null,
    artifactAvailability: artifact.artifactAvailability,
    artifactPaths: artifact.artifactPaths,
    warnings: boundList(artifact.warnings, MAX_WARNINGS),
  };
}

function summarizeStateFindings(state: OrchestrationState): StatusSnapshot['findings'] {
  return {
    total: state.findings.length,
    openBlocking: state.findings.filter((finding) => finding.status === 'open' && finding.severity === 'blocking').length,
    openNonBlocking: state.findings.filter((finding) => finding.status === 'open' && finding.severity === 'non_blocking').length,
    fixed: state.findings.filter((finding) => finding.status === 'fixed').length,
    rejected: state.findings.filter((finding) => finding.status === 'rejected').length,
    deferred: state.findings.filter((finding) => finding.status === 'deferred').length,
  };
}

function emptyFindingCounts(): StatusSnapshot['findings'] {
  return {
    total: 0,
    openBlocking: 0,
    openNonBlocking: 0,
    fixed: 0,
    rejected: 0,
    deferred: 0,
  };
}

function firstOpenBlockingFinding(state: OrchestrationState): string | null {
  const finding = state.findings.find((item) => item.status === 'open' && item.severity === 'blocking');
  if (!finding) {
    return null;
  }
  return finding.evidence
    ? `${finding.claim} Evidence: ${finding.evidence}`
    : `${finding.claim} Required action: ${finding.requiredAction}`;
}


function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function currentOrLatestBlockedCompletedScopeBlocker(state: OrchestrationState): string | null {
  const blockedScopes = state.completedScopes.filter((scope) => scope.result === 'blocked' && scope.blocker);
  const currentScope = blockedScopes.find((scope) => scope.number === String(state.currentScopeNumber));
  return currentScope?.blocker ?? blockedScopes.at(-1)?.blocker ?? null;
}

function latestEventBlocker(eventTail: RecentEvent[]): string | null {
  for (const event of [...eventTail].reverse()) {
    if (event.type === 'split_plan.invalid_payload') {
      const validationErrors = stringArrayValue(event.data.validationErrors);
      const artifactPath = stringValue(event.data.invalidPayloadPath);
      const reason = validationErrors.length > 0
        ? `Invalid split-plan payload: ${validationErrors.join('; ')}`
        : 'Invalid split-plan payload was rejected by plan validation.';
      return artifactPath ? `${reason} Invalid payload artifact: ${artifactPath}` : reason;
    }
    const candidate =
      stringValue(event.data.blocker) ??
      stringValue(event.data.blockedReason) ??
      stringValue(event.data.reason) ??
      (event.type === 'phase.retry' || event.type === 'coder.timeout_cleanup' ? stringValue(event.data.message) : null);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function firstArtifactBlockerLine(excerpts: RunNarrativeArtifactExcerpt[]): string | null {
  for (const excerpt of excerpts) {
    const line = excerpt.content
      .split('\n')
      .map((item) => item.trim())
      .find((item) => /blocker|blocked reason|failed|failure/i.test(item));
    if (line) {
      return `${excerpt.label}: ${line}`;
    }
  }
  return null;
}

function summarizeEvent(event: RecentEvent): string {
  const candidate =
    stringValue(event.data.message) ??
    formatMaybePublicPhase(stringValue(event.data.phase)) ??
    formatMaybePublicPhase(stringValue(event.data.nextPhase)) ??
    stringValue(event.data.command) ??
    stringValue(event.data.label) ??
    event.type;
  return truncateText(candidate, MAX_SUMMARY_LENGTH);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function getCurrentInvalidSplitPlanPayloadArtifactPath(state: OrchestrationState) {
  return join(state.runDir, `SCOPE_${state.currentScopeNumber}_INVALID_DERIVED_PLAN.md`);
}

function uniquePreservingOrder(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function boundList<T>(values: T[], limit: number): T[] {
  return values.slice(0, Math.max(0, limit));
}

function formatDerivedPlanMetadata(derivedPlan: StatusSnapshot['derivedPlan']) {
  if (!derivedPlan) {
    return 'none';
  }

  const descriptors = [
    derivedPlan.status ?? 'unknown',
    derivedPlan.reviewActive ? 'review active' : null,
    derivedPlan.acceptedAwaitingExecution ? 'accepted awaiting execution' : null,
    derivedPlan.executing ? `executing scope ${derivedPlan.scopeIndex}` : null,
    derivedPlan.abandoned ? 'abandoned' : null,
    `parent scope ${derivedPlan.parentScopeNumber ?? 'unknown'}`,
    `path: ${derivedPlan.path}`,
  ].filter((item): item is string => Boolean(item));

  return descriptors.join(', ');
}

function summarizeManualGate(state: OrchestrationState): StatusSnapshot['manualGate'] {
  const gate = state.phase === 'manual_gate' ? state.manualGate : null;
  if (!gate) {
    return null;
  }
  return {
    id: gate.id,
    title: gate.title,
    reason: gate.reason,
    instructionsPath: gate.instructionsPath,
    lastCheckedAt: gate.lastCheckedAt,
    lastFailure: gate.lastFailure,
    resumeCommand: `neal resume --run ${basename(state.runDir)}`,
  };
}

function formatManualGateMetadata(manualGate: StatusSnapshot['manualGate']) {
  if (!manualGate) {
    return 'none';
  }
  const descriptors = [
    manualGate.id,
    manualGate.title,
    `instructions: ${manualGate.instructionsPath}`,
    `resume: ${manualGate.resumeCommand}`,
    `last checked: ${manualGate.lastCheckedAt ?? 'never'}`,
    manualGate.lastFailure ? `last failure: ${manualGate.lastFailure.checkName}` : null,
  ].filter((item): item is string => Boolean(item));
  return descriptors.join(', ');
}

function formatBenchmarkPatchRange(trace: RunNarrativeBenchmarkTrace) {
  if (trace.patch.range) {
    return trace.patch.range;
  }
  if (trace.patch.baseCommit || trace.patch.headCommit) {
    return `${trace.patch.baseCommit ?? 'unknown'}..${trace.patch.headCommit ?? 'unknown'}`;
  }
  return 'none';
}

function formatBenchmarkProviderError(providerError: RunNarrativeBenchmarkTrace['providerError']) {
  if (!providerError) {
    return 'none';
  }
  const provider = providerError.provider ?? 'unclassified';
  const role = providerError.role ?? 'unknown-role';
  const kind = providerError.kind ?? 'unclassified';
  return `${provider} ${role} ${kind} - ${providerError.message}`;
}

function formatBenchmarkBuild(trace: RunNarrativeBenchmarkTrace) {
  return `package ${trace.build.packageVersion ?? 'unknown'}, source ${
    trace.build.sourceGitSha ?? 'unknown'
  }, Node ${trace.build.nodeVersion ?? 'unknown'}`;
}

function formatBenchmarkAgentRole(role: RunNarrativeBenchmarkTrace['agent']['coder']) {
  return `${role.provider ?? 'unknown'}${role.model ? ` ${role.model}` : ' default model'}`;
}

function formatRunNarrativeMarkdownArtifact(summary: RunNarrativeSummary) {
  const runDir = summary.run.runDir?.replace(/\/+$/, '');
  return runDir ? `${runDir}/RUN_NARRATIVE.md` : 'RUN_NARRATIVE.md';
}

function formatStatusJsonCommand(summary: RunNarrativeSummary) {
  return summary.run.runDirName
    ? `neal status --json --run ${summary.run.runDirName}`
    : 'neal status --json';
}

function buildRunNarrativeSourceDigest(args: {
  state: OrchestrationState;
  eventTail: RecentEvent[];
  progress: ProgressRecord;
  artifactExcerpts: RunNarrativeArtifactExcerpt[];
}) {
  return createHash('sha256')
    .update(stableStringify({
      state: omitVolatileSourceFields(selectNarrativeSourceState(args.state)),
      eventTail: filterNarrativeInternalEvents(args.eventTail),
      progress: omitVolatileSourceFields(args.progress),
      artifactExcerpts: args.artifactExcerpts,
    }))
    .digest('hex');
}

function selectNarrativeSourceState(state: OrchestrationState) {
  const derivedPlan = summarizeDerivedPlan(state);
  const finalCompletion = getFinalCompletionView(state);
  return {
    cwd: state.cwd,
    runDir: state.runDir,
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    phase: state.phase,
    status: state.status,
    currentScopeNumber: state.currentScopeNumber,
    progressJsonPath: state.progressJsonPath,
    progressMarkdownPath: state.progressMarkdownPath,
    reviewMarkdownPath: state.reviewMarkdownPath,
    recoveryMarkdownPath: state.recoveryMarkdownPath,
    archivedReviewPath: state.archivedReviewPath,
    finalCommit: state.finalCommit,
    finalCompletionSummary: finalCompletion?.summary ?? null,
    derivedPlanPath: derivedPlan?.path ?? null,
    derivedFromScopeNumber: derivedPlan?.parentScopeNumber ?? null,
    derivedPlanStatus: derivedPlan?.status ?? null,
    derivedScopeIndex: derivedPlan?.scopeIndex ?? null,
    findings: state.findings,
    recentBlocks: state.recentBlocks,
    interactiveBlockedRecovery: state.interactiveBlockedRecovery,
    manualGate: state.manualGate,
  };
}

function filterNarrativeInternalEvents(events: RecentEvent[]) {
  return events.filter((event) => event.type !== RUN_NARRATIVE_UPDATED_EVENT);
}

function omitVolatileSourceFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitVolatileSourceFields);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'updatedAt' && key !== 'generatedAt' && key !== 'sourceDigest')
      .map(([key, item]) => [key, omitVolatileSourceFields(item)]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForStableStringify(item)]),
  );
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function resolvePath(cwd: string, value: string) {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function toDisplayPath(cwd: string, value: string) {
  const absolutePath = resolvePath(cwd, value);
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return relativePath || '.';
  }
  return absolutePath;
}

function serializeRunNarrativeSummary(summary: RunNarrativeSummary) {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function appendNarrativeUpdatedEvent(
  state: OrchestrationState,
  args: {
    jsonPath: string;
    markdownPath: string;
    summary: RunNarrativeSummary;
  },
) {
  const event = {
    ts: dateFromIso(state.updatedAt)?.toISOString() ?? new Date().toISOString(),
    type: RUN_NARRATIVE_UPDATED_EVENT,
    data: {
      jsonPath: toDisplayPath(state.cwd, args.jsonPath),
      markdownPath: toDisplayPath(state.cwd, args.markdownPath),
      headline: args.summary.headline,
      phase: state.phase,
      status: state.status,
      sourceDigest: args.summary.sourceDigest ?? null,
    },
  };
  await appendFile(join(state.runDir, 'events.ndjson'), `${JSON.stringify(event)}\n`, 'utf8');
}

function dateFromIso(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function parseDerivedPlanInfo(value: unknown): StatusSnapshot['derivedPlan'] {
  const record = asRecord(value);
  if (!record || !isDerivedPlanInfo(record)) {
    return null;
  }

  return record;
}

function parseManualGateInfo(value: unknown): StatusSnapshot['manualGate'] {
  const record = asRecord(value);
  if (!record || !isManualGateInfo(record)) {
    return null;
  }

  return record;
}

function parseBlockerInfo(value: unknown): RunNarrativeSummary['blocker'] {
  const record = asRecord(value);
  return {
    active: record?.active === true,
    summary: stringValue(record?.summary),
    technicalDetails: stringArrayValue(record?.technicalDetails),
    sources: stringArrayValue(record?.sources),
  };
}

function isDerivedPlanInfo(value: unknown): value is NonNullable<StatusSnapshot['derivedPlan']> {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.path === 'string' &&
      (typeof record.parentScopeNumber === 'number' || record.parentScopeNumber === null) &&
      (record.status === 'pending_review' ||
        record.status === 'accepted' ||
        record.status === 'rejected' ||
        record.status === null) &&
      (typeof record.scopeIndex === 'number' || record.scopeIndex === null) &&
      typeof record.reviewActive === 'boolean' &&
      typeof record.acceptedAwaitingExecution === 'boolean' &&
      typeof record.executing === 'boolean' &&
      typeof record.abandoned === 'boolean',
  );
}

function isManualGateInfo(value: unknown): value is NonNullable<StatusSnapshot['manualGate']> {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === 'string' &&
      typeof record.title === 'string' &&
      typeof record.reason === 'string' &&
      typeof record.instructionsPath === 'string' &&
      (typeof record.lastCheckedAt === 'string' || record.lastCheckedAt === null) &&
      typeof record.resumeCommand === 'string' &&
      (record.lastFailure === null || typeof record.lastFailure === 'object'),
  );
}

function isRunInfo(value: unknown): value is RunNarrativeSummary['run'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.cwd === 'string' &&
      typeof record.statePath === 'string' &&
      isNullableString(record.runDir) &&
      isNullableString(record.runDirName) &&
      isNullableString(record.planPath) &&
      (record.topLevelMode === 'plan' ||
        record.topLevelMode === 'execute' ||
        record.topLevelMode === null) &&
      isNullableString(record.phase) &&
      isNullableString(record.status) &&
      isNullableString(record.effectiveStatus) &&
      typeof record.waitingForOperatorGuidance === 'boolean' &&
      typeof record.pendingOperatorGuidance === 'boolean' &&
      (typeof record.currentScopeNumber === 'number' || record.currentScopeNumber === null) &&
      (record.health === null || typeof record.health === 'object'),
  );
}

function isLatestActivity(value: unknown): value is RunNarrativeSummary['latestActivity'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      isNullableString(record.at) &&
      isNullableString(record.type) &&
      typeof record.summary === 'string' &&
      isNullableString(record.source),
  );
}

function isFindings(value: unknown): value is RunNarrativeSummary['findings'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.total === 'number' &&
      typeof record.openBlocking === 'number' &&
      typeof record.openNonBlocking === 'number' &&
      typeof record.fixed === 'number' &&
      typeof record.rejected === 'number' &&
      typeof record.deferred === 'number',
  );
}

function isVerification(value: unknown): value is RunNarrativeSummary['verification'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      isStringArray(record.commands) &&
      isNullableString(record.lastCommand) &&
      typeof record.summary === 'string' &&
      isNullableString(record.source),
  );
}

function isBlocker(value: unknown): value is RunNarrativeSummary['blocker'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.active === 'boolean' &&
      isNullableString(record.summary) &&
      (record.technicalDetails === undefined || isStringArray(record.technicalDetails)) &&
      isStringArray(record.sources),
  );
}

function isBenchmarkTrace(value: unknown): value is RunNarrativeBenchmarkTrace {
  const record = asRecord(value);
  const patch = asRecord(record?.patch);
  const squash = asRecord(record?.squash);
  const providerError = asRecord(record?.providerError);
  const build = asRecord(record?.build);
  const agent = asRecord(record?.agent);
  const planner = asRecord(agent?.planner);
  const coder = asRecord(agent?.coder);
  const reviewer = asRecord(agent?.reviewer);
  return Boolean(
    record &&
      isNullableString(record.publicStatus) &&
      isNullableString(record.publicPhase) &&
      patch &&
      typeof patch.defaultSubmissionEligible === 'boolean' &&
      typeof patch.reason === 'string' &&
      (patch.source === 'squash_replacement' || patch.source === 'final_commit' || patch.source === 'none') &&
      isNullableString(patch.baseCommit) &&
      isNullableString(patch.headCommit) &&
      isNullableString(patch.range) &&
      (typeof patch.changedFileCount === 'number' || patch.changedFileCount === null) &&
      squash &&
      isNullableString(squash.replacementCommit) &&
      (record.providerError === null ||
        (providerError &&
          isNullableString(providerError.provider) &&
          isNullableString(providerError.role) &&
          isNullableString(providerError.kind) &&
          typeof providerError.message === 'string')) &&
      build &&
      isNullableString(build.packageVersion) &&
      isNullableString(build.sourceGitSha) &&
      isNullableString(build.nodeVersion) &&
      agent &&
      planner &&
      isNullableString(planner.provider) &&
      isNullableString(planner.model) &&
      coder &&
      isNullableString(coder.provider) &&
      isNullableString(coder.model) &&
      reviewer &&
      isNullableString(reviewer.provider) &&
      isNullableString(reviewer.model),
  );
}

function isArtifactAvailability(value: unknown): value is RunNarrativeSummary['artifactAvailability'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.runStateJson === 'boolean' &&
      typeof record.eventsNdjson === 'boolean' &&
      typeof record.planProgressJson === 'boolean' &&
      typeof record.reviewMarkdown === 'boolean' &&
      typeof record.progressMarkdown === 'boolean' &&
      typeof record.recoveryMarkdown === 'boolean' &&
      typeof record.archivedReviewMarkdown === 'boolean' &&
      typeof record.invalidDerivedPlanPayload === 'boolean',
  );
}

function isArtifactPaths(value: unknown): value is RunNarrativeSummary['artifactPaths'] {
  const record = asRecord(value);
  return Boolean(
    record &&
      isNullableString(record.runStateJson) &&
      isNullableString(record.eventsNdjson) &&
      isNullableString(record.planProgressJson) &&
      isNullableString(record.reviewMarkdown) &&
      isNullableString(record.progressMarkdown) &&
      isNullableString(record.recoveryMarkdown) &&
      isNullableString(record.archivedReviewMarkdown) &&
      isNullableString(record.invalidDerivedPlanPayload),
  );
}

function isSuggestedAction(value: unknown): value is SuggestedNealAction | null {
  if (value === null) {
    return true;
  }
  const record = asRecord(value);
  const target = asRecord(record?.target);
  return Boolean(
    record &&
      typeof record.type === 'string' &&
      isSupportedNealActionType(record.type) &&
      typeof record.label === 'string' &&
      (typeof record.rationale === 'string' || record.rationale === undefined) &&
      target,
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
