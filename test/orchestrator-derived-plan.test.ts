import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadOrInitialize, runOnePass } from '../src/neal/orchestrator.js';
import { clearConfigCache } from '../src/neal/config.js';
import { createRunLogger } from '../src/neal/logger.js';
import { clearProviderCapabilitiesOverridesForTesting, clearProviderDefinitionRegistrationsForTesting, registerProviderDefinitionForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { type CoderRunPromptArgs, type CoderStructuredPromptArgs, type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { flushDerivedPlanNotifications } from '../src/neal/orchestrator/notifications.js';
import { runPlanReviewPhase, runPlanningResponsePhase } from '../src/neal/orchestrator/phases/planning.js';
import { applyInteractiveBlockedRecoveryDisposition, recordInteractiveBlockedRecoveryGuidance } from '../src/neal/orchestrator/phases/recovery.js';
import { adoptAcceptedDerivedPlan } from '../src/neal/orchestrator/transitions.js';
import { getDefaultAgentConfig, loadState, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { writeRepoConfig, createResumeFixture, writeRawResumeState, createNotifyCapture, runGit, readRunEvents, createExecuteFinalizationFixture } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-derived-plan');

test('recovered blocked derived-plan review keeps derived-plan identity through acceptance', async () => {
  const { statePath, state: initialState } = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'reviewer_plan',
    status: 'running',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    maxDerivedPlanReviewRounds: 1,
  });
  const derivedPlanPath = join(initialState.runDir, 'DERIVED_PLAN_SCOPE_4.md');
  const parentPlan = [
    '# Parent Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    '### Scope 1: First scope',
    '- Goal: Complete the first parent scope.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The first parent scope is complete.',
    '',
    '### Scope 2: Second scope',
    '- Goal: Complete the second parent scope.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The second parent scope is complete.',
    '',
    '### Scope 3: Third scope',
    '- Goal: Complete the third parent scope.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The third parent scope is complete.',
    '',
    '### Scope 4: Split-prone scope',
    '- Goal: Complete the broad parent scope that may need a derived plan.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: The parent scope is complete.',
    '',
  ].join('\n');
  const derivedPlan = [
    '# Derived Plan For Scope 4',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope_unknown',
    '',
    '## Execution Loop',
    '',
    '### Recurring Scope',
    '- Goal: Complete one bounded replacement slice.',
    '- Verification: `pnpm typecheck`',
    '- Success Condition: One replacement slice is complete and reviewable.',
    '',
    '## Completion Condition',
    '',
    'Stop when the replacement queue is exhausted.',
    '',
  ].join('\n');
  await writeFile(initialState.planDoc, parentPlan, 'utf8');
  await writeFile(derivedPlanPath, derivedPlan, 'utf8');
  const state = await saveState(statePath, {
    ...initialState,
    agentConfig: {
      ...initialState.agentConfig,
      planner: { provider: 'fake-planner-recovery', model: null },
    },
    plannerSessionHandle: 'planner-derived-plan-response-prior',
    plannerSessionProtocol: 'structured_json_v1',
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
    findings: [],
    rounds: [],
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  const reviewerPrompts: string[] = [];
  const coderPrompts: string[] = [];
  const plannerResumeHandles: Array<string | null | undefined> = [];
  let reviewRound = 0;

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          reviewerPrompts.push(args.prompt);
          reviewRound += 1;
          if (reviewRound === 1) {
            return {
              sessionHandle: 'reviewer-derived-blocking',
              structured: {
                summary: 'The derived plan still needs a bounded execution contract.',
                executionShape: 'multi_scope_unknown',
                findings: [
                  {
                    severity: 'blocking',
                    files: [derivedPlanPath],
                    claim: 'The derived plan needs one concrete recovery clarification.',
                    requiredAction: 'Clarify the recovery sequence before adoption.',
                  },
                ],
              } as TStructured,
            };
          }

          return {
            sessionHandle: 'reviewer-derived-accepted',
            structured: {
              summary: 'The recovered derived plan is ready to execute.',
              executionShape: 'multi_scope_unknown',
              findings: [],
            } as TStructured,
          };
        },
      };
    },
  });
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-planner-recovery',
      coderSessionHandle: 'planner-derived-plan-response-next',
      coderStructuredResponses: [
        {
          outcome: 'responded',
          summary: 'Clarified the recovery sequence in the derived plan.',
          blocker: '',
          responses: [
            {
              id: 'R1-F1',
              decision: 'fixed',
              summary: 'Added the requested concrete recovery clarification.',
            },
          ],
        },
      ],
      onCoderRun: async (args: CoderRunPromptArgs) => {
        throw new Error(`unexpected text planner plan-response prompt: ${args.prompt}`);
      },
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        plannerResumeHandles.push(args.resumeHandle);
        coderPrompts.push(args.prompt);
      },
    }),
  );

  try {
    async function assertDerivedPlanArtifacts(expectedPhase: OrchestrationState['phase']) {
      const runStateJson = JSON.parse(await readFile(statePath, 'utf8')) as Partial<OrchestrationState>;
      const progressMarkdown = await readFile(state.progressMarkdownPath, 'utf8');
      const narrativeMarkdown = await readFile(join(state.runDir, 'RUN_NARRATIVE.md'), 'utf8');

      assert.equal(runStateJson.phase, expectedPhase);
      assert.equal(runStateJson.derivedPlanPath, derivedPlanPath);
      assert.equal(progressMarkdown.includes(derivedPlanPath), true);
      assert.equal(narrativeMarkdown.includes(derivedPlanPath), true);
    }

    const afterBlockedReview = await runOnePass(state, statePath, logger);
    assert.equal(afterBlockedReview.phase, 'interactive_blocked_recovery');
    assert.equal(afterBlockedReview.status, 'running');
    assert.equal(afterBlockedReview.interactiveBlockedRecovery?.sourcePhase, 'reviewer_plan');
    assert.equal(afterBlockedReview.derivedPlanPath, derivedPlanPath);
    assert.equal(afterBlockedReview.derivedFromScopeNumber, 4);
    assert.equal(afterBlockedReview.derivedScopeIndex, null);
    assert.equal(afterBlockedReview.rounds[0]?.reviewedPlanPath, derivedPlanPath);
    await assertDerivedPlanArtifacts('interactive_blocked_recovery');

    const blockedDerivedPlanStatus = afterBlockedReview.derivedPlanStatus;
    const guidedState = await recordInteractiveBlockedRecoveryGuidance(
      statePath,
      'Resume the current derived-plan review after applying the blocking finding.',
      logger,
    );
    const resumedState = await applyInteractiveBlockedRecoveryDisposition(
      guidedState,
      statePath,
      {
        action: 'resume_current_scope',
        summary: 'Continue the derived-plan review.',
        rationale: 'The blocking finding can be handled in the same derived plan.',
        blocker: '',
        replacementPlan: '',
      },
      'coder-derived-plan-recovery',
      logger,
    );
    assert.equal(resumedState.phase, 'coder_plan_response');
    assert.equal(resumedState.plannerSessionHandle, 'planner-derived-plan-response-prior');
    assert.equal(resumedState.plannerSessionProtocol, 'structured_json_v1');
    assert.equal(resumedState.coderSessionHandle, 'coder-derived-plan-recovery');

    const afterPlanResponse = await runPlanningResponsePhase(resumedState, statePath, 'coder_plan_response', logger);
    const acceptedState = await runPlanReviewPhase(afterPlanResponse, statePath, logger);
    await assertDerivedPlanArtifacts('awaiting_derived_plan_execution');
    const eventsAfterAcceptance = await readRunEvents(state.runDir);
    const reviewerCompletionEvents = eventsAfterAcceptance.filter(
      (event) => event.type === 'phase.complete' && event.data?.phase === 'reviewer_plan',
    );

    assert.deepEqual(
      {
        blockedDerivedPlanStatus,
        resumedDerivedPlanStatus: resumedState.derivedPlanStatus,
        acceptedPhase: acceptedState.phase,
        acceptedStatus: acceptedState.status,
        acceptedDerivedPlanStatus: acceptedState.derivedPlanStatus,
        acceptedDerivedScopeIndex: acceptedState.derivedScopeIndex,
        reviewedPlanPaths: acceptedState.rounds.map((round) => round.reviewedPlanPath),
        reviewerPromptsTargetDerivedPlan: reviewerPrompts.every(
          (prompt) => prompt.includes('Review the derived implementation plan at') && prompt.includes('DERIVED_PLAN_SCOPE_4'),
        ),
        coderPromptsTargetDerivedPlan: coderPrompts.every((prompt) =>
          prompt.includes(`Continue refining the derived implementation plan at ${derivedPlanPath}`),
        ),
        plannerDidNotUseRecoverySession: plannerResumeHandles.every(
          (handle) => handle === 'planner-derived-plan-response-prior',
        ),
        acceptanceRoundWentDone: reviewerCompletionEvents.some(
          (event) => event.data?.round === 2 && event.data?.nextPhase === 'done',
        ),
        acceptanceRoundWentAwaitingDerivedExecution: reviewerCompletionEvents.some(
          (event) => event.data?.round === 2 && event.data?.nextPhase === 'awaiting_derived_plan_execution',
        ),
      },
      {
        blockedDerivedPlanStatus: 'pending_review',
        resumedDerivedPlanStatus: 'pending_review',
        acceptedPhase: 'awaiting_derived_plan_execution',
        acceptedStatus: 'running',
        acceptedDerivedPlanStatus: 'accepted',
        acceptedDerivedScopeIndex: null,
        reviewedPlanPaths: [derivedPlanPath, derivedPlanPath],
        reviewerPromptsTargetDerivedPlan: true,
        coderPromptsTargetDerivedPlan: true,
        plannerDidNotUseRecoverySession: true,
        acceptanceRoundWentDone: false,
        acceptanceRoundWentAwaitingDerivedExecution: true,
      },
    );

    const adoptedState = await runOnePass(acceptedState, statePath, logger, {
      shouldStopAfterCurrentScope() {
        return true;
      },
    });
    assert.equal(adoptedState.phase, 'coder_scope');
    assert.equal(adoptedState.status, 'running');
    assert.equal(adoptedState.derivedPlanStatus, 'accepted');
    assert.equal(adoptedState.derivedScopeIndex, 1);
    assert.equal(adoptedState.derivedPlanPath, derivedPlanPath);

    const eventsAfterAdoption = await readRunEvents(state.runDir);
    const acceptanceEventIndex = eventsAfterAdoption.findIndex(
      (event) =>
        event.type === 'phase.complete' &&
        event.data?.phase === 'reviewer_plan' &&
        event.data?.round === 2 &&
        event.data?.nextPhase === 'awaiting_derived_plan_execution',
    );
    const adoptionEventIndex = eventsAfterAdoption.findIndex(
      (event) =>
        event.type === 'phase.complete' &&
        event.data?.phase === 'awaiting_derived_plan_execution' &&
        event.data?.nextPhase === 'coder_scope' &&
        event.data?.planDoc === derivedPlanPath,
    );
    assert.notEqual(acceptanceEventIndex, -1);
    assert.notEqual(adoptionEventIndex, -1);
    assert.equal(acceptanceEventIndex < adoptionEventIndex, true);
    assert.equal(eventsAfterAdoption.some((event) => event.type === 'notify.complete'), false);
    assert.equal(
      eventsAfterAdoption.some((event) => event.type === 'run.complete' && event.data?.phase === 'done'),
      false,
    );
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('accepted derived plans reject adoption after derived execution has already created commits', async () => {
  const { state: baseState } = await createResumeFixture({
    currentScopeNumber: 5,
  });
  const state: OrchestrationState = {
    ...baseState,
    phase: 'awaiting_derived_plan_execution',
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
  };

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
  const { state: baseState } = await createResumeFixture({
    currentScopeNumber: 5,
  });
  const state: OrchestrationState = {
    ...baseState,
    phase: 'awaiting_derived_plan_execution',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
    createdCommits: [],
  };

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

test('resume promotes accepted unexecuted derived plan from poisoned done state', async () => {
  const fixture = await createResumeFixture({
    currentScopeNumber: 8,
    phase: 'done',
    status: 'done',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    createdCommits: [],
  });
  const derivedPlanPath = join(fixture.state.runDir, 'DERIVED_PLAN_SCOPE_8.md');
  await writeRawResumeState(fixture.statePath, {
    ...fixture.state,
    derivedPlanPath,
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 8,
    derivedScopeIndex: null,
  });

  const { state } = await loadOrInitialize(null, fixture.cwd, getDefaultAgentConfig(), fixture.statePath, 'execute');
  assert.equal(state.phase, 'awaiting_derived_plan_execution');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'accepted');
  assert.equal(state.derivedScopeIndex, null);
  assert.equal(state.blockedFromPhase, null);

  const events = await readRunEvents(fixture.state.runDir);
  assert.equal(events.some((event) => event.type === 'run.promoted_accepted_derived_plan_on_resume'), true);
});

test('resume promotes pending unexecuted derived plan without open findings back to derived review', async () => {
  const fixture = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'done',
    status: 'done',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    createdCommits: [],
    findings: [],
  });
  const derivedPlanPath = join(fixture.state.runDir, 'DERIVED_PLAN_SCOPE_4.md');
  await writeRawResumeState(fixture.statePath, {
    ...fixture.state,
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
  });

  const { state } = await loadOrInitialize(null, fixture.cwd, getDefaultAgentConfig(), fixture.statePath, 'execute');
  assert.equal(state.phase, 'reviewer_plan');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'pending_review');
  assert.equal(state.derivedScopeIndex, null);
  assert.equal(state.blockedFromPhase, null);

  const events = await readRunEvents(fixture.state.runDir);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'run.promoted_pending_derived_plan_on_resume')
      .map((event) => event.data?.promotedPhase),
    ['reviewer_plan'],
  );
});

test('resume promotes pending unexecuted derived plan with blocking findings to plan response', async () => {
  const fixture = await createResumeFixture({
    currentScopeNumber: 4,
    phase: 'done',
    status: 'done',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    coderSessionHandle: 'coder-session-4',
    createdCommits: [],
  });
  const derivedPlanPath = join(fixture.state.runDir, 'DERIVED_PLAN_SCOPE_4.md');
  await writeRawResumeState(fixture.statePath, {
    ...fixture.state,
    derivedPlanPath,
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 4,
    derivedScopeIndex: null,
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: [derivedPlanPath],
        claim: 'Derived plan needs a concrete execution shape.',
        requiredAction: 'Revise the derived plan.',
        status: 'open',
        roundSummary: 'Missing shape',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });

  const { state } = await loadOrInitialize(null, fixture.cwd, getDefaultAgentConfig(), fixture.statePath, 'execute');
  assert.equal(state.phase, 'coder_plan_response');
  assert.equal(state.status, 'running');
  assert.equal(state.derivedPlanPath, derivedPlanPath);
  assert.equal(state.derivedPlanStatus, 'pending_review');
  assert.equal(state.coderSessionHandle, 'coder-session-4');
  assert.equal(state.blockedFromPhase, null);
});

test('resume blocks rejected unexecuted derived plan from poisoned done state', async () => {
  const derivedPlanPath = '/tmp/DERIVED_PLAN_SCOPE_6.md';
  const { cwd, statePath, state } = await createResumeFixture({
    currentScopeNumber: 6,
    phase: 'done',
    status: 'done',
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    derivedPlanPath,
    derivedPlanStatus: 'rejected',
    derivedFromScopeNumber: 6,
    derivedScopeIndex: null,
    createdCommits: [],
  });

  const { state: resumed } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(resumed.phase, 'blocked');
  assert.equal(resumed.status, 'blocked');
  assert.equal(resumed.blockedFromPhase, 'awaiting_derived_plan_execution');
  assert.equal(resumed.derivedPlanStatus, 'rejected');
  assert.equal(resumed.derivedScopeIndex, null);
  assert.equal(resumed.completedScopes.length, state.completedScopes.length + 1);
  const blockedScope = resumed.completedScopes.find((scope) => scope.number === '6');
  assert.equal(blockedScope?.result, 'blocked');
  assert.equal(blockedScope?.replacedByDerivedPlanPath, derivedPlanPath);
  assert.match(blockedScope?.blocker ?? '', /abandoned unexecuted derived plan/);

  const events = await readRunEvents(state.runDir);
  assert.equal(events.some((event) => event.type === 'run.blocked_rejected_derived_plan_on_resume'), true);
});

test('resume leaves ordinary completed runs without derived plans unchanged', async () => {
  const { cwd, statePath } = await createResumeFixture({
    phase: 'done',
    status: 'done',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
  });

  const { state } = await loadOrInitialize(null, cwd, getDefaultAgentConfig(), statePath, 'execute');
  assert.equal(state.phase, 'done');
  assert.equal(state.status, 'done');
  assert.equal(state.derivedPlanPath, null);
  assert.equal(state.derivedPlanStatus, null);
});

test('resume keeps active derived execution on the same derived sub-scope', async () => {
  const { cwd, statePath } = await createExecuteFinalizationFixture({
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
  const { cwd, statePath } = await createExecuteFinalizationFixture({
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

test('runOnePass routes incident-style pointer-only split plans into interactive blocked recovery before resetting the committed plan artifact', async () => {
  const { cwd, statePath, state, notifyLogPath, notifyScriptPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: 'coder_scope',
    status: 'running',
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedFromScopeNumber: null,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 0,
    createdCommits: [],
  });
  // Disable the consultant so the reroute yields plainly at the
  // recovery chokepoint without a provider call; consultant dispatch is
  // covered separately by the consultant and recovery tests.
  await writeFile(
    join(cwd, 'neal.yml'),
    `neal:\n  notify_bin: ${notifyScriptPath}\n  consultant_max_attempts: 0\n`,
    'utf8',
  );
  clearConfigCache(cwd);
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
  let planCommit = '';

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text coder scope prompt');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          await mkdir(join(args.cwd, 'tmp'), { recursive: true });
          await writeFile(
            join(args.cwd, 'tmp', 'incident-derived-plan.md'),
            [
              '# Incident Derived Plan',
              '',
              '## Execution Shape',
              '',
              'executionShape: multi_scope_unknown',
              '',
              '## Execution Loop',
              '',
              '### Recurring Scope',
              '- Goal: Review one bounded DOM-contract batch.',
              '- Verification: `pnpm typecheck`',
              '- Success Condition: The batch is classified.',
              '',
              '## Completion Condition',
              '',
              'Stop when every DOM-contract candidate is classified.',
              '',
            ].join('\n'),
            'utf8',
          );
          await runGit(args.cwd, 'add', 'tmp/incident-derived-plan.md');
          await runGit(args.cwd, 'commit', '-m', 'Split DOM contract sweep scope');
          planCommit = await runGit(args.cwd, 'rev-parse', 'HEAD');

          return {
            sessionHandle: 'coder-split-plan-incident',
            structured: {
              action: 'split_plan',
              message: 'The implementation scope is too broad and needs a recurring derived plan.',
              progress: {
                milestoneTargeted: 'Replace the current scope with a derived DOM-contract sweep plan.',
                newEvidence: 'The implementation scope is too broad and needs a recurring derived plan.',
                whyNotRedundant: 'The existing parent scope cannot safely carry the full candidate queue in one pass.',
                nextStepUnlocked: 'Derived-plan review can validate the replacement scope shape.',
              },
              manualGate: null,
              derivedPlan: `Use tmp/incident-derived-plan.md from commit ${planCommit}.`,
              blockedReason: '',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    await assert.rejects(
      () =>
        runOnePass(state, statePath, logger, {
          onDisplayState(displayState) {
            if (displayState.phase === 'interactive_blocked_recovery') {
              throw new Error('test stop after split-plan interactive recovery checkpoint');
            }
          },
        }),
      /test stop after split-plan interactive recovery checkpoint/,
    );
    const nextState = await loadState(statePath);

    assert.notEqual(planCommit, '');
    assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), planCommit);
    assert.match(await runGit(cwd, 'show', `${planCommit}:tmp/incident-derived-plan.md`), /executionShape: multi_scope_unknown/);
    assert.match(await readFile(join(cwd, 'tmp', 'incident-derived-plan.md'), 'utf8'), /Execution Loop/);
    await assert.rejects(readFile(join(state.runDir, 'DERIVED_PLAN_SCOPE_5.md'), 'utf8'), /ENOENT/);

    const invalidPayloadArtifact = await readFile(join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'), 'utf8');
    assert.match(invalidPayloadArtifact, /This artifact is diagnostic only/);
    assert.match(invalidPayloadArtifact, /Use tmp\/incident-derived-plan\.md from commit/);
    assert.match(invalidPayloadArtifact, /Missing required `## Execution Shape` section/);

    // The recoverable invalid split-plan payload now routes through the single
    // interactive blocked-recovery chokepoint, not a support round.
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.topLevelMode, 'execute');
    assert.equal(nextState.blockedFromPhase, 'coder_scope');
    assert.equal(nextState.interactiveBlockedRecovery?.sourcePhase, 'coder_scope');
    assert.match(nextState.interactiveBlockedRecovery?.blockedReason ?? '', /not a valid Neal-executable plan/);
    assert.equal(nextState.lastScopeMarker, 'AUTONOMY_SPLIT_PLAN');
    assert.equal(nextState.derivedPlanPath, null);
    assert.equal(nextState.derivedPlanStatus, null);
    assert.equal(nextState.completedScopes.some((scope) => scope.result === 'blocked'), false);
    // No support round is constructed any more, and the disabled consultant
    // leaves no advice on the recovery state.
    assert.equal(nextState.recentBlocks.length, 0);
    assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null);

    const events = await readRunEvents(state.runDir);
    const invalidEvent = events.find((event) => event.type === 'split_plan.invalid_payload');
    assert.ok(invalidEvent);
    assert.equal(invalidEvent.data?.sourcePhase, 'coder_scope');
    assert.equal(invalidEvent.data?.resetSkipped, true);
    assert.deepEqual(invalidEvent.data?.createdCommits, [planCommit]);
    const recoveryEvent = events.find((event) => event.type === 'split_plan.invalid_payload_recovery_started');
    assert.ok(recoveryEvent);
    assert.equal(recoveryEvent.data?.sourcePhase, 'coder_scope');
    assert.equal(recoveryEvent.data?.invalidPayloadPath, join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md'));
    // The disabled consultant emits no consultant.* events.
    assert.equal(events.some((event) => event.type.startsWith('consultant.')), false);
    assert.ok(events.some((event) => event.type === 'notify.blocked'));
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /not a valid Neal-executable plan/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
