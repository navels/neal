export type PromptSpecId =
  | 'plan_author'
  | 'plan_reviewer'
  | 'scope_coder'
  | 'scope_reviewer'
  | 'diagnostic_analyst'
  | 'recovery_plan_author'
  | 'recovery_plan_reviewer'
  | 'completion_coder'
  | 'completion_reviewer';

export type PromptSpecRole = 'coder' | 'reviewer';
export type PromptSpecVariantKind =
  | 'primary'
  | 'response'
  | 'meaningful_progress'
  | 'derived_plan'
  | 'recovery_plan'
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
      providerSurface: 'outputSchema' | 'structured_advisor_schema';
    }
  | {
      kind: 'terminal_marker';
      markerSource: 'plain_text_final_line';
      markers: readonly string[];
      parser: string | null;
    }
  | {
      kind: 'artifact_markdown';
      artifactKind: 'diagnostic_analysis' | 'recovery_plan';
      markerSource: 'plain_text_final_line';
      markers: readonly string[];
      parser: 'artifact_body_extractor';
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

export type PromptSpec = {
  id: PromptSpecId;
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
  field('mode', 'orchestrator_state', true, 'Plan review mode: ordinary plan, derived-plan, or recovery-plan.'),
  field('parentPlanDoc', 'prompt_argument', false, 'Path to the parent plan when reviewing a derived or recovery plan.'),
  field('derivedFromScopeNumber', 'orchestrator_state', false, 'Parent scope number when reviewing a derived plan.'),
  field('recoveryParentScopeLabel', 'orchestrator_state', false, 'Parent objective label when reviewing a recovery plan.'),
  field('repositoryState', 'repository_state', true, 'Current repository context and directly referenced companion docs.'),
]);

const SCOPE_CODER_CONTEXT = context('ScopeCoderPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
  field('progressText', 'run_artifact', true, 'Current Neal progress markdown used to keep the scope bounded.'),
  field('openFindings', 'review_history', false, 'Open reviewer findings when responding inside the same scope.'),
  field('verificationHint', 'orchestrator_state', false, 'Wrapper-provided verification guidance for reviewer-response rounds.'),
  field('operatorGuidance', 'operator_input', false, 'Interactive blocked-recovery guidance when the scope is waiting on operator input.'),
  field('consultMarkdownPath', 'run_artifact', false, 'Consult history artifact path for adjacent consult and blocked-recovery flows.'),
  field('request', 'review_history', false, 'Coder consult request payload for consult-response rounds.'),
  field('response', 'review_history', false, 'Reviewer consult response payload for consult-response rounds.'),
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
]);

const DIAGNOSTIC_ANALYST_CONTEXT = context('DiagnosticAnalysisPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
  field('progressText', 'run_artifact', true, 'Current Neal progress markdown for active-run context.'),
  field('question', 'operator_input', true, 'Operator diagnostic question that bounds the analysis.'),
  field('target', 'operator_input', true, 'Requested diagnostic target path or symbol.'),
  field('analysisArtifactPath', 'run_artifact', true, 'Artifact path where Neal will persist the diagnostic analysis.'),
  field('baselineRef', 'orchestrator_state', false, 'Read-only baseline ref used for comparison when needed.'),
  field('baselineSource', 'orchestrator_state', true, 'Why the selected baseline was chosen.'),
  field('blockedReason', 'orchestrator_state', false, 'Blocker context that triggered diagnostic recovery.'),
]);

const RECOVERY_PLAN_AUTHOR_CONTEXT = context('RecoveryPlanAuthorPromptContext', [
  field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
  field('progressText', 'run_artifact', true, 'Current Neal progress markdown for active-run context.'),
  field('question', 'operator_input', true, 'Operator diagnostic question that the recovery plan must answer.'),
  field('target', 'operator_input', true, 'Requested diagnostic target path or symbol.'),
  field('analysisArtifactPath', 'run_artifact', true, 'Diagnostic analysis artifact that must be read before planning.'),
  field('recoveryPlanPath', 'run_artifact', true, 'Artifact path where Neal will persist the candidate recovery plan.'),
  field('baselineRef', 'orchestrator_state', false, 'Read-only baseline ref carried through from diagnostic analysis.'),
  field('baselineSource', 'orchestrator_state', true, 'Why the selected baseline was chosen.'),
  field('openFindings', 'review_history', false, 'Open recovery-plan review findings when revising the candidate plan.'),
  field('recoveryParentScopeLabel', 'orchestrator_state', false, 'Parent objective label being replaced by the recovery plan.'),
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
  field('repositoryState', 'repository_state', true, 'Current repository state used to judge whole-plan completion.'),
]);

const TERMINAL_SCOPE_MARKERS = ['AUTONOMY_SCOPE_DONE', 'AUTONOMY_DONE', 'AUTONOMY_BLOCKED', 'AUTONOMY_SPLIT_PLAN'] as const;
const TERMINAL_PLAN_MARKERS = ['AUTONOMY_DONE', 'AUTONOMY_BLOCKED'] as const;

export const PROMPT_SPECS: readonly PromptSpec[] = [
  {
    id: 'plan_author',
    role: 'coder',
    purpose: 'Author or revise Neal-executable plans without leaking planning-task scaffolding into final artifacts.',
    requiredContext: PLAN_AUTHOR_CONTEXT,
    schemaTarget: {
      kind: 'terminal_marker',
      markerSource: 'plain_text_final_line',
      markers: TERMINAL_PLAN_MARKERS,
      parser: 'extractMarker',
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
          kind: 'terminal_marker',
          markerSource: 'plain_text_final_line',
          markers: TERMINAL_PLAN_MARKERS,
          parser: 'extractMarker',
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
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
        },
      },
    ],
  },
  {
    id: 'plan_reviewer',
    role: 'reviewer',
    purpose: 'Review Neal-executable plans for execution-shape correctness, verification concreteness, and resume safety.',
    requiredContext: PLAN_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildPlanReviewerSchema',
      parser: 'PlanReviewerPayload',
      providerSurface: 'structured_advisor_schema',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/planning.ts',
      exportName: 'buildPlanReviewerPrompt',
      inputShape: context('BuildPlanReviewerPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the plan artifact under review.'),
        field('round', 'orchestrator_state', true, 'Plan-review round number.'),
        field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact path.'),
        field('mode', 'orchestrator_state', false, 'Plan review mode for ordinary vs derived-plan vs recovery-plan review.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the reviewer prompt requires executionShape confirmation.',
      'Fixture cases should cover ordinary plans, derived plans, and recovery-plan candidates.',
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
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildPlanReviewerSchema',
          parser: 'PlanReviewerPayload',
          providerSurface: 'structured_advisor_schema',
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
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildPlanReviewerSchema',
          parser: 'PlanReviewerPayload',
          providerSurface: 'structured_advisor_schema',
        },
      },
    ],
  },
  {
    id: 'scope_coder',
    role: 'coder',
    purpose: 'Execute exactly one bounded implementation scope and respond to in-scope review feedback without starting new scopes.',
    requiredContext: SCOPE_CODER_CONTEXT,
    schemaTarget: {
      kind: 'terminal_marker',
      markerSource: 'plain_text_final_line',
      markers: TERMINAL_SCOPE_MARKERS,
      parser: 'parseExecuteScopeProgressPayload + extractMarker',
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
      'Render tests should assert progress-justification payload requirements and terminal marker rules.',
      'Future fixture cases should cover split-plan responses and response-round schema invariants.',
    ],
    firstMigrationPriority: 2,
    currentHome: 'mixed',
    ownershipNotes: [
      'Prompt spec owns execute-scope instructions, not state transitions, commit adoption, or blocked-recovery routing.',
      'Blocked recovery and consult response stay as capability variants rather than separate top-level role ids in v1.',
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
          kind: 'terminal_marker',
          markerSource: 'plain_text_final_line',
          markers: TERMINAL_SCOPE_MARKERS,
          parser: 'parseExecuteScopeProgressPayload + extractMarker',
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
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
        },
      },
      {
        kind: 'response',
        status: 'adjacent',
        description: 'Consult-response round after reviewer blocker consultation.',
        currentRoundEntrypoints: ['runCoderConsultResponseRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/agents/prompts.ts',
          exportName: 'buildCoderConsultResponsePrompt',
          inputShape: context('BuildCoderConsultResponsePromptArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
            field('progressText', 'run_artifact', true, 'Current Neal progress markdown.'),
            field('consultMarkdownPath', 'run_artifact', true, 'Consult history artifact path.'),
            field('request', 'review_history', true, 'Coder consultation request payload.'),
            field('response', 'review_history', true, 'Reviewer consultation response payload.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderConsultDispositionSchema',
          parser: 'parseCoderConsultDispositionPayload',
          providerSurface: 'outputSchema',
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
            field('consultMarkdownPath', 'run_artifact', true, 'Consult history artifact path.'),
            field('blockedReason', 'orchestrator_state', true, 'Current blocked reason.'),
            field('operatorGuidance', 'operator_input', true, 'Latest operator guidance.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderBlockedRecoveryDispositionSchema',
          parser: 'parseCoderBlockedRecoveryDispositionPayload',
          providerSurface: 'outputSchema',
        },
      },
    ],
  },
  {
    id: 'scope_reviewer',
    role: 'reviewer',
    purpose: 'Review execute-scope results for correctness, verification coverage, and meaningful progress toward the active parent objective.',
    requiredContext: SCOPE_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildReviewerSchema',
      parser: 'ReviewerPayload',
      providerSurface: 'structured_advisor_schema',
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
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert reviewer prompts include meaningful-progress instructions and parent-objective history.',
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
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildReviewerSchema',
          parser: 'ReviewerPayload',
          providerSurface: 'structured_advisor_schema',
        },
      },
      {
        kind: 'meaningful_progress',
        status: 'migration_target',
        description: 'Meaningful-progress capability layered onto execute review.',
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
          providerSurface: 'structured_advisor_schema',
        },
      },
    ],
  },
  {
    id: 'diagnostic_analyst',
    role: 'coder',
    purpose: 'Author the diagnostic analysis artifact that explains why the current execute run stopped converging.',
    requiredContext: DIAGNOSTIC_ANALYST_CONTEXT,
    schemaTarget: {
      kind: 'artifact_markdown',
      artifactKind: 'diagnostic_analysis',
      markerSource: 'plain_text_final_line',
      markers: TERMINAL_PLAN_MARKERS,
      parser: 'artifact_body_extractor',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/specialized.ts',
      exportName: 'buildDiagnosticAnalysisPrompt',
      inputShape: context('BuildDiagnosticAnalysisPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
        field('progressText', 'run_artifact', true, 'Current Neal progress markdown.'),
        field('question', 'operator_input', true, 'Operator diagnostic question.'),
        field('target', 'operator_input', true, 'Requested diagnostic target.'),
        field('analysisArtifactPath', 'run_artifact', true, 'Diagnostic analysis artifact path.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert read-only baseline guidance and required markdown headings.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Diagnostic analysis remains outside the later adjudicator loop according to plan 05.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'migration_target',
        description: 'Diagnostic analysis authoring round.',
        currentRoundEntrypoints: ['runDiagnosticAnalysisRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/specialized.ts',
          exportName: 'buildDiagnosticAnalysisPrompt',
          inputShape: context('BuildDiagnosticAnalysisPromptArgs', [
            field('question', 'operator_input', true, 'Operator diagnostic question.'),
            field('target', 'operator_input', true, 'Requested diagnostic target.'),
            field('analysisArtifactPath', 'run_artifact', true, 'Diagnostic analysis artifact path.'),
            field('baselineRef', 'orchestrator_state', false, 'Read-only baseline ref.'),
          ]),
        },
        schemaTarget: {
          kind: 'artifact_markdown',
          artifactKind: 'diagnostic_analysis',
          markerSource: 'plain_text_final_line',
          markers: TERMINAL_PLAN_MARKERS,
          parser: 'artifact_body_extractor',
        },
      },
    ],
  },
  {
    id: 'recovery_plan_author',
    role: 'coder',
    purpose: 'Turn a diagnostic analysis into a narrow Neal-executable recovery plan candidate.',
    requiredContext: RECOVERY_PLAN_AUTHOR_CONTEXT,
    schemaTarget: {
      kind: 'artifact_markdown',
      artifactKind: 'recovery_plan',
      markerSource: 'plain_text_final_line',
      markers: TERMINAL_PLAN_MARKERS,
      parser: 'artifact_body_extractor',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/specialized.ts',
      exportName: 'buildRecoveryPlanPrompt',
      inputShape: context('BuildRecoveryPlanPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the active execute-mode plan.'),
        field('analysisArtifactPath', 'run_artifact', true, 'Diagnostic analysis artifact path.'),
        field('recoveryPlanPath', 'run_artifact', true, 'Recovery plan artifact path.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert canonical Neal-executable plan sections remain required for recovery plans.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Recovery-plan authoring stays distinct from plan adoption and diagnostic recovery transitions.',
    ],
    variants: [
      {
        kind: 'primary',
        status: 'migration_target',
        description: 'Recovery-plan authoring round.',
        currentRoundEntrypoints: ['runRecoveryPlanRound'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/specialized.ts',
          exportName: 'buildRecoveryPlanPrompt',
          inputShape: context('BuildRecoveryPlanPromptArgs', [
            field('analysisArtifactPath', 'run_artifact', true, 'Diagnostic analysis artifact path.'),
            field('recoveryPlanPath', 'run_artifact', true, 'Recovery plan artifact path.'),
            field('question', 'operator_input', true, 'Operator diagnostic question.'),
            field('target', 'operator_input', true, 'Requested diagnostic target.'),
          ]),
        },
        schemaTarget: {
          kind: 'artifact_markdown',
          artifactKind: 'recovery_plan',
          markerSource: 'plain_text_final_line',
          markers: TERMINAL_PLAN_MARKERS,
          parser: 'artifact_body_extractor',
        },
      },
      {
        kind: 'response',
        status: 'migration_target',
        description: 'Recovery-plan revision round after recovery-plan review findings.',
        currentRoundEntrypoints: ['runCoderPlanResponseRound(reviewMode=recovery-plan)'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/planning.ts',
          exportName: 'buildCoderPlanResponsePrompt',
          inputShape: context('BuildCoderPlanResponseRecoveryArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the recovery plan artifact being revised.'),
            field('openFindings', 'review_history', true, 'Open recovery-plan review findings to address.'),
            field('recoveryParentScopeLabel', 'orchestrator_state', false, 'Parent objective label being replaced by the recovery plan.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildCoderPlanResponseSchema',
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
        },
      },
    ],
  },
  {
    id: 'recovery_plan_reviewer',
    role: 'reviewer',
    purpose: 'Review a diagnostic recovery plan candidate for adoption safety, narrowness, and Neal-executable structure.',
    requiredContext: PLAN_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildPlanReviewerSchema',
      parser: 'PlanReviewerPayload',
      providerSurface: 'structured_advisor_schema',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/planning.ts',
      exportName: 'buildPlanReviewerPrompt',
      inputShape: context('BuildPlanReviewerRecoveryArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the recovery plan candidate.'),
        field('parentPlanDoc', 'prompt_argument', false, 'Path to the active parent plan.'),
        field('recoveryParentScopeLabel', 'orchestrator_state', false, 'Parent objective being replaced.'),
        field('reviewMarkdownPath', 'run_artifact', true, 'Review history artifact path.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert recovery-plan review stays anchored to the active run and parent objective.',
    ],
    firstMigrationPriority: 3,
    currentHome: 'src/neal/prompts',
    ownershipNotes: [
      'Recovery-plan review should later reuse shared adjudicator machinery, but the prompt spec remains role-local.',
    ],
    variants: [
      {
        kind: 'recovery_plan',
        status: 'migration_target',
        description: 'Recovery-plan review round.',
        currentRoundEntrypoints: ['runPlanReviewerRound(mode=recovery-plan)'],
        baseInstructions: {
          kind: 'builder',
          modulePath: 'src/neal/prompts/planning.ts',
          exportName: 'buildPlanReviewerPrompt',
          inputShape: context('BuildPlanReviewerRecoveryArgs', [
            field('planDoc', 'prompt_argument', true, 'Path to the recovery plan candidate.'),
            field('parentPlanDoc', 'prompt_argument', false, 'Path to the active parent plan.'),
            field('recoveryParentScopeLabel', 'orchestrator_state', false, 'Parent objective being replaced.'),
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildPlanReviewerSchema',
          parser: 'PlanReviewerPayload',
          providerSurface: 'structured_advisor_schema',
        },
      },
    ],
  },
  {
    id: 'completion_coder',
    role: 'coder',
    purpose: 'Summarize whole-plan completion state in compact structured JSON.',
    requiredContext: COMPLETION_CODER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildFinalCompletionSummarySchema',
      parser: 'parseFinalCompletionSummaryPayload',
      providerSurface: 'structured_advisor_schema',
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
          providerSurface: 'structured_advisor_schema',
        },
      },
    ],
  },
  {
    id: 'completion_reviewer',
    role: 'reviewer',
    purpose: 'Judge whole-plan completion and decide whether Neal should accept completion, continue execution, or block for operator input.',
    requiredContext: COMPLETION_REVIEWER_CONTEXT,
    schemaTarget: {
      kind: 'structured_json',
      schemaBuilder: 'buildFinalCompletionReviewerSchema',
      parser: 'parseFinalCompletionReviewerPayload',
      providerSurface: 'structured_advisor_schema',
    },
    baseInstructions: {
      kind: 'builder',
      modulePath: 'src/neal/prompts/specialized.ts',
      exportName: 'buildFinalCompletionReviewerPrompt',
      inputShape: context('BuildFinalCompletionReviewerPromptArgs', [
        field('planDoc', 'prompt_argument', true, 'Path to the execute-mode plan.'),
        field('packet', 'orchestrator_state', true, 'Whole-plan completion packet.'),
        field('summary', 'review_history', true, 'Coder-authored completion summary.'),
      ]),
    },
    providerVariants: SHARED_PROVIDER_VARIANTS,
    evaluationNotes: [
      'Render tests should assert the reviewer prompt requires one of the three structured completion actions.',
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
          ]),
        },
        schemaTarget: {
          kind: 'structured_json',
          schemaBuilder: 'buildFinalCompletionReviewerSchema',
          parser: 'parseFinalCompletionReviewerPayload',
          providerSurface: 'structured_advisor_schema',
        },
      },
    ],
  },
] as const;

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
