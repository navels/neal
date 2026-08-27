import { createHash } from 'node:crypto';

export type PromptSpecId =
  | 'plan_author'
  | 'plan_reviewer'
  | 'scope_coder'
  | 'scope_reviewer'
  | 'completion_coder'
  | 'completion_reviewer'
  | 'consultant';

export type PromptSpecRole = 'coder' | 'reviewer';
export type PromptSpecVariantKind =
  | 'primary'
  | 'response'
  | 'meaningful_progress'
  | 'derived_plan'
  | 'final_completion';

export type PromptContextSource =
  | 'prompt_argument'
  | 'run_artifact'
  | 'review_history'
  | 'repository_state'
  | 'orchestrator_state'
  | 'operator_input';

export type PromptSpecStatus = 'migration_target' | 'adjacent' | 'hold';

export type PromptContextField = {
  key: string;
  source: PromptContextSource;
  required: boolean;
  description: string;
};

export type PromptContextContract = {
  shapeName: string;
  fields: readonly PromptContextField[];
};

export type PromptBuilderContract = {
  kind: 'builder';
  modulePath:
    | 'src/neal/agents/prompts.ts'
    | 'src/neal/prompts/planning.ts'
    | 'src/neal/prompts/execute.ts'
    | 'src/neal/prompts/specialized.ts';
  exportName: string;
  inputShape: PromptContextContract;
};

export type PromptSchemaTarget =
  | {
      kind: 'structured_json';
      schemaBuilder: string;
      parser: string;
      providerSurface: 'neal_json_block_protocol';
    }
  | {
      kind: 'terminal_marker';
      markerSource: 'plain_text_final_line';
      markers: readonly string[];
      parser: string | null;
    };

export type PromptProviderVariant = {
  provider: 'shared' | 'openai-codex' | 'anthropic-claude';
  status: 'default' | 'reserved_for_justified_divergence';
  notes: string;
};

export type PromptSpecVariant = {
  kind: PromptSpecVariantKind;
  status: PromptSpecStatus;
  description: string;
  currentRoundEntrypoints: readonly string[];
  baseInstructions: PromptBuilderContract;
  schemaTarget: PromptSchemaTarget;
};

export type PromptSpecCurrentHome = 'src/neal/prompts' | 'mixed';

// One entry per integer prompt-spec version. The latest entry's `renderSha` pins
// the SHA-256 of the spec's canonical render matrix (see serializeRenderMatrix).
// Any change to an enumerated authored-instruction branch must land as a new
// entry with a new hash plus a new versioned golden; prior entries stay to keep
// the changelog append-only.
export type PromptSpecChangelogEntry = {
  version: number;
  renderSha: string;
};

export type PromptSpec = {
  id: PromptSpecId;
  version: number;
  changelog: readonly PromptSpecChangelogEntry[];
  role: PromptSpecRole;
  purpose: string;
  requiredContext: PromptContextContract;
  schemaTarget: PromptSchemaTarget;
  baseInstructions: PromptBuilderContract;
  providerVariants: readonly PromptProviderVariant[];
  evaluationNotes: readonly string[];
  firstMigrationPriority: 1 | 2 | 3;
  currentHome: PromptSpecCurrentHome;
  ownershipNotes: readonly string[];
  variants: readonly PromptSpecVariant[];
};

function field(
  key: string,
  source: PromptContextSource,
  required: boolean,
  description: string,
): PromptContextField {
  return { key, source, required, description };
}

function context(shapeName: string, fields: readonly PromptContextField[]): PromptContextContract {
  return { shapeName, fields };
}

const SHARED_PROVIDER_VARIANTS: readonly PromptProviderVariant[] = [
  {
    provider: 'shared',
    status: 'default',
    notes: 'Default wording should stay shared across providers until fixture evidence justifies divergence.',
  },
  {
    provider: 'openai-codex',
    status: 'reserved_for_justified_divergence',
    notes: 'Provider-specific overrides belong in prompt specs only when OpenAI Codex behavior demonstrably differs.',
  },
  {
    provider: 'anthropic-claude',
    status: 'reserved_for_justified_divergence',
    notes: 'Provider-specific overrides belong in prompt specs only when Anthropic Claude behavior demonstrably differs.',
  },
] as const;

const PLAN_AUTHOR_CONTEXT = context('PlanAuthorPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the draft or candidate plan artifact being rewritten.'),
  field('companionDocs', 'repository_state', true, 'Companion docs explicitly referenced by the active plan.'),
  field('repositoryState', 'repository_state', true, 'Current repository symbols and file structure that the plan must target concretely.'),
  field('openFindings', 'review_history', false, 'Prior plan-review findings when refining the same plan artifact.'),
  field('reviewMode', 'orchestrator_state', false, 'Plan review mode for ordinary vs derived-plan response wording.'),
]);

const PLAN_REVIEWER_CONTEXT = context('PlanReviewerPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the plan artifact being reviewed.'),
  field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact used to inspect prior findings and responses.'),
  field('round', 'orchestrator_state', true, 'Review round number for the current plan-review loop.'),
  field('mode', 'orchestrator_state', true, 'Plan review mode: ordinary plan or derived-plan.'),
  field('parentPlanDoc', 'prompt_argument', false, 'Path to the parent plan when reviewing a derived plan.'),
  field('derivedFromScopeNumber', 'orchestrator_state', false, 'Parent scope number when reviewing a derived plan.'),
  field('repositoryState', 'repository_state', true, 'Current repository context and directly referenced companion docs.'),
  field(
    'accessMode',
    'orchestrator_state',
    false,
    "Two-way reviewer doctrine access mode derived from the reviewer provider's structured-advisor tool access: 'tool-access' (inspect and execute) or 'read-only' (read tools only; no command execution, test runs, or scratch work). Defaults to 'tool-access' when absent.",
  ),
]);

const SCOPE_CODER_CONTEXT = context('ScopeCoderPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
  field('progressText', 'run_artifact', true, 'Current Neal progress markdown used to keep the scope bounded.'),
  field('openFindings', 'review_history', false, 'Open reviewer findings when responding inside the same scope.'),
  field('verificationHint', 'orchestrator_state', false, 'Wrapper-provided verification guidance for reviewer-response rounds.'),
  field('operatorGuidance', 'operator_input', false, 'Interactive blocked-recovery guidance when the scope is waiting on operator input.'),
  field('recoveryMarkdownPath', 'run_artifact', false, 'Interactive blocked-recovery history artifact path.'),
  field('blockedReason', 'orchestrator_state', false, 'Current blocked reason for interactive blocked recovery.'),
  field('maxTurns', 'orchestrator_state', false, 'Blocked-recovery turn cap.'),
  field('turnsTaken', 'orchestrator_state', false, 'Blocked-recovery turns already used.'),
  field('terminalOnly', 'orchestrator_state', false, 'Whether only terminal replacement/block actions remain allowed.'),
]);

const SCOPE_REVIEWER_CONTEXT = context('ScopeReviewerPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
  field('baseCommit', 'orchestrator_state', true, 'Commit that defines the scope start.'),
  field('headCommit', 'orchestrator_state', true, 'Commit that defines the scope head under review.'),
  field('commits', 'orchestrator_state', true, 'Commits created during the current scope.'),
  field('previousHeadCommit', 'orchestrator_state', false, 'Previous reviewer head commit when reviewing subsequent rounds.'),
  field('diffStat', 'repository_state', true, 'Repo-derived diff summary for the scope commit range.'),
  field('changedFiles', 'repository_state', true, 'Files changed in the scope commit range.'),
  field('round', 'orchestrator_state', true, 'Review round number for the current scope.'),
  field('parentScopeLabel', 'orchestrator_state', true, 'Active parent objective label for meaningful-progress review.'),
  field('progressJustification', 'review_history', true, 'Coder-authored meaningful-progress JSON payload for the scope.'),
  field('recentHistorySummary', 'review_history', true, 'Accepted-scope history for the active parent objective.'),
  field('reviewMarkdownPath', 'run_artifact', true, 'Review artifact that carries prior findings and coder responses.'),
  field('scratchDir', 'run_artifact', true, 'Run-local reviewer scratch directory for temporary verification artifacts.'),
  field(
    'earlierScopeChanges',
    'repository_state',
    false,
    'Files in the current scope diff that an earlier accepted scope also changed, each with that scope number, commit range, and per-file diff. Computed from completedScopes in run state; omitted when there is no overlap.',
  ),
  field(
    'accessMode',
    'orchestrator_state',
    false,
    "Two-way reviewer doctrine access mode derived from the reviewer provider's structured-advisor tool access: 'tool-access' (inspect and execute) or 'read-only' (read tools only; no command execution, test runs, or scratch work). Defaults to 'tool-access' when absent.",
  ),
]);

const COMPLETION_CODER_CONTEXT = context('CompletionCoderPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan being evaluated for final completion.'),
  field('packet', 'orchestrator_state', true, 'Whole-plan completion packet assembled from Neal run state.'),
  field('repositoryState', 'repository_state', true, 'Current repository state used to ground the completion summary.'),
]);

const COMPLETION_REVIEWER_CONTEXT = context('CompletionReviewerPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan being evaluated for final completion.'),
  field('packet', 'orchestrator_state', true, 'Whole-plan completion packet assembled from Neal run state.'),
  field('summary', 'review_history', true, 'Coder-authored whole-plan completion summary under review.'),
  field('scratchDir', 'run_artifact', true, 'Run-local final-completion reviewer scratch directory for temporary verification artifacts.'),
  field('repositoryState', 'repository_state', true, 'Current repository state used to judge whole-plan completion.'),
  field(
    'accessMode',
    'orchestrator_state',
    false,
    "Two-way reviewer doctrine access mode derived from the reviewer provider's structured-advisor tool access: 'tool-access' (inspect and execute) or 'read-only' (read tools only; no command execution, test runs, or scratch work). Defaults to 'tool-access' when absent.",
  ),
]);

const CONSULTANT_CONTEXT = context('ConsultantPromptContext', [
  field('blockedReason', 'prompt_argument', true, 'Blocked reason reported by the stalled coder or reviewer turn.'),
  field(
    'inlineContext',
    'repository_state',
    true,
    'Neal-inlined adjudication context (plan content, open blocking findings, reviewer-round snapshots, or coder blocker plus changed files) the consultant judges entirely from.',
  ),
]);

export const PROMPT_SPECS: readonly PromptSpec[] = [
  {
    id: 'plan_author',
    version: 5,
    changelog: [
      {
        version: 1,
        renderSha: '2e5600ef64885419b574cc0a04b684dc93f3efcc9ede65e4cacc8951a220d5cd',
      },
      {
        version: 2,
        renderSha: 'a9ebcafa81fa0f60812adcb7c7b68f999a6c45c1c7fa7b7a20911031d6b0fd9e',
      },
      {
        version: 3,
        renderSha: '51943007b2a334ee0c92d8314616fb882e9cea7b410b05c5aeda668c7c9e04dc',
      },
      {
        version: 4,
        renderSha: 'e9f5b2dd5f66df87986b2e2f884c560d02a235db053b544221dcb43512e057a4',
      },
      {
        version: 5,
        renderSha: '148ed793be3f39c4a5505289ab3045ff124d8c44a53bf5fa9ccc8c3c5f20d408',
      },
    ],
    role: 'coder',
    purpose: 'Author or revise concise, human-reviewable Neal-executable plans at moderate-to-high-level implementation detail.',
    requiredContext: PLAN_AUTHOR_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildCoderPlanSchema',
      parser: 'validateCoderPlanPayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/planning.ts',
      exportName: 'buildPlanningPrompt',
      inputShape: context('BuildPlanningPromptArgs', [field('planDoc', 'prompt_argument', true, 'Path to the draft plan artifact.')]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the canonical Neal-executable execution-shape contract stays present.',
      'Fixture cases should cover single-scope vs multi-scope decisions and cleanup of planning-only scaffolding.',
      'Prompt tests should preserve repository grounding while rejecting exhaustive implementation inventories.',
      'Planner and response prompts should narrow self-imposed global verification guarantees unless they are necessary for the requested change to be correct.',
    ],
    firstMigrationPriority: 1,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Prompt spec owns plan-author instructions and required context only.',
      'Plan review loop mechanics stay outside the prompt-spec library so the later adjudicator can consume them cleanly.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'migration_target',
        description: 'Initial plan-author prompt used by runCoderPlanRound.',
        currentRoundEntrypoints: ['runCoderPlanRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/planning.ts',
          exportName: 'buildPlanningPrompt',
          inputShape: context('BuildPlanningPromptArgs', [field('planDoc', 'prompt_argument', true, 'Path to the draft plan artifact.')]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderPlanSchema',
          parser: 'validateCoderPlanPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
      {
        kind: 'response',
        status: 'migration_target',
        description: 'Plan-author response round used after plan-review findings.',
        currentRoundEntrypoints: ['runCoderPlanResponseRound(reviewMode=plan)', 'runCoderPlanResponseRound(reviewMode=derived-plan)'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/planning.ts',
          exportName: 'buildCoderPlanResponsePrompt',
          inputShape: context('BuildCoderPlanResponsePromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the plan artifact being revised.'),
            field('openFindings', 'review_history', true, 'Open plan-review findings to address.'),
            field('reviewMode', 'orchestrator_state', false, 'Plan review mode for ordinary vs derived-plan response wording.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderPlanResponseSchema',
          parser: 'validateCoderPlanResponsePayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
  {
    id: 'plan_reviewer',
    version: 4,
    changelog: [
      {
        version: 1,
        renderSha: 'c84e630d1463590eda463726a0529dab6277f1980a2c9c586a3fe3673e44d2ee',
      },
      {
        version: 2,
        renderSha: '43a6f77d767bb5a010203f37b2c1ac980f0d7c6e1eb104f038c33afcea97c658',
      },
      {
        version: 3,
        renderSha: 'fa0309ed0e394c690dfc3135da3c98a74dd5413ccb754fefa100171bf35b72b6',
      },
      {
        version: 4,
        renderSha: '65ad05a8bbe1f4a6d631db8778bf6bed82249151f3412a7773f9568ae2d40f11',
      },
    ],
    role: 'reviewer',
    purpose: 'Review human-reviewable Neal-executable plans for material approach, scope, verification, and resume-safety defects.',
    requiredContext: PLAN_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildPlanReviewerSchema',
      parser: 'PlanReviewerPayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/planning.ts',
      exportName: 'buildPlanReviewerPrompt',
      inputShape: context('BuildPlanReviewerPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the plan artifact under review.'),
        field('round', 'orchestrator_state', true, 'Plan-review round number.'),
        field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact path.'),
        field('mode', 'orchestrator_state', false, 'Plan review mode for ordinary vs derived-plan review.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the reviewer prompt requires executionShape confirmation.',
      'Render tests should assert independent material plan review without adding implementation diff-review instructions or exhaustive detail requirements.',
      'Reviewer tests should distinguish requested-change correctness from incomplete enforcement of broader guarantees introduced by the plan.',
      'Fixture cases should cover ordinary plans and derived plans.',
    ],
    firstMigrationPriority: 1,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Prompt spec owns plan-review instructions, not the loop convergence rules.',
      'Derived-plan review is a variant of plan review rather than a separate top-level prompt-spec identity.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'migration_target',
        description: 'Ordinary plan-review round.',
        currentRoundEntrypoints: ['runPlanReviewerRound(mode=plan)'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/planning.ts',
          exportName: 'buildPlanReviewerPrompt',
          inputShape: context('BuildPlanReviewerPromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the plan artifact under review.'),
            field('round', 'orchestrator_state', true, 'Plan-review round number.'),
            field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact path.'),
            field(
              'accessMode',
              'orchestrator_state',
              false,
              "Optional explicit doctrine access mode ('tool-access' or 'read-only'); defaults to 'tool-access' when absent.",
            ),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildPlanReviewerSchema',
          parser: 'PlanReviewerPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
      {
        kind: 'derived_plan',
        status: 'migration_target',
        description: 'Derived-plan review after split-plan recovery.',
        currentRoundEntrypoints: ['runPlanReviewerRound(mode=derived-plan)'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/planning.ts',
          exportName: 'buildPlanReviewerPrompt',
          inputShape: context('BuildPlanReviewerPromptDerivedArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the derived plan artifact under review.'),
            field('parentPlanDoc', 'prompt_argument', false, 'Path to the parent plan artifact.'),
            field('derivedFromScopeNumber', 'orchestrator_state', false, 'Parent scope number that the derived plan replaces.'),
            field(
              'accessMode',
              'orchestrator_state',
              false,
              "Optional explicit doctrine access mode ('tool-access' or 'read-only'); defaults to 'tool-access' when absent.",
            ),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildPlanReviewerSchema',
          parser: 'PlanReviewerPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
  {
    id: 'scope_coder',
    version: 3,
    changelog: [
      {
        version: 1,
        renderSha: 'c579d65db51be90fa81dbe3b7dd260083bc4960cc4cba32ccf2cd802d19703bc',
      },
      {
        version: 2,
        renderSha: '0ce921ee7d0acc4042bacf31e1509968f7e76df8db8417eb4b724ce7842794ac',
      },
      {
        version: 3,
        renderSha: '8fb94430bf9d9abcb11f905106a3a04fc1b81bd101104c88f84a8693f705c5ea',
      },
    ],
    role: 'coder',
    purpose: 'Execute exactly one bounded implementation scope and respond to in-scope review feedback without starting new scopes.',
    requiredContext: SCOPE_CODER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildCoderScopeSchema',
      parser: 'validateCoderScopePayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/execute.ts',
      exportName: 'buildScopePrompt',
      inputShape: context('BuildScopePromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
        field('progressText', 'run_artifact', true, 'Current Neal progress markdown.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert structured execution envelope, progress-justification field requirements, and manual-gate instructions.',
      'Future fixture cases should cover split-plan responses, manual-gate checks, and response-round schema invariants.',
    ],
    firstMigrationPriority: 2,
    currentHome: 'mixed',
    ownershipNotes: [
      'Prompt spec owns execute-scope instructions, not state transitions, commit adoption, or blocked-recovery routing.',
      'Blocked recovery stays as a capability variant rather than a separate top-level role id in v1.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'migration_target',
        description: 'Initial execute-scope coder round.',
        currentRoundEntrypoints: ['runCoderScopeRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/execute.ts',
          exportName: 'buildScopePrompt',
          inputShape: context('BuildScopePromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
            field('progressText', 'run_artifact', true, 'Current Neal progress markdown.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderScopeSchema',
          parser: 'validateCoderScopePayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
      {
        kind: 'response',
        status: 'migration_target',
        description: 'Reviewer-response round inside the same execute scope.',
        currentRoundEntrypoints: ['runCoderResponseRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/execute.ts',
          exportName: 'buildCoderResponsePrompt',
          inputShape: context('BuildCoderResponsePromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
            field('progressText', 'run_artifact', true, 'Current Neal progress markdown.'),
            field('verificationHint', 'orchestrator_state', true, 'Wrapper-provided verification hint.'),
            field('openFindings', 'review_history', true, 'Open execute-review findings to address.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderResponseSchema',
          parser: 'validateCoderResponsePayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
      {
        kind: 'response',
        status: 'adjacent',
        description: 'Interactive blocked-recovery response round.',
        currentRoundEntrypoints: ['runBlockedRecoveryCoderRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/agents/prompts.ts',
          exportName: 'buildBlockedRecoveryCoderPrompt',
          inputShape: context('BuildBlockedRecoveryCoderPromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
            field('progressText', 'run_artifact', true, 'Current Neal progress markdown.'),
            field('recoveryMarkdownPath', 'run_artifact', true, 'Interactive blocked-recovery history artifact path.'),
            field('blockedReason', 'orchestrator_state', true, 'Current blocked reason.'),
            field('operatorGuidance', 'operator_input', true, 'Latest operator guidance.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderBlockedRecoveryDispositionSchema',
          parser: 'validateCoderBlockedRecoveryDispositionPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
  {
    id: 'scope_reviewer',
    version: 4,
    changelog: [
      {
        version: 1,
        renderSha: '38a19da2b70dc10f6f4d8c4b955ece084bbe6e1291151de9c557dca194411386',
      },
      {
        version: 2,
        renderSha: '431a75ad341a531535606af607187239a31d12cf921575eb17774b317ad639a0',
      },
      {
        version: 3,
        renderSha: '4b75fab01367f0e4e263bc7635f8753e8e73c08b3ca46cf6bb6e695a67da31a4',
      },
      {
        version: 4,
        renderSha: 'da87b19f2401ffdca21e3cefec1037c6470b3e74810b6152d07c55fa4924047f',
      },
    ],
    role: 'reviewer',
    purpose: 'Review execute-scope results for correctness, verification coverage, and meaningful progress toward the active parent objective.',
    requiredContext: SCOPE_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildReviewerSchema',
      parser: 'ReviewerPayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/execute.ts',
      exportName: 'buildReviewerPrompt',
      inputShape: context('BuildReviewerPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
        field('baseCommit', 'orchestrator_state', true, 'Commit range base.'),
        field('headCommit', 'orchestrator_state', true, 'Commit range head.'),
        field('commits', 'orchestrator_state', true, 'Commits produced in the current scope.'),
        field('round', 'orchestrator_state', true, 'Review round number.'),
        field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact path.'),
        field('progressJustification', 'review_history', true, 'Coder progress-justification payload.'),
        field('scratchDir', 'run_artifact', true, 'Run-local scratch directory for reviewer verification artifacts.'),
        field(
          'earlierScopeChanges',
          'repository_state',
          false,
          'Earlier accepted scopes\' per-file diffs for files the current diff touches again; absent when there is no overlap.',
        ),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert reviewer prompts include shared adversarial falsification, verification skepticism, concrete finding-quality doctrine, meaningful-progress instructions, and parent-objective history.',
      'Render tests should assert the earlier-scope preservation line renders in every cell and the earlier-scope changes section renders only when an overlap is supplied.',
      'Future fixture cases should cover cases where local correctness differs from parent-objective convergence.',
    ],
    firstMigrationPriority: 2,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Meaningful-progress remains a capability variant of scope review in v1 rather than its own top-level prompt spec.',
      'Reviewer loop sequencing and acceptance transitions stay outside the prompt-spec library.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'migration_target',
        description: 'Execute-scope review round.',
        currentRoundEntrypoints: ['runReviewerRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/execute.ts',
          exportName: 'buildReviewerPrompt',
          inputShape: context('BuildReviewerPromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
            field('baseCommit', 'orchestrator_state', true, 'Commit range base.'),
            field('headCommit', 'orchestrator_state', true, 'Commit range head.'),
            field('commits', 'orchestrator_state', true, 'Commits produced in the current scope.'),
            field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact path.'),
            field('parentScopeLabel', 'orchestrator_state', true, 'Active parent objective label.'),
            field('scratchDir', 'run_artifact', true, 'Run-local scratch directory for reviewer verification artifacts.'),
            field(
              'accessMode',
              'orchestrator_state',
              false,
              "Optional explicit doctrine access mode ('tool-access' or 'read-only'); defaults to 'tool-access' when absent.",
            ),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildReviewerSchema',
          parser: 'ReviewerPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
      {
        kind: 'meaningful_progress',
        status: 'migration_target',
        description:
          'Meaningful-progress capability layered onto execute review, including ordinary accept, top-level already-satisfied accept, block_for_operator, replace_plan, and the empty derived-scope advance_parent action.',
        currentRoundEntrypoints: ['runReviewerRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/execute.ts',
          exportName: 'buildReviewerPrompt',
          inputShape: context('BuildReviewerPromptMeaningfulProgressArgs', [
            field('progressJustification', 'review_history', true, 'Coder progress-justification payload.'),
            field('recentHistorySummary', 'review_history', true, 'Accepted scope history for the active parent objective.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildReviewerSchema',
          parser: 'ReviewerPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
  {
    id: 'completion_coder',
    version: 2,
    changelog: [
      {
        version: 1,
        renderSha: 'f88b43d206de28212ad7f6f3ae84576718934b0a5e36953e35afee89c4d7ce5e',
      },
      {
        version: 2,
        renderSha: '85f36db1245090baa3c8f74e5fe2d3de774664dcb6a3b1b84dcc49425cc3c646',
      },
    ],
    role: 'coder',
    purpose: 'Summarize whole-plan completion state in compact structured JSON.',
    requiredContext: COMPLETION_CODER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildFinalCompletionSummarySchema',
      parser: 'parseFinalCompletionSummaryPayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/specialized.ts',
      exportName: 'buildFinalCompletionSummaryPrompt',
      inputShape: context('BuildFinalCompletionSummaryPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan.'),
        field('packet', 'orchestrator_state', true, 'Whole-plan completion packet.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the prompt requires JSON-only output and completion packet context.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Whole-plan completion summary is prompt-local; completion transitions remain outside the prompt-spec library.',
    ],
    variants: [
      {
        kind: 'final_completion',
        status: 'migration_target',
        description: 'Whole-plan completion summary round.',
        currentRoundEntrypoints: ['runCoderFinalCompletionSummaryRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/specialized.ts',
          exportName: 'buildFinalCompletionSummaryPrompt',
          inputShape: context('BuildFinalCompletionSummaryPromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan.'),
            field('packet', 'orchestrator_state', true, 'Whole-plan completion packet.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildFinalCompletionSummarySchema',
          parser: 'parseFinalCompletionSummaryPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
  {
    id: 'completion_reviewer',
    version: 4,
    changelog: [
      {
        version: 1,
        renderSha: 'e5d104d46899f01cf69db9d2e6d109aa32d0faf645d6d908aae443558900a131',
      },
      {
        version: 2,
        renderSha: 'cc06cea4a8de6366f07a6943718fc1ae219e4c9092a5cf52542fa9de0caa02da',
      },
      {
        version: 3,
        renderSha: '127097db4b0d06cba8943681d12d93fbb07e577e078c99c1d81036399bedb66a',
      },
      {
        version: 4,
        renderSha: 'c47009016178fc29c34440e06636ba7b21c6beb59202dd3fe63e365cb32a75cf',
      },
    ],
    role: 'reviewer',
    purpose: 'Judge whole-plan completion and decide whether Neal should accept completion, continue execution, or block for operator input.',
    requiredContext: COMPLETION_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildFinalCompletionReviewerSchema',
      parser: 'parseFinalCompletionReviewerPayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/specialized.ts',
      exportName: 'buildFinalCompletionReviewerPrompt',
      inputShape: context('BuildFinalCompletionReviewerPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan.'),
        field('packet', 'orchestrator_state', true, 'Whole-plan completion packet.'),
        field('summary', 'review_history', true, 'Coder-authored completion summary.'),
        field('scratchDir', 'run_artifact', true, 'Run-local scratch directory for final-completion reviewer artifacts.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the reviewer prompt requires shared adversarial doctrine, aggregate range context, and one of the three structured completion actions.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Final completion review is plan-review-adjacent in the later adjudicator design, but prompt ownership remains separate from transition semantics.',
    ],
    variants: [
      {
        kind: 'final_completion',
        status: 'migration_target',
        description: 'Whole-plan final completion review round.',
        currentRoundEntrypoints: ['runReviewerFinalCompletionRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/specialized.ts',
          exportName: 'buildFinalCompletionReviewerPrompt',
          inputShape: context('BuildFinalCompletionReviewerPromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan.'),
            field('packet', 'orchestrator_state', true, 'Whole-plan completion packet.'),
            field('summary', 'review_history', true, 'Coder-authored completion summary.'),
            field('scratchDir', 'run_artifact', true, 'Run-local scratch directory for final-completion reviewer artifacts.'),
            field(
              'accessMode',
              'orchestrator_state',
              false,
              "Optional explicit doctrine access mode ('tool-access' or 'read-only'); defaults to 'tool-access' when absent.",
            ),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildFinalCompletionReviewerSchema',
          parser: 'parseFinalCompletionReviewerPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
  {
    id: 'consultant',
    version: 1,
    changelog: [
      {
        version: 1,
        renderSha: '42e41552be1e8cceb0596a26f09892e13cc31adf07e58479d939d289c8b469e3',
      },
    ],
    role: 'reviewer',
    purpose:
      'Triage a blocked Neal run entirely from Neal-inlined context and decide whether the block is an in-scope recoverable misunderstanding or a genuine wall that must escalate to a human.',
    requiredContext: CONSULTANT_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildConsultantSchema',
      parser: 'validateConsultantVerdictPayload',
      providerSurface: 'neal_json_block_protocol',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/agents/prompts.ts',
      exportName: 'buildConsultantPrompt',
      inputShape: context('BuildConsultantPromptArgs', [
        field('blockedReason', 'prompt_argument', true, 'Blocked reason string.'),
        field('inlineContext', 'repository_state', true, 'Neal-inlined adjudication context.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the consultant judges entirely from inlined context and its static instructions carry no repository-access phrasing.',
      'A golden render test pins the exact prompt bytes, including the ALL-CAPS emphasis lines.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'mixed',
    ownershipNotes: [
      'Prompt spec owns the consultant instructions and required context only; anti-thrash guarding, recovery routing, and verdict persistence stay in src/neal/adjudicator/ outside the prompt-spec library.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'adjacent',
        description: 'Read-only blocked-run adjudication round.',
        currentRoundEntrypoints: ['runConsultantRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/agents/prompts.ts',
          exportName: 'buildConsultantPrompt',
          inputShape: context('BuildConsultantPromptArgs', [
            field('blockedReason', 'prompt_argument', true, 'Blocked reason string.'),
            field('inlineContext', 'repository_state', true, 'Neal-inlined adjudication context.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildConsultantSchema',
          parser: 'validateConsultantVerdictPayload',
          providerSurface: 'neal_json_block_protocol',
        },
      },
    ],
  },
] as const;

// SHA-256 of `text` as lowercase hex. Used to pin the render matrix (via the
// changelog `renderSha`) and, in the render-integrity test, the builder-module
// source tripwire.
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Canonical, order-independent serialization of a render matrix. Each cell is a
// `{ key, render }` pair; cells are sorted by `key` and joined as
// `=== <key> ===\n<render>\n` blocks so the output is deterministic regardless
// of generation order and stays human-diffable in the versioned goldens.
export function serializeRenderMatrix(cells: readonly { key: string; render: string }[]): string {
  return [...cells]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((cell) => `=== ${cell.key} ===\n${cell.render}\n`)
    .join('');
}

// Structural validation of a spec's integer version and sha-anchored changelog.
// This is format/shape enforcement only; it does not compare the recorded
// `renderSha` against any live render (that is verifyRenderVersionContract's
// job) so it can run cheaply at module load for every spec.
export function validatePromptSpecVersioning(spec: Pick<PromptSpec, 'id' | 'version' | 'changelog'>): void {
  const { id, version, changelog } = spec;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Prompt spec ${id} version must be a safe integer >= 1, received ${String(version)}`);
  }
  if (changelog.length === 0) {
    throw new Error(`Prompt spec ${id} changelog must not be empty`);
  }
  let previousVersion = 0;
  for (const entry of changelog) {
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
      throw new Error(`Prompt spec ${id} changelog entry version must be a safe integer >= 1, received ${String(entry.version)}`);
    }
    if (entry.version <= previousVersion) {
      throw new Error(
        `Prompt spec ${id} changelog entry versions must be strictly increasing, received ${entry.version} after ${previousVersion}`,
      );
    }
    previousVersion = entry.version;
    if (!/^[0-9a-f]{64}$/.test(entry.renderSha)) {
      throw new Error(`Prompt spec ${id} changelog entry renderSha must be 64-char lowercase hex, received ${entry.renderSha}`);
    }
  }
  const last = changelog[changelog.length - 1];
  if (last.version !== version) {
    throw new Error(`Prompt spec ${id} last changelog entry version ${last.version} must equal spec version ${version}`);
  }
}

// Internal-consistency and change-visibility contract over a spec's live render
// matrix and its versioned goldens. Throws when the last changelog entry does
// not match the spec version, when the live matrix sha does not match the last
// recorded `renderSha`, or when any changelog entry's golden is missing or does
// not hash to its recorded `renderSha`. This is not tamper evidence: an author
// who edits the live render, the golden, and the recorded sha together produces
// an internally consistent state that passes here; catching that coordinated
// same-version repin is the documented review/CI append-only rule, not this
// unit contract.
export function verifyRenderVersionContract(args: {
  specId: PromptSpecId;
  version: number;
  changelog: readonly PromptSpecChangelogEntry[];
  liveMatrix: string;
  readGolden: (version: number) => string | undefined;
}): void {
  const { specId, version, changelog, liveMatrix, readGolden } = args;
  const last = changelog[changelog.length - 1];
  if (!last || last.version !== version) {
    throw new Error(
      `Prompt spec ${specId} last changelog entry version ${String(last?.version)} must equal spec version ${version}`,
    );
  }
  const liveSha = sha256Hex(liveMatrix);
  if (liveSha !== last.renderSha) {
    throw new Error(
      `Prompt spec ${specId} live render matrix sha ${liveSha} does not match recorded renderSha ${last.renderSha} for version ${version}. ` +
        'The render changed: re-audit the builder axes, bump the version, add a new versioned golden, and re-pin the recorded renderSha.',
    );
  }
  for (const entry of changelog) {
    const golden = readGolden(entry.version);
    if (golden === undefined) {
      throw new Error(`Prompt spec ${specId} is missing the versioned golden for version ${entry.version}`);
    }
    const goldenSha = sha256Hex(golden);
    if (goldenSha !== entry.renderSha) {
      throw new Error(
        `Prompt spec ${specId} golden for version ${entry.version} sha ${goldenSha} does not match recorded renderSha ${entry.renderSha}`,
      );
    }
  }
}

function getContractFieldKeys(contract: PromptContextContract): Set<string> {
  return new Set(contract.fields.map((field) => field.key));
}

function validateBuilderInputShape(spec: PromptSpec, builder: PromptBuilderContract, label: string) {
  const allowedKeys = getContractFieldKeys(spec.requiredContext);
  const extraKeys = builder.inputShape.fields.map((field) => field.key).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    throw new Error(
      `Prompt spec ${spec.id} ${label} references builder context keys missing from requiredContext: ${extraKeys.join(', ')}`,
    );
  }
}

function validatePromptSpecContracts(specs: readonly PromptSpec[]) {
  for (const spec of specs) {
    validatePromptSpecVersioning(spec);
    validateBuilderInputShape(spec, spec.baseInstructions, 'baseInstructions');
    for (const variant of spec.variants) {
      validateBuilderInputShape(spec, variant.baseInstructions, `variant ${variant.kind}/${variant.baseInstructions.exportName}`);
    }
  }
}

validatePromptSpecContracts(PROMPT_SPECS);

const PROMPT_SPEC_MAP = new Map<PromptSpecId, PromptSpec>(PROMPT_SPECS.map((spec) => [spec.id, spec]));

export function getPromptSpec(id: PromptSpecId): PromptSpec {
  const spec = PROMPT_SPEC_MAP.get(id);
  if (!spec) {
    throw new Error(`Unknown prompt spec: ${id}`);
  }
  return spec;
}
