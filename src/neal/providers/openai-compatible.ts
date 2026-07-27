/**
 * openai-compatible provider: neal's generic OpenAI-compatible provider,
 * implementing the CoderAdapter contract on the Vercel AI SDK so any
 * OpenAI-compatible endpoint with a strong tool-calling model can serve the
 * planner, coder, and reviewer roles through ordinary config. Key mechanics:
 *
 * - one `generateText` call per turn (`stopWhen: stepCountIs(1)`,
 *   `maxRetries: 0`) with a neal-owned outer loop over an explicit message
 *   history; the AI SDK is never used as a multi-step black box;
 * - per-turn bounded transient retry (`args.apiRetryLimit ?? 0`) with the
 *   standard `api_retry` `tool_progress` event shape and the bespoke
 *   adapter's backoff schedule (500 ms base, doubling, 5 s cap);
 * - abort/inactivity wiring: every primary turn receives
 *   `AbortSignal.any([args.signal, AbortSignal.timeout(inactivityTimeoutMs)])`
 *   (the caller signal is omitted when absent). A caller-signal abort is a
 *   non-retryable `timeout`; an inactivity expiry is a retryable `timeout`;
 *   the two are disambiguated by checking `args.signal?.aborted` after the
 *   abort (`AbortSignal.timeout` aborts with a `TimeoutError` DOMException);
 * - structured output (coder and structured-advisor alike) through the AI
 *   SDK's native structured-output channel: the tool loop runs to its normal
 *   zero-tool-call completion turn, then exactly one dedicated finalization
 *   turn carries `output: Output.object(...)` (see
 *   `runStructuredFinalizationTurn`, shared by both paths); there are no
 *   fence instructions and no repair turns on this provider;
 * - events-only synthetic session handles: `supportsSessionResume: false`,
 *   so `args.onSessionStarted` is never invoked, returned session handles
 *   are always null, and a non-null `args.resumeHandle` is corrupted state
 *   (`session_unavailable`);
 * - a structured-advisor adapter running the same outer loop over the
 *   read-only toolset (`read_file`, `list_dir`, `grep`, `git_diff`) with its own smaller
 *   step cap (`OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS`), the same settings
 *   resolution, retry semantics, and cancellation contract, so the coder
 *   role passes the final-completion structured-advisor gate and a generic
 *   reviewer inspects the repository directly with read tools instead of
 *   relying on Neal-inlined context.
 */
import { randomBytes } from 'node:crypto';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';

import { getOpenAICompatibleSettings, type OpenAICompatibleSettings } from '../config.js';
import { withOpenRouterRouting } from './openrouter-routing.js';
import { resolveRateCost, type ProviderPricing } from './pricing.js';
import {
  createCoderToolset,
  createPlanAuthorToolset,
  createReadOnlyToolset,
  type OpenAICompatibleToolEvent,
} from './openai-compatible-tools.js';
import { isContentSafetyRefusalMessage, NealProviderError } from './types.js';
import type {
  StructuredJsonProtocolSpec,
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  CoderStructuredPromptArgs,
  CoderStructuredPromptResult,
  NealProviderDefinition,
  NealProviderErrorKind,
  ProviderEventSink,
  ProviderRole,
  ProviderRuntimeEvent,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from './types.js';

const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

/**
 * Step cap for the coder loop: the maximum number of successful model turns
 * per prompt before the adapter fails the attempt with `provider_failed`.
 * This is a constant, not a config knob, by design. It originally shipped at
 * 24, and live runs on `examples/issue-triage-js` hit that cap repeatedly on
 * ordinary scopes (one tool call per turn means read/inspect/edit/test cycles
 * consume turns quickly), so it was raised to 48. Raise it again only on live
 * evidence that the cap binds on real projects, not speculatively.
 */
export const OPENAI_COMPATIBLE_MAX_STEPS = 48;

/**
 * Step cap for the structured-advisor read-only tool loop: the maximum number
 * of successful model turns per round before the adapter fails the round with
 * a non-retryable `provider_failed`. A constant, not a config knob, by design
 * (mirroring `OPENAI_COMPATIBLE_MAX_STEPS`). It ships at half the coder cap
 * because reviews are bounded inspections, not implementations: the advisor
 * only reads, lists, and greps before judging, while the coder's
 * read/inspect/edit/test cycles consume turns far faster. Provider telemetry
 * records tool turns per review round; raise this cap only on live evidence
 * that reviews hit it, the same way the coder cap moved 24 -> 48.
 */
export const OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS = 24;

const API_RETRY_BASE_DELAY_MS = 500;
const API_RETRY_MAX_DELAY_MS = 5_000;

// Network-level error codes treated as transient, mirroring the spike's
// isTransientError classification (statusCode 408/429/5xx, explicit
// isRetryable, or one of these codes on the error or its cause).
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export type OpenAICompatibleSettingsResolver = (cwd: string) => OpenAICompatibleSettings;

export type OpenAICompatibleModelFactory = (args: {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
}) => LanguageModel;

type SleepFn = (ms: number) => Promise<void>;

type OpenAICompatibleAdapterOptions = {
  model?: string | null;
  effort?: string | null;
  resolveSettings?: OpenAICompatibleSettingsResolver;
  createModel?: OpenAICompatibleModelFactory;
  sleep?: SleepFn;
};

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDefaultOpenAICompatibleModel(args: {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  model: string;
}): LanguageModel {
  // Exactly the spike's model construction: an OpenAI-compatible chat model.
  // maxRetries: 0 on each generateText call keeps neal's own apiRetryLimit
  // loop the only retry layer for this provider.
  //
  // supportsStructuredOutputs: true tells the SDK to send the structured
  // finalization turn's request with `response_format.type: 'json_schema'`
  // carrying neal's schema (the `Output.object`/`jsonSchema` constraint in
  // runAgentModelTurn). Without it the SDK silently drops the schema,
  // downgrades to loose `json_object`, and emits the request-build warning
  // "JSON response format schema is only supported with structuredOutputs" —
  // a silent schema-drop that makes neal ask for enforced JSON but receive
  // unenforced JSON. With the flag set, a gateway that cannot honor the
  // schema fails attributably instead.
  return createOpenAICompatible({
    name: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseURL: args.baseUrl,
    apiKey: args.apiKey,
    headers: args.headers,
    supportsStructuredOutputs: true,
    // On OpenRouter, constrain routing to backends that support the parameters
    // neal sends — above all the coder's `response_format: json_schema`. Without
    // it OpenRouter can route the same slug to a backend that can't do
    // structured output, which fails the coder attributably (structured_output)
    // even though the slug "works" on other backends. No-op off OpenRouter.
    fetch: withOpenRouterRouting(args.baseUrl, globalThis.fetch),
  }).chatModel(args.model);
}

function createOpenAICompatibleProviderError(args: {
  message: string;
  role: ProviderRole;
  sessionHandle?: string | null;
  kind: NealProviderErrorKind;
  retryable: boolean;
  cause?: unknown;
}) {
  return new NealProviderError({
    message: args.message,
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    role: args.role,
    sessionHandle: args.sessionHandle,
    kind: args.kind,
    retryable: args.retryable,
    cause: args.cause,
  });
}

function buildSyntheticSessionHandle() {
  // Synthetic events-only handle. This provider has no session resume;
  // adapter methods always return sessionHandle: null and never invoke
  // onSessionStarted, so no resumable handle is ever persisted for it.
  return `${OPENAI_COMPATIBLE_PROVIDER_ID}:${new Date().toISOString()}:${randomBytes(4).toString('hex')}`;
}

function withEventsOnlySessionHandle(error: NealProviderError): NealProviderError {
  // The synthetic session handle is events-only telemetry and must never ride
  // on thrown errors: the orchestrator persists `error.sessionHandle` into
  // `state.coderSessionHandle` on coder-phase and final-completion failures
  // (src/neal/orchestrator/phases/coder.ts, src/neal/orchestrator/completion.ts),
  // and any persisted handle makes `assertAgentConfigSupportsResume` demand
  // session_resume support — which this provider declares false — rejecting
  // `neal resume` for the whole run.
  if (error.sessionHandle === null) {
    return error;
  }
  const stripped = new NealProviderError({
    message: error.message,
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    role: error.role,
    sessionHandle: null,
    kind: error.kind,
    retryable: error.retryable,
    cause: error.cause,
  });
  if (error.stack !== undefined) {
    stripped.stack = error.stack;
  }
  return stripped;
}

function getApiRetryDelayMs(retryCount: number) {
  return Math.min(API_RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1), API_RETRY_MAX_DELAY_MS);
}

function readStatusCode(error: object): number | null {
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function isAbortLikeError(error: object): boolean {
  // AbortSignal.timeout aborts with a DOMException named TimeoutError on
  // Node >= 22; caller AbortController.abort() defaults to AbortError. The
  // AI SDK propagates the abort reason when maxRetries is 0.
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function hasTransientShape(error: object): boolean {
  if ((error as { isRetryable?: unknown }).isRetryable === true) {
    return true;
  }
  const status = readStatusCode(error);
  if (status !== null && (status === 408 || status === 429 || status >= 500)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  const codes = [
    (error as { code?: unknown }).code,
    typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined,
  ];
  return codes.some((code) => typeof code === 'string' && NETWORK_ERROR_CODES.has(code));
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; statusCode?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message : String(error);
    return typeof candidate.statusCode === 'number'
      ? `HTTP ${candidate.statusCode}: ${message}`
      : message;
  }
  return String(error);
}

const MAX_ERROR_DIAGNOSTIC_TEXT_LENGTH = 2_000;
const MAX_ERROR_CAUSE_DEPTH = 3;

function truncateDiagnosticText(text: string) {
  if (text.length <= MAX_ERROR_DIAGNOSTIC_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_ERROR_DIAGNOSTIC_TEXT_LENGTH)}...[truncated ${text.length - MAX_ERROR_DIAGNOSTIC_TEXT_LENGTH} chars]`;
}

function readErrorProperty(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

function buildErrorDiagnostic(error: unknown, depth = 0): Record<string, unknown> {
  const diagnostic: Record<string, unknown> = {
    message: describeError(error),
  };
  if (error instanceof Error && error.name) {
    diagnostic.name = error.name;
  } else {
    const name = readErrorProperty(error, 'name');
    if (typeof name === 'string' && name.trim() !== '') {
      diagnostic.name = name;
    }
  }

  const statusCode = readErrorProperty(error, 'statusCode');
  if (typeof statusCode === 'number') {
    diagnostic.statusCode = statusCode;
  }
  const url = readErrorProperty(error, 'url');
  if (typeof url === 'string' && url.trim() !== '') {
    diagnostic.url = url;
  }
  const responseBody = readErrorProperty(error, 'responseBody');
  if (typeof responseBody === 'string' && responseBody.trim() !== '') {
    diagnostic.responseBody = truncateDiagnosticText(responseBody);
    diagnostic.responseBodyTruncated = responseBody.length > MAX_ERROR_DIAGNOSTIC_TEXT_LENGTH;
  }
  // Rejected structured-output text: NoObjectGeneratedError carries the
  // assistant text it could not parse as `text`, and the adapter constructs
  // validator-failure causes with the generated JSON as `text`, so failed
  // structured runs stay classifiable ("emitted XML garbage" vs "wrote a real
  // patch and fumbled the payload") from the provider_error event alone.
  const text = readErrorProperty(error, 'text');
  if (typeof text === 'string' && text.trim() !== '') {
    diagnostic.text = truncateDiagnosticText(text);
    diagnostic.textTruncated = text.length > MAX_ERROR_DIAGNOSTIC_TEXT_LENGTH;
  }

  const cause = readErrorProperty(error, 'cause');
  if (cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
    diagnostic.cause = buildErrorDiagnostic(cause, depth + 1);
  }
  return diagnostic;
}

function providerErrorData(error: NealProviderError): Record<string, unknown> {
  return {
    retryable: error.retryable,
    diagnostic: buildErrorDiagnostic(error.cause ?? error),
  };
}

/**
 * Normalizes any thrown value into a NealProviderError with the same
 * classification table as the bespoke openai-compatible adapter plus the
 * abort-source disambiguation contract:
 *
 * - caller signal aborted -> `timeout`, retryable: false (the caller owns
 *   the cancellation; never retried in-round);
 * - abort without a caller abort -> inactivity expiry -> `timeout`,
 *   retryable: true;
 * - HTTP 401/403 -> `permission_denied`, non-retryable;
 * - HTTP 408/429/5xx, explicit isRetryable, network codes -> `api_error`,
 *   retryable;
 * - everything else -> `provider_failed`, non-retryable.
 */
function normalizeOpenAICompatibleError(
  error: unknown,
  ctx: {
    role: ProviderRole;
    label: string;
    sessionHandle: string | null;
    callerSignal?: AbortSignal | undefined;
  },
): NealProviderError {
  if (error instanceof NealProviderError) {
    return error;
  }

  if (ctx.callerSignal?.aborted) {
    return createOpenAICompatibleProviderError({
      message: `openai-compatible ${ctx.label} turn was aborted by the caller before completion.`,
      role: ctx.role,
      sessionHandle: ctx.sessionHandle,
      kind: 'timeout',
      retryable: false,
      cause: error,
    });
  }

  // Content-safety refusal on the genuine-transport path. describeError reads
  // the provider-authored transport message (the AI SDK's APICallError message
  // is `data.error.message`, with any statusCode prefixed). Classified before
  // the status table so a refusal phrased as a 401/403 lands as a terminal
  // content_refused rather than permission_denied. Error channel only, never
  // the assistant review content.
  if (isContentSafetyRefusalMessage(describeError(error))) {
    return createOpenAICompatibleProviderError({
      message: `openai-compatible ${ctx.label} request was refused on content-safety grounds: ${describeError(error)}`,
      role: ctx.role,
      sessionHandle: ctx.sessionHandle,
      kind: 'content_refused',
      retryable: false,
      cause: error,
    });
  }

  if (typeof error === 'object' && error !== null) {
    if (isAbortLikeError(error)) {
      return createOpenAICompatibleProviderError({
        message: `openai-compatible ${ctx.label} turn exceeded the inactivity timeout and was aborted.`,
        role: ctx.role,
        sessionHandle: ctx.sessionHandle,
        kind: 'timeout',
        retryable: true,
        cause: error,
      });
    }
    const status = readStatusCode(error);
    if (status === 401 || status === 403) {
      return createOpenAICompatibleProviderError({
        message: `openai-compatible ${ctx.label} request was rejected with HTTP ${status}: ${describeError(error)}`,
        role: ctx.role,
        sessionHandle: ctx.sessionHandle,
        kind: 'permission_denied',
        retryable: false,
        cause: error,
      });
    }
    if (hasTransientShape(error)) {
      return createOpenAICompatibleProviderError({
        message: `openai-compatible ${ctx.label} request failed transiently: ${describeError(error)}`,
        role: ctx.role,
        sessionHandle: ctx.sessionHandle,
        kind: 'api_error',
        retryable: true,
        cause: error,
      });
    }
  }

  return createOpenAICompatibleProviderError({
    message: `openai-compatible ${ctx.label} request failed: ${describeError(error)}`,
    role: ctx.role,
    sessionHandle: ctx.sessionHandle,
    kind: 'provider_failed',
    retryable: false,
    cause: error,
  });
}

function createTurnAbortController(
  callerSignal: AbortSignal | undefined,
  inactivityTimeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();

  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  // Keep this as an ordinary ref'ed timer. In Node 22, AbortSignal.timeout()
  // can let a mocked or idle SDK call be cancelled by node:test before the
  // timeout fires because the process has no remaining ref'ed handles.
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, inactivityTimeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

async function emitProviderEvent(events: ProviderEventSink | undefined, event: ProviderRuntimeEvent) {
  await events?.(event);
}

type ResolvedOpenAICompatibleSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  pricing: ProviderPricing | null;
};

/** Error-message wording for the role calling into settings resolution. */
type SettingsErrorContext = {
  role: ProviderRole;
  /** Short noun for the settings line: 'coder' or the round label. */
  noun: string;
  /** Subject for the missing-value lines: 'coder run' or `<label> round`. */
  subject: string;
  /** Example config key for the no-model guidance. */
  modelOverrideExample: string;
};

function resolveOpenAICompatibleSettings(args: {
  cwd: string;
  // Model precedence (matching resolveRoundSettings in the bespoke adapter):
  // round-level model -> adapter/role model -> default_model -> error. Coder
  // calls pass roundModel: null, collapsing this to role -> default -> error.
  roundModel: string | null;
  roleModel: string | null;
  context: SettingsErrorContext;
  resolveSettings: OpenAICompatibleSettingsResolver;
}): ResolvedOpenAICompatibleSettings {
  const { context } = args;
  let settings: OpenAICompatibleSettings;
  try {
    settings = args.resolveSettings(args.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createOpenAICompatibleProviderError({
      message: `openai-compatible ${context.noun} settings could not be resolved: ${message}`,
      role: context.role,
      kind: 'provider_failed',
      retryable: false,
      cause: error,
    });
  }

  if (!settings.baseUrl) {
    throw createOpenAICompatibleProviderError({
      message:
        `openai-compatible ${context.subject} has no base URL. ` +
        'Set providers.openai_compatible.base_url in neal.yml, ~/.neal/config.yml, or the OPENAI_COMPATIBLE_BASE_URL environment variable.',
      role: context.role,
      kind: 'provider_failed',
      retryable: false,
    });
  }

  const model = args.roundModel ?? args.roleModel ?? settings.defaultModel;
  if (!model) {
    throw createOpenAICompatibleProviderError({
      message:
        `openai-compatible ${context.subject} has no model. ` +
        `Set a role model override (for example ${context.modelOverrideExample}), providers.openai_compatible.default_model in neal.yml or ~/.neal/config.yml, or the OPENAI_COMPATIBLE_MODEL environment variable.`,
      role: context.role,
      kind: 'provider_failed',
      retryable: false,
    });
  }

  if (!settings.apiKey) {
    throw createOpenAICompatibleProviderError({
      message:
        `openai-compatible ${context.subject} has no API key. ` +
        `Set the ${settings.apiKeyEnv} environment variable.`,
      role: context.role,
      kind: 'permission_denied',
      retryable: false,
    });
  }

  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model,
    headers: settings.headers,
    pricing: settings.pricing,
  };
}

/**
 * Mutable per-prompt loop state: the explicit message history the outer loop
 * owns, the jailed toolset bound to the prompt's cwd, the cumulative
 * per-tool telemetry maps carried on `turn_completed`/`usage_reported`
 * providerData, and the successful-turn step counter the cap binds on.
 * Role-agnostic: the coder loop binds the full toolset and the advisor loop
 * binds the read-only toolset; everything else is shared.
 */
type AgentLoopState = {
  model: LanguageModel;
  // The resolved model slug string (distinct from the SDK `model` object) used
  // for card-based rate lookup at the turn emit site.
  modelSlug: string;
  tools: ToolSet;
  messages: ModelMessage[];
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  steps: number;
  // Operator-configured per-million rates for rate-computed cost, or null when
  // no pricing is configured. When null, the turn emit site falls back to the
  // vendored card by `modelSlug`; only an unlisted slug stays tokens-only.
  pricing: ProviderPricing | null;
};

/** Step-cap binding for an agent loop: the limit plus its error wording. */
type AgentStepCap = {
  limit: number;
  /** Exported constant name, embedded in the cap-exhaustion error message. */
  constantName: 'OPENAI_COMPATIBLE_MAX_STEPS' | 'OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS';
  /** Loop noun for the cap-exhaustion error message ('coder loop', ...). */
  loopDescription: string;
};

const CODER_STEP_CAP: AgentStepCap = {
  limit: OPENAI_COMPATIBLE_MAX_STEPS,
  constantName: 'OPENAI_COMPATIBLE_MAX_STEPS',
  loopDescription: 'coder loop',
};

function advisorStepCap(label: string): AgentStepCap {
  return {
    limit: OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS,
    constantName: 'OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS',
    loopDescription: `${label} advisor loop`,
  };
}

type AgentTurnContext = {
  role: ProviderRole;
  state: AgentLoopState;
  sessionHandle: string;
  label?: string | undefined;
  inactivityTimeoutMs: number;
  apiRetryLimit: number;
  stepCap: AgentStepCap;
  // Advisor rounds carry a cumulative `steps` field on
  // `turn_completed`/`usage_reported` providerData (tool-turns-per-review is
  // a qualification signal for cheap-model reviewers). The coder omits it;
  // omitting it keeps the coder's providerData shape byte-stable.
  includeStepsTelemetry: boolean;
  sleep: SleepFn;
  signal?: AbortSignal | undefined;
  events?: ProviderEventSink | undefined;
};

/**
 * Maps toolset events onto the provider runtime event grammar (adding the
 * base fields for the owning role) and maintains the cumulative per-tool
 * telemetry maps. The toolset hook is synchronous, so async sink results are
 * fire-and-forget; sink failures must never turn a tool result into a thrown
 * error.
 */
function forwardAgentToolEvent(
  event: OpenAICompatibleToolEvent,
  ctx: {
    role: ProviderRole;
    state: AgentLoopState;
    sessionHandle: string;
    label?: string | undefined;
    events?: ProviderEventSink | undefined;
  },
): void {
  const base = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    role: ctx.role,
    ...(ctx.label !== undefined ? { label: ctx.label } : {}),
    sessionHandle: ctx.sessionHandle,
  };
  const forward = (runtimeEvent: ProviderRuntimeEvent) => {
    if (!ctx.events) {
      return;
    }
    try {
      void Promise.resolve(ctx.events(runtimeEvent)).catch(() => {});
    } catch {
      // Telemetry must never break tool execution.
    }
  };

  switch (event.type) {
    case 'tool_started':
      ctx.state.toolCalls[event.toolName] = (ctx.state.toolCalls[event.toolName] ?? 0) + 1;
      forward({ type: 'tool_started', ...base, toolName: event.toolName });
      return;
    case 'tool_progress':
      if (event.isError) {
        ctx.state.toolErrors[event.toolName] = (ctx.state.toolErrors[event.toolName] ?? 0) + 1;
      }
      forward({
        type: 'tool_progress',
        ...base,
        toolName: event.toolName,
        message: event.message,
        isError: event.isError,
      });
      return;
    case 'command_completed':
      forward({
        type: 'command_completed',
        ...base,
        command: event.command,
        exitCode: event.exitCode,
        output: event.output,
        cwd: event.cwd,
      });
      return;
    case 'file_changed':
      forward({ type: 'file_changed', ...base, files: event.files });
      return;
  }
}

/**
 * The outer tool loop: pushes the prompt onto the shared history and runs
 * model turns (each with its own bounded transient retry) until a turn
 * makes zero tool calls — its assistant text is the loop's completion text
 * — or the step cap is exhausted (`provider_failed`).
 *
 * Discovery (recorded, ai@6.0.202): a tool call whose input fails the tool's
 * inputSchema does NOT throw out of `generateText`. The SDK's parseToolCall
 * catches `InvalidToolInputError`, marks the call `invalid: true,
 * dynamic: true` (without executing the tool), and the generate loop feeds an
 * `error-text` tool-result ("Invalid input for tool <name>: ...") back to the
 * model. The invalid call still appears in `result.toolCalls`, so this loop
 * counts it as a tool-calling turn and continues — the model sees the error
 * and self-corrects or runs into the step cap. That native feedback behavior
 * is the whole strict-input contract; no coercion or repair hook wraps it.
 */
async function runAgentToolLoop(ctx: AgentTurnContext, prompt: string): Promise<string> {
  ctx.state.messages.push({ role: 'user', content: prompt });
  while (true) {
    if (ctx.state.steps >= ctx.stepCap.limit) {
      throw createOpenAICompatibleProviderError({
        message:
          `openai-compatible ${ctx.stepCap.loopDescription} reached the ${ctx.stepCap.constantName} cap of ` +
          `${ctx.stepCap.limit} model turns without a completion turn (a turn with zero tool calls).`,
        role: ctx.role,
        sessionHandle: ctx.sessionHandle,
        kind: 'provider_failed',
        retryable: false,
      });
    }
    const turn = await runAgentModelTurn(ctx, { useTools: true });
    ctx.state.messages.push(...turn.responseMessages);
    if (turn.toolCallCount > 0) {
      // Completion is structural only: a model that narrates completion
      // while still calling tools keeps looping until it makes a turn with
      // zero tool calls or exhausts the step cap (channel rule — no
      // substring classification on content channels).
      continue;
    }
    return turn.assistantText;
  }
}

type AgentTurnOptions = {
  useTools: boolean;
  /**
   * When set, the turn is a dedicated structured-output finalization turn:
   * the `generateText` call carries `output: Output.object(...)` (which the
   * SDK translates into the provider's `response_format` JSON-schema
   * constraint) and no tools, and the parsed object is returned as
   * `structuredOutput`. Mutually exclusive with `useTools: true`.
   */
  structuredOutput?: { schema: Record<string, unknown>; schemaLabel: string };
};

/**
 * True when any object node in the schema declares a property that is not in its
 * own `required` tuple — a genuinely-optional property. The plan reviewer's
 * `findingClass` and the consultant's `targetCanonicalIds` are such
 * properties, kept optional so the tolerant validator can default an omitted
 * value. `@ai-sdk/openai-compatible` sends `strict: true` by default, and an
 * OpenAI-strict json_schema request requires every property to be required and
 * rejects an omitted optional one before the validator can normalize it. The
 * finalization turn therefore disables strict mode (below) for these schemas.
 */
function schemaHasOptionalProperties(schema: unknown): boolean {
  if (Array.isArray(schema)) {
    return schema.some((entry) => schemaHasOptionalProperties(entry));
  }
  if (!schema || typeof schema !== 'object') {
    return false;
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = Array.isArray(record.required) ? (record.required as unknown[]) : [];
    if (Object.keys(properties).some((name) => !required.includes(name))) {
      return true;
    }
  }
  return Object.values(record).some((value) => schemaHasOptionalProperties(value));
}

/**
 * One model turn: emits `turn_started`, makes a single `generateText` call
 * (`stopWhen: stepCountIs(1)`, `maxRetries: 0`, abort/inactivity signal),
 * applies the missing-content rule, emits `assistant_text` (when text is
 * non-empty) then `usage_reported` and `turn_completed` with the
 * cumulative per-tool telemetry providerData. Transient failures retry up
 * to `apiRetryLimit` times with backoff and the standard `api_retry`
 * event; a successful call consumes one step.
 */
async function runAgentModelTurn(
  ctx: AgentTurnContext,
  turnOptions: AgentTurnOptions,
): Promise<{
  assistantText: string;
  toolCallCount: number;
  responseMessages: ModelMessage[];
  /** The SDK-parsed structured object; set only on structured-output turns. */
  structuredOutput?: unknown;
}> {
  const base = {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    role: ctx.role,
    ...(ctx.label !== undefined ? { label: ctx.label } : {}),
    sessionHandle: ctx.sessionHandle,
  };
  // The finalization schema is submitted as an SDK-native json_schema constraint.
  // `@ai-sdk/openai-compatible` defaults strict: true, which requires every
  // property to be in `required` and rejects an omitted optional property before
  // the validator runs. For schemas that legitimately carry an optional property
  // (the plan reviewer's findingClass, the consultant's
  // targetCanonicalIds), disable strict mode on the request so the omitted
  // property survives to the tolerant validator, which then applies its canonical
  // default. The schema still rides as a json_schema constraint and the validator
  // stays the real contract; all-required schemas keep strict enforcement.
  const relaxStrictJsonSchema =
    turnOptions.structuredOutput !== undefined && schemaHasOptionalProperties(turnOptions.structuredOutput.schema);
  let apiRetryCount = 0;

  while (true) {
    try {
      // turn_started before each model call so startup silence is
      // observable by the liveness watchdog.
      await emitProviderEvent(ctx.events, { type: 'turn_started', ...base });

      const turnAbort = createTurnAbortController(ctx.signal, ctx.inactivityTimeoutMs);
      const result = await generateText({
        model: ctx.state.model,
        messages: ctx.state.messages,
        ...(turnOptions.useTools ? { tools: ctx.state.tools } : {}),
        ...(turnOptions.structuredOutput
          ? { output: Output.object({ schema: jsonSchema(turnOptions.structuredOutput.schema) }) }
          : {}),
        ...(relaxStrictJsonSchema
          ? { providerOptions: { openaiCompatible: { strictJsonSchema: false } } }
          : {}),
        maxRetries: 0,
        stopWhen: stepCountIs(1),
        abortSignal: turnAbort.signal,
      }).finally(() => {
        turnAbort.dispose();
      });

      // Reasoning-model fallback: when content text is empty the final
      // text can land in reasoningText (mirrors extractAssistantText in
      // the bespoke adapter).
      const assistantText =
        result.text.trim().length > 0 ? result.text : (result.reasoningText ?? '');
      if (result.toolCalls.length === 0 && assistantText.trim().length === 0) {
        // Missing-content rule: covers embedded HTTP-200 gateway errors
        // and reasoning-only responses on the AI SDK path — transient, so
        // it flows into the bounded retry loop.
        throw createOpenAICompatibleProviderError({
          message:
            `openai-compatible ${ctx.label ?? ctx.role} turn produced neither tool calls nor ` +
            'non-empty assistant text (after the reasoning-text fallback).',
          role: ctx.role,
          sessionHandle: ctx.sessionHandle,
          kind: 'api_error',
          retryable: true,
        });
      }

      // Discovery (recorded, ai@6.0.202): the SDK awaits structured-output
      // parsing inside `generateText` itself, so a non-JSON or
      // schema-mismatched final text throws `NoObjectGeneratedError`
      // (carrying the rejected assistant text as `.text`) from the call
      // above — classified in the catch below. The `result.output` getter
      // throws the *distinct* `NoOutputGeneratedError` only when no output
      // was resolved because the turn's finish reason was not 'stop' (for
      // example a length-truncated response); that case is mapped here.
      let structuredOutputValue: unknown;
      if (turnOptions.structuredOutput) {
        const { schemaLabel } = turnOptions.structuredOutput;
        try {
          structuredOutputValue = result.output;
        } catch (outputError) {
          throw createOpenAICompatibleProviderError({
            message:
              `openai-compatible ${ctx.label ?? ctx.role} finalization turn completed without a ` +
              `"${schemaLabel}" structured output (the response did not finish cleanly).`,
            role: ctx.role,
            sessionHandle: ctx.sessionHandle,
            kind: 'structured_output_missing',
            retryable: false,
            // Carry the turn's assistant text as `text` so the rejected
            // excerpt rides into provider_error providerData.diagnostic.
            cause: {
              message: describeError(outputError),
              text: assistantText,
              cause: outputError,
            },
          });
        }
      }

      ctx.state.steps += 1;

      if (assistantText.trim().length > 0) {
        await emitProviderEvent(ctx.events, {
          type: 'assistant_text',
          ...base,
          text: assistantText,
        });
      }

      // Cumulative per-tool telemetry so run records are self-sufficient for
      // per-tool error attribution. Advisor rounds add the cumulative step
      // count (see includeStepsTelemetry).
      const providerData = {
        toolCalls: { ...ctx.state.toolCalls },
        toolErrors: { ...ctx.state.toolErrors },
        ...(ctx.includeStepsTelemetry ? { steps: ctx.state.steps } : {}),
      };
      // Rate-computed cost: config pricing (when present) wins; otherwise a
      // card-listed model is priced by its resolved slug with no configuration.
      // When neither yields pricing the cost fields are omitted so the
      // tokens-only event shape is preserved (resolveRateCost returns null,
      // matching the prior `computeRateCostUsd`-returns-0-for-empty behavior).
      const cost =
        resolveRateCost({
          usage: result.usage,
          model: ctx.state.modelSlug,
          configPricing: ctx.state.pricing,
        }) ?? {};
      await emitProviderEvent(ctx.events, {
        type: 'usage_reported',
        ...base,
        usage: result.usage,
        ...cost,
        providerData,
      });
      await emitProviderEvent(ctx.events, {
        type: 'turn_completed',
        ...base,
        usage: result.usage,
        ...cost,
        providerData,
      });

      return {
        assistantText,
        toolCallCount: result.toolCalls.length,
        responseMessages: result.response.messages,
        ...(turnOptions.structuredOutput ? { structuredOutput: structuredOutputValue } : {}),
      };
    } catch (error) {
      // Structured-output failure semantics (no repair): NoObjectGeneratedError
      // is classified before generic normalization. An empty rejected text is
      // the missing-content rule (a transport fault — embedded HTTP-200
      // gateway errors, reasoning-only responses — so it stays retryable);
      // any other rejected text is the model failing the structured-output
      // contract: non-retryable `structured_output_missing` with the SDK
      // error (and its `.text` excerpt) as the cause.
      let classified = error;
      // Content-safety refusal takes precedence over the structured-finalization
      // classification below: a refusal returned as an HTTP-400 finalization
      // rejection must land as a terminal content_refused, never
      // structured_output_invalid. Matched on the error channel (describeError
      // reads error.message) only, never the assistant content channel, so a
      // benign schema rejection (no refusal substrings) keeps its
      // structured_output_invalid mapping.
      if (isContentSafetyRefusalMessage(describeError(error))) {
        classified = createOpenAICompatibleProviderError({
          message: `openai-compatible ${ctx.label ?? ctx.role} request was refused on content-safety grounds: ${describeError(error)}`,
          role: ctx.role,
          sessionHandle: ctx.sessionHandle,
          kind: 'content_refused',
          retryable: false,
          cause: error,
        });
      } else if (turnOptions.structuredOutput && NoObjectGeneratedError.isInstance(error)) {
        const { schemaLabel } = turnOptions.structuredOutput;
        classified =
          (error.text ?? '').trim() === ''
            ? createOpenAICompatibleProviderError({
                message:
                  `openai-compatible ${ctx.label ?? ctx.role} finalization turn produced neither tool calls nor ` +
                  'non-empty assistant text (after the reasoning-text fallback).',
                role: ctx.role,
                sessionHandle: ctx.sessionHandle,
                kind: 'api_error',
                retryable: true,
                cause: error,
              })
            : createOpenAICompatibleProviderError({
                message:
                  `openai-compatible ${ctx.label ?? ctx.role} finalization turn did not produce a parsable ` +
                  `"${schemaLabel}" JSON payload: ${describeError(error)}`,
                role: ctx.role,
                sessionHandle: ctx.sessionHandle,
                kind: 'structured_output_missing',
                retryable: false,
                cause: error,
              });
      } else if (
        turnOptions.structuredOutput &&
        typeof error === 'object' &&
        error !== null &&
        readStatusCode(error) === 400
      ) {
        // Request-time schema rejection: now that the SDK sends
        // `response_format.type: 'json_schema'`, a gateway/model that cannot
        // honor schema-enforced JSON rejects the request with HTTP 400. That
        // is the model failing the structured-output contract, not a generic
        // transport fault, so it is an attributable, non-retryable
        // structured_output_invalid (the same compat `structured_output`
        // mode as the NoObjectGeneratedError/validator paths) rather than the
        // `provider_failed` bucket normalizeOpenAICompatibleError would assign.
        // The narrowing to a structured-output turn keeps a 400 on a normal
        // tool turn on its existing `provider_failed` mapping. The raw SDK
        // error rides as the cause so its message/responseBody reach the
        // provider_error diagnostic, exactly like the NoObjectGeneratedError
        // branch above.
        const { schemaLabel } = turnOptions.structuredOutput;
        classified = createOpenAICompatibleProviderError({
          message:
            `openai-compatible ${ctx.label ?? ctx.role} finalization turn was rejected with HTTP 400 ` +
            `while requesting schema-enforced "${schemaLabel}" structured output ` +
            `(the model or gateway does not honor json_schema response_format): ${describeError(error)}`,
          role: ctx.role,
          sessionHandle: ctx.sessionHandle,
          kind: 'structured_output_invalid',
          retryable: false,
          cause: error,
        });
      }
      const providerError = normalizeOpenAICompatibleError(classified, {
        role: ctx.role,
        label: ctx.label ?? ctx.role,
        sessionHandle: ctx.sessionHandle,
        callerSignal: ctx.signal,
      });
      // Caller cancellation never burns retry budget: a caller-signal
      // abort is non-retryable and the aborted check is defensive depth.
      if (providerError.retryable && apiRetryCount < ctx.apiRetryLimit && !ctx.signal?.aborted) {
        apiRetryCount += 1;
        await emitProviderEvent(ctx.events, {
          type: 'tool_progress',
          ...base,
          toolName: 'api_retry',
          message: `transient API failure; retrying (${apiRetryCount}/${ctx.apiRetryLimit})`,
          isError: true,
          providerData: {
            retryCount: apiRetryCount,
            retryLimit: ctx.apiRetryLimit,
            message: providerError.message,
          },
        });
        await ctx.sleep(getApiRetryDelayMs(apiRetryCount));
        continue;
      }
      throw providerError;
    }
  }
}

/**
 * The dedicated SDK-native structured-output finalization turn, shared by the
 * coder and structured-advisor paths: appends one user message requesting the
 * final control payload, runs exactly one no-tools `runAgentModelTurn` with
 * `output: Output.object(...)`, validates the SDK-parsed object with the
 * protocol spec's validator (the single source of truth — the SDK schema is
 * transport-level enforcement of the same JSON schema object, not a parallel
 * contract), and emits `structured_output_received` on success.
 *
 * Why a dedicated turn instead of constraining the tool loop itself:
 * - it preserves per-turn liveness granularity (each turn keeps its own
 *   `turn_started`/inactivity-abort window);
 * - it avoids applying `response_format` to tool-calling turns, a known
 *   cross-provider compatibility gap on OpenAI-compatible gateways;
 * - it sidesteps the SDK's documented +1-step interaction between
 *   structured-output generation and `stopWhen`.
 *
 * The turn goes through the existing `runAgentModelTurn` machinery, so the
 * inactivity abort, caller-signal composition, the missing-content rule, and
 * the bounded `api_retry` transient loop are the same code path; transport
 * retries are not model repair. The turn increments the `steps` telemetry
 * counter like any successful turn but is never subject to the step cap
 * (the cap binds only inside `runAgentToolLoop`). There are no repair turns,
 * no fence extraction, and no raw-JSON tolerance: a model that cannot answer
 * this turn with the payload fails non-retryably.
 */
async function runStructuredFinalizationTurn<TStructured>(args: {
  ctx: AgentTurnContext;
  protocol: StructuredJsonProtocolSpec<TStructured>;
  /** The spec's schema, narrowed to its object form by the caller's guard. */
  schema: Record<string, unknown>;
}): Promise<TStructured> {
  const { ctx, protocol, schema } = args;
  // The schema (and example payload, when the spec provides one) rides in the
  // message because some OpenAI-compatible endpoints silently ignore
  // `response_format` (a known gateway gap); without it those models would
  // have no shape information at all. This is prompt content, not a parsing
  // protocol — nothing reads the text back.
  const promptLines = [
    `Return the final ${protocol.schemaLabel} control payload now as a single JSON object. Do not call tools.`,
    '',
    'The payload must satisfy this JSON schema:',
    JSON.stringify(schema, null, 2),
  ];
  if (protocol.examplePayload !== undefined) {
    promptLines.push('', 'Example payload:', JSON.stringify(protocol.examplePayload, null, 2));
  }
  ctx.state.messages.push({ role: 'user', content: promptLines.join('\n') });

  const turn = await runAgentModelTurn(ctx, {
    useTools: false,
    structuredOutput: { schema, schemaLabel: protocol.schemaLabel },
  });
  ctx.state.messages.push(...turn.responseMessages);

  let structured: TStructured;
  try {
    structured = protocol.validator(turn.structuredOutput);
  } catch (validationError) {
    throw createOpenAICompatibleProviderError({
      message:
        `openai-compatible ${ctx.label ?? ctx.role} finalization payload failed "${protocol.schemaLabel}" ` +
        `validation: ${describeError(validationError)}`,
      role: ctx.role,
      sessionHandle: ctx.sessionHandle,
      kind: 'structured_output_invalid',
      retryable: false,
      // The generated JSON rides as `text` on the cause so the excerpt
      // reaches provider_error providerData.diagnostic (same capture as
      // NoObjectGeneratedError.text).
      cause: {
        message: describeError(validationError),
        text: JSON.stringify(turn.structuredOutput, null, 2) ?? String(turn.structuredOutput),
        cause: validationError,
      },
    });
  }

  await emitProviderEvent(ctx.events, {
    type: 'structured_output_received',
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    role: ctx.role,
    ...(ctx.label !== undefined ? { label: ctx.label } : {}),
    sessionHandle: ctx.sessionHandle,
    providerData: { schemaLabel: protocol.schemaLabel },
  });
  return structured;
}

/**
 * Appends the protocol spec's `responseShapeHint` (decision-content guidance,
 * not transport instructions) to the base prompt. The base prompt is sent
 * fence-free: no neal-json instructions and no schema dump — the schema is
 * delivered by the finalization turn.
 */
function appendResponseShapeHint(
  prompt: string,
  protocol: StructuredJsonProtocolSpec<unknown>,
): string {
  const hint = protocol.responseShapeHint?.trim();
  return hint ? `${prompt}\n\nResponse shape guidance:\n${hint}` : prompt;
}

class OpenAICompatibleCoderAdapter implements CoderAdapter {
  constructor(private readonly options: OpenAICompatibleAdapterOptions) {}

  async runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
    const sessionHandle = buildSyntheticSessionHandle();
    try {
      this.assertNoResumeHandle(args.resumeHandle, sessionHandle);
      const state = this.prepareLoopState({
        cwd: args.cwd,
        sessionHandle,
        events: args.events,
        toolPolicy: args.toolPolicy,
      });
      await this.emitSessionStarted({ sessionHandle, events: args.events });
      // CoderRunPromptArgs carries no apiRetryLimit: runPrompt performs no
      // in-round transient retries; the liveness supervisor and orchestrator
      // retries own recovery there.
      const finalResponse = await runAgentToolLoop({
        role: 'coder',
        state,
        sessionHandle,
        inactivityTimeoutMs: args.inactivityTimeoutMs,
        apiRetryLimit: 0,
        stepCap: CODER_STEP_CAP,
        includeStepsTelemetry: false,
        sleep: this.options.sleep ?? defaultSleep,
        signal: args.signal,
        events: args.events,
      }, args.prompt);
      // Never persist a resumable handle for this provider, and never invoke
      // args.onSessionStarted: the orchestrator persists that callback's
      // handle and would then demand session_resume support.
      return { sessionHandle: null, finalResponse };
    } catch (error) {
      throw await this.surfaceError(error, {
        sessionHandle,
        events: args.events,
        callerSignal: args.signal,
      });
    }
  }

  async runStructuredPrompt<TStructured>(
    args: CoderStructuredPromptArgs<TStructured>,
  ): Promise<CoderStructuredPromptResult<TStructured>> {
    const sessionHandle = buildSyntheticSessionHandle();
    try {
      this.assertNoResumeHandle(args.resumeHandle, sessionHandle);
      const protocol = args.structuredJsonProtocol;
      if (!protocol || protocol.protocol !== 'neal-json-block-v1') {
        // The spec is still required: it carries the schema, validator, and
        // labels that drive the SDK-native structured-output finalization
        // turn (the fence protocol itself is never rendered here).
        throw createOpenAICompatibleProviderError({
          message:
            `openai-compatible ${args.label} prompts require the neal-json-block-v1 structured JSON ` +
            'protocol spec; its schema, validator, and labels drive the SDK-native structured-output ' +
            'finalization turn.',
          role: 'coder',
          sessionHandle,
          kind: 'provider_failed',
          retryable: false,
        });
      }
      if (typeof protocol.schema === 'string') {
        // Configuration error: the SDK's jsonSchema(...) needs the object
        // form. No runtime caller passes the string arm of the spec's
        // schema union today.
        throw createOpenAICompatibleProviderError({
          message:
            `openai-compatible ${args.label} prompts require an object-form JSON schema for ` +
            `"${protocol.schemaLabel}"; a string schema cannot drive the SDK-native structured-output ` +
            'finalization turn.',
          role: 'coder',
          sessionHandle,
          kind: 'provider_failed',
          retryable: false,
        });
      }

      const state = this.prepareLoopState({
        cwd: args.cwd,
        sessionHandle,
        label: args.label,
        events: args.events,
        toolPolicy: args.toolPolicy,
      });
      await this.emitSessionStarted({ sessionHandle, label: args.label, events: args.events });

      const turnContext: AgentTurnContext = {
        role: 'coder',
        state,
        sessionHandle,
        label: args.label,
        inactivityTimeoutMs: args.inactivityTimeoutMs,
        apiRetryLimit: args.apiRetryLimit ?? 0,
        stepCap: CODER_STEP_CAP,
        includeStepsTelemetry: false,
        sleep: this.options.sleep ?? defaultSleep,
        signal: args.signal,
        events: args.events,
      };

      // The tool loop runs to its normal zero-tool-call completion turn on a
      // fence-free prompt; its assistant text stays in the shared history.
      // Then exactly one finalization turn produces the structured payload.
      await runAgentToolLoop(turnContext, appendResponseShapeHint(args.prompt, protocol));
      const structured = await runStructuredFinalizationTurn({
        ctx: turnContext,
        protocol,
        schema: protocol.schema,
      });

      // Never persist a resumable handle; args.onSessionStarted is never
      // invoked for this provider (see runPrompt).
      return { sessionHandle: null, structured };
    } catch (error) {
      throw await this.surfaceError(error, {
        sessionHandle,
        label: args.label,
        events: args.events,
        callerSignal: args.signal,
      });
    }
  }

  private assertNoResumeHandle(resumeHandle: string | null | undefined, sessionHandle: string) {
    if (resumeHandle === undefined || resumeHandle === null) {
      return;
    }
    // Defensive: this provider never persists a session handle, so a
    // non-null resume handle can only come from corrupted run state.
    throw createOpenAICompatibleProviderError({
      message:
        'openai-compatible does not support session resume and never persists session handles, ' +
        `but a resume handle was provided (${JSON.stringify(resumeHandle)}); this indicates corrupted run state.`,
      role: 'coder',
      sessionHandle,
      kind: 'session_unavailable',
      retryable: false,
    });
  }

  private prepareLoopState(args: {
    cwd: string;
    sessionHandle: string;
    label?: string | undefined;
    events?: ProviderEventSink | undefined;
    toolPolicy?: CoderRunPromptArgs['toolPolicy'];
  }): AgentLoopState {
    const resolveSettings = this.options.resolveSettings ?? getOpenAICompatibleSettings;
    const settings = resolveOpenAICompatibleSettings({
      cwd: args.cwd,
      roundModel: null,
      roleModel: this.options.model ?? null,
      context: {
        role: 'coder',
        noun: 'coder',
        subject: 'coder run',
        modelOverrideExample: 'agent.coder.model',
      },
      resolveSettings,
    });
    const createModel = this.options.createModel ?? createDefaultOpenAICompatibleModel;
    const model = createModel({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      headers: settings.headers,
      model: settings.model,
    });

    const state: AgentLoopState = {
      model,
      modelSlug: settings.model,
      // Assigned immediately below; the toolset's event hook needs the state
      // object to update the cumulative per-tool telemetry maps.
      tools: undefined as unknown as ToolSet,
      messages: [],
      toolCalls: {},
      toolErrors: {},
      steps: 0,
      pricing: settings.pricing,
    };
    const createToolset =
      args.toolPolicy?.allowRun === false ? createPlanAuthorToolset : createCoderToolset;
    state.tools = createToolset(args.cwd, {
      allowedWritePaths: args.toolPolicy?.allowedWritePaths,
      emitToolEvent: (event) =>
        forwardAgentToolEvent(event, {
          role: 'coder',
          state,
          sessionHandle: args.sessionHandle,
          label: args.label,
          events: args.events,
        }),
    });
    return state;
  }

  private async emitSessionStarted(args: {
    sessionHandle: string;
    label?: string | undefined;
    events?: ProviderEventSink | undefined;
  }) {
    await emitProviderEvent(args.events, {
      type: 'session_started',
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      role: 'coder',
      ...(args.label !== undefined ? { label: args.label } : {}),
      sessionHandle: args.sessionHandle,
    });
  }

  private async surfaceError(
    error: unknown,
    ctx: {
      sessionHandle: string;
      label?: string | undefined;
      events?: ProviderEventSink | undefined;
      callerSignal?: AbortSignal | undefined;
    },
  ): Promise<NealProviderError> {
    const providerError = normalizeOpenAICompatibleError(error, {
      role: 'coder',
      label: ctx.label ?? 'coder',
      sessionHandle: ctx.sessionHandle,
      callerSignal: ctx.callerSignal,
    });
    await emitProviderEvent(ctx.events, {
      type: 'provider_error',
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      role: 'coder',
      ...(ctx.label !== undefined ? { label: ctx.label } : {}),
      sessionHandle: providerError.sessionHandle ?? ctx.sessionHandle,
      message: providerError.message,
      errorKind: providerError.kind,
      providerData: providerErrorData(providerError),
    });
    // Thrown errors must not carry the events-only synthetic handle (see
    // withEventsOnlySessionHandle): the orchestrator persists it from the
    // error and resume would then demand session_resume support.
    return withEventsOnlySessionHandle(providerError);
  }
}

/**
 * Structured-advisor adapter with a bounded read-only tool loop: rounds run
 * the shared outer loop over `createReadOnlyToolset` (`read_file`,
 * `list_dir`, `grep`, `git_diff`; never write or shell) until a zero-tool-call turn,
 * then exactly one SDK-native structured-output finalization turn produces
 * the round payload (`runStructuredFinalizationTurn`, shared with the coder
 * structured path). Settings resolution, transient retry,
 * abort/inactivity composition, and the missing-content rule are the shared
 * per-turn machinery. This is the adapter
 * `runCoderFinalCompletionSummaryRound` uses when the coder is
 * `openai-compatible`, and it is what lets a generic reviewer inspect the
 * repository directly instead of relying on Neal-inlined context. Advisor
 * rounds are stateless: no advisor handle is ever persisted, so
 * `args.resumeHandle` is silently ignored (unlike the coder path's
 * `session_unavailable` guard).
 */
class OpenAICompatibleStructuredAdvisorAdapter implements StructuredAdvisorAdapter {
  constructor(private readonly options: OpenAICompatibleAdapterOptions) {}

  async runStructuredRound<TStructured>(
    args: StructuredAdvisorRoundArgs<TStructured>,
  ): Promise<StructuredAdvisorRoundResult<TStructured>> {
    const sessionHandle = buildSyntheticSessionHandle();
    try {
      const protocol = args.structuredJsonProtocol;
      if (!protocol || protocol.protocol !== 'neal-json-block-v1') {
        // The spec is still required: it carries the schema, validator, and
        // labels that drive the SDK-native structured-output finalization
        // turn (the fence protocol itself is never rendered here).
        throw createOpenAICompatibleProviderError({
          message:
            `openai-compatible ${args.label} rounds require the neal-json-block-v1 structured JSON ` +
            'protocol spec; its schema, validator, and labels drive the SDK-native structured-output ' +
            'finalization turn.',
          role: 'structured-advisor',
          sessionHandle,
          kind: 'provider_failed',
          retryable: false,
        });
      }
      if (typeof protocol.schema === 'string') {
        // Configuration error: the SDK's jsonSchema(...) needs the object
        // form. No runtime caller passes the string arm of the spec's
        // schema union today.
        throw createOpenAICompatibleProviderError({
          message:
            `openai-compatible ${args.label} rounds require an object-form JSON schema for ` +
            `"${protocol.schemaLabel}"; a string schema cannot drive the SDK-native structured-output ` +
            'finalization turn.',
          role: 'structured-advisor',
          sessionHandle,
          kind: 'provider_failed',
          retryable: false,
        });
      }

      const resolveSettings = this.options.resolveSettings ?? getOpenAICompatibleSettings;
      const settings = resolveOpenAICompatibleSettings({
        cwd: args.cwd,
        // Round-level args.model wins over the adapter/role model and
        // default_model (matching resolveRoundSettings in the bespoke
        // adapter).
        roundModel: args.model ?? null,
        roleModel: this.options.model ?? null,
        context: {
          role: 'structured-advisor',
          noun: args.label,
          subject: `${args.label} round`,
          modelOverrideExample: 'agent.reviewer.model',
        },
        resolveSettings,
      });
      const createModel = this.options.createModel ?? createDefaultOpenAICompatibleModel;
      const model = createModel({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        headers: settings.headers,
        model: settings.model,
      });

      const state: AgentLoopState = {
        model,
        modelSlug: settings.model,
        // Assigned immediately below; the toolset's event hook needs the
        // state object to update the cumulative per-tool telemetry maps.
        tools: undefined as unknown as ToolSet,
        messages: [],
        toolCalls: {},
        toolErrors: {},
        steps: 0,
        pricing: settings.pricing,
      };
      // Read-only inspection toolset only: advisor rounds must never gain
      // write or shell access. Tool events forward with the advisor role and
      // the round label.
      state.tools = createReadOnlyToolset(args.cwd, {
        emitToolEvent: (event) =>
          forwardAgentToolEvent(event, {
            role: 'structured-advisor',
            state,
            sessionHandle,
            label: args.label,
            events: args.events,
          }),
      });

      const turnContext: AgentTurnContext = {
        role: 'structured-advisor',
        state,
        sessionHandle,
        label: args.label,
        inactivityTimeoutMs: args.inactivityTimeoutMs,
        apiRetryLimit: args.apiRetryLimit,
        stepCap: advisorStepCap(args.label),
        includeStepsTelemetry: true,
        sleep: this.options.sleep ?? defaultSleep,
        // Caller cancellation is wired into every turn — the read-only tool
        // loop and the finalization turn alike (matching the coder
        // structured path).
        signal: args.signal,
        events: args.events,
      };

      await emitProviderEvent(args.events, {
        type: 'session_started',
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        role: 'structured-advisor',
        label: args.label,
        sessionHandle,
      });

      // The read-only tool loop runs to its normal zero-tool-call completion
      // turn on a fence-free prompt; its assistant text stays in the shared
      // history. Then exactly one finalization turn produces the structured
      // payload (it increments the `steps` telemetry like any successful
      // turn but is never subject to the advisor step cap, which binds only
      // inside the tool loop).
      await runAgentToolLoop(turnContext, appendResponseShapeHint(args.prompt, protocol));
      const structured = await runStructuredFinalizationTurn({
        ctx: turnContext,
        protocol,
        schema: protocol.schema,
      });

      // Never persist a resumable handle for this provider.
      return { sessionHandle: null, structured };
    } catch (error) {
      const providerError = normalizeOpenAICompatibleError(error, {
        role: 'structured-advisor',
        label: args.label,
        sessionHandle,
        callerSignal: args.signal,
      });
      await emitProviderEvent(args.events, {
        type: 'provider_error',
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        role: 'structured-advisor',
        label: args.label,
        sessionHandle: providerError.sessionHandle ?? sessionHandle,
        message: providerError.message,
        errorKind: providerError.kind,
        providerData: providerErrorData(providerError),
      });
      // Strip the events-only handle before throwing: the final-completion
      // summary path persists `error.sessionHandle` into
      // `state.coderSessionHandle` (src/neal/orchestrator/completion.ts), and
      // a persisted handle rejects `neal resume` for this provider.
      throw withEventsOnlySessionHandle(providerError);
    }
  }
}

export function createOpenAICompatibleCoderAdapter(
  options: OpenAICompatibleAdapterOptions = {},
): CoderAdapter {
  return new OpenAICompatibleCoderAdapter(options);
}

export function createOpenAICompatibleStructuredAdvisorAdapter(
  options: OpenAICompatibleAdapterOptions = {},
): StructuredAdvisorAdapter {
  return new OpenAICompatibleStructuredAdvisorAdapter(options);
}

export const openAICompatibleProviderDefinition = {
  id: OPENAI_COMPATIBLE_PROVIDER_ID,
  displayName: 'OpenAI-compatible',
  capabilities: {
    coder: {
      supported: true,
      toolAccess: { read: true, write: true, shell: true },
      supportsSessionResume: false,
      supportsModelOverride: true,
      supportsStructuredOutput: true,
      usageReporting: 'opportunistic',
    },
    // Required so the coder role passes the final-completion
    // structured-advisor gate (assertAgentConfigSupportsWriterRun asserts
    // the coder provider's structured-advisor path for
    // runCoderFinalCompletionSummaryRound). Advisor rounds run the bounded
    // read-only tool loop (read_file, list_dir, grep), so read is true:
    // reviewers inspect the repository directly (the 'read-only' review
    // doctrine mode) instead of receiving Neal-inlined context. Write and
    // shell stay false — advisor rounds never mutate or execute.
    'structured-advisor': {
      supported: true,
      toolAccess: { read: true, write: false, shell: false },
      // The read-only advisor tool loop exposes a real commit-range diff tool
      // (git_diff in createReadOnlyToolset), so the read-only review doctrine
      // instructs that tool directly instead of having Neal inline the diff.
      providesRangeDiffTool: true,
      supportsSessionResume: false,
      supportsModelOverride: true,
      supportsStructuredOutput: true,
      usageReporting: 'opportunistic',
    },
  },
  createCoderAdapter: createOpenAICompatibleCoderAdapter,
  createStructuredAdvisorAdapter: createOpenAICompatibleStructuredAdvisorAdapter,
} satisfies NealProviderDefinition;

export const openAICompatibleProviderTestHooks = {
  createDefaultOpenAICompatibleModel,
  normalizeOpenAICompatibleError,
  createCoderAdapterWithInjection: (
    injection: {
      resolveSettings?: OpenAICompatibleSettingsResolver;
      createModel?: OpenAICompatibleModelFactory;
      sleep?: SleepFn;
    },
    options?: { model?: string | null; effort?: string | null },
  ) => new OpenAICompatibleCoderAdapter({ ...options, ...injection }),
  createStructuredAdvisorAdapterWithInjection: (
    injection: {
      resolveSettings?: OpenAICompatibleSettingsResolver;
      createModel?: OpenAICompatibleModelFactory;
      sleep?: SleepFn;
    },
    options?: { model?: string | null; effort?: string | null },
  ) => new OpenAICompatibleStructuredAdvisorAdapter({ ...options, ...injection }),
};
