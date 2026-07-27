import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getStagedDiff, getWorktreeStatus } from '../src/neal/git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

// Regression: git subprocess output scales with scope artifacts. A scope that
// vendored a ~2 MB fixture produced a staged diff past Node's default 1 MiB
// execFile maxBuffer, killing a live run with "stdout maxBuffer length
// exceeded" instead of any classified failure.
test('a staged diff larger than the default execFile maxBuffer is returned intact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-git-large-diff-'));
  await git(cwd, 'init');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await git(cwd, 'config', 'user.name', 'test');
  // A developer's global commit.gpgsign=true would otherwise try to sign as
  // the throwaway identity above (no secret key) and fail the seed commit.
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'seed.txt'), 'seed\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'seed');

  // > 2 MiB of unique lines so the diff itself exceeds 1 MiB (Node's default).
  const lines = Array.from({ length: 40_000 }, (_, i) => `rate-card-entry-${i}: ${'x'.repeat(40)}`);
  await writeFile(join(cwd, 'large-fixture.json'), lines.join('\n'));
  await git(cwd, 'add', 'large-fixture.json');

  const diff = await getStagedDiff(cwd);
  assert.ok(diff.length > 1024 * 1024, `diff must exceed the default maxBuffer (got ${diff.length} bytes)`);
  assert.match(diff, /rate-card-entry-39999/);

  const status = await getWorktreeStatus(cwd);
  assert.match(status, /large-fixture\.json/);
});
