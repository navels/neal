import test from 'node:test';
import assert from 'node:assert/strict';

import { runWithAgentTurnLiveness, type AgentTurnAttempt } from '../src/neal/providers/liveness.js';
import type { RunLogger } from '../src/neal/logger.js';
import {
  NealProviderError,
  type ProviderEventSink,
  type ProviderRuntimeEvent,
} from '../src/neal/providers/types.js';

class FakeLogger {
  readonly stderrMessages: string[] = [];
  readonly events: Array<{ type: string; data?: Record<string, unknown> }> = [];

  async stderr(message: string) {
    this.stderrMessages.push(message);
  }

  async event(type: string, data?: Record<string, unknown>) {
    this.events.push({ type, data });
  }

  asRunLogger() {
    return this as unknown as RunLogger;
  }

  livenessEventTypes() {
    return this.events
      .map((event) => event.type)
      .filter((type) => type.startsWith('provider.turn_liveness_'));
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function turnStarted(): ProviderRuntimeEvent {
  return { type: 'turn_started', provider: 'fake-provider', role: 'coder' };
}

function sessionStarted(handle: string): ProviderRuntimeEvent {
  return { type: 'session_started', provider: 'fake-provider', role: 'coder', sessionHandle: handle };
}

function commandCompleted(): ProviderRuntimeEvent {
  return { type: 'command_completed', provider: 'fake-provider', role: 'coder', command: 'true' };
}

function assistantText(text: string): ProviderRuntimeEvent {
  return { type: 'assistant_text', provider: 'fake-provider', role: 'coder', text };
}

test('startup silence is aborted at the startup timeout and retried; retry succeeds', async () => {
  const logger = new FakeLogger();
  const forwarded: ProviderRuntimeEvent[] = [];
  const trace: string[] = [];

  const result = await runWithAgentTurnLiveness<string>({
    provider: 'fake-provider',
    role: 'coder',
    label: 'scope',
    startupTimeoutMs: 30,
    retryLimit: 1,
    logger: logger.asRunLogger(),
    baseSink: (event) => {
      forwarded.push(event);
    },
    run: async (events, attempt) => {
      trace.push(`run:${attempt.attempt}`);
      if (attempt.attempt === 1) {
        attempt.signal.addEventListener('abort', () => trace.push('abort:1'), { once: true });
        await events?.(turnStarted());
        return neverSettles();
      }
      await events?.(turnStarted());
      await events?.(assistantText('hello'));
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  // Attempt 1's signal was aborted before attempt 2's run was invoked.
  assert.deepEqual(trace, ['run:1', 'abort:1', 'run:2']);
  assert.deepEqual(logger.livenessEventTypes(), [
    'provider.turn_liveness_timeout',
    'provider.turn_liveness_retry',
  ]);
  const timeoutEvent = logger.events.find((event) => event.type === 'provider.turn_liveness_timeout');
  assert.deepEqual(timeoutEvent?.data, {
    provider: 'fake-provider',
    role: 'coder',
    label: 'scope',
    attempt: 1,
    startupTimeoutMs: 30,
    meaningfulProgress: false,
  });
  const retryEvent = logger.events.find((event) => event.type === 'provider.turn_liveness_retry');
  assert.equal(retryEvent?.data?.nextAttempt, 2);
  // Attempt 2's events were forwarded normally.
  assert.deepEqual(
    forwarded.map((event) => event.type),
    ['turn_started', 'turn_started', 'assistant_text'],
  );
  assert.ok(logger.stderrMessages.some((line) => /no observable progress for 0s after turn start \(attempt 1\)/.test(line)));
  assert.ok(logger.stderrMessages.some((line) => /retrying turn after startup silence \(attempt 2\)/.test(line)));
});

test('exhausted retries throw a no_progress_timeout provider error', async () => {
  const logger = new FakeLogger();
  let runCalls = 0;

  await assert.rejects(
    runWithAgentTurnLiveness<string>({
      provider: 'fake-provider',
      role: 'structured-advisor',
      label: 'review',
      startupTimeoutMs: 20,
      retryLimit: 1,
      logger: logger.asRunLogger(),
      run: async (events) => {
        runCalls += 1;
        await events?.(turnStarted());
        return neverSettles();
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NealProviderError);
      assert.equal(error.kind, 'no_progress_timeout');
      assert.equal(error.provider, 'fake-provider');
      assert.equal(error.role, 'structured-advisor');
      assert.equal(error.retryable, false);
      assert.match(error.message, /\btimed out after\b/i);
      assert.match(error.message, /no observable progress after turn start \(attempts: 2\)/);
      return true;
    },
  );

  assert.equal(runCalls, 2);
  assert.deepEqual(logger.livenessEventTypes(), [
    'provider.turn_liveness_timeout',
    'provider.turn_liveness_retry',
    'provider.turn_liveness_timeout',
    'provider.turn_liveness_give_up',
  ]);
});

test('meaningful progress disarms the startup timer permanently', async () => {
  const logger = new FakeLogger();
  let runCalls = 0;
  let observedAbort: boolean | undefined;

  const result = await runWithAgentTurnLiveness<string>({
    provider: 'fake-provider',
    role: 'coder',
    startupTimeoutMs: 25,
    retryLimit: 1,
    logger: logger.asRunLogger(),
    run: async (events, attempt) => {
      runCalls += 1;
      await events?.(turnStarted());
      await events?.(commandCompleted());
      // Stay silent past the startup timeout; the adapter inactivity timeout
      // governs from here, so the supervisor must not abort.
      await delay(80);
      observedAbort = attempt.signal.aborted;
      return 'done';
    },
  });

  assert.equal(result, 'done');
  assert.equal(runCalls, 1);
  assert.equal(observedAbort, false);
  assert.deepEqual(logger.livenessEventTypes(), []);
});

test('session_started / turn_started reset the startup timer but never disarm it', async () => {
  const logger = new FakeLogger();
  const start = Date.now();
  let abortedAt = 0;

  await assert.rejects(
    runWithAgentTurnLiveness<string>({
      provider: 'fake-provider',
      role: 'coder',
      startupTimeoutMs: 40,
      retryLimit: 0,
      logger: logger.asRunLogger(),
      run: async (events, attempt) => {
        attempt.signal.addEventListener('abort', () => {
          abortedAt = Date.now();
        }, { once: true });
        await events?.(turnStarted());
        await delay(25);
        // Transport-alive chatter resets the timer without disarming it.
        await events?.(sessionStarted('h1'));
        await events?.(turnStarted());
        return neverSettles();
      },
    }),
    (error: unknown) => error instanceof NealProviderError && error.kind === 'no_progress_timeout',
  );

  // The reset extended the attempt's life past a single startup window
  // (~25ms of activity + a fresh 40ms window), proving the timer was reset...
  assert.ok(abortedAt - start >= 55, `expected timer reset to extend life past 55ms, aborted after ${abortedAt - start}ms`);
  // ...but it still fired eventually, proving the resets never disarmed it.
  assert.deepEqual(logger.livenessEventTypes(), [
    'provider.turn_liveness_timeout',
    'provider.turn_liveness_give_up',
  ]);
});

test('retryLimit 0 throws on the first timer fire without retrying', async () => {
  const logger = new FakeLogger();
  let runCalls = 0;

  await assert.rejects(
    runWithAgentTurnLiveness<string>({
      provider: 'fake-provider',
      role: 'coder',
      startupTimeoutMs: 15,
      retryLimit: 0,
      logger: logger.asRunLogger(),
      run: async (events) => {
        runCalls += 1;
        await events?.(turnStarted());
        return neverSettles();
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NealProviderError);
      assert.equal(error.kind, 'no_progress_timeout');
      assert.match(error.message, /attempts: 1/);
      return true;
    },
  );

  assert.equal(runCalls, 1);
  assert.deepEqual(logger.livenessEventTypes(), [
    'provider.turn_liveness_timeout',
    'provider.turn_liveness_give_up',
  ]);
});

test('errors thrown by run propagate unchanged and are never retried by the supervisor', async (t) => {
  await t.test('ordinary Error', async () => {
    const logger = new FakeLogger();
    const boom = new Error('boom');
    let runCalls = 0;
    let capturedSignal: AbortSignal | undefined;

    await assert.rejects(
      runWithAgentTurnLiveness<string>({
        provider: 'fake-provider',
        role: 'coder',
        startupTimeoutMs: 1000,
        retryLimit: 1,
        logger: logger.asRunLogger(),
        run: async (events, attempt) => {
          runCalls += 1;
          capturedSignal = attempt.signal;
          await events?.(turnStarted());
          throw boom;
        },
      }),
      (error: unknown) => error === boom,
    );

    assert.equal(runCalls, 1);
    assert.equal(capturedSignal?.aborted, false);
    assert.deepEqual(logger.livenessEventTypes(), []);
  });

  await t.test('synchronous throw clears the startup timer and propagates unchanged', async () => {
    const logger = new FakeLogger();
    const boom = new Error('sync boom');
    let runCalls = 0;
    let capturedSignal: AbortSignal | undefined;

    // Instrument timer creation/cleanup so the test can prove the supervisor
    // does not leave a live startup timer behind on a synchronous throw.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const liveTimers = new Set<unknown>();
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
      const handle = realSetTimeout(handler, timeout);
      liveTimers.add(handle);
      return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      liveTimers.delete(handle);
      return realClearTimeout(handle);
    }) as unknown as typeof clearTimeout;

    try {
      await assert.rejects(
        runWithAgentTurnLiveness<string>({
          provider: 'fake-provider',
          role: 'coder',
          startupTimeoutMs: 5000,
          retryLimit: 1,
          logger: logger.asRunLogger(),
          run: (events, attempt) => {
            runCalls += 1;
            capturedSignal = attempt.signal;
            throw boom;
          },
        }),
        (error: unknown) => error === boom,
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    assert.equal(runCalls, 1);
    assert.equal(capturedSignal?.aborted, false);
    assert.deepEqual(logger.livenessEventTypes(), []);
    assert.equal(liveTimers.size, 0, 'startup timer must be cleared on a synchronous throw');
  });

  await t.test('NealProviderError with kind api_error', async () => {
    const logger = new FakeLogger();
    const apiError = new NealProviderError({
      message: 'API failure',
      provider: 'fake-provider',
      role: 'coder',
      kind: 'api_error',
    });
    let runCalls = 0;
    let capturedSignal: AbortSignal | undefined;

    await assert.rejects(
      runWithAgentTurnLiveness<string>({
        provider: 'fake-provider',
        role: 'coder',
        startupTimeoutMs: 1000,
        retryLimit: 1,
        logger: logger.asRunLogger(),
        run: async (events, attempt) => {
          runCalls += 1;
          capturedSignal = attempt.signal;
          await events?.(turnStarted());
          throw apiError;
        },
      }),
      (error: unknown) => {
        assert.equal(error, apiError);
        assert.ok(error instanceof NealProviderError);
        assert.equal(error.kind, 'api_error');
        return true;
      },
    );

    assert.equal(runCalls, 1);
    assert.equal(capturedSignal?.aborted, false);
    assert.deepEqual(logger.livenessEventTypes(), []);
  });
});

test('events arriving after abandonment are not forwarded to baseSink', async () => {
  const logger = new FakeLogger();
  const forwarded: ProviderRuntimeEvent[] = [];
  let attempt1Sink: ProviderEventSink | undefined;

  const result = await runWithAgentTurnLiveness<string>({
    provider: 'fake-provider',
    role: 'coder',
    startupTimeoutMs: 20,
    retryLimit: 1,
    logger: logger.asRunLogger(),
    baseSink: (event) => {
      forwarded.push(event);
    },
    run: async (events, attempt) => {
      if (attempt.attempt === 1) {
        attempt1Sink = events;
        await events?.(turnStarted());
        return neverSettles();
      }
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  const forwardedBefore = forwarded.length;
  // The abandoned attempt wakes up late and emits stale events.
  await attempt1Sink?.(sessionStarted('stale'));
  await attempt1Sink?.(commandCompleted());
  await attempt1Sink?.(assistantText('stale text'));
  assert.equal(forwarded.length, forwardedBefore);
});

test('guarded onSessionStarted from an abandoned attempt never delivers a stale handle', async () => {
  const logger = new FakeLogger();
  const handles: string[] = [];
  const record = (handle: string) => {
    handles.push(handle);
  };
  let attempt1Guarded: ((handle: string) => void | Promise<void>) | undefined;

  const result = await runWithAgentTurnLiveness<string>({
    provider: 'fake-provider',
    role: 'coder',
    startupTimeoutMs: 20,
    retryLimit: 1,
    logger: logger.asRunLogger(),
    run: async (events, attempt: AgentTurnAttempt) => {
      if (attempt.attempt === 1) {
        assert.equal(attempt.guard(undefined), undefined);
        attempt1Guarded = attempt.guard(record);
        await events?.(turnStarted());
        return neverSettles();
      }
      const guarded = attempt.guard(record);
      await guarded?.('h2');
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.deepEqual(handles, ['h2']);

  const livenessEventsBefore = logger.livenessEventTypes();
  // The abandoned attempt produces a session handle late, after the retry has
  // already succeeded; its guarded callback must be a permanent no-op.
  await attempt1Guarded?.('h1');
  assert.deepEqual(handles, ['h2']);
  assert.deepEqual(logger.livenessEventTypes(), livenessEventsBefore);
});

test('assistant_thinking resets the startup timer but never disarms it', async () => {
  const logger = new FakeLogger();
  const start = Date.now();
  let abortedAt = 0;

  await assert.rejects(
    runWithAgentTurnLiveness<string>({
      provider: 'fake-provider',
      role: 'coder',
      startupTimeoutMs: 40,
      retryLimit: 0,
      logger: logger.asRunLogger(),
      run: async (events, attempt) => {
        attempt.signal.addEventListener('abort', () => {
          abortedAt = Date.now();
        }, { once: true });
        await events?.(turnStarted());
        await delay(25);
        // Extended thinking proves the stream is alive and resets the timer,
        // but it must not disarm the watchdog: a stream that dies mid-think
        // should still be caught at startup-window granularity.
        await events?.({ type: 'assistant_thinking', provider: 'fake-provider', role: 'coder' });
        return neverSettles();
      },
    }),
    (error: unknown) => error instanceof NealProviderError && error.kind === 'no_progress_timeout',
  );

  // ~25ms of activity plus a fresh 40ms window proves the reset happened...
  assert.ok(abortedAt - start >= 55, `expected thinking reset to extend life past 55ms, aborted after ${abortedAt - start}ms`);
  // ...and the timeout still fired, proving thinking never disarmed the timer.
  assert.deepEqual(logger.livenessEventTypes(), [
    'provider.turn_liveness_timeout',
    'provider.turn_liveness_give_up',
  ]);
});
