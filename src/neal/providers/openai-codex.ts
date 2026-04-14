import { Codex, type Thread } from '@openai/codex-sdk';

import type { RunLogger } from '../logger.js';
import type {
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from './types.js';

const DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS = Number(process.env.CODEX_INACTIVITY_TIMEOUT_MS ?? 600_000);

export class OpenAICodexProviderError extends Error {
  readonly threadId: string | null;

  constructor(message: string, threadId: string | null) {
    super(message);
    this.name = 'OpenAICodexProviderError';
    this.threadId = threadId;
  }
}

function writeDiagnostic(message: string, logger?: RunLogger) {
  process.stderr.write(message);
  void logger?.stderr(message);
}

async function nextWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)}s without progress`));
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

function createCodexThread(cwd: string, threadId?: string | null, model?: string): Thread {
  const codex = new Codex();
  const threadOptions = {
    ...(model ? { model } : {}),
    approvalPolicy: 'never' as const,
    sandboxMode: 'danger-full-access' as const,
    workingDirectory: cwd,
  };
  return threadId
    ? codex.resumeThread(threadId, threadOptions)
    : codex.startThread(threadOptions);
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
      next = await nextWithTimeout(iterator.next(), DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenAICodexProviderError(message, threadId);
    }

    if (next.done) {
      break;
    }

    const event = next.value;
    switch (event.type) {
      case 'thread.started':
        threadId = event.thread_id;
        writeDiagnostic(`[codex] thread ${event.thread_id}\n`, logger);
        void logger?.event('coder.thread_started', { threadId: event.thread_id, provider: 'openai-codex' });
        await onThreadStarted?.(event.thread_id);
        break;
      case 'item.completed':
        if (event.item.type === 'command_execution') {
          writeDiagnostic(`\n$ ${event.item.command}\n`, logger);
          void logger?.event('coder.command_execution', { command: event.item.command, provider: 'openai-codex' });
          if (event.item.aggregated_output) {
            writeDiagnostic(`${event.item.aggregated_output}\n`, logger);
          }
        } else if (event.item.type === 'file_change' && event.item.changes.length > 0) {
          const files = event.item.changes.map((change) => change.path);
          writeDiagnostic(`[codex] files ${files.join(', ')}\n`, logger);
          void logger?.event('coder.file_change', { files, provider: 'openai-codex' });
        } else if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }
        break;
      case 'turn.failed':
        fatalError = event.error.message;
        writeDiagnostic(`[codex:error] ${event.error.message}\n`, logger);
        void logger?.event('coder.turn_failed', { message: event.error.message, provider: 'openai-codex' });
        break;
      case 'error':
        fatalError = event.message;
        writeDiagnostic(`[codex:error] ${event.message}\n`, logger);
        void logger?.event('coder.error', { message: event.message, provider: 'openai-codex' });
        break;
      default:
        break;
    }
  }

  if (fatalError) {
    throw new OpenAICodexProviderError(fatalError, threadId);
  }

  return { finalResponse, threadId };
}

async function consumeCodexAdvisorTurn(
  turn: Awaited<ReturnType<Thread['runStreamed']>>,
  label: StructuredAdvisorRoundArgs['label'],
  logger?: RunLogger,
) {
  let finalResponse = '';
  let fatalError: string | null = null;
  let threadId: string | null = null;
  const iterator = turn.events[Symbol.asyncIterator]();

  while (true) {
    let next;
    try {
      next = await nextWithTimeout(iterator.next(), DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenAICodexProviderError(message, threadId);
    }

    if (next.done) {
      break;
    }

    const event = next.value;
    switch (event.type) {
      case 'thread.started':
        threadId = event.thread_id;
        writeDiagnostic(`[codex:${label}] thread ${event.thread_id}\n`, logger);
        void logger?.event('advisor.status', {
          label,
          status: `thread ${event.thread_id} started`,
          provider: 'openai-codex',
        });
        break;
      case 'item.completed':
        if (event.item.type === 'command_execution') {
          const content = [`$ ${event.item.command}`, event.item.aggregated_output ?? ''].filter(Boolean).join('\n');
          writeDiagnostic(`\n${content}\n`, logger);
          void logger?.event('advisor.local_command_output', { label, content, provider: 'openai-codex' });
        } else if (event.item.type === 'file_change' && event.item.changes.length > 0) {
          const files = event.item.changes.map((change) => change.path);
          const summary = `files ${files.join(', ')}`;
          writeDiagnostic(`[codex:${label}] ${summary}\n`, logger);
          void logger?.event('advisor.tool_use_summary', { label, summary, provider: 'openai-codex' });
        } else if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }
        break;
      case 'turn.failed':
        fatalError = event.error.message;
        writeDiagnostic(`[codex:${label}:error] ${event.error.message}\n`, logger);
        void logger?.event('advisor.status', { label, status: event.error.message, provider: 'openai-codex' });
        break;
      case 'error':
        fatalError = event.message;
        writeDiagnostic(`[codex:${label}:error] ${event.message}\n`, logger);
        void logger?.event('advisor.status', { label, status: event.message, provider: 'openai-codex' });
        break;
      default:
        break;
    }
  }

  if (fatalError) {
    throw new OpenAICodexProviderError(fatalError, threadId);
  }

  return { finalResponse, threadId };
}

class OpenAICodexCoderAdapter implements CoderAdapter {
  constructor(private readonly options: { model?: string | null } = {}) {}

  async runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
    const thread = createCodexThread(args.cwd, args.threadId, this.options.model ?? undefined);
    const streamedTurn = await thread.runStreamed(args.prompt, args.outputSchema ? { outputSchema: args.outputSchema } : undefined);
    const result = await consumeCodexTurn(streamedTurn, args.logger, args.onThreadStarted);

    return {
      threadId: thread.id,
      finalResponse: result.finalResponse,
    };
  }
}

class OpenAICodexStructuredAdvisorAdapter implements StructuredAdvisorAdapter {
  constructor(private readonly options: { model?: string | null } = {}) {}

  async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs): Promise<StructuredAdvisorRoundResult<TStructured>> {
    const thread = createCodexThread(args.cwd, args.resumeSessionId, this.options.model ?? undefined);
    const streamedTurn = await thread.runStreamed(args.prompt, { outputSchema: args.schema });
    const result = await consumeCodexAdvisorTurn(streamedTurn, args.label, args.logger);

    let structured: TStructured;
    try {
      structured = JSON.parse(result.finalResponse) as TStructured;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenAICodexProviderError(`Codex ${args.label} returned invalid structured output: ${message}`, thread.id);
    }

    void args.logger?.event('advisor.result', { label: args.label, provider: 'openai-codex' });

    return {
      sessionId: thread.id,
      structured,
    };
  }
}

export function createOpenAICodexCoderAdapter(options: { model?: string | null } = {}): CoderAdapter {
  return new OpenAICodexCoderAdapter(options);
}

export function createOpenAICodexStructuredAdvisorAdapter(options: { model?: string | null } = {}): StructuredAdvisorAdapter {
  return new OpenAICodexStructuredAdvisorAdapter(options);
}
