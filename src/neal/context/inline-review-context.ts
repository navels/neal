import { readFile } from 'node:fs/promises';

import { getProviderDefinition, isRegisteredProviderId } from '../providers/registry.js';
import type { ReviewDoctrineAccessMode } from '../prompts/review-doctrine.js';
import type { AgentRoleConfig } from '../types.js';

// Per-section character cap for inlined reviewer context. Mirrors the
// truncation posture of truncateForPrompt in src/neal/agents/structured-json.ts:
// truncate with an explicit marker instead of silently dropping content.
export const INLINE_SECTION_MAX_CHARS = 200_000;

// Fixed aggregate character budget for the free-text values of one
// agent-authored payload embedded in another agent's prompt (review-finding
// text, progress justifications, completion summaries). The budget covers the
// total rendered free text including truncation markers, so the free-text
// contribution of a section never exceeds this constant. Control data (ids,
// severities, statuses, file paths) never rides this budget: callers render it
// separately and exactly via boundOpenFindingsForPrompt-style wrappers.
export const AGENT_FREE_TEXT_SECTION_MAX_CHARS = 20_000;

// Upper bound on one rendered truncation marker:
// '\n[truncated N character(s)]' with N at most 16 digits.
const TRUNCATION_MARKER_MAX_CHARS = 42;

// Maximum open findings presented to the coder per response round. Response
// selection (getExecuteResponseOpenFindings and the plan-review response
// phase) and prompt rendering share this bound, so the coder always sees
// exactly the finding set it must disposition; findings beyond the limit stay
// open and are presented in later response rounds until every one is handled.
// The limit also keeps boundFreeTextValues' cardinality precondition
// satisfied: 3 free-text values per finding times this limit stays far under
// AGENT_FREE_TEXT_SECTION_MAX_CHARS / TRUNCATION_MARKER_MAX_CHARS.
export const OPEN_FINDINGS_PROMPT_ITEM_LIMIT = 50;

function renderBoundedFreeTextValue(text: string, cap: number): string {
  if (text.length <= cap) {
    return text;
  }
  if (cap <= 0) {
    return `[truncated ${text.length} character(s)]`;
  }
  return `${text.slice(0, cap)}\n[truncated ${text.length - cap} character(s)]`;
}

// Largest equal per-value kept-character cap such that the values fit the
// kept-character budget (water-filling): short values keep their full text and
// long values share the remaining budget equally. Returns MAX_SAFE_INTEGER
// when everything already fits.
function computeFairValueCap(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((left, right) => left - right);
  let remaining = budget;
  for (let index = 0; index < sorted.length; index += 1) {
    const share = Math.floor(remaining / (sorted.length - index));
    if (sorted[index]! > share) {
      return Math.max(share, 0);
    }
    remaining -= sorted[index]!;
  }
  return Number.MAX_SAFE_INTEGER;
}

// Bounds a fixed list of agent-authored free-text values to a fixed aggregate
// budget, truncation markers included: marker allowance is reserved up front,
// the kept characters are water-filled over the rest, so the total rendered
// length is always <= budget. Positions are preserved one-to-one with the
// input. Callers keep control data (ids, files, severities) out of this list
// and enforce the finite cardinality this validates. Never mutates the input.
export function boundFreeTextValues(
  texts: readonly string[],
  budget = AGENT_FREE_TEXT_SECTION_MAX_CHARS,
): string[] {
  if (texts.length * TRUNCATION_MARKER_MAX_CHARS > budget) {
    throw new Error(
      `boundFreeTextValues received ${texts.length} free-text values; the aggregate budget of ${budget} characters supports at most ${Math.floor(budget / TRUNCATION_MARKER_MAX_CHARS)}. Bound the payload's item cardinality before rendering free text.`,
    );
  }
  const keptBudget = budget - texts.length * TRUNCATION_MARKER_MAX_CHARS;
  const cap = computeFairValueCap(texts.map((text) => text.length), keptBudget);
  return texts.map((text) => renderBoundedFreeTextValue(text, cap));
}

type OpenFindingForPrompt = {
  claim: string;
  requiredAction: string;
  roundSummary: string;
  files: string[];
};

// Render-only view of an open-findings list for prompt embedding. Every
// finding renders: id, source, and severity are copied exactly, each files
// path renders whole with the list length bounded via boundChangedFileList,
// and only the claim, requiredAction, and roundSummary free text shares the
// fixed aggregate budget. Callers must present at most
// OPEN_FINDINGS_PROMPT_ITEM_LIMIT findings — the same bounded set their
// response processing validates against — so this never drops a finding the
// coder is required to disposition; it throws on a larger list instead of
// silently diverging from the response contract. Never mutates the input.
export function boundOpenFindingsForPrompt<T extends OpenFindingForPrompt>(findings: readonly T[]): T[] {
  if (findings.length > OPEN_FINDINGS_PROMPT_ITEM_LIMIT) {
    throw new Error(
      `boundOpenFindingsForPrompt received ${findings.length} findings; response rounds present at most ${OPEN_FINDINGS_PROMPT_ITEM_LIMIT}. Bound the selection where the response set is chosen.`,
    );
  }
  const boundedTexts = boundFreeTextValues(
    findings.flatMap((finding) => [finding.claim, finding.requiredAction, finding.roundSummary]),
  );
  return findings.map((finding, index) => ({
    ...finding,
    claim: boundedTexts[index * 3]!,
    requiredAction: boundedTexts[index * 3 + 1]!,
    roundSummary: boundedTexts[index * 3 + 2]!,
    files: boundChangedFileList(finding.files),
  }));
}

// Maximum commit subjects rendered per commit-subject list that reaches a
// prompt (the aggregate completion range and the scope review's commits-in-scope
// list). Matches CHANGED_FILE_LIST_LIMIT so both run-scaling list bounds read
// the same way.
export const COMMIT_SUBJECT_LIST_LIMIT = 20;

// Character cap for one rendered git summary block that grows with run length
// (diff-stat output, one line per file). Applied via truncateInlineSectionBody,
// so an over-cap block carries an explicit truncation marker.
export const GIT_SUMMARY_SECTION_MAX_CHARS = 20_000;

// Bounds a commit-subject list for prompt rendering: the first
// COMMIT_SUBJECT_LIST_LIMIT subjects render with their text sharing the fixed
// aggregate free-text budget (subjects are largely agent-authored), and the
// rest collapse to an explicit "(+N more)" entry. The underlying arrays keep
// every subject for non-prompt consumers. Never mutates the input.
export function boundCommitSubjectList(subjects: readonly string[]): string[] {
  const kept = boundFreeTextValues(subjects.slice(0, COMMIT_SUBJECT_LIST_LIMIT));
  if (subjects.length <= COMMIT_SUBJECT_LIST_LIMIT) {
    return kept;
  }
  return [...kept, `(+${subjects.length - COMMIT_SUBJECT_LIST_LIMIT} more)`];
}

// Maximum file paths rendered per changed-file list that reaches a prompt.
// Matches the reviewer continuity packet's per-scope bound
// (COMPLETED_SCOPE_CHANGED_FILE_LIMIT in src/neal/context/reviewer-context.ts).
export const CHANGED_FILE_LIST_LIMIT = 20;

// Bounds a changed-file list for prompt rendering: the first
// CHANGED_FILE_LIST_LIMIT entries render and the rest collapse to an explicit
// "(+N more)" marker entry. Callers join or JSON-embed the result; the
// underlying arrays in state and packets keep every path.
export function boundChangedFileList(files: readonly string[], limit = CHANGED_FILE_LIST_LIMIT): string[] {
  if (files.length <= limit) {
    return [...files];
  }
  return [...files.slice(0, limit), `(+${files.length - limit} more)`];
}

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
