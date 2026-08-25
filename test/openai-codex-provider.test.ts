import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Thread } from '@openai/codex-sdk';

import {
  configureDiagnosticFooter,
  getBufferedDetailSnapshot,
  resetDiagnosticStateForTests,
  setDiagnosticDetailVisibility,
} from '../src/neal/diagnostic.js';
import { buildReviewerSchema, validateReviewerPayload } from '../src/neal/agents/schemas.js';
import type { RunLogger } from '../src/neal/logger.js';
import { openAICodexProviderTestHooks } from '../src/neal/providers/openai-codex.js';
import { resolveRateCost } from '../src/neal/providers/pricing.js';
import { createProviderTelemetrySink } from '../src/neal/providers/telemetry.js';
import { NealProviderError, type ProviderRuntimeEvent } from '../src/neal/providers/types.js';
import { buildReviewFindingsInlinedDiffSection } from '../src/neal/review-findings/prompts.js';
import type { ReviewFindingsContext } from '../src/neal/review-findings/types.js';

class FakeFooter {
  readonly writes: string[] = [];

  write(message: string) {
    this.writes.push(message);
  }

  dispose() {}
}

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
}

async function* eventStream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

async function* eventStreamThenThrow(events: unknown[], error: unknown) {
  for (const event of events) {
    yield event;
  }
  throw error;
}

async function* stalledAfterThreadStarted(threadId: string) {
  yield { type: 'thread.started', thread_id: threadId };
  await new Promise(() => {});
}

function codexTurn(events: unknown[]) {
  return {
    events: eventStream(events),
  } as unknown as Awaited<ReturnType<Thread['runStreamed']>>;
}

function codexTurnFromStream(events: AsyncGenerator<unknown, void>) {
  return {
    events,
  } as unknown as Awaited<ReturnType<Thread['runStreamed']>>;
}

function providerErrorEvents(events: ProviderRuntimeEvent[]) {
  return events.filter((event): event is Extract<ProviderRuntimeEvent, { type: 'provider_error' }> => event.type === 'provider_error');
}

function commandCompleted(command: string, output: string) {
  return {
    type: 'item.completed',
    item: {
      type: 'command_execution',
      id: 'cmd-1',
      status: 'completed',
      command,
      exit_code: 0,
      aggregated_output: output,
    },
  };
}

function fileChangeCompleted(path: string) {
  return {
    type: 'item.completed',
    item: {
      type: 'file_change',
      id: 'file-1',
      status: 'completed',
      changes: [{ path }],
    },
  };
}

function agentMessage(text: string) {
  return {
    type: 'item.completed',
    item: {
      type: 'agent_message',
      id: 'msg-1',
      text,
    },
  };
}

function turnCompleted() {
  return {
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 80,
      output_tokens: 10,
    },
  };
}

function sdkError(message: string) {
  return {
    type: 'error',
    message,
  };
}

function turnFailed(message: string) {
  return {
    type: 'turn.failed',
    error: { message },
  };
}

// The OpenAI content-safety refusal text from issue #27. Either documented
// substring is sufficient to classify a refusal.
const CONTENT_SAFETY_REFUSAL_MESSAGE =
  'This content was flagged for possible cybersecurity risk. If this seems wrong, ' +
  'try rephrasing your request. To get authorized for security work, join the ' +
  'Trusted Access for Cyber program.';

// A thread factory whose every created thread fails its turn via a `turn.failed`
// event carrying `failureMessage`, recording how many threads were created so a
// test can prove the retry loop did not start a second turn.
function fakeTurnFailedThreadFactory(runs: Array<{ id: string; failureMessage: string }>) {
  const calls: Array<{ createArgs: FakeCodexThreadCreateArgs; prompt: string }> = [];
  const createThread = (createArgs: FakeCodexThreadCreateArgs): Thread => {
    const run = runs[calls.length];
    if (!run) {
      throw new Error('unexpected Codex test thread creation');
    }
    return {
      id: run.id,
      runStreamed: (prompt: string) => {
        calls.push({ createArgs, prompt });
        return codexTurn([
          { type: 'thread.started', thread_id: run.id },
          turnFailed(run.failureMessage),
        ]);
      },
    } as unknown as Thread;
  };
  return { calls, createThread };
}

function reviewerJsonBlock(payload: unknown, prose = 'Review complete.') {
  return `${prose}\n\n\`\`\`neal-json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function coderJsonBlock(payload: unknown, prose = 'Coder complete.') {
  return `${prose}\n\n\`\`\`neal-json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

function validReviewerPayload() {
  return {
    summary: 'Implementation is acceptable.',
    findings: [],
    meaningfulProgressAction: 'accept',
    meaningfulProgressRationale: 'The scope made meaningful progress.',
  };
}

type FakeCodexThreadCreateArgs = {
  cwd: string;
  sessionHandle?: string | null;
  model?: string;
  effort?: string;
  skipGitRepoCheck?: boolean;
  sandboxMode?: 'danger-full-access' | 'read-only' | 'workspace-write';
};

type FakeCodexThreadRun = { id: string } & ({ responseText: string } | { errorMessage: string });

function fakeStructuredAdvisorThreadFactory(runs: FakeCodexThreadRun[]) {
  const calls: Array<{
    createArgs: FakeCodexThreadCreateArgs;
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  const createThread = (createArgs: FakeCodexThreadCreateArgs): Thread => {
    const run = runs[calls.length];
    if (!run) {
      throw new Error('unexpected Codex test thread creation');
    }

    return {
      id: run.id,
      runStreamed: (prompt: string, options: Record<string, unknown>) => {
        calls.push({ createArgs, prompt, options });
        return codexTurn([
          { type: 'thread.started', thread_id: run.id },
          ...('errorMessage' in run
            ? [sdkError(run.errorMessage)]
            : [agentMessage(run.responseText), turnCompleted()]),
        ]);
      },
    } as unknown as Thread;
  };

  return { calls, createThread };
}

function reviewerProtocol(schema = buildReviewerSchema()) {
  return {
    protocol: 'neal-json-block-v1' as const,
    schemaLabel: 'reviewer_payload',
    schema,
    validator: validateReviewerPayload,
    repairAttemptLimit: 1,
  };
}

function coderProtocol() {
  const schema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
    },
    required: ['ok'],
    additionalProperties: false,
  };
  return {
    protocol: 'neal-json-block-v1' as const,
    schemaLabel: 'coder_test_payload',
    schema,
    validator: (payload: unknown) => {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('invalid coder test payload');
      }
      const value = payload as Record<string, unknown>;
      if (typeof value.ok !== 'boolean') {
        throw new Error('invalid coder test payload');
      }
      return { ok: value.ok };
    },
    repairAttemptLimit: 1,
  };
}

test('Codex structured-advisor local JSON protocol run options omit SDK outputSchema', () => {
  const schema = buildReviewerSchema();
  const abortController = new AbortController();
  const options = openAICodexProviderTestHooks.buildCodexStructuredAdvisorRunOptions(
    {
      label: 'review',
      cwd: process.cwd(),
      prompt: 'review current scope',
      schema,
      inactivityTimeoutMs: 600_000,
      apiRetryLimit: 0,
      structuredJsonProtocol: {
        protocol: 'neal-json-block-v1',
        schemaLabel: 'reviewer_payload',
        schema,
        validator: validateReviewerPayload,
        repairAttemptLimit: 2,
      },
    },
    abortController.signal,
  );

  assert.equal('outputSchema' in options, false);
  assert.equal(options.signal, abortController.signal);
  assert.equal('structuredJsonProtocol' in options, false);
});

test('Codex structured-advisor local JSON protocol happy path omits SDK outputSchema and returns initial session', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-json-primary',
      responseText: reviewerJsonBlock(payload),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fakeThreads.createThread);

  const result = await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(result, {
    sessionHandle: 'codex-json-primary',
    structured: payload,
  });
  assert.equal(fakeThreads.calls.length, 1);
  assert.match(fakeThreads.calls[0].prompt, /Protocol: neal-json-block-v1/);
  assert.equal(fakeThreads.calls[0].createArgs.sandboxMode, 'read-only');
  assert.equal('outputSchema' in fakeThreads.calls[0].options, false);
  assert.deepEqual(
    events.map((event) => event.type === 'tool_progress' ? event.toolName : event.type),
    [
      'session_started',
      'turn_completed',
      'usage_reported',
      'structured_json_extraction_started',
      'structured_output_received',
    ],
  );
});

test('Codex structured-advisor local JSON protocol repairs on a fresh thread and preserves original session', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-json-primary',
      responseText: 'Review prose without a control block.',
    },
    {
      id: 'codex-json-repair',
      responseText: reviewerJsonBlock(payload, 'Repaired review control payload.'),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fakeThreads.createThread);

  const result = await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(result, {
    sessionHandle: 'codex-json-primary',
    structured: payload,
  });
  assert.equal(fakeThreads.calls.length, 2);
  assert.equal(fakeThreads.calls[1].createArgs.sessionHandle, undefined);
  assert.equal(fakeThreads.calls[1].createArgs.skipGitRepoCheck, true);
  assert.equal(fakeThreads.calls[0].createArgs.sandboxMode, 'read-only');
  assert.equal(fakeThreads.calls[1].createArgs.sandboxMode, 'read-only');
  assert.equal('outputSchema' in fakeThreads.calls[1].options, false);
  const repairSucceeded = events.find(
    (event) => event.type === 'tool_progress' && event.toolName === 'structured_json_repair_succeeded',
  );
  assert.equal(repairSucceeded?.sessionHandle, 'codex-json-primary');
  assert.equal(repairSucceeded?.providerData?.repairSessionHandle, 'codex-json-repair');
});

test('Codex structured-advisor local JSON protocol repair exhaustion emits one provider error', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-json-primary',
      responseText: 'Review prose without a control block.',
    },
    {
      id: 'codex-json-repair',
      responseText: 'Still no control block.',
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fakeThreads.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: 'review current scope',
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 0,
        structuredJsonProtocol: reviewerProtocol(),
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.sessionHandle, 'codex-json-primary');
      assert.match(providerError.message, /remained invalid after 1 repair attempt/);
      return true;
    },
  );

  assert.equal(providerErrorEvents(events).length, 1);
  assert.equal(providerErrorEvents(events)[0].sessionHandle, 'codex-json-primary');
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'structured_json_repair_failed'),
    true,
  );
  assert.equal(events.some((event) => event.type === 'structured_output_received'), false);
});

test('Codex coder local JSON protocol happy path omits SDK outputSchema and returns initial session', async () => {
  const payload = { ok: true };
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-coder-json-primary',
      responseText: coderJsonBlock(payload),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread);

  const result = await adapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'make a structured coder decision',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Coder response round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
  });

  assert.deepEqual(result, {
    sessionHandle: 'codex-coder-json-primary',
    structured: payload,
  });
  assert.equal(fakeThreads.calls.length, 1);
  assert.match(fakeThreads.calls[0].prompt, /Protocol: neal-json-block-v1/);
  assert.equal(fakeThreads.calls[0].createArgs.sandboxMode, 'danger-full-access');
  assert.equal('outputSchema' in fakeThreads.calls[0].options, false);
});

test('Codex coder local JSON protocol repairs on a fresh thread and preserves original session', async () => {
  const payload = { ok: true };
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-coder-json-primary',
      responseText: 'Coder prose without control JSON.',
    },
    {
      id: 'codex-coder-json-repair',
      responseText: coderJsonBlock(payload, 'Repaired coder payload.'),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread);

  const result = await adapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'make a structured coder decision',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Coder response round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
  });

  assert.deepEqual(result, {
    sessionHandle: 'codex-coder-json-primary',
    structured: payload,
  });
  assert.equal(fakeThreads.calls.length, 2);
  assert.equal(fakeThreads.calls[1].createArgs.sessionHandle, undefined);
  assert.equal(fakeThreads.calls[1].createArgs.skipGitRepoCheck, true);
  assert.equal(fakeThreads.calls[0].createArgs.sandboxMode, 'danger-full-access');
  // The repair prompt forbids tool use entirely, so the repair thread runs
  // under the read-only sandbox even for the coder role.
  assert.equal(fakeThreads.calls[1].createArgs.sandboxMode, 'read-only');
  assert.equal('outputSchema' in fakeThreads.calls[1].options, false);
});

// --- Card-derived cost battery ------------------------------------------------
//
// Codex has no pricing config block, so its cost comes only from the vendored
// rate card by the configured model. The `model` param is threaded into all six
// consumeCodexTurn / consumeCodexAdvisorTurn call sites, and because the
// appended param is optional (a dropped argument still typechecks), each distinct
// path that can emit completed usage is covered explicitly.

function turnCompletedNoUsage() {
  return { type: 'turn.completed' };
}

type FakeCodexEventRun = { id: string; events: unknown[] };

// A thread factory that yields caller-controlled events per run (so a
// usage-less turn.completed can be exercised), mirroring the shape of
// fakeStructuredAdvisorThreadFactory.
function fakeEventThreadFactory(runs: FakeCodexEventRun[]) {
  const calls: Array<{
    createArgs: FakeCodexThreadCreateArgs;
    prompt: string;
    options: Record<string, unknown>;
  }> = [];
  const createThread = (createArgs: FakeCodexThreadCreateArgs): Thread => {
    const run = runs[calls.length];
    if (!run) {
      throw new Error('unexpected Codex test thread creation');
    }
    return {
      id: run.id,
      runStreamed: (prompt: string, options: Record<string, unknown>) => {
        calls.push({ createArgs, prompt, options });
        return codexTurn([{ type: 'thread.started', thread_id: run.id }, ...run.events]);
      },
    } as unknown as Thread;
  };
  return { calls, createThread };
}

// Every usage_reported and turn_completed event must carry the card cost for the
// configured model. Uses each event's own usage so it is exact regardless of the
// usage vector.
function assertCodexCardCost(events: ProviderRuntimeEvent[], model: string) {
  const usageReports = events.filter((event) => event.type === 'usage_reported');
  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  assert.ok(usageReports.length > 0, 'expected at least one usage_reported event');
  assert.ok(turnCompletions.length > 0, 'expected at least one turn_completed event');
  for (const report of usageReports) {
    assert.ok(report.type === 'usage_reported');
    const expected = resolveRateCost({ usage: report.usage, model, configPricing: null });
    assert.ok(expected && expected.costUsd > 0);
    assert.equal(report.costUsd, expected.costUsd);
    assert.equal(report.costSource, 'rate');
  }
  for (const completion of turnCompletions) {
    assert.ok(completion.type === 'turn_completed');
    const expected = resolveRateCost({ usage: completion.usage, model, configPricing: null });
    assert.ok(expected && expected.costUsd > 0);
    assert.equal(completion.costUsd, expected.costUsd);
    assert.equal(completion.costSource, 'rate');
  }
}

test('Codex advisor card-listed model attaches costUsd and costSource to completed usage', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-json-primary', responseText: reviewerJsonBlock(payload) },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    { model: 'gpt-5.5' },
  );

  await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  assertCodexCardCost(events, 'gpt-5.5');
});

test('Codex coder structured repair path prices both the initial and repair thread usage', async () => {
  const payload = { ok: true };
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    // First run: prose with no control block forces a repair.
    { id: 'codex-coder-json-primary', responseText: 'Coder prose without control JSON.' },
    // Repair thread returns a valid payload.
    { id: 'codex-coder-json-repair', responseText: coderJsonBlock(payload, 'Repaired coder payload.') },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(
    fakeThreads.createThread,
    { model: 'gpt-5.5' },
  );

  await adapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'make a structured coder decision',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Coder response round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  // Two threads each emit a completed turn; both must be priced (fails if the
  // repair-thread consumeCodexTurn call is not threaded the model).
  assert.equal(events.filter((event) => event.type === 'turn_completed').length, 2);
  assertCodexCardCost(events, 'gpt-5.5');
});

test('Codex advisor structured repair path prices both the initial and repair thread usage', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-json-primary', responseText: 'Review prose without a control block.' },
    { id: 'codex-json-repair', responseText: reviewerJsonBlock(payload, 'Repaired review control payload.') },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    { model: 'gpt-5.5' },
  );

  await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  assert.equal(events.filter((event) => event.type === 'turn_completed').length, 2);
  assertCodexCardCost(events, 'gpt-5.5');
});

test('Codex provider-native structured-advisor path prices completed usage by the configured model', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    // No structuredJsonProtocol -> provider-native path; responseText is valid
    // JSON parsed by parseCodexStructuredOutput.
    { id: 'codex-native-primary', responseText: JSON.stringify(validReviewerPayload()) },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    { model: 'gpt-5.5' },
  );

  await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    events: (event) => {
      events.push(event);
    },
  });

  // Distinct call site from the two local-JSON branches; the existing aborting
  // native-round test never emits completed usage, so only this covers it.
  assertCodexCardCost(events, 'gpt-5.5');
});

test('Codex two models in one run price each role by its own configured model', async () => {
  const coderThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-coder-two-models', responseText: coderJsonBlock({ ok: true }) },
  ]);
  const coderAdapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(
    coderThreads.createThread,
    { model: 'gpt-5.5' },
  );
  const coderEvents: ProviderRuntimeEvent[] = [];
  await coderAdapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'make a structured coder decision',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Coder response round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
    events: (event) => {
      coderEvents.push(event);
    },
  });

  const advisorThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-advisor-two-models', responseText: reviewerJsonBlock(validReviewerPayload()) },
  ]);
  const advisorAdapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    advisorThreads.createThread,
    { model: 'claude-fable-5' },
  );
  const advisorEvents: ProviderRuntimeEvent[] = [];
  await advisorAdapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      advisorEvents.push(event);
    },
  });

  assertCodexCardCost(coderEvents, 'gpt-5.5');
  assertCodexCardCost(advisorEvents, 'claude-fable-5');
  // The two models price the same usage vector distinctly.
  const coderUsage = coderEvents.find((event) => event.type === 'usage_reported');
  const advisorUsage = advisorEvents.find((event) => event.type === 'usage_reported');
  assert.ok(coderUsage && coderUsage.type === 'usage_reported');
  assert.ok(advisorUsage && advisorUsage.type === 'usage_reported');
  assert.notEqual(coderUsage.costUsd, advisorUsage.costUsd);
});

test('Codex model null emits usage with no cost fields (tokens-only shape preserved)', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-json-null-model', responseText: reviewerJsonBlock(payload) },
  ]);
  // No model configured (SDK default): the slug is unknown, so cost stays null.
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
  );

  await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  for (const event of events) {
    if (event.type === 'usage_reported' || event.type === 'turn_completed') {
      assert.equal(event.costUsd, undefined);
      assert.equal(event.costSource, undefined);
    }
  }
});

test('Codex usage-less completed turn attaches no cost and emits no usage_reported', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeEventThreadFactory([
    {
      id: 'codex-json-no-usage',
      // turn.completed with no usage: opportunistic reporting can omit usage.
      events: [agentMessage(reviewerJsonBlock(payload)), turnCompletedNoUsage()],
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    { model: 'gpt-5.5' },
  );

  await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  const turnCompletions = events.filter((event) => event.type === 'turn_completed');
  assert.equal(turnCompletions.length, 1);
  for (const completion of turnCompletions) {
    assert.ok(completion.type === 'turn_completed');
    assert.equal(completion.costUsd, undefined);
    assert.equal(completion.costSource, undefined);
  }
  // A usage-less turn emits no usage_reported event at all.
  assert.equal(events.filter((event) => event.type === 'usage_reported').length, 0);
});

test('Codex coder toolPolicy plan jail creates the structured-prompt thread with the workspace-write sandbox', async () => {
  const payload = { ok: true };
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-coder-jailed-thread', responseText: coderJsonBlock(payload) },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread);

  await adapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'author the plan document',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Planner plan round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
    toolPolicy: { allowedWritePaths: [join(process.cwd(), 'plan.md')], allowRun: false },
  });

  assert.equal(fakeThreads.calls.length, 1);
  assert.equal(fakeThreads.calls[0].createArgs.sandboxMode, 'workspace-write');
});

test('Codex coder runPrompt toolPolicy plan jail uses workspace-write while policy-free turns keep full access', async () => {
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-runprompt-jailed', responseText: 'AUTONOMY_SCOPE_DONE' },
    { id: 'codex-runprompt-open', responseText: 'AUTONOMY_SCOPE_DONE' },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread);

  await adapter.runPrompt({
    cwd: process.cwd(),
    prompt: 'author the plan document',
    inactivityTimeoutMs: 600_000,
    toolPolicy: { allowedWritePaths: [join(process.cwd(), 'plan.md')], allowRun: false },
  });
  await adapter.runPrompt({
    cwd: process.cwd(),
    prompt: 'implement the change',
    inactivityTimeoutMs: 600_000,
  });

  assert.equal(fakeThreads.calls.length, 2);
  assert.equal(fakeThreads.calls[0].createArgs.sandboxMode, 'workspace-write');
  assert.equal(fakeThreads.calls[1].createArgs.sandboxMode, 'danger-full-access');
});

test('Codex coder structured prompt retries transient failures with backoff up to apiRetryLimit before surfacing the error', async () => {
  const capacityMessage = 'Selected model is at capacity. Please try a different model.';
  const events: ProviderRuntimeEvent[] = [];
  const sleepDelays: number[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-coder-retry-1', errorMessage: capacityMessage },
    { id: 'codex-coder-retry-2', errorMessage: capacityMessage },
    { id: 'codex-coder-retry-3', errorMessage: capacityMessage },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread, {
    sleep: async (ms) => {
      sleepDelays.push(ms);
    },
  });

  await assert.rejects(
    () =>
      adapter.runStructuredPrompt({
        cwd: process.cwd(),
        prompt: 'make a structured coder decision',
        schema: coderProtocol().schema as Record<string, unknown>,
        label: 'Coder response round',
        inactivityTimeoutMs: 600_000,
        structuredJsonProtocol: coderProtocol(),
        apiRetryLimit: 2,
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'api_error');
      assert.equal(providerError.retryable, true);
      assert.match(providerError.message, /at capacity/);
      return true;
    },
  );

  // One initial attempt plus two retries, each on a fresh thread, with the
  // 500 ms base doubling backoff between attempts.
  assert.equal(fakeThreads.calls.length, 3);
  assert.deepEqual(sleepDelays, [500, 1000]);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_progress' && event.toolName === 'api_retry')
      .map((event) => ({
        retryCount: event.providerData?.retryCount,
        retryLimit: event.providerData?.retryLimit,
      })),
    [
      { retryCount: 1, retryLimit: 2 },
      { retryCount: 2, retryLimit: 2 },
    ],
  );
});

test('Codex coder structured prompt with apiRetryLimit 0 surfaces the transient failure without retrying', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const sleepDelays: number[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-coder-no-retry', errorMessage: 'Selected model is at capacity. Please try a different model.' },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread, {
    sleep: async (ms) => {
      sleepDelays.push(ms);
    },
  });

  await assert.rejects(
    () =>
      adapter.runStructuredPrompt({
        cwd: process.cwd(),
        prompt: 'make a structured coder decision',
        schema: coderProtocol().schema as Record<string, unknown>,
        label: 'Coder response round',
        inactivityTimeoutMs: 600_000,
        structuredJsonProtocol: coderProtocol(),
        apiRetryLimit: 0,
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'api_error');
      assert.equal(providerError.retryable, true);
      return true;
    },
  );

  assert.equal(fakeThreads.calls.length, 1);
  assert.deepEqual(sleepDelays, []);
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'api_retry'),
    false,
  );
});

test('Codex structured-advisor retries a transient failure on a fresh thread before succeeding', async () => {
  const payload = validReviewerPayload();
  const events: ProviderRuntimeEvent[] = [];
  const sleepDelays: number[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-advisor-retry-failure', errorMessage: 'Selected model is at capacity. Please try a different model.' },
    { id: 'codex-advisor-retry-success', responseText: reviewerJsonBlock(payload) },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    {
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
    },
  );

  const result = await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 1,
    structuredJsonProtocol: reviewerProtocol(),
    events: (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(result, {
    sessionHandle: 'codex-advisor-retry-success',
    structured: payload,
  });
  assert.equal(fakeThreads.calls.length, 2);
  assert.equal(fakeThreads.calls[1].createArgs.sessionHandle, undefined);
  assert.deepEqual(sleepDelays, [500]);
  assert.equal(
    events.some((event) => event.type === 'tool_progress' && event.toolName === 'api_retry'),
    true,
  );
});

test('Codex structured-advisor non-retryable failures never burn the retry budget', async () => {
  const sleepDelays: number[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    { id: 'codex-advisor-fatal', errorMessage: 'Model not found. Try a different model.' },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    {
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
    },
  );

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: 'review current scope',
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'provider_failed');
      assert.equal(providerError.retryable, false);
      return true;
    },
  );

  assert.equal(fakeThreads.calls.length, 1);
  assert.deepEqual(sleepDelays, []);
});

test('Codex structured-advisor classifies a content-safety refusal as non-retryable content_refused', async () => {
  const sleepDelays: number[] = [];
  const fakeThreads = fakeTurnFailedThreadFactory([
    { id: 'codex-advisor-refused', failureMessage: CONTENT_SAFETY_REFUSAL_MESSAGE },
    { id: 'codex-advisor-refused-2', failureMessage: CONTENT_SAFETY_REFUSAL_MESSAGE },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    {
      sleep: async (ms) => {
        sleepDelays.push(ms);
      },
    },
  );

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: 'review current scope',
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        // A nonzero retry budget must not be burned: content_refused is terminal.
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'content_refused');
      assert.equal(providerError.retryable, false);
      return true;
    },
  );

  // Exactly one turn: the refusal never starts a second thread even with a
  // nonzero apiRetryLimit, and no backoff sleep is scheduled.
  assert.equal(fakeThreads.calls.length, 1);
  assert.deepEqual(sleepDelays, []);
});

test('Codex structured-advisor still classifies an unrelated failure as provider_failed', async () => {
  const fakeThreads = fakeTurnFailedThreadFactory([
    { id: 'codex-advisor-unrelated', failureMessage: 'Model not found. Try a different model.' },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
  );

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: 'review current scope',
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'provider_failed');
      assert.equal(providerError.retryable, false);
      return true;
    },
  );

  assert.equal(fakeThreads.calls.length, 1);
});

test('buildCodexThreadOptions maps a configured effort to modelReasoningEffort', () => {
  const options = openAICodexProviderTestHooks.buildCodexThreadOptions({
    cwd: '/repo',
    model: 'gpt-5-codex',
    effort: 'high',
  });

  assert.equal(options.modelReasoningEffort, 'high');
  assert.equal(options.model, 'gpt-5-codex');
  assert.equal(options.approvalPolicy, 'never');
  assert.equal(options.sandboxMode, 'danger-full-access');
  assert.equal(options.workingDirectory, '/repo');
});

test('buildCodexThreadOptions threads an explicit sandboxMode and defaults to danger-full-access', () => {
  const readOnly = openAICodexProviderTestHooks.buildCodexThreadOptions({
    cwd: '/repo',
    sandboxMode: 'read-only',
  });
  assert.equal(readOnly.sandboxMode, 'read-only');

  const defaulted = openAICodexProviderTestHooks.buildCodexThreadOptions({ cwd: '/repo' });
  assert.equal(defaulted.sandboxMode, 'danger-full-access');
});

test('buildCodexThreadOptions omits modelReasoningEffort when effort is null or omitted', () => {
  const omitted = openAICodexProviderTestHooks.buildCodexThreadOptions({ cwd: '/repo' });
  assert.equal('modelReasoningEffort' in omitted, false);

  const nulled = openAICodexProviderTestHooks.buildCodexThreadOptions({
    cwd: '/repo',
    effort: undefined,
  });
  assert.equal('modelReasoningEffort' in nulled, false);
});

test('Codex coder adapter forwards configured effort to every createThread call site', async () => {
  const payload = { ok: true };
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-coder-json-primary',
      responseText: 'Coder prose without control JSON.',
    },
    {
      id: 'codex-coder-json-repair',
      responseText: coderJsonBlock(payload, 'Repaired coder payload.'),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread, {
    effort: 'high',
  });

  await adapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'make a structured coder decision',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Coder response round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
  });

  assert.equal(fakeThreads.calls.length, 2);
  assert.equal(fakeThreads.calls[0].createArgs.effort, 'high');
  assert.equal(fakeThreads.calls[1].createArgs.effort, 'high');
});

test('Codex structured-advisor adapter forwards configured effort to every createThread call site', async () => {
  const payload = validReviewerPayload();
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-json-primary',
      responseText: 'Review prose without a control block.',
    },
    {
      id: 'codex-json-repair',
      responseText: reviewerJsonBlock(payload, 'Repaired review control payload.'),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(
    fakeThreads.createThread,
    { effort: 'high' },
  );

  await adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    structuredJsonProtocol: reviewerProtocol(),
  });

  assert.equal(fakeThreads.calls.length, 2);
  assert.equal(fakeThreads.calls[0].createArgs.effort, 'high');
  assert.equal(fakeThreads.calls[1].createArgs.effort, 'high');
});

test('Codex adapters forward no effort to createThread when effort is null', async () => {
  const payload = { ok: true };
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-coder-json-primary',
      responseText: coderJsonBlock(payload),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fakeThreads.createThread, {
    effort: null,
  });

  await adapter.runStructuredPrompt({
    cwd: process.cwd(),
    prompt: 'make a structured coder decision',
    schema: coderProtocol().schema as Record<string, unknown>,
    label: 'Coder response round',
    inactivityTimeoutMs: 600_000,
    structuredJsonProtocol: coderProtocol(),
  });

  assert.equal(fakeThreads.calls.length, 1);
  assert.equal(fakeThreads.calls[0].createArgs.effort, undefined);
});

test('Codex coder diagnostics keep provider telemetry out of the default terminal but persist it to artifacts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-codex-provider-'));
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    const result = await openAICodexProviderTestHooks.consumeCodexTurn(
      codexTurn([
        { type: 'thread.started', thread_id: 'codex-thread-1' },
        commandCompleted('pnpm test', 'line one\nline two\n'),
        fileChangeCompleted('src/example.ts'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'msg-1',
            text: 'AUTONOMY_SCOPE_DONE',
          },
        },
      ]),
      cwd,
      600_000,
      createProviderTelemetrySink({
        logger: logger.asRunLogger(),
        provider: 'openai-codex',
        role: 'coder',
        cwd,
      }),
    );

    const terminal = footer.writes.join('');
    const artifactLog = logger.stderrMessages.join('');
    assert.equal(result.finalResponse, 'AUTONOMY_SCOPE_DONE');
    assert.doesNotMatch(terminal, /\[codex\] thread codex-thread-1/);
    assert.doesNotMatch(terminal, /\$ pnpm test/);
    assert.doesNotMatch(terminal, /\[codex\] command completed \(exit 0, \d+ output bytes\)/);
    assert.doesNotMatch(terminal, /\[codex\] files src\/example\.ts/);
    assert.doesNotMatch(terminal, /line one/);
    assert.match(artifactLog, /\[codex\] thread codex-thread-1/);
    assert.match(artifactLog, /\$ pnpm test/);
    assert.match(artifactLog, /\[codex\] files src\/example\.ts/);
    assert.match(artifactLog, /line one/);
    assert.match(
      getBufferedDetailSnapshot({})
        .entries.map((entry) => entry.message)
        .join(''),
      /\[codex\] command completed \(exit 0, \d+ output bytes\)/,
    );
    assert.deepEqual(
      logger.events.map((event) => event.type).filter((type) => type.startsWith('provider.')),
      ['provider.session_started', 'provider.command_completed', 'provider.file_changed'],
    );
    assert.deepEqual(logger.events.find((event) => event.type === 'provider.command_completed')?.data?.provider, 'openai-codex');
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('Codex detail visibility surfaces full command output to the terminal', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-codex-provider-verbose-'));
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  setDiagnosticDetailVisibility(true);
  configureDiagnosticFooter(footer);

  try {
    await openAICodexProviderTestHooks.consumeCodexAdvisorTurn(
      codexTurn([
        { type: 'thread.started', thread_id: 'codex-review-thread-1' },
        commandCompleted('git diff --stat', 'src/example.ts | 2 ++\n'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'msg-1',
            text: '{"summary":"ok"}',
          },
        },
      ]),
      cwd,
      'review',
      600_000,
      createProviderTelemetrySink({
        logger: logger.asRunLogger(),
        provider: 'openai-codex',
        role: 'structured-advisor',
        label: 'review',
        cwd,
      }),
    );

    const terminal = footer.writes.join('');
    assert.match(terminal, /\[codex:review\] thread codex-review-thread-1/);
    assert.match(terminal, /\$ git diff --stat/);
    assert.match(terminal, /\[codex:review\] command completed \(exit 0, \d+ output bytes\)/);
    assert.match(terminal, /src\/example\.ts \| 2 \+\+/);
    assert.equal(logger.events.some((event) => event.type === 'provider.command_completed'), true);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('Codex advisor diagnostics omit local command output from default terminal logs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-codex-provider-advisor-'));
  const footer = new FakeFooter();
  const logger = new FakeLogger();
  resetDiagnosticStateForTests();
  configureDiagnosticFooter(footer);

  try {
    await openAICodexProviderTestHooks.consumeCodexAdvisorTurn(
      codexTurn([
        commandCompleted('git status --short', ' M src/example.ts\n'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            id: 'msg-1',
            text: '{"summary":"ok"}',
          },
        },
      ]),
      cwd,
      'review',
      600_000,
      createProviderTelemetrySink({
        logger: logger.asRunLogger(),
        provider: 'openai-codex',
        role: 'structured-advisor',
        label: 'review',
        cwd,
      }),
    );

    const terminal = footer.writes.join('');
    const artifactLog = logger.stderrMessages.join('');
    assert.doesNotMatch(terminal, /\$ git status --short/);
    assert.doesNotMatch(terminal, /\[codex:review\] command completed \(exit 0, \d+ output bytes\)/);
    assert.doesNotMatch(terminal, /M src\/example\.ts/);
    assert.match(artifactLog, /\$ git status --short/);
    assert.match(artifactLog, /\[codex:review\] command completed \(exit 0, \d+ output bytes\)/);
    assert.match(artifactLog, /M src\/example\.ts/);
    assert.equal(logger.events.some((event) => event.type === 'provider.command_completed'), true);
  } finally {
    resetDiagnosticStateForTests();
  }
});

test('Codex inactivity timeout maps to a normalized timeout error with the known session handle', async () => {
  await assert.rejects(
    () =>
      openAICodexProviderTestHooks.consumeCodexTurn(
        codexTurnFromStream(stalledAfterThreadStarted('codex-timeout-thread')),
        process.cwd(),
        1,
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'timeout');
      assert.equal(providerError.retryable, true);
      assert.equal(providerError.sessionHandle, 'codex-timeout-thread');
      assert.match(providerError.message, /timed out after/);
      return true;
    },
  );
});

test('Codex coder treats reconnect progress as nonfatal stream telemetry', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const result = await openAICodexProviderTestHooks.consumeCodexTurn(
    codexTurn([
      { type: 'thread.started', thread_id: 'codex-reconnect-thread' },
      sdkError('Reconnecting... 2/5 (timeout waiting for child process to exit)'),
      agentMessage('AUTONOMY_SCOPE_DONE'),
      turnCompleted(),
    ]),
    process.cwd(),
    600_000,
    (event) => {
      events.push(event);
    },
  );

  assert.equal(result.finalResponse, 'AUTONOMY_SCOPE_DONE');
  assert.equal(events.some((event) => event.type === 'provider_error'), false);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_progress')
      .map((event) => ({
        toolName: event.toolName,
        isError: event.isError,
        nonFatal: event.providerData?.nonFatal,
      })),
    [{ toolName: 'codex_stream', isError: true, nonFatal: true }],
  );
  assert.equal(events.some((event) => event.type === 'turn_completed'), true);
});

test('Codex advisor treats reconnect progress as nonfatal stream telemetry', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const result = await openAICodexProviderTestHooks.consumeCodexAdvisorTurn(
    codexTurn([
      { type: 'thread.started', thread_id: 'codex-advisor-reconnect-thread' },
      sdkError('Reconnecting... 1/5 (timeout waiting for child process to exit)'),
      agentMessage('{"summary":"ok"}'),
      turnCompleted(),
    ]),
    process.cwd(),
    'review',
    600_000,
    (event) => {
      events.push(event);
    },
  );

  assert.equal(result.finalResponse, '{"summary":"ok"}');
  assert.equal(events.some((event) => event.type === 'provider_error'), false);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_progress')
      .map((event) => ({
        role: event.role,
        label: event.label,
        toolName: event.toolName,
        isError: event.isError,
        nonFatal: event.providerData?.nonFatal,
      })),
    [{ role: 'structured-advisor', label: 'review', toolName: 'codex_stream', isError: true, nonFatal: true }],
  );
  assert.equal(events.some((event) => event.type === 'turn_completed'), true);
});

test('Codex coder preserves prior provider-authored failure over later iterator process error', async () => {
  const capacityMessage = 'Selected model is at capacity. Please try a different model.';
  const processError = new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
  const events: ProviderRuntimeEvent[] = [];

  await assert.rejects(
    () =>
      openAICodexProviderTestHooks.consumeCodexTurn(
        codexTurnFromStream(
          eventStreamThenThrow(
            [
              { type: 'thread.started', thread_id: 'codex-capacity-thread' },
              sdkError(capacityMessage),
            ],
            processError,
          ),
        ),
        process.cwd(),
        600_000,
        (event) => {
          events.push(event);
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.sessionHandle, 'codex-capacity-thread');
      assert.match(providerError.message, /Selected model is at capacity/);
      assert.doesNotMatch(providerError.message, /Reading prompt from stdin/);
      assert.equal(providerError.kind, 'api_error');
      assert.equal(providerError.retryable, true);
      return true;
    },
  );

  const errors = providerErrorEvents(events);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.provider, 'openai-codex');
  assert.equal(errors[0]?.role, 'coder');
  assert.equal(errors[0]?.sessionHandle, 'codex-capacity-thread');
  assert.equal(errors[0]?.message, capacityMessage);
  assert.doesNotMatch(errors.map((event) => event.message).join('\n'), /Reading prompt from stdin/);
});

test('Codex advisor preserves prior provider-authored failure over later iterator process error', async () => {
  const capacityMessage = 'Selected model is at capacity. Please try a different model.';
  const processError = new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
  const events: ProviderRuntimeEvent[] = [];

  await assert.rejects(
    () =>
      openAICodexProviderTestHooks.consumeCodexAdvisorTurn(
        codexTurnFromStream(
          eventStreamThenThrow(
            [
              { type: 'thread.started', thread_id: 'codex-review-capacity-thread' },
              sdkError(capacityMessage),
            ],
            processError,
          ),
        ),
        process.cwd(),
        'review',
        600_000,
        (event) => {
          events.push(event);
        },
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.sessionHandle, 'codex-review-capacity-thread');
      assert.match(providerError.message, /Selected model is at capacity/);
      assert.doesNotMatch(providerError.message, /Reading prompt from stdin/);
      assert.equal(providerError.kind, 'api_error');
      assert.equal(providerError.retryable, true);
      return true;
    },
  );

  const errors = providerErrorEvents(events);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.provider, 'openai-codex');
  assert.equal(errors[0]?.role, 'structured-advisor');
  assert.equal(errors[0]?.label, 'review');
  assert.equal(errors[0]?.sessionHandle, 'codex-review-capacity-thread');
  assert.equal(errors[0]?.message, capacityMessage);
  assert.doesNotMatch(errors.map((event) => event.message).join('\n'), /Reading prompt from stdin/);
});

test('Codex iterator process errors remain fatal without a prior provider-authored failure', async () => {
  await assert.rejects(
    () =>
      openAICodexProviderTestHooks.consumeCodexTurn(
        codexTurnFromStream(
          eventStreamThenThrow(
            [{ type: 'thread.started', thread_id: 'codex-process-error-thread' }],
            new Error('Codex Exec exited with code 1: Reading prompt from stdin...'),
          ),
        ),
        process.cwd(),
        600_000,
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'provider_failed');
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.sessionHandle, 'codex-process-error-thread');
      assert.match(providerError.message, /Reading prompt from stdin/);
      return true;
    },
  );
});

test('Codex ordinary stream errors remain fatal', async () => {
  await assert.rejects(
    () =>
      openAICodexProviderTestHooks.consumeCodexTurn(
        codexTurn([
          { type: 'thread.started', thread_id: 'codex-fatal-error-thread' },
          sdkError('stream parser failed permanently'),
        ]),
        process.cwd(),
        600_000,
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'provider_failed');
      assert.equal(providerError.sessionHandle, 'codex-fatal-error-thread');
      assert.match(providerError.message, /stream parser failed permanently/);
      return true;
    },
  );
});

test('Codex model-selection guidance without capacity wording is not retryable', async () => {
  await assert.rejects(
    () =>
      openAICodexProviderTestHooks.consumeCodexTurn(
        codexTurn([
          { type: 'thread.started', thread_id: 'codex-unknown-model-thread' },
          sdkError('Model not found. Try a different model.'),
        ]),
        process.cwd(),
        600_000,
      ),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.equal(providerError.kind, 'provider_failed');
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.sessionHandle, 'codex-unknown-model-thread');
      assert.match(providerError.message, /Try a different model/);
      return true;
    },
  );
});

test('Codex invalid structured JSON maps to a normalized structured output error', () => {
  assert.throws(
    () => openAICodexProviderTestHooks.parseCodexStructuredOutput('not-json', 'review', 'codex-structured-thread'),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.sessionHandle, 'codex-structured-thread');
      assert.match(providerError.message, /invalid structured output/);
      return true;
    },
  );
});

test('Codex empty structured response maps to a normalized structured output error with the session handle', () => {
  assert.throws(
    () => openAICodexProviderTestHooks.parseCodexStructuredOutput('', 'review', 'codex-empty-structured-thread'),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'structured-advisor');
      assert.equal(providerError.kind, 'structured_output_invalid');
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.sessionHandle, 'codex-empty-structured-thread');
      assert.match(providerError.message, /Codex review returned invalid structured output/);
      assert.match(providerError.message, /Unexpected end of JSON input/);
      return true;
    },
  );
});

function rejectWhenAborted(signal: AbortSignal, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error(message));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

async function* stalledUntilAborted(threadId: string, signal: AbortSignal): AsyncGenerator<unknown, void> {
  yield { type: 'thread.started', thread_id: threadId };
  yield { type: 'turn.started' };
  await rejectWhenAborted(signal, 'Codex turn aborted by external signal');
}

function abortableThreadFactory(threadId: string) {
  const receivedSignals: AbortSignal[] = [];
  const createThread = (_createArgs: FakeCodexThreadCreateArgs): Thread =>
    ({
      id: threadId,
      runStreamed: (_prompt: string, options: { signal: AbortSignal }) => {
        receivedSignals.push(options.signal);
        return codexTurnFromStream(stalledUntilAborted(threadId, options.signal));
      },
    }) as unknown as Thread;
  return { createThread, receivedSignals };
}

test('Codex coder external abort signal terminates an in-flight runPrompt turn with a provider error', async () => {
  const external = new AbortController();
  const fake = abortableThreadFactory('codex-abort-coder-thread');
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fake.createThread);

  const promise = adapter.runPrompt({
    cwd: process.cwd(),
    prompt: 'implement the change',
    inactivityTimeoutMs: 600_000,
    signal: external.signal,
  });
  setTimeout(() => external.abort(), 10);

  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof NealProviderError, true);
    const providerError = error as NealProviderError;
    assert.equal(providerError.provider, 'openai-codex');
    assert.equal(providerError.role, 'coder');
    assert.equal(providerError.sessionHandle, 'codex-abort-coder-thread');
    assert.match(providerError.message, /aborted/i);
    return true;
  });
  assert.equal(fake.receivedSignals.length, 1);
  assert.equal(fake.receivedSignals[0]?.aborted, true);
});

test('Codex structured-advisor external abort signal terminates an in-flight round with a provider error', async () => {
  const external = new AbortController();
  const fake = abortableThreadFactory('codex-abort-advisor-thread');
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fake.createThread);

  const promise = adapter.runStructuredRound({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review current scope',
    schema: buildReviewerSchema(),
    inactivityTimeoutMs: 600_000,
    apiRetryLimit: 0,
    signal: external.signal,
  });
  setTimeout(() => external.abort(), 10);

  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof NealProviderError, true);
    const providerError = error as NealProviderError;
    assert.equal(providerError.provider, 'openai-codex');
    assert.equal(providerError.role, 'structured-advisor');
    assert.equal(providerError.sessionHandle, 'codex-abort-advisor-thread');
    assert.match(providerError.message, /aborted/i);
    return true;
  });
  assert.equal(fake.receivedSignals.length, 1);
  assert.equal(fake.receivedSignals[0]?.aborted, true);
});

test('Codex coder structured prompt rejects promptly when the external signal is already aborted', async () => {
  const external = new AbortController();
  external.abort();
  const fake = abortableThreadFactory('codex-preaborted-thread');
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fake.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredPrompt({
        cwd: process.cwd(),
        prompt: 'make a structured coder decision',
        schema: coderProtocol().schema as Record<string, unknown>,
        label: 'Coder response round',
        inactivityTimeoutMs: 600_000,
        structuredJsonProtocol: coderProtocol(),
        signal: external.signal,
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.provider, 'openai-codex');
      assert.equal(providerError.role, 'coder');
      assert.match(providerError.message, /aborted/i);
      return true;
    },
  );
  assert.equal(fake.receivedSignals.length, 1);
  assert.equal(fake.receivedSignals[0]?.aborted, true);
});

// --- Input-budget preflight ---------------------------------------------------
//
// Codex declares maxInputChars on both roles, so every turn/round entry point
// preflights the assembled prompt and rejects an over-limit prompt before the
// SDK is touched: the thread factory below records creations, so a nonzero
// count proves an SDK call would have started.

const CODEX_MAX_INPUT_CHARS = 1_048_576;

function threadCreationRecorder() {
  const calls: number[] = [];
  const createThread = (): Thread => {
    calls.push(calls.length);
    throw new Error('unexpected Codex test thread creation');
  };
  return { calls, createThread };
}

function oversizedCodexPrompt() {
  return `## Oversized Section\n${'p'.repeat(CODEX_MAX_INPUT_CHARS)}`;
}

function assertInputTooLargeError(error: unknown, role: 'coder' | 'structured-advisor') {
  assert.equal(error instanceof NealProviderError, true);
  const providerError = error as NealProviderError;
  assert.equal(providerError.provider, 'openai-codex');
  assert.equal(providerError.role, role);
  assert.equal(providerError.kind, 'input_too_large');
  assert.equal(providerError.retryable, false);
  assert.match(providerError.message, /accepts at most 1,048,576 input chars per turn/);
  // The reported size varies by path (structured turns preflight the
  // protocol-wrapped prompt, which is slightly larger than the base prompt),
  // so pin the section name and the magnitude rather than an exact figure.
  assert.match(providerError.message, /Largest sections: "Oversized Section" 1,0\d{2},\d{3} chars/);
  return providerError;
}

test('Codex structured-advisor round rejects an over-budget prompt before any SDK call', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fake = threadCreationRecorder();
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fake.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: oversizedCodexPrompt(),
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assertInputTooLargeError(error, 'structured-advisor');
      return true;
    },
  );

  assert.equal(fake.calls.length, 0);
  const errors = providerErrorEvents(events);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorKind, 'input_too_large');
  assert.match(errors[0].message, /Largest sections:/);
});

test('Codex coder runPrompt rejects an over-budget prompt before any SDK call', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fake = threadCreationRecorder();
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fake.createThread);

  await assert.rejects(
    () =>
      adapter.runPrompt({
        cwd: process.cwd(),
        prompt: oversizedCodexPrompt(),
        inactivityTimeoutMs: 600_000,
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assertInputTooLargeError(error, 'coder');
      return true;
    },
  );

  assert.equal(fake.calls.length, 0);
  const errors = providerErrorEvents(events);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorKind, 'input_too_large');
});

test('Codex coder structured prompt rejects an over-budget prompt without burning API-retry budget', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fake = threadCreationRecorder();
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fake.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredPrompt({
        cwd: process.cwd(),
        prompt: oversizedCodexPrompt(),
        schema: coderProtocol().schema as Record<string, unknown>,
        label: 'Coder response round',
        inactivityTimeoutMs: 600_000,
        structuredJsonProtocol: coderProtocol(),
        apiRetryLimit: 2,
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assertInputTooLargeError(error, 'coder');
      return true;
    },
  );

  assert.equal(fake.calls.length, 0);
  assert.equal(providerErrorEvents(events).length, 1);
  assert.equal(events.some((event) => event.type === 'tool_progress' && event.toolName === 'api_retry'), false);
});

test('Codex advisor round rejects an oversized inlined review-findings diff before any SDK call', async () => {
  const fake = threadCreationRecorder();
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fake.createThread);
  const context: ReviewFindingsContext = {
    version: 1,
    instruction: 'review the selected range',
    instructionSource: 'default',
    selector: { kind: 'last', count: 1 },
    baseRef: 'base',
    headRef: 'head',
    externalBaseCommit: 'a'.repeat(40),
    externalHeadCommit: 'b'.repeat(40),
    externalCommits: ['b'.repeat(40)],
    externalCommitSubjects: ['change'],
    externalChangedFiles: ['src/example.ts'],
    diffStat: '1 file changed',
    diff: `diff --git a/src/example.ts b/src/example.ts\n${'+x\n'.repeat(400_000)}`,
  };
  const prompt = `## Review Findings Adjudication\nAdjudicate the draft.\n\n${buildReviewFindingsInlinedDiffSection(context)}`;

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review-findings',
        cwd: process.cwd(),
        prompt,
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'input_too_large');
      assert.equal(providerError.retryable, false);
      assert.match(providerError.message, /"Inlined Selected-Range Diff"/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});

test('Codex provider-side input_too_large rejection normalizes to the same non-retryable kind', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-input-too-large',
      errorMessage:
        'Codex rejected the request: code -32602, input_error_code: input_too_large, max_chars 1048576, actual_chars 1259386',
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fakeThreads.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: 'review current scope',
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'input_too_large');
      assert.equal(providerError.retryable, false);
      return true;
    },
  );

  // A non-retryable input-size rejection must not burn the API-retry budget.
  assert.equal(fakeThreads.calls.length, 1);
  assert.equal(events.some((event) => event.type === 'tool_progress' && event.toolName === 'api_retry'), false);
});

// A base prompt that fits under the budget on its own but crosses it once the
// neal-json protocol wrapper (transport instructions plus the schema JSON) is
// appended, proving the preflight measures the exact wrapped text sent to the
// SDK rather than the base prompt.
function nearLimitBasePrompt() {
  const prompt = `## Oversized Section\n${'p'.repeat(CODEX_MAX_INPUT_CHARS - 30)}`;
  assert.ok(prompt.length <= CODEX_MAX_INPUT_CHARS);
  return prompt;
}

test('Codex structured-advisor round preflights the wrapped protocol prompt, not just the base prompt', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fake = threadCreationRecorder();
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fake.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: nearLimitBasePrompt(),
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assertInputTooLargeError(error, 'structured-advisor');
      return true;
    },
  );

  assert.equal(fake.calls.length, 0);
  assert.equal(providerErrorEvents(events).length, 1);
});

test('Codex coder structured prompt preflights the wrapped protocol prompt, not just the base prompt', async () => {
  const events: ProviderRuntimeEvent[] = [];
  const fake = threadCreationRecorder();
  const adapter = openAICodexProviderTestHooks.createCoderAdapterWithThreadFactory(fake.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredPrompt({
        cwd: process.cwd(),
        prompt: nearLimitBasePrompt(),
        schema: coderProtocol().schema as Record<string, unknown>,
        label: 'Coder response round',
        inactivityTimeoutMs: 600_000,
        structuredJsonProtocol: coderProtocol(),
        apiRetryLimit: 2,
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assertInputTooLargeError(error, 'coder');
      return true;
    },
  );

  assert.equal(fake.calls.length, 0);
  assert.equal(providerErrorEvents(events).length, 1);
});

test('Codex oversized repair prompt creates no repair thread and surfaces one input_too_large error', async () => {
  const events: ProviderRuntimeEvent[] = [];
  // The initial turn returns a payload that parses as JSON but fails schema
  // validation and is large enough that the generated repair prompt (which
  // embeds the invalid JSON) exceeds the budget, even though the initial
  // wrapped prompt fit.
  const fakeThreads = fakeStructuredAdvisorThreadFactory([
    {
      id: 'codex-repair-too-large',
      responseText: reviewerJsonBlock({ summary: 'x'.repeat(CODEX_MAX_INPUT_CHARS + 1000) }),
    },
  ]);
  const adapter = openAICodexProviderTestHooks.createStructuredAdvisorAdapterWithThreadFactory(fakeThreads.createThread);

  await assert.rejects(
    () =>
      adapter.runStructuredRound({
        label: 'review',
        cwd: process.cwd(),
        prompt: 'review current scope',
        schema: buildReviewerSchema(),
        inactivityTimeoutMs: 600_000,
        apiRetryLimit: 2,
        structuredJsonProtocol: reviewerProtocol(),
        events: (event) => {
          events.push(event);
        },
      }),
    (error) => {
      assert.equal(error instanceof NealProviderError, true);
      const providerError = error as NealProviderError;
      assert.equal(providerError.kind, 'input_too_large');
      assert.equal(providerError.retryable, false);
      assert.equal(providerError.sessionHandle, 'codex-repair-too-large');
      return true;
    },
  );

  // Only the primary thread was created; the repair preflight rejected before
  // a repair thread existed and without burning API-retry budget.
  assert.equal(fakeThreads.calls.length, 1);
  const errors = providerErrorEvents(events);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].errorKind, 'input_too_large');
  assert.equal(events.some((event) => event.type === 'tool_progress' && event.toolName === 'api_retry'), false);
});
