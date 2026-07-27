import { getAgentTurnRetryLimit, getAgentTurnStartupTimeoutMs, getApiRetryLimit, getInactivityTimeoutMs } from '../config.js';
import type { RunLogger } from '../logger.js';
import { runWithAgentTurnLiveness } from '../providers/liveness.js';
import { getCoderAdapter } from '../providers/registry.js';
import { createProviderTelemetrySink } from '../providers/telemetry.js';
import { isNealProviderError, type NealProviderError, type StructuredJsonProtocolSpec } from '../providers/types.js';
import type { AgentRoleConfig } from '../types.js';

export class CoderRoundError extends Error {
  readonly sessionHandle: string | null;
  readonly providerError: NealProviderError;
  readonly kind: NealProviderError['kind'];
  readonly retryable: boolean;

  constructor(providerError: NealProviderError) {
    super(providerError.message);
    this.name = 'CoderRoundError';
    this.sessionHandle = providerError.sessionHandle;
    this.providerError = providerError;
    this.kind = providerError.kind;
    this.retryable = providerError.retryable;
  }
}

export function translateCoderProviderError(error: unknown): CoderRoundError | unknown {
  if (isNealProviderError(error)) {
    return new CoderRoundError(error);
  }
  return error;
}

function getCoderRuntimeOptions(cwd: string) {
  return {
    inactivityTimeoutMs: getInactivityTimeoutMs(cwd),
  };
}

function createCoderProviderEventSink(args: {
  coder: AgentRoleConfig;
  cwd: string;
  label?: 'planner';
  logger?: RunLogger;
}) {
  return createProviderTelemetrySink({
    logger: args.logger,
    provider: args.coder.provider,
    role: 'coder',
    ...(args.label ? { label: args.label } : {}),
    cwd: args.cwd,
  });
}

export async function runCoderStructuredPrompt<TStructured>(args: {
  coder: AgentRoleConfig;
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  label: string;
  structuredJsonProtocol: StructuredJsonProtocolSpec<TStructured>;
  toolPolicy?: {
    allowedWritePaths?: string[];
    allowRun?: boolean;
  };
  resumeHandle?: string | null;
  telemetryLabel?: 'planner';
  logger?: RunLogger;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
}): Promise<{ sessionHandle: string | null; structured: TStructured }> {
  try {
    const coder = getCoderAdapter(args.coder);
    return await runWithAgentTurnLiveness({
      provider: args.coder.provider,
      role: 'coder',
      ...(args.telemetryLabel ? { label: args.telemetryLabel } : {}),
      startupTimeoutMs: Math.min(getAgentTurnStartupTimeoutMs(args.cwd), getInactivityTimeoutMs(args.cwd)),
      // Resumed sessions never retry in the supervisor; the orchestrator's
      // fresh-session retry owns recovery so session-handle state stays
      // consistent.
      retryLimit: args.resumeHandle ? 0 : getAgentTurnRetryLimit(args.cwd),
      logger: args.logger,
      baseSink: createCoderProviderEventSink({
        coder: args.coder,
        cwd: args.cwd,
        label: args.telemetryLabel,
        logger: args.logger,
      }),
      run: (events, attempt) =>
        coder.runStructuredPrompt<TStructured>({
          cwd: args.cwd,
          prompt: args.prompt,
          label: args.label,
          schema: args.schema,
          structuredJsonProtocol: args.structuredJsonProtocol,
          toolPolicy: args.toolPolicy,
          ...getCoderRuntimeOptions(args.cwd),
          // Resumed sessions never retry in-round; the orchestrator's
          // fresh-session retry owns recovery.
          apiRetryLimit: args.resumeHandle ? 0 : getApiRetryLimit(args.cwd),
          resumeHandle: args.resumeHandle,
          // Guarded so an abandoned attempt's late session handle can never
          // overwrite a newer attempt's handle.
          onSessionStarted: attempt.guard(args.onSessionStarted),
          signal: attempt.signal,
          events,
        }),
    });
  } catch (error) {
    throw translateCoderProviderError(error);
  }
}
