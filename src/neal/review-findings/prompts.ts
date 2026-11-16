import { getRangeDiffArtifactLines } from '../prompts/review-doctrine.js';
import type { ReviewFindingsContext, ReviewFindingsDraft } from './types.js';

const DIFF_PREVIEW_LIMIT = 12000;

// The accepted findings artifact is read by a human who was not part of the
// review and may not know the codebase, so both the draft fields and the
// reviewer's finalMarkdown must be written in plain language. Precision is not
// negotiable: paths, identifiers, numbers, and SHAs stay exact; only the
// wording around them gets simpler.
export const REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES = [
  'Write for a human reader who was not part of this review and may not know the codebase: short sentences, one idea per sentence, everyday words.',
  'Do not use jargon, shorthand, or undefined abbreviations when a plain phrase says the same thing. When a technical term is necessary, say in plain words what it means for the reader the first time you use it.',
  'Keep exact file paths, identifiers, numbers, commit SHAs, and command names. Plain wording must not drop, blur, or soften a technical fact.',
  'State each claim as what happens and why it matters. State each requiredAction as a concrete step a maintainer can take without re-reading the diff.',
];

export const REVIEW_FINDINGS_READ_ONLY_RULES = [
  'Do not mutate the repository.',
  'Do not make commits, amend commits, rebase, reset, squash, or rewrite history.',
  'Do not edit source files, Neal writer-run state, queue files, current-run pointers, or run-local RUN_STATE.json files.',
  'Do not run shell write commands or claim that fixes were applied.',
  'Review only the frozen selected commit range and the supplied instruction.',
  'The checkout may advance while this review is running; do not treat current HEAD or dirty worktree files as part of the review target unless they are in the supplied resolved range.',
  'Produce findings only; do not perform repair work.',
];

export function buildReviewFindingsRangeDiffSection(indexPath: string) {
  return [
    '## Selected-Range Diff Files',
    '',
    ...getRangeDiffArtifactLines({ indexPath }),
    'Verify draft claims against the surrounding code with your read tools; absence from a diff hunk is not evidence of absence from the repository.',
  ].join('\n');
}

export type ReviewFindingsDraftPromptContext = {
  round?: number;
  previousDraft?: ReviewFindingsDraft | null;
  reviewFindings?: readonly string[];
  maxRounds?: number;
};

export function buildReviewFindingsDraftPrompt(
  context: ReviewFindingsContext,
  draftContext: ReviewFindingsDraftPromptContext = {},
) {
  const round = draftContext.round ?? 1;
  const reviewFindings = draftContext.reviewFindings ?? [];
  return [
    '# Neal Review Findings Draft',
    '',
    `You are drafting round ${round}${draftContext.maxRounds ? `/${draftContext.maxRounds}` : ''} of a read-only \`neal review\` findings artifact.`,
    '',
    '## Read-Only Rules',
    '',
    ...REVIEW_FINDINGS_READ_ONLY_RULES.map((rule) => `- ${rule}`),
    '',
    '## Plain Language',
    '',
    ...REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES.map((rule) => `- ${rule}`),
    ...(reviewFindings.length > 0
      ? [
          '',
          '## Required Revision Findings',
          '',
          ...reviewFindings.map((finding) => `- ${finding}`),
          '',
          '## Previous Draft',
          '',
          renderDraftSummary(draftContext.previousDraft),
        ]
      : []),
    '',
    '## Review Instruction',
    '',
    context.instruction,
    '',
    '## Review Target',
    '',
    renderDraftContextSummary(context),
    '',
    'Return a summary, concrete findings, and warnings only. Each finding needs severity, files, claim, evidence, and requiredAction. Write the summary, every claim, evidence, requiredAction, and warning under the Plain Language rules above. Do not suggest that Neal applied fixes.',
  ].join('\n');
}

export function buildReviewFindingsReviewPrompt(
  context: ReviewFindingsContext,
  draft: ReviewFindingsDraft,
  rangeDiffIndexPath: string,
  round = 1,
) {
  return [
    '# Neal Review Findings Review',
    '',
    `Review findings draft round ${round} for missing important findings, weak evidence, false positives, wrong severity, unclear required actions, wording that breaks the Plain Language rules below, and insufficient test or integration analysis.`,
    '',
    '## Read-Only Rules',
    '',
    ...REVIEW_FINDINGS_READ_ONLY_RULES.map((rule) => `- ${rule}`),
    '',
    '## Plain Language',
    '',
    ...REVIEW_FINDINGS_PLAIN_LANGUAGE_RULES.map((rule) => `- ${rule}`),
    '',
    '## Review Instruction',
    '',
    context.instruction,
    '',
    '## Review Target',
    '',
    renderContextSummary(context),
    '',
    buildReviewFindingsRangeDiffSection(rangeDiffIndexPath),
    '',
    '## Draft Findings',
    '',
    renderDraftSummary(draft),
    '',
    'Return verdict=`accepted` only when the final findings artifact is ready. Return verdict=`revise` with concrete findings when another draft is required. Return verdict=`blocked` only when a safe read-only review cannot be produced. Keep accepted finalMarkdown read-only, artifact-ready, and written under the Plain Language rules above. Return empty strings for finalMarkdown or blockedReason when they do not apply.',
  ].join('\n');
}

function renderContextSummary(context: ReviewFindingsContext) {
  return [
    `Selector: ${formatSelector(context.selector)}`,
    `Resolved range: ${context.externalBaseCommit}..${context.externalHeadCommit}`,
    'Range stability: frozen at review startup; current HEAD/worktree may move independently.',
    `Commit count: ${context.externalCommits.length}`,
    '',
    'Commits:',
    ...renderList(context.externalCommitSubjects),
    '',
    'Changed files:',
    ...renderList(context.externalChangedFiles),
    '',
    'Diff stat:',
    context.diffStat.trim() || '(none)',
  ].join('\n');
}

function renderDraftContextSummary(context: ReviewFindingsContext) {
  return [
    renderContextSummary(context),
    '',
    'Diff preview:',
    renderDiffPreview(context.diff),
  ].join('\n');
}

function formatSelector(selector: ReviewFindingsContext['selector']) {
  switch (selector.kind) {
    case 'last':
      return `--last ${selector.count}`;
    case 'since':
      return `--since ${selector.baseRef}`;
  }
}

function renderDraftSummary(draft: ReviewFindingsDraft | null | undefined) {
  if (!draft) {
    return '(none)';
  }

  return [
    `Summary: ${draft.summary}`,
    '',
    'Findings:',
    ...(draft.findings.length === 0
      ? ['- (none)']
      : draft.findings.map(
          (finding, index) =>
            `- F${index + 1} [${finding.severity}] ${finding.claim} Files: ${finding.files.join(', ') || '(none)'} Evidence: ${finding.evidence} Required action: ${finding.requiredAction}`,
        )),
    '',
    'Warnings:',
    ...renderList(draft.warnings ?? []),
  ].join('\n');
}

function renderList(items: readonly string[]) {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- (none)'];
}

function renderDiffPreview(diff: string) {
  if (!diff.trim()) {
    return '(none)';
  }
  if (diff.length <= DIFF_PREVIEW_LIMIT) {
    return diff;
  }
  return `${diff.slice(0, DIFF_PREVIEW_LIMIT).trimEnd()}\n\n[diff truncated to ${DIFF_PREVIEW_LIMIT} characters for review prompt]`;
}
