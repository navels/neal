// Render a `neal compat --json` report as a GitHub-flavored markdown table.
//
// scripts/qualify-sdk.sh posts compat evidence to the SDK-bump PR. A raw JSON
// dump is unreadable in a PR; this renders the same report as a per-cell table
// (role / fixture / diff / result / failure mode / detail) under a one-line
// heading with the adapter label and the pass count.
//
// Usage: node scripts/compat-md.mjs <report.json> [label]
//   label  optional heading text (e.g. "openai-codex / gpt-5.5")
// Always exits 0: this is a formatter, not a verdict — an unreadable or
// unparseable report becomes a visible note rather than a failure.

import { readFileSync } from 'node:fs';

const [path, label] = process.argv.slice(2);
if (!path) {
  console.error('usage: node scripts/compat-md.mjs <report.json> [label]');
  process.exit(0);
}

// Collapse whitespace, escape pipes so a detail string can't break the table,
// and bound the length so a stack-trace detail doesn't blow up the row.
function cellText(value, max = 160) {
  if (value === null || value === undefined || value === '') return '';
  const flat = String(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  const heading = label ? `**${cellText(label)}**` : '**compat**';
  console.log(`${heading} — no parseable report (${cellText(error instanceof Error ? error.message : String(error))}).`);
  process.exit(0);
}

const cells = Array.isArray(report.cells) ? report.cells : [];
const passCount = cells.filter((c) => c.pass).length;
const verdict = report.overallPass === true ? 'PASS' : 'FAIL';
const heading = label ? `${cellText(label)} — ` : '';
console.log(`**${heading}${verdict}** (${passCount}/${cells.length} cells)`);
console.log('');

if (cells.length === 0) {
  console.log('_(no cells in report)_');
  process.exit(0);
}

console.log('| Role | Fixture | Diff | Blocking | Result | Failure mode | Detail |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const c of cells) {
  const diff = c.diffKind ?? '—';
  // Blocking findings on this diff. Null for non-reviewer or errored cells, and
  // absent entirely from a schemaVersion 1 report — both render as an em dash.
  const blocking = c.blockingCount ?? '—';
  const result = c.pass ? 'PASS' : 'FAIL';
  const mode = c.pass ? '' : cellText(c.failureMode || '?', 40);
  const detail = c.pass ? '' : cellText(c.detail);
  console.log(
    `| ${cellText(c.role)} | ${cellText(c.fixtureId)} | ${diff} | ${blocking} | ${result} | ${mode} | ${detail} |`,
  );
}
