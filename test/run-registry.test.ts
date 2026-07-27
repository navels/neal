import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWriterRunSelection } from '../src/neal/commands/runtime.js';
import { getActiveRunLockPath, type ActiveRunLock } from '../src/neal/run-lock.js';
import {
  getCurrentRunPointerPath,
  getRunIdFromRunDir,
  getRunStatePathForRunId,
  listRuns,
  resolveRunStatePath,
} from '../src/neal/run-registry.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

async function createRunState(cwd: string, runId: string, mutate?: (state: OrchestrationState) => OrchestrationState) {
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, `${runId}.md`);
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(cwd),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'base',
  );

  return mutate?.(initialState) ?? initialState;
}

async function saveRun(cwd: string, runId: string, mutate?: (state: OrchestrationState) => OrchestrationState) {
  const state = await createRunState(cwd, runId, mutate);
  return saveState(getRunStatePath(state.runDir), state);
}

test('run registry derives run ids and run-local state paths', () => {
  assert.equal(getRunIdFromRunDir('/repo/.neal/runs/abc'), 'abc');
  assert.equal(getRunStatePathForRunId('/repo', 'abc'), '/repo/.neal/runs/abc/RUN_STATE.json');
  assert.throws(() => getRunStatePathForRunId('/repo', '../abc'), /Invalid Neal run id/);
});

test('resolveRunStatePath prefers .neal/current.json and exact run-local state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-current-'));
  const runId = '2026-04-25T18-00-00.000Z-current';
  const saved = await saveRun(cwd, runId);

  const resolution = await resolveRunStatePath({ cwd });

  assert.deepEqual(resolution, {
    statePath: getRunStatePath(saved.runDir),
    runId,
    source: 'current_pointer',
  });

  const pointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as {
    runId: string;
    runStatePath: string;
    planDoc: string;
    topLevelMode: string;
  };
  assert.equal(pointer.runId, runId);
  assert.equal(pointer.runStatePath, `.neal/runs/${runId}/RUN_STATE.json`);
  assert.equal(pointer.planDoc, saved.planDoc);
  assert.equal(pointer.topLevelMode, 'execute');
});

test('resolveRunStatePath fails clearly when the default current pointer is missing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-missing-current-'));

  await assert.rejects(
    () => resolveRunStatePath({ cwd }),
    /No \.neal\/current\.json pointer found; run neal status --all to choose an explicit run id/,
  );
});

test('explicit run selection uses the selected run-local state path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-explicit-'));
  await saveRun(cwd, '2026-04-25T18-00-00.000Z-current');
  const selectedRun = await saveRun(cwd, '2026-04-25T19-00-00.000Z-selected');

  const resolution = await resolveRunStatePath({
    cwd,
    runId: '2026-04-25T19-00-00.000Z-selected',
  });

  assert.deepEqual(resolution, {
    statePath: getRunStatePath(selectedRun.runDir),
    runId: '2026-04-25T19-00-00.000Z-selected',
    source: 'explicit_run',
  });
});

test('resolveWriterRunSelection loads a selected run without acquiring the active writer lock', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-writer-selection-'));
  await saveRun(cwd, '2026-04-25T18-00-00.000Z-current');
  const selectedRun = await saveRun(cwd, '2026-04-25T19-00-00.000Z-selected');
  const lockPath = getActiveRunLockPath(cwd);
  const lock: ActiveRunLock = {
    version: 1,
    runId: '2026-04-25T18-00-00.000Z-current',
    runStatePath: '.neal/runs/2026-04-25T18-00-00.000Z-current/RUN_STATE.json',
    planDoc: join(cwd, 'current.md'),
    topLevelMode: 'execute',
    pid: process.pid,
    hostname: hostname(),
    cwd,
    startedAt: '2026-04-25T18:00:00.000Z',
    updatedAt: '2026-04-25T18:00:00.000Z',
  };
  await mkdir(join(cwd, '.neal'), { recursive: true });
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  const beforeLockBytes = await readFile(lockPath, 'utf8');

  const selection = await resolveWriterRunSelection({
    cwd,
    runId: '2026-04-25T19-00-00.000Z-selected',
  });

  assert.equal(selection.selectedRunId, '2026-04-25T19-00-00.000Z-selected');
  assert.equal(selection.statePath, getRunStatePath(selectedRun.runDir));
  assert.equal(selection.state.runDir, selectedRun.runDir);
  assert.equal(selection.source, 'explicit_run');
  assert.equal(await readFile(lockPath, 'utf8'), beforeLockBytes);
});

test('--run latest resolves only through the current pointer', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-latest-'));
  const currentRun = await saveRun(cwd, '2026-04-25T18-00-00.000Z-current');
  const newerRun = await createRunState(cwd, '2026-04-25T20-00-00.000Z-newer');
  await saveState(getRunStatePath(newerRun.runDir), newerRun);

  const resolution = await resolveRunStatePath({ cwd, runId: 'latest' });

  assert.equal(resolution.statePath, getRunStatePath(currentRun.runDir));
  assert.equal(resolution.runId, '2026-04-25T18-00-00.000Z-current');

  await rm(getCurrentRunPointerPath(cwd));
  await assert.rejects(
    () => resolveRunStatePath({ cwd, runId: 'latest' }),
    /No \.neal\/current\.json pointer found for --run latest/,
  );
});

test('explicit run selection requires readable run-local state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-explicit-'));
  await saveRun(cwd, '2026-04-25T18-00-00.000Z-current');

  await assert.rejects(
    () => resolveRunStatePath({ cwd, runId: '2026-04-25T19-00-00.000Z-missing' }),
    /No run state found for --run 2026-04-25T19-00-00.000Z-missing/,
  );
});

test('listRuns ignores malformed run directories and sorts newest first', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-registry-list-'));
  const oldRun = await createRunState(cwd, '2026-04-25T18-00-00.000Z-old', (state) => ({
    ...state,
    status: 'blocked',
    phase: 'blocked',
  }));
  const newRun = await createRunState(cwd, '2026-04-25T20-00-00.000Z-new', (state) => ({
    ...state,
    topLevelMode: 'plan',
    phase: 'coder_plan',
  }));
  const tieRun = await createRunState(cwd, '2026-04-25T22-00-00.000Z-zzz');
  await saveState(getRunStatePath(oldRun.runDir), oldRun);
  await saveState(getRunStatePath(newRun.runDir), newRun);
  await saveState(getRunStatePath(tieRun.runDir), tieRun);

  async function rewriteDates(state: OrchestrationState, createdAt: string, updatedAt: string) {
    const statePath = getRunStatePath(state.runDir);
    const savedState = JSON.parse(await readFile(statePath, 'utf8')) as OrchestrationState;
    await writeFile(statePath, JSON.stringify({ ...savedState, createdAt, updatedAt }, null, 2) + '\n', 'utf8');
  }

  await rewriteDates(oldRun, '2026-04-25T18:00:00.000Z', '2026-04-25T20:00:00.000Z');
  await rewriteDates(newRun, '2026-04-25T20:00:00.000Z', '2026-04-25T21:00:00.000Z');
  await rewriteDates(tieRun, '2026-04-25T21:00:00.000Z', '2026-04-25T21:00:00.000Z');
  await mkdir(join(cwd, '.neal', 'runs', '.hidden'), { recursive: true });
  await mkdir(join(cwd, '.neal', 'runs', 'bad-json'), { recursive: true });
  await writeFile(join(cwd, '.neal', 'runs', 'bad-json', 'RUN_STATE.json'), '{', 'utf8');
  await mkdir(join(cwd, '.neal', 'runs', 'missing-state'), { recursive: true });

  const runs = await listRuns(cwd);

  assert.deepEqual(runs.map((run) => run.runId), [
    '2026-04-25T22-00-00.000Z-zzz',
    '2026-04-25T20-00-00.000Z-new',
    '2026-04-25T18-00-00.000Z-old',
  ]);
  assert.deepEqual(runs.map((run) => run.topLevelMode), ['execute', 'plan', 'execute']);
  assert.deepEqual(runs.map((run) => run.status), ['running', 'running', 'blocked']);
});
