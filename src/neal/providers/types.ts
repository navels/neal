export type ProviderId = string;
export type ProviderRole = 'coder' | 'structured-advisor';

export type ProviderToolAccess = {
  read: boolean;
  write: boolean;
  shell: boolean;
};

export type ProviderUsageReporting = 'opportunistic' | 'none';

export type ProviderRoleCapabilities = {
  supported: boolean;
  toolAccess: ProviderToolAccess;
  // Structural signal that a read-only structured-advisor reviewer exposes a
  // commit-range diff tool (e.g. openai-compatible's `git_diff`). When absent or
  // false, a read-only reviewer has no way to see the commit-range diff through
  // tools, so Neal inlines the commit-range diff into its reviewer prompt
  // instead of instructing it to call a diff tool it does not have. Only
  // meaningful for the `read-only` review doctrine; irrelevant for
  // `tool-access` (shell `git diff`).
  providesRangeDiffTool?: boolean;
  // Hard per-turn input limit in characters, when the provider enforces one
  // (Codex's app-server rejects any single turn over 1,048,576 chars with
  // `input_too_large`). An adapter whose role declares this preflights every
  // assembled prompt at its turn/round entry points and fails fast with a
  // normalized `input_too_large` error before any SDK call (see
  // input-budget.ts). Undefined means no known hard limit and no preflight.
  maxInputChars?: number;
  supportsSessionResume: boolean;
  supportsModelOverride: boolean;
  supportsStructuredOutput: boolean;
  usageReporting: ProviderUsageReporting;
  supportedEfforts?: readonly string[];
};

export type ProviderCapabilities = Record<ProviderRole, ProviderRoleCapabilities>;

export type ProviderAdapterOptions = {
  model?: string | null;
  effort?: string | null;
};

export type NealProviderDefinition = {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapabilities;
  createCoderAdapter?: (options?: ProviderAdapterOptions) => CoderAdapter;
  createStructuredAdvisorAdapter?: (options?: ProviderAdapterOptions) => StructuredAdvisorAdapter;
};

export type ProviderRuntimeEventBase = {
  provider: ProviderId;
  role: ProviderRole;
  label?: string;
  sessionHandle?: string | null;
  providerData?: Record<string, unknown>;
};

export type ProviderRuntimeEvent =
  | (ProviderRuntimeEventBase & { type: 'session_started'; sessionHandle: string })
  | (ProviderRuntimeEventBase & { type: 'turn_started' })
  | (ProviderRuntimeEventBase & {
      type: 'turn_completed';
      usage?: unknown;
      costUsd?: number;
      costSource?: 'provider' | 'rate';
    })
  | (ProviderRuntimeEventBase & { type: 'tool_started'; toolName?: string; itemId?: string | null })
  | (ProviderRuntimeEventBase & { type: 'tool_progress'; toolName?: string; itemId?: string | null; message?: string; isError?: boolean })
  | (ProviderRuntimeEventBase & {
      type: 'command_completed';
      itemId?: string | null;
      command: string;
      status?: string | null;
      exitCode?: number | null;
      output?: string;
      outputLength?: number | null;
      cwd?: string | null;
      gitHead?: string | null;
    })
  | (ProviderRuntimeEventBase & { type: 'file_changed'; files: string[] })
  | (ProviderRuntimeEventBase & { type: 'assistant_text'; text: string })
  | (ProviderRuntimeEventBase & { type: 'assistant_thinking'; estimatedTokens?: number })
  | (ProviderRuntimeEventBase & { type: 'structured_output_received' })
  | (ProviderRuntimeEventBase & {
      type: 'usage_reported';
      usage: unknown;
      costUsd?: number;
      costSource?: 'provider' | 'rate';
    })
  | (ProviderRuntimeEventBase & { type: 'provider_error'; message: string; errorKind?: NealProviderErrorKind });

export type ProviderEventSink = (event: ProviderRuntimeEvent) => void | Promise<void>;

export type NealProviderErrorKind =
  | 'timeout'
  | 'no_progress_timeout'
  | 'api_error'
  | 'structured_output_missing'
  | 'structured_output_invalid'
  | 'permission_denied'
  | 'session_unavailable'
  | 'content_refused'
  | 'input_too_large'
  | 'provider_failed'
  | 'unknown';

// Detects an OpenAI content-safety refusal in a provider-authored error or
// exception message. OpenAI flags security-adjacent requests with a stable
// notice ("This content was flagged for possible cybersecurity risk ... join
// the Trusted Access for Cyber ..."); either substring is specific enough that
// ordinary review findings mentioning "security" do not trip it. Callers must
// only pass error-channel text (an embedded gateway error message or an
// HTTP/transport exception message), never assistant review content.
export function isContentSafetyRefusalMessage(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('flagged for possible cybersecurity risk') ||
    text.includes('trusted access for cyber')
  );
}

export class NealProviderError extends Error {
  readonly provider: ProviderId;
  readonly role: ProviderRole;
  readonly sessionHandle: string | null;
  readonly kind: NealProviderErrorKind;
  readonly retryable: boolean;
  readonly cause: unknown;

  constructor(args: {
    message: string;
    provider: ProviderId;
    role: ProviderRole;
    sessionHandle?: string | null;
    kind?: NealProviderErrorKind;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'NealProviderError';
    this.provider = args.provider;
    this.role = args.role;
    this.sessionHandle = args.sessionHandle ?? null;
    this.kind = args.kind ?? 'unknown';
    this.retryable = args.retryable ?? false;
    this.cause = args.cause;
  }
}

export function isNealProviderError(error: unknown): error is NealProviderError {
  return error instanceof NealProviderError;
}

// Provider adapters own SDK initialization, SDK stream/message collection,
// opaque session-handle mapping, SDK error normalization, and SDK telemetry
// normalization into Neal provider events. When an SDK exposes a useful
// provider-authored failure before later generic transport, iterator, or
// process-wrapper noise, adapters should preserve that provider-authored
// failure as the normalized error.
//
// Providers must not own orchestration state transitions, adjudication
// decisions, terminal narration policy, source-control policy, or local
// review loop policy. Those behaviors stay in Neal's orchestration and
// command layers so adding a provider does not fork the product workflow.
export type CoderRunPromptArgs = {
  cwd: string;
  prompt: string;
  inactivityTimeoutMs: number;
  resumeHandle?: string | null;
  skipGitRepoCheck?: boolean;
  toolPolicy?: {
    allowedWritePaths?: string[];
    allowRun?: boolean;
  };
  outputSchema?: Record<string, unknown>;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  events?: ProviderEventSink;
  // External cancellation for the primary turn. Adapters propagate aborts into
  // their SDK-level cancellation; repair turns are short prompt-only turns and
  // are not wired to this signal.
  signal?: AbortSignal;
};

export type CoderRunPromptResult = {
  sessionHandle: string | null;
  finalResponse: string;
};

export type CoderStructuredPromptArgs<TStructured = unknown> = Omit<CoderRunPromptArgs, 'outputSchema'> & {
  label: string;
  schema: Record<string, unknown>;
  structuredJsonProtocol: StructuredJsonProtocolSpec<TStructured>;
  // Bounded in-round retries for transient provider failures. Callers must
  // pass 0 for resumed sessions; the orchestrator's fresh-session retry owns
  // recovery there.
  apiRetryLimit?: number;
};

export type CoderStructuredPromptResult<TStructured> = {
  sessionHandle: string | null;
  structured: TStructured;
};

export type StructuredJsonProtocolSpec<TStructured = unknown> = {
  protocol: 'neal-json-block-v1';
  schemaLabel: string;
  schema: Record<string, unknown> | string;
  validator: (payload: unknown) => TStructured;
  repairAttemptLimit: number;
  responseShapeHint?: string;
  examplePayload?: unknown;
  allowProseBeforeBlock?: boolean;
};

export type StructuredAdvisorRoundArgs<TStructured = unknown> = {
  // Neal round category for prompts/logging; not provider-specific nomenclature.
  label:
    | 'review'
    | 'plan-review'
    | 'support'
    | 'final-completion'
    | 'provider-check'
    | 'review-findings'
    | 'consultant';
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  inactivityTimeoutMs: number;
  apiRetryLimit: number;
  model?: string | null;
  skipGitRepoCheck?: boolean;
  events?: ProviderEventSink;
  resumeHandle?: string | null;
  structuredJsonProtocol?: StructuredJsonProtocolSpec<TStructured>;
  // External cancellation for the primary turn. Adapters propagate aborts into
  // their SDK-level cancellation; repair turns are short prompt-only turns and
  // are not wired to this signal.
  signal?: AbortSignal;
};

export type StructuredAdvisorRoundResult<TStructured> = {
  sessionHandle: string | null;
  structured: TStructured;
};

export type CoderAdapter = {
  runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult>;
  runStructuredPrompt<TStructured>(
    args: CoderStructuredPromptArgs<TStructured>,
  ): Promise<CoderStructuredPromptResult<TStructured>>;
};

export type StructuredAdvisorAdapter = {
  runStructuredRound<TStructured>(
    args: StructuredAdvisorRoundArgs<TStructured>,
  ): Promise<StructuredAdvisorRoundResult<TStructured>>;
};
