import {
  assertNoReadPromptInstructionText,
  boundFreeTextValues,
  renderInlineReviewerContext,
  truncateInlineSectionBody,
  type InlineReviewerContext,
} from '../context/inline-review-context.js';
import {
  AUTONOMY_BLOCKED as SHARED_AUTONOMY_BLOCKED,
  AUTONOMY_CHUNK_DONE as SHARED_AUTONOMY_CHUNK_DONE,
  AUTONOMY_DONE as SHARED_AUTONOMY_DONE,
  AUTONOMY_SCOPE_DONE as SHARED_AUTONOMY_SCOPE_DONE,
  AUTONOMY_SPLIT_PLAN as SHARED_AUTONOMY_SPLIT_PLAN,
  buildProgressSection,
  getCanonicalPlanContractLines,
  getProtocolMarkerArtifactProhibitionLines,
  getStandalonePlanPayloadSourceOfTruthLines,
} from '../prompts/shared.js';
import { getUserGuidanceLines, USER_GUIDANCE_MAX_CHARS } from '../prompts/guidance.js';
import { assertPromptBuilder, resolvePrimaryVariant } from '../prompts/assert-builder.js';
export { buildCoderResponsePrompt, buildLegacyScopePrompt, buildReviewerPrompt, buildScopePrompt } from '../prompts/execute.js';
export {
  buildCoderPlanResponsePrompt,
  buildLegacyPlanningPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
} from '../prompts/planning.js';
export {
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
} from '../prompts/specialized.js';

export const AUTONOMY_BLOCKED = SHARED_AUTONOMY_BLOCKED;
export const AUTONOMY_CHUNK_DONE = SHARED_AUTONOMY_CHUNK_DONE;
export const AUTONOMY_DONE = SHARED_AUTONOMY_DONE;
export const AUTONOMY_SCOPE_DONE = SHARED_AUTONOMY_SCOPE_DONE;
export const AUTONOMY_SPLIT_PLAN = SHARED_AUTONOMY_SPLIT_PLAN;

// Single no-read-safe prompt variant for the read-only blocked-run consultant.
// It generalizes across every triaged block class (a coder-blocked signal or a
// reviewer `review_stuck` deadlock): it takes a NON-null InlineReviewerContext
// (the round runner narrows before calling it) and judges entirely from whatever
// sections that context supplies, making no assumptions about which sections are
// present. The static Neal-authored instructions must never reference
// repository/file/shell access, so they pass through the shared no-read guard.
export function buildConsultantPrompt(args: {
  blockedReason: string;
  inlineContext: InlineReviewerContext;
}): string {
  const spec = assertPromptBuilder('consultant', 'buildConsultantPrompt', 'src/neal/agents/prompts.ts');
  resolvePrimaryVariant(spec, 'consultant');
  const staticInstructionLines = [
    'You are a read-only consultant for a blocked neal run. The run has stopped because a coder or reviewer turn reported a blocker it could not resolve on its own.',
    'Judge entirely from the inlined context sections below. You make no changes, run nothing, and look at nothing outside this prompt.',
    'Decide whether the block is an autonomously recoverable misunderstanding that can be resolved WITHIN the existing scope, or a genuine wall that must escalate to a human.',
    'Return `recoverable:true` with `triageCategory:"misunderstanding"` and a concrete, in-scope `resolutionDirective` ONLY when ALL of these hold:',
    '- the block stems from a genuine misunderstanding (the blocked party means something different from, or missed something already present in, the plan or the inlined context),',
    '- it can be resolved within the current scope as written, with no new authorization, credentials, network access, external services, external state, or scope expansion,',
    '- the resolution does not require asking the operator a question (a bounded clarification that needs an operator answer is NOT in scope here; treat it as a genuine wall).',
    'The `resolutionDirective` must be a concrete instruction the blocked party can act on immediately, naming the specific in-scope action that breaks the block.',
    'Otherwise return `recoverable:false` with the matching genuine-wall category:',
    '- `authorization`: the next useful step needs explicit new authorization, credentials, or permission.',
    '- `external_precondition`: it needs network access, external services, or external state that cannot be created in-scope.',
    '- `impossible_task`: the scope as written cannot be satisfied.',
    'If the inlined context lists specific blocking findings, set `targetCanonicalIds` to the canonical ids your verdict addresses; otherwise leave it empty.',
    'Always provide a non-empty `rationale` explaining the triage.',
  ];
  assertNoReadPromptInstructionText(staticInstructionLines.join('\n'), 'buildConsultantPrompt');

  return [
    ...staticInstructionLines,
    '',
    'Blocked reason:',
    // Agent-authored free text shares the fixed agent free-text cap at render
    // time; the persisted blocked reason keeps its full text.
    boundFreeTextValues([args.blockedReason])[0]!,
    '',
    renderInlineReviewerContext(args.inlineContext),
  ].join('\n');
}

export function buildBlockedRecoveryCoderPrompt(args: {
  planDoc: string;
  progressText: string;
  recoveryMarkdownPath: string;
  blockedReason: string;
  operatorGuidance: string;
  maxTurns: number;
  turnsTaken: number;
  terminalOnly?: boolean;
  allowReplacement?: boolean;
  // Offered only when the top-level plan is a canonical multi_scope document
  // with a scope after the current one; the recovery phase decides.
  laterScopeRevision?: {
    topLevelPlanDoc: string;
    currentScopeNumber: number;
    scopeCount: number;
  } | null;
}) {
  const allowReplacement = args.allowReplacement ?? true;
  const laterScopeRevision = args.terminalOnly ? null : args.laterScopeRevision ?? null;
  const actionLines = [
    '- `resume_current_scope`',
    ...(allowReplacement ? ['- `replace_current_scope`'] : []),
    ...(args.terminalOnly && !allowReplacement ? [] : ['- `stay_blocked`']),
    '- `terminal_block`',
  ];
  const terminalOnlyInstruction =
    args.terminalOnly && allowReplacement
      ? 'The recovery turn cap has been reached. You must choose either `replace_current_scope` or `terminal_block`. Do not use `resume_current_scope` or `stay_blocked`.'
      : args.terminalOnly
        ? 'The recovery turn cap has been reached. You must choose `terminal_block`. Do not use `resume_current_scope` or `stay_blocked`.'
        : 'Use `resume_current_scope` when the current scope is still correct and the operator guidance gives enough direction to continue normally.';

  return [
    `Continue blocked recovery for the current neal scope in ${args.planDoc}.`,
    `Read ${args.recoveryMarkdownPath} before responding so you understand the blocked-recovery history.`,
    'Blocked recovery is now in-band inside Neal. Do not tell the operator to leave Neal or resume the coder session separately.',
    'Use the inlined progress state below to stay on the current scope.',
    'You are still handling the same blocked scope. Do not start a new scope.',
    ...getUserGuidanceLines('coder'),
    'Choose exactly one recovery action in your structured response:',
    ...actionLines,
    terminalOnlyInstruction,
    allowReplacement
      ? 'Use `replace_current_scope` when the current scope shape is wrong and Neal should route the replacement through the existing split-plan / derived-plan machinery.'
      : '`replace_current_scope` is not available for this run because replacing the scope would discard or rewrite externally authored commits.',
    args.terminalOnly
      ? 'Use `terminal_block` when no safe in-repo path remains and the run must finalize as truly blocked.'
      : 'Use `stay_blocked` when more operator guidance is still required and the run should remain in interactive blocked recovery.',
    args.terminalOnly
      ? 'Do not ask for additional operator guidance in this turn.'
      : 'Use `terminal_block` only when no safe in-repo path remains and the run should finalize as truly blocked.',
    'Always include a `summary` and `rationale`.',
    allowReplacement
      ? 'Always include a `blocker` string. Use an empty string only when action=`resume_current_scope` or action=`replace_current_scope`.'
      : 'Always include a `blocker` string. Use an empty string only when action=`resume_current_scope`.',
    allowReplacement
      ? 'Always include a `replacementPlan` string. Use an empty string unless action=`replace_current_scope`.'
      : 'Always include an empty `replacementPlan` string.',
    ...(laterScopeRevision
      ? [
          'Always include an integer `laterScopeNumber` and a `laterScopeBody` string. Use `0` and an empty string unless the operator guidance directs a change to a later top-level scope.',
          `The operator guidance may direct a change to one later scope of the top-level plan at ${laterScopeRevision.topLevelPlanDoc}. The current top-level scope is ${laterScopeRevision.currentScopeNumber}; eligible target scopes are ${laterScopeRevision.currentScopeNumber + 1} through ${laterScopeRevision.scopeCount}.`,
          'To revise a later scope, set `laterScopeNumber` to the target scope number and `laterScopeBody` to the complete replacement text of that one `### Scope N:` entry. The body must start with the line `### Scope N:` for the same N (the title after the colon may change), must contain no other `### ` or `## ` heading, and must keep the `- Goal:`, `- Verification:`, and `- Success Condition:` bullets.',
          'A later-scope revision may accompany action=`resume_current_scope` or action=`stay_blocked` only. Set both fields or neither. Do not revise the current scope, an earlier scope, or a derived plan this way, and do not edit the plan file yourself: Neal validates the revised plan and writes it. Put the reasoning for the revision in `rationale`.',
        ]
      : ['Always include `laterScopeNumber` as `0` and `laterScopeBody` as an empty string.']),
    ...(allowReplacement
      ? [
          'When action=`replace_current_scope`, `replacementPlan` must use the same Neal-executable contract as a top-level plan.',
          'Any replacement-specific rationale sections are optional additive context only; they must not replace or rename the canonical machine-consumed sections.',
          ...getStandalonePlanPayloadSourceOfTruthLines({
            planLabel: 'replacement plan',
            payloadLabel: '`replacementPlan` field',
            resetWorkLabel: 'Abandoned scope work',
          }),
          ...getProtocolMarkerArtifactProhibitionLines(),
          ...getCanonicalPlanContractLines(),
        ]
      : []),
    'Do not invent a new recovery taxonomy or extra top-level actions.',
    'Do not treat operator guidance as authorization to skip verification, waive policy, or reinterpret the target beyond the current scope.',
    '',
    'Blocked recovery context:',
    // The blocked reason is agent-authored free text and the guidance is
    // operator-authored; each gets its class's render-time cap while the
    // persisted values keep their full text.
    `- Blocked reason: ${boundFreeTextValues([args.blockedReason])[0]!}`,
    `- Recovery turns used: ${args.turnsTaken} of ${args.maxTurns}`,
    `- Latest operator guidance: ${truncateInlineSectionBody(args.operatorGuidance, USER_GUIDANCE_MAX_CHARS)}`,
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
  ].join('\n');
}
