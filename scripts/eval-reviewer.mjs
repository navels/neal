// Reviewer-recall eval runner (issue #22 Phase B). Operator-run, like
// scripts/qualify-sdk.sh: it makes real reviewer calls, so it bills whatever
// the configured reviewer bills (subscription when run from a checkout with an
// authenticated Codex/Claude CLI).
//
// For each labeled fixture in examples/reviewer-eval/ it builds a throwaway git
// repo from the fixture's base/ tree, applies change.diff, runs the configured
// reviewer against that commit, and scores its findings against the fixture's
// labels. Prints a recall/precision/finding-rate report and writes
// EVAL_REPORT.json. Run it before and after a reviewer-doctrine change and
// compare the numbers — that is the gate for the Phase C prompt rewrite.
//
// The scoring, manifest loading, and finding projection are the tested core in
// src/neal/eval/*; this script is the thin live shell around them. Build first
// (pnpm build) so the dist/ imports resolve.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(root, 'examples/reviewer-eval');

const { loadReviewerEvalManifest } = await import(join(root, 'dist/neal/eval/reviewer-eval-manifest.js'));
const { scoreReviewerEval, renderReviewerEvalReport, toReviewerEvalObservation } = await import(
  join(root, 'dist/neal/eval/reviewer-eval.js')
);
const { runNealReviewCli } = await import(join(root, 'dist/neal/review-findings/run.js'));
const { createAgentReviewFindingsProviderAdapter } = await import(join(root, 'dist/neal/review-findings/provider.js'));
const { DEFAULT_REVIEW_INSTRUCTION } = await import(join(root, 'dist/neal/cli.js'));

// A ParsedReviewArgs reviewing the most recent commit (the applied diff),
// matching compat's buildReviewParsedArgs exactly.
function reviewLastCommit() {
  return {
    instruction: DEFAULT_REVIEW_INSTRUCTION,
    instructionSource: 'default',
    selector: { kind: 'last', count: 1 },
  };
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
}

async function evaluateFixture(fixture) {
  const cwd = mkdtempSync(join(tmpdir(), `neal-eval-${fixture.id}-`));
  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  try {
    cpSync(fixture.baseDir, cwd, { recursive: true });
    git(cwd, 'init');
    git(cwd, 'config', 'user.email', 'eval@neal.local');
    git(cwd, 'config', 'user.name', 'neal-eval');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'base');
    execFileSync('git', ['apply', fixture.diffPath], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'change');

    const provider = createAgentReviewFindingsProviderAdapter({ cwd });
    const result = await runNealReviewCli({
      cwd,
      parsed: reviewLastCommit(),
      stdout: sink,
      stderr: sink,
      provider,
    });
    return toReviewerEvalObservation(fixture.id, result.draft.findings ?? []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const fixtures = loadReviewerEvalManifest(examplesDir);
console.error(`Running the configured reviewer against ${fixtures.length} fixtures (real provider calls)...`);
const observations = [];
for (const fixture of fixtures) {
  console.error(`  ${fixture.id} (${fixture.kind})...`);
  observations.push(await evaluateFixture(fixture));
}

const report = scoreReviewerEval(
  fixtures.map((fixture) => ({ id: fixture.id, kind: fixture.kind, expectedFindings: fixture.expectedFindings })),
  observations,
);

const reportPath = join(root, 'EVAL_REPORT.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(renderReviewerEvalReport(report));
console.error(`\nMachine-readable report: ${reportPath}`);
