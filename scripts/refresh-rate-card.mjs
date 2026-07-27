// Re-pins the vendored LiteLLM rate card to the latest upstream commit and
// regenerates src/neal/providers/rate-card.ts. Run manually from a local
// checkout when the vendored pricing data needs an update; the result should
// land through a normal pull request gated by CI and human review.
//
// The pin lives as string constants in scripts/generate-rate-card.ts plus one
// fixture-path reference in test/provider-pricing.test.ts; both are rewritten
// textually so the generator remains the single source of provenance truth.
//
// Exit 0 both when already up to date (no file changes) and after a
// successful re-pin (workspace changes left for the caller to review and
// commit); non-zero on any integrity failure.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = resolve(root, 'scripts/generate-rate-card.ts');
const PRICING_TEST = resolve(root, 'test/provider-pricing.test.ts');
const UPSTREAM_PATH = 'model_prices_and_context_window.json';

// Slugs the card must keep serving; losing one is a human decision, not a
// silent refresh.
const REQUIRED_SLUGS = ['gpt-5.6-sol', 'gpt-5.5', 'claude-opus-4-8', 'claude-fable-5'];

function readPin(source) {
  const commit = source.match(/const RATE_CARD_COMMIT = '([0-9a-f]{40})';/)?.[1];
  const date = source.match(/const RATE_CARD_COMMIT_DATE = '(\d{4}-\d{2}-\d{2})';/)?.[1];
  const sha256 = source.match(/const RATE_CARD_SHA256 = '([0-9a-f]{64})';/)?.[1];
  if (!commit || !date || !sha256) {
    throw new Error('could not read the pin constants from scripts/generate-rate-card.ts');
  }
  return { commit, date, sha256 };
}

const generatorSource = readFileSync(GENERATOR, 'utf8');
const current = readPin(generatorSource);

const latest = JSON.parse(
  execFileSync(
    'gh',
    ['api', `repos/BerriAI/litellm/commits?path=${UPSTREAM_PATH}&per_page=1`],
    { encoding: 'utf8' },
  ),
)[0];
const newCommit = latest.sha;
const newDate = latest.commit.author.date.slice(0, 10);

if (newCommit === current.commit) {
  console.log(`rate card already pinned to the latest upstream commit (${current.commit.slice(0, 12)})`);
  process.exit(0);
}

const rawUrl = `https://raw.githubusercontent.com/BerriAI/litellm/${newCommit}/${UPSTREAM_PATH}`;
const response = await fetch(rawUrl);
if (!response.ok) {
  throw new Error(`failed to download ${rawUrl}: HTTP ${response.status}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
const newSha256 = createHash('sha256').update(bytes).digest('hex');

const parsed = JSON.parse(bytes.toString('utf8'));
for (const slug of REQUIRED_SLUGS) {
  const entry = parsed[slug];
  if (
    !entry ||
    !Number.isFinite(entry.input_cost_per_token) ||
    !Number.isFinite(entry.output_cost_per_token)
  ) {
    throw new Error(
      `refusing to re-pin: required slug '${slug}' is missing or unpriced at upstream ${newCommit.slice(0, 12)}; ` +
        'this needs a human decision, not an automated refresh',
    );
  }
}

const oldShort = current.commit.slice(0, 12);
const newShort = newCommit.slice(0, 12);
const newFixture = resolve(root, `test/fixtures/litellm-model-prices.${newShort}.json`);
const oldFixture = resolve(root, `test/fixtures/litellm-model-prices.${oldShort}.json`);

writeFileSync(newFixture, bytes);
unlinkSync(oldFixture);

// Full-sha replacement covers RATE_CARD_COMMIT and the raw URL; short-sha
// covers the fixture path constant; date and checksum are standalone.
const updatedGenerator = generatorSource
  .replaceAll(current.commit, newCommit)
  .replaceAll(oldShort, newShort)
  .replace(current.sha256, newSha256)
  .replace(`const RATE_CARD_COMMIT_DATE = '${current.date}';`, `const RATE_CARD_COMMIT_DATE = '${newDate}';`);
writeFileSync(GENERATOR, updatedGenerator);

// The pricing test pins the full provenance (commit, sha256, date, fixture
// path) as its own literals — that is the provenance-binding oracle, so it
// needs the same replacement chain as the generator: full sha first (so the
// short-sha pass cannot corrupt an embedded full sha), then the fixture
// path's short sha, checksum, and date.
writeFileSync(
  PRICING_TEST,
  readFileSync(PRICING_TEST, 'utf8')
    .replaceAll(current.commit, newCommit)
    .replaceAll(oldShort, newShort)
    .replaceAll(current.sha256, newSha256)
    .replaceAll(`'${current.date}'`, `'${newDate}'`),
);

// Sanity: the rewrite must leave exactly the new pin in place.
const rewritten = readPin(readFileSync(GENERATOR, 'utf8'));
if (rewritten.commit !== newCommit || rewritten.sha256 !== newSha256 || rewritten.date !== newDate) {
  throw new Error('pin rewrite did not produce the expected constants; aborting');
}

execFileSync('node', ['--import', 'tsx', GENERATOR], { cwd: root, stdio: 'inherit' });
execFileSync('node', ['--import', 'tsx', GENERATOR, '--check'], { cwd: root, stdio: 'inherit' });

console.log(
  [
    `re-pinned rate card: ${oldShort} (${current.date}) -> ${newShort} (${newDate})`,
    `sha256: ${newSha256}`,
    `fixture: test/fixtures/litellm-model-prices.${newShort}.json`,
  ].join('\n'),
);
