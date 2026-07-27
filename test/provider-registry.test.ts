import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAgentConfigSupportsWriterRun,
  assertProviderSupportsCoder,
  assertProviderSupportsStructuredAdvisor,
  assertStructuredAdvisorReadOnly,
  assertSupportedAgentConfig,
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  formatRegisteredProviderIds,
  getCoderAdapter,
  getProviderDefinition,
  getStructuredAdvisorAdapter,
  isRegisteredProviderId,
  listRegisteredProviderDefinitions,
  listRegisteredProviderIds,
  parseProviderId,
  registerProviderDefinitionForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import {
  NealProviderError,
  type ProviderAdapterOptions,
  type ProviderRuntimeEvent,
} from '../src/neal/providers/types.js';
import { createFakeProviderDefinition, fakeProviderDefaultCapabilities } from './helpers/fake-provider.js';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
  clearProviderDefinitionRegistrationsForTesting();
});

function testProtocolSpec() {
  return {
    protocol: 'neal-json-block-v1' as const,
    schemaLabel: 'test_payload',
    schema: {},
    validator: (payload: unknown) => payload as { ok: boolean },
    repairAttemptLimit: 1,
  };
}

test('registry exposes built-in provider definitions from one source', () => {
  assert.deepEqual(listRegisteredProviderIds(), [
    'openai-codex',
    'anthropic-claude',
    'openai-compatible',
  ]);
  assert.deepEqual(
    listRegisteredProviderDefinitions().map((definition) => definition.displayName),
    ['OpenAI Codex', 'Anthropic Claude', 'OpenAI-compatible'],
  );
  assert.equal(
    formatRegisteredProviderIds(),
    'openai-codex, anthropic-claude, openai-compatible',
  );
});

test('registry parses and rejects provider IDs with registered provider context', () => {
  assert.equal(isRegisteredProviderId('openai-codex'), true);
  assert.equal(parseProviderId(' anthropic-claude ', 'agent.reviewer.provider'), 'anthropic-claude');
  assert.equal(isRegisteredProviderId('missing-provider'), false);

  assert.throws(
    () => parseProviderId('missing-provider', 'agent.coder.provider'),
    /Invalid provider for agent\.coder\.provider: "missing-provider".*Registered providers: openai-codex, anthropic-claude/,
  );
  assert.throws(
    () => parseProviderId(123, 'agent.coder.provider'),
    /Invalid provider for agent\.coder\.provider: 123.*Registered providers: openai-codex, anthropic-claude/,
  );
});

test('test providers can be registered and used without core provider branches', async () => {
  const emittedEvent: ProviderRuntimeEvent = {
    type: 'turn_started',
    provider: 'fake-provider',
    role: 'coder',
  };
  let textCoderRuns = 0;
  let structuredCoderRuns = 0;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-provider',
      coderResponses: [{ sessionHandle: 'fake-coder-session', finalResponse: 'coded' }],
      coderSessionHandle: 'fake-coder-session',
      coderStructuredResponses: [{ ok: true }],
      structuredAdvisorResponses: [{ verdict: 'accepted' }],
      emittedProviderEvents: [emittedEvent],
      onCoderRun: () => {
        textCoderRuns += 1;
      },
      onCoderStructuredRun: () => {
        structuredCoderRuns += 1;
      },
    }),
  );

  assert.deepEqual(listRegisteredProviderIds(), [
    'openai-codex',
    'anthropic-claude',
    'openai-compatible',
    'fake-provider',
  ]);
  assert.equal(getProviderDefinition('fake-provider').displayName, 'Fake Provider fake-provider');
  assert.doesNotThrow(() =>
    assertSupportedAgentConfig({
      planner: { provider: 'fake-provider', model: null },
      coder: { provider: 'fake-provider', model: null },
      reviewer: { provider: 'fake-provider', model: null },
    }),
  );

  const events: ProviderRuntimeEvent[] = [];
  const coder = getCoderAdapter({ provider: 'fake-provider', model: null });
  const coderArgs = {
    cwd: process.cwd(),
    prompt: 'implement',
    inactivityTimeoutMs: 1,
    events: (event: ProviderRuntimeEvent) => {
      events.push(event);
    },
  } as Parameters<typeof coder.runPrompt>[0] & { events: (event: ProviderRuntimeEvent) => void };
  const coderResult = await coder.runPrompt(coderArgs);
  assert.deepEqual(coderResult, {
    sessionHandle: 'fake-coder-session',
    finalResponse: 'coded',
  });
  assert.deepEqual(events, [emittedEvent]);
  assert.equal(textCoderRuns, 1);
  assert.equal(structuredCoderRuns, 0);

  const structuredEvents: ProviderRuntimeEvent[] = [];
  const structuredResult = await coder.runStructuredPrompt<{ ok: boolean }>({
    cwd: process.cwd(),
    prompt: 'implement structured',
    label: 'test-structured',
    schema: {},
    structuredJsonProtocol: testProtocolSpec(),
    inactivityTimeoutMs: 1,
    events: (event: ProviderRuntimeEvent) => {
      structuredEvents.push(event);
    },
  });
  assert.deepEqual(structuredResult, {
    sessionHandle: 'fake-coder-session',
    structured: { ok: true },
  });
  assert.deepEqual(structuredEvents, [emittedEvent]);
  assert.equal(textCoderRuns, 1);
  assert.equal(structuredCoderRuns, 1);

  const advisor = getStructuredAdvisorAdapter({ provider: 'fake-provider', model: null });
  const advisorResult = await advisor.runStructuredRound<{ verdict: string }>({
    label: 'review',
    cwd: process.cwd(),
    prompt: 'review',
    schema: {},
    inactivityTimeoutMs: 1,
    apiRetryLimit: 1,
  });
  assert.deepEqual(advisorResult, {
    sessionHandle: 'fake-provider-advisor-session',
    structured: { verdict: 'accepted' },
  });
});

test('test provider registration cleanup removes provider IDs', () => {
  const cleanup = registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: 'temporary-provider' }));
  assert.equal(isRegisteredProviderId('temporary-provider'), true);

  cleanup();

  assert.equal(isRegisteredProviderId('temporary-provider'), false);
});

test('capability overrides remain available for existing orchestration tests', () => {
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter: undefined,
  });

  assert.throws(
    () =>
      assertSupportedAgentConfig({
        planner: { provider: 'openai-codex', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: 'anthropic-claude', model: null },
      }),
    /Provider capability error for coder role: configured provider "openai-codex" is missing coder adapter/,
  );

  clearProviderCapabilitiesOverridesForTesting();

  assert.doesNotThrow(() =>
    assertSupportedAgentConfig({
      planner: { provider: 'openai-codex', model: null },
      coder: { provider: 'openai-codex', model: null },
      reviewer: { provider: 'anthropic-claude', model: null },
    }),
  );
});

test('planner role requires coder-backed writer capabilities', () => {
  const definition = createFakeProviderDefinition({ id: 'fake-readonly-planner' });
  registerProviderDefinitionForTesting({
    ...definition,
    capabilities: {
      ...definition.capabilities,
      coder: {
        ...definition.capabilities.coder,
        toolAccess: { ...definition.capabilities.coder.toolAccess, write: false },
      },
    },
  });

  assert.throws(
    () =>
      assertSupportedAgentConfig({
        planner: { provider: 'fake-readonly-planner', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: 'anthropic-claude', model: null },
      }),
    /Provider capability error for planner role: configured provider "fake-readonly-planner" is missing write tool access/,
  );
});

test('built-in providers accept their shared supported effort values', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    assert.doesNotThrow(() =>
      assertSupportedAgentConfig({
        planner: { provider: 'openai-codex', model: null, effort },
        coder: { provider: 'openai-codex', model: null, effort },
        reviewer: { provider: 'anthropic-claude', model: null, effort },
      }),
    );
  }
});

test('codex rejects an effort it does not support while claude accepts it', () => {
  assert.throws(
    () =>
      assertSupportedAgentConfig({
        planner: { provider: 'openai-codex', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: 'openai-codex', model: null, effort: 'max' },
      }),
    /Provider config error for reviewer role: provider "openai-codex" does not support effort "max"\. Supported effort values for openai-codex: minimal, low, medium, high, xhigh\./,
  );

  assert.doesNotThrow(() =>
    assertSupportedAgentConfig({
      planner: { provider: 'anthropic-claude', model: null },
      coder: { provider: 'anthropic-claude', model: null },
      reviewer: { provider: 'anthropic-claude', model: null, effort: 'max' },
    }),
  );
});

test('claude rejects an effort it does not support while codex accepts it', () => {
  assert.throws(
    () =>
      assertSupportedAgentConfig({
        planner: { provider: 'anthropic-claude', model: null },
        coder: { provider: 'anthropic-claude', model: null, effort: 'minimal' },
        reviewer: { provider: 'anthropic-claude', model: null },
      }),
    /Provider config error for coder role: provider "anthropic-claude" does not support effort "minimal"\. Supported effort values for anthropic-claude: low, medium, high, xhigh, max\./,
  );

  assert.doesNotThrow(() =>
    assertProviderSupportsCoder(
      { provider: 'openai-codex', model: null, effort: 'minimal' },
      { role: 'coder', reason: 'test' },
    ),
  );
});

test('an unknown effort string is rejected with role, provider, effort, and supported values', () => {
  assert.throws(
    () =>
      assertProviderSupportsStructuredAdvisor(
        { provider: 'anthropic-claude', model: null, effort: 'turbo' },
        { role: 'reviewer', reason: 'test' },
      ),
    /Provider config error for reviewer role: provider "anthropic-claude" does not support effort "turbo"\. Supported effort values for anthropic-claude: low, medium, high, xhigh, max\./,
  );
});

test('a provider that omits supportedEfforts rejects any non-null effort with a (none) clause', () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({ id: 'fake-no-effort-provider' }),
  );

  assert.throws(
    () =>
      assertProviderSupportsCoder(
        { provider: 'fake-no-effort-provider', model: null, effort: 'high' },
        { role: 'coder', reason: 'test' },
      ),
    /Provider config error for coder role: provider "fake-no-effort-provider" does not support configuring effort\. Supported effort values for fake-no-effort-provider: \(none\)\./,
  );

  assert.throws(
    () =>
      assertProviderSupportsStructuredAdvisor(
        { provider: 'fake-no-effort-provider', model: null, effort: 'high' },
        { role: 'reviewer', reason: 'test' },
      ),
    /Provider config error for reviewer role: provider "fake-no-effort-provider" does not support configuring effort\. Supported effort values for fake-no-effort-provider: \(none\)\./,
  );

  assert.doesNotThrow(() =>
    assertProviderSupportsCoder(
      { provider: 'fake-no-effort-provider', model: null, effort: null },
      { role: 'coder', reason: 'test' },
    ),
  );

  assert.doesNotThrow(() =>
    assertProviderSupportsCoder(
      { provider: 'fake-no-effort-provider', model: null },
      { role: 'coder', reason: 'test' },
    ),
  );
});

test('fake providers can surface configured normalized provider errors', async () => {
  const providerError = new NealProviderError({
    message: 'fake provider failed',
    provider: 'fake-error-provider',
    role: 'coder',
    kind: 'provider_failed',
    retryable: false,
  });
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-error-provider',
      coderError: providerError,
    }),
  );

  const coder = getCoderAdapter({ provider: 'fake-error-provider', model: null });
  await assert.rejects(
    () =>
      coder.runPrompt({
        cwd: process.cwd(),
        prompt: 'implement',
        inactivityTimeoutMs: 1,
      }),
    (error) => error === providerError,
  );
});

test('registry forwards configured effort from AgentRoleConfig into both adapter factories', () => {
  const coderOptions: Array<ProviderAdapterOptions | undefined> = [];
  const advisorOptions: Array<ProviderAdapterOptions | undefined> = [];
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-effort-forwarding-provider',
      onCreateCoderAdapter: (options) => {
        coderOptions.push(options);
      },
      onCreateStructuredAdvisorAdapter: (options) => {
        advisorOptions.push(options);
      },
    }),
  );

  getCoderAdapter({ provider: 'fake-effort-forwarding-provider', model: null, effort: 'high' });
  getStructuredAdvisorAdapter({ provider: 'fake-effort-forwarding-provider', model: null, effort: 'high' });

  assert.equal(coderOptions.length, 1);
  assert.equal(coderOptions[0]?.effort, 'high');
  assert.equal(advisorOptions.length, 1);
  assert.equal(advisorOptions[0]?.effort, 'high');
});

test('openai-compatible is registered and passes coder, planner, and reviewer capability checks', () => {
  assert.equal(isRegisteredProviderId('openai-compatible'), true);

  const capabilities = getProviderDefinition('openai-compatible').capabilities;
  assert.equal(capabilities.coder.supported, true);
  assert.equal(capabilities['structured-advisor'].supported, true);
  assert.equal(capabilities['structured-advisor'].toolAccess.read, true);
  assert.equal(capabilities['structured-advisor'].providesRangeDiffTool, true);

  assert.doesNotThrow(() =>
    assertProviderSupportsCoder(
      { provider: 'openai-compatible', model: null },
      {
        role: 'coder',
        reason: 'test coder requirement',
        requireWriteToolAccess: true,
        requireStructuredOutput: true,
      },
    ),
  );

  assert.doesNotThrow(() =>
    assertProviderSupportsCoder(
      { provider: 'openai-compatible', model: null },
      {
        role: 'planner',
        reason: 'test planner requirement',
        requireWriteToolAccess: true,
        requireStructuredOutput: true,
      },
    ),
  );

  assert.doesNotThrow(() =>
    assertProviderSupportsStructuredAdvisor(
      { provider: 'openai-compatible', model: null },
      {
        role: 'reviewer',
        reason: 'test reviewer requirement',
        requireReadToolAccess: true,
        requireStructuredOutput: true,
      },
    ),
  );
});

test('openai-compatible rejects any configured effort with the existing effort error', () => {
  assert.throws(
    () =>
      assertProviderSupportsCoder(
        { provider: 'openai-compatible', model: null, effort: 'high' },
        { role: 'coder', reason: 'test' },
      ),
    /Provider config error for coder role: provider "openai-compatible" does not support configuring effort\. Supported effort values for openai-compatible: \(none\)\./,
  );

  assert.throws(
    () =>
      assertProviderSupportsStructuredAdvisor(
        { provider: 'openai-compatible', model: null, effort: 'high' },
        { role: 'reviewer', reason: 'test' },
      ),
    /Provider config error for reviewer role: provider "openai-compatible" does not support configuring effort\. Supported effort values for openai-compatible: \(none\)\./,
  );
});

test('registry forwards a null effort when the role config omits effort', () => {
  const coderOptions: Array<ProviderAdapterOptions | undefined> = [];
  const advisorOptions: Array<ProviderAdapterOptions | undefined> = [];
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-no-effort-forwarding-provider',
      onCreateCoderAdapter: (options) => {
        coderOptions.push(options);
      },
      onCreateStructuredAdvisorAdapter: (options) => {
        advisorOptions.push(options);
      },
    }),
  );

  getCoderAdapter({ provider: 'fake-no-effort-forwarding-provider', model: null });
  getStructuredAdvisorAdapter({ provider: 'fake-no-effort-forwarding-provider', model: null });

  assert.equal(coderOptions[0]?.effort, null);
  assert.equal(advisorOptions[0]?.effort, null);
});

function structuredAdvisorWith(toolAccess: { read: boolean; write: boolean; shell: boolean }) {
  return {
    coder: fakeProviderDefaultCapabilities.coder,
    'structured-advisor': {
      ...fakeProviderDefaultCapabilities['structured-advisor'],
      toolAccess,
    },
  };
}

test('assertStructuredAdvisorReadOnly accepts every registered built-in definition', () => {
  for (const definition of listRegisteredProviderDefinitions()) {
    assert.doesNotThrow(
      () => assertStructuredAdvisorReadOnly(definition),
      `built-in ${definition.id} must declare a read-only structured-advisor capability`,
    );
  }
});

test('assertStructuredAdvisorReadOnly accepts read-only reviewer shapes regardless of read access', () => {
  // The read-only registry invariant constrains write/shell only; read access
  // is enforced separately by the writer-run capability gates below.
  assert.doesNotThrow(() =>
    assertStructuredAdvisorReadOnly(
      createFakeProviderDefinition({
        id: 'fake-read-only-advisor',
        capabilities: structuredAdvisorWith({ read: true, write: false, shell: false }),
      }),
    ),
  );

  assert.doesNotThrow(() =>
    assertStructuredAdvisorReadOnly(
      createFakeProviderDefinition({
        id: 'fake-no-read-advisor',
        capabilities: structuredAdvisorWith({ read: false, write: false, shell: false }),
      }),
    ),
  );
});

test('assertAgentConfigSupportsWriterRun rejects a reviewer provider without read tool access', () => {
  // A structured-output-capable read:false reviewer used to satisfy the
  // removed read_tool_access_or_inline_reviewer_context capability via inline
  // reviewer context; it must now be rejected on read tool access outright.
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-read-less-reviewer',
      capabilities: {
        coder: fakeProviderDefaultCapabilities.coder,
        'structured-advisor': {
          ...fakeProviderDefaultCapabilities['structured-advisor'],
          toolAccess: { read: false, write: false, shell: false },
          supportsStructuredOutput: true,
        },
      },
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun({
        planner: { provider: 'openai-codex', model: null },
        coder: { provider: 'openai-codex', model: null },
        reviewer: { provider: 'fake-read-less-reviewer', model: null },
      }),
    /reviewer role: .* is missing read tool access/,
  );
});

test('assertStructuredAdvisorReadOnly rejects a structured-advisor that can write or run shell', () => {
  assert.throws(
    () =>
      assertStructuredAdvisorReadOnly(
        createFakeProviderDefinition({
          id: 'fake-shelling-advisor',
          capabilities: structuredAdvisorWith({ read: true, write: false, shell: true }),
        }),
      ),
    /structured-advisor capability that is not read-only.*write:false, shell:true/s,
  );

  assert.throws(
    () =>
      assertStructuredAdvisorReadOnly(
        createFakeProviderDefinition({
          id: 'fake-writing-advisor',
          capabilities: structuredAdvisorWith({ read: true, write: true, shell: false }),
        }),
      ),
    /structured-advisor capability that is not read-only.*write:true, shell:false/s,
  );
});

test('registerProviderDefinitionForTesting rejects a writing or shelling structured-advisor definition', () => {
  assert.throws(
    () =>
      registerProviderDefinitionForTesting(
        createFakeProviderDefinition({
          id: 'fake-shelling-reviewer-registration',
          capabilities: structuredAdvisorWith({ read: true, write: false, shell: true }),
        }),
      ),
    /structured-advisor capability that is not read-only/,
  );

  // Registration was rejected, so the violating id never entered the registry.
  assert.equal(isRegisteredProviderId('fake-shelling-reviewer-registration'), false);
});
