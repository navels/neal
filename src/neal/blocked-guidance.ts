import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { formatPublicPhase } from './phase-display.js';
import { getRunDisplayStatus } from './run-status.js';
import { getCurrentScopeLabel } from './scopes.js';
import { sanitizeSensitiveText } from './sensitive-text.js';
import { getPlanReviewGuidanceOriginPhase } from './state-views.js';
import { getRunStatePath } from './state.js';
import type { OrchestrationPhase, OrchestrationState } from './types.js';

export type BlockedGuidanceOption = {
  label: string;
  description: string;
  command: string;
};

export type BlockedGuidance = {
  summary: string;
  reason: string | null;
  scopeLabel: string | null;
  sourcePhase: OrchestrationPhase | null;
  category:
    | 'waiting_on_external_event'
    | 'missing_external_prerequisite'
    | 'scope_accounting_guardrail'
    | 'review_or_scope_criteria_mismatch'
    | 'plan_review_guidance'
    | 'unknown';
  technicalDetails: string[];
  evidenceBullets: string[];
  options: BlockedGuidanceOption[];
  artifactPaths: Array<{ label: string; path: string }>;
};

type BlockedGuidanceCategory = BlockedGuidance['category'];

const FALLBACK_REASON = 'Neal is waiting for operator guidance before it can continue.';
const PLAN_REVIEW_REASON = 'Plan review requires operator guidance before Neal can continue.';

// Conservative operator-facing message offered for the `unknown` blocked
// category. Exported so the unattended site-A auto-resume can synthesize
// guidance in the same conservative spirit without forking the wording here.
export const CONTINUE_WITH_GUIDANCE_MESSAGE =
  'Continue using this operator guidance. Keep existing verification requirements intact and do not assume any extra authorization.';

// Synthesized guidance recorded by the unattended execute-mode interactive
// recovery auto-resume (site A). Self-contained (no human operator text to echo
// back) and deliberately conservative: continue autonomously, keep every
// verification requirement, assume no extra authorization.
export const UNATTENDED_AUTO_RESUME_GUIDANCE =
  'No operator is available. Continue autonomously using your best judgment. Keep all existing verification requirements intact and do not assume any extra authorization.';

const MISSING_EXTERNAL_PREREQUISITE_KEYWORDS = [
  'credential',
  'credentials',
  'token',
  'secret',
  'api key',
  'gist',
  'dns',
  'billing',
  'approval',
  'installation',
  'permission',
  'access',
  'manual setup',
  'configure',
  'configuration',
  'login',
  'auth',
  'authentication',
];

const REVIEW_OR_SCOPE_KEYWORDS = [
  'reviewer',
  'review',
  'waive',
  'reinterpret',
  'criterion',
  'criteria',
  'acceptance',
  'accept manual evidence',
  'manual evidence',
  'replace current scope',
  'replace plan',
  'scope mismatch',
];

const WAITING_ON_EXTERNAL_EVENT_KEYWORDS = [
  'waiting',
  'poll',
  'polling',
  'scheduled run',
  'scheduler',
  'schedule',
  'github scheduler',
  'external event',
  'time window',
  'later',
  'manual validation',
  'workflow_dispatch',
];

export function buildBlockedGuidance(args: {
  state: OrchestrationState;
  runId?: string;
  waitingForOperatorGuidance?: boolean;
}): BlockedGuidance | null {
  const waitingForOperatorGuidance =
    args.waitingForOperatorGuidance ?? getRunDisplayStatus(args.state).waitingForOperatorGuidance;
  if (!waitingForOperatorGuidance) {
    return null;
  }

  const planReviewWaiting = isPlanReviewGuidanceWaiting(args.state);
  const reasonAndPhase = getReasonAndPhase(args.state, planReviewWaiting);
  const candidateText = buildCandidateText(args.state, reasonAndPhase.reason);
  const category = classifyBlockedGuidance(args.state, reasonAndPhase.reason, candidateText, planReviewWaiting);
  const runId = args.runId ?? basename(args.state.runDir);
  const scopeLabel = args.state.topLevelMode === 'execute' ? getCurrentScopeLabel(args.state) : null;
  const safeReason = sanitizeSensitiveText(reasonAndPhase.reason);
  const knownScopeAccountingGuardrail = category === 'scope_accounting_guardrail';
  const publicSummary = knownScopeAccountingGuardrail
    ? formatScopeAccountingGuardrailSummary(scopeLabel)
    : formatGuidanceSummary({ category, scopeLabel, sourcePhase: reasonAndPhase.sourcePhase });
  const publicReason = knownScopeAccountingGuardrail
    ? formatScopeAccountingGuardrailReason(scopeLabel)
    : safeReason;

  return {
    summary: publicSummary,
    reason: publicReason,
    scopeLabel,
    sourcePhase: reasonAndPhase.sourcePhase,
    category,
    technicalDetails: knownScopeAccountingGuardrail
      ? buildScopeAccountingGuardrailTechnicalDetails(args.state, reasonAndPhase.reason)
      : [],
    evidenceBullets: knownScopeAccountingGuardrail ? buildScopeAccountingEvidenceBullets(args.state, scopeLabel) : [],
    options: buildOptions({ category, runId, candidateText, reason: safeReason, scopeLabel }),
    artifactPaths: buildArtifactPaths(args.state),
  };
}

export function renderBlockedGuidanceSections(guidance: BlockedGuidance): string[] {
  const lines = [
    '## Why Neal Stopped',
    guidance.summary,
    guidance.sourcePhase
      ? `- Source phase: ${formatPublicPhase(guidance.sourcePhase)} (${guidance.sourcePhase})`
      : '- Source phase: unknown',
  ];

  if (guidance.scopeLabel) {
    lines.push(`- Scope: ${guidance.scopeLabel}`);
  }

  if (guidance.reason && guidance.reason !== guidance.summary) {
    lines.push(`- Reason: ${guidance.reason}`);
  }

  if (guidance.evidenceBullets.length > 0) {
    lines.push('', 'Evidence:');
    guidance.evidenceBullets.forEach((bullet) => {
      lines.push(`- ${bullet}`);
    });
  }

  if (guidance.technicalDetails.length > 0) {
    lines.push('', 'Technical details:');
    guidance.technicalDetails.forEach((detail) => {
      lines.push(`- ${detail}`);
    });
  }

  lines.push('', '## Resume Options');
  guidance.options.forEach((option, index) => {
    lines.push(`${index + 1}. ${option.label}: ${option.description}`, `   ${option.command}`);
  });

  lines.push('', '## Useful Artifacts');
  for (const artifact of guidance.artifactPaths) {
    lines.push(`- ${artifact.label}: ${artifact.path}`);
  }

  return lines;
}

function isPlanReviewGuidanceWaiting(state: OrchestrationState) {
  // Shared discriminator: reviewer_plan plus coder-authored *response* blocks
  // (blockerReason non-null). A dirty-worktree safety block at the same response
  // phase has blockerReason null and is not a guidance wait, so it renders as a
  // normal blocked state rather than a plan-review-guidance panel.
  return getPlanReviewGuidanceOriginPhase(state) !== null;
}

function getReasonAndPhase(
  state: OrchestrationState,
  planReviewWaiting: boolean,
): { reason: string; sourcePhase: OrchestrationPhase | null } {
  if (state.interactiveBlockedRecovery) {
    return {
      reason: state.interactiveBlockedRecovery.blockedReason,
      sourcePhase: state.interactiveBlockedRecovery.sourcePhase,
    };
  }

  if (planReviewWaiting) {
    // A coder-authored *response* block carries a durable, operator-facing reason;
    // surface it (and its origin phase) so the guidance render shows the coder's
    // concrete question rather than the generic reviewer-plan message. The
    // reviewer-plan message-resume path leaves blockerReason null and keeps the
    // generic reason + `reviewer_plan` source phase unchanged.
    const blockerReason = state.blockerReason?.trim();
    return {
      reason: blockerReason ? state.blockerReason! : PLAN_REVIEW_REASON,
      sourcePhase: state.blockedFromPhase ?? ('reviewer_plan' satisfies OrchestrationPhase),
    };
  }

  return {
    reason: FALLBACK_REASON,
    sourcePhase: state.blockedFromPhase ?? state.phase,
  };
}

function buildCandidateText(state: OrchestrationState, reason: string) {
  const recovery = state.interactiveBlockedRecovery;
  return normalizeText(
    [
      reason,
      state.currentScopeProgressJustification?.nextStepUnlocked,
      state.currentScopeProgressJustification?.newEvidence,
      state.currentScopeMeaningfulProgressVerdict?.rationale,
      recovery?.blockedReason,
      recovery?.pendingDirective?.operatorGuidance,
      recovery?.consultantAdvice?.resolutionDirective,
      recovery?.consultantAdvice?.rationale,
    ].filter(Boolean).join(' '),
  );
}

function classifyBlockedGuidance(
  state: OrchestrationState,
  reason: string,
  candidateText: string,
  planReviewWaiting: boolean,
): BlockedGuidanceCategory {
  if (planReviewWaiting) {
    return 'plan_review_guidance';
  }
  if (isScopeAccountingGuardrailBlock(state, reason)) {
    return 'scope_accounting_guardrail';
  }
  if (matchesAnyKeyword(candidateText, MISSING_EXTERNAL_PREREQUISITE_KEYWORDS)) {
    return 'missing_external_prerequisite';
  }
  if (
    matchesAnyKeyword(candidateText, REVIEW_OR_SCOPE_KEYWORDS) ||
    state.currentScopeMeaningfulProgressVerdict?.action === 'block_for_operator'
  ) {
    return 'review_or_scope_criteria_mismatch';
  }
  if (matchesAnyKeyword(candidateText, WAITING_ON_EXTERNAL_EVENT_KEYWORDS)) {
    return 'waiting_on_external_event';
  }
  return 'unknown';
}

function matchesAnyKeyword(candidateText: string, keywords: string[]) {
  return keywords.some((keyword) => candidateText.includes(keyword));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function formatGuidanceSummary(args: {
  category: BlockedGuidanceCategory;
  scopeLabel: string | null;
  sourcePhase: OrchestrationPhase | null;
}) {
  const location = args.scopeLabel
    ? `scope ${args.scopeLabel}`
    : args.sourcePhase
      ? formatPublicPhase(args.sourcePhase)
      : 'this run';

  switch (args.category) {
    case 'waiting_on_external_event':
      return `Neal stopped because ${location} is waiting on an external event or validation.`;
    case 'missing_external_prerequisite':
      return `Neal stopped because ${location} needs an external prerequisite before it can continue.`;
    case 'scope_accounting_guardrail':
      return formatScopeAccountingGuardrailSummary(args.scopeLabel);
    case 'review_or_scope_criteria_mismatch':
      return `Neal stopped because ${location} needs operator guidance about review or scope criteria.`;
    case 'plan_review_guidance':
      return 'Neal stopped because plan review needs operator guidance before refinement can continue.';
    case 'unknown':
      return `Neal stopped because ${location} needs operator guidance before it can continue.`;
  }
}

function buildOptions(args: {
  category: BlockedGuidanceCategory;
  runId: string;
  candidateText: string;
  reason: string | null;
  scopeLabel: string | null;
}): BlockedGuidanceOption[] {
  switch (args.category) {
    case 'waiting_on_external_event':
      return buildWaitingOnExternalEventOptions(args.runId, args.candidateText);
    case 'missing_external_prerequisite':
      return buildMissingExternalPrerequisiteOptions(args.runId, args.reason ?? args.candidateText);
    case 'scope_accounting_guardrail':
      return buildScopeAccountingGuardrailOptions(args.runId, args.scopeLabel);
    case 'review_or_scope_criteria_mismatch':
      return [
        option(
          args.runId,
          'Preserve requirement',
          'Keep the current review or scope requirement and continue applying it.',
          'Preserve the current requirement exactly as written and continue applying the existing review criteria.',
        ),
        option(
          args.runId,
          'Provide criteria decision',
          'State the concrete review or scope criteria decision Neal should apply.',
          'Apply the concrete review or scope criteria decision described in this operator guidance. Preserve required verification and document the rationale before continuing.',
        ),
        option(
          args.runId,
          'Replace current scope',
          'Request a replacement scope when the current scope criteria no longer match the work needed.',
          'Replace the current scope with a safer scope that satisfies the operator guidance and preserves required verification.',
        ),
      ];
    case 'plan_review_guidance':
      return [
        option(
          args.runId,
          'Revise plan',
          'Revise the plan according to the operator decision.',
          'Revise the plan according to this operator guidance and keep the execution-shape contract valid.',
        ),
        option(
          args.runId,
          'Preserve requirement',
          'Keep the current reviewer requirement and continue plan refinement.',
          'Preserve the current reviewer requirement and continue refining the plan until it satisfies that requirement.',
        ),
        option(
          args.runId,
          'Narrow plan',
          'Narrow the plan to the reviewer finding that needs resolution.',
          'Narrow the plan to address the reviewer finding that needs resolution and keep unrelated plan content stable.',
        ),
      ];
    case 'unknown':
      return [
        option(
          args.runId,
          'Continue with guidance',
          'Continue using the supplied operator guidance while keeping existing verification requirements intact.',
          CONTINUE_WITH_GUIDANCE_MESSAGE,
        ),
      ];
  }
}

function isScopeAccountingGuardrailBlock(state: OrchestrationState, reason: string) {
  const sourcePhase = state.interactiveBlockedRecovery?.sourcePhase ?? state.blockedFromPhase;
  if (sourcePhase !== 'reviewer_scope' && state.blockedFromPhase !== 'reviewer_scope') {
    return false;
  }

  const rawText = [reason, state.currentScopeMeaningfulProgressVerdict?.rationale].filter(Boolean).join(' ');
  const normalized = normalizeText(rawText);
  if (!normalized.includes('unsafe advance_parent')) {
    return false;
  }

  const containsParentAdvancePreconditions =
    normalized.includes('failed preconditions') ||
    normalized.includes('accepted derived plan is not actively executing') ||
    normalized.includes('parent objective has no prior substantive accepted derived sub-scope');
  const hasBlockedOriginalParentAdvance =
    state.currentScopeMeaningfulProgressVerdict?.action === 'block_for_operator' &&
    (normalized.includes('reviewer rationale') || normalizeText(reason).includes('meaningful_progress'));

  return containsParentAdvancePreconditions || hasBlockedOriginalParentAdvance;
}

function formatScopeAccountingGuardrailSummary(scopeLabel: string | null) {
  const scope = scopeLabel ? `scope ${scopeLabel}` : 'the current scope';
  return (
    `Neal tried to close ${scope} from already-accepted prior work, but its scope-accounting guardrail ` +
    `could not prove that automatic parent-scope closure was safe. Neal stopped for an operator decision ` +
    `instead of skipping scope accounting.`
  );
}

function formatScopeAccountingGuardrailReason(scopeLabel: string | null) {
  const scope = scopeLabel ? `scope ${scopeLabel}` : 'the current scope';
  return (
    `${scope} may already be satisfied, but Neal needs an operator decision on whether to accept that evidence, ` +
    `continue the scope directly, or replace it with a verification-only scope.`
  );
}

function buildScopeAccountingGuardrailTechnicalDetails(state: OrchestrationState, reason: string) {
  return uniqueNonEmptyStrings([
    extractAdvanceParentFailedPreconditions(reason),
    sanitizeSensitiveText(reason),
    state.currentScopeMeaningfulProgressVerdict?.rationale
      ? `Reviewer rationale: ${sanitizeSensitiveText(state.currentScopeMeaningfulProgressVerdict.rationale)}`
      : null,
  ]);
}

function extractAdvanceParentFailedPreconditions(reason: string) {
  const match = reason.match(
    /failed preconditions:\s*(.+?)(?=(?:\.\s+(?:top-level already-satisfied fallback failed preconditions|reviewer rationale)|$))/is,
  );
  const failedPreconditions = match?.[1]?.replace(/\s+/g, ' ').trim();
  if (!failedPreconditions) {
    return null;
  }
  return `advance_parent preconditions failed: ${sanitizeSensitiveText(failedPreconditions)}`;
}

function buildScopeAccountingEvidenceBullets(state: OrchestrationState, scopeLabel: string | null) {
  const progress = state.currentScopeProgressJustification;
  const latestRound = state.rounds.at(-1);
  const priorAcceptedScopes = state.completedScopes
    .filter((scope) => scope.result === 'accepted' && scope.number !== scopeLabel)
    .map((scope) => scope.number);
  const openFindings = state.findings.filter((finding) => finding.status === 'open');
  const openBlockingFindings = openFindings.filter((finding) => finding.severity === 'blocking');
  const currentAcceptedScope = scopeLabel
    ? state.completedScopes.find(
        (scope) => scope.result === 'accepted' && scope.number === scopeLabel && scope.derivedFromParentScope === null,
      )
    : null;

  return uniqueNonEmptyStrings([
    scopeLabel ? `Current scope: ${scopeLabel}.` : null,
    progress?.newEvidence ? `New evidence: ${sanitizeSensitiveText(progress.newEvidence)}` : null,
    progress?.whyNotRedundant ? `Why not redundant: ${sanitizeSensitiveText(progress.whyNotRedundant)}` : null,
    progress?.nextStepUnlocked ? `Next step unlocked: ${sanitizeSensitiveText(progress.nextStepUnlocked)}` : null,
    priorAcceptedScopes.length > 0 ? `Prior accepted scope records: ${priorAcceptedScopes.join(', ')}.` : null,
    scopeLabel && !currentAcceptedScope ? `No accepted top-level record exists yet for scope ${scopeLabel}.` : null,
    latestRound ? `Latest reviewer round open blocking findings: ${latestRound.openBlockingCanonicalCount}.` : null,
    `Open reviewer findings: ${openFindings.length} total, ${openBlockingFindings.length} blocking.`,
  ]);
}

function buildScopeAccountingGuardrailOptions(runId: string, scopeLabel: string | null) {
  const scope = scopeLabel ? `scope ${scopeLabel}` : 'the current scope';
  return [
    option(
      runId,
      'Accept already-satisfied scope',
      `Accept ${scope} only if the reviewer found no issues, prior accepted work satisfies it, and focused verification passed.`,
      `Accept ${scope} as already satisfied only if the reviewer found no issues, prior accepted work satisfies it, and focused verification passed. Record the already-satisfied rationale and continue without weakening implementation, review, or verification requirements.`,
    ),
    option(
      runId,
      'Continue scope directly',
      `Continue executing ${scope} directly instead of closing it from prior work.`,
      `Do not close ${scope} from prior work. Continue executing it directly and verify the remaining acceptance criteria.`,
    ),
    option(
      runId,
      'Replace with verification-only scope',
      `Replace ${scope} with a narrow verification-only scope that proves prior accepted work satisfies the objective.`,
      `Replace ${scope} with a narrow verification-only scope proving prior accepted work satisfies the objective while preserving all review and verification gates.`,
    ),
  ];
}

function buildWaitingOnExternalEventOptions(runId: string, candidateText: string) {
  const options = [
    option(
      runId,
      'Event complete',
      'Tell Neal the external event or validation is complete and ask it to verify.',
      'The external event or validation is complete. Continue and verify it before proceeding.',
    ),
  ];

  if (
    candidateText.includes('manual validation') ||
    candidateText.includes('manual evidence') ||
    candidateText.includes('workflow_dispatch')
  ) {
    options.push(
      option(
        runId,
        'Authorize alternate validation',
        'Authorize a clearly named alternate validation path.',
        'I authorize using the alternate validation path described in this guidance. Verify it and continue only if it satisfies the existing requirement.',
      ),
    );
  }

  return options;
}

function buildMissingExternalPrerequisiteOptions(runId: string, reason: string) {
  const options = [
    option(
      runId,
      'Prerequisite verified',
      'Tell Neal the required external prerequisite is satisfied and ask it to verify.',
      inferPrerequisiteVerifiedMessage(reason),
    ),
  ];

  if (mentionsAlternatePlanPath(reason)) {
    options.push(
      option(
        runId,
        'Change requirement',
        'Authorize the specific plan or provenance change described in your guidance.',
        'Use the alternate requirement or provenance source described in this guidance. Continue only after preserving the required verification.',
      ),
    );
  }

  return options;
}

function inferPrerequisiteVerifiedMessage(reason: string) {
  const normalized = normalizeText(reason);
  if (normalized.includes('mit') && normalized.includes('license')) {
    const project = inferLicensedProjectName(reason);
    return project
      ? `I have verified the ${project} code is MIT-licensed.`
      : 'I have verified the required code is MIT-licensed.';
  }

  return 'I have verified the required external prerequisite is complete.';
}

function inferLicensedProjectName(reason: string) {
  const pinnedCheckoutMatch = reason.match(/\bthe pinned (.+?) checkout\b/i);
  if (pinnedCheckoutMatch?.[1]?.trim()) {
    return cleanInferredName(pinnedCheckoutMatch[1]);
  }

  const projectMatch = reason.match(/\b([A-Z][A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]+){0,4})\b(?=[^.]*\b(?:license|licensed)\b)/);
  if (projectMatch?.[1]?.trim()) {
    return cleanInferredName(projectMatch[1]);
  }

  return null;
}

function cleanInferredName(value: string) {
  return value.replace(/\s+/g, ' ').replace(/^the\s+/i, '').trim();
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function mentionsAlternatePlanPath(reason: string) {
  const normalized = normalizeText(reason);
  return (
    normalized.includes('amend the plan') ||
    normalized.includes('alternate') ||
    normalized.includes('another provenance source') ||
    normalized.includes('another source')
  );
}

function option(runId: string, label: string, description: string, message: string): BlockedGuidanceOption {
  return {
    label,
    description,
    command: `neal resume --run ${runId} --message "${escapeDoubleQuotedShellString(message)}"`,
  };
}

function escapeDoubleQuotedShellString(value: string) {
  return value.replace(/[\\$"`]/g, (match) => `\\${match}`);
}

function buildArtifactPaths(state: OrchestrationState): Array<{ label: string; path: string }> {
  const paths = [
    { label: 'Run state', path: getRunStatePath(state.runDir) },
    { label: 'Progress', path: state.progressMarkdownPath },
    { label: 'Review', path: state.reviewMarkdownPath },
    { label: 'Recovery', path: state.recoveryMarkdownPath },
    { label: 'Run narrative', path: join(state.runDir, 'RUN_NARRATIVE.md') },
    { label: 'Events', path: join(state.runDir, 'events.ndjson') },
  ];

  if (state.archivedReviewPath) {
    paths.push({ label: 'Archived review', path: state.archivedReviewPath });
  }

  const invalidPayloadPath = findCurrentInvalidSplitPlanPayloadArtifactPath(state);
  if (invalidPayloadPath) {
    paths.push({ label: 'Invalid split-plan payload', path: invalidPayloadPath });
  }

  return paths;
}

function findCurrentInvalidSplitPlanPayloadArtifactPath(state: OrchestrationState): string | null {
  const artifactPath = join(state.runDir, `SCOPE_${state.currentScopeNumber}_INVALID_DERIVED_PLAN.md`);
  return existsSync(artifactPath) ? artifactPath : null;
}
