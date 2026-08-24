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
    'Choose exactly one execution shape: `one_shot`, `multi_scope`, or `multi_scope_unknown`.',
    'Declare that choice in the plan document with a literal `## Execution Shape` section followed by exactly one line: `executionShape: one_shot`, `executionShape: multi_scope`, or `executionShape: multi_scope_unknown`.',
    'If the plan should complete in one scope, declare `executionShape: one_shot` and keep the plan single-scope.',
    'If the plan requires multiple scopes, declare `executionShape: multi_scope` and make scope selection and completion rules explicit.',
    'If the plan requires one bounded recurring scope at a time but the total number of scopes is intentionally unknown at authoring time, declare `executionShape: multi_scope_unknown` and use one recurring scope template plus an explicit completion condition.',
    'Shape-specific section rules are mandatory:',
    '`executionShape: one_shot` must not include a literal `## Execution Queue` section, literal `## Execution Loop` section, or standalone `## Completion Condition` section.',
    '`executionShape: multi_scope` must include a literal `## Execution Queue` section and must not include a literal `## Execution Loop` section or standalone `## Completion Condition` section.',
    '`executionShape: multi_scope_unknown` must include a literal `## Execution Loop` section and standalone `## Completion Condition` section and must not include a literal `## Execution Queue` section.',
    'For `multi_scope` plans, include a literal `## Execution Queue` section.',
    'Inside `## Execution Queue`, use literal `### Scope N:` headings with contiguous numbering starting at 1.',
    'Each `### Scope N:` entry must include these labeled bullets: `- Goal:`, `- Verification:`, and `- Success Condition:`.',
    'For `multi_scope_unknown` plans, include a literal `## Execution Loop` section containing exactly one literal `### Recurring Scope` entry with `- Goal:`, `- Verification:`, and `- Success Condition:` bullets, followed by a literal `## Completion Condition` section.',
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
    'Minimal accepted multi-scope-unknown recurring shape:',
    '```md',
    '## Execution Shape',
    '',
    'executionShape: multi_scope_unknown',
    '',
    '## Execution Loop',
    '',
    '### Recurring Scope',
    '- Goal: Implement one bounded recurring slice.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The recurring slice is complete and reviewable.',
    '',
    '## Completion Condition',
    '',
    'Stop when the explicit plan-completion condition is satisfied.',
    '```',
  ];
}

export function getDerivedPlanSectionContractLines() {
  return [
    'For a derived plan, choose the declared execution shape first, then include only the orchestration sections valid for that shape.',
    'A `multi_scope` derived plan must not include a standalone `## Completion Condition` section; that section is valid only for `multi_scope_unknown` derived plans.',
  ];
}

export function getTerminalMarkerArtifactBoundaryLines() {
  return [
    'Protocol markers are terminal-response control signals, not artifact content.',
    `Never write ${AUTONOMY_DONE}, ${AUTONOMY_BLOCKED}, ${AUTONOMY_SCOPE_DONE}, or ${AUTONOMY_SPLIT_PLAN} into any authored markdown or JSON artifact unless the file is explicitly about Neal protocol markers.`,
    'Finish writing the artifact body first, stop editing files, and then emit exactly one terminal marker only in your final terminal response.',
    'Bad example: appending a marker line to the plan or recovery artifact itself.',
    'Good example: leave the file content marker-free, then output the marker as the final line of your terminal response.',
  ];
}

export function getProtocolMarkerArtifactProhibitionLines() {
  return [
    'Protocol markers are terminal-response control signals, not artifact content.',
    `Never write ${AUTONOMY_DONE}, ${AUTONOMY_BLOCKED}, ${AUTONOMY_SCOPE_DONE}, or ${AUTONOMY_SPLIT_PLAN} into any authored markdown or JSON artifact unless the file is explicitly about Neal protocol markers.`,
    'Bad example: appending a marker line to the plan or recovery artifact itself.',
    'Good example: leave the file content marker-free.',
  ];
}

export function getStandalonePlanPayloadSourceOfTruthLines(args: {
  planLabel: string;
  payloadLabel: string;
  resetWorkLabel: string;
}) {
  return [
    `The ${args.payloadLabel} is the source of truth for derived-plan review and must contain a complete standalone ${args.planLabel} body.`,
    `Do not commit the ${args.planLabel} to the target repository as the source of truth; repo-local notes may help while drafting, but the returned ${args.payloadLabel} must carry the full plan.`,
    'Do not return only a file path, commit SHA, branch name, reflog entry, PR link, external artifact, or a statement that another file was committed.',
    `${args.resetWorkLabel} may be reset before derived-plan review begins, so anything needed to execute the replacement plan must be inside the returned ${args.payloadLabel}.`,
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
