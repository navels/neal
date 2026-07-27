import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from '../atomic-write.js';
import { getReviewsDir } from '../storage-paths.js';
import type {
  ReviewFindingsArtifactPaths,
  ReviewFindingsContext,
  ReviewFindingsDraft,
  ReviewFindingsLoopRound,
  ReviewFindingsMeta,
  ReviewFindingsReviewArtifact,
} from './types.js';

export function getReviewFindingsArtifactPaths(cwd: string, reviewId: string): ReviewFindingsArtifactPaths {
  const reviewDir = join(getReviewsDir(cwd), reviewId);
  return {
    reviewDir,
    meta: join(reviewDir, 'meta.json'),
    events: join(reviewDir, 'events.ndjson'),
    request: join(reviewDir, 'REVIEW_REQUEST.md'),
    context: join(reviewDir, 'REVIEW_CONTEXT.json'),
    draft: join(reviewDir, 'REVIEW_DRAFT.md'),
    review: join(reviewDir, 'REVIEW_REVIEW.json'),
    rounds: join(reviewDir, 'REVIEW_ROUNDS.json'),
    final: join(reviewDir, 'REVIEW_FINAL.md'),
  };
}

export async function writeReviewFindingsMeta(paths: ReviewFindingsArtifactPaths, meta: ReviewFindingsMeta) {
  await writeJsonAtomic(paths.meta, meta);
}

export async function writeReviewFindingsEvent(
  paths: ReviewFindingsArtifactPaths,
  type: string,
  data?: Record<string, unknown>,
) {
  await mkdir(paths.reviewDir, { recursive: true });
  await appendFile(
    paths.events,
    JSON.stringify({
      ts: new Date().toISOString(),
      type,
      data,
    }) + '\n',
    'utf8',
  );
}

export async function writeReviewFindingsRequest(
  paths: ReviewFindingsArtifactPaths,
  meta: ReviewFindingsMeta,
  rounds: readonly ReviewFindingsLoopRound[],
) {
  await writeTextAtomic(
    paths.request,
    [
      '# Review Request',
      '',
      `Review ID: ${meta.reviewId}`,
      `Created: ${meta.createdAt}`,
      `Instruction source: ${meta.instructionSource}`,
      '',
      '## Instruction',
      '',
      meta.instruction,
      '',
      '## Selector',
      '',
      ...formatSelector(meta.selector),
      '',
      '## Resolved Range',
      '',
      `- External base commit: ${meta.target.externalBaseCommit}`,
      `- External head commit: ${meta.target.externalHeadCommit}`,
      `- External commit count: ${meta.target.externalCommits.length}`,
      '',
      '## Loop',
      '',
      `Outcome: ${meta.outcome}`,
      `Max rounds: ${meta.maxRounds}`,
      '',
      ...rounds.flatMap((round) => [
        `## Round ${round.round} Draft Prompt`,
        '',
        round.draftPrompt,
        '',
        `## Round ${round.round} Review Prompt`,
        '',
        round.reviewPrompt,
        '',
      ]),
    ].join('\n') + '\n',
  );
}

export async function writeReviewFindingsContext(
  paths: ReviewFindingsArtifactPaths,
  context: ReviewFindingsContext,
) {
  await writeJsonAtomic(paths.context, context);
}

export async function writeReviewFindingsDraft(
  paths: ReviewFindingsArtifactPaths,
  rounds: readonly ReviewFindingsLoopRound[],
) {
  await writeTextAtomic(
    paths.draft,
    [
      '# Review Draft',
      '',
      ...rounds.flatMap((round) => [
        `## Round ${round.round}`,
        '',
        round.draft.summary,
        '',
        '### Findings',
        '',
        ...formatFindings(round.draft.findings),
        '',
        '### Warnings',
        '',
        ...formatWarnings(round.draft.warnings ?? []),
        '',
      ]),
    ].join('\n') + '\n',
  );
}

export async function writeReviewFindingsReview(
  paths: ReviewFindingsArtifactPaths,
  artifact: ReviewFindingsReviewArtifact,
) {
  await writeJsonAtomic(paths.review, artifact);
}

export async function writeReviewFindingsRounds(
  paths: ReviewFindingsArtifactPaths,
  artifact: ReviewFindingsReviewArtifact,
) {
  await writeJsonAtomic(paths.rounds, artifact);
}

export async function writeReviewFindingsFinal(
  paths: ReviewFindingsArtifactPaths,
  finalMarkdown: string,
  acceptedRound: ReviewFindingsLoopRound,
  cwd: string,
) {
  const resumeSection = formatReviewResumeSection(cwd, acceptedRound);
  await writeTextAtomic(
    paths.final,
    [
      finalMarkdown.trimEnd(),
      '',
      '## Accepted Review Round',
      '',
      `Round: ${acceptedRound.round}`,
      `Verdict: ${acceptedRound.review.verdict}`,
      ...(resumeSection.length > 0 ? ['', ...resumeSection] : []),
      '',
    ].join('\n'),
  );
}

// The reviewer/draft turns run through the Claude Agent SDK, whose sessions are
// persisted to ~/.claude/projects but deliberately hidden from the interactive
// `/resume` picker — they are only resumable by id. Surface those ids so an
// operator can reopen the reviewer's full context to ask "why did it conclude
// X". Returns [] when no handles were captured (e.g. non-SDK/test providers).
export function formatReviewResumeSection(cwd: string, round: ReviewFindingsLoopRound): string[] {
  const resumable = collectResumableHandles(round);
  if (resumable.length === 0) {
    return [];
  }
  return [
    '## Resume Sessions',
    '',
    `These reviewer/coder turns ran through the Claude Agent SDK. Such sessions do not appear in the interactive \`/resume\` picker, but you can resume one by id from the reviewed directory (${cwd}):`,
    '',
    ...resumable.map(([label, handle]) => `- ${label}: \`claude --resume ${handle}\``),
  ];
}

// Compact one-line resume hint for stdout, preferring the reviewer session
// (the one most useful for interrogating the verdict). Null when no handle was
// captured.
export function formatReviewResumeStdoutLine(cwd: string, round: ReviewFindingsLoopRound): string | null {
  const reviewer = nonEmptyHandle(round.reviewSessionHandle);
  const draft = nonEmptyHandle(round.draftSessionHandle);
  const handle = reviewer ?? draft;
  if (!handle) {
    return null;
  }
  const which = reviewer ? 'reviewer' : 'draft';
  return `Resume the ${which} session: (cd ${cwd} && claude --resume ${handle})`;
}

function collectResumableHandles(round: ReviewFindingsLoopRound): Array<[string, string]> {
  const entries: Array<[string, string | null | undefined]> = [
    ['Reviewer', round.reviewSessionHandle],
    ['Draft (coder)', round.draftSessionHandle],
  ];
  return entries
    .map(([label, handle]): [string, string | null] => [label, nonEmptyHandle(handle)])
    .filter((entry): entry is [string, string] => entry[1] !== null);
}

function nonEmptyHandle(handle: string | null | undefined): string | null {
  return typeof handle === 'string' && handle.trim() !== '' ? handle : null;
}

function formatSelector(selector: ReviewFindingsMeta['selector']) {
  switch (selector.kind) {
    case 'last':
      return [`- Form: --last`, `- Count: ${selector.count}`];
    case 'since':
      return [`- Form: --since`, `- Base ref: ${selector.baseRef}`, `- Head ref: HEAD (implicit)`];
  }
}

function formatFindings(findings: ReviewFindingsDraft['findings']) {
  if (findings.length === 0) {
    return ['- (none)'];
  }

  return findings.map(
    (finding, index) =>
      `- F${index + 1} [${finding.severity}] ${finding.claim} (${finding.files.join(', ') || 'no files'}): ${finding.evidence} Required action: ${finding.requiredAction}`,
  );
}

function formatWarnings(warnings: string[]) {
  if (warnings.length === 0) {
    return ['- (none)'];
  }
  return warnings.map((warning) => `- ${warning}`);
}
