import { Codex, type ModelReasoningEffort, type Thread, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';

import { buildStructuredJsonPrompt, runStructuredJsonProtocol } from '../agents/structured-json.js';
import { agentSettingsIsolated } from './agent-settings-isolation.js';
import { agentSubprocessEnv } from './git-config-isolation.js';
import { assertPromptWithinInputBudget } from './input-budget.js';
import { resolveRateCost } from './pricing.js';
import { isContentSafetyRefusalMessage, NealProviderError } from './types.js';
import type {
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  CoderStructuredPromptArgs,
  CoderStructuredPromptResult,
  NealProviderErrorKind,
  NealProviderDefinition,
  ProviderEventSink,
  ProviderRuntimeEvent,
  ProviderRole,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from './types.js';

const OPENAI_CODEX_PROVIDER_ID = 'openai-codex';

// Codex's app-server rejects any single turn whose input exceeds this size
// (JSON-RPC code -32602, input_error_code `input_too_large`). Declared as
// `maxInputChars` on both role capabilities and enforced by the preflight at
// every turn/round entry point below.
const OPENAI_CODEX_MAX_INPUT_CHARS = 1_048_576;

function assertCodexInputBudget(args: {
  prompt: string;
  role: ProviderRole;
  sessionHandle?: string | null;
}) {
  assertPromptWithinInputBudget({
    prompt: args.prompt,
    maxInputChars: OPENAI_CODEX_MAX_INPUT_CHARS,
    provider: OPENAI_CODEX_PROVIDER_ID,
    role: args.role,
    sessionHandle: args.sessionHandle,
  });
}

class CodexInactivityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Codex timed out after ${Math.round(timeoutMs / 1000)}s without progress`);
    this.name = 'CodexInactivityTimeoutError';
  }
}

// In-round transient (`api_error`) retries back off exponentially: 500 ms
// base, doubling per retry, capped at 5 s — the same schedule as the
// openai-compatible adapter. `sleep` is injectable through the adapter options
// so tests observe the delays without wall-clock waiting.
const API_RETRY_BASE_DELAY_MS = 500;
const API_RETRY_MAX_DELAY_MS = 5_000;

type SleepFn = (ms: number) => Promise<void>;

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getApiRetryDelayMs(retryCount: number) {
  return Math.min(API_RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1), API_RETRY_MAX_DELAY_MS);
}

async function nextWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      rejectPromise(new CodexInactivityTimeoutError(timeoutMs));
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

// Propagates an external caller-owned abort signal into the adapter's
// internal per-turn AbortController so orchestration-level supervision can
// cancel an in-flight Codex turn. Repair threads use their own controllers
// and are intentionally not linked; repairs are short, prompt-only turns.
function linkExternalAbortSignal(signal: AbortSignal | undefined, abortController: AbortController) {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    abortController.abort(signal.reason);
    return;
  }
  signal.addEventListener('abort', () => abortController.abort(signal.reason), { once: true });
}

function isTransientCodexApiFailure(message: string) {
  const text = message.toLowerCase();
  return (
    text.includes('api_error') ||
    text.includes('api error') ||
    text.includes('internal server error') ||
    text.includes('overloaded') ||
    text.includes('at capacity') ||
    text.includes('rate limit') ||
    text.includes('temporar') ||
    text.includes('try again')
  );
}

function inferCodexErrorKind(error: unknown, message: string, fallback: NealProviderErrorKind): NealProviderErrorKind {
  const text = message.toLowerCase();
  if (error instanceof CodexInactivityTimeoutError || /\btimed out after\b/i.test(message)) {
    return 'timeout';
  }
  // Placed before the permission check so a content-safety refusal is never
  // misread as permission_denied when OpenAI phrases it with the word
  // "authorized".
  if (isContentSafetyRefusalMessage(message)) {
    return 'content_refused';
  }
  // Codex's app-server rejects an over-limit turn with JSON-RPC code -32602
  // and input_error_code `input_too_large`; matching the stable error code
  // means a limit the preflight did not predict still classifies correctly.
  if (text.includes('input_too_large')) {
    return 'input_too_large';
  }
  if (text.includes('permission') || text.includes('denied') || text.includes('forbidden') || text.includes('not authorized')) {
    return 'permission_denied';
  }
  if (
    text.includes('property_name_above_max_length') ||
    text.includes('orphan function call output') ||
    text.includes('failed to record rollout items') ||
    text.includes('session unavailable') ||
    text.includes('session not found') ||
    text.includes('thread not found')
  ) {
    return 'session_unavailable';
  }
  if (isTransientCodexApiFailure(message)) {
    return 'api_error';
  }
  return fallback;
}

function isRetryableCodexError(kind: NealProviderErrorKind, message: string) {
  return kind === 'timeout' || kind === 'session_unavailable' || (kind === 'api_error' && isTransientCodexApiFailure(message));
}

function isCodexReconnectProgressMessage(message: string) {
  return /^reconnecting\.\.\.\s*\d+\/\d+\b/i.test(message.trim());
}

function createCodexProviderError(args: {
  message: string;
  role: ProviderRole;
  sessionHandle?: string | null;
  kind?: NealProviderErrorKind;
  retryable?: boolean;
  cause?: unknown;
}) {
  const kind = args.kind ?? inferCodexErrorKind(args.cause, args.message, 'provider_failed');
  return new NealProviderError({
    message: args.message,
    provider: OPENAI_CODEX_PROVIDER_ID,
    role: args.role,
    sessionHandle: args.sessionHandle,
    kind,
    retryable: args.retryable ?? isRetryableCodexError(kind, args.message),
    cause: args.cause,
  });
}

type CodexObservedFailureSource = 'turn.failed' | 'error';

type CodexObservedFailure = {
  message: string;
  kind: NealProviderErrorKind;
  source: CodexObservedFailureSource;
  cause?: unknown;
};

function observeCodexFailure(args: {
  message: string;
  source: CodexObservedFailureSource;
  cause?: unknown;
  kind?: NealProviderErrorKind;
}): CodexObservedFailure {
  return {
    message: args.message,
    kind: args.kind ?? inferCodexErrorKind(args.cause, args.message, 'provider_failed'),
    source: args.source,
    cause: args.cause,
  };
}

function isGenericCodexProcessFailure(message: string) {
  const text = message.toLowerCase();
  return text.includes('codex exec exited') || text.includes('reading prompt from stdin') || text.includes('exited with code');
}

function shouldReplaceCodexFailure(current: CodexObservedFailure | null, next: CodexObservedFailure) {
  if (!current) {
    return true;
  }
  return isGenericCodexProcessFailure(current.message) || !isGenericCodexProcessFailure(next.message);
}

function createCodexProviderErrorFromObservedFailure(
  failure: CodexObservedFailure,
  args: {
    role: ProviderRole;
    sessionHandle?: string | null;
    cause?: unknown;
  },
) {
  const cause =
    args.cause === undefined
      ? failure.cause
      : {
          source: failure.source,
          providerCause: failure.cause,
          iteratorCause: args.cause,
        };
  return createCodexProviderError({
    message: failure.message,
    role: args.role,
    sessionHandle: args.sessionHandle,
    kind: failure.kind,
    cause,
  });
}

function normalizeCodexProviderError(
  error: unknown,
  args: {
    role: ProviderRole;
    sessionHandle?: string | null;
    kind?: NealProviderErrorKind;
  },
) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NealProviderError) {
    if (error.sessionHandle || !args.sessionHandle) {
      return error;
    }
    return createCodexProviderError({
      message: error.message,
      role: error.role,
      sessionHandle: args.sessionHandle,
      kind: error.kind,
      retryable: error.retryable,
      cause: error,
    });
  }

  return createCodexProviderError({
    message,
    role: args.role,
    sessionHandle: args.sessionHandle,
    kind: args.kind,
    cause: error,
  });
}

function summarizeItem(item: ThreadItem) {
  switch (item.type) {
    case 'command_execution':
      return {
        itemId: item.id,
        itemType: item.type,
        status: item.status,
        command: item.command,
        outputLength: item.aggregated_output.length,
        exitCode: item.exit_code,
      };
    case 'file_change':
      return {
        itemId: item.id,
        itemType: item.type,
        status: item.status,
        files: item.changes.map((change) => change.path),
      };
    case 'mcp_tool_call':
      return {
        itemId: item.id,
        itemType: item.type,
        status: item.status,
        server: item.server,
        tool: item.tool,
      };
    case 'web_search':
      return {
        itemId: item.id,
        itemType: item.type,
        query: item.query,
      };
    case 'todo_list':
      return {
        itemId: item.id,
        itemType: item.type,
        completed: item.items.filter((todo) => todo.completed).length,
        total: item.items.length,
      };
    case 'reasoning':
      return {
        itemId: item.id,
        itemType: item.type,
        textLength: item.text.length,
      };
    case 'agent_message':
      return {
        itemId: item.id,
        itemType: item.type,
        textLength: item.text.length,
      };
    case 'error':
      return {
        itemId: item.id,
        itemType: item.type,
        message: item.message,
      };
  }
}

type CodexSandboxMode = NonNullable<ThreadOptions['sandboxMode']>;

function buildCodexThreadOptions(args: {
  cwd: string;
  model?: string;
  effort?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: CodexSandboxMode;
}): ThreadOptions {
  return {
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { modelReasoningEffort: args.effort as ModelReasoningEffort } : {}),
    approvalPolicy: 'never' as const,
    sandboxMode: args.sandboxMode ?? ('danger-full-access' as const),
    workingDirectory: args.cwd,
    skipGitRepoCheck: args.skipGitRepoCheck ?? false,
  };
}

function createCodexThread(args: {
  cwd: string;
  sessionHandle?: string | null;
  model?: string;
  effort?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: CodexSandboxMode;
}): Thread {
  // Under compat qualification only, isolate from the user's interactive
  // `notify` hook in ~/.codex/config.toml: compat runs the whole role matrix
  // through Codex, and left alone the hook fires a desktop notification per
  // planner/coder/reviewer turn. Override `notify` to empty (a `--config
  // notify=[]` pass to the CLI) for that case. Normal neal runs (pipeline,
  // local `neal go`) honor the user's config. See agent-settings-isolation.ts.
  //
  // `env` is always passed (the SDK stops inheriting process.env once env is
  // provided, so it is the full environment plus the git-config isolation
  // overrides): the Codex CLI and every shell it runs must not be able to
  // write the operator's real global gitconfig. See git-config-isolation.ts.
  const env = agentSubprocessEnv();
  const codex = agentSettingsIsolated()
    ? new Codex({ config: { notify: [] }, env })
    : new Codex({ env });
  const threadOptions = buildCodexThreadOptions({
    cwd: args.cwd,
    model: args.model,
    effort: args.effort,
    skipGitRepoCheck: args.skipGitRepoCheck,
    sandboxMode: args.sandboxMode,
  });
  return args.sessionHandle
    ? codex.resumeThread(args.sessionHandle, threadOptions)
    : codex.startThread(threadOptions);
}

type CodexThreadFactory = typeof createCodexThread;

async function emitProviderEvent(events: ProviderEventSink | undefined, event: ProviderRuntimeEvent) {
  await events?.(event);
}

async function emitCodexStreamError(args: {
  events?: ProviderEventSink;
  role: ProviderRole;
  label?: StructuredAdvisorRoundArgs['label'];
  sessionHandle: string | null;
  message: string;
}) {
  if (isCodexReconnectProgressMessage(args.message)) {
    await emitProviderEvent(args.events, {
      type: 'tool_progress',
      provider: OPENAI_CODEX_PROVIDER_ID,
      role: args.role,
      label: args.label,
      sessionHandle: args.sessionHandle,
      toolName: 'codex_stream',
      message: args.message,
      isError: true,
      providerData: { sdkEventType: 'error', nonFatal: true },
    });
    return false;
  }

  await emitProviderEvent(args.events, {
    type: 'provider_error',
    provider: OPENAI_CODEX_PROVIDER_ID,
    role: args.role,
    label: args.label,
    sessionHandle: args.sessionHandle,
    message: args.message,
    providerData: { sdkEventType: 'error' },
  });
  return true;
}

type CodexTurnConsumerOptions = {
  role: ProviderRole;
  label?: StructuredAdvisorRoundArgs['label'];
  events?: ProviderEventSink;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  abortController?: AbortController;
  // The configured Codex model slug (may be null = SDK default). Codex has no
  // pricing config block, so this configured slug is the only rate source: a
  // turn's card-derived cost is priced by the model the role actually ran. When
  // null the slug is unknown and cost stays tokens-only.
  model?: string | null;
};

// Shared turn consumer behind `consumeCodexTurn` (coder) and
// `consumeCodexAdvisorTurn` (structured advisor). The two paths differ only
// in the role stamped on emitted events and normalized errors, the
// advisor-only `label` stamp, and the coder-only `onSessionStarted`
// callback; everything else is identical.
async function consumeCodexTurnWithOptions(
  turn: Awaited<ReturnType<Thread['runStreamed']>>,
  cwd: string,
  inactivityTimeoutMs: number,
  options: CodexTurnConsumerOptions,
) {
  const { role, label, events, onSessionStarted, abortController, model } = options;
  // The advisor path stamps `label` on every emitted event while the coder
  // path emits events without a `label` property at all — the conditional
  // spread preserves that own-property distinction exactly.
  const labelFields: { label?: StructuredAdvisorRoundArgs['label'] } = label === undefined ? {} : { label };
  let finalResponse = '';
  let observedFailure: CodexObservedFailure | null = null;
  let sessionHandle: string | null = null;
  const iterator = turn.events[Symbol.asyncIterator]();

  while (true) {
    let next;
    try {
      next = await nextWithTimeout(iterator.next(), inactivityTimeoutMs, () => abortController?.abort());
    } catch (error) {
      if (observedFailure) {
        throw createCodexProviderErrorFromObservedFailure(observedFailure, {
          role,
          sessionHandle,
          cause: error,
        });
      }
      throw normalizeCodexProviderError(error, {
        role,
        sessionHandle,
      });
    }

    if (next.done) {
      break;
    }

    const event = next.value;
    switch (event.type) {
      case 'thread.started':
        sessionHandle = event.thread_id;
        await emitProviderEvent(events, {
          type: 'session_started',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role,
          ...labelFields,
          sessionHandle: event.thread_id,
          providerData: { sdkEventType: event.type },
        });
        await onSessionStarted?.(event.thread_id);
        break;
      case 'turn.started':
        await emitProviderEvent(events, {
          type: 'turn_started',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role,
          ...labelFields,
          sessionHandle,
          providerData: { sdkEventType: event.type },
        });
        break;
      case 'item.started':
        await emitProviderEvent(events, {
          type: 'tool_started',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role,
          ...labelFields,
          sessionHandle,
          itemId: summarizeItem(event.item).itemId,
          toolName: event.item.type,
          providerData: { sdkEventType: event.type, item: summarizeItem(event.item) },
        });
        break;
      case 'item.updated':
        await emitProviderEvent(events, {
          type: 'tool_progress',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role,
          ...labelFields,
          sessionHandle,
          itemId: summarizeItem(event.item).itemId,
          toolName: event.item.type,
          providerData: { sdkEventType: event.type, item: summarizeItem(event.item) },
        });
        break;
      case 'item.completed':
        if (event.item.type === 'command_execution') {
          await emitProviderEvent(events, {
            type: 'command_completed',
            provider: OPENAI_CODEX_PROVIDER_ID,
            role,
            ...labelFields,
            sessionHandle,
            itemId: event.item.id,
            command: event.item.command,
            status: event.item.status,
            exitCode: event.item.exit_code ?? null,
            output: event.item.aggregated_output,
            outputLength: event.item.aggregated_output.length,
            cwd,
            providerData: { sdkEventType: event.type, item: summarizeItem(event.item) },
          });
        } else if (event.item.type === 'file_change' && event.item.changes.length > 0) {
          const files = event.item.changes.map((change) => change.path);
          await emitProviderEvent(events, {
            type: 'file_changed',
            provider: OPENAI_CODEX_PROVIDER_ID,
            role,
            ...labelFields,
            sessionHandle,
            files,
            providerData: { sdkEventType: event.type, item: summarizeItem(event.item) },
          });
        } else if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }
        break;
      case 'turn.completed': {
        // Card-derived cost only when the turn actually carried usage. Codex
        // advertises opportunistic usage reporting, and `computeRateCostUsd`
        // returns 0 for absent usage, so gating on `event.usage !== undefined`
        // (matching the usage_reported emit) keeps a usage-less turn's
        // tokens-only shape byte-stable rather than attaching costUsd: 0. Codex
        // has no config pricing, so cost comes from the card via the configured
        // model only.
        const cost =
          event.usage !== undefined
            ? (resolveRateCost({ usage: event.usage, model: model ?? null, configPricing: null }) ?? {})
            : {};
        await emitProviderEvent(events, {
          type: 'turn_completed',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role,
          ...labelFields,
          sessionHandle,
          usage: event.usage,
          ...cost,
          providerData: { sdkEventType: event.type },
        });
        if (event.usage !== undefined) {
          await emitProviderEvent(events, {
            type: 'usage_reported',
            provider: OPENAI_CODEX_PROVIDER_ID,
            role,
            ...labelFields,
            sessionHandle,
            usage: event.usage,
            ...cost,
            providerData: { sdkEventType: event.type },
          });
        }
        break;
      }
      case 'turn.failed':
        {
          const nextFailure = observeCodexFailure({
            message: event.error.message,
            source: event.type,
            cause: event.error,
          });
          if (shouldReplaceCodexFailure(observedFailure, nextFailure)) {
            observedFailure = nextFailure;
            await emitProviderEvent(events, {
              type: 'provider_error',
              provider: OPENAI_CODEX_PROVIDER_ID,
              role,
              ...labelFields,
              sessionHandle,
              message: event.error.message,
              providerData: { sdkEventType: event.type },
            });
          }
        }
        break;
      case 'error':
        {
          const nextFailure = observeCodexFailure({
            message: event.message,
            source: event.type,
            cause: event,
          });
          if (shouldReplaceCodexFailure(observedFailure, nextFailure)) {
            if (
              await emitCodexStreamError({
                events,
                role,
                label,
                sessionHandle,
                message: event.message,
              })
            ) {
              observedFailure = nextFailure;
            }
          }
        }
        break;
      default:
        break;
    }
  }

  if (observedFailure) {
    throw createCodexProviderErrorFromObservedFailure(observedFailure, {
      role,
      sessionHandle,
    });
  }

  return { finalResponse, sessionHandle };
}

async function consumeCodexTurn(
  turn: Awaited<ReturnType<Thread['runStreamed']>>,
  cwd: string,
  inactivityTimeoutMs: number,
  events?: ProviderEventSink,
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>,
  abortController?: AbortController,
  // Appended last so existing positional callers (including test hooks) stay
  // valid; forwards the configured slug for card-derived cost.
  model?: string | null,
) {
  return consumeCodexTurnWithOptions(turn, cwd, inactivityTimeoutMs, {
    role: 'coder',
    events,
    onSessionStarted,
    abortController,
    model,
  });
}

async function consumeCodexAdvisorTurn(
  turn: Awaited<ReturnType<Thread['runStreamed']>>,
  cwd: string,
  label: StructuredAdvisorRoundArgs['label'],
  inactivityTimeoutMs: number,
  events?: ProviderEventSink,
  abortController?: AbortController,
  // Appended last so existing positional callers (including test hooks) stay
  // valid; forwards the configured slug for card-derived cost.
  model?: string | null,
) {
  return consumeCodexTurnWithOptions(turn, cwd, inactivityTimeoutMs, {
    role: 'structured-advisor',
    label,
    events,
    abortController,
    model,
  });
}

function parseCodexStructuredOutput<TStructured>(
  finalResponse: string,
  label: StructuredAdvisorRoundArgs['label'],
  sessionHandle: string | null,
): TStructured {
  try {
    return JSON.parse(finalResponse) as TStructured;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createCodexProviderError({
      message: `Codex ${label} returned invalid structured output: ${message}`,
      role: 'structured-advisor',
      sessionHandle,
      kind: 'structured_output_invalid',
      cause: error,
    });
  }
}

function buildCodexStructuredAdvisorRunOptions(
  args: StructuredAdvisorRoundArgs<unknown>,
  signal: AbortSignal,
) {
  if (args.structuredJsonProtocol?.protocol === 'neal-json-block-v1') {
    return { signal };
  }

  return {
    outputSchema: args.schema,
    signal,
  };
}

// Best-effort `toolPolicy` enforcement for Codex coder turns. The Codex SDK
// has no per-tool-call hook, so `allowedWritePaths` cannot be enforced at
// path granularity; sandbox modes are the strongest mechanical lever it
// offers. A jailed plan-authoring turn (allowRun false + allowedWritePaths)
// runs under 'workspace-write' so writes are confined to the workspace
// sandbox. Residual gap: shell still runs inside that sandbox and can write
// any workspace path, not just the allowlisted plan document — documented in
// docs/providers.md. Policy-free coder rounds keep 'danger-full-access'
// because scope verification legitimately runs arbitrary commands.
function getCodexCoderSandboxMode(toolPolicy: CoderRunPromptArgs['toolPolicy']): CodexSandboxMode {
  return toolPolicy?.allowRun === false && toolPolicy.allowedWritePaths
    ? 'workspace-write'
    : 'danger-full-access';
}

class OpenAICodexCoderAdapter implements CoderAdapter {
  constructor(private readonly options: {
    model?: string | null;
    effort?: string | null;
    createThread?: CodexThreadFactory;
    sleep?: SleepFn;
  } = {}) {}

  async runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
    let thread: Thread | null = null;
    try {
      assertCodexInputBudget({
        prompt: args.prompt,
        role: 'coder',
        sessionHandle: args.resumeHandle ?? null,
      });
      const createThread = this.options.createThread ?? createCodexThread;
      thread = createThread({
        cwd: args.cwd,
        sessionHandle: args.resumeHandle,
        model: this.options.model ?? undefined,
        effort: this.options.effort ?? undefined,
        skipGitRepoCheck: args.skipGitRepoCheck,
        sandboxMode: getCodexCoderSandboxMode(args.toolPolicy),
      });
      const abortController = new AbortController();
      linkExternalAbortSignal(args.signal, abortController);
      const streamedTurn = await thread.runStreamed(args.prompt, {
        ...(args.outputSchema ? { outputSchema: args.outputSchema } : {}),
        signal: abortController.signal,
      });
      const result = await consumeCodexTurn(
        streamedTurn,
        args.cwd,
        args.inactivityTimeoutMs,
        args.events,
        args.onSessionStarted,
        abortController,
        this.options.model ?? null,
      );
      if (args.outputSchema) {
        await emitProviderEvent(args.events, {
          type: 'structured_output_received',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role: 'coder',
          sessionHandle: thread.id,
        });
      }

      return {
        sessionHandle: thread.id,
        finalResponse: result.finalResponse,
      };
    } catch (error) {
      const providerError = normalizeCodexProviderError(error, {
        role: 'coder',
        sessionHandle: thread?.id ?? args.resumeHandle ?? null,
      });
      await emitProviderEvent(args.events, {
        type: 'provider_error',
        provider: OPENAI_CODEX_PROVIDER_ID,
        role: 'coder',
        sessionHandle: providerError.sessionHandle,
        message: providerError.message,
        errorKind: providerError.kind,
      });
      throw providerError;
    }
  }

  async runStructuredPrompt<TStructured>(
    args: CoderStructuredPromptArgs<TStructured>,
  ): Promise<CoderStructuredPromptResult<TStructured>> {
    const sleep = this.options.sleep ?? defaultSleep;
    let apiRetryCount = 0;
    const apiRetryLimit = args.apiRetryLimit ?? 0;

    while (true) {
      let thread: Thread | null = null;
      try {
        // Preflight the exact text the initial SDK turn will send: the
        // protocol-wrapped prompt. buildStructuredJsonPrompt is the same pure
        // builder runStructuredJsonProtocol applies to the same inputs below,
        // so the checked text is byte-identical to the sent text. Repair
        // prompts are checked in runRepair before their thread is created.
        assertCodexInputBudget({
          prompt: buildStructuredJsonPrompt(args.prompt, args.structuredJsonProtocol),
          role: 'coder',
          sessionHandle: args.resumeHandle ?? null,
        });
        const createThread = this.options.createThread ?? createCodexThread;
        thread = createThread({
          cwd: args.cwd,
          sessionHandle: args.resumeHandle,
          model: this.options.model ?? undefined,
          effort: this.options.effort ?? undefined,
          skipGitRepoCheck: args.skipGitRepoCheck,
          sandboxMode: getCodexCoderSandboxMode(args.toolPolicy),
        });
        const abortController = new AbortController();
        linkExternalAbortSignal(args.signal, abortController);
        return await runStructuredJsonProtocol<TStructured>({
          provider: OPENAI_CODEX_PROVIDER_ID,
          role: 'coder',
          label: args.label,
          protocol: args.structuredJsonProtocol,
          prompt: args.prompt,
          events: args.events,
          initialSessionHandle: args.resumeHandle ?? null,
          runInitial: async (prompt) => {
            const streamedTurn = await thread!.runStreamed(prompt, {
              signal: abortController.signal,
            });
            const result = await consumeCodexTurn(
              streamedTurn,
              args.cwd,
              args.inactivityTimeoutMs,
              args.events,
              args.onSessionStarted,
              abortController,
              this.options.model ?? null,
            );
            return {
              assistantText: result.finalResponse,
              sessionHandle: thread!.id,
            };
          },
          runRepair: async (prompt) => {
            // A generated repair prompt embeds the invalid payload and the
            // original response, so it can exceed the budget even when the
            // initial prompt fit; preflight it before creating its thread.
            assertCodexInputBudget({
              prompt,
              role: 'coder',
              sessionHandle: thread!.id ?? args.resumeHandle ?? null,
            });
            // Repair runs on a fresh prompt-only thread whose prompt forbids
            // tool use entirely, so nothing in the repair flow needs write
            // access; the read-only sandbox enforces that mechanically
            // (mirroring the structured-advisor repair thread).
            const repairThread = createThread({
              cwd: args.cwd,
              model: this.options.model ?? undefined,
              effort: this.options.effort ?? undefined,
              skipGitRepoCheck: true,
              sandboxMode: 'read-only',
            });
            const repairAbortController = new AbortController();
            const streamedTurn = await repairThread.runStreamed(prompt, {
              signal: repairAbortController.signal,
            });
            const result = await consumeCodexTurn(
              streamedTurn,
              args.cwd,
              args.inactivityTimeoutMs,
              args.events,
              undefined,
              repairAbortController,
              this.options.model ?? null,
            );
            return {
              assistantText: result.finalResponse,
              sessionHandle: repairThread.id,
            };
          },
          createProviderError: (errorArgs) => createCodexProviderError({
            message: errorArgs.message,
            role: 'coder',
            sessionHandle: errorArgs.sessionHandle,
            kind: errorArgs.kind,
            retryable: false,
            cause: errorArgs.cause,
          }),
        });
      } catch (error) {
        const providerError = normalizeCodexProviderError(error, {
          role: 'coder',
          sessionHandle: thread?.id ?? args.resumeHandle ?? null,
        });
        // Bounded in-round retry for transient provider failures, mirroring
        // the Claude structured-coder loop: only retryable `api_error` kinds
        // burn budget and a caller abort never does. Each retry starts a
        // fresh thread; per the adapter contract resumed sessions pass 0.
        if (
          providerError.kind === 'api_error' &&
          providerError.retryable &&
          apiRetryCount < apiRetryLimit &&
          !args.signal?.aborted
        ) {
          apiRetryCount += 1;
          await emitProviderEvent(args.events, {
            type: 'tool_progress',
            provider: OPENAI_CODEX_PROVIDER_ID,
            role: 'coder',
            label: args.label,
            sessionHandle: providerError.sessionHandle,
            toolName: 'api_retry',
            message: `transient Codex failure; retrying ${args.label} (${apiRetryCount}/${apiRetryLimit})`,
            isError: true,
            providerData: {
              retryCount: apiRetryCount,
              retryLimit: apiRetryLimit,
              message: providerError.message,
            },
          });
          await sleep(getApiRetryDelayMs(apiRetryCount));
          continue;
        }
        await emitProviderEvent(args.events, {
          type: 'provider_error',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role: 'coder',
          label: args.label,
          sessionHandle: providerError.sessionHandle,
          message: providerError.message,
          errorKind: providerError.kind,
        });
        throw providerError;
      }
    }
  }
}

class OpenAICodexStructuredAdvisorAdapter implements StructuredAdvisorAdapter {
  constructor(private readonly options: {
    model?: string | null;
    effort?: string | null;
    createThread?: CodexThreadFactory;
    sleep?: SleepFn;
  } = {}) {}

  async runStructuredRound<TStructured>(
    args: StructuredAdvisorRoundArgs<TStructured>,
  ): Promise<StructuredAdvisorRoundResult<TStructured>> {
    const createThread = this.options.createThread ?? createCodexThread;
    const sleep = this.options.sleep ?? defaultSleep;
    let apiRetryCount = 0;
    const apiRetryLimit = args.apiRetryLimit;

    while (true) {
      let thread: Thread | null = null;
      try {
        // Preflight the exact text the initial SDK turn will send: the
        // protocol-wrapped prompt on the local-JSON path
        // (buildStructuredJsonPrompt is the same pure builder
        // runStructuredJsonProtocol applies to the same inputs below, so the
        // checked text is byte-identical to the sent text), the bare prompt on
        // the provider-native path. Repair prompts are checked in runRepair
        // before their thread is created.
        assertCodexInputBudget({
          prompt:
            args.structuredJsonProtocol?.protocol === 'neal-json-block-v1'
              ? buildStructuredJsonPrompt(args.prompt, args.structuredJsonProtocol)
              : args.prompt,
          role: 'structured-advisor',
          sessionHandle: args.resumeHandle ?? null,
        });
        thread = createThread({
          cwd: args.cwd,
          sessionHandle: args.resumeHandle,
          model: this.options.model ?? undefined,
          effort: this.options.effort ?? undefined,
          skipGitRepoCheck: args.skipGitRepoCheck,
          sandboxMode: 'read-only',
        });
        const abortController = new AbortController();
        linkExternalAbortSignal(args.signal, abortController);

        if (args.structuredJsonProtocol?.protocol === 'neal-json-block-v1') {
          return await runStructuredJsonProtocol<TStructured>({
            provider: OPENAI_CODEX_PROVIDER_ID,
            role: 'structured-advisor',
            label: args.label,
            protocol: args.structuredJsonProtocol,
            prompt: args.prompt,
            events: args.events,
            initialSessionHandle: args.resumeHandle ?? null,
            runInitial: async (prompt) => {
              const streamedTurn = await thread!.runStreamed(prompt, {
                signal: abortController.signal,
              });
              const result = await consumeCodexAdvisorTurn(
                streamedTurn,
                args.cwd,
                args.label,
                args.inactivityTimeoutMs,
                args.events,
                abortController,
                this.options.model ?? null,
              );
              return {
                assistantText: result.finalResponse,
                sessionHandle: thread!.id ?? result.sessionHandle ?? null,
              };
            },
            runRepair: async (prompt) => {
              // A generated repair prompt embeds the invalid payload and the
              // original response, so it can exceed the budget even when the
              // initial prompt fit; preflight it before creating its thread.
              assertCodexInputBudget({
                prompt,
                role: 'structured-advisor',
                sessionHandle: thread!.id ?? args.resumeHandle ?? null,
              });
              const repairThread = createThread({
                cwd: args.cwd,
                model: this.options.model ?? undefined,
                effort: this.options.effort ?? undefined,
                skipGitRepoCheck: true,
                sandboxMode: 'read-only',
              });
              const repairAbortController = new AbortController();
              const streamedTurn = await repairThread.runStreamed(prompt, {
                signal: repairAbortController.signal,
              });
              const result = await consumeCodexAdvisorTurn(
                streamedTurn,
                args.cwd,
                args.label,
                args.inactivityTimeoutMs,
                args.events,
                repairAbortController,
                this.options.model ?? null,
              );
              return {
                assistantText: result.finalResponse,
                sessionHandle: repairThread.id ?? result.sessionHandle ?? null,
              };
            },
            createProviderError: (errorArgs) => createCodexProviderError({
              message: errorArgs.message,
              role: 'structured-advisor',
              sessionHandle: errorArgs.sessionHandle,
              kind: errorArgs.kind,
              retryable: false,
              cause: errorArgs.cause,
            }),
          });
        }

        const streamedTurn = await thread.runStreamed(
          args.prompt,
          buildCodexStructuredAdvisorRunOptions(args, abortController.signal),
        );
        const result = await consumeCodexAdvisorTurn(
          streamedTurn,
          args.cwd,
          args.label,
          args.inactivityTimeoutMs,
          args.events,
          abortController,
          this.options.model ?? null,
        );
        const structured = parseCodexStructuredOutput<TStructured>(result.finalResponse, args.label, thread.id);
        await emitProviderEvent(args.events, {
          type: 'structured_output_received',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role: 'structured-advisor',
          label: args.label,
          sessionHandle: thread.id,
        });

        return {
          sessionHandle: thread.id,
          structured,
        };
      } catch (error) {
        const providerError = normalizeCodexProviderError(error, {
          role: 'structured-advisor',
          sessionHandle: thread?.id ?? args.resumeHandle ?? null,
        });
        // Bounded in-round retry for transient provider failures, mirroring
        // the Claude advisor rounds: only retryable `api_error` kinds burn
        // budget and a caller abort never does. Each retry starts a fresh
        // thread; per the adapter contract resumed sessions pass 0.
        if (
          providerError.kind === 'api_error' &&
          providerError.retryable &&
          apiRetryCount < apiRetryLimit &&
          !args.signal?.aborted
        ) {
          apiRetryCount += 1;
          await emitProviderEvent(args.events, {
            type: 'tool_progress',
            provider: OPENAI_CODEX_PROVIDER_ID,
            role: 'structured-advisor',
            label: args.label,
            sessionHandle: providerError.sessionHandle,
            toolName: 'api_retry',
            message: `transient Codex failure; retrying ${args.label} (${apiRetryCount}/${apiRetryLimit})`,
            isError: true,
            providerData: {
              retryCount: apiRetryCount,
              retryLimit: apiRetryLimit,
              message: providerError.message,
            },
          });
          await sleep(getApiRetryDelayMs(apiRetryCount));
          continue;
        }
        await emitProviderEvent(args.events, {
          type: 'provider_error',
          provider: OPENAI_CODEX_PROVIDER_ID,
          role: 'structured-advisor',
          label: args.label,
          sessionHandle: providerError.sessionHandle,
          message: providerError.message,
          errorKind: providerError.kind,
        });
        throw providerError;
      }
    }
  }
}

export function createOpenAICodexCoderAdapter(options: { model?: string | null; effort?: string | null } = {}): CoderAdapter {
  return new OpenAICodexCoderAdapter(options);
}

export function createOpenAICodexStructuredAdvisorAdapter(options: { model?: string | null; effort?: string | null } = {}): StructuredAdvisorAdapter {
  return new OpenAICodexStructuredAdvisorAdapter(options);
}

export const openAICodexProviderDefinition = {
  id: 'openai-codex',
  displayName: 'OpenAI Codex',
  capabilities: {
    coder: {
      supported: true,
      toolAccess: {
        read: true,
        write: true,
        shell: true,
      },
      maxInputChars: OPENAI_CODEX_MAX_INPUT_CHARS,
      supportsSessionResume: true,
      supportsModelOverride: true,
      supportsStructuredOutput: true,
      usageReporting: 'opportunistic',
      supportedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    'structured-advisor': {
      supported: true,
      // Reviewers run read-only: no write, no shell. The structured-advisor
      // thread (primary and repair) runs under the SDK read-only sandbox so a
      // reviewer can inspect the checkout but never mutate it or run commands.
      toolAccess: {
        read: true,
        write: false,
        shell: false,
      },
      maxInputChars: OPENAI_CODEX_MAX_INPUT_CHARS,
      supportsSessionResume: true,
      supportsModelOverride: true,
      supportsStructuredOutput: true,
      usageReporting: 'opportunistic',
      supportedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
  },
  createCoderAdapter: createOpenAICodexCoderAdapter,
  createStructuredAdvisorAdapter: createOpenAICodexStructuredAdvisorAdapter,
} satisfies NealProviderDefinition;

export const openAICodexProviderTestHooks = {
  buildCodexStructuredAdvisorRunOptions,
  buildCodexThreadOptions,
  createCoderAdapterWithThreadFactory: (
    createThread: CodexThreadFactory,
    options?: { model?: string | null; effort?: string | null; sleep?: SleepFn },
  ) => new OpenAICodexCoderAdapter({ ...options, createThread }),
  createStructuredAdvisorAdapterWithThreadFactory: (
    createThread: CodexThreadFactory,
    options?: { model?: string | null; effort?: string | null; sleep?: SleepFn },
  ) => new OpenAICodexStructuredAdvisorAdapter({ ...options, createThread }),
  consumeCodexTurn,
  consumeCodexAdvisorTurn,
  parseCodexStructuredOutput,
};
