import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFinalCompletionReviewPhase, runExecuteFinalizationPhase, runOnePass } from '../src/neal/orchestrator.js';
import { getFinalCompletionReviewArtifactPath } from '../src/neal/final-completion-review.js';
import { createRunLogger } from '../src/neal/logger.js';
import { clearProviderCapabilitiesOverridesForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { NealProviderError, type CoderStructuredPromptArgs, type StructuredAdvisorRoundArgs } from '../src/neal/providers/types.js';
import { getDefaultAgentConfig, loadState, saveState } from '../src/neal/state.js';
import { writeRepoConfig, createNotifyCapture, runGit, readRunEvents, delay, createExecuteFinalizationFixture, createEmptyExecuteFinalizationFixture, createDerivedPlanExecutionFixture, readEvents } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-final-completion');

test('runOnePass accepts whole-plan completion only after reviewer final completion verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-accept-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
              squashCommitMessage: {
                subject: 'Complete final plan outcome',
                bullets: [
                  'Deliver the requested execute-mode behavior across the completed work.',
                  'Verify the integrated result has no remaining known gaps.',
                ],
              },
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
    assert.match(notifyLog, /implementation complete/);
    assert.doesNotMatch(notifyLog, /plan complete/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review accepts completion without a reviewer-authored squash draft', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: 'final-5',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the stale final-completion reconciliation.',
      verificationSummary: 'Ran final-completion review regression coverage.',
      remainingKnownGaps: [],
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
        summary: 'Completed the stale final-completion reconciliation.',
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          return {
            sessionHandle: 'reviewer-final-completion-no-squash-draft',
            structured: {
              action: 'accept_complete',
              summary: 'The plan outcome is complete and coherent.',
              rationale: 'The accepted terminal scope satisfies the plan with no remaining known gaps.',
              missingWork: null,
              squashCommitMessage: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath, logger);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');
    assert.equal(nextState.finalCompletionReviewVerdict?.action, 'accept_complete');
    assert.equal(nextState.finalCompletionReviewVerdict?.squashCommitMessage, null);
    assert.equal(nextState.finalCompletionResolvedAction, 'accept_complete');

    const persisted = await loadState(statePath);
    assert.equal(persisted.phase, 'done');
    assert.equal(persisted.status, 'done');
    assert.equal(persisted.finalCompletionReviewVerdict?.squashCommitMessage, null);

    const events = await readRunEvents(state.runDir);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'phase.complete' &&
          event.data?.phase === 'final_completion_review' &&
          event.data?.resultingAction === 'accept_complete',
      ),
      true,
    );

    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(state.runDir), 'utf8');
    assert.match(completionArtifact, /- Reviewer action: accept_complete/);
    assert.match(completionArtifact, /No reviewer-authored squash draft recorded/);
    assert.match(completionArtifact, /derive the squash message from deterministic fallback generation/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review discards reviewer-created worktree dirt before accepting completion', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: 'final-5',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed final-completion verification cleanup.',
      verificationSummary: 'Simulated a reviewer verification command that dirtied the worktree.',
      remainingKnownGaps: [],
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
        summary: 'Completed final-completion verification cleanup.',
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          await writeFile(join(state.cwd, 'scope.txt'), 'base\nchange\nreview dirt\n', 'utf8');
          await writeFile(join(state.cwd, 'reviewer.tmp'), 'temporary reviewer output\n', 'utf8');
          return {
            sessionHandle: 'reviewer-final-completion-dirty-worktree',
            structured: {
              action: 'accept_complete',
              summary: 'The plan outcome is complete and coherent.',
              rationale: 'Verification passed; no remaining known gaps.',
              missingWork: null,
              squashCommitMessage: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath, logger);
    assert.equal(nextState.phase, 'done');
    assert.equal(nextState.status, 'done');
    assert.equal(nextState.finalCompletionResolvedAction, 'accept_complete');

    assert.equal(await runGit(state.cwd, 'status', '--short', '--untracked-files=all', '--', 'scope.txt', 'reviewer.tmp'), '');
    assert.equal(await readFile(join(state.cwd, 'scope.txt'), 'utf8'), 'base\nchange\n');

    const events = await readRunEvents(state.runDir);
    const cleanupEvent = events.find((event) => event.type === 'final_completion_review.discarded_dirty_worktree');
    assert.ok(cleanupEvent);
    assert.match(String(cleanupEvent.data?.statusOutput), /scope\.txt/);
    assert.match(String(cleanupEvent.data?.statusOutput), /reviewer\.tmp/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// Production repro (issue pipeline, 2026-07-16): when the plan document is a
// tracked file whose committed content differs from the run's overlay (the
// pipeline seeds its plan over a leftover tracked PLAN.md), the discard's
// reset --hard silently swapped the committed plan back in mid-run and later
// completion reviews judged the diff against the wrong plan.
test('final completion discard preserves a tracked-and-modified plan document overlay', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
    phase: 'final_completion_review',
    status: 'running',
    finalCommit: 'final-5',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the overlay-preservation check.',
      verificationSummary: 'Simulated reviewer dirt to force the discard.',
      remainingKnownGaps: [],
    },
  });

  // Track a plan document with committed content, then overlay it with the
  // run's actual plan (uncommitted) — the pipeline's exact shape.
  const trackedPlanPath = join(fixtureState.cwd, 'PLAN.md');
  await writeFile(trackedPlanPath, '# committed stale plan\n', 'utf8');
  await runGit(fixtureState.cwd, 'add', 'PLAN.md');
  await runGit(fixtureState.cwd, 'commit', '-m', 'add stale tracked plan');
  const overlayContent = '# seeded run plan overlay\n\n## Execution Shape\n\nexecutionShape: one_shot\n';
  await writeFile(trackedPlanPath, overlayContent, 'utf8');

  const state = await saveState(statePath, {
    ...fixtureState,
    planDoc: trackedPlanPath,
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
        summary: 'Completed the overlay-preservation check.',
        commitSubject: 'finish scope 5',
        changedFiles: ['scope.txt'],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-final.md',
        blocker: null,
        derivedFromParentScope: null,
        replacedByDerivedPlanPath: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          await writeFile(join(state.cwd, 'reviewer.tmp'), 'reviewer dirt\n', 'utf8');
          return {
            sessionHandle: 'reviewer-final-completion-plan-overlay',
            structured: {
              action: 'accept_complete',
              summary: 'The plan outcome is complete and coherent.',
              rationale: 'Verification passed; no remaining known gaps.',
              missingWork: null,
              squashCommitMessage: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath, logger);
    assert.equal(nextState.phase, 'done');

    // The reviewer dirt is gone, but the plan overlay survived the reset.
    assert.equal(await runGit(state.cwd, 'status', '--short', '--untracked-files=all', '--', 'reviewer.tmp'), '');
    assert.equal(await readFile(trackedPlanPath, 'utf8'), overlayContent);

    const events = await readRunEvents(state.runDir);
    const cleanupEvent = events.find((event) => event.type === 'final_completion_review.discarded_dirty_worktree');
    assert.ok(cleanupEvent, 'discard should still fire for genuine reviewer dirt');
    // The plan overlay is wrapper-owned, not reviewer dirt: it must not be the
    // trigger and must not appear in the discard report.
    assert.doesNotMatch(String(cleanupEvent.data?.statusOutput), /PLAN\.md/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass accepts one-shot whole-plan completion after final completion review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-one-shot-accept-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
              squashCommitMessage: {
                subject: 'Complete one-shot plan outcome',
                bullets: [
                  'Deliver the requested one-shot execute behavior.',
                  'Verify the finished result has no remaining known gaps.',
                ],
              },
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
    assert.match(notifyLog, /implementation complete/);
    assert.doesNotMatch(notifyLog, /plan complete/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('execute finalization persists the squashed checkpoint before failing the coder final-completion summary round', async () => {
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound(args: StructuredAdvisorRoundArgs) {
          const archivedReviewPath = args.prompt.match(/"archivedReviewPath": "([^"]+)"/)?.[1];
          assert.ok(archivedReviewPath, 'final-completion prompt should include terminal archived review path');
          assert.match(await readFile(archivedReviewPath, 'utf8'), /# Review/);
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'coder-final-completion-failed',
            text: 'Unstructured coder summary says the plan is complete.',
          });
          throw new NealProviderError({
            message: 'final completion summary failed',
            provider: 'anthropic-claude',
            sessionHandle: 'coder-final-completion-failed',
            role: 'structured-advisor',
            kind: 'structured_output_invalid',
          });
        },
      };
    },
  });

  try {
    const { statePath, state } = await createExecuteFinalizationFixture({
      lastScopeMarker: 'AUTONOMY_DONE',
      agentConfig: {
        ...getDefaultAgentConfig(),
        coder: { provider: 'anthropic-claude', model: null },
      },
    });
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(dirname(state.runDir)),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    await assert.rejects(
      () => runExecuteFinalizationPhase(state, statePath, logger),
      /final completion summary failed/,
    );

    const failedState = await loadState(statePath);
    assert.equal(failedState.phase, 'execute_finalization');
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.finalCommit !== null, true);
    assert.equal(failedState.archivedReviewPath?.endsWith(`REVIEW-${failedState.finalCommit}.md`), true);
    assert.equal(failedState.completedScopes.some((scope) => scope.finalCommit === failedState.finalCommit), true);
    assert.equal(failedState.coderSessionHandle, 'coder-final-completion-failed');
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(failedState.runDir), 'utf8');
    assert.match(completionArtifact, /## Unstructured Coder Summary Output/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review failure artifact includes unstructured reviewer output by failed session', async () => {
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound(args: StructuredAdvisorRoundArgs) {
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'other-final-completion-session',
            text: 'Wrong final-completion prose from another session.',
          });
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'reviewer-final-completion-failed',
            text: 'Unstructured reviewer verdict accepts completion, part one.',
          });
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'reviewer-final-completion-failed',
            text: 'Unstructured reviewer verdict accepts completion, part two.',
          });
          throw new NealProviderError({
            message: 'final completion reviewer failed',
            provider: 'anthropic-claude',
            sessionHandle: 'reviewer-final-completion-failed',
            role: 'structured-advisor',
            kind: 'structured_output_invalid',
          });
        },
      };
    },
  });

  try {
    const { statePath, state } = await createExecuteFinalizationFixture({
      phase: 'final_completion_review',
      status: 'running',
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Completed the plan before final review.',
        verificationSummary: 'Ran focused verification.',
        remainingKnownGaps: [],
      },
      agentConfig: {
        ...getDefaultAgentConfig(),
        reviewer: { provider: 'anthropic-claude', model: null },
      },
    });
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(dirname(state.runDir)),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    await assert.rejects(
      () => runFinalCompletionReviewPhase(state, statePath, logger),
      /final completion reviewer failed/,
    );

    const failedState = await loadState(statePath);
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.reviewerSessionHandle, null);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(failedState.runDir), 'utf8');
    assert.match(completionArtifact, /## Unstructured Reviewer Output/);
    assert.match(completionArtifact, /Unstructured reviewer verdict accepts completion, part one\./);
    assert.match(completionArtifact, /Unstructured reviewer verdict accepts completion, part two\./);
    assert.doesNotMatch(completionArtifact, /Wrong final-completion prose/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review returns a terminal blocked state on a content_refused reviewer error', async () => {
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound(args: StructuredAdvisorRoundArgs) {
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'reviewer-content-refused-session',
            text: 'Reviewer refused this content on content-safety grounds.',
          });
          throw new NealProviderError({
            message: 'reviewer refused: content was flagged for possible cybersecurity risk',
            provider: 'anthropic-claude',
            sessionHandle: 'reviewer-content-refused-session',
            role: 'structured-advisor',
            kind: 'content_refused',
            retryable: false,
          });
        },
      };
    },
  });

  try {
    const { statePath, state } = await createExecuteFinalizationFixture({
      phase: 'final_completion_review',
      status: 'running',
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Completed the plan before final review.',
        verificationSummary: 'Ran focused verification.',
        remainingKnownGaps: [],
      },
      agentConfig: {
        ...getDefaultAgentConfig(),
        reviewer: { provider: 'anthropic-claude', model: null },
      },
    });
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(dirname(state.runDir)),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    // The phase must RETURN a terminal blocked state, not reject.
    const blockedState = await runFinalCompletionReviewPhase(state, statePath, logger);
    assert.equal(blockedState.phase, 'blocked');
    assert.equal(blockedState.status, 'blocked');
    assert.equal(blockedState.reviewerSessionHandle, null);
    assert.equal(blockedState.blockedFromPhase, null);
    assert.match(blockedState.blockerReason ?? '', /content-safety/);

    const reloaded = await loadState(statePath);
    assert.equal(reloaded.phase, 'blocked');
    assert.equal(reloaded.status, 'blocked');
    assert.equal(reloaded.reviewerSessionHandle, null);
    assert.equal(reloaded.blockedFromPhase, null);
    assert.match(reloaded.blockerReason ?? '', /content-safety/);

    // The failed final-completion review artifact is still written, carrying the
    // failed session's unstructured reviewer prose.
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(reloaded.runDir), 'utf8');
    assert.match(completionArtifact, /## Unstructured Reviewer Output/);
    assert.match(completionArtifact, /Reviewer refused this content on content-safety grounds\./);

    const events = await readRunEvents(state.runDir);
    const phaseError = events.find(
      (event) => event.type === 'phase.error' && event.data?.phase === 'final_completion_review',
    );
    assert.equal(phaseError?.data?.errorKind, 'content_refused');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review parser failures persist failed state and reviewer failure context', async () => {
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>(args: StructuredAdvisorRoundArgs) {
          assert.equal(args.label, 'final-completion');
          await args.events?.({
            type: 'assistant_text',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            label: 'final-completion',
            sessionHandle: 'reviewer-final-completion-invalid-verdict',
            text: 'Reviewer prose identified follow-on work but omitted the missingWork payload.',
          });
          return {
            sessionHandle: 'reviewer-final-completion-invalid-verdict',
            structured: {
              action: 'continue_execution',
              summary: 'One follow-on scope is still required.',
              rationale: 'The reviewer found missing work but returned incomplete structured metadata.',
              missingWork: null,
              squashCommitMessage: null,
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
      phase: 'final_completion_review',
      status: 'running',
      archivedReviewPath: '/tmp/review-final.md',
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Completed the plan before final review.',
        verificationSummary: 'Ran focused verification.',
        remainingKnownGaps: [],
      },
      agentConfig: {
        ...getDefaultAgentConfig(),
        reviewer: { provider: 'anthropic-claude', model: null },
      },
    });
    const state = await saveState(statePath, {
      ...fixtureState,
      phase: 'final_completion_review',
      status: 'running',
      finalCommit: createdCommit,
      archivedReviewPath: '/tmp/review-final.md',
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      completedScopes: [
        {
          number: '5',
          marker: 'AUTONOMY_DONE',
          result: 'accepted',
          baseCommit: fixtureState.baseCommit,
          finalCommit: createdCommit,
          summary: 'Completed the plan before final review.',
          commitSubject: 'finish scope 5',
          changedFiles: ['scope.txt'],
          reviewRounds: 1,
          findings: 0,
          residualReviewDebt: [],
          archivedReviewPath: '/tmp/review-final.md',
          blocker: null,
          derivedFromParentScope: null,
          replacedByDerivedPlanPath: null,
        },
      ],
    });
    const logger = await createRunLogger({
      cwd: state.cwd,
      stateDir: dirname(dirname(state.runDir)),
      planDoc: state.planDoc,
      topLevelMode: state.topLevelMode,
      runDir: state.runDir,
    });

    await assert.rejects(
      () => runFinalCompletionReviewPhase(state, statePath, logger),
      /Final completion reviewer verdict must include a non-empty missingWork payload when action=continue_execution\./,
    );

    const failedState = await loadState(statePath);
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.phase, 'final_completion_review');
    assert.equal(failedState.reviewerSessionHandle, null);
    assert.equal(failedState.finalCompletionReviewVerdict, null);
    assert.equal(failedState.finalCompletionResolvedAction, null);

    const progressMarkdown = await readFile(failedState.progressMarkdownPath, 'utf8');
    assert.match(progressMarkdown, /- Status: failed/);

    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(failedState.runDir), 'utf8');
    assert.match(completionArtifact, /- Current step: reviewing final completion/);
    assert.match(completionArtifact, /- Status: failed/);
    assert.match(completionArtifact, /## Unstructured Reviewer Output/);
    assert.match(
      completionArtifact,
      /Reviewer prose identified follow-on work but omitted the missingWork payload\./,
    );

    const events = await readRunEvents(failedState.runDir);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'phase.error' &&
          event.data?.phase === 'final_completion_review' &&
          event.data?.sessionHandle === 'reviewer-final-completion-invalid-verdict' &&
          event.data?.subtype === 'final_completion_verdict_invalid' &&
          typeof event.data?.message === 'string' &&
          event.data.message.includes('missingWork payload'),
      ),
      true,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass reopens execution as a new follow-on scope when final completion review returns continue_execution', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
    // Consumed per-scope budgets from the completed scope: the reopened
    // follow-on scope is a fresh scope boundary, so both must reset to 0.
    consultantAttemptCount: 1,
    splitPlanCountForCurrentScope: 1,
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
              rationale: 'The execute state machine still finalizes automatically after execute finalization.',
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
    // Per-scope budgets reset at the reopen scope boundary, exactly as they do
    // at every scope-advance transition.
    assert.equal(nextState.consultantAttemptCount, 0);
    assert.equal(nextState.splitPlanCountForCurrentScope, 0);
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

test('final completion continue_execution clears coder protocol with the handle', async () => {
  for (const protocol of ['legacy_marker_v1', 'structured_json_v1'] as const) {
    const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
      currentScopeNumber: 5,
      phase: 'final_completion_review',
      status: 'running',
      archivedReviewPath: `/tmp/review-final-${protocol}.md`,
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCompletionSummary: {
        planGoalSatisfied: false,
        whatChangedOverall: 'A follow-on scope remains.',
        verificationSummary: 'Focused final-completion test.',
        remainingKnownGaps: ['Follow-on execution is still required.'],
      },
    });
    const state = await saveState(statePath, {
      ...fixtureState,
      phase: 'final_completion_review',
      status: 'running',
      coderSessionHandle: `coder-final-${protocol}`,
      coderSessionProtocol: protocol,
      finalCommit: createdCommit,
      archivedReviewPath: `/tmp/review-final-${protocol}.md`,
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
          archivedReviewPath: `/tmp/review-final-${protocol}.md`,
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
              sessionHandle: `reviewer-final-${protocol}`,
              structured: {
                action: 'continue_execution',
                summary: 'One follow-on scope remains.',
                rationale: 'The final reviewer requested more execution.',
                missingWork: {
                  summary: 'Continue with a follow-on scope.',
                  requiredOutcome: 'Execution resumes from a fresh coder session.',
                  verification: 'Inspect saved state.',
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
      assert.equal(nextState.coderSessionHandle, null);
      assert.equal(nextState.coderSessionProtocol, null);
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  }
});

test('final completion review keeps one-shot plans on scope 1 when continue_execution requests follow-on work', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
    assert.match(progressMarkdown, /- Progress: scope 6\b/);
    assert.doesNotMatch(progressMarkdown, /- Progress: scope 6\/\?/);
    assert.match(progressMarkdown, /- Resulting action: continue_execution/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runOnePass honors stop-after-current-scope on final completion continue_execution reopen', async () => {
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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

test('runOnePass honors stop-after-current-scope on the execute-finalization to coder_scope boundary and refreshes display state on both sides', async () => {
  const { statePath, state } = await createExecuteFinalizationFixture({
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
      { phase: 'execute_finalization', currentScopeNumber: 5 },
      { phase: 'coder_scope', currentScopeNumber: 6 },
    ],
  );
  assert.equal(displayStates.every((entry) => entry.startedAtType === 'number'), true);

  const events = await readRunEvents(state.runDir);
  assert.equal(
    events.some(
      (event) =>
        event.type === 'phase.complete' &&
        event.data?.phase === 'execute_finalization' &&
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
          throw new Error('provider should not be called for text coder scope prompt');
        },
        async runStructuredPrompt() {
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
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
              squashCommitMessage: {
                subject: 'Complete final plan outcome',
                bullets: [
                  'Deliver the requested execute-mode behavior across the completed work.',
                  'Verify the integrated result has no remaining known gaps.',
                ],
              },
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
    assert.match(notifyLog, /implementation complete: finish scope 5/);
    assert.doesNotMatch(notifyLog, /plan complete: finish scope 5/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('final completion review blocks with an explicit diagnostic hint when continue_execution exceeds its cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-cap-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
    // Operator guidance points at the recovery CLI tokens.
    assert.match(notifyLog, /neal status/);
    assert.match(notifyLog, /neal resume --message/);
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
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
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
    // Operator guidance points at the recovery CLI tokens.
    assert.match(notifyLog, /neal status/);
    assert.match(notifyLog, /neal resume --message/);
    const completionArtifact = await readFile(getFinalCompletionReviewArtifactPath(nextState.runDir), 'utf8');
    assert.match(completionArtifact, /- Execution shape: one_shot/);
    assert.match(completionArtifact, /- Reviewer action: block_for_operator/);
    assert.match(completionArtifact, /Run blocked for operator guidance\./);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unattended final completion review runs the shared terminal-fail action on a direct block_for_operator (site B)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-unattended-block-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
    currentScopeNumber: 2,
    executionShape: 'one_shot',
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    unattended: true,
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
    unattended: true,
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-unattended-block',
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
    const failedState = await runFinalCompletionReviewPhase(state, statePath, logger);
    // No operator wait: clean classified terminal fail instead of status:'blocked'.
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.blockedFromPhase, 'final_completion_review');
    assert.equal(failedState.finalCompletionReviewVerdict?.action, 'block_for_operator');
    assert.equal(failedState.finalCompletionResolvedAction, 'block_for_operator');
    // The aggregate diff is preserved unsubmitted, exactly as today's failed runs.
    assert.equal(failedState.finalCommit, createdCommit);

    const reloaded = await loadState(statePath);
    assert.equal(reloaded.status, 'failed');

    const events = await readEvents(state.runDir);
    const eventTypes = events.map((event) => event.type as string);
    const classified = events.find((event) => event.type === 'unattended.block_unresolved');
    assert.ok(classified, 'expected a classified unattended.block_unresolved event for site B');
    const classifiedData = classified?.data as Record<string, unknown> | undefined;
    assert.equal(classifiedData?.reason, 'unattended_block_unresolved');
    assert.equal(classifiedData?.site, 'final_completion_review');
    assert.equal(classifiedData?.blockedFromPhase, 'final_completion_review');
    // Mirrors the failed-run path: no attended block notification is emitted.
    assert.ok(!eventTypes.includes('notify.blocked'));
    const notifyLog = await readFile(notifyLogPath, 'utf8').catch(() => '');
    assert.doesNotMatch(notifyLog, /blocked completion for operator guidance/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('unattended final completion review runs the shared terminal-fail action when the continue_execution cap is reached (site B)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-final-completion-unattended-cap-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState, createdCommit } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionContinueExecutionCount: 1,
    unattended: true,
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
    unattended: true,
  });
  const logger = await createRunLogger({
    cwd: state.cwd,
    stateDir: dirname(dirname(state.runDir)),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-final-completion-unattended-cap',
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
    const failedState = await runFinalCompletionReviewPhase(state, statePath, logger);
    // The forced continue-execution cap folds into block_for_operator; unattended
    // turns that into a clean classified terminal fail rather than status:'blocked'.
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.blockedFromPhase, 'final_completion_review');
    assert.equal(failedState.finalCompletionReviewVerdict?.action, 'continue_execution');
    assert.equal(failedState.finalCompletionResolvedAction, 'block_for_operator');
    assert.equal(failedState.finalCompletionContinueExecutionCapReached, true);
    assert.equal(failedState.finalCommit, createdCommit);

    const reloaded = await loadState(statePath);
    assert.equal(reloaded.status, 'failed');

    const events = await readEvents(state.runDir);
    const eventTypes = events.map((event) => event.type as string);
    const classified = events.find((event) => event.type === 'unattended.block_unresolved');
    assert.ok(classified, 'expected a classified unattended.block_unresolved event for the site-B cap path');
    assert.equal(
      (classified?.data as Record<string, unknown> | undefined)?.site,
      'final_completion_review',
    );
    assert.ok(!eventTypes.includes('notify.blocked'));
    const notifyLog = await readFile(notifyLogPath, 'utf8').catch(() => '');
    assert.doesNotMatch(notifyLog, /continue_execution cap/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('verification-only terminal scope bypasses ordinary reviewer_scope and goes straight to final completion review', async () => {
  const { statePath, state } = await createEmptyExecuteFinalizationFixture({
    currentScopeNumber: 4,
    phase: 'coder_scope',
    status: 'running',
    lastScopeMarker: null,
    createdCommits: [],
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt() {
          throw new Error('provider should not be called for text coder scope prompt');
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          assert.match(args.prompt, /Set `action` to `done` only if this scope completes the entire plan/);
          return {
            sessionHandle: 'coder-scope-session-final',
            structured: {
              action: 'done',
              message: 'Verification-only completion.',
              progress: {
                milestoneTargeted: 'Finish with verification-only completion.',
                newEvidence: 'The required verification already passed.',
                whyNotRedundant: 'No further code changes are needed for the terminal plan state.',
                nextStepUnlocked: 'Neal can evaluate whole-plan completion directly.',
              },
              manualGate: null,
              derivedPlan: '',
              blockedReason: '',
            } as TStructured,
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
              squashCommitMessage: {
                subject: 'Complete verification-only plan outcome',
                bullets: [
                  'Confirm the existing implementation already satisfies the requested behavior.',
                  'Preserve the completed result without adding unnecessary changes.',
                ],
              },
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
