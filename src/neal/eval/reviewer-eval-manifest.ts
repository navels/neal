import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { ReviewerEvalExpectedFinding, ReviewerEvalFixture } from './reviewer-eval.js';

// A fixture as loaded from examples/reviewer-eval/manifest.json: the scoring
// fixture (id, kind, expected findings) plus the on-disk paths the runner
// applies. Validation is deliberately structural — it checks that a defective
// fixture labels at least one file the diff actually touches, and a clean
// fixture labels none. It does NOT try to prove the diff exhibits the labeled
// defect; that proof was an over-specification that made the fixtures
// impossible to author (see issue #22). A human authoring a fixture asserts
// the defect; the structural check only catches a label pointing at a file the
// diff never changes.
export type ReviewerEvalManifestFixture = ReviewerEvalFixture & {
  diffPath: string;
  baseDir: string;
};

function fail(context: string, message: string): never {
  throw new Error(`reviewer-eval manifest: ${context} ${message}`);
}

function asString(value: unknown, context: string, field: string): string {
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    fail(context, `must define a non-empty string ${field}`);
  }
  return candidate as string;
}

function parseExpectedFinding(raw: unknown, context: string): ReviewerEvalExpectedFinding {
  if (typeof raw !== 'object' || raw === null) {
    fail(context, 'each expectedFindings entry must be an object');
  }
  return {
    file: asString(raw, context, 'file'),
    defectClass: asString(raw, context, 'defectClass'),
    description: asString(raw, context, 'description'),
  };
}

// Every path the diff adds or modifies, read from its `+++ b/<path>` headers.
function diffTargetFiles(diffText: string): Set<string> {
  const files = new Set<string>();
  for (const line of diffText.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    if (match) {
      files.add(match[1].trim());
    }
  }
  return files;
}

export function loadReviewerEvalManifest(manifestDir: string): ReviewerEvalManifestFixture[] {
  const dir = isAbsolute(manifestDir) ? manifestDir : resolve(manifestDir);
  const manifestPath = join(dir, 'manifest.json');
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const rawFixtures = (parsed as { fixtures?: unknown }).fixtures;
  if (!Array.isArray(rawFixtures) || rawFixtures.length === 0) {
    fail('manifest.json', 'must define a non-empty fixtures array');
  }

  const seen = new Set<string>();
  return rawFixtures.map((raw, index) => {
    const context = `fixtures[${index}]`;
    if (typeof raw !== 'object' || raw === null) {
      fail(context, 'must be an object');
    }
    const id = asString(raw, context, 'id');
    if (seen.has(id)) {
      fail(context, `duplicate fixture id ${id}`);
    }
    seen.add(id);

    const kind = (raw as Record<string, unknown>).kind;
    if (kind !== 'defective' && kind !== 'clean') {
      fail(id, "kind must be 'defective' or 'clean'");
    }
    const diff = asString(raw, id, 'diff');
    const baseDirRelative = asString(raw, id, 'baseDir');

    const rawExpected = (raw as Record<string, unknown>).expectedFindings;
    if (!Array.isArray(rawExpected)) {
      fail(id, 'expectedFindings must be an array');
    }
    const expectedFindings = rawExpected.map((entry) => parseExpectedFinding(entry, id));

    if (kind === 'defective' && expectedFindings.length === 0) {
      fail(id, 'a defective fixture must label at least one expected finding');
    }
    if (kind === 'clean' && expectedFindings.length > 0) {
      fail(id, 'a clean fixture must not label any expected findings');
    }

    const diffPath = join(dir, diff);
    const diffText = readFileSync(diffPath, 'utf8');
    const targetFiles = diffTargetFiles(diffText);
    for (const expected of expectedFindings) {
      if (!targetFiles.has(expected.file)) {
        fail(id, `expected finding file ${expected.file} is not modified by ${diff}`);
      }
    }

    return {
      id,
      kind,
      expectedFindings,
      diffPath,
      baseDir: join(dir, baseDirRelative),
    };
  });
}
