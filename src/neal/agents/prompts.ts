import type {
  CoderConsultRequest,
  ExecutionShape,
  ReviewerConsultResponse,
} from '../types.js';
import {
  AUTONOMY_BLOCKED as SHARED_AUTONOMY_BLOCKED,
  AUTONOMY_CHUNK_DONE as SHARED_AUTONOMY_CHUNK_DONE,
  AUTONOMY_DONE as SHARED_AUTONOMY_DONE,
  AUTONOMY_SCOPE_DONE as SHARED_AUTONOMY_SCOPE_DONE,
  AUTONOMY_SPLIT_PLAN as SHARED_AUTONOMY_SPLIT_PLAN,
  buildProgressSection,
} from '../prompts/shared.js';
export { buildCoderResponsePrompt, buildReviewerPrompt, buildScopePrompt } from '../prompts/execute.js';
export { buildCoderPlanResponsePrompt, buildPlanReviewerPrompt, buildPlanningPrompt } from '../prompts/planning.js';
export {
  buildDiagnosticAnalysisPrompt,
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
  buildRecoveryPlanPrompt,
} from '../prompts/specialized.js';

export const AUTONOMY_BLOCKED = SHARED_AUTONOMY_BLOCKED;
export const AUTONOMY_CHUNK_DONE = SHARED_AUTONOMY_CHUNK_DONE;
export const AUTONOMY_DONE = SHARED_AUTONOMY_DONE;
export const AUTONOMY_SCOPE_DONE = SHARED_AUTONOMY_SCOPE_DONE;
export const AUTONOMY_SPLIT_PLAN = SHARED_AUTONOMY_SPLIT_PLAN;

export function buildConsultReviewerPrompt(args: {
  planDoc: string;
  request: CoderConsultRequest;
  consultMarkdownPath: string;
}) {
  return [
    `Handle a blocker consultation for the active neal scope in ${args.planDoc}.`,
    'This is a blocker consultation, not a code review.',
    'The coder remains the implementation owner. Your job is to diagnose the blocker and recommend bounded next steps.',
    'Do not expand scope unnecessarily.',
    'You are not allowed to grant policy exceptions, authorize baseline failures, waive verification gates, or reinterpret the plan on behalf of the user or wrapper.',
    'If the blocker would require explicit user or wrapper authorization, say that directly. You may recommend asking for authorization, but you must not treat it as already granted.',
    'Do not tell the coder to consider a failure "allowed", "authorized", or "baseline" unless that authorization is already explicitly present in the blocker request or the referenced plan/context.',
    `Read ${args.consultMarkdownPath} if you need prior consult history.`,
    '',
    'Current blocker request:',
    JSON.stringify(args.request, null, 2),
    '',
    'Use repository inspection only as needed. Prefer concrete, file-specific advice.',
  ].join('\n');
}


export function buildCoderConsultResponsePrompt(args: {
  planDoc: string;
  progressText: string;
  consultMarkdownPath: string;
  request: CoderConsultRequest;
  response: ReviewerConsultResponse;
}) {
  return [
    `Continue the current neal scope for plan ${args.planDoc}.`,
    `Read ${args.consultMarkdownPath} before responding so you understand the current blocker context.`,
    'Use the inlined progress state below to stay on the current scope.',
    'You are still working on the same scope. Do not start a new scope.',
    'Use reviewer advisory feedback below to continue the same scope if possible.',
    'Reviewer consult advice is advisory only. It does not authorize policy exceptions, baseline failures, skipped verification, or plan reinterpretation.',
    'If continuing would require a new allowed-failure baseline or any other explicit user/wrapper authorization that is not already present in the plan or wrapper-owned artifacts, you must remain blocked.',
    'Make code changes if needed, run relevant verification, and create a real git commit if you changed code.',
    'Return outcome=`resumed` if you followed the advice enough to continue the scope.',
    'Return outcome=`blocked` only if the blocker is still real after reasonable follow-through.',
    '',
    'Coder blocker request:',
    JSON.stringify(args.request, null, 2),
    '',
    'Reviewer consultation response:',
    JSON.stringify(args.response, null, 2),
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
  ].join('\n');
}

export function buildBlockedRecoveryCoderPrompt(args: {
  planDoc: string;
  progressText: string;
  consultMarkdownPath: string;
  blockedReason: string;
  operatorGuidance: string;
  maxTurns: number;
  turnsTaken: number;
  terminalOnly?: boolean;
}) {
  return [
    `Continue blocked recovery for the current neal scope in ${args.planDoc}.`,
    `Read ${args.consultMarkdownPath} before responding so you understand the blocked-recovery history.`,
    'Blocked recovery is now in-band inside Neal. Do not tell the operator to leave Neal or resume the coder session separately.',
    'Use the inlined progress state below to stay on the current scope.',
    'You are still handling the same blocked scope. Do not start a new scope.',
    'Choose exactly one recovery action in your structured response:',
    '- `resume_current_scope`',
    '- `replace_current_scope`',
    '- `stay_blocked`',
    '- `terminal_block`',
    args.terminalOnly
      ? 'The recovery turn cap has been reached. You must choose either `replace_current_scope` or `terminal_block`. Do not use `resume_current_scope` or `stay_blocked`.'
      : 'Use `resume_current_scope` when the current scope is still correct and the operator guidance gives enough direction to continue normally.',
    'Use `replace_current_scope` when the current scope shape is wrong and Neal should route the replacement through the existing split-plan / derived-plan machinery.',
    args.terminalOnly
      ? 'Use `terminal_block` when no safe in-repo path remains and the run must finalize as truly blocked.'
      : 'Use `stay_blocked` when more operator guidance is still required and the run should remain in interactive blocked recovery.',
    args.terminalOnly
      ? 'Do not ask for additional operator guidance in this turn.'
      : 'Use `terminal_block` only when no safe in-repo path remains and the run should finalize as truly blocked.',
    'Always include a `summary` and `rationale`.',
    'Always include a `blocker` string. Use an empty string only when action=`resume_current_scope` or action=`replace_current_scope`.',
    'Always include a `replacementPlan` string. Use an empty string unless action=`replace_current_scope`.',
    'Do not invent a new recovery taxonomy or extra top-level actions.',
    'Do not treat operator guidance as authorization to skip verification, waive policy, or reinterpret the target beyond the current scope.',
    '',
    'Blocked recovery context:',
    `- Blocked reason: ${args.blockedReason}`,
    `- Recovery turns used: ${args.turnsTaken} of ${args.maxTurns}`,
    `- Latest operator guidance: ${args.operatorGuidance}`,
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
  ].join('\n');
}

export function isExecutionShape(value: string): value is ExecutionShape {
  return value === 'one_shot' || value === 'multi_scope';
}
