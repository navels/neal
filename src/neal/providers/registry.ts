import { anthropicClaudeProviderDefinition } from './anthropic-claude.js';
import { openAICompatibleProviderDefinition } from './openai-compatible.js';
import { openAICodexProviderDefinition } from './openai-codex.js';
import type {
  CoderAdapter,
  NealProviderDefinition,
  ProviderId,
  ProviderRoleCapabilities,
  StructuredAdvisorAdapter,
} from './types.js';
import type { AgentConfig, AgentProvider, AgentRoleConfig, OrchestrationState } from '../types.js';

type ProviderAdapterFactories = {
  createCoderAdapter?: (config: AgentRoleConfig) => CoderAdapter;
  createStructuredAdvisorAdapter?: (config: AgentRoleConfig) => StructuredAdvisorAdapter;
};

type ProviderCapabilityName =
  | 'registered_provider'
  | 'role_support'
  | 'coder_adapter'
  | 'structured_advisor_adapter'
  | 'read_tool_access'
  | 'write_tool_access'
  | 'structured_output'
  | 'model_override'
  | 'session_resume';

export type ProviderCapabilityRequirementContext = {
  role: keyof AgentConfig;
  context?: string;
  reason: string;
  requireReadToolAccess?: boolean;
  requireWriteToolAccess?: boolean;
  requireStructuredOutput?: boolean;
  requireSessionResume?: boolean;
  reasons?: Partial<Record<ProviderCapabilityName, string>>;
};

export type AgentConfigCapabilityAssertionOptions = {
  context?: string;
};

type ResumeCapabilityState = Pick<
  OrchestrationState,
  'coderSessionHandle' | 'reviewerSessionHandle'
> & Partial<Pick<OrchestrationState, 'plannerSessionHandle'>>;

// Computed lazily instead of as a top-level constant: openai-compatible.ts
// imports config.ts, which imports this module, so the definition bindings may
// still be in their temporal dead zone while this module body evaluates.
// Every consumer calls listRegisteredProviderDefinitions() at runtime, after
// the module graph has fully loaded.
function getBuiltInProviderDefinitions(): NealProviderDefinition[] {
  return [
    openAICodexProviderDefinition,
    anthropicClaudeProviderDefinition,
    openAICompatibleProviderDefinition,
  ];
}

const providerCapabilityOverrides = new Map<ProviderId, Partial<ProviderAdapterFactories>>();
const providerDefinitionRegistrationsForTesting = new Map<ProviderId, NealProviderDefinition>();

function formatProviderValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function getProviderDefinitionMap() {
  return new Map(listRegisteredProviderDefinitions().map((definition) => [definition.id, definition]));
}

function getProviderAdapterFactories(provider: AgentProvider): ProviderAdapterFactories {
  const definition = getProviderDefinition(provider);
  const createCoderAdapter = definition.createCoderAdapter;
  const createStructuredAdvisorAdapter = definition.createStructuredAdvisorAdapter;
  const base = {
    createCoderAdapter: createCoderAdapter
      ? (config: AgentRoleConfig) => createCoderAdapter({ model: config.model, effort: config.effort ?? null })
      : undefined,
    createStructuredAdvisorAdapter: createStructuredAdvisorAdapter
      ? (config: AgentRoleConfig) => createStructuredAdvisorAdapter({ model: config.model, effort: config.effort ?? null })
      : undefined,
  };
  const override = providerCapabilityOverrides.get(provider);
  return override ? { ...base, ...override } : base;
}

function listSupportedProvidersForRole(role: keyof AgentConfig) {
  const providers = listRegisteredProviderDefinitions()
    .filter((definition) => {
      const adapters = getProviderAdapterFactories(definition.id);
      return role === 'coder' || role === 'planner'
        ? adapters.createCoderAdapter
        : adapters.createStructuredAdvisorAdapter;
    })
    .map((definition) => definition.id);
  return providers.length > 0 ? providers.join(', ') : 'none';
}

function getCapabilityReason(
  requirementContext: ProviderCapabilityRequirementContext,
  capability: ProviderCapabilityName,
) {
  return requirementContext.reasons?.[capability] ?? requirementContext.reason;
}

function formatCapabilityName(capability: ProviderCapabilityName) {
  return capability.replaceAll('_', ' ');
}

function formatRoleConfigKey(role: keyof AgentConfig, key: 'provider' | 'model') {
  return `agent.${role}.${key}`;
}

function formatConfiguredModel(config: AgentRoleConfig) {
  return config.model === null ? 'null (provider default)' : JSON.stringify(config.model);
}

function throwProviderCapabilityError(args: {
  requirementContext: ProviderCapabilityRequirementContext;
  config: AgentRoleConfig;
  missingCapability: ProviderCapabilityName;
}) {
  const context = args.requirementContext.context ? ` Context: ${args.requirementContext.context}.` : '';
  throw new Error(
    [
      `Provider capability error for ${args.requirementContext.role} role: configured provider ${JSON.stringify(args.config.provider)} is missing ${formatCapabilityName(args.missingCapability)}.`,
      `Config keys: ${formatRoleConfigKey(args.requirementContext.role, 'provider')}=${JSON.stringify(args.config.provider)}, ${formatRoleConfigKey(args.requirementContext.role, 'model')}=${formatConfiguredModel(args.config)}.`,
      `Neal needs this because ${getCapabilityReason(args.requirementContext, args.missingCapability)}.`,
      `Registered providers: ${formatRegisteredProviderIds()}.`,
      context.trim(),
    ].filter(Boolean).join(' '),
  );
}

function throwProviderEffortError(args: {
  requirementContext: ProviderCapabilityRequirementContext;
  config: AgentRoleConfig;
  effort: string;
  supportedEfforts: readonly string[] | undefined;
}) {
  const role = args.requirementContext.role;
  const provider = args.config.provider;
  const hasSupported = Boolean(args.supportedEfforts && args.supportedEfforts.length > 0);
  const supportedClause = hasSupported
    ? `Supported effort values for ${provider}: ${args.supportedEfforts!.join(', ')}.`
    : `Supported effort values for ${provider}: (none).`;
  const headline = hasSupported
    ? `Provider config error for ${role} role: provider ${JSON.stringify(provider)} does not support effort ${JSON.stringify(args.effort)}.`
    : `Provider config error for ${role} role: provider ${JSON.stringify(provider)} does not support configuring effort.`;
  throw new Error([headline, supportedClause].join(' '));
}

function getDefinitionForCapabilityCheck(
  config: AgentRoleConfig,
  requirementContext: ProviderCapabilityRequirementContext,
) {
  if (!isRegisteredProviderId(config.provider)) {
    throwProviderCapabilityError({
      requirementContext,
      config,
      missingCapability: 'registered_provider',
    });
  }

  return getProviderDefinition(config.provider);
}

function assertRoleCapabilities(args: {
  config: AgentRoleConfig;
  capabilities: ProviderRoleCapabilities;
  requirementContext: ProviderCapabilityRequirementContext;
}) {
  if (!args.capabilities.supported) {
    throwProviderCapabilityError({
      requirementContext: args.requirementContext,
      config: args.config,
      missingCapability: 'role_support',
    });
  }

  if (args.requirementContext.requireReadToolAccess && !args.capabilities.toolAccess.read) {
    throwProviderCapabilityError({
      requirementContext: args.requirementContext,
      config: args.config,
      missingCapability: 'read_tool_access',
    });
  }

  if (args.requirementContext.requireWriteToolAccess && !args.capabilities.toolAccess.write) {
    throwProviderCapabilityError({
      requirementContext: args.requirementContext,
      config: args.config,
      missingCapability: 'write_tool_access',
    });
  }

  if (args.requirementContext.requireStructuredOutput && !args.capabilities.supportsStructuredOutput) {
    throwProviderCapabilityError({
      requirementContext: args.requirementContext,
      config: args.config,
      missingCapability: 'structured_output',
    });
  }

  if (args.config.model !== null && !args.capabilities.supportsModelOverride) {
    throwProviderCapabilityError({
      requirementContext: args.requirementContext,
      config: args.config,
      missingCapability: 'model_override',
    });
  }

  const effort = args.config.effort ?? null;
  if (effort !== null) {
    const supportedEfforts = args.capabilities.supportedEfforts;
    if (!supportedEfforts || supportedEfforts.length === 0 || !supportedEfforts.includes(effort)) {
      throwProviderEffortError({
        requirementContext: args.requirementContext,
        config: args.config,
        effort,
        supportedEfforts,
      });
    }
  }

  if (args.requirementContext.requireSessionResume && !args.capabilities.supportsSessionResume) {
    throwProviderCapabilityError({
      requirementContext: args.requirementContext,
      config: args.config,
      missingCapability: 'session_resume',
    });
  }
}

// Registry invariant: every *supported* structured-advisor (reviewer)
// capability must be read-only. Reviewers inspect work and return verdicts;
// they never mutate the checkout or run shell commands. Only `write`/`shell`
// are constrained here — `read` is not constrained by this assertion (the
// writer-run capability gates separately require reviewer read access). The
// `coder` capability is intentionally not checked: coders keep write/shell.
export function assertStructuredAdvisorReadOnly(definition: NealProviderDefinition): void {
  const capability = definition.capabilities['structured-advisor'];
  if (!capability.supported) {
    return;
  }

  const { write, shell } = capability.toolAccess;
  if (write || shell) {
    throw new Error(
      [
        `Provider ${JSON.stringify(definition.id)} declares a structured-advisor capability that is not read-only:`,
        `reviewers must have write:false and shell:false (read is unconstrained), but got write:${write}, shell:${shell}.`,
        'Reviewer rounds inspect work and return verdicts; only the coder capability may write or run shell.',
      ].join(' '),
    );
  }
}

export function listRegisteredProviderDefinitions(): NealProviderDefinition[] {
  const definitions = [
    ...getBuiltInProviderDefinitions(),
    ...providerDefinitionRegistrationsForTesting.values(),
  ];
  for (const definition of definitions) {
    assertStructuredAdvisorReadOnly(definition);
  }
  return definitions;
}

export function listRegisteredProviderIds(): ProviderId[] {
  return listRegisteredProviderDefinitions().map((definition) => definition.id);
}

export function formatRegisteredProviderIds(): string {
  return listRegisteredProviderIds().join(', ');
}

export function isRegisteredProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && getProviderDefinitionMap().has(value);
}

export function parseProviderId(value: unknown, context = 'provider'): ProviderId {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `Invalid provider for ${context}: ${formatProviderValue(value)}. Registered providers: ${formatRegisteredProviderIds()}`,
    );
  }

  const provider = value.trim();
  if (!isRegisteredProviderId(provider)) {
    throw new Error(
      `Invalid provider for ${context}: ${JSON.stringify(provider)}. Registered providers: ${formatRegisteredProviderIds()}`,
    );
  }

  return provider;
}

export function getProviderDefinition(id: ProviderId): NealProviderDefinition {
  const definition = getProviderDefinitionMap().get(id);
  if (!definition) {
    throw new Error(`Unsupported provider ${formatProviderValue(id)}. Registered providers: ${formatRegisteredProviderIds()}`);
  }
  return definition;
}

export function assertProviderSupportsCoder(
  config: AgentRoleConfig,
  requirementContext: ProviderCapabilityRequirementContext,
) {
  const definition = getDefinitionForCapabilityCheck(config, requirementContext);
  const adapters = getProviderAdapterFactories(config.provider);
  const capabilities = definition.capabilities.coder;

  assertRoleCapabilities({
    config,
    capabilities,
    requirementContext,
  });

  if (!adapters.createCoderAdapter) {
    throwProviderCapabilityError({
      requirementContext,
      config,
      missingCapability: 'coder_adapter',
    });
  }
}

export function assertProviderSupportsStructuredAdvisor(
  config: AgentRoleConfig,
  requirementContext: ProviderCapabilityRequirementContext,
) {
  const definition = getDefinitionForCapabilityCheck(config, requirementContext);
  const adapters = getProviderAdapterFactories(config.provider);
  const capabilities = definition.capabilities['structured-advisor'];

  assertRoleCapabilities({
    config,
    capabilities,
    requirementContext,
  });

  if (!adapters.createStructuredAdvisorAdapter) {
    throwProviderCapabilityError({
      requirementContext,
      config,
      missingCapability: 'structured_advisor_adapter',
    });
  }
}

export function assertAgentConfigSupportsWriterRun(
  agentConfig: AgentConfig,
  options: AgentConfigCapabilityAssertionOptions = {},
) {
  const context = options.context ?? 'writer run';

  assertProviderSupportsCoder(agentConfig.coder, {
    role: 'coder',
    context,
    reason: 'Neal writer runs need a coder provider that can modify the target checkout and return structured continuation payloads',
    requireWriteToolAccess: true,
    requireStructuredOutput: true,
    reasons: {
      coder_adapter: 'Neal starts coder turns through the configured coder adapter before any scope work can run',
      write_tool_access: 'plan and execute work may edit plan files, source files, and verification artifacts',
      structured_output: 'coder response, support response, blocked recovery, and final-completion paths use schema-validated structured coder payloads',
      model_override: 'a non-null coder model override is configured for this writer run',
    },
  });

  assertProviderSupportsCoder(agentConfig.planner, {
    role: 'planner',
    context,
    reason: 'Neal planning runs need a planner provider backed by the coder adapter so plan authoring can edit plan artifacts and return structured continuation payloads',
    requireWriteToolAccess: true,
    requireStructuredOutput: true,
    reasons: {
      coder_adapter: 'Neal starts planner turns through the coder adapter before plan authoring can run',
      write_tool_access: 'planning work may create, refine, and recover plan files',
      structured_output: 'plan authoring and plan-response paths use schema-validated structured coder payloads',
      model_override: 'a non-null planner model override is configured for this writer run',
    },
  });

  assertProviderSupportsStructuredAdvisor(agentConfig.reviewer, {
    role: 'reviewer',
    context,
    reason: 'Neal writer runs need a reviewer provider that can inspect work and return structured verdicts',
    requireReadToolAccess: true,
    requireStructuredOutput: true,
    reasons: {
      structured_advisor_adapter: 'reviewer, plan-review, support, and final-completion verdicts run through the structured-advisor adapter',
      read_tool_access: 'reviewer rounds must inspect repository state, diffs, and run artifacts directly with read tools',
      structured_output: 'reviewer rounds return schema-validated structured verdicts',
      model_override: 'a non-null reviewer model override is configured for this writer run',
    },
  });

  assertProviderSupportsStructuredAdvisor(agentConfig.coder, {
    role: 'coder',
    context,
    reason: 'the final-completion summary currently uses the configured coder provider through the structured-advisor path',
    requireStructuredOutput: true,
    reasons: {
      structured_advisor_adapter: 'runCoderFinalCompletionSummaryRound obtains a structured-advisor adapter from the coder provider',
      structured_output: 'the final-completion summary must return a schema-validated structured payload',
      model_override: 'a non-null coder model override is configured for the final-completion structured-advisor call',
    },
  });
}

export function assertAgentConfigSupportsResume(
  agentConfig: AgentConfig,
  state: ResumeCapabilityState,
  options: AgentConfigCapabilityAssertionOptions = {},
) {
  const context = options.context ?? 'writer run resume';
  assertAgentConfigSupportsWriterRun(agentConfig, { context });

  if (state.plannerSessionHandle) {
    assertProviderSupportsCoder(agentConfig.planner, {
      role: 'planner',
      context,
      reason: 'the selected run has a persisted planner session handle that Neal must resume before continuing plan-authoring work',
      requireSessionResume: true,
      reasons: {
        session_resume: `persisted planner session ${JSON.stringify(state.plannerSessionHandle)} is present`,
      },
    });
  }

  if (state.coderSessionHandle) {
    assertProviderSupportsCoder(agentConfig.coder, {
      role: 'coder',
      context,
      reason: 'the selected run has a persisted coder session handle that Neal must resume before continuing writer work',
      requireSessionResume: true,
      reasons: {
        session_resume: `persisted coder session ${JSON.stringify(state.coderSessionHandle)} is present`,
      },
    });
  }

  if (state.reviewerSessionHandle) {
    assertProviderSupportsStructuredAdvisor(agentConfig.reviewer, {
      role: 'reviewer',
      context,
      reason: 'the selected run has a persisted reviewer session handle that Neal must resume before continuing reviewer work',
      requireSessionResume: true,
      reasons: {
        session_resume: `persisted reviewer session ${JSON.stringify(state.reviewerSessionHandle)} is present`,
      },
    });
  }
}

export function assertSupportedAgentConfig(agentConfig: AgentConfig) {
  assertAgentConfigSupportsWriterRun(agentConfig);
}

export function getCoderAdapter(config: AgentRoleConfig): CoderAdapter {
  const createCoderAdapter = getProviderAdapterFactories(config.provider).createCoderAdapter;
  if (createCoderAdapter) {
    return createCoderAdapter(config);
  }

  throw new Error(`Unsupported coder provider: ${config.provider}. Supported today: ${listSupportedProvidersForRole('coder')}`);
}

export function getStructuredAdvisorAdapter(config: AgentRoleConfig): StructuredAdvisorAdapter {
  const createStructuredAdvisorAdapter = getProviderAdapterFactories(config.provider).createStructuredAdvisorAdapter;
  if (createStructuredAdvisorAdapter) {
    return createStructuredAdvisorAdapter(config);
  }

  throw new Error(`Unsupported reviewer provider: ${config.provider}. Supported today: ${listSupportedProvidersForRole('reviewer')}`);
}

// The two mutators below can substitute adapter factories/definitions after the
// registry's read-only assertion has run, so they must be structurally
// unreachable outside the test runner: node:test sets NODE_TEST_CONTEXT in
// every test process, and no production code path sets it. The clear* helpers
// stay unguarded — they can only restore production state.
function assertTestRunnerContext(hook: string) {
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error(
      `${hook} is a test-only registry mutation hook and can only run under the node:test runner ` +
        '(NODE_TEST_CONTEXT is not set). Production code must never override provider capabilities.',
    );
  }
}

export function setProviderCapabilitiesOverrideForTesting(
  provider: AgentProvider,
  override: Partial<ProviderAdapterFactories>,
) {
  assertTestRunnerContext('setProviderCapabilitiesOverrideForTesting');
  providerCapabilityOverrides.set(provider, override);
}

export function clearProviderCapabilitiesOverridesForTesting() {
  providerCapabilityOverrides.clear();
}

export function registerProviderDefinitionForTesting(definition: NealProviderDefinition): () => void {
  assertTestRunnerContext('registerProviderDefinitionForTesting');
  if (isRegisteredProviderId(definition.id)) {
    throw new Error(`Provider ${JSON.stringify(definition.id)} is already registered`);
  }

  assertStructuredAdvisorReadOnly(definition);

  providerDefinitionRegistrationsForTesting.set(definition.id, definition);
  return () => {
    providerDefinitionRegistrationsForTesting.delete(definition.id);
  };
}

export function clearProviderDefinitionRegistrationsForTesting() {
  providerDefinitionRegistrationsForTesting.clear();
}
