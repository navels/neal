/**
 * Deterministic coder-adapter battery for the openai-compatible provider,
 * driving the AI SDK outer loop with MockLanguageModelV3 from ai/test. No
 * network, no keys: settings, model construction, and sleep are injected
 * through openAICompatibleProviderTestHooks.
 *
 * Coverage: scripted tool-call runs with the ordered
 * provider event sequence and per-tool telemetry providerData; structured
 * envelope repair (prompt-only repair turns on the same message history) and
 * repair exhaustion; the transient-retry battery (thrown 429,
 * missing-content turns, the exact api_retry tool_progress shape,
 * apiRetryLimit: 0 rethrow); step-cap exhaustion; null session semantics
 * (onSessionStarted never invoked, sessionHandle null, resumeHandle ->
 * session_unavailable); and the cancellation/inactivity battery (abort
 * signal observed inside the SDK call, caller abort vs inactivity expiry
 * disambiguation, retry/no-retry behavior under apiRetryLimit).
 *
 * Coverage (structured-advisor battery at the bottom of this file; Phase 1
 * Scope 4 origin, reworked for the Phase 2 read-only tool loop and the
 * SDK-native structured-output finalization turn): valid rounds with the
 * ordered advisor event sequence (read-tool loop, then exactly one no-tools
 * finalization turn, then structured_output_received) and the read-only
 * toolset on the SDK call; read-tool turns ending in a valid payload with
 * `steps` telemetry; tool-error self-correction within the loop; advisor
 * step-cap exhaustion; transient retry mid-loop; the protocol requirement
 * and string-schema guards; missing-content retry within apiRetryLimit with
 * the api_retry shape; finalization failures as non-retryable
 * structured_output_missing/structured_output_invalid with the rejected
 * excerpt in the provider_error diagnostic (no repair turns, no
 * structured_json_* events); round-level model precedence; settings error
 * kinds; and the primary-turn cancellation/inactivity battery (abort signal
 * wired into the SDK call, inactivity expiry as retryable timeout,
 * retry/no-retry behavior under apiRetryLimit, caller abort non-retryable
 * and never retried).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MockLanguageModelV3 } from 'ai/test';

import type { OpenAICompatibleSettings } from '../src/neal/config.js';
import { buildPlanReviewerSchema, validatePlanReviewerPayload } from '../src/neal/agents.js';
import type { PlanReviewerPayload } from '../src/neal/agents/schemas.js';
import {
  OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS,
  OPENAI_COMPATIBLE_MAX_STEPS,
  openAICompatibleProviderTestHooks,
} from '../src/neal/providers/openai-compatible.js';
import { computeRateCostUsd, resolveRateCost } from '../src/neal/providers/pricing.js';
import { NealProviderError } from '../src/neal/providers/types.js';
import type {
  ProviderRuntimeEvent,
  StructuredJsonProtocolSpec,
} from '../src/neal/providers/types.js';

type TestPayload = { done: boolean };

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'openai-compatible-provider-test-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'README.md'), 'fixture file\n', 'utf8');
  return dir;
}

function testProtocol(repairAttemptLimit = 1): StructuredJsonProtocolSpec<TestPayload> {
  return {
    protocol: 'neal-json-block-v1',
    schemaLabel: 'test_payload',
    schema: { type: 'object', required: ['done'] },
    validator: (payload) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        (payload as { done?: unknown }).done !== true
      ) {
        throw new Error('payload.done must be true');
      }
      return payload as TestPayload;
    },
    repairAttemptLimit,
  };
}

const MALFORMED_RESPONSE = 'I believe the work is done but I forgot the control block.';
// Finalization turns (both roles) parse the text channel through the SDK's
// Output.object, so the scripted response is plain JSON text (no fences).
const VALID_JSON_PAYLOAD = '{ "done": true }';

const REPORTED_USAGE = {
  inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

// LanguageModelV3 finish reasons are { unified, raw } objects. The unified
// value must be 'stop' for the SDK to resolve structured output (it parses
// the final text only on cleanly-stopped turns), so the scripted responses
// use the real shape rather than a bare string.
const STOP_FINISH_REASON = { unified: 'stop', raw: 'stop' };
const TOOL_CALLS_FINISH_REASON = { unified: 'tool-calls', raw: 'tool_calls' };

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    finishReason: STOP_FINISH_REASON,
    usage: REPORTED_USAGE,
    warnings: [],
  };
}

function jsonPayloadResponse() {
  return textResponse(VALID_JSON_PAYLOAD);
}

function reasoningOnlyResponse(text: string) {
  return {
    content: [{ type: 'reasoning', text }],
    finishReason: STOP_FINISH_REASON,
    usage: REPORTED_USAGE,
    warnings: [],
  };
}

function emptyResponse() {
  return { content: [], finishReason: STOP_FINISH_REASON, usage: REPORTED_USAGE, warnings: [] };
}

function listDirToolCallResponse(callId: string) {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: callId,
        toolName: 'list_dir',
        input: JSON.stringify({ path: '.' }),
      },
    ],
    finishReason: TOOL_CALLS_FINISH_REASON,
    usage: REPORTED_USAGE,
    warnings: [],
  };
}

function textAndListDirToolCallResponse(callId: string, text: string) {
  return {
    content: [
      { type: 'text', text },
      {
        type: 'tool-call',
        toolCallId: callId,
        toolName: 'list_dir',
        input: JSON.stringify({ path: '.' }),
      },
    ],
    finishReason: TOOL_CALLS_FINISH_REASON,
    usage: REPORTED_USAGE,
    warnings: [],
  };
}

function transient429(): never {
  // A plain object shaped like APICallError: classification must work off
  // the shape (statusCode / isRetryable), not instanceof.
  throw { name: 'AI_APICallError', message: 'rate limited', statusCode: 429, isRetryable: true };
}

function successfulResponseProcessingFailure(): never {
  throw {
    name: 'AI_APICallError',
    message: 'Failed to process successful response',
    statusCode: 200,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    responseBody: '{"choices":[{"message":{"tool_calls":[{"function":{"arguments":{}}}]}}]}',
    cause: {
      name: 'AI_APICallError',
      message: 'Invalid JSON response',
      cause: {
        name: 'AI_TypeValidationError',
        message: 'Invalid tool call arguments: expected string, received object',
      },
    },
  };
}

type Producer = (options: { abortSignal?: AbortSignal }) => unknown;

/**
 * Builds a mock whose Nth call runs the Nth scripted producer; the last
 * producer repeats for any further calls. A producer may throw to simulate a
 * transport error. Call options are recorded on the model
 * (`doGenerateCalls`) for prompt/tool assertions.
 */
function scriptedModel(producers: Producer[]): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async (options: { abortSignal?: AbortSignal }) => {
      const producer = producers[Math.min(calls, producers.length - 1)];
      calls += 1;
      return producer(options);
    }) as any,
  });
}

/** A producer that never resolves on its own; it rejects only when the SDK call's abort signal fires. */
function hangUntilAborted(onAbort?: (signal: AbortSignal) => void): Producer {
  return ({ abortSignal }) => {
    assert.ok(abortSignal, 'the adapter must pass an abortSignal into the SDK call');
    return new Promise((_resolve, reject) => {
      const settle = () => {
        onAbort?.(abortSignal);
        reject(abortSignal.reason);
      };
      if (abortSignal.aborted) {
        settle();
        return;
      }
      abortSignal.addEventListener('abort', settle, { once: true });
    });
  };
}

function fakeSettings(overrides: Partial<OpenAICompatibleSettings> = {}): OpenAICompatibleSettings {
  return {
    baseUrl: 'https://example.test/v1',
    apiKeyEnv: 'TEST_OPENAI_COMPATIBLE_KEY',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    headers: {},
    pricing: null,
    ...overrides,
  };
}

function createAdapter(args: {
  model: MockLanguageModelV3;
  settings?: OpenAICompatibleSettings;
  sleeps?: number[];
  options?: { model?: string | null; effort?: string | null };
}) {
  return openAICompatibleProviderTestHooks.createCoderAdapterWithInjection(
    {
      resolveSettings: () => args.settings ?? fakeSettings(),
      createModel: () => args.model,
      sleep: async (ms) => {
        args.sleeps?.push(ms);
      },
    },
    args.options,
  );
}

function collectEvents() {
  const events: ProviderRuntimeEvent[] = [];
  return {
    events,
    sink: (event: ProviderRuntimeEvent) => {
      events.push(event);
    },
  };
}

function structuredArgs(cwd: string, sink: (event: ProviderRuntimeEvent) => void) {
  return {
    cwd,
    prompt: 'Do the scoped task.',
    label: 'scope',
    schema: { type: 'object' },
    structuredJsonProtocol: testProtocol(),
    inactivityTimeoutMs: 5_000,
    events: sink,
  };
}

function apiRetryEvents(events: ProviderRuntimeEvent[]) {
  return events.filter(
    (event) => event.type === 'tool_progress' && event.toolName === 'api_retry',
  );
}

function expectProviderError(expected: {
  kind: NealProviderError['kind'];
  retryable: boolean;
  messagePattern?: RegExp;
}) {
  return (error: unknown) => {
    assert.ok(error instanceof NealProviderError, `expected NealProviderError, got ${String(error)}`);
    assert.equal(error.provider, 'openai-compatible');
    assert.equal(error.kind, expected.kind);
    assert.equal(error.retryable, expected.retryable);
    if (expected.messagePattern) {
      assert.match(error.message, expected.messagePattern);
    }
    // The synthetic session handle is events-only: thrown errors must never
    // carry it, because the orchestrator persists `error.sessionHandle` into
    // `state.coderSessionHandle` on coder-phase and final-completion failures
    // and a persisted handle makes resume demand session_resume support,
    // which this provider declares false.
    assert.equal(error.sessionHandle, null, 'thrown NealProviderError must not carry a session handle');
    return true;
  };
}

test('scripted tool-call run returns the structured payload with the ordered event sequence and per-tool telemetry', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => listDirToolCallResponse('call-1'),
    () => textResponse('Work is verified complete.'),
    jsonPayloadResponse,
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();
  const sessionStartedCalls: string[] = [];

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 0,
    onSessionStarted: (handle) => {
      sessionStartedCalls.push(handle);
    },
  });

  assert.deepEqual(result.structured, { done: true });
  // Session semantics: handle never persisted, callback never invoked.
  assert.equal(result.sessionHandle, null);
  assert.deepEqual(sessionStartedCalls, []);

  // Tool loop to the zero-tool-call completion turn, then exactly one
  // finalization turn; structured_output_received is emitted by the adapter
  // and no structured_json_* protocol events ever fire on this provider.
  const sequence = events.map((event) =>
    event.type === 'tool_progress' || event.type === 'tool_started'
      ? `${event.type}:${event.toolName ?? ''}`
      : event.type,
  );
  assert.deepEqual(sequence, [
    'session_started',
    'turn_started',
    'tool_started:list_dir',
    'tool_progress:list_dir',
    'usage_reported',
    'turn_completed',
    'turn_started',
    'assistant_text',
    'usage_reported',
    'turn_completed',
    'turn_started',
    'assistant_text',
    'usage_reported',
    'turn_completed',
    'structured_output_received',
  ]);

  const sessionStarted = events[0];
  assert.equal(sessionStarted.type, 'session_started');
  assert.match(String(sessionStarted.sessionHandle), /^openai-compatible:/);
  // Every event carries the same synthetic events-only handle and label.
  for (const event of events) {
    assert.equal(event.provider, 'openai-compatible');
    assert.equal(event.role, 'coder');
    assert.equal(event.label, 'scope');
    assert.equal(event.sessionHandle, sessionStarted.sessionHandle);
  }

  const received = events.find((event) => event.type === 'structured_output_received');
  assert.ok(received);
  assert.deepEqual(received.providerData, { schemaLabel: 'test_payload' });

  // The base prompt is fence-free: no neal-json instructions, no schema dump.
  assert.equal(model.doGenerateCalls.length, 3);
  const initialPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.ok(!initialPrompt.includes('neal-json'), 'the base prompt must not carry fence instructions');
  // The finalization turn carries no tools and the SDK structured-output
  // responseFormat constraint, and its request message names the schema.
  const finalizationCall = model.doGenerateCalls[2];
  assert.equal((finalizationCall.tools ?? []).length, 0);
  assert.deepEqual(finalizationCall.responseFormat, {
    type: 'json',
    schema: { type: 'object', required: ['done'] },
  });
  const finalizationPrompt = JSON.stringify(finalizationCall.prompt);
  assert.ok(finalizationPrompt.includes('test_payload control payload'));
  assert.ok(!finalizationPrompt.includes('neal-json'));

  // Per-tool telemetry providerData on usage_reported/turn_completed,
  // cumulative across turns (the finalization turn included).
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  const usageReports = events.filter((event) => event.type === 'usage_reported');
  assert.equal(turnCompletions.length, 3);
  assert.equal(usageReports.length, 3);
  assert.deepEqual(turnCompletions[0].providerData, {
    toolCalls: { list_dir: 1 },
    toolErrors: {},
  });
  assert.deepEqual(turnCompletions[2].providerData, {
    toolCalls: { list_dir: 1 },
    toolErrors: {},
  });
  assert.deepEqual(usageReports[0].providerData, turnCompletions[0].providerData);

  const assistantText = events.find((event) => event.type === 'assistant_text');
  assert.ok(assistantText && assistantText.type === 'assistant_text');
  assert.equal(assistantText.text, 'Work is verified complete.');

  assert.equal(apiRetryEvents(events).length, 0);
});

test('configured pricing attaches rate-computed cost to every usage_reported and turn_completed', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('All set.'), jsonPayloadResponse]);
  const pricing = { inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 };
  const adapter = createAdapter({ model, settings: fakeSettings({ pricing }) });
  const { events, sink } = collectEvents();

  await adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 });

  const usageReports = events.filter((event) => event.type === 'usage_reported');
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  assert.ok(usageReports.length > 0);
  assert.equal(usageReports.length, turnCompletions.length);
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const expected = computeRateCostUsd(report.usage, pricing);
    assert.ok(expected > 0);
    assert.equal(report.costUsd, expected);
    assert.equal(report.costSource, 'rate');
  }
  for (const completion of turnCompletions) {
    assert.ok(completion.type === 'turn_completed');
    assert.equal(completion.costUsd, computeRateCostUsd(completion.usage, pricing));
    assert.equal(completion.costSource, 'rate');
  }
});

test('without configured pricing neither cost field is attached to emitted events', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('All set.'), jsonPayloadResponse]);
  // The default resolved model (test-model) is not on the card, so with no
  // config pricing this stays tokens-only.
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 });

  for (const event of events) {
    if (event.type === 'usage_reported' || event.type === 'turn_completed') {
      assert.equal(event.costUsd, undefined);
      assert.equal(event.costSource, undefined);
    }
  }
});

test('coder: a card-listed model with no configured pricing attaches card-derived cost', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('All set.'), jsonPayloadResponse]);
  // Resolved model is an exact card slug; no config pricing configured.
  const adapter = createAdapter({ model, settings: fakeSettings({ defaultModel: 'gpt-5.5' }) });
  const { events, sink } = collectEvents();

  await adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 });

  const usageReports = events.filter((event) => event.type === 'usage_reported');
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  assert.ok(usageReports.length > 0);
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const expected = resolveRateCost({ usage: report.usage, model: 'gpt-5.5', configPricing: null });
    assert.ok(expected && expected.costUsd > 0);
    assert.equal(report.costUsd, expected.costUsd);
    assert.equal(report.costSource, 'rate');
  }
  for (const completion of turnCompletions) {
    assert.ok(completion.type === 'turn_completed');
    const expected = resolveRateCost({ usage: completion.usage, model: 'gpt-5.5', configPricing: null });
    assert.equal(completion.costUsd, expected?.costUsd);
    assert.equal(completion.costSource, 'rate');
  }
});

test('coder: configured pricing overrides the card for a card-listed model', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('All set.'), jsonPayloadResponse]);
  const pricing = { inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 };
  const adapter = createAdapter({ model, settings: fakeSettings({ defaultModel: 'gpt-5.5', pricing }) });
  const { events, sink } = collectEvents();

  await adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 });

  const usageReports = events.filter((event) => event.type === 'usage_reported');
  assert.ok(usageReports.length > 0);
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const configCost = computeRateCostUsd(report.usage, pricing);
    const cardCost = resolveRateCost({ usage: report.usage, model: 'gpt-5.5', configPricing: null })?.costUsd;
    // Config and card must differ so a passing assertion proves the override.
    assert.ok(cardCost !== undefined && configCost !== cardCost);
    assert.equal(report.costUsd, configCost);
    assert.equal(report.costSource, 'rate');
  }
});

test('responseShapeHint rides on the base prompt and the finalization message carries schema and example', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('All set.'), jsonPayloadResponse]);
  const adapter = createAdapter({ model });

  const protocol: StructuredJsonProtocolSpec<TestPayload> = {
    ...testProtocol(),
    responseShapeHint: 'Set done to true only when the work is verified.',
    examplePayload: { done: true },
  };
  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, () => {}),
    structuredJsonProtocol: protocol,
    apiRetryLimit: 0,
  });
  assert.deepEqual(result.structured, { done: true });

  // The hint is plain guidance appended to the fence-free base prompt.
  const initialPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.ok(initialPrompt.includes('Response shape guidance'));
  assert.ok(initialPrompt.includes('Set done to true only when the work is verified.'));
  assert.ok(!initialPrompt.includes('neal-json'));
  // The finalization message carries the pretty-printed schema and example
  // payload (some gateways silently ignore response_format).
  const finalizationPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
  assert.ok(finalizationPrompt.includes('must satisfy this JSON schema'));
  assert.ok(finalizationPrompt.includes('Example payload'));
});

test('tool error results attribute per-tool in toolErrors providerData', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_file',
          input: JSON.stringify({ path: 'does-not-exist.txt' }),
        },
      ],
      finishReason: TOOL_CALLS_FINISH_REASON,
      usage: REPORTED_USAGE,
      warnings: [],
    }),
    jsonPayloadResponse,
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 });

  const errorProgress = events.find(
    (event) => event.type === 'tool_progress' && event.toolName === 'read_file',
  );
  assert.ok(errorProgress && errorProgress.type === 'tool_progress');
  assert.equal(errorProgress.isError, true);
  assert.match(String(errorProgress.message), /^Error: /);

  const lastTurnCompleted = events.filter((event) => event.type === 'turn_completed').at(-1);
  assert.ok(lastTurnCompleted);
  assert.deepEqual(lastTurnCompleted.providerData, {
    toolCalls: { read_file: 1 },
    toolErrors: { read_file: 1 },
  });
});

test('a non-JSON finalization response throws structured_output_missing with the rejected excerpt and no repair turn', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse(MALFORMED_RESPONSE),
    () => textResponse('<xml>not a payload</xml>'),
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({
      kind: 'structured_output_missing',
      retryable: false,
      messagePattern: /test_payload/,
    }),
  );

  // No repair: exactly the loop turn plus one finalization turn, and no
  // structured_json_* protocol events.
  assert.equal(model.doGenerateCalls.length, 2);
  const finalizationCall = model.doGenerateCalls[1];
  assert.equal((finalizationCall.tools ?? []).length, 0);
  assert.ok(finalizationCall.responseFormat, 'the finalization turn must carry responseFormat');
  assert.ok(
    !events.some(
      (event) => event.type === 'tool_progress' && String(event.toolName).startsWith('structured_json'),
    ),
    'no structured_json_* events on this provider',
  );

  // Deliverable 4: the rejected assistant text rides as a truncated excerpt
  // in the provider_error diagnostic.
  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'structured_output_missing');
  const diagnostic = (providerError.providerData as { diagnostic: { text?: string; textTruncated?: boolean } })
    .diagnostic;
  assert.equal(diagnostic.text, '<xml>not a payload</xml>');
  assert.equal(diagnostic.textTruncated, false);
});

test('a tool-calling turn that narrates completion continues the loop until a zero-tool-call turn', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textAndListDirToolCallResponse(
      'call-1',
      'Perfect. The fix has been successfully committed. Final summary follows.',
    ),
    () => textResponse('Done.'),
    jsonPayloadResponse,
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 0,
  });

  // Channel rule: completion is structural (zero tool calls), never a text
  // heuristic. The narrating tool-call turn is followed by another full tool
  // turn, then the zero-tool-call turn ends the loop and the finalization
  // turn (no tools, responseFormat) produces the payload.
  assert.deepEqual(result.structured, { done: true });
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal((model.doGenerateCalls[0].tools ?? []).length > 0, true);
  assert.equal((model.doGenerateCalls[1].tools ?? []).length > 0, true);
  assert.equal((model.doGenerateCalls[2].tools ?? []).length, 0);
  assert.ok(model.doGenerateCalls[2].responseFormat, 'the finalization turn must carry responseFormat');
  assert.ok(events.some((event) => event.type === 'structured_output_received'));
});

test('a model that narrates completion while always calling tools hits the unchanged step cap', async () => {
  const cwd = await createWorkDir();
  let calls = 0;
  const model = scriptedModel([
    () => {
      calls += 1;
      return textAndListDirToolCallResponse(
        `call-${calls}`,
        'Perfect. The fix has been successfully committed. Final summary follows.',
      );
    },
  ]);
  const adapter = createAdapter({ model });
  const { sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: new RegExp(
        `OPENAI_COMPATIBLE_MAX_STEPS cap of ${OPENAI_COMPATIBLE_MAX_STEPS} model turns without a ` +
          'completion turn \\(a turn with zero tool calls\\)',
      ),
    }),
  );
  assert.equal(model.doGenerateCalls.length, OPENAI_COMPATIBLE_MAX_STEPS);
});

test('a validator-rejected finalization payload throws structured_output_invalid with the JSON excerpt', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse('The work is done.'),
    () => textResponse('{ "done": false }'),
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({
      kind: 'structured_output_invalid',
      retryable: false,
      messagePattern: /test_payload.*payload\.done must be true/,
    }),
  );

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'structured_output_invalid');
  // The generated JSON (the validator's reject) rides in the diagnostic.
  const diagnostic = (providerError.providerData as { diagnostic: { text?: string } }).diagnostic;
  assert.match(String(diagnostic.text), /"done": false/);
  // No repair turn followed the rejection.
  assert.equal(model.doGenerateCalls.length, 2);
});

test('the default model construction enables SDK structured outputs (real factory, not the mock seam)', () => {
  // Exercises the real createOpenAICompatible path (the createModel injection
  // seam returns a MockLanguageModelV3 that bypasses it). The SDK reads
  // `config.supportsStructuredOutputs ?? false` and only sends
  // `response_format.type: 'json_schema'` when it is true, so this public
  // property is the falsifiable proof that the request carries neal's schema
  // and the schema-drop warning is gone. Omitting the flag (the bug) leaves
  // this false.
  const model = openAICompatibleProviderTestHooks.createDefaultOpenAICompatibleModel({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    headers: {},
    model: 'test-model',
  });
  assert.equal(
    (model as { supportsStructuredOutputs?: unknown }).supportsStructuredOutputs,
    true,
  );
});

test('an HTTP 400 rejection on the structured finalization turn is attributable structured_output_invalid', async () => {
  const cwd = await createWorkDir();
  // The model rejects the schema-enforced `json_schema` request with HTTP 400
  // (a gateway/model that cannot honor structured outputs). Shaped like
  // APICallError; classification works off the status code, not instanceof.
  const model = scriptedModel([
    () => textResponse('Implementation complete.'),
    () => {
      throw {
        name: 'AI_APICallError',
        message: 'response_format json_schema is not supported',
        statusCode: 400,
      };
    },
  ]);
  const adapter = createAdapter({ model, sleeps: [] });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({
      kind: 'structured_output_invalid',
      retryable: false,
      messagePattern: /HTTP 400.*test_payload/,
    }),
  );

  // Non-retryable: the loop turn plus exactly one finalization turn, no
  // api_retry consumption despite a budget of 2.
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(apiRetryEvents(events).length, 0);

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'structured_output_invalid');
});

test('an HTTP 400 thrown on a non-structured tool turn keeps its provider_failed mapping', async () => {
  const cwd = await createWorkDir();
  // The first (tool-loop) turn carries no structuredOutput, so the narrowed
  // 400 branch must not fire: a 400 here stays provider_failed via
  // normalizeOpenAICompatibleError.
  const model = scriptedModel([
    () => {
      throw {
        name: 'AI_APICallError',
        message: 'bad request on the tool turn',
        statusCode: 400,
      };
    },
  ]);
  const adapter = createAdapter({ model, sleeps: [] });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: /HTTP 400/,
    }),
  );

  // The 400 is on the very first turn; no finalization turn is reached and the
  // non-retryable provider_failed is thrown immediately.
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(apiRetryEvents(events).length, 0);

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'provider_failed');
});

test('a transient throw during the finalization turn consumes the api_retry loop and then succeeds', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse('Implementation complete.'),
    transient429,
    jsonPayloadResponse,
  ]);
  const sleeps: number[] = [];
  const adapter = createAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 1,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  assert.ok(retries[0].type === 'tool_progress');
  assert.match(String((retries[0].providerData as { message: string }).message), /HTTP 429/);
  assert.deepEqual(sleeps, [500]);
  assert.equal(model.doGenerateCalls.length, 3);
});

test('an empty finalization response retries under the missing-content rule', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse('Implementation complete.'),
    emptyResponse,
    jsonPayloadResponse,
  ]);
  const adapter = createAdapter({ model, sleeps: [] });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 1,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  assert.ok(retries[0].type === 'tool_progress');
  assert.match(
    String((retries[0].providerData as { message: string }).message),
    /neither tool calls nor non-empty assistant text/,
  );
});

test('transient 429 retries within apiRetryLimit with the exact api_retry tool_progress shape', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([transient429, jsonPayloadResponse]);
  const sleeps: number[] = [];
  const adapter = createAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 2,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  const retry = retries[0];
  assert.ok(retry.type === 'tool_progress');
  assert.equal(retry.toolName, 'api_retry');
  assert.equal(retry.message, 'transient API failure; retrying (1/2)');
  assert.equal(retry.isError, true);
  const providerData = retry.providerData as { retryCount: number; retryLimit: number; message: string };
  assert.equal(providerData.retryCount, 1);
  assert.equal(providerData.retryLimit, 2);
  assert.match(providerData.message, /HTTP 429/);
  // 500 ms base, doubling, 5 s cap.
  assert.deepEqual(sleeps, [500]);

  // The retried attempt re-emits turn_started so startup silence stays
  // observable to the liveness watchdog (loop turn retried once, then the
  // successful loop turn's finalization turn).
  assert.equal(events.filter((event) => event.type === 'turn_started').length, 3);
});

test('a missing-content turn (empty text after the reasoning fallback) is classified transient', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([emptyResponse, jsonPayloadResponse]);
  const adapter = createAdapter({ model, sleeps: [] });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 1,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  assert.ok(retries[0].type === 'tool_progress');
  assert.match(
    String((retries[0].providerData as { message: string }).message),
    /neither tool calls nor non-empty assistant text/,
  );
});

test('provider errors include compact SDK cause diagnostics in providerData', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([successfulResponseProcessingFailure]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    () =>
      adapter.runStructuredPrompt<TestPayload>({
        ...structuredArgs(cwd, sink),
        apiRetryLimit: 0,
      }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: /Failed to process successful response/,
    }),
  );

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError);
  assert.equal(providerError.errorKind, 'provider_failed');
  const providerData = providerError.providerData as {
    retryable: boolean;
    diagnostic: {
      message: string;
      name: string;
      statusCode: number;
      url: string;
      responseBody: string;
      responseBodyTruncated: boolean;
      cause: { message: string; name: string; cause: { message: string; name: string } };
    };
  };
  assert.equal(providerData.retryable, false);
  assert.equal(providerData.diagnostic.message, 'HTTP 200: Failed to process successful response');
  assert.equal(providerData.diagnostic.name, 'AI_APICallError');
  assert.equal(providerData.diagnostic.statusCode, 200);
  assert.equal(providerData.diagnostic.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.match(providerData.diagnostic.responseBody, /tool_calls/);
  assert.equal(providerData.diagnostic.responseBodyTruncated, false);
  assert.equal(providerData.diagnostic.cause.message, 'Invalid JSON response');
  assert.equal(providerData.diagnostic.cause.name, 'AI_APICallError');
  assert.match(providerData.diagnostic.cause.cause.message, /expected string, received object/);
  assert.equal(providerData.diagnostic.cause.cause.name, 'AI_TypeValidationError');
});

test('reasoning-only responses fall back to reasoningText for the loop completion text', async () => {
  const cwd = await createWorkDir();
  // The loop-ending turn is reasoning-only: the fallback text completes the
  // tool loop, then the finalization turn produces the payload on the text
  // channel (the SDK's Output.object reads text, never reasoning).
  const model = scriptedModel([
    () => reasoningOnlyResponse('I verified the work; it is complete.'),
    jsonPayloadResponse,
  ]);
  const adapter = createAdapter({ model });
  const { sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    apiRetryLimit: 0,
  });
  assert.deepEqual(result.structured, { done: true });
});

test('apiRetryLimit: 0 performs no in-round retry and rethrows the retryable error', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([transient429]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({ kind: 'api_error', retryable: true, messagePattern: /HTTP 429/ }),
  );
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('step-cap exhaustion throws provider_failed naming OPENAI_COMPATIBLE_MAX_STEPS', async () => {
  const cwd = await createWorkDir();
  let calls = 0;
  const model = scriptedModel([
    () => {
      calls += 1;
      return listDirToolCallResponse(`call-${calls}`);
    },
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: new RegExp(`OPENAI_COMPATIBLE_MAX_STEPS cap of ${OPENAI_COMPATIBLE_MAX_STEPS}`),
    }),
  );
  // 48 because the original 24-turn cap bound repeatedly on ordinary
  // example-project scopes (see the constant's doc comment).
  assert.equal(OPENAI_COMPATIBLE_MAX_STEPS, 48);
  assert.equal(
    events.filter((event) => event.type === 'turn_completed').length,
    OPENAI_COMPATIBLE_MAX_STEPS,
  );
});

test('a non-null resumeHandle throws session_unavailable from both coder methods', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const adapter = createAdapter({ model });
  const { sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({
      ...structuredArgs(cwd, sink),
      apiRetryLimit: 0,
      resumeHandle: 'openai-compatible:corrupted:handle',
    }),
    expectProviderError({
      kind: 'session_unavailable',
      retryable: false,
      messagePattern: /never persists session handles/,
    }),
  );

  await assert.rejects(
    adapter.runPrompt({
      cwd,
      prompt: 'continue',
      inactivityTimeoutMs: 5_000,
      resumeHandle: 'openai-compatible:corrupted:handle',
    }),
    expectProviderError({ kind: 'session_unavailable', retryable: false }),
  );
  // The model was never called: the corrupted handle is rejected up front.
  assert.equal(model.doGenerateCalls.length, 0);
});

test('runPrompt runs the same loop and returns the final assistant text with a null handle', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => listDirToolCallResponse('call-1'),
    () => textResponse('All requested changes are in place.'),
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();
  const sessionStartedCalls: string[] = [];

  const result = await adapter.runPrompt({
    cwd,
    prompt: 'Do the follow-up task.',
    inactivityTimeoutMs: 5_000,
    events: sink,
    onSessionStarted: (handle) => {
      sessionStartedCalls.push(handle);
    },
  });

  assert.equal(result.finalResponse, 'All requested changes are in place.');
  assert.equal(result.sessionHandle, null);
  assert.deepEqual(sessionStartedCalls, []);
  // No structured-protocol events on the unstructured path.
  assert.ok(!events.some((event) => event.type === 'structured_output_received'));
  assert.equal(events.filter((event) => event.type === 'turn_completed').length, 2);
});

test('runPrompt has no in-round retry budget: transient failures rethrow as retryable', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([transient429]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runPrompt({ cwd, prompt: 'task', inactivityTimeoutMs: 5_000, events: sink }),
    expectProviderError({ kind: 'api_error', retryable: true }),
  );
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('a caller-signal abort propagates as a non-retryable timeout and never burns retry budget', async () => {
  const cwd = await createWorkDir();
  let sdkCallObservedAbort = false;
  const model = scriptedModel([
    hangUntilAborted((signal) => {
      sdkCallObservedAbort = signal.aborted;
    }),
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();
  const controller = new AbortController();

  const pending = adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    inactivityTimeoutMs: 60_000,
    // Even with retry budget available, caller cancellation is never retried.
    apiRetryLimit: 1,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    pending,
    expectProviderError({
      kind: 'timeout',
      retryable: false,
      messagePattern: /aborted by the caller/,
    }),
  );
  assert.equal(sdkCallObservedAbort, true);
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('inactivity expiry aborts the SDK call and surfaces a retryable timeout at apiRetryLimit: 0', async () => {
  const cwd = await createWorkDir();
  let sdkCallObservedAbort = false;
  const model = scriptedModel([
    hangUntilAborted((signal) => {
      sdkCallObservedAbort = signal.aborted;
    }),
  ]);
  const adapter = createAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({
      ...structuredArgs(cwd, sink),
      inactivityTimeoutMs: 20,
      apiRetryLimit: 0,
    }),
    expectProviderError({
      kind: 'timeout',
      retryable: true,
      messagePattern: /inactivity timeout/,
    }),
  );
  // The mock observed the abort: the adapter really wired
  // AbortSignal.timeout(inactivityTimeoutMs) into the SDK call.
  assert.equal(sdkCallObservedAbort, true);
  assert.equal(apiRetryEvents(events).length, 0);
});

test('inactivity expiry retries exactly once under apiRetryLimit: 1 and the loop completes', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([hangUntilAborted(), jsonPayloadResponse]);
  const sleeps: number[] = [];
  const adapter = createAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, sink),
    inactivityTimeoutMs: 20,
    apiRetryLimit: 1,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  assert.ok(retries[0].type === 'tool_progress');
  assert.equal(retries[0].message, 'transient API failure; retrying (1/1)');
  assert.equal(retries[0].isError, true);
  assert.match(
    String((retries[0].providerData as { message: string }).message),
    /inactivity timeout/,
  );
  assert.deepEqual(sleeps, [500]);
  // Hung loop turn, retried loop turn, finalization turn.
  assert.equal(model.doGenerateCalls.length, 3);
});

test('abort-source disambiguation: caller abort is non-retryable, inactivity expiry is retryable', async () => {
  const cwd = await createWorkDir();

  // Caller-signal abort: the caller owns the cancellation.
  {
    const model = scriptedModel([hangUntilAborted()]);
    const adapter = createAdapter({ model });
    const controller = new AbortController();
    const pending = adapter.runStructuredPrompt<TestPayload>({
      ...structuredArgs(cwd, () => {}),
      inactivityTimeoutMs: 60_000,
      apiRetryLimit: 0,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, expectProviderError({ kind: 'timeout', retryable: false }));
  }

  // Inactivity expiry under an un-aborted caller signal: retryable.
  {
    const model = scriptedModel([hangUntilAborted()]);
    const adapter = createAdapter({ model });
    const controller = new AbortController();
    await assert.rejects(
      adapter.runStructuredPrompt<TestPayload>({
        ...structuredArgs(cwd, () => {}),
        inactivityTimeoutMs: 20,
        apiRetryLimit: 0,
        signal: controller.signal,
      }),
      expectProviderError({ kind: 'timeout', retryable: true }),
    );
    assert.equal(controller.signal.aborted, false);
  }
});

test('settings resolution errors use the documented kinds', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const { sink } = collectEvents();

  const missingBaseUrl = createAdapter({ model, settings: fakeSettings({ baseUrl: null }) });
  await assert.rejects(
    missingBaseUrl.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({ kind: 'provider_failed', retryable: false, messagePattern: /no base URL/ }),
  );

  const missingModel = createAdapter({ model, settings: fakeSettings({ defaultModel: null }) });
  await assert.rejects(
    missingModel.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({ kind: 'provider_failed', retryable: false, messagePattern: /no model/ }),
  );

  const missingApiKey = createAdapter({ model, settings: fakeSettings({ apiKey: null }) });
  await assert.rejects(
    missingApiKey.runStructuredPrompt<TestPayload>({ ...structuredArgs(cwd, sink), apiRetryLimit: 0 }),
    expectProviderError({
      kind: 'permission_denied',
      retryable: false,
      messagePattern: /TEST_OPENAI_COMPATIBLE_KEY/,
    }),
  );
});

test('the adapter model precedence prefers the role model over default_model', async () => {
  const cwd = await createWorkDir();
  const modelNames: string[] = [];
  const mock = scriptedModel([jsonPayloadResponse]);
  const adapter = openAICompatibleProviderTestHooks.createCoderAdapterWithInjection(
    {
      resolveSettings: () => fakeSettings({ defaultModel: 'default-model' }),
      createModel: (args) => {
        modelNames.push(args.model);
        return mock;
      },
      sleep: async () => {},
    },
    { model: 'role-model' },
  );

  await adapter.runStructuredPrompt<TestPayload>({
    ...structuredArgs(cwd, () => {}),
    apiRetryLimit: 0,
  });
  assert.deepEqual(modelNames, ['role-model']);
});

test('a missing or wrong structuredJsonProtocol throws provider_failed', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const adapter = createAdapter({ model });

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({
      cwd,
      prompt: 'task',
      label: 'scope',
      schema: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      structuredJsonProtocol: undefined as any,
      inactivityTimeoutMs: 5_000,
      apiRetryLimit: 0,
    }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: /neal-json-block-v1/,
    }),
  );
  assert.equal(model.doGenerateCalls.length, 0);
});

test('a string-form protocol schema throws provider_failed naming the schema label before any model call', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const adapter = createAdapter({ model });

  await assert.rejects(
    adapter.runStructuredPrompt<TestPayload>({
      ...structuredArgs(cwd, () => {}),
      structuredJsonProtocol: {
        ...testProtocol(),
        schema: '{"type":"object"}',
      },
      apiRetryLimit: 0,
    }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: /object-form JSON schema for "test_payload"/,
    }),
  );
  assert.equal(model.doGenerateCalls.length, 0);
});

// --- Structured-advisor battery ----------------------------------------------
//
// The advisor adapter runs reviewer rounds through the bounded read-only tool
// loop (read_file, list_dir, grep, git_diff; OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS) and the
// final-completion round when the coder is openai-compatible, so its loop,
// retry, and cancellation behavior is what keeps reviews and run completion
// from stalling.

function createAdvisorAdapter(args: {
  model: MockLanguageModelV3;
  settings?: OpenAICompatibleSettings;
  sleeps?: number[];
  options?: { model?: string | null; effort?: string | null };
}) {
  return openAICompatibleProviderTestHooks.createStructuredAdvisorAdapterWithInjection(
    {
      resolveSettings: () => args.settings ?? fakeSettings(),
      createModel: () => args.model,
      sleep: async (ms) => {
        args.sleeps?.push(ms);
      },
    },
    args.options,
  );
}

function advisorArgs(cwd: string, sink: (event: ProviderRuntimeEvent) => void) {
  return {
    label: 'final-completion' as const,
    cwd,
    prompt: 'Summarize the completed run.',
    schema: { type: 'object' },
    structuredJsonProtocol: testProtocol(),
    inactivityTimeoutMs: 5_000,
    apiRetryLimit: 0,
    events: sink,
  };
}

test('advisor: a valid round returns the structured verdict with the ordered event sequence and a null handle', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse('Review complete; the run met its goal.'),
    jsonPayloadResponse,
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, sink),
    // Advisor rounds are stateless: a resume handle is silently ignored
    // (no session_unavailable guard on this path), exactly as the bespoke
    // adapter ignores it.
    resumeHandle: 'openai-compatible:stale:handle',
  });

  assert.deepEqual(result.structured, { done: true });
  assert.equal(result.sessionHandle, null);

  // Read-tool loop to the zero-tool-call completion turn, then exactly one
  // finalization turn; structured_output_received is emitted by the adapter
  // and no structured_json_* protocol events ever fire on this provider.
  const sequence = events.map((event) =>
    event.type === 'tool_progress' ? `${event.type}:${event.toolName ?? ''}` : event.type,
  );
  assert.deepEqual(sequence, [
    'session_started',
    'turn_started',
    'assistant_text',
    'usage_reported',
    'turn_completed',
    'turn_started',
    'assistant_text',
    'usage_reported',
    'turn_completed',
    'structured_output_received',
  ]);

  const sessionStarted = events[0];
  assert.equal(sessionStarted.type, 'session_started');
  assert.match(String(sessionStarted.sessionHandle), /^openai-compatible:/);
  for (const event of events) {
    assert.equal(event.provider, 'openai-compatible');
    assert.equal(event.role, 'structured-advisor');
    assert.equal(event.label, 'final-completion');
    assert.equal(event.sessionHandle, sessionStarted.sessionHandle);
  }

  const assistantText = events.find((event) => event.type === 'assistant_text');
  assert.ok(assistantText && assistantText.type === 'assistant_text');
  assert.equal(assistantText.text, 'Review complete; the run met its goal.');

  const received = events.find((event) => event.type === 'structured_output_received');
  assert.ok(received);
  assert.deepEqual(received.providerData, { schemaLabel: 'test_payload' });

  // The advisor loop turn carries exactly the read-only toolset on the SDK
  // call: no write or shell tools, ever. git_diff is the read-only
  // commit-range inspector (deletion visibility without shell access).
  assert.equal(model.doGenerateCalls.length, 2);
  assert.deepEqual(
    (model.doGenerateCalls[0].tools ?? []).map((tool) => tool.name).sort(),
    ['git_diff', 'grep', 'list_dir', 'read_file'],
  );
  const initialPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.ok(!initialPrompt.includes('neal-json'), 'the base prompt must not carry fence instructions');
  // The finalization turn carries no tools and the SDK structured-output
  // responseFormat constraint, and its request message names the schema.
  const finalizationCall = model.doGenerateCalls[1];
  assert.equal((finalizationCall.tools ?? []).length, 0);
  assert.deepEqual(finalizationCall.responseFormat, {
    type: 'json',
    schema: { type: 'object', required: ['done'] },
  });
  const finalizationPrompt = JSON.stringify(finalizationCall.prompt);
  assert.ok(finalizationPrompt.includes('test_payload control payload'));
  assert.ok(!finalizationPrompt.includes('neal-json'));

  // Advisor telemetry carries the cumulative per-tool maps plus the steps
  // count (tool-turns-per-review qualification signal); the finalization
  // turn increments steps like any successful turn.
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  const usageReports = events.filter((event) => event.type === 'usage_reported');
  assert.equal(turnCompletions.length, 2);
  assert.equal(usageReports.length, 2);
  assert.deepEqual(turnCompletions[0].providerData, { toolCalls: {}, toolErrors: {}, steps: 1 });
  assert.deepEqual(turnCompletions[1].providerData, { toolCalls: {}, toolErrors: {}, steps: 2 });
  assert.deepEqual(usageReports[0].providerData, turnCompletions[0].providerData);
});

function planReviewerAdvisorProtocol(): StructuredJsonProtocolSpec<PlanReviewerPayload> {
  return {
    protocol: 'neal-json-block-v1',
    schemaLabel: 'plan_reviewer_payload',
    schema: buildPlanReviewerSchema() as unknown as Record<string, unknown>,
    validator: validatePlanReviewerPayload,
    repairAttemptLimit: 1,
  };
}

function planReviewerAdvisorRoundArgs(cwd: string, sink: (event: ProviderRuntimeEvent) => void) {
  return {
    ...advisorArgs(cwd, sink),
    label: 'plan-review' as const,
    schema: buildPlanReviewerSchema() as unknown as Record<string, unknown>,
    structuredJsonProtocol: planReviewerAdvisorProtocol(),
  };
}

test('advisor: a plan-review finding that omits findingClass normalizes to plan_correctness through native finalization', async () => {
  // R3-F1 provider-path guard: buildPlanReviewerSchema keeps findingClass optional,
  // and openai-compatible submits it to the SDK-native json_schema finalization. A
  // nonempty finding that OMITS findingClass must survive the native finalization
  // (the optional property is accepted) and reach the validator's fail-safe default.
  const cwd = await createWorkDir();
  const payloadJson = JSON.stringify({
    summary: 'The plan is executable.',
    executionShape: 'one_shot',
    findings: [
      {
        severity: 'blocking',
        files: ['PLAN.md'],
        claim: 'Scope two lacks verification.',
        requiredAction: 'Add a verification command to scope two.',
        // findingClass intentionally omitted.
      },
    ],
  });
  const model = scriptedModel([() => textResponse('Plan review complete.'), () => textResponse(payloadJson)]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredRound<PlanReviewerPayload>(planReviewerAdvisorRoundArgs(cwd, sink));

  assert.equal(result.structured.findings.length, 1);
  assert.equal(result.structured.findings[0].findingClass, 'plan_correctness');
  assert.ok(events.some((event) => event.type === 'structured_output_received'));
});

test('advisor: a plan-review finding with a present-but-invalid findingClass is rejected on the native finalization path', async () => {
  // Companion to the omission test: an invalid class value must not slip through
  // as a silent default. The openai-compatible finalization rejects the round (via
  // either the SDK json_schema enum check or the validator).
  const cwd = await createWorkDir();
  const payloadJson = JSON.stringify({
    summary: 'The plan is executable.',
    executionShape: 'one_shot',
    findings: [
      {
        severity: 'blocking',
        files: ['PLAN.md'],
        claim: 'Scope two lacks verification.',
        requiredAction: 'Add a verification command to scope two.',
        findingClass: 'nice_to_have',
      },
    ],
  });
  const model = scriptedModel([() => textResponse('Plan review complete.'), () => textResponse(payloadJson)]);
  const adapter = createAdvisorAdapter({ model });
  const { sink } = collectEvents();

  await assert.rejects(() =>
    adapter.runStructuredRound<PlanReviewerPayload>(planReviewerAdvisorRoundArgs(cwd, sink)),
  );
});

function openAiChatCompletion(content: string) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

test('advisor: the real openai-compatible finalization request disables strict json_schema so an omitted findingClass reaches the validator', async () => {
  // R4-F1 real-transport guard: MockLanguageModelV3 bypasses the openai-compatible
  // serialization, so it cannot prove the actual request accepts an omitted optional
  // property. This drives buildPlanReviewerSchema through the real
  // @ai-sdk/openai-compatible model with a captured fetch, and asserts the
  // serialized finalization request carries json_schema strict: false so the
  // omitted findingClass survives to validatePlanReviewerPayload's default.
  const cwd = await createWorkDir();
  const payloadJson = JSON.stringify({
    summary: 'The plan is executable.',
    executionShape: 'one_shot',
    findings: [
      {
        severity: 'blocking',
        files: ['PLAN.md'],
        claim: 'Scope two lacks verification.',
        requiredAction: 'Add a verification command to scope two.',
        // findingClass intentionally omitted.
      },
    ],
  });

  const requestBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const captureFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    calls += 1;
    // Turn 1 is the read-tool loop (ends with no tool calls); turn 2 is the
    // no-tools structured finalization that carries response_format.
    const content = calls === 1 ? 'Reviewed the plan; no blocking issues.' : payloadJson;
    return new Response(JSON.stringify(openAiChatCompletion(content)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const model = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: 'https://example.test/v1',
    apiKey: 'test-key',
    headers: {},
    supportsStructuredOutputs: true,
    fetch: captureFetch,
  }).chatModel('test-model');

  const adapter = openAICompatibleProviderTestHooks.createStructuredAdvisorAdapterWithInjection({
    resolveSettings: () => fakeSettings(),
    createModel: () => model,
    sleep: async () => {},
  });
  const { sink } = collectEvents();

  const result = await adapter.runStructuredRound<PlanReviewerPayload>(planReviewerAdvisorRoundArgs(cwd, sink));

  // The serialized finalization request (the 2nd call) carries the json_schema
  // constraint with strict disabled — the actual transport adaptation.
  assert.equal(requestBodies.length, 2);
  const finalizationBody = requestBodies[1] as {
    response_format?: { type?: string; json_schema?: { strict?: boolean } };
  };
  assert.equal(finalizationBody.response_format?.type, 'json_schema');
  assert.equal(finalizationBody.response_format?.json_schema?.strict, false);

  // The omitted findingClass survived the real transport and reached the validator's default.
  assert.equal(result.structured.findings.length, 1);
  assert.equal(result.structured.findings[0].findingClass, 'plan_correctness');
});

test('advisor: responseShapeHint rides on the base prompt and the finalization message carries schema and example', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('Reviewed.'), jsonPayloadResponse]);
  const adapter = createAdvisorAdapter({ model });

  const protocol: StructuredJsonProtocolSpec<TestPayload> = {
    ...testProtocol(),
    responseShapeHint: 'Set done to true only when the run is verified.',
    examplePayload: { done: true },
  };
  const result = await adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, () => {}),
    structuredJsonProtocol: protocol,
  });
  assert.deepEqual(result.structured, { done: true });

  // The hint is plain guidance appended to the fence-free base prompt.
  const initialPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  assert.ok(initialPrompt.includes('Response shape guidance'));
  assert.ok(initialPrompt.includes('Set done to true only when the run is verified.'));
  assert.ok(!initialPrompt.includes('neal-json'));
  // The finalization message carries the pretty-printed schema and example
  // payload (some gateways silently ignore response_format).
  const finalizationPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
  assert.ok(finalizationPrompt.includes('must satisfy this JSON schema'));
  assert.ok(finalizationPrompt.includes('Example payload'));
});

test('advisor: a read-tool sequence ends in a valid payload with per-tool and steps telemetry', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_file',
          input: JSON.stringify({ path: 'README.md' }),
        },
      ],
      finishReason: 'tool-calls',
      usage: REPORTED_USAGE,
      warnings: [],
    }),
    () => textResponse('README reviewed; verdict follows.'),
    jsonPayloadResponse,
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink));
  assert.deepEqual(result.structured, { done: true });
  assert.equal(result.sessionHandle, null);

  const sequence = events.map((event) =>
    event.type === 'tool_progress' || event.type === 'tool_started'
      ? `${event.type}:${event.toolName ?? ''}`
      : event.type,
  );
  assert.deepEqual(sequence, [
    'session_started',
    'turn_started',
    'tool_started:read_file',
    'tool_progress:read_file',
    'usage_reported',
    'turn_completed',
    'turn_started',
    'assistant_text',
    'usage_reported',
    'turn_completed',
    'turn_started',
    'assistant_text',
    'usage_reported',
    'turn_completed',
    'structured_output_received',
  ]);

  // Tool events forward with the advisor role and the round label.
  for (const event of events) {
    assert.equal(event.role, 'structured-advisor');
    assert.equal(event.label, 'final-completion');
  }
  const readProgress = events.find(
    (event) => event.type === 'tool_progress' && event.toolName === 'read_file',
  );
  assert.ok(readProgress && readProgress.type === 'tool_progress');
  assert.equal(readProgress.isError, false);

  // Cumulative telemetry: steps counts successful model turns, the
  // finalization turn included.
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  assert.equal(turnCompletions.length, 3);
  assert.deepEqual(turnCompletions[0].providerData, {
    toolCalls: { read_file: 1 },
    toolErrors: {},
    steps: 1,
  });
  assert.deepEqual(turnCompletions[2].providerData, {
    toolCalls: { read_file: 1 },
    toolErrors: {},
    steps: 3,
  });
});

test('advisor: a tool error result is self-corrected within the loop and attributed in toolErrors', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_file',
          input: JSON.stringify({ path: 'does-not-exist.txt' }),
        },
      ],
      finishReason: 'tool-calls',
      usage: REPORTED_USAGE,
      warnings: [],
    }),
    () => textResponse('The file is missing; judging from the rest of the tree.'),
    jsonPayloadResponse,
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  // The tool error is returned as a tool result, the model self-corrects on
  // the next turn, and the round still succeeds.
  const result = await adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink));
  assert.deepEqual(result.structured, { done: true });

  const errorProgress = events.find(
    (event) => event.type === 'tool_progress' && event.toolName === 'read_file',
  );
  assert.ok(errorProgress && errorProgress.type === 'tool_progress');
  assert.equal(errorProgress.isError, true);
  assert.match(String(errorProgress.message), /^Error: /);

  const lastTurnCompleted = events.filter((event) => event.type === 'turn_completed').at(-1);
  assert.ok(lastTurnCompleted);
  assert.deepEqual(lastTurnCompleted.providerData, {
    toolCalls: { read_file: 1 },
    toolErrors: { read_file: 1 },
    steps: 3,
  });
});

test('advisor: step-cap exhaustion throws provider_failed naming OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS', async () => {
  const cwd = await createWorkDir();
  let calls = 0;
  const model = scriptedModel([
    () => {
      calls += 1;
      return listDirToolCallResponse(`call-${calls}`);
    },
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: new RegExp(
        `OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS cap of ${OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS}`,
      ),
    }),
  );
  // Half the coder cap: reviews are bounded inspections, not
  // implementations. Raise only on live `steps` telemetry evidence (see the
  // constant's doc comment).
  assert.equal(OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS, 24);
  assert.equal(
    events.filter((event) => event.type === 'turn_completed').length,
    OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS,
  );

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'provider_failed');
});

test('advisor: a transient failure mid-loop retries within apiRetryLimit and the round completes', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => listDirToolCallResponse('call-1'),
    transient429,
    () => textResponse('Inspection done.'),
    jsonPayloadResponse,
  ]);
  const sleeps: number[] = [];
  const adapter = createAdvisorAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, sink),
    apiRetryLimit: 1,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  assert.ok(retries[0].type === 'tool_progress');
  assert.equal(retries[0].message, 'transient API failure; retrying (1/1)');
  assert.match(String((retries[0].providerData as { message: string }).message), /HTTP 429/);
  assert.deepEqual(sleeps, [500]);
  assert.equal(model.doGenerateCalls.length, 4);
  // The retry does not consume a loop step: only successful turns count
  // (two loop turns plus the finalization turn).
  const lastTurnCompleted = events.filter((event) => event.type === 'turn_completed').at(-1);
  assert.ok(lastTurnCompleted);
  assert.deepEqual(lastTurnCompleted.providerData, {
    toolCalls: { list_dir: 1 },
    toolErrors: {},
    steps: 3,
  });
});

test('advisor: a missing structuredJsonProtocol throws provider_failed before any model call', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>({
      ...advisorArgs(cwd, sink),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      structuredJsonProtocol: undefined as any,
    }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: /neal-json-block-v1/,
    }),
  );
  assert.equal(model.doGenerateCalls.length, 0);

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'provider_failed');
});

test('advisor: a string-form protocol schema throws provider_failed naming the schema label before any model call', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const adapter = createAdvisorAdapter({ model });

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>({
      ...advisorArgs(cwd, () => {}),
      structuredJsonProtocol: {
        ...testProtocol(),
        schema: '{"type":"object"}',
      },
    }),
    expectProviderError({
      kind: 'provider_failed',
      retryable: false,
      messagePattern: /object-form JSON schema for "test_payload"/,
    }),
  );
  assert.equal(model.doGenerateCalls.length, 0);
});

test('advisor: a missing-content response is retried within apiRetryLimit with the exact api_retry shape', async () => {
  const cwd = await createWorkDir();
  // An empty response is how embedded HTTP-200 gateway errors and
  // reasoning-only responses surface on the AI SDK path.
  const model = scriptedModel([
    emptyResponse,
    () => textResponse('Reviewed after the retry.'),
    jsonPayloadResponse,
  ]);
  const sleeps: number[] = [];
  const adapter = createAdvisorAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, sink),
    apiRetryLimit: 2,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  const retry = retries[0];
  assert.ok(retry.type === 'tool_progress');
  assert.equal(retry.toolName, 'api_retry');
  assert.equal(retry.message, 'transient API failure; retrying (1/2)');
  assert.equal(retry.isError, true);
  const providerData = retry.providerData as { retryCount: number; retryLimit: number; message: string };
  assert.equal(providerData.retryCount, 1);
  assert.equal(providerData.retryLimit, 2);
  assert.match(providerData.message, /neither tool calls nor non-empty assistant text/);
  assert.deepEqual(sleeps, [500]);

  // The retried attempt re-emits turn_started (failed loop turn, retried
  // loop turn, then the finalization turn).
  assert.equal(events.filter((event) => event.type === 'turn_started').length, 3);
});

test('advisor: transient 429 errors rethrow as retryable api_error at apiRetryLimit: 0 with no in-round retry', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([transient429]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({ kind: 'api_error', retryable: true, messagePattern: /HTTP 429/ }),
  );
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});

// The OpenAI content-safety refusal text from issue #27.
const OPENAI_COMPATIBLE_CONTENT_SAFETY_REFUSAL =
  'This content was flagged for possible cybersecurity risk. If this seems wrong, ' +
  'try rephrasing your request. To get authorized for security work, join the ' +
  'Trusted Access for Cyber program.';

function refusalTransportError(overrides: Record<string, unknown> = {}): never {
  // A plain object shaped like APICallError: classification works off the
  // provider-authored message (and optional statusCode), not instanceof.
  throw { name: 'AI_APICallError', message: OPENAI_COMPATIBLE_CONTENT_SAFETY_REFUSAL, ...overrides };
}

test('advisor: a status-bearing refusal transport error classifies as non-retryable content_refused without burning retry budget', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => refusalTransportError({ statusCode: 403 })]);
  const sleeps: number[] = [];
  const adapter = createAdvisorAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  await assert.rejects(
    // A nonzero retry budget must not be consumed: content_refused is terminal.
    adapter.runStructuredRound<TestPayload>({ ...advisorArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({ kind: 'content_refused', retryable: false }),
  );
  assert.equal(apiRetryEvents(events).length, 0);
  assert.deepEqual(sleeps, []);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('advisor: a statusless refusal transport error classifies as non-retryable content_refused', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => refusalTransportError()]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>({ ...advisorArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({ kind: 'content_refused', retryable: false }),
  );
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('advisor: a benign 403 transport error still classifies as permission_denied', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    (): never => {
      throw { name: 'AI_APICallError', message: 'forbidden', statusCode: 403 };
    },
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>({ ...advisorArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({ kind: 'permission_denied', retryable: false, messagePattern: /HTTP 403/ }),
  );
  assert.equal(model.doGenerateCalls.length, 1);
});

// Builds a real @ai-sdk/openai-compatible structured-advisor adapter over a
// scripted fetch so the actual AI SDK error boundary is exercised (the real
// APICallError carries data.error.message), recording backoff sleeps.
function createRealTransportAdvisorAdapter(args: { fetch: typeof fetch; sleeps?: number[] }) {
  const model = createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: 'https://example.test/v1',
    apiKey: 'test-key',
    headers: {},
    supportsStructuredOutputs: true,
    fetch: args.fetch,
  }).chatModel('test-model');
  return openAICompatibleProviderTestHooks.createStructuredAdvisorAdapterWithInjection({
    resolveSettings: () => fakeSettings(),
    createModel: () => model,
    sleep: async (ms) => {
      args.sleeps?.push(ms);
    },
  });
}

test('advisor real transport: a first-turn non-2xx refusal classifies as non-retryable content_refused on a single request', async () => {
  const cwd = await createWorkDir();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: OPENAI_COMPATIBLE_CONTENT_SAFETY_REFUSAL } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const adapter = createRealTransportAdvisorAdapter({ fetch: fetchImpl, sleeps });
  const { events, sink } = collectEvents();

  await assert.rejects(
    // A nonzero retry budget must not be consumed: content_refused is terminal.
    adapter.runStructuredRound<TestPayload>({ ...advisorArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({ kind: 'content_refused', retryable: false }),
  );
  assert.equal(calls, 1);
  assert.equal(apiRetryEvents(events).length, 0);
  assert.deepEqual(sleeps, []);
});

test('advisor real transport: a finalization-turn HTTP 400 refusal after a successful first turn classifies as non-retryable content_refused', async () => {
  const cwd = await createWorkDir();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      // First (read-tool) turn: valid plain-text response with no tool calls,
      // ending the loop so the structured finalization turn runs next.
      return new Response(JSON.stringify(openAiChatCompletion('Reviewed; no blocking issues.')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Finalization turn: the schema-enforced request is rejected with HTTP 400
    // carrying the content-safety refusal. This must classify as content_refused,
    // not structured_output_invalid.
    return new Response(JSON.stringify({ error: { message: OPENAI_COMPATIBLE_CONTENT_SAFETY_REFUSAL } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const adapter = createRealTransportAdvisorAdapter({ fetch: fetchImpl, sleeps });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>({ ...advisorArgs(cwd, sink), apiRetryLimit: 2 }),
    expectProviderError({ kind: 'content_refused', retryable: false }),
  );
  assert.equal(calls, 2);
  assert.equal(apiRetryEvents(events).length, 0);
  assert.deepEqual(sleeps, []);
});

test('advisor: a non-JSON finalization response throws structured_output_missing with the rejected excerpt and no repair turn', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse('Review narrative without a payload.'),
    () => textResponse(MALFORMED_RESPONSE),
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({
      kind: 'structured_output_missing',
      retryable: false,
      messagePattern: /test_payload/,
    }),
  );

  // No repair: exactly the loop turn plus one finalization turn, and no
  // structured_json_* protocol events. The finalization turn is prompt-only
  // (no tools) with the SDK responseFormat constraint, extending the same
  // message history: round prompt, the loop's assistant turn, then the
  // finalization request.
  assert.equal(model.doGenerateCalls.length, 2);
  const initialCall = model.doGenerateCalls[0];
  const finalizationCall = model.doGenerateCalls[1];
  assert.ok((initialCall.tools ?? []).length > 0);
  assert.equal((finalizationCall.tools ?? []).length, 0);
  assert.ok(finalizationCall.responseFormat, 'the finalization turn must carry responseFormat');
  assert.deepEqual(finalizationCall.prompt.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.ok(
    !events.some(
      (event) => event.type === 'tool_progress' && String(event.toolName).startsWith('structured_json'),
    ),
    'no structured_json_* events on this provider',
  );

  // Every event carries the advisor role; the rejected assistant text rides
  // as a truncated excerpt in the provider_error diagnostic.
  for (const event of events) {
    assert.equal(event.role, 'structured-advisor');
    assert.equal(event.label, 'final-completion');
  }
  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'structured_output_missing');
  const diagnostic = (providerError.providerData as { diagnostic: { text?: string; textTruncated?: boolean } })
    .diagnostic;
  assert.equal(diagnostic.text, MALFORMED_RESPONSE);
  assert.equal(diagnostic.textTruncated, false);
});

test('advisor: a validator-rejected finalization payload throws structured_output_invalid with the JSON excerpt', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([
    () => textResponse('Review narrative.'),
    () => textResponse('{ "done": false }'),
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({
      kind: 'structured_output_invalid',
      retryable: false,
      messagePattern: /test_payload.*payload\.done must be true/,
    }),
  );

  const providerError = events.find((event) => event.type === 'provider_error');
  assert.ok(providerError && providerError.type === 'provider_error');
  assert.equal(providerError.errorKind, 'structured_output_invalid');
  // The generated JSON (the validator's reject) rides in the diagnostic.
  const diagnostic = (providerError.providerData as { diagnostic: { text?: string } }).diagnostic;
  assert.match(String(diagnostic.text), /"done": false/);
  // No repair turn followed the rejection.
  assert.equal(model.doGenerateCalls.length, 2);
});

test('advisor: the round-level model override wins over the role model and default_model', async () => {
  const cwd = await createWorkDir();
  const modelNames: string[] = [];
  // A repeating JSON-text producer satisfies both the loop's completion turn
  // and the finalization turn across consecutive rounds.
  const mock = scriptedModel([jsonPayloadResponse]);
  const adapter = openAICompatibleProviderTestHooks.createStructuredAdvisorAdapterWithInjection(
    {
      resolveSettings: () => fakeSettings({ defaultModel: 'default-model' }),
      createModel: (args) => {
        modelNames.push(args.model);
        return mock;
      },
      sleep: async () => {},
    },
    { model: 'role-model' },
  );

  await adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, () => {}),
    model: 'round-model',
  });
  assert.deepEqual(modelNames, ['round-model']);

  // Without a round-level override the role model wins over default_model.
  await adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, () => {}));
  assert.deepEqual(modelNames, ['round-model', 'role-model']);
});

test('advisor: a card-listed model with no configured pricing attaches card-derived cost', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('Reviewed.'), jsonPayloadResponse]);
  // Resolved model is an exact card slug; no config pricing configured. This
  // exercises the advisor state construction's own modelSlug wiring.
  const adapter = createAdvisorAdapter({ model, settings: fakeSettings({ defaultModel: 'gpt-5.5' }) });
  const { events, sink } = collectEvents();

  await adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink));

  const usageReports = events.filter((event) => event.type === 'usage_reported');
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  assert.ok(usageReports.length > 0);
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const expected = resolveRateCost({ usage: report.usage, model: 'gpt-5.5', configPricing: null });
    assert.ok(expected && expected.costUsd > 0);
    assert.equal(report.costUsd, expected.costUsd);
    assert.equal(report.costSource, 'rate');
  }
  for (const completion of turnCompletions) {
    assert.ok(completion.type === 'turn_completed');
    const expected = resolveRateCost({ usage: completion.usage, model: 'gpt-5.5', configPricing: null });
    assert.equal(completion.costUsd, expected?.costUsd);
    assert.equal(completion.costSource, 'rate');
  }
});

test('advisor: configured pricing overrides the card for a card-listed model', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([() => textResponse('Reviewed.'), jsonPayloadResponse]);
  const pricing = { inputPerMillion: 3, cachedInputPerMillion: 0.3, outputPerMillion: 15 };
  const adapter = createAdvisorAdapter({ model, settings: fakeSettings({ defaultModel: 'gpt-5.5', pricing }) });
  const { events, sink } = collectEvents();

  await adapter.runStructuredRound<TestPayload>(advisorArgs(cwd, sink));

  const usageReports = events.filter((event) => event.type === 'usage_reported');
  assert.ok(usageReports.length > 0);
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const configCost = computeRateCostUsd(report.usage, pricing);
    const cardCost = resolveRateCost({ usage: report.usage, model: 'gpt-5.5', configPricing: null })?.costUsd;
    assert.ok(cardCost !== undefined && configCost !== cardCost);
    assert.equal(report.costUsd, configCost);
    assert.equal(report.costSource, 'rate');
  }
});

test('advisor: the resolved round model selects the card rate (round over role over default)', async () => {
  const cwd = await createWorkDir();
  const mock = scriptedModel([() => textResponse('Reviewed.'), jsonPayloadResponse]);
  // default_model, role model, and round model are three distinct card slugs
  // with distinct rates. The emitted cost must be priced by the round model.
  const adapter = openAICompatibleProviderTestHooks.createStructuredAdvisorAdapterWithInjection(
    {
      resolveSettings: () => fakeSettings({ defaultModel: 'gpt-5.5' }),
      createModel: () => mock,
      sleep: async () => {},
    },
    { model: 'claude-opus-4-8' },
  );
  const { events, sink } = collectEvents();

  await adapter.runStructuredRound<TestPayload>({ ...advisorArgs(cwd, sink), model: 'claude-fable-5' });

  const usageReports = events.filter((event) => event.type === 'usage_reported');
  assert.ok(usageReports.length > 0);
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const roundCost = resolveRateCost({ usage: report.usage, model: 'claude-fable-5', configPricing: null })?.costUsd;
    const roleCost = resolveRateCost({ usage: report.usage, model: 'claude-opus-4-8', configPricing: null })?.costUsd;
    const defaultCost = resolveRateCost({ usage: report.usage, model: 'gpt-5.5', configPricing: null })?.costUsd;
    // The three slugs price distinctly, so matching the round rate (and not the
    // role or default rate) proves round-model precedence drives pricing.
    assert.ok(roundCost !== undefined && roundCost !== roleCost && roundCost !== defaultCost);
    assert.equal(report.costUsd, roundCost);
    assert.equal(report.costSource, 'rate');
  }
});

test('advisor: settings resolution errors use the documented kinds', async () => {
  const cwd = await createWorkDir();
  const model = scriptedModel([jsonPayloadResponse]);
  const { sink } = collectEvents();

  const missingApiKey = createAdvisorAdapter({ model, settings: fakeSettings({ apiKey: null }) });
  await assert.rejects(
    missingApiKey.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({
      kind: 'permission_denied',
      retryable: false,
      messagePattern: /TEST_OPENAI_COMPATIBLE_KEY/,
    }),
  );

  const missingBaseUrl = createAdvisorAdapter({ model, settings: fakeSettings({ baseUrl: null }) });
  await assert.rejects(
    missingBaseUrl.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({ kind: 'provider_failed', retryable: false, messagePattern: /no base URL/ }),
  );

  const missingModel = createAdvisorAdapter({ model, settings: fakeSettings({ defaultModel: null }) });
  await assert.rejects(
    missingModel.runStructuredRound<TestPayload>(advisorArgs(cwd, sink)),
    expectProviderError({ kind: 'provider_failed', retryable: false, messagePattern: /no model/ }),
  );
  assert.equal(model.doGenerateCalls.length, 0);
});

test('advisor: inactivity expiry aborts the SDK call and surfaces a retryable timeout at apiRetryLimit: 0', async () => {
  const cwd = await createWorkDir();
  let sdkCallObservedAbort = false;
  const model = scriptedModel([
    hangUntilAborted((signal) => {
      sdkCallObservedAbort = signal.aborted;
    }),
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();
  const controller = new AbortController();

  await assert.rejects(
    adapter.runStructuredRound<TestPayload>({
      ...advisorArgs(cwd, sink),
      inactivityTimeoutMs: 20,
      // An un-aborted caller signal proves the expiry came from
      // AbortSignal.timeout, not the caller.
      signal: controller.signal,
    }),
    expectProviderError({
      kind: 'timeout',
      retryable: true,
      messagePattern: /inactivity timeout/,
    }),
  );
  // The mock observed the abort: the adapter really wired
  // AbortSignal.timeout(inactivityTimeoutMs) into the SDK call.
  assert.equal(sdkCallObservedAbort, true);
  assert.equal(controller.signal.aborted, false);
  // apiRetryLimit: 0 -> the retryable timeout rethrows with no in-round retry.
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('advisor: inactivity expiry retries exactly once under apiRetryLimit: 1 and the round completes', async () => {
  const cwd = await createWorkDir();
  // The retried loop turn completes with JSON text (zero tool calls), and
  // the repeating producer also serves the finalization turn.
  const model = scriptedModel([hangUntilAborted(), jsonPayloadResponse]);
  const sleeps: number[] = [];
  const adapter = createAdvisorAdapter({ model, sleeps });
  const { events, sink } = collectEvents();

  const result = await adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, sink),
    inactivityTimeoutMs: 20,
    apiRetryLimit: 1,
  });
  assert.deepEqual(result.structured, { done: true });

  const retries = apiRetryEvents(events);
  assert.equal(retries.length, 1);
  assert.ok(retries[0].type === 'tool_progress');
  assert.equal(retries[0].message, 'transient API failure; retrying (1/1)');
  assert.equal(retries[0].isError, true);
  assert.match(
    String((retries[0].providerData as { message: string }).message),
    /inactivity timeout/,
  );
  assert.deepEqual(sleeps, [500]);
  // Hung loop turn, retried loop turn, finalization turn.
  assert.equal(model.doGenerateCalls.length, 3);
});

test('advisor: a caller-signal abort surfaces as a non-retryable timeout and never burns retry budget', async () => {
  const cwd = await createWorkDir();
  let sdkCallObservedAbort = false;
  const model = scriptedModel([
    hangUntilAborted((signal) => {
      sdkCallObservedAbort = signal.aborted;
    }),
  ]);
  const adapter = createAdvisorAdapter({ model });
  const { events, sink } = collectEvents();
  const controller = new AbortController();

  const pending = adapter.runStructuredRound<TestPayload>({
    ...advisorArgs(cwd, sink),
    inactivityTimeoutMs: 60_000,
    // Even with retry budget available, caller cancellation is never retried.
    apiRetryLimit: 1,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    pending,
    expectProviderError({
      kind: 'timeout',
      retryable: false,
      messagePattern: /aborted by the caller/,
    }),
  );
  assert.equal(sdkCallObservedAbort, true);
  assert.equal(apiRetryEvents(events).length, 0);
  assert.equal(model.doGenerateCalls.length, 1);
});
