import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSupportedNealActionType } from '../src/neal/context/shared.js';
import type { NealStatusSnapshot as StatusSnapshot } from '../src/neal/status.js';
import {
  buildRunNarrativeSummary,
  getRunNarrativeJsonArtifactPath,
  getRunNarrativeMarkdownArtifactPath,
  renderRunNarrativeMarkdown,
  writeRunNarrativeArtifacts,
} from '../src/neal/run-narrative.js';
import { createInitialState, getDefaultAgentConfig, getRunStatePath } from '../src/neal/state.js';
import type { OrchestrationState, ReviewFinding } from '../src/neal/types.js';

const NOW = new Date('2026-04-25T18:15:52.082Z');

test('buildRunNarrativeSummary summarizes a running run with verification commands', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 3,
      currentScopeProgressJustification: {
        milestoneTargeted: 'Wire narrative builder',
        newEvidence: 'Added deterministic summary code',
        whyNotRedundant: 'The existing status model has no narrative shape',
        nextStepUnlocked: 'Worker detail can expose narrative data',
      },
    }),
    events: [
      event('2026-04-25T18:14:00.000Z', 'phase.start', { phase: 'coder_scope' }),
      event('2026-04-25T18:15:00.000Z', 'coder.command_execution', { command: 'pnpm typecheck' }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.match(summary.headline, /running/i);
  assert.equal(summary.run.effectiveStatus, 'running');
  assert.equal(summary.run.waitingForOperatorGuidance, false);
  assert.equal(summary.run.pendingOperatorGuidance, false);
  assert.equal(summary.run.currentScopeNumber, 3);
  assert.equal(summary.run.derivedPlan, null);
  assert.equal(summary.run.health?.classification, 'ok');
  assert.deepEqual(summary.verification.commands, ['pnpm typecheck']);
  assert.equal(summary.recommendedAction?.type, 'resume');
  assert.equal(summary.recommendedAction?.target.runDirName, '2026-04-25T18-00-00.000Z-test');
  assert.equal(summary.artifactAvailability.runStateJson, true);
});

test('buildRunNarrativeSummary includes normalized provider command events in verification summary', async (t) => {
  const fixture = await createNarrativeFixture({
    events: [
      event('2026-04-25T18:14:00.000Z', 'phase.start', { phase: 'coder_scope' }),
      event('2026-04-25T18:15:00.000Z', 'provider.command_completed', {
        provider: 'openai-codex',
        role: 'coder',
        command: 'pnpm exec tsx --test test/run-narrative.test.ts',
        status: 'completed',
        exitCode: 0,
      }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.deepEqual(summary.verification.commands, ['pnpm exec tsx --test test/run-narrative.test.ts']);
  assert.equal(summary.verification.lastCommand, 'pnpm exec tsx --test test/run-narrative.test.ts');
  assert.equal(summary.verification.source, 'events.ndjson');
});

test('buildRunNarrativeSummary adds benchmark trace fields from supplied status snapshots', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'done',
      phase: 'done',
      finalCommit: 'final456',
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });
  const snapshot: StatusSnapshot = {
    ...sampleStatusSnapshot(fixture, 'ok'),
    publicStatus: 'done',
    publicPhase: 'complete',
    squash: {
      artifactPath: join(fixture.runDir, 'SQUASH_RESULT.json'),
      status: 'complete',
      replacementCommit: 'squash789',
      finalHeadCommit: 'head789',
      originalBaseCommit: 'base123',
      originalFinalCommit: 'final456',
      unavailableReason: null,
    },
    providerError: {
      source: 'provider_event',
      timestamp: '2026-04-25T18:14:30.000Z',
      provider: 'openai-codex',
      role: 'coder',
      label: 'scope',
      sessionHandle: 'coder-session',
      kind: 'api_error',
      message: 'model capacity reached',
      retryable: true,
      diagnostic: null,
    },
    build: {
      source: 'meta',
      packageVersion: '1.2.3-test',
      nodeVersion: 'v24.0.0',
      sourceGitSha: 'abc123',
      agentConfig: {
        planner: {
          provider: 'openai-codex',
          model: 'gpt-5',
        },
        coder: {
          provider: 'openai-codex',
          model: 'gpt-5',
        },
        reviewer: {
          provider: 'anthropic-claude',
          model: 'claude-opus-4-1',
        },
      },
    },
    patch: {
      defaultSubmissionEligible: true,
      reason: 'Completed execute run has a non-empty patch range.',
      source: 'squash_replacement',
      baseCommit: 'base123',
      headCommit: 'squash789',
      range: 'base123..squash789',
      commitCount: 1,
      changedFileCount: 2,
      changedFiles: ['src/a.ts', 'test/a.test.ts'],
      unavailableReason: null,
    },
  };

  const summary = await buildRunNarrativeSummary({
    cwd: fixture.cwd,
    statePath: fixture.statePath,
    snapshot,
    now: NOW,
  });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.equal(summary.benchmarkTrace.publicStatus, 'done');
  assert.equal(summary.benchmarkTrace.publicPhase, 'complete');
  assert.equal(summary.benchmarkTrace.patch.defaultSubmissionEligible, true);
  assert.equal(summary.benchmarkTrace.patch.source, 'squash_replacement');
  assert.equal(summary.benchmarkTrace.patch.baseCommit, 'base123');
  assert.equal(summary.benchmarkTrace.patch.headCommit, 'squash789');
  assert.equal(summary.benchmarkTrace.patch.changedFileCount, 2);
  assert.equal(summary.benchmarkTrace.squash.replacementCommit, 'squash789');
  assert.equal(summary.benchmarkTrace.providerError?.kind, 'api_error');
  assert.equal(summary.benchmarkTrace.build.packageVersion, '1.2.3-test');
  assert.equal(summary.benchmarkTrace.agent.planner.model, 'gpt-5');
  assert.equal(summary.benchmarkTrace.agent.coder.model, 'gpt-5');
  assert.match(markdown, /## Benchmark Trace/);
  assert.match(markdown, /- Patch eligible: yes - Completed execute run has a non-empty patch range\./);
  assert.match(markdown, /- Patch range: base123\.\.squash789/);
  assert.match(markdown, /- Squash replacement commit: squash789/);
  assert.match(markdown, /- Provider error: openai-codex coder api_error - model capacity reached/);
  assert.match(markdown, /- Neal build: package 1\.2\.3-test, source abc123, Node v24\.0\.0/);
  assert.match(markdown, /- Planner: openai-codex gpt-5/);
  assert.match(markdown, /- Coder: openai-codex gpt-5/);
  assert.match(markdown, /- Status command: neal status --json --run 2026-04-25T18-00-00\.000Z-test/);
});

test('renderRunNarrativeMarkdown keeps benchmark trace free of raw provider and event payloads', async (t) => {
  const sensitiveValues = [
    'RAW_PROVIDER_PAYLOAD',
    'RAW_ASSISTANT_TEXT',
    'SECRET_COMMAND_OUTPUT',
    'RAW_STDERR_TAIL',
    'SECRET_ENV_VALUE',
    'diff --git a/secret.ts b/secret.ts',
    '/Users/example/private/project',
  ];
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'failed',
      phase: 'blocked',
    }),
    events: [
      event('2026-04-25T18:13:00.000Z', 'provider.assistant_text', {
        provider: 'anthropic-claude',
        role: 'structured-advisor',
        label: 'review',
        text: 'RAW_ASSISTANT_TEXT with local detail /Users/example/private/project',
      }),
      event('2026-04-25T18:14:00.000Z', 'provider.command_completed', {
        provider: 'openai-codex',
        role: 'coder',
        command: 'pnpm typecheck',
        status: 'completed',
        exitCode: 0,
        cwd: '/Users/example/private/project',
        output: 'SECRET_COMMAND_OUTPUT',
        stderr: 'RAW_STDERR_TAIL',
        diff: 'diff --git a/secret.ts b/secret.ts',
      }),
      event('2026-04-25T18:15:00.000Z', 'provider.provider_error', {
        provider: 'openai-codex',
        role: 'coder',
        label: 'scope',
        sessionHandle: 'coder-session',
        errorKind: 'api_error',
        retryable: false,
        message: 'model capacity reached',
        providerData: {
          raw: 'RAW_PROVIDER_PAYLOAD',
          cwd: '/Users/example/private/project',
          env: {
            TOKEN: 'SECRET_ENV_VALUE',
          },
        },
      }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.equal(summary.benchmarkTrace.publicStatus, 'failed');
  assert.equal(summary.benchmarkTrace.providerError?.provider, 'openai-codex');
  assert.equal(summary.benchmarkTrace.providerError?.kind, 'api_error');
  assert.equal(summary.benchmarkTrace.providerError?.message, 'model capacity reached');
  assert.equal(summary.benchmarkTrace.patch.defaultSubmissionEligible, false);
  assert.match(markdown, /## Benchmark Trace/);
  assert.match(markdown, /- Public status: failed/);
  assert.match(markdown, /- Provider error: openai-codex coder api_error - model capacity reached/);
  assert.match(markdown, /- Public trace artifact: \.neal\/runs\/2026-04-25T18-00-00\.000Z-test\/RUN_NARRATIVE\.md/);
  for (const sensitiveValue of sensitiveValues) {
    assert.equal(markdown.includes(sensitiveValue), false, `markdown exposed ${sensitiveValue}`);
    assert.equal(JSON.stringify(summary.benchmarkTrace).includes(sensitiveValue), false, `benchmark trace exposed ${sensitiveValue}`);
  }
});

test('buildRunNarrativeSummary reports an unexecuted rejected derived plan without completed-run wording', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'done',
      phase: 'done',
      currentScopeNumber: 4,
      derivedPlanPath: join(state.runDir, 'DERIVED_PLAN_SCOPE_4.md'),
      derivedFromScopeNumber: 4,
      derivedPlanStatus: 'rejected',
      derivedScopeIndex: null,
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.match(summary.headline, /unexecuted rejected derived plan/i);
  assert.doesNotMatch(summary.headline, /\bdone\b/i);
  assert.doesNotMatch(summary.headline, /completed/i);
  assert.equal(summary.run.derivedPlan?.abandoned, true);
  assert.equal(summary.run.derivedPlan?.parentScopeNumber, 4);
  assert.match(markdown, /Derived plan: rejected, abandoned, parent scope 4/);
});

test('buildRunNarrativeSummary reports interactive blocked recovery', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'blocked',
      phase: 'interactive_blocked_recovery',
      interactiveBlockedRecovery: {
        enteredAt: '2026-04-25T18:10:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Review findings stopped converging.',
        maxTurns: 3,
        lastHandledTurn: 0,
        pendingDirective: null,
        turns: [],
      },
    }),
    events: [
      event('2026-04-25T18:12:00.000Z', 'interactive_blocked_recovery.entered', { blocker: 'Need operator guidance' }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.equal(summary.blocker.active, true);
  assert.match(summary.blocker.summary ?? '', /Review findings stopped converging/);
  assert.equal(summary.recommendedAction?.type, 'recover');
  assert.equal(summary.recommendedAction?.target.statePath, '.neal/runs/2026-04-25T18-00-00.000Z-test/RUN_STATE.json');
});

test('buildRunNarrativeSummary uses public scope-accounting blocker guidance', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      ...scopeAccountingGuardrailState(),
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.match(summary.headline, /scope-accounting guardrail/);
  assert.doesNotMatch(summary.headline, /Unsafe advance_parent|failed preconditions|accepted derived plan is not actively executing/);
  assert.equal(summary.blocker.active, true);
  assert.match(summary.blocker.summary ?? '', /scope-accounting guardrail/);
  assert.deepEqual(summary.blocker.sources[0], 'blocked guidance');
  assert.match(summary.blocker.technicalDetails.join('\n'), /accepted derived plan is not actively executing/);
  assert.match(summary.recommendedAction?.rationale ?? '', /scope-accounting guardrail/);
  assert.doesNotMatch(summary.recommendedAction?.rationale ?? '', /Unsafe advance_parent|failed preconditions/);
  assert.match(markdown, /- Technical details:/);
  assert.match(markdown, /accepted derived plan is not actively executing/);
  assert.ok(summary.artifactPaths.runStateJson?.endsWith('/RUN_STATE.json'));
});

test('buildRunNarrativeSummary reports terminal invalid split-plan diagnostics', async (t) => {
  const validationReason = 'split-plan payload is not a valid Neal-executable plan: executionShape: multi_scope must not include a `## Completion Condition` section.';
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'blocked',
      phase: 'blocked',
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
    events: [
      event('2026-04-25T18:12:00.000Z', 'split_plan.invalid_payload', {
        scopeNumber: 5,
        sourcePhase: 'reviewer_scope',
        validationErrors: ['executionShape: multi_scope must not include a `## Completion Condition` section.'],
        invalidPayloadPath: '.neal/runs/2026-04-25T18-00-00.000Z-test/SCOPE_5_INVALID_DERIVED_PLAN.md',
      }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });
  const invalidPayloadPath = join(fixture.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md');
  await writeFile(invalidPayloadPath, '# Invalid Derived Plan Payload\n', 'utf8');

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.equal(summary.blocker.active, true);
  assert.match(summary.blocker.summary ?? '', /must not include a `## Completion Condition` section/);
  assert.deepEqual(summary.blocker.sources, ['RUN_STATE.json completed scopes', 'events.ndjson']);
  assert.equal(summary.artifactAvailability.invalidDerivedPlanPayload, true);
  assert.equal(summary.artifactPaths.invalidDerivedPlanPayload, '.neal/runs/2026-04-25T18-00-00.000Z-test/SCOPE_5_INVALID_DERIVED_PLAN.md');
  assert.match(markdown, /- Active: yes/);
  assert.match(markdown, /invalidDerivedPlanPayload: \.neal\/runs\/2026-04-25T18-00-00\.000Z-test\/SCOPE_5_INVALID_DERIVED_PLAN\.md/);
});

test('buildRunNarrativeSummary headlines waiting recovery as waiting instead of running', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'running',
      phase: 'interactive_blocked_recovery',
      interactiveBlockedRecovery: {
        enteredAt: '2026-04-25T18:10:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Review findings need operator input.',
        maxTurns: 3,
        lastHandledTurn: 1,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-25T18:11:00.000Z',
            operatorGuidance: 'Stay blocked until the owner answers.',
            origin: 'operator',
            disposition: null,
          },
        ],
      },
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.match(summary.headline, /waiting for operator guidance/i);
  assert.doesNotMatch(summary.headline, /Neal running/i);
  assert.equal(summary.run.status, 'running');
  assert.equal(summary.run.effectiveStatus, 'waiting_for_operator');
  assert.equal(summary.run.waitingForOperatorGuidance, true);
  assert.equal(summary.run.pendingOperatorGuidance, false);
  assert.equal(summary.run.health?.classification, 'blocked');
  assert.equal(summary.recommendedAction?.type, 'recover');
});

test('buildRunNarrativeSummary recommends resume when operator guidance is pending', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'running',
      phase: 'interactive_blocked_recovery',
      interactiveBlockedRecovery: {
        enteredAt: '2026-04-25T18:10:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Review findings need operator input.',
        maxTurns: 3,
        lastHandledTurn: 0,
        pendingDirective: null,
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-25T18:11:00.000Z',
            operatorGuidance: 'Continue with a smaller fix.',
            origin: 'operator',
            disposition: null,
          },
        ],
      },
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.equal(summary.run.status, 'running');
  assert.equal(summary.run.effectiveStatus, 'running');
  assert.equal(summary.run.waitingForOperatorGuidance, false);
  assert.equal(summary.run.pendingOperatorGuidance, true);
  assert.equal(summary.recommendedAction?.type, 'resume');
});

test('buildRunNarrativeSummary includes active manual gate details', async (t) => {
  const fixture = await createNarrativeFixture({
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
        createdAt: '2026-04-25T18:15:00.000Z',
        updatedAt: '2026-04-25T18:15:00.000Z',
        lastCheckedAt: null,
        lastFailure: null,
      },
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.equal(summary.run.effectiveStatus, 'waiting_for_manual_gate');
  assert.equal(summary.run.manualGate?.id, 'approval');
  assert.match(summary.headline, /waiting_for_manual_gate/i);
  assert.match(markdown, /Manual gate: approval, Approve deployment/);
  assert.equal(summary.blocker.active, false);
  assert.equal(summary.recommendedAction?.type, 'resume');
});

test('buildRunNarrativeSummary handles failed runs with finding counts', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'failed',
      phase: 'blocked',
      findings: [
        finding('open', 'blocking'),
        finding('open', 'non_blocking'),
        finding('fixed', 'blocking'),
        finding('deferred', 'non_blocking'),
        finding('rejected', 'blocking'),
      ],
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.match(summary.headline, /failed/i);
  assert.deepEqual(summary.findings, {
    total: 5,
    openBlocking: 1,
    openNonBlocking: 1,
    fixed: 1,
    rejected: 1,
    deferred: 1,
  });
  assert.match(summary.blocker.summary ?? '', /claim-open-blocking/);
  assert.equal(summary.recommendedAction?.type, 'resume');
});

test('buildRunNarrativeSummary summarizes completed runs from final completion state', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'done',
      phase: 'done',
      finalCommit: 'abc1234',
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Added the narrative read model.',
        verificationSummary: 'pnpm typecheck passed.',
        remainingKnownGaps: [],
      },
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });
  const markdown = renderRunNarrativeMarkdown(summary);

  assert.match(summary.headline, /done/i);
  assert.equal(summary.run.status, 'done');
  assert.equal(summary.run.health?.classification, 'ok');
  assert.equal(summary.verification.summary, 'pnpm typecheck passed.');
  assert.equal(summary.recommendedAction, null);
  assert.match(markdown, /- Health: ok/);
  assert.match(markdown, /- Type: none/);
  assert.doesNotMatch(markdown, /Review squash opportunity/);
});

test('buildRunNarrativeSummary tolerates missing optional artifacts and bounds output', async (t) => {
  const longCommand = `pnpm exec tsx --test ${'test/really-long-file-name.test.ts '.repeat(20)}`;
  const longReason = 'External prerequisite '.repeat(80);
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'blocked',
      phase: 'interactive_blocked_recovery',
      interactiveBlockedRecovery: {
        enteredAt: '2026-04-25T18:10:00.000Z',
        sourcePhase: 'coder_scope',
        blockedReason: longReason,
        maxTurns: 3,
        lastHandledTurn: 0,
        pendingDirective: null,
        turns: [],
      },
    }),
    events: Array.from({ length: 8 }, (_, index) =>
      event(`2026-04-25T18:15:0${index}.000Z`, 'coder.command_execution', { command: `${longCommand}${index}` }),
    ),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.equal(summary.artifactAvailability.eventsNdjson, true);
  assert.equal(summary.artifactAvailability.planProgressJson, false);
  assert.equal(summary.artifactAvailability.reviewMarkdown, false);
  assert.equal(summary.verification.commands.length, 5);
  assert.ok(summary.verification.commands.every((command) => command.length <= 160));
  assert.ok((summary.blocker.summary ?? '').length <= 320);
  assert.ok(summary.headline.length <= 180);
  assert.ok(summary.recommendedAction && isSupportedNealActionType(summary.recommendedAction.type));
});

test('writeRunNarrativeArtifacts persists consistent JSON and markdown artifacts', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      currentScopeNumber: 2,
    }),
    events: [
      event('2026-04-25T18:14:00.000Z', 'phase.start', { phase: 'coder_scope' }),
      event('2026-04-25T18:15:00.000Z', 'coder.command_execution', { command: 'pnpm typecheck' }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const result = await writeRunNarrativeArtifacts(fixture.state);
  const jsonPath = getRunNarrativeJsonArtifactPath(fixture.runDir);
  const markdownPath = getRunNarrativeMarkdownArtifactPath(fixture.runDir);
  const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
    headline: string;
    sourceDigest?: string;
    benchmarkTrace?: unknown;
  };
  const markdown = await readFile(markdownPath, 'utf8');

  assert.equal(result.changed, true);
  assert.equal(json.headline, result.summary.headline);
  assert.equal(typeof json.sourceDigest, 'string');
  assert.equal(typeof json.benchmarkTrace, 'object');
  assert.match(markdown, /# Run Narrative/);
  assert.match(markdown, /## Benchmark Trace/);
  assert.match(markdown, /- Health: ok/);
  assert.match(markdown, /## Artifact References/);
  assert.ok(markdown.includes(result.summary.headline));
});

test('writeRunNarrativeArtifacts does not recommend squash for completed execute runs', async (t) => {
  const fixture = await createNarrativeFixture({
    mutate: (state) => ({
      ...state,
      status: 'done',
      phase: 'done',
      finalCommit: 'abc1234',
      finalCompletionSummary: {
        planGoalSatisfied: true,
        whatChangedOverall: 'Completed the requested work.',
        verificationSummary: 'pnpm typecheck passed.',
        remainingKnownGaps: [],
      },
    }),
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });

  const result = await writeRunNarrativeArtifacts(fixture.state);
  const markdown = await readFile(getRunNarrativeMarkdownArtifactPath(fixture.runDir), 'utf8');

  assert.equal(result.summary.run.health?.classification, 'ok');
  assert.equal(result.summary.recommendedAction, null);
  assert.match(markdown, /- Health: ok/);
  assert.match(markdown, /- Type: none/);
  assert.doesNotMatch(markdown, /Review squash opportunity/);
});

test('buildRunNarrativeSummary prefers a fresh persisted narrative artifact', async (t) => {
  const fixture = await createNarrativeFixture({});
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });
  await writeRunNarrativeArtifacts(fixture.state);
  const jsonPath = getRunNarrativeJsonArtifactPath(fixture.runDir);
  const artifact = JSON.parse(await readFile(jsonPath, 'utf8')) as Record<string, unknown>;
  artifact.headline = 'Persisted fresh narrative headline.';
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.equal(summary.headline, 'Persisted fresh narrative headline.');
});

test('buildRunNarrativeSummary overlays supplied snapshot health on fresh persisted artifacts', async (t) => {
  const fixture = await createNarrativeFixture({});
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });
  await writeRunNarrativeArtifacts(fixture.state);
  const snapshot = sampleStatusSnapshot(fixture, 'quiet');

  const summary = await buildRunNarrativeSummary({
    cwd: fixture.cwd,
    statePath: fixture.statePath,
    snapshot,
    now: NOW,
  });

  assert.equal(summary.run.health?.classification, 'quiet');
});

test('buildRunNarrativeSummary rebuilds stale narrative artifacts when source events change', async (t) => {
  const fixture = await createNarrativeFixture({
    events: [
      event('2026-04-25T18:14:00.000Z', 'phase.start', { phase: 'coder_scope' }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });
  const firstWrite = await writeRunNarrativeArtifacts(fixture.state);
  await writeFile(
    join(fixture.runDir, 'events.ndjson'),
    [
      event('2026-04-25T18:14:00.000Z', 'phase.start', { phase: 'coder_scope' }),
      event('2026-04-25T18:15:30.000Z', 'coder.command_execution', { command: 'pnpm exec tsx --test test/run-narrative.test.ts' }),
    ].join('\n') + '\n',
    'utf8',
  );

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.notEqual(summary.sourceDigest, firstWrite.summary.sourceDigest);
  assert.equal(summary.verification.lastCommand, 'pnpm exec tsx --test test/run-narrative.test.ts');
});

test('buildRunNarrativeSummary reports malformed narrative artifacts and rebuilds', async (t) => {
  const fixture = await createNarrativeFixture({
    events: [
      event('2026-04-25T18:15:00.000Z', 'coder.command_execution', { command: 'pnpm typecheck' }),
    ],
  });
  t.after(async () => {
    await rm(fixture.cwd, { recursive: true, force: true });
  });
  await writeFile(getRunNarrativeJsonArtifactPath(fixture.runDir), '{"version":', 'utf8');

  const summary = await buildRunNarrativeSummary({ cwd: fixture.cwd, statePath: fixture.statePath, now: NOW });

  assert.match(summary.warnings.join('\n'), /RUN_NARRATIVE\.json/);
  assert.equal(summary.verification.lastCommand, 'pnpm typecheck');
});

async function createNarrativeFixture(args: {
  mutate?: (state: OrchestrationState) => OrchestrationState;
  events?: string[];
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-run-narrative-'));
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', '2026-04-25T18-00-00.000Z-test');
  await mkdir(runDir, { recursive: true });
  const planDoc = join(cwd, 'PLAN.md');
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
  const state = args.mutate?.({
    ...initialState,
    executionShape: 'multi_scope',
    createdAt: '2026-04-25T18:00:00.000Z',
    updatedAt: '2026-04-25T18:15:00.000Z',
  }) ?? {
    ...initialState,
    executionShape: 'multi_scope',
    createdAt: '2026-04-25T18:00:00.000Z',
    updatedAt: '2026-04-25T18:15:00.000Z',
  };
  const statePath = getRunStatePath(runDir);
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  if (args.events) {
    await writeFile(join(runDir, 'events.ndjson'), args.events.join('\n') + '\n', 'utf8');
  }
  return { cwd, runDir, statePath, state };
}

function event(ts: string, type: string, data: Record<string, unknown> = {}) {
  return JSON.stringify({ ts, type, data });
}

function finding(status: ReviewFinding['status'], severity: ReviewFinding['severity']): ReviewFinding {
  return {
    id: `finding-${status}-${severity}`,
    canonicalId: `finding-${status}-${severity}`,
    round: 1,
    source: 'reviewer',
    severity,
    files: [],
    claim: `claim-${status}-${severity}`,
    evidence: null,
    requiredAction: `required-${status}-${severity}`,
    status,
    roundSummary: 'summary',
    coderDisposition: null,
    coderCommit: null,
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

function sampleStatusSnapshot(
  fixture: Awaited<ReturnType<typeof createNarrativeFixture>>,
  classification: StatusSnapshot['health']['classification'],
): StatusSnapshot {
  return {
    ok: true,
    runId: '2026-04-25T18-00-00.000Z-test',
    cwd: fixture.cwd,
    statePath: fixture.statePath,
    runDir: fixture.runDir,
    planDoc: fixture.state.planDoc,
    topLevelMode: fixture.state.topLevelMode,
    executionShape: fixture.state.executionShape,
    phase: fixture.state.phase,
    publicPhase: 'implementing current scope',
    status: fixture.state.status,
    effectiveStatus: fixture.state.status,
    publicStatus: fixture.state.status,
    nextAction: 'neal resume --run 2026-04-25T18-00-00.000Z-test',
    waitingForOperatorGuidance: false,
    pendingOperatorGuidance: false,
    blocker: {
      active: false,
      reason: null,
      source: null,
      artifactPaths: [],
    },
    blockedGuidance: null,
    resumeDecision: {
      kind: 'continue',
      reason: 'Run is in a resumable state.',
      resumeCommand: 'neal resume --run 2026-04-25T18-00-00.000Z-test',
    },
    currentScopeNumber: fixture.state.currentScopeNumber,
    plannerSessionHandle: fixture.state.plannerSessionHandle,
    coderSessionHandle: fixture.state.coderSessionHandle,
    reviewerSessionHandle: fixture.state.reviewerSessionHandle,
    coderRetryCount: fixture.state.coderRetryCount,
    rounds: fixture.state.rounds.length,
    createdCommits: fixture.state.createdCommits.length,
    completedScopes: fixture.state.completedScopes.length,
    lastEventAt: null,
    lastMeaningfulEventAt: null,
    lastCoderEventAt: null,
    lastReviewerEventAt: null,
    lastMeaningfulEvent: null,
    lock: { kind: 'none' },
    health: {
      classification,
      phaseElapsedMs: 600000,
      quietMs: 600000,
      heartbeatOnly: false,
      reason: 'test supplied snapshot',
    },
    findings: {
      total: 0,
      openBlocking: 0,
      openNonBlocking: 0,
      fixed: 0,
      rejected: 0,
      deferred: 0,
    },
    planReviewDebt: {
      total: 0,
      items: [],
    },
    commits: {
      initialBaseCommit: fixture.state.initialBaseCommit,
      baseCommit: fixture.state.baseCommit,
      finalCommit: fixture.state.finalCommit,
      createdCommitCount: fixture.state.createdCommits.length,
      acceptedScopeFinalCommits: [],
    },
    squash: {
      artifactPath: join(fixture.runDir, 'SQUASH_RESULT.json'),
      status: 'missing',
      replacementCommit: null,
      finalHeadCommit: null,
      originalBaseCommit: null,
      originalFinalCommit: null,
      unavailableReason: 'SQUASH_RESULT.json is not present for this run.',
    },
    providerError: null,
    finalCompletionStaleness: {
      stale: false,
      reason: null,
      reviewerOutputObserved: false,
      finalCompletionPhaseStartedAt: null,
      lastFinalCompletionReviewerOutputAt: null,
      finalCompletionPhaseTerminalEventObserved: false,
    },
    build: {
      source: 'live_fallback',
      packageVersion: '0.0.0-test',
      nodeVersion: process.version,
      sourceGitSha: null,
      agentConfig: fixture.state.agentConfig,
    },
    patch: {
      defaultSubmissionEligible: false,
      reason: 'No patch head commit is available.',
      source: 'final_commit',
      baseCommit: fixture.state.initialBaseCommit ?? fixture.state.baseCommit,
      headCommit: fixture.state.finalCommit,
      range: null,
      commitCount: null,
      changedFileCount: null,
      changedFiles: [],
      unavailableReason: 'No patch head commit is available.',
    },
    derivedPlan: null,
    manualGate: null,
    events: {
      path: join(fixture.runDir, 'events.ndjson'),
      exists: true,
      parsedLines: 0,
      malformedLines: 0,
      truncated: false,
    },
    artifacts: {
      runStatePath: fixture.statePath,
      eventsPath: join(fixture.runDir, 'events.ndjson'),
      runNarrativeMarkdownPath: join(fixture.runDir, 'RUN_NARRATIVE.md'),
      latestRetrospectiveMarkdownPath: null,
      reviewMarkdownPath: fixture.state.reviewMarkdownPath,
      progressJsonPath: fixture.state.progressJsonPath,
      progressMarkdownPath: fixture.state.progressMarkdownPath,
      recoveryMarkdownPath: fixture.state.recoveryMarkdownPath,
      queueSummaryMarkdownPath: null,
      archivedReviewPath: fixture.state.archivedReviewPath,
      invalidDerivedPlanPayloadPath: null,
    },
  };
}
