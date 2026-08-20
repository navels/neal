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

// The draft and reviewer turns run through provider SDKs (Claude Agent SDK,
// Codex SDK). Those sessions are persisted by each CLI but hidden from its
// interactive resume picker, so they are only resumable by id. Surface the ids
// with the right command per provider so an operator can reopen the full
// context and ask "why did it conclude X". Returns [] when no handles were
// captured (e.g. non-SDK/test providers).
export function formatReviewResumeSection(cwd: string, round: ReviewFindingsLoopRound): string[] {
  const resumable = collectResumableSessions(round);
  if (resumable.length === 0) {
    return [];
  }
  return [
    '## Resume Sessions',
    '',
    `These draft/reviewer turns ran through provider SDKs. Their sessions do not appear in the interactive resume pickers, but you can resume one by id from the reviewed directory (${cwd}):`,
    '',
    ...resumable.map((session) => `- ${formatResumeSessionLine(session)}`),
  ];
}

// Compact one-line resume hint for stdout, preferring the reviewer session
// (the one most useful for interrogating the verdict) and skipping any session
// whose provider has no known resume command. Null when nothing is resumable.
export function formatReviewResumeStdoutLine(cwd: string, round: ReviewFindingsLoopRound): string | null {
  const session = collectResumableSessions(round).find((candidate) => resumeCommand(candidate) !== null);
  if (!session) {
    return null;
  }
  return `Resume the ${session.role} session: (cd ${cwd} && ${resumeCommand(session)})`;
}

type ResumableSession = {
  role: 'reviewer' | 'draft';
  label: string;
  handle: string;
  provider: string | null;
};

// CLI resume commands by provider id. A provider missing here still gets its
// session id listed, just without a command. openai-compatible never surfaces
// handles (no session resume), so it never reaches this table.
const RESUME_COMMANDS: Record<string, (handle: string) => string> = {
  'anthropic-claude': (handle) => `claude --resume ${handle}`,
  'openai-codex': (handle) => `codex resume ${handle}`,
};

function resumeCommand(session: ResumableSession): string | null {
  const build = session.provider ? RESUME_COMMANDS[session.provider] : undefined;
  return build ? build(session.handle) : null;
}

function formatResumeSessionLine(session: ResumableSession): string {
  const command = resumeCommand(session);
  const who = session.provider ? `${session.label} (${session.provider})` : session.label;
  if (command) {
    return `${who}: \`${command}\``;
  }
  return `${who}: session id \`${session.handle}\` (no known resume command for this provider)`;
}

function collectResumableSessions(round: ReviewFindingsLoopRound): ResumableSession[] {
  const candidates: Array<[ResumableSession['role'], string, string | null | undefined, string | null | undefined]> = [
    ['reviewer', 'Reviewer', round.reviewSessionHandle, round.reviewSessionProvider],
    ['draft', 'Draft (coder)', round.draftSessionHandle, round.draftSessionProvider],
  ];
  return candidates.flatMap(([role, label, handle, provider]) => {
    const nonEmpty = nonEmptyHandle(handle);
    return nonEmpty ? [{ role, label, handle: nonEmpty, provider: provider?.trim() ? provider : null }] : [];
  });
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
