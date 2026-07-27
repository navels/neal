import { writeDetail, writeErrorDetail } from '../diagnostic.js';
import { getHeadCommit } from '../git.js';
import type { RunLogger } from '../logger.js';
import type { ProviderEventSink, ProviderId, ProviderRole, ProviderRuntimeEvent } from './types.js';

export type ProviderTelemetrySinkOptions = {
  logger?: RunLogger;
  provider: ProviderId;
  role: ProviderRole;
  label?: string;
  cwd: string;
};

type ResolvedProviderRuntimeEvent = ProviderRuntimeEvent & {
  provider: ProviderId;
  role: ProviderRole;
  label?: string;
};

export function providerShortName(provider: ProviderId) {
  switch (provider) {
    case 'openai-codex':
      return 'codex';
    case 'anthropic-claude':
      return 'claude';
    default:
      return provider;
  }
}

function detailRole(event: ResolvedProviderRuntimeEvent) {
  return event.label ?? event.role;
}

function detailPrefix(event: ResolvedProviderRuntimeEvent) {
  const provider = providerShortName(event.provider);
  if (event.provider === 'openai-codex' && event.role === 'coder' && !event.label) {
    return `[${provider}]`;
  }
  return `[${provider}:${detailRole(event)}]`;
}

function errorDetailPrefix(event: ResolvedProviderRuntimeEvent) {
  const prefix = detailPrefix(event);
  return `${prefix.slice(0, -1)}:error]`;
}

function formatExitCode(exitCode: number | null | undefined) {
  return typeof exitCode === 'number' ? `exit ${exitCode}` : 'exit unknown';
}

async function getGitHeadOrNull(cwd: string) {
  try {
    return await getHeadCommit(cwd);
  } catch {
    return null;
  }
}

function commonEventData(event: ResolvedProviderRuntimeEvent) {
  return {
    provider: event.provider,
    role: event.role,
    ...(event.label ? { label: event.label } : {}),
    ...(event.sessionHandle !== undefined ? { sessionHandle: event.sessionHandle } : {}),
    ...(event.providerData ? { providerData: event.providerData } : {}),
  };
}

async function writeRunEvent(event: ResolvedProviderRuntimeEvent, options: ProviderTelemetrySinkOptions) {
  const logger = options.logger;
  if (!logger) {
    return;
  }

  switch (event.type) {
    case 'session_started':
      await logger.event('provider.session_started', {
        ...commonEventData(event),
        sessionHandle: event.sessionHandle,
      });
      break;
    case 'turn_started':
      await logger.event('provider.turn_started', commonEventData(event));
      break;
    case 'turn_completed':
      await logger.event('provider.turn_completed', {
        ...commonEventData(event),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.costSource !== undefined ? { costSource: event.costSource } : {}),
      });
      break;
    case 'tool_started':
      await logger.event('provider.tool_started', {
        ...commonEventData(event),
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
      });
      break;
    case 'tool_progress':
      await logger.event('provider.tool_progress', {
        ...commonEventData(event),
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
        ...(event.message ? { message: event.message } : {}),
        ...(event.isError ? { isError: event.isError } : {}),
      });
      break;
    case 'command_completed': {
      const cwd = event.cwd ?? options.cwd;
      const gitHead = event.gitHead ?? await getGitHeadOrNull(cwd);
      await logger.event('provider.command_completed', {
        ...commonEventData(event),
        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
        command: event.command,
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        outputLength: event.outputLength ?? Buffer.byteLength(event.output ?? '', 'utf8'),
        cwd,
        gitHead,
      });
      break;
    }
    case 'file_changed':
      await logger.event('provider.file_changed', {
        ...commonEventData(event),
        files: event.files,
      });
      break;
    case 'assistant_text':
      await logger.event('provider.assistant_text', {
        ...commonEventData(event),
        text: event.text,
      });
      break;
    case 'assistant_thinking':
      await logger.event('provider.assistant_thinking', {
        ...commonEventData(event),
        ...(event.estimatedTokens !== undefined ? { estimatedTokens: event.estimatedTokens } : {}),
      });
      break;
    case 'structured_output_received':
      await logger.event('provider.structured_output_received', commonEventData(event));
      break;
    case 'usage_reported':
      await logger.event('provider.usage_reported', {
        ...commonEventData(event),
        usage: event.usage,
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.costSource !== undefined ? { costSource: event.costSource } : {}),
      });
      break;
    case 'provider_error':
      await logger.event('provider.provider_error', {
        ...commonEventData(event),
        message: event.message,
        ...(event.errorKind ? { errorKind: event.errorKind } : {}),
      });
      break;
  }
}

function renderDetail(event: ResolvedProviderRuntimeEvent, logger?: RunLogger) {
  const context = {
    provider: event.provider,
    role: detailRole(event),
  };

  switch (event.type) {
    case 'session_started':
      writeDetail(`${detailPrefix(event)} thread ${event.sessionHandle}\n`, logger, context);
      break;
    case 'tool_progress':
      if (!event.message) {
        break;
      }
      if (event.isError) {
        const message = event.message.endsWith('\n') ? event.message : `${event.message}\n`;
        writeErrorDetail(`${detailPrefix(event)} ${message}`, logger, context);
      } else {
        writeDetail(`${detailPrefix(event)} ${event.message}\n`, logger, context);
      }
      break;
    case 'command_completed':
      writeDetail(
        `\n$ ${event.command}\n${detailPrefix(event)} command ${event.status ?? 'completed'} (${formatExitCode(
          event.exitCode,
        )}, ${event.outputLength ?? Buffer.byteLength(event.output ?? '', 'utf8')} output bytes)\n`,
        logger,
        {
          ...context,
          commandSummary: event.command,
        },
      );
      if (event.output) {
        writeDetail(`${event.output}\n`, logger, {
          ...context,
          commandSummary: event.command,
        });
      }
      break;
    case 'file_changed':
      writeDetail(`${detailPrefix(event)} files ${event.files.join(', ')}\n`, logger, {
        ...context,
        fileCount: event.files.length,
      });
      break;
    case 'assistant_text':
      writeDetail(`${detailPrefix(event)} ${event.text}\n`, logger, context);
      break;
    case 'assistant_thinking':
      writeDetail(
        `${detailPrefix(event)} thinking${typeof event.estimatedTokens === 'number' ? ` (~${event.estimatedTokens} tokens)` : ''}\n`,
        logger,
        context,
      );
      break;
    case 'turn_completed': {
      const subtype = event.providerData?.subtype;
      if (typeof subtype === 'string' && subtype.trim()) {
        writeDetail(`${detailPrefix(event)} result: ${subtype}\n`, logger, context);
      }
      break;
    }
    case 'provider_error':
      writeErrorDetail(`${errorDetailPrefix(event)} ${event.message}\n`, logger, context);
      break;
    case 'turn_started':
    case 'tool_started':
    case 'structured_output_received':
    case 'usage_reported':
      break;
  }
}

export function createProviderTelemetrySink(options: ProviderTelemetrySinkOptions): ProviderEventSink {
  return async (event) => {
    const resolvedEvent = {
      ...event,
      provider: event.provider ?? options.provider,
      role: event.role ?? options.role,
      label: event.label ?? options.label,
    } as ResolvedProviderRuntimeEvent;

    renderDetail(resolvedEvent, options.logger);
    await writeRunEvent(resolvedEvent, options);
  };
}
