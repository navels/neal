import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { validatePlanDocument } from '../src/neal/plan-validation.js';

const repoRoot = process.cwd();
const compatDir = join(repoRoot, 'examples', 'compat');
const manifestPath = join(compatDir, 'manifest.json');

interface ReferenceFix {
  file: string;
  from: string;
  to: string;
}

interface ReviewerDiffs {
  goodDiff: string;
  brokenDiff: string;
}

interface CompatFixture {
  id: string;
  roles: string[];
  projectDir: string;
  planDoc?: string;
  issuePrompt?: string;
  verifyCommand: string;
  referenceFix: ReferenceFix;
  reviewer?: ReviewerDiffs;
}

interface CompatManifest {
  fixtures: CompatFixture[];
}

function loadManifest(): CompatManifest {
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as CompatManifest;
  assert.ok(Array.isArray(parsed.fixtures), 'manifest must have a fixtures array');
  assert.ok(parsed.fixtures.length > 0, 'manifest must define at least one fixture');
  return parsed;
}

function copyProject(fixture: CompatFixture): string {
  const dir = mkdtempSync(join(tmpdir(), `compat-${fixture.id}-`));
  cpSync(join(compatDir, fixture.projectDir), dir, { recursive: true });
  return dir;
}

function cleanEnv(): NodeJS.ProcessEnv {
  // A spawned `node --test` inherits NODE_TEST_CONTEXT from this test runner and
  // would report as a child process (exiting 0 regardless of failures). Strip
  // any NODE_TEST_* vars so the child reports its own real exit status.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) {
      delete env[key];
    }
  }
  return env;
}

function runVerify(fixture: CompatFixture, cwd: string): number {
  const parts = fixture.verifyCommand.split(/\s+/u);
  const [command, ...commandArgs] = parts;
  assert.ok(command, `fixture ${fixture.id} must define a verifyCommand`);
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function gitApply(cwd: string, diffPath: string): boolean {
  const init = spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed in ${cwd}`);
  const apply = spawnSync('git', ['apply', diffPath], { cwd, encoding: 'utf8' });
  return apply.status === 0;
}

const manifest = loadManifest();

test('every manifest fixture references files that exist on disk', () => {
  for (const fixture of manifest.fixtures) {
    const projectPath = join(compatDir, fixture.projectDir);
    assert.ok(readFileSync(join(projectPath, 'package.json'), 'utf8'), `${fixture.id} missing package.json`);

    const refPath = join(projectPath, fixture.referenceFix.file);
    const refContents = readFileSync(refPath, 'utf8');
    assert.equal(
      refContents.split(fixture.referenceFix.from).length - 1,
      1,
      `${fixture.id}: referenceFix.from must appear exactly once in ${fixture.referenceFix.file}`,
    );

    if (fixture.planDoc) {
      assert.ok(readFileSync(join(compatDir, fixture.planDoc), 'utf8'), `${fixture.id} missing planDoc`);
    }
    if (fixture.issuePrompt) {
      assert.ok(readFileSync(join(compatDir, fixture.issuePrompt), 'utf8'), `${fixture.id} missing issuePrompt`);
    }
    if (fixture.roles.includes('reviewer')) {
      assert.ok(fixture.reviewer, `${fixture.id} carries reviewer role but no reviewer diffs`);
      assert.ok(readFileSync(join(compatDir, fixture.reviewer.goodDiff), 'utf8'), `${fixture.id} missing goodDiff`);
      assert.ok(readFileSync(join(compatDir, fixture.reviewer.brokenDiff), 'utf8'), `${fixture.id} missing brokenDiff`);
    }
    if (fixture.roles.includes('reviewer') || fixture.roles.includes('coder')) {
      assert.ok(fixture.verifyCommand, `${fixture.id} must define verifyCommand`);
    }
  }
});

test('every coder fixture fails on the buggy source and passes after referenceFix', () => {
  const coderFixtures = manifest.fixtures.filter((fixture) => fixture.roles.includes('coder'));
  assert.ok(coderFixtures.length >= 2, 'expected at least two coder fixtures (2-3 per plan)');

  for (const fixture of coderFixtures) {
    const dir = copyProject(fixture);
    try {
      const buggyStatus = runVerify(fixture, dir);
      assert.notEqual(buggyStatus, 0, `${fixture.id}: verifyCommand should FAIL against the buggy source`);

      const targetFile = join(dir, fixture.referenceFix.file);
      const original = readFileSync(targetFile, 'utf8');
      assert.equal(
        original.split(fixture.referenceFix.from).length - 1,
        1,
        `${fixture.id}: referenceFix.from must appear exactly once`,
      );
      writeFileSync(targetFile, original.replace(fixture.referenceFix.from, fixture.referenceFix.to));

      const fixedStatus = runVerify(fixture, dir);
      assert.equal(fixedStatus, 0, `${fixture.id}: verifyCommand should PASS after applying referenceFix`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('every coder fixture PLAN.md declares executionShape one_shot', () => {
  const coderFixtures = manifest.fixtures.filter((fixture) => fixture.roles.includes('coder'));
  for (const fixture of coderFixtures) {
    assert.ok(fixture.planDoc, `${fixture.id}: coder fixture must define planDoc`);
    const planDocument = readFileSync(join(compatDir, fixture.planDoc), 'utf8');
    const validation = validatePlanDocument(planDocument);
    assert.equal(
      validation.ok,
      true,
      validation.ok ? `${fixture.id} plan valid` : `${fixture.id} plan invalid:\n${validation.errors.join('\n')}`,
    );
    assert.equal(validation.executionShape, 'one_shot', `${fixture.id}: PLAN.md must be one_shot`);
  }
});

test('reviewer goodDiff passes and brokenDiff fails the fixture verifyCommand', () => {
  const reviewerFixtures = manifest.fixtures.filter((fixture) => fixture.roles.includes('reviewer'));
  assert.ok(reviewerFixtures.length >= 1, 'expected at least one reviewer fixture');

  for (const fixture of reviewerFixtures) {
    assert.ok(fixture.reviewer, `${fixture.id}: reviewer fixture must define diffs`);

    const goodDir = copyProject(fixture);
    try {
      const goodApplied = gitApply(goodDir, join(compatDir, fixture.reviewer.goodDiff));
      assert.ok(goodApplied, `${fixture.id}: goodDiff must apply cleanly`);
      assert.equal(
        runVerify(fixture, goodDir),
        0,
        `${fixture.id}: goodDiff must make verifyCommand PASS`,
      );
    } finally {
      rmSync(goodDir, { recursive: true, force: true });
    }

    const brokenDir = copyProject(fixture);
    try {
      const brokenApplied = gitApply(brokenDir, join(compatDir, fixture.reviewer.brokenDiff));
      assert.ok(brokenApplied, `${fixture.id}: brokenDiff must apply cleanly`);
      assert.notEqual(
        runVerify(fixture, brokenDir),
        0,
        `${fixture.id}: brokenDiff must make verifyCommand FAIL`,
      );
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  }
});

test('manifest path layout is internally consistent', () => {
  for (const fixture of manifest.fixtures) {
    if (fixture.planDoc) {
      assert.equal(dirname(fixture.planDoc), fixture.projectDir, `${fixture.id}: planDoc must live under projectDir`);
    }
    if (fixture.issuePrompt) {
      assert.equal(
        dirname(fixture.issuePrompt),
        fixture.projectDir,
        `${fixture.id}: issuePrompt must live under projectDir`,
      );
    }
  }
});
