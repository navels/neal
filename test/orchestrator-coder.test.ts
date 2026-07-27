import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runOnePass } from '../src/neal/orchestrator.js';
import { createRunLogger } from '../src/neal/logger.js';
import { clearProviderCapabilitiesOverridesForTesting, clearProviderDefinitionRegistrationsForTesting, registerProviderDefinitionForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { type CoderRunPromptArgs, type CoderStructuredPromptArgs } from '../src/neal/providers/types.js';
import { runCoderScopePhase, runExecuteResponsePhase } from '../src/neal/orchestrator/phases/coder.js';
import { buildStatusSnapshot } from '../src/neal/status.js';
import { loadState, saveState } from '../src/neal/state.js';
import { createFakeProviderDefinition } from './helpers/fake-provider.js';
import { writeRepoConfig, createNotifyCapture, runGit, createCoderScopeManualGateFixture, readRunEvents, openAICodexProviderError, createExecuteFinalizationFixture } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-coder');

test('Codex provider-authored failure propagates through failed coder artifacts', async () => {
  const fixture = await createCoderScopeManualGateFixture();
  const capacityMessage = 'Selected model is at capacity. Please try a different model.';
  const genericProcessMessage = 'Reading prompt from stdin';
  const sessionHandle = 'codex-capacity-session';
  const fixtureState = await saveState(fixture.statePath, {
    ...fixture.state,
    agentConfig: {
      ...fixture.state.agentConfig,
      coder: { provider: 'openai-codex', model: null },
    },
    coderSessionHandle: null,
    coderSessionProtocol: null,
    coderRetryCount: 0,
  });
  const logger = await createRunLogger({
    cwd: fixtureState.cwd,
    stateDir: dirname(fixture.statePath),
    planDoc: fixtureState.planDoc,
    topLevelMode: fixtureState.topLevelMode,
    runDir: fixtureState.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text coder scope prompt: ${args.prompt}`);
        },
        async runStructuredPrompt(args: CoderStructuredPromptArgs) {
          assert.equal(args.resumeHandle, null);
          await args.onSessionStarted?.(sessionHandle);
          await args.events?.({
            type: 'provider_error',
            provider: 'openai-codex',
            role: 'coder',
            sessionHandle,
            message: capacityMessage,
            errorKind: 'api_error',
          });
          throw openAICodexProviderError({
            message: capacityMessage,
            sessionHandle,
            kind: 'api_error',
            retryable: true,
          });
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runCoderScopePhase(fixtureState, fixture.statePath, logger),
      (error) => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : '';
        assert.match(message, /Selected model is at capacity/);
        assert.doesNotMatch(message, /Reading prompt from stdin/);
        assert.equal((error as { sessionHandle?: unknown }).sessionHandle, sessionHandle);
        assert.equal((error as { kind?: unknown }).kind, 'api_error');
        assert.equal((error as { retryable?: unknown }).retryable, true);
        assert.equal(
          (error as { providerError?: { provider?: unknown } }).providerError?.provider,
          'openai-codex',
        );
        return true;
      },
    );

    const failedState = await loadState(fixture.statePath);
    assert.equal(failedState.phase, 'coder_scope');
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.coderSessionHandle, sessionHandle);
    assert.equal(failedState.coderSessionProtocol, 'structured_json_v1');

    const events = await readRunEvents(failedState.runDir);
    const providerErrorIndex = events.findIndex((event) => event.type === 'provider.provider_error');
    const phaseErrorIndex = events.findIndex(
      (event) => event.type === 'phase.error' && event.data?.phase === 'coder_scope',
    );
    assert.notEqual(providerErrorIndex, -1);
    assert.notEqual(phaseErrorIndex, -1);
    assert.equal(providerErrorIndex < phaseErrorIndex, true);

    const providerError = events[providerErrorIndex];
    const phaseError = events[phaseErrorIndex];
    assert.equal(providerError.data?.provider, 'openai-codex');
    assert.equal(providerError.data?.role, 'coder');
    assert.equal(providerError.data?.sessionHandle, sessionHandle);
    assert.equal(providerError.data?.errorKind, 'api_error');
    assert.match(String(providerError.data?.message ?? ''), /Selected model is at capacity/);
    assert.doesNotMatch(String(providerError.data?.message ?? ''), new RegExp(genericProcessMessage));
    assert.equal(phaseError.data?.sessionHandle, sessionHandle);
    assert.match(String(phaseError.data?.message ?? ''), /Selected model is at capacity/);
    assert.doesNotMatch(String(phaseError.data?.message ?? ''), new RegExp(genericProcessMessage));

    const snapshot = await buildStatusSnapshot({ cwd: fixture.cwd, statePath: fixture.statePath });
    assert.equal(snapshot.phase, 'coder_scope');
    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.providerError?.source, 'provider_event');
    assert.equal(snapshot.providerError?.provider, 'openai-codex');
    assert.equal(snapshot.providerError?.role, 'coder');
    assert.equal(snapshot.providerError?.sessionHandle, sessionHandle);
    assert.equal(snapshot.providerError?.kind, 'api_error');
    assert.match(snapshot.providerError?.message ?? '', /Selected model is at capacity/);
    assert.equal(snapshot.lastMeaningfulEvent?.type, 'provider.provider_error');
    assert.match(snapshot.lastMeaningfulEvent?.summary ?? '', /Selected model is at capacity/);
    assert.doesNotMatch(snapshot.lastMeaningfulEvent?.summary ?? '', new RegExp(genericProcessMessage));

    const narrativeMarkdown = await readFile(join(failedState.runDir, 'RUN_NARRATIVE.md'), 'utf8');
    assert.match(narrativeMarkdown, /Selected model is at capacity/);
    assert.doesNotMatch(narrativeMarkdown, new RegExp(genericProcessMessage));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope manual_gate opens gate without reviewer or blocked recovery routing', async () => {
  const fixture = await createCoderScopeManualGateFixture();
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-manual-gate-coder',
      coderStructuredResponses: [
        {
          action: 'manual_gate',
          message: 'Waiting for staging approval.',
          progress: {
            milestoneTargeted: 'Manual gate transition',
            newEvidence: 'The fake coder returned a manual gate payload.',
            whyNotRedundant: 'This exercises the manual-gate routing branch before reviewer handoff.',
            nextStepUnlocked: 'Resume checks can continue coder_scope.',
          },
          manualGate: {
            id: 'staging-approval',
            title: 'Approve staging deployment',
            reason: 'The staging deployment requires a human approval step.',
            instructionsMarkdown: 'Approve the staging deployment, then rerun Neal resume.',
            resumeChecks: [
              { type: 'command', name: 'approval marker', command: ['test', '-f', 'approved.txt'], cwd: 'repo' },
            ],
          },
          derivedPlan: '',
          blockedReason: '',
        },
      ],
    }),
  );

  try {
    const logger = await createRunLogger({
      cwd: fixture.cwd,
      stateDir: dirname(dirname(fixture.runDir)),
      planDoc: fixture.state.planDoc,
      topLevelMode: fixture.state.topLevelMode,
      runDir: fixture.runDir,
    });
    const nextState = await runCoderScopePhase(fixture.state, fixture.statePath, logger);

    assert.equal(nextState.phase, 'manual_gate');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.blockedFromPhase, null);
    assert.equal(nextState.lastScopeMarker, null);
    assert.equal(nextState.coderRetryCount, 0);
    assert.equal(nextState.manualGate?.id, 'staging-approval');
    assert.equal(nextState.manualGate?.resumePhase, 'coder_scope');
    assert.equal(nextState.manualGate?.lastCheckedAt, null);
    assert.equal(nextState.manualGate?.lastFailure, null);
    assert.deepEqual(nextState.createdCommits, []);
    assert.equal(nextState.rounds.length, 0);
    assert.equal(nextState.recentBlocks.length, 0);
    assert.equal(nextState.interactiveBlockedRecovery, null);

    const gateMarkdown = await readFile(join(fixture.runDir, 'GATE-staging-approval.md'), 'utf8');
    assert.match(gateMarkdown, /# Approve staging deployment/);
    assert.match(gateMarkdown, /Approve the staging deployment, then rerun Neal resume\./);
    assert.match(gateMarkdown, /\["test","-f","approved\.txt"\]/);
    assert.match(gateMarkdown, /neal resume --run manual-gate-run/);
    assert.match(gateMarkdown, /resume the same `coder_scope`/);

    const persisted = await loadState(fixture.statePath);
    assert.equal(persisted.manualGate?.instructionsPath, join(fixture.runDir, 'GATE-staging-approval.md'));
    assert.match(await readFile(fixture.notifyLogPath, 'utf8'), /waiting for manual gate staging-approval/);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('coder scope drops ignored files from coder-created commits and leaves them local', async () => {
  const fixture = await createCoderScopeManualGateFixture();
  let originalCommit = '';
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-manual-gate-coder',
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        await mkdir(join(args.cwd, 'tmp'), { recursive: true });
        await writeFile(join(args.cwd, '.gitignore'), 'tmp/\n', 'utf8');
        await writeFile(join(args.cwd, 'scope.txt'), 'base\nimplemented\n', 'utf8');
        await writeFile(join(args.cwd, 'tmp', 'OVDX-11580-scope3-verification.md'), 'local verification notes\n', 'utf8');
        await runGit(args.cwd, 'add', '.gitignore', 'scope.txt');
        await runGit(args.cwd, 'add', '-f', 'tmp/OVDX-11580-scope3-verification.md');
        await runGit(args.cwd, 'commit', '-m', 'Implement scope with scratch verification notes');
        originalCommit = await runGit(args.cwd, 'rev-parse', 'HEAD');
      },
      coderStructuredResponses: [
        {
          action: 'scope_done',
          message: 'Implemented the bounded execution slice.',
          progress: {
            milestoneTargeted: 'Ignored-file cleanup regression',
            newEvidence: 'The fake coder committed source changes and an ignored verification note.',
            whyNotRedundant: 'This covers Neal cleanup after a coder force-adds ignored scratch files.',
            nextStepUnlocked: 'Reviewer can inspect the source change without the ignored note in history.',
          },
          manualGate: null,
          derivedPlan: '',
          blockedReason: '',
        },
      ],
    }),
  );

  try {
    const logger = await createRunLogger({
      cwd: fixture.cwd,
      stateDir: dirname(dirname(fixture.runDir)),
      planDoc: fixture.state.planDoc,
      topLevelMode: fixture.state.topLevelMode,
      runDir: fixture.runDir,
    });
    const nextState = await runCoderScopePhase(fixture.state, fixture.statePath, logger);

    assert.equal(nextState.phase, 'reviewer_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.createdCommits.length, 1);
    assert.notEqual(nextState.createdCommits[0], originalCommit);
    assert.match(await runGit(fixture.cwd, 'show', '--name-only', '--format=', nextState.createdCommits[0]), /scope\.txt/);
    assert.doesNotMatch(
      await runGit(fixture.cwd, 'show', '--name-only', '--format=', nextState.createdCommits[0]),
      /OVDX-11580-scope3-verification\.md/,
    );
    assert.equal(await readFile(join(fixture.cwd, 'tmp', 'OVDX-11580-scope3-verification.md'), 'utf8'), 'local verification notes\n');
    assert.equal(await runGit(fixture.cwd, 'status', '--short', '--ignored', '--', 'tmp'), '!! tmp/');
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('coder scope commits dirty implementation changes when coder forgets to commit', async () => {
  const fixture = await createCoderScopeManualGateFixture();
  registerProviderDefinitionForTesting(
    createFakeProviderDefinition({
      id: 'fake-manual-gate-coder',
      onCoderStructuredRun: async (args: CoderStructuredPromptArgs) => {
        await writeFile(join(args.cwd, 'scope.txt'), 'base\nimplemented without commit\n', 'utf8');
        await writeFile(join(args.cwd, 'CURRENT_PLAN.md'), 'wrapper scratch\n', 'utf8');
      },
      coderStructuredResponses: [
        {
          action: 'scope_done',
          message: 'Implemented the scope but forgot to commit.',
          progress: {
            milestoneTargeted: 'Dirty worktree commit regression',
            newEvidence: 'The fake coder edited scope.txt without creating a git commit.',
            whyNotRedundant: 'This covers providers that can edit files but do not follow the commit instruction.',
            nextStepUnlocked: 'Reviewer can inspect a committed scope diff.',
          },
          manualGate: null,
          derivedPlan: '',
          blockedReason: '',
        },
      ],
    }),
  );

  try {
    const logger = await createRunLogger({
      cwd: fixture.cwd,
      stateDir: dirname(dirname(fixture.runDir)),
      planDoc: fixture.state.planDoc,
      topLevelMode: fixture.state.topLevelMode,
      runDir: fixture.runDir,
    });
    const nextState = await runCoderScopePhase(fixture.state, fixture.statePath, logger);

    assert.equal(nextState.phase, 'reviewer_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.createdCommits.length, 1);
    assert.match(await runGit(fixture.cwd, 'show', '--name-only', '--format=', nextState.createdCommits[0]), /scope\.txt/);
    assert.doesNotMatch(
      await runGit(fixture.cwd, 'show', '--name-only', '--format=', nextState.createdCommits[0]),
      /CURRENT_PLAN\.md/,
    );
    assert.match(await runGit(fixture.cwd, 'status', '--short'), /\?\? CURRENT_PLAN\.md/);

    const events = await readRunEvents(nextState.runDir);
    assert.equal(events.some((event) => event.type === 'coder_scope.autocommit_dirty_worktree'), true);
  } finally {
    clearProviderDefinitionRegistrationsForTesting();
  }
});

test('coder response commits dirty review fixes when coder forgets to commit', async () => {
  const { statePath, state: fixtureState, cwd } = await createExecuteFinalizationFixture({
    currentScopeNumber: 6,
    phase: 'coder_response',
    status: 'running',
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session',
        reviewedPlanPath: 'PLAN.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'base', head: 'head' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['scope.txt'],
        claim: 'Review response needs another code change.',
        evidence: 'The current implementation lacks the reviewed fix.',
        requiredAction: 'Patch scope.txt and commit the response.',
        status: 'open',
        roundSummary: 'One blocking finding remains.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });
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
          throw new Error('provider should not be called for text coder response prompt');
        },
        async runStructuredPrompt<TStructured>() {
          await writeFile(join(cwd, 'scope.txt'), 'base\nchange\nreview fix without commit\n', 'utf8');
          return {
            sessionHandle: null,
            structured: {
              outcome: 'responded',
              summary: 'Fixed the review finding but forgot to commit.',
              blocker: '',
              derivedPlan: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Updated scope.txt.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runExecuteResponsePhase(fixtureState, statePath, 'coder_response', logger);

    assert.equal(nextState.phase, 'reviewer_scope');
    assert.equal(nextState.status, 'running');
    assert.equal(nextState.createdCommits.length, 2);
    const responseCommit = nextState.createdCommits.at(-1);
    assert.ok(responseCommit);
    assert.match(await runGit(cwd, 'show', '--name-only', '--format=', responseCommit), /scope\.txt/);
    assert.match(await runGit(cwd, 'show', '--quiet', '--format=%s', responseCommit), /Address review findings for scope 6/);
    assert.doesNotMatch(await runGit(cwd, 'status', '--short'), /scope\.txt/);

    const events = await readRunEvents(nextState.runDir);
    assert.equal(
      events.some((event) => event.type === 'coder_response.autocommit_dirty_worktree'),
      true,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope inactivity timeout retries once on a fresh session and records retry diagnostics before failing cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-coder-timeout-retry-'));
  const { notifyLogPath, notifyScriptPath } = await createNotifyCapture(root);
  const { statePath, state: executeFinalizationState } = await createExecuteFinalizationFixture({
    currentScopeNumber: 4,
    createdCommits: [],
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'stale-session',
    coderSessionProtocol: 'legacy_marker_v1',
  });
  await writeRepoConfig(executeFinalizationState.cwd, { notifyBin: notifyScriptPath });
  const fixtureState = await saveState(statePath, {
    ...executeFinalizationState,
    currentScopeNumber: 4,
    createdCommits: [],
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'stale-session',
    coderSessionProtocol: 'legacy_marker_v1',
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

  let textCoderCalls = 0;
  let structuredCoderCalls = 0;
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          textCoderCalls += 1;
          assert.equal(args.resumeHandle, 'stale-session');
          throw openAICodexProviderError({
            message: 'Coder timed out after 600000ms of inactivity',
            sessionHandle: 'stale-session',
            kind: 'timeout',
            retryable: true,
          });
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          structuredCoderCalls += 1;
          assert.equal(args.resumeHandle, null);
          await args.onSessionStarted?.('fresh-session');
          throw openAICodexProviderError({
            message: 'coder retry failed after fresh session',
            sessionHandle: 'fresh-session',
          });
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runOnePass(fixtureState, statePath, logger),
      /coder retry failed after fresh session/,
    );

    assert.equal(textCoderCalls, 1);
    assert.equal(structuredCoderCalls, 1);
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

test('coder response retries once on a fresh session when Codex rejects corrupt resume history', async () => {
  const { statePath, state: baseState, notifyLogPath } = await createExecuteFinalizationFixture({
    currentScopeNumber: 9,
    phase: 'coder_response',
    status: 'running',
    coderSessionHandle: 'corrupt-session',
    coderRetryCount: 0,
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session',
        reviewedPlanPath: 'PLAN.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'base', head: 'head' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['src/neal/orchestrator.ts'],
        claim: 'Fix the regression.',
        evidence: 'The reviewed diff misses a user-visible path.',
        requiredAction: 'Patch the code and add coverage.',
        status: 'open',
        roundSummary: 'One blocking finding remains.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });
  const logger = await createRunLogger({
    cwd: baseState.cwd,
    stateDir: dirname(statePath),
    planDoc: baseState.planDoc,
    topLevelMode: baseState.topLevelMode,
    runDir: baseState.runDir,
  });

  let coderCalls = 0;
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text coder response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          coderCalls += 1;
          if (coderCalls === 1) {
            assert.equal(args.resumeHandle, 'corrupt-session');
            throw openAICodexProviderError({
              message: 'invalid_request_error: property_name_above_max_length; Orphan function call output for call id:',
              sessionHandle: 'corrupt-session',
              kind: 'session_unavailable',
              retryable: true,
            });
          }

          assert.equal(args.resumeHandle, null);
          throw openAICodexProviderError({
            message: 'fresh retry failed after corrupt history',
            sessionHandle: 'fresh-session',
          });
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runOnePass(baseState, statePath, logger),
      /fresh retry failed after corrupt history/,
    );

    assert.equal(coderCalls, 2);
    const failedState = await loadState(statePath);
    assert.equal(failedState.phase, 'coder_response');
    assert.equal(failedState.status, 'failed');
    assert.equal(failedState.coderRetryCount, 1);
    assert.equal(failedState.coderSessionHandle, 'fresh-session');

    const events = await readRunEvents(failedState.runDir);
    assert.ok(events.some((event) => event.type === 'phase.retry' && event.data?.phase === 'coder_response'));

    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /scope 9 hit an unusable resume session in coder_response; retrying with a fresh coder session/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope stream failure after a clean commit recovers directly into review', async () => {
  const { statePath, state: fixtureState } = await createExecuteFinalizationFixture({
    currentScopeNumber: 14,
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'interrupted-session',
    coderSessionProtocol: 'legacy_marker_v1',
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
          throw openAICodexProviderError({
            message: 'stream disconnected before completion: request failed after commit',
            sessionHandle: 'recovered-coder-session',
          });
        },
        async runStructuredPrompt() {
          throw new Error('provider should not be called for structured coder scope prompt');
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

test('coder response stream failure after a clean commit recovers directly into review', async () => {
  const { statePath, state: fixtureState, cwd } = await createExecuteFinalizationFixture({
    currentScopeNumber: 16,
    phase: 'coder_response',
    status: 'running',
    coderSessionHandle: null,
    coderSessionProtocol: null,
    createdCommits: [],
    currentScopeProgressJustification: {
      milestoneTargeted: 'Address review finding',
      newEvidence: 'Reviewer asked for a focused follow-up.',
      whyNotRedundant: 'The follow-up has not been reviewed yet.',
      nextStepUnlocked: 'Reviewer can check the response commit.',
    },
    rounds: [
      {
        round: 1,
        reviewerSessionHandle: 'reviewer-session',
        reviewedPlanPath: 'PLAN.md',
        normalizationApplied: false,
        normalizationOperations: [],
        normalizationScopeLabelMappings: [],
        commitRange: { base: 'base', head: 'head' },
        openBlockingCanonicalCount: 1,
        findings: ['R1-F1'],
      },
    ],
    findings: [
      {
        id: 'R1-F1',
        canonicalId: 'C1',
        round: 1,
        source: 'reviewer',
        severity: 'blocking',
        files: ['scope.txt'],
        claim: 'Review response needs a concrete code change.',
        evidence: 'The prior commit did not update scope.txt.',
        requiredAction: 'Patch scope.txt and commit the response.',
        status: 'open',
        roundSummary: 'One blocking finding remains.',
        coderDisposition: null,
        coderCommit: null,
      },
    ],
  });
  await writeFile(join(cwd, '.git', 'info', 'exclude'), '.neal/\n', 'utf8');
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
          throw new Error('provider should not be called for text coder response prompt');
        },
        async runStructuredPrompt() {
          await writeFile(join(cwd, 'scope.txt'), 'base\nchange\nreview response\n', 'utf8');
          await runGit(cwd, 'add', 'scope.txt');
          await runGit(cwd, 'commit', '-m', 'Address review finding');
          throw openAICodexProviderError({
            message: 'stream disconnected before completion: request failed after review response commit',
            sessionHandle: 'response-session',
          });
        },
      };
    },
  });
  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound() {
          reviewerCalled = true;
          throw new Error('stop after recovered response review');
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runOnePass(fixtureState, statePath, logger),
      /stop after recovered response review/,
    );

    assert.equal(reviewerCalled, true);
    const recoveredState = await loadState(statePath);
    assert.equal(recoveredState.phase, 'reviewer_scope');
    assert.equal(recoveredState.status, 'running');
    assert.equal(recoveredState.createdCommits.length, 1);
    assert.equal(recoveredState.coderRetryCount, 0);

    const events = await readRunEvents(recoveredState.runDir);
    assert.equal(
      events.some((event) => event.type === 'run.recovered_pending_review_after_coder_response_failure'),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'phase.error' && event.data?.phase === 'coder_response'),
      false,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('coder scope stream failure with dirty committed work still fails instead of recovering', async () => {
  const { statePath, state: fixtureState, cwd } = await createExecuteFinalizationFixture({
    currentScopeNumber: 15,
    phase: 'coder_scope',
    status: 'running',
    coderSessionHandle: 'interrupted-session',
    coderSessionProtocol: 'legacy_marker_v1',
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
          throw openAICodexProviderError({
            message: 'stream disconnected before completion: request failed with dirty worktree',
            sessionHandle: 'failed-coder-session',
          });
        },
        async runStructuredPrompt() {
          throw new Error('provider should not be called for structured coder scope prompt');
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
