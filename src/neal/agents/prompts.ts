import {
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
} from './schemas.js';
import type {
  CoderConsultRequest,
  ExecuteScopeProgressJustification,
  ExecutionShape,
  ReviewFinding,
  ReviewerConsultResponse,
} from '../types.js';

export const AUTONOMY_SCOPE_DONE = 'AUTONOMY_SCOPE_DONE';
export const AUTONOMY_CHUNK_DONE = 'AUTONOMY_CHUNK_DONE';
export const AUTONOMY_DONE = 'AUTONOMY_DONE';
export const AUTONOMY_BLOCKED = 'AUTONOMY_BLOCKED';
export const AUTONOMY_SPLIT_PLAN = 'AUTONOMY_SPLIT_PLAN';

function getCanonicalPlanContractLines() {
  return [
    'Choose exactly one execution shape: `one_shot` or `multi_scope`.',
    'Declare that choice in the plan document with a literal `## Execution Shape` section followed by exactly one line: `executionShape: one_shot` or `executionShape: multi_scope`.',
    'If the plan should complete in one scope, declare `executionShape: one_shot` and keep the plan single-scope.',
    'If the plan requires multiple scopes, declare `executionShape: multi_scope` and make scope selection and completion rules explicit.',
    'For `multi_scope` plans, include a literal `## Execution Queue` section.',
    'Inside `## Execution Queue`, use literal `### Scope N:` headings with contiguous numbering starting at 1.',
    'Each `### Scope N:` entry must include these labeled bullets: `- Goal:`, `- Verification:`, and `- Success Condition:`.',
    'Minimal accepted multi-scope shape:',
    '```md',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: Example scope',
    '- Goal: Implement one bounded slice.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The bounded slice is complete and verified.',
    '```',
  ];
}

export function buildPlanningPrompt(planDoc: string) {
  return [
    `Rewrite the draft plan document at ${planDoc} into a future execution plan for neal.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    '2. Read any companion docs explicitly referenced by that plan.',
    '3. Reset your instructions for this turn from the current contents of the plan and referenced context.',
    '',
    'Then revise only plan-related artifacts.',
    'Do not edit runtime source code outside the plan itself and adjacent planning notes.',
    'Do not make git commits.',
    'Your output must be a pure future execution plan, not a planning-task checklist.',
    'Replace the draft in place so the resulting file is meant to be run later with neal --execute, not neal --plan.',
    'Do not leave planning-only scaffolding in the final file. Remove or replace sections such as planning mode instructions, Required Inputs for the planner, Verification For This Planning Task, and Completion Criteria For This Planning Task.',
    'Ground the plan in the actual current repository state. Inspect the real target files and write steps against the symbols, exports, and file structure that actually exist.',
    'Do not leave avoidable ambiguity in the plan when the repository already answers the question. Name concrete target functions, files, and exports when they are knowable from the repo.',
    'Do not ask the future executor to perform redundant edits. If an export already propagates through an existing barrel file, say to verify that behavior instead of adding a fake extra edit step.',
    'Make the final plan explicit about scope boundaries, allowed scope, forbidden paths, implementation steps, verification, completion criteria, blocker handling, and any repeated-scope selection rules.',
    'Choose `multi_scope` when the work changes orchestration or state-machine behavior, resume semantics, persistence or schema shape, multiple independent subsystems, or otherwise naturally falls into staged rollout checkpoints.',
    'Choose `one_shot` only when the work can realistically be executed, reviewed, and verified as one bounded scope without hidden staging assumptions.',
    ...getCanonicalPlanContractLines(),
    'If critical information is missing, do not invent it. Surface the concrete missing questions in your final response.',
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

function buildProgressSection(progressText: string) {
  return progressText.trim() || '(no current progress summary available)';
}

export function buildScopePrompt(planDoc: string, progressText: string) {
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
    `When you return ${AUTONOMY_SPLIT_PLAN}, include a derived plan markdown artifact before the final marker.`,
    'The derived plan must use the same Neal-executable contract as a top-level plan. Any derived-plan-specific sections are optional additive context only; they must not replace or rename the canonical machine-consumed sections.',
    `Include exactly one progress-justification JSON payload between ${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START} and ${EXECUTE_SCOPE_PROGRESS_PAYLOAD_END}.`,
    'That JSON payload must contain non-empty string fields for `milestoneTargeted`, `newEvidence`, `whyNotRedundant`, and `nextStepUnlocked`.',
    'Keep any prose explanation or derived plan body outside that payload block.',
    'The final line of your response must still be the terminal marker.',
    ...getCanonicalPlanContractLines(),
    'Verify the relevant work before you finish.',
    'Create real git commit(s) for completed work.',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
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
  progressJustification: ExecuteScopeProgressJustification;
  recentHistorySummary: string;
}) {
  const changedFilesText = args.changedFiles.length > 0 ? args.changedFiles.join('\n') : '(no changed files)';
  const commitsText = args.commits.length > 0 ? args.commits.join('\n') : '(no commits recorded)';

  return [
    `Review the current scope for plan ${args.planDoc}.`,
    `Review round: ${args.round}.`,
    `Commit range: ${args.baseCommit}..${args.headCommit}.`,
    'Review that commit range directly with repository tools. The commit range is the source of truth for this review.',
    '',
    'Produce only structured review findings.',
    'Use blocking severity for correctness, regression, or missing-verification issues.',
    'Also use blocking severity for substantive robustness or performance regressions introduced by the implementation, especially in infrastructure, config, parser, caching, retry, or orchestration code.',
    'Use non_blocking severity for suggestions that do not block acceptance.',
    'Only emit non_blocking findings when they identify a concrete maintenance, observability, or testability issue that is genuinely worth a later follow-up turn.',
    'Do not emit non_blocking findings for formatting, whitespace, naming preferences, trivial code-shape preferences, or optional refactors.',
    'If the scope is acceptable aside from low-signal trivia, return no finding rather than a non_blocking note.',
    'Do not infer that verification was skipped merely because this prompt does not embed full terminal output. Treat missing verification as a finding only when the repository state, plan requirements, or review history give concrete evidence that required verification was not run or was insufficient.',
    'For refactors and config/runtime plumbing changes, actively look for implementation-quality regressions, not just behavioral correctness. Examples include replacing a robust library with a weaker hand-rolled parser, introducing repeated disk reads or reparsing in hot paths, silently weakening error handling, or otherwise making the implementation materially less robust than the prior version.',
    'Check whether test coverage for the changed behavior degraded. If the change removes, weakens, or fails to preserve meaningful test coverage for the affected behavior, treat that as a review finding. Use blocking severity when the missing or degraded coverage leaves the changed behavior insufficiently protected.',
    args.previousHeadCommit
      ? `Previous reviewer head was ${args.previousHeadCommit}. Focus especially on changes since that commit, while still considering the full current state.`
      : 'This is the first reviewer round for this scope.',
    `The active parent objective for meaningful-progress evaluation is scope ${args.parentScopeLabel}.`,
    'You are the authority for meaningful-progress gating during this execute review pass.',
    'Set `meaningfulProgressAction` to `accept` only when this scope materially advances the active parent objective.',
    'Set `meaningfulProgressAction` to `block_for_operator` when the code may be locally correct but the run needs operator guidance before more work on this objective.',
    'Set `meaningfulProgressAction` to `replace_plan` when the current execution shape should be replaced rather than retried.',
    'Use `meaningfulProgressRationale` to explain the convergence judgment against the parent objective and recent accepted-scope history.',
    '',
    'Coder progress justification for this scope:',
    JSON.stringify(args.progressJustification, null, 2),
    '',
    'Recent accepted scope history for this parent objective:',
    args.recentHistorySummary,
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
    `Prior review history is available at ${args.reviewMarkdownPath} if you need earlier reviewer findings or coder responses, but review the current commit range directly.`,
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
    `End your response with exactly one terminal marker on the final line: ${AUTONOMY_DONE} or ${AUTONOMY_BLOCKED}.`,
    'Use AUTONOMY_BLOCKED only if you cannot produce the diagnostic analysis artifact from the available repository and baseline context.',
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
    `End your response with exactly one terminal marker on the final line: ${AUTONOMY_DONE} or ${AUTONOMY_BLOCKED}.`,
    'Use AUTONOMY_BLOCKED only if the diagnostic analysis does not provide enough grounded information to author a safe recovery plan.',
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

export function buildPlanReviewerPrompt(args: {
  planDoc: string;
  round: number;
  reviewMarkdownPath: string;
  mode?: 'plan' | 'derived-plan' | 'recovery-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  recoveryParentScopeLabel?: string | null;
}) {
  const mode = args.mode ?? 'plan';
  return [
    mode === 'derived-plan'
      ? `Review the derived implementation plan at ${args.planDoc} for scope ${args.derivedFromScopeNumber ?? 'unknown'} in parent plan ${args.parentPlanDoc ?? args.planDoc}.`
      : mode === 'recovery-plan'
        ? `Review the diagnostic recovery plan candidate at ${args.planDoc} for parent objective ${args.recoveryParentScopeLabel ?? 'unknown'} in active plan ${args.parentPlanDoc ?? args.planDoc}.`
      : `Review the plan document at ${args.planDoc}.`,
    `Review round: ${args.round}.`,
    '',
    'Produce only structured review findings.',
    'The coder owns the plan document and must declare exactly one execution shape inside it: `one_shot` or `multi_scope`.',
    'You must confirm the declared execution shape and echo it in the required `executionShape` field of your structured output.',
    'Raise a blocking finding when the declared shape is missing, internally inconsistent, or not safe for neal execution.',
    'Assess execution readiness explicitly across these dimensions: scope granularity, verification concreteness, and resume safety.',
    'When you raise a blocking finding about execution readiness, name the failing dimension directly in the claim or required action.',
    'Scope granularity means boundaries stay narrow, auditable, and avoid accidental widening.',
    'Verification concreteness means the plan uses executable verification commands or deterministic repo-derived checks rather than vague instructions.',
    'Resume safety means scopes have clean stopping points, understandable ordering, and no hidden staging assumptions.',
    'A plan should generally be forced to `multi_scope` when it changes orchestration behavior, resume semantics, persistence/schema shape, multiple independent subsystems, or naturally staged rollout checkpoints.',
    mode === 'derived-plan'
      ? 'Use blocking severity when the derived plan does not safely replace the abandoned scope shape, lacks concrete ordered scopes, leaves blast radius too broad, or does not define adequate verification.'
      : mode === 'recovery-plan'
        ? 'Use blocking severity when the recovery plan does not safely replace the failing parent-objective context, is not adoption-safe, leaves the blast radius too broad, or lacks concrete verification.'
      : 'Use blocking severity for missing information or plan structure that would prevent neal from executing safely.',
    mode === 'derived-plan'
      ? 'Reject vague replans such as "break it into smaller chunks" when they do not define the actual replacement sequence in the canonical Neal-executable plan shape.'
      : mode === 'recovery-plan'
        ? 'Review it as a candidate recovery plan, not as a brand-new top-level initiative. It should stay anchored to the current active run and parent objective.'
      : 'Treat leftover planning-task scaffolding as blocking. A final plan must not still describe how to revise itself, how to run neal --plan, or how to validate the planning task.',
    mode === 'derived-plan'
      ? 'Also use blocking severity if the proposal appears to be a real blocker disguised as replanning rather than a safer in-repo execution shape.'
      : mode === 'recovery-plan'
        ? 'Also use blocking severity if the proposal silently broadens into unrelated future work instead of a bounded recovery path for the diagnosed failure mode.'
      : 'Examples of blocking leftover scaffolding include planning-mode execution headers, planner-only required-input sections, "Verification For This Planning Task", and "Completion Criteria For This Planning Task".',
    'Use non_blocking severity for clarity improvements that do not block execution.',
    mode === 'derived-plan'
      ? 'Focus on whether the derived plan actually addresses the failure mode, is concrete enough to execute, reduces blast radius, and is truly not a blocker.'
      : mode === 'recovery-plan'
        ? 'Focus on whether the recovery plan directly answers the diagnostic analysis, remains narrow enough to adopt back into the active run, and preserves the canonical Neal-executable plan shape.'
      : 'Call out plan steps that are avoidably ambiguous or redundant when the current repository already provides a more specific answer, such as existing function names, current exports, or barrel re-export behavior.',
    mode === 'derived-plan'
      ? 'The derived plan should preserve the same target while replacing only the invalid scope shape, and it must use the same canonical `## Execution Shape` / `## Execution Queue` contract as a top-level plan.'
      : mode === 'recovery-plan'
        ? 'The recovery plan should remain a candidate replacement for the active parent objective, and it must use the same canonical `## Execution Shape` / `## Execution Queue` contract as a top-level plan.'
      : 'Focus on whether the plan is now a clean future execution plan, explicit about single-scope vs repeated-scope behavior, and clear about verification and completion.',
    'If the plan is already Neal-executable, confirm that quickly and return no manufactured findings.',
    `Read ${args.reviewMarkdownPath} before finalizing findings so you can inspect prior review history and coder responses.`,
    '',
    'Use repository tools to inspect the current plan and any directly referenced companion docs before finalizing findings.',
  ].join('\n');
}

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

export function buildCoderResponsePrompt(args: {
  planDoc: string;
  progressText: string;
  verificationHint: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
}) {
  const mode = args.mode ?? 'blocking';
  return [
    `Continue autonomously on the task described in ${args.planDoc}.`,
    '',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    mode === 'blocking'
      ? 'Address the currently open review findings provided below.'
      : 'The currently open review findings below are non-blocking. Decide whether to address each one now or explicitly reject/defer it with rationale.',
    'You are still working on the same scope. Do not start a new scope.',
    'Stay on the current implementation scope described by the inlined progress state below.',
    args.verificationHint,
    mode === 'blocking'
      ? 'Make code changes if needed, run the most relevant verification for the fixes you make, and create a real git commit if you changed code.'
      : 'If you choose to address any findings, make the smallest justified code changes, run the most relevant verification for those changes, and create a real git commit if you changed code.',
    'Use `fixed` only when you actually changed the code or verification in a way that resolves the finding.',
    'Use `rejected` only when the finding is incorrect and your summary explains why.',
    'Use `deferred` only when the finding is real but not safe to resolve inside this scope.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    'Always include a `derivedPlan` string. Use an empty string unless outcome=`split_plan`.',
    mode === 'blocking'
      ? 'If you truly cannot continue, return outcome=`blocked` and explain the blocker in `blocker`.'
      : 'Return outcome=`blocked` only if you are genuinely unable to make or explain a decision on these findings.',
    `If the target remains viable but the current scope has proven to be the wrong execution shape, return outcome=\`split_plan\` with a concrete derived plan in \`derivedPlan\`.`,
    'A derived plan must use the same Neal-executable contract as a top-level plan. Derived-plan-specific rationale sections are optional additive context only; they must not replace or rename `## Execution Shape`, `executionShape: ...`, `## Execution Queue`, or the required `### Scope N:` entries.',
    ...getCanonicalPlanContractLines(),
    '',
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
    '',
    'Current progress state:',
    buildProgressSection(args.progressText),
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

export function buildCoderPlanResponsePrompt(args: {
  planDoc: string;
  openFindings: Pick<ReviewFinding, 'id' | 'source' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
  reviewMode?: 'plan' | 'derived-plan' | 'recovery-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  recoveryParentScopeLabel?: string | null;
}) {
  const mode = args.mode ?? 'blocking';
  const reviewMode = args.reviewMode ?? 'plan';

  return [
    reviewMode === 'derived-plan'
      ? `Continue refining the derived implementation plan at ${args.planDoc} for scope ${args.derivedFromScopeNumber ?? 'unknown'} in parent plan ${args.parentPlanDoc ?? args.planDoc}.`
      : reviewMode === 'recovery-plan'
        ? `Continue refining the diagnostic recovery plan candidate at ${args.planDoc} for parent objective ${args.recoveryParentScopeLabel ?? 'unknown'} in active plan ${args.parentPlanDoc ?? args.planDoc}.`
      : `Continue rewriting the draft plan document at ${args.planDoc} into a future execution plan.`,
    '',
    mode === 'blocking'
      ? 'Address the currently open review findings provided below.'
      : 'The currently open review findings below are non-blocking. Decide whether to address each one now or explicitly reject/defer it with rationale.',
    reviewMode === 'derived-plan'
      ? 'Edit only the derived plan artifact and directly related planning notes for that derived plan.'
      : reviewMode === 'recovery-plan'
        ? 'Edit only the diagnostic recovery plan artifact and directly related recovery-planning notes.'
      : 'Edit only the plan document and directly related planning artifacts.',
    'Do not edit runtime source code.',
    'Do not make git commits.',
    reviewMode === 'derived-plan'
      ? 'Keep the same target, but make the derived plan concrete enough to replace the abandoned scope safely.'
      : reviewMode === 'recovery-plan'
        ? 'Keep the same diagnostic target, but make the recovery plan concrete enough to adopt back into the active run safely.'
      : 'The final file must be a pure future execution plan for neal --execute.',
    reviewMode === 'derived-plan'
      ? 'Do not silently widen the target or convert a real blocker into a vague replan.'
      : reviewMode === 'recovery-plan'
        ? 'Do not silently widen the recovery target or turn the candidate recovery plan into a fresh unrelated roadmap.'
      : 'Do not leave planning-task scaffolding behind after you respond to the findings.',
    reviewMode === 'derived-plan'
      ? 'Revise the derived plan so it uses the same Neal-executable contract as a top-level plan. Any derived-plan-specific rationale sections are optional additive context only; they must not replace the canonical machine-consumed sections.'
      : reviewMode === 'recovery-plan'
        ? 'Revise the recovery plan so it uses the same Neal-executable contract as a top-level plan. Any diagnostic-recovery-specific rationale sections are optional additive context only; they must not replace the canonical machine-consumed sections.'
      : 'Where the current repository already answers an implementation detail, revise the plan to use the concrete existing symbol names and exports instead of leaving generic or redundant instructions.',
    ...(reviewMode === 'derived-plan' || reviewMode === 'recovery-plan' ? getCanonicalPlanContractLines() : []),
    'Use `fixed` only when you actually revised the plan to resolve the finding.',
    'Use `rejected` only when the finding is incorrect and your summary explains why.',
    'Use `deferred` only when the finding is real but not safe to resolve without user input.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    mode === 'blocking'
      ? 'If required information is missing, return outcome=`blocked` and explain the concrete questions in `blocker`.'
      : 'Return outcome=`blocked` only if you are genuinely unable to make or explain a decision on these findings.',
    '',
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
  ].join('\n');
}

export function isExecutionShape(value: string): value is ExecutionShape {
  return value === 'one_shot' || value === 'multi_scope';
}
