import type { ReviewFinding } from '../types.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_DONE,
  AUTONOMY_SCOPE_DONE,
  AUTONOMY_SPLIT_PLAN,
  buildProgressSection,
  getCanonicalPlanContractLines,
  getExecuteScopeProgressPayloadContractLines,
} from './shared.js';
import { getPromptSpec } from './specs.js';

function assertPromptBuilder(id: 'scope_coder' | 'scope_reviewer', exportName: string) {
  const spec = getPromptSpec(id);
  const allowedBuilders = [spec.baseInstructions, ...spec.variants.map((variant) => variant.baseInstructions)];
  const matchingBuilder = allowedBuilders.find((builder) => builder.exportName === exportName);
  if (!matchingBuilder) {
    throw new Error(`Prompt spec ${id} does not expose builder ${exportName}`);
  }
  if (matchingBuilder.modulePath !== 'src/neal/prompts/execute.ts') {
    throw new Error(`Prompt spec ${id} still points ${exportName} at ${matchingBuilder.modulePath}`);
  }
  return spec;
}

export function buildScopePrompt(planDoc: string, progressText: string) {
  const spec = assertPromptBuilder('scope_coder', 'buildScopePrompt');
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
    'Then execute exactly one implementation scope.',
    'Do not start a second scope in this turn.',
    'If this scope completes the entire plan, return AUTONOMY_DONE. If more scopes remain, return AUTONOMY_SCOPE_DONE.',
    `If the target remains viable but the current scope has proven to be the wrong execution shape, return ${AUTONOMY_SPLIT_PLAN} instead of forcing the bad shape or using AUTONOMY_BLOCKED.`,
    `Use ${AUTONOMY_SPLIT_PLAN} only when the current scope result should be discarded and replaced by a safer derived plan for the same target.`,
    `When you return ${AUTONOMY_SPLIT_PLAN}, include a derived plan markdown artifact before the final marker.`,
    'The derived plan must use the same Neal-executable contract as a top-level plan. Any derived-plan-specific sections are optional additive context only; they must not replace or rename the canonical machine-consumed sections.',
    ...getExecuteScopeProgressPayloadContractLines(),
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
  progressJustification: {
    milestoneTargeted: string;
    newEvidence: string;
    whyNotRedundant: string;
    nextStepUnlocked: string;
  };
  recentHistorySummary: string;
}) {
  const spec = assertPromptBuilder('scope_reviewer', 'buildReviewerPrompt');
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  const meaningfulProgressVariant = spec.variants.find((variant) => variant.kind === 'meaningful_progress');
  if (!primaryVariant || !meaningfulProgressVariant) {
    throw new Error('Prompt spec scope_reviewer is missing primary or meaningful-progress coverage');
  }

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

export function buildCoderResponsePrompt(args: {
  planDoc: string;
  progressText: string;
  verificationHint: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
}) {
  const spec = assertPromptBuilder('scope_coder', 'buildCoderResponsePrompt');
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
    'If the target remains viable but the current scope has proven to be the wrong execution shape, return outcome=`split_plan` with a concrete derived plan in `derivedPlan`.',
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
