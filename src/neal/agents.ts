import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { Codex, type Thread } from '@openai/codex-sdk';

import type { RunLogger } from './logger.js';
import type { ExecutionMode, ReviewFinding } from './types.js';

const AUTONOMY_CHUNK_DONE = 'AUTONOMY_CHUNK_DONE';
const AUTONOMY_DONE = 'AUTONOMY_DONE';
const AUTONOMY_BLOCKED = 'AUTONOMY_BLOCKED';
const DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS = Number(process.env.CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS ?? 600_000);
const DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS = Number(process.env.CODEX_INACTIVITY_TIMEOUT_MS ?? 600_000);
const DEFAULT_CLAUDE_MAX_TURNS = Number(process.env.CLAUDE_REVIEW_MAX_TURNS ?? 100);
const DEFAULT_CLAUDE_CONTINUATION_LIMIT = Number(process.env.CLAUDE_REVIEW_CONTINUATION_LIMIT ?? 2);
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
    'Make the final plan explicit about execution mode, allowed scope, forbidden paths, implementation steps, verification, completion criteria, blocker handling, and any chunking rules.',
    'If the plan is one-shot, say so directly and do not leave chunk-only markers or backlog instructions in place.',
    'If the plan is chunked, make chunk selection and completion rules explicit.',
    'If critical information is missing, do not invent it. Surface the concrete missing questions in your final response.',
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

function buildOneShotPrompt(planDoc: string, progressMarkdownPath: string) {
  return [
    `Continue autonomously on the task described in ${planDoc}.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    `2. Read ${progressMarkdownPath}.`,
    '3. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '4. Reset your instructions for this turn from the current contents of the plan, the progress doc, and required context.',
    '',
    'Then complete the plan end-to-end if feasible.',
    'Verify the relevant work before you finish.',
    'Create real git commit(s) for completed work.',
    `Read ${progressMarkdownPath} for status, but do not edit or stage it.`,
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

function buildChunkedPrompt(planDoc: string, progressMarkdownPath: string) {
  return [
    `Continue autonomously on the task described in ${planDoc}.`,
    '',
    'Before doing anything else:',
    `1. Read ${planDoc}.`,
    `2. Read ${progressMarkdownPath}.`,
    '3. Read any companion docs or required-context files explicitly referenced by that plan before starting work.',
    '4. Reset your instructions for this turn from the current contents of the plan, the progress doc, and required context.',
    '',
    'Then execute exactly one meaningful chunk.',
    'Do not start a second chunk in this turn.',
    'This chunk must end with a real git commit if work was completed.',
    `Read ${progressMarkdownPath} for status, but do not edit or stage it.`,
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Treat AUTONOMY_BLOCKED as a last resort, not an early exit.',
    '',
    'Final line must be exactly one of:',
    `- ${AUTONOMY_CHUNK_DONE}`,
    `- ${AUTONOMY_DONE}`,
    `- ${AUTONOMY_BLOCKED}`,
  ].join('\n');
}

function extractMarker(message: string) {
  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === AUTONOMY_CHUNK_DONE || line === AUTONOMY_DONE || line === AUTONOMY_BLOCKED) {
      return line;
    }
  }

  return null;
}

function writeDiagnostic(message: string, logger?: RunLogger) {
  process.stderr.write(message);
  void logger?.stderr(message);
}

async function consumeCodexTurn(
  turn: Awaited<ReturnType<Thread['runStreamed']>>,
  logger?: RunLogger,
  onThreadStarted?: (threadId: string) => void | Promise<void>,
) {
  let finalResponse = '';
  let fatalError: string | null = null;
  let threadId: string | null = null;
  const iterator = turn.events[Symbol.asyncIterator]();

  while (true) {
    let next;
    try {
      next = await nextWithTimeout(iterator.next(), DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS, 'codex');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CodexRoundError(message, threadId);
    }
    if (next.done) {
      break;
    }

    const event = next.value;
    switch (event.type) {
      case 'thread.started':
        threadId = event.thread_id;
        writeDiagnostic(`[codex] thread ${event.thread_id}\n`, logger);
        void logger?.event('codex.thread_started', { threadId: event.thread_id });
        await onThreadStarted?.(event.thread_id);
        break;
      case 'item.completed':
        if (event.item.type === 'command_execution') {
          writeDiagnostic(`\n$ ${event.item.command}\n`, logger);
          void logger?.event('codex.command_execution', { command: event.item.command });
          if (event.item.aggregated_output) {
            writeDiagnostic(`${event.item.aggregated_output}\n`, logger);
          }
        } else if (event.item.type === 'file_change' && event.item.changes.length > 0) {
          const files = event.item.changes.map((change) => change.path);
          writeDiagnostic(`[codex] files ${files.join(', ')}\n`, logger);
          void logger?.event('codex.file_change', { files });
        } else if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }
        break;
      case 'turn.failed':
        fatalError = event.error.message;
        writeDiagnostic(`[codex:error] ${event.error.message}\n`, logger);
        void logger?.event('codex.turn_failed', { message: event.error.message });
        break;
      case 'error':
        fatalError = event.message;
        writeDiagnostic(`[codex:error] ${event.message}\n`, logger);
        void logger?.event('codex.error', { message: event.message });
        break;
      default:
        break;
    }
  }

  if (fatalError) {
    throw new CodexRoundError(fatalError, threadId);
  }

  return finalResponse;
}

type ClaudeFindingPayload = {
  severity: 'blocking' | 'non_blocking';
  files: string[];
  claim: string;
  requiredAction: string;
};

type ClaudeReviewPayload = {
  summary: string;
  findings: ClaudeFindingPayload[];
};

type CodexResponsePayload = {
  outcome: 'responded' | 'blocked';
  summary: string;
  blocker?: string;
  responses: Array<{
    id: string;
    decision: 'fixed' | 'rejected' | 'deferred';
    summary: string;
  }>;
};

export class ClaudeRoundError extends Error {
  readonly sessionId: string | null;
  readonly subtype: string | null;

  constructor(message: string, sessionId: string | null, subtype: string | null) {
    super(message);
    this.name = 'ClaudeRoundError';
    this.sessionId = sessionId;
    this.subtype = subtype;
  }
}

export class CodexRoundError extends Error {
  readonly threadId: string | null;

  constructor(message: string, threadId: string | null) {
    super(message);
    this.name = 'CodexRoundError';
    this.threadId = threadId;
  }
}

function parseCodexResponsePayload(raw: string): CodexResponsePayload {
  try {
    return JSON.parse(raw) as CodexResponsePayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex response round returned invalid JSON: ${message}\nRaw response:\n${raw}`);
  }
}

function logClaudeMessage(label: string, message: SDKMessage, logger?: RunLogger) {
  switch (message.type) {
    case 'tool_progress':
      writeDiagnostic(`[claude:${label}] tool ${message.tool_name} running (${message.elapsed_time_seconds}s)\n`, logger);
      void logger?.event('claude.tool_progress', {
        label,
        toolName: message.tool_name,
        elapsedTimeSeconds: message.elapsed_time_seconds,
      });
      break;
    case 'tool_use_summary':
      writeDiagnostic(`[claude:${label}] ${message.summary}\n`, logger);
      void logger?.event('claude.tool_use_summary', { label, summary: message.summary });
      break;
    case 'system':
      switch (message.subtype) {
        case 'task_started':
          writeDiagnostic(`[claude:${label}] task started: ${message.description}\n`, logger);
          void logger?.event('claude.task_started', { label, description: message.description });
          break;
        case 'task_progress':
          writeDiagnostic(`[claude:${label}] ${message.description}\n`, logger);
          void logger?.event('claude.task_progress', { label, description: message.description });
          break;
        case 'task_notification':
          writeDiagnostic(`[claude:${label}] task ${message.status}: ${message.summary}\n`, logger);
          void logger?.event('claude.task_notification', { label, status: message.status, summary: message.summary });
          break;
        case 'status':
          if (message.status) {
            writeDiagnostic(`[claude:${label}] status: ${message.status}\n`, logger);
            void logger?.event('claude.status', { label, status: message.status });
          }
          break;
        default:
          break;
      }
      break;
    case 'result':
      writeDiagnostic(`[claude:${label}] result: ${message.subtype}\n`, logger);
      void logger?.event('claude.result', { label, subtype: message.subtype });
      break;
    default:
      break;
  }
}

async function nextWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      const prefix = label === 'codex' ? 'Codex' : 'Claude';
      rejectPromise(new Error(`${prefix} ${label} timed out after ${Math.round(timeoutMs / 1000)}s without progress`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function collectClaudeResult(stream: AsyncGenerator<SDKMessage, void>, label: string, timeoutMs = DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS, logger?: RunLogger) {
  let sessionId: string | null = null;
  let lastResult: SDKResultMessage | null = null;
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    const next = await nextWithTimeout(iterator.next(), timeoutMs, label);
    if (next.done) {
      break;
    }

    const message = next.value;
    sessionId = sessionId ?? message.session_id ?? null;
    logClaudeMessage(label, message, logger);
    if (message.type === 'result') {
      lastResult = message;
    }
  }

  return { sessionId, lastResult };
}

function buildClaudeQueryStream(
  prompt: string,
  label: string,
  cwd: string,
  schema: Record<string, unknown>,
  logger?: RunLogger,
  resumeSessionId?: string | null,
) {
  return query({
    prompt,
    options: {
      cwd,
      tools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: DEFAULT_CLAUDE_MAX_TURNS,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      stderr: (data) => {
        writeDiagnostic(`[claude:${label}:stderr] ${data}`, logger);
      },
      outputFormat: {
        type: 'json_schema',
        schema,
      },
    },
  });
}

async function runClaudeStructuredRound(args: {
  label: 'review' | 'plan-review';
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  logger?: RunLogger;
}): Promise<{ sessionId: string | null; structured: ClaudeReviewPayload }> {
  let sessionId: string | null = null;
  let attempt = 0;
  let lastResult: SDKResultMessage | null = null;

  while (attempt <= DEFAULT_CLAUDE_CONTINUATION_LIMIT) {
    const prompt =
      attempt === 0
        ? args.prompt
        : [
            'Continue the same review session.',
            'Do not restart the investigation from scratch.',
            'Present your final structured findings now. If there are no findings, return an empty findings array.',
          ].join('\n');
    const stream = buildClaudeQueryStream(prompt, args.label, args.cwd, args.schema, args.logger, sessionId);
    const result = await collectClaudeResult(stream, args.label, DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS, args.logger);

    sessionId = result.sessionId ?? sessionId;
    lastResult = result.lastResult;
    const structured = (lastResult as { structured_output?: ClaudeReviewPayload } | null)?.structured_output;
    if (structured) {
      return { sessionId, structured };
    }

    const subtype = lastResult?.subtype ?? null;
    if (subtype !== 'error_max_turns' || !sessionId || attempt === DEFAULT_CLAUDE_CONTINUATION_LIMIT) {
      throw new ClaudeRoundError(
        `Claude ${args.label} did not return a successful result${subtype ? ` (${subtype})` : ''}`,
        sessionId,
        subtype,
      );
    }

    writeDiagnostic(
      `[claude:${args.label}] max turns reached without structured findings; continuing same session (${attempt + 1}/${DEFAULT_CLAUDE_CONTINUATION_LIMIT})\n`,
      args.logger,
    );
    void args.logger?.event('claude.review_continuation', {
      label: args.label,
      sessionId,
      attempt: attempt + 1,
      continuationLimit: DEFAULT_CLAUDE_CONTINUATION_LIMIT,
    });
    attempt += 1;
  }

  throw new ClaudeRoundError(`Claude ${args.label} did not return structured output`, sessionId, lastResult?.subtype ?? null);
}

export async function runClaudeReviewRound(args: {
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
  logger?: RunLogger;
}): Promise<{ sessionId: string | null; summary: string; findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'codexDisposition' | 'codexCommit'>[] }> {
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
    `Review the codex chunk for plan ${args.planDoc}.`,
    `Review round: ${args.round}.`,
    `Commit range: ${args.baseCommit}..${args.headCommit}.`,
    'Review that commit range directly with repository tools. The commit range is the source of truth for this review.',
    '',
    'Produce only structured review findings.',
    'Use blocking severity for correctness, regression, or missing-verification issues.',
    'Use non_blocking severity for suggestions that do not block acceptance.',
    'Only emit non_blocking findings when they identify a concrete maintenance, observability, or testability issue that is genuinely worth a later follow-up turn.',
    'Do not emit non_blocking findings for formatting, whitespace, naming preferences, trivial code-shape preferences, or optional refactors.',
    'If the chunk is acceptable aside from low-signal trivia, return no finding rather than a non_blocking note.',
    'Do not infer that verification was skipped merely because this prompt does not embed full terminal output. Treat missing verification as a finding only when the repository state, plan requirements, or review history give concrete evidence that required verification was not run or was insufficient.',
    args.previousHeadCommit
      ? `Previous Claude review head was ${args.previousHeadCommit}. Focus especially on changes since that commit, while still considering the full current state.`
      : 'This is the first Claude review round for this chunk.',
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
    `Prior review history is available at ${args.reviewMarkdownPath} if you need earlier Claude findings or Codex responses, but review the current commit range directly.`,
  ].join('\n');

  const { sessionId, structured } = await runClaudeStructuredRound({
    label: 'review',
    cwd: args.cwd,
    prompt,
    schema,
    logger: args.logger,
  });

  return {
    sessionId,
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

export async function runClaudePlanReviewRound(args: {
  cwd: string;
  planDoc: string;
  round: number;
  reviewMarkdownPath: string;
  logger?: RunLogger;
}): Promise<{ sessionId: string | null; summary: string; findings: Omit<ReviewFinding, 'id' | 'canonicalId' | 'status' | 'codexDisposition' | 'codexCommit'>[] }> {
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
    'Focus on whether the plan is now a clean future execution plan, explicit about one_shot vs chunked mode, and clear about verification and completion.',
    `Read ${args.reviewMarkdownPath} before finalizing findings so you can inspect prior review history and Codex responses.`,
    '',
    'Use repository tools to inspect the current plan and any directly referenced companion docs before finalizing findings.',
  ].join('\n');

  const { sessionId, structured } = await runClaudeStructuredRound({
    label: 'plan-review',
    cwd: args.cwd,
    prompt,
    schema,
    logger: args.logger,
  });

  return {
    sessionId,
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

function createCodexThread(cwd: string, threadId?: string | null): Thread {
  const codex = new Codex();
  return threadId
    ? codex.resumeThread(threadId)
    : codex.startThread({
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
        workingDirectory: cwd,
      });
}

export async function runCodexChunkRound(args: {
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  executionMode: ExecutionMode;
  threadId?: string | null;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  logger?: RunLogger;
}): Promise<{ threadId: string | null; finalResponse: string; marker: string | null }> {
  const thread = createCodexThread(args.cwd, args.threadId);
  const prompt =
    args.executionMode === 'one_shot'
      ? buildOneShotPrompt(args.planDoc, args.progressMarkdownPath)
      : buildChunkedPrompt(args.planDoc, args.progressMarkdownPath);
  const streamedTurn = await thread.runStreamed(prompt);
  const finalResponse = await consumeCodexTurn(streamedTurn, args.logger, args.onThreadStarted);
  const marker = extractMarker(finalResponse);

  return {
    threadId: thread.id,
    finalResponse,
    marker,
  };
}

export async function runCodexPlanRound(args: {
  cwd: string;
  planDoc: string;
  threadId?: string | null;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  logger?: RunLogger;
}): Promise<{ threadId: string | null; finalResponse: string; marker: string | null }> {
  const thread = createCodexThread(args.cwd, args.threadId);
  const streamedTurn = await thread.runStreamed(buildPlanningPrompt(args.planDoc));
  const finalResponse = await consumeCodexTurn(streamedTurn, args.logger, args.onThreadStarted);
  const marker = extractMarker(finalResponse);

  return {
    threadId: thread.id,
    finalResponse,
    marker,
  };
}

export async function runCodexResponseRound(args: {
  cwd: string;
  planDoc: string;
  progressMarkdownPath: string;
  verificationHint: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  threadId: string;
  logger?: RunLogger;
}): Promise<{ threadId: string | null; payload: CodexResponsePayload }> {
  const thread = createCodexThread(args.cwd, args.threadId);

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
    `Read ${args.progressMarkdownPath} before changing code so you stay on the current implementation scope.`,
    'Do not edit or stage wrapper-owned artifacts such as review files under .neal/runs/, PLAN_PROGRESS.md, plan-progress.json, or .neal/*.',
    'Address the currently open review findings provided below.',
    'You are still working on the same chunk. Do not start a new chunk.',
    args.verificationHint,
    'Make code changes if needed, run the most relevant verification for the fixes you make, and create a real git commit if you changed code.',
    'Use `fixed` only when you actually changed the code or verification in a way that resolves the finding.',
    'Use `rejected` only when the finding is incorrect and your summary explains why.',
    'Use `deferred` only when the finding is real but not safe to resolve inside this chunk.',
    'Always include a `blocker` string. Use an empty string when outcome=`responded`.',
    'If you truly cannot continue, return outcome=`blocked` and explain the blocker in `blocker`.',
    '',
    'Open findings:',
    JSON.stringify(args.openFindings, null, 2),
  ].join('\n');

  const streamedTurn = await thread.runStreamed(prompt, {
    outputSchema: schema,
  });
  const finalResponse = await consumeCodexTurn(streamedTurn, args.logger);
  const payload = parseCodexResponsePayload(finalResponse);

  return {
    threadId: thread.id,
    payload,
  };
}

export async function runCodexPlanResponseRound(args: {
  cwd: string;
  planDoc: string;
  openFindings: Pick<ReviewFinding, 'id' | 'claim' | 'requiredAction' | 'severity' | 'files' | 'roundSummary'>[];
  threadId: string;
  logger?: RunLogger;
}): Promise<{ threadId: string | null; payload: CodexResponsePayload }> {
  const thread = createCodexThread(args.cwd, args.threadId);

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

  const streamedTurn = await thread.runStreamed(prompt, {
    outputSchema: schema,
  });
  const finalResponse = await consumeCodexTurn(streamedTurn, args.logger);
  const payload = parseCodexResponsePayload(finalResponse);

  return {
    threadId: thread.id,
    payload,
  };
}
