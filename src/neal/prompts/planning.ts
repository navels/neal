import type { ReviewFinding } from '../types.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_DONE,
  getCanonicalPlanContractLines,
  getTerminalMarkerArtifactBoundaryLines,
} from './shared.js';
import { getPromptSpec } from './specs.js';

function assertPromptBuilder(id: 'plan_author' | 'plan_reviewer' | 'recovery_plan_author' | 'recovery_plan_reviewer', exportName: string) {
  const spec = getPromptSpec(id);
  const allowedBuilders = [spec.baseInstructions, ...spec.variants.map((variant) => variant.baseInstructions)];
  const matchingBuilder = allowedBuilders.find((builder) => builder.exportName === exportName);
  if (!matchingBuilder) {
    throw new Error(`Prompt spec ${id} does not expose builder ${exportName}`);
  }
  if (matchingBuilder.modulePath !== 'src/neal/prompts/planning.ts') {
    throw new Error(`Prompt spec ${id} still points ${exportName} at ${matchingBuilder.modulePath}`);
  }
  return spec;
}

function getPlanReviewerModeLines(args: {
  mode: 'plan' | 'derived-plan' | 'recovery-plan';
  planDoc: string;
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  recoveryParentScopeLabel?: string | null;
}) {
  const { mode } = args;
  return {
    heading:
      mode === 'derived-plan'
        ? `Review the derived implementation plan at ${args.planDoc} for scope ${args.derivedFromScopeNumber ?? 'unknown'} in parent plan ${args.parentPlanDoc ?? args.planDoc}.`
        : mode === 'recovery-plan'
          ? `Review the diagnostic recovery plan candidate at ${args.planDoc} for parent objective ${args.recoveryParentScopeLabel ?? 'unknown'} in active plan ${args.parentPlanDoc ?? args.planDoc}.`
          : `Review the plan document at ${args.planDoc}.`,
    blockingRule:
      mode === 'derived-plan'
        ? 'Use blocking severity when the derived plan does not safely replace the abandoned scope shape, lacks concrete ordered scopes, leaves blast radius too broad, or does not define adequate verification.'
        : mode === 'recovery-plan'
          ? 'Use blocking severity when the recovery plan does not safely replace the failing parent-objective context, is not adoption-safe, leaves the blast radius too broad, or lacks concrete verification.'
          : 'Use blocking severity for missing information or plan structure that would prevent neal from executing safely.',
    scaffoldingRule:
      mode === 'derived-plan'
        ? 'Reject vague replans such as "break it into smaller chunks" when they do not define the actual replacement sequence in the canonical Neal-executable plan shape.'
        : mode === 'recovery-plan'
          ? 'Review it as a candidate recovery plan, not as a brand-new top-level initiative. It should stay anchored to the current active run and parent objective.'
          : 'Treat leftover planning-task scaffolding as blocking. A final plan must not still describe how to revise itself, how to run neal --plan, or how to validate the planning task.',
    wideningRule:
      mode === 'derived-plan'
        ? 'Also use blocking severity if the proposal appears to be a real blocker disguised as replanning rather than a safer in-repo execution shape.'
        : mode === 'recovery-plan'
          ? 'Also use blocking severity if the proposal silently broadens into unrelated future work instead of a bounded recovery path for the diagnosed failure mode.'
          : 'Examples of blocking leftover scaffolding include planning-mode execution headers, planner-only required-input sections, "Verification For This Planning Task", and "Completion Criteria For This Planning Task".',
    focusRule:
      mode === 'derived-plan'
        ? 'Focus on whether the derived plan actually addresses the failure mode, is concrete enough to execute, reduces blast radius, and is truly not a blocker.'
        : mode === 'recovery-plan'
          ? 'Focus on whether the recovery plan directly answers the diagnostic analysis, remains narrow enough to adopt back into the active run, and preserves the canonical Neal-executable plan shape.'
          : 'Call out plan steps that are avoidably ambiguous or redundant when the current repository already provides a more specific answer, such as existing function names, current exports, or barrel re-export behavior.',
    contractRule:
      mode === 'derived-plan'
        ? 'The derived plan should preserve the same target while replacing only the invalid scope shape, and it must use the same canonical `## Execution Shape` / `## Execution Queue` contract as a top-level plan.'
        : mode === 'recovery-plan'
          ? 'The recovery plan should remain a candidate replacement for the active parent objective, and it must use the same canonical `## Execution Shape` / `## Execution Queue` contract as a top-level plan.'
          : 'Focus on whether the plan is now a clean future execution plan, explicit about single-scope vs repeated-scope behavior, and clear about verification and completion.',
  };
}

export function buildPlanningPrompt(planDoc: string) {
  const spec = assertPromptBuilder('plan_author', 'buildPlanningPrompt');
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  if (!primaryVariant) {
    throw new Error('Prompt spec plan_author is missing a primary variant');
  }

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
    ...getTerminalMarkerArtifactBoundaryLines(),
    ...getCanonicalPlanContractLines(),
    'If critical information is missing, do not invent it. Surface the concrete missing questions in your final response.',
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
  const specId = mode === 'recovery-plan' ? 'recovery_plan_reviewer' : 'plan_reviewer';
  const spec = assertPromptBuilder(specId, 'buildPlanReviewerPrompt');
  const expectedVariant = mode === 'derived-plan' ? 'derived_plan' : mode === 'recovery-plan' ? 'recovery_plan' : 'primary';
  if (!spec.variants.some((variant) => variant.kind === expectedVariant)) {
    throw new Error(`Prompt spec ${spec.id} is missing variant ${expectedVariant}`);
  }

  const modeLines = getPlanReviewerModeLines({
    mode,
    planDoc: args.planDoc,
    parentPlanDoc: args.parentPlanDoc,
    derivedFromScopeNumber: args.derivedFromScopeNumber,
    recoveryParentScopeLabel: args.recoveryParentScopeLabel,
  });

  return [
    modeLines.heading,
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
    modeLines.blockingRule,
    modeLines.scaffoldingRule,
    modeLines.wideningRule,
    'Use non_blocking severity for clarity improvements that do not block execution.',
    modeLines.focusRule,
    modeLines.contractRule,
    'If the plan is already Neal-executable, confirm that quickly and return no manufactured findings.',
    `Read ${args.reviewMarkdownPath} before finalizing findings so you can inspect prior review history and coder responses.`,
    '',
    'Use repository tools to inspect the current plan and any directly referenced companion docs before finalizing findings.',
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
  const specId = reviewMode === 'recovery-plan' ? 'recovery_plan_author' : 'plan_author';
  const spec = assertPromptBuilder(specId, 'buildCoderPlanResponsePrompt');
  if (!spec.variants.some((variant) => variant.kind === 'response')) {
    throw new Error(`Prompt spec ${spec.id} is missing a response variant`);
  }

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
    ...getTerminalMarkerArtifactBoundaryLines(),
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
