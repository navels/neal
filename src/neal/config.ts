import 'dotenv/config';

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

export type NealConfigFile = {
  neal?: {
    phase_heartbeat_ms?: number | null;
    max_review_rounds?: number | null;
    review_stuck_window?: number | null;
    inactivity_timeout_ms?: number | null;
    api_retry_limit?: number | null;
  };
  providers?: {
    'openai-codex'?: {
      inactivity_timeout_ms?: number | null;
    };
    'anthropic-claude'?: {
      inactivity_timeout_ms?: number | null;
      api_retry_limit?: number | null;
      max_turns?: number | null;
      continuation_limit?: number | null;
    };
  };
};

type NealResolvedConfig = {
  neal: {
    phase_heartbeat_ms: number;
    max_review_rounds: number;
    review_stuck_window: number;
    inactivity_timeout_ms: number;
    api_retry_limit: number;
  };
  providers: {
    'openai-codex': {
      inactivity_timeout_ms?: number | null;
    };
    'anthropic-claude': {
      inactivity_timeout_ms?: number | null;
      api_retry_limit?: number | null;
      max_turns: number;
      continuation_limit: number;
    };
  };
};

const DEFAULT_CONFIG: NealResolvedConfig = {
  neal: {
    phase_heartbeat_ms: 60_000,
    max_review_rounds: 20,
    review_stuck_window: 3,
    inactivity_timeout_ms: 600_000,
    api_retry_limit: 10,
  },
  providers: {
    'openai-codex': {},
    'anthropic-claude': {
      max_turns: 100,
      continuation_limit: 2,
    },
  },
};

const warnedKeys = new Set<string>();
const cachedConfig = new Map<string, NealConfigFile>();

function warnOnce(key: string, message: string) {
  if (warnedKeys.has(key)) {
    return;
  }
  warnedKeys.add(key);
  process.stderr.write(`${message}\n`);
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
    providers: {
      ...base.providers,
      'openai-codex': {
        ...base.providers?.['openai-codex'],
        ...override.providers?.['openai-codex'],
      },
      'anthropic-claude': {
        ...base.providers?.['anthropic-claude'],
        ...override.providers?.['anthropic-claude'],
      },
    },
  };
}

function loadConfigFile(cwd = process.cwd()): NealConfigFile {
  const cacheKey = resolve(cwd);
  const cached = cachedConfig.get(cacheKey);
  if (cached) {
    return cached;
  }

  const repoConfigPath = resolve(cacheKey, 'config.yml');
  const homeConfigPath = join(homedir(), '.config', 'neal', 'config.yml');

  const resolved = mergeConfig(
    mergeConfig({}, readYamlFileIfPresent(repoConfigPath)),
    readYamlFileIfPresent(homeConfigPath),
  );
  cachedConfig.set(cacheKey, resolved);
  return resolved;
}

function getStandardizedEnvNumber(name: string): number | undefined {
  return parseNumberValue(process.env[name]);
}

function getNealNumber(
  envName: string,
  yamlValue: unknown,
  fallback: number,
) {
  return getStandardizedEnvNumber(envName) ?? parseNumberValue(yamlValue) ?? fallback;
}

function getLegacyEnvNumber(
  standardizedEnvName: string,
  legacyEnvNames: string[],
): number | undefined {
  const values = legacyEnvNames
    .map((name) => ({ name, value: parseNumberValue(process.env[name]) }))
    .filter((entry): entry is { name: string; value: number } => entry.value !== undefined);

  if (values.length === 0) {
    return undefined;
  }

  for (const entry of values) {
    warnOnce(
      `legacy-env:${entry.name}`,
      `[neal] ${entry.name} is deprecated; migrate to ${standardizedEnvName}.`,
    );
  }

  const first = values[0];
  const conflict = values.find((entry) => entry.value !== first.value);
  if (conflict) {
    warnOnce(
      `legacy-env-conflict:${standardizedEnvName}`,
      `[neal] Conflicting legacy env vars for ${standardizedEnvName}; using ${first.name}=${first.value} and ignoring ${conflict.name}=${conflict.value}. Migrate to ${standardizedEnvName}.`,
    );
  }

  return first.value;
}

function getLegacyYamlNumber(
  standardizedYamlPath: string,
  standardizedEnvName: string,
  entries: Array<{ path: string; value: number | undefined }>,
): number | undefined {
  const values = entries.filter((entry): entry is { path: string; value: number } => entry.value !== undefined);

  if (values.length === 0) {
    return undefined;
  }

  for (const entry of values) {
    warnOnce(
      `legacy-yaml:${entry.path}`,
      `[neal] ${entry.path} is deprecated; migrate to ${standardizedYamlPath} or ${standardizedEnvName}.`,
    );
  }

  const first = values[0];
  const conflict = values.find((entry) => entry.value !== first.value);
  if (conflict) {
    warnOnce(
      `legacy-yaml-conflict:${standardizedYamlPath}`,
      `[neal] Conflicting legacy YAML keys for ${standardizedYamlPath}; using ${first.path}=${first.value} and ignoring ${conflict.path}=${conflict.value}. Migrate to ${standardizedYamlPath} or ${standardizedEnvName}.`,
    );
  }

  return first.value;
}

export function getInactivityTimeoutMs(cwd = process.cwd()) {
  const legacyEnv = getLegacyEnvNumber('NEAL_INACTIVITY_TIMEOUT_MS', [
    'CODEX_INACTIVITY_TIMEOUT_MS',
    'CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS',
  ]);
  const standardizedEnv = getStandardizedEnvNumber('NEAL_INACTIVITY_TIMEOUT_MS');
  if (standardizedEnv !== undefined) {
    return standardizedEnv;
  }
  if (legacyEnv !== undefined) {
    return legacyEnv;
  }

  const config = loadConfigFile(cwd);
  const legacyYaml = getLegacyYamlNumber('neal.inactivity_timeout_ms', 'NEAL_INACTIVITY_TIMEOUT_MS', [
    {
      path: 'providers.openai-codex.inactivity_timeout_ms',
      value: parseNumberValue(config.providers?.['openai-codex']?.inactivity_timeout_ms),
    },
    {
      path: 'providers.anthropic-claude.inactivity_timeout_ms',
      value: parseNumberValue(config.providers?.['anthropic-claude']?.inactivity_timeout_ms),
    },
  ]);
  const standardizedYaml = parseNumberValue(config.neal?.inactivity_timeout_ms);
  if (standardizedYaml !== undefined) {
    return standardizedYaml;
  }
  if (legacyYaml !== undefined) {
    return legacyYaml;
  }

  return DEFAULT_CONFIG.neal.inactivity_timeout_ms;
}

export function getApiRetryLimit(cwd = process.cwd()) {
  const legacyEnv = getLegacyEnvNumber('NEAL_API_RETRY_LIMIT', [
    'CLAUDE_API_RETRY_LIMIT',
    'CLAUDE_REVIEW_API_RETRY_LIMIT',
  ]);
  const standardizedEnv = getStandardizedEnvNumber('NEAL_API_RETRY_LIMIT');
  if (standardizedEnv !== undefined) {
    return standardizedEnv;
  }
  if (legacyEnv !== undefined) {
    return legacyEnv;
  }

  const config = loadConfigFile(cwd);
  const legacyYaml = getLegacyYamlNumber('neal.api_retry_limit', 'NEAL_API_RETRY_LIMIT', [
    {
      path: 'providers.anthropic-claude.api_retry_limit',
      value: parseNumberValue(config.providers?.['anthropic-claude']?.api_retry_limit),
    },
  ]);
  const standardizedYaml = parseNumberValue(config.neal?.api_retry_limit);
  if (standardizedYaml !== undefined) {
    return standardizedYaml;
  }
  if (legacyYaml !== undefined) {
    return legacyYaml;
  }

  return DEFAULT_CONFIG.neal.api_retry_limit;
}

export function getClaudeMaxTurns(cwd = process.cwd()) {
  const envValue = parseNumberValue(process.env.CLAUDE_REVIEW_MAX_TURNS);
  if (envValue !== undefined) {
    return envValue;
  }

  const config = loadConfigFile(cwd);
  return parseNumberValue(config.providers?.['anthropic-claude']?.max_turns) ?? DEFAULT_CONFIG.providers['anthropic-claude'].max_turns;
}

export function getClaudeContinuationLimit(cwd = process.cwd()) {
  const envValue = parseNumberValue(process.env.CLAUDE_REVIEW_CONTINUATION_LIMIT);
  if (envValue !== undefined) {
    return envValue;
  }

  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.providers?.['anthropic-claude']?.continuation_limit) ??
    DEFAULT_CONFIG.providers['anthropic-claude'].continuation_limit
  );
}

export function getPhaseHeartbeatMs(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return getNealNumber('NEAL_PHASE_HEARTBEAT_MS', config.neal?.phase_heartbeat_ms, DEFAULT_CONFIG.neal.phase_heartbeat_ms);
}

export function getMaxReviewRounds(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return getNealNumber('NEAL_MAX_REVIEW_ROUNDS', config.neal?.max_review_rounds, DEFAULT_CONFIG.neal.max_review_rounds);
}

export function getReviewStuckWindow(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return getNealNumber('NEAL_REVIEW_STUCK_WINDOW', config.neal?.review_stuck_window, DEFAULT_CONFIG.neal.review_stuck_window);
}
