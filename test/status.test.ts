import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { parseStatusArgs } from '../src/neal/cli.js';
import {
  createPlanAndExecuteQueue,
  getCurrentPlanAndExecuteQueuePointerPath,
  getPlanAndExecuteQueueSummaryPath,
  getPlanAndExecuteQueueStatePath,
  savePlanAndExecuteQueueState,
  toQueueStoredPath,
  writeQueueChildLink,
} from '../src/neal/plan-queue.js';
import { getCurrentRunPointerPath } from '../src/neal/run-registry.js';
import { createRunLogger } from '../src/neal/logger.js';
import {
  buildStatusListSnapshot,
  buildStatusSnapshot,
  formatPublicPhase,
  formatStatusNextActionForState,
  renderHumanStatusListSnapshot,
  renderHumanStatusSnapshot,
} from '../src/neal/status.js';
import { acquireActiveRunLock, getActiveRunLockPath } from '../src/neal/run-lock.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, saveState } from '../src/neal/state.js';
import type { OrchestrationState, ReviewFinding } from '../src/neal/types.js';
import { getAppVersion } from '../src/neal/version.js';
import { nealCliInvocation, normalizeCliStderr } from './helpers/cli.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

process.env.HOME = join(tmpdir(), 'neal-test-home-status');

async function createStatusFixture(args: {
  phase?: OrchestrationState['phase'];
  status?: OrchestrationState['status'];
  now?: Date;
  cwd?: string;
  runId?: string;
  planName?: string;
  mutate?: (state: OrchestrationState) => OrchestrationState;
}) {
  const cwd = args.cwd ?? (await mkdtemp(join(tmpdir(), 'neal-status-project-')));
  const stateDir = join(cwd, '.neal');
  const runId = args.runId ?? '2026-04-25T18-00-00.000Z-test';
  const runDir = join(stateDir, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, args.planName ?? 'PLAN.md');
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

  const phase = args.phase ?? initialState.phase;
  const status = args.status ?? (phase === 'done' ? 'done' : phase === 'blocked' ? 'blocked' : initialState.status);
  const state = args.mutate?.({
    ...initialState,
    phase,
    status,
    executionShape: 'multi_scope',
    updatedAt: args.now?.toISOString() ?? initialState.updatedAt,
  }) ?? {
    ...initialState,
    phase,
    status,
    executionShape: 'multi_scope',
    updatedAt: args.now?.toISOString() ?? initialState.updatedAt,
  };

  const statePath = getRunStatePath(runDir);
  await saveState(statePath, state);

  return {
    cwd,
    runDir,
    planDoc,
    statePath,
    eventsPath: join(runDir, 'events.ndjson'),
  };
}

function event(ts: string, type: string, data: Record<string, unknown> = {}) {
  return JSON.stringify({ ts, type, data });
}

async function writeEvents(path: string, lines: string[]) {
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
}

function minutesBefore(now: Date, minutes: number) {
  return new Date(now.getTime() - minutes * 60 * 1000).toISOString();
}

function secondsBefore(now: Date, seconds: number) {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

function runIdForFixture(fixture: { runDir: string }) {
  return basename(fixture.runDir);
}

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createGitRepoFixture() {
  const root = await mkdtemp(join(tmpdir(), 'neal-status-git-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'base\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');
  return {
    cwd,
    baseCommit: await runGit(cwd, 'rev-parse', 'HEAD'),
  };
}

async function createGitCommit(cwd: string, filename: string, content: string, message: string) {
  await writeFile(join(cwd, filename), content, 'utf8');
  await runGit(cwd, 'add', filename);
  await runGit(cwd, 'commit', '-m', message);
  return runGit(cwd, 'rev-parse', 'HEAD');
}

async function rewriteRunState(
  fixture: { runDir: string },
  mutate: (state: OrchestrationState) => OrchestrationState,
) {
  const statePath = join(fixture.runDir, 'RUN_STATE.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as OrchestrationState;
  await writeFile(statePath, JSON.stringify(mutate(state), null, 2) + '\n', 'utf8');
}

function finding(status: ReviewFinding['status'], severity: ReviewFinding['severity']): ReviewFinding {
  return {
    id: `${status}-${severity}`,
    canonicalId: `${status}-${severity}`,
    round: 1,
    source: 'reviewer',
    severity,
    files: [],
    claim: 'claim',
    evidence: null,
    requiredAction: 'fix it',
    status,
    roundSummary: 'summary',
    coderDisposition: null,
    coderCommit: null,
  };
}

function acceptedTerminalScope(args: {
  number: string;
  baseCommit: string | null;
  finalCommit: string;
}): OrchestrationState['completedScopes'][number] {
  return {
    number: args.number,
    marker: 'AUTONOMY_DONE',
    result: 'accepted',
    baseCommit: args.baseCommit,
    finalCommit: args.finalCommit,
    summary: 'Completed the terminal scope.',
    commitSubject: 'finish plan',
    changedFiles: ['src/final.ts'],
    reviewRounds: 1,
    findings: 0,
    residualReviewDebt: [],
    archivedReviewPath: null,
    blocker: null,
    derivedFromParentScope: null,
    replacedByDerivedPlanPath: null,
  };
}

function scopeAccountingGuardrailState(): Partial<OrchestrationState> {
  const unsafeReason =
    'Unsafe advance_parent for parent objective 4 cannot proceed; failed preconditions: ' +
    'accepted derived plan is not actively executing; parent objective has no prior substantive accepted derived sub-scope. ' +
    'Reviewer rationale: prior accepted benchmark work satisfies scope 4.';

  return {
    status: 'running',
    phase: 'interactive_blocked_recovery',
    currentScopeNumber: 4,
    executionShape: 'multi_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-07T15:41:51.055Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: unsafeReason,
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'block_for_operator',
      rationale: unsafeReason,
    },
    currentScopeProgressJustification: {
      milestoneTargeted: 'Scope 4 blocker guidance fixture',
      newEvidence: 'Focused verification and `pnpm typecheck` passed with an empty current diff.',
      whyNotRedundant: 'Prior accepted benchmark-mode work under parent scope 2 satisfies this objective.',
      nextStepUnlocked: 'The operator can decide whether to accept the already-satisfied scope or verify it directly.',
    },
    rounds: [
      {
        round: 2,
        reviewerSessionHandle: 'reviewer-session',
        reviewedPlanPath: null,
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: {
          base: 'base-commit',
          head: 'head-commit',
        },
        openBlockingCanonicalCount: 0,
        findings: [],
      },
    ],
    findings: [],
    completedScopes: [
      {
        number: '2.1',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-2-1',
        finalCommit: 'final-2-1',
        summary: 'Implemented benchmark mode.',
        commitSubject: 'add benchmark mode',
        changedFiles: ['benchmark/lib/neal.ts'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-2.1.md',
        blocker: null,
        derivedFromParentScope: '2',
        replacedByDerivedPlanPath: null,
      },
    ],
  };
}

async function createFinalCompletionReviewFixture(args: {
  now: Date;
  runId?: string;
  label?: string | null;
  outputAgeMinutes?: number;
  phaseStartAgeMinutes?: number;
}) {
  const finalCommit = '1111111111111111111111111111111111111111';
  const fixture = await createStatusFixture({
    now: args.now,
    runId: args.runId,
    phase: 'final_completion_review',
    status: 'running',
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 5,
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCommit,
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Completed all requested implementation scopes.',
        verificationSummary: 'Required verification passed.',
        remainingKnownGaps: [],
      },
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      completedScopes: [
        acceptedTerminalScope({
          number: '5',
          baseCommit: state.baseCommit,
          finalCommit,
        }),
      ],
    }),
  });
  const lines = [
    event(minutesBefore(args.now, args.phaseStartAgeMinutes ?? 10), 'phase.start', {
      phase: 'final_completion_review',
    }),
  ];
  if (args.label !== null) {
    lines.push(
      event(minutesBefore(args.now, args.outputAgeMinutes ?? 7), 'provider.structured_output_received', {
        provider: 'anthropic-claude',
        role: 'structured-advisor',
        label: args.label ?? 'final-completion',
      }),
    );
  }
  await writeEvents(fixture.eventsPath, lines);
  return fixture;
}

test('buildStatusSnapshot reports healthy recent coder activity and artifacts', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 4,
      coderSessionHandle: 'coder-session',
      reviewerSessionHandle: 'reviewer-session',
      createdCommits: ['commit-one'],
      completedScopes: [
        {
          number: '1',
          marker: 'AUTONOMY_SCOPE_DONE',
          result: 'accepted',
          baseCommit: 'base',
          finalCommit: 'commit-one',
          summary: null,
          commitSubject: 'scope one',
          changedFiles: [],
          reviewRounds: 1,
          findings: 0,
          residualReviewDebt: [],
          archivedReviewPath: null,
          blocker: null,
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
      findings: [
        finding('open', 'blocking'),
        finding('open', 'non_blocking'),
        finding('fixed', 'blocking'),
        finding('rejected', 'blocking'),
        finding('deferred', 'non_blocking'),
      ],
    }),
  });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 1), 'phase.start', { phase: 'coder_scope' }),
    event(secondsBefore(now, 30), 'coder.command_execution', { command: 'pnpm typecheck' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'ok');
  assert.equal(snapshot.lastCoderEventAt, secondsBefore(now, 30));
  assert.equal(snapshot.lastMeaningfulEvent?.summary, 'pnpm typecheck');
  assert.equal(snapshot.artifacts.eventsPath, fixture.eventsPath);
  assert.equal(snapshot.artifacts.runStatePath, join(fixture.runDir, 'RUN_STATE.json'));
  assert.equal(snapshot.artifacts.runNarrativeMarkdownPath, join(fixture.runDir, 'RUN_NARRATIVE.md'));
  assert.equal(snapshot.artifacts.latestRetrospectiveMarkdownPath, null);
  assert.equal(snapshot.artifacts.queueSummaryMarkdownPath, null);
  assert.equal('queue' in snapshot, false);
  assert.equal(snapshot.derivedPlan, null);
  assert.equal(snapshot.createdCommits, 1);
  assert.equal(snapshot.completedScopes, 1);
  assert.deepEqual(snapshot.findings, {
    total: 5,
    openBlocking: 1,
    openNonBlocking: 1,
    fixed: 1,
    rejected: 1,
    deferred: 1,
  });
});

test('buildStatusSnapshot exposes harness fields and default patch eligibility for completed runs', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const repo = await createGitRepoFixture();
  const finalCommit = await createGitCommit(repo.cwd, 'feature.txt', 'feature\n', 'feature commit');
  const fixture = await createStatusFixture({
    cwd: repo.cwd,
    now,
    phase: 'done',
    status: 'done',
    mutate: (state) => ({
      ...state,
      initialBaseCommit: repo.baseCommit,
      baseCommit: repo.baseCommit,
      finalCommit,
      createdCommits: [finalCommit],
      completedScopes: [
        {
          number: '1',
          marker: 'AUTONOMY_SCOPE_DONE',
          result: 'accepted',
          baseCommit: repo.baseCommit,
          finalCommit,
          summary: null,
          commitSubject: 'feature commit',
          changedFiles: ['feature.txt'],
          reviewRounds: 1,
          findings: 0,
          residualReviewDebt: [],
          archivedReviewPath: null,
          blocker: null,
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const list = await buildStatusListSnapshot({ cwd: fixture.cwd, now });

  assert.equal(snapshot.runId, runIdForFixture(fixture));
  assert.equal(snapshot.publicStatus, 'done');
  assert.equal(snapshot.publicPhase, 'done');
  assert.match(snapshot.nextAction, /No resume needed/);
  assert.deepEqual(snapshot.commits, {
    initialBaseCommit: repo.baseCommit,
    baseCommit: repo.baseCommit,
    finalCommit,
    createdCommitCount: 1,
    acceptedScopeFinalCommits: [finalCommit],
  });
  assert.equal(snapshot.squash.status, 'missing');
  assert.equal(snapshot.providerError, null);
  assert.equal(snapshot.patch.defaultSubmissionEligible, true);
  assert.equal(snapshot.patch.source, 'final_commit');
  assert.equal(snapshot.patch.baseCommit, repo.baseCommit);
  assert.equal(snapshot.patch.headCommit, finalCommit);
  assert.equal(snapshot.patch.range, `${repo.baseCommit}..${finalCommit}`);
  assert.equal(snapshot.patch.commitCount, 1);
  assert.equal(snapshot.patch.changedFileCount, 1);
  assert.deepEqual(snapshot.patch.changedFiles, ['feature.txt']);
  assert.equal(snapshot.patch.unavailableReason, null);
  assert.equal(snapshot.build.source, 'live_fallback');
  assert.equal(snapshot.build.packageVersion, getAppVersion());
  assert.equal(snapshot.build.nodeVersion, process.version);
  assert.deepEqual(snapshot.build.agentConfig, getDefaultAgentConfig(repo.cwd));
  assert.equal(list.runs[0].runId, snapshot.runId);
  assert.deepEqual(list.runs[0].commits, snapshot.commits);
  assert.deepEqual(list.runs[0].squash, snapshot.squash);
  assert.deepEqual(list.runs[0].patch, snapshot.patch);
  assert.deepEqual(list.runs[0].build, snapshot.build);
});

test('buildStatusSnapshot keeps failed, blocked, empty, and unreadable patch ranges out of default submission', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const repo = await createGitRepoFixture();
  const finalCommit = await createGitCommit(repo.cwd, 'feature.txt', 'feature\n', 'feature commit');
  const failedFinalization = await createStatusFixture({
    cwd: repo.cwd,
    now,
    phase: 'execute_finalization',
    status: 'failed',
    mutate: (state) => ({
      ...state,
      initialBaseCommit: repo.baseCommit,
      baseCommit: repo.baseCommit,
      finalCommit,
      createdCommits: [finalCommit],
    }),
  });
  const blocked = await createStatusFixture({
    cwd: repo.cwd,
    now,
    runId: '2026-04-25T18-01-00.000Z-blocked',
    phase: 'blocked',
    status: 'blocked',
    mutate: (state) => ({
      ...state,
      initialBaseCommit: repo.baseCommit,
      baseCommit: repo.baseCommit,
      finalCommit,
      createdCommits: [finalCommit],
    }),
  });
  const emptyPatch = await createStatusFixture({
    cwd: repo.cwd,
    now,
    runId: '2026-04-25T18-02-00.000Z-empty',
    phase: 'done',
    status: 'done',
    mutate: (state) => ({
      ...state,
      initialBaseCommit: repo.baseCommit,
      baseCommit: repo.baseCommit,
      finalCommit: repo.baseCommit,
      createdCommits: [],
    }),
  });
  const unreadableRange = await createStatusFixture({
    now,
    phase: 'done',
    status: 'done',
    mutate: (state) => ({
      ...state,
      finalCommit: 'missing-head',
      createdCommits: ['missing-head'],
    }),
  });

  const failedSnapshot = await buildStatusSnapshot({ cwd: failedFinalization.cwd, statePath: failedFinalization.statePath, now });
  const blockedSnapshot = await buildStatusSnapshot({ cwd: blocked.cwd, statePath: blocked.statePath, now });
  const emptySnapshot = await buildStatusSnapshot({ cwd: emptyPatch.cwd, statePath: emptyPatch.statePath, now });
  const unreadableSnapshot = await buildStatusSnapshot({ cwd: unreadableRange.cwd, statePath: unreadableRange.statePath, now });

  assert.equal(failedSnapshot.patch.defaultSubmissionEligible, false);
  assert.match(failedSnapshot.patch.reason, /failed/);
  assert.equal(failedSnapshot.patch.changedFileCount, 1);
  assert.equal(blockedSnapshot.patch.defaultSubmissionEligible, false);
  assert.match(blockedSnapshot.patch.reason, /blocked/);
  assert.equal(blockedSnapshot.patch.changedFileCount, 1);
  assert.equal(emptySnapshot.patch.defaultSubmissionEligible, false);
  assert.match(emptySnapshot.patch.reason, /empty patch range/);
  assert.equal(emptySnapshot.patch.commitCount, 0);
  assert.equal(emptySnapshot.patch.changedFileCount, 0);
  assert.equal(unreadableSnapshot.patch.defaultSubmissionEligible, false);
  assert.match(unreadableSnapshot.patch.reason, /Patch range is unavailable/);
  assert.ok(unreadableSnapshot.patch.unavailableReason);
});

test('buildStatusSnapshot summarizes provider and unclassified phase errors without raw event payloads', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    status: 'failed',
  });
  const longMessage = `${'capacity '.repeat(200)}selected model is at capacity`;
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 2), 'phase.error', {
      phase: 'coder_scope',
      sessionHandle: 'phase-session',
      message: 'phase failed after provider error',
    }),
    event(secondsBefore(now, 30), 'provider.provider_error', {
      provider: 'openai-codex',
      role: 'coder',
      label: 'scope',
      sessionHandle: 'coder-session',
      errorKind: 'api_error',
      retryable: true,
      message: longMessage,
      providerData: {
        raw: 'do not expose this provider payload',
        diagnostic: {
          message: 'Failed to process successful response',
          responseBody: '{"choices":[]}',
          cause: {
            message: 'Invalid JSON response',
          },
        },
      },
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const serialized = JSON.stringify(snapshot.providerError);

  assert.equal(snapshot.providerError?.source, 'provider_event');
  assert.equal(snapshot.providerError?.provider, 'openai-codex');
  assert.equal(snapshot.providerError?.role, 'coder');
  assert.equal(snapshot.providerError?.label, 'scope');
  assert.equal(snapshot.providerError?.sessionHandle, 'coder-session');
  assert.equal(snapshot.providerError?.kind, 'api_error');
  assert.equal(snapshot.providerError?.retryable, true);
  assert.ok((snapshot.providerError?.message.length ?? 0) <= 1000);
  assert.deepEqual(snapshot.providerError?.diagnostic, {
    message: 'Failed to process successful response',
    responseBody: '{"choices":[]}',
    cause: {
      message: 'Invalid JSON response',
    },
  });
  assert.doesNotMatch(serialized, /providerData|do not expose/);

  const phaseOnly = await createStatusFixture({
    now,
    status: 'failed',
    runId: '2026-04-25T18-01-00.000Z-phase-only',
  });
  await writeEvents(phaseOnly.eventsPath, [
    event(secondsBefore(now, 30), 'phase.error', {
      phase: 'execute_finalization',
      sessionHandle: 'final-session',
      message: 'finalization failed',
    }),
  ]);
  const phaseSnapshot = await buildStatusSnapshot({ cwd: phaseOnly.cwd, statePath: phaseOnly.statePath, now });
  assert.deepEqual(phaseSnapshot.providerError, {
    source: 'phase_error',
    timestamp: secondsBefore(now, 30),
    provider: null,
    role: null,
    label: 'finalizing accepted scope',
    sessionHandle: 'final-session',
    kind: null,
    message: 'finalization failed',
    retryable: null,
    diagnostic: null,
  });
});

test('buildStatusSnapshot preserves the content_refused provider-error kind instead of degrading it to null', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    status: 'blocked',
    phase: 'blocked',
  });
  await writeEvents(fixture.eventsPath, [
    event(secondsBefore(now, 30), 'provider.provider_error', {
      provider: 'openai-compatible',
      role: 'structured-advisor',
      label: 'review',
      sessionHandle: 'reviewer-session',
      errorKind: 'content_refused',
      retryable: false,
      message: 'OpenAI-compatible review request was refused on content-safety grounds.',
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  assert.equal(snapshot.providerError?.source, 'provider_event');
  assert.equal(snapshot.providerError?.kind, 'content_refused');
  assert.equal(snapshot.providerError?.retryable, false);
});

test('buildStatusSnapshot reads persisted build metadata and RunLogger preserves it on resume', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  const persistedBuild = {
    packageVersion: '9.9.9-test',
    nodeVersion: 'v99.0.0',
    sourceGitSha: 'abc123',
  };
  await writeFile(
    join(fixture.runDir, 'meta.json'),
    JSON.stringify({ version: 1, build: persistedBuild }, null, 2) + '\n',
    'utf8',
  );

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.deepEqual(snapshot.build, {
    ...persistedBuild,
    source: 'meta',
    agentConfig: getDefaultAgentConfig(fixture.cwd),
  });

  const loggerRunDir = join(fixture.cwd, '.neal', 'runs', 'logger-run');
  const logger = await createRunLogger({
    cwd: fixture.cwd,
    stateDir: join(fixture.cwd, '.neal'),
    planDoc: fixture.planDoc,
    topLevelMode: 'execute',
    runDir: loggerRunDir,
  });
  const firstMeta = JSON.parse(await readFile(join(logger.runDir, 'meta.json'), 'utf8')) as {
    createdAt: string;
    build: unknown;
  };
  await createRunLogger({
    cwd: fixture.cwd,
    stateDir: join(fixture.cwd, '.neal'),
    planDoc: fixture.planDoc,
    topLevelMode: 'execute',
    runDir: loggerRunDir,
    resumedFromStatePath: join(loggerRunDir, 'RUN_STATE.json'),
  });
  const resumedMeta = JSON.parse(await readFile(join(logger.runDir, 'meta.json'), 'utf8')) as {
    createdAt: string;
    build: unknown;
    resumes: { resumedFromStatePath: string; build: unknown }[];
  };
  assert.equal(resumedMeta.createdAt, firstMeta.createdAt);
  assert.deepEqual(resumedMeta.build, firstMeta.build);
  assert.equal(resumedMeta.resumes.length, 1);
  assert.equal(resumedMeta.resumes[0]?.resumedFromStatePath, join(loggerRunDir, 'RUN_STATE.json'));
  assert.deepEqual(resumedMeta.resumes[0]?.build, firstMeta.build);
});

test('buildStatusSnapshot classifies normalized provider events by role', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 1), 'phase.start', { phase: 'coder_scope' }),
    event(secondsBefore(now, 45), 'provider.assistant_text', {
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review',
      text: 'Reviewer inspected the implementation.',
    }),
    event(secondsBefore(now, 30), 'provider.command_completed', {
      provider: 'openai-codex',
      role: 'coder',
      command: 'pnpm typecheck',
      status: 'completed',
      exitCode: 0,
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'ok');
  assert.equal(snapshot.lastMeaningfulEventAt, secondsBefore(now, 30));
  assert.equal(snapshot.lastMeaningfulEvent?.type, 'provider.command_completed');
  assert.equal(snapshot.lastMeaningfulEvent?.summary, 'pnpm typecheck');
  assert.equal(snapshot.lastCoderEventAt, secondsBefore(now, 30));
  assert.equal(snapshot.lastReviewerEventAt, secondsBefore(now, 45));
});

test('buildStatusSnapshot counts turn liveness events as meaningful activity', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 10), 'phase.start', { phase: 'coder_scope' }),
    event(secondsBefore(now, 45), 'provider.turn_liveness_timeout', {
      provider: 'openai-codex',
      role: 'coder',
      attempt: 1,
      startupTimeoutMs: 300_000,
      meaningfulProgress: false,
    }),
    event(secondsBefore(now, 30), 'provider.turn_liveness_retry', {
      provider: 'openai-codex',
      role: 'coder',
      attempt: 1,
      nextAttempt: 2,
      startupTimeoutMs: 300_000,
      meaningfulProgress: false,
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'ok');
  assert.equal(snapshot.lastMeaningfulEventAt, secondsBefore(now, 30));
  assert.equal(snapshot.lastMeaningfulEvent?.type, 'provider.turn_liveness_retry');
  assert.equal(snapshot.lastCoderEventAt, secondsBefore(now, 30));
});

test('buildStatusSnapshot counts turn liveness give-up as meaningful activity', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 10), 'phase.start', { phase: 'review' }),
    event(secondsBefore(now, 20), 'provider.turn_liveness_give_up', {
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'review',
      attempt: 2,
      startupTimeoutMs: 300_000,
      meaningfulProgress: false,
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'ok');
  assert.equal(snapshot.lastMeaningfulEventAt, secondsBefore(now, 20));
  assert.equal(snapshot.lastMeaningfulEvent?.type, 'provider.turn_liveness_give_up');
  assert.equal(snapshot.lastReviewerEventAt, secondsBefore(now, 20));
});

test('buildStatusSnapshot exposes replacement artifact paths for run summaries', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  const narrativePath = join(fixture.runDir, 'RUN_NARRATIVE.md');
  const olderRetrospectivePath = join(fixture.runDir, 'RETROSPECTIVE-scope-1-old.md');
  const latestRetrospectivePath = join(fixture.runDir, 'RETROSPECTIVE-scope-2-new.md');
  await writeFile(narrativePath, '# Run Narrative\n', 'utf8');
  await writeFile(olderRetrospectivePath, '# Old Retrospective\n', 'utf8');
  await writeFile(latestRetrospectivePath, '# Latest Retrospective\n', 'utf8');

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);

  assert.equal(snapshot.artifacts.runNarrativeMarkdownPath, narrativePath);
  assert.equal(snapshot.artifacts.latestRetrospectiveMarkdownPath, latestRetrospectivePath);
  assert.ok(output.includes(`- Run narrative: ${narrativePath}`));
  assert.ok(output.includes(`- Latest retrospective: ${latestRetrospectivePath}`));
});

test('buildStatusSnapshot and human render surface combined plan-review debt after reload', async () => {
  const now = new Date('2026-04-25T18:10:00.000Z');
  const fixture = await createStatusFixture({
    phase: 'reviewer_plan',
    now,
    mutate: (state) => ({
      ...state,
      topLevelMode: 'plan',
      planReviewDebt: [
        {
          id: 'R3-F1',
          canonicalId: 'C3',
          status: 'deferred',
          files: ['PLAN.md'],
          claim: 'Current-negotiation debt.',
          evidence: '',
          requiredAction: 'Add an oracle.',
          coderDisposition: null,
          coderCommit: null,
          findingClass: 'verification_hardening',
          originRound: 3,
        },
      ],
      inheritedPlanReviewDebt: [
        {
          id: 'R4-F2',
          canonicalId: 'C9',
          status: 'deferred',
          files: ['PLAN.md'],
          claim: 'Inherited debt.',
          evidence: '',
          requiredAction: 'Add a provenance assertion.',
          coderDisposition: null,
          coderCommit: null,
          findingClass: 'verification_hardening',
          originRound: 4,
        },
      ],
    }),
  });

  // buildStatusSnapshot reloads RUN_STATE.json via loadState, so this also
  // exercises the debt-array hydration round-trip.
  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  assert.equal(snapshot.planReviewDebt.total, 2);
  assert.deepStrictEqual(snapshot.planReviewDebt.items, [
    { canonicalId: 'C9', findingClass: 'verification_hardening', originRound: 4, inherited: true },
    { canonicalId: 'C3', findingClass: 'verification_hardening', originRound: 3, inherited: false },
  ]);

  const human = renderHumanStatusSnapshot(snapshot);
  assert.match(human, /- Plan review debt: 2 \(rounds 3, 4\)/);
});

test('buildStatusSnapshot exposes derived-plan review, adoption, execution, and abandonment state', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const cases: {
    name: string;
    phase: OrchestrationState['phase'];
    status?: OrchestrationState['status'];
    derivedPlanStatus: NonNullable<OrchestrationState['derivedPlanStatus']>;
    derivedScopeIndex: number | null;
    expected: Pick<
      NonNullable<Awaited<ReturnType<typeof buildStatusSnapshot>>['derivedPlan']>,
      'reviewActive' | 'acceptedAwaitingExecution' | 'executing' | 'abandoned'
    >;
  }[] = [
    {
      name: 'pending review',
      phase: 'reviewer_plan',
      derivedPlanStatus: 'pending_review',
      derivedScopeIndex: null,
      expected: {
        reviewActive: true,
        acceptedAwaitingExecution: false,
        executing: false,
        abandoned: false,
      },
    },
    {
      name: 'accepted awaiting execution',
      phase: 'awaiting_derived_plan_execution',
      derivedPlanStatus: 'accepted',
      derivedScopeIndex: null,
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: true,
        executing: false,
        abandoned: false,
      },
    },
    {
      name: 'active derived execution',
      phase: 'coder_scope',
      derivedPlanStatus: 'accepted',
      derivedScopeIndex: 2,
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: false,
        executing: true,
        abandoned: false,
      },
    },
    {
      name: 'abandoned rejected plan',
      phase: 'blocked',
      status: 'blocked',
      derivedPlanStatus: 'rejected',
      derivedScopeIndex: null,
      expected: {
        reviewActive: false,
        acceptedAwaitingExecution: false,
        executing: false,
        abandoned: true,
      },
    },
  ];

  for (const item of cases) {
    const fixture = await createStatusFixture({
      now,
      phase: item.phase,
      status: item.status,
      mutate: (state) => ({
        ...state,
        derivedPlanPath: join(state.runDir, 'DERIVED_PLAN_SCOPE_4.md'),
        derivedFromScopeNumber: 4,
        derivedPlanStatus: item.derivedPlanStatus,
        derivedScopeIndex: item.derivedScopeIndex,
      }),
    });

    const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

    assert.deepEqual(
      snapshot.derivedPlan,
      {
        path: join(fixture.runDir, 'DERIVED_PLAN_SCOPE_4.md'),
        parentScopeNumber: 4,
        status: item.derivedPlanStatus,
        scopeIndex: item.derivedScopeIndex,
        ...item.expected,
      },
      item.name,
    );
  }
});

test('buildStatusSnapshot reports linked plan-and-execute queue metadata', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  const runId = basename(fixture.runDir);
  const queue = await createPlanAndExecuteQueue({
    cwd: fixture.cwd,
    planDocs: ['PLAN.md'],
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(fixture.cwd, queue.queueId);
  await savePlanAndExecuteQueueState({
    ...queue,
    items: [
      {
        ...queue.items[0],
        status: 'executing',
        planningRunId: 'planning-run',
        planningStatePath: '.neal/runs/planning-run/RUN_STATE.json',
        acceptedPlanPath: 'PLAN.md',
        executionRunId: runId,
        executionStatePath: toQueueStoredPath(fixture.cwd, join(fixture.runDir, 'RUN_STATE.json')),
        activeStage: 'execution',
        startedAt: now.toISOString(),
      },
    ],
  });
  await writeQueueChildLink({
    runDir: fixture.runDir,
    queueId: queue.queueId,
    queueStatePath: toQueueStoredPath(fixture.cwd, queueStatePath),
    itemIndex: 0,
    stage: 'execution',
    createdAt: now.toISOString(),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const queueSummaryPath = getPlanAndExecuteQueueSummaryPath(fixture.cwd, queue.queueId);

  assert.deepEqual(snapshot.queue, {
    queueId: queue.queueId,
    queueStatePath,
    itemIndex: 0,
    itemCount: 1,
    stage: 'execution',
    queueStatus: 'running',
    itemStatus: 'executing',
    requestedPlanPath: 'PLAN.md',
  });
  assert.equal(snapshot.artifacts.queueSummaryMarkdownPath, queueSummaryPath);

  const output = renderHumanStatusSnapshot(snapshot);
  assert.match(output, /- Queue: /);
  assert.match(output, /item 1\/1 execution; queue running, item executing/);
  assert.match(output, /- Queue plan: PLAN\.md/);
  assert.ok(output.includes(`- Queue summary: ${queueSummaryPath}`));
});

test('buildStatusSnapshot recommends resuming linked failed queue children by run id', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'coder_scope',
    status: 'failed',
  });
  const runId = basename(fixture.runDir);
  const queue = await createPlanAndExecuteQueue({
    cwd: fixture.cwd,
    planDocs: ['PLAN.md'],
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(fixture.cwd, queue.queueId);
  await savePlanAndExecuteQueueState({
    ...queue,
    status: 'failed',
    stopReason: 'execution child failed',
    items: [
      {
        ...queue.items[0],
        status: 'failed',
        planningRunId: 'planning-run',
        planningStatePath: '.neal/runs/planning-run/RUN_STATE.json',
        acceptedPlanPath: 'PLAN.md',
        executionRunId: runId,
        executionStatePath: toQueueStoredPath(fixture.cwd, fixture.statePath),
        activeStage: 'execution',
        startedAt: now.toISOString(),
        stopReason: 'execution child failed',
      },
    ],
  });
  await writeQueueChildLink({
    runDir: fixture.runDir,
    queueId: queue.queueId,
    queueStatePath: toQueueStoredPath(fixture.cwd, queueStatePath),
    itemIndex: 0,
    stage: 'execution',
    createdAt: now.toISOString(),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);

  assert.equal(snapshot.resumeDecision.kind, 'continue');
  assert.match(output, /item 1\/1 execution; queue failed, item failed/);
  assert.ok(output.includes(`Resume this run: neal resume --run ${runId}`));
});

test('formatPublicPhase maps manual gate phase to waiting wording', () => {
  assert.equal(formatPublicPhase('manual_gate'), 'waiting for manual gate');
});

test('buildStatusSnapshot surfaces the interactive recovery blocked reason', async () => {
  const now = new Date('2026-04-25T18:30:00.000Z');
  const fixture = await createStatusFixture({
    phase: 'interactive_blocked_recovery',
    now,
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        enteredAt: now.toISOString(),
        sourcePhase: 'coder_scope',
        blockedReason: 'Fallback interactive recovery reason.',
        maxTurns: 3,
        lastHandledTurn: 0,
        turns: [],
        pendingDirective: null,
      },
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  assert.equal(snapshot.blocker.reason, 'Fallback interactive recovery reason.');
});

test('buildStatusSnapshot surfaces the coder-authored plan-stage blocker reason as the top-priority source', async () => {
  const now = new Date('2026-04-25T18:30:00.000Z');
  const blocker = 'Need an operator decision on the shared retry-budget owner.';
  const fixture = await createStatusFixture({
    phase: 'blocked',
    status: 'blocked',
    now,
    mutate: (state) => ({
      ...state,
      topLevelMode: 'plan',
      blockedFromPhase: 'coder_plan_response',
      blockerReason: blocker,
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  assert.equal(snapshot.blocker.active, true);
  assert.equal(snapshot.blocker.reason, blocker);
  assert.equal(snapshot.blocker.source, 'RUN_STATE.json blocker reason');

  // The coder-authored response block is recognized as waiting for operator
  // guidance, so it renders as plan-review guidance carrying the durable authored
  // reason rather than the raw `## Blocker` section.
  assert.equal(snapshot.blockedGuidance?.category, 'plan_review_guidance');
  assert.equal(snapshot.blockedGuidance?.reason, blocker);
  const output = renderHumanStatusSnapshot(snapshot);
  assert.match(output, /## Why Neal Stopped/);
  assert.ok(output.includes(blocker));
});

test('buildStatusSnapshot uses the completed blocked scope blocker for terminal blocked states', async () => {
  const now = new Date('2026-04-25T18:30:00.000Z');
  const fixture = await createStatusFixture({
    phase: 'blocked',
    status: 'blocked',
    now,
    mutate: (state) => ({
      ...state,
      blockedFromPhase: 'coder_scope',
      completedScopes: [
        ...state.completedScopes,
        {
          number: String(state.currentScopeNumber),
          marker: 'AUTONOMY_BLOCKED',
          result: 'blocked',
          baseCommit: null,
          finalCommit: null,
          summary: null,
          commitSubject: null,
          changedFiles: [],
          reviewRounds: 0,
          findings: 0,
          residualReviewDebt: [],
          archivedReviewPath: null,
          blocker: 'The current scope is not viable as written.',
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  assert.equal(snapshot.blocker.reason, 'The current scope is not viable as written.');
  assert.equal(snapshot.blocker.source, 'RUN_STATE.json completed scopes');
});

test('buildStatusSnapshot and list output expose active manual gate details', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'manual_gate',
    mutate: (state) => ({
      ...state,
      phase: 'manual_gate',
      status: 'running',
      manualGate: {
        id: 'approval',
        title: 'Approve deployment',
        reason: 'External approval is required.',
        instructionsPath: join(state.runDir, 'GATE-approval.md'),
        resumeChecks: [
          {
            type: 'command',
            name: 'approval file',
            command: ['test', '-f', 'approved.txt'],
          },
        ],
        resumePhase: 'coder_scope',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastCheckedAt: '2026-04-25T18:14:00.000Z',
        lastFailure: {
          checkName: 'approval file',
          exitCode: 1,
          signal: null,
          stdoutTail: 'missing',
          stderrTail: '',
        },
      },
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const list = await buildStatusListSnapshot({ cwd: fixture.cwd, now });

  assert.equal(snapshot.effectiveStatus, 'waiting_for_manual_gate');
  assert.equal(snapshot.manualGate?.id, 'approval');
  assert.equal(snapshot.manualGate?.resumeCommand, `neal resume --run ${runIdForFixture(fixture)}`);
  assert.equal(snapshot.waitingForOperatorGuidance, false);
  assert.match(output, /## Manual Gate/);
  assert.match(output, /- Last failure check: approval file/);
  assert.match(output, /Complete manual gate approval, then resume this run: neal resume --run/);
  assert.equal(list.runs[0].publicStatus, 'waiting_for_manual_gate');
  assert.equal(list.runs[0].manualGate?.title, 'Approve deployment');
  assert.match(list.runs[0].nextAction, /Complete manual gate approval/);
});

test('formatPublicPhase keeps execute finalization distinct from public squash', () => {
  assert.equal(formatPublicPhase('execute_finalization'), 'finalizing accepted scope');
});

test('buildStatusListSnapshot exposes sorted public run list rows', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const cwd = await mkdtemp(join(tmpdir(), 'neal-status-list-project-'));
  const oldRun = await createStatusFixture({
    cwd,
    now,
    runId: '2026-04-25T18-00-00.000Z-old',
    planName: 'old-plan.md',
    phase: 'blocked',
    status: 'blocked',
  });
  const waitingRun = await createStatusFixture({
    cwd,
    now,
    runId: '2026-04-25T19-00-00.000Z-waiting',
    planName: 'waiting-plan.md',
    phase: 'interactive_blocked_recovery',
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        enteredAt: minutesBefore(now, 5),
        sourcePhase: 'coder_scope',
        blockedReason: 'needs operator',
        maxTurns: 3,
        lastHandledTurn: 1,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: minutesBefore(now, 4),
            operatorGuidance: 'try again',
            disposition: null,
          },
        ],
      },
    }),
  });
  await rewriteRunState(oldRun, (state) => ({
    ...state,
    createdAt: '2026-04-25T18:00:00.000Z',
    updatedAt: '2026-04-25T18:05:00.000Z',
  }));
  await rewriteRunState(waitingRun, (state) => ({
    ...state,
    createdAt: '2026-04-25T19:00:00.000Z',
    updatedAt: '2026-04-25T19:05:00.000Z',
  }));

  const snapshot = await buildStatusListSnapshot({ cwd, now });
  const output = renderHumanStatusListSnapshot(snapshot);

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.cwd, cwd);
  assert.deepEqual(
    snapshot.runs.map((run) => run.runId),
    ['2026-04-25T19-00-00.000Z-waiting', '2026-04-25T18-00-00.000Z-old'],
  );
  assert.equal(snapshot.runs[0].publicStatus, 'waiting_for_guidance');
  assert.equal(snapshot.runs[0].publicPhase, 'waiting for recovery guidance');
  assert.equal(snapshot.runs[0].effectiveStatus, 'waiting_for_operator');
  assert.equal(snapshot.runs[0].waitingForOperatorGuidance, true);
  assert.equal(snapshot.runs[0].pendingOperatorGuidance, false);
  assert.equal(
    snapshot.runs[0].nextAction,
    'Needs operator guidance: Neal stopped because scope 1 needs operator guidance before it can continue. Use first resume option: neal resume --run 2026-04-25T19-00-00.000Z-waiting --message "Continue using this operator guidance. Keep existing verification requirements intact and do not assume any extra authorization."',
  );
  assert.equal(snapshot.runs[0].artifacts.runStatePath, join(waitingRun.runDir, 'RUN_STATE.json'));
  assert.match(output, /RUN ID\s+MODE\s+STATUS\s+STEP\s+PLAN\s+UPDATED\s+NEXT ACTION/);
  assert.match(output, /waiting-plan\.md/);
  assert.match(output, /Needs operator guidance: Neal stopped because scope 1 needs operator guidance before it can continue\. Use first resume option: neal resume --run 2026-04-25T19-00-00\.000Z-waiting --message "Continue using this operator guidance\./);
});

test('buildStatusListSnapshot recommends plain resume for ordinary failed coder scope runs', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const cwd = await mkdtemp(join(tmpdir(), 'neal-status-list-failed-project-'));
  const failedRun = await createStatusFixture({
    cwd,
    now,
    runId: '2026-04-25T18-30-00.000Z-failed',
    planName: 'failed-plan.md',
    status: 'failed',
  });

  const snapshot = await buildStatusListSnapshot({ cwd, now });

  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].runId, '2026-04-25T18-30-00.000Z-failed');
  assert.equal(snapshot.runs[0].publicStatus, 'failed');
  assert.equal(
    snapshot.runs[0].nextAction,
    `Resume this run: neal resume --run ${runIdForFixture(failedRun)}`,
  );
});

test('buildStatusSnapshot classifies recent heartbeat without phase progress as heartbeat_only', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 12), 'coder.command_execution', { command: 'old command' }),
    event(minutesBefore(now, 10), 'phase.start', { phase: 'coder_scope' }),
    event(secondsBefore(now, 10), 'phase.heartbeat', { phase: 'coder_scope' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'heartbeat_only');
  assert.equal(snapshot.health.heartbeatOnly, true);
});

test('buildStatusSnapshot classifies retry events as timed_out', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    mutate: (state) => ({
      ...state,
      coderRetryCount: 2,
    }),
  });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 1), 'phase.start', { phase: 'coder_scope' }),
    event(secondsBefore(now, 30), 'phase.retry', { phase: 'coder_scope' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'timed_out');
  assert.equal(snapshot.coderRetryCount, 2);
});

test('buildStatusSnapshot classifies paused-after-scope runs as paused', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 3), 'phase.start', { phase: 'coder_scope' }),
    event(minutesBefore(now, 2), 'coder.command_execution', { command: 'pnpm typecheck' }),
    event(minutesBefore(now, 1), 'run.paused_after_scope', { message: 'stop requested' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'paused');
  assert.equal(snapshot.lastMeaningfulEvent?.type, 'run.paused_after_scope');
});

test('buildStatusSnapshot classifies stale running activity as quiet', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 10), 'phase.start', { phase: 'coder_scope' }),
    event(minutesBefore(now, 7), 'coder.command_execution', { command: 'pnpm typecheck' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);

  assert.equal(snapshot.health.classification, 'quiet');
  assert.equal(snapshot.health.heartbeatOnly, false);
  assert.equal(snapshot.resumeDecision.kind, 'continue');
  assert.ok(output.includes(`Resume this run: neal resume --run ${runIdForFixture(fixture)}`));
});

test('buildStatusSnapshot classifies stale final-completion reviewer output evidence', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createFinalCompletionReviewFixture({
    now,
    label: 'final-completion',
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const list = await buildStatusListSnapshot({ cwd: fixture.cwd, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const runId = runIdForFixture(fixture);

  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.phase, 'final_completion_review');
  assert.equal(snapshot.publicStatus, 'stale');
  assert.equal(snapshot.health.classification, 'stale');
  assert.match(snapshot.health.reason, /final completion review has reviewer output/);
  assert.deepEqual(snapshot.finalCompletionStaleness, {
    stale: true,
    reason: 'final completion review has reviewer output but no terminal transition',
    reviewerOutputObserved: true,
    finalCompletionPhaseStartedAt: minutesBefore(now, 10),
    lastFinalCompletionReviewerOutputAt: minutesBefore(now, 7),
    finalCompletionPhaseTerminalEventObserved: false,
  });
  assert.equal(snapshot.resumeDecision.kind, 'continue');
  // The next action points at status (not plain resume) for a stale run; assert
  // the CLI tokens and the rendered status/health classification, not the
  // guidance prose (the health reason is deepEqual'd above).
  assert.ok(snapshot.nextAction.includes(`neal status --run ${runId}`));
  assert.equal(snapshot.nextAction.includes(`Resume this run: neal resume --run ${runId}`), false);
  assert.match(output, /- Status: stale/);
  assert.match(output, /- Health: stale/);
  assert.ok(output.includes(snapshot.nextAction));
  assert.equal(list.runs[0].publicStatus, 'stale');
  assert.deepEqual(list.runs[0].finalCompletionStaleness, snapshot.finalCompletionStaleness);
});

test('buildStatusSnapshot reports failed final-completion verdict validation as failed', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const finalCommit = '1111111111111111111111111111111111111111';
  const fixture = await createStatusFixture({
    now,
    phase: 'final_completion_review',
    status: 'failed',
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 5,
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCommit,
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Completed all requested implementation scopes.',
        verificationSummary: 'Required verification passed.',
        remainingKnownGaps: [],
      },
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      reviewerSessionHandle: null,
      completedScopes: [
        acceptedTerminalScope({
          number: '5',
          baseCommit: state.baseCommit,
          finalCommit,
        }),
      ],
    }),
  });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 10), 'phase.start', { phase: 'final_completion_review' }),
    event(minutesBefore(now, 7), 'provider.structured_output_received', {
      provider: 'anthropic-claude',
      role: 'structured-advisor',
      label: 'final-completion',
    }),
    event(minutesBefore(now, 6), 'phase.error', {
      phase: 'final_completion_review',
      sessionHandle: 'reviewer-final-completion-invalid-verdict',
      subtype: 'final_completion_verdict_invalid',
      message:
        'Final completion reviewer verdict must include a non-empty missingWork payload when action=continue_execution.',
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);

  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.phase, 'final_completion_review');
  assert.equal(snapshot.publicStatus, 'failed');
  assert.equal(snapshot.health.classification, 'blocked');
  assert.equal(snapshot.finalCompletionStaleness.stale, false);
  assert.equal(snapshot.finalCompletionStaleness.reviewerOutputObserved, true);
  assert.equal(snapshot.finalCompletionStaleness.finalCompletionPhaseTerminalEventObserved, true);
  assert.match(output, /- Status: failed/);
  assert.doesNotMatch(output, /- Status: stale/);
});

test('buildStatusSnapshot treats fallback final-completion structured output as stale reviewer evidence', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createFinalCompletionReviewFixture({
    now,
    label: 'final-completion:structured-output-fallback',
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.publicStatus, 'stale');
  assert.equal(snapshot.health.classification, 'stale');
  assert.equal(snapshot.finalCompletionStaleness.reviewerOutputObserved, true);
  assert.equal(snapshot.finalCompletionStaleness.lastFinalCompletionReviewerOutputAt, minutesBefore(now, 7));
});

test('buildStatusSnapshot keeps active final-completion review running when stale predicates are incomplete', async (t) => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const recent = await createFinalCompletionReviewFixture({
    now,
    runId: '2026-04-25T18-00-00.000Z-recent-final-completion',
    outputAgeMinutes: 1,
    phaseStartAgeMinutes: 2,
  });
  const noReviewerOutput = await createFinalCompletionReviewFixture({
    now,
    runId: '2026-04-25T18-01-00.000Z-no-final-completion-output',
    label: null,
  });
  const locked = await createFinalCompletionReviewFixture({
    now,
    runId: '2026-04-25T18-02-00.000Z-locked-final-completion',
  });
  const lockedRunId = runIdForFixture(locked);
  const handle = await acquireActiveRunLock({
    cwd: locked.cwd,
    runId: lockedRunId,
    runStatePath: locked.statePath,
    planDoc: locked.planDoc,
    topLevelMode: 'execute',
  });
  t.after(async () => {
    await handle.release();
  });

  const recentSnapshot = await buildStatusSnapshot({ cwd: recent.cwd, statePath: recent.statePath, now });
  const noOutputSnapshot = await buildStatusSnapshot({ cwd: noReviewerOutput.cwd, statePath: noReviewerOutput.statePath, now });
  const lockedSnapshot = await buildStatusSnapshot({ cwd: locked.cwd, statePath: locked.statePath, now });

  assert.equal(recentSnapshot.finalCompletionStaleness.stale, false);
  assert.equal(recentSnapshot.finalCompletionStaleness.reviewerOutputObserved, true);
  assert.equal(recentSnapshot.publicStatus, 'running');
  assert.equal(recentSnapshot.health.classification, 'ok');

  assert.equal(noOutputSnapshot.finalCompletionStaleness.stale, false);
  assert.equal(noOutputSnapshot.finalCompletionStaleness.reviewerOutputObserved, false);
  assert.equal(noOutputSnapshot.publicStatus, 'running');
  assert.equal(noOutputSnapshot.health.classification, 'quiet');

  assert.equal(lockedSnapshot.finalCompletionStaleness.stale, false);
  assert.equal(lockedSnapshot.finalCompletionStaleness.reviewerOutputObserved, true);
  assert.equal(lockedSnapshot.publicStatus, 'running');
  assert.equal(lockedSnapshot.lock.kind, 'live_same_run');
  assert.equal(lockedSnapshot.resumeDecision.kind, 'already_running');
});

test('buildStatusSnapshot does not treat recent resume command events as healthy progress', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 10), 'phase.start', { phase: 'coder_scope' }),
    event(minutesBefore(now, 7), 'coder.command_execution', { command: 'pnpm typecheck' }),
    event(secondsBefore(now, 10), 'run.resumed', { statePath: fixture.statePath }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.lastMeaningfulEvent?.type, 'coder.command_execution');
  assert.equal(snapshot.health.classification, 'quiet');
  assert.equal(snapshot.resumeDecision.kind, 'continue');
});

test('buildStatusSnapshot classifies blocked and failed state without events as blocked', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  for (const status of ['blocked', 'failed'] as const) {
    const fixture = await createStatusFixture({ now, status });
    const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
    assert.equal(snapshot.health.classification, 'blocked');
  }

  const phaseFixture = await createStatusFixture({ now, phase: 'blocked' });
  const phaseSnapshot = await buildStatusSnapshot({ cwd: phaseFixture.cwd, statePath: phaseFixture.statePath, now });
  assert.equal(phaseSnapshot.health.classification, 'blocked');
});

test('buildStatusSnapshot surfaces terminal invalid split-plan blocker diagnostics', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const validationReason = 'split-plan payload is not a valid Neal-executable plan: executionShape: multi_scope must not include a `## Completion Condition` section.';
  const fixture = await createStatusFixture({
    now,
    phase: 'blocked',
    status: 'blocked',
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 5,
      blockedFromPhase: 'reviewer_scope',
      lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
      completedScopes: [
        {
          number: '5',
          marker: 'AUTONOMY_SPLIT_PLAN',
          result: 'blocked',
          baseCommit: 'base',
          finalCommit: 'scope-head',
          summary: null,
          commitSubject: null,
          changedFiles: [],
          reviewRounds: 0,
          findings: 0,
          residualReviewDebt: [],
          archivedReviewPath: null,
          blocker: validationReason,
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
    }),
  });
  const invalidPayloadPath = join(fixture.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md');
  await writeFile(invalidPayloadPath, '# Invalid Derived Plan Payload\n', 'utf8');
  await writeEvents(fixture.eventsPath, [
    event(secondsBefore(now, 15), 'split_plan.invalid_payload', {
      scopeNumber: 5,
      sourcePhase: 'reviewer_scope',
      validationErrors: ['executionShape: multi_scope must not include a `## Completion Condition` section.'],
      invalidPayloadPath,
      resetSkipped: true,
      createdCommits: ['scope-head'],
    }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const jsonOutput = JSON.stringify(snapshot, null, 2);

  assert.equal(snapshot.blocker.active, true);
  assert.equal(snapshot.blocker.reason, validationReason);
  assert.equal(snapshot.blocker.source, 'RUN_STATE.json completed scopes');
  assert.deepEqual(snapshot.blocker.artifactPaths, [{ label: 'Invalid split-plan payload', path: invalidPayloadPath }]);
  assert.equal(snapshot.artifacts.invalidDerivedPlanPayloadPath, invalidPayloadPath);
  assert.match(output, /## Blocker/);
  assert.match(output, /must not include a `## Completion Condition` section/);
  assert.ok(output.includes(`- Invalid split-plan payload: ${invalidPayloadPath}`));
  assert.match(jsonOutput, /invalidDerivedPlanPayloadPath/);
  assert.match(jsonOutput, /SCOPE_5_INVALID_DERIVED_PLAN\.md/);
});

test('buildStatusSnapshot classifies interactive blocked recovery waiting for guidance as blocked', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'interactive_blocked_recovery',
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        enteredAt: minutesBefore(now, 5),
        sourcePhase: 'coder_scope',
        blockedReason: 'needs operator',
        maxTurns: 3,
        lastHandledTurn: 1,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: minutesBefore(now, 4),
            operatorGuidance: 'try again',
            disposition: null,
          },
        ],
      },
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.health.classification, 'blocked');
  assert.equal(snapshot.effectiveStatus, 'waiting_for_operator');
  assert.equal(snapshot.waitingForOperatorGuidance, true);
  assert.equal(snapshot.pendingOperatorGuidance, false);
  assert.equal(snapshot.blockedGuidance?.category, 'unknown');
});

test('buildStatusSnapshot surfaces scope-accounting guidance without headlining raw internals', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    mutate: (state) => ({
      ...state,
      ...scopeAccountingGuardrailState(),
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const jsonOutput = JSON.stringify(snapshot, null, 2);
  const technicalDetailsIndex = output.indexOf('Technical details:');
  const preconditionIndex = output.indexOf('accepted derived plan is not actively executing');

  assert.equal(snapshot.blockedGuidance?.category, 'scope_accounting_guardrail');
  assert.match(snapshot.blockedGuidance.summary, /scope-accounting guardrail/);
  assert.match(snapshot.blockedGuidance.technicalDetails.join('\n'), /accepted derived plan is not actively executing/);
  assert.equal(snapshot.blocker.reason, snapshot.blockedGuidance.summary);
  assert.equal(snapshot.blocker.source, 'blocked guidance');
  assert.match(snapshot.nextAction, /Use first resume option: neal resume --run 2026-04-25T18-00-00\.000Z-test --message "Accept scope 4 as already satisfied/);
  assert.doesNotMatch(snapshot.nextAction, /Unsafe advance_parent|failed preconditions/);
  assert.match(output, /## Why Neal Stopped/);
  assert.match(output, /scope-accounting guardrail/);
  assert.match(output, /Accept already-satisfied scope/);
  assert.ok(technicalDetailsIndex > -1);
  assert.ok(preconditionIndex > technicalDetailsIndex);
  assert.doesNotMatch(output.slice(0, technicalDetailsIndex), /Unsafe advance_parent|accepted derived plan is not actively executing/);
  assert.ok(jsonOutput.indexOf('scope-accounting guardrail') < jsonOutput.indexOf('Unsafe advance_parent'));
});

test('buildStatusSnapshot reports pending operator guidance as resumable running state', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'interactive_blocked_recovery',
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        enteredAt: minutesBefore(now, 5),
        sourcePhase: 'coder_scope',
        blockedReason: 'needs operator',
        maxTurns: 3,
        lastHandledTurn: 0,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: minutesBefore(now, 4),
            operatorGuidance: 'try again',
            disposition: null,
          },
        ],
      },
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.effectiveStatus, 'running');
  assert.equal(snapshot.waitingForOperatorGuidance, false);
  assert.equal(snapshot.pendingOperatorGuidance, true);
  assert.equal(snapshot.blockedGuidance, null);
});

test('buildStatusSnapshot tolerates missing event logs', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.events.exists, false);
  assert.equal(snapshot.events.parsedLines, 0);
  assert.equal(snapshot.health.classification, 'unknown');
  assert.equal(snapshot.lastEventAt, null);
});

test('buildStatusSnapshot tolerates malformed event lines', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [
    '{"ts":',
    event(secondsBefore(now, 20), 'coder.file_change', { message: 'edited file' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });

  assert.equal(snapshot.events.exists, true);
  assert.equal(snapshot.events.parsedLines, 1);
  assert.equal(snapshot.events.malformedLines, 1);
  assert.equal(snapshot.health.classification, 'ok');
});

test('renderHumanStatusSnapshot summarizes a running run with next resume action', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 4,
      findings: [finding('open', 'blocking'), finding('open', 'non_blocking')],
    }),
  });
  await writeEvents(fixture.eventsPath, [
    event(minutesBefore(now, 1), 'phase.start', { phase: 'coder_scope' }),
    event(secondsBefore(now, 30), 'coder.command_execution', { command: 'pnpm typecheck' }),
  ]);

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const runId = runIdForFixture(fixture);

  assert.match(output, /# Neal Status/);
  assert.match(output, /- Status: running/);
  assert.match(output, /- Step: implementing current scope/);
  assert.match(output, /- Current scope: 4/);
  assert.match(output, /- Health: ok - recent meaningful event/);
  assert.match(output, /- Findings: 1 open blocking, 1 open non-blocking \(2 total\)/);
  assert.match(output, /- Operator guidance: waiting=no, pending=no/);
  assert.match(output, /- Last progress: coder\.command_execution - pnpm typecheck/);
  assert.ok(output.includes(`Resume this run: neal resume --run ${runId}`));
});

test('renderHumanStatusSnapshot summarizes done runs without scope progress', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now, phase: 'done' });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const runId = runIdForFixture(fixture);

  assert.match(output, /- Status: done/);
  assert.match(output, /- Step: done/);
  assert.doesNotMatch(output, /- Current scope:/);
  assert.ok(output.includes(`No resume needed. Inspect status: neal status --run ${runId}`));
});

test('renderHumanStatusSnapshot summarizes blocked runs with inspection actions and ordinary failures with resume actions', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const blockedFixture = await createStatusFixture({
    now,
    phase: 'blocked',
    status: 'blocked',
    mutate: (state) => ({
      ...state,
      blockedFromPhase: 'reviewer_scope',
    }),
  });
  const failedFixture = await createStatusFixture({ now, status: 'failed' });

  const blockedSnapshot = await buildStatusSnapshot({ cwd: blockedFixture.cwd, statePath: blockedFixture.statePath, now });
  const failedSnapshot = await buildStatusSnapshot({ cwd: failedFixture.cwd, statePath: failedFixture.statePath, now });
  const blockedOutput = renderHumanStatusSnapshot(blockedSnapshot);
  const failedOutput = renderHumanStatusSnapshot(failedSnapshot);

  assert.match(blockedOutput, /- Status: blocked/);
  assert.match(blockedOutput, /- Health: blocked - state is blocked or failed/);
  assert.doesNotMatch(blockedOutput, /## Resume Options/);
  assert.equal(blockedSnapshot.blockedGuidance, null);
  // Assert the blocked-from phase token and the status CLI token render; the
  // surrounding "cannot be mechanically resumed" sentence is prose.
  assert.match(blockedOutput, /blocked from reviewer_scope/);
  assert.ok(blockedOutput.includes(`Inspect status and artifacts: neal status --run ${runIdForFixture(blockedFixture)}`));
  assert.match(failedOutput, /- Status: failed/);
  assert.match(failedOutput, /- Health: blocked - state is blocked or failed/);
  assert.ok(failedOutput.includes(`Resume this run: neal resume --run ${runIdForFixture(failedFixture)}`));
});

test('renderHumanStatusSnapshot maps waiting guidance to public status and message action', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'interactive_blocked_recovery',
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        enteredAt: minutesBefore(now, 5),
        sourcePhase: 'coder_scope',
        blockedReason: 'needs operator',
        maxTurns: 3,
        lastHandledTurn: 1,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: minutesBefore(now, 4),
            operatorGuidance: 'try again',
            disposition: null,
          },
        ],
      },
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const runId = runIdForFixture(fixture);

  assert.match(output, /- Status: waiting_for_guidance/);
  assert.match(output, /- Step: waiting for recovery guidance/);
  assert.match(output, /- Operator guidance: waiting=yes, pending=no/);
  assert.match(output, /## Why Neal Stopped/);
  assert.match(output, /## Resume Options/);
  assert.match(output, /## Useful Artifacts/);
  assert.match(output, /- Reason: needs operator/);
  assert.match(output, new RegExp(`neal resume --run ${runId} --message "`));
  assert.ok(output.indexOf('## Useful Artifacts') < output.indexOf('## Next Action'));
  // The next action surfaces the first resume option's prefilled command; assert
  // that structured resume token rather than the surrounding guidance paragraph.
  assert.match(output, new RegExp(`neal resume --run ${runId} --message "Continue using this operator guidance`));
});

test('renderHumanStatusSnapshot reports pending guidance with resume action', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'interactive_blocked_recovery',
    mutate: (state) => ({
      ...state,
      interactiveBlockedRecovery: {
        enteredAt: minutesBefore(now, 5),
        sourcePhase: 'coder_scope',
        blockedReason: 'needs operator',
        maxTurns: 3,
        lastHandledTurn: 0,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: minutesBefore(now, 4),
            operatorGuidance: 'try again',
            disposition: null,
          },
        ],
      },
    }),
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);
  const runId = runIdForFixture(fixture);

  assert.match(output, /- Status: running/);
  assert.match(output, /- Operator guidance: waiting=no, pending=yes/);
  // Assert the resume CLI token for the pending-guidance next action; the
  // lead-in sentence is prose.
  assert.match(output, new RegExp(`Resume this run: neal resume --run ${runId}`));
});

test('renderHumanStatusSnapshot reports a live same-run lock as already running', async (t) => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  const runId = runIdForFixture(fixture);
  const handle = await acquireActiveRunLock({
    cwd: fixture.cwd,
    runId,
    runStatePath: fixture.statePath,
    planDoc: fixture.planDoc,
    topLevelMode: 'execute',
  });
  t.after(async () => {
    await handle.release();
  });

  const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath, now });
  const output = renderHumanStatusSnapshot(snapshot);

  // The structured resumeDecision.kind is the contract; the render points at
  // status inspection. Assert those, not the verbatim already-running sentence.
  assert.equal(snapshot.resumeDecision.kind, 'already_running');
  assert.ok(output.includes(`Inspect status: neal status --run ${runId}`));
});

test('formatStatusNextActionForState recommends plain resume for ordinary failed coder scope runs', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now, status: 'failed' });
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as OrchestrationState;

  assert.equal(
    formatStatusNextActionForState(state),
    `Resume this run: neal resume --run ${runIdForFixture(fixture)}`,
  );
});

test('formatStatusNextActionForState recommends plain resume for a running derived-plan revision without a planner session', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({
    now,
    phase: 'coder_plan_response',
    status: 'running',
    mutate: (state) => ({
      ...state,
      blockedFromPhase: null,
      currentScopeNumber: 3,
      plannerSessionHandle: null,
      plannerSessionProtocol: null,
      coderSessionHandle: '3915c8c0-de35-49b1-b04e-9958cbe14c02',
      coderSessionProtocol: 'structured_json_v1',
      derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
      derivedPlanStatus: 'pending_review',
      derivedFromScopeNumber: 3,
      derivedScopeIndex: null,
      splitPlanStartedNotified: true,
      findings: [finding('open', 'blocking')],
    }),
  });
  const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as OrchestrationState;

  assert.equal(
    formatStatusNextActionForState(state),
    `Resume this run: neal resume --run ${runIdForFixture(fixture)}`,
  );
});

test('parseStatusArgs accepts human default, json, all, and run selectors', () => {
  assert.deepEqual(parseStatusArgs(['status']), { runId: null, json: false, all: false });
  assert.deepEqual(parseStatusArgs(['status', '--json']), { runId: null, json: true, all: false });
  assert.deepEqual(parseStatusArgs(['status', '--all']), { runId: null, json: false, all: true });
  assert.deepEqual(parseStatusArgs(['status', '--all', '--json']), { runId: null, json: true, all: true });
  assert.deepEqual(parseStatusArgs(['status', '--json', '--all']), { runId: null, json: true, all: true });
  assert.deepEqual(parseStatusArgs(['status', '--run', 'run-id']), { runId: 'run-id', json: false, all: false });
  assert.deepEqual(parseStatusArgs(['status', '--json', '--run', 'run-id']), {
    runId: 'run-id',
    json: true,
    all: false,
  });
  assert.deepEqual(parseStatusArgs(['status', '--run', 'run-id', '--json']), {
    runId: 'run-id',
    json: true,
    all: false,
  });
  assert.throws(() => parseStatusArgs(['status', '--all', '--run', 'run-id']), /--all and --run are mutually exclusive/);
  assert.throws(() => parseStatusArgs(['status', '--all', '--all']), /accepts --all only once/);
  assert.throws(() => parseStatusArgs(['status', '--json', '--json']), /accepts --json only once/);
  assert.throws(() => parseStatusArgs(['status', '--run']), /--run requires a run id argument/);
  assert.throws(() => parseStatusArgs(['status', '--run', 'one', '--run', 'two']), /accepts --run only once/);
  assert.throws(() => parseStatusArgs(['status', '--json', '--bogus']), /Unknown argument: --bogus/);
});

test('neal status --json CLI prints one JSON object and does not mutate run state', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [event(secondsBefore(now, 20), 'coder.file_change')]);
  const runStatePath = join(fixture.runDir, 'RUN_STATE.json');
  const before = await stat(runStatePath);
  const beforeContent = await readFile(runStatePath, 'utf8');

  const invocation = nealCliInvocation(join(REPO_ROOT, 'src/neal/index.ts'), ['status', '--json', '--run', basename(fixture.runDir)]);
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    { cwd: fixture.cwd },
  );

  const after = await stat(runStatePath);
  const snapshot = JSON.parse(stdout) as {
    ok: boolean;
    statePath: string;
    phase: string;
    effectiveStatus: string;
    waitingForOperatorGuidance: boolean;
    pendingOperatorGuidance: boolean;
    resumeDecision: { kind: string };
    health: { classification: string };
  };
  assert.equal(normalizeCliStderr(stderr), '');
  assert.equal(snapshot.ok, true);
  assert.equal(await realpath(snapshot.statePath), await realpath(runStatePath));
  assert.equal(snapshot.phase, 'coder_scope');
  assert.equal(snapshot.effectiveStatus, 'running');
  assert.equal(snapshot.waitingForOperatorGuidance, false);
  assert.equal(snapshot.pendingOperatorGuidance, false);
  assert.equal(snapshot.resumeDecision.kind, 'continue');
  assert.equal(typeof snapshot.health.classification, 'string');
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(runStatePath, 'utf8'), beforeContent);
});

test('neal status --all --json is read-only for runs, pointers, queue state, and locks', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  const runId = basename(fixture.runDir);
  const queue = await createPlanAndExecuteQueue({
    cwd: fixture.cwd,
    planDocs: ['PLAN.md'],
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(fixture.cwd, queue.queueId);
  const currentQueuePointerPath = getCurrentPlanAndExecuteQueuePointerPath(fixture.cwd);
  await savePlanAndExecuteQueueState({
    ...queue,
    items: [
      {
        ...queue.items[0],
        status: 'executing',
        planningRunId: 'planning-run',
        planningStatePath: '.neal/runs/planning-run/RUN_STATE.json',
        acceptedPlanPath: 'PLAN.md',
        executionRunId: runId,
        executionStatePath: toQueueStoredPath(fixture.cwd, join(fixture.runDir, 'RUN_STATE.json')),
        activeStage: 'execution',
        startedAt: now.toISOString(),
      },
    ],
  });
  const queueLink = await writeQueueChildLink({
    runDir: fixture.runDir,
    queueId: queue.queueId,
    queueStatePath: toQueueStoredPath(fixture.cwd, queueStatePath),
    itemIndex: 0,
    stage: 'execution',
    createdAt: now.toISOString(),
  });

  const runStatePath = join(fixture.runDir, 'RUN_STATE.json');
  const currentPointerPath = getCurrentRunPointerPath(fixture.cwd);
  const activeLockPath = getActiveRunLockPath(fixture.cwd);
  const beforeRunStateStat = await stat(runStatePath);
  const beforeSessionStat = await stat(fixture.statePath);
  const beforeRunState = await readFile(runStatePath, 'utf8');
  const beforeSession = await readFile(fixture.statePath, 'utf8');
  const beforeCurrentPointer = await readFile(currentPointerPath, 'utf8');
  const beforeQueueState = await readFile(queueStatePath, 'utf8');
  const beforeCurrentQueuePointer = await readFile(currentQueuePointerPath, 'utf8');
  const beforeQueueLink = await readFile(join(fixture.runDir, 'QUEUE_LINK.json'), 'utf8');
  assert.deepEqual(JSON.parse(beforeQueueLink), queueLink);
  await assert.rejects(() => access(activeLockPath), { code: 'ENOENT' });

  const invocation = nealCliInvocation(join(REPO_ROOT, 'src/neal/index.ts'), ['status', '--all', '--json']);
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    { cwd: fixture.cwd },
  );

  const snapshot = JSON.parse(stdout) as {
    ok: boolean;
    runs: {
      runId: string;
      statePath: string;
      publicStatus: string;
      publicPhase: string;
      artifacts: { runStatePath: string };
    }[];
  };
  assert.equal(normalizeCliStderr(stderr), '');
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].runId, runId);
  assert.equal(await realpath(snapshot.runs[0].statePath), await realpath(runStatePath));
  assert.equal(snapshot.runs[0].publicStatus, 'running');
  assert.equal(snapshot.runs[0].publicPhase, 'implementing current scope');
  assert.equal(await realpath(snapshot.runs[0].artifacts.runStatePath), await realpath(runStatePath));
  await assert.rejects(() => access(activeLockPath), { code: 'ENOENT' });
  assert.equal((await stat(runStatePath)).mtimeMs, beforeRunStateStat.mtimeMs);
  assert.equal((await stat(fixture.statePath)).mtimeMs, beforeSessionStat.mtimeMs);
  assert.equal(await readFile(runStatePath, 'utf8'), beforeRunState);
  assert.equal(await readFile(fixture.statePath, 'utf8'), beforeSession);
  assert.equal(await readFile(currentPointerPath, 'utf8'), beforeCurrentPointer);
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueState);
  assert.equal(await readFile(currentQueuePointerPath, 'utf8'), beforeCurrentQueuePointer);
  assert.equal(await readFile(join(fixture.runDir, 'QUEUE_LINK.json'), 'utf8'), beforeQueueLink);
});

test('neal status CLI prints a human summary and does not mutate run pointers or state', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  await writeEvents(fixture.eventsPath, [event(secondsBefore(now, 20), 'coder.file_change')]);
  const runStatePath = join(fixture.runDir, 'RUN_STATE.json');
  const currentPointerPath = getCurrentRunPointerPath(fixture.cwd);
  const beforeSession = await stat(fixture.statePath);
  const beforeRunState = await stat(runStatePath);
  const beforeSessionContent = await readFile(fixture.statePath, 'utf8');
  const beforeRunStateContent = await readFile(runStatePath, 'utf8');
  const beforeCurrentPointerContent = await readFile(currentPointerPath, 'utf8');

  const invocation = nealCliInvocation(join(REPO_ROOT, 'src/neal/index.ts'), ['status']);
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    { cwd: fixture.cwd },
  );

  const afterSession = await stat(fixture.statePath);
  const afterRunState = await stat(runStatePath);
  assert.equal(normalizeCliStderr(stderr), '');
  assert.match(stdout, /# Neal Status/);
  assert.match(stdout, /- Status: running/);
  assert.match(stdout, /## Next Action/);
  assert.throws(() => JSON.parse(stdout));
  assert.equal(afterSession.mtimeMs, beforeSession.mtimeMs);
  assert.equal(afterRunState.mtimeMs, beforeRunState.mtimeMs);
  assert.equal(await readFile(fixture.statePath, 'utf8'), beforeSessionContent);
  assert.equal(await readFile(runStatePath, 'utf8'), beforeRunStateContent);
  assert.equal(await readFile(currentPointerPath, 'utf8'), beforeCurrentPointerContent);
});

test('neal status CLI reports a friendly empty state when no runs exist', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-status-empty-'));

  const invocation = nealCliInvocation(join(REPO_ROOT, 'src/neal/index.ts'), ['status']);
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    { cwd },
  );

  assert.equal(normalizeCliStderr(stderr), '');
  assert.equal(stdout, 'No Neal runs found in this repository yet. Start one with: neal run <plan.md>\n');
  assert.doesNotMatch(stdout, /current\.json/);

  // The machine-readable path keeps its existing contract: no runs is still an error.
  const jsonInvocation = nealCliInvocation(join(REPO_ROOT, 'src/neal/index.ts'), ['status', '--json']);
  await assert.rejects(
    () => execFileAsync(jsonInvocation.command, jsonInvocation.args, { cwd }),
    /No \.neal\/current\.json pointer found/,
  );
});

test('neal status --json --run reads exact run-local state without mutating artifacts', async () => {
  const now = new Date('2026-04-25T18:15:52.082Z');
  const fixture = await createStatusFixture({ now });
  const runId = basename(fixture.runDir);
  const runStatePath = join(fixture.runDir, 'RUN_STATE.json');
  const before = await stat(runStatePath);
  const beforeRunState = await readFile(runStatePath, 'utf8');
  const beforeCurrent = await readFile(getCurrentRunPointerPath(fixture.cwd), 'utf8');

  const invocation = nealCliInvocation(join(REPO_ROOT, 'src/neal/index.ts'), ['status', '--json', '--run', runId]);
  const { stdout, stderr } = await execFileAsync(
    invocation.command,
    invocation.args,
    { cwd: fixture.cwd },
  );

  const after = await stat(runStatePath);
  const snapshot = JSON.parse(stdout) as {
    ok: boolean;
    statePath: string;
  };
  assert.equal(normalizeCliStderr(stderr), '');
  assert.equal(snapshot.ok, true);
  assert.equal(await realpath(snapshot.statePath), await realpath(runStatePath));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(runStatePath, 'utf8'), beforeRunState);
  assert.equal(await readFile(getCurrentRunPointerPath(fixture.cwd), 'utf8'), beforeCurrent);
});
