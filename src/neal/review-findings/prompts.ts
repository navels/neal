import type { ReviewFindingsContext, ReviewFindingsDraft } from './types.js';

const DIFF_PREVIEW_LIMIT = 12000;

export const REVIEW_FINDINGS_READ_ONLY_RULES = [
  'Do not mutate the repository.',
  'Do not make commits, amend commits, rebase, reset, squash, or rewrite history.',
  'Do not edit source files, Neal writer-run state, queue files, current-run pointers, or run-local RUN_STATE.json files.',
  'Do not run shell write commands or claim that fixes were applied.',
  'Review only the frozen selected commit range and the supplied instruction.',
  'The checkout may advance while this review is running; do not treat current HEAD or dirty worktree files as part of the review target unless they are in the supplied resolved range.',
  'Produce findings only; do not perform repair work.',
];

/**
 * Read-only range-inspection section appended to the adjudication prompt for
 * reviewers with read tool access but no shell (the 'read-only' doctrine
 * access mode). The base adjudication prompt previews at most
 * DIFF_PREVIEW_LIMIT characters of the resolved-range diff; a read-only
 * reviewer cannot run git commands, so the read-only git_diff tool is its
 * only source of truth for what the range actually changed (deletions and
 * renames included). The section names the exact resolved revisions so the
 * reviewer does not have to parse them back out of the context summary, and
 * only claims the preview is truncated when it actually is.
 */
export function buildReviewFindingsReadOnlyInspectionSection(context: ReviewFindingsContext) {
  const previewTruncated = context.diff.trim() !== '' && context.diff.length > DIFF_PREVIEW_LIMIT;
  const sourceOfTruthLine = previewTruncated
    ? 'You have read-only repository tools: read_file, list_dir, grep, and git_diff. The diff preview above is truncated; the git_diff tool is the source of truth for what the resolved range actually changed, including deletions and renames that head-state file reads cannot reveal.'
    : 'You have read-only repository tools: read_file, list_dir, grep, and git_diff. The git_diff tool is the source of truth for what the resolved range actually changed, including deletions and renames that head-state file reads cannot reveal.';
  return [
    '## Read-Only Range Inspection',
    '',
    sourceOfTruthLine,
    `Before returning a verdict, inspect the resolved range with git_diff: first call git_diff with base ${context.externalBaseCommit}, head ${context.externalHeadCommit}, and stat:true for the changed-file overview, then request per-path diffs for the files the draft findings cite.`,
    'Verify draft claims against the surrounding code with read_file and grep; absence from a diff hunk is not evidence of absence from the repository.',
  ].join('\n');
}

/**
 * Inlined-diff section appended to the adjudication prompt for a read-only
 * reviewer that has read tools but no commit-range diff tool (native
 * Claude/Codex). The base adjudication prompt only previews at most
 * DIFF_PREVIEW_LIMIT characters of the resolved-range diff and such a reviewer
 * can neither run git commands nor call a git_diff tool, so Neal inlines the
 * full selected-range diff here as the source of truth and instructs only the
 * read tools the provider actually has. Reviewers that expose a commit-range
 * diff tool get buildReviewFindingsReadOnlyInspectionSection instead.
 */
export function buildReviewFindingsInlinedDiffSection(context: ReviewFindingsContext) {
  return [
    '## Inlined Selected-Range Diff',
    '',
    'You have read-only repository tools (read and search, no shell) but no commit-range diff tool, so the full selected-range diff is inlined below.',
    'This inlined diff is the source of truth for what the resolved range actually changed, including deletions and renames that head-state file reads cannot reveal.',
    `Resolved range: ${context.externalBaseCommit}..${context.externalHeadCommit}.`,
    'Verify draft claims against the surrounding code with your read tools; absence from a diff hunk is not evidence of absence from the repository.',
    '',
    context.diff.trim() === '' ? '(empty diff)' : context.diff,
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
    renderContextSummary(context),
    '',
    'Return a summary, concrete findings, and warnings only. Each finding needs severity, files, claim, evidence, and requiredAction. Do not suggest that Neal applied fixes.',
  ].join('\n');
}

export function buildReviewFindingsReviewPrompt(context: ReviewFindingsContext, draft: ReviewFindingsDraft, round = 1) {
  return [
    '# Neal Review Findings Review',
    '',
    `Review findings draft round ${round} for missing important findings, weak evidence, false positives, wrong severity, unclear required actions, and insufficient test or integration analysis.`,
    '',
    '## Read-Only Rules',
    '',
    ...REVIEW_FINDINGS_READ_ONLY_RULES.map((rule) => `- ${rule}`),
    '',
    '## Review Instruction',
    '',
    context.instruction,
    '',
    '## Review Target',
    '',
    renderContextSummary(context),
    '',
    '## Draft Findings',
    '',
    renderDraftSummary(draft),
    '',
    'Return verdict=`accepted` only when the final findings artifact is ready. Return verdict=`revise` with concrete findings when another draft is required. Return verdict=`blocked` only when a safe read-only review cannot be produced. Keep accepted finalMarkdown read-only and artifact-ready. Return empty strings for finalMarkdown or blockedReason when they do not apply.',
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
