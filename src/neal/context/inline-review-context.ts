import { readFile } from 'node:fs/promises';

import { getProviderDefinition, isRegisteredProviderId } from '../providers/registry.js';
import type { ReviewDoctrineAccessMode } from '../prompts/review-doctrine.js';
import type { AgentRoleConfig } from '../types.js';

// Per-section character cap for inlined reviewer context. Mirrors the
// truncation posture of truncateForPrompt in src/neal/agents/structured-json.ts:
// truncate with an explicit marker instead of silently dropping content.
export const INLINE_SECTION_MAX_CHARS = 200_000;

export type InlineReviewerContextSection = {
  title: string;
  body: string;
};

export type InlineReviewerContext = {
  sections: InlineReviewerContextSection[];
};

// Canonical forbidden-phrase list for no-read prompts (today: the blocked-run
// consultant, which always judges from Neal-inlined in-memory context). A
// no-read prompt must contain no instruction that requires repository, file,
// tool, or shell access of any kind. Both the prompt-builder implementations
// and the runtime capture tests assert against this shared list, so a newly
// added repo-access phrase fails the shared assertion rather than silently
// passing.
export const NO_READ_PROMPT_FORBIDDEN_MARKERS: readonly string[] = [
  'repository tools',
  'repository inspection',
  'git diff',
  'git log',
  'git show',
  'scratch directory',
  // "Read <path>"-style pointer phrasings ("Prior review history is available
  // at <path>", "REVIEW.md is available at <path>", ...).
  'is available at',
  'Inspect cited artifacts',
];

// Two-way review-doctrine access mode for the configured reviewer provider's
// structured-advisor role. Unregistered provider ids default to 'tool-access'.
// Every registered reviewer provider has repository read access; read access
// without shell access selects 'read-only' (the reviewer inspects the
// repository with read tools but must not be instructed to run commands);
// read plus shell access selects 'tool-access'. Write access does not affect
// review doctrine: reviews never instruct repository mutation.
export function getReviewerDoctrineAccessMode(reviewer: AgentRoleConfig): ReviewDoctrineAccessMode {
  if (!isRegisteredProviderId(reviewer.provider)) {
    return 'tool-access';
  }

  const toolAccess = getProviderDefinition(reviewer.provider).capabilities['structured-advisor'].toolAccess;
  if (toolAccess.shell === false) {
    return 'read-only';
  }

  return 'tool-access';
}

// True when the configured reviewer is a read-only reviewer (read tools, no
// shell) that has no commit-range diff tool of its own, so Neal must inline the
// commit-range diff into its reviewer prompt. Read-only reviewers that expose a
// commit-range diff tool (providesRangeDiffTool === true, e.g. openai-compatible)
// inspect the range with that tool and do not receive an inlined diff, and
// tool-access reviewers run shell git themselves.
export function readOnlyReviewerNeedsInlinedDiff(reviewer: AgentRoleConfig): boolean {
  if (!isRegisteredProviderId(reviewer.provider)) {
    return false;
  }

  if (getReviewerDoctrineAccessMode(reviewer) !== 'read-only') {
    return false;
  }

  return getProviderDefinition(reviewer.provider).capabilities['structured-advisor'].providesRangeDiffTool !== true;
}

// Renders the Neal-inlined commit-range diff section for a read-only reviewer
// that lacks a commit-range diff tool. Unlike renderInlineReviewerContext (the
// no-read framing that denies all repository access), this framing affirms the
// reviewer's read tools and presents the inlined diff only as the source of
// truth for what the range changed.
export function renderInlinedRangeDiffSection(args: { rangeLabel: string; diff: string }): string {
  return [
    `## Inlined commit-range diff from Neal (${args.rangeLabel})`,
    '',
    'You have read-only repository tools (read and search, no shell) but no commit-range diff tool, so Neal has inlined the commit-range diff below.',
    'This inlined diff is the source of truth for exactly what this range changed, including deletions and renames that head-state file reads cannot reveal. Use your read tools to verify the surrounding code.',
    '',
    args.diff.trim() === '' ? '(empty diff)' : truncateInlineSectionBody(args.diff),
  ].join('\n');
}

// Best-effort artifact read for inline reviewer sections. Missing or
// unreadable artifacts inline as empty content (callers substitute an explicit
// "(unavailable)" placeholder) instead of failing the reviewer round.
export async function readTextForInlineSection(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export function truncateInlineSectionBody(body: string, maxChars = INLINE_SECTION_MAX_CHARS): string {
  if (body.length <= maxChars) {
    return body;
  }

  return `${body.slice(0, maxChars)}\n[truncated ${body.length - maxChars} character(s)]`;
}

export function createInlineSection(title: string, body: string): InlineReviewerContextSection {
  return {
    title,
    body: truncateInlineSectionBody(body),
  };
}

export function renderInlineReviewerContext(context: InlineReviewerContext): string {
  return [
    '## Inlined review context from Neal',
    '',
    'You do not have repository, file, shell, or tool access of any kind for this review.',
    'Neal has inlined every artifact you need below. The inlined sections are the source of truth for this review; judge entirely from this prompt.',
    'Do not report the lack of repository access as a finding; it is expected for this reviewer configuration.',
    ...context.sections.flatMap((section) => ['', `### ${section.title}`, '', section.body]),
  ].join('\n');
}

// Implementation-side guard for builder-owned static instruction text in
// no-read prompt variants. Call it only on Neal-authored instruction lines
// (never on dynamic content such as diffs, coder-authored justifications, or
// operator guidance, which may legitimately mention these phrases).
export function assertNoReadPromptInstructionText(text: string, label: string) {
  const lowered = text.toLowerCase();
  const violations = NO_READ_PROMPT_FORBIDDEN_MARKERS.filter((marker) => lowered.includes(marker.toLowerCase()));
  if (violations.length > 0) {
    throw new Error(
      `${label} produced no-read reviewer instructions containing forbidden repository-access phrasing: ${violations.join(', ')}`,
    );
  }
}
