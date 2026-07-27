import type { FinalCompletionPacket, FinalCompletionSummary } from '../types.js';
import { guardStructuredJsonOutputFormatLines } from '../agents/structured-json.js';
import { renderInlinedRangeDiffSection } from '../context/inline-review-context.js';
import type { ReviewerContextPacket } from '../context/reviewer-context.js';
import { assertPromptBuilder } from './assert-builder.js';
import { getUserGuidanceLines } from './guidance.js';
import { getUnattendedAutonomyLines } from './shared.js';
import {
  getAdversarialReviewDoctrineLines,
  getCodeReviewFalsificationLines,
  getFindingQualityLines,
  getPreexistingFailureContractLines,
  getRegressionPreservationLines,
  getVerificationSkepticismLines,
  type ReviewDoctrineAccessMode,
} from './review-doctrine.js';

const PROMPT_MODULE_PATH = 'src/neal/prompts/specialized.ts' as const;

// Guarded output-format instruction block shared by the two structured-JSON
// completion base prompts. It emits only JSON-only framing and a
// transport-deferring line (replacing the old fence-prohibition that
// contradicted the neal-json transport), and routes the assembled lines through
// guardStructuredJsonOutputFormatLines so a reintroduced conflicting phrasing
// throws at render. Both completion builders emit their output-format
// instructions exclusively through this helper. The transport-deferring line is
// provider-neutral: the neal-json protocol block is appended below the base
// prompt only on the wrapper path (anthropic-claude and the repair loop), while
// other transports (e.g. openai-compatible) send the base prompt with no protocol
// below it, so the line must not claim instructions appear "below".
export function completionJsonOutputFormatLines(label: string): string[] {
  return guardStructuredJsonOutputFormatLines(
    [
      'Return only JSON that matches the required schema.',
      'Return the final answer only as the required structured output object, not as prose or markdown.',
      'Defer exact output framing to the active structured-output transport; do not add your own output-format constraints.',
    ],
    label,
  );
}

export function buildFinalCompletionSummaryPrompt(args: {
  planDoc: string;
  packet: FinalCompletionPacket;
}) {
  const spec = assertPromptBuilder('completion_coder', 'buildFinalCompletionSummaryPrompt', PROMPT_MODULE_PATH);
  const finalCompletionVariant = spec.variants.find((variant) => variant.kind === 'final_completion');
  if (!finalCompletionVariant) {
    throw new Error('Prompt spec completion_coder is missing a final_completion variant');
  }

  const lastImplementationScope = args.packet.lastNonEmptyImplementationScope
    ? JSON.stringify(args.packet.lastNonEmptyImplementationScope, null, 2)
    : 'null';

  return [
    `Summarize whether the execute-mode plan at ${args.planDoc} is complete as a whole.`,
    '',
    'Before writing the summary, review the current repository state, the plan document, and the completion packet below.',
    ...completionJsonOutputFormatLines('buildFinalCompletionSummaryPrompt'),
    'Keep the response compact and auditable rather than essay-style.',
    'Use `planGoalSatisfied` to state whether the plan goal is satisfied overall.',
    'Use `whatChangedOverall` to summarize the completed work across the whole plan, not just the last scope.',
    'Use `verificationSummary` to summarize the completion evidence that actually ran.',
    'Before claiming a step is done or a verification passed, confirm the claim against an actual tool or command result from this session, and do not claim verification that did not actually run.',
    'Use `remainingKnownGaps` for any known missing work, regressions, quality concerns, testing gaps, risks, or omissions that would make the plan not fully complete.',
    'Do not contradict yourself:',
    '- if `planGoalSatisfied` is `true`, `remainingKnownGaps` must be empty',
    '- if `remainingKnownGaps` is non-empty, `planGoalSatisfied` must be `false`',
    '',
    'Whole-plan completion packet:',
    JSON.stringify(
      {
        executionShape: args.packet.executionShape,
        currentScopeLabel: args.packet.currentScopeLabel,
        acceptedScopeRecordCount: args.packet.acceptedScopeCount,
        blockedScopeCount: args.packet.blockedScopeCount,
        scopeAccountingSummary: args.packet.scopeAccountingSummary,
        verificationOnlyCompletion: args.packet.verificationOnlyCompletion,
        aggregateReviewContext: args.packet.aggregateReviewContext,
        completedScopeSummary: args.packet.completedScopeSummary,
        terminalChangedFilesSummary: args.packet.terminalChangedFilesSummary,
        planChangedFilesSummary: args.packet.planChangedFilesSummary,
        verificationCommandResults: args.packet.verificationCommandResults,
        verificationSummary: args.packet.verificationSummary,
        lastNonEmptyImplementationScope: args.packet.lastNonEmptyImplementationScope,
        continueExecutionCount: args.packet.continueExecutionCount,
        continueExecutionMax: args.packet.continueExecutionMax,
      },
      null,
      2,
    ),
    '',
    'If the completion is verification-only, say so directly in `whatChangedOverall` or `remainingKnownGaps` instead of pretending there was a terminal implementation diff.',
    ...getUserGuidanceLines('coder'),
    '',
    'Last non-empty implementation scope reference:',
    lastImplementationScope,
  ].join('\n');
}

export function buildFinalCompletionReviewerPrompt(args: {
  planDoc: string;
  packet: FinalCompletionPacket;
  summary: FinalCompletionSummary;
  scratchDir: string;
  reviewerContext?: ReviewerContextPacket | null;
  // Neal-inlined aggregate commit-range diff for a read-only reviewer that has
  // read tools but no commit-range diff tool. Only rendered when accessMode is
  // 'read-only'.
  inlinedRangeDiff?: string | null;
  // Explicit reviewer doctrine access mode. Defaults to 'tool-access'.
  accessMode?: ReviewDoctrineAccessMode;
  // When true, the run is unattended: render the no-operator autonomy line.
  unattended?: boolean;
}) {
  const spec = assertPromptBuilder('completion_reviewer', 'buildFinalCompletionReviewerPrompt', PROMPT_MODULE_PATH);
  const finalCompletionVariant = spec.variants.find((variant) => variant.kind === 'final_completion');
  if (!finalCompletionVariant) {
    throw new Error('Prompt spec completion_reviewer is missing a final_completion variant');
  }

  const accessMode = args.accessMode ?? 'tool-access';
  // A collected diff may legitimately be the empty string (a range with no
  // changes); distinguish "collected" (any string, including '') from "not
  // collected" (null/undefined) so an empty diff still rides the inlined channel
  // instead of falling back to git_diff-tool phrasing the reviewer cannot use.
  const rangeDiffInlined =
    accessMode === 'read-only' && args.inlinedRangeDiff !== null && args.inlinedRangeDiff !== undefined;
  const completionSummary = args.summary;
  const lastImplementationScope = args.packet.lastNonEmptyImplementationScope
    ? JSON.stringify(args.packet.lastNonEmptyImplementationScope, null, 2)
    : 'null';
  const aggregateRange = args.packet.aggregateReviewContext.range;
  const falsificationLines = getCodeReviewFalsificationLines({
    rangeLabel: aggregateRange ? `aggregate range ${aggregateRange}` : null,
    gitInspectionExamples: aggregateRange
      ? `Use git commands against the repository, for example: git diff ${aggregateRange}, git log --oneline ${aggregateRange}, and targeted path diffs or file reads for changed files.`
      : undefined,
    reviewTarget: 'aggregate implementation',
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
    reviewTarget: 'aggregate implementation',
    mode: accessMode,
  });
  const regressionLines = getRegressionPreservationLines({
    reviewTarget: 'aggregate implementation',
    mode: accessMode,
  });
  const preexistingLines = getPreexistingFailureContractLines({
    reviewTarget: 'aggregate implementation',
    mode: accessMode,
  });

  return [
    `Review whether the execute-mode plan at ${args.planDoc} is complete as a whole.`,
    '',
    'This is a whole-plan final completion review, not an ordinary last-scope review.',
    'Compare the completed result against the original plan objectives and the whole-plan completion packet below.',
    'Evaluate the totality of the work completed for this plan, not just whether each individual scope was previously accepted.',
    'Your review must answer both of these questions:',
    '- Are the full plan objectives actually satisfied?',
    '- Is the aggregate implementation good enough to keep under ordinary code review standards?',
    ...getAdversarialReviewDoctrineLines({
      reviewSubject: 'the whole-plan completion claim',
      falsificationTarget: 'the aggregate implementation',
      creditPhrase: 'accept completion',
      claimSources: 'the coder completion summary, completion packet, verification summaries, or prior per-scope acceptance history',
      judgmentTarget: 'whole-plan completion',
      proofTarget: 'the aggregate implementation satisfies the plan',
    }),
    ...falsificationLines,
    ...scratchLines,
    'Falsify cross-scope runtime invariants and integration behavior before accepting completion, especially paths that individual scope reviews could not see together.',
    'If `aggregateReviewContext.unavailableReason` is non-null, treat the missing aggregate range as a completion-review evidence gap rather than proof that the aggregate implementation is correct.',
    ...skepticismLines,
    ...regressionLines,
    ...preexistingLines,
    ...getFindingQualityLines({ outputContract: 'completion_verdict' }),
    'Review the whole-plan result for correctness and completeness against the plan objectives, regressions or missing behavior, cross-scope integration issues that may not have been visible in individual scope reviews, code quality, maintainability, and consistency of the final implementation, and adequacy of test coverage and verification for the total change.',
    ...getReviewerContextLines(args.reviewerContext),
    'Do not treat prior per-scope acceptance as sufficient evidence that the whole plan is complete or that the aggregate code quality is acceptable.',
    ...completionJsonOutputFormatLines('buildFinalCompletionReviewerPrompt'),
    'Use `accept_complete` only when the full plan objectives are satisfied and the aggregate implementation is acceptable under ordinary code review standards.',
    'Use `continue_execution` only when the remaining work is concrete, bounded, and suitable for one explicit follow-on scope.',
    'Use `block_for_operator` when the remaining gap is ambiguous, externally constrained, or needs human direction.',
    ...getUnattendedAutonomyLines(args.unattended),
    'When you return `continue_execution`, you must provide a non-null `missingWork` object with `summary`, `requiredOutcome`, and `verification`.',
    'When you return any other action, `missingWork` must be null.',
    '',
    'Squash commit message rules:',
    '- `squashCommitMessage` is project-facing Git history for human readers.',
    '- Use `squashCommitMessage` only for `accept_complete`; when you return any non-accept action, set `squashCommitMessage` to null.',
    '- For `accept_complete`, provide a non-null object with one concise project-facing `subject` and 2 to 5 high-level `bullets`.',
    '- Do not mention plan paths, markdown plan filenames, temporary run paths, scope-numbered or per-scope wording, final cleanup, Neal mechanics, provider process, or reviewer process.',
    '- Summarize the code or product behavior change, not the plan document.',
    '- Valid example: subject "Persist final completion review failures"; bullets ["Mark invalid verdicts failed", "Record phase error events"].',
    '- Invalid example: subject "Finish scope 4 cleanup"; bullets ["Summarize per-scope plan work", "Describe reviewer process"].',
    '',
    'Coder whole-plan completion summary:',
    JSON.stringify(completionSummary, null, 2),
    '',
    'Whole-plan completion packet:',
    JSON.stringify(
      {
        executionShape: args.packet.executionShape,
        currentScopeLabel: args.packet.currentScopeLabel,
        acceptedScopeRecordCount: args.packet.acceptedScopeCount,
        blockedScopeCount: args.packet.blockedScopeCount,
        scopeAccountingSummary: args.packet.scopeAccountingSummary,
        verificationOnlyCompletion: args.packet.verificationOnlyCompletion,
        aggregateReviewContext: args.packet.aggregateReviewContext,
        finalCommit: args.packet.finalCommit,
        completedScopeSummary: args.packet.completedScopeSummary,
        terminalChangedFilesSummary: args.packet.terminalChangedFilesSummary,
        planChangedFilesSummary: args.packet.planChangedFilesSummary,
        verificationCommandResults: args.packet.verificationCommandResults,
        verificationSummary: args.packet.verificationSummary,
        lastNonEmptyImplementationScope: args.packet.lastNonEmptyImplementationScope,
        continueExecutionCount: args.packet.continueExecutionCount,
        continueExecutionMax: args.packet.continueExecutionMax,
      },
      null,
      2,
    ),
    '',
    'If this was a verification-only terminal scope, judge the whole-plan result directly instead of pretending there was a final implementation diff.',
    ...getUserGuidanceLines('reviewer'),
    '',
    'Last non-empty implementation scope reference:',
    lastImplementationScope,
    ...(rangeDiffInlined
      ? [
          '',
          renderInlinedRangeDiffSection({
            rangeLabel: aggregateRange ?? 'aggregate range',
            diff: args.inlinedRangeDiff!,
          }),
        ]
      : []),
  ].join('\n');
}

function getReviewerContextLines(reviewerContext: ReviewerContextPacket | null | undefined) {
  if (!reviewerContext) {
    return [];
  }

  return [
    '',
    'Bounded current-run continuity context:',
    reviewerContext.promptMarkdown,
  ];
}
