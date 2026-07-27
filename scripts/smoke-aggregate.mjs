// Aggregate several `neal compat --json` reports into one smoke verdict.
//
// The live smoke runs the full compat matrix up to 3 times against a cheap
// self-referenced OpenRouter model. A single all-green attempt passes on the
// spot (the workflow short-circuits before calling this). When no attempt is
// perfect, demanding one is statistically brittle: each attempt rolls ~10 live
// LLM runs, and marginal models flake on different cells per attempt. What the
// smoke exists to catch — an AI-SDK bump that breaks tool-calling, structured
// output, or schema enforcement — fails the SAME cell every attempt. So the
// verdict here is per-cell majority: a cell fails the smoke only if it failed
// in at least `failThreshold` attempts; anything rarer is reported as flake.
//
// Usage: node scripts/smoke-aggregate.mjs report1.json [report2.json ...]
// Exit 0 = PASS (no majority-fail cell), 1 = FAIL, 2 = no usable reports.

import { readFileSync } from 'node:fs';

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: node scripts/smoke-aggregate.mjs <report.json> [...]');
  process.exit(2);
}

const failThreshold = Math.max(2, Math.ceil(paths.length / 2));
const cellKey = (cell) => `${cell.role}/${cell.fixtureId}/${cell.diffKind ?? '-'}`;

const attempts = paths.map((path) => {
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(report.cells)) throw new Error('missing cells array');
    return { path, report };
  } catch (error) {
    return { path, error: error instanceof Error ? error.message : String(error) };
  }
});

const parsed = attempts.filter((a) => a.report);
const unparsable = attempts.length - parsed.length;
if (parsed.length === 0) {
  console.error('smoke-aggregate: no attempt produced a parseable compat report.');
  process.exit(2);
}

// Union of cell identities across parsed attempts. An unparsable attempt (the
// run crashed before emitting a report) counts as a failure of every cell —
// repeated crashes are exactly the systematic signal the smoke must not absorb.
const tally = new Map();
for (const { report } of parsed) {
  for (const cell of report.cells) {
    const key = cellKey(cell);
    const entry = tally.get(key) ?? { fails: 0, seen: 0, modes: new Set() };
    entry.seen += 1;
    if (!cell.pass) {
      entry.fails += 1;
      if (cell.failureMode) entry.modes.add(cell.failureMode);
    }
    tally.set(key, entry);
  }
}
for (const entry of tally.values()) entry.fails += unparsable;

const systematic = [];
const flaky = [];
for (const [key, entry] of [...tally.entries()].sort()) {
  const line = `${key}: failed ${entry.fails}/${attempts.length} attempts` +
    (entry.modes.size ? ` (${[...entry.modes].join(', ')})` : '');
  if (entry.fails >= failThreshold) systematic.push(line);
  else if (entry.fails > 0) flaky.push(line);
}

if (flaky.length > 0) {
  console.log(`Flaky cells absorbed (failed < ${failThreshold}/${attempts.length}):`);
  for (const line of flaky) console.log(`  ${line}`);
}
if (systematic.length > 0) {
  console.log(`FAIL — cells failing in >= ${failThreshold}/${attempts.length} attempts (systematic):`);
  for (const line of systematic) console.log(`  ${line}`);
  process.exit(1);
}
console.log(`PASS — no cell failed in >= ${failThreshold}/${attempts.length} attempts` +
  (unparsable ? ` (${unparsable} unparsable attempt(s) counted against every cell)` : ''));
