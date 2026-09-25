import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildRunChangesSnapshot,
  renderHumanRunChanges,
} from '../src/neal/changes.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, saveState } from '../src/neal/state.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}

async function createFixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-changes-'));
  await git(cwd, ['init']);
  await git(cwd, ['config', 'user.email', 'neal@example.test']);
  await git(cwd, ['config', 'user.name', 'Neal Test']);

  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n', 'utf8');
  await writeFile(join(cwd, 'app.txt'), 'before\n', 'utf8');
  await git(cwd, ['add', 'PLAN.md', 'app.txt']);
  await git(cwd, ['commit', '-m', 'baseline']);
  const baseCommit = await git(cwd, ['rev-parse', 'HEAD']);

  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'run-changes');
  await mkdir(runDir, { recursive: true });
  const initial = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [planDoc],
      agentConfig: getDefaultAgentConfig(cwd),
      autoSquashOnCompletion: false,
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );
  await saveState(getRunStatePath(runDir), {
    ...initial,
    status: 'failed',
  });

  return { cwd, baseCommit };
}

test('changes reports no source changes for a failed run whose HEAD and worktree are unchanged', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));

  const snapshot = await buildRunChangesSnapshot({ cwd: fixture.cwd });

  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.changed, false);
  assert.equal(snapshot.currentScope.changed, false);
  assert.equal(snapshot.currentScope.commits.length, 0);
  assert.equal(snapshot.currentScope.files.length, 0);
  assert.equal(snapshot.worktree.changed, false);
  assert.equal(snapshot.runTotal.changed, false);

  const rendered = renderHumanRunChanges(snapshot);
  assert.match(rendered, /Changed: no/);
  assert.match(rendered, /Committed since scope base: 0 commit\(s\), 0 file\(s\)/);
  assert.match(rendered, /Uncommitted worktree: clean/);
});

test('changes reports uncommitted source files while ignoring Neal-owned run artifacts', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));

  await writeFile(join(fixture.cwd, 'app.txt'), 'after\n', 'utf8');
  const snapshot = await buildRunChangesSnapshot({ cwd: fixture.cwd, runId: 'latest' });

  assert.equal(snapshot.changed, true);
  assert.equal(snapshot.currentScope.changed, false);
  assert.equal(snapshot.worktree.changed, true);
  assert.deepEqual(snapshot.worktree.files, ['app.txt']);
  assert.ok(snapshot.worktree.status.some((line) => line.includes('app.txt')));
  assert.ok(snapshot.worktree.status.every((line) => !line.includes('.neal')));
});

test('changes reports commits and changed files since the current scope base', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));

  await writeFile(join(fixture.cwd, 'app.txt'), 'after\n', 'utf8');
  await git(fixture.cwd, ['add', 'app.txt']);
  await git(fixture.cwd, ['commit', '-m', 'change app']);

  const snapshot = await buildRunChangesSnapshot({ cwd: fixture.cwd });

  assert.equal(snapshot.changed, true);
  assert.equal(snapshot.currentScope.changed, true);
  assert.equal(snapshot.currentScope.commits.length, 1);
  assert.deepEqual(snapshot.currentScope.files, ['app.txt']);
  assert.equal(snapshot.worktree.changed, false);
  assert.equal(snapshot.runTotal.changed, true);
});

test('changes reports an unknown committed range when HEAD diverges from the recorded base', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.cwd, { recursive: true, force: true }));

  await git(fixture.cwd, ['checkout', '--orphan', 'other-history']);
  await git(fixture.cwd, ['rm', '-rf', '.']);
  await writeFile(join(fixture.cwd, 'other.txt'), 'other\n', 'utf8');
  await git(fixture.cwd, ['add', 'other.txt']);
  await git(fixture.cwd, ['commit', '-m', 'other history']);

  const snapshot = await buildRunChangesSnapshot({ cwd: fixture.cwd });

  assert.equal(snapshot.changed, null);
  assert.equal(snapshot.currentScope.comparable, false);
  assert.equal(snapshot.currentScope.changed, null);
  assert.match(snapshot.currentScope.reason ?? '', /not descended/);
});
