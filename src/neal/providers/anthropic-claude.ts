import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import type { RunLogger } from '../logger.js';
import type {
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from './types.js';

const DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS = Number(process.env.CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS ?? 600_000);
const DEFAULT_CLAUDE_MAX_TURNS = Number(process.env.CLAUDE_REVIEW_MAX_TURNS ?? 100);
const DEFAULT_CLAUDE_CONTINUATION_LIMIT = Number(process.env.CLAUDE_REVIEW_CONTINUATION_LIMIT ?? 2);
const DEFAULT_CLAUDE_API_RETRY_LIMIT = Number(process.env.CLAUDE_REVIEW_API_RETRY_LIMIT ?? 2);

type ClaudeLogState = {
  textBuffer: string;
  sawTextDelta: boolean;
};

export class AnthropicClaudeProviderError extends Error {
  readonly sessionId: string | null;
  readonly subtype: string | null;

  constructor(message: string, sessionId: string | null, subtype: string | null) {
    super(message);
    this.name = 'AnthropicClaudeProviderError';
    this.sessionId = sessionId;
    this.subtype = subtype;
  }
}

function writeDiagnostic(message: string, logger?: RunLogger) {
  process.stderr.write(message);
  void logger?.stderr(message);
}

function flushClaudeText(label: string, state: ClaudeLogState, logger?: RunLogger) {
  const trimmed = state.textBuffer.trim();
  if (!trimmed) {
    state.textBuffer = '';
    return;
  }

  writeDiagnostic(`[claude:${label}] ${trimmed}\n`, logger);
  void logger?.event('advisor.assistant_text', { label, text: trimmed, provider: 'anthropic-claude' });
  state.textBuffer = '';
}

function appendClaudeText(label: string, state: ClaudeLogState, text: string, logger?: RunLogger) {
  state.sawTextDelta = true;
  state.textBuffer += text;

  const lines = state.textBuffer.split('\n');
  state.textBuffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    writeDiagnostic(`[claude:${label}] ${trimmed}\n`, logger);
    void logger?.event('advisor.assistant_text', { label, text: trimmed, provider: 'anthropic-claude' });
  }
}

function logClaudeMessage(label: string, message: SDKMessage, logger?: RunLogger, state?: ClaudeLogState) {
  switch (message.type) {
    case 'assistant': {
      if (state?.sawTextDelta) {
        break;
      }

      const textBlocks = message.message.content
        .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean);

      if (textBlocks.length > 0) {
        for (const text of textBlocks) {
          writeDiagnostic(`[claude:${label}] ${text}\n`, logger);
          void logger?.event('advisor.assistant_text', { label, text, provider: 'anthropic-claude' });
        }
      }
      break;
    }
    case 'stream_event':
      if (message.event.type === 'content_block_delta') {
        if (message.event.delta.type === 'text_delta' && state) {
          appendClaudeText(label, state, message.event.delta.text, logger);
        }
      } else if (message.event.type === 'content_block_stop' && state) {
        flushClaudeText(label, state, logger);
      }
      break;
    case 'tool_progress':
      writeDiagnostic(`[claude:${label}] tool ${message.tool_name} running (${message.elapsed_time_seconds}s)\n`, logger);
      void logger?.event('advisor.tool_progress', {
        label,
        toolName: message.tool_name,
        elapsedTimeSeconds: message.elapsed_time_seconds,
        provider: 'anthropic-claude',
      });
      break;
    case 'tool_use_summary':
      writeDiagnostic(`[claude:${label}] ${message.summary}\n`, logger);
      void logger?.event('advisor.tool_use_summary', { label, summary: message.summary, provider: 'anthropic-claude' });
      break;
    case 'system':
      switch (message.subtype) {
        case 'local_command_output':
          writeDiagnostic(`[claude:${label}] ${message.content}\n`, logger);
          void logger?.event('advisor.local_command_output', { label, content: message.content, provider: 'anthropic-claude' });
          break;
        case 'task_started':
          writeDiagnostic(`[claude:${label}] task started: ${message.description}\n`, logger);
          void logger?.event('advisor.task_started', { label, description: message.description, provider: 'anthropic-claude' });
          break;
        case 'task_progress':
          writeDiagnostic(`[claude:${label}] ${message.description}\n`, logger);
          void logger?.event('advisor.task_progress', { label, description: message.description, provider: 'anthropic-claude' });
          break;
        case 'task_notification':
          writeDiagnostic(`[claude:${label}] task ${message.status}: ${message.summary}\n`, logger);
          void logger?.event('advisor.task_notification', {
            label,
            status: message.status,
            summary: message.summary,
            provider: 'anthropic-claude',
          });
          break;
        case 'status':
          if (message.status) {
            writeDiagnostic(`[claude:${label}] status: ${message.status}\n`, logger);
            void logger?.event('advisor.status', { label, status: message.status, provider: 'anthropic-claude' });
          }
          break;
        default:
          break;
      }
      break;
    case 'result':
      writeDiagnostic(`[claude:${label}] result: ${message.subtype}\n`, logger);
      void logger?.event('advisor.result', { label, subtype: message.subtype, provider: 'anthropic-claude' });
      break;
    default:
      break;
  }
}

async function nextWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Claude ${label} timed out after ${Math.round(timeoutMs / 1000)}s without progress`));
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

async function collectClaudeResult(stream: AsyncGenerator<SDKMessage, void>, label: string, logger?: RunLogger) {
  let sessionId: string | null = null;
  let lastResult: SDKResultMessage | null = null;
  const logState: ClaudeLogState = { textBuffer: '', sawTextDelta: false };
  const assistantTexts: string[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    const next = await nextWithTimeout(iterator.next(), DEFAULT_CLAUDE_INACTIVITY_TIMEOUT_MS, label);
    if (next.done) {
      break;
    }

    const message = next.value;
    sessionId = sessionId ?? message.session_id ?? null;
    if (message.type === 'assistant') {
      const textBlocks = message.message.content
        .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean);
      if (textBlocks.length > 0) {
        assistantTexts.push(textBlocks.join('\n\n'));
      }
    }
    logClaudeMessage(label, message, logger, logState);
    if (message.type === 'result') {
      lastResult = message;
    }
  }

  flushClaudeText(label, logState, logger);
  return { sessionId, lastResult, assistantText: assistantTexts.join('\n\n').trim() };
}

function buildClaudeQueryStream(args: StructuredAdvisorRoundArgs, defaultModel?: string | null) {
  return query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      ...((args.model ?? defaultModel) ? { model: args.model ?? defaultModel ?? undefined } : {}),
      tools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: DEFAULT_CLAUDE_MAX_TURNS,
      ...(args.resumeSessionId ? { resume: args.resumeSessionId } : {}),
      stderr: (data) => {
        writeDiagnostic(`[claude:${args.label}:stderr] ${data}`, args.logger);
      },
      outputFormat: {
        type: 'json_schema',
        schema: args.schema,
      },
    },
  });
}

function getClaudeResultErrorMessage(result: SDKResultMessage | null) {
  const raw = result as { result?: unknown; error?: unknown; subtype?: unknown } | null;
  if (!raw) {
    return null;
  }

  if (typeof raw.result === 'string' && raw.result.trim()) {
    return raw.result.trim();
  }

  if (raw.error && typeof raw.error === 'object') {
    const message = (raw.error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  return null;
}

function isTransientClaudeFailure(subtype: string | null, message: string | null) {
  const text = `${subtype ?? ''}\n${message ?? ''}`.toLowerCase();
  return (
    text.includes('api_error') ||
    text.includes('api error') ||
    text.includes('internal server error') ||
    text.includes('overloaded') ||
    text.includes('rate limit') ||
    text.includes('temporar') ||
    text.includes('try again')
  );
}

class AnthropicClaudeStructuredAdvisorAdapter implements StructuredAdvisorAdapter {
  constructor(private readonly options: { model?: string | null } = {}) {}

  async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs): Promise<StructuredAdvisorRoundResult<TStructured>> {
    let sessionId: string | null = args.resumeSessionId ?? null;
    let attempt = 0;
    let apiRetryCount = 0;
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

      const stream = buildClaudeQueryStream({ ...args, prompt, resumeSessionId: sessionId }, this.options.model);
      let result;
      try {
        result = await collectClaudeResult(stream, args.label, args.logger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTransientClaudeFailure(null, message) && apiRetryCount < DEFAULT_CLAUDE_API_RETRY_LIMIT) {
          apiRetryCount += 1;
          writeDiagnostic(
            `[claude:${args.label}] transient API failure; retrying review (${apiRetryCount}/${DEFAULT_CLAUDE_API_RETRY_LIMIT})\n`,
            args.logger,
          );
          void args.logger?.event('advisor.api_retry', {
            label: args.label,
            sessionId,
            retryCount: apiRetryCount,
            retryLimit: DEFAULT_CLAUDE_API_RETRY_LIMIT,
            message,
            provider: 'anthropic-claude',
          });
          continue;
        }
        throw new AnthropicClaudeProviderError(message, sessionId, 'api_error');
      }

      sessionId = result.sessionId ?? sessionId;
      lastResult = result.lastResult;
      const structured = (lastResult as { structured_output?: TStructured } | null)?.structured_output;
      if (structured) {
        return {
          sessionId,
          structured,
        };
      }

      const subtype = lastResult?.subtype ?? null;
      const resultErrorMessage = getClaudeResultErrorMessage(lastResult);
      if (isTransientClaudeFailure(subtype, resultErrorMessage) && apiRetryCount < DEFAULT_CLAUDE_API_RETRY_LIMIT) {
        apiRetryCount += 1;
        writeDiagnostic(
          `[claude:${args.label}] transient Claude error result; retrying review (${apiRetryCount}/${DEFAULT_CLAUDE_API_RETRY_LIMIT})\n`,
          args.logger,
        );
        void args.logger?.event('advisor.api_retry', {
          label: args.label,
          sessionId,
          retryCount: apiRetryCount,
          retryLimit: DEFAULT_CLAUDE_API_RETRY_LIMIT,
          subtype,
          message: resultErrorMessage,
          provider: 'anthropic-claude',
        });
        continue;
      }
      if (subtype !== 'error_max_turns' || !sessionId || attempt === DEFAULT_CLAUDE_CONTINUATION_LIMIT) {
        throw new AnthropicClaudeProviderError(
          resultErrorMessage
            ? `Claude ${args.label} did not return a successful result${subtype ? ` (${subtype})` : ''}: ${resultErrorMessage}`
            : `Claude ${args.label} did not return a successful result${subtype ? ` (${subtype})` : ''}`,
          sessionId,
          subtype,
        );
      }

      writeDiagnostic(
        `[claude:${args.label}] max turns reached without structured findings; continuing same session (${attempt + 1}/${DEFAULT_CLAUDE_CONTINUATION_LIMIT})\n`,
        args.logger,
      );
      void args.logger?.event('advisor.round_continuation', {
        label: args.label,
        sessionId,
        attempt: attempt + 1,
        continuationLimit: DEFAULT_CLAUDE_CONTINUATION_LIMIT,
        provider: 'anthropic-claude',
      });
      attempt += 1;
    }

    throw new AnthropicClaudeProviderError(`Claude ${args.label} did not return structured output`, sessionId, lastResult?.subtype ?? null);
  }
}

function buildClaudeCoderQueryStream(args: CoderRunPromptArgs, defaultModel?: string | null) {
  return query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      ...((defaultModel ? { model: defaultModel } : {})),
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(args.threadId ? { resume: args.threadId } : {}),
      ...(args.outputSchema
        ? {
            outputFormat: {
              type: 'json_schema' as const,
              schema: args.outputSchema,
            },
          }
        : {}),
      stderr: (data) => {
        writeDiagnostic(`[claude:coder:stderr] ${data}`, args.logger);
      },
    },
  });
}

class AnthropicClaudeCoderAdapter implements CoderAdapter {
  constructor(private readonly options: { model?: string | null } = {}) {}

  async runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
    const stream = buildClaudeCoderQueryStream(args, this.options.model);
    const result = await collectClaudeResult(stream, 'coder', args.logger);
    const sessionId = result.sessionId ?? args.threadId ?? null;

    if (sessionId && sessionId !== args.threadId) {
      await args.onThreadStarted?.(sessionId);
    }

    const subtype = result.lastResult?.subtype ?? null;
    const resultErrorMessage = getClaudeResultErrorMessage(result.lastResult);
    if (subtype && subtype !== 'success') {
      throw new AnthropicClaudeProviderError(
        resultErrorMessage
          ? `Claude coder did not return a successful result (${subtype}): ${resultErrorMessage}`
          : `Claude coder did not return a successful result (${subtype})`,
        sessionId,
        subtype,
      );
    }

    if (args.outputSchema) {
      const structuredOutput = (result.lastResult as { structured_output?: unknown } | null)?.structured_output;
      if (structuredOutput === undefined) {
        throw new AnthropicClaudeProviderError('Claude coder did not return structured output', sessionId, subtype);
      }

      return {
        threadId: sessionId,
        finalResponse: JSON.stringify(structuredOutput),
      };
    }

    const finalResponse = result.assistantText || getClaudeResultErrorMessage(result.lastResult) || '';
    if (!finalResponse.trim()) {
      throw new AnthropicClaudeProviderError('Claude coder returned no final response', sessionId, subtype);
    }

    return {
      threadId: sessionId,
      finalResponse,
    };
  }
}

export function createAnthropicClaudeStructuredAdvisorAdapter(options: { model?: string | null } = {}): StructuredAdvisorAdapter {
  return new AnthropicClaudeStructuredAdvisorAdapter(options);
}

export function createAnthropicClaudeCoderAdapter(options: { model?: string | null } = {}): CoderAdapter {
  return new AnthropicClaudeCoderAdapter(options);
}
