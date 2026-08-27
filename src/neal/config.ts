import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

import {
  assertAgentConfigSupportsWriterRun,
  parseProviderId,
} from './providers/registry.js';
import type { ProviderPricing } from './providers/pricing.js';
import type { AgentConfig, AgentProvider } from './types.js';

export type NealConfigFile = {
  neal?: {
    phase_heartbeat_ms?: number | null;
    max_review_rounds?: number | null;
    review_stuck_window?: number | null;
    plan_review_debt_round_threshold?: number | null;
    inactivity_timeout_ms?: number | null;
    api_retry_limit?: number | null;
    agent_turn_startup_timeout_ms?: number | null;
    agent_turn_retry_limit?: number | null;
    interactive_blocked_recovery_max_turns?: number | null;
    final_completion_continue_execution_max?: number | null;
    consultant_max_attempts?: number | null;
    notify_bin?: string | null;
    review_level?: string | null;
  };
  agent?: {
    planner?: {
      provider?: string | null;
      model?: string | null;
      effort?: string | null;
    };
    coder?: {
      provider?: string | null;
      model?: string | null;
      effort?: string | null;
    };
    reviewer?: {
      provider?: string | null;
      model?: string | null;
      effort?: string | null;
    };
  };
  providers?: {
    openai_compatible?: {
      base_url?: string | null;
      api_key_env?: string | null;
      default_model?: string | null;
      headers?: Record<string, unknown> | null;
      pricing?: {
        input_per_million?: number | null;
        cached_input_per_million?: number | null;
        output_per_million?: number | null;
      } | null;
    };
  };
};

export type ReviewLevel = 'strict' | 'moderate' | 'lenient';

const REVIEW_LEVELS: readonly ReviewLevel[] = ['strict', 'moderate', 'lenient'];

export type OpenAICompatibleSettings = {
  baseUrl: string | null;
  apiKeyEnv: string;
  apiKey: string | null;
  defaultModel: string | null;
  headers: Record<string, string>;
  pricing: ProviderPricing | null;
};

const OPENAI_COMPATIBLE_DEFAULT_API_KEY_ENV = 'OPENAI_COMPATIBLE_API_KEY';

type NealResolvedConfig = {
  neal: {
    phase_heartbeat_ms: number;
    max_review_rounds: number;
    review_stuck_window: number;
    plan_review_debt_round_threshold: number;
    inactivity_timeout_ms: number;
    api_retry_limit: number;
    agent_turn_startup_timeout_ms: number;
    agent_turn_retry_limit: number;
    interactive_blocked_recovery_max_turns: number;
    final_completion_continue_execution_max: number;
    consultant_max_attempts: number;
    notify_bin: string | null;
    review_level: ReviewLevel;
  };
  agent: {
    planner: {
      provider: AgentProvider;
      model: string | null;
    };
    coder: {
      provider: AgentProvider;
      model: string | null;
    };
    reviewer: {
      provider: AgentProvider;
      model: string | null;
    };
  };
};

export type ConfigSourceInfo = {
  repo: {
    path: string;
    exists: boolean;
  };
  user: {
    path: string;
    exists: boolean;
  };
};

export type WriterProviderSetupGuidance = 'writer-run' | 'check';

export type AssertWriterProvidersConfiguredOptions = {
  context?: string;
  guidance?: WriterProviderSetupGuidance;
};

const WRITER_PROVIDER_CONFIG_KEYS = {
  coder: 'agent.coder.provider',
  reviewer: 'agent.reviewer.provider',
} as const;

const DEFAULT_CONFIG: NealResolvedConfig = {
  neal: {
    phase_heartbeat_ms: 60_000,
    max_review_rounds: 20,
    review_stuck_window: 5,
    plan_review_debt_round_threshold: 3,
    inactivity_timeout_ms: 600_000,
    api_retry_limit: 10,
    agent_turn_startup_timeout_ms: 300_000,
    agent_turn_retry_limit: 1,
    interactive_blocked_recovery_max_turns: 3,
    final_completion_continue_execution_max: 3,
    consultant_max_attempts: 1,
    notify_bin: null,
    review_level: 'moderate',
  },
  agent: {
    planner: {
      provider: 'openai-codex',
      model: null,
    },
    coder: {
      provider: 'openai-codex',
      model: null,
    },
    reviewer: {
      provider: 'anthropic-claude',
      model: null,
    },
  },
};

const cachedConfig = new Map<string, NealConfigFile>();

function buildWriterProviderSetupLines(guidance: WriterProviderSetupGuidance, missingProviderKeys: string[]) {
  const missingKeys = missingProviderKeys.length > 0
    ? missingProviderKeys
    : Object.values(WRITER_PROVIDER_CONFIG_KEYS);
  if (guidance === 'check') {
    return [
      'Neal is not set up yet.',
      'Run `neal setup` to choose providers, then run `neal check` again.',
    ];
  }

  return [
    'Neal is not set up yet.',
    `Run \`neal setup\` to choose providers, or set ${formatInlineList(missingKeys)} in neal.yml.`,
  ];
}

function formatInlineList(values: readonly string[]) {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

export class WriterProvidersNotConfiguredError extends Error {
  readonly guidance: WriterProviderSetupGuidance;
  readonly lines: string[];
  readonly missingProviderKeys: string[];

  constructor(guidance: WriterProviderSetupGuidance = 'writer-run', missingProviderKeys: string[] = []) {
    const lines = buildWriterProviderSetupLines(guidance, missingProviderKeys);
    super(lines.join('\n'));
    this.name = 'WriterProvidersNotConfiguredError';
    this.guidance = guidance;
    this.lines = lines;
    this.missingProviderKeys = [...missingProviderKeys];
  }
}

export function isWriterProvidersNotConfiguredError(error: unknown): error is WriterProvidersNotConfiguredError {
  return error instanceof WriterProvidersNotConfiguredError;
}

export function formatWriterProviderSetupRequiredLines(
  error: WriterProvidersNotConfiguredError,
  prefix = '',
) {
  return prefix ? error.lines.map((line) => `${prefix} ${line}`) : [...error.lines];
}

export function clearConfigCache(cwd?: string) {
  if (cwd) {
    cachedConfig.delete(resolve(cwd));
    return;
  }

  cachedConfig.clear();
}

function parseNumberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function parseStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isReviewLevel(value: string): value is ReviewLevel {
  return (REVIEW_LEVELS as readonly string[]).includes(value);
}

function parseReviewLevelValue(value: unknown, fieldPath: string): ReviewLevel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string' && !value.trim()) {
    return undefined;
  }

  const level = typeof value === 'string' ? value.trim() : value;
  if (typeof level !== 'string' || !isReviewLevel(level)) {
    throw new Error(
      `Invalid review level for ${fieldPath}: ${JSON.stringify(level)}. Valid values: ${REVIEW_LEVELS.join(', ')}`,
    );
  }

  return level;
}

function parseConfigProviderValue(value: unknown, fieldPath: string): AgentProvider | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string' && !value.trim()) {
    return undefined;
  }

  return parseProviderId(value, fieldPath);
}

function parseExplicitProviderValue(value: unknown, fieldPath: string): AgentProvider | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'string' && !value.trim()) {
    return null;
  }

  return parseProviderId(value, fieldPath);
}

function parseExplicitModelValue(value: unknown): string | null {
  return parseStringValue(value) ?? null;
}

function parseExplicitEffortValue(value: unknown): string | null {
  return parseStringValue(value) ?? null;
}

function hasOwnConfigKey<T extends object, K extends PropertyKey>(
  value: T | null | undefined,
  key: K,
): value is T & Record<K, unknown> {
  return value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
}

function readYamlFileIfPresent(path: string): NealConfigFile | null {
  if (!existsSync(path)) {
    return null;
  }

  const parsed = YAML.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  return parsed as NealConfigFile;
}

function mergeConfig(base: NealConfigFile, override: NealConfigFile | null): NealConfigFile {
  if (!override) {
    return base;
  }

  return {
    neal: {
      ...base.neal,
      ...override.neal,
    },
    agent: {
      planner: {
        ...base.agent?.planner,
        ...override.agent?.planner,
      },
      coder: {
        ...base.agent?.coder,
        ...override.agent?.coder,
      },
      reviewer: {
        ...base.agent?.reviewer,
        ...override.agent?.reviewer,
      },
    },
    providers: {
      openai_compatible: {
        ...base.providers?.openai_compatible,
        ...override.providers?.openai_compatible,
      },
    },
  };
}

export function getConfigSourceInfo(cwd = process.cwd()): ConfigSourceInfo {
  const repoPath = resolve(cwd, 'neal.yml');
  const userPath = join(homedir(), '.neal', 'config.yml');

  return {
    repo: {
      path: repoPath,
      exists: existsSync(repoPath),
    },
    user: {
      path: userPath,
      exists: existsSync(userPath),
    },
  };
}

function loadConfigFile(cwd = process.cwd()): NealConfigFile {
  const cacheKey = resolve(cwd);
  const cached = cachedConfig.get(cacheKey);
  if (cached) {
    return cached;
  }

  const sources = getConfigSourceInfo(cacheKey);
  const userConfig = readYamlFileIfPresent(sources.user.path);
  const repoConfig = readYamlFileIfPresent(sources.repo.path);
  const resolved = mergeConfig(mergeConfig({}, userConfig), repoConfig);
  cachedConfig.set(cacheKey, resolved);
  return resolved;
}

export function getRawMergedConfig(cwd = process.cwd()): NealConfigFile {
  return loadConfigFile(cwd);
}

function readExplicitAgentConfig(cwd = process.cwd()) {
  const config = getRawMergedConfig(cwd);
  const coderProvider = parseExplicitProviderValue(config.agent?.coder?.provider, WRITER_PROVIDER_CONFIG_KEYS.coder);
  const reviewerProvider = parseExplicitProviderValue(config.agent?.reviewer?.provider, WRITER_PROVIDER_CONFIG_KEYS.reviewer);
  const missingProviderKeys: string[] = [];
  if (!coderProvider) {
    missingProviderKeys.push(WRITER_PROVIDER_CONFIG_KEYS.coder);
  }
  if (!reviewerProvider) {
    missingProviderKeys.push(WRITER_PROVIDER_CONFIG_KEYS.reviewer);
  }

  if (!coderProvider || !reviewerProvider) {
    return {
      agentConfig: null,
      missingProviderKeys,
    };
  }

  const plannerProvider = parseConfigProviderValue(config.agent?.planner?.provider, 'agent.planner.provider');
  return {
    agentConfig: {
      planner: {
        provider: plannerProvider ?? coderProvider,
        model: hasOwnConfigKey(config.agent?.planner, 'model')
          ? parseExplicitModelValue(config.agent.planner.model)
          : plannerProvider
            ? null
            : parseExplicitModelValue(config.agent?.coder?.model),
        effort: hasOwnConfigKey(config.agent?.planner, 'effort')
          ? parseExplicitEffortValue(config.agent.planner.effort)
          : plannerProvider
            ? null
            : parseExplicitEffortValue(config.agent?.coder?.effort),
      },
      coder: {
        provider: coderProvider,
        model: parseExplicitModelValue(config.agent?.coder?.model),
        effort: parseExplicitEffortValue(config.agent?.coder?.effort),
      },
      reviewer: {
        provider: reviewerProvider,
        model: parseExplicitModelValue(config.agent?.reviewer?.model),
        effort: parseExplicitEffortValue(config.agent?.reviewer?.effort),
      },
    },
    missingProviderKeys: [],
  };
}

export function getExplicitAgentConfig(cwd = process.cwd()): AgentConfig | null {
  return readExplicitAgentConfig(cwd).agentConfig;
}

export function assertWriterProvidersConfigured(
  cwd = process.cwd(),
  options: AssertWriterProvidersConfiguredOptions = {},
): AgentConfig {
  const { agentConfig, missingProviderKeys } = readExplicitAgentConfig(cwd);
  if (!agentConfig) {
    throw new WriterProvidersNotConfiguredError(options.guidance ?? 'writer-run', missingProviderKeys);
  }

  assertAgentConfigSupportsWriterRun(agentConfig, { context: options.context });
  getReviewLevel(cwd);
  return agentConfig;
}

export function getReviewLevel(cwd = process.cwd()): ReviewLevel {
  const config = loadConfigFile(cwd);
  return parseReviewLevelValue(config.neal?.review_level, 'neal.review_level') ?? DEFAULT_CONFIG.neal.review_level;
}

export function getInactivityTimeoutMs(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.inactivity_timeout_ms) ??
    DEFAULT_CONFIG.neal.inactivity_timeout_ms
  );
}

export function getApiRetryLimit(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.api_retry_limit) ??
    DEFAULT_CONFIG.neal.api_retry_limit
  );
}

export function getAgentTurnStartupTimeoutMs(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.agent_turn_startup_timeout_ms) ??
    DEFAULT_CONFIG.neal.agent_turn_startup_timeout_ms
  );
}

export function getAgentTurnRetryLimit(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.agent_turn_retry_limit) ??
    DEFAULT_CONFIG.neal.agent_turn_retry_limit
  );
}

export function getPhaseHeartbeatMs(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.phase_heartbeat_ms) ??
    DEFAULT_CONFIG.neal.phase_heartbeat_ms
  );
}

export function getMaxReviewRounds(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.max_review_rounds) ??
    DEFAULT_CONFIG.neal.max_review_rounds
  );
}

export function getReviewStuckWindow(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.review_stuck_window) ??
    DEFAULT_CONFIG.neal.review_stuck_window
  );
}

// The reviewer round at or past which a novel verification-hardening plan-review
// finding converts to recorded plan-review debt instead of forcing another
// revision round. Read at the decision site by cwd, mirroring getMaxReviewRounds.
export function getPlanReviewDebtRoundThreshold(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.plan_review_debt_round_threshold) ??
    DEFAULT_CONFIG.neal.plan_review_debt_round_threshold
  );
}

export function getConsultantMaxAttempts(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  const raw =
    parseNumberValue(config.neal?.consultant_max_attempts) ??
    DEFAULT_CONFIG.neal.consultant_max_attempts;
  // Clamp to a non-negative integer (0 disables the consultant entirely).
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.floor(raw);
}

export function getInteractiveBlockedRecoveryMaxTurns(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.interactive_blocked_recovery_max_turns) ??
    DEFAULT_CONFIG.neal.interactive_blocked_recovery_max_turns
  );
}

export function getFinalCompletionContinueExecutionMax(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.final_completion_continue_execution_max) ??
    DEFAULT_CONFIG.neal.final_completion_continue_execution_max
  );
}

export function getNotifyBin(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  // NEAL_NOTIFY_BIN overrides config entirely: a non-empty value selects that
  // helper, and a defined-but-empty value disables notifications. The test
  // suite sets the empty form so test fixtures that resolve effective config
  // (which falls through to ~/.neal/config.yml) never invoke the operator's
  // real notification helper.
  const envOverride = env.NEAL_NOTIFY_BIN;
  if (envOverride !== undefined) {
    return envOverride.trim() === '' ? null : envOverride;
  }
  const config = loadConfigFile(cwd);
  return (
    parseStringValue(config.neal?.notify_bin) ??
    DEFAULT_CONFIG.neal.notify_bin
  );
}

function parseOpenAICompatibleHeaders(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Invalid providers.openai_compatible.headers: expected a map of string header names to string values.',
    );
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) {
      throw new Error(
        'Invalid providers.openai_compatible.headers: header names must be non-empty strings.',
      );
    }
    if (typeof headerValue !== 'string') {
      throw new Error(
        `Invalid providers.openai_compatible.headers: value for "${key}" must be a string.`,
      );
    }
    headers[key] = headerValue;
  }

  return headers;
}

function parseOpenAICompatiblePricing(value: unknown): ProviderPricing | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'Invalid providers.openai_compatible.pricing: expected a map with input_per_million, ' +
        'cached_input_per_million, and output_per_million rates.',
    );
  }

  const record = value as Record<string, unknown>;
  const parseRate = (key: string): number => {
    const rate = record[key];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      throw new Error(
        `Invalid providers.openai_compatible.pricing: "${key}" must be a finite non-negative number.`,
      );
    }
    return rate;
  };

  return {
    inputPerMillion: parseRate('input_per_million'),
    cachedInputPerMillion: parseRate('cached_input_per_million'),
    outputPerMillion: parseRate('output_per_million'),
  };
}

export function getOpenAICompatibleSettings(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleSettings {
  const config = loadConfigFile(cwd).providers?.openai_compatible;

  const baseUrl =
    parseStringValue(config?.base_url) ??
    parseStringValue(env.OPENAI_COMPATIBLE_BASE_URL) ??
    null;
  const apiKeyEnv = parseStringValue(config?.api_key_env) ?? OPENAI_COMPATIBLE_DEFAULT_API_KEY_ENV;
  const apiKey = parseStringValue(env[apiKeyEnv]) ?? null;
  const defaultModel =
    parseStringValue(config?.default_model) ??
    parseStringValue(env.OPENAI_COMPATIBLE_MODEL) ??
    null;
  const headers = parseOpenAICompatibleHeaders(config?.headers);
  const pricing = parseOpenAICompatiblePricing(config?.pricing);

  return {
    baseUrl,
    apiKeyEnv,
    apiKey,
    defaultModel,
    headers,
    pricing,
  };
}

export function getDefaultCoderProvider(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseConfigProviderValue(config.agent?.coder?.provider, 'agent.coder.provider') ??
    DEFAULT_CONFIG.agent.coder.provider
  );
}

export function getDefaultCoderModel(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return config.agent?.coder?.model === null
    ? null
    : (parseStringValue(config.agent?.coder?.model) ?? DEFAULT_CONFIG.agent.coder.model);
}

export function getDefaultPlannerProvider(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseConfigProviderValue(config.agent?.planner?.provider, 'agent.planner.provider') ??
    getDefaultCoderProvider(cwd)
  );
}

export function getDefaultPlannerModel(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  const plannerProvider = parseConfigProviderValue(config.agent?.planner?.provider, 'agent.planner.provider');
  if (hasOwnConfigKey(config.agent?.planner, 'model')) {
    return config.agent.planner.model === null
      ? null
      : (parseStringValue(config.agent.planner.model) ?? null);
  }
  if (plannerProvider) {
    return DEFAULT_CONFIG.agent.planner.model;
  }

  return getDefaultCoderModel(cwd);
}

export function getDefaultReviewerProvider(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseConfigProviderValue(config.agent?.reviewer?.provider, 'agent.reviewer.provider') ??
    DEFAULT_CONFIG.agent.reviewer.provider
  );
}

export function getDefaultReviewerModel(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return config.agent?.reviewer?.model === null
    ? null
    : (parseStringValue(config.agent?.reviewer?.model) ?? DEFAULT_CONFIG.agent.reviewer.model);
}

export function getDefaultCoderEffort(cwd = process.cwd()): string | null {
  const config = loadConfigFile(cwd);
  return parseStringValue(config.agent?.coder?.effort) ?? null;
}

export function getDefaultReviewerEffort(cwd = process.cwd()): string | null {
  const config = loadConfigFile(cwd);
  return parseStringValue(config.agent?.reviewer?.effort) ?? null;
}

export function getDefaultPlannerEffort(cwd = process.cwd()): string | null {
  const config = loadConfigFile(cwd);
  const plannerProvider = parseConfigProviderValue(config.agent?.planner?.provider, 'agent.planner.provider');
  if (hasOwnConfigKey(config.agent?.planner, 'effort')) {
    return parseStringValue(config.agent.planner.effort) ?? null;
  }
  if (plannerProvider) {
    return null;
  }

  return getDefaultCoderEffort(cwd);
}
