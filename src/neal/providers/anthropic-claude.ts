import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
  query,
  type HookCallback,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  buildStructuredJsonPrompt,
  runStructuredJsonProtocol,
  runStructuredJsonRepairLoop,
  validateStructuredJsonPayload,
  type StructuredJsonRepairLoopResult,
  type StructuredJsonValidationFailure,
  type StructuredJsonValidationResult,
  type StructuredJsonValidationSuccess,
} from '../agents/structured-json.js';
import { agentSettingsIsolated } from './agent-settings-isolation.js';
import { agentSubprocessEnv } from './git-config-isolation.js';
import { NealProviderError } from './types.js';
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
  StructuredJsonProtocolSpec,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from './types.js';

const ANTHROPIC_CLAUDE_PROVIDER_ID = 'anthropic-claude';
const requireFromProvider = createRequire(import.meta.url);
const requireFromClaudeSdk = createRequire(requireFromProvider.resolve('@anthropic-ai/claude-agent-sdk'));

type ClaudeExecutableResolutionOptions = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  glibcVersionRuntime?: string | undefined;
  resolve?: (specifier: string) => string;
};

function getGlibcVersionRuntime(): string | undefined {
  const report = process.report as
    | {
        getReport?: () => {
          header?: {
            glibcVersionRuntime?: unknown;
          };
        };
      }
    | undefined;
  const glibcVersionRuntime = report?.getReport?.().header?.glibcVersionRuntime;
  return typeof glibcVersionRuntime === 'string' && glibcVersionRuntime.length > 0 ? glibcVersionRuntime : undefined;
}

function isGlibcRuntime(glibcVersionRuntime?: string | undefined): boolean {
  return typeof glibcVersionRuntime === 'string' && glibcVersionRuntime.length > 0;
}

export function getClaudeCodeExecutablePath(options: ClaudeExecutableResolutionOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const resolve = options.resolve ?? requireFromClaudeSdk.resolve.bind(requireFromClaudeSdk);
  const glibcVersionRuntime =
    'glibcVersionRuntime' in options ? options.glibcVersionRuntime : getGlibcVersionRuntime();

  if (platform !== 'linux' || !isGlibcRuntime(glibcVersionRuntime)) {
    return undefined;
  }

  try {
    return resolve(`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`);
  } catch {
    return undefined;
  }
}

type ClaudePendingToolUse = {
  name: string;
  input: unknown;
};

type ClaudeLogState = {
  textBuffer: string;
  sawTextDelta: boolean;
  lastThinkingEmitMs: number;
  // tool_use blocks (id → {name, input}) awaiting their matching tool_result
  // within the current turn. Bash results map to `command_completed` and
  // write-tool results map to `file_changed` so Neal's verification-evidence
  // extraction (provider.command_completed), run metrics, and retrospectives
  // see Claude tool activity. Cleared at each result message (turn boundary)
  // so a dangling tool_use cannot leak across turns.
  pendingToolUses: Map<string, ClaudePendingToolUse>;
};

// Extended thinking can run for many minutes before the first visible text or
// tool call. Surfacing it keeps the turn-liveness watchdog from treating a
// deep-thinking turn as a silent stall, but thinking deltas arrive far too
// often to persist one event each, so emission is throttled per log state.
const THINKING_PROGRESS_EMIT_INTERVAL_MS = 30_000;

async function emitClaudeThinkingProgress(
  label: string,
  state: ClaudeLogState,
  events?: ProviderEventSink,
  sessionHandle?: string | null,
  role: ProviderRole = roleForClaudeLabel(label),
  estimatedTokens?: number,
) {
  const now = Date.now();
  if (now - state.lastThinkingEmitMs < THINKING_PROGRESS_EMIT_INTERVAL_MS) {
    return;
  }
  state.lastThinkingEmitMs = now;
  await emitProviderEvent(events, {
    type: 'assistant_thinking',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role,
    label,
    sessionHandle,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  });
}

type CollectedClaudeResult = {
  sessionHandle: string | null;
  lastResult: SDKResultMessage | null;
  firstStructuredResult: SDKResultMessage | null;
  assistantText: string;
};

class ClaudeInactivityTimeoutError extends Error {
  constructor(timeoutMs: number, label: string) {
    super(`Claude ${label} timed out after ${Math.round(timeoutMs / 1000)}s without progress`);
    this.name = 'ClaudeInactivityTimeoutError';
  }
}

// In-round transient (`api_error`) retries back off exponentially: 500 ms
// base, doubling per retry, capped at 5 s — the same schedule as the
// openai-compatible adapter. `sleep` is injectable through the run functions so
// tests observe the delays without wall-clock waiting.
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

async function emitProviderEvent(events: ProviderEventSink | undefined, event: ProviderRuntimeEvent) {
  await events?.(event);
}

function getMirroredAssistantText(event: ProviderRuntimeEvent, role: ProviderRole, label: string) {
  if (
    event.type !== 'assistant_text' ||
    event.provider !== ANTHROPIC_CLAUDE_PROVIDER_ID ||
    event.role !== role ||
    event.label !== label
  ) {
    return null;
  }

  const text = event.text.trim();
  return text ? text : null;
}

function roleForClaudeLabel(label: string): ProviderRole {
  return label === 'coder' ? 'coder' : 'structured-advisor';
}

async function flushClaudeText(
  label: string,
  state: ClaudeLogState,
  events?: ProviderEventSink,
  sessionHandle?: string | null,
  role: ProviderRole = roleForClaudeLabel(label),
): Promise<string | null> {
  const trimmed = state.textBuffer.trim();
  if (!trimmed) {
    state.textBuffer = '';
    return null;
  }

  await emitProviderEvent(events, {
    type: 'assistant_text',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role,
    label,
    sessionHandle,
    text: trimmed,
  });
  state.textBuffer = '';
  return trimmed;
}

async function appendClaudeText(
  label: string,
  state: ClaudeLogState,
  text: string,
  events?: ProviderEventSink,
  sessionHandle?: string | null,
  role: ProviderRole = roleForClaudeLabel(label),
): Promise<string[]> {
  state.sawTextDelta = true;
  state.textBuffer += text;

  const emittedTexts: string[] = [];
  const lines = state.textBuffer.split('\n');
  state.textBuffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    await emitProviderEvent(events, {
      type: 'assistant_text',
      provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
      role,
      label,
      sessionHandle,
      text: trimmed,
    });
    emittedTexts.push(trimmed);
  }
  return emittedTexts;
}

function getClaudeBashCommand(toolInput: unknown): string | null {
  if (toolInput === null || typeof toolInput !== 'object') {
    return null;
  }
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command : null;
}

// Extracts the human-readable text of a tool_result block: string content is
// used as-is; block-array content contributes its text blocks. Non-text
// content (images, documents) yields null.
function getClaudeToolResultText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      texts.push((block as { text: string }).text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

async function logClaudeMessage(
  label: string,
  message: SDKMessage,
  events?: ProviderEventSink,
  state?: ClaudeLogState,
  sessionHandle?: string | null,
  role: ProviderRole = roleForClaudeLabel(label),
  cwd?: string,
): Promise<string[]> {
  switch (message.type) {
    case 'assistant': {
      if (state) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            state.pendingToolUses.set(block.id, { name: block.name, input: block.input });
          }
        }
      }

      if (state?.sawTextDelta) {
        return [];
      }

      const textBlocks = message.message.content
        .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
        .map((block) => block.text.trim())
        .filter(Boolean);

      if (textBlocks.length > 0) {
        for (const text of textBlocks) {
          await emitProviderEvent(events, {
            type: 'assistant_text',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            text,
          });
        }
        return textBlocks;
      }
      break;
    }
    case 'user': {
      // SDK tool executions surface as user messages carrying tool_result
      // blocks. Matching them against the turn's pending tool_use blocks maps
      // Bash runs to `command_completed` and successful write-tool calls to
      // `file_changed`. Read-class tools (Read/Grep/Glob) intentionally emit
      // nothing here — they are not verification evidence. The mapping is
      // role-agnostic: advisor rounds run a read-only toolset, so they never
      // produce Bash or write tool_uses.
      if (!state) {
        break;
      }
      const content = message.message.content;
      if (!Array.isArray(content)) {
        break;
      }
      for (const block of content) {
        if (block.type !== 'tool_result') {
          continue;
        }
        const pending = state.pendingToolUses.get(block.tool_use_id);
        if (!pending) {
          continue;
        }
        state.pendingToolUses.delete(block.tool_use_id);
        if (pending.name === 'Bash') {
          const command = getClaudeBashCommand(pending.input);
          if (!command) {
            continue;
          }
          // The SDK's tool_result exposes no exit code, so `exitCode` is
          // omitted; `status` carries the is_error signal instead.
          const output = getClaudeToolResultText(block.content);
          await emitProviderEvent(events, {
            type: 'command_completed',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            itemId: block.tool_use_id,
            command,
            status: block.is_error === true ? 'failed' : 'completed',
            ...(output !== null ? { output } : {}),
            ...(cwd ? { cwd } : {}),
            providerData: { sdkMessageType: message.type, toolName: pending.name, toolUseId: block.tool_use_id },
          });
        } else if (CLAUDE_WRITE_TOOL_NAMES.has(pending.name) && block.is_error !== true) {
          // An is_error result means the write did not happen (e.g. a
          // write-path guard deny), so it must not claim a file change.
          const filePath = getClaudeWriteToolPath(pending.input);
          if (!filePath) {
            continue;
          }
          await emitProviderEvent(events, {
            type: 'file_changed',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            files: [filePath],
            providerData: { sdkMessageType: message.type, toolName: pending.name, toolUseId: block.tool_use_id },
          });
        }
      }
      break;
    }
    case 'stream_event':
      if (message.event.type === 'content_block_delta') {
        if (message.event.delta.type === 'text_delta' && state) {
          return await appendClaudeText(label, state, message.event.delta.text, events, sessionHandle, role);
        }
        if (message.event.delta.type === 'thinking_delta' && state) {
          await emitClaudeThinkingProgress(label, state, events, sessionHandle, role);
        }
      } else if (message.event.type === 'content_block_stop' && state) {
        const flushedText = await flushClaudeText(label, state, events, sessionHandle, role);
        return flushedText ? [flushedText] : [];
      }
      break;
    case 'tool_progress':
      await emitProviderEvent(events, {
        type: 'tool_progress',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role,
        label,
        sessionHandle,
        toolName: message.tool_name,
        message: `tool ${message.tool_name} running (${message.elapsed_time_seconds}s)`,
        providerData: {
          sdkMessageType: message.type,
          elapsedTimeSeconds: message.elapsed_time_seconds,
        },
      });
      break;
    case 'tool_use_summary':
      await emitProviderEvent(events, {
        type: 'tool_progress',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role,
        label,
        sessionHandle,
        toolName: 'tool_use_summary',
        message: message.summary,
        providerData: { sdkMessageType: message.type },
      });
      break;
    case 'system':
      switch (message.subtype) {
        case 'local_command_output':
          await emitProviderEvent(events, {
            type: 'tool_progress',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            toolName: 'local_command_output',
            message: message.content,
            providerData: { sdkMessageType: message.type, subtype: message.subtype },
          });
          break;
        case 'task_started':
          await emitProviderEvent(events, {
            type: 'tool_started',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            toolName: 'task',
            providerData: { sdkMessageType: message.type, subtype: message.subtype, description: message.description },
          });
          await emitProviderEvent(events, {
            type: 'tool_progress',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            toolName: 'task',
            message: `task started: ${message.description}`,
            providerData: { sdkMessageType: message.type, subtype: message.subtype },
          });
          break;
        case 'task_progress':
          await emitProviderEvent(events, {
            type: 'tool_progress',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            toolName: 'task',
            message: message.description,
            providerData: { sdkMessageType: message.type, subtype: message.subtype },
          });
          break;
        case 'task_notification':
          await emitProviderEvent(events, {
            type: 'tool_progress',
            provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
            role,
            label,
            sessionHandle,
            toolName: 'task',
            message: `task ${message.status}: ${message.summary}`,
            providerData: { sdkMessageType: message.type, subtype: message.subtype, status: message.status },
          });
          break;
        case 'thinking_tokens':
          if (state) {
            await emitClaudeThinkingProgress(label, state, events, sessionHandle, role, message.estimated_tokens);
          }
          break;
        case 'status':
          if (message.status) {
            await emitProviderEvent(events, {
              type: 'tool_progress',
              provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
              role,
              label,
              sessionHandle,
              toolName: 'status',
              message: `status: ${message.status}`,
              providerData: { sdkMessageType: message.type, subtype: message.subtype },
            });
          }
          break;
        default:
          break;
      }
      break;
    case 'result':
      // Turn boundary: a tool_use whose result never arrived must not match a
      // tool_result from a later turn in the same stream.
      state?.pendingToolUses.clear();
      await emitProviderEvent(events, {
        type: 'turn_completed',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role,
        label,
        sessionHandle,
        usage: message.usage,
        // One `result` message is one query invocation = one turn, so
        // `total_cost_usd` is a per-turn figure that sums cleanly across turns.
        costUsd: message.total_cost_usd,
        costSource: 'provider',
        providerData: { sdkMessageType: message.type, subtype: message.subtype },
      });
      if (message.usage !== undefined) {
        await emitProviderEvent(events, {
          type: 'usage_reported',
          provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
          role,
          label,
          sessionHandle,
          usage: message.usage,
          costUsd: message.total_cost_usd,
          costSource: 'provider',
          providerData: { sdkMessageType: message.type, subtype: message.subtype },
        });
      }
      break;
    default:
      break;
  }
  return [];
}

// The timeout callback (which aborts the underlying query) runs before the
// synchronous rejection, so the surfaced error is always the retryable
// inactivity-timeout error — never the SDK's abort error, which would
// misclassify the stall as a caller abort. Mirrors the Codex adapter.
async function nextWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      rejectPromise(new ClaudeInactivityTimeoutError(timeoutMs, label));
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

function inferClaudeErrorKind(
  error: unknown,
  message: string,
  fallback: NealProviderErrorKind,
  subtype?: string | null,
): NealProviderErrorKind {
  const text = `${subtype ?? ''}\n${message}`.toLowerCase();
  if (error instanceof ClaudeInactivityTimeoutError || /\btimed out after\b/i.test(message)) {
    return 'timeout';
  }
  if (text.includes('permission') || text.includes('denied') || text.includes('forbidden') || text.includes('not authorized')) {
    return 'permission_denied';
  }
  if (text.includes('failed to provide valid structured output')) {
    return 'structured_output_invalid';
  }
  if (text.includes('resume') || text.includes('session not found') || text.includes('session unavailable')) {
    return 'session_unavailable';
  }
  if (isTransientClaudeFailure(subtype ?? null, message)) {
    return 'api_error';
  }
  return fallback;
}

function isRetryableClaudeError(kind: NealProviderErrorKind) {
  return kind === 'timeout' || kind === 'session_unavailable' || kind === 'api_error';
}

function createClaudeProviderError(args: {
  message: string;
  role: ProviderRole;
  sessionHandle?: string | null;
  kind?: NealProviderErrorKind;
  retryable?: boolean;
  cause?: unknown;
  subtype?: string | null;
}) {
  const kind = args.kind ?? inferClaudeErrorKind(args.cause, args.message, 'provider_failed', args.subtype);
  return new NealProviderError({
    message: args.message,
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: args.role,
    sessionHandle: args.sessionHandle,
    kind,
    retryable: args.retryable ?? isRetryableClaudeError(kind),
    cause: args.cause,
  });
}

function normalizeClaudeProviderError(
  error: unknown,
  args: {
    role: ProviderRole;
    sessionHandle?: string | null;
    kind?: NealProviderErrorKind;
    subtype?: string | null;
  },
) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NealProviderError) {
    if (error.sessionHandle || !args.sessionHandle) {
      return error;
    }
    return createClaudeProviderError({
      message: error.message,
      role: error.role,
      sessionHandle: args.sessionHandle,
      kind: error.kind,
      retryable: error.retryable,
      cause: error,
    });
  }

  return createClaudeProviderError({
    message,
    role: args.role,
    sessionHandle: args.sessionHandle,
    kind: args.kind,
    cause: error,
    subtype: args.subtype,
  });
}

async function emitClaudeProviderError(events: ProviderEventSink | undefined, error: NealProviderError, label?: string) {
  await emitProviderEvent(events, {
    type: 'provider_error',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: error.role,
    label: label ?? (error.role === 'coder' ? 'coder' : undefined),
    sessionHandle: error.sessionHandle,
    message: error.message,
    errorKind: error.kind,
  });
}

function hasStructuredOutput(message: SDKResultMessage) {
  const raw = message as { structured_output?: unknown };
  return raw.structured_output !== undefined && raw.structured_output !== null;
}

function getPreferredStructuredOutput<TStructured>(result: CollectedClaudeResult) {
  const structuredResult = result.firstStructuredResult ?? result.lastResult;
  const structuredOutput = (structuredResult as { structured_output?: TStructured | null } | null)?.structured_output;
  return structuredOutput === null ? undefined : structuredOutput;
}

async function collectClaudeResult(
  stream: AsyncGenerator<SDKMessage, void>,
  cwd: string,
  label: string,
  inactivityTimeoutMs: number,
  events?: ProviderEventSink,
  role: ProviderRole = roleForClaudeLabel(label),
  abortController?: AbortController,
): Promise<CollectedClaudeResult> {
  let sessionHandle: string | null = null;
  let lastResult: SDKResultMessage | null = null;
  let firstStructuredResult: SDKResultMessage | null = null;
  const logState: ClaudeLogState = {
    textBuffer: '',
    sawTextDelta: false,
    lastThinkingEmitMs: 0,
    pendingToolUses: new Map(),
  };
  const assistantTexts: string[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    let next;
    try {
      // Aborting the per-turn controller cancels the SDK query on inactivity
      // timeout, so a stalled turn stops burning its child process and tokens
      // instead of racing a retry; the SDK owns stream teardown on abort, so
      // no manual iterator.return() is needed (mirroring the Codex adapter).
      next = await nextWithTimeout(iterator.next(), inactivityTimeoutMs, label, () => abortController?.abort());
    } catch (error) {
      throw normalizeClaudeProviderError(error, {
        role,
        sessionHandle,
      });
    }
    if (next.done) {
      break;
    }

    const message = next.value;
    const previousSessionHandle = sessionHandle;
    sessionHandle = sessionHandle ?? message.session_id ?? null;
    if (!previousSessionHandle && sessionHandle) {
      await emitProviderEvent(events, {
        type: 'session_started',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role,
        label,
        sessionHandle,
        providerData: { sdkMessageType: message.type },
      });
    }
    const emittedAssistantTexts = await logClaudeMessage(label, message, events, logState, sessionHandle, role, cwd);
    if (emittedAssistantTexts.length > 0) {
      assistantTexts.push(emittedAssistantTexts.join('\n\n'));
    }
    if (message.type === 'result') {
      lastResult = message;
      if (firstStructuredResult === null && hasStructuredOutput(message)) {
        // Claude can emit late result messages for background tasks after the structured round result.
        firstStructuredResult = message;
      }
    }
  }

  const flushedText = await flushClaudeText(label, logState, events, sessionHandle, role);
  if (flushedText) {
    assistantTexts.push(flushedText);
  }
  return {
    sessionHandle,
    lastResult,
    firstStructuredResult,
    assistantText: assistantTexts.join('\n\n').trim(),
  };
}

// Creates the SDK-facing AbortController for one Claude turn so both
// orchestration-level supervision (via the external caller-owned abort
// signal, when present) and the per-turn inactivity timeout can cancel an
// in-flight query through `Options.abortController`. Repair turns receive
// their own unlinked controllers: repairs are short, prompt-only turns that
// caller aborts intentionally do not cancel, but the inactivity timeout
// still must be able to tear them down.
function createClaudeTurnAbortController(signal: AbortSignal | undefined): AbortController {
  const abortController = new AbortController();
  if (!signal) {
    return abortController;
  }
  if (signal.aborted) {
    abortController.abort(signal.reason);
  } else {
    signal.addEventListener('abort', () => abortController.abort(signal.reason), { once: true });
  }
  return abortController;
}

// Builder-default derivation: when the run loop does not pass a per-turn
// controller explicitly, query options carry an abortController only for an
// external caller-owned abort signal.
function deriveClaudeAbortController(signal: AbortSignal | undefined): AbortController | undefined {
  return signal ? createClaudeTurnAbortController(signal) : undefined;
}

// Single source of truth for Claude SDK query-option construction. The five
// named builders below (advisor, json-block advisor, json-block repair, coder,
// coder repair) are thin wrappers that configure this core with their genuine
// deltas: role/label stamping for stderr events, tools list, optional
// structured outputFormat, resume handle, per-turn abort controller, and the
// coder's optional write-guard hooks.
type ClaudeQueryOptionsSpec = {
  cwd: string;
  abortController: AbortController | undefined;
  model: string | null | undefined;
  effort: string | null | undefined;
  tools: NonNullable<Options['tools']>;
  hooks?: Options['hooks'];
  resumeHandle?: string | null;
  claudeExecutablePath: string | undefined;
  outputSchema?: Record<string, unknown>;
  events?: ProviderEventSink;
  stderrRole: ProviderRole;
  stderrLabel: string;
  stderrSessionHandle: string | null;
};

function buildClaudeCoreQueryOptions(spec: ClaudeQueryOptionsSpec): Options {
  return {
    cwd: spec.cwd,
    // Full environment plus the git-config isolation overrides: Claude's Bash
    // tool must not be able to write the operator's real global gitconfig.
    // See git-config-isolation.ts.
    env: agentSubprocessEnv(),
    ...(spec.abortController ? { abortController: spec.abortController } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort as Options['effort'] } : {}),
    tools: spec.tools,
    ...(spec.hooks ? { hooks: spec.hooks } : {}),
    // Under compat qualification only, run Claude in the SDK's isolation mode
    // (load no filesystem settings). Left unset, the SDK loads ~/.claude and any
    // repo .claude by default, pulling in the operator's interactive config —
    // permissions, statusline, CLAUDE.md, and the Stop / Notification hooks that
    // fire a desktop notifier on every turn. compat runs the whole role matrix,
    // so those hooks would spam one notification per turn; isolating keeps the
    // capability probe quiet and hermetic. Normal neal runs (pipeline, local
    // `neal go`) honor the operator's config — it's their machine. neal's own
    // hooks (the coder write-path guard passed programmatically above) are
    // unaffected either way. See agent-settings-isolation.ts.
    ...(agentSettingsIsolated() ? { settingSources: [] as const } : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    ...(spec.resumeHandle ? { resume: spec.resumeHandle } : {}),
    ...(spec.claudeExecutablePath ? { pathToClaudeCodeExecutable: spec.claudeExecutablePath } : {}),
    ...(spec.outputSchema
      ? {
          outputFormat: {
            type: 'json_schema' as const,
            schema: spec.outputSchema,
          },
        }
      : {}),
    stderr: (data) => {
      void spec.events?.({
        type: 'tool_progress',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role: spec.stderrRole,
        label: spec.stderrLabel,
        sessionHandle: spec.stderrSessionHandle,
        toolName: 'stderr',
        message: data,
        isError: true,
        providerData: { stream: 'stderr' },
      });
    },
  };
}

function buildClaudeQueryOptions(
  args: StructuredAdvisorRoundArgs,
  defaultModel?: string | null,
  claudeExecutablePath = getClaudeCodeExecutablePath(),
  defaultEffort?: string | null,
  abortController: AbortController | undefined = deriveClaudeAbortController(args.signal),
): Options {
  return buildClaudeCoreQueryOptions({
    cwd: args.cwd,
    abortController,
    model: args.model ?? defaultModel,
    effort: defaultEffort,
    tools: ['Read', 'Grep', 'Glob'],
    resumeHandle: args.resumeHandle,
    claudeExecutablePath,
    outputSchema: args.schema,
    events: args.events,
    stderrRole: 'structured-advisor',
    stderrLabel: args.label,
    stderrSessionHandle: args.resumeHandle ?? null,
  });
}

function buildClaudeQueryStream(
  args: StructuredAdvisorRoundArgs,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) {
  return query({
    prompt: args.prompt,
    options: buildClaudeQueryOptions(args, defaultModel, undefined, defaultEffort, abortController),
  });
}

function buildClaudeJsonBlockReviewPrompt(args: StructuredAdvisorRoundArgs<unknown>) {
  if (args.structuredJsonProtocol?.protocol === 'neal-json-block-v1') {
    return buildStructuredJsonPrompt(args.prompt, args.structuredJsonProtocol);
  }

  return args.prompt;
}

function buildClaudeJsonBlockQueryOptions(
  args: StructuredAdvisorRoundArgs<unknown>,
  defaultModel?: string | null,
  claudeExecutablePath = getClaudeCodeExecutablePath(),
  defaultEffort?: string | null,
  abortController: AbortController | undefined = deriveClaudeAbortController(args.signal),
): Options {
  return buildClaudeCoreQueryOptions({
    cwd: args.cwd,
    abortController,
    model: args.model ?? defaultModel,
    effort: defaultEffort,
    tools: ['Read', 'Grep', 'Glob'],
    resumeHandle: args.resumeHandle,
    claudeExecutablePath,
    events: args.events,
    stderrRole: 'structured-advisor',
    stderrLabel: args.label,
    stderrSessionHandle: args.resumeHandle ?? null,
  });
}

function buildClaudeJsonBlockQueryStream(
  args: StructuredAdvisorRoundArgs<unknown>,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) {
  return query({
    prompt: buildClaudeJsonBlockReviewPrompt(args),
    options: buildClaudeJsonBlockQueryOptions(args, defaultModel, undefined, defaultEffort, abortController),
  });
}

function buildClaudeJsonBlockRepairQueryOptions(
  args: StructuredAdvisorRoundArgs<unknown>,
  defaultModel?: string | null,
  claudeExecutablePath = getClaudeCodeExecutablePath(),
  defaultEffort?: string | null,
  abortController?: AbortController,
): Options {
  return buildClaudeCoreQueryOptions({
    cwd: args.cwd,
    abortController,
    model: args.model ?? defaultModel,
    effort: defaultEffort,
    tools: [],
    claudeExecutablePath,
    events: args.events,
    stderrRole: 'structured-advisor',
    stderrLabel: `${args.label}:structured-json-repair`,
    stderrSessionHandle: null,
  });
}

function buildClaudeJsonBlockRepairQueryStream(
  args: StructuredAdvisorRoundArgs<unknown>,
  repairPrompt: string,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) {
  return query({
    prompt: repairPrompt,
    options: buildClaudeJsonBlockRepairQueryOptions(args, defaultModel, undefined, defaultEffort, abortController),
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

  const errors = (raw as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const messages = errors
      .map((error) => (typeof error === 'string' ? error.trim() : ''))
      .filter(Boolean);
    if (messages.length > 0) {
      return messages.join('; ');
    }
  }

  return null;
}

// Callers classifying SDK result messages must gate on `is_error` before
// calling this: a successful result's `result` field is the assistant's final
// text, which can legitimately contain failure vocabulary (plans, reviews, and
// docs that discuss error handling all mention strings like "api_error" or
// "rate limit"), and matching on it turns a document about retries into an
// endless retry loop.
function isTransientClaudeFailure(subtype: string | null, message: string | null) {
  const text = `${subtype ?? ''}\n${message ?? ''}`.toLowerCase();
  return (
    text.includes('api_error') ||
    text.includes('api error') ||
    text.includes('internal server error') ||
    text.includes('overloaded') ||
    text.includes('rate limit') ||
    text.includes('temporar') ||
    (
      subtype === 'error_during_execution' &&
      text.includes('[ede_diagnostic]') &&
      text.includes('result_type=assistant') &&
      text.includes('last_content_type=none') &&
      text.includes('stop_reason=end_turn')
    ) ||
    text.includes('try again')
  );
}

type ClaudeStructuredAdvisorStreamFactory = (
  args: StructuredAdvisorRoundArgs,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) => AsyncGenerator<SDKMessage, void>;

type ClaudeJsonBlockStructuredAdvisorStreamFactory = (
  args: StructuredAdvisorRoundArgs<unknown>,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) => AsyncGenerator<SDKMessage, void>;

type ClaudeJsonBlockStructuredAdvisorRepairStreamFactory = (
  args: StructuredAdvisorRoundArgs<unknown>,
  repairPrompt: string,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) => AsyncGenerator<SDKMessage, void>;

type ClaudeCoderStreamFactory = (
  args: CoderRunPromptArgs,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) => AsyncGenerator<SDKMessage, void>;

type ClaudeCoderRepairStreamFactory = (
  args: CoderStructuredPromptArgs<unknown>,
  repairPrompt: string,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) => AsyncGenerator<SDKMessage, void>;

function isStructuredOutputRetryExhaustion(subtype: string | null, message: string | null) {
  const text = `${subtype ?? ''}\n${message ?? ''}`.toLowerCase();
  return (
    subtype === 'error_max_structured_output_retries' ||
    text.includes('failed to provide valid structured output')
  );
}

function getClaudeStructuredFailureKind(subtype: string | null, message: string | null): NealProviderErrorKind {
  if (isTransientClaudeFailure(subtype, message)) {
    return 'api_error';
  }
  if (isStructuredOutputRetryExhaustion(subtype, message)) {
    return 'structured_output_invalid';
  }
  return subtype === 'success' || subtype === null ? 'structured_output_missing' : 'provider_failed';
}

type ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured> = StructuredAdvisorRoundArgs<TStructured> & {
  structuredJsonProtocol: StructuredJsonProtocolSpec<TStructured>;
};

function isClaudeJsonBlockStructuredAdvisorRound<TStructured>(
  args: StructuredAdvisorRoundArgs<TStructured>,
): args is ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured> {
  return args.structuredJsonProtocol?.protocol === 'neal-json-block-v1';
}

function getClaudeAssistantTextForLocalJson(result: CollectedClaudeResult, mirroredAssistantText = '') {
  return [
    result.assistantText,
    mirroredAssistantText,
    getClaudeResultErrorMessage(result.lastResult) ?? '',
  ].find((value) => value.trim().length > 0)?.trim() ?? '';
}

function getStructuredJsonFailureSummaries(failure: StructuredJsonValidationFailure) {
  return {
    parseErrorSummary: failure.phase === 'extraction' ? failure.errorSummary : undefined,
    validationErrorSummary: failure.phase === 'validation' ? failure.errorSummary : undefined,
  };
}

function buildStructuredJsonProviderData<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  attemptNumber: number;
  assistantTextLength: number;
  source?: string;
  rawJson?: string | null;
  failure?: StructuredJsonValidationFailure;
  originalSessionHandle?: string | null;
  repairSessionHandle?: string | null;
}) {
  const summaries: { parseErrorSummary?: string; validationErrorSummary?: string } = args.failure
    ? getStructuredJsonFailureSummaries(args.failure)
    : {};
  return {
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: 'structured-advisor',
    label: args.roundArgs.label,
    protocol: args.roundArgs.structuredJsonProtocol.protocol,
    schemaLabel: args.roundArgs.structuredJsonProtocol.schemaLabel,
    attemptNumber: args.attemptNumber,
    repairAttemptLimit: args.roundArgs.structuredJsonProtocol.repairAttemptLimit,
    assistantTextLength: args.assistantTextLength,
    extractedJsonLength: args.rawJson?.length ?? 0,
    ...(args.source ? { source: args.source } : {}),
    ...(summaries.parseErrorSummary ? { parseErrorSummary: summaries.parseErrorSummary } : {}),
    ...(summaries.validationErrorSummary ? { validationErrorSummary: summaries.validationErrorSummary } : {}),
    ...(args.originalSessionHandle !== undefined ? { originalSessionHandle: args.originalSessionHandle } : {}),
    ...(args.repairSessionHandle !== undefined ? { repairSessionHandle: args.repairSessionHandle } : {}),
  };
}

async function emitStructuredJsonExtractionStarted<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  assistantText: string;
  sessionHandle: string | null;
  attemptNumber: number;
  originalSessionHandle?: string | null;
  repairSessionHandle?: string | null;
}) {
  await emitProviderEvent(args.roundArgs.events, {
    type: 'tool_progress',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: 'structured-advisor',
    label: args.roundArgs.label,
    sessionHandle: args.sessionHandle,
    toolName: 'structured_json_extraction_started',
    message: 'Extracting Claude review JSON control payload.',
    providerData: buildStructuredJsonProviderData({
      roundArgs: args.roundArgs,
      attemptNumber: args.attemptNumber,
      assistantTextLength: args.assistantText.length,
      originalSessionHandle: args.originalSessionHandle,
      repairSessionHandle: args.repairSessionHandle,
    }),
  });
}

async function emitStructuredJsonFailure<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  failure: StructuredJsonValidationFailure;
  assistantTextLength: number;
  sessionHandle: string | null;
  attemptNumber: number;
  originalSessionHandle?: string | null;
  repairSessionHandle?: string | null;
}) {
  const toolName =
    args.failure.phase === 'validation'
      ? 'structured_json_validation_failed'
      : 'structured_json_extraction_failed';
  await emitProviderEvent(args.roundArgs.events, {
    type: 'tool_progress',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: 'structured-advisor',
    label: args.roundArgs.label,
    sessionHandle: args.sessionHandle,
    toolName,
    message:
      args.failure.phase === 'validation'
        ? 'Claude review JSON control payload failed Neal validation.'
        : 'Claude review JSON control payload could not be extracted or parsed.',
    isError: true,
    providerData: buildStructuredJsonProviderData({
      roundArgs: args.roundArgs,
      attemptNumber: args.attemptNumber,
      assistantTextLength: args.assistantTextLength,
      rawJson: args.failure.extraction.rawJson,
      failure: args.failure,
      originalSessionHandle: args.originalSessionHandle,
      repairSessionHandle: args.repairSessionHandle,
    }),
  });
}

async function emitStructuredJsonRepairStarted<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  attemptNumber: number;
  attemptLimit: number;
  assistantTextLength: number;
  originalSessionHandle: string | null;
}) {
  await emitProviderEvent(args.roundArgs.events, {
    type: 'tool_progress',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: 'structured-advisor',
    label: args.roundArgs.label,
    sessionHandle: args.originalSessionHandle,
    toolName: 'structured_json_repair_started',
    message: `Repairing Claude review JSON control payload (${args.attemptNumber}/${args.attemptLimit}).`,
    providerData: buildStructuredJsonProviderData({
      roundArgs: args.roundArgs,
      attemptNumber: args.attemptNumber,
      assistantTextLength: args.assistantTextLength,
      originalSessionHandle: args.originalSessionHandle,
    }),
  });
}

async function emitStructuredJsonOutputReceived<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  validation: StructuredJsonValidationSuccess<TStructured>;
  assistantTextLength: number;
  sessionHandle: string | null;
  attemptNumber: number;
  originalSessionHandle?: string | null;
  repairSessionHandle?: string | null;
}) {
  await emitProviderEvent(args.roundArgs.events, {
    type: 'structured_output_received',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: 'structured-advisor',
    label: args.roundArgs.label,
    sessionHandle: args.sessionHandle,
    providerData: buildStructuredJsonProviderData({
      roundArgs: args.roundArgs,
      attemptNumber: args.attemptNumber,
      assistantTextLength: args.assistantTextLength,
      source: args.validation.source,
      rawJson: args.validation.rawJson,
      originalSessionHandle: args.originalSessionHandle,
      repairSessionHandle: args.repairSessionHandle,
    }),
  });
}

async function validateClaudeJsonBlockResponse<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  assistantText: string;
  sessionHandle: string | null;
  attemptNumber: number;
  originalSessionHandle?: string | null;
  repairSessionHandle?: string | null;
}): Promise<StructuredJsonValidationResult<TStructured>> {
  await emitStructuredJsonExtractionStarted(args);
  const validation = validateStructuredJsonPayload(
    args.assistantText,
    args.roundArgs.structuredJsonProtocol.validator,
  );
  if (!validation.ok) {
    await emitStructuredJsonFailure({
      roundArgs: args.roundArgs,
      failure: validation,
      assistantTextLength: args.assistantText.length,
      sessionHandle: args.sessionHandle,
      attemptNumber: args.attemptNumber,
      originalSessionHandle: args.originalSessionHandle,
      repairSessionHandle: args.repairSessionHandle,
    });
  }
  return validation;
}

async function repairClaudeJsonBlockResponse<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  assistantText: string;
  initialFailure: StructuredJsonValidationFailure;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  originalSessionHandle: string | null;
  createRepairStream: ClaudeJsonBlockStructuredAdvisorRepairStreamFactory;
}) {
  let repairResult: StructuredJsonRepairLoopResult<TStructured>;
  try {
    repairResult = await runStructuredJsonRepairLoop({
      originalAssistantText: args.assistantText,
      initialFailure: args.initialFailure,
      schemaLabel: args.roundArgs.structuredJsonProtocol.schemaLabel,
      schema: args.roundArgs.schema,
      attemptLimit: args.roundArgs.structuredJsonProtocol.repairAttemptLimit,
      validator: args.roundArgs.structuredJsonProtocol.validator,
      callRepair: async ({ prompt, attemptNumber, attemptLimit }) => {
        await emitStructuredJsonRepairStarted({
          roundArgs: args.roundArgs,
          attemptNumber,
          attemptLimit,
          assistantTextLength: args.assistantText.length,
          originalSessionHandle: args.originalSessionHandle,
        });
        const repairAbortController = new AbortController();
        const stream = args.createRepairStream(
          args.roundArgs,
          prompt,
          args.defaultModel,
          args.defaultEffort,
          repairAbortController,
        );
        const result = await collectClaudeResult(
          stream,
          args.roundArgs.cwd,
          `${args.roundArgs.label}:structured-json-repair`,
          args.roundArgs.inactivityTimeoutMs,
          args.roundArgs.events,
          'structured-advisor',
          repairAbortController,
        );
        return {
          assistantText: getClaudeAssistantTextForLocalJson(result),
          sessionHandle: result.sessionHandle,
        };
      },
    });
  } catch (error) {
    const providerError = normalizeClaudeProviderError(error, {
      role: 'structured-advisor',
      sessionHandle: args.originalSessionHandle,
      kind: 'structured_output_invalid',
    });
    await emitProviderEvent(args.roundArgs.events, {
      type: 'tool_progress',
      provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
      role: 'structured-advisor',
      label: args.roundArgs.label,
      sessionHandle: providerError.sessionHandle,
      toolName: 'structured_json_repair_failed',
      message: 'Claude review JSON control payload repair failed before producing a valid Neal payload.',
      isError: true,
      providerData: {
        ...buildStructuredJsonProviderData({
          roundArgs: args.roundArgs,
          attemptNumber: 0,
          assistantTextLength: args.assistantText.length,
          failure: args.initialFailure,
          originalSessionHandle: args.originalSessionHandle,
        }),
        errorKind: providerError.kind,
        errorMessage: providerError.message,
      },
    });
    await emitClaudeProviderError(args.roundArgs.events, providerError, args.roundArgs.label);
    throw providerError;
  }

  for (const attempt of repairResult.attempts) {
    if (!attempt.result.ok) {
      await emitStructuredJsonFailure({
        roundArgs: args.roundArgs,
        failure: attempt.result,
        assistantTextLength: args.assistantText.length,
        sessionHandle: args.originalSessionHandle ?? attempt.sessionHandle,
        attemptNumber: attempt.attemptNumber,
        originalSessionHandle: args.originalSessionHandle,
        repairSessionHandle: attempt.sessionHandle,
      });
    }
  }

  if (repairResult.ok) {
    const returnedSessionHandle = args.originalSessionHandle ?? repairResult.sessionHandle;
    await emitProviderEvent(args.roundArgs.events, {
      type: 'tool_progress',
      provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
      role: 'structured-advisor',
      label: args.roundArgs.label,
      sessionHandle: returnedSessionHandle,
      toolName: 'structured_json_repair_succeeded',
      message: 'Claude review JSON control payload repair produced a valid Neal payload.',
      providerData: buildStructuredJsonProviderData({
        roundArgs: args.roundArgs,
        attemptNumber: repairResult.attemptNumber,
        assistantTextLength: args.assistantText.length,
        source: repairResult.result.source,
        rawJson: repairResult.result.rawJson,
        originalSessionHandle: args.originalSessionHandle,
        repairSessionHandle: repairResult.sessionHandle,
      }),
    });
    await emitStructuredJsonOutputReceived({
      roundArgs: args.roundArgs,
      validation: repairResult.result,
      assistantTextLength: args.assistantText.length,
      sessionHandle: returnedSessionHandle,
      attemptNumber: repairResult.attemptNumber,
      originalSessionHandle: args.originalSessionHandle,
      repairSessionHandle: repairResult.sessionHandle,
    });
    return {
      sessionHandle: returnedSessionHandle,
      structured: repairResult.result.structured,
    };
  }

  await emitProviderEvent(args.roundArgs.events, {
    type: 'tool_progress',
    provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
    role: 'structured-advisor',
    label: args.roundArgs.label,
    sessionHandle: args.originalSessionHandle,
    toolName: 'structured_json_repair_failed',
    message: 'Claude review JSON control payload repair attempts were exhausted.',
    isError: true,
    providerData: buildStructuredJsonProviderData({
      roundArgs: args.roundArgs,
      attemptNumber: repairResult.attempts.at(-1)?.attemptNumber ?? args.roundArgs.structuredJsonProtocol.repairAttemptLimit,
      assistantTextLength: args.assistantText.length,
      rawJson: repairResult.lastFailure.extraction.rawJson,
      failure: repairResult.lastFailure,
      originalSessionHandle: args.originalSessionHandle,
      repairSessionHandle: repairResult.attempts.at(-1)?.sessionHandle ?? null,
    }),
  });

  const providerError = createClaudeProviderError({
    message: `Claude review JSON control payload remained invalid after ${args.roundArgs.structuredJsonProtocol.repairAttemptLimit} repair attempt(s): ${repairResult.lastFailure.errorSummary}`,
    role: 'structured-advisor',
    sessionHandle: args.originalSessionHandle,
    kind: 'structured_output_invalid',
    retryable: false,
    cause: repairResult.lastFailure,
  });
  await emitClaudeProviderError(args.roundArgs.events, providerError, args.roundArgs.label);
  throw providerError;
}

async function validateOrRepairClaudeJsonBlockResponse<TStructured>(args: {
  roundArgs: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
  assistantText: string;
  defaultModel?: string | null;
  defaultEffort?: string | null;
  sessionHandle: string | null;
  createRepairStream: ClaudeJsonBlockStructuredAdvisorRepairStreamFactory;
}) {
  try {
    return await runStructuredJsonProtocol<TStructured>({
      provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
      role: 'structured-advisor',
      label: args.roundArgs.label,
      protocol: args.roundArgs.structuredJsonProtocol,
      prompt: args.roundArgs.prompt,
      events: args.roundArgs.events,
      initialSessionHandle: args.sessionHandle,
      runInitial: async () => ({
        assistantText: args.assistantText,
        sessionHandle: args.sessionHandle,
      }),
      runRepair: async (prompt) => {
        const repairAbortController = new AbortController();
        const stream = args.createRepairStream(
          args.roundArgs,
          prompt,
          args.defaultModel,
          args.defaultEffort,
          repairAbortController,
        );
        const result = await collectClaudeResult(
          stream,
          args.roundArgs.cwd,
          `${args.roundArgs.label}:structured-json-repair`,
          args.roundArgs.inactivityTimeoutMs,
          args.roundArgs.events,
          'structured-advisor',
          repairAbortController,
        );
        return {
          assistantText: getClaudeAssistantTextForLocalJson(result),
          sessionHandle: result.sessionHandle,
        };
      },
      createProviderError: (errorArgs) => createClaudeProviderError({
        message: errorArgs.message,
        role: 'structured-advisor',
        sessionHandle: errorArgs.sessionHandle,
        kind: errorArgs.kind,
        retryable: false,
        cause: errorArgs.cause,
      }),
    });
  } catch (error) {
    const providerError = normalizeClaudeProviderError(error, {
      role: 'structured-advisor',
      sessionHandle: args.sessionHandle,
      kind: 'structured_output_invalid',
    });
    await emitClaudeProviderError(args.roundArgs.events, providerError, args.roundArgs.label);
    throw providerError;
  }
}

// The one merged advisor round loop below serves both structured-output
// protocols; this discriminated union carries the per-protocol configuration
// (the json-block protocol additionally needs a repair-turn stream factory).
type ClaudeStructuredAdvisorRoundRun<TStructured> =
  | {
      protocol: 'json-block';
      args: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>;
      createStream: ClaudeJsonBlockStructuredAdvisorStreamFactory;
      createRepairStream: ClaudeJsonBlockStructuredAdvisorRepairStreamFactory;
    }
  | {
      protocol: 'native';
      args: StructuredAdvisorRoundArgs<TStructured>;
      createStream: ClaudeStructuredAdvisorStreamFactory;
    };

// Both advisor protocols give up on an unsuccessful Claude result with the
// same normalized provider error; only the loop position at which each
// protocol reaches this differs (see runClaudeStructuredAdvisorRoundLoop).
async function createClaudeAdvisorUnsuccessfulResultError(details: {
  events: ProviderEventSink | undefined;
  label: string;
  subtype: string | null;
  resultErrorMessage: string | null;
  sessionHandle: string | null;
}): Promise<NealProviderError> {
  const providerError = createClaudeProviderError({
    message: details.resultErrorMessage
      ? `Claude ${details.label} did not return a successful result${details.subtype ? ` (${details.subtype})` : ''}: ${details.resultErrorMessage}`
      : `Claude ${details.label} did not return a successful result${details.subtype ? ` (${details.subtype})` : ''}`,
    role: 'structured-advisor',
    sessionHandle: details.sessionHandle,
    kind: getClaudeStructuredFailureKind(details.subtype, details.resultErrorMessage),
    subtype: details.subtype,
  });
  await emitClaudeProviderError(details.events, providerError, details.label);
  return providerError;
}

// One advisor round loop serves both structured-output protocols. The shared
// skeleton — per-turn abort controller, assistant-text mirroring, transient
// api_error retries with exponential backoff, transient error-result
// retries, and the final unsuccessful-result error — is identical for both;
// the `run.protocol` discriminator selects the json-block behavior (local
// extraction/validation with the repair sub-loop, plus the mirrored-prose
// recovery when the stream fails after emitting assistant text) or the
// native behavior (SDK `json_schema` structured output with stream-error and
// retry-exhaustion telemetry).
async function runClaudeStructuredAdvisorRoundLoop<TStructured>(
  run: ClaudeStructuredAdvisorRoundRun<TStructured>,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  sleep: SleepFn = defaultSleep,
): Promise<StructuredAdvisorRoundResult<TStructured>> {
  const args = run.args;
  let sessionHandle: string | null = args.resumeHandle ?? null;
  let apiRetryCount = 0;
  const apiRetryLimit = args.apiRetryLimit;

  while (true) {
    const mirroredAssistantTexts: string[] = [];
    const primaryEvents: ProviderEventSink | undefined = args.events
      ? async (event) => {
          const text = getMirroredAssistantText(event, 'structured-advisor', args.label);
          if (text) {
            mirroredAssistantTexts.push(text);
          }
          await args.events?.(event);
        }
      : undefined;

    // Reads `sessionHandle` at call time, so post-collect callers observe the
    // handle updated from the just-collected result.
    const retryAfterTransientErrorResult = async (subtype: string | null, message: string | null) => {
      apiRetryCount += 1;
      await emitProviderEvent(args.events, {
        type: 'tool_progress',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role: 'structured-advisor',
        label: args.label,
        sessionHandle,
        toolName: 'api_retry',
        message: `transient Claude error result; retrying review (${apiRetryCount}/${apiRetryLimit})`,
        isError: true,
        providerData: {
          retryCount: apiRetryCount,
          retryLimit: apiRetryLimit,
          subtype,
          message,
        },
      });
      await sleep(getApiRetryDelayMs(apiRetryCount));
    };

    let result: CollectedClaudeResult;
    try {
      const turnAbortController = createClaudeTurnAbortController(args.signal);
      result = await collectClaudeResult(
        run.createStream(run.args, defaultModel, defaultEffort, turnAbortController),
        args.cwd,
        args.label,
        args.inactivityTimeoutMs,
        primaryEvents,
        'structured-advisor',
        turnAbortController,
      );
    } catch (error) {
      const providerError = normalizeClaudeProviderError(error, {
        role: 'structured-advisor',
        sessionHandle,
      });
      const mirroredAssistantText = mirroredAssistantTexts.join('\n\n').trim();
      if (run.protocol === 'native' && providerError.kind === 'structured_output_invalid') {
        await emitProviderEvent(args.events, {
          type: 'tool_progress',
          provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
          role: 'structured-advisor',
          label: args.label,
          sessionHandle: providerError.sessionHandle ?? sessionHandle,
          toolName: 'structured_output_stream_error',
          message: 'Claude SDK structured output stream failed before Neal could process a final structured result.',
          isError: true,
          providerData: {
            errorKind: providerError.kind,
            errorMessage: providerError.message,
            collectedAssistantTextLength: mirroredAssistantText.length,
            mirroredAssistantTextCount: mirroredAssistantTexts.length,
          },
        });
      }
      if (providerError.kind === 'api_error' && apiRetryCount < apiRetryLimit) {
        apiRetryCount += 1;
        await emitProviderEvent(args.events, {
          type: 'tool_progress',
          provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
          role: 'structured-advisor',
          label: args.label,
          sessionHandle,
          toolName: 'api_retry',
          message: `transient API failure; retrying review (${apiRetryCount}/${apiRetryLimit})`,
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
      if (
        run.protocol === 'json-block' &&
        mirroredAssistantText &&
        (providerError.kind === 'structured_output_invalid' || providerError.kind === 'structured_output_missing')
      ) {
        return await validateOrRepairClaudeJsonBlockResponse({
          roundArgs: run.args,
          assistantText: mirroredAssistantText,
          defaultModel,
          defaultEffort,
          sessionHandle: providerError.sessionHandle ?? sessionHandle,
          createRepairStream: run.createRepairStream,
        });
      }
      await emitClaudeProviderError(args.events, providerError, args.label);
      throw providerError;
    }

    sessionHandle = result.sessionHandle ?? sessionHandle;
    const lastResult = result.lastResult;
    const subtype = lastResult?.subtype ?? null;
    const resultErrorMessage = getClaudeResultErrorMessage(lastResult);
    const structuredRetryExhausted = isStructuredOutputRetryExhaustion(subtype, resultErrorMessage);
    const isTransientErrorResult =
      lastResult?.is_error === true && isTransientClaudeFailure(subtype, resultErrorMessage);

    if (run.protocol === 'json-block') {
      if (isTransientErrorResult && apiRetryCount < apiRetryLimit) {
        await retryAfterTransientErrorResult(subtype, resultErrorMessage);
        continue;
      }

      if (subtype && subtype !== 'success' && !structuredRetryExhausted) {
        throw await createClaudeAdvisorUnsuccessfulResultError({
          events: args.events,
          label: args.label,
          subtype,
          resultErrorMessage,
          sessionHandle,
        });
      }

      const assistantText = getClaudeAssistantTextForLocalJson(
        result,
        mirroredAssistantTexts.join('\n\n').trim(),
      );
      return await validateOrRepairClaudeJsonBlockResponse({
        roundArgs: run.args,
        assistantText,
        defaultModel,
        defaultEffort,
        sessionHandle,
        createRepairStream: run.createRepairStream,
      });
    }

    const structured = getPreferredStructuredOutput<TStructured>(result);
    if (structured !== undefined) {
      await emitProviderEvent(args.events, {
        type: 'structured_output_received',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role: 'structured-advisor',
        label: args.label,
        sessionHandle,
      });
      return {
        sessionHandle,
        structured,
      };
    }

    if (structuredRetryExhausted) {
      await emitProviderEvent(args.events, {
        type: 'tool_progress',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role: 'structured-advisor',
        label: args.label,
        sessionHandle,
        toolName: 'structured_output_retry_exhausted',
        message: 'Claude SDK structured output failed after retries.',
        isError: true,
        providerData: {
          subtype,
          resultMessage: resultErrorMessage,
          collectedAssistantTextLength: result.assistantText.length,
          mirroredAssistantTextCount: mirroredAssistantTexts.length,
        },
      });
    }

    if (isTransientErrorResult && apiRetryCount < apiRetryLimit) {
      await retryAfterTransientErrorResult(subtype, resultErrorMessage);
      continue;
    }

    throw await createClaudeAdvisorUnsuccessfulResultError({
      events: args.events,
      label: args.label,
      subtype,
      resultErrorMessage,
      sessionHandle,
    });
  }
}

async function runClaudeJsonBlockStructuredAdvisorRound<TStructured>(
  args: ClaudeJsonBlockStructuredAdvisorRoundArgs<TStructured>,
  defaultModel?: string | null,
  createStream: ClaudeJsonBlockStructuredAdvisorStreamFactory = buildClaudeJsonBlockQueryStream,
  createRepairStream: ClaudeJsonBlockStructuredAdvisorRepairStreamFactory = buildClaudeJsonBlockRepairQueryStream,
  defaultEffort?: string | null,
  sleep: SleepFn = defaultSleep,
): Promise<StructuredAdvisorRoundResult<TStructured>> {
  return runClaudeStructuredAdvisorRoundLoop<TStructured>(
    { protocol: 'json-block', args, createStream, createRepairStream },
    defaultModel,
    defaultEffort,
    sleep,
  );
}

async function runClaudeStructuredAdvisorRound<TStructured>(
  args: StructuredAdvisorRoundArgs<TStructured>,
  defaultModel?: string | null,
  createStream: ClaudeStructuredAdvisorStreamFactory = buildClaudeQueryStream,
  defaultEffort?: string | null,
  sleep: SleepFn = defaultSleep,
): Promise<StructuredAdvisorRoundResult<TStructured>> {
  if (isClaudeJsonBlockStructuredAdvisorRound(args)) {
    return await runClaudeJsonBlockStructuredAdvisorRound<TStructured>(
      args,
      defaultModel,
      undefined,
      undefined,
      defaultEffort,
      sleep,
    );
  }

  return runClaudeStructuredAdvisorRoundLoop<TStructured>(
    { protocol: 'native', args, createStream },
    defaultModel,
    defaultEffort,
    sleep,
  );
}

class AnthropicClaudeStructuredAdvisorAdapter implements StructuredAdvisorAdapter {
  constructor(private readonly options: { model?: string | null; effort?: string | null } = {}) {}

  async runStructuredRound<TStructured>(
    args: StructuredAdvisorRoundArgs<TStructured>,
  ): Promise<StructuredAdvisorRoundResult<TStructured>> {
    return runClaudeStructuredAdvisorRound<TStructured>(
      args,
      this.options.model,
      undefined,
      this.options.effort ?? undefined,
    );
  }
}

// Tool names that write to the local filesystem. Edit and Write are the only
// write-class tools Neal exposes to the coder; the extra names keep the write
// jail closed if the exposed toolset ever widens.
const CLAUDE_WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function getClaudeWriteToolPath(toolInput: unknown): string | null {
  if (toolInput === null || typeof toolInput !== 'object') {
    return null;
  }
  const record = toolInput as Record<string, unknown>;
  const filePath = record.file_path ?? record.notebook_path;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
}

// Mechanical enforcement of `toolPolicy.allowedWritePaths` for coder turns.
// The coder runs with `permissionMode: 'bypassPermissions'`, which skips the
// SDK's permission checks entirely — the `canUseTool` permission callback is
// never consulted — but PreToolUse hooks still run before every tool call and
// their denies are honored, so the hook is the SDK's mechanism for a per-path
// write jail. Paths are compared after resolving against the turn cwd (the
// allowlisted paths arrive absolute from the plan rounds); a write-class call
// without a recognizable file path is denied, failing closed. Shell is closed
// off separately: `allowRun: false` removes Bash from the tools list, so a
// jailed turn cannot route writes around this hook through a shell command.
function buildClaudeWritePathGuardHooks(cwd: string, allowedWritePaths: string[]): Options['hooks'] {
  const allowedPaths = new Set(allowedWritePaths.map((path) => resolve(cwd, path)));
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || !CLAUDE_WRITE_TOOL_NAMES.has(input.tool_name)) {
      return { continue: true };
    }
    const filePath = getClaudeWriteToolPath(input.tool_input);
    if (filePath !== null && allowedPaths.has(resolve(cwd, filePath))) {
      return { continue: true };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason:
          `This turn may only write to: ${[...allowedPaths].join(', ')}. ` +
          `${input.tool_name} targeting ${filePath ?? 'an unrecognized path'} is not allowed.`,
      },
    };
  };
  return { PreToolUse: [{ hooks: [guard] }] };
}

function buildClaudeCoderQueryOptions(
  args: CoderRunPromptArgs,
  defaultModel?: string | null,
  claudeExecutablePath = getClaudeCodeExecutablePath(),
  defaultEffort?: string | null,
  abortController: AbortController | undefined = deriveClaudeAbortController(args.signal),
): Options {
  return buildClaudeCoreQueryOptions({
    cwd: args.cwd,
    abortController,
    model: defaultModel,
    effort: defaultEffort,
    // `toolPolicy.allowRun: false` (plan-authoring turns) removes Bash so the
    // "no shell" jail is enforced by tool absence, not prompt text.
    tools:
      args.toolPolicy?.allowRun === false
        ? ['Read', 'Grep', 'Glob', 'Edit', 'Write']
        : ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    hooks: args.toolPolicy?.allowedWritePaths
      ? buildClaudeWritePathGuardHooks(args.cwd, args.toolPolicy.allowedWritePaths)
      : undefined,
    resumeHandle: args.resumeHandle,
    claudeExecutablePath,
    outputSchema: args.outputSchema,
    events: args.events,
    stderrRole: 'coder',
    stderrLabel: 'coder',
    stderrSessionHandle: args.resumeHandle ?? null,
  });
}

function buildClaudeCoderQueryStream(
  args: CoderRunPromptArgs,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) {
  return query({
    prompt: args.prompt,
    options: buildClaudeCoderQueryOptions(args, defaultModel, undefined, defaultEffort, abortController),
  });
}

function buildClaudeCoderRepairQueryOptions(
  args: CoderStructuredPromptArgs<unknown>,
  defaultModel?: string | null,
  claudeExecutablePath = getClaudeCodeExecutablePath(),
  defaultEffort?: string | null,
  abortController?: AbortController,
): Options {
  return buildClaudeCoreQueryOptions({
    cwd: args.cwd,
    abortController,
    model: defaultModel,
    effort: defaultEffort,
    tools: [],
    claudeExecutablePath,
    events: args.events,
    stderrRole: 'coder',
    stderrLabel: `${args.label}:structured-json-repair`,
    stderrSessionHandle: null,
  });
}

function buildClaudeCoderRepairQueryStream(
  args: CoderStructuredPromptArgs<unknown>,
  repairPrompt: string,
  defaultModel?: string | null,
  defaultEffort?: string | null,
  abortController?: AbortController,
) {
  return query({
    prompt: repairPrompt,
    options: buildClaudeCoderRepairQueryOptions(args, defaultModel, undefined, defaultEffort, abortController),
  });
}

async function runClaudeStructuredCoderPrompt<TStructured>(
  args: CoderStructuredPromptArgs<TStructured>,
  defaultModel?: string | null,
  createStream: ClaudeCoderStreamFactory = buildClaudeCoderQueryStream,
  createRepairStream: ClaudeCoderRepairStreamFactory = buildClaudeCoderRepairQueryStream,
  defaultEffort?: string | null,
  sleep: SleepFn = defaultSleep,
): Promise<CoderStructuredPromptResult<TStructured>> {
  let sessionHandle: string | null = args.resumeHandle ?? null;
  let apiRetryCount = 0;
  const apiRetryLimit = args.apiRetryLimit ?? 0;

  // Mirrors the structured-advisor rounds: a transient error result (e.g. a
  // stream idle timeout surfaced in the result message) must restart the round
  // instead of feeding the error text into JSON extraction. Budget-gated so an
  // exhausted budget falls through to today's behavior.
  const throwIfRetryableTransientResult = (result: CollectedClaudeResult, label: string) => {
    if (apiRetryCount >= apiRetryLimit) {
      return;
    }
    if (result.lastResult?.is_error !== true) {
      return;
    }
    const subtype = result.lastResult?.subtype ?? null;
    const resultErrorMessage = getClaudeResultErrorMessage(result.lastResult);
    if (isTransientClaudeFailure(subtype, resultErrorMessage)) {
      throw createClaudeProviderError({
        message: resultErrorMessage
          ? `Claude ${label} returned a transient error result${subtype ? ` (${subtype})` : ''}: ${resultErrorMessage}`
          : `Claude ${label} returned a transient error result${subtype ? ` (${subtype})` : ''}`,
        role: 'coder',
        sessionHandle,
        kind: 'api_error',
        retryable: true,
        subtype,
      });
    }
  };

  while (true) {
    try {
      return await runStructuredJsonProtocol<TStructured>({
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role: 'coder',
        label: args.label,
        protocol: args.structuredJsonProtocol,
        prompt: args.prompt,
        events: args.events,
        initialSessionHandle: args.resumeHandle ?? null,
        runInitial: async (prompt) => {
          const turnAbortController = createClaudeTurnAbortController(args.signal);
          const result = await collectClaudeResult(
            createStream(
              {
                ...args,
                prompt,
              },
              defaultModel,
              defaultEffort,
              turnAbortController,
            ),
            args.cwd,
            args.label,
            args.inactivityTimeoutMs,
            args.events,
            'coder',
            turnAbortController,
          );
          throwIfRetryableTransientResult(result, args.label);
          sessionHandle = result.sessionHandle ?? sessionHandle;
          if (sessionHandle && sessionHandle !== args.resumeHandle) {
            await args.onSessionStarted?.(sessionHandle);
          }
          return {
            assistantText: getClaudeAssistantTextForLocalJson(result),
            sessionHandle,
          };
        },
        runRepair: async (prompt) => {
          const repairAbortController = new AbortController();
          const result = await collectClaudeResult(
            createRepairStream(args, prompt, defaultModel, defaultEffort, repairAbortController),
            args.cwd,
            `${args.label}:structured-json-repair`,
            args.inactivityTimeoutMs,
            args.events,
            'coder',
            repairAbortController,
          );
          throwIfRetryableTransientResult(result, `${args.label}:structured-json-repair`);
          return {
            assistantText: getClaudeAssistantTextForLocalJson(result),
            sessionHandle: result.sessionHandle,
          };
        },
        createProviderError: (errorArgs) => createClaudeProviderError({
          message: errorArgs.message,
          role: 'coder',
          sessionHandle: errorArgs.sessionHandle,
          kind: errorArgs.kind,
          retryable: false,
          cause: errorArgs.cause,
        }),
      });
    } catch (error) {
      const providerError = normalizeClaudeProviderError(error, {
        role: 'coder',
        sessionHandle,
        kind: 'structured_output_invalid',
      });
      if (providerError.kind === 'api_error' && providerError.retryable && apiRetryCount < apiRetryLimit) {
        apiRetryCount += 1;
        await emitProviderEvent(args.events, {
          type: 'tool_progress',
          provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
          role: 'coder',
          label: args.label,
          sessionHandle,
          toolName: 'api_retry',
          message: `transient Claude failure; retrying ${args.label} (${apiRetryCount}/${apiRetryLimit})`,
          isError: true,
          providerData: {
            retryCount: apiRetryCount,
            retryLimit: apiRetryLimit,
            message: providerError.message,
          },
        });
        await sleep(getApiRetryDelayMs(apiRetryCount));
        // Fresh attempt: never resume the failed attempt's session.
        sessionHandle = args.resumeHandle ?? null;
        continue;
      }
      await emitClaudeProviderError(args.events, providerError, args.label);
      throw providerError;
    }
  }
}

class AnthropicClaudeCoderAdapter implements CoderAdapter {
  constructor(private readonly options: { model?: string | null; effort?: string | null } = {}) {}

  async runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
    let sessionHandle: string | null = args.resumeHandle ?? null;
    let result: CollectedClaudeResult;
    try {
      const turnAbortController = createClaudeTurnAbortController(args.signal);
      const stream = buildClaudeCoderQueryStream(
        args,
        this.options.model,
        this.options.effort ?? undefined,
        turnAbortController,
      );
      result = await collectClaudeResult(
        stream,
        args.cwd,
        'coder',
        args.inactivityTimeoutMs,
        args.events,
        'coder',
        turnAbortController,
      );
      sessionHandle = result.sessionHandle ?? sessionHandle;
    } catch (error) {
      const providerError = normalizeClaudeProviderError(error, {
        role: 'coder',
        sessionHandle,
      });
      await emitClaudeProviderError(args.events, providerError, 'coder');
      throw providerError;
    }

    if (sessionHandle && sessionHandle !== args.resumeHandle) {
      await args.onSessionStarted?.(sessionHandle);
    }

    const statusResult = args.outputSchema && result.firstStructuredResult ? result.firstStructuredResult : result.lastResult;
    const subtype = statusResult?.subtype ?? null;
    const resultErrorMessage = getClaudeResultErrorMessage(statusResult);
    if (subtype && subtype !== 'success') {
      const providerError = createClaudeProviderError({
        message: resultErrorMessage
          ? `Claude coder did not return a successful result (${subtype}): ${resultErrorMessage}`
          : `Claude coder did not return a successful result (${subtype})`,
        sessionHandle,
        subtype,
        role: 'coder',
      });
      await emitClaudeProviderError(args.events, providerError, 'coder');
      throw providerError;
    }

    if (args.outputSchema) {
      const structuredOutput = getPreferredStructuredOutput<unknown>(result);
      if (structuredOutput === undefined) {
        const providerError = createClaudeProviderError({
          message: 'Claude coder did not return structured output',
          role: 'coder',
          sessionHandle,
          kind: 'structured_output_missing',
          subtype,
        });
        await emitClaudeProviderError(args.events, providerError, 'coder');
        throw providerError;
      }

      await emitProviderEvent(args.events, {
        type: 'structured_output_received',
        provider: ANTHROPIC_CLAUDE_PROVIDER_ID,
        role: 'coder',
        label: 'coder',
        sessionHandle,
      });
      return {
        sessionHandle: sessionHandle,
        finalResponse: JSON.stringify(structuredOutput),
      };
    }

    const finalResponse = result.assistantText || getClaudeResultErrorMessage(result.lastResult) || '';
    if (!finalResponse.trim()) {
      const providerError = createClaudeProviderError({
        message: 'Claude coder returned no final response',
        role: 'coder',
        sessionHandle,
        kind: 'structured_output_missing',
        subtype,
      });
      await emitClaudeProviderError(args.events, providerError, 'coder');
      throw providerError;
    }

    return {
      sessionHandle: sessionHandle,
      finalResponse,
    };
  }

  async runStructuredPrompt<TStructured>(
    args: CoderStructuredPromptArgs<TStructured>,
  ): Promise<CoderStructuredPromptResult<TStructured>> {
    return runClaudeStructuredCoderPrompt<TStructured>(
      args,
      this.options.model,
      undefined,
      undefined,
      this.options.effort ?? undefined,
    );
  }
}

export function createAnthropicClaudeStructuredAdvisorAdapter(options: { model?: string | null; effort?: string | null } = {}): StructuredAdvisorAdapter {
  return new AnthropicClaudeStructuredAdvisorAdapter(options);
}

export function createAnthropicClaudeCoderAdapter(options: { model?: string | null; effort?: string | null } = {}): CoderAdapter {
  return new AnthropicClaudeCoderAdapter(options);
}

export const anthropicClaudeProviderDefinition = {
  id: 'anthropic-claude',
  displayName: 'Anthropic Claude',
  capabilities: {
    coder: {
      supported: true,
      toolAccess: {
        read: true,
        write: true,
        shell: true,
      },
      supportsSessionResume: true,
      supportsModelOverride: true,
      supportsStructuredOutput: true,
      usageReporting: 'opportunistic',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'structured-advisor': {
      supported: true,
      // Reviewers run read-only: read tools only, no write, no shell. The
      // reviewer option builders expose only ['Read','Grep','Glob'] (repair
      // exposes none), so a reviewer can inspect the checkout but never edit it
      // or run commands.
      toolAccess: {
        read: true,
        write: false,
        shell: false,
      },
      supportsSessionResume: true,
      supportsModelOverride: true,
      supportsStructuredOutput: true,
      usageReporting: 'opportunistic',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  },
  createCoderAdapter: createAnthropicClaudeCoderAdapter,
  createStructuredAdvisorAdapter: createAnthropicClaudeStructuredAdvisorAdapter,
} satisfies NealProviderDefinition;

export const anthropicClaudeProviderTestHooks = {
  buildClaudeCoderQueryOptions,
  buildClaudeCoderRepairQueryOptions,
  buildClaudeJsonBlockQueryOptions,
  buildClaudeJsonBlockRepairQueryOptions,
  buildClaudeJsonBlockReviewPrompt,
  buildClaudeQueryOptions,
  collectClaudeResult,
  getClaudeCodeExecutablePath,
  getMirroredAssistantText,
  getPreferredStructuredOutput,
  isGlibcRuntime,
  logClaudeMessage,
  THINKING_PROGRESS_EMIT_INTERVAL_MS,
  runClaudeJsonBlockStructuredAdvisorRound,
  runClaudeStructuredCoderPrompt,
  runClaudeStructuredAdvisorRound,
};
