import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getDiffForRangePaths } from '../src/neal/git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createRepo() {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-git-range-paths-'));
  await git(cwd, 'init');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await git(cwd, 'config', 'user.name', 'test');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(cwd, 'b.ts'), 'export const b = 1;\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'seed');
  const base = await git(cwd, 'rev-parse', 'HEAD');
  await writeFile(join(cwd, 'a.ts'), 'export const a = 2;\n');
  await writeFile(join(cwd, 'b.ts'), 'export const b = 2;\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'change both');
  const head = await git(cwd, 'rev-parse', 'HEAD');
  return { cwd, base, head };
}

// Issue #10: the scope reviewer gets an earlier scope's diff restricted to the
// files the current diff touches again, so the helper must confine the diff to
// the requested paths and never read a path as a revision.
test('getDiffForRangePaths returns only the requested paths for the range', async () => {
  const { cwd, base, head } = await createRepo();

  const diff = await getDiffForRangePaths(cwd, base, head, ['a.ts']);
  assert.match(diff, /diff --git a\/a\.ts b\/a\.ts/);
  assert.match(diff, /\+export const a = 2;/);
  assert.doesNotMatch(diff, /b\.ts/);

  assert.equal(await getDiffForRangePaths(cwd, base, head, []), '');
  assert.equal(await getDiffForRangePaths(cwd, head, head, ['a.ts']), '');
  // A path that does not exist in the range yields an empty diff, not an error.
  assert.equal(await getDiffForRangePaths(cwd, base, head, ['missing.ts']), '');
});
