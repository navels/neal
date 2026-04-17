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
    interactive_blocked_recovery_max_turns?: number | null;
    notify_bin?: string | null;
  };
  providers?: {
    'anthropic-claude'?: {
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
    interactive_blocked_recovery_max_turns: number;
    notify_bin: string;
  };
  providers: {
    'anthropic-claude': {
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
    interactive_blocked_recovery_max_turns: 3,
    notify_bin: resolve(homedir(), 'bin/notify'),
  },
  providers: {
    'anthropic-claude': {
      max_turns: 100,
      continuation_limit: 2,
    },
  },
};

const cachedConfig = new Map<string, NealConfigFile>();

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

export function getClaudeMaxTurns(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.providers?.['anthropic-claude']?.max_turns) ??
    DEFAULT_CONFIG.providers['anthropic-claude'].max_turns
  );
}

export function getClaudeContinuationLimit(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.providers?.['anthropic-claude']?.continuation_limit) ??
    DEFAULT_CONFIG.providers['anthropic-claude'].continuation_limit
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

export function getInteractiveBlockedRecoveryMaxTurns(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseNumberValue(config.neal?.interactive_blocked_recovery_max_turns) ??
    DEFAULT_CONFIG.neal.interactive_blocked_recovery_max_turns
  );
}

export function getNotifyBin(cwd = process.cwd()) {
  const config = loadConfigFile(cwd);
  return (
    parseStringValue(config.neal?.notify_bin) ??
    DEFAULT_CONFIG.neal.notify_bin
  );
}
