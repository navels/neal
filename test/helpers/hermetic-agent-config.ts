import type { AgentConfig } from '../../src/neal/types.js';

// Hermetic agent config for tests. getDefaultAgentConfig() reads the machine's
// effective config (repo neal.yml and ~/.neal/config.yml), so tests whose
// code under test branches on reviewer capabilities must pin this config
// instead of the environment-derived one. Every registered reviewer provider
// has repository read access, so no capability guard is needed here.
export function hermeticAgentConfig(): AgentConfig {
  return {
    planner: { provider: 'openai-codex', model: null, effort: null },
    coder: { provider: 'openai-codex', model: null, effort: null },
    reviewer: { provider: 'anthropic-claude', model: null, effort: null },
  };
}
