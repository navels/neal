import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

import { getApiRetryLimit, getClaudeContinuationLimit, getClaudeMaxTurns, getInactivityTimeoutMs } from '../config.js';
import type { RunLogger } from '../logger.js';
import type {
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from './types.js';

type ClaudeLogState = {
  textBuffer: string;
  sawTextDelta: boolean;
};

export class AnthropicClaudeProviderError extends Error {
  readonly sessionHandle: string | null;
  readonly subtype: string | null;

  constructor(message: string, sessionHandle: string | null, subtype: string | null) {
    super(message);
    this.name = 'AnthropicClaudeProviderError';
    this.sessionHandle = sessionHandle;
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

async function collectClaudeResult(stream: AsyncGenerator<SDKMessage, void>, cwd: string, label: string, logger?: RunLogger) {
  let sessionHandle: string | null = null;
  let lastResult: SDKResultMessage | null = null;
  const logState: ClaudeLogState = { textBuffer: '', sawTextDelta: false };
  const assistantTexts: string[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    const next = await nextWithTimeout(iterator.next(), getInactivityTimeoutMs(cwd), label);
    if (next.done) {
      break;
    }

    const message = next.value;
    sessionHandle = sessionHandle ?? message.session_id ?? null;
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
  return { sessionHandle, lastResult, assistantText: assistantTexts.join('\n\n').trim() };
}

function buildClaudeQueryStream(args: StructuredAdvisorRoundArgs, defaultModel?: string | null) {
  const maxTurns = getClaudeMaxTurns(args.cwd);
  return query({
    prompt: args.prompt,
    options: {
      cwd: args.cwd,
      ...((args.model ?? defaultModel) ? { model: args.model ?? defaultModel ?? undefined } : {}),
      tools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns,
      ...(args.resumeHandle ? { resume: args.resumeHandle } : {}),
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
    let sessionHandle: string | null = args.resumeHandle ?? null;
    let attempt = 0;
    let apiRetryCount = 0;
    let lastResult: SDKResultMessage | null = null;
    const continuationLimit = getClaudeContinuationLimit(args.cwd);
    const apiRetryLimit = getApiRetryLimit(args.cwd);

    while (attempt <= continuationLimit) {
      const prompt =
        attempt === 0
          ? args.prompt
          : [
              'Continue the same review session.',
              'Do not restart the investigation from scratch.',
              'Present your final structured findings now. If there are no findings, return an empty findings array.',
            ].join('\n');

      const stream = buildClaudeQueryStream({ ...args, prompt, resumeHandle: sessionHandle }, this.options.model);
      let result;
      try {
        result = await collectClaudeResult(stream, args.cwd, args.label, args.logger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTransientClaudeFailure(null, message) && apiRetryCount < apiRetryLimit) {
          apiRetryCount += 1;
          writeDiagnostic(
            `[claude:${args.label}] transient API failure; retrying review (${apiRetryCount}/${apiRetryLimit})\n`,
            args.logger,
          );
          void args.logger?.event('advisor.api_retry', {
            label: args.label,
            sessionHandle,
            retryCount: apiRetryCount,
            retryLimit: apiRetryLimit,
            message,
            provider: 'anthropic-claude',
          });
          continue;
        }
        throw new AnthropicClaudeProviderError(message, sessionHandle, 'api_error');
      }

      sessionHandle = result.sessionHandle ?? sessionHandle;
      lastResult = result.lastResult;
      const structured = (lastResult as { structured_output?: TStructured } | null)?.structured_output;
      if (structured) {
        return {
          sessionHandle,
          structured,
        };
      }

      const subtype = lastResult?.subtype ?? null;
      const resultErrorMessage = getClaudeResultErrorMessage(lastResult);
      if (isTransientClaudeFailure(subtype, resultErrorMessage) && apiRetryCount < apiRetryLimit) {
        apiRetryCount += 1;
        writeDiagnostic(
          `[claude:${args.label}] transient Claude error result; retrying review (${apiRetryCount}/${apiRetryLimit})\n`,
          args.logger,
        );
        void args.logger?.event('advisor.api_retry', {
          label: args.label,
          sessionHandle,
          retryCount: apiRetryCount,
          retryLimit: apiRetryLimit,
          subtype,
          message: resultErrorMessage,
          provider: 'anthropic-claude',
        });
        continue;
      }
      if (subtype !== 'error_max_turns' || !sessionHandle || attempt === continuationLimit) {
        throw new AnthropicClaudeProviderError(
          resultErrorMessage
            ? `Claude ${args.label} did not return a successful result${subtype ? ` (${subtype})` : ''}: ${resultErrorMessage}`
            : `Claude ${args.label} did not return a successful result${subtype ? ` (${subtype})` : ''}`,
          sessionHandle,
          subtype,
        );
      }

      writeDiagnostic(
        `[claude:${args.label}] max turns reached without structured findings; continuing same session (${attempt + 1}/${continuationLimit})\n`,
        args.logger,
      );
      void args.logger?.event('advisor.round_continuation', {
        label: args.label,
        sessionHandle,
        attempt: attempt + 1,
        continuationLimit,
        provider: 'anthropic-claude',
      });
      attempt += 1;
    }

    throw new AnthropicClaudeProviderError(`Claude ${args.label} did not return structured output`, sessionHandle, lastResult?.subtype ?? null);
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
      ...(args.resumeHandle ? { resume: args.resumeHandle } : {}),
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
    const result = await collectClaudeResult(stream, args.cwd, 'coder', args.logger);
    const sessionHandle = result.sessionHandle ?? args.resumeHandle ?? null;

    if (sessionHandle && sessionHandle !== args.resumeHandle) {
      await args.onSessionStarted?.(sessionHandle);
    }

    const subtype = result.lastResult?.subtype ?? null;
    const resultErrorMessage = getClaudeResultErrorMessage(result.lastResult);
    if (subtype && subtype !== 'success') {
      throw new AnthropicClaudeProviderError(
        resultErrorMessage
          ? `Claude coder did not return a successful result (${subtype}): ${resultErrorMessage}`
          : `Claude coder did not return a successful result (${subtype})`,
        sessionHandle,
        subtype,
      );
    }

    if (args.outputSchema) {
      const structuredOutput = (result.lastResult as { structured_output?: unknown } | null)?.structured_output;
      if (structuredOutput === undefined) {
        throw new AnthropicClaudeProviderError('Claude coder did not return structured output', sessionHandle, subtype);
      }

      return {
        sessionHandle: sessionHandle,
        finalResponse: JSON.stringify(structuredOutput),
      };
    }

    const finalResponse = result.assistantText || getClaudeResultErrorMessage(result.lastResult) || '';
    if (!finalResponse.trim()) {
      throw new AnthropicClaudeProviderError('Claude coder returned no final response', sessionHandle, subtype);
    }

    return {
      sessionHandle: sessionHandle,
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
