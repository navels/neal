export type NormalizedProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Normalize provider token usage across the legacy flat fields Neal already
 * records and the nested AI SDK LanguageModelUsage shape used by newer
 * openai-compatible / Codex adapters.
 *
 * Flat aliases retain the historical additive behavior. Nested details are
 * read only when inputTokens/outputTokens are objects, so a numeric camelCase
 * field is never counted twice.
 */
export function normalizeProviderUsage(value: unknown): NormalizedProviderUsage {
  const usage = recordValue(value) ?? {};
  const inputDetails = recordValue(usage.inputTokens);
  const outputDetails = recordValue(usage.outputTokens);

  return {
    inputTokens:
      numberValue(usage.input_tokens) +
      (inputDetails ? numberValue(inputDetails.total) : numberValue(usage.inputTokens)),
    cachedInputTokens:
      numberValue(usage.cached_input_tokens) +
      numberValue(usage.cachedInputTokens) +
      (inputDetails ? numberValue(inputDetails.cacheRead) : 0),
    cacheCreationInputTokens:
      numberValue(usage.cache_creation_input_tokens) +
      numberValue(usage.cacheCreationInputTokens) +
      (inputDetails ? numberValue(inputDetails.cacheWrite) : 0),
    cacheReadInputTokens:
      numberValue(usage.cache_read_input_tokens) +
      numberValue(usage.cacheReadInputTokens),
    outputTokens:
      numberValue(usage.output_tokens) +
      (outputDetails ? numberValue(outputDetails.total) : numberValue(usage.outputTokens)),
    reasoningOutputTokens:
      numberValue(usage.reasoning_output_tokens) +
      numberValue(usage.reasoningOutputTokens) +
      (outputDetails ? numberValue(outputDetails.reasoning) : 0),
    totalTokens:
      numberValue(usage.total_tokens) +
      numberValue(usage.totalTokens),
  };
}
