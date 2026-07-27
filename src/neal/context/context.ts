import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  NealActionTarget,
  NealArtifactCitation,
  NealContextArtifact,
  NealContextPack,
  SuggestedNealAction,
} from './shared.js';

import { getFinalCompletionReviewArtifactPath } from '../final-completion-review.js';
import { getCurrentRunPointerPath, resolveRunStatePath } from '../run-registry.js';
import { getRunDisplayStatus } from '../run-status.js';
import { getRunStatePath, loadState } from '../state.js';
import { getNealDir } from '../storage-paths.js';
import { formatStatusNextActionForState } from '../status.js';
import type { OrchestrationState } from '../types.js';
import {
  DEFAULT_CONTEXT_ARTIFACT_BYTE_LIMIT,
  DEFAULT_CONTEXT_TOTAL_BYTE_LIMIT,
  type BoundedArtifactRequest,
  type ContextByteBudget,
  findLatestRetrospectiveArtifact,
  makeBoundedInlineArtifact,
  readBoundedArtifact,
} from './artifacts.js';
import type { BuildLocalNealContextPackArgs, LocalNealContextStatePathSource } from './types.js';

const execFileAsync = promisify(execFile);
const GIT_RECENT_COMMIT_LIMIT = 5;

export async function buildLocalNealContextPack(args: BuildLocalNealContextPackArgs): Promise<NealContextPack> {
  const cwd = resolve(args.cwd);
  const createdAt = (args.now ?? new Date()).toISOString();
  const perArtifactByteLimit = args.perArtifactByteLimit ?? DEFAULT_CONTEXT_ARTIFACT_BYTE_LIMIT;
  const totalByteLimit = args.totalByteLimit ?? DEFAULT_CONTEXT_TOTAL_BYTE_LIMIT;
  const budget: ContextByteBudget = {
    perArtifactByteLimit,
    totalByteLimit,
    usedBytes: 0,
  };
  const warnings: string[] = [];
  const artifacts: NealContextArtifact[] = [];

  const stateResolution = await loadContextState(cwd, args.statePath ?? null, warnings);
  if (stateResolution.state) {
    for (const request of await buildRunArtifactRequests(stateResolution.state)) {
      artifacts.push(await readBoundedArtifact(request, budget));
    }
  }

  if (args.planPath) {
    const planPath = resolvePath(cwd, args.planPath);
    artifacts.push(
      await readBoundedArtifact(
        {
          label: args.planPath,
          kind: 'plan',
          path: planPath,
        },
        budget,
      ),
    );
  }

  for (const request of buildGuidanceArtifactRequests(cwd)) {
    artifacts.push(await readBoundedArtifact(request, budget));
  }

  const gitContext = await buildGitContext(cwd, warnings);
  if (gitContext) {
    artifacts.push(makeBoundedInlineArtifact({ label: 'git context', kind: 'git' }, gitContext, budget));
  }

  const suggestedActions = buildSuggestedActions(stateResolution, artifacts, cwd);
  const citations = artifacts
    .filter((artifact) => !artifact.omitted)
    .map(({ label, kind }) => ({ label, kind } satisfies NealArtifactCitation));

  return {
    version: 1,
    createdAt,
    cwd,
    state: stateResolution.state ? buildContextState(cwd, stateResolution) : null,
    artifacts,
    citations,
    suggestedActions,
    limits: {
      perArtifactByteLimit,
      totalByteLimit,
      totalArtifactBytes: budget.usedBytes,
      truncatedArtifactCount: artifacts.filter((artifact) => artifact.truncated).length,
      omittedArtifactCount: artifacts.filter((artifact) => artifact.omitted).length,
    },
    warnings,
  };
}

type LoadedContextState = {
  state: OrchestrationState | null;
  statePath: string;
  source: LocalNealContextStatePathSource;
};

function buildContextState(cwd: string, stateResolution: LoadedContextState): NonNullable<NealContextPack['state']> {
  const state = stateResolution.state;
  if (!state) {
    throw new Error('Cannot build Neal context state without a loaded run state');
  }

  const displayStatus = getRunDisplayStatus(state);
  const runId = basename(state.runDir);
  const latestInteractiveBlockedRecoveryHistory = state.interactiveBlockedRecoveryHistory.at(-1) ?? null;

  return {
    statePath: toDisplayPath(cwd, stateResolution.statePath),
    statePathSource: stateResolution.source,
    runDir: toDisplayPath(cwd, state.runDir),
    runDirName: runId,
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    executionShape: state.executionShape,
    phase: state.phase,
    status: state.status,
    effectiveStatus: displayStatus.effectiveStatus,
    waitingForOperatorGuidance: displayStatus.waitingForOperatorGuidance,
    pendingOperatorGuidance: displayStatus.pendingOperatorGuidance,
    currentScopeNumber: state.currentScopeNumber,
    blockedFromPhase: state.blockedFromPhase,
    lastBlockedReason: getLastBlockedReason(state),
    interactiveBlockedRecovery: state.interactiveBlockedRecovery
      ? {
          sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
          blockedReason: state.interactiveBlockedRecovery.blockedReason,
          turns: state.interactiveBlockedRecovery.turns.length,
          lastHandledTurn: state.interactiveBlockedRecovery.lastHandledTurn,
          pendingDirective: state.interactiveBlockedRecovery.pendingDirective?.operatorGuidance ?? null,
          acceptsFreeFormResumeMessage: displayStatus.waitingForOperatorGuidance,
        }
      : null,
    acceptedResumeMessageShapes: getAcceptedResumeMessageShapes(
      state,
      runId,
      displayStatus.waitingForOperatorGuidance,
    ),
    latestInteractiveBlockedRecoveryHistory: latestInteractiveBlockedRecoveryHistory
      ? {
          resolvedByAction: latestInteractiveBlockedRecoveryHistory.resolvedByAction,
          resultPhase: latestInteractiveBlockedRecoveryHistory.resultPhase,
          blockedReason: latestInteractiveBlockedRecoveryHistory.blockedReason,
          turns: latestInteractiveBlockedRecoveryHistory.turns.length,
        }
      : null,
    nextAction: formatStatusNextActionForState(state),
    updatedAt: state.updatedAt,
  };
}

function getAcceptedResumeMessageShapes(
  state: OrchestrationState,
  runId: string,
  waitingForOperatorGuidance: boolean,
) {
  if (waitingForOperatorGuidance) {
    return [`neal resume --run ${runId} --message "<free-form recovery guidance>"`];
  }

  return [];
}

function getLastBlockedReason(state: OrchestrationState) {
  if (state.interactiveBlockedRecovery?.blockedReason) {
    return state.interactiveBlockedRecovery.blockedReason;
  }

  const blockedScope = [...state.completedScopes].reverse().find((scope) => scope.result === 'blocked' && scope.blocker);
  return blockedScope?.blocker ?? null;
}

async function loadContextState(cwd: string, inputStatePath: string | null, warnings: string[]): Promise<LoadedContextState> {
  const source: LocalNealContextStatePathSource = inputStatePath ? 'explicit' : 'current_pointer';
  let statePath: string;
  try {
    statePath = inputStatePath
      ? resolvePath(cwd, inputStatePath)
      : (await resolveRunStatePath({ cwd, runId: 'latest' })).statePath;
  } catch (error) {
    statePath = inputStatePath ? resolvePath(cwd, inputStatePath) : getCurrentRunPointerPath(cwd);
    warnings.push(
      inputStatePath
        ? `State file could not be resolved: ${error instanceof Error ? error.message : String(error)}`
        : `Current Neal run pointer could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      state: null,
      statePath,
      source,
    };
  }

  try {
    const state = await loadState(statePath);
    return {
      state,
      statePath,
      source,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      warnings.push(inputStatePath ? `State file not found: ${inputStatePath}` : 'No .neal/current.json run pointer state file found.');
      return {
        state: null,
        statePath,
        source,
      };
    }
    warnings.push(`State file could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return {
      state: null,
      statePath,
      source,
    };
  }
}

async function buildRunArtifactRequests(state: OrchestrationState): Promise<BoundedArtifactRequest[]> {
  const requests: BoundedArtifactRequest[] = [
    {
      label: 'RUN_STATE.json',
      kind: 'state',
      path: getRunStatePath(state.runDir),
    },
  ];

  requests.push(
    {
      label: 'events.ndjson',
      kind: 'run_artifact',
      path: join(state.runDir, 'events.ndjson'),
      readStrategy: 'tail',
    },
    {
      label: 'plan-progress.json',
      kind: 'run_artifact',
      path: state.progressJsonPath,
    },
    {
      label: 'PLAN_PROGRESS.md',
      kind: 'run_artifact',
      path: state.progressMarkdownPath,
    },
    {
      label: 'REVIEW.md',
      kind: 'run_artifact',
      path: state.reviewMarkdownPath,
    },
    {
      label: 'RECOVERY.md',
      kind: 'run_artifact',
      path: state.recoveryMarkdownPath,
    },
  );

  const retrospective = await findLatestRetrospectiveArtifact(state.runDir);
  if (retrospective) {
    requests.push(retrospective);
  }

  requests.push({
    label: 'FINAL_COMPLETION_REVIEW.md',
    kind: 'run_artifact',
    path: getFinalCompletionReviewArtifactPath(state.runDir),
  });

  return requests;
}

function buildGuidanceArtifactRequests(cwd: string): BoundedArtifactRequest[] {
  return [
    {
      label: 'AGENTS.md',
      kind: 'guidance',
      path: join(cwd, 'AGENTS.md'),
    },
    {
      label: '.neal/NOTES.md',
      kind: 'guidance',
      path: join(getNealDir(cwd), 'NOTES.md'),
    },
  ];
}

async function buildGitContext(cwd: string, warnings: string[]) {
  try {
    await access(join(cwd, '.git'));
  } catch {
    return null;
  }

  try {
    const [statusResult, logResult] = await Promise.all([
      execFileAsync('git', ['status', '--short'], { cwd }),
      execFileAsync('git', ['log', `-${GIT_RECENT_COMMIT_LIMIT}`, '--pretty=format:%h %s'], { cwd }),
    ]);
    const status = statusResult.stdout.trim();
    const log = logResult.stdout.trim();
    return [
      'git status --short',
      status || '(clean)',
      '',
      `git log -${GIT_RECENT_COMMIT_LIMIT} --pretty=format:%h %s`,
      log || '(no commits)',
    ].join('\n');
  } catch {
    warnings.push('Git context unavailable.');
    return null;
  }
}

function buildSuggestedActions(
  stateResolution: LoadedContextState,
  artifacts: NealContextArtifact[],
  cwd: string,
): SuggestedNealAction[] {
  const state = stateResolution.state;
  if (!state) {
    return [];
  }

  const target: NealActionTarget = {
    runDirName: basename(state.runDir),
    statePath: toDisplayPath(cwd, getRunStatePath(state.runDir)),
  };
  const suggestions: SuggestedNealAction[] = [];
  const firstInspectableArtifact = artifacts.find((artifact) => !artifact.omitted && artifact.kind !== 'git');
  if (firstInspectableArtifact) {
    suggestions.push({
      type: 'inspect_artifact',
      label: `Inspect ${firstInspectableArtifact.label}`,
      target: {
        ...target,
        artifactLabel: firstInspectableArtifact.label,
      },
      rationale: 'Read a bounded Neal artifact excerpt before taking action.',
    });
  }

  if (state.status === 'blocked') {
    suggestions.push({
      type: 'recover',
      label: 'Recover selected run',
      target,
      rationale: 'The selected Neal run is blocked and can accept operator recovery guidance.',
    });
  } else if (state.status === 'paused') {
    suggestions.push({
      type: 'resume',
      label: 'Resume selected run',
      target,
      rationale: 'The selected Neal run is paused at a scope boundary.',
    });
  } else if (state.status === 'running') {
    suggestions.push({
      type: 'pause_after_scope',
      label: 'Pause after current scope',
      target,
      rationale: 'The selected Neal run is still running.',
    });
  } else if (state.status === 'done' && state.finalCommit) {
    suggestions.push({
      type: 'squash',
      label: 'Review squash opportunity',
      target,
      rationale: 'The selected Neal run has a final commit recorded.',
    });
  }

  return suggestions;
}

function resolvePath(cwd: string, path: string) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function toDisplayPath(cwd: string, path: string) {
  const absolutePath = resolvePath(cwd, path);
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return relativePath || '.';
  }
  return absolutePath;
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
