import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReviewerEvalManifest } from '../src/neal/eval/reviewer-eval-manifest.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../examples/reviewer-eval', import.meta.url));

test('the shipped reviewer-eval fixture set loads and satisfies its structural contract', () => {
  const fixtures = loadReviewerEvalManifest(EXAMPLES_DIR);
  assert.ok(fixtures.length >= 3, 'expected a starter set of at least three fixtures');
  const defective = fixtures.filter((fixture) => fixture.kind === 'defective');
  const clean = fixtures.filter((fixture) => fixture.kind === 'clean');
  assert.ok(defective.length >= 1, 'expected at least one defective fixture');
  assert.ok(clean.length >= 1, 'expected at least one clean fixture for false-positive measurement');
  for (const fixture of defective) {
    assert.ok(fixture.expectedFindings.length >= 1);
  }
  for (const fixture of clean) {
    assert.equal(fixture.expectedFindings.length, 0);
  }
});

function writeManifest(fixtures: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'neal-eval-manifest-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ fixtures }));
  return dir;
}

test('a defective fixture whose label names a file the diff does not touch is rejected', () => {
  const dir = writeManifest([
    { id: 'bad', kind: 'defective', diff: 'bad/change.diff', baseDir: 'bad/base', expectedFindings: [{ file: 'src/other.ts', defectClass: 'x', description: 'y' }] },
  ]);
  mkdirSync(join(dir, 'bad'));
  writeFileSync(
    join(dir, 'bad/change.diff'),
    ['diff --git a/src/real.ts b/src/real.ts', '--- a/src/real.ts', '+++ b/src/real.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n'),
  );
  assert.throws(() => loadReviewerEvalManifest(dir), /file src\/other\.ts is not modified/);
});

test('a defective fixture with no labels is rejected', () => {
  const dir = writeManifest([
    { id: 'nolabels', kind: 'defective', diff: 'd.diff', baseDir: 'b', expectedFindings: [] },
  ]);
  assert.throws(() => loadReviewerEvalManifest(dir), /must label at least one expected finding/);
});

test('a clean fixture with labels is rejected', () => {
  const dir = writeManifest([
    { id: 'dirty-clean', kind: 'clean', diff: 'd.diff', baseDir: 'b', expectedFindings: [{ file: 'x.ts', defectClass: 'x', description: 'y' }] },
  ]);
  assert.throws(() => loadReviewerEvalManifest(dir), /must not label any expected findings/);
});

test('duplicate fixture ids are rejected', () => {
  const dir = writeManifest([
    { id: 'dup', kind: 'clean', diff: 'a.diff', baseDir: 'a', expectedFindings: [] },
    { id: 'dup', kind: 'clean', diff: 'b.diff', baseDir: 'b', expectedFindings: [] },
  ]);
  const emptyDiff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  writeFileSync(join(dir, 'a.diff'), emptyDiff);
  writeFileSync(join(dir, 'b.diff'), emptyDiff);
  assert.throws(() => loadReviewerEvalManifest(dir), /duplicate fixture id dup/);
});
