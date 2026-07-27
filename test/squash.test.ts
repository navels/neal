import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { executeRun } from '../src/neal/commands/runtime.js';
import { RunLogger } from '../src/neal/logger.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import { buildStatusSnapshot } from '../src/neal/status.js';
import { nealCliInvocation } from './helpers/cli.js';
import {
  buildSquashCommitMessage,
  discoverSquashCandidates,
  executeSquashForRun,
  selectLatestSquashRun,
  selectSquashRunByRunDir,
  selectSquashRunForPlan,
  validateSelectedRunForSquash,
} from '../src/neal/squash.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function outputChunkToString(chunk: unknown) {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8');
  }
  return String(chunk);
}

async function captureProcessOutput<T>(action: () => Promise<T>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutMock = mock.method(process.stdout, 'write', (chunk: unknown) => {
    stdout.push(outputChunkToString(chunk));
    return true;
  });
  const stderrMock = mock.method(process.stderr, 'write', (chunk: unknown) => {
    stderr.push(outputChunkToString(chunk));
    return true;
  });

  try {
    const result = await action();
    return {
      result,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    };
  } finally {
    stdoutMock.mock.restore();
    stderrMock.mock.restore();
  }
}

async function runNealCliClosedStdinFailureInCwd(cwd: string, ...args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const invocation = nealCliInvocation(join(process.cwd(), 'src', 'neal', 'index.ts'), args);
    const child = spawn(
      invocation.command,
      invocation.args,
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        code: code ?? 1,
      });
    });

    child.stdin.end();
  });
}

async function createRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'neal-squash-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'empty-excludes'), '', 'utf8');
  await runGit(cwd, 'config', 'core.excludesFile', join(root, 'empty-excludes'));
  await mkdir(join(cwd, 'plans'), { recursive: true });
  const planDoc = join(cwd, 'plans', 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(join(cwd, 'README.md'), 'base\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'add', '-f', 'plans/PLAN.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');

  return {
    cwd,
    planDoc,
    baseCommit,
  };
}

async function createCommit(cwd: string, filename: string, content: string, message: string) {
  await writeFile(join(cwd, filename), content, 'utf8');
  await runGit(cwd, 'add', filename);
  await runGit(cwd, 'commit', '-m', message);
  return runGit(cwd, 'rev-parse', 'HEAD');
}

async function configureSshCommitSigning(cwd: string) {
  const signingRoot = await mkdtemp(join(tmpdir(), 'neal-squash-signing-'));
  const keyPath = join(signingRoot, 'signing_key');
  await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'neal@example.com']);
  await runGit(cwd, 'config', 'gpg.format', 'ssh');
  await runGit(cwd, 'config', 'user.signingkey', `${keyPath}.pub`);
  await runGit(cwd, 'config', 'commit.gpgsign', 'true');
}

async function createRunSnapshot(args: {
  cwd: string;
  runId: string;
  planDoc: string;
  baseCommit: string;
  finalCommit: string | null;
  createdCommits: string[];
  status?: 'running' | 'done' | 'blocked' | 'failed';
  topLevelMode?: 'plan' | 'execute';
}) {
  const stateDir = join(args.cwd, '.neal');
  const runDir = join(stateDir, 'runs', args.runId);
  const status = args.status ?? 'done';
  await mkdir(runDir, { recursive: true });
  const initialState = await createInitialState(
    {
      cwd: args.cwd,
      planDoc: args.planDoc,
      stateDir,
      runDir,
      topLevelMode: args.topLevelMode ?? 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    args.baseCommit,
  );

  await saveState(getRunStatePath(runDir), {
    ...initialState,
    phase: status === 'done' ? 'done' : status === 'blocked' ? 'blocked' : initialState.phase,
    status,
    baseCommit: args.baseCommit,
    finalCommit: args.finalCommit,
    createdCommits: [...args.createdCommits],
  });

  return runDir;
}

async function updateRunState(cwd: string, runId: string, mutate: (state: Awaited<ReturnType<typeof loadState>>) => Awaited<ReturnType<typeof loadState>>) {
  const statePath = getRunStatePath(join(cwd, '.neal', 'runs', runId));
  const state = await loadState(statePath);
  await saveState(statePath, mutate(state));
}

test('selectSquashRunForPlan chooses the latest completed matching run', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T10-00-00.000Z-old',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitOne,
    createdCommits: [commitOne],
  });

  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T11-00-00.000Z-new',
    planDoc: fixture.planDoc,
    baseCommit: commitOne,
    finalCommit: commitTwo,
    createdCommits: [commitTwo],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  assert.equal(selection.selected.runId, '2026-04-18T11-00-00.000Z-new');
  assert.equal(selection.completedMatchCount, 2);
  assert.match(selection.selectionWarning ?? '', /Selected latest completed run/);
});

test('selectLatestSquashRun chooses the latest completed execute run when no plan is supplied', async () => {
  const fixture = await createRepoFixture();
  const otherPlanDoc = join(fixture.cwd, 'plans', 'OTHER.md');
  await writeFile(otherPlanDoc, '# Other Plan\n', 'utf8');
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T10-00-00.000Z-old',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitOne,
    createdCommits: [commitOne],
  });

  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T11-00-00.000Z-new',
    planDoc: otherPlanDoc,
    baseCommit: commitOne,
    finalCommit: commitTwo,
    createdCommits: [commitTwo],
  });

  const selection = await selectLatestSquashRun({
    cwd: fixture.cwd,
  });

  assert.equal(selection.selected.runId, '2026-04-18T11-00-00.000Z-new');
  assert.equal(selection.normalizedPlanDoc, otherPlanDoc);
  assert.equal(selection.completedMatchCount, 2);
  assert.match(selection.selectionWarning ?? '', /No plan doc supplied/);
});

test('selectSquashRunForPlan rejects a plan with no recorded runs', async () => {
  const fixture = await createRepoFixture();
  await assert.rejects(
    () =>
      selectSquashRunForPlan({
        cwd: fixture.cwd,
        planDocArg: 'plans/MISSING.md',
      }),
    /No Neal runs found for plan doc/,
  );
});

test('selectSquashRunForPlan rejects blocked or incomplete matching runs', async () => {
  const fixture = await createRepoFixture();
  const blockedCommit = await createCommit(fixture.cwd, 'blocked.txt', 'blocked\n', 'blocked work');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T12-00-00.000Z-blocked',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: blockedCommit,
    createdCommits: [blockedCommit],
    status: 'blocked',
  });
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T13-00-00.000Z-running',
    planDoc: fixture.planDoc,
    baseCommit: blockedCommit,
    finalCommit: null,
    createdCommits: [],
    status: 'running',
  });

  await assert.rejects(
    () =>
      selectSquashRunForPlan({
        cwd: fixture.cwd,
        planDocArg: 'plans/PLAN.md',
      }),
    /No completed execute-mode Neal runs found/,
  );
});

test('selectSquashRunByRunDir requires an exact completed execute run', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T13-30-00.000Z-complete',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitOne,
    createdCommits: [commitOne],
  });
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T13-45-00.000Z-running',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: null,
    createdCommits: [],
    status: 'running',
  });
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T13-50-00.000Z-plan',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitOne,
    createdCommits: [commitOne],
    topLevelMode: 'plan',
  });
  const selection = await selectSquashRunByRunDir({
    cwd: fixture.cwd,
    runDirName: '2026-04-18T13-30-00.000Z-complete',
  });
  assert.equal(selection.selected.runId, '2026-04-18T13-30-00.000Z-complete');
  assert.equal(selection.completedMatchCount, 1);
  assert.equal(selection.selectionWarning, null);

  await assert.rejects(
    () =>
      selectSquashRunByRunDir({
        cwd: fixture.cwd,
        runDirName: '2026-04-18T13-45-00.000Z-running',
      }),
    /not complete/,
  );
  await assert.rejects(
    () =>
      selectSquashRunByRunDir({
        cwd: fixture.cwd,
        runDirName: '2026-04-18T13-50-00.000Z-plan',
      }),
    /not an execute-mode run/,
  );
  await assert.rejects(
    () =>
      selectSquashRunByRunDir({
        cwd: fixture.cwd,
        runDirName: '../2026-04-18T13-30-00.000Z-complete',
      }),
    /single explicit run directory name/,
  );
});

test('squash discovery ignores artifact-only and malformed run directories', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'feature');
  const artifactOnlyRunDir = join(fixture.cwd, '.neal', 'runs', '2026-04-18T13-57-00.000Z-artifacts-only');
  const malformedStateRunDir = join(fixture.cwd, '.neal', 'runs', '2026-04-18T13-58-00.000Z-bad-state');
  await mkdir(artifactOnlyRunDir, { recursive: true });
  await mkdir(malformedStateRunDir, { recursive: true });
  await writeFile(
    join(artifactOnlyRunDir, 'meta.json'),
    JSON.stringify(
      {
        planDoc: fixture.planDoc,
        topLevelMode: 'execute',
        createdAt: '2026-04-18T13:57:00.000Z',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(
    join(artifactOnlyRunDir, 'plan-progress.json'),
    JSON.stringify({ version: 1, status: 'done', finalCommit }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(malformedStateRunDir, 'RUN_STATE.json'), '{', 'utf8');

  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T13-59-00.000Z-run-state',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  const candidates = await discoverSquashCandidates(join(fixture.cwd, '.neal', 'runs'));

  assert.deepEqual(candidates.map((candidate) => candidate.runId), ['2026-04-18T13-59-00.000Z-run-state']);
});

test('explicit squash run-dir selection requires readable run-local state', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'feature');
  const artifactOnlyRunDir = join(fixture.cwd, '.neal', 'runs', '2026-04-18T13-58-00.000Z-artifacts-only');
  const malformedStateRunDir = join(fixture.cwd, '.neal', 'runs', '2026-04-18T13-59-00.000Z-bad-state');
  await mkdir(artifactOnlyRunDir, { recursive: true });
  await mkdir(malformedStateRunDir, { recursive: true });
  await writeFile(
    join(artifactOnlyRunDir, 'meta.json'),
    JSON.stringify(
      {
        planDoc: fixture.planDoc,
        topLevelMode: 'execute',
        createdAt: '2026-04-18T13:58:00.000Z',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(
    join(artifactOnlyRunDir, 'plan-progress.json'),
    JSON.stringify({ version: 1, status: 'done', finalCommit }, null, 2) + '\n',
    'utf8',
  );
  await writeFile(join(malformedStateRunDir, 'RUN_STATE.json'), '{', 'utf8');

  await assert.rejects(
    () =>
      selectSquashRunForPlan({
        cwd: fixture.cwd,
        planDocArg: fixture.planDoc,
      }),
    /No Neal runs found for plan doc/,
  );
  await assert.rejects(
    () =>
      selectSquashRunByRunDir({
        cwd: fixture.cwd,
        runDirName: '2026-04-18T13-58-00.000Z-artifacts-only',
      }),
    /no readable run-local state RUN_STATE\.json/,
  );
  await assert.rejects(
    () =>
      selectSquashRunByRunDir({
        cwd: fixture.cwd,
        runDirName: '2026-04-18T13-59-00.000Z-bad-state',
      }),
    /no readable run-local state RUN_STATE\.json/,
  );
});

test('validateSelectedRunForSquash rejects a dirty worktree', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T14-00-00.000Z-dirty',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  await writeFile(join(fixture.cwd, 'README.md'), 'dirty\n', 'utf8');

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  await assert.rejects(
    () =>
      validateSelectedRunForSquash({
        cwd: fixture.cwd,
        selected: selection.selected,
      }),
    /Cannot squash with a dirty worktree/,
  );
});

test('validateSelectedRunForSquash rejects run-owned ignored files', async () => {
  const fixture = await createRepoFixture();
  await writeFile(join(fixture.cwd, '.gitignore'), 'ignored.txt\n', 'utf8');
  await runGit(fixture.cwd, 'add', '.gitignore');
  await runGit(fixture.cwd, 'commit', '-m', 'ignore generated file');
  const baseCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  await writeFile(join(fixture.cwd, 'ignored.txt'), 'generated\n', 'utf8');
  await runGit(fixture.cwd, 'add', '-f', 'ignored.txt');
  await runGit(fixture.cwd, 'commit', '-m', 'force add ignored output');
  const finalCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T14-10-00.000Z-ignored-file',
    planDoc: fixture.planDoc,
    baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  await assert.rejects(
    () =>
      validateSelectedRunForSquash({
        cwd: fixture.cwd,
        selected: selection.selected,
      }),
    /Squash run 2026-04-18T14-10-00\.000Z-ignored-file would include ignored file\(s\)[\s\S]*ignored\.txt/,
  );
});

test('validateSelectedRunForSquash rejects non-linear created commit metadata', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-00-00.000Z-bad-range',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [commitTwo],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  await assert.rejects(
    () =>
      validateSelectedRunForSquash({
        cwd: fixture.cwd,
        selected: selection.selected,
      }),
    /does not form a squashable range/,
  );
  assert.notEqual(commitOne, commitTwo);
});

test('validateSelectedRunForSquash accepts Neal execute-finalization metadata where finalCommit differs from createdCommits', async () => {
  const fixture = await createRepoFixture();
  const createdCommit = await createCommit(fixture.cwd, 'feature.txt', 'one\n', 'scope work');
  const squashedFinalCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  await runGit(fixture.cwd, 'reset', '--soft', fixture.baseCommit);
  await runGit(fixture.cwd, 'commit', '-m', 'squashed scope');
  const finalCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');

  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-05-00.000Z-finalized-single',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [createdCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(validation.baseCommit, fixture.baseCommit);
  assert.equal(validation.finalCommit, finalCommit);
  assert.deepEqual(validation.createdCommits, [finalCommit]);
  assert.equal(validation.headCommit, finalCommit);
  assert.notEqual(createdCommit, finalCommit);
  assert.equal(squashedFinalCommit, createdCommit);
});

test('validateSelectedRunForSquash uses the whole accepted run range for multi-scope runs', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-10-00.000Z-multi-scope',
    planDoc: fixture.planDoc,
    baseCommit: commitTwo,
    finalCommit: commitTwo,
    createdCommits: [commitTwo],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-10-00.000Z-multi-scope', (state) => ({
    ...state,
    initialBaseCommit: fixture.baseCommit,
    baseCommit: commitOne,
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: fixture.baseCommit,
        finalCommit: commitOne,
        summary: 'First scope',
        commitSubject: 'scope 1',
        changedFiles: ['feature-1.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '2',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: commitOne,
        finalCommit: commitTwo,
        summary: 'Second scope',
        commitSubject: 'scope 2',
        changedFiles: ['feature-2.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(validation.baseCommit, fixture.baseCommit);
  assert.equal(validation.finalCommit, commitTwo);
  assert.deepEqual(validation.createdCommits, [commitOne, commitTwo]);
});

test('validateSelectedRunForSquash accepts a single-scope run whose history was rewritten by reopened final-completion execution', async () => {
  // Reproduces the protonmail SWE-bench smoke failure: final-completion review
  // reopened execution and the coder rewrote history, so the recorded
  // createdCommits ([staleCommit]) became fully disjoint from the rebuilt
  // base->final range ([commitOne, commitTwo]). Only one scope was accepted,
  // so the old acceptedScopeCount > 1 gate rejected an otherwise-valid range.
  const fixture = await createRepoFixture();
  const staleCommit = await createCommit(fixture.cwd, 'abandoned.txt', 'stale\n', 'abandoned scope work');
  await runGit(fixture.cwd, 'reset', '--hard', fixture.baseCommit);
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'reopened base');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope final');

  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-20-00.000Z-reopened-single-scope',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [staleCommit],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-20-00.000Z-reopened-single-scope', (state) => ({
    ...state,
    initialBaseCommit: fixture.baseCommit,
    baseCommit: commitOne,
    finalCommit: commitTwo,
    createdCommits: [staleCommit],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: commitOne,
        finalCommit: commitTwo,
        summary: 'Single scope reopened by final-completion review',
        commitSubject: 'scope final',
        changedFiles: ['feature-1.txt', 'feature-2.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(validation.baseCommit, fixture.baseCommit);
  assert.equal(validation.finalCommit, commitTwo);
  assert.deepEqual(validation.createdCommits, [commitOne, commitTwo]);
  assert.notEqual(staleCommit, commitOne);
  assert.notEqual(staleCommit, commitTwo);
});

test('validateSelectedRunForSquash derives completed run range when top-level createdCommits is empty', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-15-00.000Z-empty-created-commits',
    planDoc: fixture.planDoc,
    baseCommit: commitOne,
    finalCommit: commitTwo,
    createdCommits: [],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-15-00.000Z-empty-created-commits', (state) => ({
    ...state,
    initialBaseCommit: fixture.baseCommit,
    baseCommit: commitOne,
    finalCommit: commitTwo,
    createdCommits: [],
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: fixture.baseCommit,
        finalCommit: commitOne,
        summary: 'First empty metadata scope',
        commitSubject: 'scope 1',
        changedFiles: ['feature-1.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '2',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: commitOne,
        finalCommit: commitTwo,
        summary: 'Second empty metadata scope',
        commitSubject: 'scope 2',
        changedFiles: ['feature-2.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(selection.selected.runId, '2026-04-18T15-15-00.000Z-empty-created-commits');
  assert.equal(validation.baseCommit, fixture.baseCommit);
  assert.equal(validation.finalCommit, commitTwo);
  assert.deepEqual(validation.createdCommits, [commitOne, commitTwo]);
  assert.deepEqual(validation.postPlanCommits, []);

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'changed_file_categories');
  assert.deepEqual(message.bullets, [
    'Refresh supporting project files',
    'Keep repository content aligned with the requested change',
  ]);
  assert.equal(
    message.message,
    [
      'Update project files',
      '',
      '- Refresh supporting project files',
      '- Keep repository content aligned with the requested change',
    ].join('\n'),
  );
});

test('validateSelectedRunForSquash accepts later commits that descend from the run final commit', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-20-00.000Z-descendant-head',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });
  const laterCommit = await createCommit(fixture.cwd, 'later.txt', 'later\n', 'post plan work');

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(validation.baseCommit, fixture.baseCommit);
  assert.equal(validation.finalCommit, finalCommit);
  assert.equal(validation.headCommit, laterCommit);
  assert.deepEqual(validation.createdCommits, [finalCommit]);
  assert.deepEqual(validation.postPlanCommits, [laterCommit]);
});

test('buildSquashCommitMessage prefers accepted scope summaries recorded in run state', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope commit 1');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope commit 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-30-00.000Z-summary',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [commitOne, commitTwo],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-30-00.000Z-summary', (state) => ({
    ...state,
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: fixture.baseCommit,
        finalCommit: commitOne,
        summary: 'Scope 1: Add deterministic run selection',
        commitSubject: 'scope commit 1',
        changedFiles: ['feature-1.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '2',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: commitOne,
        finalCommit: commitTwo,
        summary: 'Scope: 2 - Generate auditable squash commit messages',
        commitSubject: 'scope commit 2',
        changedFiles: ['feature-2.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'accepted_scope_summaries');
  assert.equal(
    message.message,
    ['Add deterministic run selection', '', '- Add deterministic run selection', '- Generate auditable squash commit messages'].join('\n'),
  );
});

test('buildSquashCommitMessage falls back to created commit subjects', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'plans/PLAN.md: Scope 1: add squash selector');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'Scope: 2 - Add deterministic commit message builder');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-45-00.000Z-subjects',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [commitOne, commitTwo],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  assert.deepEqual(validation.createdCommits, [commitOne, commitTwo]);

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'created_commit_subjects');
  assert.equal(
    message.message,
    ['add squash selector', '', '- add squash selector', '- Add deterministic commit message builder'].join('\n'),
  );
});

test('buildSquashCommitMessage prefers reviewer-authored final completion squash messages', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope commit 1');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope commit 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-46-00.000Z-reviewer-message',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [commitOne, commitTwo],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-46-00.000Z-reviewer-message', (state) => ({
    ...state,
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed semantic squash message generation.',
      verificationSummary: 'Ran focused squash message tests.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'The run is complete.',
      rationale: 'The squash message draft describes the project change.',
      missingWork: null,
      squashCommitMessage: {
        subject: 'Add semantic squash messages',
        bullets: [
          'Prefer reviewer-authored replacement commit summaries',
          'Keep plan paths out of generated squash messages',
        ],
      },
    },
    finalCompletionResolvedAction: 'accept_complete',
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'final_completion_reviewer');
  assert.equal(
    message.message,
    [
      'Add semantic squash messages',
      '',
      '- Prefer reviewer-authored replacement commit summaries',
      '- Keep plan paths out of generated squash messages',
    ].join('\n'),
  );
});

test('buildSquashCommitMessage falls back to final completion summary for an accepted null reviewer draft', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'mechanical scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-47-00.000Z-final-summary',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-47-00.000Z-final-summary', (state) => ({
    ...state,
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Added deterministic semantic squash message generation.',
      verificationSummary: 'Ran focused squash message coverage.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'The run is complete.',
      rationale: 'The reviewer accepted completion without a usable squash draft.',
      missingWork: null,
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'accept_complete',
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'final_completion_summary');
  assert.equal(
    message.message,
    [
      'Added deterministic semantic squash message generation',
      '',
      '- Added deterministic semantic squash message generation',
      '- Ran focused squash message coverage',
    ].join('\n'),
  );
});

test('buildSquashCommitMessage uses normalized plan title fallback without plan paths', async () => {
  const fixture = await createRepoFixture();
  await writeFile(fixture.planDoc, '# 11 - Semantic Squash Message Plan\n', 'utf8');
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope commit 1');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope commit 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-48-00.000Z-plan-title',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [commitOne, commitTwo],
  });

  await updateRunState(fixture.cwd, '2026-04-18T15-48-00.000Z-plan-title', (state) => ({
    ...state,
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: fixture.baseCommit,
        finalCommit: commitOne,
        summary: 'Scope 1: Normalize squash message titles',
        commitSubject: 'scope commit 1',
        changedFiles: ['feature-1.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '2',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: commitOne,
        finalCommit: commitTwo,
        summary: 'Filter mechanical squash bullets',
        commitSubject: 'scope commit 2',
        changedFiles: ['feature-2.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  }));

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'plan_title');
  assert.equal(message.subject, 'Semantic Squash Message');
  assert.doesNotMatch(message.message, /plans\/PLAN\.md|tmp\//);
});

test('buildSquashCommitMessage filters mechanical commit subjects and falls back to changed file category', async () => {
  const fixture = await createRepoFixture();
  await mkdir(join(fixture.cwd, 'src', 'neal'), { recursive: true });
  const commitOne = await createCommit(fixture.cwd, 'src/neal/feature.ts', 'export const one = 1;\n', 'Scope 1');
  const commitTwo = await createCommit(fixture.cwd, 'src/neal/other.ts', 'export const two = 2;\n', 'Final cleanup');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-49-00.000Z-changed-file-category',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: commitTwo,
    createdCommits: [commitOne, commitTwo],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  const message = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  assert.equal(message.source, 'changed_file_categories');
  assert.equal(message.subject, 'Update Neal CLI behavior');
  assert.doesNotMatch(message.message, /Scope 1|Final cleanup|plans\/PLAN\.md/);
});

test('buildSquashCommitMessage rejects runs without auditable summaries or reachable commit subjects', async () => {
  const fixture = await createRepoFixture();
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T15-50-00.000Z-missing-subjects',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    createdCommits: ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });

  await assert.rejects(
    () =>
      buildSquashCommitMessage({
        cwd: fixture.cwd,
        selected: selection.selected,
      }),
    /does not have auditable scope summaries or reachable commit subjects/,
  );
});

test('neal squash refuses non-TTY execution after printing the selected run and commit range', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-00-00.000Z-cli',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });
  const originalHead = await runGit(fixture.cwd, 'rev-parse', 'HEAD');

  const result = await runNealCliClosedStdinFailureInCwd(fixture.cwd, 'squash', 'plans/PLAN.md');

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(await runGit(fixture.cwd, 'rev-parse', 'HEAD'), originalHead);
  assert.match(result.stderr, /\[neal\] selected squash run: 2026-04-18T16-00-00.000Z-cli/);
  assert.match(result.stderr, /\[neal\] commits to replace:/);
  assert.match(result.stderr, new RegExp(finalCommit));
  assert.match(result.stderr, /\[neal\] plan doc disposition: present_in_replacement_tree/);
  assert.match(result.stderr, /\[neal\] replacement tree includes plan doc: yes/);
  assert.match(result.stderr, /\[neal\] commit message source: changed_file_categories/);
  assert.match(result.stderr, /\[neal\] commit message subject: Update project files/);
  assert.match(result.stderr, /\[neal\] generated commit message:/);
  assert.match(result.stderr, /Interactive TTY confirmation is required before rewriting history/);
  assert.match(result.stderr, /automated squash confirmation is not part of the public CLI/);
  assert.match(result.stderr, /no history was rewritten/);
});

test('executeSquashForRun rewrites the selected commits into one replacement commit and writes an audit artifact', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-15-00.000Z-execute',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const originalTree = await runGit(fixture.cwd, 'rev-parse', `${finalCommit}^{tree}`);

  const execution = await executeSquashForRun({
    cwd: fixture.cwd,
    selected: selection.selected,
    validation,
    commitMessage,
  });

  const replacementCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  const replacementTree = await runGit(fixture.cwd, 'rev-parse', `${replacementCommit}^{tree}`);
  const rewrittenCount = await runGit(fixture.cwd, 'rev-list', '--count', `${fixture.baseCommit}..${replacementCommit}`);
  const replacementMessage = await runGit(fixture.cwd, 'show', '--quiet', '--format=%B', replacementCommit);
  const artifactPath = join(runDir, 'SQUASH_RESULT.json');
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
    version: 1;
    status: 'pending' | 'complete';
    originalBaseCommit: string;
    originalFinalCommit: string;
    originalHeadCommit: string;
    originalCreatedCommits: string[];
    postPlanCommits: string[];
    replacementCommit: string | null;
    finalHeadCommit: string | null;
    generatedCommitMessage: string;
    squashedAt: string | null;
    metadata: {
      runId: string;
      selectedPlanDoc: string;
      normalizedPlanDoc: string;
      planDocDisposition: string;
      planDocIncludedInReplacementCommit: boolean;
      commitMessageSource: string;
      commitMessageSubject: string;
    };
  };

  assert.equal(execution.replacementCommit, replacementCommit);
  assert.equal(execution.artifactPath, artifactPath);
  assert.equal(rewrittenCount, '1');
  assert.equal(replacementTree, originalTree);
  assert.equal(replacementMessage.trim(), commitMessage.message);
  assert.equal(artifact.version, 1);
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.originalBaseCommit, fixture.baseCommit);
  assert.equal(artifact.originalFinalCommit, finalCommit);
  assert.equal(artifact.originalHeadCommit, finalCommit);
  assert.deepEqual(artifact.originalCreatedCommits, [commitOne, finalCommit]);
  assert.deepEqual(artifact.postPlanCommits, []);
  assert.equal(artifact.replacementCommit, replacementCommit);
  assert.equal(artifact.finalHeadCommit, replacementCommit);
  assert.equal(artifact.generatedCommitMessage, commitMessage.message);
  assert.ok(artifact.squashedAt);
  assert.match(artifact.squashedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(artifact.metadata, {
    runId: '2026-04-18T16-15-00.000Z-execute',
    selectedPlanDoc: fixture.planDoc,
    normalizedPlanDoc: 'plans/PLAN.md',
    planDocDisposition: 'present_in_replacement_tree',
    planDocIncludedInReplacementCommit: true,
    commitMessageSource: commitMessage.source,
    commitMessageSubject: commitMessage.subject,
  });
  assert.deepEqual(execution.artifact.metadata, artifact.metadata);
});

test('status JSON summarizes missing, pending, complete, and malformed squash artifacts', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  const missingRunDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-16-00.000Z-missing-squash',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });
  const pendingRunDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-16-01.000Z-pending-squash',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });
  const completeRunDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-16-02.000Z-complete-squash',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });
  const malformedRunDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-16-03.000Z-malformed-squash',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });
  const pendingArtifact = {
    version: 1,
    status: 'pending',
    originalBaseCommit: fixture.baseCommit,
    originalFinalCommit: finalCommit,
    replacementCommit: null,
    finalHeadCommit: null,
  };
  const completeArtifact = {
    version: 1,
    status: 'complete',
    originalBaseCommit: fixture.baseCommit,
    originalFinalCommit: finalCommit,
    replacementCommit: finalCommit,
    finalHeadCommit: finalCommit,
  };
  await writeFile(join(pendingRunDir, 'SQUASH_RESULT.json'), JSON.stringify(pendingArtifact, null, 2) + '\n', 'utf8');
  await writeFile(join(completeRunDir, 'SQUASH_RESULT.json'), JSON.stringify(completeArtifact, null, 2) + '\n', 'utf8');
  await writeFile(join(malformedRunDir, 'SQUASH_RESULT.json'), '{"version":1,"status":"complete"}\n', 'utf8');

  const missing = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: getRunStatePath(missingRunDir) });
  const pending = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: getRunStatePath(pendingRunDir) });
  const complete = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: getRunStatePath(completeRunDir) });
  const malformed = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: getRunStatePath(malformedRunDir) });

  assert.equal(missing.squash.status, 'missing');
  assert.equal(missing.patch.defaultSubmissionEligible, true);
  assert.equal(pending.squash.status, 'pending');
  assert.equal(pending.squash.originalBaseCommit, fixture.baseCommit);
  assert.equal(pending.squash.originalFinalCommit, finalCommit);
  assert.equal(pending.patch.defaultSubmissionEligible, false);
  assert.match(pending.patch.reason, /pending/);
  assert.equal(complete.squash.status, 'complete');
  assert.equal(complete.squash.replacementCommit, finalCommit);
  assert.equal(complete.squash.finalHeadCommit, finalCommit);
  assert.equal(complete.patch.source, 'squash_replacement');
  assert.equal(complete.patch.defaultSubmissionEligible, true);
  assert.equal(malformed.squash.status, 'malformed');
  assert.match(malformed.squash.unavailableReason ?? '', /expected squash artifact shape/);
  assert.equal(malformed.patch.defaultSubmissionEligible, false);
  assert.match(malformed.patch.reason, /malformed/);
});

test('executeSquashForRun records included plan document disposition metadata', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'plans/PLAN.md', '# Updated Plan\n', 'Update tracked plan doc');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-15-30.000Z-plan-doc-metadata',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  const execution = await executeSquashForRun({
    cwd: fixture.cwd,
    selected: selection.selected,
    validation,
    commitMessage,
  });

  const artifact = JSON.parse(await readFile(join(runDir, 'SQUASH_RESULT.json'), 'utf8')) as {
    metadata: {
      planDocDisposition: string;
      planDocIncludedInReplacementCommit: boolean;
      normalizedPlanDoc: string;
    };
  };
  assert.equal(artifact.metadata.planDocDisposition, 'included');
  assert.equal(artifact.metadata.planDocIncludedInReplacementCommit, true);
  assert.equal(artifact.metadata.normalizedPlanDoc, 'plans/PLAN.md');
  assert.equal(execution.artifact.metadata.planDocDisposition, 'included');
});

test('executeRun auto-squashes completed execute runs by default when enabled', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-16-00.000Z-auto-squash',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });
  const statePath = getRunStatePath(runDir);
  await updateRunState(fixture.cwd, '2026-04-18T16-16-00.000Z-auto-squash', (state) => ({
    ...state,
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Delivered automatic squash metadata for completed execute runs.',
      verificationSummary: 'Ran focused auto-squash coverage.',
      remainingKnownGaps: [],
    },
    finalCompletionReviewVerdict: {
      action: 'accept_complete',
      summary: 'The run is complete.',
      rationale: 'The final reviewer accepted completion without a usable squash draft.',
      missingWork: null,
      squashCommitMessage: null,
    },
    finalCompletionResolvedAction: 'accept_complete',
  }));
  const state = await loadState(statePath);
  const logger = new RunLogger(runDir);

  const output = await captureProcessOutput(() =>
    executeRun(state, statePath, logger, {
      autoSquashOnCompletion: true,
    }),
  );

  const replacementCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  const rewrittenCount = await runGit(fixture.cwd, 'rev-list', '--count', `${fixture.baseCommit}..${replacementCommit}`);
  const artifactPath = join(runDir, 'SQUASH_RESULT.json');
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
    status: 'pending' | 'complete';
    replacementCommit: string | null;
    metadata: {
      commitMessageSource: string;
      planDocDisposition: string;
    };
  };
  const events = (await readFile(join(runDir, 'events.ndjson'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
  const autoStartEvent = events.find((event) => event.type === 'squash.auto_start');
  const autoCompleteEvent = events.find((event) => event.type === 'squash.auto_complete');

  assert.equal(output.result.finalState.status, 'done');
  assert.equal(rewrittenCount, '1');
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.replacementCommit, replacementCommit);
  assert.equal(artifact.metadata.commitMessageSource, 'final_completion_summary');
  assert.equal(artifact.metadata.planDocDisposition, 'present_in_replacement_tree');
  assert.equal(autoStartEvent?.data?.commitMessageSource, artifact.metadata.commitMessageSource);
  assert.equal(autoStartEvent?.data?.planDocDisposition, artifact.metadata.planDocDisposition);
  assert.equal(autoCompleteEvent?.data?.commitMessageSource, artifact.metadata.commitMessageSource);
  assert.equal(autoCompleteEvent?.data?.planDocDisposition, artifact.metadata.planDocDisposition);
  assert.match(output.stdout, new RegExp(`- Squash commit: ${replacementCommit}`));
  assert.match(output.stdout, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('validateSelectedRunForSquash reports when a run has already been squashed', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-16-30.000Z-already-squashed',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const execution = await executeSquashForRun({
    cwd: fixture.cwd,
    selected: selection.selected,
    validation,
    commitMessage,
  });

  await assert.rejects(
    () =>
      validateSelectedRunForSquash({
        cwd: fixture.cwd,
        selected: selection.selected,
      }),
    new RegExp(
      [
        'already been squashed',
        finalCommit,
        execution.replacementCommit,
        'SQUASH_RESULT\\.json',
      ].join('[\\s\\S]*'),
    ),
  );
});

test('executeSquashForRun signs the replacement commit when commit signing is configured', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-17-00.000Z-signed-execute',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  await configureSshCommitSigning(fixture.cwd);

  const execution = await executeSquashForRun({
    cwd: fixture.cwd,
    selected: selection.selected,
    validation,
    commitMessage,
  });

  const replacementCommitObject = await runGit(fixture.cwd, 'cat-file', '-p', execution.replacementCommit);
  assert.match(replacementCommitObject, /^gpgsig -----BEGIN SSH SIGNATURE-----$/m);
});

test('executeSquashForRun preserves later commits by replaying them onto the replacement commit', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-20-00.000Z-execute-with-later-work',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });
  const laterCommit = await createCommit(fixture.cwd, 'later.txt', 'later\n', 'post plan work');
  const originalHeadTree = await runGit(fixture.cwd, 'rev-parse', `${laterCommit}^{tree}`);

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });

  const execution = await executeSquashForRun({
    cwd: fixture.cwd,
    selected: selection.selected,
    validation,
    commitMessage,
  });

  const finalHead = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  const finalHeadTree = await runGit(fixture.cwd, 'rev-parse', `${finalHead}^{tree}`);
  const rewrittenCommits = await runGit(fixture.cwd, 'rev-list', '--reverse', `${fixture.baseCommit}..${finalHead}`);
  const rewrittenSubjects = await runGit(fixture.cwd, 'log', '--reverse', '--format=%s', `${fixture.baseCommit}..${finalHead}`);
  const artifact = JSON.parse(await readFile(join(runDir, 'SQUASH_RESULT.json'), 'utf8')) as {
    originalHeadCommit: string;
    postPlanCommits: string[];
    replacementCommit: string;
    finalHeadCommit: string;
  };

  assert.equal(execution.replacementCommit, rewrittenCommits.split('\n')[0]);
  assert.equal(execution.finalHeadCommit, finalHead);
  assert.equal(finalHeadTree, originalHeadTree);
  assert.equal(await readFile(join(fixture.cwd, 'later.txt'), 'utf8'), 'later\n');
  assert.deepEqual(rewrittenSubjects.split('\n'), ['Update project files', 'post plan work']);
  assert.equal(artifact.originalHeadCommit, laterCommit);
  assert.deepEqual(artifact.postPlanCommits, [laterCommit]);
  assert.equal(artifact.replacementCommit, execution.replacementCommit);
  assert.equal(artifact.finalHeadCommit, finalHead);
});

test('neal squash rejects unsupported flags without rewriting history', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-30-00.000Z-cli-execute',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });

  const result = await runNealCliClosedStdinFailureInCwd(fixture.cwd, 'squash', 'plans/PLAN.md', '--unexpected');

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(await runGit(fixture.cwd, 'rev-parse', 'HEAD'), finalCommit);
  assert.match(result.stderr, /unsupported flag: --unexpected/);
  assert.doesNotMatch(result.stderr, /\[neal\] selected squash run:/);
});

test('executeSquashForRun leaves a pending audit artifact behind if final artifact persistence fails after rewrite', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-35-00.000Z-artifact-failure',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });

  const selection = await selectSquashRunForPlan({
    cwd: fixture.cwd,
    planDocArg: 'plans/PLAN.md',
  });
  const validation = await validateSelectedRunForSquash({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: fixture.cwd,
    selected: selection.selected,
  });
  const originalTree = await runGit(fixture.cwd, 'rev-parse', `${finalCommit}^{tree}`);

  let writeCount = 0;
  let pendingArtifactContent = '';
  await assert.rejects(
    () =>
      executeSquashForRun({
        cwd: fixture.cwd,
        selected: selection.selected,
        validation,
        commitMessage,
        artifactWriter: async (_path, content) => {
          writeCount += 1;
          if (writeCount === 1) {
            pendingArtifactContent = content;
            return;
          }

          throw new Error('simulated final artifact write failure');
        },
      }),
    /Squash rewrite succeeded but Neal could not finalize the audit artifact/,
  );

  const replacementCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  const replacementTree = await runGit(fixture.cwd, 'rev-parse', `${replacementCommit}^{tree}`);
  const pendingArtifact = JSON.parse(pendingArtifactContent) as {
    version: 1;
    status: 'pending' | 'complete';
    originalBaseCommit: string;
    originalFinalCommit: string;
    originalHeadCommit: string;
    originalCreatedCommits: string[];
    postPlanCommits: string[];
    replacementCommit: string | null;
    finalHeadCommit: string | null;
    generatedCommitMessage: string;
    squashedAt: string | null;
    metadata: {
      runId: string;
      selectedPlanDoc: string;
      normalizedPlanDoc: string;
      planDocDisposition: string;
      planDocIncludedInReplacementCommit: boolean;
      commitMessageSource: string;
      commitMessageSubject: string;
    };
  };

  assert.equal(writeCount, 2);
  assert.equal(replacementTree, originalTree);
  assert.equal(pendingArtifact.version, 1);
  assert.equal(pendingArtifact.status, 'pending');
  assert.equal(pendingArtifact.originalBaseCommit, fixture.baseCommit);
  assert.equal(pendingArtifact.originalFinalCommit, finalCommit);
  assert.equal(pendingArtifact.originalHeadCommit, finalCommit);
  assert.deepEqual(pendingArtifact.originalCreatedCommits, [commitOne, finalCommit]);
  assert.deepEqual(pendingArtifact.postPlanCommits, []);
  assert.equal(pendingArtifact.replacementCommit, null);
  assert.equal(pendingArtifact.finalHeadCommit, null);
  assert.equal(pendingArtifact.generatedCommitMessage, commitMessage.message);
  assert.equal(pendingArtifact.squashedAt, null);
  assert.deepEqual(pendingArtifact.metadata, {
    runId: '2026-04-18T16-35-00.000Z-artifact-failure',
    selectedPlanDoc: fixture.planDoc,
    normalizedPlanDoc: 'plans/PLAN.md',
    planDocDisposition: 'present_in_replacement_tree',
    planDocIncludedInReplacementCommit: true,
    commitMessageSource: commitMessage.source,
    commitMessageSubject: commitMessage.subject,
  });
  assert.equal(await realpath(runDir), await realpath(selection.selected.runDir));
});

test('neal squash rejects an unsupported flag before selecting a run', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-45-00.000Z-dry-run',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  const result = await runNealCliClosedStdinFailureInCwd(fixture.cwd, 'squash', 'plans/PLAN.md', '--unexpected');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsupported flag: --unexpected/);
  assert.doesNotMatch(result.stderr, /\[neal\] selected squash run:/);
});
