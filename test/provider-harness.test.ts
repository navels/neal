import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAgentConfigSupportsResume,
  assertAgentConfigSupportsWriterRun,
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import type { ProviderCapabilities } from '../src/neal/providers/types.js';
import type { AgentConfig } from '../src/neal/types.js';
import {
  createFakeProviderDefinition,
  fakeProviderDefaultCapabilities,
} from './helpers/fake-provider.js';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
  clearProviderDefinitionRegistrationsForTesting();
});

function cloneCapabilities(): ProviderCapabilities {
  return {
    coder: {
      ...fakeProviderDefaultCapabilities.coder,
      toolAccess: { ...fakeProviderDefaultCapabilities.coder.toolAccess },
    },
    'structured-advisor': {
      ...fakeProviderDefaultCapabilities['structured-advisor'],
      toolAccess: { ...fakeProviderDefaultCapabilities['structured-advisor'].toolAccess },
    },
  };
}

function writerConfig(coderProvider: string, reviewerProvider = 'anthropic-claude', coderModel: string | null = null): AgentConfig {
  return {
    planner: { provider: coderProvider, model: coderModel },
    coder: { provider: coderProvider, model: coderModel },
    reviewer: { provider: reviewerProvider, model: null },
  };
}

test('fake provider defaults satisfy writer-run capability checks', () => {
  registerProviderDefinitionForTesting(createFakeProviderDefinition({ id: 'fake-writer-ready' }));

  assert.doesNotThrow(() =>
    assertAgentConfigSupportsWriterRun(writerConfig('fake-writer-ready', 'fake-writer-ready'), {
      context: 'test writer run',
    }),
  );
});

test('writer-run capability checks reject a provider without a coder adapter', () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-no-coder-adapter',
      includeCoderAdapter: false,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('fake-no-coder-adapter'), {
        context: 'test writer run',
      }),
    /coder role: configured provider "fake-no-coder-adapter" is missing coder adapter.*Neal needs this because.*Registered providers:/,
  );
});

test('writer-run capability checks reject a reviewer provider without a structured-advisor adapter', () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-reviewer-no-advisor',
      includeStructuredAdvisorAdapter: false,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('openai-codex', 'fake-reviewer-no-advisor'), {
        context: 'test writer run',
      }),
    /reviewer role: configured provider "fake-reviewer-no-advisor" is missing structured advisor adapter.*reviewer, plan-review, support, and final-completion verdicts/,
  );
});

test('writer-run capability checks require the coder provider structured-advisor path for final completion', () => {
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-coder-no-advisor',
      includeStructuredAdvisorAdapter: false,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('fake-coder-no-advisor'), {
        context: 'test writer run',
      }),
    /coder role: configured provider "fake-coder-no-advisor" is missing structured advisor adapter.*runCoderFinalCompletionSummaryRound/,
  );
});

test('writer-run capability checks require write-capable coder tools', () => {
  const capabilities = cloneCapabilities();
  capabilities.coder.toolAccess.write = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-readonly-coder',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('fake-readonly-coder'), {
        context: 'test writer run',
      }),
    /coder role: configured provider "fake-readonly-coder" is missing write tool access.*plan and execute work may edit/,
  );
});

test('writer-run capability checks require structured output from coder turns', () => {
  const capabilities = cloneCapabilities();
  capabilities.coder.supportsStructuredOutput = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-unstructured-coder',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('fake-unstructured-coder'), {
        context: 'test writer run',
      }),
    /coder role: configured provider "fake-unstructured-coder" is missing structured output.*structured coder payloads/,
  );
});

test('writer-run capability checks require structured output from reviewer turns', () => {
  const capabilities = cloneCapabilities();
  capabilities['structured-advisor'].supportsStructuredOutput = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-unstructured-reviewer',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('openai-codex', 'fake-unstructured-reviewer'), {
        context: 'test writer run',
      }),
    /reviewer role: configured provider "fake-unstructured-reviewer" is missing structured output.*reviewer rounds return schema-validated structured verdicts/,
  );
});

test('writer-run capability checks reject model overrides when the provider role does not support them', () => {
  const capabilities = cloneCapabilities();
  capabilities.coder.supportsModelOverride = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-no-model-override',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('fake-no-model-override', 'anthropic-claude', 'custom-model'), {
        context: 'test writer run',
      }),
    /coder role: configured provider "fake-no-model-override" is missing model override.*non-null coder model override/,
  );
});

// The reviewer gate accepts the openai-compatible reviewer: it has read tool
// access through neal's jailed read-only toolset.
test('writer-run capability checks accept the openai-compatible reviewer on read tool access', () => {
  assert.doesNotThrow(() =>
    assertAgentConfigSupportsWriterRun(writerConfig('openai-codex', 'openai-compatible'), {
      context: 'test writer run',
    }),
  );

  assert.doesNotThrow(() =>
    assertAgentConfigSupportsWriterRun(writerConfig('anthropic-claude', 'openai-compatible'), {
      context: 'test writer run',
    }),
  );
});

test('writer-run capability checks reject a reviewer without read tool access', () => {
  // Structured output no longer compensates for missing read access: the
  // inline-reviewer-context capability escape hatch was removed, so a
  // read:false reviewer is rejected outright.
  const capabilities = cloneCapabilities();
  capabilities['structured-advisor'].toolAccess.read = false;
  capabilities['structured-advisor'].supportsStructuredOutput = true;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-read-less-reviewer',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsWriterRun(writerConfig('openai-codex', 'fake-read-less-reviewer'), {
        context: 'test writer run',
      }),
    /reviewer role: configured provider "fake-read-less-reviewer" is missing read tool access.*reviewer rounds must inspect repository state, diffs, and run artifacts directly with read tools/,
  );
});

// One all-roles config covers every writer-run gate: the planner role is
// asserted through assertProviderSupportsCoder, and the coder role's
// final-completion structured-advisor path is asserted as well.
test('writer-run capability checks accept an all-roles openai-compatible config', () => {
  assert.doesNotThrow(() =>
    assertAgentConfigSupportsWriterRun(writerConfig('openai-compatible', 'openai-compatible'), {
      context: 'test writer run',
    }),
  );
});

test('resume capability checks reject persisted coder sessions when resume is unsupported', () => {
  const capabilities = cloneCapabilities();
  capabilities.coder.supportsSessionResume = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-no-coder-resume',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsResume(
        writerConfig('fake-no-coder-resume'),
        {
          coderSessionHandle: 'coder-session-1',
          reviewerSessionHandle: null,
        },
        { context: 'test resume' },
      ),
    /coder role: configured provider "fake-no-coder-resume" is missing session resume.*persisted coder session "coder-session-1"/,
  );
});

test('resume capability checks reject persisted reviewer sessions when resume is unsupported', () => {
  const capabilities = cloneCapabilities();
  capabilities['structured-advisor'].supportsSessionResume = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-no-reviewer-resume',
      capabilities,
    }),
  );

  assert.throws(
    () =>
      assertAgentConfigSupportsResume(
        writerConfig('openai-codex', 'fake-no-reviewer-resume'),
        {
          coderSessionHandle: null,
          reviewerSessionHandle: 'reviewer-session-1',
        },
        { context: 'test resume' },
      ),
    /reviewer role: configured provider "fake-no-reviewer-resume" is missing session resume.*persisted reviewer session "reviewer-session-1"/,
  );
});
