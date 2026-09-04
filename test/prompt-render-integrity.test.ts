import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildConsultantPrompt,
  buildBlockedRecoveryCoderPrompt,
  buildCoderPlanResponsePrompt,
  buildCoderResponsePrompt,
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
  buildReviewerPrompt,
  buildScopePrompt,
} from '../src/neal/agents.js';
import {
  PROMPT_SPECS,
  getPromptSpec,
  serializeRenderMatrix,
  sha256Hex,
  validatePromptSpecVersioning,
  verifyRenderVersionContract,
  type PromptSpecChangelogEntry,
  type PromptSpecId,
} from '../src/neal/prompts/specs.js';
import { clearUserGuidanceCache } from '../src/neal/prompts/guidance.js';
import { createInlineSection, type InlineReviewerContext } from '../src/neal/context/inline-review-context.js';
import { renderReviewerContextMarkdown, type ReviewerContextPacket } from '../src/neal/context/reviewer-context.js';
import type { ReviewDoctrineAccessMode } from '../src/neal/prompts/review-doctrine.js';
import type { ReviewLevel } from '../src/neal/config.js';
import type { FinalCompletionPacket, FinalCompletionSummary } from '../src/neal/types.js';

// Deterministic renders: point guidance at a nonexistent dir and clear the cache
// so no user-guidance file bleeds into a golden.
process.env.NEAL_GUIDANCE_DIR = join(tmpdir(), 'neal-guidance-render-integrity-does-not-exist');
clearUserGuidanceCache();

// When set, a maintenance generator imports this module to regenerate goldens and
// shas without executing the test suite. Registration is skipped in that mode.
const IMPORT_ONLY = process.env.NEAL_RENDER_MATRIX_IMPORT_ONLY === '1';

// ---------------------------------------------------------------------------
// Fixed canonical render args. Every interpolated data value (commit shas,
// paths, diffs, packet fields) is a deterministic placeholder so the goldens
// never carry wall-clock or run-varying content. These pin authored instruction
// text, not data interpolation.
// ---------------------------------------------------------------------------

const PLAN_DOC = '/tmp/PLAN.md';
const PARENT_PLAN_DOC = '/tmp/PARENT_PLAN.md';
const PROGRESS_TEXT = '## Current Scope\n- Scope: 1\n';
const REVIEW_MD = '/tmp/REVIEW.md';
const RECOVERY_MD = '/tmp/RECOVERY.md';
const SCRATCH_DIR = '/tmp/repo/.neal/runs/run-000/scratch/review';
const PARENT_SCOPE_LABEL = '1';
const BASE_COMMIT = 'base000';
const HEAD_COMMIT = 'head000';
const PREV_HEAD_COMMIT = 'prevhead000';
const DIFF_STAT = ' src/example.ts | 2 +-';
const CHANGED_FILES = ['src/example.ts'];
const COMMITS = ['head000 canonical render matrix'];
const OPERATOR_GUIDANCE = 'Deterministic operator guidance.';
const VERIFICATION_HINT = 'Run the focused regression tests before replying.';
const RECENT_HISTORY = 'No accepted scopes yet.';
const BLOCKED_REASON = 'Deterministic blocked reason.';

const PROGRESS_JUSTIFICATION = {
  milestoneTargeted: 'Deterministic milestone.',
  newEvidence: 'Deterministic evidence.',
  whyNotRedundant: 'Deterministic non-redundancy.',
  nextStepUnlocked: 'Deterministic next step.',
};

const CANNED_RANGE_DIFF = 'diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n';

// One earlier accepted scope's per-file diff for a file the current diff
// touches again (buildReviewerPrompt earlierScopeChanges). Production computes
// these from completedScopes (collectEarlierScopeChanges, adjudicator/execute.ts).
const CANNED_EARLIER_SCOPE_CHANGES = [
  {
    file: 'src/example.ts',
    scopeNumber: '3',
    baseCommit: 'scope3base000',
    finalCommit: 'scope3final000',
    diff: 'diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-older\n+old\n',
  },
];

// Consultant-only inline context: the blocked-run consultant is the sole
// surviving consumer of the Neal-inlined context channel.
const CANNED_INLINE_CONTEXT: InlineReviewerContext = {
  sections: [
    createInlineSection(
      `Full diff for commit range ${BASE_COMMIT}..${HEAD_COMMIT}`,
      CANNED_RANGE_DIFF,
    ),
    createInlineSection(`Plan document content (${PLAN_DOC})`, '# Plan\nDeterministic plan body.\n'),
    createInlineSection('Prior review history (REVIEW.md content)', '(no prior review history)\n'),
  ],
};

const CANNED_COMPLETION_PACKET: FinalCompletionPacket = {
  planDoc: PLAN_DOC,
  executionShape: 'multi_scope',
  currentScopeLabel: '6',
  finalCommit: HEAD_COMMIT,
  aggregateReviewContext: {
    baseCommit: BASE_COMMIT,
    headCommit: HEAD_COMMIT,
    range: `${BASE_COMMIT}..${HEAD_COMMIT}`,
    commitSubjects: [`${HEAD_COMMIT} canonical render matrix`],
    diffStat: DIFF_STAT,
    changedFiles: CHANGED_FILES,
    unavailableReason: null,
  },
  completedScopeSummary: '1 accepted; 2 accepted',
  acceptedScopeCount: 5,
  blockedScopeCount: 0,
  scopeAccounting: {
    acceptedScopeRecords: 5,
    acceptedTopLevelScopeRecords: 5,
    acceptedDerivedSubScopeRecords: 0,
    blockedScopeRecords: 0,
    blockedTopLevelScopeRecords: 0,
    blockedDerivedSubScopeRecords: 0,
    replacedParentScopes: [],
    summary: '5 accepted top-level records',
  },
  scopeAccountingSummary: '5 accepted top-level records',
  verificationOnlyCompletion: false,
  terminalChangedFiles: CHANGED_FILES,
  terminalChangedFilesSummary: 'src/example.ts',
  planChangedFiles: CHANGED_FILES,
  planChangedFilesSummary: 'src/example.ts',
  residualReviewDebt: [],
  residualReviewDebtSummary: 'none',
  verificationTally: {
    totalRuns: 1,
    distinctCommands: 1,
    passed: 1,
    failed: 0,
    unknown: 0,
    recentFailures: [],
  },
  lastNonEmptyImplementationScope: {
    number: '5',
    finalCommit: HEAD_COMMIT,
    commitSubject: 'canonical render matrix',
    changedFiles: CHANGED_FILES,
    archivedReviewPath: '/tmp/REVIEW-5.md',
  },
  continueExecutionCount: 0,
  continueExecutionMax: 2,
};

const CANNED_COMPLETION_SUMMARY: FinalCompletionSummary = {
  planGoalSatisfied: false,
  whatChangedOverall: 'Canonical render matrix pinned across prompt specs.',
  verificationSummary: 'pnpm typecheck',
  remainingKnownGaps: ['One documentation pass remains.'],
};

// Production always supplies a first-round reviewer continuity packet
// (buildAndPersistReviewerContextPacket) to the plan, scope, and final-completion
// reviewer rounds (adjudicator/planning.ts:568, execute.ts:504,
// final-completion.ts:162). Build a deterministic empty-set packet the same way
// buildReviewerContextPacket does — a packetWithoutMarkdown literal plus
// promptMarkdown = renderReviewerContextMarkdown(...) — so every reviewer cell
// pins the real `# Reviewer Continuity Context` framing (tool-access citations
// vs inline) instead of omitting production context.
const CANNED_REVIEWER_PACKET_WITHOUT_MARKDOWN: Omit<ReviewerContextPacket, 'promptMarkdown'> = {
  version: 1,
  createdAt: '2026-07-17T00:00:00.000Z',
  purpose: 'reviewer_continuity',
  run: {
    id: 'run-000',
    cwd: '/tmp/repo',
    runDir: '.neal/runs/run-000',
    planDoc: PLAN_DOC,
    topLevelMode: 'execute',
    executionShape: 'multi_scope',
    phase: 'reviewer_scope',
    status: 'running',
    currentScopeNumber: 1,
  },
  completedScopes: [],
  findings: [],
  inheritedPlanReviewDebt: [],
  finalCompletion: null,
  citations: [
    { label: 'RUN_STATE.json', path: '.neal/runs/run-000/RUN_STATE.json' },
    { label: 'PLAN_PROGRESS.md', path: '.neal/runs/run-000/PLAN_PROGRESS.md' },
    { label: 'plan-progress.json', path: '.neal/runs/run-000/plan-progress.json' },
    { label: 'REVIEW.md', path: '.neal/runs/run-000/REVIEW.md' },
    { label: 'RECOVERY.md', path: '.neal/runs/run-000/RECOVERY.md' },
    { label: 'REVIEWER_CONTEXT.json', path: '.neal/runs/run-000/REVIEWER_CONTEXT.json' },
    { label: 'REVIEWER_CONTEXT.md', path: '.neal/runs/run-000/REVIEWER_CONTEXT.md' },
  ],
  limits: {
    completedScopeLimit: 12,
    completedScopeCount: 0,
    findingLimit: 24,
    findingCount: 0,
    truncatedCompletedScopes: false,
    truncatedFindings: false,
  },
};

const CANNED_REVIEWER_PACKET: ReviewerContextPacket = {
  ...CANNED_REVIEWER_PACKET_WITHOUT_MARKDOWN,
  promptMarkdown: renderReviewerContextMarkdown(CANNED_REVIEWER_PACKET_WITHOUT_MARKDOWN),
};

// Production plan review reads the reviewed plan file (and, for derived-plan
// review, the parent plan) and passes them as reviewedPlanContent /
// parentPlanContent (adjudicator/planning.ts); every reviewer mode renders them.
const CANNED_REVIEWED_PLAN_CONTENT = '# Plan\nDeterministic reviewed plan body.\n';
const CANNED_PARENT_PLAN_CONTENT = '# Parent Plan\nDeterministic parent plan body.\n';

// buildPlanningPrompt inlines the current plan document (getInlineCurrentPlanLines,
// planning.ts:65-78) when a planDocument string is supplied; production passes the
// live plan text there. Absent -> no inlined-plan lines.
const CANNED_INLINE_PLAN_DOCUMENT = '# Plan\nDeterministic inline plan document body.\n';

// buildCoderPlanResponsePrompt renders an operator-guidance block
// (planning.ts:402-410) when planReviewGuidance is present. Shape:
// NonNullable<PendingPlanReviewGuidance>.
const CANNED_PLAN_REVIEW_GUIDANCE = {
  message: 'Deterministic plan-review recovery guidance.',
  sourcePhase: 'reviewer_plan' as const,
  recordedAt: '2026-07-17T00:00:00.000Z',
};

// Completion packet variant with an unavailable aggregate range. Production sets
// this when no aggregate commit range resolves; buildFinalCompletionReviewerPrompt
// then renders rangeLabel=null falsification text, and read-only-inlined does
// not occur because no diff is collected.
const CANNED_COMPLETION_PACKET_UNAVAILABLE: FinalCompletionPacket = {
  ...CANNED_COMPLETION_PACKET,
  finalCommit: null,
  aggregateReviewContext: {
    baseCommit: null,
    headCommit: null,
    range: null,
    commitSubjects: [],
    diffStat: '',
    changedFiles: [],
    unavailableReason: 'no aggregate commit range was resolved',
  },
};

// ---------------------------------------------------------------------------
// Builder matrix specs. Each builder declares its authored-instruction axes and
// a render function. An authored-instruction axis selects different
// Neal-authored instruction text (mode/reviewMode enums, doctrine access mode
// including its read-only submode, and boolean toggles such as
// `authoredOneShot`); it excludes pure data interpolation. The `accessMode` axis for the two range-diff
// reviewers encodes the read-only submode: `read-only-inlined` supplies a canned
// inlined range diff, `read-only-tool` omits it (the providesRangeDiffTool case).
// The `reviewLevel` axis on the same two reviewers selects the level-calibration
// doctrine (`strict`, `moderate`, `lenient`).
// ---------------------------------------------------------------------------

type AxisSpec = { name: string; values: string[] };
type Combo = Record<string, string>;
type BuilderMatrixSpec = {
  exportName: string;
  axes: AxisSpec[];
  render: (combo: Combo) => string;
};

const REVIEW_LEVEL_AXIS_VALUES: ReviewLevel[] = ['strict', 'moderate', 'lenient'];

function reviewerAccessMode(value: string): ReviewDoctrineAccessMode {
  if (value === 'tool-access') {
    return 'tool-access';
  }
  return 'read-only';
}

const planningPromptSpec: BuilderMatrixSpec = {
  exportName: 'buildPlanningPrompt',
  axes: [
    { name: 'authoredOneShot', values: ['true', 'false'] },
    { name: 'planDocument', values: ['present', 'absent'] },
  ],
  render: (c) =>
    buildPlanningPrompt(PLAN_DOC, c.planDocument === 'present' ? CANNED_INLINE_PLAN_DOCUMENT : null, {
      authoredOneShot: c.authoredOneShot === 'true',
    }),
};

const coderPlanResponseSpec: BuilderMatrixSpec = {
  exportName: 'buildCoderPlanResponsePrompt',
  axes: [
    { name: 'mode', values: ['blocking', 'optional'] },
    { name: 'planReviewGuidance', values: ['present', 'absent'] },
    { name: 'reviewMode', values: ['plan', 'derived-plan'] },
  ],
  render: (c) =>
    buildCoderPlanResponsePrompt({
      planDoc: PLAN_DOC,
      openFindings: [],
      mode: c.mode as 'blocking' | 'optional',
      reviewMode: c.reviewMode as 'plan' | 'derived-plan',
      parentPlanDoc: PARENT_PLAN_DOC,
      derivedFromScopeNumber: 2,
      planReviewGuidance: c.planReviewGuidance === 'present' ? CANNED_PLAN_REVIEW_GUIDANCE : undefined,
    }),
};

const planReviewerSpec: BuilderMatrixSpec = {
  exportName: 'buildPlanReviewerPrompt',
  axes: [
    { name: 'accessMode', values: ['tool-access', 'read-only'] },
    { name: 'authoredOneShot', values: ['true', 'false'] },
    { name: 'mode', values: ['plan', 'derived-plan'] },
  ],
  render: (c) =>
    buildPlanReviewerPrompt({
      planDoc: PLAN_DOC,
      round: 1,
      reviewMarkdownPath: REVIEW_MD,
      mode: c.mode as 'plan' | 'derived-plan',
      parentPlanDoc: PARENT_PLAN_DOC,
      derivedFromScopeNumber: 2,
      reviewerContext: CANNED_REVIEWER_PACKET,
      reviewedPlanContent: CANNED_REVIEWED_PLAN_CONTENT,
      parentPlanContent: c.mode === 'derived-plan' ? CANNED_PARENT_PLAN_CONTENT : null,
      accessMode: c.accessMode as ReviewDoctrineAccessMode,
      authoredOneShot: c.authoredOneShot === 'true',
    }),
};

const scopePromptSpec: BuilderMatrixSpec = {
  exportName: 'buildScopePrompt',
  axes: [],
  render: () => buildScopePrompt(PLAN_DOC, PROGRESS_TEXT),
};

const coderResponseSpec: BuilderMatrixSpec = {
  exportName: 'buildCoderResponsePrompt',
  axes: [{ name: 'mode', values: ['blocking', 'optional'] }],
  render: (c) =>
    buildCoderResponsePrompt({
      planDoc: PLAN_DOC,
      progressText: PROGRESS_TEXT,
      verificationHint: VERIFICATION_HINT,
      openFindings: [],
      mode: c.mode as 'blocking' | 'optional',
    }),
};

const blockedRecoverySpec: BuilderMatrixSpec = {
  exportName: 'buildBlockedRecoveryCoderPrompt',
  axes: [
    { name: 'allowLaterScopeRevision', values: ['true', 'false'] },
    { name: 'allowReplacement', values: ['true', 'false'] },
    { name: 'terminalOnly', values: ['true', 'false'] },
  ],
  render: (c) =>
    buildBlockedRecoveryCoderPrompt({
      planDoc: PLAN_DOC,
      progressText: PROGRESS_TEXT,
      recoveryMarkdownPath: RECOVERY_MD,
      blockedReason: BLOCKED_REASON,
      operatorGuidance: OPERATOR_GUIDANCE,
      maxTurns: 3,
      turnsTaken: 1,
      terminalOnly: c.terminalOnly === 'true',
      allowReplacement: c.allowReplacement === 'true',
      laterScopeRevision:
        c.allowLaterScopeRevision === 'true'
          ? { topLevelPlanDoc: PLAN_DOC, currentScopeNumber: 1, scopeCount: 3 }
          : null,
    }),
};

const reviewerSpec: BuilderMatrixSpec = {
  exportName: 'buildReviewerPrompt',
  axes: [
    { name: 'accessMode', values: ['tool-access', 'read-only-inlined', 'read-only-tool'] },
    { name: 'earlierScopeChanges', values: ['present', 'absent'] },
    { name: 'previousHead', values: ['present', 'absent'] },
    { name: 'reviewLevel', values: REVIEW_LEVEL_AXIS_VALUES },
  ],
  render: (c) => {
    const accessMode = reviewerAccessMode(c.accessMode);
    return buildReviewerPrompt({
      planDoc: PLAN_DOC,
      baseCommit: BASE_COMMIT,
      headCommit: HEAD_COMMIT,
      commits: COMMITS,
      previousHeadCommit: c.previousHead === 'present' ? PREV_HEAD_COMMIT : null,
      diffStat: DIFF_STAT,
      changedFiles: CHANGED_FILES,
      round: 1,
      reviewMarkdownPath: REVIEW_MD,
      parentScopeLabel: PARENT_SCOPE_LABEL,
      progressJustification: PROGRESS_JUSTIFICATION,
      recentHistorySummary: RECENT_HISTORY,
      scratchDir: SCRATCH_DIR,
      reviewerContext: CANNED_REVIEWER_PACKET,
      inlinedRangeDiff: c.accessMode === 'read-only-inlined' ? CANNED_RANGE_DIFF : null,
      earlierScopeChanges: c.earlierScopeChanges === 'present' ? CANNED_EARLIER_SCOPE_CHANGES : null,
      accessMode,
      reviewLevel: c.reviewLevel as ReviewLevel,
    });
  },
};

const finalCompletionSummarySpec: BuilderMatrixSpec = {
  exportName: 'buildFinalCompletionSummaryPrompt',
  axes: [],
  render: () => buildFinalCompletionSummaryPrompt({ planDoc: PLAN_DOC, packet: CANNED_COMPLETION_PACKET }),
};

function renderCompletionReviewer(c: Combo): string {
  const available = c.aggregateRange === 'available';
  const accessMode = reviewerAccessMode(c.accessMode);
  return buildFinalCompletionReviewerPrompt({
    planDoc: PLAN_DOC,
    packet: available ? CANNED_COMPLETION_PACKET : CANNED_COMPLETION_PACKET_UNAVAILABLE,
    summary: CANNED_COMPLETION_SUMMARY,
    scratchDir: SCRATCH_DIR,
    reviewerContext: CANNED_REVIEWER_PACKET,
    // read-only-inlined only occurs with an available aggregate range (a diff was
    // collected); the unavailable spec omits that submode entirely.
    inlinedRangeDiff: c.accessMode === 'read-only-inlined' ? CANNED_RANGE_DIFF : null,
    accessMode,
    reviewLevel: c.reviewLevel as ReviewLevel,
  });
}

// Range available: all three access submodes. Range unavailable: no
// read-only-inlined, since production never inlines a range diff without a
// collected range (final-completion.ts).
const finalCompletionReviewerAvailableSpec: BuilderMatrixSpec = {
  exportName: 'buildFinalCompletionReviewerPrompt',
  axes: [
    { name: 'accessMode', values: ['tool-access', 'read-only-inlined', 'read-only-tool'] },
    { name: 'aggregateRange', values: ['available'] },
    { name: 'reviewLevel', values: REVIEW_LEVEL_AXIS_VALUES },
  ],
  render: renderCompletionReviewer,
};

const finalCompletionReviewerUnavailableSpec: BuilderMatrixSpec = {
  exportName: 'buildFinalCompletionReviewerPrompt',
  axes: [
    { name: 'accessMode', values: ['tool-access', 'read-only-tool'] },
    { name: 'aggregateRange', values: ['unavailable'] },
    { name: 'reviewLevel', values: REVIEW_LEVEL_AXIS_VALUES },
  ],
  render: renderCompletionReviewer,
};

const consultantSpec: BuilderMatrixSpec = {
  exportName: 'buildConsultantPrompt',
  axes: [],
  render: () => buildConsultantPrompt({ blockedReason: BLOCKED_REASON, inlineContext: CANNED_INLINE_CONTEXT }),
};

const SPEC_MATRIX_BUILDERS: Record<PromptSpecId, BuilderMatrixSpec[]> = {
  plan_author: [planningPromptSpec, coderPlanResponseSpec],
  plan_reviewer: [planReviewerSpec],
  scope_coder: [scopePromptSpec, coderResponseSpec, blockedRecoverySpec],
  scope_reviewer: [reviewerSpec],
  completion_coder: [finalCompletionSummarySpec],
  completion_reviewer: [finalCompletionReviewerAvailableSpec, finalCompletionReviewerUnavailableSpec],
  consultant: [consultantSpec],
};

const SPEC_IDS = Object.keys(SPEC_MATRIX_BUILDERS) as PromptSpecId[];

function crossProduct(axes: AxisSpec[]): Combo[] {
  return axes.reduce<Combo[]>(
    (acc, axis) => acc.flatMap((combo) => axis.values.map((value) => ({ ...combo, [axis.name]: value }))),
    [{}],
  );
}

function cellKey(exportName: string, combo: Combo): string {
  const segments = Object.keys(combo)
    .sort()
    .map((name) => `#${name}=${combo[name]}`);
  return `${exportName}${segments.join('')}`;
}

function buildBuilderCells(spec: BuilderMatrixSpec): { key: string; render: string }[] {
  return crossProduct(spec.axes).map((combo) => ({ key: cellKey(spec.exportName, combo), render: spec.render(combo) }));
}

export function getSpecCells(specId: PromptSpecId): { key: string; render: string }[] {
  return SPEC_MATRIX_BUILDERS[specId].flatMap(buildBuilderCells);
}

// Modules hosting a matrixed builder or an authored reviewer-context renderer
// the reviewer cells embed. Pin each module's SHA so any edit (a new mode value,
// a new toggle, any authored-line change, or a change to the continuity/inline
// framing) trips the source tripwire and forces a re-audit — the enumerated-cell
// guard alone cannot detect a newly introduced source branch, and a fixed
// empty-set packet does not exercise every renderReviewerContextMarkdown branch.
export const MATRIX_BUILDER_MODULES = [
  'src/neal/prompts/planning.ts',
  'src/neal/prompts/execute.ts',
  'src/neal/prompts/specialized.ts',
  'src/neal/agents/prompts.ts',
  'src/neal/context/reviewer-context.ts',
  'src/neal/context/inline-review-context.ts',
] as const;

export function readModuleBytes(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8');
}

function goldenPath(specId: PromptSpecId, version: number): string {
  return fileURLToPath(new URL(`./fixtures/prompts/render-integrity/${specId}.v${version}.txt`, import.meta.url));
}

export function readGolden(specId: PromptSpecId, version: number): string | undefined {
  try {
    return readFileSync(goldenPath(specId, version), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Frozen expectations. The enumerated-cell guard deep-equals these against the
// generated cell keys, so a dropped, renamed, or mis-parameterized enumerated
// cell fails here. The module SHAs are the source tripwire. Both are hand-frozen
// (they encode the audited axis spec and current builder source); regenerate
// with the maintenance generator only after a deliberate, reviewed change.
// ---------------------------------------------------------------------------

const EXPECTED_KEYS: Record<PromptSpecId, string[]> = {
  plan_author: [
    'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=derived-plan',
    'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=plan',
    'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=present#reviewMode=derived-plan',
    'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=present#reviewMode=plan',
    'buildCoderPlanResponsePrompt#mode=optional#planReviewGuidance=absent#reviewMode=derived-plan',
    'buildCoderPlanResponsePrompt#mode=optional#planReviewGuidance=absent#reviewMode=plan',
    'buildCoderPlanResponsePrompt#mode=optional#planReviewGuidance=present#reviewMode=derived-plan',
    'buildCoderPlanResponsePrompt#mode=optional#planReviewGuidance=present#reviewMode=plan',
    'buildPlanningPrompt#authoredOneShot=false#planDocument=absent',
    'buildPlanningPrompt#authoredOneShot=false#planDocument=present',
    'buildPlanningPrompt#authoredOneShot=true#planDocument=absent',
    'buildPlanningPrompt#authoredOneShot=true#planDocument=present',
  ],
  plan_reviewer: [
    'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=false#mode=derived-plan',
    'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=false#mode=plan',
    'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=true#mode=derived-plan',
    'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=true#mode=plan',
    'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=derived-plan',
    'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=plan',
    'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=true#mode=derived-plan',
    'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=true#mode=plan',
  ],
  scope_coder: [
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=false#terminalOnly=false',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=false#terminalOnly=true',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=false',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=true',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=false#terminalOnly=false',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=false#terminalOnly=true',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=true#terminalOnly=false',
    'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=true#terminalOnly=true',
    'buildCoderResponsePrompt#mode=blocking',
    'buildCoderResponsePrompt#mode=optional',
    'buildScopePrompt',
  ],
  scope_reviewer: [
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=present#previousHead=absent#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=present#previousHead=absent#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=present#previousHead=absent#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=present#previousHead=present#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=present#previousHead=present#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=present#previousHead=present#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=present#previousHead=absent#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=present#previousHead=absent#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=present#previousHead=absent#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=present#previousHead=present#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=present#previousHead=present#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=present#previousHead=present#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=absent#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=absent#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=absent#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=present#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=present#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=present#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=absent#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=absent#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=absent#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=absent#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=absent#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=absent#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=absent#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=absent#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=absent#reviewLevel=lenient',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=strict',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
  ],
  completion_coder: ['buildFinalCompletionSummaryPrompt'],
  completion_reviewer: [
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-inlined#aggregateRange=available#reviewLevel=strict',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-inlined#aggregateRange=available#reviewLevel=moderate',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-inlined#aggregateRange=available#reviewLevel=lenient',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=strict',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=moderate',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=lenient',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=strict',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=moderate',
    'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=lenient',
    'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=strict',
    'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=moderate',
    'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=lenient',
    'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=unavailable#reviewLevel=strict',
    'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=unavailable#reviewLevel=moderate',
    'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=unavailable#reviewLevel=lenient',
  ],
  consultant: ['buildConsultantPrompt'],
};

const EXPECTED_MODULE_SHAS: Record<(typeof MATRIX_BUILDER_MODULES)[number], string> = {
  'src/neal/prompts/planning.ts': '0d0e88130af09545f7bfb5d74bf03d333954152baabd37a7926279e361167cde',
  'src/neal/prompts/execute.ts': '2b94a85d63e08bd676bdb2415eb9c1de2f27cdce6e858ee220cfb44c18dacfb0',
  'src/neal/prompts/specialized.ts': '396c46ab85aa4e41ef0bf5cbce5c84d0dd11210d07b25a4c58327fd615ca8683',
  'src/neal/agents/prompts.ts': 'c9b8b6bd135206ec8c7055aa887d65003490b8fdef95c3a662797018d01a667e',
  'src/neal/context/reviewer-context.ts': '7168f61b26ff2c9fb9fa67ce7c608f452722fcfc5187f8c346910264a4c00674',
  'src/neal/context/inline-review-context.ts': '707a75dec9712158b14c9b15ccac19491a6b0d3221089545b4b2c3431458bbe7',
};

function assertModuleShaMatches(relPath: (typeof MATRIX_BUILDER_MODULES)[number], expectedSha: string): void {
  const actual = sha256Hex(readModuleBytes(relPath));
  if (actual !== expectedSha) {
    throw new Error(
      `Prompt-builder module ${relPath} sha ${actual} does not match pinned ${expectedSha}. ` +
        'Re-audit the builder authored-instruction axes, extend the axis spec and matrix for any new branch, ' +
        'bump the affected PromptSpec.version and re-pin its golden if authored output changed, then re-pin this module SHA.',
    );
  }
}

// Find the (specId, cells) that owns a given cell key, for the perturbation
// regression tests.
function findCell(cellKey: string): { specId: PromptSpecId; cells: { key: string; render: string }[] } {
  for (const specId of SPEC_IDS) {
    const cells = getSpecCells(specId);
    if (cells.some((cell) => cell.key === cellKey)) {
      return { specId, cells };
    }
  }
  throw new Error(`No matrix cell found for key ${cellKey}`);
}

function perturbCell(cells: { key: string; render: string }[], cellKey: string): { key: string; render: string }[] {
  return cells.map((cell) => (cell.key === cellKey ? { ...cell, render: `${cell.render}X` } : cell));
}

function cellRenderByKey(key: string): string {
  const { cells } = findCell(key);
  const cell = cells.find((candidate) => candidate.key === key);
  if (!cell) {
    throw new Error(`No matrix cell found for key ${key}`);
  }
  return cell.render;
}

// Asserts that a rendered cell's containment of an authored branch sentinel
// matches what its key's axis value implies. This is the label->value proof: if
// a render function passed the opposite axis value, the sentinel presence would
// flip and this throws.
function assertSentinelPresence(cellKey: string, render: string, sentinel: string, expectPresent: boolean): void {
  const present = render.includes(sentinel);
  if (present !== expectPresent) {
    throw new Error(
      `cell ${cellKey} sentinel presence mismatch (expected ${expectPresent}, got ${present}) for authored sentinel: ${sentinel}`,
    );
  }
}

// Each entry names a real matrix cell that renders the axis at the "with" value
// (whose authored sentinel must appear) and its sibling at the opposite value
// (whose render must not contain that sentinel). Covers every authored axis:
// authoredOneShot, previousHead, terminalOnly, allowReplacement,
// allowLaterScopeRevision, both response
// modes, plan/derived-plan modes, every reviewer access submode of both
// range-diff reviewers, and every review level of both range-diff reviewers.
type AxisConformanceCase = { withKey: string; withoutKey: string; sentinel: string };

const GIT_COMMANDS_SENTINEL = 'Use git commands against the repository';
const GIT_DIFF_TOOL_SENTINEL = 'use the git_diff tool';
const INLINED_RANGE_DIFF_SENTINEL = '## Inlined commit-range diff from Neal';
const EARLIER_SCOPE_CHANGES_SENTINEL = '## Earlier-scope changes to files in this diff';
const STRICT_LEVEL_SENTINEL = 'Review level: strict.';
const MODERATE_LEVEL_SENTINEL = 'Review level: moderate.';
const LENIENT_LEVEL_SENTINEL = 'Review level: lenient.';
const LENIENT_FINDING_QUALITY_SENTINEL = 'are non_blocking unless they are a reachable correctness failure';

const AXIS_CONFORMANCE: AxisConformanceCase[] = [
  // authoredOneShot
  {
    withKey: 'buildPlanningPrompt#authoredOneShot=true#planDocument=absent',
    withoutKey: 'buildPlanningPrompt#authoredOneShot=false#planDocument=absent',
    sentinel: 'authored as a single-scope (`one_shot`) plan',
  },
  {
    withKey: 'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=true#mode=plan',
    withoutKey: 'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=plan',
    sentinel: 'authored `one_shot`; raise a blocking finding',
  },
  // earlierScopeChanges present/absent on buildReviewerPrompt: the section
  // renders only with an overlap; the preservation rule renders either way.
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=present#previousHead=present#reviewLevel=moderate',
    withoutKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    sentinel: EARLIER_SCOPE_CHANGES_SENTINEL,
  },
  // previousHead
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    withoutKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=absent#reviewLevel=moderate',
    sentinel: 'Previous reviewer head was',
  },
  // terminalOnly / allowReplacement / allowLaterScopeRevision
  {
    withKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=true',
    withoutKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=false',
    sentinel: 'The recovery turn cap has been reached.',
  },
  {
    withKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=false',
    withoutKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=false#terminalOnly=false',
    sentinel: '- `replace_current_scope`',
  },
  {
    withKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=false#terminalOnly=false',
    withoutKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=false',
    sentinel: '`replace_current_scope` is not available for this run',
  },
  {
    withKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=true#terminalOnly=false',
    withoutKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=false',
    sentinel: 'To revise a later scope, set `laterScopeNumber`',
  },
  // A terminal-only round never offers the revision, whatever the flag says.
  {
    withKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=true#terminalOnly=false',
    withoutKey: 'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=true#terminalOnly=true',
    sentinel: 'To revise a later scope, set `laterScopeNumber`',
  },
  // response modes
  {
    withKey: 'buildCoderResponsePrompt#mode=optional',
    withoutKey: 'buildCoderResponsePrompt#mode=blocking',
    sentinel: 'they are not optional to triage',
  },
  {
    withKey: 'buildCoderPlanResponsePrompt#mode=optional#planReviewGuidance=absent#reviewMode=plan',
    withoutKey: 'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=plan',
    sentinel: 'The currently open review findings below are non-blocking.',
  },
  // plan / derived-plan modes
  {
    withKey: 'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=derived-plan',
    withoutKey: 'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=plan',
    sentinel: 'Review the derived implementation plan at',
  },
  {
    withKey: 'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=derived-plan',
    withoutKey: 'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=plan',
    sentinel: 'Continue refining the derived implementation plan at',
  },
  // buildReviewerPrompt access submodes
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    withoutKey: 'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    sentinel: GIT_COMMANDS_SENTINEL,
  },
  {
    withKey: 'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    withoutKey: 'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    sentinel: INLINED_RANGE_DIFF_SENTINEL,
  },
  {
    withKey: 'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    withoutKey: 'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    sentinel: GIT_DIFF_TOOL_SENTINEL,
  },
  // buildFinalCompletionReviewerPrompt access submodes (aggregate range available)
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=moderate',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=moderate',
    sentinel: GIT_COMMANDS_SENTINEL,
  },
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-inlined#aggregateRange=available#reviewLevel=moderate',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=moderate',
    sentinel: INLINED_RANGE_DIFF_SENTINEL,
  },
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=moderate',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-inlined#aggregateRange=available#reviewLevel=moderate',
    sentinel: GIT_DIFF_TOOL_SENTINEL,
  },
  // buildPlanReviewerPrompt access modes: tool-access vs read-only
  // doctrine/framing. Read-only names read-only file tools; tool-access names
  // repository tools.
  {
    withKey: 'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=false#mode=plan',
    withoutKey: 'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=plan',
    sentinel: 'use your read-only file tools to inspect directly referenced companion docs',
  },
  {
    withKey: 'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=plan',
    withoutKey: 'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=false#mode=plan',
    sentinel: 'use repository tools to inspect directly referenced companion docs',
  },
  // planDocument present/absent on buildPlanningPrompt (R2-F1).
  {
    withKey: 'buildPlanningPrompt#authoredOneShot=false#planDocument=present',
    withoutKey: 'buildPlanningPrompt#authoredOneShot=false#planDocument=absent',
    sentinel: 'Current plan document content:',
  },
  // planReviewGuidance present/absent on buildCoderPlanResponsePrompt (R2-F1).
  {
    withKey: 'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=present#reviewMode=plan',
    withoutKey: 'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=plan',
    sentinel: 'Operator guidance for this blocked plan-review recovery:',
  },
  // completion aggregate-range available/unavailable (R2-F1). Available renders
  // the range-anchored falsification line; unavailable has no resolved range so
  // that line is absent.
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=moderate',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=unavailable#reviewLevel=moderate',
    sentinel: 'Review that aggregate range base000..head000 directly with repository tools',
  },
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=moderate',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=moderate',
    sentinel: 'Review that aggregate range base000..head000 directly with your read-only repository tools',
  },
  // reviewLevel on buildReviewerPrompt: each level renders its own calibration
  // line; only lenient narrows the robustness/performance severity rule.
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=strict',
    withoutKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    sentinel: STRICT_LEVEL_SENTINEL,
  },
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    withoutKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
    sentinel: MODERATE_LEVEL_SENTINEL,
  },
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
    withoutKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=strict',
    sentinel: LENIENT_LEVEL_SENTINEL,
  },
  {
    withKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
    withoutKey: 'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
    sentinel: LENIENT_FINDING_QUALITY_SENTINEL,
  },
  // reviewLevel on buildFinalCompletionReviewerPrompt.
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=strict',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=moderate',
    sentinel: STRICT_LEVEL_SENTINEL,
  },
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=moderate',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=lenient',
    sentinel: MODERATE_LEVEL_SENTINEL,
  },
  {
    withKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=lenient',
    withoutKey: 'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=strict',
    sentinel: LENIENT_LEVEL_SENTINEL,
  },
];

// ---------------------------------------------------------------------------
// A minimal seed changelog entry helper for the pure internal-consistency tests.
// ---------------------------------------------------------------------------

function entry(version: number, renderSha: string): PromptSpecChangelogEntry {
  return { version, renderSha };
}

function registerTests(): void {
  test('each spec live render matrix and every versioned golden match the recorded renderSha', () => {
    for (const spec of PROMPT_SPECS) {
      const cells = getSpecCells(spec.id);
      const liveMatrix = serializeRenderMatrix(cells);
      verifyRenderVersionContract({
        specId: spec.id,
        version: spec.version,
        changelog: spec.changelog,
        liveMatrix,
        readGolden: (version) => readGolden(spec.id, version),
      });
    }
  });

  test('generated cell keys deep-equal the frozen axis-spec expected key list per spec', () => {
    for (const specId of SPEC_IDS) {
      const keys = getSpecCells(specId)
        .map((cell) => cell.key)
        .sort();
      const expected = [...EXPECTED_KEYS[specId]].sort();
      assert.deepEqual(keys, expected, `spec ${specId} cell keys drifted from the frozen axis spec`);
    }
    // Every declared spec is covered by the matrix.
    assert.deepEqual([...SPEC_IDS].sort(), PROMPT_SPECS.map((spec) => spec.id).sort());
  });

  test('the source-integrity tripwire pins each matrixed builder module SHA', () => {
    for (const relPath of MATRIX_BUILDER_MODULES) {
      assertModuleShaMatches(relPath, EXPECTED_MODULE_SHAS[relPath]);
    }
  });

  test('reviewer access-mode branches render distinctly (both read-only submodes covered)', () => {
    const render = (accessMode: string, previousHead: string) =>
      reviewerSpec.render({ accessMode, earlierScopeChanges: 'absent', previousHead, reviewLevel: 'moderate' });
    const toolAccess = render('tool-access', 'present');
    const readOnlyInlined = render('read-only-inlined', 'present');
    const readOnlyTool = render('read-only-tool', 'present');
    const renders = [toolAccess, readOnlyInlined, readOnlyTool];
    for (let i = 0; i < renders.length; i += 1) {
      for (let j = i + 1; j < renders.length; j += 1) {
        assert.notEqual(renders[i], renders[j], `buildReviewerPrompt access-mode renders ${i} and ${j} must differ`);
      }
    }

    // plan_reviewer plan vs derived-plan and coder-plan-response blocking vs optional.
    const planReviewPlan = planReviewerSpec.render({
      accessMode: 'tool-access',
      authoredOneShot: 'false',
      mode: 'plan',
    });
    const planReviewDerived = planReviewerSpec.render({
      accessMode: 'tool-access',
      authoredOneShot: 'false',
      mode: 'derived-plan',
    });
    assert.notEqual(planReviewPlan, planReviewDerived);

    const coderPlanBlocking = coderPlanResponseSpec.render({ mode: 'blocking', reviewMode: 'plan' });
    const coderPlanOptional = coderPlanResponseSpec.render({ mode: 'optional', reviewMode: 'plan' });
    assert.notEqual(coderPlanBlocking, coderPlanOptional);
  });

  test('reviewer cells render production continuity framing and plan content per access mode', () => {
    // scope reviewer: every mode gets the tool-access citations framing (the
    // removed no-read inline framing must never render).
    const scopeToolAccess = cellRenderByKey('buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate');
    const scopeReadOnly = cellRenderByKey('buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate');
    for (const render of [scopeToolAccess, scopeReadOnly]) {
      assert.ok(render.includes('# Reviewer Continuity Context'), 'scope reviewer must render the continuity block');
      assert.ok(render.includes('Inspect cited artifacts'));
      assert.ok(render.includes('## Citations'));
      assert.ok(!render.includes('All required review context is inlined'));
      assert.ok(!render.includes('## Inlined review context from Neal'));
    }

    // plan reviewer: every mode renders the reviewed plan (and parent plan for
    // derived-plan review).
    const planToolAccess = cellRenderByKey(
      'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=plan',
    );
    const planDerivedToolAccess = cellRenderByKey(
      'buildPlanReviewerPrompt#accessMode=tool-access#authoredOneShot=false#mode=derived-plan',
    );
    const planReadOnly = cellRenderByKey(
      'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=false#mode=plan',
    );
    assert.ok(planToolAccess.includes('# Reviewer Continuity Context'));
    assert.ok(planToolAccess.includes('Reviewed plan content from Neal'));
    assert.ok(!planToolAccess.includes('Parent plan content from Neal'));
    assert.ok(planDerivedToolAccess.includes('Parent plan content from Neal'));
    assert.ok(planReadOnly.includes('Reviewed plan content from Neal'));
    assert.ok(!planReadOnly.includes('## Inlined review context from Neal'));

    // completion reviewer: same tool-access continuity framing everywhere.
    const complToolAccess = cellRenderByKey(
      'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=moderate',
    );
    const complReadOnly = cellRenderByKey(
      'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=available#reviewLevel=moderate',
    );
    for (const render of [complToolAccess, complReadOnly]) {
      assert.ok(render.includes('Inspect cited artifacts'));
      assert.ok(render.includes('## Citations'));
      assert.ok(!render.includes('## Inlined review context from Neal'));
    }
  });

  test('enumerated axis labels match the values actually passed to builders (branch sentinels)', () => {
    for (const { withKey, withoutKey, sentinel } of AXIS_CONFORMANCE) {
      assertSentinelPresence(withKey, cellRenderByKey(withKey), sentinel, true);
      assertSentinelPresence(withoutKey, cellRenderByKey(withoutKey), sentinel, false);
    }
  });

  test('a cell rendered with the opposite value from its key is rejected', () => {
    // For every axis pair, pairing the "with" key against the sibling's
    // opposite-value render flips the sentinel presence and must be rejected.
    for (const { withKey, withoutKey, sentinel } of AXIS_CONFORMANCE) {
      const oppositeRender = cellRenderByKey(withoutKey);
      assert.throws(
        () => assertSentinelPresence(withKey, oppositeRender, sentinel, true),
        /sentinel presence mismatch/,
        `mislabeling ${withKey} with the ${withoutKey} render must be rejected`,
      );
    }
  });

  test('every declared PromptSpec builder export is represented by the matrix, and no phantom builders', () => {
    for (const spec of PROMPT_SPECS) {
      const matrixExports = [...new Set(SPEC_MATRIX_BUILDERS[spec.id].map((builder) => builder.exportName))].sort();
      const declaredExports = [
        ...new Set<string>([spec.baseInstructions.exportName, ...spec.variants.map((variant) => variant.baseInstructions.exportName)]),
      ].sort();
      assert.deepEqual(
        matrixExports,
        declaredExports,
        `spec ${spec.id} matrix builder exports must equal its baseInstructions + variant builder exports`,
      );
    }
  });

  test('perturbing any enumerated authored-instruction branch breaks the contract without a version bump', () => {
    const perturbedKeys = [
      'buildCoderResponsePrompt#mode=blocking',
      'buildCoderPlanResponsePrompt#mode=optional#planReviewGuidance=absent#reviewMode=plan',
      'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=absent#reviewMode=derived-plan',
      'buildPlanningPrompt#authoredOneShot=true#planDocument=absent',
      'buildPlanReviewerPrompt#accessMode=read-only#authoredOneShot=true#mode=derived-plan',
      'buildScopePrompt',
      'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=false#terminalOnly=true',
      'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=false#allowReplacement=true#terminalOnly=false',
      'buildBlockedRecoveryCoderPrompt#allowLaterScopeRevision=true#allowReplacement=true#terminalOnly=false',
      'buildReviewerPrompt#accessMode=read-only-inlined#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
      'buildReviewerPrompt#accessMode=read-only-tool#earlierScopeChanges=absent#previousHead=present#reviewLevel=moderate',
      // New authored axes (R2-F1): planDocument, planReviewGuidance, aggregate-range.
      'buildPlanningPrompt#authoredOneShot=false#planDocument=present',
      'buildCoderPlanResponsePrompt#mode=blocking#planReviewGuidance=present#reviewMode=plan',
      'buildFinalCompletionReviewerPrompt#accessMode=read-only-tool#aggregateRange=unavailable#reviewLevel=moderate',
      'buildReviewerPrompt#accessMode=tool-access#earlierScopeChanges=absent#previousHead=present#reviewLevel=lenient',
      'buildFinalCompletionReviewerPrompt#accessMode=tool-access#aggregateRange=available#reviewLevel=strict',
    ];
    for (const key of perturbedKeys) {
      const { specId, cells } = findCell(key);
      const spec = getPromptSpec(specId);
      const original = serializeRenderMatrix(cells);
      const perturbed = serializeRenderMatrix(perturbCell(cells, key));
      assert.notEqual(sha256Hex(perturbed), sha256Hex(original), `perturbing ${key} must change the matrix sha`);
      assert.throws(
        () =>
          verifyRenderVersionContract({
            specId,
            version: spec.version,
            changelog: spec.changelog,
            liveMatrix: perturbed,
            readGolden: (version) => readGolden(specId, version),
          }),
        /does not match recorded renderSha/,
        `perturbing ${key} must fail the render-version contract`,
      );
    }
  });

  test('the source tripwire throws when a builder-module SHA does not match its pinned value', () => {
    assert.throws(
      () => assertModuleShaMatches('src/neal/prompts/execute.ts', 'f'.repeat(64)),
      /does not match pinned/,
    );
  });

  test('render-vs-sha/golden inconsistency, mutated golden, and missing golden throw; a proper bump passes', () => {
    const OLD = serializeRenderMatrix([{ key: 'k', render: 'old' }]);
    const NEW = serializeRenderMatrix([{ key: 'k', render: 'new' }]);
    const shaOld = sha256Hex(OLD);
    const shaNew = sha256Hex(NEW);

    // Render changed but recorded sha/golden unchanged -> throws.
    assert.throws(
      () =>
        verifyRenderVersionContract({
          specId: 'scope_coder',
          version: 1,
          changelog: [entry(1, shaOld)],
          liveMatrix: NEW,
          readGolden: () => OLD,
        }),
      /does not match recorded renderSha/,
    );

    // Mutated existing-version golden -> throws.
    assert.throws(
      () =>
        verifyRenderVersionContract({
          specId: 'scope_coder',
          version: 1,
          changelog: [entry(1, shaOld)],
          liveMatrix: OLD,
          readGolden: () => `${OLD}mutated`,
        }),
      /does not match recorded renderSha/,
    );

    // Missing golden -> throws.
    assert.throws(
      () =>
        verifyRenderVersionContract({
          specId: 'scope_coder',
          version: 1,
          changelog: [entry(1, shaOld)],
          liveMatrix: OLD,
          readGolden: () => undefined,
        }),
      /missing the versioned golden/,
    );

    // Proper bump: two versions, live NEW, goldens OLD/NEW -> passes.
    assert.doesNotThrow(() =>
      verifyRenderVersionContract({
        specId: 'scope_coder',
        version: 2,
        changelog: [entry(1, shaOld), entry(2, shaNew)],
        liveMatrix: NEW,
        readGolden: (version) => (version === 1 ? OLD : NEW),
      }),
    );
  });

  test('a coordinated same-version repin is internally consistent (documented boundary)', () => {
    const NEW = serializeRenderMatrix([{ key: 'k', render: 'new' }]);
    const shaNew = sha256Hex(NEW);
    // Live matrix, recorded sha, and golden all moved to NEW consistently at the
    // same version: the unit contract passes. Catching this coordinated repin is
    // the Scope 4 process/CI append-only rule, not this contract.
    assert.doesNotThrow(() =>
      verifyRenderVersionContract({
        specId: 'scope_coder',
        version: 1,
        changelog: [entry(1, shaNew)],
        liveMatrix: NEW,
        readGolden: () => NEW,
      }),
    );
  });

  test('validatePromptSpecVersioning rejects the enumerated malformed contracts', () => {
    const sha = 'a'.repeat(64);
    // Valid case.
    assert.doesNotThrow(() =>
      validatePromptSpecVersioning({ id: 'scope_coder', version: 1, changelog: [entry(1, sha)] }),
    );
    // Fractional version.
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: 1.5, changelog: [entry(1, sha)] }),
      /version must be a safe integer >= 1/,
    );
    // Zero version.
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: 0, changelog: [entry(1, sha)] }),
      /version must be a safe integer >= 1/,
    );
    // Negative version.
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: -1, changelog: [entry(1, sha)] }),
      /version must be a safe integer >= 1/,
    );
    // Fractional entry version.
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: 1, changelog: [entry(1.5, sha)] }),
      /changelog entry version must be a safe integer >= 1/,
    );
    // Empty changelog.
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: 1, changelog: [] }),
      /changelog must not be empty/,
    );
    // Duplicate-version changelog.
    assert.throws(
      () =>
        validatePromptSpecVersioning({ id: 'scope_coder', version: 1, changelog: [entry(1, sha), entry(1, sha)] }),
      /strictly increasing/,
    );
    // Descending-version changelog.
    assert.throws(
      () =>
        validatePromptSpecVersioning({ id: 'scope_coder', version: 1, changelog: [entry(2, sha), entry(1, sha)] }),
      /strictly increasing/,
    );
    // Last-entry/spec mismatch.
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: 2, changelog: [entry(1, sha)] }),
      /must equal spec version/,
    );
    // Malformed renderSha (uppercase).
    assert.throws(
      () => validatePromptSpecVersioning({ id: 'scope_coder', version: 1, changelog: [entry(1, 'A'.repeat(64))] }),
      /renderSha must be 64-char lowercase hex/,
    );
  });
}

if (!IMPORT_ONLY) {
  registerTests();
}
