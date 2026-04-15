import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptAcceptedDerivedPlan, flushDerivedPlanNotifications, loadOrInitialize } from './orchestrator.js';
import { renderPlanProgressMarkdown } from './progress.js';
import { renderReviewMarkdown } from './review.js';
import { createInitialState, getDefaultAgentConfig, saveState } from './state.js';
import type { OrchestrationState } from './types.js';

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
        blocker: 'split-plan recovery rejected: scope 10 already emitted a derived plan once',
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

test('review and progress reports expose derived-plan audit linkage', async () => {
  const { state } = await createResumeFixture({
    currentScopeNumber: 3,
    phase: 'reviewer_plan',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
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
  assert.match(reviewMarkdown, /Derived from scope: 3/);
  assert.match(reviewMarkdown, /Discarded WIP artifact: .*SCOPE_3_DISCARDED\.diff/);
  assert.match(progressMarkdown, /Replaced by derived plan: \/tmp\/DERIVED_PLAN_SCOPE_3\.md/);
});
