import type { PendingPlanReviewGuidance, ReviewFinding } from '../types.js';
import type { ReviewerContextPacket } from '../context/reviewer-context.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_DONE,
  getCanonicalPlanContractLines,
  getDerivedPlanSectionContractLines,
  getProtocolMarkerArtifactProhibitionLines,
  getTerminalMarkerArtifactBoundaryLines,
} from './shared.js';
import { assertPromptBuilder } from './assert-builder.js';
import { getUserGuidanceLines } from './guidance.js';
import { type ReviewDoctrineAccessMode } from './review-doctrine.js';

const PROMPT_MODULE_PATH = 'src/neal/prompts/planning.ts' as const;
const PLAN_VERIFICATION_NECESSITY_RULE =
  'A repository-wide invariant or global regression guarantee belongs in the plan only when it is necessary for the requested change to be correct.';

function getPlanVerificationScopeLines(role: 'planner' | 'reviewer') {
  return [
    PLAN_VERIFICATION_NECESSITY_RULE,
    role === 'planner'
      ? 'Otherwise, do not introduce it. If the plan already contains an unnecessary broader guarantee, narrow or remove it instead of expanding the implementation or verification scope to satisfy it.'
      : 'Otherwise, do not require additional implementation or verification to satisfy it. If an unnecessary broader guarantee makes the plan misleading, require the planner to narrow or remove the guarantee rather than expand its coverage.',
  ];
}

function getPlanDetailLevelLines() {
  return [
    'Write for both neal and the operator. Prefer the smallest human-reviewable plan that communicates the approach, scope boundaries, and important decisions.',
    'Use moderate-to-high-level implementation detail. Name major subsystems, important files, or key interfaces when they clarify the approach, but leave routine implementation discovery to the coder and reviewer working against the implementation.',
    'Inspect the repository enough to confirm that the approach fits the existing architecture and to identify major dependencies, constraints, and affected subsystems. Do not try to complete the implementation or its full blast-radius analysis in the plan.',
    'Leave routine file, symbol, caller, and test discovery to execution. Avoid line-by-line change lists, exhaustive inventories, exact assertions, pinned values, and fixture recipes unless they preserve a fixed decision or prevent a known failure.',
    'Use allowed-path lists, forbidden-path lists, and detailed blocker handling only when the task has a real boundary or known hazard that needs to survive into execution.',
    ...getPlanVerificationScopeLines('planner'),
  ];
}

function getPlanResponseDetailLevelLines() {
  return [
    'Keep the revised plan concise, human-reviewable, and at moderate-to-high-level implementation detail.',
    'Resolve material findings without expanding the plan into an exhaustive implementation inventory; leave routine discovery to execution.',
    ...getPlanVerificationScopeLines('planner'),
  ];
}

function getPlanReviewerReadinessLines() {
  return [
    'Review the plan independently and look for material problems before accepting it.',
    'A ready plan preserves the requested objective, proposes a sound approach, accounts for major architectural constraints and dependencies, uses a valid execution shape with coherent scopes, and gives each scope meaningful verification and a reviewable success condition.',
    'The plan is written for both neal and the operator. It should be concise enough for a person to review, specific enough to guide implementation, and open enough for the coder to make local choices after inspecting the code.',
    'Raise a blocking finding only when an omission is likely to produce the wrong implementation, make a scope unsafe or impractical, hide a major dependency, leave sequencing materially unclear, or allow incorrect work to appear complete.',
    'Missing routine implementation detail is not a finding. Do not require exhaustive file, symbol, caller, test, command, assertion, line-number, pinned-value, or fixture inventories.',
    'More detail can make a plan worse by turning tentative implementation choices into acceptance requirements. Ask for low-level detail only when it records a fixed decision, preserves compatibility, or prevents a known failure.',
    ...getPlanVerificationScopeLines('reviewer'),
    'Inspect enough repository context to support material findings. Do not audit every implementation path before code has been written.',
  ];
}

function getPlanningPromptBaseLines(planDoc: string) {
  return [
    `Refine the existing plan document at ${planDoc} into a stronger future execution plan for neal.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc} when it is accessible. If that path is outside your file-tool jail, use the inlined current plan content below as the authoritative plan text.`,
    '2. Read any companion docs explicitly referenced by that plan.',
    '3. Reset your instructions for this turn from the current contents of the plan and referenced context.',
    '',
    'Then identify weaknesses in the current plan and improve it. Look specifically for:',
    '- Underdeveloped scopes that need enough implementation detail to guide the coder.',
    '- Missing major architectural constraints or dependencies.',
    '- Vague or missing acceptance criteria / completion criteria.',
    '- Ambiguous scope boundaries or hidden assumptions about the repository.',
    '- Poor or unclear sequencing between scopes.',
    '- Verification that would not meaningfully establish the scope\'s success.',
    '- Planning-task scaffolding left over from an earlier draft.',
    'Produce a substantively improved revision in the same file.',
    'If the current plan is already strong, do not invent new weaknesses; revise only what actually improves it.',
    "Refine for executability without expanding the author's scope. Include refactoring only when the plan calls for it, the objective genuinely requires it, or implementing the change would otherwise increase complexity such that a refactor is a natural outgrowth — not opportunistically.",
    ...getPlanDetailLevelLines(),
    '',
    'Revise only plan-related artifacts.',
    'Do not edit runtime source code outside the plan itself and adjacent planning notes.',
    'Do not make git commits.',
    'Your output must be a pure future execution plan, not a planning-task checklist.',
    'Replace the plan in place so the resulting file is meant to be run later with `neal execute`, not `neal plan`.',
    'Do not leave planning-only scaffolding in the final file. Remove or replace sections such as planning mode instructions, Required Inputs for the planner, Verification For This Planning Task, and Completion Criteria For This Planning Task.',
    'Your refined plan will be reviewed for execution readiness on three dimensions; satisfy each before finalizing: scope granularity (the work is divided into coherent, bounded scopes without exhaustive path inventories), verification concreteness (each scope names meaningful checks without specifying every possible oracle), and resume safety (scopes have understandable ordering and clean stopping points).',
    'Make the final plan explicit about its execution shape, scope goals and approach, sequencing, meaningful verification, and success conditions. Add constraints, non-goals, or blocker handling only where the task needs them.',
    'Choose `multi_scope` when the work changes orchestration or state-machine behavior, resume semantics, persistence or schema shape, multiple independent subsystems, or otherwise naturally falls into staged rollout checkpoints.',
    'Choose `multi_scope_unknown` when the work repeats one bounded recurring slice at a time and the total number of scopes is intentionally unknown until an explicit completion condition is satisfied.',
    'Choose `one_shot` only when the work can realistically be executed, reviewed, and verified as one bounded scope without hidden staging assumptions.',
  ];
}

function getInlineCurrentPlanLines(planDocument?: string | null) {
  if (!planDocument) {
    return [];
  }

  return [
    '',
    'Current plan document content:',
    '```markdown',
    planDocument,
    '```',
    'Use the inlined plan content above as the source of truth if the plan path itself cannot be read by your tools.',
  ];
}

function getPlanReviewerModeLines(args: {
  mode: 'plan' | 'derived-plan';
  planDoc: string;
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
}) {
  const { mode } = args;
  const derivedPlanContractRule = [
    'The derived plan should preserve the same target while replacing only the invalid scope shape, and it must use the same canonical Neal-executable shape contract as a top-level plan.',
    ...getDerivedPlanSectionContractLines(),
    'Reviewers must require the exact section set for the declared shape: `multi_scope` uses `## Execution Queue` and forbids `## Execution Loop` and `## Completion Condition`; `multi_scope_unknown` uses `## Execution Loop` plus `## Completion Condition` and forbids `## Execution Queue`; `one_shot` forbids all three orchestration sections.',
  ].join(' ');

  return {
    heading:
      mode === 'derived-plan'
        ? `Review the derived implementation plan at ${args.planDoc} for scope ${args.derivedFromScopeNumber ?? 'unknown'} in parent plan ${args.parentPlanDoc ?? args.planDoc}.`
        : `Review the plan document at ${args.planDoc}.`,
    blockingRule:
      mode === 'derived-plan'
        ? 'Use blocking severity when the derived plan does not safely replace the abandoned scope shape, lacks concrete ordered scopes, leaves blast radius too broad, or does not define adequate verification.'
        : 'Use blocking severity for missing information or plan structure that would prevent neal from executing safely.',
    scaffoldingRule:
      mode === 'derived-plan'
        ? 'Reject vague replans such as "break it into smaller chunks" when they do not define the actual replacement sequence in the canonical Neal-executable plan shape.'
        : 'Treat leftover planning-task scaffolding as blocking. A final plan must not still describe how to revise itself, how to run `neal plan`, or how to validate the planning task.',
    wideningRule:
      mode === 'derived-plan'
        ? 'Also use blocking severity if the proposal appears to be a real blocker disguised as replanning rather than a safer in-repo execution shape.'
        : 'Examples of blocking leftover scaffolding include planning-mode execution headers, planner-only required-input sections, "Verification For This Planning Task", and "Completion Criteria For This Planning Task".',
    focusRule:
      mode === 'derived-plan'
        ? 'Focus on whether the derived plan actually addresses the failure mode, is concrete enough to execute, reduces blast radius, and is truly not a blocker.'
        : 'Focus on plan quality for refinement: a sound implementation approach, material architectural constraints, coherent scopes, clear sequencing, meaningful verification, and reviewable success conditions. Do not turn routine implementation discovery into plan findings.',
    contractRule:
      mode === 'derived-plan'
        ? derivedPlanContractRule
        : 'Focus on whether the plan is now a clean, human-reviewable future execution plan, explicit about single-scope vs repeated-scope behavior, and clear about verification and completion.',
  };
}

function getAuthoredOneShotPlanningLines(authoredOneShot?: boolean) {
  if (!authoredOneShot) {
    return [];
  }

  return [
    'This plan was authored as a single-scope (`one_shot`) plan; keep it one scope, make the smallest complete change, and do not restructure it into multiple scopes.',
  ];
}

function getAuthoredOneShotReviewerLines(authoredOneShot?: boolean) {
  if (!authoredOneShot) {
    return [];
  }

  return [
    'This plan was authored `one_shot`; raise a blocking finding if the document declares any other execution shape or adds orchestration sections.',
  ];
}

export function buildPlanningPrompt(
  planDoc: string,
  planDocument?: string | null,
  options?: { authoredOneShot?: boolean },
) {
  const spec = assertPromptBuilder('plan_author', 'buildPlanningPrompt', PROMPT_MODULE_PATH);
  const primaryVariant = spec.variants.find((variant) => variant.kind === 'primary');
  if (!primaryVariant) {
    throw new Error('Prompt spec plan_author is missing a primary variant');
  }

  return [
    ...getPlanningPromptBaseLines(planDoc),
    ...getInlineCurrentPlanLines(planDocument),
    ...getAuthoredOneShotPlanningLines(options?.authoredOneShot),
    ...getProtocolMarkerArtifactProhibitionLines(),
    ...getCanonicalPlanContractLines(),
    'If critical information is missing, do not invent it. Surface the concrete missing questions in your final response.',
    'Return only a structured planning envelope with these fields:',
    '- `action`: `ready_for_review` after the plan file has been revised and is ready for review, or `blocked` when critical information is missing.',
    '- `message`: concise human-readable summary of what changed or why you are blocked.',
    '- `executionShape`: exactly the chosen shape for the final plan: `one_shot`, `multi_scope`, or `multi_scope_unknown`.',
    '- `planBody`: the complete final contents of the plan file when `action` is `ready_for_review`; otherwise an empty string.',
    '- `blockedReason`: concrete missing information when `action` is `blocked`; otherwise an empty string.',
    'Do not use terminal marker lines for this primary planning response.',
    ...getUserGuidanceLines('planner'),
  ].join('\n');
}

export function buildLegacyPlanningPrompt(planDoc: string, planDocument?: string | null) {
  return [
    ...getPlanningPromptBaseLines(planDoc),
    ...getInlineCurrentPlanLines(planDocument),
    ...getTerminalMarkerArtifactBoundaryLines(),
    ...getCanonicalPlanContractLines(),
    'If critical information is missing, do not invent it. Surface the concrete missing questions in your final response.',
    ...getUserGuidanceLines('planner'),
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
  mode?: 'plan' | 'derived-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  reviewerContext?: ReviewerContextPacket | null;
  reviewedPlanContent?: string | null;
  parentPlanContent?: string | null;
  // Explicit reviewer doctrine access mode. Defaults to 'tool-access'.
  accessMode?: ReviewDoctrineAccessMode;
  // When true, the top-level plan was authored `one_shot`: render a line instructing the
  // reviewer to raise a blocking finding on any shape expansion or added orchestration.
  authoredOneShot?: boolean;
}) {
  const mode = args.mode ?? 'plan';
  const spec = assertPromptBuilder('plan_reviewer', 'buildPlanReviewerPrompt', PROMPT_MODULE_PATH);
  const expectedVariant = mode === 'derived-plan' ? 'derived_plan' : 'primary';
  if (!spec.variants.some((variant) => variant.kind === expectedVariant)) {
    throw new Error(`Prompt spec ${spec.id} is missing variant ${expectedVariant}`);
  }

  const accessMode = args.accessMode ?? 'tool-access';
  const modeLines = getPlanReviewerModeLines({
    mode,
    planDoc: args.planDoc,
    parentPlanDoc: args.parentPlanDoc,
    derivedFromScopeNumber: args.derivedFromScopeNumber,
  });
  const reviewHistoryLine = `Read ${args.reviewMarkdownPath} before finalizing findings so you can inspect prior review history and coder responses.`;
  const planInspectionLine =
    accessMode === 'read-only'
      ? 'The reviewed plan content is inlined below; use your read-only file tools to inspect directly referenced companion docs and repository source files before finalizing findings.'
      : 'The reviewed plan content is inlined below; use repository tools to inspect directly referenced companion docs and repository source files before finalizing findings.';

  return [
    modeLines.heading,
    `Review round: ${args.round}.`,
    '',
    ...getPlanReviewerReadinessLines(),
    '',
    'Produce only structured review findings.',
    'This is a read-only plan review. Do not edit files, create scratch artifacts, stage changes, commit, or otherwise mutate the repository.',
    'The coder owns the plan document and must declare exactly one execution shape inside it: `one_shot`, `multi_scope`, or `multi_scope_unknown`.',
    'You must confirm the declared execution shape and echo it in the required `executionShape` field of your structured output.',
    'Raise a blocking finding when the declared shape is missing, internally inconsistent, or not safe for neal execution.',
    'Assess execution readiness explicitly across these dimensions: scope granularity, verification concreteness, and resume safety.',
    'When you raise a blocking finding about execution readiness, name the failing dimension directly in the claim or required action.',
    'Every finding must rest on concrete evidence, not assumption. Any claim about the repository’s current state — whether a file, symbol, export, or test node id exists, or whether a verification command collects or passes — must be verified by direct inspection (read the file, search the tree, collect the tests) and cite what you found; any claim about the plan must quote the exact plan text it rests on. If you cannot verify a claim, state the uncertainty instead of raising it as blocking.',
    'Never infer the repository’s current state from what the plan proposes to change. A plan proposing to add a file, class, or test is not evidence that it already exists; a plan introducing a new abstraction is not evidence that existing code or tests are already organized around it. Confirm presence or absence against the actual tree before asserting it.',
    'Scope granularity means the work is divided into coherent, bounded scopes. It does not require an exhaustive allowed-path inventory.',
    'Verification concreteness means each scope names checks that can meaningfully establish success. It does not require every possible test, oracle, assertion, or shell command to be designed in advance.',
    'Resume safety means scopes have understandable ordering and clean stopping points. It does not require the plan to prescribe routine Git mechanics.',
    'A plan should generally be forced to `multi_scope` when it changes orchestration behavior, resume semantics, persistence/schema shape, multiple independent subsystems, or naturally staged rollout checkpoints.',
    'A plan should generally be forced to `multi_scope_unknown` when the work is an intentionally open-ended recurring loop that still executes one bounded scope per cycle and ends only when a stated completion condition becomes true.',
    modeLines.blockingRule,
    modeLines.scaffoldingRule,
    modeLines.wideningRule,
    'Use non_blocking severity for clarity improvements that do not block execution.',
    'Classify every finding with a `findingClass` of either `plan_correctness` or `verification_hardening`.',
    'A `verification_hardening` finding asks for a material improvement to how already-specified behavior will be verified. It may block only when the planned checks could allow the requested change itself to be wrong while still appearing complete. Incomplete enforcement of an unnecessary broader guarantee introduced by the plan is non-blocking.',
    'A `plan_correctness` finding means the plan would build the wrong thing, build an unverifiable thing, or contains an impossible or self-contradictory instruction. When you are unsure which class applies, use `plan_correctness`.',
    modeLines.focusRule,
    modeLines.contractRule,
    'If the plan is already Neal-executable, confirm that quickly and return no manufactured findings.',
    reviewHistoryLine,
    ...getAuthoredOneShotReviewerLines(args.authoredOneShot),
    ...getReviewerContextLines(args.reviewerContext),
    ...getUserGuidanceLines('reviewer'),
    '',
    planInspectionLine,
    ...getReviewedPlanContentLines({
      planDoc: args.planDoc,
      reviewedPlanContent: args.reviewedPlanContent,
      parentPlanDoc: args.parentPlanDoc,
      parentPlanContent: args.parentPlanContent,
    }),
  ].join('\n');
}

function getReviewedPlanContentLines(args: {
  planDoc: string;
  reviewedPlanContent?: string | null;
  parentPlanDoc?: string;
  parentPlanContent?: string | null;
}) {
  if (!args.reviewedPlanContent) {
    return [];
  }

  return [
    '',
    `Reviewed plan content from Neal (${args.planDoc}):`,
    '```markdown',
    args.reviewedPlanContent,
    '```',
    ...(args.parentPlanDoc && args.parentPlanContent
      ? [
          '',
          `Parent plan content from Neal (${args.parentPlanDoc}):`,
          '```markdown',
          args.parentPlanContent,
          '```',
        ]
      : []),
    'Use the inlined plan content above as the authoritative plan text for plan-readiness review. Repository inspection should focus on validating referenced files, symbols, assumptions, and companion docs.',
  ];
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

export function buildCoderPlanResponsePrompt(args: {
  planDoc: string;
  openFindings: Pick<ReviewFinding, 'id' | 'source' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
  reviewMode?: 'plan' | 'derived-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  planReviewGuidance?: NonNullable<PendingPlanReviewGuidance>;
}) {
  const mode = args.mode ?? 'blocking';
  const reviewMode = args.reviewMode ?? 'plan';
  const spec = assertPromptBuilder('plan_author', 'buildCoderPlanResponsePrompt', PROMPT_MODULE_PATH);
  if (!spec.variants.some((variant) => variant.kind === 'response')) {
    throw new Error(`Prompt spec ${spec.id} is missing a response variant`);
  }

  return [
    reviewMode === 'derived-plan'
      ? `Continue refining the derived implementation plan at ${args.planDoc} for scope ${args.derivedFromScopeNumber ?? 'unknown'} in parent plan ${args.parentPlanDoc ?? args.planDoc}.`
      : `Continue refining the plan document at ${args.planDoc} into a stronger future execution plan.`,
    '',
    mode === 'blocking'
      ? 'Address the currently open review findings provided below.'
      : 'The currently open review findings below are non-blocking. Decide whether to address each one now or explicitly reject/defer it with rationale.',
    reviewMode === 'derived-plan'
      ? 'Edit only the derived plan artifact and directly related planning notes for that derived plan.'
      : 'Edit only the plan document and directly related planning artifacts.',
    'Do not edit runtime source code.',
    'Do not make git commits.',
    ...getPlanResponseDetailLevelLines(),
    reviewMode === 'derived-plan'
      ? 'Keep the same target, but make the derived plan concrete enough to replace the abandoned scope safely.'
      : 'The final file must be a pure future execution plan for `neal execute`.',
    reviewMode === 'derived-plan'
      ? 'Do not silently widen the target or convert a real blocker into a vague replan.'
      : 'Do not leave planning-task scaffolding behind after you respond to the findings.',
    reviewMode === 'derived-plan'
      ? 'Revise the derived plan so it uses the same Neal-executable contract as a top-level plan. Any derived-plan-specific rationale sections are optional additive context only; they must not replace the canonical machine-consumed sections.'
      : 'Resolve the material finding without adding planning-task scaffolding.',
    ...(reviewMode === 'derived-plan' ? getDerivedPlanSectionContractLines() : []),
    ...getProtocolMarkerArtifactProhibitionLines(),
    ...(reviewMode === 'derived-plan' ? getCanonicalPlanContractLines() : []),
    'Use `fixed` only when you actually revised the plan to resolve the finding.',
    'Use `rejected` only when the finding is incorrect and your summary explains why.',
    'Use `deferred` only when the finding is real but not safe to resolve without user input.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    mode === 'blocking'
      ? 'If required information is missing, return outcome=`blocked` and explain the concrete questions in `blocker`.'
      : 'Return outcome=`blocked` only if you are genuinely unable to make or explain a decision on these findings.',
    ...getUserGuidanceLines('planner'),
    '',
    ...(args.planReviewGuidance
      ? [
          'Operator guidance for this blocked plan-review recovery:',
          args.planReviewGuidance.message,
          '',
          'This guidance supplements the open reviewer findings. It does not waive plan-contract requirements, verification requirements, or the need to address blocking findings.',
          '',
        ]
      : []),
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
  ].join('\n');
}
