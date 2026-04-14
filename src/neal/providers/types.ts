import type { RunLogger } from '../logger.js';

export type CoderRunPromptArgs = {
  cwd: string;
  prompt: string;
  threadId?: string | null;
  outputSchema?: Record<string, unknown>;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  logger?: RunLogger;
};

export type CoderRunPromptResult = {
  threadId: string | null;
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
  resumeSessionId?: string | null;
};

export type StructuredAdvisorRoundResult<TStructured> = {
  sessionId: string | null;
  structured: TStructured;
};

export type CoderAdapter = {
  runPrompt(args: CoderRunPromptArgs): Promise<CoderRunPromptResult>;
};

export type StructuredAdvisorAdapter = {
  runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs): Promise<StructuredAdvisorRoundResult<TStructured>>;
};
