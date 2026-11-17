import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearConfigCache } from '../src/neal/config.js';
import { runFinalCompletionReviewPhase } from '../src/neal/orchestrator.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import { decideResumeAction } from '../src/neal/resume-decision.js';
import { applyResumeActions, assertResumeActionsCanApply, planResumeActions } from '../src/neal/resume-planner.js';
import { loadState, saveState } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';
import {
  createExecuteFinalizationFixture,
  createNotifyCapture,
  readRunEvents,
  runGit,
  writeRepoConfig,
} from './helpers/orchestrator-harness.js';

// A user-level config directory this file owns, so a test can change the
// continue-execution cap the way an operator must: without touching the
// repository's worktree.
const testHome = join(tmpdir(), `neal-test-home-resume-blocked-final-review-${process.pid}`);
process.env.HOME = testHome;

type FinalVerdict = 'accept_complete' | 'continue_execution' | 'block_for_operator';

const VERDICT_PAYLOADS: Record<FinalVerdict, Record<string, unknown>> = {
  accept_complete: {
    action: 'accept_complete',
    summary: 'The plan outcome is complete and coherent.',
    rationale: 'The completed scopes satisfy the plan objectives with no remaining known gaps.',
    missingWork: null,
    squashCommitMessage: {
      subject: 'Complete final plan outcome',
      bullets: ['Deliver the requested behavior.', 'Verify the integrated result.'],
    },
  },
  continue_execution: {
    action: 'continue_execution',
    summary: 'Another bounded follow-on scope is required.',
    rationale: 'One piece of the plan is still missing.',
    missingWork: {
      summary: 'Add the missing piece.',
      requiredOutcome: 'The plan objective is fully met.',
      verification: 'Run the test suite.',
    },
  },
  block_for_operator: {
    action: 'block_for_operator',
    summary: 'An operator decision is required.',
    rationale: 'The plan and the implementation disagree about scope.',
    missingWork: null,
  },
};

async function setUserContinueCap(cwd: string, cap: number | null) {
  await mkdir(join(testHome, '.neal'), { recursive: true });
  await writeFile(
    join(testHome, '.neal', 'config.yml'),
    cap === null ? 'neal: {}\n' : `neal:\n  final_completion_continue_execution_max: ${cap}\n`,
    'utf8',
  );
  clearConfigCache(cwd);
}

// Builds a run sitting at final completion review, with the repo config
// committed so the worktree is clean, and scripts the reviewer's verdicts in
// order. `continueCount` is how many continuations the run has already used.
async function createFinalReviewFixture(args: { verdicts: FinalVerdict[]; continueCount: number; userCap: number | null }) {
  const root = await mkdtemp(join(tmpdir(), 'neal-resume-blocked-final-review-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: fixtureState } = await createExecuteFinalizationFixture({
    currentScopeNumber: 5,
    phase: 'final_completion_review',
    status: 'running',
    archivedReviewPath: '/tmp/review-final.md',
    lastScopeMarker: 'AUTONOMY_DONE',
    finalCompletionContinueExecutionCount: args.continueCount,
    finalCompletionSummary: {
      planGoalSatisfied: false,
      whatChangedOverall: 'Implemented the plan.',
      verificationSummary: 'Ran the tests.',
      remainingKnownGaps: [],
    },
  });
  const cwd = fixtureState.cwd;
  // The repo config deliberately leaves the cap unset, so the user config
  // decides it, and it is committed so the worktree stays clean.
  await writeRepoConfig(cwd, { notifyBin: notifyScriptPath });
  await runGit(cwd, 'add', 'neal.yml');
  await runGit(cwd, 'commit', '--no-verify', '-m', 'pin test config');
  const finalCommit = await runGit(cwd, 'rev-parse', 'HEAD');
  await setUserContinueCap(cwd, args.userCap);

  const state = await saveState(statePath, {
    ...fixtureState,
    phase: 'final_completion_review',
    status: 'running',
    finalCommit,
    archivedReviewPath: '/tmp/review-final.md',
    completedScopes: [
      {
        number: '5',
        marker: 'AUTONOMY_DONE',
        result: 'accepted',
        baseCommit: fixtureState.baseCommit,
        finalCommit,
        commitSubject: 'finish scope 5',
        summary: 'Finished scope 5.',
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

  let reviewerRounds = 0;
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          const verdict = args.verdicts[reviewerRounds];
          assert.ok(verdict, `unexpected final reviewer round ${reviewerRounds + 1}`);
          reviewerRounds += 1;
          return {
            sessionHandle: `reviewer-final-${reviewerRounds}`,
            structured: VERDICT_PAYLOADS[verdict] as TStructured,
          };
        },
      };
    },
  });

  return { cwd, statePath, state, finalCommit, notifyLogPath, reviewerRounds: () => reviewerRounds };
}

async function resume(state: OrchestrationState, statePath: string) {
  return applyResumeActions(state, statePath, undefined, planResumeActions(state));
}

function assertBlockedAtFinalReview(state: OrchestrationState) {
  assert.equal(state.phase, 'blocked');
  assert.equal(state.status, 'blocked');
  assert.equal(state.blockedFromPhase, 'final_completion_review');
}

test('a run the final reviewer blocked resumes into a fresh final review that can accept', async () => {
  const fixture = await createFinalReviewFixture({
    verdicts: ['block_for_operator', 'accept_complete'],
    continueCount: 0,
    userCap: null,
  });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    assertBlockedAtFinalReview(blocked);
    assert.match(await readFile(fixture.notifyLogPath, 'utf8'), /use `neal resume`/);

    assert.deepEqual(planResumeActions(blocked).map((action) => action.kind), ['rerun_blocked_final_completion_review']);
    // The shared decision layer reports it as resumable, without a message.
    assert.equal(
      decideResumeAction({ state: blocked, selectedRunId: 'test-run', statePath: fixture.statePath }).kind,
      'continue',
    );

    const resumed = await resume(blocked, fixture.statePath);
    assert.equal(resumed.phase, 'final_completion_review');
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.blockedFromPhase, null);
    assert.equal(resumed.finalCompletionReviewVerdict, null);
    assert.equal(resumed.finalCompletionResolvedAction, null);
    assert.equal(resumed.finalCompletionContinueExecutionCapReached, false);
    assert.equal(resumed.reviewerSessionHandle, null);
    assert.equal(resumed.finalCommit, fixture.finalCommit);
    assert.ok(resumed.finalCompletionSummary);
    // The reopened state is what was persisted.
    assert.equal((await loadState(fixture.statePath)).phase, 'final_completion_review');

    const done = await runFinalCompletionReviewPhase(resumed, fixture.statePath);
    assert.equal(done.phase, 'done');
    assert.equal(done.status, 'done');
    assert.equal(done.finalCompletionReviewVerdict?.action, 'accept_complete');
    assert.equal(fixture.reviewerRounds(), 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('a run blocked at the cap can still be accepted on resume without raising the cap', async () => {
  const fixture = await createFinalReviewFixture({
    verdicts: ['continue_execution', 'accept_complete'],
    continueCount: 1,
    userCap: 1,
  });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    assertBlockedAtFinalReview(blocked);
    assert.equal(blocked.finalCompletionContinueExecutionCapReached, true);

    const resumed = await resume(blocked, fixture.statePath);
    // The cap bounds continuations only; it is no reason to refuse a review
    // that may now accept.
    assert.equal(resumed.finalCompletionContinueExecutionCount, 1);
    const done = await runFinalCompletionReviewPhase(resumed, fixture.statePath);
    assert.equal(done.status, 'done');
    assert.equal(done.finalCompletionContinueExecutionCount, 1);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('a resumed review that asks to continue again with the cap unchanged blocks again', async () => {
  const fixture = await createFinalReviewFixture({
    verdicts: ['continue_execution', 'continue_execution'],
    continueCount: 1,
    userCap: 1,
  });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    const resumed = await resume(blocked, fixture.statePath);
    const blockedAgain = await runFinalCompletionReviewPhase(resumed, fixture.statePath);

    assertBlockedAtFinalReview(blockedAgain);
    assert.equal(blockedAgain.finalCompletionContinueExecutionCapReached, true);
    // The cap held: resuming did not buy an extra continuation.
    assert.equal(blockedAgain.finalCompletionContinueExecutionCount, 1);
    // Each operator-requested review that blocks is its own notification.
    const notifyLines = (await readFile(fixture.notifyLogPath, 'utf8')).split('\n').filter((line) => line.includes('continue_execution cap'));
    assert.equal(notifyLines.length, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('raising the cap in user config lets a resumed review reopen execution', async () => {
  const fixture = await createFinalReviewFixture({
    verdicts: ['continue_execution', 'continue_execution'],
    continueCount: 1,
    userCap: 1,
  });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    assertBlockedAtFinalReview(blocked);

    await setUserContinueCap(fixture.cwd, 2);
    const resumed = await resume(blocked, fixture.statePath);
    const reopened = await runFinalCompletionReviewPhase(resumed, fixture.statePath);

    assert.equal(reopened.phase, 'coder_scope');
    assert.equal(reopened.status, 'running');
    assert.equal(reopened.finalCompletionContinueExecutionCount, 2);
    assert.equal(reopened.finalCompletionContinueExecutionCapReached, false);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('resume refuses to re-run the final review when HEAD has moved, and changes nothing', async () => {
  const fixture = await createFinalReviewFixture({ verdicts: ['block_for_operator'], continueCount: 0, userCap: null });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    await writeFile(join(fixture.cwd, 'later.txt'), 'operator work\n', 'utf8');
    await runGit(fixture.cwd, 'add', 'later.txt');
    await runGit(fixture.cwd, 'commit', '--no-verify', '-m', 'operator commit after the block');

    await assert.rejects(resume(blocked, fixture.statePath), /HEAD has moved since the run blocked/);

    assertBlockedAtFinalReview(await loadState(fixture.statePath));
    assert.equal(fixture.reviewerRounds(), 1);
    const events = await readRunEvents(blocked.runDir);
    assert.equal(events.some((event) => event.type === 'run.resumed_blocked_final_completion_review'), false);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('resume refuses to re-run the final review over uncommitted work, and leaves that work alone', async () => {
  const fixture = await createFinalReviewFixture({ verdicts: ['block_for_operator'], continueCount: 0, userCap: null });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    // The review's cleanup would reset the tracked edit and delete the new file.
    await writeFile(join(fixture.cwd, 'scope.txt'), 'operator edit\n', 'utf8');
    await writeFile(join(fixture.cwd, 'notes.txt'), 'operator notes\n', 'utf8');

    await assert.rejects(resume(blocked, fixture.statePath), /uncommitted changes in the worktree[\s\S]*scope\.txt[\s\S]*notes\.txt/);

    assert.equal(await readFile(join(fixture.cwd, 'scope.txt'), 'utf8'), 'operator edit\n');
    await access(join(fixture.cwd, 'notes.txt'));
    assertBlockedAtFinalReview(await loadState(fixture.statePath));
    assert.equal(fixture.reviewerRounds(), 1);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('an edited plan document blocks the re-run only when the run would squash on completion', async () => {
  const fixture = await createFinalReviewFixture({
    verdicts: ['block_for_operator', 'accept_complete'],
    continueCount: 0,
    userCap: null,
  });
  try {
    const blocked = await runFinalCompletionReviewPhase(fixture.state, fixture.statePath);
    const planText = await readFile(blocked.planDoc, 'utf8');
    await writeFile(blocked.planDoc, `${planText}\nOperator note.\n`, 'utf8');

    // Auto-squash refuses any dirty worktree, so an accepted review would be
    // followed by a failed squash. Refuse before the review instead.
    const squashing = await saveState(fixture.statePath, { ...blocked, autoSquashOnCompletion: true });
    await assert.rejects(resume(squashing, fixture.statePath), /squashes on completion[\s\S]*PLAN\.md/);
    assertBlockedAtFinalReview(await loadState(fixture.statePath));
    assert.match(await readFile(blocked.planDoc, 'utf8'), /Operator note\./);
    assert.equal(fixture.reviewerRounds(), 1);

    // A run with no commit range is never squashed, even with auto-squash on
    // (a verification-only completion), so the edit is no reason to refuse.
    assert.notEqual(blocked.initialBaseCommit ?? blocked.baseCommit, fixture.finalCommit);
    const noRange = await saveState(fixture.statePath, {
      ...blocked,
      autoSquashOnCompletion: true,
      initialBaseCommit: fixture.finalCommit,
    });
    assert.deepEqual(planResumeActions(noRange).map((action) => action.kind), ['rerun_blocked_final_completion_review']);
    await assertResumeActionsCanApply(noRange, planResumeActions(noRange));

    // Without a squash the review already preserves the plan document, so the
    // edit alone is no reason to refuse.
    const unsquashed = await saveState(fixture.statePath, { ...blocked, autoSquashOnCompletion: false });
    const resumed = await resume(unsquashed, fixture.statePath);
    assert.equal(resumed.phase, 'final_completion_review');
    assert.match(await readFile(blocked.planDoc, 'utf8'), /Operator note\./);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
