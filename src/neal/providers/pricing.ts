// Shared pricing type and rate math for token-only provider adapters
// (openai-compatible and openai-codex). Those adapters report
// token counts but not dollars. Cost is resolved per bucket in this order:
// operator-configured per-million rates under
// `providers.openai_compatible.pricing` (the override tier), else the vendored
// published rate card (`rate-card.ts`, keyed by exact model slug), else
// tokens-only (`null` — Neal never invents dollars). The Claude adapter does
// not use this: it passes through the provider-reported `total_cost_usd`
// instead, and that provider-reported cost always wins upstream (it never
// reaches `resolveRateCost`).

import { RATE_CARD, type RateCard } from './rate-card.js';

export type ProviderPricing = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

// Same coercion as `numberValue` in run-metrics.ts: non-number or non-finite
// values normalize to 0 so the arithmetic never yields NaN.
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Rate-compute the USD cost of one turn's token usage.
 *
 * Field-to-rate mapping (kept explicit so the math is reproducible from the
 * source alone):
 *
 * - `totalInput = input_tokens + inputTokens` — the reported prompt/input
 *   count. For OpenAI-compatible Chat Completions this count is *inclusive of*
 *   cached tokens (`prompt_tokens` already contains
 *   `prompt_tokens_details.cached_tokens`; the AI SDK surfaces these as
 *   `inputTokens` and `cachedInputTokens`).
 * - `cachedInput = cached_input_tokens + cachedInputTokens +
 *   cache_read_input_tokens + cacheReadInputTokens` — tokens billed at the
 *   cached rate.
 * - `billedUncachedInput = max(0, totalInput - cachedInput)` — cached tokens
 *   are subtracted from the inclusive total so a cached token is billed once,
 *   at the cached rate, never also at the full input rate. The `max(0, ...)`
 *   clamp is the defined handling for inconsistent counts (cached reported
 *   greater than total): treat the excess as fully cached rather than emitting a
 *   negative term.
 * - `output = output_tokens + outputTokens` — already includes reasoning
 *   tokens for these providers, so reasoning output is not added separately.
 * - Cache-creation tokens (`cache_creation_input_tokens`) are an Anthropic-only
 *   concept billed via provider-reported cost, not by these rates, so they are
 *   intentionally excluded here.
 *
 * Returns 0 (never NaN) when no tokens are present.
 */
export function computeRateCostUsd(usage: unknown, pricing: ProviderPricing): number {
  const value = (usage && typeof usage === 'object' && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const totalInput = num(value.input_tokens) + num(value.inputTokens);
  const cachedInput =
    num(value.cached_input_tokens) +
    num(value.cachedInputTokens) +
    num(value.cache_read_input_tokens) +
    num(value.cacheReadInputTokens);
  const billedUncachedInput = Math.max(0, totalInput - cachedInput);
  const output = num(value.output_tokens) + num(value.outputTokens);

  return (
    (billedUncachedInput / 1e6) * pricing.inputPerMillion +
    (cachedInput / 1e6) * pricing.cachedInputPerMillion +
    (output / 1e6) * pricing.outputPerMillion
  );
}

const PER_TOKEN_TO_PER_MILLION = 1e6;

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Resolve a model slug to per-million pricing from the vendored rate card.
 *
 * Exact-match only: the slug is looked up (after trimming surrounding
 * whitespace) as a literal key. No provider prefix is stripped and there is no
 * basename fallback, so a slash-qualified slug like `local/gpt-5.5`,
 * `azure/<deployment>`, or a finetune whose basename collides with a listed
 * model does NOT inherit that model's price — pricing an unlisted slug would
 * invent dollars, which the never-invent contract forbids. Provider-qualified
 * slugs are priced only when the card carries that exact key (LiteLLM lists many
 * `vendor/model` keys directly).
 *
 * Returns null for a non-string / empty / whitespace-only model, for an unknown
 * slug, and for a card entry whose input or output cost is not a finite
 * non-negative number (a partial entry is a miss, never a partial rate). The
 * per-token rates are converted to per-million. The cached rate uses
 * `cacheReadInputTokenCost` when it is a finite non-negative number, else falls
 * back to the input rate (no published cache discount means cached reads are
 * billed at the input rate — never free, never an invented discount).
 */
export function lookupCardPricing(
  model: string | null | undefined,
  card: RateCard = RATE_CARD,
): ProviderPricing | null {
  if (typeof model !== 'string') {
    return null;
  }
  const key = model.trim();
  if (key === '') {
    return null;
  }
  const entry = card[key];
  if (entry === undefined) {
    return null;
  }
  if (!isFiniteNonNegativeNumber(entry.inputCostPerToken) || !isFiniteNonNegativeNumber(entry.outputCostPerToken)) {
    return null;
  }
  const cachedPerToken = isFiniteNonNegativeNumber(entry.cacheReadInputTokenCost)
    ? entry.cacheReadInputTokenCost
    : entry.inputCostPerToken;
  return {
    inputPerMillion: entry.inputCostPerToken * PER_TOKEN_TO_PER_MILLION,
    cachedInputPerMillion: cachedPerToken * PER_TOKEN_TO_PER_MILLION,
    outputPerMillion: entry.outputCostPerToken * PER_TOKEN_TO_PER_MILLION,
  };
}

/**
 * Resolve a turn's rate-computed cost for a single provider/role bucket.
 *
 * Resolution order per bucket: operator-configured `configPricing` (the
 * override tier) beats the vendored card (`lookupCardPricing(model)`). Returns
 * null when neither yields pricing (tokens-only). When pricing is found, returns
 * the flat base-tier computation from `computeRateCostUsd` tagged
 * `costSource: 'rate'`; no tiered/threshold logic is applied, so a card-listed
 * model is priced at its published base rates regardless of prompt length.
 */
export function resolveRateCost(args: {
  usage: unknown;
  model: string | null | undefined;
  configPricing?: ProviderPricing | null;
  card?: RateCard;
}): { costUsd: number; costSource: 'rate' } | null {
  const pricing = args.configPricing ?? lookupCardPricing(args.model, args.card ?? RATE_CARD);
  if (!pricing) {
    return null;
  }
  return { costUsd: computeRateCostUsd(args.usage, pricing), costSource: 'rate' };
}
