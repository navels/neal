import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from '../src/neal/atomic-write.js';
import {
  continuePlanAndExecuteQueueFromChildRun,
  createPlanAndExecuteQueue,
  getCurrentPlanAndExecuteQueuePointerPath,
  getPlanAndExecuteQueueDir,
  getPlanAndExecuteQueueSummaryPath,
  getPlanAndExecuteQueueStatePath,
  getQueueChildLinkPath,
  inspectQueueChildResumeEvidence,
  loadPlanAndExecuteQueueState,
  readCurrentPlanAndExecuteQueuePointer,
  readQueueChildLink,
  resolveQueueStoredPath,
  runPlanAndExecuteQueue,
  savePlanAndExecuteQueueState,
  toQueueStoredPath,
  writeQueueChildLink,
  type InitializedQueueChildRun,
  type PlanAndExecuteQueueRunnerDeps,
  type PlanAndExecuteQueueState,
  type RunFreshPlanAndExecuteChildArgs,
} from '../src/neal/plan-queue.js';
import { getCurrentRunPointerPath, resolveRunStatePath } from '../src/neal/run-registry.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath, loadState, saveState } from '../src/neal/state.js';
import { buildStatusSnapshot, renderHumanStatusSnapshot } from '../src/neal/status.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  clearProviderDefinitionRegistrationsForTesting,
  registerProviderDefinitionForTesting,
} from '../src/neal/providers/registry.js';
import type { ExecuteRunResult } from '../src/neal/commands/runtime.js';
import type { ProviderCapabilities } from '../src/neal/providers/types.js';
import type { ResumeQueueEvidence } from '../src/neal/resume-decision.js';
import type { OrchestrationState } from '../src/neal/types.js';
import {
  createFakeProviderDefinition,
  fakeProviderDefaultCapabilities,
} from './helpers/fake-provider.js';

afterEach(() => {
  clearProviderCapabilitiesOverridesForTesting();
  clearProviderDefinitionRegistrationsForTesting();
});

function cloneProviderCapabilities(): ProviderCapabilities {
  return {
    coder: {
      ...fakeProviderDefaultCapabilities.coder,
      toolAccess: { ...fakeProviderDefaultCapabilities.coder.toolAccess },
    },
    'structured-advisor': {
      ...fakeProviderDefaultCapabilities['structured-advisor'],
      toolAccess: { ...fakeProviderDefaultCapabilities['structured-advisor'].toolAccess },
    },
  };
}

function assertQueueEvidenceKind<K extends ResumeQueueEvidence['kind']>(
  evidence: ResumeQueueEvidence,
  kind: K,
): ResumeQueueEvidence & { kind: K } {
  assert.equal(evidence.kind, kind);
  return evidence as ResumeQueueEvidence & { kind: K };
}

async function createQueueFixture(prefix: string, planNames = ['A.md']) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, 'repo');
  await mkdir(join(cwd, 'plans'), { recursive: true });
  for (const planName of planNames) {
    await writeFile(join(cwd, 'plans', planName), `# ${planName}\n`, 'utf8');
  }

  return { root, cwd };
}

type FakeChildOutcome = {
  status?: OrchestrationState['status'];
  phase?: OrchestrationState['phase'];
  planDoc?: string;
  manualGate?: NonNullable<OrchestrationState['manualGate']>;
  stateOverrides?: Partial<OrchestrationState>;
  waitingForOperatorGuidance?: boolean;
  waitingForManualGate?: boolean;
  stopRequestedAfterScope?: boolean;
};

function defaultPhaseForStatus(status: OrchestrationState['status']): OrchestrationState['phase'] {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    default:
      return 'coder_scope';
  }
}

function createFakeQueueRunner(
  cwd: string,
  outcomes: FakeChildOutcome[],
  worktreeStatusOutputs: string[] = [],
): {
  calls: Array<{
    stage: string;
    planDoc: string;
    itemIndex: number;
    allowedDirtyPaths: string[];
    squashOnCompletion: boolean;
  }>;
  cleanCalls: Array<{ cwd: string; paths: string[] }>;
  finalStates: OrchestrationState[];
  restoreCalls: Array<{ cwd: string; paths: string[] }>;
  itemDebts: Array<{ stage: string; planReviewDebt: OrchestrationState['planReviewDebt'] }>;
  deps: PlanAndExecuteQueueRunnerDeps;
} {
  const calls: Array<{
    stage: string;
    planDoc: string;
    itemIndex: number;
    allowedDirtyPaths: string[];
    squashOnCompletion: boolean;
  }> = [];
  const cleanCalls: Array<{ cwd: string; paths: string[] }> = [];
  const finalStates: OrchestrationState[] = [];
  const restoreCalls: Array<{ cwd: string; paths: string[] }> = [];
  // Records the inherited plan-review debt each child sees on its queue item, so
  // tests can assert the execution stage receives the planning stage's debt.
  const itemDebts: Array<{ stage: string; planReviewDebt: OrchestrationState['planReviewDebt'] }> = [];
  const pendingOutcomes = [...outcomes];
  const pendingWorktreeStatuses = [...worktreeStatusOutputs];

  return {
    calls,
    cleanCalls,
    finalStates,
    restoreCalls,
    itemDebts,
    deps: {
      async cleanUntrackedPaths(cleanCwd: string, paths: string[]) {
        cleanCalls.push({ cwd: cleanCwd, paths });
      },
      async getWorktreeStatus() {
        return pendingWorktreeStatuses.shift() ?? '';
      },
      async restoreWorktreePaths(restoreCwd: string, paths: string[]) {
        restoreCalls.push({ cwd: restoreCwd, paths });
      },
      async runFreshChild(
        args: RunFreshPlanAndExecuteChildArgs,
        onInitialized: (child: InitializedQueueChildRun) => Promise<void>,
      ) {
        const callNumber = calls.length + 1;
        calls.push({
          stage: args.stage,
          planDoc: args.planDoc,
          itemIndex: args.item.index,
          allowedDirtyPaths: args.stage === 'execution' ? [args.planDoc] : [],
          squashOnCompletion: args.squashOnCompletion,
        });
        itemDebts.push({ stage: args.stage, planReviewDebt: args.item.planReviewDebt });

        const runId = `${args.stage}-${callNumber}`;
        const runDir = join(cwd, '.neal', 'runs', runId);
        const stateDir = join(cwd, '.neal');
        const runStatePath = getRunStatePath(runDir);
        await mkdir(runDir, { recursive: true });
        const initialState = await createInitialState(
          {
            cwd,
            planDoc: args.planDoc,
            stateDir,
            runDir,
            topLevelMode: args.stage === 'planning' ? 'plan' : 'execute',
            allowedDirtyPaths: args.stage === 'execution' ? [args.planDoc] : [],
            agentConfig: getDefaultAgentConfig(),
            autoSquashOnCompletion: args.squashOnCompletion,
            progressJsonPath: join(runDir, 'plan-progress.json'),
            progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
            reviewMarkdownPath: join(runDir, 'REVIEW.md'),
            recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
            maxRounds: 3,
          },
          'base-commit',
        );
        const savedState = await saveState(runStatePath, initialState);
        await onInitialized({
          runId,
          runDir,
          runStatePath,
          statePath: runStatePath,
          planDoc: savedState.planDoc,
        });

        const outcome = pendingOutcomes.shift() ?? {};
        const status = outcome.status ?? 'done';
        const finalState: OrchestrationState = {
          ...savedState,
          status,
          phase: outcome.phase ?? defaultPhaseForStatus(status),
          planDoc: outcome.planDoc ?? savedState.planDoc,
          manualGate: outcome.manualGate ?? savedState.manualGate,
          ...outcome.stateOverrides,
        };
        finalStates.push(finalState);
        if (finalState.phase === 'manual_gate' && finalState.manualGate !== null) {
          await saveState(runStatePath, finalState);
        }

        return {
          finalState,
          waitingForOperatorGuidance: outcome.waitingForOperatorGuidance ?? false,
          waitingForManualGate:
            outcome.waitingForManualGate ??
            (finalState.phase === 'manual_gate' && finalState.manualGate !== null),
          stopRequestedAfterScope: outcome.stopRequestedAfterScope ?? false,
        };
      },
    },
  };
}

async function saveFixtureRun(cwd: string, runId: string, planName = 'A.md') {
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, 'plans', planName);
  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'base-commit',
  );

  return saveState(getRunStatePath(runDir), initialState);
}

test('shared atomic writers replace files and remove failed temp files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-atomic-writer-'));
  const jsonPath = join(root, 'nested', 'state.json');

  await writeJsonAtomic(jsonPath, { version: 1, status: 'old' });
  await writeJsonAtomic(jsonPath, { version: 1, status: 'new' });

  assert.equal(await readFile(jsonPath, 'utf8'), '{\n  "version": 1,\n  "status": "new"\n}\n');

  const directoryTarget = join(root, 'directory-target');
  await mkdir(directoryTarget);
  await assert.rejects(() => writeTextAtomic(directoryTarget, 'cannot replace a directory\n'));

  const entries = await readdir(root);
  assert.equal(entries.some((entry) => entry.endsWith('.tmp')), false);
});

test('createPlanAndExecuteQueue persists queue state and an independent current-queue pointer', async () => {
  const { cwd } = await createQueueFixture('neal-queue-create-', ['A.md', 'B.md']);
  const currentRunPointerPath = getCurrentRunPointerPath(cwd);
  const existingCurrentRunPointer = '{"sentinel":true}\n';
  await mkdir(join(cwd, '.neal'), { recursive: true });
  await writeFile(currentRunPointerPath, existingCurrentRunPointer, 'utf8');

  const queue = await createPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
  });

  assert.match(queue.queueId, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.equal(queue.cwd, cwd);
  assert.equal(queue.status, 'running');
  assert.equal(queue.currentIndex, 0);
  assert.deepEqual(queue.requestedPlans, ['plans/A.md', 'plans/B.md']);
  assert.deepEqual(queue.allowedDirtyPlanPaths, ['plans/A.md', 'plans/B.md']);
  assert.deepEqual(
    queue.items.map((item) => ({
      index: item.index,
      requestedPlanPath: item.requestedPlanPath,
      resolvedPlanPath: item.resolvedPlanPath,
      status: item.status,
      activeStage: item.activeStage,
    })),
    [
      {
        index: 0,
        requestedPlanPath: 'plans/A.md',
        resolvedPlanPath: 'plans/A.md',
        status: 'pending',
        activeStage: null,
      },
      {
        index: 1,
        requestedPlanPath: 'plans/B.md',
        resolvedPlanPath: 'plans/B.md',
        status: 'pending',
        activeStage: null,
      },
    ],
  );

  const loaded = await loadPlanAndExecuteQueueState(getPlanAndExecuteQueueStatePath(cwd, queue.queueId));
  assert.deepEqual(loaded, queue);

  const currentQueuePointer = await readCurrentPlanAndExecuteQueuePointer(cwd);
  assert.deepEqual(currentQueuePointer, {
    version: 1,
    queueId: queue.queueId,
    queueStatePath: `.neal/queues/${queue.queueId}/QUEUE_STATE.json`,
    status: 'running',
    currentIndex: 0,
    activeStage: null,
    activeRunId: null,
    updatedAt: queue.updatedAt,
  });
  assert.equal(await readFile(getCurrentPlanAndExecuteQueuePointerPath(cwd), 'utf8'), JSON.stringify(currentQueuePointer, null, 2) + '\n');
  assert.equal(await readFile(currentRunPointerPath, 'utf8'), existingCurrentRunPointer);

  const summary = await readFile(getPlanAndExecuteQueueSummaryPath(cwd, queue.queueId), 'utf8');
  assert.match(summary, /# Neal Plan-And-Execute Queue Summary/);
  assert.match(summary, /- Status: running/);
  assert.match(summary, /### Item 1: plans\/A\.md/);
  assert.match(summary, /### Item 2: plans\/B\.md/);
  assert.match(summary, /- Terminal outcome: not terminal/);
});

test('queue path helpers store repo-local paths relatively and outside paths absolutely', async () => {
  const { root, cwd } = await createQueueFixture('neal-queue-paths-', ['inside.md']);
  const outsidePlan = join(root, 'outside.md');
  await writeFile(outsidePlan, '# Outside\n', 'utf8');
  const insideAbsolutePath = join(cwd, 'plans', 'inside.md');

  const queue = await createPlanAndExecuteQueue({
    cwd,
    planDocs: [insideAbsolutePath, outsidePlan],
  });

  assert.equal(toQueueStoredPath(cwd, insideAbsolutePath), 'plans/inside.md');
  assert.equal(toQueueStoredPath(cwd, outsidePlan), outsidePlan);
  assert.deepEqual(queue.requestedPlans, ['plans/inside.md', outsidePlan]);
  assert.deepEqual(queue.allowedDirtyPlanPaths, ['plans/inside.md', outsidePlan, 'outside.md']);
  assert.equal(resolveQueueStoredPath(cwd, 'plans/inside.md'), insideAbsolutePath);
  assert.equal(resolveQueueStoredPath(cwd, outsidePlan), outsidePlan);
  assert.throws(() => resolveQueueStoredPath(cwd, '../outside.md'), /relative paths must stay within cwd/);
});

test('loadPlanAndExecuteQueueState rejects malformed statuses and non-contiguous item indices', async () => {
  const { cwd } = await createQueueFixture('neal-queue-invalid-', ['A.md', 'B.md']);
  const queue = await createPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
  });
  const statePath = getPlanAndExecuteQueueStatePath(cwd, queue.queueId);

  await writeFile(statePath, JSON.stringify({ ...queue, status: 'stalled' }, null, 2) + '\n', 'utf8');
  await assert.rejects(() => loadPlanAndExecuteQueueState(statePath), /malformed queue status/);

  const badIndices: PlanAndExecuteQueueState = {
    ...queue,
    items: queue.items.map((item, index) => (index === 1 ? { ...item, index: 3 } : item)),
  };
  await writeFile(statePath, JSON.stringify(badIndices, null, 2) + '\n', 'utf8');
  await assert.rejects(() => loadPlanAndExecuteQueueState(statePath), /non-contiguous item indices/);
});

test('queue item planReviewDebt hydration defaults an omitted legacy field to [] but rejects a present null or non-array', async () => {
  const { cwd } = await createQueueFixture('neal-queue-debt-hydration-', ['A.md']);
  const queue = await createPlanAndExecuteQueue({ cwd, planDocs: ['plans/A.md'] });
  const statePath = getPlanAndExecuteQueueStatePath(cwd, queue.queueId);

  type RawQueueState = Record<string, unknown> & { items: Record<string, unknown>[] };
  const rawWith = (mutate: (item: Record<string, unknown>) => void): RawQueueState => {
    const raw = JSON.parse(JSON.stringify(queue)) as RawQueueState;
    mutate(raw.items[0]);
    return raw;
  };

  // A queue item persisted before planReviewDebt existed omits the key entirely;
  // that genuinely-absent field defaults to an empty debt array.
  const omitted = rawWith((item) => {
    delete item.planReviewDebt;
  });
  await writeFile(statePath, JSON.stringify(omitted, null, 2) + '\n', 'utf8');
  const loaded = await loadPlanAndExecuteQueueState(statePath);
  assert.deepStrictEqual(loaded.items[0].planReviewDebt, []);

  // A PRESENT null is corrupted state that would silently erase accepted debt —
  // it must be rejected, never defaulted away.
  const explicitNull = rawWith((item) => {
    item.planReviewDebt = null;
  });
  await writeFile(statePath, JSON.stringify(explicitNull, null, 2) + '\n', 'utf8');
  await assert.rejects(() => loadPlanAndExecuteQueueState(statePath), /malformed planReviewDebt/);

  // Any other non-array value is likewise rejected as malformed.
  const nonArray = rawWith((item) => {
    item.planReviewDebt = 'not-an-array';
  });
  await writeFile(statePath, JSON.stringify(nonArray, null, 2) + '\n', 'utf8');
  await assert.rejects(() => loadPlanAndExecuteQueueState(statePath), /malformed planReviewDebt/);

  // A malformed debt ITEM inside the array is rejected by the shared validator.
  const badItem = rawWith((item) => {
    item.planReviewDebt = [{ canonicalId: 'C1' }];
  });
  await writeFile(statePath, JSON.stringify(badItem, null, 2) + '\n', 'utf8');
  await assert.rejects(() => loadPlanAndExecuteQueueState(statePath), /planReviewDebt\[0\]/);
});

test('savePlanAndExecuteQueueState persists item transitions and preserves sibling files', async () => {
  const { cwd } = await createQueueFixture('neal-queue-transition-', ['A.md']);
  const queue = await createPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
  });
  const notePath = join(getPlanAndExecuteQueueDir(cwd, queue.queueId), 'NOTE.txt');
  await writeFile(notePath, 'leave me alone\n', 'utf8');

  const transitioned = await savePlanAndExecuteQueueState({
    ...queue,
    items: [
      {
        ...queue.items[0],
        status: 'executing',
        planningRunId: 'planning-run',
        planningStatePath: '.neal/runs/planning-run/RUN_STATE.json',
        acceptedPlanPath: 'plans/A.md',
        executionRunId: 'execution-run',
        executionStatePath: '.neal/runs/execution-run/RUN_STATE.json',
        activeStage: 'execution',
        startedAt: '2026-05-07T12:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(await loadPlanAndExecuteQueueState(getPlanAndExecuteQueueStatePath(cwd, queue.queueId)), transitioned);
  assert.equal(await readFile(notePath, 'utf8'), 'leave me alone\n');
  assert.deepEqual(await readCurrentPlanAndExecuteQueuePointer(cwd), {
    version: 1,
    queueId: queue.queueId,
    queueStatePath: `.neal/queues/${queue.queueId}/QUEUE_STATE.json`,
    status: 'running',
    currentIndex: 0,
    activeStage: 'execution',
    activeRunId: 'execution-run',
    updatedAt: transitioned.updatedAt,
  });
});

test('queue child links round-trip from child run directories', async () => {
  const { cwd } = await createQueueFixture('neal-queue-link-');
  const runDir = join(cwd, '.neal', 'runs', 'child-run');
  const queueStatePath = '.neal/queues/2026-05-07T12-00-00-000Z-abcdef12/QUEUE_STATE.json';

  const link = await writeQueueChildLink({
    runDir,
    queueId: '2026-05-07T12-00-00-000Z-abcdef12',
    queueStatePath,
    itemIndex: 1,
    stage: 'planning',
    createdAt: '2026-05-07T12:00:00.000Z',
  });

  assert.deepEqual(link, {
    version: 1,
    queueId: '2026-05-07T12-00-00-000Z-abcdef12',
    queueStatePath,
    itemIndex: 1,
    stage: 'planning',
    createdAt: '2026-05-07T12:00:00.000Z',
  });
  assert.deepEqual(await readQueueChildLink(runDir), link);
  assert.equal(await readQueueChildLink(join(cwd, '.neal', 'runs', 'missing-run')), null);

  await writeFile(
    getQueueChildLinkPath(runDir),
    JSON.stringify({ ...link, stage: 'reviewing' }, null, 2) + '\n',
    'utf8',
  );
  await assert.rejects(() => readQueueChildLink(runDir), /malformed stage/);
});

test('inspectQueueChildResumeEvidence reports active failed child evidence without mutating queue state', async () => {
  const { cwd } = await createQueueFixture('neal-queue-evidence-active-failed-', ['A.md']);
  const { deps } = createFakeQueueRunner(cwd, [{ status: 'done' }, { status: 'failed' }]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(cwd, queue.queueId);
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');
  const runDir = join(cwd, '.neal', 'runs', queue.items[0].executionRunId!);

  const evidence = assertQueueEvidenceKind(await inspectQueueChildResumeEvidence({ cwd, runDir }), 'active_child');

  assert.equal(evidence.queueId, queue.queueId);
  assert.equal(evidence.itemIndex, 0);
  assert.equal(evidence.stage, 'execution');
  assert.equal(evidence.queueStatus, 'failed');
  assert.equal(evidence.itemStatus, 'failed');
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
});

test('inspectQueueChildResumeEvidence reports consumed child evidence without mutating queue state', async () => {
  const { cwd } = await createQueueFixture('neal-queue-evidence-consumed-', ['A.md']);
  const { deps } = createFakeQueueRunner(cwd, [{ status: 'done' }, { status: 'done' }]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(cwd, queue.queueId);
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');
  const runDir = join(cwd, '.neal', 'runs', queue.items[0].executionRunId!);

  const evidence = assertQueueEvidenceKind(await inspectQueueChildResumeEvidence({ cwd, runDir }), 'consumed_child');

  assert.equal(evidence.queueId, queue.queueId);
  assert.equal(evidence.itemIndex, 0);
  assert.equal(evidence.stage, 'execution');
  assert.match(evidence.reason, /already been consumed/);
  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
});

test('runPlanAndExecuteQueue composes one planning child and one execution child', async () => {
  const { cwd } = await createQueueFixture('neal-queue-run-one-', ['A.md']);
  const { calls, finalStates, deps } = createFakeQueueRunner(
    cwd,
    [
      { status: 'done', stateOverrides: { reviewerSessionHandle: 'planning-child-reviewer-session' } },
      { status: 'done' },
    ],
    [' M plans/A.md', ''],
  );

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'completed');
  assert.equal(queue.currentIndex, 1);
  assert.equal(queue.completedAt !== null, true);
  assert.deepEqual(calls, [
    {
      stage: 'planning',
      planDoc: join(cwd, 'plans', 'A.md'),
      itemIndex: 0,
      allowedDirtyPaths: [],
      squashOnCompletion: true,
    },
    {
      stage: 'execution',
      planDoc: join(cwd, 'plans', 'A.md'),
      itemIndex: 0,
      allowedDirtyPaths: [join(cwd, 'plans', 'A.md')],
      squashOnCompletion: true,
    },
  ]);

  const item = queue.items[0];
  assert.equal(item.status, 'completed');
  assert.equal(item.planningRunId, 'planning-1');
  assert.equal(item.planningStatePath, '.neal/runs/planning-1/RUN_STATE.json');
  assert.equal(item.acceptedPlanPath, 'plans/A.md');
  assert.equal(item.executionRunId, 'execution-2');
  assert.equal(item.executionStatePath, '.neal/runs/execution-2/RUN_STATE.json');
  assert.equal(item.activeStage, null);
  assert.equal(item.completedAt !== null, true);

  const planningLink = await readQueueChildLink(join(cwd, '.neal', 'runs', 'planning-1'));
  assert.equal(planningLink?.queueId, queue.queueId);
  assert.equal(planningLink?.queueStatePath, `.neal/queues/${queue.queueId}/QUEUE_STATE.json`);
  assert.equal(planningLink?.itemIndex, 0);
  assert.equal(planningLink?.stage, 'planning');

  const executionLink = await readQueueChildLink(join(cwd, '.neal', 'runs', 'execution-2'));
  assert.equal(executionLink?.queueId, queue.queueId);
  assert.equal(executionLink?.itemIndex, 0);
  assert.equal(executionLink?.stage, 'execution');

  const executionState = await loadState(join(cwd, '.neal', 'runs', 'execution-2', 'RUN_STATE.json'));
  assert.equal(finalStates[0]?.reviewerSessionHandle, 'planning-child-reviewer-session');
  assert.equal(executionState.reviewerSessionHandle, null);

  const summary = await readFile(getPlanAndExecuteQueueSummaryPath(cwd, queue.queueId), 'utf8');
  assert.match(summary, /- Status: completed/);
  assert.match(summary, /- Terminal outcome: completed/);
  assert.match(summary, /- Planning run: planning-1 \(\.neal\/runs\/planning-1\/RUN_STATE\.json\)/);
  assert.match(summary, /- Execution run: execution-2 \(\.neal\/runs\/execution-2\/RUN_STATE\.json\)/);
});

const ACCEPTED_PLAN_REVIEW_DEBT: OrchestrationState['planReviewDebt'] = [
  {
    id: 'R3-F1',
    canonicalId: 'C3',
    status: 'deferred',
    files: ['plans/A.md'],
    claim: 'Verification should pin the retry-count behavior.',
    evidence: '',
    requiredAction: 'Add an executable oracle for retry counting.',
    coderDisposition: null,
    coderCommit: null,
    findingClass: 'verification_hardening',
    originRound: 3,
  },
];

test('runPlanAndExecuteQueue carries the accepted plan-review debt from planning onto the execution child', async () => {
  const { cwd } = await createQueueFixture('neal-queue-debt-handoff-', ['A.md']);
  const { itemDebts, deps } = createFakeQueueRunner(
    cwd,
    [
      { status: 'done', stateOverrides: { planReviewDebt: ACCEPTED_PLAN_REVIEW_DEBT } },
      { status: 'done' },
    ],
    [' M plans/A.md', ''],
  );

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'completed');
  // completePlanningStage persisted the accepted debt onto the item.
  assert.deepStrictEqual(queue.items[0].planReviewDebt, ACCEPTED_PLAN_REVIEW_DEBT);
  // The planning child saw no inherited debt; the execution child receives the
  // accepted plan's debt via args.item.planReviewDebt.
  assert.deepStrictEqual(itemDebts, [
    { stage: 'planning', planReviewDebt: [] },
    { stage: 'execution', planReviewDebt: ACCEPTED_PLAN_REVIEW_DEBT },
  ]);

  // The debt survives a full queue-state reload.
  const loaded = await loadPlanAndExecuteQueueState(getPlanAndExecuteQueueStatePath(cwd, queue.queueId));
  assert.deepStrictEqual(loaded.items[0].planReviewDebt, ACCEPTED_PLAN_REVIEW_DEBT);
});

test('continuePlanAndExecuteQueueFromChildRun persists resumed planning debt and passes it to the execution stage', async () => {
  const { cwd } = await createQueueFixture('neal-queue-debt-resume-', ['A.md']);
  const { itemDebts, deps } = createFakeQueueRunner(cwd, [{ status: 'failed' }, { status: 'done' }]);

  // The planning child halts, so the queue stops after planning.
  const failedQueue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const failedPlanningStatePath = resolveQueueStoredPath(cwd, failedQueue.items[0].planningStatePath!);
  const resumedChildState = await loadState(failedPlanningStatePath);
  // The resumed planning child now accepts a plan carrying plan-review debt.
  const childResult: ExecuteRunResult = {
    finalState: {
      ...resumedChildState,
      status: 'done',
      phase: 'done',
      planDoc: join(cwd, 'plans', 'A.md'),
      planReviewDebt: ACCEPTED_PLAN_REVIEW_DEBT,
    },
    waitingForOperatorGuidance: false,
    waitingForManualGate: false,
    stopRequestedAfterScope: false,
  };

  const completedQueue = await continuePlanAndExecuteQueueFromChildRun({
    childResult,
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(completedQueue?.status, 'completed');
  // completePlanningStage (via the resume path) persisted the debt onto the item.
  assert.deepStrictEqual(completedQueue?.items[0].planReviewDebt, ACCEPTED_PLAN_REVIEW_DEBT);
  // The debt survives a queue-state reload...
  const loaded = await loadPlanAndExecuteQueueState(getPlanAndExecuteQueueStatePath(cwd, completedQueue!.queueId));
  assert.deepStrictEqual(loaded.items[0].planReviewDebt, ACCEPTED_PLAN_REVIEW_DEBT);
  // ...and reaches the execution stage.
  assert.deepStrictEqual(itemDebts.at(-1), { stage: 'execution', planReviewDebt: ACCEPTED_PLAN_REVIEW_DEBT });
});

test('runPlanAndExecuteQueue cleans plan-stage side effects before execution', async () => {
  const { cwd } = await createQueueFixture('neal-queue-plan-side-effects-', ['A.md']);
  const { calls, cleanCalls, deps, restoreCalls } = createFakeQueueRunner(
    cwd,
    [
      { status: 'done' },
      { status: 'done' },
    ],
    [
      '',
      [' M plans/A.md', ' M go.work.sum', '?? planner.tmp'].join('\n'),
      ' M plans/A.md',
      ' M plans/A.md',
    ],
  );

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'completed');
  assert.deepEqual(calls.map((call) => call.stage), ['planning', 'execution']);
  assert.deepEqual(restoreCalls, [{ cwd, paths: ['go.work.sum'] }]);
  assert.deepEqual(cleanCalls, [{ cwd, paths: ['planner.tmp'] }]);
});

test('runPlanAndExecuteQueue allows repo-root plan surrogate for external queued plans', async () => {
  const { root, cwd } = await createQueueFixture('neal-queue-external-plan-surrogate-', []);
  const externalPlan = join(root, 'PLAN.md');
  await writeFile(externalPlan, '# External Plan\n', 'utf8');
  const { calls, deps } = createFakeQueueRunner(
    cwd,
    [{ status: 'done' }, { status: 'done' }],
    ['', '?? PLAN.md'],
  );

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: [externalPlan],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'completed');
  assert.deepEqual(
    calls.map((call) => call.stage),
    ['planning', 'execution'],
  );
  assert.deepEqual(queue.allowedDirtyPlanPaths.sort(), [externalPlan, 'PLAN.md'].sort());
});

test('runPlanAndExecuteQueue makes the active child run the default current run', async () => {
  const { cwd } = await createQueueFixture('neal-queue-current-child-', ['A.md']);
  await saveFixtureRun(cwd, 'old-current');
  const oldPointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as { runId: string };
  assert.equal(oldPointer.runId, 'old-current');
  const { deps } = createFakeQueueRunner(cwd, [{ status: 'done' }, { status: 'done' }]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'completed');
  const pointer = JSON.parse(await readFile(getCurrentRunPointerPath(cwd), 'utf8')) as {
    runId: string;
    runStatePath: string;
    planDoc: string;
    topLevelMode: string;
  };
  assert.equal(pointer.runId, 'execution-2');
  assert.equal(pointer.runStatePath, '.neal/runs/execution-2/RUN_STATE.json');
  assert.equal(pointer.planDoc, join(cwd, 'plans', 'A.md'));
  assert.equal(pointer.topLevelMode, 'execute');

  const resolution = await resolveRunStatePath({ cwd });
  assert.deepEqual(resolution, {
    statePath: join(cwd, '.neal', 'runs', 'execution-2', 'RUN_STATE.json'),
    runId: 'execution-2',
    source: 'current_pointer',
  });
});

test('runPlanAndExecuteQueue stops without execution when planning blocks', async () => {
  const { cwd } = await createQueueFixture('neal-queue-planning-blocked-', ['A.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [{ status: 'blocked' }]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'blocked');
  assert.equal(queue.currentIndex, 0);
  assert.deepEqual(
    calls.map((call) => call.stage),
    ['planning'],
  );
  assert.equal(queue.items[0].status, 'blocked');
  assert.equal(queue.items[0].planningRunId, 'planning-1');
  assert.equal(queue.items[0].executionRunId, null);
  assert.equal(queue.items[0].activeStage, 'planning');
  assert.match(queue.stopReason ?? '', /planning child blocked/);
});

test('runPlanAndExecuteQueue rejects unsupported provider capabilities before creating a child', async () => {
  const { cwd } = await createQueueFixture('neal-queue-provider-capability-', ['A.md']);
  const capabilities = cloneProviderCapabilities();
  capabilities.coder.toolAccess.write = false;
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-queue-readonly-coder',
      capabilities,
    }),
  );
  const { calls, deps } = createFakeQueueRunner(cwd, [{ status: 'done' }]);

  await assert.rejects(
    () =>
      runPlanAndExecuteQueue({
        cwd,
        planDocs: ['plans/A.md'],
        agentConfig: {
          planner: { provider: 'fake-queue-readonly-coder', model: null },
          coder: { provider: 'fake-queue-readonly-coder', model: null },
          reviewer: { provider: 'anthropic-claude', model: null },
        },
        deps,
      }),
    /coder role: configured provider "fake-queue-readonly-coder" is missing write tool access/,
  );

  assert.deepEqual(calls, []);
  assert.equal(await readCurrentPlanAndExecuteQueuePointer(cwd), null);
});

test('runPlanAndExecuteQueue rejects unrelated dirty worktree changes before creating a child', async () => {
  const { cwd } = await createQueueFixture('neal-queue-dirty-', ['A.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [], [' M plans/A.md\n M src/unrelated.ts']);

  await assert.rejects(
    () =>
      runPlanAndExecuteQueue({
        cwd,
        planDocs: ['plans/A.md'],
        agentConfig: getDefaultAgentConfig(),
        deps,
      }),
    /Cannot continue neal run with a dirty worktree/,
  );

  assert.deepEqual(calls, []);
  const pointer = await readCurrentPlanAndExecuteQueuePointer(cwd);
  assert.equal(pointer?.status, 'failed');
  assert.equal(pointer?.activeRunId, null);
  const failedQueue = await loadPlanAndExecuteQueueState(resolveQueueStoredPath(cwd, pointer!.queueStatePath));
  assert.equal(failedQueue.status, 'failed');
  assert.equal(failedQueue.items[0].status, 'failed');
  assert.equal(failedQueue.items[0].planningRunId, null);
  assert.match(failedQueue.stopReason ?? '', /src\/unrelated\.ts/);
});

test('runPlanAndExecuteQueue runs three items serially without replaying completed items', async () => {
  const { cwd } = await createQueueFixture('neal-queue-three-', ['A.md', 'B.md', 'C.md']);
  const { calls, deps } = createFakeQueueRunner(
    cwd,
    [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }],
  );

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md', 'plans/C.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'completed');
  assert.equal(queue.currentIndex, 3);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution', '1:planning', '1:execution', '2:planning', '2:execution'],
  );
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ['completed', 'completed', 'completed'],
  );
});

test('runPlanAndExecuteQueue stops on item two planning failure without starting later children', async () => {
  const { cwd } = await createQueueFixture('neal-queue-plan-fail-', ['A.md', 'B.md', 'C.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [
    { status: 'done' },
    { status: 'done' },
    { status: 'failed' },
  ]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md', 'plans/C.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'failed');
  assert.equal(queue.currentIndex, 1);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution', '1:planning'],
  );
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ['completed', 'failed', 'pending'],
  );
  assert.equal(queue.items[1].executionRunId, null);
  assert.match(queue.stopReason ?? '', /planning child failed/);
});

test('runPlanAndExecuteQueue stops on item two execution failure without starting item three', async () => {
  const { cwd } = await createQueueFixture('neal-queue-exec-fail-', ['A.md', 'B.md', 'C.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [
    { status: 'done' },
    { status: 'done' },
    { status: 'done' },
    { status: 'failed' },
  ]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md', 'plans/C.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'failed');
  assert.equal(queue.currentIndex, 1);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution', '1:planning', '1:execution'],
  );
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ['completed', 'failed', 'pending'],
  );
  assert.match(queue.stopReason ?? '', /execution child failed/);
});

test('runPlanAndExecuteQueue pauses after a stop request without starting the next item', async () => {
  const { cwd } = await createQueueFixture('neal-queue-pause-', ['A.md', 'B.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [
    { status: 'done' },
    { status: 'running', phase: 'coder_scope', stopRequestedAfterScope: true },
    { status: 'done' },
    { status: 'done' },
  ]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'paused');
  assert.equal(queue.currentIndex, 0);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution'],
  );
  assert.equal(queue.items[0].status, 'paused');
  assert.equal(queue.items[0].activeStage, 'execution');
  assert.equal(queue.items[1].status, 'pending');
  assert.match(queue.stopReason ?? '', /execution child paused after stop request/);

  const pausedExecutionStatePath = resolveQueueStoredPath(cwd, queue.items[0].executionStatePath!);
  const pausedExecutionState = await loadState(pausedExecutionStatePath);
  assert.equal(pausedExecutionState.status, 'paused');
  assert.equal(pausedExecutionState.phase, 'coder_scope');

  const progressJson = JSON.parse(await readFile(pausedExecutionState.progressJsonPath, 'utf8'));
  assert.equal(progressJson.status, 'paused');
  assert.equal(progressJson.effectiveStatus, 'paused');

  const progressMarkdown = await readFile(pausedExecutionState.progressMarkdownPath, 'utf8');
  assert.match(progressMarkdown, /- Status: paused/);
  assert.match(progressMarkdown, /- Effective status: paused/);

  const narrativeMarkdown = await readFile(join(pausedExecutionState.runDir, 'RUN_NARRATIVE.md'), 'utf8');
  assert.match(narrativeMarkdown, /- Status: paused/);
  assert.match(narrativeMarkdown, /- Effective status: paused/);
  assert.match(narrativeMarkdown, /- Type: resume/);

  const statusSnapshot = await buildStatusSnapshot({ cwd, statePath: pausedExecutionStatePath });
  assert.equal(statusSnapshot.effectiveStatus, 'paused');
  assert.equal(statusSnapshot.health.classification, 'paused');
  assert.match(renderHumanStatusSnapshot(statusSnapshot), /Resume this run: neal resume --run execution-2/);
});

test('runPlanAndExecuteQueue blocks on operator guidance without starting the next child', async () => {
  const { cwd } = await createQueueFixture('neal-queue-guidance-', ['A.md', 'B.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [
    {
      status: 'running',
      phase: 'interactive_blocked_recovery',
      waitingForOperatorGuidance: true,
    },
    { status: 'done' },
  ]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'blocked');
  assert.equal(queue.currentIndex, 0);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning'],
  );
  assert.equal(queue.items[0].status, 'blocked');
  assert.equal(queue.items[0].activeStage, 'planning');
  assert.equal(queue.items[1].status, 'pending');
  assert.match(
    queue.stopReason ?? '',
    /planning child planning-1 \(\.neal\/runs\/planning-1\/RUN_STATE\.json\) is waiting for operator guidance/,
  );
  // Assert the structured public-status token and the resume token; the
  // operator-guidance sentence is prose and is not asserted verbatim.
  assert.match(queue.stopReason ?? '', /public status: waiting_for_guidance/);
  assert.match(queue.stopReason ?? '', /neal resume --run planning-1 --message/);

  const summary = await readFile(getPlanAndExecuteQueueSummaryPath(cwd, queue.queueId), 'utf8');
  assert.match(summary, /planning child planning-1 \(\.neal\/runs\/planning-1\/RUN_STATE\.json\)/);
  assert.match(summary, /public status: waiting_for_guidance/);
  assert.match(summary, /neal resume --run planning-1 --message/);
});

test('runPlanAndExecuteQueue summarizes execution child blocked guidance in queue state and summary', async () => {
  const { cwd } = await createQueueFixture('neal-queue-guidance-execution-', ['A.md', 'B.md']);
  const unsafeReason =
    'Unsafe advance_parent for parent objective 4 cannot proceed; failed preconditions: ' +
    'accepted derived plan is not actively executing; parent objective has no prior substantive accepted derived sub-scope. ' +
    'Reviewer rationale: prior accepted benchmark work satisfies scope 4.';
  const { calls, deps } = createFakeQueueRunner(cwd, [
    { status: 'done' },
    {
      status: 'running',
      phase: 'interactive_blocked_recovery',
      waitingForOperatorGuidance: true,
      stateOverrides: {
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
            round: 1,
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
      },
    },
    { status: 'done' },
  ]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(queue.status, 'blocked');
  assert.equal(queue.currentIndex, 0);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution'],
  );
  assert.equal(queue.items[0].status, 'blocked');
  assert.equal(queue.items[0].activeStage, 'execution');
  assert.equal(queue.items[0].executionRunId, 'execution-2');
  assert.equal(queue.items[0].executionStatePath, '.neal/runs/execution-2/RUN_STATE.json');
  assert.equal(queue.items[1].status, 'pending');
  assert.match(
    queue.stopReason ?? '',
    /execution child execution-2 \(\.neal\/runs\/execution-2\/RUN_STATE\.json\) is waiting for operator guidance/,
  );
  // Assert the structured public-status token, the scope-accounting guardrail
  // category, the resume token, and that raw internals are redacted; the
  // operator-guidance sentence is prose and is not asserted verbatim.
  assert.match(queue.stopReason ?? '', /public status: waiting_for_guidance/);
  assert.match(queue.stopReason ?? '', /scope-accounting guardrail/);
  assert.match(queue.stopReason ?? '', /neal resume --run execution-2 --message "Accept scope 4 as already satisfied/);
  assert.doesNotMatch(queue.stopReason ?? '', /accepted derived plan is not actively executing/);

  const summary = await readFile(getPlanAndExecuteQueueSummaryPath(cwd, queue.queueId), 'utf8');
  assert.match(summary, /Execution run: execution-2 \(\.neal\/runs\/execution-2\/RUN_STATE\.json\)/);
  assert.match(summary, /public status: waiting_for_guidance/);
  assert.match(summary, /scope-accounting guardrail/);
  assert.match(summary, /neal resume --run execution-2 --message "Accept scope 4 as already satisfied/);
  assert.doesNotMatch(summary, /accepted derived plan is not actively executing/);
});

test('runPlanAndExecuteQueue pauses when execution child waits for a manual gate without rewriting child status', async () => {
  const { cwd } = await createQueueFixture('neal-queue-manual-gate-', ['A.md', 'B.md']);
  const manualGate = {
    id: 'approval',
    title: 'Approve deployment',
    reason: 'External approval is required.',
    instructionsPath: join(cwd, '.neal', 'runs', 'execution-2', 'GATE-approval.md'),
    resumeChecks: [
      {
        type: 'command' as const,
        name: 'approval file',
        command: ['test', '-f', 'approved.txt'],
      },
    ],
    resumePhase: 'coder_scope' as const,
    createdAt: '2026-04-25T18:00:00.000Z',
    updatedAt: '2026-04-25T18:00:00.000Z',
    lastCheckedAt: null,
    lastFailure: null,
  };
  const { calls, deps } = createFakeQueueRunner(cwd, [
    { status: 'done' },
    { status: 'running', phase: 'manual_gate', manualGate },
  ]);

  const queue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const childStatePath = resolveQueueStoredPath(cwd, queue.items[0].executionStatePath!);
  const childState = await loadState(childStatePath);

  assert.equal(queue.status, 'paused');
  assert.equal(queue.currentIndex, 0);
  assert.equal(queue.items[0].status, 'paused');
  assert.equal(queue.items[1].status, 'pending');
  assert.match(queue.stopReason ?? '', /execution child is waiting for manual gate approval/);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution'],
  );
  assert.equal(childState.status, 'running');
  assert.equal(childState.phase, 'manual_gate');
  assert.equal(childState.manualGate?.id, 'approval');
});

test('continuePlanAndExecuteQueueFromChildRun advances after a resumed child completes', async () => {
  const { cwd } = await createQueueFixture('neal-queue-resumed-', ['A.md', 'B.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [
    { status: 'done' },
    { status: 'running', phase: 'coder_scope', stopRequestedAfterScope: true },
    { status: 'done' },
    { status: 'done' },
  ]);

  const pausedQueue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md', 'plans/B.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const pausedExecutionStatePath = resolveQueueStoredPath(cwd, pausedQueue.items[0].executionStatePath!);
  const resumedChildState = await loadState(pausedExecutionStatePath);
  const childResult: ExecuteRunResult = {
    finalState: {
      ...resumedChildState,
      status: 'done',
      phase: 'done',
    },
    waitingForOperatorGuidance: false,
    waitingForManualGate: false,
    stopRequestedAfterScope: false,
  };

  const completedQueue = await continuePlanAndExecuteQueueFromChildRun({
    childResult,
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(completedQueue?.status, 'completed');
  assert.equal(completedQueue?.currentIndex, 2);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution', '1:planning', '1:execution'],
  );
  assert.deepEqual(
    completedQueue?.items.map((item) => item.status),
    ['completed', 'completed'],
  );
});

test('continuePlanAndExecuteQueueFromChildRun completes a resumed failed execution child after success', async () => {
  const { cwd } = await createQueueFixture('neal-queue-resumed-failed-execution-', ['A.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [{ status: 'done' }, { status: 'failed' }]);

  const failedQueue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(cwd, failedQueue.queueId);
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');
  const failedExecutionStatePath = resolveQueueStoredPath(cwd, failedQueue.items[0].executionStatePath!);
  const resumedChildState = await loadState(failedExecutionStatePath);
  const childResult: ExecuteRunResult = {
    finalState: {
      ...resumedChildState,
      status: 'done',
      phase: 'done',
    },
    waitingForOperatorGuidance: false,
    waitingForManualGate: false,
    stopRequestedAfterScope: false,
  };

  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
  const completedQueue = await continuePlanAndExecuteQueueFromChildRun({
    childResult,
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(completedQueue?.status, 'completed');
  assert.equal(completedQueue?.currentIndex, 1);
  assert.equal(completedQueue?.items[0].status, 'completed');
  assert.equal(completedQueue?.items[0].activeStage, null);
  assert.notEqual(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution'],
  );
});

test('continuePlanAndExecuteQueueFromChildRun advances from resumed failed planning child into execution', async () => {
  const { cwd } = await createQueueFixture('neal-queue-resumed-failed-planning-', ['A.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [{ status: 'failed' }, { status: 'done' }]);

  const failedQueue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    deps,
  });
  const queueStatePath = getPlanAndExecuteQueueStatePath(cwd, failedQueue.queueId);
  const beforeQueueStateBytes = await readFile(queueStatePath, 'utf8');
  const failedPlanningStatePath = resolveQueueStoredPath(cwd, failedQueue.items[0].planningStatePath!);
  const resumedChildState = await loadState(failedPlanningStatePath);
  const childResult: ExecuteRunResult = {
    finalState: {
      ...resumedChildState,
      status: 'done',
      phase: 'done',
      planDoc: join(cwd, 'plans', 'A.md'),
    },
    waitingForOperatorGuidance: false,
    waitingForManualGate: false,
    stopRequestedAfterScope: false,
  };

  assert.equal(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
  const completedQueue = await continuePlanAndExecuteQueueFromChildRun({
    childResult,
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(completedQueue?.status, 'completed');
  assert.equal(completedQueue?.currentIndex, 1);
  assert.equal(completedQueue?.items[0].status, 'completed');
  assert.equal(completedQueue?.items[0].acceptedPlanPath, 'plans/A.md');
  assert.equal(completedQueue?.items[0].executionRunId, 'execution-2');
  assert.equal(completedQueue?.items[0].activeStage, null);
  assert.notEqual(await readFile(queueStatePath, 'utf8'), beforeQueueStateBytes);
  assert.deepEqual(
    calls.map((call) => `${call.itemIndex}:${call.stage}`),
    ['0:planning', '0:execution'],
  );
});

test('continuePlanAndExecuteQueueFromChildRun carries --no-squash into the execution child after a resumed planning child', async () => {
  const { cwd } = await createQueueFixture('neal-queue-resumed-no-squash-', ['A.md']);
  const { calls, deps } = createFakeQueueRunner(cwd, [{ status: 'failed' }, { status: 'done' }]);

  // Original `neal run --no-squash`: the planning child halts and is later
  // resumed in a separate process where the queue arg is no longer supplied.
  const failedQueue = await runPlanAndExecuteQueue({
    cwd,
    planDocs: ['plans/A.md'],
    agentConfig: getDefaultAgentConfig(),
    squashOnCompletion: false,
    deps,
  });
  assert.equal(calls[0]?.squashOnCompletion, false);

  const failedPlanningStatePath = resolveQueueStoredPath(cwd, failedQueue.items[0].planningStatePath!);
  const resumedChildState = await loadState(failedPlanningStatePath);
  // The resumed child's persisted state retained the preference from creation.
  assert.equal(resumedChildState.autoSquashOnCompletion, false);
  const childResult: ExecuteRunResult = {
    finalState: {
      ...resumedChildState,
      status: 'done',
      phase: 'done',
      planDoc: join(cwd, 'plans', 'A.md'),
    },
    waitingForOperatorGuidance: false,
    waitingForManualGate: false,
    stopRequestedAfterScope: false,
  };

  // Continuation does NOT re-supply squashOnCompletion; it must derive it from
  // the resumed child's finalState so the execution child stays unsquashed.
  const completedQueue = await continuePlanAndExecuteQueueFromChildRun({
    childResult,
    agentConfig: getDefaultAgentConfig(),
    deps,
  });

  assert.equal(completedQueue?.status, 'completed');
  const executionCall = calls.find((call) => call.stage === 'execution');
  assert.equal(executionCall?.squashOnCompletion, false);
});
