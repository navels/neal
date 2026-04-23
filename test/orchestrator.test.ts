import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  adoptAcceptedDerivedPlan,
  applyInteractiveBlockedRecoveryDisposition,
  computeNextScopeStateAfterSquash,
  finalizeBlockedPlanReviewResponse,
  flushDerivedPlanNotifications,
  getExecuteResponsePhaseWithoutOpenFindings,
  getExecuteResponseRetryPhase,
  getExecuteReviewBlockReason,
  getPlanningResponseRetryPhase,
  loadOrInitialize,
  resolveExecuteReviewDisposition,
  recordInteractiveBlockedRecoveryGuidance,
  resolveDiagnosticRecovery,
  runFinalCompletionReviewPhase,
  runFinalSquashPhase,
  runOnePass,
  startDiagnosticRecovery,
} from '../src/neal/orchestrator.js';
import {
  resolveExecuteAdjudicationContext,
  synthesizeExecuteResponseState,
  synthesizeExecuteReviewerState,
} from '../src/neal/adjudicator/execute.js';
import { assertAdjudicationTransitionSignal, getAdjudicationSpec } from '../src/neal/adjudicator/specs.js';
import {
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
  EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
  buildFinalCompletionReviewerSchema,
  buildFinalCompletionSummarySchema,
  parseExecuteScopeProgressPayload,
  parseFinalCompletionReviewerPayload,
  parseFinalCompletionSummaryPayload,
  stripExecuteScopeProgressPayload,
} from '../src/neal/agents.js';
import { clearConfigCache } from '../src/neal/config.js';
import { buildFinalCompletionPacket } from '../src/neal/final-completion.js';
import { getFinalCompletionReviewArtifactPath } from '../src/neal/final-completion-review.js';
import { createRunLogger } from '../src/neal/logger.js';
import { clearProviderCapabilitiesOverridesForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import type { CoderRunPromptArgs, StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { OpenAICodexProviderError } from '../src/neal/providers/openai-codex.js';
import { notifyScopeAccepted } from '../src/neal/orchestrator/notifications.js';
import { appendCompletedScope } from '../src/neal/orchestrator/transitions.js';
import { persistSplitPlanRecovery } from '../src/neal/orchestrator/split-plan.js';
import { renderPlanProgressMarkdown } from '../src/neal/progress.js';
import { renderReviewMarkdown } from '../src/neal/review.js';
import { getRecentAcceptedScopesForParentObjective, renderRecentAcceptedScopesSummary } from '../src/neal/scopes.js';
import { createInitialState, getDefaultAgentConfig, loadState, saveState } from '../src/neal/state.js';
import type { ExecuteScopeProgressJustification, OrchestrationState, ReviewerMeaningfulProgressVerdict } from '../src/neal/types.js';

const execFileAsync = promisify(execFile);
process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator');

async function writeRepoConfig(
  cwd: string,
  overrides?: { notifyBin?: string; finalCompletionContinueExecutionMax?: number; phaseHeartbeatMs?: number },
) {
  const extraConfig =
    typeof overrides?.finalCompletionContinueExecutionMax === 'number'
      ? `  final_completion_continue_execution_max: ${overrides.finalCompletionContinueExecutionMax}\n`
      : '';
  const heartbeatConfig =
    typeof overrides?.phaseHeartbeatMs === 'number' ? `  phase_heartbeat_ms: ${overrides.phaseHeartbeatMs}\n` : '';
  await writeFile(
    join(cwd, 'config.yml'),
    `neal:\n  notify_bin: ${overrides?.notifyBin ?? '/usr/bin/true'}\n${heartbeatConfig}${extraConfig}`,
    'utf8',
  );
  clearConfigCache(cwd);
}

async function createResumeFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-scope4-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd);
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

async function readRunEvents(runDir: string) {
  const eventsPath = join(runDir, 'events.ndjson');
  const content = await readFile(eventsPath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createFinalSquashFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-squash-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'config.yml', 'scope.txt');
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

  return { cwd, statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath };
}

async function createEmptyFinalSquashFixture(overrides: Partial<OrchestrationState>) {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-squash-empty-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'config.yml', 'scope.txt');
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

  return { cwd, statePath, state, baseCommit, createdCommit, notifyLogPath, notifyScriptPath };
}

async function createDerivedPlanExecutionFixture(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-derived-plan-execution-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');

  await mkdir(runDir, { recursive: true });
  await writeRepoConfig(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'config.yml', 'scope.txt');
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

  const derivedPlanPath = join(runDir, 'DERIVED_PLAN_SCOPE_5.md');
  await writeFile(
    derivedPlanPath,
    [
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
      '',
      '## Execution Queue',
      '',
      '### Scope 1: Adopt the derived execution boundary',
      '- Goal: Run the first derived sub-scope after the accepted plan is adopted.',
      '- Verification: `pnpm exec tsx --test test/orchestrator.test.ts`',
      '- Success Condition: The first derived sub-scope is ready to execute.',
    ].join('\n'),
    'utf8',
  );

  const statePath = join(stateDir, 'session.json');
  const state = await saveState(statePath, {
    ...initialState,
    currentScopeNumber: 5,
    phase: 'awaiting_derived_plan_execution',
    status: 'running',
    coderSessionHandle: 'stale-coder-session',
    reviewerSessionHandle: 'reviewer-session-derived-pass',
    derivedPlanPath,
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: null,
    blockedFromPhase: 'reviewer_plan',
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-derived-pass',
        reviewedPlanPath: derivedPlanPath,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: baseCommit, head: baseCommit },
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
        files: [derivedPlanPath],
        claim: 'Clarify the first derived execution step.',
        requiredAction: 'Accept the plan and begin execution at derived scope 1.',
        status: 'fixed',
        roundSummary: 'Derived plan is ready for execution.',
        coderDisposition: 'Accepted the execution shape and verification.',
        coderCommit: null,
      },
    ],
    createdCommits: [],
    ...overrides,
  });

  return { cwd, statePath, state, baseCommit, derivedPlanPath };
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

test('startDiagnosticRecovery persists execute-run diagnostic recovery state from a blocked run', async () => {
  const { statePath, state } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
    baseCommit: 'scope-base-commit',
    initialBaseCommit: 'run-base-commit',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'run-base-commit',
        finalCommit: 'commit-1',
        commitSubject: 'scope 1',
        changedFiles: ['src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '4',
        marker: 'AUTONOMY_BLOCKED',
        result: 'blocked',
        baseCommit: 'scope-base-commit',
        finalCommit: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'Need broader diagnostic recovery',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const nextState = await startDiagnosticRecovery(statePath, {
    question: 'Why did the current scope stop converging?',
    target: 'src/neal/orchestrator.ts',
  });

  assert.equal(nextState.phase, 'diagnostic_recovery_analyze');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.diagnosticRecovery?.sourcePhase, 'blocked');
  assert.equal(nextState.diagnosticRecovery?.resumePhase, 'reviewer_scope');
  assert.equal(nextState.diagnosticRecovery?.blockedReason, 'Need broader diagnostic recovery');
  assert.equal(nextState.diagnosticRecovery?.effectiveBaselineRef, 'scope-base-commit');
  assert.equal(nextState.diagnosticRecovery?.effectiveBaselineSource, 'active_parent_base_commit');
  assert.match(nextState.diagnosticRecovery?.analysisArtifactPath ?? '', /DIAGNOSTIC_RECOVERY_1_ANALYSIS\.md$/);
  assert.match(nextState.diagnosticRecovery?.recoveryPlanPath ?? '', /DIAGNOSTIC_RECOVERY_1_PLAN\.md$/);

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.phase, 'diagnostic_recovery_analyze');
  assert.equal(reloadedState.diagnosticRecovery?.question, 'Why did the current scope stop converging?');
  assert.equal(reloadedState.diagnosticRecovery?.target, 'src/neal/orchestrator.ts');

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /## Diagnostic Recovery/);
  assert.match(progressMarkdown, /Why did the current scope stop converging\?/);
  assert.match(progressMarkdown, /scope-base-commit/);
});

test('startDiagnosticRecovery rejects active execute sessions that are not paused or blocked', async () => {
  const { statePath } = await createResumeFixture({
    currentScopeNumber: 1,
    phase: 'coder_scope',
    status: 'running',
    completedScopes: [],
  });

  await assert.rejects(
    () =>
      startDiagnosticRecovery(statePath, {
        question: 'Why is this diverging?',
        target: 'src/neal/orchestrator.ts',
      }),
    /Diagnostic recovery may start only from a paused execute scope, a blocked run, or interactive blocked recovery/,
  );
});

test('resume preserves diagnostic recovery sessions for inspection without manual state edits', async () => {
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_analyze',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    initialBaseCommit: 'run-base-commit',
    diagnosticRecovery: {
      sequence: 2,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need deeper diagnosis',
      question: 'What failure mode are we missing?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'run-base-commit',
      effectiveBaselineSource: 'run_base_commit',
      analysisArtifactPath: '/tmp/DIAGNOSTIC_RECOVERY_2_ANALYSIS.md',
      recoveryPlanPath: '/tmp/DIAGNOSTIC_RECOVERY_2_PLAN.md',
    },
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'diagnostic_recovery_analyze');
  assert.equal(state.status, 'running');
  assert.equal(state.diagnosticRecovery?.sequence, 2);
  assert.equal(state.diagnosticRecovery?.question, 'What failure mode are we missing?');
});

test('execute response transition helpers preserve completion and retry routing', () => {
  assert.deepEqual(getExecuteResponsePhaseWithoutOpenFindings(), {
    phase: 'final_squash',
    status: 'running',
  });
  assert.equal(getExecuteResponseRetryPhase('required'), 'coder_response');
  assert.equal(getExecuteResponseRetryPhase('optional'), 'coder_optional_response');
  assert.equal(getPlanningResponseRetryPhase('required'), 'coder_plan_response');
  assert.equal(getPlanningResponseRetryPhase('optional'), 'coder_plan_optional_response');
});

test('diagnostic recovery analyze phase writes the analysis artifact before continuing into recovery-plan review', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_analyze',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  let promptCount = 0;
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          promptCount += 1;
          if (promptCount === 1) {
            return {
              sessionHandle: 'diagnostic-session-1',
              finalResponse: [
                '# Diagnostic Analysis',
                '',
                '## Request Context',
                '- Question: Why did the current scope stop converging?',
                '',
                '## Findings',
                '- The current scope keeps revisiting the same orchestration hotspot.',
                '',
                '## Recovery Implications',
                '- The next phase should author a narrower recovery plan.',
                '',
                'AUTONOMY_DONE',
              ].join('\n'),
            };
          }
          return {
            sessionHandle: 'diagnostic-session-2',
            finalResponse: [
              '## Problem Statement',
              '',
              'The current scope keeps revisiting the same orchestration hotspot.',
              '',
              '## Goal',
              '',
              'Split the recovery work into a narrower plan before adoption.',
              '',
              '## Execution Shape',
              '',
              'executionShape: one_shot',
              '',
              'AUTONOMY_DONE',
            ].join('\n'),
          };
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-session-diagnostic-1',
            structured: {
              summary: 'Recovery plan is ready for operator adoption review.',
              executionShape: 'one_shot',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'diagnostic_recovery_adopt');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.coderSessionHandle, 'diagnostic-session-2');
    assert.equal(nextState.reviewerSessionHandle, 'reviewer-session-diagnostic-1');
    assert.equal(nextState.lastScopeMarker, 'AUTONOMY_DONE');

    const artifact = await readFile(state.diagnosticRecovery!.analysisArtifactPath, 'utf8');
    assert.match(artifact, /# Diagnostic Analysis/);
    assert.match(artifact, /The current scope keeps revisiting the same orchestration hotspot/);
    assert.doesNotMatch(artifact, /AUTONOMY_DONE/);

    const recoveryPlan = await readFile(state.diagnosticRecovery!.recoveryPlanPath, 'utf8');
    assert.match(recoveryPlan, /## Problem Statement/);
    assert.match(recoveryPlan, /executionShape: one_shot/);

    const reloadedState = await loadState(statePath);
    assert.equal(reloadedState.phase, 'diagnostic_recovery_adopt');
    assert.equal(reloadedState.diagnosticRecovery?.analysisArtifactPath, state.diagnosticRecovery?.analysisArtifactPath);

    const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /## Diagnostic Recovery/);
    assert.match(progressMarkdown, /DIAGNOSTIC_RECOVERY_1_ANALYSIS\.md/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery analyze phase accepts an empty blocked response without crashing', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_analyze',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          return {
            sessionHandle: 'diagnostic-session-2',
            finalResponse: 'AUTONOMY_BLOCKED\n',
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.coderSessionHandle, 'diagnostic-session-2');
    assert.equal(nextState.lastScopeMarker, 'AUTONOMY_BLOCKED');
    assert.equal(nextState.blockedFromPhase, 'diagnostic_recovery_analyze');

    await assert.rejects(readFile(state.diagnosticRecovery!.analysisArtifactPath, 'utf8'));

    const reloadedState = await loadState(statePath);
    assert.equal(reloadedState.phase, 'blocked');
    assert.equal(reloadedState.status, 'blocked');

    const resumed = await loadOrInitialize(null, state.cwd, getDefaultAgentConfig(), statePath, 'execute');
    assert.equal(resumed.state.phase, 'diagnostic_recovery_analyze');
    assert.equal(resumed.state.status, 'running');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery author-plan phase writes the recovery plan artifact and advances to recovery review', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_author_plan',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  const analysisArtifactPath = join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md');
  await writeFile(
    analysisArtifactPath,
    [
      '# Diagnostic Analysis',
      '',
      '## Request Context',
      '- Question: Why did the current scope stop converging?',
      '',
      '## Findings',
      '- The current approach keeps widening the orchestration surface.',
      '',
      '## Recovery Implications',
      '- The next plan should split artifact generation from adoption.',
      '',
    ].join('\n'),
    'utf8',
  );

  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath,
      recoveryPlanPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          return {
            sessionHandle: 'recovery-plan-session-1',
            finalResponse: [
              '## Problem Statement',
              '',
              'The current scope keeps revisiting the same orchestration hotspot without isolating recovery work.',
              '',
              '## Goal',
              '',
              'Produce a narrow recovery path that separates artifact generation from later adoption.',
              '',
              '## Execution Shape',
              '',
              'executionShape: one_shot',
              '',
              'AUTONOMY_DONE',
            ].join('\n'),
          };
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-session-diagnostic-2',
            structured: {
              summary: 'Recovery plan is executable and ready for operator review.',
              executionShape: 'one_shot',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'diagnostic_recovery_adopt');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.coderSessionHandle, 'recovery-plan-session-1');
    assert.equal(nextState.reviewerSessionHandle, 'reviewer-session-diagnostic-2');
    assert.equal(nextState.lastScopeMarker, 'AUTONOMY_DONE');

    const artifact = await readFile(state.diagnosticRecovery!.recoveryPlanPath, 'utf8');
    assert.match(artifact, /## Problem Statement/);
    assert.match(artifact, /executionShape: one_shot/);
    assert.doesNotMatch(artifact, /AUTONOMY_DONE/);

    const reloadedState = await loadState(statePath);
    assert.equal(reloadedState.phase, 'diagnostic_recovery_adopt');
    assert.equal(reloadedState.diagnosticRecovery?.recoveryPlanPath, state.diagnosticRecovery?.recoveryPlanPath);

    const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /## Diagnostic Recovery/);
    assert.match(progressMarkdown, /DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery author-plan phase accepts an empty blocked response without crashing', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_author_plan',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  const analysisArtifactPath = join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md');
  await writeFile(analysisArtifactPath, '# Diagnostic Analysis\n', 'utf8');

  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath,
      recoveryPlanPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          return {
            sessionHandle: 'recovery-plan-session-2',
            finalResponse: 'AUTONOMY_BLOCKED\n',
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.coderSessionHandle, 'recovery-plan-session-2');
    assert.equal(nextState.lastScopeMarker, 'AUTONOMY_BLOCKED');
    assert.equal(nextState.blockedFromPhase, 'diagnostic_recovery_author_plan');

    await assert.rejects(readFile(state.diagnosticRecovery!.recoveryPlanPath, 'utf8'));

    const reloadedState = await loadState(statePath);
    assert.equal(reloadedState.phase, 'blocked');
    assert.equal(reloadedState.status, 'blocked');

    const resumed = await loadOrInitialize(null, state.cwd, getDefaultAgentConfig(), statePath, 'execute');
    assert.equal(resumed.state.phase, 'diagnostic_recovery_author_plan');
    assert.equal(resumed.state.status, 'running');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery can be cancelled directly from a blocked diagnostic-analysis state', async () => {
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'diagnostic_recovery_analyze',
  });
  await saveState(statePath, {
    ...baseState,
    lastScopeMarker: 'AUTONOMY_BLOCKED',
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  const nextState = await resolveDiagnosticRecovery(statePath, {
    decision: 'cancel',
    rationale: 'Cancel the stuck diagnostic-analysis attempt and return to the original blocked run.',
  });

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'reviewer_scope');
  assert.equal(nextState.diagnosticRecovery, null);
  assert.equal(nextState.diagnosticRecoveryHistory.at(-1)?.decision, 'cancel');
  assert.equal(nextState.diagnosticRecoveryHistory.at(-1)?.resultPhase, 'blocked');
});

test('diagnostic recovery review with blocking findings at the round limit blocks cleanly without entering interactive blocked recovery', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_review',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    maxRounds: 1,
  });
  const recoveryPlanPath = join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md');
  await writeFile(
    recoveryPlanPath,
    ['## Problem Statement', '', 'Problem.', '', '## Goal', '', 'Goal.', '', '## Execution Shape', '', 'executionShape: one_shot', ''].join('\n'),
    'utf8',
  );
  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath,
    },
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-session-recovery-blocked',
            structured: {
              summary: 'Recovery plan still needs revision.',
              executionShape: 'one_shot',
              findings: [
                {
                  severity: 'blocking',
                  files: [recoveryPlanPath],
                  claim: 'The recovery plan remains too broad.',
                  requiredAction: 'Narrow the plan before adoption.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'diagnostic_recovery_review');
    assert.equal(nextState.diagnosticRecovery?.recoveryPlanPath, recoveryPlanPath);
    assert.equal(nextState.interactiveBlockedRecovery, null);
    assert.equal(nextState.findings.length, 1);

    const resolved = await resolveDiagnosticRecovery(statePath, {
      decision: 'cancel',
      rationale: 'The reviewed recovery plan is not suitable to adopt.',
    });
    assert.equal(resolved.phase, 'blocked');
    assert.equal(resolved.status, 'blocked');
    assert.equal(resolved.diagnosticRecovery, null);
    assert.equal(resolved.diagnosticRecoveryHistory.at(-1)?.reviewArtifactPath?.endsWith('DIAGNOSTIC_RECOVERY_1_REVIEW.md'), true);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery review reuses ordinary plan review against the recorded recovery-plan artifact', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_review',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  const recoveryPlanPath = join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md');
  await writeFile(
    recoveryPlanPath,
    [
      '## Problem Statement',
      '',
      'The current scope keeps revisiting the same orchestration hotspot.',
      '',
      '## Goal',
      '',
      'Split the recovery work into a narrower adoption-safe plan.',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );

  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath,
    },
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-session-recovery-1',
            structured: {
              summary: 'Recovery plan is executable and ready for operator adoption review.',
              executionShape: 'one_shot',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'diagnostic_recovery_adopt');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.executionShape, 'one_shot');
    assert.equal(nextState.reviewerSessionHandle, 'reviewer-session-recovery-1');
    assert.equal(nextState.rounds.length, 1);
    assert.equal(nextState.rounds[0]?.reviewedPlanPath, recoveryPlanPath);

    const reviewMarkdown = await readFile(state.reviewMarkdownPath, 'utf8');
    assert.match(reviewMarkdown, /- Review target: .*DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
    assert.match(reviewMarkdown, /- Review target kind: diagnostic recovery plan candidate/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery review preserves recovery-plan context across blocking response rounds', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_review',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    coderSessionHandle: 'recovery-plan-session-seeded',
  });
  const recoveryPlanPath = join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md');
  await writeFile(
    recoveryPlanPath,
    [
      '## Problem Statement',
      '',
      'The current scope keeps revisiting the same orchestration hotspot.',
      '',
      '## Goal',
      '',
      'Split the recovery work into a narrower adoption-safe plan.',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
    ].join('\n'),
    'utf8',
  );

  const state = await saveState(statePath, {
    ...initialState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath,
    },
  });

  const reviewerPrompts: string[] = [];
  const coderPrompts: string[] = [];
  let reviewRound = 0;

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          reviewerPrompts.push(args.prompt);
          reviewRound += 1;
          if (reviewRound === 1) {
            return {
              sessionHandle: 'reviewer-session-recovery-blocking',
              structured: {
                summary: 'Recovery plan needs one blocking revision before adoption.',
                executionShape: 'one_shot',
                findings: [
                  {
                    severity: 'blocking',
                    files: [recoveryPlanPath],
                    claim: 'Clarify how the adoption boundary stays limited to the active parent objective.',
                    requiredAction: 'Add explicit adoption-boundary language to the recovery plan.',
                  },
                ],
              } as TStructured,
            };
          }

          return {
            sessionHandle: 'reviewer-session-recovery-pass',
            structured: {
              summary: 'Recovery plan is ready for operator adoption review.',
              executionShape: 'one_shot',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          coderPrompts.push(args.prompt);
          return {
            sessionHandle: 'recovery-plan-session-followup',
            finalResponse: JSON.stringify({
              outcome: 'responded',
              summary: 'Added explicit adoption-boundary language.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Clarified that adoption replaces only the active parent objective context.',
                },
              ],
            }),
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'diagnostic_recovery_adopt');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.reviewerSessionHandle, 'reviewer-session-recovery-pass');
    assert.equal(nextState.coderSessionHandle, 'recovery-plan-session-followup');
    assert.equal(nextState.rounds.length, 2);
    assert.equal(nextState.rounds[0]?.reviewedPlanPath, recoveryPlanPath);
    assert.equal(nextState.rounds[1]?.reviewedPlanPath, recoveryPlanPath);

    assert.equal(coderPrompts.length, 1);
    assert.match(coderPrompts[0] ?? '', /diagnostic recovery plan candidate at .*DIAGNOSTIC_RECOVERY_1_PLAN\.md for parent objective 4/);
    assert.match(coderPrompts[0] ?? '', /Edit only the diagnostic recovery plan artifact/);

    assert.equal(reviewerPrompts.length, 2);
    assert.match(reviewerPrompts[0] ?? '', /diagnostic recovery plan candidate at .*DIAGNOSTIC_RECOVERY_1_PLAN\.md for parent objective 4/);
    assert.match(reviewerPrompts[1] ?? '', /diagnostic recovery plan candidate at .*DIAGNOSTIC_RECOVERY_1_PLAN\.md for parent objective 4/);

    const reviewMarkdown = await readFile(state.reviewMarkdownPath, 'utf8');
    assert.match(reviewMarkdown, /- Review target: .*DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
    assert.match(reviewMarkdown, /### Round 2/);

    const reloadedState = await loadState(statePath);
    assert.equal(reloadedState.phase, 'diagnostic_recovery_adopt');
    assert.equal(reloadedState.rounds.length, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('diagnostic recovery adoption routes the reviewed recovery plan through derived-plan execution state and clears stale carry-over state', async () => {
  const recoveryPlanPath = '/tmp/DIAGNOSTIC_RECOVERY_1_PLAN.normalized.md';
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  await saveState(statePath, {
    ...baseState,
    lastScopeMarker: 'AUTONOMY_BLOCKED',
    splitPlanCountForCurrentScope: 3,
    derivedPlanDepth: 1,
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Need operator guidance',
      maxTurns: 3,
      lastHandledTurn: 1,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-17T00:01:00.000Z',
          operatorGuidance: 'Try diagnostic recovery.',
          disposition: null,
        },
      ],
      pendingDirective: null,
    },
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-pass',
        reviewedPlanPath: recoveryPlanPath,
        normalizationApplied: true,
        normalizationOperations: ['execution-shape-normalized'],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  const nextState = await resolveDiagnosticRecovery(statePath, {
    decision: 'adopt_recovery_plan',
    rationale: 'The reviewed recovery plan is narrow enough to replace the failing parent objective.',
  });

  assert.equal(nextState.phase, 'awaiting_derived_plan_execution');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.derivedPlanPath, recoveryPlanPath);
  assert.equal(nextState.derivedPlanStatus, 'accepted');
  assert.equal(nextState.derivedFromScopeNumber, 4);
  assert.equal(nextState.lastScopeMarker, null);
  assert.equal(nextState.splitPlanCountForCurrentScope, 0);
  assert.equal(nextState.derivedPlanDepth, 0);
  assert.equal(nextState.interactiveBlockedRecovery, null);
  assert.equal(nextState.diagnosticRecovery, null);
  assert.equal(nextState.diagnosticRecoveryHistory.length, 1);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.decision, 'adopt_recovery_plan');
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.resultPhase, 'awaiting_derived_plan_execution');
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.adoptedPlanPath, recoveryPlanPath);

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.phase, 'awaiting_derived_plan_execution');
  assert.equal(reloadedState.diagnosticRecoveryHistory[0]?.decision, 'adopt_recovery_plan');
});

test('diagnostic recovery adoption rejects unreviewed recovery plans', async () => {
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  await saveState(statePath, {
    ...baseState,
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  await assert.rejects(
    () =>
      resolveDiagnosticRecovery(statePath, {
        decision: 'adopt_recovery_plan',
      }),
    /Cannot adopt diagnostic recovery without a reviewed recovery plan artifact/,
  );
});

test('diagnostic recovery adoption rejects reviewed plans with open blocking findings', async () => {
  const recoveryPlanPath = join(tmpdir(), 'DIAGNOSTIC_RECOVERY_1_PLAN.normalized.md');
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  await saveState(statePath, {
    ...baseState,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-pass',
        reviewedPlanPath: recoveryPlanPath,
        normalizationApplied: true,
        normalizationOperations: ['execution-shape-normalized'],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'recovery-scope-too-broad',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [recoveryPlanPath],
        claim: 'The recovery plan remains too broad.',
        requiredAction: 'Narrow the plan before adoption.',
        status: 'open',
        roundSummary: 'Recovery plan still needs revision.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'reviewer_scope',
      parentScopeLabel: '4',
      blockedReason: 'Need broader diagnostic recovery',
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  await assert.rejects(
    () =>
      resolveDiagnosticRecovery(statePath, {
        decision: 'adopt_recovery_plan',
      }),
    /Cannot adopt diagnostic recovery while recovery-plan review still has open blocking findings/,
  );
});

test('diagnostic recovery can be kept as reference only while returning the run to an ordinary paused state', async () => {
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    status: 'running',
    blockedFromPhase: 'coder_scope',
  });
  await saveState(statePath, {
    ...baseState,
    coderSessionHandle: 'stale-coder-session',
    reviewerSessionHandle: 'reviewer-session-recovery-pass',
    consultRounds: [
      {
        number: 1,
        sourcePhase: 'coder_scope',
        coderSessionHandle: 'coder-session-recovery-1',
        reviewerSessionHandle: 'reviewer-session-recovery-1',
        request: {
          summary: 'Need recovery review clarification',
          blocker: 'Recovery review findings need interpretation',
          question: 'Should this plan remain reference-only?',
          attempts: ['Ran the diagnostic recovery review'],
          relevantFiles: ['src/neal/orchestrator.ts'],
          verificationContext: ['pnpm typecheck'],
        },
        response: null,
        disposition: null,
      },
    ],
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-pass',
        reviewedPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'recovery-adoption-boundary',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md')],
        claim: 'Clarify the adoption boundary.',
        requiredAction: 'Constrain the recovery plan to the active parent objective.',
        status: 'open',
        roundSummary: 'Recovery plan needs one more change.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
    diagnosticRecovery: {
      sequence: 1,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      resumePhase: 'coder_scope',
      parentScopeLabel: '4',
      blockedReason: null,
      question: 'Why did the current scope stop converging?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'),
    },
  });

  const nextState = await resolveDiagnosticRecovery(statePath, {
    decision: 'keep_as_reference',
    rationale: 'Keep the recovery artifacts for later, but do not replace the current scope yet.',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, null);
  assert.equal(nextState.coderSessionHandle, null);
  assert.equal(nextState.reviewerSessionHandle, null);
  assert.equal(nextState.lastScopeMarker, null);
  assert.equal(nextState.diagnosticRecovery, null);
  assert.deepEqual(nextState.rounds, []);
  assert.deepEqual(nextState.findings, []);
  assert.deepEqual(nextState.consultRounds, []);
  assert.equal(nextState.diagnosticRecoveryHistory.length, 1);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.decision, 'keep_as_reference');
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.resultPhase, 'coder_scope');
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.adoptedPlanPath, null);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.reviewArtifactPath?.endsWith('DIAGNOSTIC_RECOVERY_1_REVIEW.md'), true);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.reviewRoundCount, 1);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.reviewFindingCount, 1);
});

test('diagnostic recovery started from interactive blocked recovery restores the original interactive recovery context on keep_as_reference', async () => {
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    status: 'running',
    blockedFromPhase: 'interactive_blocked_recovery',
  });
  await saveState(statePath, {
    ...baseState,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-pass',
        reviewedPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_3_PLAN.md'),
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    diagnosticRecovery: {
      sequence: 3,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'interactive_blocked_recovery',
      resumePhase: 'interactive_blocked_recovery',
      parentScopeLabel: '4',
      blockedReason: 'Need a more structural diagnosis',
      question: 'What recovery plan would break the current churn pattern?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_3_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_3_PLAN.md'),
    },
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Scope is strategically non-convergent',
      maxTurns: 3,
      lastHandledTurn: 1,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-17T00:01:00.000Z',
          operatorGuidance: 'Pause and pursue diagnostic recovery.',
          disposition: {
            recordedAt: '2026-04-17T00:02:00.000Z',
            sessionHandle: 'coder-session-ibr',
            action: 'stay_blocked',
            summary: 'Diagnostic recovery is the right next step.',
            rationale: 'The current loop is not converging.',
            blocker: 'Need a new plan shape.',
            replacementPlan: '',
            resultingPhase: 'interactive_blocked_recovery',
          },
        },
      ],
      pendingDirective: null,
    },
  });

  const nextState = await resolveDiagnosticRecovery(statePath, {
    decision: 'keep_as_reference',
    rationale: 'Keep the reviewed recovery plan as reference and return to the interactive recovery loop.',
  });

  assert.equal(nextState.phase, 'interactive_blocked_recovery');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.blockedFromPhase, 'reviewer_scope');
  assert.equal(nextState.interactiveBlockedRecovery?.sourcePhase, 'reviewer_scope');
  assert.equal(nextState.interactiveBlockedRecovery?.blockedReason, 'Scope is strategically non-convergent');
  assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 1);
  assert.equal(nextState.interactiveBlockedRecovery?.turns[0]?.operatorGuidance, 'Pause and pursue diagnostic recovery.');
  assert.equal(nextState.diagnosticRecovery, null);
  assert.equal(nextState.diagnosticRecoveryHistory.at(-1)?.decision, 'keep_as_reference');
  assert.equal(nextState.diagnosticRecoveryHistory.at(-1)?.resultPhase, 'interactive_blocked_recovery');
});

test('diagnostic recovery cancel clears the pending intervention while preserving an auditable history entry', async () => {
  const { statePath, state: baseState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'diagnostic_recovery_adopt',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
  });
  await saveState(statePath, {
    ...baseState,
    lastScopeMarker: 'AUTONOMY_BLOCKED',
    consultRounds: [
      {
        number: 1,
        sourcePhase: 'coder_scope',
        coderSessionHandle: 'coder-session-recovery-2',
        reviewerSessionHandle: 'reviewer-session-recovery-2',
        request: {
          summary: 'Need recovery cancellation clarification',
          blocker: 'The operator may want to cancel the intervention entirely',
          question: 'Should the intervention be cancelled?',
          attempts: ['Reviewed the candidate recovery plan'],
          relevantFiles: ['src/neal/orchestrator.ts'],
          verificationContext: ['pnpm exec tsx --test test/orchestrator.test.ts'],
        },
        response: null,
        disposition: null,
      },
    ],
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session-recovery-pass',
        reviewedPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_2_PLAN.md'),
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'abc123', head: 'abc123' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'recovery-scope-too-broad',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_2_PLAN.md')],
        claim: 'The recovery plan remains too broad.',
        requiredAction: 'Narrow the plan before adoption.',
        status: 'open',
        roundSummary: 'Recovery plan still needs revision.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
    diagnosticRecovery: {
      sequence: 2,
      startedAt: '2026-04-17T00:00:00.000Z',
      sourcePhase: 'blocked',
      resumePhase: 'coder_scope',
      parentScopeLabel: '4',
      blockedReason: null,
      question: 'Is there a better way to re-enter this scope?',
      target: 'src/neal/orchestrator.ts',
      requestedBaselineRef: null,
      effectiveBaselineRef: 'scope-base-commit',
      effectiveBaselineSource: 'active_parent_base_commit',
      analysisArtifactPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_2_ANALYSIS.md'),
      recoveryPlanPath: join(baseState.runDir, 'DIAGNOSTIC_RECOVERY_2_PLAN.md'),
    },
  });

  const nextState = await resolveDiagnosticRecovery(statePath, {
    decision: 'cancel',
  });

  assert.equal(nextState.phase, 'blocked');
  assert.equal(nextState.status, 'blocked');
  assert.equal(nextState.blockedFromPhase, 'coder_scope');
  assert.equal(nextState.lastScopeMarker, 'AUTONOMY_BLOCKED');
  assert.equal(nextState.diagnosticRecovery, null);
  assert.deepEqual(nextState.rounds, []);
  assert.deepEqual(nextState.findings, []);
  assert.deepEqual(nextState.consultRounds, []);
  assert.equal(nextState.diagnosticRecoveryHistory.length, 1);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.decision, 'cancel');
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.resultPhase, 'blocked');
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.reviewArtifactPath?.endsWith('DIAGNOSTIC_RECOVERY_2_REVIEW.md'), true);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.reviewRoundCount, 1);
  assert.equal(nextState.diagnosticRecoveryHistory[0]?.reviewFindingCount, 1);
});

test('diagnostic recovery end-to-end logs auditable events and allocates collision-safe repeated artifact paths', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'reviewer_scope',
    completedScopes: [
      {
        number: '4',
        marker: 'AUTONOMY_BLOCKED',
        result: 'blocked',
        baseCommit: 'scope-base-commit',
        finalCommit: null,
        commitSubject: null,
        changedFiles: [],
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'Need a cleaner baseline before more scope work.',
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd: initialState.cwd,
    stateDir: join(initialState.cwd, '.neal'),
    planDoc: initialState.planDoc,
    topLevelMode: initialState.topLevelMode,
    runDir: initialState.runDir,
  });

  let coderPromptCount = 0;
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          coderPromptCount += 1;
          if (coderPromptCount === 1) {
            return {
              sessionHandle: 'diagnostic-analysis-session-1',
              finalResponse: [
                '# Diagnostic Analysis',
                '',
                '## Request Context',
                '- Question: Why did the current scope stop converging?',
                '',
                '## Findings',
                '- The scope keeps revisiting the same orchestration hotspot without resetting the hypothesis chain.',
                '',
                '## Recovery Implications',
                '- Recovery should isolate artifact generation from later adoption.',
                '',
                'AUTONOMY_DONE',
              ].join('\n'),
            };
          }

          return {
            sessionHandle: 'diagnostic-plan-session-1',
            finalResponse: [
              '## Problem Statement',
              '',
              'The current scope keeps revisiting the same orchestration hotspot without isolating recovery work.',
              '',
              '## Goal',
              '',
              'Create a bounded recovery path that preserves the active run while generating replacement context.',
              '',
              '## Execution Shape',
              '',
              'executionShape: one_shot',
              '',
              'AUTONOMY_DONE',
            ].join('\n'),
          };
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'diagnostic-review-session-1',
            structured: {
              summary: 'Recovery plan is ready for operator review.',
              executionShape: 'one_shot',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const startedState = await startDiagnosticRecovery(
      statePath,
      {
        question: 'Why did the current scope stop converging?',
        target: 'src/neal/orchestrator.ts',
      },
      logger,
    );
    assert.equal(startedState.phase, 'diagnostic_recovery_analyze');
    assert.match(startedState.diagnosticRecovery?.analysisArtifactPath ?? '', /DIAGNOSTIC_RECOVERY_1_ANALYSIS\.md$/);
    assert.match(startedState.diagnosticRecovery?.recoveryPlanPath ?? '', /DIAGNOSTIC_RECOVERY_1_PLAN\.md$/);

    const afterRecoveryFlow = await runOnePass(startedState, statePath, logger);
    assert.equal(afterRecoveryFlow.phase, 'diagnostic_recovery_adopt');

    const reviewMarkdown = await readFile(initialState.reviewMarkdownPath, 'utf8');
    assert.match(reviewMarkdown, /- Review target: .*DIAGNOSTIC_RECOVERY_1_PLAN\.md/);
    assert.match(reviewMarkdown, /- Review target kind: diagnostic recovery plan candidate/);

    const referencedState = await resolveDiagnosticRecovery(
      statePath,
      {
        decision: 'keep_as_reference',
        rationale: 'Keep this recovery candidate for reference while the operator decides how to resume.',
      },
      logger,
    );
    assert.equal(referencedState.phase, 'blocked');
    assert.equal(referencedState.diagnosticRecoveryHistory.length, 1);
    assert.equal(referencedState.diagnosticRecoveryHistory[0]?.decision, 'keep_as_reference');

    const secondStart = await startDiagnosticRecovery(
      statePath,
      {
        question: 'What would a cleaner baseline change about the failure analysis?',
        target: 'src/neal/orchestrator.ts',
        baselineRef: 'feature/clean-baseline',
      },
      logger,
    );
    assert.equal(secondStart.phase, 'diagnostic_recovery_analyze');
    assert.equal(secondStart.diagnosticRecovery?.sequence, 2);
    assert.match(secondStart.diagnosticRecovery?.analysisArtifactPath ?? '', /DIAGNOSTIC_RECOVERY_2_ANALYSIS\.md$/);
    assert.match(secondStart.diagnosticRecovery?.recoveryPlanPath ?? '', /DIAGNOSTIC_RECOVERY_2_PLAN\.md$/);
    assert.equal(secondStart.diagnosticRecovery?.effectiveBaselineRef, 'feature/clean-baseline');
    assert.equal(secondStart.diagnosticRecovery?.effectiveBaselineSource, 'explicit');

    const progressMarkdown = await readFile(initialState.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /## Diagnostic Recovery/);
    assert.match(progressMarkdown, /Sequence: 2/);
    assert.match(progressMarkdown, /feature\/clean-baseline/);
    assert.match(progressMarkdown, /## Diagnostic Recovery History/);
    assert.match(progressMarkdown, /Sessions: 1/);
    assert.match(progressMarkdown, /Latest decision: keep_as_reference/);

    const analysisArtifact = await readFile(join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'), 'utf8');
    assert.match(analysisArtifact, /# Diagnostic Analysis/);
    const recoveryPlanArtifact = await readFile(join(initialState.runDir, 'DIAGNOSTIC_RECOVERY_1_PLAN.md'), 'utf8');
    assert.match(recoveryPlanArtifact, /executionShape: one_shot/);

    const events = await readRunEvents(initialState.runDir);
    const eventTypes = events.map((event) => event.type);
    assert.deepEqual(
      eventTypes.filter((type) => type === 'diagnostic_recovery.started'),
      ['diagnostic_recovery.started', 'diagnostic_recovery.started'],
    );
    assert.equal(eventTypes.includes('diagnostic_recovery.resolved'), true);

    const firstStartEvent = events.find(
      (event) =>
        event.type === 'diagnostic_recovery.started' &&
        String(event.data?.analysisArtifactPath ?? '').endsWith('DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
    );
    assert.equal(firstStartEvent?.data?.effectiveBaselineRef, 'scope-base-commit');

    const resolvedEvent = events.find((event) => event.type === 'diagnostic_recovery.resolved');
    assert.equal(resolvedEvent?.data?.decision, 'keep_as_reference');
    assert.equal(resolvedEvent?.data?.resultPhase, 'blocked');

    const secondStartEvent = events.find(
      (event) =>
        event.type === 'diagnostic_recovery.started' &&
        String(event.data?.analysisArtifactPath ?? '').endsWith('DIAGNOSTIC_RECOVERY_2_ANALYSIS.md'),
    );
    assert.equal(secondStartEvent?.data?.effectiveBaselineRef, 'feature/clean-baseline');

    assert.equal(
      events.some(
        (event) =>
          event.type === 'phase.complete' &&
          event.data?.phase === 'diagnostic_recovery_analyze' &&
          String(event.data?.analysisArtifactPath ?? '').endsWith('DIAGNOSTIC_RECOVERY_1_ANALYSIS.md'),
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === 'phase.complete' &&
          event.data?.phase === 'diagnostic_recovery_author_plan' &&
          String(event.data?.recoveryPlanPath ?? '').endsWith('DIAGNOSTIC_RECOVERY_1_PLAN.md'),
      ),
      true,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
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
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'awaiting_derived_plan_execution');
  assert.equal(state.derivedPlanAcceptedNotified, true);
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /derived plan accepted for scope 9/);
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

test('resume recovering committed coder work backfills progress justification for reviewer adjudication', async () => {
  const { cwd, statePath } = await createFinalSquashFixture({
    currentScopeNumber: 13,
    phase: 'coder_scope',
    status: 'failed',
    coderSessionHandle: 'coder-session-13',
    createdCommits: [],
    currentScopeProgressJustification: null,
  });
  await writeFile(join(cwd, '.git', 'info', 'exclude'), '.neal/\n', 'utf8');

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'reviewer_scope');
  assert.equal(state.status, 'running');
  assert.equal(state.createdCommits.length, 1);
  assert.ok(state.currentScopeProgressJustification);
  assert.match(
    state.currentScopeProgressJustification.milestoneTargeted,
    /Recovered completed coder work for scope 13/,
  );
  assert.match(state.currentScopeProgressJustification.newEvidence, /derived scope work/);
  assert.match(state.currentScopeProgressJustification.newEvidence, /scope\.txt/);

  const reloadedState = await loadState(statePath);
  assert.ok(reloadedState.currentScopeProgressJustification);

  const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /Coder milestone: Recovered completed coder work for scope 13/);

  const reviewMarkdown = await readFile(state.reviewMarkdownPath, 'utf8');
  assert.match(reviewMarkdown, /Coder milestone: Recovered completed coder work for scope 13/);
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
        changedFiles: [],
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
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  const nextState = await flushDerivedPlanNotifications(state, statePath);
  assert.equal(nextState.splitPlanBlockedNotified, true);
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /split-plan recovery rejected for scope 10/);
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
              changedFiles: [],
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
        changedFiles: [],
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
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  const nextState = await flushDerivedPlanNotifications(state, statePath);
  assert.equal(nextState.splitPlanBlockedNotified, true);
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.match(notifyLog, /derived plan review did not converge/);
});

test('final squash advances to the next derived sub-scope without rolling up the parent', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath } = await createFinalSquashFixture({
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 1,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });

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
  assert.deepEqual(subScope?.changedFiles, ['scope.txt']);
  const directParent = await runGit(state.cwd, 'rev-parse', `${nextState.baseCommit}^`);
  assert.equal(directParent, state.baseCommit);
  const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${state.baseCommit}..${nextState.baseCommit}`);
  assert.equal(squashedCount, '1');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
  assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.1 complete: derived scope work']);
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
        changedFiles: ['src/feature-a.ts'],
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
  assert.deepEqual(subScope?.changedFiles, ['scope.txt']);
  assert.deepEqual(parentScope?.changedFiles, ['scope.txt']);
  const directParent = await runGit(state.cwd, 'rev-parse', `${nextState.baseCommit}^`);
  assert.equal(directParent, state.baseCommit);
  const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${state.baseCommit}..${nextState.baseCommit}`);
  assert.equal(squashedCount, '1');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
  assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.2 complete: derived scope work']);
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

  const nextState = await runFinalSquashPhase(state, statePath);
  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, 2);
  assert.equal(nextState.baseCommit, createdCommit);
  assert.equal(nextState.completedScopes.some((scope) => scope.number === '5.1'), true);
  const subScope = nextState.completedScopes.find((scope) => scope.number === '5.1');
  assert.equal(subScope?.finalCommit, createdCommit);
  assert.deepEqual(subScope?.changedFiles, []);
  const directParent = await runGit(state.cwd, 'rev-parse', `${createdCommit}^`);
  assert.equal(directParent, baseCommit);
  const squashedCount = await runGit(state.cwd, 'rev-list', '--count', `${baseCommit}..${createdCommit}`);
  assert.equal(squashedCount, '1');
  const notifyLog = await readFile(notifyLogPath, 'utf8');
  const notifyLines = notifyLog.trim().split('\n').filter(Boolean);
  assert.deepEqual(notifyLines, ['[neal] PLAN.md: scope 5.1 complete: empty derived scope checkpoint']);
});

test('notifyScopeAccepted includes total scope count when the execution plan is a valid multi-scope doc', async () => {
  const { cwd, state } = await createResumeFixture({
    currentScopeNumber: 2,
  });
  const multiScopePlan = [
    '# Example Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: First',
    '- Goal: Do the first thing.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: First thing done.',
    '',
    '### Scope 2: Second',
    '- Goal: Do the second thing.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: Second thing done.',
    '',
    '### Scope 3: Third',
    '- Goal: Do the third thing.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: Third thing done.',
    '',
  ].join('\n');
  await writeFile(state.planDoc, multiScopePlan, 'utf8');
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  await notifyScopeAccepted(state, 'wire up scope 2');

  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 2/3 complete: wire up scope 2');
});

test('notifyScopeAccepted falls back to scope label alone when the plan cannot be validated', async () => {
  const { cwd, state } = await createResumeFixture({
    currentScopeNumber: 1,
  });
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  await notifyScopeAccepted(state, 'scope 1 work');

  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 1 complete: scope 1 work');
});

test('notifyScopeAccepted renders unknown totals explicitly for recurring unknown-total plans', async () => {
  const { cwd, state } = await createResumeFixture({
    currentScopeNumber: 2,
    executionShape: 'multi_scope_unknown',
  });
  await writeFile(
    state.planDoc,
    [
      '# Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope_unknown',
      '',
      '## Execution Loop',
      '',
      '### Recurring Scope',
      '- Goal: Ship one recurring slice.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: One bounded slice is done.',
      '',
      '## Completion Condition',
      '',
      'The backlog is fully drained.',
      '',
    ].join('\n'),
    'utf8',
  );
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(cwd);
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });

  await notifyScopeAccepted(state, 'ship another recurring slice');

  const notifyLog = await readFile(notifyLogPath, 'utf8');
  assert.equal(notifyLog.trim(), '[neal] PLAN.md: scope 2/? complete: ship another recurring slice');
});

test('final squash tolerates unrelated local changes when the run was started with ignoreLocalChanges', async () => {
  const { statePath, state, notifyLogPath, notifyScriptPath, cwd } = await createFinalSquashFixture({
    ignoreLocalChanges: true,
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the terminal scope before finalization.',
      verificationSummary: 'Pre-recorded summary for terminal final-squash coverage.',
      remainingKnownGaps: [],
    },
  });
  const strayFile = join(cwd, 'FEEDBACK-DERIVED_PLAN.md');
  await writeFile(strayFile, 'local notes\n', 'utf8');

  const nextState = await runFinalSquashPhase(state, statePath);
  assert.equal(nextState.phase, 'final_completion_review');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.ignoreLocalChanges, true);
  await assert.rejects(readFile(notifyLogPath, 'utf8'));
});

test('final squash routes terminal execution into final completion review instead of completing immediately', async () => {
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'coder-final-completion-1',
            structured: {
              planGoalSatisfied: true,
              whatChangedOverall: 'Completed the terminal scope and assembled the whole-plan packet.',
              verificationSummary: 'Ran final-squash coverage with the current repository state.',
              remainingKnownGaps: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { statePath, state, notifyLogPath } = await createFinalSquashFixture({
      lastScopeMarker: 'AUTONOMY_DONE',
    });

    const nextState = await runFinalSquashPhase(state, statePath);
    assert.equal(nextState.phase, 'final_completion_review');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.finalCompletionSummary?.planGoalSatisfied, true);
    assert.equal(nextState.finalCommit !== null, true);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /# Final Completion Review/);
    assert.match(completionArtifact, /## Coder Completion Summary/);
    assert.match(completionArtifact, /Completed the terminal scope and assembled the whole-plan packet\./);
    assert.match(completionArtifact, /## Reviewer Verdict/);
    assert.match(completionArtifact, /Pending\./);
    await assert.rejects(readFile(notifyLogPath, 'utf8'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass accepts whole-plan completion only after reviewer final completion verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-accept-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: 'final-5',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Implemented the dedicated whole-plan completion gate.',
      verificationSummary: 'Ran orchestrator and review tests.',
      remainingKnownGaps: [],
    },
  });
  await writeRepoConfig(fixtureState.cwd, { notifyBin: notifyScriptPath });
  const state = await saveState(statePath, {
    ...fixtureState,
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'reviewer-final-completion-1',
            structured: {
              action: 'accept_complete',
              summary: 'The plan outcome is complete and coherent.',
              rationale: 'The completed scopes satisfy the plan objectives with no remaining known gaps.',
              missingWork: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'accept_complete');
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /plan complete/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass accepts one-shot whole-plan completion after final completion review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-one-shot-accept-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 1,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the one-shot plan and reached whole-plan acceptance.',
      verificationSummary: 'Ran one-shot final-completion orchestrator coverage.',
      remainingKnownGaps: [],
    },
  });
  await writeRepoConfig(fixtureState.cwd, { notifyBin: notifyScriptPath });
  const state = await saveState(statePath, {
    ...fixtureState,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish one-shot plan',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'reviewer-final-completion-one-shot',
            structured: {
              action: 'accept_complete',
              summary: 'The one-shot plan is complete as a whole.',
              rationale: 'The one accepted scope satisfies the declared plan objective with no remaining gaps.',
              missingWork: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');
    assert.equal(nextState.executionShape, 'one_shot');
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'accept_complete');
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /- Execution shape: one_shot/);
    assert.match(completionArtifact, /Run completed cleanly\./);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /plan complete/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final squash persists the squashed checkpoint before failing the coder final-completion summary round', async () => {
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound() {
          throw new OpenAICodexProviderError('final completion summary failed', 'coder-final-completion-failed');
        },
      };
    },
  });

  try {
    const { statePath, state } = await createFinalSquashFixture({
      lastScopeMarker: 'AUTONOMY_DONE',
    });

    await assert.rejects(
      () => runFinalSquashPhase(state, statePath),
      /final completion summary failed/,
    );

    const failedState = await loadState(statePath);
    assert.equal(failedState.phase, 'final_squash');
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.finalCommit !== null, true);
    assert.equal(failedState.archivedReviewPath?.endsWith(`REVIEW-${failedState.finalCommit}.md`), true);
    assert.equal(failedState.completedScopes.some((scope) => scope.finalCommit === failedState.finalCommit), true);
    assert.equal(failedState.coderSessionHandle, 'coder-final-completion-failed');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass reopens execution as a new follow-on scope when final completion review returns continue_execution', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 5,
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Added the coder completion summary contract but not the reviewer verdict gate.',
      verificationSummary: 'Ran orchestrator and review tests.',
      remainingKnownGaps: ['Reviewer final-completion verdict still needs execute-mode wiring.'],
    },
  });
  const state = await saveState(statePath, {
    ...fixtureState,
    phase: 'final_completion_review',
    status: 'running',
    coderRetryCount: 1,
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-2',
            structured: {
              action: 'continue_execution',
              summary: 'One follow-on scope is still required before the plan can complete.',
              rationale: 'The execute state machine still finalizes automatically after final_squash.',
              missingWork: {
                summary: 'Add a dedicated final completion reviewer phase.',
                requiredOutcome: 'Route terminal execution through an explicit reviewer verdict before AUTONOMY_DONE.',
                verification: 'Run orchestrator and review tests plus typecheck.',
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath);
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 6);
    assert.equal(nextState.baseCommit, createdCommit);
    assert.equal(nextState.finalCommit, null);
    assert.equal(nextState.finalCompletionSummary, null);
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'continue_execution');
    assert.equal(nextState.finalCompletionResolvedAction, 'continue_execution');
    assert.equal(nextState.finalCompletionContinueExecutionCount, 1);
    assert.equal(nextState.finalCompletionContinueExecutionCapReached, false);
    assert.equal(nextState.coderRetryCount, 0);
    const progressMarkdown = await readFile(nextState.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /## Final Completion Review/);
    assert.match(progressMarkdown, /- Resulting action: continue_execution/);
    assert.match(progressMarkdown, /Add a dedicated final completion reviewer phase/);
    assert.match(progressMarkdown, /Route terminal execution through an explicit reviewer verdict before AUTONOMY_DONE/);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /- Reviewer action: continue_execution/);
    assert.match(completionArtifact, /Execution reopened with one explicit follow-on scope\./);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review keeps one-shot plans on scope 1 when continue_execution requests follow-on work', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 1,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'The one-shot implementation landed, but the whole-plan review found one bounded repair.',
      verificationSummary: 'Ran one-shot continue-execution coverage.',
      remainingKnownGaps: ['One repair is still required before the plan can complete.'],
    },
  });
  const state = await saveState(statePath, {
    ...fixtureState,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish one-shot plan',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-one-shot-continue',
            structured: {
              action: 'continue_execution',
              summary: 'One bounded repair is still required.',
              rationale: 'A one-shot plan can reopen execution without inventing a second numbered scope.',
              missingWork: {
                summary: 'Apply the final one-shot repair.',
                requiredOutcome: 'Reopen execution while staying on scope 1.',
                verification: 'Run orchestrator tests plus typecheck.',
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath);
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 1);
    assert.equal(nextState.executionShape, 'one_shot');
    const progressMarkdown = await readFile(nextState.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /- Progress: scope 1\/1/);
    assert.match(progressMarkdown, /- Resulting action: continue_execution/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review reopens recurring unknown-total plans on the next numbered scope', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 5,
    executionShape: 'multi_scope_unknown',
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'One recurring slice landed, but the completion condition is not satisfied yet.',
      verificationSummary: 'Ran recurring unknown-total final completion coverage.',
      remainingKnownGaps: ['Another bounded recurring slice is still required.'],
    },
  });
  const state = await saveState(statePath, {
    ...fixtureState,
    executionShape: 'multi_scope_unknown',
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish recurring scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-recurring',
            structured: {
              action: 'continue_execution',
              summary: 'The recurring loop needs one more bounded slice.',
              rationale: 'The explicit completion condition is still false after the current recurring scope.',
              missingWork: {
                summary: 'Implement the next recurring slice.',
                requiredOutcome: 'Reopen execution on the next numbered recurring scope.',
                verification: 'Run orchestrator and review tests plus typecheck.',
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath);
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 6);
    assert.equal(nextState.baseCommit, createdCommit);
    assert.equal(nextState.finalCommit, null);
    const progressMarkdown = await readFile(nextState.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /- Progress: scope 6\/\?/);
    assert.match(progressMarkdown, /- Resulting action: continue_execution/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass honors stop-after-current-scope on final completion continue_execution reopen', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 5,
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Completed most of the plan, but one bounded follow-on scope is still required.',
      verificationSummary: 'Ran final completion review coverage.',
      remainingKnownGaps: ['One explicit follow-on repair remains.'],
    },
  });
  const state = await saveState(statePath, {
    ...fixtureState,
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-pause',
            structured: {
              action: 'continue_execution',
              summary: 'One follow-on scope is still required before the plan can complete.',
              rationale: 'The whole-plan review found one bounded remaining repair.',
              missingWork: {
                summary: 'Add the missing follow-on scope.',
                requiredOutcome: 'Reopen execution for one explicit repair scope.',
                verification: 'Run orchestrator tests plus typecheck.',
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath, undefined, {
      shouldStopAfterCurrentScope() {
        return true;
      },
    });
    assert.equal(nextState.phase, 'coder_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.currentScopeNumber, 6);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass honors stop-after-current-scope on the final_squash to coder_scope boundary and refreshes display state on both sides', async () => {
  const { statePath, state } = await createFinalSquashFixture({
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const displayStates: Array<{ phase: string; currentScopeNumber: number; startedAtType: string }> = [];
  let stopChecks = 0;

  const nextState = await runOnePass(state, statePath, logger, {
    onDisplayState(currentState, phaseStartedAt) {
      displayStates.push({
        phase: currentState.phase,
        currentScopeNumber: currentState.currentScopeNumber,
        startedAtType: typeof phaseStartedAt,
      });
    },
    shouldStopAfterCurrentScope() {
      stopChecks += 1;
      return true;
    },
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 6);
  assert.equal(stopChecks, 1);
  assert.deepEqual(
    displayStates.map((entry) => ({
      phase: entry.phase,
      currentScopeNumber: entry.currentScopeNumber,
    })),
    [
      { phase: 'final_squash', currentScopeNumber: 5 },
      { phase: 'coder_scope', currentScopeNumber: 6 },
    ],
  );
  assert.equal(displayStates.every((entry) => entry.startedAtType === 'number'), true);

  const events = await readRunEvents(state.runDir);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'phase.complete' &&
        event.data?.phase === 'final_squash' &&
        event.data?.continueScopes === true,
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'run.paused_after_scope' &&
        event.data?.phase === 'coder_scope' &&
        event.data?.currentScopeNumber === 6,
    ),
    true,
  );
});

test('runOnePass pauses after accepted derived-plan adoption before derived coder scope execution starts', async () => {
  const { statePath, state, derivedPlanPath } = await createDerivedPlanExecutionFixture();
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const nextState = await runOnePass(state, statePath, logger, {
    shouldStopAfterCurrentScope() {
      return true;
    },
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.derivedPlanPath, derivedPlanPath);
  assert.equal(nextState.derivedPlanStatus, 'accepted');
  assert.equal(nextState.derivedFromScopeNumber, 5);
  assert.equal(nextState.derivedScopeIndex, 1);
  assert.equal(nextState.coderSessionHandle, null);
  assert.equal(nextState.blockedFromPhase, null);
  assert.deepEqual(nextState.rounds, []);
  assert.deepEqual(nextState.findings, []);
  assert.deepEqual(nextState.createdCommits, []);

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.phase, 'coder_scope');
  assert.equal(reloadedState.status, 'running');
  assert.equal(reloadedState.derivedScopeIndex, 1);
  assert.equal(reloadedState.derivedPlanPath, derivedPlanPath);

  const events = await readRunEvents(state.runDir);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'phase.complete' &&
        event.data?.phase === 'awaiting_derived_plan_execution' &&
        event.data?.nextPhase === 'coder_scope' &&
        event.data?.planDoc === derivedPlanPath,
    ),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'phase.start' && event.data?.phase === 'coder_scope'),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'run.paused_after_scope' &&
        event.data?.phase === 'coder_scope' &&
        event.data?.currentScopeNumber === 5,
    ),
    true,
  );
});

test('runOnePass continues into derived coder scope execution when stop-after-current-scope is not requested', async () => {
  const { statePath, state } = await createDerivedPlanExecutionFixture();
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('derived-coder-scope-reached');
        },
      };
    },
  });

  try {
    await assert.rejects(() => runOnePass(state, statePath, logger), /derived-coder-scope-reached/);

    const reloadedState = await loadState(statePath);
    assert.equal(reloadedState.phase, 'coder_scope');
    assert.equal(reloadedState.status, 'running');
    assert.equal(reloadedState.derivedScopeIndex, 1);

    const events = await readRunEvents(state.runDir);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'phase.complete' &&
          event.data?.phase === 'awaiting_derived_plan_execution' &&
          event.data?.nextPhase === 'coder_scope',
      ),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'phase.start' && event.data?.phase === 'coder_scope'),
      true,
    );
    assert.equal(events.some((event) => event.type === 'run.paused_after_scope'), false);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review emits heartbeat and completion events in order before final run completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-heartbeat-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the last scope and paused for whole-plan review.',
      verificationSummary: 'Ran final completion heartbeat coverage.',
      remainingKnownGaps: [],
    },
  });
  await writeRepoConfig(fixtureState.cwd, {
    notifyBin: notifyScriptPath,
    phaseHeartbeatMs: 10,
  });
  const state = await saveState(statePath, {
    ...fixtureState,
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          await delay(35);
          return {
            sessionHandle: 'reviewer-final-completion-heartbeat',
            structured: {
              action: 'accept_complete',
              summary: 'The plan outcome is complete and coherent.',
              rationale: 'The whole-plan result matches the stated objective after the last accepted scope.',
              missingWork: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath, logger);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');

    const events = await readRunEvents(state.runDir);
    const startIndex = events.findIndex(
      (event) => event.type === 'phase.start' && event.data?.phase === 'final_completion_review',
    );
    const heartbeatIndex = events.findIndex(
      (event) => event.type === 'phase.heartbeat' && event.data?.phase === 'final_completion_review',
    );
    const completeIndex = events.findIndex(
      (event) => event.type === 'phase.complete' && event.data?.phase === 'final_completion_review',
    );
    const notifyIndex = events.findIndex((event) => event.type === 'notify.complete');
    const runCompleteIndex = events.findIndex((event) => event.type === 'run.complete');

    assert.notEqual(startIndex, -1);
    assert.notEqual(heartbeatIndex, -1);
    assert.notEqual(completeIndex, -1);
    assert.notEqual(notifyIndex, -1);
    assert.notEqual(runCompleteIndex, -1);
    assert.equal(startIndex < heartbeatIndex, true);
    assert.equal(heartbeatIndex < completeIndex, true);
    assert.equal(completeIndex < notifyIndex, true);
    assert.equal(notifyIndex < runCompleteIndex, true);

    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /plan complete: finish scope 5/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope inactivity timeout retries once on a fresh session and records retry diagnostics before failing cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-coder-timeout-retry-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: finalSquashState } = await createFinalSquashFixture({
    currentScopeNumber: 4,
    createdCommits: [],
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'stale-session',
  });
  await writeRepoConfig(finalSquashState.cwd, { notifyBin: notifyScriptPath });
  const fixtureState = await saveState(statePath, {
    ...finalSquashState,
    currentScopeNumber: 4,
    createdCommits: [],
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'stale-session',
    blockedFromPhase: null,
    lastScopeMarker: null,
    currentScopeProgressJustification: null,
  });
  const logger = await createRunLogger({
    cwd: fixtureState.cwd,
    stateDir: dirname(statePath),
    planDoc: fixtureState.planDoc,
    topLevelMode: fixtureState.topLevelMode,
    runDir: fixtureState.runDir,
  });

  let coderCalls = 0;
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          coderCalls += 1;
          if (coderCalls === 1) {
            assert.equal(args.resumeHandle, 'stale-session');
            throw new OpenAICodexProviderError('Coder timed out after 600000ms of inactivity', 'stale-session');
          }

          assert.equal(args.resumeHandle, null);
          await args.onSessionStarted?.('fresh-session');
          throw new OpenAICodexProviderError('coder retry failed after fresh session', 'fresh-session');
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runOnePass(fixtureState, statePath, logger),
      /coder retry failed after fresh session/,
    );

    assert.equal(coderCalls, 2);
    const failedState = await loadState(statePath);
    assert.equal(failedState.phase, 'coder_scope');
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.coderRetryCount, 1);
    assert.equal(failedState.coderSessionHandle, 'fresh-session');

    const events = await readRunEvents(failedState.runDir);
    const cleanupIndex = events.findIndex((event) => event.type === 'coder.timeout_cleanup');
    const retryIndex = events.findIndex(
      (event) => event.type === 'phase.retry' && event.data?.phase === 'coder_scope',
    );
    const notifyIndex = events.findIndex((event) => event.type === 'notify.retry');
    const failureIndex = events.findIndex(
      (event) => event.type === 'phase.error' && event.data?.phase === 'coder_scope',
    );
    assert.notEqual(cleanupIndex, -1);
    assert.notEqual(retryIndex, -1);
    assert.notEqual(notifyIndex, -1);
    assert.notEqual(failureIndex, -1);
    assert.equal(cleanupIndex < retryIndex, true);
    assert.equal(retryIndex < notifyIndex, true);
    assert.equal(notifyIndex < failureIndex, true);

    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /scope 4 timed out in coder_scope; retrying with a fresh coder session/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope stream failure after a clean commit recovers directly into review', async () => {
  const { statePath, state: fixtureState } = await createFinalSquashFixture({
    currentScopeNumber: 14,
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'interrupted-session',
    createdCommits: [],
    currentScopeProgressJustification: null,
  });
  await writeFile(join(fixtureState.cwd, '.git', 'info', 'exclude'), '.neal/\n', 'utf8');
  const logger = await createRunLogger({
    cwd: fixtureState.cwd,
    stateDir: dirname(statePath),
    planDoc: fixtureState.planDoc,
    topLevelMode: fixtureState.topLevelMode,
    runDir: fixtureState.runDir,
  });

  let reviewerCalled = false;
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new OpenAICodexProviderError(
            'stream disconnected before completion: request failed after commit',
            'recovered-coder-session',
          );
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound() {
          reviewerCalled = true;
          throw new Error('stop after recovered pending review');
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runOnePass(fixtureState, statePath, logger),
      /stop after recovered pending review/,
    );

    assert.equal(reviewerCalled, true);
    const recoveredState = await loadState(statePath);
    assert.equal(recoveredState.phase, 'reviewer_scope');
    assert.equal(recoveredState.status, 'running');
    assert.equal(recoveredState.coderSessionHandle, 'recovered-coder-session');
    assert.equal(recoveredState.createdCommits.length, 1);
    assert.ok(recoveredState.currentScopeProgressJustification);
    assert.match(
      recoveredState.currentScopeProgressJustification.milestoneTargeted,
      /Recovered completed coder work for scope 14/,
    );

    const events = await readRunEvents(recoveredState.runDir);
    assert.equal(
      events.some((event) => event.type === 'run.recovered_pending_review_after_coder_failure'),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'phase.error' && event.data?.phase === 'coder_scope'),
      false,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope stream failure with dirty committed work still fails instead of recovering', async () => {
  const { statePath, state: fixtureState, cwd } = await createFinalSquashFixture({
    currentScopeNumber: 15,
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'interrupted-session',
    createdCommits: [],
    currentScopeProgressJustification: null,
  });
  await writeFile(join(cwd, '.git', 'info', 'exclude'), '.neal/\n', 'utf8');
  await writeFile(join(cwd, 'scope.txt'), 'base\nchange\ndirty\n', 'utf8');
  const logger = await createRunLogger({
    cwd: fixtureState.cwd,
    stateDir: dirname(statePath),
    planDoc: fixtureState.planDoc,
    topLevelMode: fixtureState.topLevelMode,
    runDir: fixtureState.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new OpenAICodexProviderError(
            'stream disconnected before completion: request failed with dirty worktree',
            'failed-coder-session',
          );
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runOnePass(fixtureState, statePath, logger),
      /stream disconnected before completion/,
    );

    const failedState = await loadState(statePath);
    assert.equal(failedState.phase, 'coder_scope');
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.coderSessionHandle, 'failed-coder-session');
    assert.deepEqual(failedState.createdCommits, []);

    const events = await readRunEvents(failedState.runDir);
    assert.equal(
      events.some((event) => event.type === 'run.recovered_pending_review_after_coder_failure'),
      false,
    );
    assert.equal(
      events.some((event) => event.type === 'phase.error' && event.data?.phase === 'coder_scope'),
      true,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review blocks with an explicit diagnostic hint when continue_execution exceeds its cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-cap-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 5,
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionContinueExecutionCount: 1,
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the first reopen cycle already.',
      verificationSummary: 'Ran orchestrator and review tests.',
      remainingKnownGaps: ['One more final-completion repair was requested.'],
    },
  });
  await writeRepoConfig(fixtureState.cwd, {
    notifyBin: notifyScriptPath,
    finalCompletionContinueExecutionMax: 1,
  });
  const state = await saveState(statePath, {
    ...fixtureState,
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-cap',
            structured: {
              action: 'continue_execution',
              summary: 'Another bounded follow-on scope would normally be required.',
              rationale: 'The completion strategy is still incomplete and needs additional repair work.',
              missingWork: {
                summary: 'Add one more final completion repair scope.',
                requiredOutcome: 'Finish the remaining final-completion control-path wiring.',
                verification: 'Run orchestrator and review tests plus typecheck.',
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath);
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'final_completion_review');
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'continue_execution');
    assert.equal(nextState.finalCompletionResolvedAction, 'block_for_operator');
    assert.equal(nextState.finalCompletionContinueExecutionCount, 1);
    assert.equal(nextState.finalCompletionContinueExecutionCapReached, true);
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /continue_execution cap \(1\) is already exhausted/);
    assert.match(notifyLog, /One available next step is `neal --diagnose`/);
    const progressMarkdown = await readFile(nextState.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /- Reviewer action: continue_execution/);
    assert.match(progressMarkdown, /- Resulting action: block_for_operator/);
    assert.match(progressMarkdown, /- Continue-execution cap reached: yes/);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /- Resulting action: block_for_operator/);
    assert.match(completionArtifact, /Run blocked for operator guidance\./);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review supports a direct block_for_operator verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-block-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createFinalSquashFixture({
    currentScopeNumber: 2,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Completed the one-shot implementation but operator confirmation is still required.',
      verificationSummary: 'Ran orchestrator coverage for one-shot final completion.',
      remainingKnownGaps: ['The release decision is externally constrained.'],
    },
  });
  await writeRepoConfig(fixtureState.cwd, { notifyBin: notifyScriptPath });
  const state = await saveState(statePath, {
    ...fixtureState,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: createdCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '1',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit: createdCommit,
        commitSubject: 'finish one-shot plan',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'reviewer-final-completion-block',
            structured: {
              action: 'block_for_operator',
              summary: 'A human decision is still required before this plan can be considered complete.',
              rationale: 'The remaining gap is external and should not reopen execution.',
              missingWork: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath);
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'final_completion_review');
    assert.equal(nextState.executionShape, 'one_shot');
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'block_for_operator');
    assert.equal(nextState.finalCompletionResolvedAction, 'block_for_operator');
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /blocked completion for operator guidance/);
    assert.match(notifyLog, /One available next step is `neal --diagnose`/);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /- Execution shape: one_shot/);
    assert.match(completionArtifact, /- Reviewer action: block_for_operator/);
    assert.match(completionArtifact, /Run blocked for operator guidance\./);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('verification-only terminal scope bypasses ordinary reviewer_scope and goes straight to final completion review', async () => {
  const { statePath, state } = await createEmptyFinalSquashFixture({
    currentScopeNumber: 4,
    phase: 'coder_scope',
    status: 'running',
    lastScopeMarker: null,
    createdCommits: [],
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          assert.match(args.prompt, /If this scope completes the entire plan, return AUTONOMY_DONE/);
          return {
            sessionHandle: 'coder-scope-session-final',
            finalResponse: [
              EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
              JSON.stringify({
                milestoneTargeted: 'Finish with verification-only completion.',
                newEvidence: 'The required verification already passed.',
                whyNotRedundant: 'No further code changes are needed for the terminal plan state.',
                nextStepUnlocked: 'Neal can evaluate whole-plan completion directly.',
              }),
              EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
              '',
              'AUTONOMY_DONE',
            ].join('\n'),
          };
        },
      };
    },
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'coder-final-completion-verify-only',
            structured: {
              planGoalSatisfied: true,
              whatChangedOverall: 'No further implementation changes were required before final completion review.',
              verificationSummary: 'Used the existing verification-only completion evidence.',
              remainingKnownGaps: [],
            } as TStructured,
          };
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'reviewer-final-completion-verify-only',
            structured: {
              action: 'accept_complete',
              summary: 'The verification-only terminal state still satisfies the plan as a whole.',
              rationale: 'There was no remaining implementation diff to review, and the whole-plan packet is complete.',
              missingWork: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runOnePass(state, statePath);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');
    assert.equal(nextState.rounds.length, 0);
    assert.equal(nextState.currentScopeMeaningfulProgressVerdict, null);
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'accept_complete');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
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
      changedFiles: ['src/feature-a.ts'],
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
      changedFiles: ['src/feature-a.ts'],
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

test('computeNextScopeStateAfterSquash keeps recurring unknown-total plans advancing one scope at a time', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '4',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-4',
      commitSubject: 'finish recurring scope 4',
      changedFiles: ['src/loop.ts'],
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-4.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: null,
    },
  ];
  const { state } = await createResumeFixture({
    currentScopeNumber: 4,
    executionShape: 'multi_scope_unknown',
    phase: 'final_squash',
    status: 'running',
    baseCommit: 'base-1',
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });

  const nextState = computeNextScopeStateAfterSquash({
    state,
    finalCommit: 'final-4',
    completedScopes,
    archivedReviewPath: '/tmp/review-4.md',
  });

  assert.equal(nextState.phase, 'coder_scope');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 5);
  assert.equal(nextState.baseCommit, 'final-4');
  assert.deepEqual(nextState.completedScopes, completedScopes);
});

test('computeNextScopeStateAfterSquash routes one-shot AUTONOMY_SCOPE_DONE into final completion review without inventing a new scope', async () => {
  const completedScopes: OrchestrationState['completedScopes'] = [
    {
      number: '1',
      marker: 'AUTONOMY_SCOPE_DONE',
      result: 'accepted',
      baseCommit: 'base-1',
      finalCommit: 'final-1',
      commitSubject: 'finish one-shot implementation',
      changedFiles: ['src/one-shot.ts'],
      reviewRounds: 1,
      findings: 0,
      archivedReviewPath: '/tmp/review-1.md',
      blocker: null,
      derivedFromParentScope: null,
      replacedByDerivedPlanPath: null,
    },
  ];
  const { state } = await createResumeFixture({
    currentScopeNumber: 1,
    executionShape: 'one_shot',
    phase: 'final_squash',
    status: 'running',
    baseCommit: 'base-1',
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
  });

  const nextState = computeNextScopeStateAfterSquash({
    state,
    finalCommit: 'final-1',
    completedScopes,
    archivedReviewPath: '/tmp/review-1.md',
  });

  assert.equal(nextState.phase, 'final_completion_review');
  assert.equal(nextState.status, 'running');
  assert.equal(nextState.currentScopeNumber, 1);
  assert.equal(nextState.finalCommit, 'final-1');
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
        changedFiles: [],
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
  assert.match(reviewMarkdown, /## Adjudication Contract/);
  assert.match(reviewMarkdown, /- Adjudication spec id: derived_plan_review/);
  assert.match(reviewMarkdown, /- Adjudication family: plan_review/);
  assert.match(reviewMarkdown, /- Allowed transition outcomes: accept_derived_plan, request_revision, optional_revision, block_for_operator/);
  assert.match(progressMarkdown, /## Adjudication Contract/);
  assert.match(progressMarkdown, /- Adjudication spec id: derived_plan_review/);
  assert.match(progressMarkdown, /Parent scope: none/);
  assert.match(progressMarkdown, /Replaced by derived plan: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
});

test('recent accepted scope history for a parent objective keeps oldest-first order within the bounded window', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 9,
    completedScopes: [
      {
        number: '3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-3',
        finalCommit: 'final-3',
        commitSubject: 'scope 3',
        changedFiles: ['src/3.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-3.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-1',
        finalCommit: 'final-5-1',
        commitSubject: 'scope 5.1',
        changedFiles: ['src/shared.ts', 'src/a.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.1.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-2',
        finalCommit: 'final-5-2',
        commitSubject: 'scope 5.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.2.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-3',
        finalCommit: 'final-5-3',
        commitSubject: 'scope 5.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.3.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.4',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-4',
        finalCommit: 'final-5-4',
        commitSubject: 'scope 5.4',
        changedFiles: ['src/shared.ts', 'src/d.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.4.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.5',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-5',
        finalCommit: 'final-5-5',
        commitSubject: 'scope 5.5',
        changedFiles: ['src/shared.ts', 'src/e.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.5.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5',
        finalCommit: 'final-5',
        commitSubject: 'rolled-up scope 5',
        changedFiles: ['src/shared.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
      },
      {
        number: '5.6',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'blocked',
        baseCommit: 'base-5-6',
        finalCommit: null,
        commitSubject: null,
        changedFiles: ['src/shared.ts'],
        reviewRounds: 1,
        findings: 1,
        archivedReviewPath: null,
        blocker: 'blocked scope',
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const recentHistory = getRecentAcceptedScopesForParentObjective(state, '5');
  assert.deepEqual(recentHistory.map((scope) => scope.number), ['5.1', '5.2', '5.3', '5.4', '5.5']);
  assert.deepEqual(recentHistory.map((scope) => scope.changedFiles), [
    ['src/shared.ts', 'src/a.ts'],
    ['src/shared.ts', 'src/b.ts'],
    ['src/shared.ts', 'src/c.ts'],
    ['src/shared.ts', 'src/d.ts'],
    ['src/shared.ts', 'src/e.ts'],
  ]);
  assert.deepEqual(
    state.completedScopes.find((scope) => scope.number === '5')?.changedFiles,
    ['src/shared.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
  );
});

test('state hydration backfills completed scope changed-files history for older sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-state-hydration-'));
  const stateDir = join(root, '.neal');
  const statePath = join(stateDir, 'session.json');
  await mkdir(stateDir, { recursive: true });

  await writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        planDoc: '/tmp/PLAN.md',
        cwd: '/tmp/repo',
        runDir: '/tmp/repo/.neal/runs/test-run',
        topLevelMode: 'execute',
        ignoreLocalChanges: false,
        agentConfig: getDefaultAgentConfig(),
        progressJsonPath: '/tmp/repo/.neal/runs/test-run/plan-progress.json',
        progressMarkdownPath: '/tmp/repo/.neal/runs/test-run/PLAN_PROGRESS.md',
        consultMarkdownPath: '/tmp/repo/.neal/runs/test-run/CONSULT.md',
        phase: 'coder_scope',
        createdAt: '2026-04-17T00:00:00.000Z',
        updatedAt: '2026-04-17T00:00:00.000Z',
        reviewMarkdownPath: '/tmp/repo/.neal/runs/test-run/REVIEW.md',
        archivedReviewPath: null,
        baseCommit: 'abc123',
        finalCommit: null,
        coderSessionHandle: null,
        reviewerSessionHandle: null,
        executionShape: 'multi_scope',
        currentScopeNumber: 2,
        coderRetryCount: 0,
        lastScopeMarker: null,
        derivedPlanPath: null,
        derivedFromScopeNumber: null,
        derivedPlanStatus: null,
        derivedScopeIndex: null,
        splitPlanStartedNotified: false,
        derivedPlanAcceptedNotified: false,
        splitPlanBlockedNotified: false,
        splitPlanCountForCurrentScope: 0,
        derivedPlanDepth: 0,
        maxDerivedPlanReviewRounds: 5,
        rounds: [],
        consultRounds: [],
        findings: [],
        createdCommits: [],
        completedScopes: [
          {
            number: '1',
            marker: 'AUTONOMY_SCOPE_DONE',
            result: 'accepted',
            baseCommit: 'abc123',
            finalCommit: 'def456',
            commitSubject: 'legacy scope',
            reviewRounds: 1,
            findings: 0,
            archivedReviewPath: '/tmp/review.md',
            blocker: null,
            derivedFromParentScope: null,
            replacedByDerivedPlanPath: null,
          },
        ],
        maxRounds: 3,
        maxConsultsPerScope: 4,
        blockedFromPhase: null,
        interactiveBlockedRecovery: null,
        interactiveBlockedRecoveryHistory: [],
        status: 'running',
      },
      null,
      2,
    ),
    'utf8',
  );

  const hydrated = await loadState(statePath);
  assert.deepEqual(hydrated.completedScopes[0]?.changedFiles, []);
  assert.equal(hydrated.currentScopeMeaningfulProgressVerdict, null);
});

test('recent accepted scope summary surfaces repeated hotspot churn for the parent objective', async () => {
  const { state } = await createResumeFixture({
    completedScopes: [
      {
        number: '5.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-2',
        finalCommit: 'final-5-2',
        commitSubject: 'scope 5.2',
        changedFiles: ['src/shared.ts', 'src/b.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.2.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
      {
        number: '5.3',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-5-3',
        finalCommit: 'final-5-3',
        commitSubject: 'scope 5.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        reviewRounds: 1,
        findings: 0,
        archivedReviewPath: '/tmp/review-5.3.md',
        blocker: null,
        derivedFromParentScope: '5',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const summary = renderRecentAcceptedScopesSummary(state, '5');
  assert.match(summary, /Accepted scope history for parent objective 5/);
  assert.match(summary, /Scope 5\.2/);
  assert.match(summary, /Scope 5\.3/);
  assert.match(summary, /Touched-file concentration: src\/shared\.ts \(2\/2 scopes\), src\/b\.ts \(1\/2 scopes\), src\/c\.ts \(1\/2 scopes\)/);
});

test('execute review disposition only permits final squash for meaningful-progress accept', () => {
  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'accept',
    }),
    {
      phase: 'final_squash',
      status: 'running',
      blockedFromPhase: null,
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: true,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'accept',
    }),
    {
      phase: 'coder_optional_response',
      status: 'running',
      blockedFromPhase: null,
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'block_for_operator',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: true,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'block_for_operator',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: false,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'replace_plan',
    }),
    {
      phase: 'blocked',
      status: 'blocked',
      blockedFromPhase: 'reviewer_scope',
    },
  );

  assert.deepEqual(
    resolveExecuteReviewDisposition({
      hasBlockingFindings: true,
      hasOpenNonBlockingFindings: false,
      reachedMaxRounds: false,
      shouldBlockForConvergence: false,
      meaningfulProgressAction: 'replace_plan',
    }),
    {
      phase: 'coder_response',
      status: 'running',
      blockedFromPhase: null,
    },
  );
});

test('execute reviewer acceptance with only non-blocking findings routes to optional response', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    rounds: [],
    findings: [],
    maxRounds: 3,
  });
  const context = resolveExecuteAdjudicationContext(state);

  const reviewerState = synthesizeExecuteReviewerState({
    state,
    context,
    headCommit: 'head123',
    reviewerResult: {
      sessionHandle: 'reviewer-session',
      summary: 'Only bounded residual polish remains.',
      findings: [
        {
          round: context.round,
          source: 'reviewer',
          severity: 'non_blocking',
          files: ['src/neal/review.ts'],
          claim: 'Review artifacts should preserve optional dispositions.',
          evidence: 'Without optional triage, an accepted scope can lose the coder rationale for non-blocking review debt.',
          requiredAction: 'Route accepted scopes with open non-blocking findings through coder_optional_response.',
          roundSummary: 'Only bounded residual polish remains.',
        },
      ],
      meaningfulProgress: {
        action: 'accept',
        rationale: 'The scope materially advances the parent objective and only non-blocking polish remains.',
      },
    },
  });

  assert.deepEqual(reviewerState.disposition, {
    phase: 'coder_optional_response',
    status: 'running',
    blockedFromPhase: null,
  });
  assert.equal(reviewerState.mergedFindings.length, 1);
  assert.equal(reviewerState.mergedFindings[0].status, 'open');
  assert.equal(reviewerState.mergedFindings[0].evidence, 'Without optional triage, an accepted scope can lose the coder rationale for non-blocking review debt.');
});

test('execute optional response must disposition every open non-blocking finding before final squash', async () => {
  const { state } = await createResumeFixture({
    phase: 'coder_optional_response',
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/prompts/execute.ts'],
        claim: 'Prompt should be clearer.',
        evidence: 'The optional prompt does not make bounded fixes the default.',
        requiredAction: 'Clarify optional uptake.',
        status: 'open',
        roundSummary: 'Optional uptake needs explicit triage.',
        coderDisposition: null,
        coderCommit: null,
      },
      {
        id: 'R1-F2',
        canonicalId: 'C2',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/adjudicator/execute.ts'],
        claim: 'Disposition persistence should be explicit.',
        evidence: 'Missing responses would leave an open non-blocking finding while final squash proceeds.',
        requiredAction: 'Require one disposition per open non-blocking finding.',
        status: 'open',
        roundSummary: 'Optional uptake needs explicit triage.',
        coderDisposition: null,
        coderCommit: null,
      },
      {
        id: 'R1-F3',
        canonicalId: 'C3',
        round: 1,
        source: 'reviewer',
        severity: 'non_blocking',
        files: ['src/neal/review.ts'],
        claim: 'A reviewer suggestion may be incorrect.',
        evidence: 'The optional response contract should preserve evidence-backed rejection rather than reopening the finding.',
        requiredAction: 'Reject incorrect non-blocking findings with a rationale.',
        status: 'open',
        roundSummary: 'Optional uptake needs explicit triage.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });

  assert.throws(
    () =>
      synthesizeExecuteResponseState({
        state,
        mode: 'optional',
        createdCommits: ['fix123'],
        response: {
          sessionHandle: 'coder-session',
          payload: {
            outcome: 'responded',
            summary: 'Handled optional findings.',
            blocker: '',
            derivedPlan: '',
            responses: [
              {
                id: 'R1-F1',
                decision: 'fixed',
                summary: 'Clarified the prompt.',
              },
            ],
          },
        },
      }),
    /did not disposition every open finding: R1-F2/,
  );

  const responseState = synthesizeExecuteResponseState({
    state,
    mode: 'optional',
    createdCommits: ['fix123'],
    response: {
      sessionHandle: 'coder-session',
      payload: {
        outcome: 'responded',
        summary: 'Handled optional findings.',
        blocker: '',
        derivedPlan: '',
        responses: [
          {
            id: 'R1-F1',
            decision: 'fixed',
            summary: 'Clarified the prompt.',
          },
          {
            id: 'R1-F2',
            decision: 'deferred',
            summary: 'The finding is real but should wait for the residual-debt artifact scope.',
          },
          {
            id: 'R1-F3',
            decision: 'rejected',
            summary: 'The suggestion is incorrect because review markdown already preserves rejected dispositions.',
          },
        ],
      },
    },
  });

  assert.equal(responseState.nextPhase, 'final_squash');
  assert.equal(responseState.findings[0].status, 'fixed');
  assert.equal(responseState.findings[0].coderDisposition, 'Clarified the prompt.');
  assert.equal(responseState.findings[0].coderCommit, 'fix123');
  assert.equal(responseState.findings[1].status, 'deferred');
  assert.equal(responseState.findings[1].coderDisposition, 'The finding is real but should wait for the residual-debt artifact scope.');
  assert.equal(responseState.findings[1].coderCommit, null);
  assert.equal(responseState.findings[2].status, 'rejected');
  assert.equal(responseState.findings[2].coderDisposition, 'The suggestion is incorrect because review markdown already preserves rejected dispositions.');
  assert.equal(responseState.findings[2].coderCommit, null);

  const acceptedState = {
    ...state,
    phase: responseState.nextPhase,
    status: responseState.nextStatus,
    findings: responseState.findings,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE' as const,
  };
  const completedScopes = appendCompletedScope(acceptedState, 'accepted', {
    finalCommit: 'scope-final',
    commitSubject: 'finish optional uptake',
    changedFiles: ['src/neal/prompts/execute.ts', 'src/neal/adjudicator/execute.ts'],
    archivedReviewPath: '/tmp/review-optional.md',
    blocker: null,
    marker: 'AUTONOMY_SCOPE_DONE',
  });
  const completionPacket = await buildFinalCompletionPacket({
    state: {
      ...acceptedState,
      completedScopes,
      finalCommit: 'scope-final',
      createdCommits: [],
    },
    terminalScope: null,
  });

  assert.deepEqual(
    completionPacket.residualReviewDebt.map((item) => `${item.id}:${item.status}:${item.coderDisposition}`),
    ['R1-F2:deferred:The finding is real but should wait for the residual-debt artifact scope.'],
  );
  assert.match(completionPacket.completedScopeSummary, /residual non-blocking debt: R1-F2 deferred/);
  assert.match(completionPacket.residualReviewDebtSummary, /Scope 1 R1-F2 \(deferred\)/);
  assert.doesNotMatch(completionPacket.residualReviewDebtSummary, /R1-F1/);
  assert.doesNotMatch(completionPacket.residualReviewDebtSummary, /R1-F3/);
});

test('execute adjudication context exposes meaningful-progress through the execute-review capability surface', async () => {
  const { state } = await createResumeFixture({
    phase: 'reviewer_scope',
    currentScopeNumber: 5,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Keep the execute-review contract explicit',
      newEvidence: 'Execute review now resolves meaningful-progress from the adjudication spec.',
      whyNotRedundant: 'This verifies the shared execute-review family still carries the gating capability.',
      nextStepUnlocked: 'Reviewer disposition can use the same adjudication family without a separate phase.',
    },
  });

  const context = resolveExecuteAdjudicationContext(state);
  assert.equal(context.spec.id, 'execute_review');
  assert.equal(context.meaningfulProgressCapability.promptSpecId, 'scope_reviewer');
  assert.equal(context.meaningfulProgressCapability.variantKind, 'meaningful_progress');
  assert.equal(context.meaningfulProgressCapability.exportName, 'buildReviewerPrompt');
});

test('execute transition assertions reject impossible live outcomes for the active execute-review spec', () => {
  const spec = getAdjudicationSpec('execute_review');

  assert.throws(
    () => assertAdjudicationTransitionSignal(spec, 'accept_complete', 'test:execute-boundary'),
    /test:execute-boundary resolved transition signal accept_complete for adjudication spec execute_review family execute_review/,
  );
});

test('execute review block reason names the parent objective for meaningful-progress operator guidance', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: null,
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'block_for_operator',
    meaningfulProgressRationale: 'The recent scopes are locally correct but no longer converging on the parent objective.',
    parentScopeLabel: '4',
  });

  assert.equal(
    reason,
    'meaningful_progress: reviewer requested operator guidance before accepting parent objective 4. ' +
      'The recent scopes are locally correct but no longer converging on the parent objective.',
  );
});

test('execute review block reason directs replace-plan cases into diagnosis-friendly recovery', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: null,
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'replace_plan',
    meaningfulProgressRationale: 'The current scope keeps revisiting the same hotspot and should be replaced.',
    parentScopeLabel: '4',
  });

  assert.match(
    reason ?? '',
    /meaningful_progress: reviewer requested replacing the current scope for parent objective 4 rather than retrying it\./,
  );
  assert.match(reason ?? '', /The current scope keeps revisiting the same hotspot and should be replaced\./);
  assert.match(reason ?? '', /One available next step: neal --diagnose/);
});

test('execute review block reason preserves convergence blockers ahead of meaningful-progress guidance', () => {
  const reason = getExecuteReviewBlockReason({
    cwd: process.cwd(),
    reopenedCanonical: 'C7',
    stalledBlockingCount: false,
    reachedMaxRounds: false,
    maxRounds: 3,
    meaningfulProgressAction: 'replace_plan',
    meaningfulProgressRationale: 'The scope shape is wrong.',
    parentScopeLabel: '2',
  });

  assert.equal(reason, 'review_stuck: blocking finding C7 reopened across multiple reviewer rounds');
});

test('execute scope progress payload parses and strips cleanly from split-plan responses', () => {
  const derivedPlan = [
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: Replace the current scope',
    '- Goal: Narrow the work.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The replacement scope is executable.',
  ].join('\n');
  const response = [
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
    JSON.stringify({
      milestoneTargeted: 'Add the execute-scope progress payload contract.',
      newEvidence: 'The parser and state wiring are implemented.',
      whyNotRedundant: 'This replaces the prior marker-only contract with parseable state.',
      nextStepUnlocked: 'Reviewer prompts can consume the persisted justification next.',
    }),
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
    '',
    derivedPlan,
    '',
    'AUTONOMY_SPLIT_PLAN',
  ].join('\n');

  assert.deepEqual(parseExecuteScopeProgressPayload(response), {
    milestoneTargeted: 'Add the execute-scope progress payload contract.',
    newEvidence: 'The parser and state wiring are implemented.',
    whyNotRedundant: 'This replaces the prior marker-only contract with parseable state.',
    nextStepUnlocked: 'Reviewer prompts can consume the persisted justification next.',
  });
  assert.equal(stripExecuteScopeProgressPayload(response), `${derivedPlan}\n\nAUTONOMY_SPLIT_PLAN`);
});

test('execute scope progress payload parser fails fast on missing required fields', () => {
  const malformed = [
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_START,
    JSON.stringify({
      milestoneTargeted: 'Carry structured justification.',
      newEvidence: '',
      whyNotRedundant: 'The old contract was freeform only.',
      nextStepUnlocked: 'Reviewer integration can use this next.',
    }),
    EXECUTE_SCOPE_PROGRESS_PAYLOAD_END,
    'AUTONOMY_SCOPE_DONE',
  ].join('\n');

  assert.throws(() => parseExecuteScopeProgressPayload(malformed), /empty or missing newEvidence field/);
});

test('final completion summary schema requires the whole-plan completion fields', () => {
  const schema = buildFinalCompletionSummarySchema();

  assert.deepEqual(schema.required, [
    'planGoalSatisfied',
    'whatChangedOverall',
    'verificationSummary',
    'remainingKnownGaps',
  ]);
  assert.equal(schema.properties.planGoalSatisfied.type, 'boolean');
  assert.equal(schema.properties.whatChangedOverall.type, 'string');
  assert.equal(schema.properties.verificationSummary.type, 'string');
  assert.equal(schema.properties.remainingKnownGaps.type, 'array');
});

test('final completion summary parser rejects contradictory completion claims', () => {
  assert.deepEqual(
    parseFinalCompletionSummaryPayload({
      planGoalSatisfied: false,
      whatChangedOverall: 'Added the whole-plan completion packet assembly helper.',
      verificationSummary: 'Ran targeted tests and typecheck.',
      remainingKnownGaps: ['Final completion review is not wired into the execute state machine yet.'],
    }),
    {
      planGoalSatisfied: false,
      whatChangedOverall: 'Added the whole-plan completion packet assembly helper.',
      verificationSummary: 'Ran targeted tests and typecheck.',
      remainingKnownGaps: ['Final completion review is not wired into the execute state machine yet.'],
    },
  );

  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: true,
        whatChangedOverall: 'Added final completion plumbing.',
        verificationSummary: 'Ran pnpm typecheck.',
        remainingKnownGaps: ['Still needs reviewer wiring.'],
      }),
    /planGoalSatisfied=true while remainingKnownGaps is non-empty/,
  );

  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: false,
        whatChangedOverall: 'Added final completion plumbing.',
        verificationSummary: 'Ran pnpm typecheck.',
        remainingKnownGaps: [],
      }),
    /planGoalSatisfied=false with an empty remainingKnownGaps array/,
  );

  assert.throws(
    () =>
      parseFinalCompletionSummaryPayload({
        planGoalSatisfied: false,
        whatChangedOverall: 'Added final completion plumbing.',
        verificationSummary: 'Ran pnpm typecheck.',
        remainingKnownGaps: ['  ', ''],
      }),
    /planGoalSatisfied=false with an empty remainingKnownGaps array/,
  );
});

test('final completion reviewer schema requires verdict action and missing-work contract', () => {
  const schema = buildFinalCompletionReviewerSchema();

  assert.deepEqual(schema.required, ['action', 'summary', 'rationale', 'missingWork']);
  assert.equal(schema.properties.action.type, 'string');
  assert.equal(schema.properties.summary.type, 'string');
  assert.equal(schema.properties.rationale.type, 'string');
  assert.deepEqual(schema.properties.missingWork.type, ['object', 'null']);
});

test('final completion reviewer parser enforces continue_execution missing-work rules', () => {
  assert.deepEqual(
    parseFinalCompletionReviewerPayload({
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork: {
        summary: 'Add the final completion reviewer transition.',
        requiredOutcome: 'Wire the reviewer verdict into the execute state machine before completion.',
        verification: 'Run orchestrator and review tests plus typecheck.',
      },
    }),
    {
      action: 'continue_execution',
      summary: 'One bounded follow-on scope is still required.',
      rationale: 'The completion packet still shows a missing execute-mode transition.',
      missingWork: {
        summary: 'Add the final completion reviewer transition.',
        requiredOutcome: 'Wire the reviewer verdict into the execute state machine before completion.',
        verification: 'Run orchestrator and review tests plus typecheck.',
      },
    },
  );

  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'continue_execution',
        summary: 'Need more work.',
        rationale: 'The plan is not complete yet.',
        missingWork: null,
      }),
    /missingWork payload when action=continue_execution/,
  );

  assert.throws(
    () =>
      parseFinalCompletionReviewerPayload({
        action: 'accept_complete',
        summary: 'The plan is complete.',
        rationale: 'The reviewer accepted the whole-plan result.',
        missingWork: {
          summary: 'should not be here',
          requiredOutcome: 'n/a',
          verification: 'n/a',
        },
      }),
    /cannot include missingWork when action=accept_complete/,
  );
});

test('state round-trip preserves current execute-scope progress justification', async () => {
  const justification: ExecuteScopeProgressJustification = {
    milestoneTargeted: 'Scope 2 payload contract',
    newEvidence: 'The response now carries parseable JSON.',
    whyNotRedundant: 'The marker alone cannot support the progress gate.',
    nextStepUnlocked: 'Scope 3 can pass reviewer context deterministically.',
  };
  const { cwd, statePath } = await createResumeFixture({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    currentScopeProgressJustification: justification,
  });

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.cwd, cwd);
  assert.deepEqual(reloadedState.currentScopeProgressJustification, justification);
});

test('state round-trip preserves the final completion summary', async () => {
  const { cwd, statePath } = await createResumeFixture({
    phase: 'done',
    status: 'done',
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the packet plumbing but not the reviewer gate.',
      verificationSummary: 'Ran review and orchestrator tests.',
      remainingKnownGaps: ['Reviewer final-completion verdict is not wired yet.'],
    },
  });

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.cwd, cwd);
  assert.deepEqual(reloadedState.finalCompletionSummary, {
    planGoalSatisfied: false,
    whatChangedOverall: 'Implemented the packet plumbing but not the reviewer gate.',
    verificationSummary: 'Ran review and orchestrator tests.',
    remainingKnownGaps: ['Reviewer final-completion verdict is not wired yet.'],
  });
});

test('state round-trip preserves final completion recovery metadata', async () => {
  const { statePath } = await createResumeFixture({
    phase: 'blocked',
    status: 'blocked',
    blockedFromPhase: 'final_completion_review',
    finalCompletionReviewVerdict: {
      action: 'continue_execution',
      summary: 'One more follow-on scope was requested.',
      rationale: 'The plan is close, but one execution repair remains.',
      missingWork: {
        summary: 'Add the missing final-completion branch.',
        requiredOutcome: 'Wire the remaining reviewer decision into execute-mode completion.',
        verification: 'Run orchestrator and review tests plus typecheck.',
      },
    },
    finalCompletionResolvedAction: 'block_for_operator',
    finalCompletionContinueExecutionCount: 2,
    finalCompletionContinueExecutionCapReached: true,
  });

  const reloadedState = await loadState(statePath);
  assert.equal(reloadedState.finalCompletionResolvedAction, 'block_for_operator');
  assert.equal(reloadedState.finalCompletionContinueExecutionCount, 2);
  assert.equal(reloadedState.finalCompletionContinueExecutionCapReached, true);
  assert.equal(reloadedState.finalCompletionReviewVerdict?.action, 'continue_execution');
  assert.equal(reloadedState.finalCompletionReviewVerdict?.missingWork?.summary, 'Add the missing final-completion branch.');
});

test('state round-trip preserves current reviewer meaningful-progress verdict', async () => {
  const verdict: ReviewerMeaningfulProgressVerdict = {
    action: 'replace_plan',
    rationale: 'Recent accepted scopes keep returning to src/shared.ts without moving the parent objective forward.',
  };
  const { statePath } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'blocked',
    status: 'blocked',
    currentScopeMeaningfulProgressVerdict: verdict,
  });

  const reloadedState = await loadState(statePath);
  assert.deepEqual(reloadedState.currentScopeMeaningfulProgressVerdict, verdict);
});
