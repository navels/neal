import './helpers/orchestrator-env.js';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { executeRun, withActiveRunLock } from '../src/neal/commands/runtime.js';
import { getExecuteRunResultExitCode } from '../src/neal/commands/writer-exit-codes.js';
import { RunLogger } from '../src/neal/logger.js';
import { setProviderCapabilitiesOverrideForTesting, clearProviderCapabilitiesOverridesForTesting } from '../src/neal/providers/registry.js';
import { NealProviderError, type ProviderEventSink } from '../src/neal/providers/types.js';
import { acquireActiveRunLock } from '../src/neal/run-lock.js';
import { loadState, saveState } from '../src/neal/state.js';
import { buildStatusSnapshot } from '../src/neal/status.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { createExecuteFinalizationFixture, readRunEvents, runGit } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-usage-limit-runtime');

const summary = { planGoalSatisfied: true, whatChangedOverall: 'Implemented the scope.', verificationSummary: 'Verified the scope.', remainingKnownGaps: [] };
const complete = { action: 'accept_complete', summary: 'Complete.', rationale: 'Scope is complete.', missingWork: null, squashCommitMessage: null };
const review = { summary: 'Accepted.', findings: [], meaningfulProgressAction: 'accept', meaningfulProgressRationale: 'The scope is complete.' };
const coderDone = {
  action: 'done', message: 'Complete.', derivedPlan: '', blockedReason: '', manualGate: null,
  progress: { milestoneTargeted: 'Finish scope', newEvidence: 'Work committed', whyNotRedundant: 'Completes the scope', nextStepUnlocked: 'Final review' },
};

type Scenario = 'coder' | 'partial-coder' | 'summary' | 'review' | 'missing' | 'distant' | 'past' | 'repeated' | 'disabled' | 'progress';

for (const scenario of ['coder', 'partial-coder', 'summary', 'review', 'missing', 'distant', 'past', 'repeated', 'disabled', 'progress'] as const) {
  test(`executeRun usage-limit handling: ${scenario}`, async (t) => {
    t.after(clearProviderCapabilitiesOverridesForTesting);
    let now = Date.parse('2026-11-15T12:00:00Z');
    let failures = 0;
    let sleeps = 0;
    let coderCalls = 0;
    let summaryCalls = 0;
    let reviewerCalls = 0;
    const isCoder = !['summary', 'review', 'progress'].includes(scenario);
    const fixture = await createExecuteFinalizationFixture({
      phase: scenario === 'review' ? 'final_completion_review' : isCoder ? 'coder_scope' : 'execute_finalization',
      lastScopeMarker: isCoder ? null : 'AUTONOMY_DONE',
      finalCompletionSummary: scenario === 'review' ? summary : null,
      executionShape: 'one_shot',
    });
    const state = await saveState(fixture.statePath, {
      ...fixture.state,
      agentConfig: { ...fixture.state.agentConfig, coder: { provider: 'openai-codex', model: null }, reviewer: { provider: 'anthropic-claude', model: null } },
      ...(isCoder ? { baseCommit: fixture.createdCommit, createdCommits: [] } : {}),
      ...(scenario === 'review' ? { finalCommit: fixture.createdCommit } : {}),
    });
    const fail = async (events: ProviderEventSink | undefined, provider: string, role: 'coder' | 'structured-advisor') => {
      failures += 1;
      const resetsAt = scenario === 'missing' ? null : now + (scenario === 'distant' ? 7 * 3600_000 : scenario === 'past' ? -1 : 1000);
      await events?.({ type: 'provider_error', provider, role, errorKind: 'usage_limit', message: 'Usage limit reached', resetsAt, retryable: false });
      throw new NealProviderError({ provider, role, kind: 'usage_limit', message: 'Usage limit reached', resetsAt, sessionHandle: role === 'coder' ? 'partial-session' : null });
    };
    const coder = createFakeProviderDefinition({
      id: 'openai-codex', coderStructuredResponses: [coderDone], structuredAdvisorResponses: [summary],
      onCoderStructuredRun: async (args) => {
        coderCalls += 1;
        if (coderCalls === 1 || scenario === 'repeated') {
          await args.onSessionStarted?.('partial-session');
          if (scenario === 'partial-coder') await writeFile(join(state.cwd, 'scope.txt'), 'partial work\n');
          await fail(args.events, 'openai-codex', 'coder');
        }
        assert.equal(args.resumeHandle, 'partial-session');
        if (scenario === 'partial-coder') {
          assert.equal(await readFile(join(state.cwd, 'scope.txt'), 'utf8'), 'partial work\n');
          await runGit(state.cwd, 'add', 'scope.txt');
          await runGit(state.cwd, 'commit', '-m', 'Finish partial work');
        }
      },
      onStructuredAdvisorRun: async (args) => {
        summaryCalls += 1;
        if ((scenario === 'summary' && summaryCalls === 1) || (scenario === 'progress' && summaryCalls <= 3)) {
          await fail(args.events, 'openai-codex', 'structured-advisor');
        }
      },
    });
    const reviewer = createFakeProviderDefinition({
      id: 'anthropic-claude', structuredAdvisorResponses: scenario === 'partial-coder' ? [review, complete] : [complete],
      onStructuredAdvisorRun: async (args) => {
        reviewerCalls += 1;
        if ((scenario === 'review' || scenario === 'progress') && reviewerCalls === 1) await fail(args.events, 'anthropic-claude', 'structured-advisor');
      },
    });
    setProviderCapabilitiesOverrideForTesting('openai-codex', coder);
    setProviderCapabilitiesOverrideForTesting('anthropic-claude', reviewer);
    const lockArgs = { cwd: state.cwd, runId: basename(state.runDir), runStatePath: fixture.statePath, planDoc: state.planDoc, topLevelMode: 'execute' as const };
    const lock = await acquireActiveRunLock(lockArgs);
    const result = await withActiveRunLock(lock, () => executeRun(state, fixture.statePath, new RunLogger(state.runDir), {
      waitForUsageLimit: scenario !== 'disabled',
      usageLimitClock: {
        now: () => now,
        sleep: async (ms) => {
          sleeps += 1;
          assert.equal(ms, 61_000);
          const persisted = await loadState(fixture.statePath);
          assert.equal(persisted.status, 'failed');
          const status = await buildStatusSnapshot({ cwd: state.cwd, statePath: fixture.statePath });
          assert.equal(status.effectiveStatus, 'waiting_for_usage_limit');
          assert.equal(status.lock.kind, 'live_same_run');
          await assert.rejects(() => acquireActiveRunLock({ ...lockArgs, runId: 'another-writer' }), /active/);
          if (scenario === 'partial-coder') assert.equal(persisted.coderSessionHandle, 'partial-session');
          if (scenario === 'summary' || scenario === 'progress') {
            assert.ok(persisted.finalCommit);
            const head = await runGit(state.cwd, 'rev-parse', 'HEAD');
            // Existing resume finalization may recreate the squash commit;
            // its parent and tree must still preserve the accepted scope.
            assert.equal(await runGit(state.cwd, 'rev-parse', 'HEAD^'), fixture.baseCommit);
            assert.equal(await readFile(join(state.cwd, 'scope.txt'), 'utf8'), 'base\nchange\n');
            assert.equal(persisted.finalCommit, head);
          }
          now += ms;
        },
      },
    }));
    const fails = ['missing', 'distant', 'past', 'repeated', 'disabled'].includes(scenario);
    assert.equal(result.finalState.status, fails ? 'failed' : 'done');
    assert.equal(getExecuteRunResultExitCode(result), fails ? 3 : 0);
    assert.equal(sleeps, scenario === 'repeated' ? 3 : scenario === 'progress' ? 4 : fails ? 0 : 1);
    const events = await readRunEvents(state.runDir);
    assert.equal(events.filter((event) => event.type === 'notify.blocked').length, failures);
    assert.equal(events.filter((event) => event.type === 'run.usage_limit_wait_started').length, sleeps);
    assert.equal(events.filter((event) => event.type === 'run.usage_limit_wait_finished').length, sleeps);
    assert.equal(events.filter((event) => event.type === 'run.resumed').length, sleeps);
    const notifications = await readFile(fixture.notifyLogPath, 'utf8');
    assert.equal(notifications.split('\n').filter((line) => line.includes('usage limit reached')).length, failures);
    if (scenario === 'distant') {
      assert.match(notifications, /resets at/);
      assert.match(notifications, /neal resume --run/);
    }
    assert.equal((await buildStatusSnapshot({ cwd: state.cwd, statePath: fixture.statePath })).lock.kind, 'none');
    if (scenario === 'progress') {
      const counts = events.filter((event) => event.type === 'run.usage_limit_wait_started').map((event) => event.data?.waitsSoFar);
      assert.deepEqual(counts, [1, 2, 3, 1]);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} during a usage-limit wait releases the lock and leaves normal resume available`, { timeout: 15_000 }, async (t) => {
    const fixture = await createExecuteFinalizationFixture({ phase: 'coder_scope', createdCommits: [] });
    await saveState(fixture.statePath, { ...fixture.state, baseCommit: fixture.createdCommit });
    const worker = `
      import { executeRun, withActiveRunLock } from './src/neal/commands/runtime.ts';
      import { RunLogger } from './src/neal/logger.ts';
      import { loadState } from './src/neal/state.ts';
      import { acquireActiveRunLock } from './src/neal/run-lock.ts';
      import { setProviderCapabilitiesOverrideForTesting } from './src/neal/providers/registry.ts';
      import { NealProviderError } from './src/neal/providers/types.ts';
      const statePath = process.argv[1];
      const state = await loadState(statePath);
      setProviderCapabilitiesOverrideForTesting(state.agentConfig.coder.provider, {
        createCoderAdapter() {
          return { async runStructuredPrompt() {
            throw new NealProviderError({ provider: state.agentConfig.coder.provider, role: 'coder', kind: 'usage_limit', message: 'Usage limit reached', resetsAt: Date.now() + 10000 });
          }};
        }
      });
      const lock = await acquireActiveRunLock({ cwd: state.cwd, runId: 'test-run', runStatePath: statePath, planDoc: state.planDoc, topLevelMode: 'execute' });
      await withActiveRunLock(lock, () => executeRun(state, statePath, new RunLogger(state.runDir), {
        usageLimitClock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => {
          setTimeout(resolve, ms);
          process.send('waiting');
        }) }
      }));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, fixture.statePath], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NEAL_NOTIFY_BIN: '' },
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const exit = once(child, 'exit');
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exit.then(([code]) => { throw new Error(`Worker exited before waiting (${code}): ${stderr}`); }),
    ]);
    assert.equal(ready, 'waiting');
    const waiting = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath });
    assert.equal(waiting.publicStatus, 'waiting_for_usage_limit');
    assert.ok(waiting.lock.kind === 'live_same_run');
    assert.equal(waiting.lock.pid, child.pid);
    child.kill(signal);
    const [, exitSignal] = await exit;
    assert.equal(exitSignal, signal);
    const stopped = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath });
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.publicStatus, 'failed');
    assert.equal(stopped.lock.kind, 'none');
    assert.equal(stopped.resumeDecision.kind, 'continue');
    const { loadRunForResume } = await import('../src/neal/orchestrator.js');
    const resumed = await loadRunForResume(fixture.statePath);
    assert.equal(resumed.state.status, 'running');
    assert.equal(resumed.state.phase, 'coder_scope');
  });
}
