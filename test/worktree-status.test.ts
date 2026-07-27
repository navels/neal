import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterAllowedDirtyPathStatus,
  filterWrapperOwnedWorktreeStatus,
  formatDirtyWorktreeDiagnostic,
  getLikelyScratchLeakPaths,
  parseWorktreeStatusLine,
} from '../src/neal/worktree-status.js';

test('parseWorktreeStatusLine extracts paths from short status entries', () => {
  assert.deepEqual(parseWorktreeStatusLine(' M src/file.ts'), {
    raw: ' M src/file.ts',
    pathText: 'src/file.ts',
    paths: ['src/file.ts'],
  });
  assert.deepEqual(parseWorktreeStatusLine('R  old/path.ts -> new/path.ts'), {
    raw: 'R  old/path.ts -> new/path.ts',
    pathText: 'old/path.ts -> new/path.ts',
    paths: ['old/path.ts', 'new/path.ts'],
  });
  assert.equal(parseWorktreeStatusLine(''), null);
});

test('getLikelyScratchLeakPaths classifies only obvious project-root scratch paths', () => {
  const statusOutput = [
    '?? build_review/',
    ' M src/build_review.ts',
    '?? review_scratch/log.txt',
    '?? .neal/runs/test-run/scratch/reviewer-scope-5-round-1/log.txt',
    '?? docs/scratch-notes.md',
  ].join('\n');

  assert.deepEqual(getLikelyScratchLeakPaths(statusOutput), ['build_review/', 'review_scratch/log.txt']);
});

test('formatDirtyWorktreeDiagnostic explains scratch leakage without hiding ordinary dirtiness', () => {
  const diagnostic = formatDirtyWorktreeDiagnostic({
    statusOutput: ['?? build_review/', ' M src/unrelated.ts'].join('\n'),
    expectedScratchDirs: ['/repo/.neal/runs/test-run/scratch/reviewer-scope-5-round-1'],
  });

  assert.match(diagnostic, /build_review\//);
  assert.match(diagnostic, /\/repo\/\.neal\/runs\/test-run\/scratch\/reviewer-scope-5-round-1/);
  assert.doesNotMatch(diagnostic, /src\/unrelated\.ts/);
  assert.equal(formatDirtyWorktreeDiagnostic({ statusOutput: ' M src/unrelated.ts' }), '');
});

test('filterAllowedDirtyPathStatus preserves relative aliases for missing files', () => {
  assert.equal(filterAllowedDirtyPathStatus('/repo', '?? PLAN.md', ['PLAN.md']), '');
  assert.equal(filterAllowedDirtyPathStatus('/repo', '?? OTHER.md', ['PLAN.md']), '?? OTHER.md');
});

test('filterWrapperOwnedWorktreeStatus filters .neal/ status lines while preserving ordinary paths', () => {
  const statusOutput = [
    '?? .neal/',
    '?? .neal/runs/run-1/REVIEW.md',
    '?? .forge/',
    ' M src/index.ts',
    '?? docs/notes.md',
    'R  .neal/runs/run-1/log.txt -> docs/log.txt',
    'R  .neal/runs/run-1/cache.txt -> .forge/cache.txt',
  ].join('\n');

  assert.equal(
    filterWrapperOwnedWorktreeStatus(statusOutput),
    [
      ' M src/index.ts',
      '?? docs/notes.md',
      'R  .neal/runs/run-1/log.txt -> docs/log.txt',
    ].join('\n'),
  );
});
