import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  inspectPlanDocDisposition,
  toPlanDocMetadata,
} from '../src/neal/plan-doc.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createPlanDocumentRepo(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'empty-excludes'), '', 'utf8');
  await runGit(cwd, 'config', 'core.excludesFile', join(root, 'empty-excludes'));
  await writeFile(join(cwd, 'README.md'), 'base\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  return { root, cwd };
}

test('plan document helpers classify a repo-local nonignored plan document', async () => {
  const { cwd } = await createPlanDocumentRepo('neal-plan-doc-local-');
  await mkdir(join(cwd, 'plans'), { recursive: true });
  const planDoc = join(cwd, 'plans', 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const inspection = await inspectPlanDocDisposition(cwd, planDoc);

  assert.equal(inspection.disposition, 'metadata_only_clean');
  assert.equal(inspection.repoRelativePath, 'plans/PLAN.md');
  assert.equal(inspection.normalizedPlanDoc, 'plans/PLAN.md');
  assert.equal(inspection.eligibleForCommit, true);
  assert.equal(inspection.exists, true);
  assert.equal(inspection.isRegularFile, true);
  assert.equal(inspection.ignored, false);
  assert.deepEqual(toPlanDocMetadata(inspection), {
    selectedPlanDoc: planDoc,
    normalizedPlanDoc: 'plans/PLAN.md',
    planDocDisposition: 'metadata_only_clean',
    repoRelativePath: 'plans/PLAN.md',
    eligibleForCommit: true,
  });
});

test('plan document helpers classify changed repo-local plans as included', async () => {
  const { cwd } = await createPlanDocumentRepo('neal-plan-doc-included-');
  await mkdir(join(cwd, 'plans'), { recursive: true });
  const planDoc = join(cwd, 'plans', 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const inspection = await inspectPlanDocDisposition(cwd, planDoc, {
    changedFiles: ['plans/PLAN.md'],
  });

  assert.equal(inspection.disposition, 'included');
  assert.equal(inspection.eligibleForCommit, true);
});

test('plan document helpers classify ignored plan documents', async () => {
  const { cwd } = await createPlanDocumentRepo('neal-plan-doc-ignored-');
  await writeFile(join(cwd, '.gitignore'), 'tmp/\n', 'utf8');
  await mkdir(join(cwd, 'tmp'), { recursive: true });
  const planDoc = join(cwd, 'tmp', 'PLAN.md');
  await writeFile(planDoc, '# Ignored Plan\n', 'utf8');

  const inspection = await inspectPlanDocDisposition(cwd, planDoc);

  assert.equal(inspection.disposition, 'ignored');
  assert.equal(inspection.repoRelativePath, 'tmp/PLAN.md');
  assert.equal(inspection.normalizedPlanDoc, 'tmp/PLAN.md');
  assert.equal(inspection.eligibleForCommit, false);
  assert.equal(inspection.exists, true);
  assert.equal(inspection.isRegularFile, true);
  assert.equal(inspection.ignored, true);
});

test('plan document helpers classify outside-repository plan documents', async () => {
  const { root, cwd } = await createPlanDocumentRepo('neal-plan-doc-outside-');
  const planDoc = join(root, 'OUTSIDE.md');
  await writeFile(planDoc, '# Outside Plan\n', 'utf8');

  const inspection = await inspectPlanDocDisposition(cwd, planDoc);

  assert.equal(inspection.disposition, 'outside_repo');
  assert.equal(inspection.repoRelativePath, null);
  assert.equal(inspection.normalizedPlanDoc, planDoc);
  assert.equal(inspection.eligibleForCommit, false);
});

test('plan document helpers classify missing repo-local plan documents', async () => {
  const { cwd } = await createPlanDocumentRepo('neal-plan-doc-missing-');
  const planDoc = join(cwd, 'plans', 'MISSING.md');

  const inspection = await inspectPlanDocDisposition(cwd, planDoc);

  assert.equal(inspection.disposition, 'missing');
  assert.equal(inspection.repoRelativePath, 'plans/MISSING.md');
  assert.equal(inspection.eligibleForCommit, false);
  assert.equal(inspection.exists, false);
});

test('plan document helpers classify non-file plan document paths', async () => {
  const { cwd } = await createPlanDocumentRepo('neal-plan-doc-non-file-');
  const planDoc = join(cwd, 'plans', 'PLAN.md');
  await mkdir(planDoc, { recursive: true });

  const inspection = await inspectPlanDocDisposition(cwd, planDoc);

  assert.equal(inspection.disposition, 'not_regular_file');
  assert.equal(inspection.repoRelativePath, 'plans/PLAN.md');
  assert.equal(inspection.eligibleForCommit, false);
  assert.equal(inspection.exists, true);
  assert.equal(inspection.isRegularFile, false);
});
