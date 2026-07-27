import type { PromptSpecRole, PromptSpecVariantKind, PromptSpecId } from '../prompts/specs.js';
import { getPromptSpec } from '../prompts/specs.js';
import type { AdjudicatedLoopContract } from './contracts.js';
import { validateAdjudicatedLoopContract } from './contracts.js';

export type AdjudicationSpecId =
  | 'plan_review'
  | 'derived_plan_review'
  | 'execute_review'
  | 'final_completion_review';

export type AdjudicationSpecStatus = 'in_scope_v1' | 'adjacent_v1';
export type AdjudicationRoundLabel = 'plan-review' | 'review' | 'final-completion';
export type AdjudicationTransitionSignal =
  | 'accept_plan'
  | 'accept_derived_plan'
  | 'accept_scope'
  | 'accept_complete'
  | 'request_revision'
  | 'optional_revision'
  | 'continue_execution'
  | 'block_for_operator'
  | 'replace_plan'
  | 'advance_parent'
  | 'leave_adjacent';

type AdjudicationFamily = AdjudicationSpec['family'];

type PromptBuilderExportName =
  | 'buildPlanningPrompt'
  | 'buildCoderPlanResponsePrompt'
  | 'buildScopePrompt'
  | 'buildCoderResponsePrompt'
  | 'buildPlanReviewerPrompt'
  | 'buildReviewerPrompt'
  | 'buildFinalCompletionSummaryPrompt'
  | 'buildFinalCompletionReviewerPrompt';

type SchemaBuilderName =
  | 'buildReviewerSchema'
  | 'buildPlanReviewerSchema'
  | 'buildCoderPlanSchema'
  | 'buildCoderScopeSchema'
  | 'buildCoderResponseSchema'
  | 'buildCoderPlanResponseSchema'
  | 'buildFinalCompletionSummarySchema'
  | 'buildFinalCompletionReviewerSchema';

type ParserSurfaceName =
  | 'validateCoderPlanPayload'
  | 'validateCoderPlanResponsePayload'
  | 'validateCoderScopePayload'
  | 'validateCoderResponsePayload'
  | 'PlanReviewerPayload'
  | 'ReviewerPayload'
  | 'parseFinalCompletionSummaryPayload'
  | 'parseFinalCompletionReviewerPayload';

type ProviderSurfaceName = 'coder_structured_schema' | 'structured_advisor_schema';

export type PromptSurfaceReference = {
  role: PromptSpecRole;
  promptSpecId: PromptSpecId;
  variantKind: PromptSpecVariantKind;
  exportName: PromptBuilderExportName;
};

export type StructuredOutputSurface = {
  protocol: 'structured_json';
  schemaBuilder: SchemaBuilderName;
  parser: ParserSurfaceName;
  providerSurface: ProviderSurfaceName;
};

export type OutputSurface = StructuredOutputSurface;

export type AdjudicationConvergenceRule = {
  settledWhen: string;
  reviseWhen: string;
  blockedWhen?: string;
};

export type AdjudicationSpec = {
  id: AdjudicationSpecId;
  family: 'plan_review' | 'execute_review' | 'final_completion';
  status: Extract<AdjudicationSpecStatus, 'in_scope_v1'>;
  roundLabel: AdjudicationRoundLabel;
  currentEntrypoints: readonly string[];
  artifactUnderReview: string;
  contextAssembly: {
    owner: 'orchestrator' | 'review_artifact' | 'final_completion_packet';
    inputs: readonly string[];
    notes: string;
  };
  coder: {
    primary: {
      prompt: PromptSurfaceReference;
      output: OutputSurface;
    };
    response?: {
      prompt: PromptSurfaceReference;
      output: StructuredOutputSurface;
    } | null;
  };
  reviewer: {
    prompt: PromptSurfaceReference;
    output: StructuredOutputSurface;
    capabilities?: readonly PromptSurfaceReference[];
  };
  convergence: AdjudicationConvergenceRule;
  transitionSignals: readonly AdjudicationTransitionSignal[];
  loopContract: AdjudicatedLoopContract;
  successCondition: string;
};

export type AdjudicationAdjacentFlow = {
  id: 'interactive_blocked_recovery';
  status: Exclude<AdjudicationSpecStatus, 'in_scope_v1'>;
  currentEntrypoints: readonly string[];
  reason: string;
  futureRelationship: string;
};

const FAMILY_RUNTIME_TRANSITION_SIGNALS = {
  plan_review: ['accept_plan', 'accept_derived_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
  execute_review: ['accept_scope', 'request_revision', 'optional_revision', 'block_for_operator', 'replace_plan', 'advance_parent'],
  final_completion: ['accept_complete', 'continue_execution', 'block_for_operator'],
} as const satisfies Record<AdjudicationFamily, readonly AdjudicationTransitionSignal[]>;

const SPEC_RUNTIME_TRANSITION_SIGNALS = {
  plan_review: ['accept_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
  derived_plan_review: ['accept_derived_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
  execute_review: ['accept_scope', 'request_revision', 'optional_revision', 'block_for_operator', 'replace_plan', 'advance_parent'],
  final_completion_review: ['accept_complete', 'continue_execution', 'block_for_operator'],
} as const satisfies Record<AdjudicationSpecId, readonly AdjudicationTransitionSignal[]>;

export const ADJUDICATION_SPECS: readonly AdjudicationSpec[] = [
  {
    id: 'plan_review',
    family: 'plan_review',
    status: 'in_scope_v1',
    roundLabel: 'plan-review',
    currentEntrypoints: ['runCoderPlanRound', 'runPlanReviewerRound', 'runCoderPlanResponseRound(reviewMode=plan)'],
    artifactUnderReview: 'Top-level Neal-executable plan markdown.',
    contextAssembly: {
      owner: 'orchestrator',
      inputs: ['planDoc', 'reviewMarkdownPath', 'openFindings', 'repositoryState'],
      notes: 'Ordinary plan review keeps execution-shape validation and review history in the existing plan-review artifacts.',
    },
    coder: {
      primary: {
        prompt: {
          role: 'coder',
          promptSpecId: 'plan_author',
          variantKind: 'primary',
          exportName: 'buildPlanningPrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildCoderPlanSchema',
          parser: 'validateCoderPlanPayload',
          providerSurface: 'coder_structured_schema',
        },
      },
      response: {
        prompt: {
          role: 'coder',
          promptSpecId: 'plan_author',
          variantKind: 'response',
          exportName: 'buildCoderPlanResponsePrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildCoderPlanResponseSchema',
          parser: 'validateCoderPlanResponsePayload',
          providerSurface: 'coder_structured_schema',
        },
      },
    },
    reviewer: {
      prompt: {
        role: 'reviewer',
        promptSpecId: 'plan_reviewer',
        variantKind: 'primary',
        exportName: 'buildPlanReviewerPrompt',
      },
      output: {
        protocol: 'structured_json',
        schemaBuilder: 'buildPlanReviewerSchema',
        parser: 'PlanReviewerPayload',
        providerSurface: 'structured_advisor_schema',
      },
    },
    convergence: {
      settledWhen: 'Reviewer returns no open findings and the plan remains structurally valid.',
      reviseWhen: 'Open findings route back to a required or optional coder plan-response round.',
      blockedWhen:
        'Coder returns structured action=blocked instead of a revised plan; round code still renders compatibility markers for downstream state.',
    },
    transitionSignals: ['accept_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
    loopContract: {
      loopKind: 'plan',
      sideEffectPolicy: 'plan_doc_only',
      allowedOutcomes: ['accepted', 'revise', 'blocked', 'failed', 'cap_reached'],
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
      roundCap: {
        source: 'state.maxRounds',
        appliesTo: 'review_iterations',
        outcomeWhenReached: 'cap_reached',
        notes: 'Plan refinement stops at the configured review-round cap and routes to operator blocking instead of accepting an unreviewed plan.',
      },
      terminalArtifact: {
        kind: 'plan_document',
        storage: 'state.planDoc',
        description: 'Accepted top-level Neal-executable plan markdown revised in place.',
      },
    },
    successCondition: 'Ordinary plan-mode review can settle without bespoke loop wiring outside the adjudicator family.',
  },
  {
    id: 'derived_plan_review',
    family: 'plan_review',
    status: 'in_scope_v1',
    roundLabel: 'plan-review',
    currentEntrypoints: ['runPlanReviewerRound(mode=derived-plan)', 'runCoderPlanResponseRound(reviewMode=derived-plan)'],
    artifactUnderReview: 'Derived replacement plan that targets one stale execute scope.',
    contextAssembly: {
      owner: 'orchestrator',
      inputs: ['derivedPlanPath', 'parentPlanDoc', 'derivedFromScopeNumber', 'reviewMarkdownPath'],
      notes: 'The loop mechanics match ordinary plan review while adoption semantics remain in the transition layer.',
    },
    coder: {
      primary: {
        prompt: {
          role: 'coder',
          promptSpecId: 'plan_author',
          variantKind: 'response',
          exportName: 'buildCoderPlanResponsePrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildCoderPlanResponseSchema',
          parser: 'validateCoderPlanResponsePayload',
          providerSurface: 'coder_structured_schema',
        },
      },
      response: null,
    },
    reviewer: {
      prompt: {
        role: 'reviewer',
        promptSpecId: 'plan_reviewer',
        variantKind: 'derived_plan',
        exportName: 'buildPlanReviewerPrompt',
      },
      output: {
        protocol: 'structured_json',
        schemaBuilder: 'buildPlanReviewerSchema',
        parser: 'PlanReviewerPayload',
        providerSurface: 'structured_advisor_schema',
      },
    },
    convergence: {
      settledWhen: 'Reviewer returns no open findings and the derived plan is safe to adopt.',
      reviseWhen: 'Derived-plan findings loop through the same plan-response path as ordinary plan review.',
      blockedWhen: 'Coder blocks or the derived plan remains structurally invalid.',
    },
    transitionSignals: ['accept_derived_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
    loopContract: {
      loopKind: 'plan',
      sideEffectPolicy: 'plan_doc_only',
      allowedOutcomes: ['accepted', 'revise', 'blocked', 'failed', 'cap_reached'],
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
      roundCap: {
        source: 'derivedPlan.counters.maxDerivedPlanReviewRounds',
        appliesTo: 'review_iterations',
        outcomeWhenReached: 'cap_reached',
        notes: 'Derived-plan review uses the derived-plan review cap and blocks rather than adopting an unresolved replacement plan.',
      },
      terminalArtifact: {
        kind: 'derived_plan_document',
        storage: 'state.derivedPlanPath',
        description: 'Accepted derived replacement plan for one stale execute scope.',
      },
    },
    successCondition: 'Derived-plan review shares planning-side adjudication mechanics while keeping replacement/adoption explicit.',
  },
  {
    id: 'execute_review',
    family: 'execute_review',
    status: 'in_scope_v1',
    roundLabel: 'review',
    currentEntrypoints: ['runCoderScopeRound', 'runReviewerRound', 'runCoderResponseRound'],
    artifactUnderReview: 'Execute-mode scope diff plus persisted meaningful-progress history for the active parent objective.',
    contextAssembly: {
      owner: 'review_artifact',
      inputs: ['planDoc', 'baseCommit', 'headCommit', 'changedFiles', 'reviewMarkdownPath', 'currentScopeProgressJustification', 'recentHistorySummary'],
      notes: 'Execute review is the only in-scope adjudication spec with meaningful-progress capability layered onto the reviewer prompt surface.',
    },
    coder: {
      primary: {
        prompt: {
          role: 'coder',
          promptSpecId: 'scope_coder',
          variantKind: 'primary',
          exportName: 'buildScopePrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildCoderScopeSchema',
          parser: 'validateCoderScopePayload',
          providerSurface: 'coder_structured_schema',
        },
      },
      response: {
        prompt: {
          role: 'coder',
          promptSpecId: 'scope_coder',
          variantKind: 'response',
          exportName: 'buildCoderResponsePrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildCoderResponseSchema',
          parser: 'validateCoderResponsePayload',
          providerSurface: 'coder_structured_schema',
        },
      },
    },
    reviewer: {
      prompt: {
        role: 'reviewer',
        promptSpecId: 'scope_reviewer',
        variantKind: 'primary',
        exportName: 'buildReviewerPrompt',
      },
      output: {
        protocol: 'structured_json',
        schemaBuilder: 'buildReviewerSchema',
        parser: 'ReviewerPayload',
        providerSurface: 'structured_advisor_schema',
      },
      capabilities: [
        {
          role: 'reviewer',
          promptSpecId: 'scope_reviewer',
          variantKind: 'meaningful_progress',
          exportName: 'buildReviewerPrompt',
        },
      ],
    },
    convergence: {
      settledWhen:
        'Reviewer returns no blocking findings and meaningfulProgressAction === accept, including top-level scopes already satisfied by prior accepted work; advance_parent is a distinct empty-derived-scope parent-advancement signal.',
      reviseWhen: 'Findings reopen coder_response or coder_optional_response without changing execute-scope transition semantics.',
      blockedWhen:
        'Reviewer returns block_for_operator, replace_plan, or an unsafe advance_parent, or coder returns structured action=blocked/split_plan; round code still renders compatibility markers for downstream state.',
    },
    transitionSignals: ['accept_scope', 'request_revision', 'optional_revision', 'block_for_operator', 'replace_plan', 'advance_parent'],
    loopContract: {
      loopKind: 'execute',
      sideEffectPolicy: 'code_changes',
      allowedOutcomes: ['accepted', 'revise', 'blocked', 'failed', 'cap_reached'],
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
      roundCap: {
        source: 'state.maxRounds',
        appliesTo: 'review_iterations',
        outcomeWhenReached: 'cap_reached',
        notes: 'Execute review stops at the configured review-round cap when blocking findings remain and records a blocked writer run.',
      },
      terminalArtifact: {
        kind: 'implementation_scope',
        storage: 'state.createdCommits plus state.reviewMarkdownPath',
        description: 'Accepted implementation scope commits and the corresponding scope-review artifact.',
      },
    },
    successCondition: 'Ordinary execute review and meaningful-progress gating share one adjudication spec family rather than branching by phase.',
  },
  {
    id: 'final_completion_review',
    family: 'final_completion',
    status: 'in_scope_v1',
    roundLabel: 'final-completion',
    currentEntrypoints: ['runCoderFinalCompletionSummaryRound', 'runReviewerFinalCompletionRound'],
    artifactUnderReview: 'Whole-plan completion packet assembled after the terminal execute scope settles.',
    contextAssembly: {
      owner: 'final_completion_packet',
      inputs: ['planDoc', 'FinalCompletionPacket', 'FinalCompletionSummary'],
      notes: 'Final completion review is plan-review-adjacent, but its accept/continue/block transitions stay outside the adjudicator.',
    },
    coder: {
      primary: {
        prompt: {
          role: 'coder',
          promptSpecId: 'completion_coder',
          variantKind: 'final_completion',
          exportName: 'buildFinalCompletionSummaryPrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildFinalCompletionSummarySchema',
          parser: 'parseFinalCompletionSummaryPayload',
          providerSurface: 'structured_advisor_schema',
        },
      },
      response: null,
    },
    reviewer: {
      prompt: {
        role: 'reviewer',
        promptSpecId: 'completion_reviewer',
        variantKind: 'final_completion',
        exportName: 'buildFinalCompletionReviewerPrompt',
      },
      output: {
        protocol: 'structured_json',
        schemaBuilder: 'buildFinalCompletionReviewerSchema',
        parser: 'parseFinalCompletionReviewerPayload',
        providerSurface: 'structured_advisor_schema',
      },
    },
    convergence: {
      settledWhen: 'Reviewer returns accept_complete, continue_execution, or block_for_operator for the whole plan.',
      reviseWhen: 'No coder-response loop exists in v1; continue_execution returns control to execute-mode transitions instead.',
      blockedWhen: 'Transition-layer continue_execution cap or explicit block_for_operator escalates to operator guidance.',
    },
    transitionSignals: ['accept_complete', 'continue_execution', 'block_for_operator'],
    loopContract: {
      loopKind: 'final_completion',
      sideEffectPolicy: 'code_changes',
      allowedOutcomes: ['accepted', 'revise', 'blocked', 'failed', 'cap_reached'],
      terminalOutcomes: ['accepted', 'blocked', 'failed', 'cap_reached'],
      roundCap: {
        source: 'state.finalCompletionContinueExecutionMax',
        appliesTo: 'continued_execution',
        outcomeWhenReached: 'cap_reached',
        notes: 'Final completion can reopen execution only up to its continue-execution cap before routing to operator blocking.',
      },
      terminalArtifact: {
        kind: 'final_completion_review',
        storage: 'FINAL_COMPLETION_REVIEW.md and state.finalCompletionReviewVerdict',
        description: 'Whole-plan final-completion review artifact and resolved reviewer verdict.',
      },
    },
    successCondition: 'Whole-plan completion review uses the shared adjudication model without hiding execute-mode completion semantics.',
  },
] as const;

export const ADJUDICATION_ADJACENT_FLOWS: readonly AdjudicationAdjacentFlow[] = [
  {
    id: 'interactive_blocked_recovery',
    status: 'adjacent_v1',
    currentEntrypoints: ['runInteractiveBlockedRecoveryPhase'],
    reason: 'Interactive blocked recovery mixes operator input, coder dispositions, and transition routing rather than a pure coder/reviewer adjudication loop.',
    futureRelationship: 'Keep adjacent until Neal decides to formalize operator-in-the-loop adjudication as its own family.',
  },
] as const;

const STRUCTURED_SCHEMA_BUILDERS = new Set<SchemaBuilderName>([
  'buildReviewerSchema',
  'buildPlanReviewerSchema',
  'buildCoderPlanSchema',
  'buildCoderScopeSchema',
  'buildCoderResponseSchema',
  'buildCoderPlanResponseSchema',
  'buildFinalCompletionSummarySchema',
  'buildFinalCompletionReviewerSchema',
]);

const PARSER_SURFACES = new Set<ParserSurfaceName>([
  'validateCoderPlanPayload',
  'validateCoderPlanResponsePayload',
  'validateCoderScopePayload',
  'validateCoderResponsePayload',
  'PlanReviewerPayload',
  'ReviewerPayload',
  'parseFinalCompletionSummaryPayload',
  'parseFinalCompletionReviewerPayload',
]);

const PROVIDER_SURFACES = new Set<ProviderSurfaceName>(['coder_structured_schema', 'structured_advisor_schema']);

function validatePromptSurfaceReference(specId: string, label: string, reference: PromptSurfaceReference) {
  const promptSpec = getPromptSpec(reference.promptSpecId);
  if (promptSpec.role !== reference.role) {
    throw new Error(
      `Adjudication spec ${specId} ${label} role mismatch: expected ${reference.role}, prompt spec ${reference.promptSpecId} is ${promptSpec.role}.`,
    );
  }

  const variant = promptSpec.variants.find(
    (candidate) => candidate.kind === reference.variantKind && candidate.baseInstructions.exportName === reference.exportName,
  );
  if (!variant) {
    throw new Error(
      `Adjudication spec ${specId} ${label} references missing prompt surface ${reference.promptSpecId}.${reference.variantKind}/${reference.exportName}.`,
    );
  }
}

function validateOutputSurface(specId: string, label: string, surface: OutputSurface) {
  const protocol = (surface as { protocol?: unknown }).protocol;
  if (protocol !== 'structured_json') {
    throw new Error(`Adjudication spec ${specId} ${label} references unsupported output protocol ${String(protocol)}.`);
  }
  if (!STRUCTURED_SCHEMA_BUILDERS.has(surface.schemaBuilder)) {
    throw new Error(`Adjudication spec ${specId} ${label} references unknown schema builder ${surface.schemaBuilder}.`);
  }
  if (!PARSER_SURFACES.has(surface.parser)) {
    throw new Error(`Adjudication spec ${specId} ${label} references unknown parser ${surface.parser}.`);
  }
  if (!PROVIDER_SURFACES.has(surface.providerSurface)) {
    throw new Error(`Adjudication spec ${specId} ${label} references unknown provider surface ${surface.providerSurface}.`);
  }
}

function validateTransitionSignals(spec: AdjudicationSpec) {
  const familySignals = new Set<AdjudicationTransitionSignal>(FAMILY_RUNTIME_TRANSITION_SIGNALS[spec.family]);
  const specSignals = new Set(spec.transitionSignals);
  const requiredSignals = SPEC_RUNTIME_TRANSITION_SIGNALS[spec.id];

  if (specSignals.size !== spec.transitionSignals.length) {
    throw new Error(`Adjudication spec ${spec.id} family ${spec.family} declares duplicate transition signals.`);
  }

  for (const signal of spec.transitionSignals) {
    if (!familySignals.has(signal)) {
      throw new Error(`Adjudication spec ${spec.id} family ${spec.family} declares impossible transition signal ${signal}.`);
    }
  }

  for (const signal of requiredSignals) {
    if (!specSignals.has(signal)) {
      throw new Error(`Adjudication spec ${spec.id} family ${spec.family} is missing runtime transition signal ${signal}.`);
    }
  }
}

function validateFamilyRuntimeCoverage(specs: readonly AdjudicationSpec[]) {
  const signalsByFamily = new Map<AdjudicationFamily, Set<AdjudicationTransitionSignal>>();
  for (const spec of specs) {
    const signals = signalsByFamily.get(spec.family) ?? new Set<AdjudicationTransitionSignal>();
    for (const signal of SPEC_RUNTIME_TRANSITION_SIGNALS[spec.id]) {
      signals.add(signal);
    }
    signalsByFamily.set(spec.family, signals);
  }

  for (const [family, allowedSignals] of Object.entries(FAMILY_RUNTIME_TRANSITION_SIGNALS) as [
    AdjudicationFamily,
    readonly AdjudicationTransitionSignal[],
  ][]) {
    const coveredSignals = signalsByFamily.get(family) ?? new Set<AdjudicationTransitionSignal>();
    for (const signal of allowedSignals) {
      if (!coveredSignals.has(signal)) {
        throw new Error(`Adjudication family ${family} is missing runtime transition coverage for signal ${signal}.`);
      }
    }
  }
}

export function validateAdjudicationSpecContracts(specs: readonly AdjudicationSpec[]) {
  for (const spec of specs) {
    validateAdjudicatedLoopContract(spec.id, spec.loopContract);

    validatePromptSurfaceReference(spec.id, 'coder.primary.prompt', spec.coder.primary.prompt);
    validateOutputSurface(spec.id, 'coder.primary.output', spec.coder.primary.output);

    if (spec.coder.response) {
      validatePromptSurfaceReference(spec.id, 'coder.response.prompt', spec.coder.response.prompt);
      validateOutputSurface(spec.id, 'coder.response.output', spec.coder.response.output);
    }

    validatePromptSurfaceReference(spec.id, 'reviewer.prompt', spec.reviewer.prompt);
    validateOutputSurface(spec.id, 'reviewer.output', spec.reviewer.output);
    for (const capability of spec.reviewer.capabilities ?? []) {
      validatePromptSurfaceReference(spec.id, 'reviewer.capability', capability);
    }

    validateTransitionSignals(spec);
  }

  validateFamilyRuntimeCoverage(specs);
}

validateAdjudicationSpecContracts(ADJUDICATION_SPECS);

const ADJUDICATION_SPEC_MAP = new Map<AdjudicationSpecId, AdjudicationSpec>(
  ADJUDICATION_SPECS.map((spec) => [spec.id, spec]),
);

export function getAdjudicationSpec(id: AdjudicationSpecId): AdjudicationSpec {
  const spec = ADJUDICATION_SPEC_MAP.get(id);
  if (!spec) {
    throw new Error(`Unknown adjudication spec: ${id}`);
  }
  return spec;
}

export function assertAdjudicationTransitionSignal(
  spec: AdjudicationSpec,
  signal: AdjudicationTransitionSignal,
  callerLabel: string,
) {
  if (spec.transitionSignals.includes(signal)) {
    return;
  }

  throw new Error(
    `${callerLabel} resolved transition signal ${signal} for adjudication spec ${spec.id} ` +
      `family ${spec.family}, but allowed signals are: ${spec.transitionSignals.join(', ')}.`,
  );
}

export function getReviewerCapability(
  spec: AdjudicationSpec,
  variantKind: PromptSpecVariantKind,
): PromptSurfaceReference {
  const capability = spec.reviewer.capabilities?.find((candidate) => candidate.variantKind === variantKind);
  if (!capability) {
    throw new Error(`Adjudication spec ${spec.id} reviewer is missing capability ${variantKind}.`);
  }
  return capability;
}
