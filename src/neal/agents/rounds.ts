import { readFile, writeFile } from 'node:fs/promises';

import {
  getAgentTurnRetryLimit,
  getAgentTurnStartupTimeoutMs,
  getApiRetryLimit,
  getInactivityTimeoutMs,
} from '../config.js';
import type { RunLogger } from '../logger.js';
import { runWithAgentTurnLiveness } from '../providers/liveness.js';
import { normalizeExecutionShapeDeclaration } from '../plan-validation.js';
import { getCoderAdapter, getProviderDefinition, getStructuredAdvisorAdapter } from '../providers/registry.js';
import { createProviderTelemetrySink } from '../providers/telemetry.js';
import { isNealProviderError, NealProviderError } from '../providers/types.js';
import type { StructuredJsonProtocolSpec } from '../providers/types.js';
import type {
  AgentRoleConfig,
  CoderSessionProtocol,
  ExecuteScopeProgressJustification,
  FinalCompletionPacket,
  FinalCompletionReviewerVerdict,
  FinalCompletionSummary,
  PendingPlanReviewGuidance,
  ReviewFinding,
  ReviewerMeaningfulProgressVerdict,
  ConsultantVerdict,
  ScopeMarker,
} from '../types.js';
import {
  getReviewerDoctrineAccessMode,
  type InlineReviewerContext,
} from '../context/inline-review-context.js';
import type { ReviewerContextPacket } from '../context/reviewer-context.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_CHUNK_DONE,
  AUTONOMY_DONE,
  AUTONOMY_SCOPE_DONE,
  AUTONOMY_SPLIT_PLAN,
  buildBlockedRecoveryCoderPrompt,
  buildCoderResponsePrompt,
  buildCoderPlanResponsePrompt,
  buildFinalCompletionReviewerPrompt,
  buildFinalCompletionSummaryPrompt,
  buildLegacyScopePrompt,
  buildLegacyPlanningPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
  buildReviewerPrompt,
  buildConsultantPrompt,
  buildScopePrompt,
} from './prompts.js';
import {
  buildCoderBlockedRecoveryDispositionSchema,
  buildCoderPlanSchema,
  buildCoderScopeSchema,
  buildCoderPlanResponseSchema,
  buildCoderResponseSchema,
  buildConsultantSchema,
  buildFinalCompletionSummarySchema,
  buildFinalCompletionReviewerSchema,
  buildPlanReviewerSchema,
  buildReviewerSchema,
  parseExecuteScopeProgressPayload,
  parseFinalCompletionReviewerPayload,
  parseFinalCompletionSummaryPayload,
  stripExecuteScopeProgressPayload,
  type CoderBlockedRecoveryDispositionPayload,
  type CoderPlanPayload,
  type CoderPlanResponsePayload,
  type CoderScopePayload,
  type CoderResponsePayload,
  type PlanReviewerPayload,
  type ReviewerPayload,
  validateCoderBlockedRecoveryDispositionPayload,
  validateCoderPlanPayload,
  validateCoderPlanResponsePayload,
  validateCoderResponsePayload,
  validateCoderScopePayload,
  validatePlanReviewerPayload,
  validateConsultantVerdictPayload,
  validateReviewerPayload,
} from './schemas.js';
import { runCoderStructuredPrompt, translateCoderProviderError } from './structured-coder.js';

export class ReviewerRoundError extends Error {
  readonly sessionHandle: string | null;
  readonly providerError: NealProviderError;
  readonly kind: NealProviderError['kind'];
  readonly retryable: boolean;
  readonly subtype: string | null;

  constructor(providerError: NealProviderError) {
    super(providerError.message);
    this.name = 'ReviewerRoundError';
    this.sessionHandle = providerError.sessionHandle;
    this.providerError = providerError;
    this.kind = providerError.kind;
    this.retryable = providerError.retryable;
    this.subtype = providerError.kind;
  }
}

function validationErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class FinalCompletionReviewerVerdictError extends Error {
  readonly originalValidationMessage: string;
  readonly sessionHandle: string | null;
  readonly subtype: 'final_completion_verdict_invalid';
  readonly cause: unknown;

  constructor(args: { sessionHandle: string | null; cause: unknown }) {
    const message = validationErrorMessage(args.cause);
    super(message, { cause: args.cause });
    this.name = 'FinalCompletionReviewerVerdictError';
    this.originalValidationMessage = message;
    this.sessionHandle = args.sessionHandle;
    this.subtype = 'final_completion_verdict_invalid';
    this.cause = args.cause;
  }
}

// Legacy marker-protocol compatibility for active legacy_marker_v1 primary
// sessions. New primary planning/execution sessions use structured envelopes.
function extractMarker(message: string): ScopeMarker | null {
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      line === AUTONOMY_SCOPE_DONE ||
      line === AUTONOMY_CHUNK_DONE ||
      line === AUTONOMY_DONE ||
      line === AUTONOMY_BLOCKED ||
      line === AUTONOMY_SPLIT_PLAN
    ) {
      return line as ScopeMarker;
    }
  }

  return null;
}

function translateReviewerProviderError(error: unknown): ReviewerRoundError | unknown {
  if (isNealProviderError(error)) {
    return new ReviewerRoundError(error);
  }
  return error;
}

async function safeReadText(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function getCoderRuntimeOptions(cwd: string) {
  return {
    inactivityTimeoutMs: getInactivityTimeoutMs(cwd),
  };
}

function getStructuredAdvisorRuntimeOptions(cwd: string) {
  return {
    inactivityTimeoutMs: getInactivityTimeoutMs(cwd),
    apiRetryLimit: getApiRetryLimit(cwd),
  };
}

function buildStructuredJsonProtocolSpec<TStructured>(args: {
  schemaLabel: string;
  schema: Record<string, unknown>;
  validator: (payload: unknown) => TStructured;
  repairAttemptLimit?: number;
}): StructuredJsonProtocolSpec<TStructured> {
  return {
    protocol: 'neal-json-block-v1',
    schemaLabel: args.schemaLabel,
    schema: args.schema,
    validator: args.validator,
    repairAttemptLimit: args.repairAttemptLimit ?? 2,
  };
}

function createCoderProviderEventSink(args: {
  coder: AgentRoleConfig;
  cwd: string;
  label?: 'planner';
  logger?: RunLogger;
}) {
  return createProviderTelemetrySink({
    logger: args.logger,
    provider: args.coder.provider,
    role: 'coder',
    ...(args.label ? { label: args.label } : {}),
    cwd: args.cwd,
  });
}

function createStructuredAdvisorProviderEventSink(args: {
  advisor: AgentRoleConfig;
  cwd: string;
  label:
    | 'review'
    | 'plan-review'
    | 'final-completion'
    | 'provider-check'
    | 'review-findings'
    | 'consultant';
  logger?: RunLogger;
}) {
  return createProviderTelemetrySink({
    logger: args.logger,
    provider: args.advisor.provider,
    role: 'structured-advisor',
    label: args.label,
    cwd: args.cwd,
  });
}

// Resolves the session handle a reviewer round may resume: the previous
// round's handle when the provider's structured-advisor capability declares
// session resume, null otherwise (sessionless providers like
// openai-compatible must never receive one — openai-compatible treats a
// non-null resume handle as corrupted state).
// Reviewer continuity within a review engagement is the original design:
// a continuing reviewer converges like a human-shuttled review chat, while
// a cold-started reviewer re-audits from scratch every round.
export function resolveReviewerResumeHandle(
  reviewer: AgentRoleConfig,
  resumeHandle: string | null | undefined,
): string | null {
  if (!resumeHandle) {
    return null;
  }
  const capabilities = getProviderDefinition(reviewer.provider).capabilities['structured-advisor'];
  return capabilities.supported && capabilities.supportsSessionResume ? resumeHandle : null;
}

async function runReviewerStructuredRound<TStructured>(args: {
  reviewer: AgentRoleConfig;
  label:
    | 'review'
    | 'plan-review'
    | 'final-completion'
    | 'provider-check'
    | 'review-findings'
    | 'consultant';
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  structuredJsonProtocol: StructuredJsonProtocolSpec<TStructured>;
  resumeHandle?: string | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; structured: TStructured }> {
  try {
    const advisor = getStructuredAdvisorAdapter(args.reviewer);
    const result = await runWithAgentTurnLiveness({
      provider: args.reviewer.provider,
      role: 'structured-advisor',
      label: args.label,
      startupTimeoutMs: Math.min(getAgentTurnStartupTimeoutMs(args.cwd), getInactivityTimeoutMs(args.cwd)),
      // Structured-advisor turns retry locally: they are non-writing by
      // policy, and a liveness retry re-runs the round from the same resume
      // handle (the prior round's session), never a partially-written one.
      retryLimit: getAgentTurnRetryLimit(args.cwd),
      logger: args.logger,
      baseSink: createStructuredAdvisorProviderEventSink({
        advisor: args.reviewer,
        cwd: args.cwd,
        label: args.label,
        logger: args.logger,
      }),
      run: (events, attempt) =>
        advisor.runStructuredRound<TStructured>({
          label: args.label,
          cwd: args.cwd,
          prompt: args.prompt,
          schema: args.schema,
          structuredJsonProtocol: args.structuredJsonProtocol,
          resumeHandle: resolveReviewerResumeHandle(args.reviewer, args.resumeHandle),
          // Liveness retry sits outside the adapter-owned apiRetryLimit; it
          // does not replace provider API retry.
          ...getStructuredAdvisorRuntimeOptions(args.cwd),
          signal: attempt.signal,
          events,
        }),
    });

    return {
      sessionHandle: result.sessionHandle,
      structured: result.structured,
    };
  } catch (error) {
    throw translateReviewerProviderError(error);
  }
}

export async function runReviewerRound(args: {
  reviewer: AgentRoleConfig;
  resumeHandle?: string | null;
  cwd: string;
  planDoc: string;
  baseCommit: string;
  headCommit: string;
  commits: string[];
  previousHeadCommit?: string | null;
  diffStat: string;
  changedFiles: string[];
  round: number;
  reviewMarkdownPath: string;
  parentScopeLabel: string;
  progressJustification: ExecuteScopeProgressJustification;
  recentHistorySummary: string;
  scratchDir: string;
  reviewerContext?: ReviewerContextPacket | null;
  // Neal-inlined commit-range diff for a read-only reviewer that has read tools
  // but no commit-range diff tool; threaded into buildReviewerPrompt.
  inlinedRangeDiff?: string | null;
  // Persisted unattended run flag; threaded into the reviewer prompt variant.
  unattended?: boolean;
  logger?: RunLogger;
}): Promise<{
  sessionHandle: string | null;
  summary: string;
  findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>[];
  meaningfulProgress: ReviewerMeaningfulProgressVerdict;
}> {
  const schema = buildReviewerSchema();
  const { sessionHandle, structured } = await runReviewerStructuredRound<ReviewerPayload>({
    reviewer: args.reviewer,
    resumeHandle: args.resumeHandle,
    label: 'review',
    cwd: args.cwd,
    // The doctrine access mode comes from the reviewer provider's declared
    // structured-advisor tool access, not from inline-context presence alone.
    prompt: buildReviewerPrompt({ ...args, accessMode: getReviewerDoctrineAccessMode(args.reviewer) }),
    schema,
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'reviewer_payload',
      schema,
      validator: validateReviewerPayload,
    }),
    logger: args.logger,
  });

  return {
    sessionHandle,
    summary: structured.summary,
    findings: structured.findings.map((finding) => ({
      round: args.round,
      source: 'reviewer' as const,
      severity: finding.severity,
      files: finding.files,
      claim: finding.claim,
      evidence: finding.evidence,
      requiredAction: finding.requiredAction,
      roundSummary: structured.summary,
    })),
    meaningfulProgress: {
      action: structured.meaningfulProgressAction,
      rationale: structured.meaningfulProgressRationale,
    },
  };
}

export async function runPlanReviewerRound(args: {
  reviewer: AgentRoleConfig;
  resumeHandle?: string | null;
  cwd: string;
  planDoc: string;
  round: number;
  reviewMarkdownPath: string;
  mode?: 'plan' | 'derived-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  reviewerContext?: ReviewerContextPacket | null;
  reviewedPlanContent?: string | null;
  parentPlanContent?: string | null;
  // Persisted unattended run flag; threaded into the plan-reviewer prompt variant.
  unattended?: boolean;
  // When true, the top-level plan was authored `one_shot`; the reviewer prompt gains a line
  // instructing it to raise a blocking finding on any shape expansion or added orchestration.
  authoredOneShot?: boolean;
  logger?: RunLogger;
}): Promise<{
  sessionHandle: string | null;
  summary: string;
  executionShape: PlanReviewerPayload['executionShape'];
  findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>[];
}> {
  const schema = buildPlanReviewerSchema();
  const { sessionHandle, structured } = await runReviewerStructuredRound<PlanReviewerPayload>({
    reviewer: args.reviewer,
    resumeHandle: args.resumeHandle,
    label: 'plan-review',
    cwd: args.cwd,
    // The doctrine access mode comes from the reviewer provider's declared
    // structured-advisor tool access, not from inline-context presence alone.
    prompt: buildPlanReviewerPrompt({ ...args, accessMode: getReviewerDoctrineAccessMode(args.reviewer) }),
    schema,
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'plan_reviewer_payload',
      schema,
      validator: validatePlanReviewerPayload,
    }),
    logger: args.logger,
  });

  return {
    sessionHandle,
    summary: structured.summary,
    executionShape: structured.executionShape,
    findings: structured.findings.map((finding) => ({
      round: args.round,
      source: 'reviewer' as const,
      severity: finding.severity,
      // validatePlanReviewerPayload normalizes an absent class to plan_correctness,
      // so a plan-review finding always carries a concrete class by this point.
      findingClass: finding.findingClass,
      files: finding.files,
      claim: finding.claim,
      requiredAction: finding.requiredAction,
      roundSummary: structured.summary,
    })),
  };
}

// Read-only, inline-only round for the review_stuck consultant. It runs through the
// same runReviewerStructuredRound plumbing the support / final-completion
// reviewers use (read-only tools only, zero commits, zero file edits). Because
// the consultant judges entirely from Neal-inlined in-memory artifacts (plan, open
// blocking findings, reviewer-round snapshots), it has a single no-read-safe
// prompt variant and therefore requires a non-null inlineContext. The explicit
// null check below rejects a caller that hands the round a null context before
// any adapter contact (the consultant always passes a non-null context in
// production).
export async function runConsultantRound(args: {
  reviewer: AgentRoleConfig;
  cwd: string;
  blockedReason: string;
  inlineContext: InlineReviewerContext | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; verdict: ConsultantVerdict }> {
  if (!args.inlineContext) {
    throw new ReviewerRoundError(
      new NealProviderError({
        message: 'consultant round requires Neal-inlined reviewer context',
        provider: args.reviewer.provider,
        role: 'structured-advisor',
        sessionHandle: null,
        kind: 'provider_failed',
        retryable: false,
      }),
    );
  }

  const schema = buildConsultantSchema();
  const { sessionHandle, structured } = await runReviewerStructuredRound<ConsultantVerdict>({
    reviewer: args.reviewer,
    label: 'consultant',
    cwd: args.cwd,
    prompt: buildConsultantPrompt({
      blockedReason: args.blockedReason,
      inlineContext: args.inlineContext,
    }),
    schema,
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'consultant_payload',
      schema,
      validator: validateConsultantVerdictPayload,
    }),
    logger: args.logger,
  });

  return {
    sessionHandle,
    verdict: validateConsultantVerdictPayload(structured),
  };
}

export async function runCoderFinalCompletionSummaryRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  packet: FinalCompletionPacket;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; summary: FinalCompletionSummary }> {
  try {
    const advisor = getStructuredAdvisorAdapter(args.coder);
    const schema = buildFinalCompletionSummarySchema();
    const result = await runWithAgentTurnLiveness({
      provider: args.coder.provider,
      role: 'structured-advisor',
      label: 'final-completion',
      startupTimeoutMs: Math.min(getAgentTurnStartupTimeoutMs(args.cwd), getInactivityTimeoutMs(args.cwd)),
      // Structured-advisor turns retry locally: they are non-writing by
      // policy, and a liveness retry re-runs the round from the same resume
      // handle (the prior round's session), never a partially-written one.
      retryLimit: getAgentTurnRetryLimit(args.cwd),
      logger: args.logger,
      baseSink: createStructuredAdvisorProviderEventSink({
        advisor: args.coder,
        cwd: args.cwd,
        label: 'final-completion',
        logger: args.logger,
      }),
      run: (events, attempt) =>
        advisor.runStructuredRound<FinalCompletionSummary>({
          label: 'final-completion',
          cwd: args.cwd,
          prompt: buildFinalCompletionSummaryPrompt(args),
          schema,
          structuredJsonProtocol: buildStructuredJsonProtocolSpec({
            schemaLabel: 'final_completion_summary_payload',
            schema,
            validator: parseFinalCompletionSummaryPayload,
          }),
          ...getStructuredAdvisorRuntimeOptions(args.cwd),
          signal: attempt.signal,
          events,
        }),
    });

    return {
      sessionHandle: result.sessionHandle,
      summary: parseFinalCompletionSummaryPayload(result.structured),
    };
  } catch (error) {
    throw translateCoderProviderError(error);
  }
}

export async function runReviewerFinalCompletionRound(args: {
  reviewer: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  packet: FinalCompletionPacket;
  summary: FinalCompletionSummary;
  scratchDir: string;
  reviewerContext?: ReviewerContextPacket | null;
  // Neal-inlined aggregate commit-range diff for a read-only reviewer that has
  // read tools but no commit-range diff tool; threaded into
  // buildFinalCompletionReviewerPrompt.
  inlinedRangeDiff?: string | null;
  // Persisted unattended run flag; threaded into the completion-reviewer prompt.
  unattended?: boolean;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; verdict: FinalCompletionReviewerVerdict }> {
  const schema = buildFinalCompletionReviewerSchema();
  const { sessionHandle, structured } = await runReviewerStructuredRound<FinalCompletionReviewerVerdict>({
    reviewer: args.reviewer,
    label: 'final-completion',
    cwd: args.cwd,
    // The doctrine access mode comes from the reviewer provider's declared
    // structured-advisor tool access, not from inline-context presence alone.
    prompt: buildFinalCompletionReviewerPrompt({ ...args, accessMode: getReviewerDoctrineAccessMode(args.reviewer) }),
    schema,
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'final_completion_reviewer_payload',
      schema,
      validator: parseFinalCompletionReviewerPayload,
    }),
    logger: args.logger,
  });

  // Trust-boundary policy: rounds-level validation calls like this one are
  // the authoritative trust boundary for agent payloads, not redundant dead
  // code. The json-block protocol validator never runs on native
  // structured-output paths, and cross-field rules are enforced only here on
  // those paths; test/orchestrator.test.ts deliberately drives this wrap
  // (FinalCompletionReviewerVerdictError, subtype
  // final_completion_verdict_invalid) with a non-conforming fake adapter.
  // Do not remove rounds-level validation calls.
  let verdict: FinalCompletionReviewerVerdict;
  try {
    verdict = parseFinalCompletionReviewerPayload(structured);
  } catch (error) {
    throw new FinalCompletionReviewerVerdictError({
      sessionHandle,
      cause: error,
    });
  }

  return {
    sessionHandle,
    verdict,
  };
}

export async function runCoderScopeRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  sessionHandle?: string | null;
  coderSessionProtocol: CoderSessionProtocol | null;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  // Persisted unattended run flag; threaded into the coder scope prompt.
  unattended?: boolean;
  logger?: RunLogger;
}): Promise<{
  sessionHandle: string | null;
  finalResponse: string;
  responseWithoutProgressPayload: string;
  marker: string | null;
  progressJustification: ExecuteScopeProgressJustification;
  manualGate: CoderScopePayload['manualGate'];
}> {
  if (args.sessionHandle && args.coderSessionProtocol === null) {
    throw new Error('Cannot resume coder scope session without coderSessionProtocol.');
  }

  if (!args.sessionHandle || args.coderSessionProtocol === 'structured_json_v1') {
    const progressText = await safeReadText(args.progressMarkdownPath);
    const schema = buildCoderScopeSchema();
    const { sessionHandle, structured } = await runCoderStructuredPrompt<CoderScopePayload>({
      coder: args.coder,
      cwd: args.cwd,
      prompt: buildScopePrompt(args.planDoc, progressText, { unattended: args.unattended }),
      schema,
      label: 'Coder scope round',
      structuredJsonProtocol: buildStructuredJsonProtocolSpec({
        schemaLabel: 'coder_scope_payload',
        schema,
        validator: validateCoderScopePayload,
      }),
      resumeHandle: args.sessionHandle,
      onSessionStarted: args.onSessionStarted,
      logger: args.logger,
    });
    const payload = validateCoderScopePayload(structured);
    const marker = markerForCoderScopeAction(payload.action);
    const responseWithoutProgressPayload = renderCoderScopeResponseWithoutProgressPayload(payload);
    return {
      sessionHandle,
      finalResponse: renderCoderScopePayload(payload, marker),
      responseWithoutProgressPayload,
      marker,
      progressJustification: payload.progress,
      manualGate: payload.manualGate,
    };
  }

  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);
  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await runWithAgentTurnLiveness({
      provider: args.coder.provider,
      role: 'coder',
      startupTimeoutMs: Math.min(getAgentTurnStartupTimeoutMs(args.cwd), getInactivityTimeoutMs(args.cwd)),
      // Resumed sessions never retry in the supervisor; the orchestrator's
      // fresh-session retry owns recovery. This legacy
      // branch always resumes, so the retry limit is always 0 here.
      retryLimit: args.sessionHandle ? 0 : getAgentTurnRetryLimit(args.cwd),
      logger: args.logger,
      baseSink: createCoderProviderEventSink({
        coder: args.coder,
        cwd: args.cwd,
        logger: args.logger,
      }),
      run: (events, attempt) =>
        coder.runPrompt({
          cwd: args.cwd,
          prompt: buildLegacyScopePrompt(args.planDoc, progressText),
          ...getCoderRuntimeOptions(args.cwd),
          resumeHandle: args.sessionHandle,
          // Guarded so an abandoned attempt's late session handle can never
          // overwrite a newer attempt's handle.
          onSessionStarted: attempt.guard(args.onSessionStarted),
          signal: attempt.signal,
          events,
        }),
    });
    finalResponse = result.finalResponse;
    sessionHandle = result.sessionHandle;
  } catch (error) {
    throw translateCoderProviderError(error);
  }
  const progressJustification = parseExecuteScopeProgressPayload(finalResponse);
  const responseWithoutProgressPayload = stripExecuteScopeProgressPayload(finalResponse);
  const marker = extractMarker(responseWithoutProgressPayload);
  if (marker === AUTONOMY_SPLIT_PLAN) {
    const derivedPlan = responseWithoutProgressPayload
      .split(/\r?\n/)
      .filter((line) => line.trim() !== AUTONOMY_SPLIT_PLAN)
      .join('\n')
      .trim();
    if (!derivedPlan) {
      throw new Error('Coder scope round returned AUTONOMY_SPLIT_PLAN without a derived plan body.');
    }
  }

  return {
    sessionHandle,
    finalResponse,
    responseWithoutProgressPayload,
    marker,
    progressJustification,
    manualGate: null,
  };
}

function markerForCoderScopeAction(action: CoderScopePayload['action']): ScopeMarker | null {
  switch (action) {
    case 'continue':
      return AUTONOMY_CHUNK_DONE;
    case 'scope_done':
      return AUTONOMY_SCOPE_DONE;
    case 'done':
      return AUTONOMY_DONE;
    case 'blocked':
      return AUTONOMY_BLOCKED;
    case 'split_plan':
      return AUTONOMY_SPLIT_PLAN;
    case 'manual_gate':
      return null;
  }
}

function renderCoderScopeResponseWithoutProgressPayload(payload: CoderScopePayload) {
  if (payload.action === 'split_plan') {
    return payload.derivedPlan.trim();
  }
  if (payload.action === 'blocked') {
    return (payload.blockedReason || payload.message).trim();
  }
  if (payload.action === 'manual_gate') {
    return payload.message.trim();
  }
  return payload.message.trim();
}

function renderCoderScopePayload(payload: CoderScopePayload, marker: ScopeMarker | null) {
  return [renderCoderScopeResponseWithoutProgressPayload(payload), marker ?? '']
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
}

async function readPlanDocumentForPrompt(planDoc: string) {
  try {
    return await readFile(planDoc, 'utf8');
  } catch {
    return null;
  }
}

export async function runCoderPlanRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  sessionHandle?: string | null;
  coderSessionProtocol: CoderSessionProtocol | null;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  // Persisted unattended run flag; threaded into the planning prompt.
  unattended?: boolean;
  // When true, the top-level plan was authored `one_shot`; the planning prompt gains a line
  // instructing the refiner to keep it single-scope.
  authoredOneShot?: boolean;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; finalResponse: string; marker: string | null }> {
  if (args.sessionHandle && args.coderSessionProtocol === null) {
    throw new Error('Cannot resume planner planning session without plannerSessionProtocol.');
  }

  if (!args.sessionHandle || args.coderSessionProtocol === 'structured_json_v1') {
    const schema = buildCoderPlanSchema();
    const planDocument = await readPlanDocumentForPrompt(args.planDoc);
    const { sessionHandle, structured } = await runCoderStructuredPrompt<CoderPlanPayload>({
      coder: args.coder,
      cwd: args.cwd,
      prompt: buildPlanningPrompt(args.planDoc, planDocument, {
        unattended: args.unattended,
        authoredOneShot: args.authoredOneShot,
      }),
      schema,
      label: 'Planner plan round',
      structuredJsonProtocol: buildStructuredJsonProtocolSpec({
        schemaLabel: 'coder_plan_payload',
        schema,
        validator: validateCoderPlanPayload,
      }),
      toolPolicy: { allowedWritePaths: [args.planDoc], allowRun: false },
      resumeHandle: args.sessionHandle,
      onSessionStarted: args.onSessionStarted,
      telemetryLabel: 'planner',
      logger: args.logger,
    });
    const payload = validateCoderPlanPayload(structured);
    const marker = payload.action === 'blocked' ? AUTONOMY_BLOCKED : AUTONOMY_DONE;
    const normalizedPayload =
      payload.action === 'ready_for_review'
        ? {
            ...payload,
            planBody: normalizeExecutionShapeDeclaration(payload.planBody, payload.executionShape),
          }
        : payload;
    if (normalizedPayload.action === 'ready_for_review') {
      await writeFile(args.planDoc, normalizedPayload.planBody, 'utf8');
    }
    const finalResponse = renderCoderPlanPayload(normalizedPayload, marker);
    return {
      sessionHandle,
      finalResponse,
      marker,
    };
  }

  const coder = getCoderAdapter(args.coder);
  let finalResponse: string;
  let sessionHandle: string | null;
  const planDocument = await readPlanDocumentForPrompt(args.planDoc);
  try {
    const result = await runWithAgentTurnLiveness({
      provider: args.coder.provider,
      role: 'coder',
      label: 'planner',
      startupTimeoutMs: Math.min(getAgentTurnStartupTimeoutMs(args.cwd), getInactivityTimeoutMs(args.cwd)),
      // Resumed sessions never retry in the supervisor; the orchestrator's
      // fresh-session retry owns recovery. This legacy
      // branch always resumes, so the retry limit is always 0 here.
      retryLimit: args.sessionHandle ? 0 : getAgentTurnRetryLimit(args.cwd),
      logger: args.logger,
      baseSink: createCoderProviderEventSink({
        coder: args.coder,
        cwd: args.cwd,
        label: 'planner',
        logger: args.logger,
      }),
      run: (events, attempt) =>
        coder.runPrompt({
          cwd: args.cwd,
          prompt: buildLegacyPlanningPrompt(args.planDoc, planDocument),
          ...getCoderRuntimeOptions(args.cwd),
          toolPolicy: { allowedWritePaths: [args.planDoc], allowRun: false },
          resumeHandle: args.sessionHandle,
          // Guarded so an abandoned attempt's late session handle can never
          // overwrite a newer attempt's handle.
          onSessionStarted: attempt.guard(args.onSessionStarted),
          signal: attempt.signal,
          events,
        }),
    });
    finalResponse = result.finalResponse;
    sessionHandle = result.sessionHandle;
  } catch (error) {
    throw translateCoderProviderError(error);
  }
  const marker = extractMarker(finalResponse);

  return {
    sessionHandle,
    finalResponse,
    marker,
  };
}

function renderCoderPlanPayload(payload: CoderPlanPayload, marker: string) {
  const parts = [payload.message, payload.planBody, payload.blockedReason]
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...parts, marker].join('\n\n');
}

export async function runCoderResponseRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  verificationHint: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
  sessionHandle?: string | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderResponsePayload }> {
  const progressText = await safeReadText(args.progressMarkdownPath);
  const schema = buildCoderResponseSchema();

  const { sessionHandle, structured } = await runCoderStructuredPrompt<CoderResponsePayload>({
    coder: args.coder,
    cwd: args.cwd,
    prompt: buildCoderResponsePrompt({
      planDoc: args.planDoc,
      progressText,
      verificationHint: args.verificationHint,
      openFindings: args.openFindings,
      mode: args.mode,
    }),
    schema,
    label: 'Coder response round',
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'coder_response_payload',
      schema,
      validator: validateCoderResponsePayload,
    }),
    resumeHandle: args.sessionHandle,
    logger: args.logger,
  });

  return {
    sessionHandle,
    payload: validateCoderResponsePayload(structured),
  };
}

export async function runBlockedRecoveryCoderRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  recoveryMarkdownPath: string;
  blockedReason: string;
  operatorGuidance: string;
  maxTurns: number;
  turnsTaken: number;
  terminalOnly?: boolean;
  allowReplacement?: boolean;
  sessionHandle?: string | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderBlockedRecoveryDispositionPayload }> {
  const progressText = await safeReadText(args.progressMarkdownPath);
  const schema = buildCoderBlockedRecoveryDispositionSchema();

  const { sessionHandle, structured } = await runCoderStructuredPrompt<CoderBlockedRecoveryDispositionPayload>({
    coder: args.coder,
    cwd: args.cwd,
    prompt: buildBlockedRecoveryCoderPrompt({
      planDoc: args.planDoc,
      progressText,
      recoveryMarkdownPath: args.recoveryMarkdownPath,
      blockedReason: args.blockedReason,
      operatorGuidance: args.operatorGuidance,
      maxTurns: args.maxTurns,
      turnsTaken: args.turnsTaken,
      terminalOnly: args.terminalOnly,
      allowReplacement: args.allowReplacement,
    }),
    schema,
    label: 'Coder blocked-recovery round',
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'coder_blocked_recovery_disposition_payload',
      schema,
      validator: validateCoderBlockedRecoveryDispositionPayload,
    }),
    resumeHandle: args.sessionHandle,
    logger: args.logger,
  });

  return {
    sessionHandle,
    payload: validateCoderBlockedRecoveryDispositionPayload(structured),
  };
}

export async function runCoderPlanResponseRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  openFindings: Pick<ReviewFinding, 'id' | 'source' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
  sessionHandle: string | null;
  reviewMode?: 'plan' | 'derived-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  planReviewGuidance?: NonNullable<PendingPlanReviewGuidance>;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderPlanResponsePayload }> {
  const schema = buildCoderPlanResponseSchema();
  const { sessionHandle, structured } = await runCoderStructuredPrompt<CoderPlanResponsePayload>({
    coder: args.coder,
    cwd: args.cwd,
    prompt: buildCoderPlanResponsePrompt(args),
    schema,
    label: 'Planner plan-response round',
    structuredJsonProtocol: buildStructuredJsonProtocolSpec({
      schemaLabel: 'coder_plan_response_payload',
      schema,
      validator: validateCoderPlanResponsePayload,
    }),
    toolPolicy: { allowedWritePaths: [args.planDoc], allowRun: false },
    resumeHandle: args.sessionHandle,
    telemetryLabel: 'planner',
    logger: args.logger,
  });

  return {
    sessionHandle,
    payload: validateCoderPlanResponsePayload(structured),
  };
}
