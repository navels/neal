import { readFile } from 'node:fs/promises';

import type { RunLogger } from '../logger.js';
import { AnthropicClaudeProviderError } from '../providers/anthropic-claude.js';
import { OpenAICodexProviderError } from '../providers/openai-codex.js';
import { getCoderAdapter, getStructuredAdvisorAdapter } from '../providers/registry.js';
import type {
  AgentRoleConfig,
  CoderConsultRequest,
  ExecuteScopeProgressJustification,
  ReviewFinding,
  ReviewerMeaningfulProgressVerdict,
  ReviewerConsultResponse,
  ScopeMarker,
} from '../types.js';
import {
  AUTONOMY_BLOCKED,
  AUTONOMY_CHUNK_DONE,
  AUTONOMY_DONE,
  AUTONOMY_SCOPE_DONE,
  AUTONOMY_SPLIT_PLAN,
  buildBlockedRecoveryCoderPrompt,
  buildCoderConsultResponsePrompt,
  buildCoderPlanResponsePrompt,
  buildCoderResponsePrompt,
  buildConsultReviewerPrompt,
  buildPlanReviewerPrompt,
  buildPlanningPrompt,
  buildReviewerPrompt,
  buildScopePrompt,
} from './prompts.js';
import {
  buildCoderBlockedRecoveryDispositionSchema,
  buildCoderConsultDispositionSchema,
  buildCoderPlanResponseSchema,
  buildCoderResponseSchema,
  buildConsultReviewerSchema,
  buildPlanReviewerSchema,
  buildReviewerSchema,
  parseCoderBlockedRecoveryDispositionPayload,
  parseCoderConsultDispositionPayload,
  parseCoderResponsePayload,
  parseExecuteScopeProgressPayload,
  stripExecuteScopeProgressPayload,
  type CoderBlockedRecoveryDispositionPayload,
  type CoderConsultDispositionPayload,
  type CoderResponsePayload,
  type PlanReviewerPayload,
  type ReviewerPayload,
} from './schemas.js';

export class ReviewerRoundError extends Error {
  readonly sessionHandle: string | null;
  readonly subtype: string | null;

  constructor(message: string, sessionHandle: string | null, subtype: string | null) {
    super(message);
    this.name = 'ReviewerRoundError';
    this.sessionHandle = sessionHandle;
    this.subtype = subtype;
  }
}

export class CoderRoundError extends Error {
  readonly sessionHandle: string | null;

  constructor(message: string, sessionHandle: string | null) {
    super(message);
    this.name = 'CoderRoundError';
    this.sessionHandle = sessionHandle;
  }
}

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
  if (error instanceof AnthropicClaudeProviderError) {
    return new ReviewerRoundError(error.message, error.sessionHandle, error.subtype);
  }
  if (error instanceof OpenAICodexProviderError) {
    return new ReviewerRoundError(error.message, error.sessionHandle, null);
  }
  return error;
}

function translateCoderProviderError(error: unknown): CoderRoundError | unknown {
  if (error instanceof OpenAICodexProviderError) {
    return new CoderRoundError(error.message, error.sessionHandle);
  }
  if (error instanceof AnthropicClaudeProviderError) {
    return new CoderRoundError(error.message, error.sessionHandle);
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

async function runReviewerStructuredRound<TStructured>(args: {
  reviewer: AgentRoleConfig;
  label: 'review' | 'plan-review' | 'consult';
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; structured: TStructured }> {
  try {
    const advisor = getStructuredAdvisorAdapter(args.reviewer);
    const result = await advisor.runStructuredRound<TStructured>({
      label: args.label,
      cwd: args.cwd,
      prompt: args.prompt,
      schema: args.schema,
      logger: args.logger,
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
  cwd: string;
  planDoc: string;
  baseCommit: string;
  headCommit: string;
  commits: string[];
  previousHeadCommit?: string | null;
  diffStat: string;
  diff: string;
  changedFiles: string[];
  round: number;
  reviewMarkdownPath: string;
  parentScopeLabel: string;
  progressJustification: ExecuteScopeProgressJustification;
  recentHistorySummary: string;
  logger?: RunLogger;
}): Promise<{
  sessionHandle: string | null;
  summary: string;
  findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>[];
  meaningfulProgress: ReviewerMeaningfulProgressVerdict;
}> {
  void args.diff;
  const { sessionHandle, structured } = await runReviewerStructuredRound<ReviewerPayload>({
    reviewer: args.reviewer,
    label: 'review',
    cwd: args.cwd,
    prompt: buildReviewerPrompt(args),
    schema: buildReviewerSchema(),
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
  cwd: string;
  planDoc: string;
  round: number;
  reviewMarkdownPath: string;
  mode?: 'plan' | 'derived-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  logger?: RunLogger;
}): Promise<{
  sessionHandle: string | null;
  summary: string;
  executionShape: PlanReviewerPayload['executionShape'];
  findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>[];
}> {
  const { sessionHandle, structured } = await runReviewerStructuredRound<PlanReviewerPayload>({
    reviewer: args.reviewer,
    label: 'plan-review',
    cwd: args.cwd,
    prompt: buildPlanReviewerPrompt(args),
    schema: buildPlanReviewerSchema(),
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
      files: finding.files,
      claim: finding.claim,
      requiredAction: finding.requiredAction,
      roundSummary: structured.summary,
    })),
  };
}

export async function runConsultReviewerRound(args: {
  reviewer: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  request: CoderConsultRequest;
  consultMarkdownPath: string;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; response: ReviewerConsultResponse }> {
  const { sessionHandle, structured } = await runReviewerStructuredRound<ReviewerConsultResponse>({
    reviewer: args.reviewer,
    label: 'consult',
    cwd: args.cwd,
    prompt: buildConsultReviewerPrompt(args),
    schema: buildConsultReviewerSchema(),
    logger: args.logger,
  });

  return {
    sessionHandle,
    response: structured,
  };
}

export async function runCoderScopeRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  sessionHandle?: string | null;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  logger?: RunLogger;
}): Promise<{
  sessionHandle: string | null;
  finalResponse: string;
  responseWithoutProgressPayload: string;
  marker: string | null;
  progressJustification: ExecuteScopeProgressJustification;
}> {
  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);
  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt: buildScopePrompt(args.planDoc, progressText),
      resumeHandle: args.sessionHandle,
      onSessionStarted: args.onSessionStarted,
      logger: args.logger,
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
  };
}

export async function runCoderPlanRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  sessionHandle?: string | null;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; finalResponse: string; marker: string | null }> {
  const coder = getCoderAdapter(args.coder);
  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt: buildPlanningPrompt(args.planDoc),
      resumeHandle: args.sessionHandle,
      onSessionStarted: args.onSessionStarted,
      logger: args.logger,
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
  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt: buildCoderResponsePrompt({
        planDoc: args.planDoc,
        progressText,
        verificationHint: args.verificationHint,
        openFindings: args.openFindings,
        mode: args.mode,
      }),
      resumeHandle: args.sessionHandle,
      outputSchema: buildCoderResponseSchema(),
      logger: args.logger,
    });
    finalResponse = result.finalResponse;
    sessionHandle = result.sessionHandle;
  } catch (error) {
    throw translateCoderProviderError(error);
  }
  const payload = parseCoderResponsePayload(finalResponse);
  const derivedPlan = payload.derivedPlan?.trim() ?? '';
  if (payload.outcome === 'split_plan' && !derivedPlan) {
    throw new Error('Coder response round returned outcome=split_plan without a derivedPlan payload.');
  }

  if (payload.outcome !== 'split_plan' && derivedPlan) {
    throw new Error('Coder response round returned a derivedPlan payload without outcome=split_plan.');
  }

  return {
    sessionHandle,
    payload,
  };
}

export async function runCoderConsultResponseRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  consultMarkdownPath: string;
  request: CoderConsultRequest;
  response: ReviewerConsultResponse;
  sessionHandle?: string | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderConsultDispositionPayload }> {
  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt: buildCoderConsultResponsePrompt({
        planDoc: args.planDoc,
        progressText,
        consultMarkdownPath: args.consultMarkdownPath,
        request: args.request,
        response: args.response,
      }),
      resumeHandle: args.sessionHandle,
      outputSchema: buildCoderConsultDispositionSchema(),
      logger: args.logger,
    });
    finalResponse = result.finalResponse;
    sessionHandle = result.sessionHandle;
  } catch (error) {
    throw translateCoderProviderError(error);
  }
  const payload = parseCoderConsultDispositionPayload(finalResponse);

  return {
    sessionHandle,
    payload,
  };
}

export async function runBlockedRecoveryCoderRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  consultMarkdownPath: string;
  blockedReason: string;
  operatorGuidance: string;
  maxTurns: number;
  turnsTaken: number;
  terminalOnly?: boolean;
  sessionHandle?: string | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderBlockedRecoveryDispositionPayload }> {
  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt: buildBlockedRecoveryCoderPrompt({
        planDoc: args.planDoc,
        progressText,
        consultMarkdownPath: args.consultMarkdownPath,
        blockedReason: args.blockedReason,
        operatorGuidance: args.operatorGuidance,
        maxTurns: args.maxTurns,
        turnsTaken: args.turnsTaken,
        terminalOnly: args.terminalOnly,
      }),
      resumeHandle: args.sessionHandle,
      outputSchema: buildCoderBlockedRecoveryDispositionSchema(),
      logger: args.logger,
    });
    finalResponse = result.finalResponse;
    sessionHandle = result.sessionHandle;
  } catch (error) {
    throw translateCoderProviderError(error);
  }
  const payload = parseCoderBlockedRecoveryDispositionPayload(finalResponse);

  return {
    sessionHandle,
    payload,
  };
}

export async function runCoderPlanResponseRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  openFindings: Pick<ReviewFinding, 'id' | 'source' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  mode?: 'blocking' | 'optional';
  sessionHandle: string;
  reviewMode?: 'plan' | 'derived-plan';
  parentPlanDoc?: string;
  derivedFromScopeNumber?: number | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderResponsePayload }> {
  const coder = getCoderAdapter(args.coder);

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt: buildCoderPlanResponsePrompt(args),
      resumeHandle: args.sessionHandle,
      outputSchema: buildCoderPlanResponseSchema(),
      logger: args.logger,
    });
    finalResponse = result.finalResponse;
    sessionHandle = result.sessionHandle;
  } catch (error) {
    throw translateCoderProviderError(error);
  }
  const payload = parseCoderResponsePayload(finalResponse);

  return {
    sessionHandle,
    payload,
  };
}
