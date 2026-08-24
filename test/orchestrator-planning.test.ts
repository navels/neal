import './helpers/orchestrator-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProviderCapabilitiesOverridesForTesting, setProviderCapabilitiesOverrideForTesting } from '../src/neal/providers/registry.js';
import { NealProviderError, type CoderRunPromptArgs, type CoderStructuredPromptArgs } from '../src/neal/providers/types.js';
import { runCoderPlanPhase, runPlanReviewPhase, runPlanningResponsePhase } from '../src/neal/orchestrator/phases/planning.js';
import { runPlanningResponseAdjudication } from '../src/neal/adjudicator/planning.js';
import { recordRecoveryGuidanceForResolvedRun } from '../src/neal/commands/recovery-guidance.js';
import { createRunLogger } from '../src/neal/logger.js';
import { RUNNABLE_PHASE_REGISTRY } from '../src/neal/orchestrator/run-loop.js';
import { applyResumeActions, planResumeActions } from '../src/neal/resume-planner.js';
import { getExecuteRunResultExitCode } from '../src/neal/commands/writer-exit-codes.js';
import { decideResumeAction } from '../src/neal/resume-decision.js';
import { formatPublicRunStatus, getRunDisplayStatus } from '../src/neal/run-status.js';
import { buildStatusSnapshot, renderHumanStatusSnapshot } from '../src/neal/status.js';
import { getDefaultAgentConfig, loadState } from '../src/neal/state.js';
import { getPlanReviewGuidanceOriginPhase } from '../src/neal/state-views.js';
import { createResumeFixture, createOpenPlanReviewFinding, createPlanReviewGuidanceResponseFixture, readRunEvents, runGit } from './helpers/orchestrator-harness.js';

process.env.HOME = join(tmpdir(), 'neal-test-home-orchestrator-planning');

test('runPlanningResponsePhase clears consumed plan-review guidance after successful response', async () => {
  const { statePath, state, guidance } = await createPlanReviewGuidanceResponseFixture();
  const coderPrompts: string[] = [];

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          coderPrompts.push(args.prompt);
          return {
            sessionHandle: 'coder-plan-response-session-b',
            structured: {
              outcome: 'responded',
              summary: 'Updated the plan response.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Resolved the recovery sequencing finding.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    assert.equal(nextState.phase, 'reviewer_plan');
    assert.equal(nextState.pendingPlanReviewGuidance, null);
    assert.equal(persisted.pendingPlanReviewGuidance, null);
    assert.equal(coderPrompts.length, 1);
    assert.match(coderPrompts[0], /Operator guidance for this blocked plan-review recovery:/);
    assert.match(coderPrompts[0], new RegExp(guidance.message));
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponsePhase blocks when planner dirties non-plan files', async () => {
  const { cwd, statePath, state } = await createPlanReviewGuidanceResponseFixture();

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>() {
          await writeFile(join(cwd, 'implementation.ts'), 'export const leaked = true;\n', 'utf8');
          return {
            sessionHandle: 'coder-plan-response-session-dirty',
            structured: {
              outcome: 'responded',
              summary: 'Updated the plan response.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Resolved the recovery sequencing finding.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'coder_plan_response');
    assert.equal(persisted.phase, 'blocked');
    assert.equal(nextState.interactiveBlockedRecovery, null);
    assert.match(await runGit(cwd, 'status', '--short'), /implementation\.ts/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponsePhase clears plan-review guidance after blocked response', async () => {
  const { statePath, state } = await createPlanReviewGuidanceResponseFixture();

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>() {
          return {
            sessionHandle: 'coder-plan-response-session-blocked',
            structured: {
              outcome: 'blocked',
              summary: 'The plan response still needs operator input.',
              blocker: 'Need a narrower operator decision.',
              responses: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'coder_plan_response');
    assert.equal(nextState.pendingPlanReviewGuidance, null);
    assert.equal(persisted.pendingPlanReviewGuidance, null);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runCoderPlanPhase blocks when planner dirties non-plan files', async () => {
  const { cwd, statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'coder_plan',
    status: 'running',
    blockedFromPhase: null,
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text planning prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>() {
          await writeFile(join(cwd, 'src.ts'), 'export const leaked = true;\n', 'utf8');
          return {
            sessionHandle: 'planner-dirty-session',
            structured: {
              action: 'ready_for_review',
              message: 'Plan is ready.',
              executionShape: 'one_shot',
              planBody: '# Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
              blockedReason: '',
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runCoderPlanPhase(state, statePath);
    const persisted = await loadState(statePath);

    assert.equal(nextState.phase, 'blocked');
    assert.equal(nextState.status, 'blocked');
    assert.equal(nextState.blockedFromPhase, 'coder_plan');
    assert.equal(persisted.phase, 'blocked');
    assert.equal(nextState.interactiveBlockedRecovery, null);
    assert.match(await runGit(cwd, 'status', '--short'), /src\.ts/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponsePhase delivers recorded guidance even when no open findings remain', async () => {
  // Recorded operator guidance must never be silently discarded: even if a prior
  // blocked response closed every finding, resuming the phase must deliver the
  // guidance to the planner (not accept the plan while dropping the answer).
  const { statePath, state, guidance } = await createPlanReviewGuidanceResponseFixture({
    findings: [],
  });
  const coderPrompts: string[] = [];

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          coderPrompts.push(args.prompt);
          return {
            sessionHandle: 'coder-plan-response-session-guidance-delivery',
            structured: {
              outcome: 'responded',
              summary: 'Applied the operator guidance.',
              blocker: '',
              responses: [],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    // The guidance reached the planner before it was cleared.
    assert.equal(coderPrompts.length, 1);
    assert.match(coderPrompts[0], /Operator guidance for this blocked plan-review recovery:/);
    assert.ok(coderPrompts[0].includes(guidance.message));
    // Delivered, then consumed: a blocking response returns to reviewer_plan.
    assert.equal(nextState.phase, 'reviewer_plan');
    assert.equal(nextState.pendingPlanReviewGuidance, null);
    assert.equal(persisted.pendingPlanReviewGuidance, null);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponsePhase accepts without a planner round when no findings and no guidance remain', async () => {
  // The genuine no-work case (no findings, no pending guidance) still short-circuits
  // to acceptance without invoking the planner.
  const { statePath, state } = await createPlanReviewGuidanceResponseFixture({
    findings: [],
    pendingPlanReviewGuidance: null,
  });

  const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
  const persisted = await loadState(statePath);

  assert.equal(nextState.phase, 'done');
  assert.equal(nextState.status, 'done');
  assert.equal(nextState.pendingPlanReviewGuidance, null);
  assert.equal(persisted.pendingPlanReviewGuidance, null);
});

test('runPlanningResponsePhase mints a fresh planner session and protocol for a derived-plan revision without a planner session', async () => {
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'execute',
    phase: 'coder_plan_response',
    status: 'running',
    blockedFromPhase: null,
    currentScopeNumber: 3,
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: '3915c8c0-de35-49b1-b04e-9958cbe14c02',
    coderSessionProtocol: 'structured_json_v1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
    derivedScopeIndex: null,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    findings: [createOpenPlanReviewFinding()],
  });

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          // A fresh planner session is started with a null resume handle.
          assert.equal(args.resumeHandle ?? null, null);
          return {
            sessionHandle: 'fresh-planner-session',
            structured: {
              outcome: 'responded',
              summary: 'Revised the derived plan to address the finding.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Addressed recovery sequencing in the derived plan.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    assert.equal(nextState.plannerSessionHandle, 'fresh-planner-session');
    assert.equal(nextState.plannerSessionProtocol, 'structured_json_v1');
    assert.equal(persisted.plannerSessionHandle, 'fresh-planner-session');
    assert.equal(persisted.plannerSessionProtocol, 'structured_json_v1');
    // The derived-plan blocking response returns to reviewer_plan and stays running.
    assert.equal(nextState.phase, 'reviewer_plan');
    assert.equal(nextState.status, 'running');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('resuming a derived-plan revision dispatches coder_plan_response and completes a fresh planner round', async () => {
  // Reproduction state: an execute run persisted in coder_plan_response with no planner
  // session and a single open blocking finding. This is exactly the state that previously
  // re-hit "Cannot run coder_plan_response phase without an existing planner session" on resume.
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'execute',
    phase: 'coder_plan_response',
    status: 'running',
    blockedFromPhase: null,
    currentScopeNumber: 3,
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: '3915c8c0-de35-49b1-b04e-9958cbe14c02',
    coderSessionProtocol: 'structured_json_v1',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_3.md',
    derivedPlanStatus: 'pending_review',
    derivedFromScopeNumber: 3,
    derivedScopeIndex: null,
    splitPlanStartedNotified: true,
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    findings: [createOpenPlanReviewFinding()],
  });

  // Resume normalization is a plain continue: there is no blocked phase to restore and the
  // running pending-review state yields no derived-plan promotion or keep_blocked action.
  assert.deepEqual(planResumeActions(state), []);
  const resumedState = await applyResumeActions(state, statePath, undefined, planResumeActions(state));
  assert.equal(resumedState.phase, 'coder_plan_response');
  assert.equal(resumedState.status, 'running');

  // Resume then dispatches the runnable phase through the planning response handler.
  assert.equal(RUNNABLE_PHASE_REGISTRY[resumedState.phase], 'coder_plan_response');

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          // A fresh planner session is started with a null resume handle.
          assert.equal(args.resumeHandle ?? null, null);
          return {
            sessionHandle: 'fresh-planner-session',
            structured: {
              outcome: 'responded',
              summary: 'Revised the derived plan to address the finding.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Addressed recovery sequencing in the derived plan.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(resumedState, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    // The resumed round completes without throwing and persists a valid planner session.
    assert.equal(nextState.plannerSessionHandle, 'fresh-planner-session');
    assert.equal(nextState.plannerSessionProtocol, 'structured_json_v1');
    assert.equal(persisted.plannerSessionHandle, 'fresh-planner-session');
    assert.equal(persisted.plannerSessionProtocol, 'structured_json_v1');
    assert.equal(nextState.phase, 'reviewer_plan');
    assert.equal(nextState.status, 'running');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponsePhase runs a fresh planner session for top-level plan refinement when the planner provider cannot resume sessions', async () => {
  // Regression: a no-resume planner provider (openai-compatible; the planner inherits the coder
  // provider) never persists plannerSessionHandle, so a reviewer-requested top-level plan
  // revision previously crashed with "Cannot run coder_plan_response phase without an existing
  // planner session". The phase must instead start a fresh planner session (resumeHandle null)
  // and persist/complete normally.
  const { statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'coder_plan_response',
    status: 'running',
    blockedFromPhase: null,
    plannerSessionHandle: null,
    plannerSessionProtocol: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    agentConfig: {
      ...getDefaultAgentConfig(),
      planner: { provider: 'openai-compatible', model: null, effort: null },
    },
    interactiveBlockedRecovery: null,
    interactiveBlockedRecoveryHistory: [],
    findings: [createOpenPlanReviewFinding()],
  });

  setProviderCapabilitiesOverrideForTesting('openai-compatible', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
          // A fresh planner session is started with a null resume handle.
          assert.equal(args.resumeHandle ?? null, null);
          return {
            // openai-compatible never persists a session handle.
            sessionHandle: null,
            structured: {
              outcome: 'responded',
              summary: 'Revised the plan to address the finding.',
              blocker: '',
              responses: [
                {
                  id: 'R1-F1',
                  decision: 'fixed',
                  summary: 'Addressed recovery sequencing in the plan.',
                },
              ],
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const persisted = await loadState(statePath);

    // The round completes without throwing; no planner handle or protocol is persisted because
    // the provider returns none, satisfying the state invariant (both null together).
    assert.equal(nextState.plannerSessionHandle, null);
    assert.equal(nextState.plannerSessionProtocol, null);
    assert.equal(persisted.plannerSessionHandle, null);
    assert.equal(persisted.plannerSessionProtocol, null);
    assert.equal(nextState.phase, 'reviewer_plan');
    assert.equal(nextState.status, 'running');
    assert.equal(persisted.phase, 'reviewer_plan');
    assert.equal(persisted.status, 'running');
    assert.equal(nextState.findings[0]?.status, 'fixed');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponsePhase preserves plan-review guidance when planner response throws before save', async () => {
  const { statePath, state, guidance } = await createPlanReviewGuidanceResponseFixture();

  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt() {
          throw new Error('planner response unavailable before save');
        },
      };
    },
  });

  try {
    await assert.rejects(
      () => runPlanningResponsePhase(state, statePath, 'coder_plan_response'),
      /planner response unavailable before save/,
    );
    const persisted = await loadState(statePath);

    assert.deepEqual(persisted.pendingPlanReviewGuidance, guidance);
    assert.equal(persisted.phase, 'coder_plan_response');
    assert.equal(persisted.status, 'running');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

function stubCoderPlanResponse(structured: {
  outcome: 'responded' | 'blocked';
  summary: string;
  blocker: string;
  responses: Array<{ id: string; decision: 'fixed' | 'rejected' | 'deferred'; summary: string }>;
  onRun?: () => Promise<void>;
  sessionHandle?: string;
}) {
  setProviderCapabilitiesOverrideForTesting('openai-codex', {
    createCoderAdapter() {
      return {
        async runPrompt(args: CoderRunPromptArgs) {
          throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
        },
        async runStructuredPrompt<TStructured>() {
          await structured.onRun?.();
          return {
            sessionHandle: structured.sessionHandle ?? 'coder-plan-response-session-scope6',
            structured: {
              outcome: structured.outcome,
              summary: structured.summary,
              blocker: structured.blocker,
              responses: structured.responses,
            } as TStructured,
          };
        },
      };
    },
  });
}

test('plan-stage coder-response block lands blocked-with-reason (exit 2), not a terminal failure', async () => {
  const blocker = 'Need an operator decision: which module owns the shared retry budget?';
  const { cwd, statePath, state } = await createPlanReviewGuidanceResponseFixture({
    pendingPlanReviewGuidance: null,
  });

  stubCoderPlanResponse({
    outcome: 'blocked',
    summary: 'The plan response still needs operator input.',
    blocker,
    responses: [],
    sessionHandle: 'coder-plan-response-session-authored-block',
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const reloaded = await loadState(statePath);

    // Recoverable blocked landing, not a terminal failure.
    assert.equal(nextState.status, 'blocked');
    assert.equal(reloaded.status, 'blocked');
    assert.equal(reloaded.phase, 'blocked');
    assert.equal(reloaded.blockedFromPhase, 'coder_plan_response');
    assert.equal(reloaded.blockerReason, blocker);

    // The shared lifecycle reports the block as waiting for operator guidance.
    assert.equal(getRunDisplayStatus(reloaded).waitingForOperatorGuidance, true);
    assert.equal(formatPublicRunStatus(getRunDisplayStatus(reloaded)), 'waiting_for_guidance');

    // The durable reason surfaces in both the JSON snapshot and the human render.
    const snapshot = await buildStatusSnapshot({ cwd, statePath, now: new Date() });
    assert.equal(snapshot.blocker.reason, blocker);
    assert.equal(snapshot.blocker.source, 'RUN_STATE.json blocker reason');
    // The coder-authored block is surfaced as plan-review guidance carrying the
    // durable authored reason, so the human render shows it under the guidance
    // sections rather than the raw `## Blocker` block.
    assert.equal(snapshot.blockedGuidance?.category, 'plan_review_guidance');
    assert.equal(snapshot.blockedGuidance?.reason, blocker);
    const human = renderHumanStatusSnapshot(snapshot);
    assert.match(human, /## Why Neal Stopped/);
    assert.ok(human.includes(blocker));

    // Writer exit code is 2 (blocked/recoverable), not 3 (terminal failure).
    assert.equal(
      getExecuteRunResultExitCode({
        finalState: reloaded,
        waitingForOperatorGuidance: false,
        waitingForManualGate: false,
        stopRequestedAfterScope: false,
      }),
      2,
    );
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('plan-stage dirty-worktree block stays a normal blocked safety state, not a --message guidance wait', async () => {
  // A dirty-worktree safety block lands at the same coder_plan_response phase as a
  // coder-authored block but must NOT be exposed through the author-input route:
  // it carries no durable blockerReason, so it is not advertised or accepted as
  // waiting for --message guidance and keeps its prior bare-resume behavior.
  const { cwd, statePath, state } = await createPlanReviewGuidanceResponseFixture({
    pendingPlanReviewGuidance: null,
  });

  stubCoderPlanResponse({
    outcome: 'responded',
    summary: 'Updated the plan response.',
    blocker: '',
    responses: [{ id: 'R1-F1', decision: 'fixed', summary: 'Resolved the recovery sequencing finding.' }],
    sessionHandle: 'coder-plan-response-session-dirty',
    onRun: async () => {
      await writeFile(join(cwd, 'implementation.ts'), 'export const leaked = true;\n', 'utf8');
    },
  });

  try {
    const nextState = await runPlanningResponsePhase(state, statePath, 'coder_plan_response');
    const reloaded = await loadState(statePath);

    // A normal blocked safety state with no recoverable reason.
    assert.equal(nextState.status, 'blocked');
    assert.equal(reloaded.status, 'blocked');
    assert.equal(reloaded.blockedFromPhase, 'coder_plan_response');
    assert.equal(reloaded.blockerReason, null);

    // Not advertised as waiting for operator guidance.
    assert.equal(getRunDisplayStatus(reloaded).waitingForOperatorGuidance, false);
    assert.equal(formatPublicRunStatus(getRunDisplayStatus(reloaded)), 'blocked');

    // Not answerable via --message: a resumable planner session is present, so the
    // resume decision is a bare-resume continue, never needs_message.
    const decision = decideResumeAction({ state: reloaded, selectedRunId: 'test-run', statePath });
    assert.equal(decision.kind, 'continue');

    // The dirty file is preserved for the operator to clean, exactly as today.
    assert.match(await runGit(cwd, 'status', '--short'), /implementation\.ts/);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('runPlanningResponseAdjudication forwards pending plan-review guidance to the planner response runner', async () => {
  const guidanceMessage = 'Operator: the queue item owns the retry budget; pin it in Scope 3.';
  const { state } = await createPlanReviewGuidanceResponseFixture({
    pendingPlanReviewGuidance: {
      message: guidanceMessage,
      sourcePhase: 'coder_plan_response',
      recordedAt: '2026-05-29T00:00:00.000Z',
    },
  });

  let forwarded: string | undefined;
  await runPlanningResponseAdjudication({
    state,
    openFindings: state.findings.map((finding) => ({
      id: finding.id,
      source: finding.source,
      claim: finding.claim,
      requiredAction: finding.requiredAction,
      severity: finding.severity,
      files: finding.files,
      roundSummary: finding.roundSummary,
    })),
    runResponseRound: async (args) => {
      forwarded = args.planReviewGuidance?.message;
      return {
        sessionHandle: 'planner-response-session',
        payload: { outcome: 'responded', summary: 'done', blocker: '', responses: [] },
      };
    },
  });

  assert.equal(forwarded, guidanceMessage);
});

for (const origin of ['coder_plan_response', 'coder_plan_optional_response'] as const) {
  test(`recorded --message reaches the response runner after a blocked ${origin} closed every finding`, async () => {
    // R1-F2 end-to-end: a blocked response whose responses close every finding
    // must not strand the operator's answer. The recorded guidance must reach
    // runPlanningResponseAdjudication before it is cleared or the plan accepted.
    const severity = origin === 'coder_plan_optional_response' ? 'non_blocking' : 'blocking';
    const finding = { ...createOpenPlanReviewFinding(), severity } as const;
    const blocker = `Operator decision needed for ${origin}.`;
    const answer = `Answer for ${origin}: proceed with the narrower option.`;

    const { statePath, state } = await createPlanReviewGuidanceResponseFixture({
      phase: origin,
      pendingPlanReviewGuidance: null,
      findings: [finding],
    });

    let capturedPrompt: string | undefined;
    let call = 0;
    setProviderCapabilitiesOverrideForTesting('openai-codex', {
      createCoderAdapter() {
        return {
          async runPrompt(args: CoderRunPromptArgs) {
            throw new Error(`unexpected text plan-response prompt: ${args.prompt}`);
          },
          async runStructuredPrompt<TStructured>(args: CoderStructuredPromptArgs) {
            call += 1;
            if (call === 1) {
              // Blocked, yet its responses close every finding.
              return {
                sessionHandle: 'coder-plan-response-blocked-closing',
                structured: {
                  outcome: 'blocked',
                  summary: 'Blocked but recorded fixes.',
                  blocker,
                  responses: [{ id: finding.id, decision: 'fixed', summary: 'Closed.' }],
                } as TStructured,
              };
            }
            capturedPrompt = args.prompt;
            return {
              sessionHandle: 'coder-plan-response-after-guidance',
              structured: {
                outcome: 'responded',
                summary: 'Applied the operator guidance.',
                blocker: '',
                responses: [],
              } as TStructured,
            };
          },
        };
      },
    });

    try {
      // Step 1: the blocked response closes the finding but lands blocked-with-reason.
      const blockedState = await runPlanningResponsePhase(state, statePath, origin);
      assert.equal(blockedState.status, 'blocked');
      assert.equal(blockedState.blockerReason, blocker);
      assert.equal(blockedState.findings.find((item) => item.id === finding.id)?.status, 'fixed');

      // Step 2: the operator records --message guidance via the real resume path.
      const recorded = await recordRecoveryGuidanceForResolvedRun({
        target: { statePath, selectedRunId: null },
        message: answer,
      });
      assert.equal(recorded.kind, 'recorded');

      const resumed = await loadState(statePath);
      assert.equal(resumed.phase, origin);
      assert.equal(resumed.pendingPlanReviewGuidance?.message, answer);
      assert.equal(resumed.blockerReason, null);

      // Step 3: resuming the phase delivers the message even though no findings are open.
      const afterGuidance = await runPlanningResponsePhase(resumed, statePath, origin);

      assert.ok(capturedPrompt, 'expected the post-guidance response round to run the planner');
      assert.ok(capturedPrompt!.includes(answer), 'expected the operator answer to reach the response runner');
      assert.equal(afterGuidance.pendingPlanReviewGuidance, null);
      const final = await loadState(statePath);
      assert.equal(final.pendingPlanReviewGuidance, null);
    } finally {
      clearProviderCapabilitiesOverridesForTesting();
    }
  });
}

const VALID_ONE_SHOT_PLAN = '# Example Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n';

async function createPlanReviewRefusalFixture(kind: 'content_refused' | 'provider_failed') {
  const { cwd, statePath, state } = await createResumeFixture({
    topLevelMode: 'plan',
    phase: 'reviewer_plan',
    status: 'running',
    blockedFromPhase: null,
    plannerSessionHandle: 'planner-session',
    plannerSessionProtocol: 'structured_json_v1',
    reviewerSessionHandle: null,
  });
  await writeFile(state.planDoc, VALID_ONE_SHOT_PLAN, 'utf8');
  const logger = await createRunLogger({
    cwd,
    stateDir: join(cwd, '.neal'),
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    runDir: state.runDir,
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound() {
          throw new NealProviderError({
            message:
              kind === 'content_refused'
                ? 'reviewer refused: content was flagged for possible cybersecurity risk'
                : 'reviewer provider failed for an unrelated reason',
            provider: 'anthropic-claude',
            role: 'structured-advisor',
            sessionHandle: 'plan-reviewer-session',
            kind,
            retryable: false,
          });
        },
      };
    },
  });

  return { cwd, statePath, state, logger };
}

test('plan review phase returns a terminal blocked state on a content_refused reviewer error', async () => {
  const { statePath, state, logger } = await createPlanReviewRefusalFixture('content_refused');

  try {
    // The phase must RETURN a terminal blocked state, not reject.
    const blockedState = await runPlanReviewPhase(state, statePath, logger);

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
    // A content-safety refusal is terminal, not mechanically message-resumable:
    // with blockedFromPhase null and no pending guidance, the run is never
    // exposed as waiting for operator plan-review guidance.
    assert.equal(reloaded.pendingPlanReviewGuidance, null);
    assert.equal(getPlanReviewGuidanceOriginPhase(reloaded), null);

    const events = await readRunEvents(state.runDir);
    const phaseError = events.find(
      (event) => event.type === 'phase.error' && event.data?.phase === 'reviewer_plan',
    );
    assert.equal(phaseError?.data?.errorKind, 'content_refused');
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});

test('plan review phase still fails a non-refusal reviewer error and persists status failed', async () => {
  const { statePath, state, logger } = await createPlanReviewRefusalFixture('provider_failed');

  try {
    await assert.rejects(() => runPlanReviewPhase(state, statePath, logger));

    const reloaded = await loadState(statePath);
    assert.equal(reloaded.status, 'failed');
    assert.equal(reloaded.phase, 'reviewer_plan');
    assert.equal(reloaded.blockerReason, null);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
