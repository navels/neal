import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  computeRateCostUsd,
  lookupCardPricing,
  resolveRateCost,
  type ProviderPricing,
} from '../src/neal/providers/pricing.js';
import { RATE_CARD, RATE_CARD_SOURCE } from '../src/neal/providers/rate-card.js';
import { buildRateCard, serializeRateCardModule, type RateCard } from '../scripts/generate-rate-card.js';

// Pinned provenance literals, hand-written here so the tests are an independent
// oracle for RATE_CARD_SOURCE and the fixture bytes (never derived from the
// generator or the shipped module).
const PINNED_COMMIT = 'd9661222492a098555f40cb8b50014054bea5ab8';
const PINNED_SHA256 = '8d5fdb443371f8334c28cb0ff64bf0f36ad135ec6f766eec767cc62d3b7f8092';
const PINNED_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/' +
  'd9661222492a098555f40cb8b50014054bea5ab8/model_prices_and_context_window.json';
const PINNED_RETRIEVED_AT = '2026-07-18';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/litellm-model-prices.d9661222492a.json', import.meta.url),
);

function readFixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

function readFixtureJson(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFixtureBytes().toString('utf8')) as Record<string, Record<string, unknown>>;
}

// A small hand-written card so lookup/resolution unit tests are deterministic
// and refresh-proof (independent of the shipped RATE_CARD).
const FIXTURE_CARD: RateCard = {
  'gpt-5.5': { inputCostPerToken: 0.000005, outputCostPerToken: 0.00003, cacheReadInputTokenCost: 5e-7 },
  'openai/gpt-5.5': { inputCostPerToken: 0.000009, outputCostPerToken: 0.00004 },
  'no-cache-model': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
};

const PRICING: ProviderPricing = {
  inputPerMillion: 3,
  cachedInputPerMillion: 0.3,
  outputPerMillion: 15,
};

test('computeRateCostUsd returns 0 when no tokens are present', () => {
  assert.equal(computeRateCostUsd({}, PRICING), 0);
  assert.equal(computeRateCostUsd(undefined, PRICING), 0);
  assert.equal(computeRateCostUsd(null, PRICING), 0);
});

test('computeRateCostUsd prices a known non-cached vector exactly', () => {
  // (1000/1e6)*3 + 0 cached + (200/1e6)*15 = 0.003 + 0.003 = 0.006
  const cost = computeRateCostUsd({ inputTokens: 1000, outputTokens: 200 }, PRICING);
  assert.equal(cost, 0.006);
});

test('computeRateCostUsd subtracts cached tokens from the inclusive input (no double billing)', () => {
  // (600/1e6)*3 + (400/1e6)*0.3 + (200/1e6)*15 = 0.0018 + 0.00012 + 0.003 = 0.00492
  const cost = computeRateCostUsd(
    { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 },
    PRICING,
  );
  assert.equal(cost, 0.00492);
});

test('computeRateCostUsd maps snake_case fields identically', () => {
  const cost = computeRateCostUsd(
    { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 },
    PRICING,
  );
  assert.equal(cost, 0.00492);
});

test('computeRateCostUsd bills cache-read tokens at the cached rate alongside cachedInputTokens', () => {
  // totalInput 1000; cached = 200 (cachedInputTokens) + 200 (cache_read) + 100 (cacheReadInputTokens) = 500
  // billedUncached = 500; (500/1e6)*3 + (500/1e6)*0.3 + 0 = 0.0015 + 0.00015 = 0.00165
  const cost = computeRateCostUsd(
    {
      inputTokens: 1000,
      cachedInputTokens: 200,
      cache_read_input_tokens: 200,
      cacheReadInputTokens: 100,
    },
    PRICING,
  );
  assert.equal(cost, 0.00165);
});

test('computeRateCostUsd clamps billed uncached input to zero when cached exceeds total', () => {
  // cached (900) > totalInput (500) -> billedUncached = 0, no negative term
  // 0 + (900/1e6)*0.3 + (100/1e6)*15 = 0.00027 + 0.0015 = 0.00177
  const cost = computeRateCostUsd(
    { inputTokens: 500, cachedInputTokens: 900, outputTokens: 100 },
    PRICING,
  );
  assert.equal(cost, 0.00177);
});

test('computeRateCostUsd ignores non-finite token fields', () => {
  const cost = computeRateCostUsd(
    { inputTokens: Number.NaN, outputTokens: Infinity, cachedInputTokens: 'x' as unknown as number },
    PRICING,
  );
  assert.equal(cost, 0);
});

// --- lookupCardPricing ---

test('lookupCardPricing converts per-token entries to per-million exactly', () => {
  const pricing = lookupCardPricing('gpt-5.5', FIXTURE_CARD);
  assert.deepEqual(pricing, {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
  });
});

test('lookupCardPricing falls back to the input rate when cacheReadInputTokenCost is absent', () => {
  const pricing = lookupCardPricing('no-cache-model', FIXTURE_CARD);
  assert.deepEqual(pricing, {
    inputPerMillion: 1,
    // No published cache-read discount -> cached reads billed at the input rate.
    cachedInputPerMillion: 1,
    outputPerMillion: 2,
  });
});

test('lookupCardPricing uses cacheReadInputTokenCost when present', () => {
  const pricing = lookupCardPricing('gpt-5.5', FIXTURE_CARD);
  assert.equal(pricing?.cachedInputPerMillion, 0.5);
});

test('lookupCardPricing is exact-match only: qualified and bare keys resolve independently', () => {
  // Both keys present -> each resolves to its own entry, never the other's.
  assert.equal(lookupCardPricing('gpt-5.5', FIXTURE_CARD)?.inputPerMillion, 5);
  assert.equal(lookupCardPricing('openai/gpt-5.5', FIXTURE_CARD)?.inputPerMillion, 9);
});

test('lookupCardPricing never inherits a listed price via prefix stripping or basename fallback', () => {
  const bareOnly: RateCard = {
    'gpt-5.5': { inputCostPerToken: 0.000005, outputCostPerToken: 0.00003, cacheReadInputTokenCost: 5e-7 },
  };
  // Every slash-qualified slug whose basename collides with the bare key stays
  // unpriced — no prefix stripping, no basename fallback (never invents dollars).
  assert.equal(lookupCardPricing('local/gpt-5.5', bareOnly), null);
  assert.equal(lookupCardPricing('myfinetune/gpt-5.5', bareOnly), null);
  assert.equal(lookupCardPricing('openai/gpt-5.5', bareOnly), null);
  // The exact bare key still resolves, including through surrounding whitespace.
  assert.equal(lookupCardPricing('gpt-5.5', bareOnly)?.inputPerMillion, 5);
  assert.equal(lookupCardPricing('  gpt-5.5  ', bareOnly)?.inputPerMillion, 5);
});

test('lookupCardPricing returns null for missing, empty, whitespace, null, and undefined models', () => {
  assert.equal(lookupCardPricing('unknown-slug', FIXTURE_CARD), null);
  assert.equal(lookupCardPricing('', FIXTURE_CARD), null);
  assert.equal(lookupCardPricing('   ', FIXTURE_CARD), null);
  assert.equal(lookupCardPricing(null, FIXTURE_CARD), null);
  assert.equal(lookupCardPricing(undefined, FIXTURE_CARD), null);
});

test('lookupCardPricing returns null for an entry missing input or output cost', () => {
  const partial: RateCard = {
    'missing-output': { inputCostPerToken: 1e-6 } as unknown as RateCard[string],
    'missing-input': { outputCostPerToken: 2e-6 } as unknown as RateCard[string],
    'negative-input': { inputCostPerToken: -1e-6, outputCostPerToken: 2e-6 },
  };
  assert.equal(lookupCardPricing('missing-output', partial), null);
  assert.equal(lookupCardPricing('missing-input', partial), null);
  assert.equal(lookupCardPricing('negative-input', partial), null);
});

// --- resolveRateCost ---

test('resolveRateCost prefers config pricing over the card', () => {
  const configPricing: ProviderPricing = {
    inputPerMillion: 100,
    cachedInputPerMillion: 10,
    outputPerMillion: 200,
  };
  const result = resolveRateCost({
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    model: 'gpt-5.5',
    configPricing,
    card: FIXTURE_CARD,
  });
  // Config wins: input priced at 100/M, not the card's 5/M.
  assert.deepEqual(result, { costUsd: 100, costSource: 'rate' });
});

test('resolveRateCost uses the card when config pricing is absent', () => {
  const result = resolveRateCost({
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    model: 'gpt-5.5',
    configPricing: null,
    card: FIXTURE_CARD,
  });
  assert.deepEqual(result, { costUsd: 5, costSource: 'rate' });
});

test('resolveRateCost returns null when neither config nor card yields pricing', () => {
  assert.equal(
    resolveRateCost({ usage: { inputTokens: 10 }, model: 'unknown-slug', configPricing: null, card: FIXTURE_CARD }),
    null,
  );
  assert.equal(
    resolveRateCost({ usage: { inputTokens: 10 }, model: null, configPricing: null, card: FIXTURE_CARD }),
    null,
  );
});

// --- buildRateCard transformation (hand-written expected outputs) ---

test('buildRateCard excludes sample_spec even with valid-looking cost fields', () => {
  const result = buildRateCard({
    sample_spec: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    'real-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
  });
  assert.deepEqual(result, {
    'real-model': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
  });
});

test('buildRateCard includes chat, completion, responses, and mode-absent entries', () => {
  const result = buildRateCard({
    'm-chat': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    'm-completion': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'completion' },
    'm-responses': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'responses' },
    'm-absent': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  });
  assert.deepEqual(result, {
    'm-absent': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'm-chat': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'm-completion': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'm-responses': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
  });
});

test('buildRateCard excludes non-chat-like modes', () => {
  const result = buildRateCard({
    'm-embedding': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'embedding' },
    'm-image': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'image_generation' },
    'm-audio': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'audio_transcription' },
    'm-rerank': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'rerank' },
    'm-moderation': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'moderation' },
  });
  assert.deepEqual(result, {});
});

test('buildRateCard excludes entries with missing, non-numeric, non-finite, or negative base rates', () => {
  const result = buildRateCard({
    'missing-input': { output_cost_per_token: 2e-6, mode: 'chat' },
    'missing-output': { input_cost_per_token: 1e-6, mode: 'chat' },
    'string-input': { input_cost_per_token: '1e-6', output_cost_per_token: 2e-6, mode: 'chat' },
    'nan-input': { input_cost_per_token: Number.NaN, output_cost_per_token: 2e-6, mode: 'chat' },
    'inf-output': { input_cost_per_token: 1e-6, output_cost_per_token: Infinity, mode: 'chat' },
    'negative-output': { input_cost_per_token: 1e-6, output_cost_per_token: -2e-6, mode: 'chat' },
  });
  assert.deepEqual(result, {});
});

test('buildRateCard carries cacheReadInputTokenCost only for a finite non-negative value', () => {
  const result = buildRateCard({
    'with-cache': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: 5e-7, mode: 'chat' },
    'no-cache': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    'neg-cache': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: -5e-7, mode: 'chat' },
    'str-cache': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: '5e-7', mode: 'chat' },
    'nan-cache': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, cache_read_input_token_cost: Number.NaN, mode: 'chat' },
  });
  assert.deepEqual(result, {
    'nan-cache': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'neg-cache': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'no-cache': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'str-cache': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
    'with-cache': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6, cacheReadInputTokenCost: 5e-7 },
  });
});

test('buildRateCard maps distinct input and output values without swapping', () => {
  const result = buildRateCard({
    'm': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
  });
  assert.equal(result['m'].inputCostPerToken, 1e-6);
  assert.equal(result['m'].outputCostPerToken, 2e-6);
});

test('buildRateCard is base-tier only: every conditional/tiered rate field is dropped', () => {
  const result = buildRateCard({
    'tiered': {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
      cache_read_input_token_cost: 5e-7,
      input_cost_per_token_above_272k_tokens: 2e-6,
      output_cost_per_token_above_272k_tokens: 3e-6,
      input_cost_per_token_batches: 5e-7,
      cache_creation_input_token_cost: 4e-6,
      mode: 'chat',
    },
  });
  // Only the three base fields survive; no surcharge/tier/batch/creation keys.
  assert.deepEqual(result, {
    'tiered': { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6, cacheReadInputTokenCost: 5e-7 },
  });
  assert.deepEqual(Object.keys(result['tiered']).sort(), [
    'cacheReadInputTokenCost',
    'inputCostPerToken',
    'outputCostPerToken',
  ]);
});

test('buildRateCard emits keys in lexicographic order regardless of input order', () => {
  const result = buildRateCard({
    zzz: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    aaa: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    mmm: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
  });
  // buildRateCard preserves insertion order; serialization sorts. Assert the
  // serializer emits sorted keys.
  const text = serializeRateCardModule({
    card: result,
    source: RATE_CARD_SOURCE,
  });
  const aaaIdx = text.indexOf("'aaa'");
  const mmmIdx = text.indexOf("'mmm'");
  const zzzIdx = text.indexOf("'zzz'");
  assert.ok(aaaIdx < mmmIdx && mmmIdx < zzzIdx, 'expected serialized keys in lexicographic order');
});

test('buildRateCard and serializeRateCardModule are pure/deterministic', () => {
  const raw = {
    b: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
    a: { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6, mode: 'chat' },
  };
  assert.deepEqual(buildRateCard(raw), buildRateCard(raw));
  const card = buildRateCard(raw);
  assert.equal(
    serializeRateCardModule({ card, source: RATE_CARD_SOURCE }),
    serializeRateCardModule({ card, source: RATE_CARD_SOURCE }),
  );
});

// --- Provenance binding ---

test('RATE_CARD_SOURCE equals the pinned constants and the fixture SHA-256', () => {
  assert.equal(RATE_CARD_SOURCE.commit, PINNED_COMMIT);
  assert.equal(RATE_CARD_SOURCE.sha256, PINNED_SHA256);
  assert.equal(RATE_CARD_SOURCE.url, PINNED_URL);
  assert.equal(RATE_CARD_SOURCE.retrievedAt, PINNED_RETRIEVED_AT);
  const digest = createHash('sha256').update(readFixtureBytes()).digest('hex');
  assert.equal(digest, RATE_CARD_SOURCE.sha256);
});

// --- Shipped-card correspondence ---

test('shipped RATE_CARD deep-equals buildRateCard(pinned fixture)', () => {
  assert.deepEqual(RATE_CARD, buildRateCard(readFixtureJson()));
});

// --- Direct production-slug field mapping ---

test('shipped RATE_CARD maps the four verified slugs to raw fixture rates, base-tier only', () => {
  const fixture = readFixtureJson();
  for (const slug of ['gpt-5.6-sol', 'gpt-5.5', 'claude-opus-4-8', 'claude-fable-5']) {
    const shipped = RATE_CARD[slug];
    const raw = fixture[slug];
    assert.ok(shipped, `expected shipped RATE_CARD to contain ${slug}`);
    assert.equal(shipped.inputCostPerToken, raw.input_cost_per_token);
    assert.equal(shipped.outputCostPerToken, raw.output_cost_per_token);
    if (typeof raw.cache_read_input_token_cost === 'number' && Number.isFinite(raw.cache_read_input_token_cost)) {
      assert.equal(shipped.cacheReadInputTokenCost, raw.cache_read_input_token_cost);
    }
    assert.ok(Number.isFinite(shipped.inputCostPerToken) && shipped.inputCostPerToken > 0);
    assert.ok(Number.isFinite(shipped.outputCostPerToken) && shipped.outputCostPerToken > 0);
    // No surcharge/tier key leaked (locks base-tier for gpt-5.6-sol, whose raw
    // entry publishes above-272K surcharge rates).
    const allowed = new Set(['inputCostPerToken', 'outputCostPerToken', 'cacheReadInputTokenCost']);
    for (const key of Object.keys(shipped)) {
      assert.ok(allowed.has(key), `unexpected key ${key} on shipped ${slug}`);
    }
  }
});

// --- Base-tier costing (locks the accepted approximation) ---

test('resolveRateCost prices gpt-5.6-sol at the base tier above the long-context threshold', () => {
  const fixture = readFixtureJson();
  const raw = fixture['gpt-5.6-sol'];
  const baseInputPerMillion = (raw.input_cost_per_token as number) * 1e6;
  const baseOutputPerMillion = (raw.output_cost_per_token as number) * 1e6;
  const usage = { input_tokens: 300000, output_tokens: 1000 };

  const result = resolveRateCost({ usage, model: 'gpt-5.6-sol', configPricing: null });
  const expectedBase = (300000 / 1e6) * baseInputPerMillion + (1000 / 1e6) * baseOutputPerMillion;
  assert.ok(result);
  assert.equal(result.costSource, 'rate');
  assert.equal(result.costUsd, expectedBase);

  // The surcharged tier (2x input / 1.5x output above 272K) would cost strictly
  // more; Neal deliberately does not apply it.
  const surInputPerMillion = (raw.input_cost_per_token_above_272k_tokens as number) * 1e6;
  const surOutputPerMillion = (raw.output_cost_per_token_above_272k_tokens as number) * 1e6;
  const surcharged = (300000 / 1e6) * surInputPerMillion + (1000 / 1e6) * surOutputPerMillion;
  assert.ok(result.costUsd < surcharged, 'base-tier cost must be less than the surcharged tier');
});
