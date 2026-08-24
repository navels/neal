import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { clearConfigCache } from '../src/neal/config.js';
import { runFinalCompletionReviewPhase } from '../src/neal/orchestrator.js';
import {
  adoptAcceptedDerivedPlan,
  computeNextScopeStateAfterExecuteFinalization,
  computeNextScopeStateAfterParentAdvance,
} from '../src/neal/orchestrator/transitions.js';
import { persistSplitPlanRecovery } from '../src/neal/orchestrator/split-plan.js';
import {
  clearProviderCapabilitiesOverridesForTesting,
  setProviderCapabilitiesOverrideForTesting,
} from '../src/neal/providers/registry.js';
import { createInitialState, getRunStatePath, saveState } from '../src/neal/state.js';
import type {
  ExecuteScopeProgressJustification,
  FinalCompletionReviewerVerdict,
  FinalCompletionSummary,
  InteractiveBlockedRecoveryRecord,
  InteractiveBlockedRecoveryState,
  ManualGateState,
  OrchestrationState,
  ProgressScope,
  RecentBlockRecord,
  ResidualReviewDebtItem,
  ReviewFinding,
  ReviewRound,
  ReviewerMeaningfulProgressVerdict,
} from '../src/neal/types.js';
import { hermeticAgentConfig } from './helpers/hermetic-agent-config.js';

// Characterization baseline for the seven scope-boundary reset sites (P5 plan,
// Scope 3). This file pins the COMPLETE resulting state of every site before
// Scope 4 extracts a shared reset, and is immutable through that refactor: if
// the extracted reset cannot reproduce a behavior pinned here, the refactor is
// wrong, not this file.
//
// The seven sites:
//   1. transitions.ts adoptAcceptedDerivedPlan
//   2. transitions.ts computeNextScopeStateAfterExecuteFinalization,
//      derived-plan-completed branch
//   3. transitions.ts computeNextScopeStateAfterExecuteFinalization,
//      derived-continue branch
//   4. transitions.ts computeNextScopeStateAfterExecuteFinalization,
//      top-level-continue branch
//   5. transitions.ts computeNextScopeStateAfterParentAdvance
//   6. split-plan.ts persistSplitPlanRecovery, the saveState spread that
//      persists a valid derived plan
//   7. completion.ts runFinalCompletionReviewPhase, the continue-execution
//      reopen
//
// Every field a site resets AND every field it preserves is seeded with a
// distinguishable non-default value wherever the site's branch predicates and
// (for the persisted sites) the saveState invariants allow, and the assertion
// is a complete-state deep compare: expected = { ...seededInput, <every field
// the site writes> }, so a dropped reset AND a wrongly-added reset both fail.

// This file drives config-reading orchestrator paths; user config resolves
// through homedir()/.neal/config.yml, so pin a private tmp HOME (unique across
// the flat test suite — parallel node:test child processes share tmpdir()).
process.env.HOME = join(tmpdir(), 'neal-test-home-scope-boundary-reset');

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

// --- Seed builders -----------------------------------------------------------
// Every value is deliberately non-default (non-null, non-empty, non-zero,
// non-false) so a reset to the default is always distinguishable from
// preservation.

function seedProgressJustification(): ExecuteScopeProgressJustification {
  return {
    milestoneTargeted: 'seed milestone targeted',
    newEvidence: 'seed new evidence',
    whyNotRedundant: 'seed why not redundant',
    nextStepUnlocked: 'seed next step unlocked',
  };
}

function seedMeaningfulProgressVerdict(): ReviewerMeaningfulProgressVerdict {
  return { action: 'accept', rationale: 'seed meaningful-progress rationale' };
}

function seedReviewRound(): ReviewRound {
  return {
    round: 2,
    reviewerSessionHandle: 'seed-round-reviewer-session',
    reviewedPlanPath: '/seed/reviewed-plan.md',
    normalizationApplied: true,
    normalizationOperations: ['seed-normalization-operation'],
    normalizationScopeLabelMappings: [{ normalizedScopeNumber: 1, originalScopeLabel: 'A' }],
    commitRange: { base: 'seed-round-base-commit', head: 'seed-round-head-commit' },
    openBlockingCanonicalCount: 1,
    openBlockingCanonicalIds: ['C-SEED-1'],
    findings: ['R2-F1'],
  };
}

function seedRecentBlock(): RecentBlockRecord {
  return {
    scopeNumber: 7,
    derivedScopeIndex: 3,
    sourcePhase: 'coder_scope',
    normalizedKey: 'seed-normalized-key',
    evidenceFingerprint: 'seed-evidence-fingerprint',
    count: 2,
    recordedAt: '2026-07-11T00:00:00.000Z',
  };
}

function seedFinding(): ReviewFinding {
  return {
    id: 'R2-F1',
    canonicalId: 'C-SEED-1',
    round: 2,
    source: 'reviewer',
    severity: 'non_blocking',
    files: ['src/seed.ts'],
    claim: 'seed claim',
    evidence: 'seed evidence',
    requiredAction: 'seed required action',
    status: 'open',
    roundSummary: 'seed round summary',
    coderDisposition: 'seed coder disposition',
    coderCommit: 'seed-coder-commit',
  };
}

function seedManualGate(): ManualGateState {
  return {
    id: 'seed-gate-id',
    title: 'seed gate title',
    reason: 'seed gate reason',
    instructionsPath: '/seed/manual-gate-instructions.md',
    resumeChecks: [{ type: 'command', name: 'seed-check', command: ['true'], cwd: 'repo', timeoutMs: 1000 }],
    resumePhase: 'coder_scope',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T01:00:00.000Z',
    lastCheckedAt: '2026-07-09T02:00:00.000Z',
    lastFailure: {
      checkName: 'seed-check',
      exitCode: 1,
      signal: null,
      stdoutTail: 'seed stdout tail',
      stderrTail: 'seed stderr tail',
    },
  };
}

function seedInteractiveBlockedRecovery(): InteractiveBlockedRecoveryState {
  return {
    enteredAt: '2026-07-11T01:00:00.000Z',
    sourcePhase: 'coder_scope',
    blockedReason: 'seed blocked reason',
    maxTurns: 3,
    lastHandledTurn: 1,
    turns: [
      {
        number: 1,
        recordedAt: '2026-07-11T02:00:00.000Z',
        operatorGuidance: 'seed operator guidance',
        disposition: null,
      },
    ],
    pendingDirective: null,
    consultantAdvice: null,
  };
}

function seedInteractiveBlockedRecoveryHistoryRecord(): InteractiveBlockedRecoveryRecord {
  return {
    ...seedInteractiveBlockedRecovery(),
    resolvedAt: '2026-07-11T03:00:00.000Z',
    resolvedByAction: 'resume_current_scope',
    resultPhase: 'coder_scope',
  };
}

function seedFinalCompletionSummary(): FinalCompletionSummary {
  return {
    planGoalSatisfied: false,
    whatChangedOverall: 'seed what changed overall',
    verificationSummary: 'seed verification summary',
    remainingKnownGaps: ['seed remaining known gap'],
  };
}

function seedFinalCompletionReviewVerdict(): FinalCompletionReviewerVerdict {
  return {
    action: 'continue_execution',
    summary: 'seed verdict summary',
    rationale: 'seed verdict rationale',
    missingWork: {
      summary: 'seed missing-work summary',
      requiredOutcome: 'seed missing-work required outcome',
      verification: 'seed missing-work verification',
    },
    squashCommitMessage: null,
  };
}

// Distinct non-empty current vs inherited plan-review debt, so every reset site
// can pin that the current-negotiation projection (planReviewDebt) clears with
// findings while the durable inheritedPlanReviewDebt is preserved.
function seedCurrentPlanReviewDebt(): ResidualReviewDebtItem[] {
  return [
    {
      id: 'R2-F1',
      canonicalId: 'C2',
      status: 'deferred',
      files: ['PLAN.md'],
      claim: 'seed current-negotiation plan-review debt',
      evidence: '',
      requiredAction: 'seed current debt required action',
      coderDisposition: null,
      coderCommit: null,
      findingClass: 'verification_hardening',
      originRound: 2,
    },
  ];
}

function seedInheritedPlanReviewDebt(): ResidualReviewDebtItem[] {
  return [
    {
      id: 'R4-F9',
      canonicalId: 'C9',
      status: 'deferred',
      files: ['PLAN.md'],
      claim: 'seed inherited plan-review debt',
      evidence: '',
      requiredAction: 'seed inherited debt required action',
      coderDisposition: null,
      coderCommit: null,
      findingClass: 'verification_hardening',
      originRound: 4,
    },
  ];
}

function seedCompletedScope(overrides: Partial<ProgressScope> = {}): ProgressScope {
  return {
    number: '7.2',
    marker: 'AUTONOMY_SCOPE_DONE',
    result: 'accepted',
    baseCommit: 'seed-scope-base-commit',
    finalCommit: 'seed-scope-final-commit',
    summary: 'seed scope summary',
    commitSubject: 'seed scope commit subject',
    changedFiles: ['src/seed.ts'],
    reviewRounds: 2,
    findings: 1,
    residualReviewDebt: [],
    archivedReviewPath: '/seed/archived-scope-review.md',
    blocker: null,
    derivedFromParentScope: '7',
    replacedByDerivedPlanPath: null,
    ...overrides,
  };
}

// Full in-memory state for the five PURE transition sites. Every field holds a
// distinguishable non-default value; per-site overrides then apply only the
// branch predicates that route execution to the site under pin. No saveState
// runs here, so state invariants do not constrain the seeds.
function createSeededTransitionState(overrides: Partial<OrchestrationState>): OrchestrationState {
  return {
    version: 1,
    planDoc: '/seed/repo/PLAN.md',
    planDocBackupPath: '/seed/repo/PLAN.backup.md',
    cwd: '/seed/repo',
    runDir: '/seed/repo/.neal/runs/seed-run',
    topLevelMode: 'execute',
    allowedDirtyPaths: ['docs/allowed-dirty.md'],
    agentConfig: hermeticAgentConfig(),
    consultantAttemptCount: 3,
    autoSquashOnCompletion: false,
    progressJsonPath: '/seed/repo/.neal/runs/seed-run/plan-progress.json',
    progressMarkdownPath: '/seed/repo/.neal/runs/seed-run/PLAN_PROGRESS.md',
    recoveryMarkdownPath: '/seed/repo/.neal/runs/seed-run/RECOVERY.md',
    phase: 'execute_finalization',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T01:00:00.000Z',
    reviewMarkdownPath: '/seed/repo/.neal/runs/seed-run/REVIEW.md',
    archivedReviewPath: '/seed/prior-archived-review.md',
    initialBaseCommit: 'seed-initial-base-commit',
    baseCommit: 'seed-base-commit',
    finalCommit: 'seed-final-commit',
    plannerSessionHandle: 'seed-planner-session',
    plannerSessionProtocol: 'structured_json_v1',
    coderSessionHandle: 'seed-coder-session',
    coderSessionProtocol: 'legacy_marker_v1',
    reviewerSessionHandle: 'seed-reviewer-session',
    executionShape: 'multi_scope',
    authoredExecutionShape: 'multi_scope',
    currentScopeNumber: 7,
    coderRetryCount: 4,
    lastScopeMarker: 'AUTONOMY_SCOPE_DONE',
    currentScopeProgressJustification: seedProgressJustification(),
    currentScopeMeaningfulProgressVerdict: seedMeaningfulProgressVerdict(),
    manualGate: seedManualGate(),
    finalCompletionSummary: seedFinalCompletionSummary(),
    finalCompletionReviewVerdict: seedFinalCompletionReviewVerdict(),
    finalCompletionResolvedAction: 'continue_execution',
    finalCompletionContinueExecutionCount: 2,
    finalCompletionContinueExecutionCapReached: true,
    derivedPlanPath: '/seed/repo/.neal/runs/seed-run/DERIVED_PLAN_SCOPE_7.md',
    derivedFromScopeNumber: 7,
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: 3,
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: true,
    splitPlanBlockedNotified: true,
    splitPlanCountForCurrentScope: 3,
    derivedPlanDepth: 1,
    maxDerivedPlanReviewRounds: 9,
    rounds: [seedReviewRound()],
    recentBlocks: [seedRecentBlock()],
    findings: [seedFinding()],
    createdCommits: ['seed-created-commit-1', 'seed-created-commit-2'],
    completedScopes: [seedCompletedScope()],
    maxRounds: 6,
    blockedFromPhase: 'reviewer_scope',
    interactiveBlockedRecovery: seedInteractiveBlockedRecovery(),
    interactiveBlockedRecoveryHistory: [seedInteractiveBlockedRecoveryHistoryRecord()],
    pendingPlanReviewGuidance: {
      message: 'seed plan review guidance',
      sourcePhase: 'reviewer_plan',
      recordedAt: '2026-07-08T00:00:00.000Z',
    },
    planReviewDebt: seedCurrentPlanReviewDebt(),
    inheritedPlanReviewDebt: seedInheritedPlanReviewDebt(),
    blockerReason: null,
    status: 'paused',
    ...overrides,
  };
}

// --- Site 1: adoptAcceptedDerivedPlan ----------------------------------------

test('adoptAcceptedDerivedPlan resets per-scope execution state for the derived coder scope (site 1)', () => {
  // Branch predicates: an accepted, unexecuted derived plan
  // (derivedPlanStatus 'accepted', derivedFromScopeNumber non-null,
  // derivedScopeIndex null), phase 'awaiting_derived_plan_execution', and no
  // created commits. createdCommits and derivedScopeIndex are therefore
  // constrained to their defaults in the input; every other field is seeded
  // non-default.
  const input = createSeededTransitionState({
    phase: 'awaiting_derived_plan_execution',
    derivedScopeIndex: null,
    createdCommits: [],
  });

  // Complete-state pin: everything not listed below is preserved as seeded —
  // notably baseCommit, finalCommit, archivedReviewPath, lastScopeMarker,
  // manualGate, interactiveBlockedRecovery, reviewerSessionHandle, the
  // derived-plan identity (path/parent/status), the three split-plan
  // notification flags, splitPlanCountForCurrentScope, and
  // finalCompletionContinueExecutionCount (only the CapReached flag resets).
  const expected: OrchestrationState = {
    ...input,
    phase: 'coder_scope',
    status: 'running',
    derivedScopeIndex: 1,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    coderRetryCount: 0,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    planReviewDebt: [],
    createdCommits: [],
    blockedFromPhase: null,
  };

  assert.deepStrictEqual(adoptAcceptedDerivedPlan(input), expected);
});

// --- Sites 2-4: computeNextScopeStateAfterExecuteFinalization ----------------

function seedArgCompletedScopes(state: OrchestrationState): OrchestrationState['completedScopes'] {
  return [
    ...state.completedScopes,
    seedCompletedScope({ number: '7.3', commitSubject: 'arg scope commit subject' }),
  ];
}

test('execute finalization derived-plan-completed branch clears derived identity and re-enters top-level coder scope (site 2)', () => {
  // Branch predicates: executing derived plan (derivedPlanStatus 'accepted',
  // derivedFromScopeNumber and derivedScopeIndex non-null) with
  // lastScopeMarker 'AUTONOMY_DONE'. executionShape 'multi_scope' advances the
  // top-level scope number 7 -> 8.
  const input = createSeededTransitionState({ lastScopeMarker: 'AUTONOMY_DONE' });
  const completedScopes = seedArgCompletedScopes(input);

  // Complete-state pin: preserved as seeded — notably coderRetryCount,
  // blockedFromPhase, manualGate, interactiveBlockedRecovery,
  // reviewerSessionHandle, derivedPlanDepth, and
  // finalCompletionContinueExecutionCount. The archivedReviewPath ARG is
  // ignored on this branch: the state's archivedReviewPath resets to null.
  const expected: OrchestrationState = {
    ...input,
    baseCommit: 'arg-final-commit',
    finalCommit: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    currentScopeNumber: 8,
    lastScopeMarker: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    splitPlanCountForCurrentScope: 0,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    planReviewDebt: [],
    createdCommits: [],
    completedScopes,
    archivedReviewPath: null,
    phase: 'coder_scope',
    status: 'running',
  };

  assert.deepStrictEqual(
    computeNextScopeStateAfterExecuteFinalization({
      state: input,
      finalCommit: 'arg-final-commit',
      completedScopes,
      archivedReviewPath: '/arg/archived-review.md',
    }),
    expected,
  );
});

test('execute finalization derived-continue branch advances the derived scope index and keeps derived identity (site 3)', () => {
  // Branch predicates: executing derived plan with a non-terminal marker
  // (lastScopeMarker 'AUTONOMY_SCOPE_DONE' from the base seed).
  const input = createSeededTransitionState({});
  const completedScopes = seedArgCompletedScopes(input);

  // Complete-state pin: unlike the completed branch, this branch preserves
  // currentScopeNumber, derivedPlanPath, derivedFromScopeNumber,
  // derivedPlanStatus, AND splitPlanCountForCurrentScope, and advances
  // derivedScopeIndex 3 -> 4. coderRetryCount, blockedFromPhase, manualGate,
  // interactiveBlockedRecovery, reviewerSessionHandle, derivedPlanDepth, and
  // finalCompletionContinueExecutionCount are preserved as seeded.
  const expected: OrchestrationState = {
    ...input,
    baseCommit: 'arg-final-commit',
    finalCommit: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    lastScopeMarker: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    derivedScopeIndex: 4,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    planReviewDebt: [],
    createdCommits: [],
    completedScopes,
    archivedReviewPath: null,
    phase: 'coder_scope',
    status: 'running',
  };

  assert.deepStrictEqual(
    computeNextScopeStateAfterExecuteFinalization({
      state: input,
      finalCommit: 'arg-final-commit',
      completedScopes,
      archivedReviewPath: '/arg/archived-review.md',
    }),
    expected,
  );
});

test('execute finalization top-level-continue branch advances the scope number and clears stale derived identity (site 4)', () => {
  // Branch predicates: NOT executing a derived plan and
  // shouldContinueTopLevelExecutionAfterAcceptedScope — lastScopeMarker
  // 'AUTONOMY_SCOPE_DONE' (not DONE/BLOCKED) with executionShape
  // 'multi_scope'. A REJECTED unexecuted derived plan keeps derivedPlanPath /
  // derivedFromScopeNumber / derivedPlanStatus seeded non-default without
  // making isExecutingDerivedPlan true, so this branch's derived-identity
  // resets stay distinguishable.
  const input = createSeededTransitionState({
    derivedPlanStatus: 'rejected',
    derivedScopeIndex: null,
  });
  const completedScopes = seedArgCompletedScopes(input);

  // Complete-state pin: preserved as seeded — notably coderRetryCount,
  // blockedFromPhase, manualGate, interactiveBlockedRecovery,
  // reviewerSessionHandle, derivedPlanDepth, and
  // finalCompletionContinueExecutionCount.
  const expected: OrchestrationState = {
    ...input,
    baseCommit: 'arg-final-commit',
    finalCommit: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    currentScopeNumber: 8,
    lastScopeMarker: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    splitPlanCountForCurrentScope: 0,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    planReviewDebt: [],
    createdCommits: [],
    completedScopes,
    archivedReviewPath: null,
    phase: 'coder_scope',
    status: 'running',
  };

  assert.deepStrictEqual(
    computeNextScopeStateAfterExecuteFinalization({
      state: input,
      finalCommit: 'arg-final-commit',
      completedScopes,
      archivedReviewPath: '/arg/archived-review.md',
    }),
    expected,
  );
});

// --- Site 5: computeNextScopeStateAfterParentAdvance --------------------------

test('parent advance resets the widest per-scope set including gates, sessions, and recovery (site 5)', () => {
  // No branch predicates: the function always returns the reset. The seed is
  // an executing derived plan (the production advance_parent context);
  // executionShape 'multi_scope' advances the top-level scope number 7 -> 8.
  const input = createSeededTransitionState({});
  const completedScopes = seedArgCompletedScopes(input);

  // Complete-state pin: this is the widest reset — unlike sites 1-4 it also
  // clears archivedReviewPath, reviewerSessionHandle, coderRetryCount,
  // manualGate, blockedFromPhase, and interactiveBlockedRecovery. Preserved as
  // seeded — notably plannerSessionHandle/Protocol,
  // interactiveBlockedRecoveryHistory, pendingPlanReviewGuidance,
  // derivedPlanDepth, and finalCompletionContinueExecutionCount.
  const expected: OrchestrationState = {
    ...input,
    baseCommit: 'arg-final-commit',
    finalCommit: null,
    archivedReviewPath: null,
    coderSessionHandle: null,
    coderSessionProtocol: null,
    reviewerSessionHandle: null,
    coderRetryCount: 0,
    currentScopeNumber: 8,
    lastScopeMarker: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    manualGate: null,
    finalCompletionSummary: null,
    finalCompletionReviewVerdict: null,
    finalCompletionResolvedAction: null,
    finalCompletionContinueExecutionCapReached: false,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    splitPlanStartedNotified: false,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    splitPlanCountForCurrentScope: 0,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    planReviewDebt: [],
    createdCommits: [],
    completedScopes,
    blockedFromPhase: null,
    interactiveBlockedRecovery: null,
    phase: 'coder_scope',
    status: 'running',
  };

  assert.deepStrictEqual(
    computeNextScopeStateAfterParentAdvance({
      state: input,
      finalCommit: 'arg-final-commit',
      completedScopes,
    }),
    expected,
  );
});

// --- Persisted-site fixture ----------------------------------------------------

// Preserved-field agent config for the persisted fixtures: hermetic provider
// selection (reviewer capabilities drive real routing in site 7) with
// non-default model/effort values so config preservation is distinguishable.
function seedPersistedAgentConfig() {
  const config = hermeticAgentConfig();
  return {
    planner: { ...config.planner, model: 'seed-planner-model', effort: 'high' },
    coder: { ...config.coder, model: 'seed-coder-model', effort: 'medium' },
    reviewer: { ...config.reviewer, model: 'seed-reviewer-model', effort: 'low' },
  };
}

// Real-repository fixture for the two PERSISTED sites. Unlike the pure-site
// seeds, these pre-states go through saveState and must satisfy the state
// invariants, so fields with structural constraints (manualGate,
// pendingPlanReviewGuidance, interactiveBlockedRecovery-vs-phase pairing) are
// seeded to the closest invariant-valid non-default shape.
async function createPersistedSiteFixture(options: {
  prefix: string;
  finalCompletionContinueExecutionMax?: number;
  overrides: (context: { baseCommit: string; createdCommit: string; runDir: string }) => Partial<OrchestrationState>;
}) {
  const root = await mkdtemp(join(tmpdir(), options.prefix));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  const trackedFile = join(cwd, 'scope.txt');

  await mkdir(runDir, { recursive: true });
  const extraConfig =
    typeof options.finalCompletionContinueExecutionMax === 'number'
      ? `  final_completion_continue_execution_max: ${options.finalCompletionContinueExecutionMax}\n`
      : '';
  await writeFile(join(cwd, 'neal.yml'), `neal:\n  notify_bin: /usr/bin/true\n${extraConfig}`, 'utf8');
  clearConfigCache(cwd);
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(trackedFile, 'base\n', 'utf8');

  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await runGit(cwd, 'add', 'PLAN.md', 'neal.yml', 'scope.txt');
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
      agentConfig: hermeticAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    baseCommit,
  );

  await writeFile(trackedFile, 'base\nchange\n', 'utf8');
  await runGit(cwd, 'add', 'scope.txt');
  await runGit(cwd, 'commit', '-m', 'scope work');
  const createdCommit = await runGit(cwd, 'rev-parse', 'HEAD');

  const statePath = getRunStatePath(runDir);
  const state = await saveState(statePath, {
    ...initialState,
    baseCommit,
    createdCommits: [createdCommit],
    ...options.overrides({ baseCommit, createdCommit, runDir }),
  });

  return { cwd, runDir, statePath, state, baseCommit, createdCommit };
}

// --- Site 6: persistSplitPlanRecovery success-path saveState spread -----------

test('persistSplitPlanRecovery persisted spread resets abandoned scope work and enters derived-plan review (site 6)', async () => {
  // Pre-state shaped like the production interactive-recovery
  // replace_current_scope route: phase 'interactive_blocked_recovery' with an
  // active recovery record (the only invariant-valid way to seed
  // interactiveBlockedRecovery non-null) and status 'blocked' (the recovery
  // resting state, so the site's status: 'running' write is distinguishable),
  // a stale ACTIVE derived plan (accepted, derivedScopeIndex 5) so every
  // derived-identity reset is distinguishable, and non-default values in every
  // other reset-candidate AND preserved field the invariants allow. The
  // invariant-valid capReached-true triple (verdict continue_execution +
  // resolvedAction block_for_operator + capReached true) makes any wrongly
  // shared finalCompletion reset distinguishable. Constrained fields:
  // splitPlanCountForCurrentScope 3 < 10 and derivedPlanDepth 0 < 1 are branch
  // predicates; manualGate and pendingPlanReviewGuidance must stay null
  // (phase/mode invariants).
  const { cwd, runDir, statePath, state, baseCommit } = await createPersistedSiteFixture({
    prefix: 'neal-scope-boundary-split-',
    overrides: () => ({
      planDocBackupPath: '/seed/plan-backup.md',
      allowedDirtyPaths: ['docs/allowed-dirty.md'],
      agentConfig: seedPersistedAgentConfig(),
      autoSquashOnCompletion: false,
      currentScopeNumber: 7,
      executionShape: 'multi_scope',
      authoredExecutionShape: 'multi_scope',
      maxRounds: 6,
      maxDerivedPlanReviewRounds: 9,
      phase: 'interactive_blocked_recovery',
      status: 'blocked',
      blockedFromPhase: 'coder_scope',
      interactiveBlockedRecovery: seedInteractiveBlockedRecovery(),
      interactiveBlockedRecoveryHistory: [seedInteractiveBlockedRecoveryHistoryRecord()],
      lastScopeMarker: 'AUTONOMY_BLOCKED',
      finalCommit: 'seed-stale-final-commit',
      archivedReviewPath: '/seed/prior-archived-review.md',
      plannerSessionHandle: 'seed-planner-session',
      plannerSessionProtocol: 'structured_json_v1',
      coderSessionHandle: 'seed-coder-session',
      coderSessionProtocol: 'structured_json_v1',
      reviewerSessionHandle: 'seed-reviewer-session',
      coderRetryCount: 4,
      currentScopeProgressJustification: seedProgressJustification(),
      currentScopeMeaningfulProgressVerdict: seedMeaningfulProgressVerdict(),
      finalCompletionSummary: seedFinalCompletionSummary(),
      finalCompletionReviewVerdict: seedFinalCompletionReviewVerdict(),
      finalCompletionResolvedAction: 'block_for_operator',
      finalCompletionContinueExecutionCount: 2,
      finalCompletionContinueExecutionCapReached: true,
      derivedPlanPath: '/seed/OLD_DERIVED_PLAN_SCOPE_7.md',
      derivedFromScopeNumber: 7,
      derivedPlanStatus: 'accepted',
      derivedScopeIndex: 5,
      splitPlanStartedNotified: true,
      derivedPlanAcceptedNotified: true,
      splitPlanBlockedNotified: true,
      splitPlanCountForCurrentScope: 3,
      derivedPlanDepth: 0,
      rounds: [seedReviewRound()],
      recentBlocks: [seedRecentBlock()],
      consultantAttemptCount: 3,
      findings: [seedFinding()],
      planReviewDebt: seedCurrentPlanReviewDebt(),
      inheritedPlanReviewDebt: seedInheritedPlanReviewDebt(),
      completedScopes: [seedCompletedScope({ number: '3', derivedFromParentScope: null })],
    }),
  });

  const validPlan = `# Replacement Plan

## Execution Shape

executionShape: multi_scope_unknown

## Execution Loop

### Recurring Scope
- Goal: Complete one bounded replacement slice.
- Verification: \`pnpm typecheck\`
- Success Condition: One replacement slice is complete and reviewable.

## Completion Condition

Stop when the replacement queue is exhausted.
`;

  const nextState = await persistSplitPlanRecovery(
    state,
    statePath,
    {
      sourcePhase: 'coder_scope',
      derivedPlanMarkdown: validPlan,
      createdCommits: state.createdCommits,
    },
    {
      persistBlockedScope: async () => {
        throw new Error('persistBlockedScope must not run on the split-plan success path');
      },
      writeExecutionArtifacts: async () => {},
    },
  );

  // Complete-state pin of the persisted result (saveState bookkeeping
  // normalized via updatedAt). Everything not listed is preserved as seeded —
  // notably coderSessionHandle/Protocol, plannerSessionHandle/Protocol,
  // finalCommit, archivedReviewPath, ALL five finalCompletion* fields
  // (including finalCompletionContinueExecutionCapReached staying TRUE — the
  // split-plan site must not reset it), interactiveBlockedRecoveryHistory,
  // completedScopes, currentScopeNumber, baseCommit, derivedPlanDepth,
  // autoSquashOnCompletion,
  // planDocBackupPath, allowedDirtyPaths, agentConfig, maxRounds,
  // maxDerivedPlanReviewRounds, and authoredExecutionShape.
  const expected: OrchestrationState = {
    ...state,
    lastScopeMarker: 'AUTONOMY_SPLIT_PLAN',
    phase: 'reviewer_plan',
    status: 'running',
    blockedFromPhase: null,
    currentScopeProgressJustification: null,
    currentScopeMeaningfulProgressVerdict: null,
    interactiveBlockedRecovery: null,
    derivedPlanPath: join(runDir, 'DERIVED_PLAN_SCOPE_7.md'),
    derivedFromScopeNumber: 7,
    derivedPlanStatus: 'pending_review',
    // The persisted spread itself writes splitPlanStartedNotified: false; the
    // derived-plan notification flush that persistSplitPlanRecovery runs
    // before returning sends the started notification and flips it to true.
    splitPlanStartedNotified: true,
    derivedPlanAcceptedNotified: false,
    splitPlanBlockedNotified: false,
    derivedScopeIndex: null,
    splitPlanCountForCurrentScope: 4,
    rounds: [],
    recentBlocks: [],
    consultantAttemptCount: 0,
    findings: [],
    planReviewDebt: [],
    createdCommits: [],
    coderRetryCount: 0,
    reviewerSessionHandle: null,
    updatedAt: nextState.updatedAt,
  };

  assert.deepStrictEqual(nextState, expected);
  // The on-disk persisted state matches the returned state field-for-field.
  assert.deepStrictEqual(JSON.parse(await readFile(statePath, 'utf8')), expected);
  // Route sanity: the abandoned scope worktree was reset to the scope base and
  // the derived plan document was persisted at the recorded path.
  assert.equal(await runGit(cwd, 'rev-parse', 'HEAD'), baseCommit);
  assert.equal(await readFile(join(runDir, 'DERIVED_PLAN_SCOPE_7.md'), 'utf8'), `${validPlan.trim()}\n`);
});

// --- Site 7: final completion continue-execution reopen ------------------------

test('final completion continue_execution reopen resets the follow-on scope boundary completely (site 7)', async () => {
  // Pre-state: an accepted terminal scope awaiting final completion review,
  // with non-default values in every reset-candidate AND preserved field the
  // invariants allow: a REJECTED unexecuted derived-plan identity (path,
  // parent, status non-null with derivedScopeIndex null — the only rejected
  // shape the invariants accept), positive derivedPlanDepth, non-empty
  // interactiveBlockedRecoveryHistory, and all three split-plan notification
  // flags true. Constrained fields: finalCompletionReviewVerdict /
  // ResolvedAction must be null pre-review (a non-null pair would have to be
  // self-consistent and capReached must stay false while the verdict is
  // null); manualGate and interactiveBlockedRecovery must stay null
  // (phase-pairing invariants); pendingPlanReviewGuidance must stay null
  // (execute mode). Config pins final_completion_continue_execution_max to 7,
  // so the seeded count 3 stays under the cap and increments to 4.
  const { statePath, state, createdCommit } = await createPersistedSiteFixture({
    prefix: 'neal-scope-boundary-reopen-',
    finalCompletionContinueExecutionMax: 7,
    overrides: ({ baseCommit: fixtureBaseCommit, createdCommit: fixtureCreatedCommit }) => ({
      planDocBackupPath: '/seed/plan-backup.md',
      allowedDirtyPaths: ['docs/allowed-dirty.md'],
      agentConfig: seedPersistedAgentConfig(),
      autoSquashOnCompletion: false,
      currentScopeNumber: 5,
      executionShape: 'multi_scope',
      authoredExecutionShape: 'multi_scope',
      maxRounds: 6,
      maxDerivedPlanReviewRounds: 9,
      phase: 'final_completion_review',
      status: 'running',
      blockedFromPhase: 'reviewer_scope',
      interactiveBlockedRecoveryHistory: [seedInteractiveBlockedRecoveryHistoryRecord()],
      lastScopeMarker: 'AUTONOMY_DONE',
      finalCommit: fixtureCreatedCommit,
      archivedReviewPath: '/seed/prior-archived-review.md',
      plannerSessionHandle: 'seed-planner-session',
      plannerSessionProtocol: 'structured_json_v1',
      coderSessionHandle: 'seed-coder-session',
      coderSessionProtocol: 'structured_json_v1',
      reviewerSessionHandle: 'seed-reviewer-session',
      coderRetryCount: 4,
      currentScopeProgressJustification: seedProgressJustification(),
      currentScopeMeaningfulProgressVerdict: seedMeaningfulProgressVerdict(),
      finalCompletionSummary: seedFinalCompletionSummary(),
      finalCompletionReviewVerdict: null,
      finalCompletionResolvedAction: null,
      finalCompletionContinueExecutionCount: 3,
      finalCompletionContinueExecutionCapReached: false,
      derivedPlanPath: '/seed/REJECTED_DERIVED_PLAN_SCOPE_5.md',
      derivedFromScopeNumber: 5,
      derivedPlanStatus: 'rejected',
      derivedScopeIndex: null,
      derivedPlanDepth: 1,
      splitPlanStartedNotified: true,
      derivedPlanAcceptedNotified: true,
      splitPlanBlockedNotified: true,
      splitPlanCountForCurrentScope: 2,
      rounds: [seedReviewRound()],
      recentBlocks: [seedRecentBlock()],
      consultantAttemptCount: 3,
      findings: [seedFinding()],
      planReviewDebt: seedCurrentPlanReviewDebt(),
      inheritedPlanReviewDebt: seedInheritedPlanReviewDebt(),
      completedScopes: [
        seedCompletedScope({
          number: '5',
          marker: 'AUTONOMY_DONE',
          baseCommit: fixtureBaseCommit,
          finalCommit: fixtureCreatedCommit,
          commitSubject: 'finish scope 5',
          changedFiles: ['scope.txt'],
          derivedFromParentScope: null,
          archivedReviewPath: '/seed/prior-archived-review.md',
        }),
      ],
    }),
  });

  setProviderCapabilitiesOverrideForTesting('anthropic-claude', {
    createStructuredAdvisorAdapter() {
      return {
        async runStructuredRound<TStructured>() {
          return {
            sessionHandle: 'reviewer-reopen-session',
            structured: {
              action: 'continue_execution',
              summary: 'One follow-on scope is required.',
              rationale: 'The seeded gap still needs an execution scope.',
              missingWork: {
                summary: 'Implement the remaining follow-on work.',
                requiredOutcome: 'The follow-on scope lands and is verified.',
                verification: 'Run the targeted suite.',
              },
            } as TStructured,
          };
        },
      };
    },
  });

  try {
    const nextState = await runFinalCompletionReviewPhase(state, statePath);

    // Complete-state pin of the persisted reopen result (saveState bookkeeping
    // normalized via updatedAt). Everything not listed is preserved as seeded
    // — notably the rejected derived-plan identity (derivedPlanPath /
    // derivedFromScopeNumber / derivedPlanStatus / derivedScopeIndex), the
    // positive derivedPlanDepth, the three split-plan notification flags,
    // non-empty interactiveBlockedRecoveryHistory,
    // plannerSessionHandle/Protocol, completedScopes,
    // autoSquashOnCompletion,
    // planDocBackupPath, allowedDirtyPaths, agentConfig, maxRounds,
    // maxDerivedPlanReviewRounds, and authoredExecutionShape — all untouched
    // by the reopen spread.
    const expected: OrchestrationState = {
      ...state,
      reviewerSessionHandle: 'reviewer-reopen-session',
      finalCompletionReviewVerdict: {
        action: 'continue_execution',
        summary: 'One follow-on scope is required.',
        rationale: 'The seeded gap still needs an execution scope.',
        missingWork: {
          summary: 'Implement the remaining follow-on work.',
          requiredOutcome: 'The follow-on scope lands and is verified.',
          verification: 'Run the targeted suite.',
        },
        squashCommitMessage: null,
      },
      finalCompletionResolvedAction: 'continue_execution',
      finalCompletionContinueExecutionCount: 4,
      finalCompletionContinueExecutionCapReached: false,
      baseCommit: createdCommit,
      finalCommit: null,
      archivedReviewPath: null,
      coderSessionHandle: null,
      coderSessionProtocol: null,
      coderRetryCount: 0,
      currentScopeNumber: 6,
      lastScopeMarker: null,
      currentScopeProgressJustification: null,
      currentScopeMeaningfulProgressVerdict: null,
      finalCompletionSummary: null,
      rounds: [],
      recentBlocks: [],
      // Per-scope budgets reset at the reopen scope boundary exactly as they
      // do at every scope-advance transition.
      consultantAttemptCount: 0,
      splitPlanCountForCurrentScope: 0,
      findings: [],
      planReviewDebt: [],
      createdCommits: [],
      blockedFromPhase: null,
      phase: 'coder_scope',
      status: 'running',
      updatedAt: nextState.updatedAt,
    };

    assert.deepStrictEqual(nextState, expected);
    // The on-disk persisted state matches the returned state field-for-field.
    assert.deepStrictEqual(JSON.parse(await readFile(statePath, 'utf8')), expected);
  } finally {
    clearProviderCapabilitiesOverridesForTesting();
  }
});
