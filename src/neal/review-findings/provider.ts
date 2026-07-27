import {
  getAgentTurnRetryLimit,
  getAgentTurnStartupTimeoutMs,
  getApiRetryLimit,
  getDefaultCoderModel,
  getDefaultCoderProvider,
  getDefaultReviewerModel,
  getDefaultReviewerProvider,
  getInactivityTimeoutMs,
} from '../config.js';
import type { RunLogger } from '../logger.js';
import { runCoderStructuredPrompt } from '../agents/structured-coder.js';
import {
  getReviewerDoctrineAccessMode,
  readOnlyReviewerNeedsInlinedDiff,
} from '../context/inline-review-context.js';
import { runWithAgentTurnLiveness } from '../providers/liveness.js';
import {
  assertProviderSupportsCoder,
  assertProviderSupportsStructuredAdvisor,
  getStructuredAdvisorAdapter,
} from '../providers/registry.js';
import { createProviderTelemetrySink } from '../providers/telemetry.js';
import type { StructuredJsonProtocolSpec } from '../providers/types.js';
import {
  buildReviewFindingsInlinedDiffSection,
  buildReviewFindingsReadOnlyInspectionSection,
} from './prompts.js';
import type { AgentConfig } from '../types.js';
import type {
  ReviewFindingItem,
  ReviewFindingsContext,
  ReviewFindingsDraft,
  ReviewFindingsProviderAdapter,
  ReviewFindingsProviderDraftArgs,
  ReviewFindingsProviderReviewArgs,
  ReviewFindingsReview,
} from './types.js';

// An accepted (read-only) review must not claim the reviewer mutated code, nor
// instruct mutating commands. Pattern #1 requires a first-person agency subject
// ("I/we … applied/made/committed … a fix/change"), so it flags self-attribution
// without rejecting benign passive descriptions of the coder's change under review
// (e.g. "the fix was applied and tests pass" — a thing a read-only reviewer may say).
// The earlier `(fix) (was|has|applied|…)` form false-positived on that passive
// phrasing, failing otherwise-capable review models. #2-#5 catch explicit commit
// claims and mutating git/neal command instructions regardless of subject.
const FORBIDDEN_ACCEPTED_TEXT = [
  /\b(?:i|we)\s+(?:\w+\s+){0,2}(?:applied|made|wrote|added|introduced|implemented|created|committed)\s+(?:\w+\s+){0,2}(?:fix|fixes|repair|repairs|change|changes|edit|edits|patch|patches|commit|correction)\b/i,
  /\bcreated\s+(an?\s+)?(additive\s+)?fix\s+commit\b/i,
  /\bcommitted\s+(the\s+)?fix\b/i,
  /\b(run|execute|start|invoke|call|use)\s+`?git\s+(commit|reset|rebase|squash|checkout|switch|merge|push)\b/i,
  /\b(run|execute|start|invoke|call|use)\s+`?neal\s+(execute|run|resume|squash)\b/i,
];

class AgentReviewFindingsProviderAdapter implements ReviewFindingsProviderAdapter {
  constructor(
    private readonly args: {
      cwd: string;
      agentConfig: AgentConfig;
      logger?: RunLogger;
    },
  ) {
    assertReviewAgentCapabilities(args.agentConfig);
  }

  async draftFindings(args: ReviewFindingsProviderDraftArgs): Promise<ReviewFindingsDraft> {
    const schema = buildReviewFindingsDraftSchema();
    const result = await runCoderStructuredPrompt<ReviewFindingsDraft>({
      coder: this.args.agentConfig.coder,
      cwd: this.args.cwd,
      prompt: args.prompt,
      schema,
      label: 'Review findings draft',
      structuredJsonProtocol: buildReviewFindingsProtocolSpec({
        schemaLabel: 'review_findings_draft_payload',
        schema,
        validator: validateReviewFindingsDraft,
      }),
      logger: this.args.logger,
    });

    args.onSessionHandle?.(result.sessionHandle ?? null);
    return validateReviewFindingsDraft(result.structured);
  }

  async reviewDraft(args: ReviewFindingsProviderReviewArgs): Promise<ReviewFindingsReview> {
    const reviewer = getStructuredAdvisorAdapter(this.args.agentConfig.reviewer);
    const schema = buildReviewFindingsReviewSchema();
    // The base adjudication prompt only previews the diff. A read-only
    // reviewer (read tools, no shell) that exposes its own commit-range diff
    // tool gets the read-only range-inspection section directing it to the
    // git_diff tool with the exact resolved revisions; a read-only reviewer
    // without a commit-range diff tool (native Claude/Codex) instead gets the
    // full selected diff inlined and no git_diff-tool instruction, because it
    // can neither run git commands, call a git_diff tool, nor rely on the
    // truncated preview. Tool-access reviewers keep the built prompt
    // byte-identical.
    const accessMode = getReviewerDoctrineAccessMode(this.args.agentConfig.reviewer);
    const prompt =
      accessMode === 'read-only'
        ? readOnlyReviewerNeedsInlinedDiff(this.args.agentConfig.reviewer)
          ? `${args.prompt}\n\n${buildReviewFindingsInlinedDiffSection(args.context)}`
          : `${args.prompt}\n\n${buildReviewFindingsReadOnlyInspectionSection(args.context)}`
        : args.prompt;
    const result = await runWithAgentTurnLiveness({
      provider: this.args.agentConfig.reviewer.provider,
      role: 'structured-advisor',
      label: 'review-findings',
      startupTimeoutMs: Math.min(
        getAgentTurnStartupTimeoutMs(this.args.cwd),
        getInactivityTimeoutMs(this.args.cwd),
      ),
      // Structured-advisor turns retry locally: they are non-writing by policy
      // and do not resume sessions at this call site.
      retryLimit: getAgentTurnRetryLimit(this.args.cwd),
      logger: this.args.logger,
      baseSink: createProviderTelemetrySink({
        logger: this.args.logger,
        provider: this.args.agentConfig.reviewer.provider,
        role: 'structured-advisor',
        label: 'review-findings',
        cwd: this.args.cwd,
      }),
      run: (events, attempt) =>
        reviewer.runStructuredRound<ReviewFindingsReview>({
          label: 'review-findings',
          cwd: this.args.cwd,
          prompt,
          schema,
          structuredJsonProtocol: buildReviewFindingsProtocolSpec({
            schemaLabel: 'review_findings_review_payload',
            schema,
            validator: validateReviewFindingsReview,
          }),
          inactivityTimeoutMs: getInactivityTimeoutMs(this.args.cwd),
          apiRetryLimit: getApiRetryLimit(this.args.cwd),
          signal: attempt.signal,
          events,
        }),
    });

    args.onSessionHandle?.(result.sessionHandle ?? null);
    return validateReviewFindingsReview(result.structured);
  }
}

function buildReviewFindingsProtocolSpec<TStructured>(args: {
  schemaLabel: string;
  schema: Record<string, unknown>;
  validator: (payload: unknown) => TStructured;
}): StructuredJsonProtocolSpec<TStructured> {
  return {
    protocol: 'neal-json-block-v1',
    schemaLabel: args.schemaLabel,
    schema: args.schema,
    validator: args.validator,
    repairAttemptLimit: 2,
  };
}

export function getDefaultReviewAgentConfig(cwd: string): AgentConfig {
  return {
    planner: {
      provider: getDefaultCoderProvider(cwd),
      model: getDefaultCoderModel(cwd),
    },
    coder: {
      provider: getDefaultCoderProvider(cwd),
      model: getDefaultCoderModel(cwd),
    },
    reviewer: {
      provider: getDefaultReviewerProvider(cwd),
      model: getDefaultReviewerModel(cwd),
    },
  };
}

export function createAgentReviewFindingsProviderAdapter(args: {
  cwd: string;
  agentConfig?: AgentConfig;
  logger?: RunLogger;
}): ReviewFindingsProviderAdapter {
  return new AgentReviewFindingsProviderAdapter({
    cwd: args.cwd,
    agentConfig: args.agentConfig ?? getDefaultReviewAgentConfig(args.cwd),
    logger: args.logger,
  });
}

function assertReviewAgentCapabilities(agentConfig: AgentConfig) {
  assertProviderSupportsCoder(agentConfig.coder, {
    role: 'coder',
    context: 'neal review',
    reason: 'neal review uses the configured coder provider to inspect the selected committed range and draft structured findings',
    requireReadToolAccess: true,
    requireStructuredOutput: true,
    reasons: {
      coder_adapter: 'the review findings draft starts through the configured coder adapter',
      read_tool_access: 'the coder must inspect the selected diff and repository context without editing it',
      structured_output: 'the review findings draft must be schema-validated before reviewer adjudication',
      model_override: 'a non-null coder model override is configured for review drafting',
    },
  });

  assertProviderSupportsStructuredAdvisor(agentConfig.reviewer, {
    role: 'reviewer',
    context: 'neal review',
    reason: 'neal review uses the configured reviewer provider to adjudicate and accept or revise the findings artifact',
    requireReadToolAccess: true,
    requireStructuredOutput: true,
    reasons: {
      structured_advisor_adapter: 'review findings adjudication runs through the configured structured-advisor adapter',
      read_tool_access: 'the reviewer must inspect the draft, selected diff, and repository context directly with read tools',
      structured_output: 'the reviewer verdict must be schema-validated before Neal accepts the findings artifact',
      model_override: 'a non-null reviewer model override is configured for review adjudication',
    },
  });
}

function buildReviewFindingSchema() {
  return {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['blocking', 'non_blocking'] },
      files: { type: 'array', items: { type: 'string' } },
      claim: { type: 'string' },
      evidence: { type: 'string' },
      requiredAction: { type: 'string' },
    },
    required: ['severity', 'files', 'claim', 'evidence', 'requiredAction'],
    additionalProperties: false,
  } as const;
}

function buildReviewFindingsDraftSchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: buildReviewFindingSchema(),
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'findings', 'warnings'],
    additionalProperties: false,
  } as const;
}

function buildReviewFindingsReviewSchema() {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['accepted', 'revise', 'blocked'] },
      findings: { type: 'array', items: { type: 'string' } },
      finalMarkdown: { type: 'string' },
      blockedReason: { type: 'string' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'findings', 'finalMarkdown', 'blockedReason', 'warnings'],
    additionalProperties: false,
  } as const;
}

export function validateReviewFindingsDraft(draft: unknown): ReviewFindingsDraft {
  if (!draft || typeof draft !== 'object') {
    throw new Error('Review provider returned an invalid draft object');
  }

  const raw = draft as Partial<ReviewFindingsDraft>;
  if (typeof raw.summary !== 'string' || raw.summary.trim() === '') {
    throw new Error('Review provider returned an empty draft summary');
  }

  return {
    summary: raw.summary.trim(),
    findings: validateFindingItems(raw.findings),
    warnings: validateStringArray(raw.warnings),
  };
}

export function validateReviewFindingsReview(review: unknown): ReviewFindingsReview {
  if (!review || typeof review !== 'object') {
    throw new Error('Review provider returned an invalid review object');
  }

  const raw = review as Partial<ReviewFindingsReview>;
  if (raw.verdict !== 'accepted' && raw.verdict !== 'revise' && raw.verdict !== 'blocked') {
    throw new Error('Review provider returned an invalid review verdict');
  }

  const findings = validateStringArray(raw.findings);
  if (raw.verdict === 'revise' && findings.length === 0) {
    throw new Error('Review provider requested review revision without findings');
  }
  if (
    raw.verdict === 'blocked' &&
    findings.length === 0 &&
    (typeof raw.blockedReason !== 'string' || raw.blockedReason.trim() === '')
  ) {
    throw new Error('Review provider blocked without findings or a blocked reason');
  }

  const finalMarkdown = typeof raw.finalMarkdown === 'string' && raw.finalMarkdown.trim() !== ''
    ? raw.finalMarkdown.trim()
    : undefined;
  if (finalMarkdown && FORBIDDEN_ACCEPTED_TEXT.some((pattern) => pattern.test(finalMarkdown))) {
    throw new Error('Review provider returned accepted final markdown with mutation or repair-commit wording');
  }

  return {
    verdict: raw.verdict,
    findings,
    finalMarkdown,
    blockedReason: typeof raw.blockedReason === 'string' && raw.blockedReason.trim() !== ''
      ? raw.blockedReason.trim()
      : undefined,
    warnings: validateStringArray(raw.warnings),
  };
}

export function renderReviewFindingsFinalMarkdown(
  context: ReviewFindingsContext,
  draft: ReviewFindingsDraft,
  review: Pick<ReviewFindingsReview, 'verdict' | 'findings' | 'warnings'>,
) {
  return [
    '# Review Findings',
    '',
    '## Summary',
    '',
    draft.summary,
    '',
    '## Range',
    '',
    `- Base: ${context.externalBaseCommit}`,
    `- Head: ${context.externalHeadCommit}`,
    `- Commits: ${context.externalCommits.length}`,
    '',
    '## Findings',
    '',
    ...formatFindings(draft.findings),
    '',
    '## Review Acceptance',
    '',
    `- Verdict: ${review.verdict}`,
    `- Revision findings: ${review.findings.length === 0 ? 'none' : review.findings.join('; ')}`,
    `- Warnings: ${(review.warnings ?? []).length === 0 ? 'none' : (review.warnings ?? []).join('; ')}`,
  ].join('\n') + '\n';
}

function validateFindingItems(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const findings: ReviewFindingItem[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') {
      throw new Error(`Review provider returned invalid finding at index ${index}`);
    }
    const raw = item as Partial<ReviewFindingItem>;
    if (raw.severity !== 'blocking' && raw.severity !== 'non_blocking') {
      throw new Error(`Review provider returned invalid finding severity at index ${index}`);
    }
    findings.push({
      severity: raw.severity,
      files: validateStringArray(raw.files),
      claim: typeof raw.claim === 'string' ? raw.claim.trim() : '',
      evidence: typeof raw.evidence === 'string' ? raw.evidence.trim() : '',
      requiredAction: typeof raw.requiredAction === 'string' ? raw.requiredAction.trim() : '',
    });
  }
  return findings;
}

function validateStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function formatFindings(findings: readonly ReviewFindingItem[]) {
  if (findings.length === 0) {
    return ['No findings were identified in the selected range.'];
  }

  return findings.flatMap((finding, index) => [
    `### F${index + 1}: ${finding.claim}`,
    '',
    `- Severity: ${finding.severity}`,
    `- Files: ${finding.files.length === 0 ? '(none)' : finding.files.join(', ')}`,
    `- Evidence: ${finding.evidence}`,
    `- Required action: ${finding.requiredAction}`,
    '',
  ]);
}
