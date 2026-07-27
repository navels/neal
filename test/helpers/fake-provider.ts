import type {
  CoderAdapter,
  CoderRunPromptArgs,
  CoderRunPromptResult,
  CoderStructuredPromptArgs,
  CoderStructuredPromptResult,
  NealProviderDefinition,
  ProviderAdapterOptions,
  ProviderCapabilities,
  ProviderEventSink,
  ProviderId,
  ProviderRuntimeEvent,
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../../src/neal/providers/types.js';

type EventCapableArgs = {
  events?: ProviderEventSink;
};

export type FakeProviderOptions = {
  id?: ProviderId;
  displayName?: string;
  capabilities?: ProviderCapabilities;
  includeCoderAdapter?: boolean;
  includeStructuredAdvisorAdapter?: boolean;
  coderResponses?: (string | Partial<CoderRunPromptResult>)[];
  coderStructuredResponses?: unknown[];
  structuredAdvisorResponses?: unknown[];
  coderSessionHandle?: string | null;
  structuredAdvisorSessionHandle?: string | null;
  emittedProviderEvents?: ProviderRuntimeEvent[];
  onCoderRun?: (args: CoderRunPromptArgs) => void | Promise<void>;
  onCoderStructuredRun?: (args: CoderStructuredPromptArgs) => void | Promise<void>;
  onStructuredAdvisorRun?: (args: StructuredAdvisorRoundArgs) => void | Promise<void>;
  onCreateCoderAdapter?: (options?: ProviderAdapterOptions) => void;
  onCreateStructuredAdvisorAdapter?: (options?: ProviderAdapterOptions) => void;
  coderError?: Error;
  structuredAdvisorError?: Error;
};

export const fakeProviderDefaultCapabilities: ProviderCapabilities = {
  coder: {
    supported: true,
    toolAccess: {
      read: true,
      write: true,
      shell: true,
    },
    supportsSessionResume: true,
    supportsModelOverride: true,
    supportsStructuredOutput: true,
    usageReporting: 'none',
  },
  'structured-advisor': {
    supported: true,
    // Reviewers are read-only: write:false, shell:false (read unconstrained).
    // registerProviderDefinitionForTesting enforces this invariant, so the
    // default fake reviewer capability must comply.
    toolAccess: {
      read: true,
      write: false,
      shell: false,
    },
    supportsSessionResume: true,
    supportsModelOverride: true,
    supportsStructuredOutput: true,
    usageReporting: 'none',
  },
};

function responseAt<T>(responses: T[], index: number, fallback: T): T {
  if (responses.length === 0) {
    return fallback;
  }
  return responses[Math.min(index, responses.length - 1)] ?? fallback;
}

async function emitConfiguredEvents(args: EventCapableArgs, events: ProviderRuntimeEvent[]) {
  for (const event of events) {
    await args.events?.(event);
  }
}

export function createFakeProviderDefinition(options: FakeProviderOptions = {}): NealProviderDefinition {
  const id = options.id ?? 'fake-provider';
  const coderSessionHandle = options.coderSessionHandle ?? `${id}-coder-session`;
  const structuredAdvisorSessionHandle = options.structuredAdvisorSessionHandle ?? `${id}-advisor-session`;
  const emittedProviderEvents = options.emittedProviderEvents ?? [];
  let coderRunCount = 0;
  let coderStructuredRunCount = 0;
  let structuredAdvisorRunCount = 0;

  class FakeCoderAdapter implements CoderAdapter {
    async runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult> {
      await emitConfiguredEvents(args as EventCapableArgs, emittedProviderEvents);
      await options.onCoderRun?.(args);
      if (options.coderError) {
        throw options.coderError;
      }

      const response = responseAt(options.coderResponses ?? [], coderRunCount, 'fake coder response');
      coderRunCount += 1;
      if (typeof response === 'string') {
        return {
          sessionHandle: coderSessionHandle,
          finalResponse: response,
        };
      }

      return {
        sessionHandle: response.sessionHandle ?? coderSessionHandle,
        finalResponse: response.finalResponse ?? 'fake coder response',
      };
    }

    async runStructuredPrompt<TStructured>(
      args: CoderStructuredPromptArgs,
    ): Promise<CoderStructuredPromptResult<TStructured>> {
      await emitConfiguredEvents(args as EventCapableArgs, emittedProviderEvents);
      await options.onCoderStructuredRun?.(args);
      if (options.coderError) {
        throw options.coderError;
      }

      const structured = responseAt(options.coderStructuredResponses ?? [], coderStructuredRunCount, {
        outcome: 'responded',
        message: 'fake structured coder response',
      });
      coderStructuredRunCount += 1;
      return {
        sessionHandle: coderSessionHandle,
        structured: structured as TStructured,
      };
    }
  }

  class FakeStructuredAdvisorAdapter implements StructuredAdvisorAdapter {
    async runStructuredRound<TStructured>(
      args: StructuredAdvisorRoundArgs,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      await emitConfiguredEvents(args as EventCapableArgs, emittedProviderEvents);
      await options.onStructuredAdvisorRun?.(args);
      if (options.structuredAdvisorError) {
        throw options.structuredAdvisorError;
      }

      const structured = responseAt(options.structuredAdvisorResponses ?? [], structuredAdvisorRunCount, {
        accepted: true,
      });
      structuredAdvisorRunCount += 1;
      return {
        sessionHandle: structuredAdvisorSessionHandle,
        structured: structured as TStructured,
      };
    }
  }

  const definition: NealProviderDefinition = {
    id,
    displayName: options.displayName ?? `Fake Provider ${id}`,
    capabilities: options.capabilities ?? fakeProviderDefaultCapabilities,
  };

  if (options.includeCoderAdapter ?? true) {
    definition.createCoderAdapter = (adapterOptions?: ProviderAdapterOptions) => {
      options.onCreateCoderAdapter?.(adapterOptions);
      return new FakeCoderAdapter();
    };
  }

  if (options.includeStructuredAdvisorAdapter ?? true) {
    definition.createStructuredAdvisorAdapter = (adapterOptions?: ProviderAdapterOptions) => {
      options.onCreateStructuredAdvisorAdapter?.(adapterOptions);
      return new FakeStructuredAdvisorAdapter();
    };
  }

  return definition;
}
