import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  adoptAcceptedDerivedPlan,
  applyInteractiveBlockedRecoveryDisposition,
  computeNextScopeStateAfterSquash,
  finalizeBlockedPlanReviewResponse,
  flushDerivedPlanNotifications,
  loadOrInitialize,
  recordInteractiveBlockedRecoveryGuidance,
  runFinalSquashPhase,
} from '../src/neal/orchestrator.js';
import { persistSplitPlanRecovery } from '../src/neal/orchestrator/split-plan.js';
import { renderPlanProgressMarkdown } from '../src/neal/progress.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { createInitialState, getDefaultAgentConfig, loadState, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

const execFileAsync = promisify(execFile);
const originalNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;

process.env.AUTONOMY_NOTIFY_BIN = '/usr/bin/true';

after(() => {
  if (originalNotifyBin === undefined) {
    delete process.env.AUTONOMY_NOTIFY_BIN;
  } else {
    process.env.AUTONOMY_NOTIFY_BIN = originalNotifyBin;
  }
});

async function createResumeFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-scope4-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  const statePath = join(stateDir, 'session.json');
  const state = await saveState(statePath, {
    ...initialState,
    ...overrides,
  });

  return { cwd, statePath, state };
}

async function createNotifyCapture(root: string) {
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);
  return { notifyLogPath, notifyScriptPath };
}

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function runNealCli(...args: string[]) {
  const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', 'src/neal/index.ts', ...args], {
    cwd: process.cwd(),
  });
  return stdout;
}

async function runNealCliResult(...args: string[]) {
  return execFileAsync('pnpm', ['exec', 'tsx', 'src/neal/index.ts', ...args], {
    cwd: process.cwd(),
  });
}

async function createFinalSquashFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-squash-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  await writeFile(trackedFile, 'base\nchange\n', 'utf8');
  await runGit(cwd, 'add', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'derived scope work');
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const createdCommitsOverride = overrides.createdCommits;

  const statePath = join(stateDir, 'session.json');
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'final_squash',
    status: 'running',
    baseCommit,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: false,
    ...overrides,
    createdCommits: createdCommitsOverride ?? [createdCommit],
  });

  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  return { cwd, statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath };
}

async function createEmptyFinalSquashFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-squash-empty-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  await runGit(cwd, 'commit', '--allow-empty', '-m', 'empty derived scope checkpoint');
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  const createdCommitsOverride = overrides.createdCommits;

  const statePath = join(stateDir, 'session.json');
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'final_squash',
    status: 'running',
    baseCommit,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: false,
    ...overrides,
    createdCommits: createdCommitsOverride ?? [createdCommit],
  });

  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  return { cwd, statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath };
}

test('resume restores blocked derived-plan coder response sessions', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_4.md';
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan_response',
    coderSessionHandle: 'coder-session-1',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'coder_plan_response');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'pending_review');
  assert.equal(state.derivedFromScopeNumber, 4);
});

test('resume preserves interactive blocked recovery state without resuming execution', async () => {
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    coderSessionHandle: 'coder-session-1',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
    },
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'interactive_blocked_recovery');
  assert.equal(state.status, 'running');
  assert.equal(state.blockedFromPhase, 'coder_scope');
  assert.equal(state.interactiveBlockedRecovery?.blockedReason, 'Need operator guidance');
  assert.equal(state.interactiveBlockedRecovery?.turns.length, 0);
});

test('resume restores failed interactive blocked recovery state and rewrites artifacts', async () => {
  const { cwd, statePath, state: savedState } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'interactive_blocked_recovery',
    status: 'failed',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Keep the scope and avoid infrastructure edits.',
          disposition: null,
        },
      ],
    },
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'interactive_blocked_recovery');
  assert.equal(state.status, 'running');
  assert.equal(state.interactiveBlockedRecovery?.blockedReason, 'Need operator guidance');
  assert.equal(state.interactiveBlockedRecovery?.turns.length, 1);

  const consultMarkdown = await readFile(savedState.consultMarkdownPath, 'utf8');
  assert.match(consultMarkdown, /Keep the scope and avoid infrastructure edits\./);

  const progressMarkdown = await readFile(savedState.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery/);
  assert.match(progressMarkdown, /Handled turns: 0/);
});

test('recordInteractiveBlockedRecoveryGuidance persists operator recovery input and artifacts', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
    },
  });

  const nextState = await recordInteractiveBlockedRecoveryGuidance(
    statePath,
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );
  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 1);
  assert.match(
    nextState.interactiveBlockedRecovery?.turns[0].operatorGuidance ?? '',
    /Replace this scope with a narrower plan/,
  );

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.interactiveBlockedRecovery?.turns.length, 1);
  assert.equal(
    reloadedState.interactiveBlockedRecovery?.turns[0].operatorGuidance,
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );

  const consultMarkdown = await readFile(state.consultMarkdownPath, 'utf8');
  assert.match(consultMarkdown, /## Interactive Blocked Recovery/);
  assert.match(consultMarkdown, /Replace this scope with a narrower plan and keep the last accepted commit\./);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery/);
  assert.match(progressMarkdown, /Recorded turns: 1/);
});

test('neal --recover records operator guidance without manual session edits', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
    },
  });

  const stdout = await runNealCli(
    '--recover',
    statePath,
    '--message',
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    phase: string;
    status: string;
    statePath: string;
    runDir: string;
    recoveryTurns: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.phase, 'interactive_blocked_recovery');
  assert.equal(result.status, 'running');
  assert.equal(result.statePath, statePath);
  assert.equal(result.runDir, state.runDir);
  assert.equal(result.recoveryTurns, 1);
  assert.match(stdout, /neal --resume/);

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.interactiveBlockedRecovery?.turns.length, 1);
  assert.equal(
    reloadedState.interactiveBlockedRecovery?.turns[0]?.operatorGuidance,
    'Replace this scope with a narrower plan and keep the last accepted commit.',
  );

  const consultMarkdown = await readFile(state.consultMarkdownPath, 'utf8');
  assert.match(consultMarkdown, /## Interactive Blocked Recovery/);
  assert.match(consultMarkdown, /Replace this scope with a narrower plan and keep the last accepted commit\./);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery/);
  assert.match(progressMarkdown, /Recorded turns: 1/);
});

test('neal --recover rejects recording more guidance while a recovery turn is still pending', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower plan and keep the last accepted commit.',
          disposition: null,
        },
      ],
    },
  });

  const stdout = await runNealCli(
    '--recover',
    statePath,
    '--message',
    'One more operator instruction.',
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    code: string;
    message: string;
    statePath: string;
    runDir: string;
    pendingTurn: number;
    recoveryTurns: number;
    nextStep: string;
  };

  assert.equal(result.ok, false);
  assert.equal(result.code, 'interactive_blocked_recovery_pending_turn');
  assert.equal(result.statePath, statePath);
  assert.equal(result.runDir, state.runDir);
  assert.equal(result.pendingTurn, 1);
  assert.equal(result.recoveryTurns, 1);
  assert.match(result.message, /unhandled operator guidance/);
  assert.match(result.nextStep, /neal --resume/);
});

test('neal --recover records a terminal-only directive when interactive blocked recovery hits its turn cap', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings did not converge',
      maxTurns: 3,
      lastHandledTurn: 3,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'First operator instruction.',
          disposition: null,
        },
        {
          number: 2,
          recordedAt: '2026-04-16T00:02:00.000Z',
          operatorGuidance: 'Second operator instruction.',
          disposition: null,
        },
        {
          number: 3,
          recordedAt: '2026-04-16T00:03:00.000Z',
          operatorGuidance: 'Third operator instruction.',
          disposition: null,
        },
      ],
    },
  });

  const stdout = await runNealCli(
    '--recover',
    statePath,
    '--message',
    'One more operator instruction.',
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    phase: string;
    status: string;
    statePath: string;
    runDir: string;
    recoveryTurns: number;
    terminalDirectivePending: boolean;
    nextStep: string;
  };

  assert.equal(result.ok, true);
  assert.equal(result.phase, 'interactive_blocked_recovery');
  assert.equal(result.status, 'running');
  assert.equal(result.statePath, statePath);
  assert.equal(result.runDir, state.runDir);
  assert.equal(result.recoveryTurns, 3);
  assert.equal(result.terminalDirectivePending, true);
  assert.match(result.nextStep, /neal --resume/);

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.interactiveBlockedRecovery?.pendingDirective?.terminalOnly, true);
  assert.equal(
    reloadedState.interactiveBlockedRecovery?.pendingDirective?.operatorGuidance,
    'One more operator instruction.',
  );
});

test('interactive blocked recovery can stay blocked, resume after interruption, and then continue the scope', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-5',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
    },
  });

  const afterFirstGuidance = await recordInteractiveBlockedRecoveryGuidance(
    statePath,
    'Do not replace the scope yet; first confirm whether the reviewer feedback can be applied directly.',
  );
  assert.equal(afterFirstGuidance.interactiveBlockedRecovery?.turns.length, 1);

  const stillBlockedState = await applyInteractiveBlockedRecoveryDisposition(
    afterFirstGuidance,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'More operator input is needed.',
      rationale: 'The guidance still leaves the actual remediation path ambiguous.',
      blocker: 'Need a concrete yes/no on whether the reviewer findings should be applied as-is in this scope.',
      replacementPlan: '',
    },
    'coder-session-5b',
  );

  assert.equal(stillBlockedState.phase, 'interactive_blocked_recovery');
  assert.equal(stillBlockedState.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(stillBlockedState.interactiveBlockedRecoveryHistory.length, 0);

  const resumed = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(resumed.state.phase, 'interactive_blocked_recovery');
  assert.equal(resumed.state.status, 'running');
  assert.equal(resumed.state.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(resumed.state.interactiveBlockedRecovery?.turns.length, 1);

  const afterSecondGuidance = await recordInteractiveBlockedRecoveryGuidance(
    statePath,
    'Apply the reviewer feedback directly and continue this scope.',
  );
  assert.equal(afterSecondGuidance.interactiveBlockedRecovery?.turns.length, 2);

  const finalState = await applyInteractiveBlockedRecoveryDisposition(
    afterSecondGuidance,
    statePath,
    {
      action: 'resume_current_scope',
      summary: 'The scope can continue.',
      rationale: 'The operator clarified that the reviewer feedback should be applied directly.',
      blocker: '',
      replacementPlan: '',
    },
    'coder-session-5c',
  );

  assert.equal(finalState.phase, 'coder_response');
  assert.equal(finalState.status, 'running');
  assert.equal(finalState.blockedFromPhase, null);
  assert.equal(finalState.interactiveBlockedRecovery, null);
  assert.equal(finalState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'resume_current_scope');
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'coder_response');
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.turns.length, 2);
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'stay_blocked');
  assert.equal(finalState.interactiveBlockedRecoveryHistory[0]?.turns[1]?.disposition?.action, 'resume_current_scope');

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.phase, 'coder_response');
  assert.equal(reloadedState.interactiveBlockedRecovery, null);
  assert.equal(reloadedState.interactiveBlockedRecoveryHistory[0]?.turns.length, 2);

  const consultMarkdown = await readFile(state.consultMarkdownPath, 'utf8');
  assert.match(consultMarkdown, /## Interactive Blocked Recovery History 1/);
  assert.match(consultMarkdown, /Recovery turn 1 coder action: stay_blocked/);
  assert.match(consultMarkdown, /Recovery turn 2 coder action: resume_current_scope/);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(progressMarkdown, /Sessions: 1/);
  assert.match(progressMarkdown, /Latest action: resume_current_scope/);
});

test('interactive blocked recovery resumes through the next ordinary coder path', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'coder-session-4',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Review findings stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Apply the reviewer feedback and continue this scope.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'resume_current_scope',
      summary: 'The scope can continue.',
      rationale: 'The operator clarified how to proceed.',
      blocker: '',
      replacementPlan: '',
    },
    'coder-session-4b',
  );

  assert.equal(nextState.phase, 'coder_response');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, null);
  assert.equal(nextState.coderSessionHandle, 'coder-session-4b');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'resume_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'coder_response');
});

test('interactive blocked recovery can route replacement through split-plan machinery', async () => {
  const { statePath, state } = await createFinalSquashFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'The current scope shape is wrong.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower derived plan.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'This scope should be replaced.',
      rationale: 'A narrower derived plan is safer.',
      blocker: '',
      replacementPlan:
        '## Goal\n\nReplace the stale scope.\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    },
    'coder-session-6b',
  );

  assert.equal(nextState.phase, 'reviewer_plan');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'replace_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'replace_current_scope');
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedFromScopeNumber, 6);
});

test('interactive blocked recovery records a blocked history result when replacement hits the split-plan cap', async () => {
  const { statePath, state } = await createFinalSquashFixture({
    currentScopeNumber: 6,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 10,
    createdCommits: [],
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'The current scope shape is wrong.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Replace this scope with a narrower derived plan.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'replace_current_scope',
      summary: 'This scope should be replaced.',
      rationale: 'A narrower derived plan is safer.',
      blocker: '',
      replacementPlan:
        '## Goal\n\nReplace the stale scope.\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    },
    'coder-session-6b',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'replace_current_scope');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resultPhase, 'blocked');
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.turns[0]?.disposition?.action, 'replace_current_scope');
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /split-plan limit/);
});

test('interactive blocked recovery dispositions reject plan-mode sessions', async () => {
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    currentScopeNumber: 4,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_plan',
      blockedReason: 'Plan review stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Keep revising the plan.',
          disposition: null,
        },
      ],
    },
  });

  await assert.rejects(
    () =>
      applyInteractiveBlockedRecoveryDisposition(
        state,
        statePath,
        {
          action: 'resume_current_scope',
          summary: 'Continue the plan review.',
          rationale: 'The operator clarified the path forward.',
          blocker: '',
          replacementPlan: '',
        },
        'coder-session-plan',
      ),
    /only supported for execute-mode runs/,
  );
});

test('neal --recover rejects plan-mode sessions', async () => {
  const { statePath } = await createResumeFixture({
    topLevelMode: 'plan',
    currentScopeNumber: 4,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'reviewer_plan',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'reviewer_plan',
      blockedReason: 'Plan review stopped converging.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
    },
  });

  await assert.rejects(
    () => runNealCliResult('--recover', statePath, '--message', 'Keep revising the plan.'),
    /--recover is only supported for execute-mode runs/,
  );
});

test('blocked top-level plan review does not enter interactive blocked recovery', async () => {
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'coder_plan_response',
    interactiveBlockedRecovery: null,
  });

  const nextState = await finalizeBlockedPlanReviewResponse(
    state,
    statePath,
    false,
    'Plan review did not converge.',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 0);
});

test('interactive blocked recovery can remain paused after a handled turn', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need clarification.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Do not touch infrastructure, only local code.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'stay_blocked',
      summary: 'Still blocked.',
      rationale: 'The guidance did not answer the key prerequisite question.',
      blocker: 'Need a concrete yes/no on whether credentials can be rotated in this scope.',
      replacementPlan: '',
    },
    'coder-session-5b',
  );

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.interactiveBlockedRecovery?.lastHandledTurn, 1);
  assert.equal(
    nextState.interactiveBlockedRecovery?.blockedReason,
    'Need a concrete yes/no on whether credentials can be rotated in this scope.',
  );
  assert.equal(nextState.interactiveBlockedRecovery?.turns[0]?.disposition?.action, 'stay_blocked');
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 0);
});

test('neal --resume reports when interactive blocked recovery is waiting for operator guidance', async () => {
  const { statePath } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need clarification.',
      maxTurns: 3,
      lastHandledTurn: 1,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Do not touch infrastructure, only local code.',
          disposition: {
            recordedAt: '2026-04-16T00:02:00.000Z',
            sessionHandle: 'coder-session-5b',
            action: 'stay_blocked',
            summary: 'Still blocked.',
            rationale: 'The guidance did not answer the key prerequisite question.',
            blocker: 'Need a concrete yes/no on whether credentials can be rotated in this scope.',
            replacementPlan: '',
            resultingPhase: 'interactive_blocked_recovery',
          },
        },
      ],
    },
  });

  const { stdout, stderr } = await runNealCliResult('--resume', statePath);
  const result = JSON.parse(stdout) as {
    ok: boolean;
    waitingForOperatorGuidance: boolean;
    phase: string;
    status: string;
  };

  assert.equal(result.ok, true);
  assert.equal(result.waitingForOperatorGuidance, true);
  assert.equal(result.phase, 'interactive_blocked_recovery');
  assert.equal(result.status, 'running');
  assert.match(stderr, /waiting for operator guidance/);
  assert.match(stderr, /neal --recover/);
});

test('interactive blocked recovery can finalize into a terminal blocked run', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 7,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    blockedFromPhase: 'coder_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-16T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need an external prerequisite.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-16T00:01:00.000Z',
          operatorGuidance: 'Try one more time with the same repository constraints.',
          disposition: null,
        },
      ],
    },
  });

  const nextState = await applyInteractiveBlockedRecoveryDisposition(
    state,
    statePath,
    {
      action: 'terminal_block',
      summary: 'No safe in-repo path remains.',
      rationale: 'The prerequisite must be handled outside Neal first.',
      blocker: 'External credentials must be provisioned before this scope can continue.',
      replacementPlan: '',
    },
    'coder-session-7b',
  );

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.interactiveBlockedRecoveryHistory.length, 1);
  assert.equal(nextState.interactiveBlockedRecoveryHistory[0]?.resolvedByAction, 'terminal_block');
  assert.equal(nextState.completedScopes.at(-1)?.result, 'blocked');
  assert.match(nextState.completedScopes.at(-1)?.blocker ?? '', /External credentials must be provisioned/);

  const consultMarkdown = await readFile(state.consultMarkdownPath, 'utf8');
  assert.match(consultMarkdown, /## Interactive Blocked Recovery History 1/);
  assert.match(consultMarkdown, /Recovery turn 1 coder action: terminal_block/);
});

test('resume keeps derived-plan reviewer rounds runnable after failure normalization', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_7.md';
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 7,
    phase: 'reviewer_plan',
    status: 'failed',
    reviewerSessionHandle: 'reviewer-session-1',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 7,
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'reviewer_plan');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'pending_review');
  assert.equal(state.derivedFromScopeNumber, 7);
});

test('accepted derived plans reject adoption after derived execution has already created commits', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'awaiting_derived_plan_execution',
    status: 'running',
    coderSessionHandle: 'coder-session-2',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: null,
    blockedFromPhase: 'reviewer_plan',
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-2',
        reviewedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['plans/derived.md'],
        claim: 'Need one more refinement',
        requiredAction: 'Clarify verification',
        status: 'fixed',
        roundSummary: 'Looks better',
        coderDisposition: 'Updated the plan',
        coderCommit: null,
      },
    ],
    createdCommits: ['deadbeef'],
  });

  assert.throws(
    () => adoptAcceptedDerivedPlan(state),
    /Cannot adopt derived plan after derived execution has already created commits/,
  );
});

test('accepted derived plans reject adoption from the wrong phase', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'reviewer_plan',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: null,
    createdCommits: [],
  });

  assert.throws(
    () => adoptAcceptedDerivedPlan(state),
    /Cannot adopt derived plan from phase reviewer_plan/,
  );
});

test('accepted derived plans reject adoption after derived scope execution has already started', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'awaiting_derived_plan_execution',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
    createdCommits: [],
  });

  assert.throws(
    () => adoptAcceptedDerivedPlan(state),
    /Cannot adopt derived plan after derived scope execution has already started/,
  );
});

test('accepted derived plans adopt only from the pre-execution adoption phase', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'awaiting_derived_plan_execution',
    status: 'running',
    coderSessionHandle: 'coder-session-2',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: null,
    blockedFromPhase: 'reviewer_plan',
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-2',
        reviewedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['plans/derived.md'],
        claim: 'Need one more refinement',
        requiredAction: 'Clarify verification',
        status: 'fixed',
        roundSummary: 'Looks better',
        coderDisposition: 'Updated the plan',
        coderCommit: null,
      },
    ],
    createdCommits: [],
  });

  const adopted = adoptAcceptedDerivedPlan(state);
  assert.equal(adopted.phase, 'coder_scope');
  assert.equal(adopted.status, 'running');
  assert.equal(adopted.derivedScopeIndex, 1);
  assert.equal(adopted.coderSessionHandle, null);
  assert.equal(adopted.blockedFromPhase, null);
  assert.deepEqual(adopted.rounds, []);
  assert.deepEqual(adopted.findings, []);
  assert.deepEqual(adopted.createdCommits, []);
  assert.equal(adopted.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
});

test('resume promotes accepted derived plans into the adoption phase', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_8.md';
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 8,
    phase: 'reviewer_plan',
    status: 'running',
    reviewerSessionHandle: 'reviewer-session-8',
    derivedPlanPath,
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 8,
    derivedScopeIndex: null,
    createdCommits: [],
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'awaiting_derived_plan_execution');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'accepted');
  assert.equal(state.derivedFromScopeNumber, 8);
  assert.equal(state.blockedFromPhase, null);
});

test('resume backfills accepted derived plan notification once', async () => {
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 9,
    phase: 'reviewer_plan',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_9.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 9,
    derivedScopeIndex: null,
    createdCommits: [],
    derivedPlanAcceptedNotified: false,
  });
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
    assert.equal(state.phase, 'awaiting_derived_plan_execution');
    assert.equal(state.derivedPlanAcceptedNotified, true);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /derived plan accepted for scope 9/);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('resume keeps active derived execution on the same derived sub-scope', async () => {
  const { cwd, statePath } = await createFinalSquashFixture({
    currentScopeNumber: 12,
    phase: 'coder_scope',
    status: 'failed',
    coderSessionHandle: 'coder-session-12',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_12.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 12,
    derivedScopeIndex: 2,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'coder_scope');
  assert.equal(state.status, 'running');
  assert.equal(state.currentScopeNumber, 12);
  assert.equal(state.derivedScopeIndex, 2);
  assert.equal(state.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_12.md');
  assert.equal(state.derivedPlanStatus, 'accepted');
  assert.equal(state.derivedFromScopeNumber, 12);
  assert.equal(state.derivedPlanAcceptedNotified, true);
});

test('flush sends split-plan rejection notification for guardrail blocks', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 10,
    phase: 'blocked',
    status: 'blocked',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    splitPlanBlockedNotified: false,
    completedScopes: [
      {
        number: '10',
        marker: 'AUTONOMY_SPLIT_PLAN',
        result: 'blocked',
        baseCommit: 'abc123',
        finalCommit: null,
        commitSubject: null,
        reviewRounds: 0,
        findings: 0,
        archivedReviewPath: null,
        blocker: 'split-plan recovery rejected: scope 10 reached the split-plan limit (10)',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    const nextState = await flushDerivedPlanNotifications(state, statePath);
    assert.equal(nextState.splitPlanBlockedNotified, true);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /split-plan recovery rejected for scope 10/);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('persistSplitPlanRecovery allows split-plan attempts up to the configured cap and blocks at 10', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 7,
    phase: 'coder_scope',
    status: 'running',
    splitPlanCountForCurrentScope: 10,
  });

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_scope',
      derivedPlanMarkdown: '# Derived plan',
      createdCommits: [],
    },
    {
      persistBlockedScope: async (blockedState, blockedStatePath, reason) => {
        return saveState(blockedStatePath, {
          ...blockedState,
          blockedFromPhase: blockedState.blockedFromPhase ?? 'coder_scope',
          completedScopes: [
            ...blockedState.completedScopes,
            {
              number: String(blockedState.currentScopeNumber),
              marker: 'AUTONOMY_SPLIT_PLAN',
              result: 'blocked',
              baseCommit: blockedState.baseCommit,
              finalCommit: null,
              commitSubject: null,
              reviewRounds: blockedState.rounds.length,
              findings: blockedState.findings.length,
              archivedReviewPath: blockedState.archivedReviewPath,
              blocker: reason,
              derivedFromParentScope: null,
              replacedByDerivedPlanPath: null,
            },
          ],
        });
      },
      writeExecutionArtifacts: async () => {},
    },
  );

  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
  assert.match(
    nextState.completedScopes.at(-1)?.blocker ?? '',
    /reached the split-plan limit \(10\)/,
  );
});

test('persistSplitPlanRecovery clears stale derivedScopeIndex when replacing an active derived scope', async () => {
  const { statePath, state } = await createFinalSquashFixture({
    currentScopeNumber: 6,
    phase: 'coder_scope',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_6.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: 5,
    splitPlanCountForCurrentScope: 2,
    createdCommits: [],
  });

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_scope',
      derivedPlanMarkdown: '## Execution Shape\n\nexecutionShape: multi_scope\n\n## Execution Queue\n\n### Scope 1: Replacement\n- Goal: Replace the stale derived scope.\n- Verification: `pnpm typecheck`\n- Success Condition: Replacement plan is ready for review.\n',
      createdCommits: [],
    },
    {
      persistBlockedScope: async (blockedState) => blockedState,
      writeExecutionArtifacts: async () => {},
    },
  );

  assert.equal(nextState.phase, 'reviewer_plan');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.derivedPlanStatus, 'pending_review');
  assert.equal(nextState.derivedFromScopeNumber, 6);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.createdCommits.length, 0);
});

test('flush sends derived-plan failure notification for blocked derived-plan review', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 11,
    phase: 'blocked',
    status: 'blocked',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_11.md',
    derivedPlanStatus: 'rejected',
    derivedFromScopeNumber: 11,
    splitPlanBlockedNotified: false,
    completedScopes: [
      {
        number: '11',
        marker: 'AUTONOMY_SPLIT_PLAN',
        result: 'blocked',
        baseCommit: 'abc123',
        finalCommit: null,
        commitSubject: null,
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'split-plan recovery failed to converge',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_11.md',
      },
    ],
  });
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    const nextState = await flushDerivedPlanNotifications(state, statePath);
    assert.equal(nextState.splitPlanBlockedNotified, true);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /derived plan review did not converge/);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('final squash advances to the next derived sub-scope without rolling up the parent', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath } = await createFinalSquashFixture({
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 1,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    const nextState = await runFinalSquashPhase(state, statePath);
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 5);
    assert.equal(nextState.derivedScopeIndex, 2);
    assert.equal(nextState.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
    assert.equal(nextState.derivedPlanStatus, 'accepted');
    assert.equal(nextState.completedScopes.some((scope) => scope.number === '5.1'), true);
    assert.equal(nextState.completedScopes.some((scope) => scope.number === '5'), false);
    const subScope = nextState.completedScopes.find((scope) => scope.number === '5.1');
    assert.equal(subScope?.derivedFromParentScope, '5');
    assert.equal(subScope?.finalCommit, nextState.baseCommit);
    const directParent = await runGit(state.cwd, 'rev-parse', `${nextState.baseCommit}^`);
    assert.equal(directParent, state.baseCommit);
    const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${state.baseCommit}..${nextState.baseCommit}`);
    assert.equal(squashedCount, '1');
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
    assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.1 complete: derived scope work']);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('computeNextScopeStateAfterSquash advances a non-terminal derived sub-scope', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'final_squash',
    status: 'running',
    baseCommit: 'base-1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 1,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    completedScopes: [
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-1',
        finalCommit: 'final-1',
        commitSubject: 'derived scope work',
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const nextState = computeNextScopeStateAfterSquash({
    state,
    finalCommit: 'final-1',
    completedScopes: state.completedScopes,
    archivedReviewPath: '/tmp/review-5.1.md',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, 2);
  assert.equal(nextState.derivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
  assert.equal(nextState.derivedPlanStatus, 'accepted');
  assert.equal(nextState.splitPlanStartedNotified, false);
  assert.equal(nextState.derivedPlanAcceptedNotified, false);
  assert.equal(nextState.splitPlanBlockedNotified, false);
});

test('final squash rolls the last derived sub-scope up into the parent scope and resumes parent execution', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath } = await createFinalSquashFixture({
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
    lastScopeMarker: 'AUTONOMY_DONE',
  });
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    const nextState = await runFinalSquashPhase(state, statePath);
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 6);
    assert.equal(nextState.derivedPlanPath, null);
    assert.equal(nextState.derivedFromScopeNumber, null);
    assert.equal(nextState.derivedPlanStatus, null);
    assert.equal(nextState.derivedScopeIndex, null);
    const subScope = nextState.completedScopes.find((scope) => scope.number === '5.2');
    const parentScope = nextState.completedScopes.find((scope) => scope.number === '5');
    assert.equal(subScope?.derivedFromParentScope, '5');
    assert.equal(parentScope?.marker, 'AUTONOMY_SCOPE_DONE');
    assert.equal(parentScope?.replacedByDerivedPlanPath, '/tmp/DERIVED_PLAN_SCOPE_5.md');
    assert.equal(parentScope?.finalCommit, subScope?.finalCommit);
    assert.equal(parentScope?.finalCommit, nextState.baseCommit);
    const directParent = await runGit(state.cwd, 'rev-parse', `${nextState.baseCommit}^`);
    assert.equal(directParent, state.baseCommit);
    const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${state.baseCommit}..${nextState.baseCommit}`);
    assert.equal(squashedCount, '1');
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
    assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.2 complete: derived scope work']);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('final squash preserves an empty derived scope checkpoint commit without attempting a no-op squash', async () => {
  const { statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath } =
    await createEmptyFinalSquashFixture({
      derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
      derivedPlanStatus: 'accepted',
      derivedFromScopeNumber: 5,
      derivedScopeIndex: 1,
      lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    });
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    const nextState = await runFinalSquashPhase(state, statePath);
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 5);
    assert.equal(nextState.derivedScopeIndex, 2);
    assert.equal(nextState.baseCommit, createdCommit);
    assert.equal(nextState.completedScopes.some((scope) => scope.number === '5.1'), true);
    const subScope = nextState.completedScopes.find((scope) => scope.number === '5.1');
    assert.equal(subScope?.finalCommit, createdCommit);
    const directParent = await runGit(state.cwd, 'rev-parse', `${createdCommit}^`);
    assert.equal(directParent, baseCommit);
    const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${baseCommit}..${createdCommit}`);
    assert.equal(squashedCount, '1');
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
    assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.1 complete: empty derived scope checkpoint']);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('final squash tolerates unrelated local changes when the run was started with ignoreLocalChanges', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath, cwd } = await createFinalSquashFixture({
    ignoreLocalChanges: true,
    lastScopeMarker: 'AUTONOMY_DONE',
  });
  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;
  const strayFile = join(cwd, 'FEEDBACK-DERIVED_PLAN.md');
  await writeFile(strayFile, 'local notes\n', 'utf8');

  try {
    const nextState = await runFinalSquashPhase(state, statePath);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');
    assert.equal(nextState.ignoreLocalChanges, true);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /plan complete/);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});

test('computeNextScopeStateAfterSquash rolls up the last derived sub-scope into the parent scope', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '5.2',
      marker: 'AUTONOMY_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-2',
      commitSubject: 'derived scope work',
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-5.2.md',
      blocker: null,
      derivedFromParentScope: '5',
      replacedByDerivedPlanPath: null,
    },
    {
      number: '5',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-2',
      commitSubject: 'derived scope work',
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-5.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    },
  ];
  const { state } = await createResumeFixture({
    currentScopeNumber: 5,
    phase: 'final_squash',
    status: 'running',
    baseCommit: 'base-1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
    lastScopeMarker: 'AUTONOMY_DONE',
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
  });

  const nextState = computeNextScopeStateAfterSquash({
    state,
    finalCommit: 'final-2',
    completedScopes,
    archivedReviewPath: '/tmp/review-5.2.md',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(nextState.baseCommit, 'final-2');
  assert.equal(nextState.derivedPlanPath, null);
  assert.equal(nextState.derivedFromScopeNumber, null);
  assert.equal(nextState.derivedPlanStatus, null);
  assert.equal(nextState.derivedScopeIndex, null);
  assert.equal(nextState.splitPlanCountForCurrentScope, 0);
  assert.deepEqual(nextState.completedScopes, completedScopes);
});

test('review and progress reports expose derived-plan audit linkage', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'reviewer_plan',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-1',
        reviewedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
        normalizationApplied: true,
        normalizationOperations: ['Normalized execution queue header `## Ordered Derived Scopes` to `## Execution Queue`.'],
        normalizationScopeLabelMappings: [{ normalizedScopeNumber: 1, originalScopeLabel: '6.6A' }],
        commitRange: {
          base: 'abc123',
          head: 'abc123',
        },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    completedScopes: [
      {
        number: '3',
        marker: 'AUTONOMY_BLOCKED',
        result: 'blocked',
        baseCommit: 'abc123',
        finalCommit: null,
        commitSubject: null,
        reviewRounds: 2,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'split-plan recovery failed to converge',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
      },
    ],
  });

  const reviewMarkdown = renderReviewMarkdown(state);
  const progressMarkdown = renderPlanProgressMarkdown(state);

  assert.match(reviewMarkdown, /Review target: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
  assert.match(reviewMarkdown, /Last reviewed artifact: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
  assert.match(reviewMarkdown, /### Round 1/);
  assert.match(reviewMarkdown, /Reviewed artifact: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
  assert.match(reviewMarkdown, /Normalization: Normalized execution queue header/);
  assert.match(reviewMarkdown, /Scope label mappings: 6\.6A -> 1/);
  assert.match(reviewMarkdown, /Derived from scope: 3/);
  assert.match(reviewMarkdown, /Discarded WIP artifact: .*SCOPE_3_DISCARDED\.diff/);
  assert.match(progressMarkdown, /Parent scope: none/);
  assert.match(progressMarkdown, /Replaced by derived plan: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
});
