/**
 * Deterministic generator for `src/neal/providers/rate-card.ts` from the
 * vendored, checksum-pinned LiteLLM rate card fixture.
 *
 * The shipped rates are the highest-blast-radius artifact in this feature, so
 * they are never hand-curated. This script reads only the committed,
 * checksum-verified fixture (never the network), applies one exhaustive
 * inclusion predicate, and emits a byte-stable TypeScript data module. The
 * committed `rate-card.ts` must equal this generator's output exactly; the
 * `--check` mode is the drift / mistranscription gate.
 *
 * Pure exports (`buildRateCard`, `serializeRateCardModule`) are imported by the
 * test suite, so this file must be type-clean under the strict test typecheck.
 * `eslint.config.mjs` ignores `scripts/**`, so it is never linted, but the
 * `src/neal/providers/rate-card.ts` it emits is linted and must be clean.
 *
 * Run:
 *   node --import tsx scripts/generate-rate-card.ts          # (re)write the module
 *   node --import tsx scripts/generate-rate-card.ts --check  # fail on drift
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Pinned source constants (fixed provenance; never selected or recomputed at
// execution time). All four verified slugs (gpt-5.6-sol, gpt-5.5,
// claude-opus-4-8, claude-fable-5) survive the predicate at this commit.
const RATE_CARD_COMMIT = 'd9661222492a098555f40cb8b50014054bea5ab8';
const RATE_CARD_COMMIT_DATE = '2026-07-18';
const RATE_CARD_RAW_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/' +
  'd9661222492a098555f40cb8b50014054bea5ab8/model_prices_and_context_window.json';
const RATE_CARD_SHA256 = '8d5fdb443371f8334c28cb0ff64bf0f36ad135ec6f766eec767cc62d3b7f8092';
const FIXTURE_RELATIVE_PATH = 'test/fixtures/litellm-model-prices.d9661222492a.json';
const OUTPUT_RELATIVE_PATH = 'src/neal/providers/rate-card.ts';

// The single immutable inclusion predicate description, mirrored verbatim into
// RATE_CARD_SOURCE.predicate.
const PREDICATE_DESCRIPTION =
  'key != sample_spec; finite non-negative input & output cost-per-token; ' +
  'mode in {chat,completion,responses} or absent';
const SOURCE_NOTE = 'community-maintained list prices; rate-computed cost is an estimate';

// The mode allowlist is the single immutable predicate for this generator; it
// is never narrowed or widened at execution time.
const ALLOWED_MODES = new Set(['chat', 'completion', 'responses']);

// Self-contained type declarations so the generator has no bootstrap
// dependency on the file it emits. These must match the type text emitted by
// serializeRateCardModule (and the shipped rate-card.ts) structurally.
export type RateCardEntry = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost?: number;
};

export type RateCard = Record<string, RateCardEntry>;

export type RateCardSource = {
  url: string;
  commit: string;
  retrievedAt: string;
  sha256: string;
  predicate: string;
  note: string;
};

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply the exhaustive inclusion predicate to the raw LiteLLM object and carry
 * only the three base-tier fields per included model. No per-model curation and
 * no judgment calls: a key is included iff it is not `sample_spec`, its value is
 * a plain object with finite non-negative `input_cost_per_token` and
 * `output_cost_per_token`, and its `mode` is one of chat/completion/responses or
 * absent. Conditional/tiered rate fields are dropped by only ever reading the
 * three base keys.
 */
export function buildRateCard(raw: unknown): RateCard {
  const card: RateCard = {};
  if (!isPlainObject(raw)) {
    return card;
  }
  for (const key of Object.keys(raw)) {
    if (key === 'sample_spec') {
      continue;
    }
    const value = raw[key];
    if (!isPlainObject(value)) {
      continue;
    }
    const input = value.input_cost_per_token;
    const output = value.output_cost_per_token;
    if (!isFiniteNonNegativeNumber(input) || !isFiniteNonNegativeNumber(output)) {
      continue;
    }
    const mode = value.mode;
    const modeAllowed = mode === undefined || (typeof mode === 'string' && ALLOWED_MODES.has(mode));
    if (!modeAllowed) {
      continue;
    }
    const entry: RateCardEntry = {
      inputCostPerToken: input,
      outputCostPerToken: output,
    };
    const cacheRead = value.cache_read_input_token_cost;
    if (isFiniteNonNegativeNumber(cacheRead)) {
      entry.cacheReadInputTokenCost = cacheRead;
    }
    card[key] = entry;
  }
  return card;
}

// A number literal that round-trips to the exact same IEEE-754 value. The
// ECMAScript Number-to-String algorithm is deterministic and produces the
// shortest round-tripping representation, so this is byte-stable across runs.
function numberLiteral(value: number): string {
  return String(value);
}

// Single-quoted string literal with the minimal escapes needed for arbitrary
// model-slug and provenance strings.
function singleQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function serializeEntry(entry: RateCardEntry): string {
  const parts = [
    `inputCostPerToken: ${numberLiteral(entry.inputCostPerToken)}`,
    `outputCostPerToken: ${numberLiteral(entry.outputCostPerToken)}`,
  ];
  if (entry.cacheReadInputTokenCost !== undefined) {
    parts.push(`cacheReadInputTokenCost: ${numberLiteral(entry.cacheReadInputTokenCost)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/**
 * Serialize the full text of `rate-card.ts` deterministically: a fixed header,
 * the type declarations, the RATE_CARD object with keys sorted lexicographically
 * (byte-stable), and the RATE_CARD_SOURCE provenance constant. If this output
 * ever trips `eslint src` or `tsc`, adjust this serializer — never hand-edit the
 * emitted file, which would break `--check`.
 */
export function serializeRateCardModule(args: { card: RateCard; source: RateCardSource }): string {
  const { card, source } = args;
  const keys = Object.keys(card).sort();
  const entryLines = keys.map((key) => `  ${singleQuote(key)}: ${serializeEntry(card[key])},`);
  const sourceLines = [
    `  url: ${singleQuote(source.url)},`,
    `  commit: ${singleQuote(source.commit)},`,
    `  retrievedAt: ${singleQuote(source.retrievedAt)},`,
    `  sha256: ${singleQuote(source.sha256)},`,
    `  predicate: ${singleQuote(source.predicate)},`,
    `  note: ${singleQuote(source.note)},`,
  ];
  return `${[
    '// AUTO-GENERATED by scripts/generate-rate-card.ts — DO NOT EDIT BY HAND.',
    '//',
    '// Regenerate:',
    '//   node --import tsx scripts/generate-rate-card.ts',
    '// Verify in sync (drift / mistranscription gate):',
    '//   node --import tsx scripts/generate-rate-card.ts --check',
    '//',
    '// Source: vendored LiteLLM model_prices_and_context_window.json (see',
    '// RATE_CARD_SOURCE below). Only base-tier per-token input/output/cache-read',
    '// rates are carried; conditional / tiered rate fields are intentionally',
    '// dropped, so a turn crossing a long-context threshold is priced (and',
    '// therefore underestimated) at the base tier.',
    '',
    'export type RateCardEntry = {',
    '  inputCostPerToken: number;',
    '  outputCostPerToken: number;',
    '  // Present only when upstream publishes a cache-read discount.',
    '  cacheReadInputTokenCost?: number;',
    '};',
    '',
    'export type RateCard = Record<string, RateCardEntry>;',
    '',
    'export type RateCardSource = {',
    '  url: string;',
    '  commit: string;',
    '  retrievedAt: string;',
    '  sha256: string;',
    '  predicate: string;',
    '  note: string;',
    '};',
    '',
    'export const RATE_CARD: RateCard = {',
    ...entryLines,
    '};',
    '',
    'export const RATE_CARD_SOURCE: RateCardSource = {',
    ...sourceLines,
    '} as const;',
    '',
  ].join('\n')}`;
}

function buildSource(): RateCardSource {
  return {
    url: RATE_CARD_RAW_URL,
    commit: RATE_CARD_COMMIT,
    retrievedAt: RATE_CARD_COMMIT_DATE,
    sha256: RATE_CARD_SHA256,
    predicate: PREDICATE_DESCRIPTION,
    note: SOURCE_NOTE,
  };
}

function repoRoot(): string {
  // scripts/generate-rate-card.ts -> repo root is two levels up.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readFixtureAndAssertChecksum(fixturePath: string): unknown {
  const bytes = readFileSync(fixturePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== RATE_CARD_SHA256) {
    throw new Error(
      `Fixture checksum mismatch for ${fixturePath}: expected ${RATE_CARD_SHA256}, got ${digest}. ` +
        'Refuse to generate from an unverified rate card.',
    );
  }
  return JSON.parse(bytes.toString('utf8'));
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const root = repoRoot();
  const fixturePath = resolve(root, FIXTURE_RELATIVE_PATH);
  const outputPath = resolve(root, OUTPUT_RELATIVE_PATH);

  const raw = readFixtureAndAssertChecksum(fixturePath);
  const generated = serializeRateCardModule({ card: buildRateCard(raw), source: buildSource() });

  if (checkMode) {
    let committed: string;
    try {
      committed = readFileSync(outputPath, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Cannot read ${OUTPUT_RELATIVE_PATH} for --check: ${message}`);
      process.exit(1);
      return;
    }
    if (committed !== generated) {
      console.error(
        `${OUTPUT_RELATIVE_PATH} is out of sync with scripts/generate-rate-card.ts. ` +
          'Run `node --import tsx scripts/generate-rate-card.ts` and commit the result.',
      );
      process.exit(1);
      return;
    }
    console.log(`${OUTPUT_RELATIVE_PATH} is in sync with the pinned rate card.`);
    return;
  }

  writeFileSync(outputPath, generated);
  console.log(`Wrote ${OUTPUT_RELATIVE_PATH} (${Object.keys(buildRateCard(raw)).length} models).`);
}

// Guarded CLI main (mirrors scripts/verify-package.mjs): importing this module
// in tests runs no IO — no fixture read, checksum, or file write at module load.
if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
