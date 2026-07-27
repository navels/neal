import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { clearConfigCache } from '../src/neal/config.js';
import { createRunLogger } from '../src/neal/logger.js';
import {
  enterInteractiveBlockedRecovery,
  hasPendingInteractiveBlockedRecoveryTurn,
  shouldNotifyInteractiveBlockedRecoveryEntry,
} from '../src/neal/orchestrator/phases/recovery.js';
import { UNATTENDED_AUTO_RESUME_GUIDANCE } from '../src/neal/blocked-guidance.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import type {
  StructuredAdvisorAdapter,
  StructuredAdvisorRoundArgs,
  StructuredAdvisorRoundResult,
} from '../src/neal/providers/types.js';
import {
  createInitialState,
  getDefaultAgentConfig,
  getRunStatePath,
  loadState,
  saveState,
} from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

// Mirrors the hermetic notify policy in test/orchestrator.test.ts: this suite
// pins notify_bin in every fixture config, so the suite-wide NEAL_NOTIFY_BIN=
// kill switch must not shadow it.
delete process.env.NEAL_NOTIFY_BIN;

const execFileAsync = promisify(execFile);
process.env.HOME = join(tmpdir(), 'neal-test-home-consultant-e2e');

// The consultant runs through the real read-only reviewer plumbing; we control
// its verdict by overriding this provider's structured-advisor adapter.
const ADVISOR_PROVIDER = 'openai-compatible';
const REVIEW_STUCK_REASON =
  'review_stuck: blocking findings did not decrease across 5 consecutive reviewer rounds';
const CODER_BLOCK_REASON =
  'Coder cannot finish the scope: the module fails to compile and the in-scope fix is unclear.';

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function recoverableVerdict() {
  return {
    recoverable: true,
    triageCategory: 'misunderstanding' as const,
    resolutionDirective:
      'Apply the requiredAction in finding C1 within the existing scope; no new authorization needed.',
    targetCanonicalIds: ['C1'],
    rationale: 'The coder and reviewer disagree on an already-specified in-scope requirement.',
  };
}

function nonRecoverableVerdict() {
  return {
    recoverable: false,
    triageCategory: 'authorization' as const,
    resolutionDirective: '',
    targetCanonicalIds: [],
    rationale: 'Resolving the deadlock requires credentials the coder does not have.',
  };
}

function installAdvisorOverride(behavior: { payload?: unknown; throwError?: Error }) {
  let calls = 0;
  const adapter: StructuredAdvisorAdapter = {
    async runStructuredRound<TStructured>(
      _args: StructuredAdvisorRoundArgs<TStructured>,
    ): Promise<StructuredAdvisorRoundResult<TStructured>> {
      calls += 1;
      if (behavior.throwError) {
        throw behavior.throwError;
      }
      return { sessionHandle: null, structured: behavior.payload as TStructured };
    },
  };
  setProviderCapabilitiesOverrideForTesting(ADVISOR_PROVIDER, {
    createStructuredAdvisorAdapter: () => adapter,
  });
  return { callCount: () => calls };
}

async function writeFixtureConfig(cwd: string, maxAttempts?: number) {
  const knobLine =
    typeof maxAttempts === 'number' ? `  consultant_max_attempts: ${maxAttempts}\n` : '';
  await writeFile(join(cwd, 'neal.yml'), `neal:\n  notify_bin: /usr/bin/true\n${knobLine}`, 'utf8');
  clearConfigCache(cwd);
}

async function createE2eFixture(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-consultant-e2e-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFixtureConfig(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml');
  await runGit(cwd, 'commit', '-m', 'base commit');
  const baseCommit = await runGit(cwd, 'rev-parse', 'HEAD');

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
    baseCommit,
  );

  const statePath = getRunStatePath(runDir);
  const mergedState: OrchestrationState = {
    ...initialState,
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    blockedFromPhase: 'reviewer_scope',
    unattended: true,
    unattendedAutoResumeCount: 0,
    consultantAttemptCount: 0,
    agentConfig: {
      ...getDefaultAgentConfig(),
      reviewer: { provider: ADVISOR_PROVIDER, model: null },
    },
    ...overrides,
  };

  const state = await saveState(statePath, mergedState);
  return { cwd, root, statePath, state };
}

async function makeLogger(cwd: string, statePath: string, state: OrchestrationState) {
  return createRunLogger({
    cwd,
    stateDir: dirname(statePath),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });
}

async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(runDir, 'events.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readEventTypes(runDir: string): Promise<string[]> {
  return (await readEvents(runDir)).map((event) => event.type as string);
}

async function readRecoveryMarkdown(runDir: string): Promise<string> {
  return readFile(join(runDir, 'RECOVERY.md'), 'utf8');
}

// 1. Unattended review_stuck, recoverable -> directive injected, auto-acted.
test('e2e: unattended review_stuck recoverable injects the directive and resolves autonomously', async () => {
  const { cwd, statePath, state } = await createE2eFixture({});
  const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 1);
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      recoverableVerdict().resolutionDirective,
    );
    assert.notEqual(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      UNATTENDED_AUTO_RESUME_GUIDANCE,
    );
    assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.unattendedAutoResumeCount, 0);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('consultant.start'));
    assert.ok(eventTypes.includes('consultant.verdict'));
    assert.ok(eventTypes.includes('consultant.resolved'));
    assert.ok(!eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 2. Unattended coder block, recoverable -> generalized dispatch triages it.
test('e2e: unattended coder block is triaged by the generalized dispatch with sourcePhase coder_scope', async () => {
  const { cwd, statePath, state } = await createE2eFixture({
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, CODER_BLOCK_REASON, logger);

    assert.equal(advisor.callCount(), 1);
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      recoverableVerdict().resolutionDirective,
    );
    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.recentBlocks[0]?.sourcePhase, 'coder_scope');

    const events = await readEvents(state.runDir);
    const start = events.find((event) => event.type === 'consultant.start');
    assert.equal((start?.data as Record<string, unknown> | undefined)?.sourcePhase, 'coder_scope');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 3. Unattended coder block, not recoverable -> terminal short-circuit.
test('e2e: unattended not-recoverable verdict terminally short-circuits instead of auto-resuming', async () => {
  const { cwd, statePath, state } = await createE2eFixture({
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  const advisor = installAdvisorOverride({ payload: nonRecoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, CODER_BLOCK_REASON, logger);

    assert.equal(advisor.callCount(), 1);
    assert.equal(nextState.status, 'failed');
    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.interactiveBlockedRecovery, null);
    assert.equal(nextState.unattendedAutoResumeCount, 0);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('unattended.block_unresolved'));
    assert.ok(!eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 4. Anti-thrash via two real entries (no pre-seeding) + a cross-scope control.
test('e2e: a same-scope resumed repeat short-circuits without re-invoking the advisor; a cross-scope repeat does not', async () => {
  const { cwd, statePath, state } = await createE2eFixture({
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  // A generous budget isolates the anti-thrash guard from the per-scope cap.
  await writeFixtureConfig(cwd, 5);
  const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const firstState = await enterInteractiveBlockedRecovery(state, statePath, CODER_BLOCK_REASON, logger);
    assert.equal(advisor.callCount(), 1);
    assert.equal(firstState.recentBlocks.length, 1);
    assert.equal(firstState.recentBlocks[0]?.count, 1);
    assert.equal(firstState.recentBlocks[0]?.scopeNumber, state.currentScopeNumber);

    const reloaded = await loadState(statePath);
    assert.deepEqual(reloaded.recentBlocks, firstState.recentBlocks);

    const secondEntryState: OrchestrationState = {
      ...reloaded,
      phase: 'coder_scope',
      blockedFromPhase: 'coder_scope',
      status: 'running',
      interactiveBlockedRecovery: null,
    };
    const secondState = await enterInteractiveBlockedRecovery(secondEntryState, statePath, CODER_BLOCK_REASON, logger);
    assert.equal(advisor.callCount(), 1, 'the anti-thrash repeat does not re-invoke the advisor');
    assert.equal(secondState.status, 'failed');
    assert.equal(secondState.recentBlocks.length, 1);
    assert.equal(secondState.recentBlocks[0]?.count, 2);

    const afterSecond = await loadState(statePath);
    const thirdEntryState: OrchestrationState = {
      ...afterSecond,
      currentScopeNumber: state.currentScopeNumber + 1,
      phase: 'coder_scope',
      blockedFromPhase: 'coder_scope',
      status: 'running',
      interactiveBlockedRecovery: null,
    };
    const thirdState = await enterInteractiveBlockedRecovery(thirdEntryState, statePath, CODER_BLOCK_REASON, logger);
    assert.equal(advisor.callCount(), 2, 'a different scope identity invokes the advisor again');
    assert.equal(thirdState.recentBlocks.length, 2);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 5. Attended recoverable block, knob enabled -> auto-applies the directive, same
//    as unattended. No operator yield, no notification.
test('e2e: attended recoverable block auto-applies the consultant directive without yielding', async () => {
  const { cwd, statePath, state } = await createE2eFixture({
    unattended: false,
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, CODER_BLOCK_REASON, logger);

    assert.equal(advisor.callCount(), 1);
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    // The consultant's directive is injected as the pending turn, exactly like an
    // unattended auto-fix — the run consumes it rather than waiting for the operator.
    assert.equal(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      recoverableVerdict().resolutionDirective,
    );
    assert.equal(hasPendingInteractiveBlockedRecoveryTurn(nextState), true);
    assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), false, 'an auto-fix must not notify');
    assert.equal(
      nextState.interactiveBlockedRecovery?.consultantAdvice,
      undefined,
      'a recoverable verdict is applied, not persisted as advice',
    );

    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.recentBlocks.length, 1);
    assert.equal(nextState.recentBlocks[0]?.count, 1);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(eventTypes.includes('consultant.start'));
    assert.ok(eventTypes.includes('consultant.verdict'));
    assert.ok(eventTypes.includes('consultant.resolved'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 5b. Attended non-recoverable (genuine wall), knob enabled -> advice persisted,
//     run yields for the operator (the case that still waits for a human).
test('e2e: attended non-recoverable block persists consultant advice in state and RECOVERY.md, then yields', async () => {
  const { cwd, statePath, state } = await createE2eFixture({
    unattended: false,
    phase: 'coder_scope',
    blockedFromPhase: 'coder_scope',
  });
  const advisor = installAdvisorOverride({ payload: nonRecoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, CODER_BLOCK_REASON, logger);

    assert.equal(advisor.callCount(), 1);
    assert.equal(nextState.phase, 'interactive_blocked_recovery');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0, 'a genuine wall still waits for guidance');
    assert.equal(shouldNotifyInteractiveBlockedRecoveryEntry(nextState), true);

    const advice = nextState.interactiveBlockedRecovery?.consultantAdvice;
    assert.ok(advice, 'attended advice must be persisted on a wall');
    assert.equal(advice?.recoverable, nonRecoverableVerdict().recoverable);
    assert.equal(advice?.triageCategory, nonRecoverableVerdict().triageCategory);

    assert.equal(nextState.consultantAttemptCount, 1);
    assert.equal(nextState.recentBlocks.length, 1);
    assert.equal(nextState.recentBlocks[0]?.count, 1);

    const reloaded = await loadState(statePath);
    assert.equal(reloaded.interactiveBlockedRecovery?.consultantAdvice?.triageCategory, advice?.triageCategory);

    const recoveryMarkdown = await readRecoveryMarkdown(state.runDir);
    assert.ok(recoveryMarkdown.includes('Consultant advice'), 'RECOVERY.md surfaces the advice');
    assert.ok(!recoveryMarkdown.includes('## Support Rounds'), 'RECOVERY.md has no support-rounds section');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 6. Disable knob, both modes -> today's generic behavior, byte-for-byte.
test('e2e: the disable knob (0) reproduces today behavior in both unattended and attended modes', async () => {
  // Unattended: generic auto-resume, no consultant events.
  {
    const { cwd, statePath, state } = await createE2eFixture({});
    await writeFixtureConfig(cwd, 0);
    const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
    const logger = await makeLogger(cwd, statePath, state);
    try {
      const recentBefore = state.recentBlocks;
      const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

      assert.equal(advisor.callCount(), 0);
      assert.equal(
        nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
        UNATTENDED_AUTO_RESUME_GUIDANCE,
      );
      assert.deepEqual(nextState.recentBlocks, recentBefore);

      const eventTypes = await readEventTypes(state.runDir);
      assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')));
      assert.ok(eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  }

  // Attended: plain yield, no advice, unchanged budget/recentBlocks, no events.
  {
    const { cwd, statePath, state } = await createE2eFixture({ unattended: false });
    await writeFixtureConfig(cwd, 0);
    const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
    const logger = await makeLogger(cwd, statePath, state);
    try {
      const recentBefore = state.recentBlocks;
      const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

      assert.equal(advisor.callCount(), 0);
      assert.equal(nextState.phase, 'interactive_blocked_recovery');
      assert.equal(nextState.interactiveBlockedRecovery?.turns.length, 0);
      assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null);
      assert.equal(nextState.consultantAttemptCount, 0);
      assert.deepEqual(nextState.recentBlocks, recentBefore);

      const eventTypes = await readEventTypes(state.runDir);
      assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')));
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  }
});

// 7. Exhausted budget, attended -> plain yield, the cap gates attended advice.
test('e2e: an exhausted budget gates attended advice and the recentBlocks writer', async () => {
  // Knob default is 1; seed consultantAttemptCount at the cap.
  const { cwd, statePath, state } = await createE2eFixture({
    unattended: false,
    consultantAttemptCount: 1,
  });
  const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const recentBefore = state.recentBlocks;
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 0, 'an exhausted budget must not invoke the consultant');
    assert.equal(nextState.interactiveBlockedRecovery?.consultantAdvice ?? null, null);
    assert.equal(nextState.consultantAttemptCount, 1, 'the cap is not exceeded');
    assert.deepEqual(nextState.recentBlocks, recentBefore);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

// 8. Ineligible source phase (coder_plan) -> generic behavior, zero consultant calls.
test('e2e: an ineligible source phase (coder_plan) keeps generic recovery with zero consultant calls', async () => {
  const { cwd, statePath, state } = await createE2eFixture({
    phase: 'coder_plan',
    blockedFromPhase: 'coder_plan',
  });
  const advisor = installAdvisorOverride({ payload: recoverableVerdict() });
  const logger = await makeLogger(cwd, statePath, state);

  try {
    const recentBefore = state.recentBlocks;
    const nextState = await enterInteractiveBlockedRecovery(state, statePath, REVIEW_STUCK_REASON, logger);

    assert.equal(advisor.callCount(), 0, 'plan-refinement blocks must never invoke the consultant');
    assert.equal(
      nextState.interactiveBlockedRecovery?.turns.at(-1)?.operatorGuidance,
      UNATTENDED_AUTO_RESUME_GUIDANCE,
    );
    assert.equal(nextState.consultantAttemptCount, 0);
    assert.equal(nextState.unattendedAutoResumeCount, 1);
    assert.deepEqual(nextState.recentBlocks, recentBefore);

    const eventTypes = await readEventTypes(state.runDir);
    assert.ok(!eventTypes.some((type) => type.startsWith('consultant.')));
    assert.ok(eventTypes.includes('interactive_blocked_recovery.unattended_auto_resume'));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
