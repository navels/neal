import type { OrchestrationPhase } from './types.js';
import {
  EXECUTE_FINALIZATION_PHASE,
  EXECUTE_FINALIZATION_PUBLIC_LABEL,
} from './execute-finalization.js';

const PUBLIC_PHASE_LABELS = {
  coder_plan: 'refining plan',
  reviewer_plan: 'reviewing plan',
  coder_plan_response: 'revising plan',
  coder_plan_optional_response: 'optional plan revision',
  awaiting_derived_plan_execution: 'ready to execute derived plan',
  coder_scope: 'implementing current scope',
  manual_gate: 'waiting for manual gate',
  reviewer_scope: 'reviewing current scope',
  coder_response: 'addressing review findings',
  coder_optional_response: 'optional review follow-up',
  interactive_blocked_recovery: 'waiting for recovery guidance',
  [EXECUTE_FINALIZATION_PHASE]: EXECUTE_FINALIZATION_PUBLIC_LABEL,
  final_completion_review: 'reviewing final completion',
  done: 'done',
  blocked: 'blocked',
} as const satisfies Record<OrchestrationPhase, string>;

export function formatPublicPhase(phase: OrchestrationPhase) {
  return PUBLIC_PHASE_LABELS[phase];
}

export function formatMaybePublicPhase(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  return value in PUBLIC_PHASE_LABELS ? PUBLIC_PHASE_LABELS[value as OrchestrationPhase] : value;
}
