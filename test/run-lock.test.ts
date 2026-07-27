import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  ActiveRunLockError,
  acquireActiveRunLock,
  getActiveRunLockPath,
  inspectActiveRunLock,
  readActiveRunLock,
  refreshActiveRunLock,
  releaseActiveRunLockSync,
  type ActiveRunLock,
} from '../src/neal/run-lock.js';
import type { ResumeLockEvidence } from '../src/neal/resume-decision.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, saveState } from '../src/neal/state.js';
import { runGit } from './helpers/git.js';
import { nealCliInvocation, normalizeCliStderr } from './helpers/cli.js';

const execFileAsync = promisify(execFile);

function baseLock(cwd: string, overrides: Partial<ActiveRunLock> = {}): ActiveRunLock {
  const now = '2026-04-28T12:00:00.000Z';
  return {
    version: 1,
    runId: 'active-run',
    runStatePath: '.neal/runs/active-run/RUN_STATE.json',
    planDoc: join(cwd, 'PLAN.md'),
    topLevelMode: 'execute',
    pid: process.pid,
    hostname: hostname(),
    cwd,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function writeLock(cwd: string, lock: ActiveRunLock) {
  const lockPath = getActiveRunLockPath(cwd);
  await mkdir(join(cwd, '.neal'), { recursive: true });
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  return lockPath;
}

async function assertMissing(path: string) {
  await assert.rejects(() => access(path), /ENOENT/);
}

function assertLockEvidenceKind<K extends ResumeLockEvidence['kind']>(
  evidence: ResumeLockEvidence,
  kind: K,
): Extract<ResumeLockEvidence, { kind: K }> {
  assert.equal(evidence.kind, kind);
  return evidence as Extract<ResumeLockEvidence, { kind: K }>;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForMissingFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path} to be removed`);
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM');
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

function makeSignalCleanupDriverSource(repoRoot: string) {
  const newRunUrl = pathToFileURL(join(repoRoot, 'src/neal/commands/new-run.ts')).href;
  const configUrl = pathToFileURL(join(repoRoot, 'src/neal/config.ts')).href;
  const registryUrl = pathToFileURL(join(repoRoot, 'src/neal/providers/registry.ts')).href;
  const fakeProviderUrl = pathToFileURL(join(repoRoot, 'test/helpers/fake-provider.ts')).href;

  return `
import process from 'node:process';
import { writeFile } from 'node:fs/promises';

import { runNewRunCommand } from ${JSON.stringify(newRunUrl)};
import { clearConfigCache } from ${JSON.stringify(configUrl)};
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from ${JSON.stringify(registryUrl)};
import { createFakeProviderDefinition } from ${JSON.stringify(fakeProviderUrl)};

const providerId = process.env.NEAL_TEST_PROVIDER_ID;
const planPath = process.env.NEAL_TEST_PLAN_PATH;
const readyPath = process.env.NEAL_TEST_READY_PATH;

if (!providerId || !planPath || !readyPath) {
  throw new Error('Missing signal cleanup driver environment.');
}

const fakeProvider = createFakeProviderDefinition({
  id: providerId,
  onCoderStructuredRun: async () => {
    await writeFile(readyPath, 'ready\\n', 'utf8');
    await new Promise(() => {});
  },
});
setProviderCapabilitiesOverrideForTesting(providerId, {
  createCoderAdapter: fakeProvider.createCoderAdapter,
  createStructuredAdvisorAdapter: fakeProvider.createStructuredAdvisorAdapter,
});
clearConfigCache(process.cwd());

async function main() {
  try {
    await runNewRunCommand(['execute', planPath, '--no-squash']);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
    clearConfigCache(process.cwd());
  }
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  stdoutChunks: Buffer[],
  stderrChunks: Buffer[],
  timeoutMs: number,
) {
  let timedOut = false;
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        reject(new Error(`child did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('inspectActiveRunLock reports no lock without creating one', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-inspect-none-'));
  const lockPath = getActiveRunLockPath(cwd);

  assert.deepEqual(await inspectActiveRunLock(cwd, 'active-run'), { kind: 'none' });
  await assertMissing(lockPath);
});

test('inspectActiveRunLock reports a live same-run lock without acquiring it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-inspect-live-same-'));
  const lockPath = await writeLock(cwd, baseLock(cwd));
  const before = await readFile(lockPath, 'utf8');

  const evidence = assertLockEvidenceKind(await inspectActiveRunLock(cwd, 'active-run'), 'live_same_run');

  assert.equal(evidence.runId, 'active-run');
  assert.equal(evidence.lockPath, lockPath);
  assert.equal(evidence.pid, process.pid);
  assert.equal(await readFile(lockPath, 'utf8'), before);
});

test('inspectActiveRunLock reports stale same-run and stale different-run locks without deleting them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-inspect-stale-'));
  const lockPath = await writeLock(cwd, baseLock(cwd, { pid: 0 }));
  const before = await readFile(lockPath, 'utf8');

  const sameRunEvidence = assertLockEvidenceKind(await inspectActiveRunLock(cwd, 'active-run'), 'stale_same_run');
  const differentRunEvidence = assertLockEvidenceKind(
    await inspectActiveRunLock(cwd, 'other-run'),
    'stale_different_run',
  );

  assert.equal(sameRunEvidence.runId, 'active-run');
  assert.equal(differentRunEvidence.runId, 'active-run');
  assert.equal(await readFile(lockPath, 'utf8'), before);
});

test('inspectActiveRunLock reports a live different-run lock', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-inspect-live-different-'));
  const lockPath = await writeLock(cwd, baseLock(cwd));

  const evidence = assertLockEvidenceKind(await inspectActiveRunLock(cwd, 'other-run'), 'live_different_run');

  assert.equal(evidence.runId, 'active-run');
  assert.equal(evidence.lockPath, lockPath);
  assert.equal(evidence.pid, process.pid);
});

test('inspectActiveRunLock reports cross-host locks without checking local PID liveness', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-inspect-cross-host-'));
  const otherHost = `${hostname()}-other`;
  const lockPath = await writeLock(cwd, baseLock(cwd, { hostname: otherHost, pid: 0 }));

  const evidence = assertLockEvidenceKind(await inspectActiveRunLock(cwd, 'active-run'), 'cross_host');

  assert.equal(evidence.runId, 'active-run');
  assert.equal(evidence.hostname, otherHost);
  assert.equal(evidence.lockPath, lockPath);
});

test('inspectActiveRunLock reports unreadable lock files read-only', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-inspect-unreadable-'));
  const lockPath = getActiveRunLockPath(cwd);
  await mkdir(join(cwd, '.neal'), { recursive: true });
  await writeFile(lockPath, '{', 'utf8');

  const evidence = assertLockEvidenceKind(await inspectActiveRunLock(cwd, 'active-run'), 'unreadable');

  assert.equal(evidence.lockPath, lockPath);
  assert.match(evidence.reason, /JSON|Expected|Unexpected/);
  assert.equal(await readFile(lockPath, 'utf8'), '{');
});

test('active run lock acquires when no lock exists and releases only its own lock', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-acquire-'));
  const lockPath = getActiveRunLockPath(cwd);

  const handle = await acquireActiveRunLock({
    cwd,
    runId: 'run-a',
    runStatePath: join(cwd, '.neal', 'runs', 'run-a', 'RUN_STATE.json'),
    planDoc: join(cwd, 'PLAN.md'),
    topLevelMode: 'execute',
  });

  assert.equal(handle.acquired, true);
  const lock = await readActiveRunLock(lockPath);
  assert.equal(lock.runId, 'run-a');
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.runStatePath, '.neal/runs/run-a/RUN_STATE.json');

  await handle.release();
  await assertMissing(lockPath);
});

test('active run lock refuses a live same-host lock for a different run', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-live-different-'));
  const lockPath = await writeLock(cwd, baseLock(cwd));

  await assert.rejects(
    () =>
      acquireActiveRunLock({
        cwd,
        runId: 'other-run',
        runStatePath: join(cwd, '.neal', 'runs', 'other-run', 'RUN_STATE.json'),
        planDoc: join(cwd, 'OTHER.md'),
        topLevelMode: 'plan',
      }),
    (error) => {
      assert.equal(error instanceof ActiveRunLockError, true);
      const lockError = error as ActiveRunLockError;
      assert.equal(lockError.kind, 'active_different_run');
      assert.equal(lockError.lockPath, lockPath);
      assert.match(lockError.message, /another Neal writer run is active/);
      assert.match(lockError.message, /active run: active-run/);
      assert.match(lockError.message, /pid:/);
      assert.match(lockError.message, /neal resume --run active-run/);
      return true;
    },
  );
});

test('active run lock permits a live same-host lock for the same run without taking ownership', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-same-run-'));
  const lockPath = await writeLock(cwd, baseLock(cwd));

  const handle = await acquireActiveRunLock({
    cwd,
    runId: 'active-run',
    runStatePath: join(cwd, '.neal', 'runs', 'active-run', 'RUN_STATE.json'),
    planDoc: join(cwd, 'PLAN.md'),
    topLevelMode: 'execute',
  });

  assert.equal(handle.acquired, false);
  assert.equal(handle.lock.pid, process.pid);
  await handle.release();
  assert.equal((await readActiveRunLock(lockPath)).runId, 'active-run');
});

test('active run lock refuses a live same-run lock owned by a different process', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-same-run-other-pid-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const childPid = child.pid;
    assert.equal(typeof childPid, 'number');
    assert.notEqual(childPid, process.pid);
    const lockPath = await writeLock(cwd, baseLock(cwd, { pid: childPid }));

    await assert.rejects(
      () =>
        acquireActiveRunLock({
          cwd,
          runId: 'active-run',
          runStatePath: join(cwd, '.neal', 'runs', 'active-run', 'RUN_STATE.json'),
          planDoc: join(cwd, 'PLAN.md'),
          topLevelMode: 'execute',
        }),
      (error) => {
        assert.equal(error instanceof ActiveRunLockError, true);
        const lockError = error as ActiveRunLockError;
        assert.equal(lockError.kind, 'active_same_run');
        assert.equal(lockError.lockPath, lockPath);
        assert.match(lockError.message, /another Neal process is already resuming this run/);
        assert.match(lockError.message, /active run: active-run/);
        assert.match(lockError.message, new RegExp(`owning pid: ${childPid}`));
        return true;
      },
    );
    assert.equal((await readActiveRunLock(lockPath)).pid, childPid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('active run lock synchronous cleanup removes only a lock owned by this process', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-sync-release-'));
  const lockPath = await writeLock(cwd, baseLock(cwd));

  releaseActiveRunLockSync(cwd, 'other-run');
  assert.equal((await readActiveRunLock(lockPath)).runId, 'active-run');

  releaseActiveRunLockSync(cwd, 'active-run');
  await assertMissing(lockPath);
});

test('active run lock reports stale same-host dead PID locks without deleting them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-stale-'));
  const lockPath = await writeLock(cwd, baseLock(cwd, { pid: 0 }));

  await assert.rejects(
    () =>
      acquireActiveRunLock({
        cwd,
        runId: 'other-run',
        runStatePath: join(cwd, '.neal', 'runs', 'other-run', 'RUN_STATE.json'),
        planDoc: join(cwd, 'OTHER.md'),
        topLevelMode: 'execute',
      }),
    (error) => {
      assert.equal(error instanceof ActiveRunLockError, true);
      const lockError = error as ActiveRunLockError;
      assert.equal(lockError.kind, 'stale_same_host');
      assert.match(lockError.message, /stale Neal writer lock/);
      assert.match(lockError.message, /remove .*active-run\.lock/);
      assert.match(lockError.message, /exact resume command: neal resume --run active-run/);
      return true;
    },
  );
  assert.equal((await readActiveRunLock(lockPath)).runId, 'active-run');
});

test('active run lock refuses cross-host locks for manual inspection', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-cross-host-'));
  await writeLock(cwd, baseLock(cwd, { hostname: `${hostname()}-other` }));

  await assert.rejects(
    () =>
      acquireActiveRunLock({
        cwd,
        runId: 'active-run',
        runStatePath: join(cwd, '.neal', 'runs', 'active-run', 'RUN_STATE.json'),
        planDoc: join(cwd, 'PLAN.md'),
        topLevelMode: 'execute',
      }),
    (error) => {
      assert.equal(error instanceof ActiveRunLockError, true);
      const lockError = error as ActiveRunLockError;
      assert.equal(lockError.kind, 'cross_host');
      assert.match(lockError.message, /belongs to another host/);
      assert.match(lockError.message, /inspect the other host/);
      return true;
    },
  );
});

test('saveState refreshes the active writer lock when this process owns it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-refresh-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'refresh-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  const state = await createInitialState(
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
  const handle = await acquireActiveRunLock({
    cwd,
    runId: 'refresh-run',
    runStatePath: getRunStatePath(runDir),
    planDoc,
    topLevelMode: 'execute',
  });
  const before = JSON.parse(await readFile(getActiveRunLockPath(cwd), 'utf8')) as ActiveRunLock;
  await new Promise((resolve) => setTimeout(resolve, 5));

  await saveState(getRunStatePath(runDir), state);

  const after = JSON.parse(await readFile(getActiveRunLockPath(cwd), 'utf8')) as ActiveRunLock;
  assert.equal(after.runId, 'refresh-run');
  assert.notEqual(after.updatedAt, before.updatedAt);
  await handle.release();
});

test('refreshActiveRunLock replaces the lock atomically instead of rewriting it in place', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-lock-refresh-atomic-'));
  const lockPath = await writeLock(cwd, baseLock(cwd));
  const before = await stat(lockPath);

  await refreshActiveRunLock({
    cwd,
    runId: 'active-run',
    runStatePath: join(cwd, '.neal', 'runs', 'active-run', 'RUN_STATE.json'),
    planDoc: join(cwd, 'PLAN.md'),
    topLevelMode: 'execute',
  });

  // Rename-based replacement installs a new file rather than truncating the
  // existing one in place, so a crash mid-refresh can never leave a partial
  // lock behind.
  const after = await stat(lockPath);
  assert.notEqual(after.ino, before.ino);
  const lock = await readActiveRunLock(lockPath);
  assert.equal(lock.runId, 'active-run');
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.runStatePath, '.neal/runs/active-run/RUN_STATE.json');
  const leftovers = (await readdir(join(cwd, '.neal'))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writer process SIGTERM cleans up the active lock and leaves status readable', async () => {
  const repoRoot = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'neal-lock-signal-cleanup-'));
  const cwd = join(root, 'repo');
  const home = join(root, 'home');
  const providerId = 'openai-codex';
  const planDoc = join(cwd, 'PLAN.md');
  const readyPath = join(root, 'coder-ready.txt');
  const driverPath = join(root, 'signal-cleanup-driver.mts');

  await mkdir(home, { recursive: true });
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'base\n', 'utf8');
  await writeFile(
    planDoc,
    [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(cwd, 'neal.yml'),
    [
      'agent:',
      '  coder:',
      `    provider: ${providerId}`,
      '  reviewer:',
      `    provider: ${providerId}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await runGit(cwd, 'add', 'README.md', 'PLAN.md', 'neal.yml');
  await runGit(cwd, 'commit', '-m', 'base commit');
  await writeFile(driverPath, makeSignalCleanupDriverSource(repoRoot), 'utf8');

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const driverInvocation = nealCliInvocation(driverPath);
  const child = spawn(driverInvocation.command, driverInvocation.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      NEAL_TEST_PROVIDER_ID: providerId,
      NEAL_TEST_PLAN_PATH: planDoc,
      NEAL_TEST_READY_PATH: readyPath,
    },
  });
  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const childClose = waitForChildClose(child, stdoutChunks, stderrChunks, 5000);
  let closed = false;
  let lockPid: number | null = null;
  childClose.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    },
  );

  try {
    await waitForFile(readyPath, 5000);

    const lockPath = getActiveRunLockPath(cwd);
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as ActiveRunLock;
    assert.equal(lock.runId.length > 0, true);
    lockPid = lock.pid;
    assert.equal(isPidAlive(lock.pid), true);
    await waitForFile(join(cwd, lock.runStatePath), 5000);

    process.kill(lock.pid, 'SIGTERM');
    await waitForProcessExit(lock.pid, 5000);
    await childClose.catch(() => null);
    await waitForMissingFile(lockPath, 1000);

    const statusInvocation = nealCliInvocation(join(repoRoot, 'src/neal/index.ts'), ['status', '--json', '--run', lock.runId]);
    const statusResult = await execFileAsync(
      statusInvocation.command,
      statusInvocation.args,
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
        },
      },
    );
    assert.equal(normalizeCliStderr(statusResult.stderr), '');
    const status = JSON.parse(statusResult.stdout) as {
      ok: boolean;
      runId: string;
      status: string;
      lock: ResumeLockEvidence;
      resumeDecision: { kind: string };
    };
    assert.equal(status.ok, true);
    assert.equal(status.runId, lock.runId);
    assert.equal(status.status, 'running');
    assert.deepEqual(status.lock, { kind: 'none' });
    assert.equal(status.resumeDecision.kind, 'continue');
  } finally {
    if (lockPid !== null && isPidAlive(lockPid)) {
      process.kill(lockPid, 'SIGKILL');
    }
    if (!closed) {
      child.kill('SIGKILL');
      await childClose.catch(() => {});
    }
  }
});
