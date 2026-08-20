import type { ReviewFinding } from '../types.js';
import { renderInlinedRangeDiffSection, truncateInlineSectionBody } from '../context/inline-review-context.js';
import type { ReviewerContextPacket } from '../context/reviewer-context.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_DONE,
  AUTONOMY_SCOPE_DONE,
  AUTONOMY_SPLIT_PLAN,
  buildProgressSection,
  getCanonicalPlanContractLines,
  getDerivedPlanSectionContractLines,
  getExecuteScopeProgressPayloadContractLines,
  getProtocolMarkerArtifactProhibitionLines,
  getStandalonePlanPayloadSourceOfTruthLines,
  getTerminalMarkerArtifactBoundaryLines,
  getUnattendedAutonomyLines,
} from './shared.js';
import { assertPromptBuilder } from './assert-builder.js';
import { getUserGuidanceLines } from './guidance.js';
import {
  getAdversarialReviewDoctrineLines,
  getCodeReviewFalsificationLines,
  getFindingQualityLines,
  getPreexistingFailureContractLines,
  getRegressionPreservationLines,
  getVerificationSkepticismLines,
  type ReviewDoctrineAccessMode,
} from './review-doctrine.js';

const PROMPT_MODULE_PATH = 'src/neal/prompts/execute.ts' as const;

export const CODER_REGRESSION_PRESERVATION_LINE =
  'Treat existing behavior on the code paths you touch as part of the contract: identify the shared subsystems your change intersects (state, parsing, dispatch, lifecycle, storage, startup) and confirm that adjacent behavior on those paths still works — by running existing tests that exercise them when such tests exist, or by concrete reasoning through representative flows otherwise — before you finish.';

export const CODER_PREEXISTING_FAILURE_LINES = [
  'If you encounter a pre-existing failure, crash, flaky test, or suspicious runtime behavior while implementing or verifying, do not dismiss it solely because it predates your changes, and do not fix it just because you found it. Classify it first with this acceptance-surface test.',
  "The failure is inside the required acceptance surface only when at least one of these holds: the plan explicitly requires the affected existing behavior to keep working; the plan's stated verification fails because of it; or the behavior this plan delivers cannot be exercised end-to-end without the failing path.",
  "When it is inside the surface and the fix is bounded, fix it and add a focused regression check when practical. When it is inside the surface but the fix is not bounded, do not silently expand the scope; surface it as a blocking concern through this prompt's blocked escape naming the failure as the blocker, or through this prompt's split-plan escape with a derived plan that sequences the fix, so it becomes an explicit decision.",
  'When it is outside the surface, record what you observed and why it cannot affect the required behavior in your progress justification, then continue without fixing it. Fixing out-of-surface pre-existing issues is scope drift.',
] as const;

export function buildScopePrompt(
  planDoc: string,
  progressText: string,
  options?: { unattended?: boolean },
) {
  const spec = assertPromptBuilder('scope_coder', 'buildScopePrompt', PROMPT_MODULE_PATH);
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  if (!primaryVariant) {
    throw new Error('Prompt spec scope_coder is missing a primary variant');
  }

  return [
    `Continue autonomously on the task described in ${planDoc}.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    '2. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '3. Reset your instructions for this turn from the current contents of the plan, the inlined progress state below, and required context.',
    '',
    ...getUnattendedAutonomyLines(options?.unattended),
    'Then execute exactly one implementation scope.',
    'Do not start a second scope in this turn.',
    'Return only the structured execution envelope requested by the provider schema.',
    'Set `action` to `done` only if this scope completes the entire plan. Set `action` to `scope_done` when this scope is complete but more scopes remain.',
    'Set `action` to `continue` only when you made meaningful progress but the same scope needs another implementation pass.',
    'Set `action` to `blocked` only when you are genuinely unable to continue, and explain the blocker in `blockedReason`.',
    'Set `action` to `manual_gate` only for expected user-required work outside the agent process that Neal cannot perform but can later verify with deterministic noninteractive checks.',
    'Use `blocked` for unexpected impasses; use `manual_gate` for intentional waits where `manualGate.resumeChecks` can prove the external work is complete.',
    'When action=`manual_gate`, include a non-null `manualGate` object with non-empty `id`, `title`, `reason`, `instructionsMarkdown`, and at least one command resume check. Keep `derivedPlan` and `blockedReason` empty.',
    'When action is anything other than `manual_gate`, set `manualGate` to null.',
    `If the target remains viable but the current scope has proven to be the wrong execution shape, set action=\`split_plan\` instead of forcing the bad shape or using action=\`blocked\`.`,
    'Use action=`split_plan` only when the current scope result should be discarded and replaced by a safer derived plan for the same target.',
    'When action=`split_plan`, put the complete derived plan body in `derivedPlan`.',
    'The derived plan must use the same Neal-executable contract as a top-level plan. Any derived-plan-specific sections are optional additive context only; they must not replace or rename the canonical machine-consumed sections for the declared shape.',
    ...getDerivedPlanSectionContractLines(),
    ...getStandalonePlanPayloadSourceOfTruthLines({
      planLabel: 'derived plan',
      payloadLabel: '`derivedPlan` field',
      resetWorkLabel: 'Abandoned scope work',
    }),
    'Include exactly one `progress` object with non-empty `milestoneTargeted`, `newEvidence`, `whyNotRedundant`, and `nextStepUnlocked` strings.',
    'Always include `derivedPlan` and `blockedReason` strings. Use an empty string unless the selected action requires that field.',
    ...getProtocolMarkerArtifactProhibitionLines(),
    ...getCanonicalPlanContractLines(),
    CODER_REGRESSION_PRESERVATION_LINE,
    ...CODER_PREEXISTING_FAILURE_LINES,
    'Verify the relevant work before you finish.',
    'Before claiming a step is done or a verification passed, confirm the claim against an actual tool or command result from this session, and state plainly when a step is not yet verified.',
    'Create real git commit(s) for completed work.',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Treat action=`blocked` as a last resort, not an early exit.',
    ...getUserGuidanceLines('coder'),
    '',
    'Current progress state:',
    buildProgressSection(progressText),
  ].join('\n');
}

export function buildLegacyScopePrompt(planDoc: string, progressText: string) {
  return [
    `Continue autonomously on the task described in ${planDoc}.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    '2. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '3. Reset your instructions for this turn from the current contents of the plan, the inlined progress state below, and required context.',
    '',
    'Then execute exactly one implementation scope.',
    'Do not start a second scope in this turn.',
    'If this scope completes the entire plan, return AUTONOMY_DONE. If more scopes remain, return AUTONOMY_SCOPE_DONE.',
    `If the target remains viable but the current scope has proven to be the wrong execution shape, return ${AUTONOMY_SPLIT_PLAN} instead of forcing the bad shape or using AUTONOMY_BLOCKED.`,
    `Use ${AUTONOMY_SPLIT_PLAN} only when the current scope result should be discarded and replaced by a safer derived plan for the same target.`,
    `When you return ${AUTONOMY_SPLIT_PLAN}, write the full derived plan body before the final split-plan marker.`,
    'The derived plan must use the same Neal-executable contract as a top-level plan. Any derived-plan-specific sections are optional additive context only; they must not replace or rename the canonical machine-consumed sections for the declared shape.',
    ...getDerivedPlanSectionContractLines(),
    ...getStandalonePlanPayloadSourceOfTruthLines({
      planLabel: 'derived plan',
      payloadLabel: `derived plan body before ${AUTONOMY_SPLIT_PLAN}`,
      resetWorkLabel: 'Abandoned scope work',
    }),
    ...getExecuteScopeProgressPayloadContractLines(),
    ...getTerminalMarkerArtifactBoundaryLines(),
    'The final line of your response must still be the terminal marker.',
    ...getCanonicalPlanContractLines(),
    CODER_REGRESSION_PRESERVATION_LINE,
    ...CODER_PREEXISTING_FAILURE_LINES,
    'Verify the relevant work before you finish.',
    'Create real git commit(s) for completed work.',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
    ...getUserGuidanceLines('coder'),
    '',
    'Current progress state:',
    buildProgressSection(progressText),
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_SCOPE_DONE}`,
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
    `- ${AUTONOMY_SPLIT_PLAN}`,
  ].join('\n');
}

// One file that an earlier accepted scope changed and the current scope's diff
// touches again, with the earlier scope's diff restricted to that file. The
// adjudicator computes these from state.completedScopes (see
// collectEarlierScopeChanges in src/neal/adjudicator/execute.ts).
export type EarlierScopeFileChange = {
  file: string;
  scopeNumber: string;
  baseCommit: string;
  finalCommit: string;
  diff: string;
};

export const EARLIER_SCOPE_CHANGES_SECTION_HEADING = '## Earlier-scope changes to files in this diff';

// Rendered for every execute-scope review, with or without an overlap: a
// tool-access reviewer can find earlier-scope history itself, and the rule
// about what that history means must not depend on whether Neal inlined it.
const EARLIER_SCOPE_PRESERVATION_LINE =
  "A change to a file that an earlier accepted scope signed off must preserve what that scope's review accepted. Weakening or removing a test, assertion, or check that an earlier scope introduced is a blocking finding unless the plan explicitly calls for it.";

export function buildReviewerPrompt(args: {
  planDoc: string;
  baseCommit: string;
  headCommit: string;
  commits: string[];
  previousHeadCommit?: string | null;
  diffStat: string;
  changedFiles: string[];
  round: number;
  reviewMarkdownPath: string;
  parentScopeLabel: string;
  progressJustification: {
    milestoneTargeted: string;
    newEvidence: string;
    whyNotRedundant: string;
    nextStepUnlocked: string;
  };
  recentHistorySummary: string;
  scratchDir: string;
  reviewerContext?: ReviewerContextPacket | null;
  // Neal-inlined commit-range diff for a read-only reviewer that has read tools
  // but no commit-range diff tool. Only rendered when accessMode is 'read-only'.
  inlinedRangeDiff?: string | null;
  // Files in the current diff that an earlier accepted scope also changed, each
  // with that earlier scope's per-file diff. Rendered in every access mode when
  // non-empty; omitted entirely when there is no overlap.
  earlierScopeChanges?: readonly EarlierScopeFileChange[] | null;
  // Explicit reviewer doctrine access mode. Defaults to 'tool-access'.
  accessMode?: ReviewDoctrineAccessMode;
  // When true, the run is unattended: render the no-operator autonomy line.
  unattended?: boolean;
}) {
  const spec = assertPromptBuilder('scope_reviewer', 'buildReviewerPrompt', PROMPT_MODULE_PATH);
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  const meaningfulProgressVariant = spec.variants.find((variant) => variant.kind === 'meaningful_progress');
  if (!primaryVariant || !meaningfulProgressVariant) {
    throw new Error('Prompt spec scope_reviewer is missing primary or meaningful-progress coverage');
  }

  const accessMode = args.accessMode ?? 'tool-access';
  // A collected diff may legitimately be the empty string (a range with no
  // changes); distinguish "collected" (any string, including '') from "not
  // collected" (null/undefined) so an empty diff still rides the inlined channel
  // instead of falling back to git_diff-tool phrasing the reviewer cannot use.
  const rangeDiffInlined =
    accessMode === 'read-only' && args.inlinedRangeDiff !== null && args.inlinedRangeDiff !== undefined;
  const changedFilesText = args.changedFiles.length > 0 ? args.changedFiles.join('\n') : '(no changed files)';
  const commitsText = args.commits.length > 0 ? args.commits.join('\n') : '(no commits recorded)';
  const falsificationLines = getCodeReviewFalsificationLines({
    rangeLabel: 'commit range',
    gitInspectionExamples: `Use git commands against the repository, for example: git diff ${args.baseCommit}..${args.headCommit}, git show --stat ${args.headCommit}, and targeted path diffs or file reads for changed files.`,
    reviewTarget: 'scope diff',
    includeExecuteFailureClasses: true,
    mode: accessMode,
    rangeDiffInlined,
  });
  // Scratch-directory work requires command execution; only the full
  // tool-access mode may instruct it.
  const scratchLines =
    accessMode !== 'tool-access'
      ? []
      : [
          `Temporary verification scratch directory: ${args.scratchDir}`,
          'Use that run-local scratch directory for temporary verification artifacts, copied tests, scratch builds, logs, and modified throwaway files.',
          'Do not create project-root scratch directories such as build_review/.',
          'Do not leave project-tree scratch files behind; keep scratch work under the run-local directory above.',
        ];
  const skepticismLines = getVerificationSkepticismLines({
    reviewTarget: 'scope diff',
    mode: accessMode,
  });
  const regressionLines = getRegressionPreservationLines({
    reviewTarget: 'scope diff',
    mode: accessMode,
  });
  const preexistingLines = getPreexistingFailureContractLines({
    reviewTarget: 'scope diff',
    mode: accessMode,
  });
  const reviewHistoryLine = `Prior review history is available at ${args.reviewMarkdownPath} if you need earlier reviewer findings or coder responses, but review the current commit range directly.`;

  return [
    `Review the current scope for plan ${args.planDoc}.`,
    `Review round: ${args.round}.`,
    `Commit range: ${args.baseCommit}..${args.headCommit}.`,
    ...falsificationLines,
    ...scratchLines,
    ...getAdversarialReviewDoctrineLines({
      reviewSubject: 'the scope diff',
    }),
    '',
    ...getFindingQualityLines(),
    ...skepticismLines,
    ...regressionLines,
    EARLIER_SCOPE_PRESERVATION_LINE,
    ...preexistingLines,
    args.previousHeadCommit
      ? `Previous reviewer head was ${args.previousHeadCommit}. Focus especially on changes since that commit, while still considering the full current state.`
      : 'This is the first reviewer round for this scope.',
    ...getUserGuidanceLines('reviewer'),
    '',
    'Commits in scope:',
    commitsText,
    '',
    'Diff stat:',
    args.diffStat || '(no diff stat)',
    '',
    'Changed files:',
    changedFilesText,
    '',
    ...getReviewerContextLines(args.reviewerContext),
    `The active parent objective for meaningful-progress evaluation is scope ${args.parentScopeLabel}.`,
    'You are the authority for meaningful-progress gating during this execute review pass, but perform that judgment after the adversarial correctness review above.',
    'Set `meaningfulProgressAction` to `accept` only when either this scope materially advances the active parent objective, or a top-level scope has no required new diff because prior accepted work already satisfies it and you find no issues with sufficient verification evidence.',
    'For top-level already-satisfied acceptance, use `accept`, not `advance_parent`, and name the prior accepted work plus the verification evidence in `meaningfulProgressRationale`.',
    'Set `meaningfulProgressAction` to `block_for_operator` when the objective genuinely cannot proceed without a decision only an operator can make.',
    'Set `meaningfulProgressAction` to `replace_plan` when the current execution shape should be replaced rather than retried.',
    'Set `meaningfulProgressAction` to `advance_parent` only when an active accepted derived plan has an empty current diff and prior accepted derived work already satisfies the parent objective.',
    'Do not use `block_for_operator` solely to ask Neal to retire an already-complete parent objective inside that derived-plan case; use `advance_parent` only for that narrow empty-derived-scope case.',
    'Keep `block_for_operator` for ambiguous already-satisfied claims, missing evidence, missing operator decisions, or unsafe parent-completion claims.',
    'A non-empty or uncertain current diff is the normal case, not a reason to escalate: handle it by accepting, requesting a bounded revision, or splitting the plan rather than choosing `block_for_operator`.',
    ...getUnattendedAutonomyLines(args.unattended),
    'Use `meaningfulProgressRationale` to explain the convergence judgment against the parent objective and recent accepted-scope history. Do not use it to restate correctness findings.',
    '',
    'Coder progress justification for this scope:',
    JSON.stringify(args.progressJustification, null, 2),
    '',
    'Recent accepted scope history for this parent objective:',
    args.recentHistorySummary,
    '',
    reviewHistoryLine,
    'If prior review history or continuity context describes a finding as fixed, rejected, or deferred, do not reopen the same claim from that history alone.',
    'Before emitting a finding that resembles a prior fixed/rejected/deferred finding, inspect the current code or current diff and cite fresh current evidence showing the defect still exists.',
    'If current evidence is ambiguous for an already-addressed claim, do not use a blocking finding to force another coder loop; use meaningfulProgressAction=`block_for_operator` only when operator judgment is genuinely required.',
    ...(rangeDiffInlined
      ? [
          '',
          renderInlinedRangeDiffSection({
            rangeLabel: `${args.baseCommit}..${args.headCommit}`,
            diff: args.inlinedRangeDiff!,
          }),
        ]
      : []),
    ...(args.earlierScopeChanges && args.earlierScopeChanges.length > 0
      ? ['', renderEarlierScopeChangesSection(args.earlierScopeChanges)]
      : []),
  ].join('\n');
}

// Earlier accepted scopes' per-file diffs for files the current diff touches
// again. The body shares the inlined-diff bound (truncateInlineSectionBody),
// which appends an explicit truncation marker instead of dropping content
// silently.
function renderEarlierScopeChangesSection(changes: readonly EarlierScopeFileChange[]) {
  const body = changes
    .map((change) =>
      [
        `### ${change.file} (scope ${change.scopeNumber}, ${change.baseCommit}..${change.finalCommit})`,
        '',
        change.diff.trim() === '' ? '(empty diff)' : change.diff,
      ].join('\n'),
    )
    .join('\n\n');
  return [
    EARLIER_SCOPE_CHANGES_SECTION_HEADING,
    '',
    'The files below were changed by an earlier accepted scope in this run and appear again in the current diff. Each entry shows what that earlier scope did to the file, so what the current scope alters is something you read here rather than something you have to remember.',
    'Check the current diff against each entry before accepting.',
    '',
    truncateInlineSectionBody(body),
  ].join('\n');
}

function getReviewerContextLines(reviewerContext: ReviewerContextPacket | null | undefined) {
  if (!reviewerContext) {
    return [];
  }

  return [
    'Bounded current-run continuity context:',
    reviewerContext.promptMarkdown,
    '',
  ];
}

export function buildCoderResponsePrompt(args: {
  planDoc: string;
  progressText: string;
  verificationHint: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
}) {
  const spec = assertPromptBuilder('scope_coder', 'buildCoderResponsePrompt', PROMPT_MODULE_PATH);
  const responseVariant = spec.variants.find(
    (variant) => variant.kind === 'response' && variant.baseInstructions.exportName === 'buildCoderResponsePrompt',
  );
  if (!responseVariant) {
    throw new Error('Prompt spec scope_coder is missing the reviewer-response variant');
  }

  const mode = args.mode ?? 'blocking';
  return [
    `Continue autonomously on the task described in ${args.planDoc}.`,
    '',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    mode === 'blocking'
      ? 'Address the currently open review findings provided below.'
      : 'The currently open review findings below are non-blocking, but they are not optional to triage. Respond to every finding exactly once.',
    'You are still working on the same scope. Do not start a new scope.',
    'Stay on the current implementation scope described by the inlined progress state below.',
    args.verificationHint,
    mode === 'blocking'
      ? 'Make code changes if needed, run the most relevant verification for the fixes you make, and create a real git commit if you changed code.'
      : 'Fix local, concrete, low-expansion non-blocking findings by default. Make the smallest justified code changes, run the most relevant verification for those changes, and create a real git commit if you changed code.',
    // model-calibrated: caps post-commit tool use once the fix is committed and verified; tuned for a model that otherwise keeps issuing redundant shell commands after it already has enough evidence.
    'After you have made the necessary commit and run the relevant verification, stop using tools. Your next response must return the structured outcome with no additional shell commands such as git show, git status, or extra exploratory tests.',
    // model-calibrated: stops repeated re-verification of an already-evidenced fix; tuned for a model that over-proves rather than summarizing the evidence it already gathered.
    'Do not keep proving the same fix after you have enough evidence to answer each finding. Summarize the evidence in the structured response instead.',
    'Before claiming a step is done or a verification passed, confirm the claim against an actual tool or command result from this session, and state plainly when a finding is not yet verified.',
    CODER_REGRESSION_PRESERVATION_LINE,
    ...CODER_PREEXISTING_FAILURE_LINES,
    'Use `fixed` only when you actually changed the code or verification in a way that resolves the finding.',
    'Use `rejected` only when the finding is incorrect, and your summary must explain the evidence that makes it incorrect.',
    'Use `deferred` only when the finding is real but unsafe or intentionally out of scope for this turn, and your summary must explain the scope or safety reason.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    'Always include a `derivedPlan` string. Use an empty string unless outcome=`split_plan`.',
    mode === 'blocking'
      ? 'If you truly cannot continue, return outcome=`blocked` and explain the blocker in `blocker`.'
      : 'Return outcome=`blocked` only if you are genuinely unable to make or explain a decision on these findings.',
    'If the target remains viable but the current scope has proven to be the wrong execution shape, return outcome=`split_plan` with a concrete derived plan in `derivedPlan`.',
    'A derived plan must use the same Neal-executable contract as a top-level plan. Derived-plan-specific rationale sections are optional additive context only; they must not replace or rename the canonical machine-consumed sections required by the declared shape.',
    ...getDerivedPlanSectionContractLines(),
    ...getStandalonePlanPayloadSourceOfTruthLines({
      planLabel: 'derived plan',
      payloadLabel: '`derivedPlan` field',
      resetWorkLabel: 'Abandoned scope work',
    }),
    ...getProtocolMarkerArtifactProhibitionLines(),
    ...getCanonicalPlanContractLines(),
    ...getUserGuidanceLines('coder'),
    '',
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
  ].join('\n');
}
