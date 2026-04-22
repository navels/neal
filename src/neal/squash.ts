import { access, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { getCommitRange, getCommitSubjects, getHeadCommit, getWorktreeStatus, squashCommits } from './git.js';
import { getRunStatePath, loadState } from './state.js';
import type { OrchestrationState } from './types.js';
import { filterWrapperOwnedWorktreeStatus } from './orchestrator/split-plan.js';

type RunMetaArtifact = {
  planDoc?: unknown;
  topLevelMode?: unknown;
  createdAt?: unknown;
};

type ProgressArtifact = {
  status?: unknown;
  finalCommit?: unknown;
};

type NormalizedPlanPath = {
  resolved: string;
  real: string | null;
};

export type SquashCandidate = {
  runDir: string;
  runId: string;
  planDoc: string | null;
  topLevelMode: OrchestrationState['topLevelMode'] | null;
  status: OrchestrationState['status'] | null;
  createdAt: string | null;
  updatedAt: string | null;
  initialBaseCommit: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  createdCommits: string[] | null;
  acceptedScopeCount: number | null;
  source: 'run_state' | 'artifacts_only';
  metadataIssues: string[];
};

export type SelectedSquashRun = {
  normalizedPlanDoc: string;
  selected: SquashCandidate;
  completedMatchCount: number;
  selectionWarning: string | null;
};

export type SquashMessagePlan = {
  subject: string;
  bullets: string[];
  message: string;
  source: 'accepted_scope_summaries' | 'created_commit_subjects';
};

export type SquashResultArtifact = {
  status: 'pending' | 'complete';
  selectedRunDir: string;
  selectedPlanDoc: string;
  originalBaseCommit: string;
  originalFinalCommit: string;
  originalCreatedCommits: string[];
  replacementCommit: string | null;
  generatedCommitMessage: string;
  squashedAt: string | null;
};

export type ExecutedSquashResult = {
  replacementCommit: string;
  artifactPath: string;
  artifact: SquashResultArtifact;
};

function getSortTimestamp(candidate: SquashCandidate) {
  return candidate.updatedAt ?? candidate.createdAt ?? candidate.runId;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function normalizePlanPath(path: string): Promise<NormalizedPlanPath> {
  const resolved = resolve(path);
  try {
    return {
      resolved,
      real: await realpath(resolved),
    };
  } catch {
    return {
      resolved,
      real: null,
    };
  }
}

async function planPathsMatch(candidatePlanDoc: string | null, target: NormalizedPlanPath) {
  if (!candidatePlanDoc) {
    return false;
  }

  const normalizedCandidate = await normalizePlanPath(candidatePlanDoc);
  return (
    normalizedCandidate.resolved === target.resolved ||
    (normalizedCandidate.real !== null && target.real !== null && normalizedCandidate.real === target.real)
  );
}

async function loadCandidateFromRunDir(runDir: string): Promise<SquashCandidate | null> {
  const runId = runDir.split('/').at(-1) ?? runDir;
  const runStatePath = getRunStatePath(runDir);

  try {
    await access(runStatePath);
    const state = await loadState(runStatePath);
    return {
      runDir,
      runId,
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      initialBaseCommit: state.initialBaseCommit,
      baseCommit: state.baseCommit,
      finalCommit: state.finalCommit,
      createdCommits: [...state.createdCommits],
      acceptedScopeCount: state.completedScopes.filter((scope) => scope.result === 'accepted').length,
      source: 'run_state',
      metadataIssues: [],
    };
  } catch {
    const meta = await readJsonFile<RunMetaArtifact>(join(runDir, 'meta.json'));
    const progress = await readJsonFile<ProgressArtifact>(join(runDir, 'plan-progress.json'));

    if (!meta && !progress) {
      return null;
    }

    const metadataIssues = ['missing run-local state snapshot RUN_STATE.json'];
    return {
      runDir,
      runId,
      planDoc: typeof meta?.planDoc === 'string' ? meta.planDoc : null,
      topLevelMode:
        meta?.topLevelMode === 'execute' || meta?.topLevelMode === 'plan'
          ? meta.topLevelMode
          : null,
      status:
        progress?.status === 'running' || progress?.status === 'done' || progress?.status === 'blocked' || progress?.status === 'failed'
          ? progress.status
          : null,
      createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : null,
      updatedAt: null,
      initialBaseCommit: null,
      baseCommit: null,
      finalCommit: typeof progress?.finalCommit === 'string' ? progress.finalCommit : null,
      createdCommits: null,
      acceptedScopeCount: null,
      source: 'artifacts_only',
      metadataIssues,
    };
  }
}

export async function discoverSquashCandidates(runsRoot: string): Promise<SquashCandidate[]> {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadCandidateFromRunDir(join(runsRoot, entry.name))),
  );

  return candidates
    .filter((candidate): candidate is SquashCandidate => candidate !== null)
    .sort((left, right) => getSortTimestamp(right).localeCompare(getSortTimestamp(left)));
}

function describeMatchingRuns(candidates: SquashCandidate[]) {
  return candidates
    .map((candidate) => {
      const pieces = [
        candidate.runId,
        candidate.topLevelMode ?? 'unknown-mode',
        candidate.status ?? 'unknown-status',
      ];
      if (candidate.metadataIssues.length > 0) {
        pieces.push(candidate.metadataIssues.join('; '));
      }
      return `- ${pieces.join(' | ')}`;
    })
    .join('\n');
}

export async function selectSquashRunForPlan(args: {
  cwd: string;
  planDocArg: string;
  runsRoot?: string;
}): Promise<SelectedSquashRun> {
  const normalizedPlanDoc = await normalizePlanPath(resolve(args.cwd, args.planDocArg));
  const runsRoot = resolve(args.cwd, args.runsRoot ?? '.neal/runs');
  const candidates = await discoverSquashCandidates(runsRoot);
  const matches = await Promise.all(candidates.map((candidate) => planPathsMatch(candidate.planDoc, normalizedPlanDoc)));
  const matchingPlanRuns = candidates.filter((_candidate, index) => matches[index]);

  if (matchingPlanRuns.length === 0) {
    throw new Error(`No Neal runs found for plan doc: ${normalizedPlanDoc.resolved}`);
  }

  const completedExecuteRuns = matchingPlanRuns.filter(
    (candidate) => candidate.topLevelMode === 'execute' && candidate.status === 'done',
  );

  if (completedExecuteRuns.length === 0) {
    throw new Error(
      [
        `No completed execute-mode Neal runs found for plan doc: ${normalizedPlanDoc.resolved}`,
        'Matching runs:',
        describeMatchingRuns(matchingPlanRuns),
      ].join('\n'),
    );
  }

  const selected = completedExecuteRuns[0];
  const selectionWarning =
    completedExecuteRuns.length > 1
      ? `Selected latest completed run ${selected.runId} from ${completedExecuteRuns.length} matching completed runs under ${runsRoot}.`
      : null;

  return {
    normalizedPlanDoc: normalizedPlanDoc.resolved,
    selected,
    completedMatchCount: completedExecuteRuns.length,
    selectionWarning,
  };
}

export async function validateSelectedRunForSquash(args: {
  cwd: string;
  selected: SquashCandidate;
}) {
  const statusOutput = filterWrapperOwnedWorktreeStatus(await getWorktreeStatus(args.cwd));
  if (statusOutput) {
    throw new Error(`Cannot squash with a dirty worktree:\n${statusOutput}`);
  }

  if (args.selected.metadataIssues.length > 0) {
    throw new Error(
      `Run ${args.selected.runId} is missing required squash metadata: ${args.selected.metadataIssues.join('; ')}`,
    );
  }

  const squashBaseCommit = args.selected.initialBaseCommit ?? args.selected.baseCommit;

  if (!squashBaseCommit) {
    throw new Error(`Run ${args.selected.runId} is missing baseCommit`);
  }

  if (!args.selected.finalCommit) {
    throw new Error(`Run ${args.selected.runId} is missing finalCommit`);
  }

  if (!args.selected.createdCommits || args.selected.createdCommits.length === 0) {
    throw new Error(`Run ${args.selected.runId} recorded no created commits to squash`);
  }

  const uniqueCommits = new Set(args.selected.createdCommits);
  if (uniqueCommits.size !== args.selected.createdCommits.length) {
    throw new Error(`Run ${args.selected.runId} has duplicate commit entries in createdCommits`);
  }

  const headCommit = await getHeadCommit(args.cwd);
  if (headCommit !== args.selected.finalCommit) {
    throw new Error(
      `Cannot squash run ${args.selected.runId}: HEAD ${headCommit} does not match finalCommit ${args.selected.finalCommit}`,
    );
  }

  const actualRange = await getCommitRange(args.cwd, squashBaseCommit, args.selected.finalCommit);
  if (actualRange.length === 0) {
    throw new Error(
      `Run ${args.selected.runId} has no reachable commits between ${squashBaseCommit} and ${args.selected.finalCommit}`,
    );
  }

  const exactRecordedRange = actualRange.join('\n') === args.selected.createdCommits.join('\n');
  const finalizedSingleCommitRange =
    actualRange.length === 1 &&
    actualRange[0] === args.selected.finalCommit &&
    args.selected.createdCommits.at(-1) !== args.selected.finalCommit;
  const fullPlanAcceptedRange =
    args.selected.source === 'run_state' &&
    args.selected.topLevelMode === 'execute' &&
    args.selected.status === 'done' &&
    (args.selected.acceptedScopeCount ?? 0) > 1 &&
    actualRange.at(-1) === args.selected.finalCommit;

  if (!exactRecordedRange && !finalizedSingleCommitRange && !fullPlanAcceptedRange) {
    throw new Error(
      [
        `Run ${args.selected.runId} does not form a squashable range from ${squashBaseCommit} to ${args.selected.finalCommit}`,
        `Recorded commits: ${args.selected.createdCommits.join(', ')}`,
        `Actual range: ${actualRange.join(', ')}`,
      ].join('\n'),
    );
  }

  return {
    baseCommit: squashBaseCommit,
    finalCommit: args.selected.finalCommit,
    createdCommits: [...actualRange],
    headCommit,
  };
}

async function toRelativePlanDoc(cwd: string, planDoc: string) {
  const resolvedRelative = relative(resolve(cwd), resolve(planDoc));
  if (resolvedRelative && !resolvedRelative.startsWith('..')) {
    return resolvedRelative;
  }

  const normalizedCwd = await normalizePlanPath(cwd);
  const normalizedPlanDoc = await normalizePlanPath(planDoc);
  if (normalizedCwd.real && normalizedPlanDoc.real) {
    const realRelative = relative(normalizedCwd.real, normalizedPlanDoc.real);
    if (realRelative && !realRelative.startsWith('..')) {
      return realRelative;
    }
  }

  return planDoc;
}

function trimBulletValue(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function trimRedundantPlanPrefix(subject: string, planDocDisplay: string) {
  const prefixes = [`${planDocDisplay}: `, `${basename(planDocDisplay)}: `];
  for (const prefix of prefixes) {
    if (subject.startsWith(prefix)) {
      const trimmed = subject.slice(prefix.length).trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }

  return subject;
}

async function readArchivedScopeSummary(scope: OrchestrationState['completedScopes'][number]) {
  if (!scope.archivedReviewPath || scope.replacedByDerivedPlanPath) {
    return null;
  }

  try {
    const markdown = await readFile(scope.archivedReviewPath, 'utf8');
    const match = markdown.match(/^- Coder milestone:\s+(.+)$/m);
    return match ? trimBulletValue(match[1]) : null;
  } catch {
    return null;
  }
}

async function getAcceptedScopeSummaryBullets(candidate: SquashCandidate) {
  if (candidate.source !== 'run_state') {
    return [];
  }

  const state = await loadState(getRunStatePath(candidate.runDir));
  const bullets: string[] = [];

  for (const scope of state.completedScopes) {
    if (scope.result !== 'accepted' || scope.replacedByDerivedPlanPath) {
      continue;
    }

    const summary = trimBulletValue(scope.summary ?? '') || (await readArchivedScopeSummary(scope));
    if (summary) {
      bullets.push(summary);
    }
  }

  return bullets;
}

function formatSquashMessage(subject: string, bullets: string[]) {
  return `${subject}\n\n${bullets.map((bullet) => `- ${bullet}`).join('\n')}`;
}

export async function buildSquashCommitMessage(args: {
  cwd: string;
  selected: SquashCandidate;
}): Promise<SquashMessagePlan> {
  const planDoc = args.selected.planDoc;
  if (!planDoc) {
    throw new Error(`Run ${args.selected.runId} is missing planDoc for squash message generation`);
  }

  const planDocDisplay = await toRelativePlanDoc(args.cwd, planDoc);
  const subject = `Implement ${planDocDisplay}`;
  const acceptedScopeBullets = await getAcceptedScopeSummaryBullets(args.selected);
  if (acceptedScopeBullets.length > 0) {
    return {
      subject,
      bullets: acceptedScopeBullets,
      message: formatSquashMessage(subject, acceptedScopeBullets),
      source: 'accepted_scope_summaries',
    };
  }

  if (!args.selected.createdCommits || args.selected.createdCommits.length === 0) {
    throw new Error(
      `Run ${args.selected.runId} does not have auditable scope summaries or created commits for squash message generation`,
    );
  }

  let commitSubjectLines: string[];
  try {
    commitSubjectLines = await getCommitSubjects(args.cwd, args.selected.createdCommits);
  } catch {
    throw new Error(
      `Run ${args.selected.runId} does not have auditable scope summaries or reachable commit subjects for squash message generation`,
    );
  }

  const bullets = commitSubjectLines
    .map((line) => line.replace(/^[a-f0-9]+\s+/, '').trim())
    .map((line) => trimRedundantPlanPrefix(line, planDocDisplay))
    .map(trimBulletValue)
    .filter(Boolean);

  if (bullets.length === 0) {
    throw new Error(
      `Run ${args.selected.runId} does not have auditable scope summaries or commit subjects for squash message generation`,
    );
  }

  return {
    subject,
    bullets,
    message: formatSquashMessage(subject, bullets),
    source: 'created_commit_subjects',
  };
}

export async function executeSquashForRun(args: {
  cwd: string;
  selected: SquashCandidate;
  validation: {
    baseCommit: string;
    finalCommit: string;
    createdCommits: string[];
    headCommit: string;
  };
  commitMessage: SquashMessagePlan;
  artifactWriter?: (path: string, content: string) => Promise<void>;
}): Promise<ExecutedSquashResult> {
  const artifactPath = join(args.selected.runDir, 'SQUASH_RESULT.json');
  const writeArtifact = args.artifactWriter ?? ((path: string, content: string) => writeFile(path, content, 'utf8'));
  const pendingArtifact: SquashResultArtifact = {
    status: 'pending',
    selectedRunDir: args.selected.runDir,
    selectedPlanDoc: args.selected.planDoc ?? '',
    originalBaseCommit: args.validation.baseCommit,
    originalFinalCommit: args.validation.finalCommit,
    originalCreatedCommits: [...args.validation.createdCommits],
    replacementCommit: null,
    generatedCommitMessage: args.commitMessage.message,
    squashedAt: null,
  };

  await writeArtifact(artifactPath, JSON.stringify(pendingArtifact, null, 2) + '\n');

  const replacementCommit = await squashCommits(args.cwd, args.validation.baseCommit, args.commitMessage.message);
  const artifact: SquashResultArtifact = {
    ...pendingArtifact,
    status: 'complete',
    replacementCommit,
    squashedAt: new Date().toISOString(),
  };

  try {
    await writeArtifact(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Squash rewrite succeeded but Neal could not finalize the audit artifact at ${artifactPath}. ` +
        `The pending artifact was written before the rewrite. Underlying error: ${message}`,
    );
  }

  return {
    replacementCommit,
    artifactPath,
    artifact,
  };
}
