import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBlockedGuidance,
  renderBlockedGuidanceSections,
  CONTINUE_WITH_GUIDANCE_MESSAGE,
  type BlockedGuidance,
} from '../src/neal/blocked-guidance.js';
import { getRunDisplayStatus } from '../src/neal/run-status.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-blocked-guidance-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'blocked-guidance-test');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(
    planDoc,
    `# Example Plan

## Execution Shape

executionShape: one_shot
`,
    'utf8',
  );

  const state = await createInitialState(
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

  return {
    ...state,
    ...overrides,
  };
}

function requireGuidance(guidance: BlockedGuidance | null) {
  assert.ok(guidance);
  return guidance;
}

test('interactive recovery waiting on a scheduled run renders external-event guidance', async () => {
  const state = await createState({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
    currentScopeNumber: 4,
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-02T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Waiting for the scheduled run to finish before manual validation.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-123' }));
  const output = renderBlockedGuidanceSections(guidance).join('\n');

  assert.equal(guidance.category, 'waiting_on_external_event');
  assert.equal(guidance.scopeLabel, '4');
  assert.match(output, /Waiting for the scheduled run/);
  assert.match(output, /## Why Neal Stopped/);
  assert.match(output, /## Resume Options/);
  assert.match(output, /## Useful Artifacts/);
  assert.match(output, /neal resume --run run-123 --message "/);
  assert.equal(guidance.options.some((option) => option.label === 'Authorize alternate validation'), true);
  assert.equal(guidance.options.some((option) => option.label === 'Stay blocked'), false);
});

test('missing credential prerequisite is classified and secret-looking values are redacted', async () => {
  const state = await createState({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-02T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Missing API key=sk-secretValue123 for Gist access.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-secret' }));
  const output = renderBlockedGuidanceSections(guidance).join('\n');

  assert.equal(guidance.category, 'missing_external_prerequisite');
  assert.match(output, /API key=\[redacted\]/);
  assert.doesNotMatch(output, /sk-secretValue123/);
  assert.equal(guidance.options[0]?.label, 'Prerequisite verified');
  assert.match(output, /I have verified the required external prerequisite is complete\./);
  assert.doesNotMatch(output, /TOKEN/);
  assert.doesNotMatch(output, /command output/);
  assert.doesNotMatch(output, /C:\\\\paths/);
  assert.equal(guidance.options.some((option) => option.label === 'Stay blocked'), false);
});

test('license prerequisite guidance suggests the concrete license verification message', async () => {
  const state = await createState({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
    currentScopeNumber: 3,
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-03T17:47:43.018Z',
      sourcePhase: 'coder_response',
      blockedReason:
        'Scope 3 is still blocked: the pinned Aider Polyglot checkout has no applicable MIT LICENSE at `python/LICENSE`. Continuing would require explicit operator authorization to supply license evidence or amend the plan to allow another provenance source.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-license' }));
  const output = renderBlockedGuidanceSections(guidance).join('\n');

  assert.equal(guidance.category, 'missing_external_prerequisite');
  assert.equal(guidance.options[0]?.label, 'Prerequisite verified');
  // The first option renders a resume command for this run; assert the
  // structured resume token, not the verbatim message body prose.
  assert.match(output, /neal resume --run run-license --message "/);
  assert.equal(guidance.options.some((option) => option.label === 'Change requirement'), true);
  assert.equal(guidance.options.some((option) => option.label === 'Stay blocked'), false);
});

test('meaningful-progress operator block is classified as review or scope criteria mismatch', async () => {
  const state = await createState({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-02T00:00:00.000Z',
      sourcePhase: 'reviewer_scope',
      blockedReason: 'The current implementation needs operator direction.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
    currentScopeMeaningfulProgressVerdict: {
      action: 'block_for_operator',
      rationale: 'Reviewer criteria may need reinterpretation.',
    },
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-review' }));

  assert.equal(guidance.category, 'review_or_scope_criteria_mismatch');
  assert.equal(guidance.options.some((option) => option.label === 'Provide criteria decision'), true);
  assert.equal(guidance.options.some((option) => option.label === 'Waive or change requirement'), false);
  assert.equal(guidance.options.some((option) => option.label === 'Replace current scope'), true);
});

test('scope-accounting guardrail renders plain guidance before technical internals', async () => {
  const unsafeReason =
    'Unsafe advance_parent for parent objective 4 cannot proceed; failed preconditions: ' +
    'accepted derived plan is not actively executing; parent objective has no prior substantive accepted derived sub-scope. ' +
    'Reviewer rationale: prior accepted benchmark work satisfies scope 4. api key=sk-secretValue123';
  const state = await createState({
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
      {
        number: '2.2',
        marker: 'AUTONOMY_SCOPE_DONE',
        result: 'accepted',
        baseCommit: 'base-2-2',
        finalCommit: 'final-2-2',
        summary: 'Verified benchmark hidden-test mode.',
        commitSubject: 'verify benchmark mode',
        changedFiles: [],
        reviewRounds: 1,
        findings: 0,
        residualReviewDebt: [],
        archivedReviewPath: '/tmp/review-2.2.md',
        blocker: null,
        derivedFromParentScope: '2',
        replacedByDerivedPlanPath: null,
      },
    ],
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-scope-guard' }));
  const lines = renderBlockedGuidanceSections(guidance);
  const output = lines.join('\n');
  const technicalDetailsIndex = lines.indexOf('Technical details:');
  const preconditionIndex = lines.findIndex((line) => line.includes('accepted derived plan is not actively executing'));

  assert.equal(guidance.category, 'scope_accounting_guardrail');
  assert.match(guidance.summary, /scope-accounting guardrail/);
  assert.doesNotMatch(guidance.summary, /^Unsafe advance_parent/);
  assert.doesNotMatch(guidance.reason ?? '', /Unsafe advance_parent|failed preconditions|meaningful_progress:/);
  // Assert the structured option labels rather than matching them as prose in
  // the rendered output.
  assert.equal(guidance.options.some((option) => option.label === 'Accept already-satisfied scope'), true);
  assert.equal(guidance.options.some((option) => option.label === 'Continue scope directly'), true);
  assert.equal(guidance.options.some((option) => option.label === 'Replace with verification-only scope'), true);
  assert.match(output, /neal resume --run run-scope-guard --message "/);
  assert.match(output, /Prior accepted scope records: 2\.1, 2\.2\./);
  assert.match(output, /Open reviewer findings: 0 total, 0 blocking\./);
  assert.match(guidance.technicalDetails.join('\n'), /advance_parent preconditions failed/);
  assert.match(guidance.technicalDetails.join('\n'), /accepted derived plan is not actively executing/);
  assert.ok(technicalDetailsIndex > -1);
  assert.ok(preconditionIndex > technicalDetailsIndex);
  assert.doesNotMatch(lines.slice(0, 5).join('\n'), /Unsafe advance_parent|failed preconditions|accepted derived plan is not actively executing/);
  assert.doesNotMatch(lines.slice(0, technicalDetailsIndex).join('\n'), /accepted derived plan is not actively executing/);
  assert.doesNotMatch(output, /sk-secretValue123/);
  assert.doesNotMatch(output.toLowerCase(), /\bwaive\b|skip verification|ignore review|ignore criteria/);
});

test('blocked guidance includes invalid split-plan payload artifacts when present', async () => {
  const state = await createState({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
    currentScopeNumber: 5,
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-02T00:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Invalid split-plan payload needs operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
  });
  const invalidPayloadPath = join(state.runDir, 'SCOPE_5_INVALID_DERIVED_PLAN.md');
  await writeFile(invalidPayloadPath, '# Invalid Derived Plan Payload\n', 'utf8');

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-invalid-plan' }));
  const output = renderBlockedGuidanceSections(guidance).join('\n');

  assert.equal(guidance.artifactPaths.some((artifact) => artifact.path === invalidPayloadPath), true);
  assert.match(output, /Invalid split-plan payload/);
  assert.ok(output.includes(invalidPayloadPath));
});

test('plan-review waiting state produces plan-review guidance without a scope label', async () => {
  const state = await createState({
    topLevelMode: 'plan',
    status: 'blocked',
    phase: 'blocked',
    blockedFromPhase: 'reviewer_plan',
    pendingPlanReviewGuidance: null,
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-plan' }));

  assert.equal(guidance.category, 'plan_review_guidance');
  assert.equal(guidance.scopeLabel, null);
  assert.equal(guidance.sourcePhase, 'reviewer_plan');
});

test('unknown waiting state uses a conservative fallback without invented authorization', async () => {
  const state = await createState({
    status: 'blocked',
    phase: 'interactive_blocked_recovery',
    interactiveBlockedRecovery: {
      enteredAt: '2026-06-02T00:00:00.000Z',
      sourcePhase: 'coder_response',
      blockedReason: 'The next step is ambiguous.',
      maxTurns: 3,
      lastHandledTurn: 0,
      turns: [],
      pendingDirective: null,
    },
  });

  const guidance = requireGuidance(buildBlockedGuidance({ state, runId: 'run-unknown' }));

  assert.equal(guidance.category, 'unknown');
  assert.equal(guidance.options.length, 1);
  assert.doesNotMatch(guidance.options[0]?.command ?? '', /authorize/i);
  // The human-facing option text is the extracted constant unchanged (byte-identical).
  assert.ok((guidance.options[0]?.command ?? '').includes(CONTINUE_WITH_GUIDANCE_MESSAGE));
});

test('non-waiting blocked and failed states return null', async () => {
  const blockedState = await createState({
    status: 'blocked',
    phase: 'blocked',
    blockedFromPhase: 'coder_scope',
  });
  const failedState = await createState({
    status: 'failed',
    phase: 'coder_scope',
  });

  assert.equal(getRunDisplayStatus(blockedState).waitingForOperatorGuidance, false);
  assert.equal(buildBlockedGuidance({ state: blockedState, runId: 'blocked-run' }), null);
  assert.equal(buildBlockedGuidance({ state: failedState, runId: 'failed-run' }), null);
});
