import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createInitialState, getDefaultAgentConfig, loadState, saveState } from '../src/neal/state.js';
import {
  buildSquashCommitMessage,
  executeSquashForRun,
  selectSquashRunForPlan,
  validateSelectedRunForSquash,
} from '../src/neal/squash.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function runNealCliResultInCwd(cwd: string, ...args: string[]) {
  return execFileAsync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(process.cwd(), 'src', 'neal', 'index.ts'), ...args],
    { cwd },
  );
}

async function runNealCliClosedStdinFailureInCwd(cwd: string, ...args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(process.cwd(), 'src', 'neal', 'index.ts'), ...args],
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
  await mkdir(runDir, { recursive: true });
  const initialState = await createInitialState(
    {
      cwd: args.cwd,
      planDoc: args.planDoc,
      stateDir,
      runDir,
      topLevelMode: args.topLevelMode ?? 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    args.baseCommit,
  );

  await saveState(join(stateDir, `session-${args.runId}.json`), {
    ...initialState,
    status: args.status ?? 'done',
    baseCommit: args.baseCommit,
    finalCommit: args.finalCommit,
    createdCommits: [...args.createdCommits],
  });

  return runDir;
}

async function updateRunState(cwd: string, runId: string, mutate: (state: Awaited<ReturnType<typeof loadState>>) => Awaited<ReturnType<typeof loadState>>) {
  const statePath = join(cwd, '.neal', `session-${runId}.json`);
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

test('validateSelectedRunForSquash accepts Neal final-squash metadata where finalCommit differs from createdCommits', async () => {
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
  assert.deepEqual(validation.createdCommits, [createdCommit]);
  assert.equal(validation.headCommit, finalCommit);
  assert.notEqual(createdCommit, finalCommit);
  assert.equal(squashedFinalCommit, createdCommit);
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
        summary: 'Add deterministic run selection',
        commitSubject: 'scope commit 1',
        changedFiles: ['feature-1.txt'],
        reviewRounds: 1,
        findings: 0,
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
        summary: 'Generate auditable squash commit messages',
        commitSubject: 'scope commit 2',
        changedFiles: ['feature-2.txt'],
        reviewRounds: 1,
        findings: 0,
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
    ['Implement plans/PLAN.md', '', '- Add deterministic run selection', '- Generate auditable squash commit messages'].join('\n'),
  );
});

test('buildSquashCommitMessage falls back to created commit subjects', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'plans/PLAN.md: add squash selector');
  const commitTwo = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'Add deterministic commit message builder');
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
    ['Implement plans/PLAN.md', '', '- add squash selector', '- Add deterministic commit message builder'].join('\n'),
  );
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

test('neal --squash --dry-run prints the selected run and commit range', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-00-00.000Z-cli',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  const result = await runNealCliResultInCwd(fixture.cwd, '--squash', 'plans/PLAN.md', '--dry-run');
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    mode: string;
    dryRun: boolean;
    selectedRunDir: string;
    baseCommit: string;
    finalCommit: string;
    createdCommits: string[];
    commitMessageSource: string;
    commitMessage: string;
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'squash_selection');
  assert.equal(payload.dryRun, true);
  assert.equal(await realpath(payload.selectedRunDir), await realpath(runDir));
  assert.equal(payload.baseCommit, fixture.baseCommit);
  assert.equal(payload.finalCommit, finalCommit);
  assert.deepEqual(payload.createdCommits, [finalCommit]);
  assert.equal(payload.commitMessageSource, 'created_commit_subjects');
  assert.equal(payload.commitMessage, 'Implement plans/PLAN.md\n\n- scope 1');
  assert.match(result.stderr, /\[neal\] selected squash run: 2026-04-18T16-00-00.000Z-cli/);
  assert.match(result.stderr, /\[neal\] commits to replace:/);
  assert.match(result.stderr, new RegExp(finalCommit));
  assert.match(result.stderr, /\[neal\] generated commit message:/);
  assert.match(result.stderr, /\[neal\] dry run only; no history was rewritten/);
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
    status: 'pending' | 'complete';
    originalBaseCommit: string;
    originalFinalCommit: string;
    originalCreatedCommits: string[];
    replacementCommit: string | null;
    generatedCommitMessage: string;
    squashedAt: string | null;
  };

  assert.equal(execution.replacementCommit, replacementCommit);
  assert.equal(execution.artifactPath, artifactPath);
  assert.equal(rewrittenCount, '1');
  assert.equal(replacementTree, originalTree);
  assert.equal(replacementMessage.trim(), commitMessage.message);
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.originalBaseCommit, fixture.baseCommit);
  assert.equal(artifact.originalFinalCommit, finalCommit);
  assert.deepEqual(artifact.originalCreatedCommits, [commitOne, finalCommit]);
  assert.equal(artifact.replacementCommit, replacementCommit);
  assert.equal(artifact.generatedCommitMessage, commitMessage.message);
  assert.ok(artifact.squashedAt);
  assert.match(artifact.squashedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('neal --squash --yes rewrites history and reports the replacement commit', async () => {
  const fixture = await createRepoFixture();
  const commitOne = await createCommit(fixture.cwd, 'feature-1.txt', 'one\n', 'scope 1');
  const finalCommit = await createCommit(fixture.cwd, 'feature-2.txt', 'two\n', 'scope 2');
  const runDir = await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-30-00.000Z-cli-execute',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [commitOne, finalCommit],
  });

  const originalTree = await runGit(fixture.cwd, 'rev-parse', `${finalCommit}^{tree}`);
  const result = await runNealCliResultInCwd(fixture.cwd, '--squash', 'plans/PLAN.md', '--yes');
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    mode: string;
    replacementCommit: string;
    squashArtifactPath: string;
    selectedRunDir: string;
    baseCommit: string;
    finalCommit: string;
    createdCommits: string[];
  };

  const replacementCommit = await runGit(fixture.cwd, 'rev-parse', 'HEAD');
  const replacementTree = await runGit(fixture.cwd, 'rev-parse', `${replacementCommit}^{tree}`);

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'squash_result');
  assert.equal(payload.replacementCommit, replacementCommit);
  assert.equal(payload.baseCommit, fixture.baseCommit);
  assert.equal(payload.finalCommit, finalCommit);
  assert.deepEqual(payload.createdCommits, [commitOne, finalCommit]);
  assert.equal(await realpath(payload.selectedRunDir), await realpath(runDir));
  assert.equal(await realpath(payload.squashArtifactPath), await realpath(join(runDir, 'SQUASH_RESULT.json')));
  assert.equal(replacementTree, originalTree);
  assert.match(result.stderr, /\[neal\] generated commit message:/);
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
    status: 'pending' | 'complete';
    originalBaseCommit: string;
    originalFinalCommit: string;
    originalCreatedCommits: string[];
    replacementCommit: string | null;
    generatedCommitMessage: string;
    squashedAt: string | null;
  };

  assert.equal(writeCount, 2);
  assert.equal(replacementTree, originalTree);
  assert.equal(pendingArtifact.status, 'pending');
  assert.equal(pendingArtifact.originalBaseCommit, fixture.baseCommit);
  assert.equal(pendingArtifact.originalFinalCommit, finalCommit);
  assert.deepEqual(pendingArtifact.originalCreatedCommits, [commitOne, finalCommit]);
  assert.equal(pendingArtifact.replacementCommit, null);
  assert.equal(pendingArtifact.generatedCommitMessage, commitMessage.message);
  assert.equal(pendingArtifact.squashedAt, null);
  assert.equal(await realpath(runDir), await realpath(selection.selected.runDir));
});

test('neal --squash without --yes aborts when confirmation is not supplied after printing the preview', async () => {
  const fixture = await createRepoFixture();
  const finalCommit = await createCommit(fixture.cwd, 'feature.txt', 'feature\n', 'scope 1');
  await createRunSnapshot({
    cwd: fixture.cwd,
    runId: '2026-04-18T16-45-00.000Z-no-tty',
    planDoc: fixture.planDoc,
    baseCommit: fixture.baseCommit,
    finalCommit,
    createdCommits: [finalCommit],
  });

  const result = await runNealCliClosedStdinFailureInCwd(fixture.cwd, '--squash', 'plans/PLAN.md');

  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[neal\] selected squash run: 2026-04-18T16-45-00.000Z-no-tty/);
  assert.match(result.stderr, /\[neal\] Proceed with squash rewrite\? \[y\/N\]/);
  assert.match(result.stderr, /aborted; no history was rewritten/);
});
