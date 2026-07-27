import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoderRoundError, runCoderScopeRound } from '../src/neal/agents.js';
import { clearConfigCache } from '../src/neal/config.js';
import type { RunLogger } from '../src/neal/logger.js';
import { isCoderFreshSessionRetryableError, isCoderTimeoutError } from '../src/neal/orchestrator/failures.js';
import {
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import {
  NealProviderError,
  type CoderStructuredPromptArgs,
  type ProviderEventSink,
  type ProviderId,
  type ProviderRuntimeEvent,
} from '../src/neal/providers/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';

const STARTUP_TIMEOUT_MS = 40;

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

  eventTypes() {
    return this.events.map((event) => event.type);
  }
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function turnStarted(provider: ProviderId): ProviderRuntimeEvent {
  return { type: 'turn_started', provider, role: 'coder' };
}

function sessionStarted(provider: ProviderId, handle: string): ProviderRuntimeEvent {
  return { type: 'session_started', provider, role: 'coder', sessionHandle: handle };
}

function toolStarted(provider: ProviderId): ProviderRuntimeEvent {
  return { type: 'tool_started', provider, role: 'coder', toolName: 'stale-tool' };
}

function fileChanged(provider: ProviderId): ProviderRuntimeEvent {
  return { type: 'file_changed', provider, role: 'coder', files: ['stale.txt'] };
}

async function createLivenessFixture(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'neal:',
      `  agent_turn_startup_timeout_ms: ${STARTUP_TIMEOUT_MS}`,
      '  agent_turn_retry_limit: 1',
      '',
    ].join('\n'),
    'utf8',
  );
  clearConfigCache(cwd);
  const planDoc = join(cwd, 'PLAN.md');
  const progressMarkdownPath = join(cwd, 'PLAN_PROGRESS.md');
  await writeFile(planDoc, '## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await writeFile(progressMarkdownPath, '## Current Scope\n- Number: 1\n', 'utf8');
  return { cwd, planDoc, progressMarkdownPath };
}

const scopeDonePayload = {
  action: 'scope_done',
  message: 'Implemented the bounded execution slice.',
  progress: {
    milestoneTargeted: 'Turn liveness wiring',
    newEvidence: 'The retried fake provider returned a CoderScopePayload.',
    whyNotRedundant: 'This covers the startup-silence retry branch.',
    nextStepUnlocked: 'The scope can advance to review.',
  },
  manualGate: null,
  derivedPlan: '',
  blockedReason: '',
};

test('fresh structured coder turn with startup silence is aborted, retried, and succeeds without leaking stale events or session handles', async () => {
  const providerId = 'fake-liveness-coder';
  const fixture = await createLivenessFixture('neal-liveness-wiring-retry-');
  const logger = new FakeLogger();
  const trace: string[] = [];
  const handles: string[] = [];
  let attempt1Sink: ProviderEventSink | undefined;
  let attempt1OnSessionStarted: ((sessionHandle: string) => void | Promise<void>) | undefined;
  let runs = 0;

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      coderStructuredResponses: [scopeDonePayload],
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        runs += 1;
        const attempt = runs;
        trace.push(`run:${attempt}`);
        if (attempt === 1) {
          args.signal?.addEventListener('abort', () => trace.push('abort:1'), { once: true });
          attempt1Sink = args.events;
          attempt1OnSessionStarted = args.onSessionStarted;
          await args.events?.(turnStarted(providerId));
          await neverSettles();
          return;
        }
        await args.events?.(turnStarted(providerId));
        await args.onSessionStarted?.('h2');
      },
    }),
  );

  try {
    const result = await runCoderScopeRound({
      coder: { provider: providerId, model: null },
      cwd: fixture.cwd,
      planDoc: fixture.planDoc,
      progressMarkdownPath: fixture.progressMarkdownPath,
      coderSessionProtocol: 'structured_json_v1',
      onSessionStarted: (sessionHandle) => {
        handles.push(sessionHandle);
      },
      logger: logger.asRunLogger(),
    });

    assert.equal(result.marker, 'AUTONOMY_SCOPE_DONE');
    assert.equal(runs, 2);
    // Attempt 1's abort signal fired before attempt 2's adapter call began.
    assert.deepEqual(trace, ['run:1', 'abort:1', 'run:2']);
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_timeout'));
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_retry'));
    assert.deepEqual(handles, ['h2']);

    // The abandoned attempt wakes up late, after the retry succeeded, and
    // emits stale events plus a stale session handle; none may surface.
    const eventCountBefore = logger.events.length;
    await attempt1Sink?.(sessionStarted(providerId, 'h1'));
    await attempt1Sink?.(toolStarted(providerId));
    await attempt1Sink?.(fileChanged(providerId));
    await attempt1OnSessionStarted?.('h1');
    assert.equal(logger.events.length, eventCountBefore, 'late stale events must not reach the run log');
    assert.deepEqual(handles, ['h2'], 'a stale session handle must never reach the caller');
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('hung resumed-session structured coder turn surfaces as a fresh-session-retryable no_progress_timeout without supervisor retry', async () => {
  const providerId = 'fake-liveness-resumed';
  const fixture = await createLivenessFixture('neal-liveness-wiring-resumed-');
  const logger = new FakeLogger();
  let runs = 0;

  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: providerId,
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        runs += 1;
        await args.events?.(turnStarted(providerId));
        await neverSettles();
      },
    }),
  );

  try {
    await assert.rejects(
      runCoderScopeRound({
        coder: { provider: providerId, model: null },
        cwd: fixture.cwd,
        planDoc: fixture.planDoc,
        progressMarkdownPath: fixture.progressMarkdownPath,
        sessionHandle: 'resumed-session-1',
        coderSessionProtocol: 'structured_json_v1',
        logger: logger.asRunLogger(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof CoderRoundError);
        assert.equal(error.kind, 'no_progress_timeout');
        assert.match(error.message, /\btimed out after\b/i);
        assert.equal(isCoderTimeoutError(error), true);
        assert.equal(isCoderFreshSessionRetryableError(error), true);
        return true;
      },
    );

    // Resumed sessions force retryLimit 0: the supervisor must not retry.
    assert.equal(runs, 1);
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_timeout'));
    assert.ok(logger.eventTypes().includes('provider.turn_liveness_give_up'));
    assert.ok(!logger.eventTypes().includes('provider.turn_liveness_retry'));
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('isCoderTimeoutError classifies by error kind in addition to message text', () => {
  const coderError = (kind: NealProviderError['kind'], message: string) =>
    new CoderRoundError(
      new NealProviderError({
        message,
        provider: 'fake-provider',
        role: 'coder',
        kind,
      }),
    );

  assert.equal(isCoderTimeoutError(coderError('timeout', 'inactivity limit reached')), true);
  assert.equal(isCoderTimeoutError(coderError('no_progress_timeout', 'no observable progress after turn start')), true);
  assert.equal(isCoderTimeoutError(coderError('unknown', 'Codex timed out after 600s without progress')), true);
  assert.equal(isCoderTimeoutError(coderError('api_error', 'API failure')), false);
  assert.equal(isCoderFreshSessionRetryableError(coderError('no_progress_timeout', 'silent turn')), true);
});
