// Reviewer-recall eval scoring (issue #22 Phase B).
//
// Given a labeled fixture set — diffs with known defects, plus clean diffs —
// and the findings a reviewer produced for each, this computes recall,
// precision, and blocking-finding rate. It is the measurement instrument for
// the eval-gated reviewer-doctrine rewrite (Phase C): run it against a
// reviewer prompt before and after a change and compare the numbers.
//
// The scoring here is pure and deterministic; the live reviewer invocation
// lives in scripts/eval-reviewer.mjs (operator-run, subscription-billed, like
// scripts/qualify-sdk.sh). Matching is intentionally coarse — a blocking
// finding matches an expected label when they name the same file — because a
// finer match (defect-class, line range) would encode judgment the labels
// cannot reliably carry. The coarseness is documented so a reader does not
// over-trust the numbers: recall counts "did the reviewer flag the right
// file", not "did it describe the exact defect".

export type ReviewerEvalExpectedFinding = {
  // Repo-relative path (as it appears in the fixture diff) the defect lives in.
  file: string;
  // Short slug for the kind of defect (e.g. 'off-by-one', 'missing-null-check').
  // Recorded for reporting and class-level breakdowns; not required to match.
  defectClass: string;
  description: string;
};

export type ReviewerEvalFixture = {
  id: string;
  // 'defective' fixtures carry >=1 expected finding; 'clean' fixtures carry
  // none and exist to measure false positives.
  kind: 'defective' | 'clean';
  expectedFindings: ReviewerEvalExpectedFinding[];
};

// A projection of the reviewer's output for one fixture: the severity and
// touched files of each finding it produced. Only blocking findings count
// toward recall/precision (a non_blocking note is not an accept-or-fix
// verdict); the projection carries both so the report can show finding rate
// including non-blocking noise.
export type ReviewerEvalObservationFinding = {
  severity: 'blocking' | 'non_blocking';
  files: string[];
};

export type ReviewerEvalObservation = {
  fixtureId: string;
  findings: ReviewerEvalObservationFinding[];
};

export type ReviewerEvalFixtureResult = {
  fixtureId: string;
  kind: 'defective' | 'clean';
  matchedLabels: ReviewerEvalExpectedFinding[];
  missedLabels: ReviewerEvalExpectedFinding[];
  truePositiveFindingCount: number;
  falsePositiveFindingCount: number;
  blockingFindingCount: number;
};

export type ReviewerEvalReport = {
  fixtures: ReviewerEvalFixtureResult[];
  totalFixtures: number;
  defectiveFixtures: number;
  cleanFixtures: number;
  // recall = expected labels flagged / total expected labels. null when there
  // are no labels (no defective fixtures).
  recall: number | null;
  // precision = blocking findings that hit a label / all blocking findings.
  // null when the reviewer produced no blocking findings anywhere.
  precision: number | null;
  totalExpectedLabels: number;
  matchedLabels: number;
  totalBlockingFindings: number;
  truePositiveFindings: number;
  falsePositiveFindings: number;
  // clean fixtures the reviewer flagged with >=1 blocking finding / clean
  // fixtures. null when there are no clean fixtures.
  cleanFalsePositiveRate: number | null;
  cleanFixturesFlagged: number;
  // mean blocking findings per fixture.
  blockingFindingRate: number;
};

/**
 * Projects a reviewer round's raw findings (as produced by the review-findings
 * loop: objects carrying at least a severity and a files list) into a scored
 * observation. Unknown severities are treated as non_blocking so a malformed
 * finding cannot inflate the blocking count, and a missing files list becomes
 * empty. Keeping this here lets the operator runner stay a thin shell over the
 * tested scoring core.
 */
export function toReviewerEvalObservation(
  fixtureId: string,
  rawFindings: ReadonlyArray<{ severity?: unknown; files?: unknown }>,
): ReviewerEvalObservation {
  const findings: ReviewerEvalObservationFinding[] = rawFindings.map((finding) => ({
    severity: finding.severity === 'blocking' ? 'blocking' : 'non_blocking',
    files: Array.isArray(finding.files) ? finding.files.filter((file): file is string => typeof file === 'string') : [],
  }));
  return { fixtureId, findings };
}

function normalizeFilePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function findingFileSet(observation: ReviewerEvalObservation): Set<string> {
  const files = new Set<string>();
  for (const finding of observation.findings) {
    if (finding.severity !== 'blocking') {
      continue;
    }
    for (const file of finding.files) {
      files.add(normalizeFilePath(file));
    }
  }
  return files;
}

/**
 * Scores reviewer observations against labeled fixtures. Every fixture must
 * have exactly one observation (missing observations throw — a fixture the
 * runner failed to evaluate must not silently count as perfect recall).
 */
export function scoreReviewerEval(
  fixtures: ReviewerEvalFixture[],
  observations: ReviewerEvalObservation[],
): ReviewerEvalReport {
  const observationById = new Map(observations.map((observation) => [observation.fixtureId, observation]));

  const fixtureResults: ReviewerEvalFixtureResult[] = [];
  let totalExpectedLabels = 0;
  let matchedLabels = 0;
  let totalBlockingFindings = 0;
  let truePositiveFindings = 0;
  let falsePositiveFindings = 0;
  let cleanFixturesFlagged = 0;

  for (const fixture of fixtures) {
    const observation = observationById.get(fixture.id);
    if (!observation) {
      throw new Error(`scoreReviewerEval: no observation for fixture ${fixture.id}`);
    }

    const blockingFindings = observation.findings.filter((finding) => finding.severity === 'blocking');
    const blockingFindingCount = blockingFindings.length;
    const findingFiles = findingFileSet(observation);

    const matched: ReviewerEvalExpectedFinding[] = [];
    const missed: ReviewerEvalExpectedFinding[] = [];
    const labeledFiles = new Set<string>();
    for (const expected of fixture.expectedFindings) {
      const file = normalizeFilePath(expected.file);
      labeledFiles.add(file);
      if (findingFiles.has(file)) {
        matched.push(expected);
      } else {
        missed.push(expected);
      }
    }

    // A blocking finding is a true positive when it touches at least one
    // labeled file; every other blocking finding (all of them on a clean
    // fixture) is a false positive.
    let truePositiveFindingCount = 0;
    let falsePositiveFindingCount = 0;
    for (const finding of blockingFindings) {
      const touchesLabel = finding.files.some((file) => labeledFiles.has(normalizeFilePath(file)));
      if (touchesLabel) {
        truePositiveFindingCount += 1;
      } else {
        falsePositiveFindingCount += 1;
      }
    }

    totalExpectedLabels += fixture.expectedFindings.length;
    matchedLabels += matched.length;
    totalBlockingFindings += blockingFindingCount;
    truePositiveFindings += truePositiveFindingCount;
    falsePositiveFindings += falsePositiveFindingCount;
    if (fixture.kind === 'clean' && blockingFindingCount > 0) {
      cleanFixturesFlagged += 1;
    }

    fixtureResults.push({
      fixtureId: fixture.id,
      kind: fixture.kind,
      matchedLabels: matched,
      missedLabels: missed,
      truePositiveFindingCount,
      falsePositiveFindingCount,
      blockingFindingCount,
    });
  }

  const defectiveFixtures = fixtures.filter((fixture) => fixture.kind === 'defective').length;
  const cleanFixtures = fixtures.filter((fixture) => fixture.kind === 'clean').length;

  return {
    fixtures: fixtureResults,
    totalFixtures: fixtures.length,
    defectiveFixtures,
    cleanFixtures,
    recall: totalExpectedLabels === 0 ? null : matchedLabels / totalExpectedLabels,
    precision: totalBlockingFindings === 0 ? null : truePositiveFindings / totalBlockingFindings,
    totalExpectedLabels,
    matchedLabels,
    totalBlockingFindings,
    truePositiveFindings,
    falsePositiveFindings,
    cleanFalsePositiveRate: cleanFixtures === 0 ? null : cleanFixturesFlagged / cleanFixtures,
    cleanFixturesFlagged,
    blockingFindingRate: fixtures.length === 0 ? 0 : totalBlockingFindings / fixtures.length,
  };
}

/**
 * Renders a report as a compact human-readable table plus a summary line.
 * The machine-readable form is the ReviewerEvalReport itself (write it as
 * JSON); this is for terminal output.
 */
export function renderReviewerEvalReport(report: ReviewerEvalReport): string {
  const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  const lines: string[] = [];
  lines.push('| Fixture | Kind | Labels hit | Blocking | False+ |');
  lines.push('|---|---|---:|---:|---:|');
  for (const fixture of report.fixtures) {
    const labels =
      fixture.kind === 'defective'
        ? `${fixture.matchedLabels.length}/${fixture.matchedLabels.length + fixture.missedLabels.length}`
        : '—';
    lines.push(
      `| ${fixture.fixtureId} | ${fixture.kind} | ${labels} | ${fixture.blockingFindingCount} | ${fixture.falsePositiveFindingCount} |`,
    );
  }
  lines.push('');
  lines.push(
    `Recall ${pct(report.recall)} (${report.matchedLabels}/${report.totalExpectedLabels} labels) · ` +
      `Precision ${pct(report.precision)} (${report.truePositiveFindings}/${report.totalBlockingFindings} findings) · ` +
      `Clean false-positive ${pct(report.cleanFalsePositiveRate)} (${report.cleanFixturesFlagged}/${report.cleanFixtures}) · ` +
      `Blocking rate ${report.blockingFindingRate.toFixed(2)}/fixture`,
  );
  return lines.join('\n');
}
