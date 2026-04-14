import type { RunLogger } from '../logger.js';

export type CoderRunPromptArgs = {
  cwd: string;
  prompt: string;
  resumeHandle?: string | null;
  outputSchema?: Record<string, unknown>;
  onSessionStarted?: (sessionHandle: string) => void | Promise<void>;
  logger?: RunLogger;
};

export type CoderRunPromptResult = {
  sessionHandle: string | null;
  finalResponse: string;
};

export type StructuredAdvisorRoundArgs = {
  // Neal round category for prompts/logging; not provider-specific nomenclature.
  label: 'review' | 'plan-review' | 'consult';
  cwd: string;
  prompt: string;
  schema: Record<string, unknown>;
  model?: string | null;
  logger?: RunLogger;
  resumeHandle?: string | null;
};

export type StructuredAdvisorRoundResult<TStructured> = {
  sessionHandle: string | null;
  structured: TStructured;
};

export type CoderAdapter = {
  runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult>;
};

export type StructuredAdvisorAdapter = {
  runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs): Promise<StructuredAdvisorRoundResult<TStructured>>;
};
