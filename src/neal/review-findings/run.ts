import { readdir, readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

import {
  REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
  resolveReviewedDraftLoopStep,
} from '../adjudicator/contracts.js';
import type { ActivityReporter, ActivityUpdate } from '../activity-reporting.js';
import type { ParsedReviewArgs } from '../cli.js';
import { getMaxReviewRounds } from '../config.js';
import { getDiffForRange, getDiffStatForRange, getWorktreeStatus } from '../git.js';
import { createRunId, RunLogger } from '../logger.js';
import { resolveReviewTarget } from '../review-mode.js';
import {
  getCurrentPlanAndExecuteQueuePointerPath,
  getCurrentRunPointerPath,
  getRunsDir,
  getRunStatePath,
} from '../storage-paths.js';
import { formatDirtyWorktreeDiagnostic, parseWorktreeStatusLine } from '../worktree-status.js';
import {
  formatReviewResumeStdoutLine,
  getReviewFindingsArtifactPaths,
  writeReviewFindingsContext,
  writeReviewFindingsDraft,
  writeReviewFindingsEvent,
  writeReviewFindingsFinal,
  writeReviewFindingsMeta,
  writeReviewFindingsRequest,
  writeReviewFindingsReview,
  writeReviewFindingsRounds,
} from './artifacts.js';
import {
  createAgentReviewFindingsProviderAdapter,
  renderReviewFindingsFinalMarkdown,
  validateReviewFindingsDraft,
  validateReviewFindingsReview,
} from './provider.js';
import { buildReviewFindingsDraftPrompt, buildReviewFindingsReviewPrompt } from './prompts.js';
import type {
  ReviewFindingsArtifactPaths,
  ReviewFindingsContext,
  ReviewFindingsDraft,
  ReviewFindingsLoopRound,
  ReviewFindingsMeta,
  ReviewFindingsOutcome,
  ReviewFindingsProviderAdapter,
  ReviewFindingsReviewArtifact,
  ReviewFindingsRunResult,
} from './types.js';

type ProtectedStateSnapshot = {
  currentRunPointer: string | null;
  currentQueuePointer: string | null;
  runStates: Record<string, string>;
};

export type RunNealReviewCliArgs = {
  cwd: string;
  parsed: ParsedReviewArgs;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  provider?: ReviewFindingsProviderAdapter;
  now?: Date;
  reviewId?: string;
  onActivity?: ActivityReporter;
};

export async function runNealReviewCli(args: RunNealReviewCliArgs): Promise<ReviewFindingsRunResult> {
  const cwd = resolve(args.cwd);
  const createdAt = (args.now ?? new Date()).toISOString();
  const reviewId = args.reviewId ?? createRunId();
  const paths = getReviewFindingsArtifactPaths(cwd, reviewId);
  const reviewLogger = args.provider ? undefined : new RunLogger(paths.reviewDir);
  const provider = args.provider ?? createAgentReviewFindingsProviderAdapter({ cwd, logger: reviewLogger });
  const maxRounds = Math.max(1, Math.floor(getMaxReviewRounds(cwd)));

  await reportActivity(args, {
    activity: 'resolving review target',
    detailContext: { runId: reviewId, phase: 'review' },
  });
  const target = await resolveReviewTarget(cwd, args.parsed);
  writeReviewStartupDiagnostics(args.stderr, target.externalCommits.length, target.externalBaseCommit, target.externalHeadCommit, args.parsed);
  await reportActivity(args, {
    activity: 'building review context',
    detailContext: { runId: reviewId, phase: 'review' },
  });
  const beforeState = await captureProtectedStateSnapshot(cwd);
  const beforeWorktreeStatus = await captureReviewReadOnlyWorktreeStatus(cwd, reviewId);
  const context = await buildReviewFindingsContext(cwd, args.parsed, target);

  let outcome: ReviewFindingsOutcome = 'failed';
  let finalMarkdown: string | null = null;
  const rounds: ReviewFindingsLoopRound[] = [];
  let previousDraft: ReviewFindingsDraft | null = null;
  let reviewFindings: string[] = [];

  const buildMeta = (nextOutcome: ReviewFindingsOutcome): ReviewFindingsMeta => ({
    version: 1,
    reviewId,
    createdAt,
    cwd,
    instruction: args.parsed.instruction,
    instructionSource: args.parsed.instructionSource,
    selector: args.parsed.selector,
    target,
    reviewDir: paths.reviewDir,
    maxRounds,
    outcome: nextOutcome,
  });

  await writeReviewFindingsMeta(paths, buildMeta('failed'));
  await writeReviewFindingsEvent(paths, 'review.started', {
    selectorKind: args.parsed.selector.kind,
    externalBaseCommit: target.externalBaseCommit,
    externalHeadCommit: target.externalHeadCommit,
    externalCommitCount: target.externalCommits.length,
    loopKind: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT.loopKind,
    sideEffectPolicy: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT.sideEffectPolicy,
    roundCapSource: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT.roundCap.source,
    maxRounds,
  });
  await writeReviewFindingsContext(paths, context);

  try {
    for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber += 1) {
      await reportActivity(args, {
        activity: `coder drafting review findings round ${roundNumber}/${maxRounds}`,
        detailContext: { runId: reviewId, phase: 'review', scopeNumber: roundNumber },
      });
      const draftPrompt = buildReviewFindingsDraftPrompt(context, {
        round: roundNumber,
        previousDraft,
        reviewFindings,
        maxRounds,
      });
      let draftSessionHandle: string | null = null;
      const draftResponse = await provider.draftFindings({
        context,
        round: roundNumber,
        previousDraft,
        reviewFindings,
        prompt: draftPrompt,
        onSessionHandle: (handle) => {
          draftSessionHandle = handle;
        },
      });
      await assertReviewReadOnlyStateUnchanged(cwd, beforeState);
      await assertReviewReadOnlyWorktreeUnchanged(cwd, reviewId, beforeWorktreeStatus);
      const draft = validateReviewFindingsDraft(draftResponse);
      await writeReviewFindingsEvent(paths, 'review.draft_completed', {
        round: roundNumber,
        findingCount: draft.findings.length,
      });

      await reportActivity(args, {
        activity: `reviewer checking review findings round ${roundNumber}/${maxRounds}`,
        detailContext: { runId: reviewId, phase: 'review', scopeNumber: roundNumber },
      });
      const reviewPrompt = buildReviewFindingsReviewPrompt(context, draft, roundNumber);
      let reviewSessionHandle: string | null = null;
      const reviewResponse = await provider.reviewDraft({
        context,
        round: roundNumber,
        draft,
        prompt: reviewPrompt,
        onSessionHandle: (handle) => {
          reviewSessionHandle = handle;
        },
      });
      await assertReviewReadOnlyStateUnchanged(cwd, beforeState);
      await assertReviewReadOnlyWorktreeUnchanged(cwd, reviewId, beforeWorktreeStatus);
      const review = validateReviewFindingsReview(reviewResponse);
      const loopRound: ReviewFindingsLoopRound = {
        round: roundNumber,
        draftPrompt,
        reviewPrompt,
        draft,
        review,
        // Only record handles when captured, so artifacts stay byte-identical
        // for non-SDK providers.
        ...(draftSessionHandle ? { draftSessionHandle } : {}),
        ...(reviewSessionHandle ? { reviewSessionHandle } : {}),
      };
      rounds.push(loopRound);
      await writeReviewFindingsEvent(paths, 'review.review_completed', {
        round: roundNumber,
        verdict: review.verdict,
        findingCount: review.findings.length,
      });

      const loopStep = resolveReviewedDraftLoopStep({
        ownerId: 'review',
        contract: REVIEW_FINDINGS_ADJUDICATED_LOOP_CONTRACT,
        verdict: review.verdict,
        round: roundNumber,
        maxRounds,
      });

      if (loopStep.terminalOutcome === 'accepted') {
        outcome = loopStep.terminalOutcome;
        finalMarkdown = review.finalMarkdown ?? renderReviewFindingsFinalMarkdown(context, draft, review);
        await reportActivity(args, {
          activity: 'review findings accepted',
          status: 'done',
          detailContext: { runId: reviewId, phase: 'review', scopeNumber: roundNumber },
        });
        break;
      }

      if (loopStep.terminalOutcome) {
        outcome = loopStep.terminalOutcome;
        await reportActivity(args, {
          activity: `review findings ${loopStep.terminalOutcome}`,
          status: loopStep.terminalOutcome === 'blocked' ? 'blocked' : 'failed',
          detailContext: { runId: reviewId, phase: 'review', scopeNumber: roundNumber },
        });
        break;
      }

      previousDraft = draft;
      reviewFindings = review.findings;
    }

    await assertReviewReadOnlyStateUnchanged(cwd, beforeState);
    await assertReviewReadOnlyWorktreeUnchanged(cwd, reviewId, beforeWorktreeStatus);
  } catch (error) {
    outcome = 'failed';
    await reportActivity(args, {
      activity: 'review failed',
      status: 'failed',
      detailContext: { runId: reviewId, phase: 'review' },
    });
    await persistReviewFindingsLoopArtifacts(paths, buildMeta(outcome), {
      version: 1,
      outcome,
      maxRounds,
      rounds,
    });
    await writeReviewFindingsEvent(paths, 'review.failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const meta = buildMeta(outcome);
  const reviewArtifact: ReviewFindingsReviewArtifact = {
    version: 1,
    outcome,
    maxRounds,
    rounds,
  };
  await persistReviewFindingsLoopArtifacts(paths, meta, reviewArtifact);

  if (outcome !== 'accepted' || !finalMarkdown) {
    await writeReviewFindingsEvent(paths, outcome === 'cap_reached' ? 'review.cap_reached' : 'review.blocked', {
      roundCount: rounds.length,
      outcome,
    });
    throw new Error(formatUnacceptedReviewError(outcome, paths.reviewDir, rounds));
  }

  const acceptedRound = rounds[rounds.length - 1];
  if (!acceptedRound) {
    throw new Error(`Review ${reviewId} accepted without a recorded round`);
  }

  await writeReviewFindingsFinal(paths, finalMarkdown, acceptedRound, cwd);
  await writeReviewFindingsEvent(paths, 'review.completed', {
    finalBytes: Buffer.byteLength(finalMarkdown, 'utf8'),
    findingCount: acceptedRound.draft.findings.length,
    roundCount: rounds.length,
  });

  const resumeLine = formatReviewResumeStdoutLine(cwd, acceptedRound);
  args.stdout.write(
    `${finalMarkdown.trimEnd()}\n\nReview findings accepted: ${paths.final}\n${resumeLine ? `${resumeLine}\n` : ''}`,
  );

  return {
    reviewId,
    paths,
    meta,
    context,
    draft: acceptedRound.draft,
    review: acceptedRound.review,
    rounds,
    outcome,
    finalMarkdown,
  };
}

async function reportActivity(args: RunNealReviewCliArgs, update: ActivityUpdate) {
  await args.onActivity?.(update);
}

async function buildReviewFindingsContext(
  cwd: string,
  parsed: ParsedReviewArgs,
  target: Awaited<ReturnType<typeof resolveReviewTarget>>,
): Promise<ReviewFindingsContext> {
  return {
    version: 1,
    instruction: parsed.instruction,
    instructionSource: parsed.instructionSource,
    selector: parsed.selector,
    baseRef: target.baseRef,
    headRef: target.headRef,
    externalBaseCommit: target.externalBaseCommit,
    externalHeadCommit: target.externalHeadCommit,
    externalCommits: target.externalCommits,
    externalCommitSubjects: target.externalCommitSubjects,
    externalChangedFiles: target.externalChangedFiles,
    diffStat: await getDiffStatForRange(cwd, target.externalBaseCommit, target.externalHeadCommit),
    diff: await getDiffForRange(cwd, target.externalBaseCommit, target.externalHeadCommit),
  };
}

async function persistReviewFindingsLoopArtifacts(
  paths: ReviewFindingsArtifactPaths,
  meta: ReviewFindingsMeta,
  reviewArtifact: ReviewFindingsReviewArtifact,
) {
  await writeReviewFindingsMeta(paths, meta);
  await writeReviewFindingsRequest(paths, meta, reviewArtifact.rounds);
  await writeReviewFindingsDraft(paths, reviewArtifact.rounds);
  await writeReviewFindingsReview(paths, reviewArtifact);
  await writeReviewFindingsRounds(paths, reviewArtifact);
}

function formatUnacceptedReviewError(
  outcome: ReviewFindingsOutcome,
  reviewDir: string,
  rounds: readonly ReviewFindingsLoopRound[],
) {
  const latestRound = rounds[rounds.length - 1];
  const latestReview = latestRound?.review;
  const detail = latestReview?.blockedReason ??
    latestReview?.findings.join('; ') ??
    'The review loop did not produce accepted findings.';
  if (outcome === 'cap_reached') {
    return `neal review reached the review round cap without accepted findings. Latest finding: ${detail}. Artifacts: ${reviewDir}`;
  }
  if (outcome === 'blocked') {
    return `neal review was blocked before producing accepted findings. Latest finding: ${detail}. Artifacts: ${reviewDir}`;
  }
  return `neal review failed before producing accepted findings. Artifacts: ${reviewDir}`;
}

function shortCommit(commit: string) {
  return commit.slice(0, 7);
}

function formatCommitCount(count: number) {
  return `${count} ${count === 1 ? 'commit' : 'commits'}`;
}

function writeReviewStartupDiagnostics(
  stderr: NodeJS.WritableStream,
  commitCount: number,
  baseCommit: string,
  headCommit: string,
  parsed: ParsedReviewArgs,
) {
  stderr.write(`[neal] review: analyzing ${formatCommitCount(commitCount)}\n`);
  stderr.write(`[neal] review range: ${shortCommit(baseCommit)}..${shortCommit(headCommit)}\n`);
  if (parsed.instructionSource === 'default') {
    stderr.write('[neal] review posture: built-in findings review\n');
  } else {
    stderr.write(`[neal] user review context: ${parsed.instruction}\n`);
  }
}

async function captureProtectedStateSnapshot(cwd: string): Promise<ProtectedStateSnapshot> {
  return {
    currentRunPointer: await readOptionalText(getCurrentRunPointerPath(cwd)),
    currentQueuePointer: await readOptionalText(getCurrentPlanAndExecuteQueuePointerPath(cwd)),
    runStates: await readRunStates(cwd),
  };
}

async function assertReviewReadOnlyStateUnchanged(cwd: string, before: ProtectedStateSnapshot) {
  const after = await captureProtectedStateSnapshot(cwd);
  if (after.currentRunPointer !== before.currentRunPointer) {
    throw new Error('neal review is read-only but .neal/current.json changed');
  }
  if (after.currentQueuePointer !== before.currentQueuePointer) {
    throw new Error('neal review is read-only but .neal/current-queue.json changed');
  }
  assertSameStringMap(before.runStates, after.runStates, 'run-local RUN_STATE.json files');
}

async function captureReviewReadOnlyWorktreeStatus(cwd: string, reviewId: string) {
  return filterReviewArtifactWorktreeStatus(await getWorktreeStatus(cwd, { untrackedFiles: 'all' }), reviewId);
}

async function assertReviewReadOnlyWorktreeUnchanged(cwd: string, reviewId: string, beforeStatus: string) {
  const afterStatus = await captureReviewReadOnlyWorktreeStatus(cwd, reviewId);
  if (afterStatus === beforeStatus) {
    return;
  }

  const scratchDiagnostic = formatDirtyWorktreeDiagnostic({ statusOutput: afterStatus });
  throw new Error(
    [
      'neal review is read-only but the worktree changed outside its review artifacts:',
      'Before:',
      beforeStatus || '(clean)',
      'After:',
      afterStatus || '(clean)',
      scratchDiagnostic,
    ].filter(Boolean).join('\n'),
  );
}

function filterReviewArtifactWorktreeStatus(statusOutput: string, reviewId: string) {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const paths = parseWorktreeStatusLine(line)?.paths ?? [];
      return paths.length === 0 || paths.some((path) => !isReviewArtifactPath(path, reviewId));
    })
    .join('\n');
}

function isReviewArtifactPath(path: string, reviewId: string) {
  const normalized = normalize(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const reviewPrefix = `.neal/reviews/${reviewId}`;
  return normalized === reviewPrefix || normalized.startsWith(`${reviewPrefix}/`);
}

async function readOptionalText(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function readRunStates(cwd: string) {
  const runsDir = getRunsDir(cwd);
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }

  const states: Record<string, string> = {};
  for (const entry of entries.sort()) {
    const statePath = getRunStatePath(join(runsDir, entry));
    const content = await readOptionalText(statePath);
    if (content !== null) {
      states[entry] = content;
    }
  }
  return states;
}

function assertSameStringMap(before: Record<string, string>, after: Record<string, string>, label: string) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (beforeKeys.join('\n') !== afterKeys.join('\n')) {
    throw new Error(`neal review is read-only but ${label} changed`);
  }
  for (const key of beforeKeys) {
    if (before[key] !== after[key]) {
      throw new Error(`neal review is read-only but ${label} changed for ${key}`);
    }
  }
}

function isMissingFileError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
