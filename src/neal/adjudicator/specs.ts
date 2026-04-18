import type { PromptSpecRole, PromptSpecVariantKind, PromptSpecId } from '../prompts/specs.js';
import { getPromptSpec } from '../prompts/specs.js';

export type AdjudicationSpecId =
  | 'plan_review'
  | 'derived_plan_review'
  | 'execute_review'
  | 'recovery_plan_review'
  | 'final_completion_review';

export type AdjudicationSpecStatus = 'in_scope_v1' | 'adjacent_v1' | 'single_coder_adjacent_v1';
export type AdjudicationRoundLabel = 'plan-review' | 'review' | 'final-completion';
export type AdjudicationProtocol = 'structured_json' | 'terminal_marker';
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
  | 'adopt_recovery_plan'
  | 'leave_adjacent';

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
  | 'buildCoderResponseSchema'
  | 'buildCoderPlanResponseSchema'
  | 'buildFinalCompletionSummarySchema'
  | 'buildFinalCompletionReviewerSchema';

type ParserSurfaceName =
  | 'extractMarker'
  | 'parseExecuteScopeProgressPayload'
  | 'parseCoderResponsePayload'
  | 'PlanReviewerPayload'
  | 'ReviewerPayload'
  | 'parseFinalCompletionSummaryPayload'
  | 'parseFinalCompletionReviewerPayload';

type ProviderSurfaceName = 'outputSchema' | 'structured_advisor_schema';

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

export type TerminalOutputSurface = {
  protocol: 'terminal_marker';
  markerParser: 'extractMarker';
  markers: readonly string[];
  companionParser?: ParserSurfaceName;
};

export type OutputSurface = StructuredOutputSurface | TerminalOutputSurface;

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
  successCondition: string;
};

export type AdjudicationAdjacentFlow = {
  id: 'consult_review' | 'interactive_blocked_recovery' | 'diagnostic_analysis' | 'recovery_plan_authoring';
  status: Exclude<AdjudicationSpecStatus, 'in_scope_v1'>;
  currentEntrypoints: readonly string[];
  reason: string;
  futureRelationship: string;
};

const TERMINAL_SCOPE_MARKERS = ['AUTONOMY_SCOPE_DONE', 'AUTONOMY_DONE', 'AUTONOMY_BLOCKED', 'AUTONOMY_SPLIT_PLAN'] as const;

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
          protocol: 'terminal_marker',
          markerParser: 'extractMarker',
          markers: ['AUTONOMY_DONE', 'AUTONOMY_BLOCKED'],
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
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
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
      blockedWhen: 'Coder returns AUTONOMY_BLOCKED instead of a revised plan.',
    },
    transitionSignals: ['accept_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
    successCondition: 'Ordinary --plan review can settle without bespoke loop wiring outside the adjudicator family.',
  },
  {
    id: 'derived_plan_review',
    family: 'plan_review',
    status: 'in_scope_v1',
    roundLabel: 'plan-review',
    currentEntrypoints: ['runCoderPlanRound(derived)', 'runPlanReviewerRound(mode=derived-plan)', 'runCoderPlanResponseRound(reviewMode=derived-plan)'],
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
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
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
          protocol: 'terminal_marker',
          markerParser: 'extractMarker',
          markers: TERMINAL_SCOPE_MARKERS,
          companionParser: 'parseExecuteScopeProgressPayload',
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
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
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
      settledWhen: 'Reviewer returns no blocking findings and meaningfulProgressAction === accept.',
      reviseWhen: 'Findings reopen coder_response or coder_optional_response without changing execute-scope transition semantics.',
      blockedWhen: 'Reviewer returns block_for_operator or replace_plan, or coder blocks/splits the scope.',
    },
    transitionSignals: ['accept_scope', 'request_revision', 'optional_revision', 'block_for_operator', 'replace_plan'],
    successCondition: 'Ordinary execute review and meaningful-progress gating share one adjudication spec family rather than branching by phase.',
  },
  {
    id: 'recovery_plan_review',
    family: 'plan_review',
    status: 'in_scope_v1',
    roundLabel: 'plan-review',
    currentEntrypoints: ['runPlanReviewerRound(mode=recovery-plan)', 'runCoderPlanResponseRound(reviewMode=recovery-plan)'],
    artifactUnderReview: 'Diagnostic recovery plan candidate anchored to the active execute run.',
    contextAssembly: {
      owner: 'orchestrator',
      inputs: ['recoveryPlanPath', 'parentPlanDoc', 'recoveryParentScopeLabel', 'reviewMarkdownPath'],
      notes: 'Only the review sub-flow belongs in the adjudicator; diagnostic analysis and recovery-plan authoring remain adjacent single-coder flows.',
    },
    coder: {
      primary: {
        prompt: {
          role: 'coder',
          promptSpecId: 'recovery_plan_author',
          variantKind: 'response',
          exportName: 'buildCoderPlanResponsePrompt',
        },
        output: {
          protocol: 'structured_json',
          schemaBuilder: 'buildCoderPlanResponseSchema',
          parser: 'parseCoderResponsePayload',
          providerSurface: 'outputSchema',
        },
      },
      response: null,
    },
    reviewer: {
      prompt: {
        role: 'reviewer',
        promptSpecId: 'recovery_plan_reviewer',
        variantKind: 'recovery_plan',
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
      settledWhen: 'Recovery-plan review returns no open findings and the artifact is safe for operator adoption.',
      reviseWhen: 'Open findings route to the same coder plan-response machinery as other planning-family reviews.',
      blockedWhen: 'Coder blocks or the recovery plan remains adoption-unsafe.',
    },
    transitionSignals: ['adopt_recovery_plan', 'request_revision', 'optional_revision', 'block_for_operator'],
    successCondition: 'Diagnostic-recovery plan review reuses planning-family adjudication without flattening recovery-state semantics.',
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
    successCondition: 'Whole-plan completion review uses the shared adjudication model without hiding execute-mode completion semantics.',
  },
] as const;

export const ADJUDICATION_ADJACENT_FLOWS: readonly AdjudicationAdjacentFlow[] = [
  {
    id: 'consult_review',
    status: 'adjacent_v1',
    currentEntrypoints: ['runConsultReviewerRound', 'runCoderConsultResponseRound'],
    reason: 'Consult loops are adjacent prompt surfaces today and were explicitly left outside the first adjudicator extraction.',
    futureRelationship: 'Revisit only if consult becomes a stable first-class adjudication family rather than auxiliary scope assistance.',
  },
  {
    id: 'interactive_blocked_recovery',
    status: 'adjacent_v1',
    currentEntrypoints: ['runInteractiveBlockedRecoveryPhase'],
    reason: 'Interactive blocked recovery mixes operator input, coder dispositions, and transition routing rather than a pure coder/reviewer adjudication loop.',
    futureRelationship: 'Keep adjacent until Neal decides to formalize operator-in-the-loop adjudication as its own family.',
  },
  {
    id: 'diagnostic_analysis',
    status: 'single_coder_adjacent_v1',
    currentEntrypoints: ['runDiagnosticAnalysisRound'],
    reason: 'Diagnostic analysis is a single-coder authoring round with no reviewer-side revision loop to share.',
    futureRelationship: 'Remain a dedicated transition unless diagnostic analysis gains a real reviewer loop later.',
  },
  {
    id: 'recovery_plan_authoring',
    status: 'single_coder_adjacent_v1',
    currentEntrypoints: ['runRecoveryPlanRound'],
    reason: 'Recovery-plan authoring is a single-coder artifact-generation step that feeds recovery-plan review but is not itself an adjudication loop.',
    futureRelationship: 'Keep adjacent while recovery-plan review reuses planning-family adjudication.',
  },
] as const;

const STRUCTURED_SCHEMA_BUILDERS = new Set<SchemaBuilderName>([
  'buildReviewerSchema',
  'buildPlanReviewerSchema',
  'buildCoderResponseSchema',
  'buildCoderPlanResponseSchema',
  'buildFinalCompletionSummarySchema',
  'buildFinalCompletionReviewerSchema',
]);

const PARSER_SURFACES = new Set<ParserSurfaceName>([
  'extractMarker',
  'parseExecuteScopeProgressPayload',
  'parseCoderResponsePayload',
  'PlanReviewerPayload',
  'ReviewerPayload',
  'parseFinalCompletionSummaryPayload',
  'parseFinalCompletionReviewerPayload',
]);

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
  if (surface.protocol === 'structured_json') {
    if (!STRUCTURED_SCHEMA_BUILDERS.has(surface.schemaBuilder)) {
      throw new Error(`Adjudication spec ${specId} ${label} references unknown schema builder ${surface.schemaBuilder}.`);
    }
    if (!PARSER_SURFACES.has(surface.parser)) {
      throw new Error(`Adjudication spec ${specId} ${label} references unknown parser ${surface.parser}.`);
    }
    return;
  }

  if (!PARSER_SURFACES.has(surface.markerParser)) {
    throw new Error(`Adjudication spec ${specId} ${label} references unknown marker parser ${surface.markerParser}.`);
  }
  if (surface.companionParser && !PARSER_SURFACES.has(surface.companionParser)) {
    throw new Error(`Adjudication spec ${specId} ${label} references unknown companion parser ${surface.companionParser}.`);
  }
  if (surface.markers.length === 0) {
    throw new Error(`Adjudication spec ${specId} ${label} must declare at least one terminal marker.`);
  }
}

function validateAdjudicationSpecContracts(specs: readonly AdjudicationSpec[]) {
  for (const spec of specs) {
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
  }
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
