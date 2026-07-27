import { writeDetail, writeErrorDetail } from '../diagnostic.js';
import type { RunLogger } from '../logger.js';
import { providerShortName } from './telemetry.js';
import {
  NealProviderError,
  type ProviderEventSink,
  type ProviderId,
  type ProviderRole,
  type ProviderRuntimeEvent,
} from './types.js';

export type AgentTurnAttemptGuard = <A extends unknown[]>(
  callback?: (...args: A) => void | Promise<void>,
) => ((...args: A) => void | Promise<void>) | undefined;

export type AgentTurnAttempt = {
  attempt: number;
  signal: AbortSignal;
  // Wraps a caller-supplied callback (e.g. onSessionStarted) so it no-ops
  // permanently once this attempt is abandoned. Returns undefined when given
  // undefined so call sites can pass it through unconditionally.
  guard: AgentTurnAttemptGuard;
};

export type AgentTurnLivenessArgs<T> = {
  provider: ProviderId;
  role: ProviderRole;
  label?: string;
  // Already clamped by the caller (min of the startup timeout and the call
  // site's inactivity timeout).
  startupTimeoutMs: number;
  retryLimit: number;
  logger?: RunLogger;
  baseSink?: ProviderEventSink;
  run: (events: ProviderEventSink | undefined, attempt: AgentTurnAttempt) => Promise<T>;
};

// Events that prove the transport is alive but do not represent observable
// work; they reset the startup-silence timer without disarming it.
// `assistant_thinking` is reset-only on purpose: extended thinking proves the
// stream is alive, but keeping the watchdog armed means a stream that dies
// mid-think is caught at startup-window granularity instead of waiting out
// the much larger adapter inactivity timeout.
const TIMER_RESET_EVENT_TYPES: ReadonlySet<ProviderRuntimeEvent['type']> = new Set([
  'session_started',
  'turn_started',
  'assistant_thinking',
]);

// First observable progress permanently disarms the startup-silence timer for
// the attempt; from then on the adapter's inactivityTimeoutMs governs.
const MEANINGFUL_PROGRESS_EVENT_TYPES: ReadonlySet<ProviderRuntimeEvent['type']> = new Set([
  'tool_started',
  'tool_progress',
  'command_completed',
  'file_changed',
  'assistant_text',
  'structured_output_received',
  'usage_reported',
  'turn_completed',
  'provider_error',
]);


type AttemptRaceResult<T> =
  | { kind: 'resolved'; value: T }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'startup_timeout' };

// Orchestration-level supervisor for startup silence on provider turns.
//
// It watches the provider event stream for the gap between turn start and the
// first observable progress. `session_started` / `turn_started` reset the
// startup timer (transport alive) but never disarm it; the first
// meaningful-progress event disarms it permanently for the attempt, after
// which the adapter-owned inactivity timeout governs. When the startup timer
// fires, the attempt is abandoned (its events and guarded callbacks become
// permanent no-ops), its AbortSignal is aborted, and the turn is retried up to
// `retryLimit` times before throwing a `no_progress_timeout` provider error.
// Errors thrown by `run` itself are never retried here.
export async function runWithAgentTurnLiveness<T>(args: AgentTurnLivenessArgs<T>): Promise<T> {
  const retryLimit = Math.max(0, Math.floor(args.retryLimit));
  const labelOrRole = args.label ?? args.role;
  const seconds = Math.round(args.startupTimeoutMs / 1000);
  const detailContext = { provider: args.provider, role: labelOrRole };

  const livenessEventData = (attempt: number) => ({
    provider: args.provider,
    role: args.role,
    ...(args.label ? { label: args.label } : {}),
    attempt,
    startupTimeoutMs: args.startupTimeoutMs,
    meaningfulProgress: false,
  });

  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    let abandoned = false;
    let disarmed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fireStartupTimeout: () => void = () => {};
    const startupTimedOut = new Promise<void>((resolve) => {
      fireStartupTimeout = resolve;
    });

    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const startTimer = () => {
      clearTimer();
      if (disarmed || abandoned) {
        return;
      }
      timer = setTimeout(() => fireStartupTimeout(), args.startupTimeoutMs);
    };

    // Always wrap, even without a baseSink, so liveness tracking still works;
    // abandoned attempts drop events silently (defense in depth for SDK turns
    // that ignore or lag the abort).
    const wrappedSink: ProviderEventSink = (event) => {
      if (abandoned) {
        return;
      }
      if (TIMER_RESET_EVENT_TYPES.has(event.type)) {
        startTimer();
      } else if (MEANINGFUL_PROGRESS_EVENT_TYPES.has(event.type)) {
        disarmed = true;
        clearTimer();
      }
      return args.baseSink?.(event);
    };

    const guard: AgentTurnAttemptGuard = (callback) => {
      if (!callback) {
        return undefined;
      }
      return (...callbackArgs) => {
        if (abandoned) {
          return;
        }
        return callback(...callbackArgs);
      };
    };

    startTimer();
    let runPromise: Promise<T>;
    try {
      runPromise = args.run(wrappedSink, { attempt, signal: controller.signal, guard });
    } catch (error) {
      // A synchronous throw never reaches the race below; clear the timer so
      // it cannot keep the process alive, and propagate the error unchanged
      // (synchronous throws are never retried, same as rejections).
      clearTimer();
      throw error;
    }

    const raceResult: AttemptRaceResult<T> = await Promise.race([
      runPromise.then(
        (value): AttemptRaceResult<T> => ({ kind: 'resolved', value }),
        (error): AttemptRaceResult<T> => ({ kind: 'rejected', error }),
      ),
      startupTimedOut.then((): AttemptRaceResult<T> => ({ kind: 'startup_timeout' })),
    ]);

    if (raceResult.kind === 'resolved') {
      clearTimer();
      return raceResult.value;
    }
    if (raceResult.kind === 'rejected') {
      clearTimer();
      throw raceResult.error;
    }

    // Startup timer fired. Ordering invariant: abandon the attempt before
    // aborting so any events or guarded callbacks the SDK still delivers are
    // dropped, then abort, and only then retry or throw.
    abandoned = true;
    clearTimer();
    controller.abort();
    void runPromise.catch(() => {});

    await args.logger?.event('provider.turn_liveness_timeout', livenessEventData(attempt));
    writeErrorDetail(
      `[${providerShortName(args.provider)}:${labelOrRole}:error] no observable progress for ${seconds}s after turn start (attempt ${attempt})\n`,
      args.logger,
      detailContext,
    );

    if (attempt <= retryLimit) {
      await args.logger?.event('provider.turn_liveness_retry', {
        ...livenessEventData(attempt),
        nextAttempt: attempt + 1,
      });
      writeDetail(`retrying turn after startup silence (attempt ${attempt + 1})\n`, args.logger, detailContext);
      continue;
    }

    await args.logger?.event('provider.turn_liveness_give_up', livenessEventData(attempt));
    throw new NealProviderError({
      message: `provider ${args.provider} ${labelOrRole} turn timed out after ${seconds}s with no observable progress after turn start (attempts: ${attempt})`,
      provider: args.provider,
      role: args.role,
      kind: 'no_progress_timeout',
      retryable: false,
    });
  }
}
