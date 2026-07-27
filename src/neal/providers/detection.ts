import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { getClaudeCodeExecutablePath } from './anthropic-claude.js';
import { listRegisteredProviderDefinitions } from './registry.js';
import { getOpenAICompatibleSettings, type OpenAICompatibleSettings } from '../config.js';
import type { AgentProvider } from '../types.js';

export type ProviderDetection = {
  provider: AgentProvider;
  displayName: string;
  runtimeAvailable: boolean;
  details: string[];
};

export type ProviderDetectionOptions = {
  resolvePackage?: (specifier: string) => string;
  resolveClaudeExecutable?: () => string | undefined;
  fileExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  pathDelimiter?: string;
  cwd?: string;
  resolveOpenAICompatibleSettings?: (cwd: string) => OpenAICompatibleSettings;
};

function defaultResolvePackage(specifier: string) {
  return import.meta.resolve(specifier);
}

function findExecutableOnPath(
  executable: string,
  options: Pick<Required<ProviderDetectionOptions>, 'fileExists' | 'env' | 'pathDelimiter'>,
) {
  const pathValue = options.env.PATH ?? '';
  for (const dir of pathValue.split(options.pathDelimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, executable);
    if (options.fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function detectOpenAICodex(options: Required<ProviderDetectionOptions>) {
  try {
    const runtimePath = options.resolvePackage('@openai/codex-sdk');
    return {
      runtimeAvailable: true,
      details: [`SDK runtime resolved at ${runtimePath}`],
    };
  } catch {
    return {
      runtimeAvailable: false,
      details: ['SDK runtime @openai/codex-sdk was not resolved'],
    };
  }
}

function detectAnthropicClaude(options: Required<ProviderDetectionOptions>) {
  const details: string[] = [];
  const bundledPath = options.resolveClaudeExecutable();
  if (bundledPath) {
    details.push(`SDK-bundled Claude executable resolved at ${bundledPath}`);
  } else {
    details.push('SDK-bundled Claude executable was not resolved');
  }

  const pathExecutable = findExecutableOnPath('claude', options);
  if (pathExecutable) {
    details.push(`standalone claude executable found on PATH at ${pathExecutable}`);
  } else {
    details.push('standalone claude executable was not found on PATH');
  }

  return {
    runtimeAvailable: Boolean(bundledPath || pathExecutable),
    details,
  };
}

function detectOpenAICompatible(options: Required<ProviderDetectionOptions>) {
  const settings = options.resolveOpenAICompatibleSettings(options.cwd);
  const details: string[] = [];

  if (settings.baseUrl !== null) {
    details.push(`base URL configured: ${settings.baseUrl}`);
  } else {
    details.push('base URL is missing: set providers.openai_compatible.base_url or env OPENAI_COMPATIBLE_BASE_URL');
  }

  if (settings.apiKey !== null) {
    details.push(`API key resolved from env ${settings.apiKeyEnv}`);
  } else {
    details.push(`API key is missing: set env ${settings.apiKeyEnv} (named by providers.openai_compatible.api_key_env)`);
  }

  if (settings.defaultModel !== null) {
    details.push(`default model configured: ${settings.defaultModel}`);
  } else {
    details.push(
      'default model is missing: set providers.openai_compatible.default_model or env OPENAI_COMPATIBLE_MODEL, or configure a role-level model (for example agent.reviewer.model)',
    );
  }

  return {
    runtimeAvailable: settings.baseUrl !== null && settings.apiKey !== null && settings.defaultModel !== null,
    details,
  };
}

export function detectBuiltInProviders(options: ProviderDetectionOptions = {}): ProviderDetection[] {
  const env = options.env ?? process.env;
  const resolvedOptions: Required<ProviderDetectionOptions> = {
    resolvePackage: options.resolvePackage ?? defaultResolvePackage,
    resolveClaudeExecutable: options.resolveClaudeExecutable ?? getClaudeCodeExecutablePath,
    fileExists: options.fileExists ?? existsSync,
    env,
    pathDelimiter: options.pathDelimiter ?? delimiter,
    cwd: options.cwd ?? process.cwd(),
    resolveOpenAICompatibleSettings:
      options.resolveOpenAICompatibleSettings ?? ((cwd) => getOpenAICompatibleSettings(cwd, env)),
  };

  // openai-compatible resolves from the shared settings surface
  // (providers.openai_compatible + env fallbacks). Memoized so the settings
  // resolver still runs at most once per detection pass.
  let sharedOpenAICompatibleDetection: { runtimeAvailable: boolean; details: string[] } | undefined;
  const detectFromSharedOpenAICompatibleSettings = () => {
    sharedOpenAICompatibleDetection ??= detectOpenAICompatible(resolvedOptions);
    return {
      runtimeAvailable: sharedOpenAICompatibleDetection.runtimeAvailable,
      details: [...sharedOpenAICompatibleDetection.details],
    };
  };

  return listRegisteredProviderDefinitions()
    .filter((definition) => (
      definition.capabilities.coder.supported ||
      definition.capabilities['structured-advisor'].supported
    ))
    .map((definition) => {
      let detection: { runtimeAvailable: boolean; details: string[] };
      switch (definition.id) {
        case 'openai-codex':
          detection = detectOpenAICodex(resolvedOptions);
          break;
        case 'anthropic-claude':
          detection = detectAnthropicClaude(resolvedOptions);
          break;
        case 'openai-compatible':
          detection = detectFromSharedOpenAICompatibleSettings();
          break;
        default:
          detection = {
            runtimeAvailable: false,
            details: ['No local detector is available for this provider'],
          };
          break;
      }

      return {
        provider: definition.id,
        displayName: definition.displayName,
        runtimeAvailable: detection.runtimeAvailable,
        details: detection.details,
      };
    });
}
