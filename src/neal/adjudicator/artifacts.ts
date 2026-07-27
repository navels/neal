import type { OrchestrationPhase, OrchestrationState } from '../types.js';
import { isExecuteFinalizationPhase } from '../execute-finalization.js';
import { renderAdjudicatedLoopContractLines } from './contracts.js';
import { resolveExecuteAdjudicationContext } from './execute.js';
import { resolvePlanningAdjudicationContext } from './planning.js';
import { getAdjudicationSpec, type AdjudicationSpec } from './specs.js';
import { hasFinalCompletionReviewState } from '../state-views.js';

export type ArtifactAdjudicationContract = {
  spec: AdjudicationSpec;
  sourcePhase: OrchestrationPhase;
};

function resolveArtifactPhase(state: OrchestrationState): OrchestrationPhase {
  if (hasFinalCompletionReviewState(state)) {
    return 'final_completion_review';
  }

  if (state.phase === 'blocked' && state.blockedFromPhase) {
    return state.blockedFromPhase;
  }

  return state.phase;
}

export function resolveArtifactAdjudicationContract(state: OrchestrationState): ArtifactAdjudicationContract | null {
  const sourcePhase = resolveArtifactPhase(state);

  if (
    sourcePhase === 'coder_plan' ||
    sourcePhase === 'reviewer_plan' ||
    sourcePhase === 'coder_plan_response' ||
    sourcePhase === 'coder_plan_optional_response'
  ) {
    return {
      spec: resolvePlanningAdjudicationContext(state).spec,
      sourcePhase,
    };
  }

  if (
    sourcePhase === 'coder_scope' ||
    sourcePhase === 'reviewer_scope' ||
    sourcePhase === 'coder_response' ||
    sourcePhase === 'coder_optional_response' ||
    isExecuteFinalizationPhase(sourcePhase)
  ) {
    return {
      spec: resolveExecuteAdjudicationContext(state).spec,
      sourcePhase,
    };
  }

  if (sourcePhase === 'final_completion_review') {
    return {
      spec: getAdjudicationSpec('final_completion_review'),
      sourcePhase,
    };
  }

  return null;
}

export function renderAdjudicationContractLines(state: OrchestrationState) {
  const contract = resolveArtifactAdjudicationContract(state);
  if (!contract) {
    return [];
  }

  return [
    '## Adjudication Contract',
    `- Adjudication spec id: ${contract.spec.id}`,
    `- Adjudication family: ${contract.spec.family}`,
    ...renderAdjudicatedLoopContractLines(contract.spec.loopContract),
    `- Allowed transition outcomes: ${contract.spec.transitionSignals.join(', ')}`,
    '- Contract role: validated allowed outcomes for debugging; runtime routing remains explicit elsewhere.',
  ];
}
