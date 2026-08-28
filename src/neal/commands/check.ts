import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import process from 'node:process';

import { verifyNotification } from '../../notifier.js';
import { parseCheckArgs } from '../cli.js';
import {
  assertWriterProvidersConfigured,
  getAgentTurnRetryLimit,
  getAgentTurnStartupTimeoutMs,
  getApiRetryLimit,
  getFinalCompletionContinueExecutionMax,
  getInactivityTimeoutMs,
  getInteractiveBlockedRecoveryMaxTurns,
  getMaxReviewRounds,
  getNotifyBin,
  getPhaseHeartbeatMs,
  getReviewLevel,
  getReviewStuckWindow,
} from '../config.js';
import { getNealDirGitIgnoreStatus } from '../git.js';
import { collectGuidanceDiagnostics, USER_GUIDANCE_MAX_CHARS } from '../prompts/guidance.js';
import { runWithAgentTurnLiveness } from '../providers/liveness.js';
import {
  getCoderAdapter,
  getProviderDefinition,
  getStructuredAdvisorAdapter,
} from '../providers/registry.js';
import { sanitizeSensitiveText } from '../sensitive-text.js';
import type { ProviderRuntimeEvent, StructuredJsonProtocolSpec } from '../providers/types.js';
import type { AgentConfig, AgentRoleConfig } from '../types.js';

type InputStream = Readable & { isTTY?: boolean };

export type NealCheckCliOptions = {
  cwd?: string;
  stdin?: InputStream;
  stdout?: Writable;
  confirmProviderVerification?: () => Promise<boolean> | boolean;
  verifyProviderConnectivity?: (args: {
    cwd: string;
    agentConfig: AgentConfig;
    stdout: Writable;
  }) => Promise<void>;
  confirmNotificationTest?: () => Promise<boolean> | boolean;
  verifyNotificationScript?: (args: {
    cwd: string;
    stdout: Writable;
  }) => Promise<void>;
};

type ProviderCheckPayload = {
  ok: boolean;
  message: string;
};

class CheckDisplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckDisplayError';
  }
}

const PROVIDER_CHECK_TOKEN = 'NEAL_CHECK_PROVIDER_OK';
const PROVIDER_CHECK_TIMEOUT_MS = 120_000;
const PROVIDER_STDERR_DETAIL_MAX_CHARS = 4000;

function writeLine(stdout: Writable, message: string) {
  stdout.write(`${message}\n`);
}

function write(stdout: Writable, message: string) {
  stdout.write(message);
}

function formatIndentedBlock(lines: readonly string[]) {
  return lines.map((line) => `  ${line}`).join('\n');
}

function resolveCheckTimeout(cwd: string) {
  return Math.min(getInactivityTimeoutMs(cwd), PROVIDER_CHECK_TIMEOUT_MS);
}

function sameRoleConfig(left: AgentRoleConfig, right: AgentRoleConfig) {
  return left.provider === right.provider
    && left.model === right.model
    && (left.effort ?? null) === (right.effort ?? null);
}

function describeRole(role: 'planner' | 'coder' | 'reviewer', config: AgentRoleConfig, options: {
  inheritsCoder?: boolean;
} = {}) {
  const definition = getProviderDefinition(config.provider);
  const model = config.model ?? 'provider default';
  const effort = config.effort ?? 'provider default';
  const inherited = options.inheritsCoder ? ' (inherits coder)' : '';
  return `${role}: ${definition.displayName} (${config.provider}), model: ${model}, effort: ${effort}${inherited}`;
}

type ProviderVerificationRole = 'planner' | 'coder' | 'reviewer';

type ProviderVerificationGroup = {
  config: AgentRoleConfig;
  roles: ProviderVerificationRole[];
};

function describeProviderForVerification(roles: readonly ProviderVerificationRole[], config: AgentRoleConfig) {
  const definition = getProviderDefinition(config.provider);
  const model = config.model ?? 'provider default model';
  const effort = config.effort ?? 'provider default effort';
  return `${definition.displayName} (${config.provider}), ${model}, ${effort} [${roles.join(', ')}]`;
}

function describeNotificationScript(notifyBin: string | null) {
  return `notification script: ${notifyBin ?? 'not configured'}`;
}

function validateConfig(cwd: string) {
  const agentConfig = assertWriterProvidersConfigured(cwd, {
    context: 'neal check',
    guidance: 'check',
  });

  // Exercise all current scalar config readers before provider verification is
  // offered, even when defaults are used.
  getPhaseHeartbeatMs(cwd);
  getMaxReviewRounds(cwd);
  getReviewStuckWindow(cwd);
  getInactivityTimeoutMs(cwd);
  getApiRetryLimit(cwd);
  getInteractiveBlockedRecoveryMaxTurns(cwd);
  getFinalCompletionContinueExecutionMax(cwd);
  getNotifyBin(cwd);
  getReviewLevel(cwd);

  return agentConfig;
}

async function promptForProviderVerification(stdin: InputStream, stdout: Writable) {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(
      'Verify providers now? This sends one small prompt to each unique configured provider/model. [Y/n] ',
    );
    const trimmed = answer.trim();
    if (!trimmed) {
      return true;
    }
    return !/^n(?:o)?$/i.test(trimmed);
  } finally {
    readline.close();
  }
}

async function promptForNotificationTest(stdin: InputStream, stdout: Writable) {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question('Test notification script now? [Y/n] ');
    const trimmed = answer.trim();
    if (!trimmed) {
      return true;
    }
    return !/^n(?:o)?$/i.test(trimmed);
  } finally {
    readline.close();
  }
}

function buildProviderCheckSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
    },
    required: ['ok', 'message'],
    additionalProperties: false,
  } as const;
}

function validateProviderCheckPayload(payload: unknown): ProviderCheckPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('provider returned an invalid check payload');
  }

  const value = payload as Record<string, unknown>;
  if (typeof value.ok !== 'boolean' || typeof value.message !== 'string') {
    throw new Error('provider returned an invalid check payload');
  }

  return {
    ok: value.ok,
    message: value.message,
  };
}

function buildProviderCheckProtocolSpec(
  schema: Record<string, unknown>,
): StructuredJsonProtocolSpec<ProviderCheckPayload> {
  return {
    protocol: 'neal-json-block-v1',
    schemaLabel: 'provider_check_payload',
    schema,
    validator: validateProviderCheckPayload,
    repairAttemptLimit: 1,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function removeProviderLoginHint(message: string) {
  return message
    .replace(/\s*[·-]\s*Please run\s+\/login\.?/giu, '')
    .replace(/\bPlease run\s+\/login\.?/giu, '')
    .trim();
}

function stripProviderProcessNoise(message: string) {
  return message
    .replace(/\bReading prompt from stdin\.\.\./giu, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^warning: proceeding, even though we could not update path:/iu.test(line))
    .join('\n');
}

function summarizeKnownCheckFailure(message: string) {
  if (/dangerously-skip-permissions.*root\/sudo privileges|root\/sudo privileges.*dangerously-skip-permissions/isu.test(message)) {
    return [
      'Claude Code refused bypass-permissions mode while running as root.',
      'Run Neal from a non-root user, then run `neal check` again.',
    ];
  }

  if (/not inside a trusted directory/iu.test(message)) {
    return [
      'OpenAI Codex has not trusted this directory yet.',
      'Complete the provider\'s normal local trust/setup step for the current directory, then run `neal check` again.',
    ];
  }

  if (/failed to record rollout items|thread .* not found/iu.test(message)) {
    return [
      'OpenAI Codex could not persist the check session.',
      'Run `neal check` again. If this repeats, complete the provider\'s normal local setup again.',
    ];
  }

  if (/\bnot logged in\b/iu.test(message)) {
    return [
      message,
      'Provider auth is configured outside of Neal. Complete the provider\'s normal local auth setup, then run `neal check` again.',
    ];
  }

  return null;
}

function appendBoundedProviderStderr(current: string, next: string) {
  const combined = current ? `${current}\n${next}` : next;
  if (combined.length <= PROVIDER_STDERR_DETAIL_MAX_CHARS) {
    return combined;
  }
  return combined.slice(combined.length - PROVIDER_STDERR_DETAIL_MAX_CHARS);
}

function collectCheckProviderStderr() {
  let stderr = '';
  return {
    events(event: ProviderRuntimeEvent) {
      if (
        event.type === 'tool_progress' &&
        event.toolName === 'stderr' &&
        typeof event.message === 'string' &&
        event.message.trim() !== ''
      ) {
        stderr = appendBoundedProviderStderr(stderr, event.message.trim());
      }
    },
    detail() {
      return stderr;
    },
  };
}

function buildProviderVerificationGroups(agentConfig: AgentConfig): ProviderVerificationGroup[] {
  const groups: ProviderVerificationGroup[] = [];
  const entries: Array<{ role: ProviderVerificationRole; config: AgentRoleConfig }> = [
    { role: 'planner', config: agentConfig.planner },
    { role: 'coder', config: agentConfig.coder },
    { role: 'reviewer', config: agentConfig.reviewer },
  ];

  for (const entry of entries) {
    const existing = groups.find((group) =>
      group.config.provider === entry.config.provider
      && group.config.model === entry.config.model
      && (group.config.effort ?? null) === (entry.config.effort ?? null)
    );
    if (existing) {
      existing.roles.push(entry.role);
      continue;
    }

    groups.push({
      config: entry.config,
      roles: [entry.role],
    });
  }

  return groups;
}

function shouldVerifyWithCoderAdapter(roles: readonly ProviderVerificationRole[]) {
  return roles.includes('planner') || roles.includes('coder');
}

function formatCheckFailureDetail(error: unknown, providerStderr = '') {
  const errorMessage = stripProviderProcessNoise(removeProviderLoginHint(getErrorMessage(error)));
  const stderrMessage = stripProviderProcessNoise(removeProviderLoginHint(providerStderr));
  const message = sanitizeSensitiveText([stderrMessage, errorMessage]
    .filter((part) => part.trim().length > 0)
    .join('\n'));
  const summary = summarizeKnownCheckFailure(message);
  if (summary) {
    return formatIndentedBlock(summary);
  }

  return formatIndentedBlock(message.split('\n'));
}

export async function verifyConfiguredProviders(args: {
  cwd: string;
  agentConfig: AgentConfig;
  stdout: Writable;
}) {
  const inactivityTimeoutMs = resolveCheckTimeout(args.cwd);
  const apiRetryLimit = getApiRetryLimit(args.cwd);
  // The clamp keeps the short check timeout authoritative: the startup-silence
  // timer must never extend beyond resolveCheckTimeout's window.
  const startupTimeoutMs = Math.min(getAgentTurnStartupTimeoutMs(args.cwd), inactivityTimeoutMs);
  const agentTurnRetryLimit = getAgentTurnRetryLimit(args.cwd);
  const providerCheckSchema = buildProviderCheckSchema();
  const providerCheckProtocol = buildProviderCheckProtocolSpec(providerCheckSchema);

  for (const group of buildProviderVerificationGroups(args.agentConfig)) {
    write(args.stdout, `  Verifying ${describeProviderForVerification(group.roles, group.config)}...`);
    const events = collectCheckProviderStderr();
    try {
      if (shouldVerifyWithCoderAdapter(group.roles)) {
        const provider = getCoderAdapter(group.config);
        // No RunLogger exists for `neal check`; the supervisor tolerates that.
        const result = await runWithAgentTurnLiveness({
          provider: group.config.provider,
          role: 'coder',
          label: 'provider-check',
          startupTimeoutMs,
          retryLimit: agentTurnRetryLimit,
          baseSink: events.events,
          run: (sink, attempt) =>
            provider.runStructuredPrompt<ProviderCheckPayload>({
              cwd: args.cwd,
              inactivityTimeoutMs,
              skipGitRepoCheck: true,
              events: sink,
              signal: attempt.signal,
              schema: providerCheckSchema,
              label: 'Provider check',
              structuredJsonProtocol: providerCheckProtocol,
              prompt: [
                'You are running `neal check`, a configuration and connectivity check.',
                `Return { "ok": true, "message": "${PROVIDER_CHECK_TOKEN}" }.`,
                'Do not inspect files, modify files, run commands, or create commits.',
              ].join('\n'),
            }),
        });

        const payload = result.structured;
        if (payload.ok !== true || !payload.message.includes(PROVIDER_CHECK_TOKEN)) {
          throw new Error('provider did not return the expected check payload');
        }
      } else {
        const provider = getStructuredAdvisorAdapter(group.config);
        const result = await runWithAgentTurnLiveness({
          provider: group.config.provider,
          role: 'structured-advisor',
          label: 'provider-check',
          startupTimeoutMs,
          retryLimit: agentTurnRetryLimit,
          baseSink: events.events,
          run: (sink, attempt) =>
            provider.runStructuredRound<ProviderCheckPayload>({
              label: 'provider-check',
              cwd: args.cwd,
              inactivityTimeoutMs,
              apiRetryLimit,
              skipGitRepoCheck: true,
              schema: providerCheckSchema,
              structuredJsonProtocol: providerCheckProtocol,
              events: sink,
              signal: attempt.signal,
              prompt: [
                'You are running `neal check`, a configuration and connectivity check.',
                `Return { "ok": true, "message": "${PROVIDER_CHECK_TOKEN}" }.`,
                'Do not inspect files, modify files, run commands, or create commits.',
              ].join('\n'),
            }),
        });

        if (result.structured.ok !== true || !result.structured.message.includes(PROVIDER_CHECK_TOKEN)) {
          throw new Error('provider did not return the expected check payload');
        }
      }

      writeLine(args.stdout, 'ok');
    } catch (error) {
      writeLine(args.stdout, 'failed');
      throw new CheckDisplayError(formatCheckFailureDetail(error, events.detail()));
    }
  }
}

export async function verifyConfiguredNotificationScript(args: {
  cwd: string;
  stdout: Writable;
}) {
  write(args.stdout, '  Testing notification script...');
  try {
    const notifyPath = await verifyNotification(args.cwd);
    if (!notifyPath) {
      throw new Error('notification script is not configured');
    }
    writeLine(args.stdout, 'ok');
  } catch (error) {
    writeLine(args.stdout, 'failed');
    throw new CheckDisplayError(formatCheckFailureDetail(error));
  }
}

export async function runNealCheckCli(options: NealCheckCliOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const verifyProviderConnectivity = options.verifyProviderConnectivity ?? verifyConfiguredProviders;
  const verifyNotificationScript = options.verifyNotificationScript ?? verifyConfiguredNotificationScript;
  const agentConfig = validateConfig(cwd);
  const notifyBin = getNotifyBin(cwd);

  writeLine(stdout, 'Config: ok');
  writeLine(stdout, `  ${describeRole('planner', agentConfig.planner, {
    inheritsCoder: sameRoleConfig(agentConfig.planner, agentConfig.coder),
  })}`);
  writeLine(stdout, `  ${describeRole('coder', agentConfig.coder)}`);
  writeLine(stdout, `  ${describeRole('reviewer', agentConfig.reviewer)}`);
  writeLine(stdout, `  ${describeNotificationScript(notifyBin)}`);
  for (const entry of collectGuidanceDiagnostics()) {
    if (entry.chars > USER_GUIDANCE_MAX_CHARS) {
      writeLine(
        stdout,
        `  warning: ${entry.role} guidance at ${entry.path} is ${entry.chars} characters; prompts inline the first ${USER_GUIDANCE_MAX_CHARS} and truncate the rest. Trim the file.`,
      );
    }
  }
  writeLine(stdout, '');

  // Native adapters drive their providers directly; any other writer provider is
  // an openai-compatible model that should be qualified end-to-end with `neal compat`.
  const NATIVE_WRITER_PROVIDERS = new Set(['openai-codex', 'anthropic-claude']);
  if (
    !NATIVE_WRITER_PROVIDERS.has(agentConfig.coder.provider) ||
    !NATIVE_WRITER_PROVIDERS.has(agentConfig.reviewer.provider)
  ) {
    writeLine(
      stdout,
      'This is an openai-compatible model - run `neal compat` to confirm it can drive the full loop.',
    );
    writeLine(stdout, '');
  }

  const ignoreStatus = await getNealDirGitIgnoreStatus(cwd);
  if (ignoreStatus.kind === 'not_ignored') {
    writeLine(
      stdout,
      '.neal/ is not ignored by Git. Run `neal setup` to add `.neal/` to `.git/info/exclude`, or add `.neal/` to your repository `.gitignore`.',
    );
    writeLine(stdout, '');
  }

  let shouldVerify: boolean;
  if (options.confirmProviderVerification) {
    shouldVerify = await options.confirmProviderVerification();
  } else if (stdin.isTTY === true) {
    shouldVerify = await promptForProviderVerification(stdin, stdout);
  } else {
    writeLine(
      stdout,
      'Provider verification skipped: non-interactive input. Run `neal check` from an interactive terminal to opt in.',
    );
    return;
  }

  if (!shouldVerify) {
    writeLine(stdout, 'Provider verification skipped.');
  } else {
    await verifyProviderConnectivity({ cwd, agentConfig, stdout });
  }

  if (notifyBin) {
    writeLine(stdout, '');

    let shouldTestNotification: boolean;
    if (options.confirmNotificationTest) {
      shouldTestNotification = await options.confirmNotificationTest();
    } else if (stdin.isTTY === true) {
      shouldTestNotification = await promptForNotificationTest(stdin, stdout);
    } else {
      writeLine(stdout, 'Notification test skipped: non-interactive input.');
      return;
    }

    if (shouldTestNotification) {
      await verifyNotificationScript({ cwd, stdout });
    } else {
      writeLine(stdout, 'Notification test skipped.');
    }
  }
}

export async function runCheckCommand(args: string[]) {
  parseCheckArgs(args);
  await runNealCheckCli();
}
