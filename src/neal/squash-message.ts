import { stripScopePrefixFromSubject } from './commit-message.js';

export type SquashCommitMessageDraft = {
  subject: string;
  bullets: string[];
};

export type SquashCommitMessageSource =
  | 'final_completion_reviewer'
  | 'final_completion_summary'
  | 'plan_title'
  | 'accepted_scope_summaries'
  | 'created_commit_subjects'
  | 'changed_file_categories';

const TMP_PATH_REFERENCE_PATTERN = /(^|[\s"'`(])(?:\.{1,2}\/)?tmp\//i;
const MARKDOWN_PLAN_REFERENCE_PATTERN =
  /(^|[\s"'`(])(?:[\w.-]+\/)*[\w.-]*(?:plan|scope|task|proposal|objective)[\w.-]*\.md\b/i;
const GENERIC_WRAPPER_PATH_SUBJECT_PATTERN =
  /^(?:implement|complete|execute|finish|apply|add|update|create|record|write)\s+(?:\S*\/\S+|\S+\.md)\s*$/i;
const SCOPE_NUMBER_REFERENCE_PATTERN = /\bscope\s+\d+(?:\.\d+)*(?:[a-z])?\b/i;
const PER_SCOPE_REFERENCE_PATTERN = /\b(?:per[-\s]?scope|scope[-\s]?level|scope by scope|one bullet per scope)\b/i;
const BULLET_MARKER_PATTERN = /^[-*]\s+/;
const NUMBERED_BULLET_MARKER_PATTERN = /^\d+[.)]\s+/;
const PLAN_PATH_SUBSTRING_PATTERN =
  /(?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]*(?:plan|scope|task|proposal|objective)[\w.-]*\.md\b/gi;
const RUN_LOCAL_MARKDOWN_REFERENCE_PATTERN =
  /(?:\.{1,2}\/)?(?:tmp|\.neal\/runs)\/[^\s"'`)\]]+\.md\b/gi;
const MARKDOWN_LINK_PATTERN = /!?\[([^\]]*)\]\(([^)]*)\)/g;
const MARKDOWN_INLINE_SYNTAX_PATTERN = /[`*_~]+/g;
const DANGLING_CONNECTOR_PATTERN = /\b(?:and|from|for|in|into|of|on|to|via|with)\s*$/i;
const WRAPPER_VERB_ONLY_PATTERN = /^(?:implement|complete|execute|finish|apply|add|update|create|record|write)$/i;
const MECHANICAL_ONLY_PATTERNS = [
  /^(?:final\s+)?cleanup(?:\s+work)?$/i,
  /^(?:finish|finalize|complete)\s+(?:the\s+)?(?:plan|scope|run)$/i,
  /^(?:address|apply)\s+review(?:er)?\s+feedback$/i,
  /^run\s+(?:tests|typecheck|verification)$/i,
  /^final\s+completion(?:\s+cleanup)?$/i,
  /^(?:record|persist)\s+(?:neal\s+)?(?:artifact|metadata)$/i,
  /^scope\s+(?:work|changes?|commits?)(?:\s+\d+)?$/i,
  /^(?:(?:first|second|third|fourth|fifth|final|last)\s+)?(?:empty\s+)?metadata\s+scope$/i,
] as const;
const PLAN_TITLE_MARKER_PATTERN = /^\s*#+\s*(.*?)\s*#*\s*$/;
const LEADING_PLAN_NUMBER_PATTERN = /^(?:\d+[\s._-]+)+/;
const TRAILING_PLAN_LABEL_PATTERN =
  /\s+(?:(?:implementation|execution|migration|cleanup|review|metadata|project)\s+)?(?:plan|proposal|task|objective)$/i;
const GENERIC_PLAN_TITLE_PATTERN = /^(?:plan|proposal|task|objective|scope)$/i;
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?])\s+/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeWhitespace(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function normalizeSubject(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new Error(`${label}.subject must be a string.`);
  }
  return stripScopePrefixFromSubject(normalizeWhitespace(value));
}

function normalizeBullet(value: unknown, label: string, index: number) {
  if (typeof value !== 'string') {
    throw new Error(`${label}.bullets[${index}] must be a string.`);
  }

  return stripScopePrefixFromSubject(
    normalizeWhitespace(value)
      .replace(BULLET_MARKER_PATTERN, '')
      .replace(NUMBERED_BULLET_MARKER_PATTERN, ''),
  );
}

function assertProjectFacingLine(value: string, fieldPath: string, subject = false) {
  const problem = getProjectFacingLineProblem(value, subject);
  if (problem) {
    throw new Error(`${fieldPath} ${problem}`);
  }
}

function getProjectFacingLineProblem(value: string, subject = false) {
  if (!value) {
    return 'must not be empty.';
  }

  if (TMP_PATH_REFERENCE_PATTERN.test(value)) {
    return 'must not mention tmp/ paths.';
  }

  if (MARKDOWN_PLAN_REFERENCE_PATTERN.test(value)) {
    return 'must not mention plan markdown file paths.';
  }

  if (SCOPE_NUMBER_REFERENCE_PATTERN.test(value) || PER_SCOPE_REFERENCE_PATTERN.test(value)) {
    return 'must not use scope-numbered or per-scope wording.';
  }

  if (MECHANICAL_ONLY_PATTERNS.some((pattern) => pattern.test(value))) {
    return 'must describe the project change, not mechanical cleanup.';
  }

  if (subject && GENERIC_WRAPPER_PATH_SUBJECT_PATTERN.test(value)) {
    return 'must not be a generic wrapper verb plus a path.';
  }

  return null;
}

function stripBulletMarker(value: string) {
  return value.replace(BULLET_MARKER_PATTERN, '').replace(NUMBERED_BULLET_MARKER_PATTERN, '');
}

function firstSentence(value: string) {
  return normalizeWhitespace(value)
    .split(SENTENCE_BOUNDARY_PATTERN)
    .map((sentence) => sentence.trim())
    .find(Boolean) ?? '';
}

function removeTrailingPunctuation(value: string) {
  return value.replace(/[.!?]+$/, '').trim();
}

function stripMarkdownSyntax(value: string) {
  return value
    .replace(MARKDOWN_LINK_PATTERN, (_match, label: string, target: string) => {
      if (hasDraftPathReference(target)) {
        return '';
      }
      return label;
    })
    .replace(MARKDOWN_INLINE_SYNTAX_PATTERN, '')
    .replace(/^#+\s*/, '')
    .replace(/^>\s*/, '');
}

function hasDraftPathReference(value: string) {
  PLAN_PATH_SUBSTRING_PATTERN.lastIndex = 0;
  RUN_LOCAL_MARKDOWN_REFERENCE_PATTERN.lastIndex = 0;
  return PLAN_PATH_SUBSTRING_PATTERN.test(value) || RUN_LOCAL_MARKDOWN_REFERENCE_PATTERN.test(value);
}

function removeDraftPathReferences(value: string) {
  return value.replace(PLAN_PATH_SUBSTRING_PATTERN, '').replace(RUN_LOCAL_MARKDOWN_REFERENCE_PATTERN, '');
}

function trimAfterDraftPathRemoval(value: string) {
  let normalized = normalizeWhitespace(value)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+[-:,;]+\s+/g, ' ')
    .replace(/^[-:,;]+\s*/, '')
    .trim();

  let previous: string;
  do {
    previous = normalized;
    normalized = normalized
      .replace(DANGLING_CONNECTOR_PATTERN, '')
      .replace(/[-:,;.!?]+$/, '')
      .trim();
  } while (normalized !== previous);

  return normalized;
}

function repairReviewerSquashLine(value: unknown, options: { label: string; index?: number; subject?: boolean }) {
  if (typeof value !== 'string') {
    return null;
  }

  const markdownStripped = stripMarkdownSyntax(value);
  let normalized: string;
  try {
    normalized =
      options.index === undefined
        ? normalizeSubject(markdownStripped, options.label)
        : normalizeBullet(markdownStripped, options.label, options.index);
  } catch {
    return null;
  }

  if (options.subject && GENERIC_WRAPPER_PATH_SUBJECT_PATTERN.test(normalized)) {
    return null;
  }

  normalized = trimAfterDraftPathRemoval(removeDraftPathReferences(normalized));
  if (WRAPPER_VERB_ONLY_PATTERN.test(normalized)) {
    return null;
  }

  if (getProjectFacingLineProblem(normalized, options.subject ?? false)) {
    return null;
  }

  return normalized;
}

export function normalizeSquashFallbackLine(value: string, options: { subject?: boolean } = {}) {
  const line = stripScopePrefixFromSubject(removeTrailingPunctuation(stripBulletMarker(normalizeWhitespace(value))));
  if (getProjectFacingLineProblem(line, options.subject ?? false)) {
    return null;
  }
  return line;
}

export function collectUniqueSquashBullets(values: string[], options: { max?: number } = {}) {
  const max = options.max ?? 5;
  const bullets: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const bullet = normalizeSquashFallbackLine(value);
    if (!bullet) {
      continue;
    }
    const key = bullet.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bullets.push(bullet);
    if (bullets.length >= max) {
      break;
    }
  }

  return bullets;
}

export function buildSquashMessageDraft(args: {
  subject: string;
  bullets: string[];
  supplementalBullets?: string[];
}): SquashCommitMessageDraft | null {
  const subject = normalizeSquashFallbackLine(firstSentence(args.subject), { subject: true });
  if (!subject) {
    return null;
  }

  const primaryBullets = collectUniqueSquashBullets(args.bullets);
  const bullets =
    primaryBullets.length >= 2
      ? primaryBullets
      : collectUniqueSquashBullets([...primaryBullets, ...(args.supplementalBullets ?? [])]);
  if (bullets.length < 2) {
    return null;
  }

  return {
    subject,
    bullets,
  };
}

export function extractPlanMarkdownTitle(markdown: string) {
  for (const line of markdown.split('\n')) {
    const match = line.match(PLAN_TITLE_MARKER_PATTERN);
    if (!match || !match[1]?.trim()) {
      continue;
    }
    return match[1].trim();
  }

  return null;
}

export function normalizePlanTitleForSquashSubject(title: string) {
  let normalized = normalizeWhitespace(title)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(LEADING_PLAN_NUMBER_PATTERN, '')
    .trim();

  let previous: string;
  do {
    previous = normalized;
    normalized = normalized.replace(TRAILING_PLAN_LABEL_PATTERN, '').trim();
  } while (normalized !== previous);

  if (!normalized || GENERIC_PLAN_TITLE_PATTERN.test(normalized)) {
    return null;
  }

  return normalizeSquashFallbackLine(normalized, { subject: true });
}

export function buildFinalCompletionSummarySquashDraft(args: {
  whatChangedOverall: string;
  verificationSummary: string;
  supplementalBullets?: string[];
}) {
  return buildSquashMessageDraft({
    subject: args.whatChangedOverall,
    bullets: [args.whatChangedOverall, args.verificationSummary],
    supplementalBullets: args.supplementalBullets,
  });
}

type ChangedFileCategory = 'source' | 'tests' | 'docs' | 'config' | 'other';

function classifyChangedFile(path: string): ChangedFileCategory {
  if (path.startsWith('test/') || path.endsWith('.test.ts')) {
    return 'tests';
  }
  if (path === 'README.md' || path.startsWith('docs/') || /\.(?:md|mdx)$/i.test(path)) {
    return 'docs';
  }
  if (
    path === 'package.json' ||
    path === 'pnpm-lock.yaml' ||
    path === 'pnpm-workspace.yaml' ||
    path.startsWith('.github/') ||
    path.startsWith('.husky/') ||
    /^tsconfig(?:\.[\w-]+)?\.json$/.test(path)
  ) {
    return 'config';
  }
  if (path.startsWith('src/')) {
    return 'source';
  }
  return 'other';
}

function orderedChangedFileCategories(changedFiles: string[]) {
  const categories = new Set(changedFiles.map(classifyChangedFile));
  return (['source', 'tests', 'docs', 'config', 'other'] as const).filter((category) => categories.has(category));
}

export function buildChangedFileCategorySquashDraft(changedFiles: string[]) {
  const categories = orderedChangedFileCategories(changedFiles);
  if (categories.length === 0) {
    return null;
  }

  if (categories.includes('source')) {
    return {
      subject: 'Update Neal CLI behavior',
      bullets: collectUniqueSquashBullets([
        'Update Neal CLI source files.',
        categories.includes('tests') ? 'Cover the behavior with focused tests.' : '',
        categories.includes('docs') ? 'Clarify the documented behavior for users.' : '',
        categories.includes('config') ? 'Adjust project configuration files.' : '',
        categories.includes('other') ? 'Refresh supporting project files.' : '',
        'Align runtime behavior with the changed command flow.',
      ]),
    };
  }

  if (categories.includes('tests')) {
    return {
      subject: 'Update Neal test coverage',
      bullets: collectUniqueSquashBullets([
        'Cover the behavior with focused tests.',
        categories.includes('docs') ? 'Clarify the documented behavior for users.' : '',
        categories.includes('config') ? 'Adjust project configuration files.' : '',
        categories.includes('other') ? 'Refresh supporting project files.' : '',
        'Keep regression coverage aligned with the changed behavior.',
      ]),
    };
  }

  if (categories.includes('docs')) {
    return {
      subject: 'Update Neal documentation',
      bullets: collectUniqueSquashBullets([
        'Clarify the documented behavior for users.',
        categories.includes('config') ? 'Adjust project configuration files.' : '',
        categories.includes('other') ? 'Refresh supporting project files.' : '',
        'Keep user-facing guidance aligned with the implementation.',
      ]),
    };
  }

  if (categories.includes('config')) {
    return {
      subject: 'Update project configuration',
      bullets: collectUniqueSquashBullets([
        'Adjust project configuration files.',
        categories.includes('other') ? 'Refresh supporting project files.' : '',
        'Keep package and tooling settings aligned.',
      ]),
    };
  }

  return {
    subject: 'Update project files',
    bullets: collectUniqueSquashBullets([
      'Refresh supporting project files.',
      'Keep repository content aligned with the requested change.',
    ]),
  };
}

export function validateReviewerSquashMessageDraft(
  value: unknown,
  options: { label?: string } = {},
): SquashCommitMessageDraft {
  const label = options.label ?? 'squashCommitMessage';
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const subject = normalizeSubject(value.subject, label);
  assertProjectFacingLine(subject, `${label}.subject`, true);

  if (!Array.isArray(value.bullets)) {
    throw new Error(`${label}.bullets must be an array.`);
  }

  const bullets = value.bullets.map((bullet, index) => normalizeBullet(bullet, label, index));
  if (bullets.length < 2 || bullets.length > 5) {
    throw new Error(`${label}.bullets must contain 2 to 5 bullets.`);
  }

  const seenBullets = new Set<string>();
  for (let index = 0; index < bullets.length; index += 1) {
    const bullet = bullets[index];
    assertProjectFacingLine(bullet, `${label}.bullets[${index}]`);
    const key = bullet.toLocaleLowerCase();
    if (seenBullets.has(key)) {
      throw new Error(`${label}.bullets[${index}] duplicates an earlier bullet.`);
    }
    seenBullets.add(key);
  }

  return {
    subject,
    bullets,
  };
}

export function repairReviewerSquashMessageDraft(value: unknown): SquashCommitMessageDraft | null {
  const label = 'squashCommitMessage';
  if (!isRecord(value) || typeof value.subject !== 'string' || !Array.isArray(value.bullets)) {
    return null;
  }

  const subject = repairReviewerSquashLine(value.subject, { label, subject: true });
  if (!subject) {
    return null;
  }

  const bullets: string[] = [];
  const seenBullets = new Set<string>();
  for (let index = 0; index < value.bullets.length; index += 1) {
    const bullet = repairReviewerSquashLine(value.bullets[index], { label, index });
    if (!bullet) {
      continue;
    }

    const key = bullet.toLocaleLowerCase();
    if (seenBullets.has(key)) {
      continue;
    }
    seenBullets.add(key);
    bullets.push(bullet);
    if (bullets.length >= 5) {
      break;
    }
  }

  if (bullets.length < 2) {
    return null;
  }

  try {
    return validateReviewerSquashMessageDraft({ subject, bullets }, { label });
  } catch {
    return null;
  }
}

export function formatSquashMessage(draft: SquashCommitMessageDraft): string {
  return `${draft.subject}\n\n${draft.bullets.map((bullet) => `- ${bullet}`).join('\n')}`;
}
