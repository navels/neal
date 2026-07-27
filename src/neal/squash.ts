import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { writeTextAtomic } from './atomic-write.js';
import {
  createSquashReplacementCommit,
  assertNoIgnoredChangedFiles,
  commitTreePathExists,
  getCommitRange,
  getChangedFilesForRange,
  getCommitSubjects,
  getHeadCommit,
  getWorktreeStatus,
  isAncestorCommit,
  rebaseCurrentBranchOnto,
  resetHard,
} from './git.js';
import { inspectPlanDocDisposition, type PlanDocDisposition } from './plan-doc.js';
import { getRunStatePath, loadState } from './state.js';
import { getRunsDir } from './storage-paths.js';
import {
  buildChangedFileCategorySquashDraft,
  buildFinalCompletionSummarySquashDraft,
  buildSquashMessageDraft,
  extractPlanMarkdownTitle,
  formatSquashMessage,
  normalizePlanTitleForSquashSubject,
  normalizeSquashFallbackLine,
  validateReviewerSquashMessageDraft,
  type SquashCommitMessageDraft,
  type SquashCommitMessageSource,
} from './squash-message.js';
import type { OrchestrationState } from './types.js';
import { filterWrapperOwnedWorktreeStatus } from './worktree-status.js';

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
  source: SquashCommitMessageSource;
};

export type SquashValidation = {
  baseCommit: string;
  finalCommit: string;
  createdCommits: string[];
  headCommit: string;
  postPlanCommits: string[];
};

export type SquashResultMetadata = {
  runId: string;
  selectedPlanDoc: string;
  normalizedPlanDoc: string;
  planDocDisposition: PlanDocDisposition;
  planDocIncludedInReplacementCommit: boolean;
  commitMessageSource: SquashCommitMessageSource;
  commitMessageSubject: string;
};

export type SquashResultArtifact = {
  version: 1;
  status: 'pending' | 'complete';
  selectedRunDir: string;
  selectedPlanDoc: string;
  originalBaseCommit: string;
  originalFinalCommit: string;
  originalHeadCommit: string;
  originalCreatedCommits: string[];
  postPlanCommits: string[];
  replacementCommit: string | null;
  finalHeadCommit: string | null;
  generatedCommitMessage: string;
  squashedAt: string | null;
  metadata: SquashResultMetadata;
};

export type ExecutedSquashResult = {
  replacementCommit: string;
  finalHeadCommit: string;
  artifactPath: string;
  artifact: SquashResultArtifact;
};

type CompletedSquashArtifact = SquashResultArtifact & {
  status: 'complete';
  replacementCommit: string;
  finalHeadCommit: string;
};

function getSortTimestamp(candidate: SquashCandidate) {
  return candidate.updatedAt ?? candidate.createdAt ?? candidate.runId;
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
    };
  } catch {
    return null;
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
  const runsRoot = args.runsRoot ? resolve(args.cwd, args.runsRoot) : getRunsDir(resolve(args.cwd));
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

export async function selectLatestSquashRun(args: { cwd: string; runsRoot?: string }): Promise<SelectedSquashRun> {
  const runsRoot = args.runsRoot ? resolve(args.cwd, args.runsRoot) : getRunsDir(resolve(args.cwd));
  const candidates = await discoverSquashCandidates(runsRoot);
  const completedExecuteRuns = candidates.filter(
    (candidate) => candidate.topLevelMode === 'execute' && candidate.status === 'done' && candidate.planDoc,
  );

  if (completedExecuteRuns.length === 0) {
    throw new Error(
      [
        `No completed execute-mode Neal runs with a recorded plan doc found under ${runsRoot}`,
        candidates.length > 0 ? 'Discovered runs:' : null,
        candidates.length > 0 ? describeMatchingRuns(candidates) : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const selected = completedExecuteRuns[0];
  if (!selected.planDoc) {
    throw new Error(`Selected Neal run is missing planDoc: ${selected.runId}`);
  }

  const normalizedPlanDoc = await normalizePlanPath(selected.planDoc);
  const selectionWarning = `No plan doc supplied; selected latest completed execute-mode run ${selected.runId} from ${completedExecuteRuns.length} completed run(s) under ${runsRoot}.`;

  return {
    normalizedPlanDoc: normalizedPlanDoc.resolved,
    selected,
    completedMatchCount: completedExecuteRuns.length,
    selectionWarning,
  };
}

export async function selectSquashRunByRunDir(args: {
  cwd: string;
  runDirName: string;
  runsRoot?: string;
}): Promise<SelectedSquashRun> {
  const runDirName = validateExplicitRunDirName(args.runDirName);
  const runsRoot = args.runsRoot ? resolve(args.cwd, args.runsRoot) : getRunsDir(resolve(args.cwd));
  const runsRootRealPath = await realpath(runsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(`No Neal runs directory exists at ${runsRoot}`);
    }
    throw error;
  });
  const runDir = resolve(runsRootRealPath, runDirName);
  const runDirRealPath = await realpath(runDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(`No Neal run directory exists for selected run: ${runDirName}`);
    }
    throw error;
  });
  if (!isPathInside(runDirRealPath, runsRootRealPath)) {
    throw new Error(`Selected run directory escapes the Neal runs directory: ${runDirName}`);
  }

  const selected = await loadCandidateFromRunDir(runDirRealPath);
  if (!selected) {
    throw new Error(`Selected Neal run has no readable run-local state RUN_STATE.json: ${runDirName}`);
  }
  if (selected.topLevelMode !== 'execute') {
    throw new Error(`Selected Neal run is not an execute-mode run: ${runDirName}`);
  }
  if (selected.status !== 'done') {
    throw new Error(`Selected Neal run is not complete: ${runDirName}`);
  }
  if (!selected.planDoc) {
    throw new Error(`Selected Neal run is missing planDoc: ${runDirName}`);
  }

  const normalizedPlanDoc = await normalizePlanPath(selected.planDoc);
  return {
    normalizedPlanDoc: normalizedPlanDoc.resolved,
    selected,
    completedMatchCount: 1,
    selectionWarning: null,
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

  const squashBaseCommit = args.selected.initialBaseCommit ?? args.selected.baseCommit;

  if (!squashBaseCommit) {
    throw new Error(`Run ${args.selected.runId} is missing squash base commit (initialBaseCommit or baseCommit)`);
  }

  if (!args.selected.finalCommit) {
    throw new Error(`Run ${args.selected.runId} is missing finalCommit`);
  }

  const recordedCommits = args.selected.createdCommits ?? [];
  const uniqueCommits = new Set(recordedCommits);
  if (recordedCommits.length > 0 && uniqueCommits.size !== recordedCommits.length) {
    throw new Error(`Run ${args.selected.runId} has duplicate commit entries in createdCommits`);
  }

  const headCommit = await getHeadCommit(args.cwd);
  const finalCommitIsInCurrentHistory = await isAncestorCommit(args.cwd, args.selected.finalCommit, headCommit);
  if (!finalCommitIsInCurrentHistory) {
    const completedSquash = await readCompletedSquashArtifact(args.selected);
    if (completedSquash && completedSquash.artifact.originalFinalCommit === args.selected.finalCommit) {
      const squashHeadIsCurrent = await isAncestorCommit(args.cwd, completedSquash.artifact.finalHeadCommit, headCommit);
      if (squashHeadIsCurrent) {
        throw new Error(
          [
            `Run ${args.selected.runId} has already been squashed.`,
            `Original final commit: ${completedSquash.artifact.originalFinalCommit}`,
            `Replacement commit: ${completedSquash.artifact.replacementCommit}`,
            `Final squash head: ${completedSquash.artifact.finalHeadCommit}`,
            `Squash artifact: ${completedSquash.artifactPath}`,
          ].join('\n'),
        );
      }
    }
    throw new Error(
      `Cannot squash run ${args.selected.runId}: finalCommit ${args.selected.finalCommit} is not an ancestor of HEAD ${headCommit}`,
    );
  }
  const postPlanCommits = headCommit === args.selected.finalCommit ? [] : await getCommitRange(args.cwd, args.selected.finalCommit, headCommit);

  const actualRange = await getCommitRange(args.cwd, squashBaseCommit, args.selected.finalCommit);
  if (actualRange.length === 0) {
    throw new Error(
      `Run ${args.selected.runId} has no reachable commits between ${squashBaseCommit} and ${args.selected.finalCommit}`,
    );
  }
  await assertNoIgnoredChangedFiles(
    args.cwd,
    await getChangedFilesForRange(args.cwd, squashBaseCommit, args.selected.finalCommit),
    `Squash run ${args.selected.runId}`,
  );

  if (recordedCommits.length > 0) {
    const exactRecordedRange = actualRange.join('\n') === recordedCommits.join('\n');
    const finalizedSingleCommitRange =
      actualRange.length === 1 &&
      actualRange[0] === args.selected.finalCommit &&
      recordedCommits.at(-1) !== args.selected.finalCommit;
    // A completed execute run with at least one accepted scope whose actual
    // base->final range terminates at the recorded finalCommit is squashable
    // even when `createdCommits` no longer matches that range. This happens
    // when final-completion review reopens execution and the coder rewrites
    // history (rebase/amend), leaving the recorded commits stale or fully
    // disjoint from the rebuilt range. The range is still bounded by Neal's
    // own initialBaseCommit and finalCommit, so it is authoritative. The
    // `>= 1` (not `> 1`) accepted-scope gate preserves the safety boundary:
    // runs with zero accepted scopes but a mismatched range are still
    // rejected below.
    const acceptedExecuteRange =
      args.selected.topLevelMode === 'execute' &&
      args.selected.status === 'done' &&
      (args.selected.acceptedScopeCount ?? 0) >= 1 &&
      actualRange.at(-1) === args.selected.finalCommit;

    if (!exactRecordedRange && !finalizedSingleCommitRange && !acceptedExecuteRange) {
      throw new Error(
        [
          `Run ${args.selected.runId} does not form a squashable range from ${squashBaseCommit} to ${args.selected.finalCommit}`,
          `Recorded commits: ${recordedCommits.join(', ')}`,
          `Actual range: ${actualRange.join(', ')}`,
        ].join('\n'),
      );
    }
  }

  return {
    baseCommit: squashBaseCommit,
    finalCommit: args.selected.finalCommit,
    createdCommits: [...actualRange],
    headCommit,
    postPlanCommits,
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
    return match ? normalizeSquashFallbackLine(match[1]) : null;
  } catch {
    return null;
  }
}

async function getAcceptedScopeSummaryBullets(state: OrchestrationState) {
  const bullets: string[] = [];

  for (const scope of state.completedScopes) {
    if (scope.result !== 'accepted' || scope.replacedByDerivedPlanPath) {
      continue;
    }

    const summary = normalizeSquashFallbackLine(scope.summary ?? '') || (await readArchivedScopeSummary(scope));
    if (summary) {
      bullets.push(summary);
    }
  }

  return bullets;
}

function toSquashMessagePlan(source: SquashCommitMessageSource, draft: SquashCommitMessageDraft): SquashMessagePlan {
  return {
    subject: draft.subject,
    bullets: [...draft.bullets],
    message: formatSquashMessage(draft),
    source,
  };
}

async function readPlanTitleSubject(planDoc: string) {
  let markdown: string;
  try {
    markdown = await readFile(planDoc, 'utf8');
  } catch {
    return null;
  }

  const title = extractPlanMarkdownTitle(markdown);
  return title ? normalizePlanTitleForSquashSubject(title) : null;
}

async function getRunChangedFiles(cwd: string, selected: SquashCandidate) {
  const baseCommit = selected.initialBaseCommit ?? selected.baseCommit;
  if (!baseCommit || !selected.finalCommit) {
    return [];
  }

  try {
    return await getChangedFilesForRange(cwd, baseCommit, selected.finalCommit);
  } catch {
    return [];
  }
}

async function getFallbackCommitIds(cwd: string, selected: SquashCandidate) {
  if (selected.createdCommits && selected.createdCommits.length > 0) {
    return selected.createdCommits;
  }

  const baseCommit = selected.initialBaseCommit ?? selected.baseCommit;
  if (!baseCommit || !selected.finalCommit) {
    return [];
  }

  try {
    return await getCommitRange(cwd, baseCommit, selected.finalCommit);
  } catch {
    return [];
  }
}

async function getCreatedCommitSubjectBullets(args: {
  cwd: string;
  selected: SquashCandidate;
  planDocDisplay: string;
}) {
  const commitIds = await getFallbackCommitIds(args.cwd, args.selected);
  if (commitIds.length === 0) {
    return {
      bullets: [] as string[],
      readFailed: false,
    };
  }

  let commitSubjectLines: string[];
  try {
    commitSubjectLines = await getCommitSubjects(args.cwd, commitIds);
  } catch {
    return {
      bullets: [] as string[],
      readFailed: true,
    };
  }

  return {
    bullets: commitSubjectLines
      .map((line) => line.replace(/^[a-f0-9]+\s+/, '').trim())
      .map((line) => trimRedundantPlanPrefix(line, args.planDocDisplay))
      .map((line) => normalizeSquashFallbackLine(line))
      .filter((line): line is string => Boolean(line)),
    readFailed: false,
  };
}

export async function buildSquashCommitMessage(args: {
  cwd: string;
  selected: SquashCandidate;
}): Promise<SquashMessagePlan> {
  const planDoc = args.selected.planDoc;
  if (!planDoc) {
    throw new Error(`Run ${args.selected.runId} is missing planDoc for squash message generation`);
  }

  const state = await loadState(getRunStatePath(args.selected.runDir));
  const reviewerDraft = state.finalCompletionReviewVerdict?.squashCommitMessage;
  if (reviewerDraft) {
    return toSquashMessagePlan(
      'final_completion_reviewer',
      validateReviewerSquashMessageDraft(reviewerDraft, {
        label: 'stored final completion squashCommitMessage',
      }),
    );
  }

  const planDocDisplay = await toRelativePlanDoc(args.cwd, planDoc);
  const acceptedScopeBullets = await getAcceptedScopeSummaryBullets(state);
  const commitSubjectResult = await getCreatedCommitSubjectBullets({
    cwd: args.cwd,
    selected: args.selected,
    planDocDisplay,
  });
  const changedFileDraft = buildChangedFileCategorySquashDraft(await getRunChangedFiles(args.cwd, args.selected));
  const changedFileBullets = changedFileDraft?.bullets ?? [];

  if (state.finalCompletionSummary) {
    const summaryDraft = buildFinalCompletionSummarySquashDraft({
      whatChangedOverall: state.finalCompletionSummary.whatChangedOverall,
      verificationSummary: state.finalCompletionSummary.verificationSummary,
      supplementalBullets: changedFileBullets,
    });
    if (summaryDraft) {
      return toSquashMessagePlan('final_completion_summary', summaryDraft);
    }
  }

  const planTitleSubject = await readPlanTitleSubject(planDoc);
  if (planTitleSubject) {
    const titleDraft = buildSquashMessageDraft({
      subject: planTitleSubject,
      bullets: [...acceptedScopeBullets, ...commitSubjectResult.bullets],
      supplementalBullets: changedFileBullets,
    });
    if (titleDraft) {
      return toSquashMessagePlan('plan_title', titleDraft);
    }
  }

  if (acceptedScopeBullets.length > 0) {
    const acceptedScopeDraft = buildSquashMessageDraft({
      subject: acceptedScopeBullets[0],
      bullets: acceptedScopeBullets,
      supplementalBullets: changedFileBullets,
    });
    if (acceptedScopeDraft) {
      return toSquashMessagePlan('accepted_scope_summaries', acceptedScopeDraft);
    }
  }

  if (commitSubjectResult.bullets.length > 0) {
    const commitSubjectDraft = buildSquashMessageDraft({
      subject: commitSubjectResult.bullets[0],
      bullets: commitSubjectResult.bullets,
      supplementalBullets: changedFileBullets,
    });
    if (commitSubjectDraft) {
      return toSquashMessagePlan('created_commit_subjects', commitSubjectDraft);
    }
  }

  if (changedFileDraft && changedFileDraft.bullets.length >= 2) {
    return toSquashMessagePlan('changed_file_categories', changedFileDraft);
  }

  if (commitSubjectResult.readFailed) {
    throw new Error(
      `Run ${args.selected.runId} does not have auditable scope summaries or reachable commit subjects for squash message generation`,
    );
  }

  throw new Error(`Run ${args.selected.runId} does not have enough auditable information for squash message generation`);
}

export async function buildSquashResultMetadata(args: {
  cwd: string;
  selected: SquashCandidate;
  validation: SquashValidation;
  commitMessage: SquashMessagePlan;
  treeCommit?: string;
}): Promise<SquashResultMetadata> {
  const selectedPlanDoc = args.selected.planDoc ?? '';
  if (!selectedPlanDoc) {
    return {
      runId: args.selected.runId,
      selectedPlanDoc,
      normalizedPlanDoc: '',
      planDocDisposition: 'missing',
      planDocIncludedInReplacementCommit: false,
      commitMessageSource: args.commitMessage.source,
      commitMessageSubject: args.commitMessage.subject,
    };
  }

  const changedFiles = await getChangedFilesForRange(args.cwd, args.validation.baseCommit, args.validation.finalCommit);
  const inspection = await inspectPlanDocDisposition(args.cwd, selectedPlanDoc, {
    changedFiles,
  });
  const planDocIncludedInReplacementCommit =
    inspection.repoRelativePath !== null &&
    !inspection.ignored &&
    (await commitTreePathExists(args.cwd, args.treeCommit ?? args.validation.finalCommit, inspection.repoRelativePath));
  const planDocDisposition: PlanDocDisposition =
    inspection.disposition === 'metadata_only_clean' && inspection.eligibleForCommit && planDocIncludedInReplacementCommit
      ? 'present_in_replacement_tree'
      : inspection.disposition;

  return {
    runId: args.selected.runId,
    selectedPlanDoc,
    normalizedPlanDoc: inspection.normalizedPlanDoc,
    planDocDisposition,
    planDocIncludedInReplacementCommit,
    commitMessageSource: args.commitMessage.source,
    commitMessageSubject: args.commitMessage.subject,
  };
}

export async function executeSquashForRun(args: {
  cwd: string;
  selected: SquashCandidate;
  validation: SquashValidation;
  commitMessage: SquashMessagePlan;
  artifactWriter?: (path: string, content: string) => Promise<void>;
}): Promise<ExecutedSquashResult> {
  const artifactPath = join(args.selected.runDir, 'SQUASH_RESULT.json');
  const writeArtifact = args.artifactWriter ?? writeTextAtomic;
  const pendingMetadata = await buildSquashResultMetadata({
    cwd: args.cwd,
    selected: args.selected,
    validation: args.validation,
    commitMessage: args.commitMessage,
    treeCommit: args.validation.finalCommit,
  });
  const pendingArtifact: SquashResultArtifact = {
    version: 1,
    status: 'pending',
    selectedRunDir: args.selected.runDir,
    selectedPlanDoc: args.selected.planDoc ?? '',
    originalBaseCommit: args.validation.baseCommit,
    originalFinalCommit: args.validation.finalCommit,
    originalHeadCommit: args.validation.headCommit,
    originalCreatedCommits: [...args.validation.createdCommits],
    postPlanCommits: [...args.validation.postPlanCommits],
    replacementCommit: null,
    finalHeadCommit: null,
    generatedCommitMessage: args.commitMessage.message,
    squashedAt: null,
    metadata: pendingMetadata,
  };

  await writeArtifact(artifactPath, JSON.stringify(pendingArtifact, null, 2) + '\n');

  const replacementCommit = await createSquashReplacementCommit(
    args.cwd,
    args.validation.baseCommit,
    args.validation.finalCommit,
    args.commitMessage.message,
  );
  let finalHeadCommit: string;
  try {
    if (args.validation.postPlanCommits.length === 0) {
      await resetHard(args.cwd, replacementCommit);
    } else {
      await rebaseCurrentBranchOnto(args.cwd, replacementCommit, args.validation.finalCommit);
    }
    finalHeadCommit = await getHeadCommit(args.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Squash replacement commit ${replacementCommit} was created, but Neal could not finish rewriting history. ` +
        `If Git stopped during rebase, resolve conflicts and run \`git rebase --continue\`, or run \`git rebase --abort\` to return to the pre-squash history. ` +
        `Underlying error: ${message}`,
    );
  }
  const completeMetadata = await buildSquashResultMetadata({
    cwd: args.cwd,
    selected: args.selected,
    validation: args.validation,
    commitMessage: args.commitMessage,
    treeCommit: replacementCommit,
  });
  const artifact: SquashResultArtifact = {
    ...pendingArtifact,
    status: 'complete',
    replacementCommit,
    finalHeadCommit,
    squashedAt: new Date().toISOString(),
    metadata: completeMetadata,
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
    finalHeadCommit,
    artifactPath,
    artifact,
  };
}

async function readCompletedSquashArtifact(selected: SquashCandidate) {
  const artifactPath = join(selected.runDir, 'SQUASH_RESULT.json');
  let parsed: SquashResultArtifact;
  try {
    parsed = JSON.parse(await readFile(artifactPath, 'utf8')) as SquashResultArtifact;
  } catch {
    return null;
  }

  if (
    parsed.version !== 1 ||
    parsed.status !== 'complete' ||
    typeof parsed.originalFinalCommit !== 'string' ||
    typeof parsed.replacementCommit !== 'string' ||
    typeof parsed.finalHeadCommit !== 'string'
  ) {
    return null;
  }

  return {
    artifactPath,
    artifact: parsed as CompletedSquashArtifact,
  };
}

function validateExplicitRunDirName(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('runDirName must be a single explicit run directory name');
  }
  return trimmed;
}

function isPathInside(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}
