import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildLocalNealContextPack } from '../src/neal/context/context.js';
import {
  REVIEWER_CONTEXT_JSON,
  REVIEWER_CONTEXT_MARKDOWN,
  buildAndPersistReviewerContextPacket,
  buildReviewerContextPacket,
} from '../src/neal/context/reviewer-context.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

const execFileAsync = promisify(execFile);
process.env.HOME = join(tmpdir(), 'neal-test-home-context-pack');

async function createContextFixture(args: {
  status?: OrchestrationState['status'];
  phase?: OrchestrationState['phase'];
  mutate?: (state: OrchestrationState) => OrchestrationState;
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-context-pack-'));
  await execFileAsync('git', ['init'], { cwd });
  await execFileAsync('git', ['config', 'user.email', 'neal@example.test'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Neal Test'], { cwd });

  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Fixture Plan\n\nImplement the fixture behavior.\n', 'utf8');
  await execFileAsync('git', ['add', 'PLAN.md'], { cwd });
  await execFileAsync('git', ['commit', '-m', 'Initial fixture plan'], { cwd });

  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', '2026-04-25T18-00-00.000Z-test');
  await mkdir(runDir, { recursive: true });

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

  const state = withInteractiveBlockedRecoveryFixture(args.mutate?.({
    ...initialState,
    status: args.status ?? initialState.status,
    phase: args.phase ?? initialState.phase,
    executionShape: 'multi_scope',
  }) ?? {
    ...initialState,
    status: args.status ?? initialState.status,
    phase: args.phase ?? initialState.phase,
    executionShape: 'multi_scope',
  });
  const statePath = getRunStatePath(runDir);
  const savedState = await saveState(statePath, state);

  return {
    cwd,
    stateDir,
    runDir,
    statePath,
    runStatePath: getRunStatePath(runDir),
    planDoc,
    state: savedState,
  };
}

function withInteractiveBlockedRecoveryFixture(state: OrchestrationState): OrchestrationState {
  if (state.phase !== 'interactive_blocked_recovery' || state.interactiveBlockedRecovery) {
    return state;
  }

  return {
    ...state,
    blockedFromPhase: state.blockedFromPhase ?? 'reviewer_scope',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-25T18:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'Blocked waiting for operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [],
    },
  };
}

function artifact(pack: Awaited<ReturnType<typeof buildLocalNealContextPack>>, label: string) {
  const found = pack.artifacts.find((item) => item.label === label);
  assert.ok(found, `expected artifact ${label}`);
  return found;
}

test('completed run context pack cites bounded run artifacts and supplied plan', async () => {
  const fixture = await createContextFixture({
    status: 'done',
    phase: 'done',
    mutate: (state) => ({
      ...state,
      status: 'done',
      phase: 'done',
      executionShape: 'one_shot',
      finalCommit: 'final-commit',
    }),
  });
  await writeFile(fixture.state.progressJsonPath, JSON.stringify({ completedScopes: ['1'] }, null, 2), 'utf8');
  await writeFile(fixture.state.progressMarkdownPath, '# Plan Progress\n\nScope 1 accepted.\n', 'utf8');
  await writeFile(fixture.state.reviewMarkdownPath, '# Review\n\nNo findings.\n', 'utf8');
  await writeFile(fixture.state.recoveryMarkdownPath, '# Support\n\nNo support rounds.\n', 'utf8');
  await writeFile(join(fixture.runDir, 'events.ndjson'), '{"ts":"2026-04-25T18:00:00.000Z","type":"phase.complete"}\n', 'utf8');
  await writeFile(join(fixture.runDir, 'RETROSPECTIVE.md'), '# Retrospective\n\nThe run completed.\n', 'utf8');
  await writeFile(join(fixture.runDir, 'FINAL_COMPLETION_REVIEW.md'), '# Final Completion Review\n\nAccepted.\n', 'utf8');
  await writeFile(join(fixture.cwd, 'AGENTS.md'), '# Repository Guidelines\n\nUse TypeScript.\n', 'utf8');
  await writeFile(join(fixture.stateDir, 'NOTES.md'), '# Neal Notes\n\nLocal operator note.\n', 'utf8');

  const pack = await buildLocalNealContextPack({
    cwd: fixture.cwd,
    statePath: fixture.runStatePath,
    planPath: fixture.planDoc,
    now: new Date('2026-04-25T18:15:52.082Z'),
  });

  assert.equal(pack.createdAt, '2026-04-25T18:15:52.082Z');
  assert.equal(pack.state?.statePathSource, 'explicit');
  assert.equal(pack.state?.status, 'done');
  assert.equal(pack.state?.runDirName, '2026-04-25T18-00-00.000Z-test');
  assert.deepEqual(
    pack.citations.map((citation) => citation.label),
    [
      'RUN_STATE.json',
      'events.ndjson',
      'plan-progress.json',
      'PLAN_PROGRESS.md',
      'REVIEW.md',
      'RECOVERY.md',
      'RETROSPECTIVE.md',
      'FINAL_COMPLETION_REVIEW.md',
      fixture.planDoc,
      'AGENTS.md',
      '.neal/NOTES.md',
      'git context',
    ],
  );
  assert.equal(pack.suggestedActions.some((action) => action.type === 'inspect_artifact'), true);
  assert.equal(pack.suggestedActions.some((action) => action.type === 'squash'), true);
  assert.equal(pack.limits.totalArtifactBytes > 0, true);

  for (const citation of pack.citations.filter((item) => item.kind === 'run_artifact' || item.kind === 'state')) {
    assert.equal(citation.label.startsWith(fixture.cwd), false);
    assert.equal(citation.label.includes('/'), false);
  }
});

test('context pack defaults through .neal/current.json', async () => {
  const fixture = await createContextFixture({});

  const pack = await buildLocalNealContextPack({
    cwd: fixture.cwd,
    now: new Date('2026-04-25T18:15:52.082Z'),
  });

  assert.equal(pack.state?.statePathSource, 'current_pointer');
  assert.equal(pack.state?.statePath, '.neal/runs/2026-04-25T18-00-00.000Z-test/RUN_STATE.json');
});

test('blocked run context pack tolerates missing optional artifacts', async () => {
  const fixture = await createContextFixture({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
  });
  await writeFile(fixture.state.progressJsonPath, JSON.stringify({ status: 'blocked' }, null, 2), 'utf8');
  await writeFile(fixture.state.progressMarkdownPath, '# Plan Progress\n\nBlocked waiting for operator.\n', 'utf8');

  const pack = await buildLocalNealContextPack({
    cwd: fixture.cwd,
    statePath: fixture.runStatePath,
    now: new Date('2026-04-25T18:15:52.082Z'),
  });

  assert.equal(pack.state?.status, 'blocked');
  assert.equal(artifact(pack, 'events.ndjson').omissionReason, 'missing');
  assert.equal(artifact(pack, 'REVIEW.md').omissionReason, 'missing');
  assert.equal(artifact(pack, 'RECOVERY.md').omissionReason, 'missing');
  assert.equal(pack.suggestedActions.some((action) => action.type === 'recover'), true);
  assert.equal(
    pack.suggestedActions.find((action) => action.type === 'recover')?.target.statePath,
    '.neal/runs/2026-04-25T18-00-00.000Z-test/RUN_STATE.json',
  );
});

test('context pack enforces per-artifact and total byte caps deterministically', async () => {
  const fixture = await createContextFixture({});
  await writeFile(fixture.state.progressJsonPath, '{"ok":true}\n', 'utf8');
  await writeFile(fixture.state.progressMarkdownPath, 'P'.repeat(100), 'utf8');
  await writeFile(fixture.state.reviewMarkdownPath, 'R'.repeat(100), 'utf8');
  await writeFile(fixture.state.recoveryMarkdownPath, 'C'.repeat(100), 'utf8');

  const pack = await buildLocalNealContextPack({
    cwd: fixture.cwd,
    statePath: fixture.runStatePath,
    now: new Date('2026-04-25T18:15:52.082Z'),
    perArtifactByteLimit: 24,
    totalByteLimit: 80,
  });

  assert.equal(pack.limits.totalArtifactBytes <= 80, true);
  assert.equal(pack.artifacts.every((item) => item.byteLength <= 24), true);
  assert.equal(pack.limits.truncatedArtifactCount > 0, true);
  assert.equal(pack.limits.omittedArtifactCount > 0, true);
});

test('context pack does not read sensitive local files outside the allowlisted artifacts', async () => {
  const fixture = await createContextFixture({});
  await writeFile(join(fixture.cwd, '.env'), 'NEAL_SECRET=SECRET_VALUE\n', 'utf8');
  await mkdir(join(fixture.cwd, '.neal', 'oauth'), { recursive: true });
  await writeFile(join(fixture.cwd, '.neal', 'oauth', 'cookies.json'), '{"token":"SECRET_VALUE"}\n', 'utf8');

  const pack = await buildLocalNealContextPack({
    cwd: fixture.cwd,
    statePath: fixture.runStatePath,
    now: new Date('2026-04-25T18:15:52.082Z'),
  });
  const serialized = JSON.stringify(pack);

  assert.equal(serialized.includes('SECRET_VALUE'), false);
  assert.equal(pack.artifacts.some((item) => item.label === '.env'), false);
  assert.equal(pack.artifacts.some((item) => item.label.includes('cookies')), false);

  const envContents = await readFile(join(fixture.cwd, '.env'), 'utf8');
  assert.equal(envContents.includes('SECRET_VALUE'), true);
});

test('reviewer context packet is bounded and persists citations instead of full logs', async () => {
  const fixture = await createContextFixture({
    phase: 'reviewer_scope',
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 14,
      completedScopes: Array.from({ length: 14 }, (_, index) => ({
        number: String(index + 1),
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: `base-${index + 1}`,
        finalCommit: `commit-${index + 1}`,
        summary: `Accepted scope ${index + 1}`,
        commitSubject: `Commit scope ${index + 1}`,
        changedFiles: [`src/file-${index + 1}.ts`],
        reviewRounds: 1,
        findings: index,
        residualReviewDebt: [],
        archivedReviewPath: null,
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      })),
      findings: Array.from({ length: 28 }, (_, index) => ({
        id: `F${index + 1}`,
        canonicalId: `canonical-${index + 1}`,
        round: 1,
        source: 'reviewer',
        severity: index % 2 === 0 ? 'blocking' : 'non_blocking',
        files: [`src/finding-${index + 1}.ts`],
        claim: `Finding claim ${index + 1}`,
        evidence: `Evidence ${index + 1}`,
        requiredAction: `Fix finding ${index + 1}`,
        status: index % 3 === 0 ? 'fixed' : 'open',
        roundSummary: `Round summary ${index + 1}`,
        coderDisposition: null,
        coderCommit: null,
      })),
    }),
  });

  await writeFile(join(fixture.runDir, 'events.ndjson'), 'x'.repeat(20_000), 'utf8');

  const packet = await buildAndPersistReviewerContextPacket({
    state: fixture.state,
    now: new Date('2026-04-25T18:15:52.082Z'),
  });

  assert.equal(packet.createdAt, '2026-04-25T18:15:52.082Z');
  assert.equal(packet.completedScopes.length, 12);
  assert.equal(packet.completedScopes[0]?.number, '3');
  assert.equal(packet.findings.length, 24);
  assert.equal(packet.findings[0]?.canonicalId, 'canonical-5');
  assert.equal(packet.limits.truncatedCompletedScopes, true);
  assert.equal(packet.limits.truncatedFindings, true);
  assert.equal(packet.promptMarkdown.includes('events.ndjson'), false);
  assert.equal(packet.promptMarkdown.includes('RUN_STATE.json'), true);

  const persistedJson = JSON.parse(await readFile(join(fixture.runDir, REVIEWER_CONTEXT_JSON), 'utf8'));
  const persistedMarkdown = await readFile(join(fixture.runDir, REVIEWER_CONTEXT_MARKDOWN), 'utf8');
  assert.equal(Object.hasOwn(persistedJson, 'promptMarkdown'), false);
  assert.equal(persistedJson.citations.some((citation: { label: string }) => citation.label === 'REVIEW.md'), true);
  assert.equal(persistedMarkdown.includes('Reviewer Continuity Context'), true);
});

test('reviewer prompts include compact continuity context without duplicating artifact contents', async () => {
  const fixture = await createContextFixture({});
  const packet = buildReviewerContextPacket({ state: fixture.state, now: new Date('2026-04-25T18:15:52.082Z') });
  const serialized = JSON.stringify(packet);

  assert.equal(serialized.includes('RUN_STATE.json'), true);
  assert.equal(serialized.includes('Current-run continuity'), false);
  assert.equal(packet.promptMarkdown.includes('PLAN_PROGRESS.md'), true);
});

test('an execution child seeded with inheritedPlanReviewDebt surfaces the exact items to the reviewer context', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-inherited-debt-seed-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', '2026-04-25T18-00-00.000Z-test');
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const inheritedDebt: OrchestrationState['inheritedPlanReviewDebt'] = [
    {
      id: 'R3-F1',
      canonicalId: 'C3',
      status: 'deferred',
      files: ['PLAN.md'],
      claim: 'Verification should pin the retry-count behavior.',
      evidence: '',
      requiredAction: 'Add an executable oracle for retry counting.',
      coderDisposition: null,
      coderCommit: null,
      findingClass: 'verification_hardening',
      originRound: 3,
    },
  ];

  // The init option seeds the durable inheritedPlanReviewDebt field (the queue
  // execution-stage handoff), never the recomputed planReviewDebt.
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
      inheritedPlanReviewDebt: inheritedDebt,
    },
    'base',
  );
  assert.deepStrictEqual(initialState.inheritedPlanReviewDebt, inheritedDebt);
  assert.deepStrictEqual(initialState.planReviewDebt, []);

  const statePath = getRunStatePath(runDir);
  await saveState(statePath, initialState);

  // The durable field survives the RUN_STATE.json hydration round-trip.
  const reloaded = await loadState(statePath);
  assert.deepStrictEqual(reloaded.inheritedPlanReviewDebt, inheritedDebt);
  assert.deepStrictEqual(reloaded.planReviewDebt, []);

  const packet = await buildAndPersistReviewerContextPacket({ state: reloaded });
  assert.deepStrictEqual(packet.inheritedPlanReviewDebt, [
    {
      canonicalId: 'C3',
      findingClass: 'verification_hardening',
      originRound: 3,
      claim: 'Verification should pin the retry-count behavior.',
      requiredAction: 'Add an executable oracle for retry counting.',
    },
  ]);

  // The persisted REVIEWER_CONTEXT.json carries the exact inherited items, and
  // the markdown renders the dedicated section for the reviewer.
  const persistedJson = JSON.parse(await readFile(join(runDir, REVIEWER_CONTEXT_JSON), 'utf8'));
  assert.deepStrictEqual(persistedJson.inheritedPlanReviewDebt, packet.inheritedPlanReviewDebt);
  const persistedMarkdown = await readFile(join(runDir, REVIEWER_CONTEXT_MARKDOWN), 'utf8');
  assert.match(persistedMarkdown, /## Inherited Plan-Review Debt/);
  assert.match(
    persistedMarkdown,
    /- C3: findingClass=verification_hardening; originRound=3; claim=Verification should pin the retry-count behavior\.; requiredAction=Add an executable oracle for retry counting\./,
  );
});
