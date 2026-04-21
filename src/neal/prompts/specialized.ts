import type { FinalCompletionPacket, FinalCompletionSummary } from '../types.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_DONE,
  buildProgressSection,
  getTerminalMarkerArtifactBoundaryLines,
} from './shared.js';
import { getUserGuidanceLines } from './guidance.js';
import { getPromptSpec } from './specs.js';

function assertPromptBuilder(
  id: 'diagnostic_analyst' | 'recovery_plan_author' | 'completion_coder' | 'completion_reviewer',
  exportName: string,
) {
  const spec = getPromptSpec(id);
  const allowedBuilders = [spec.baseInstructions, ...spec.variants.map((variant) => variant.baseInstructions)];
  const matchingBuilder = allowedBuilders.find((builder) => builder.exportName === exportName);
  if (!matchingBuilder) {
    throw new Error(`Prompt spec ${id} does not expose builder ${exportName}`);
  }
  if (matchingBuilder.modulePath !== 'src/neal/prompts/specialized.ts') {
    throw new Error(`Prompt spec ${id} still points ${exportName} at ${matchingBuilder.modulePath}`);
  }
  return spec;
}

export function buildFinalCompletionSummaryPrompt(args: {
  planDoc: string;
  packet: FinalCompletionPacket;
}) {
  const spec = assertPromptBuilder('completion_coder', 'buildFinalCompletionSummaryPrompt');
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
    'Return only JSON that matches the required schema.',
    'Keep the response compact and auditable rather than essay-style.',
    'Use `planGoalSatisfied` to state whether the plan goal is satisfied overall.',
    'Use `whatChangedOverall` to summarize the completed work across the whole plan, not just the last scope.',
    'Use `verificationSummary` to summarize the completion evidence that actually ran.',
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
        acceptedScopeCount: args.packet.acceptedScopeCount,
        blockedScopeCount: args.packet.blockedScopeCount,
        verificationOnlyCompletion: args.packet.verificationOnlyCompletion,
        completedScopeSummary: args.packet.completedScopeSummary,
        terminalChangedFilesSummary: args.packet.terminalChangedFilesSummary,
        planChangedFilesSummary: args.packet.planChangedFilesSummary,
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
    'Do not include markdown fences or prose outside the JSON object.',
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
}) {
  const spec = assertPromptBuilder('completion_reviewer', 'buildFinalCompletionReviewerPrompt');
  const finalCompletionVariant = spec.variants.find((variant) => variant.kind === 'final_completion');
  if (!finalCompletionVariant) {
    throw new Error('Prompt spec completion_reviewer is missing a final_completion variant');
  }

  const completionSummary = args.summary;
  const lastImplementationScope = args.packet.lastNonEmptyImplementationScope
    ? JSON.stringify(args.packet.lastNonEmptyImplementationScope, null, 2)
    : 'null';

  return [
    `Review whether the execute-mode plan at ${args.planDoc} is complete as a whole.`,
    '',
    'This is a whole-plan final completion review, not an ordinary last-scope review.',
    'Compare the completed result against the original plan objectives and the whole-plan completion packet below.',
    'Evaluate the totality of the work completed for this plan, not just whether each individual scope was previously accepted.',
    'Your review must answer both of these questions:',
    '- Are the full plan objectives actually satisfied?',
    '- Is the aggregate implementation good enough to keep under ordinary code review standards?',
    'Review the whole-plan result for correctness and completeness against the plan objectives, regressions or missing behavior, cross-scope integration issues that may not have been visible in individual scope reviews, code quality, maintainability, and consistency of the final implementation, and adequacy of test coverage and verification for the total change.',
    'Do not treat prior per-scope acceptance as sufficient evidence that the whole plan is complete or that the aggregate code quality is acceptable.',
    'Return only JSON that matches the required schema.',
    'Use `accept_complete` only when the full plan objectives are satisfied and the aggregate implementation is acceptable under ordinary code review standards.',
    'Use `continue_execution` only when the remaining work is concrete, bounded, and suitable for one explicit follow-on scope.',
    'Use `block_for_operator` when the remaining gap is ambiguous, externally constrained, or needs human direction.',
    'When you return `continue_execution`, you must provide a non-null `missingWork` object with `summary`, `requiredOutcome`, and `verification`.',
    'When you return any other action, `missingWork` must be null.',
    '',
    'Coder whole-plan completion summary:',
    JSON.stringify(completionSummary, null, 2),
    '',
    'Whole-plan completion packet:',
    JSON.stringify(
      {
        executionShape: args.packet.executionShape,
        currentScopeLabel: args.packet.currentScopeLabel,
        acceptedScopeCount: args.packet.acceptedScopeCount,
        blockedScopeCount: args.packet.blockedScopeCount,
        verificationOnlyCompletion: args.packet.verificationOnlyCompletion,
        finalCommit: args.packet.finalCommit,
        completedScopeSummary: args.packet.completedScopeSummary,
        terminalChangedFilesSummary: args.packet.terminalChangedFilesSummary,
        planChangedFilesSummary: args.packet.planChangedFilesSummary,
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
    'Do not include markdown fences or prose outside the JSON object.',
    ...getUserGuidanceLines('reviewer'),
    '',
    'Last non-empty implementation scope reference:',
    lastImplementationScope,
  ].join('\n');
}

export function buildDiagnosticAnalysisPrompt(args: {
  planDoc: string;
  progressText: string;
  question: string;
  target: string;
  analysisArtifactPath: string;
  baselineRef: string | null;
  baselineSource: string;
  blockedReason: string | null;
}) {
  const spec = assertPromptBuilder('diagnostic_analyst', 'buildDiagnosticAnalysisPrompt');
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  if (!primaryVariant) {
    throw new Error('Prompt spec diagnostic_analyst is missing a primary variant');
  }

  return [
    `Continue the diagnostic-recovery analysis for the active execute run described in ${args.planDoc}.`,
    '',
    'Your task in this phase is only to author the diagnostic analysis artifact.',
    `Write the markdown body that Neal will save to ${args.analysisArtifactPath}.`,
    'Do not author the recovery plan in this phase.',
    'Answer the operator diagnostic question directly and keep the analysis bounded to the requested target.',
    'Use the current repository state as the primary source of truth unless baseline context is required.',
    args.baselineRef
      ? `When baseline comparison is needed, inspect baseline ${args.baselineRef} using non-mutating git queries such as \`git show ${args.baselineRef}:<path>\` or \`git diff ${args.baselineRef}..HEAD -- <path>\`. Do not checkout or mutate that baseline.`
      : 'No explicit baseline was provided. If comparison helps, use the active run context and current repository state only.',
    args.blockedReason
      ? `This diagnostic recovery was started from blocker context: ${args.blockedReason}`
      : 'No explicit blocker reason was recorded for this diagnostic recovery.',
    '',
    'Operator diagnostic request:',
    `- Question: ${args.question}`,
    `- Target: ${args.target}`,
    `- Effective baseline: ${args.baselineRef ?? 'none'}`,
    `- Baseline source: ${args.baselineSource}`,
    '',
    'Required analysis goals:',
    '- analyze from the specified baseline/context',
    '- answer the operator diagnostic question directly',
    '- identify what is structurally different or uniquely difficult about the target',
    '- avoid proposing implementation work beyond what is necessary to motivate a later recovery plan',
    '',
    'Required markdown sections:',
    '- `# Diagnostic Analysis`',
    '- `## Request Context`',
    '- `## Findings`',
    '- `## Recovery Implications`',
    '',
    'You may inspect the progress artifact for run context, but do not edit wrapper-owned artifacts.',
    'Keep any commentary outside the artifact body out of the response.',
    ...getTerminalMarkerArtifactBoundaryLines(),
    `End your response with exactly one terminal marker on the final line: ${AUTONOMY_DONE} or ${AUTONOMY_BLOCKED}.`,
    'Use AUTONOMY_BLOCKED only if you cannot produce the diagnostic analysis artifact from the available repository and baseline context.',
    ...getUserGuidanceLines('coder'),
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

export function buildRecoveryPlanPrompt(args: {
  planDoc: string;
  progressText: string;
  question: string;
  target: string;
  analysisArtifactPath: string;
  recoveryPlanPath: string;
  baselineRef: string | null;
  baselineSource: string;
}) {
  const spec = assertPromptBuilder('recovery_plan_author', 'buildRecoveryPlanPrompt');
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  if (!primaryVariant) {
    throw new Error('Prompt spec recovery_plan_author is missing a primary variant');
  }

  return [
    `Continue the diagnostic-recovery authoring flow for the active execute run described in ${args.planDoc}.`,
    '',
    'Your task in this phase is only to author the recovery plan artifact.',
    `Read the diagnostic analysis at ${args.analysisArtifactPath} before you write the plan.`,
    `Write the markdown body that Neal will save to ${args.recoveryPlanPath}.`,
    'Do not review the plan in this phase and do not propose adoption decisions.',
    'Turn the diagnostic analysis into an executable recovery plan that remains narrow, auditable, and safe to adopt back into the active run.',
    args.baselineRef
      ? `The diagnostic analysis may reference baseline ${args.baselineRef} (${args.baselineSource}). Keep any further baseline inspection read-only and non-mutating.`
      : 'No explicit baseline was provided. Rely on the diagnostic analysis and current repository state.',
    '',
    'Operator diagnostic request:',
    `- Question: ${args.question}`,
    `- Target: ${args.target}`,
    `- Diagnostic analysis artifact: ${args.analysisArtifactPath}`,
    '',
    'Required recovery-plan goals:',
    '- turn the diagnostic analysis into an executable recovery plan',
    '- preserve the ordinary Neal-executable plan contract',
    '- keep the recovery plan narrow and adoption-safe',
    '- declare exactly one execution shape using the canonical `## Execution Shape` section',
    '- if multi-scope is necessary, include the canonical `## Execution Queue` with explicit ordered scopes',
    '',
    'Required markdown sections:',
    '- `## Problem Statement`',
    '- `## Goal`',
    '- `## Execution Shape`',
    '- `## Execution Queue` when `executionShape: multi_scope`',
    '',
    'The plan must be Neal-executable and ready for ordinary Neal plan review in a later phase.',
    'Keep any commentary outside the artifact body out of the response.',
    ...getTerminalMarkerArtifactBoundaryLines(),
    `End your response with exactly one terminal marker on the final line: ${AUTONOMY_DONE} or ${AUTONOMY_BLOCKED}.`,
    'Use AUTONOMY_BLOCKED only if the diagnostic analysis does not provide enough grounded information to author a safe recovery plan.',
    ...getUserGuidanceLines('planner'),
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}
