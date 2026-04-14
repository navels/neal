import { createAnthropicClaudeCoderAdapter, createAnthropicClaudeStructuredAdvisorAdapter } from './anthropic-claude.js';
import { createOpenAICodexCoderAdapter, createOpenAICodexStructuredAdvisorAdapter } from './openai-codex.js';
import type { CoderAdapter, StructuredAdvisorAdapter } from './types.js';
import type { AgentConfig, AgentProvider, AgentRoleConfig } from '../types.js';

type ProviderCapabilities = {
  createCoderAdapter?: (config: AgentRoleConfig) => CoderAdapter;
  createStructuredAdvisorAdapter?: (config: AgentRoleConfig) => StructuredAdvisorAdapter;
};

const PROVIDER_CAPABILITIES: Record<AgentProvider, ProviderCapabilities> = {
  'openai-codex': {
    createCoderAdapter(config) {
      return createOpenAICodexCoderAdapter({ model: config.model });
    },
    createStructuredAdvisorAdapter(config) {
      return createOpenAICodexStructuredAdvisorAdapter({ model: config.model });
    },
  },
  'anthropic-claude': {
    createCoderAdapter(config) {
      return createAnthropicClaudeCoderAdapter({ model: config.model });
    },
    createStructuredAdvisorAdapter(config) {
      return createAnthropicClaudeStructuredAdvisorAdapter({ model: config.model });
    },
  },
};

function listSupportedProvidersForRole(role: keyof AgentConfig) {
  return Object.entries(PROVIDER_CAPABILITIES)
    .filter(([, capabilities]) => (role === 'coder' ? capabilities.createCoderAdapter : capabilities.createStructuredAdvisorAdapter))
    .map(([provider]) => provider)
    .join(', ');
}

export function assertSupportedAgentConfig(agentConfig: AgentConfig) {
  if (!PROVIDER_CAPABILITIES[agentConfig.coder.provider].createCoderAdapter) {
    throw new Error(`Unsupported coder provider: ${agentConfig.coder.provider}. Supported today: ${listSupportedProvidersForRole('coder')}`);
  }

  if (!PROVIDER_CAPABILITIES[agentConfig.reviewer.provider].createStructuredAdvisorAdapter) {
    throw new Error(
      `Unsupported reviewer provider: ${agentConfig.reviewer.provider}. Supported today: ${listSupportedProvidersForRole('reviewer')}`,
    );
  }
}

export function getCoderAdapter(config: AgentRoleConfig): CoderAdapter {
  const createCoderAdapter = PROVIDER_CAPABILITIES[config.provider].createCoderAdapter;
  if (createCoderAdapter) {
    return createCoderAdapter(config);
  }

  throw new Error(`Unsupported coder provider: ${config.provider}. Supported today: ${listSupportedProvidersForRole('coder')}`);
}

export function getStructuredAdvisorAdapter(config: AgentRoleConfig): StructuredAdvisorAdapter {
  const createStructuredAdvisorAdapter = PROVIDER_CAPABILITIES[config.provider].createStructuredAdvisorAdapter;
  if (createStructuredAdvisorAdapter) {
    return createStructuredAdvisorAdapter(config);
  }

  throw new Error(`Unsupported reviewer provider: ${config.provider}. Supported today: ${listSupportedProvidersForRole('reviewer')}`);
}
