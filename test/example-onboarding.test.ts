import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { validatePlanDocument } from '../src/neal/plan-validation.js';
import { getExecutionPlanScopeCount } from '../src/neal/scopes.js';

const execFileAsync = promisify(execFile);

const repoRoot = process.cwd();
const exampleDir = join(repoRoot, 'examples', 'issue-triage-js');
const examplePlanPath = join(exampleDir, 'PLAN.md');
const exampleReadmePath = join(exampleDir, 'README.md');

test('issue triage example plan is structurally valid and scoped', async () => {
  const planDocument = await readFile(examplePlanPath, 'utf8');
  const validation = validatePlanDocument(planDocument);

  assert.equal(
    validation.ok,
    true,
    validation.ok ? 'example plan should validate' : validation.errors.join('\n'),
  );
  assert.equal(validation.executionShape, 'multi_scope');
  assert.deepEqual(await getExecutionPlanScopeCount(examplePlanPath), { kind: 'known', total: 4 });
});

test('issue triage example tests pass without provider calls', async () => {
  // The example's `test` script is plain `node --test`, so run it with the
  // current node binary directly instead of spawning `pnpm --dir ... test`:
  // pnpm is not reliably on PATH in every contributor environment (corepack
  // shims managed through a version manager may not be exposed to the test
  // process), and the script needs no package-manager behavior. The assertion
  // below keeps this invocation in sync with the example's declared script.
  const examplePackageJson = JSON.parse(
    await readFile(join(exampleDir, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  assert.equal(
    examplePackageJson.scripts?.test,
    'node --test',
    'examples/issue-triage-js changed its test script; update this direct node spawn to match',
  );

  try {
    await execFileAsync(process.execPath, ['--test'], {
      cwd: exampleDir,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const failure = error as Partial<{
      stdout: string;
      stderr: string;
      message: string;
    }>;
    assert.fail(
      [
        'node --test (in examples/issue-triage-js) failed.',
        failure.stdout ? `stdout:\n${failure.stdout}` : null,
        failure.stderr ? `stderr:\n${failure.stderr}` : null,
        failure.message ? `message:\n${failure.message}` : null,
      ].filter(Boolean).join('\n\n'),
    );
  }
});

test('issue triage example README documents local and live paths', async () => {
  const readme = await readFile(exampleReadmePath, 'utf8');

  assert.match(readme, /neal check/u);
  assert.match(readme, /neal run PLAN\.md/u);
  assert.match(readme, /pnpm test/u);
});
