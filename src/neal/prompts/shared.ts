import {
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
} from '../agents/schemas.js';

export const AUTONOMY_SCOPE_DONE = 'AUTONOMY_SCOPE_DONE';
export const AUTONOMY_CHUNK_DONE = 'AUTONOMY_CHUNK_DONE';
export const AUTONOMY_DONE = 'AUTONOMY_DONE';
export const AUTONOMY_BLOCKED = 'AUTONOMY_BLOCKED';
export const AUTONOMY_SPLIT_PLAN = 'AUTONOMY_SPLIT_PLAN';

export function getCanonicalPlanContractLines() {
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

export function buildProgressSection(progressText: string) {
  return progressText.trim() || '(no current progress summary available)';
}

export function getExecuteScopeProgressPayloadContractLines() {
  return [
    `Include exactly one progress-justification JSON payload between ${EXECUTE_SCOPE_PROGRESS_PAYLOAD_START} and ${EXECUTE_SCOPE_PROGRESS_PAYLOAD_END}.`,
    'That JSON payload must contain non-empty string fields for `milestoneTargeted`, `newEvidence`, `whyNotRedundant`, and `nextStepUnlocked`.',
    'Keep any prose explanation or derived plan body outside that payload block.',
  ];
}
