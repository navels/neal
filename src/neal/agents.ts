import { readFile } from 'node:fs/promises';

import type { RunLogger } from './logger.js';
import { AnthropicClaudeProviderError } from './providers/anthropic-claude.js';
import { OpenAICodexProviderError } from './providers/openai-codex.js';
import { getCoderAdapter, getStructuredAdvisorAdapter } from './providers/registry.js';
import type { AgentRoleConfig, CoderConsultDisposition, CoderConsultRequest, ReviewFinding, ReviewerConsultResponse, ScopeMarker } from './types.js';

const AUTONOMY_SCOPE_DONE = 'AUTONOMY_SCOPE_DONE';
const AUTONOMY_CHUNK_DONE = 'AUTONOMY_CHUNK_DONE';
const AUTONOMY_DONE = 'AUTONOMY_DONE';
const AUTONOMY_BLOCKED = 'AUTONOMY_BLOCKED';

function buildPlanningPrompt(planDoc: string) {
  return [
    `Rewrite the draft plan document at ${planDoc} into a future execution plan for neal.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    '2. Read any companion docs explicitly referenced by that plan.',
    '3. Reset your instructions for this turn from the current contents of the plan and referenced context.',
    '',
    'Then revise only plan-related artifacts.',
    'Do not edit runtime source code outside the plan itself and adjacent planning notes.',
    'Do not make git commits.',
    'Your output must be a pure future execution plan, not a planning-task checklist.',
    'Replace the draft in place so the resulting file is meant to be run later with neal --execute, not neal --plan.',
    'Do not leave planning-only scaffolding in the final file. Remove or replace sections such as planning mode instructions, Required Inputs for the planner, Verification For This Planning Task, and Completion Criteria For This Planning Task.',
    'Ground the plan in the actual current repository state. Inspect the real target files and write steps against the symbols, exports, and file structure that actually exist.',
    'Do not leave avoidable ambiguity in the plan when the repository already answers the question. Name concrete target functions, files, and exports when they are knowable from the repo.',
    'Do not ask the future executor to perform redundant edits. If an export already propagates through an existing barrel file, say to verify that behavior instead of adding a fake extra edit step.',
    'Make the final plan explicit about scope boundaries, allowed scope, forbidden paths, implementation steps, verification, completion criteria, blocker handling, and any repeated-scope selection rules.',
    'If the plan should complete in one scope, say so directly.',
    'If the plan requires multiple scopes, make scope selection and completion rules explicit.',
    'If critical information is missing, do not invent it. Surface the concrete missing questions in your final response.',
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

function buildProgressSection(progressText: string) {
  return progressText.trim() || '(no current progress summary available)';
}

function buildScopePrompt(planDoc: string, progressText: string) {
  return [
    `Continue autonomously on the task described in ${planDoc}.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    '2. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '3. Reset your instructions for this turn from the current contents of the plan, the inlined progress state below, and required context.',
    '',
    'Then execute exactly one implementation scope.',
    'Do not start a second scope in this turn.',
    'If this scope completes the entire plan, return AUTONOMY_DONE. If more scopes remain, return AUTONOMY_SCOPE_DONE.',
    'Verify the relevant work before you finish.',
    'Create real git commit(s) for completed work.',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
    '',
    'Current progress state:',
    buildProgressSection(progressText),
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_SCOPE_DONE}`,
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

function extractMarker(message: string): ScopeMarker | null {
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === AUTONOMY_SCOPE_DONE || line === AUTONOMY_CHUNK_DONE || line === AUTONOMY_DONE || line === AUTONOMY_BLOCKED) {
      return line as ScopeMarker;
    }
  }

  return null;
}

type ReviewerFindingPayload = {
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  requiredAction: string;
};

type ReviewerPayload = {
  summary: string;
  findings: ReviewerFindingPayload[];
};

type CoderResponsePayload = {
  outcome: 'responded' | 'blocked';
  summary: string;
  blocker?: string;
  responses: Array<{
    id: string;
    decision: 'fixed' | 'rejected' | 'deferred';
    summary: string;
  }>;
};

type CoderConsultDispositionPayload = CoderConsultDisposition;

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

function parseCoderResponsePayload(raw: string): CoderResponsePayload {
  try {
    return JSON.parse(raw) as CoderResponsePayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Coder response round returned invalid JSON: ${message}\nRaw response:\n${raw}`);
  }
}

function parseCoderConsultDispositionPayload(raw: string): CoderConsultDispositionPayload {
  try {
    return JSON.parse(raw) as CoderConsultDispositionPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Coder consult-response round returned invalid JSON: ${message}\nRaw response:\n${raw}`);
  }
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

async function runReviewerStructuredRound(args: {
  reviewer: AgentRoleConfig;
  label: 'review' | 'plan-review' | 'consult';
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; structured: ReviewerPayload }> {
  try {
    const advisor = getStructuredAdvisorAdapter(args.reviewer);
    const result = await advisor.runStructuredRound<ReviewerPayload>({
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
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; summary: string; findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>[] }> {
  const changedFilesText = args.changedFiles.length > 0 ? args.changedFiles.join('\n') : '(no changed files)';
  const commitsText = args.commits.length > 0 ? args.commits.join('\n') : '(no commits recorded)';

  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocking', 'non_blocking'] },
            files: { type: 'array', items: { type: 'string' } },
            claim: { type: 'string' },
            requiredAction: { type: 'string' },
          },
          required: ['severity', 'files', 'claim', 'requiredAction'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'findings'],
    additionalProperties: false,
  } as const;

  const prompt = [
    `Review the current scope for plan ${args.planDoc}.`,
    `Review round: ${args.round}.`,
    `Commit range: ${args.baseCommit}..${args.headCommit}.`,
    'Review that commit range directly with repository tools. The commit range is the source of truth for this review.',
    '',
    'Produce only structured review findings.',
    'Use blocking severity for correctness, regression, or missing-verification issues.',
    'Use non_blocking severity for suggestions that do not block acceptance.',
    'Only emit non_blocking findings when they identify a concrete maintenance, observability, or testability issue that is genuinely worth a later follow-up turn.',
    'Do not emit non_blocking findings for formatting, whitespace, naming preferences, trivial code-shape preferences, or optional refactors.',
    'If the scope is acceptable aside from low-signal trivia, return no finding rather than a non_blocking note.',
    'Do not infer that verification was skipped merely because this prompt does not embed full terminal output. Treat missing verification as a finding only when the repository state, plan requirements, or review history give concrete evidence that required verification was not run or was insufficient.',
    args.previousHeadCommit
      ? `Previous reviewer head was ${args.previousHeadCommit}. Focus especially on changes since that commit, while still considering the full current state.`
      : 'This is the first reviewer round for this scope.',
    '',
    'Commits in scope:',
    commitsText,
    '',
    'Diff stat:',
    args.diffStat || '(no diff stat)',
    '',
    'Changed files:',
    changedFilesText,
    '',
    `Prior review history is available at ${args.reviewMarkdownPath} if you need earlier reviewer findings or coder responses, but review the current commit range directly.`,
  ].join('\n');

  const { sessionHandle, structured } = await runReviewerStructuredRound({
    reviewer: args.reviewer,
    label: 'review',
    cwd: args.cwd,
    prompt,
    schema,
    logger: args.logger,
  });

  return {
    sessionHandle,
    summary: structured.summary,
    findings: structured.findings.map((finding) => ({
      round: args.round,
      severity: finding.severity,
      files: finding.files,
      claim: finding.claim,
      requiredAction: finding.requiredAction,
      roundSummary: structured.summary,
    })),
  };
}

export async function runPlanReviewerRound(args: {
  reviewer: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  round: number;
  reviewMarkdownPath: string;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; summary: string; findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'coderDisposition' | 'coderCommit'>[] }> {
  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocking', 'non_blocking'] },
            files: { type: 'array', items: { type: 'string' } },
            claim: { type: 'string' },
            requiredAction: { type: 'string' },
          },
          required: ['severity', 'files', 'claim', 'requiredAction'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'findings'],
    additionalProperties: false,
  } as const;

  const prompt = [
    `Review the plan document at ${args.planDoc}.`,
    `Review round: ${args.round}.`,
    '',
    'Produce only structured review findings.',
    'Use blocking severity for missing information or plan structure that would prevent neal from executing safely.',
    'Treat leftover planning-task scaffolding as blocking. A final plan must not still describe how to revise itself, how to run neal --plan, or how to validate the planning task.',
    'Examples of blocking leftover scaffolding include planning-mode execution headers, planner-only required-input sections, "Verification For This Planning Task", and "Completion Criteria For This Planning Task".',
    'Use non_blocking severity for clarity improvements that do not block execution.',
    'Call out plan steps that are avoidably ambiguous or redundant when the current repository already provides a more specific answer, such as existing function names, current exports, or barrel re-export behavior.',
    'Focus on whether the plan is now a clean future execution plan, explicit about single-scope vs repeated-scope behavior, and clear about verification and completion.',
    `Read ${args.reviewMarkdownPath} before finalizing findings so you can inspect prior review history and coder responses.`,
    '',
    'Use repository tools to inspect the current plan and any directly referenced companion docs before finalizing findings.',
  ].join('\n');

  const { sessionHandle, structured } = await runReviewerStructuredRound({
    reviewer: args.reviewer,
    label: 'plan-review',
    cwd: args.cwd,
    prompt,
    schema,
    logger: args.logger,
  });

  return {
    sessionHandle,
    summary: structured.summary,
    findings: structured.findings.map((finding) => ({
      round: args.round,
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
  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      diagnosis: { type: 'string' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      recoverable: { type: 'boolean' },
      recommendations: { type: 'array', items: { type: 'string' } },
      relevantFiles: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    },
    required: ['summary', 'diagnosis', 'confidence', 'recoverable', 'recommendations', 'relevantFiles', 'rationale'],
    additionalProperties: false,
  } as const;

  const prompt = [
    `Handle a blocker consultation for the active neal scope in ${args.planDoc}.`,
    'This is a blocker consultation, not a code review.',
    'The coder remains the implementation owner. Your job is to diagnose the blocker and recommend bounded next steps.',
    'Do not expand scope unnecessarily.',
    'You are not allowed to grant policy exceptions, authorize baseline failures, waive verification gates, or reinterpret the plan on behalf of the user or wrapper.',
    'If the blocker would require explicit user or wrapper authorization, say that directly. You may recommend asking for authorization, but you must not treat it as already granted.',
    'Do not tell the coder to consider a failure "allowed", "authorized", or "baseline" unless that authorization is already explicitly present in the blocker request or the referenced plan/context.',
    `Read ${args.consultMarkdownPath} if you need prior consult history.`,
    '',
    'Current blocker request:',
    JSON.stringify(args.request, null, 2),
    '',
    'Use repository inspection only as needed. Prefer concrete, file-specific advice.',
  ].join('\n');

  const { sessionHandle, structured } = await runReviewerStructuredRound({
    reviewer: args.reviewer,
    label: 'consult',
    cwd: args.cwd,
    prompt,
    schema,
    logger: args.logger,
  });

  return {
    sessionHandle,
    response: structured as unknown as ReviewerConsultResponse,
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
}): Promise<{ sessionHandle: string | null; finalResponse: string; marker: string | null }> {
  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);
  const prompt = buildScopePrompt(args.planDoc, progressText);
  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt,
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
  sessionHandle?: string | null;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderResponsePayload }> {
  const coder = getCoderAdapter(args.coder);
  const progressText = await safeReadText(args.progressMarkdownPath);

  const schema = {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['responded', 'blocked'] },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      responses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            decision: { type: 'string', enum: ['fixed', 'rejected', 'deferred'] },
            summary: { type: 'string' },
          },
          required: ['id', 'decision', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['outcome', 'summary', 'blocker', 'responses'],
    additionalProperties: false,
  } as const;

  const prompt = [
    `Continue autonomously on the task described in ${args.planDoc}.`,
    '',
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Address the currently open review findings provided below.',
    'You are still working on the same scope. Do not start a new scope.',
    'Stay on the current implementation scope described by the inlined progress state below.',
    args.verificationHint,
    'Make code changes if needed, run the most relevant verification for the fixes you make, and create a real git commit if you changed code.',
    'Use `fixed` only when you actually changed the code or verification in a way that resolves the finding.',
    'Use `rejected` only when the finding is incorrect and your summary explains why.',
    'Use `deferred` only when the finding is real but not safe to resolve inside this scope.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    'If you truly cannot continue, return outcome=`blocked` and explain the blocker in `blocker`.',
    '',
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
    '',
    'Current progress state:',
    buildProgressSection(progressText),
  ].join('\n');

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt,
      resumeHandle: args.sessionHandle,
      outputSchema: schema,
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

  const schema = {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['resumed', 'blocked'] },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      decision: { type: 'string', enum: ['followed', 'partially_followed', 'rejected'] },
      rationale: { type: 'string' },
    },
    required: ['outcome', 'summary', 'blocker', 'decision', 'rationale'],
    additionalProperties: false,
  } as const;

  const prompt = [
    `Continue the current neal scope for plan ${args.planDoc}.`,
    `Read ${args.consultMarkdownPath} before responding so you understand the current blocker context.`,
    'Use the inlined progress state below to stay on the current scope.',
    'You are still working on the same scope. Do not start a new scope.',
    'Use reviewer advisory feedback below to continue the same scope if possible.',
    'Reviewer consult advice is advisory only. It does not authorize policy exceptions, baseline failures, skipped verification, or plan reinterpretation.',
    'If continuing would require a new allowed-failure baseline or any other explicit user/wrapper authorization that is not already present in the plan or wrapper-owned artifacts, you must remain blocked.',
    'Make code changes if needed, run relevant verification, and create a real git commit if you changed code.',
    'Return outcome=`resumed` if you followed the advice enough to continue the scope.',
    'Return outcome=`blocked` only if the blocker is still real after reasonable follow-through.',
    '',
    'Coder blocker request:',
    JSON.stringify(args.request, null, 2),
    '',
    'Reviewer consultation response:',
    JSON.stringify(args.response, null, 2),
    '',
    'Current progress state:',
    buildProgressSection(progressText),
  ].join('\n');

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt,
      resumeHandle: args.sessionHandle,
      outputSchema: schema,
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

export async function runCoderPlanResponseRound(args: {
  coder: AgentRoleConfig;
  cwd: string;
  planDoc: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  sessionHandle: string;
  logger?: RunLogger;
}): Promise<{ sessionHandle: string | null; payload: CoderResponsePayload }> {
  const coder = getCoderAdapter(args.coder);

  const schema = {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['responded', 'blocked'] },
      summary: { type: 'string' },
      blocker: { type: 'string' },
      responses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            decision: { type: 'string', enum: ['fixed', 'rejected', 'deferred'] },
            summary: { type: 'string' },
          },
          required: ['id', 'decision', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['outcome', 'summary', 'blocker', 'responses'],
    additionalProperties: false,
  } as const;

  const prompt = [
    `Continue rewriting the draft plan document at ${args.planDoc} into a future execution plan.`,
    '',
    'Address the currently open review findings provided below.',
    'Edit only the plan document and directly related planning artifacts.',
    'Do not edit runtime source code.',
    'Do not make git commits.',
    'The final file must be a pure future execution plan for neal --execute.',
    'Do not leave planning-task scaffolding behind after you respond to the findings.',
    'Where the current repository already answers an implementation detail, revise the plan to use the concrete existing symbol names and exports instead of leaving generic or redundant instructions.',
    'Use `fixed` only when you actually revised the plan to resolve the finding.',
    'Use `rejected` only when the finding is incorrect and your summary explains why.',
    'Use `deferred` only when the finding is real but not safe to resolve without user input.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    'If required information is missing, return outcome=`blocked` and explain the concrete questions in `blocker`.',
    '',
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
  ].join('\n');

  let finalResponse: string;
  let sessionHandle: string | null;
  try {
    const result = await coder.runPrompt({
      cwd: args.cwd,
      prompt,
      resumeHandle: args.sessionHandle,
      outputSchema: schema,
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
