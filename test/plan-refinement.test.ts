import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countOpenNonBlockingFindings,
  determinePlanRefinementConvergence,
  formatPlanRefinementRoundLine,
  formatPlanRefinementSummary,
  isPlanRefinementState,
  planRefinementExitCode,
} from '../src/neal/plan-refinement.js';
import type { OrchestrationState, ReviewFinding, ReviewRound } from '../src/neal/types.js';

function makeState(overrides: Partial<OrchestrationState>): OrchestrationState {
  return {
    topLevelMode: 'plan',
    derivedPlanPath: null,
    diagnosticRecovery: null,
    status: 'running',
    rounds: [] as ReviewRound[],
    findings: [] as ReviewFinding[],
    maxRounds: 5,
    ...overrides,
  } as OrchestrationState;
}

test('isPlanRefinementState is true for plain --plan runs and false otherwise', () => {
  assert.equal(isPlanRefinementState(makeState({})), true);
  assert.equal(isPlanRefinementState(makeState({ topLevelMode: 'execute' })), false);
  assert.equal(
    isPlanRefinementState(makeState({ derivedPlanPath: '/tmp/derived.md' })),
    false,
    'derived-plan review should not be treated as refinement',
  );
  assert.equal(
    isPlanRefinementState(
      makeState({
        diagnosticRecovery: {
          sequence: 1,
          startedAt: '',
          sourcePhase: 'blocked',
          resumePhase: null,
          parentScopeLabel: '',
          blockedReason: null,
          question: '',
          target: '',
          requestedBaselineRef: null,
          effectiveBaselineRef: null,
          effectiveBaselineSource: 'run_base_commit',
          analysisArtifactPath: '',
          recoveryPlanPath: '',
        },
      }),
    ),
    false,
    'diagnostic recovery runs should not be treated as refinement',
  );
});

test('formatPlanRefinementRoundLine renders a human-readable round indicator', () => {
  assert.equal(
    formatPlanRefinementRoundLine({ round: 1, maxRounds: 5 }),
    '[neal] plan refinement mode: round 1/5',
  );
  assert.equal(
    formatPlanRefinementRoundLine({ round: 4, maxRounds: 4 }),
    '[neal] plan refinement mode: round 4/4',
  );
});

test('determinePlanRefinementConvergence classifies terminal states', () => {
  assert.equal(
    determinePlanRefinementConvergence(makeState({ status: 'running' })),
    null,
    'running state has no convergence reason yet',
  );
  assert.equal(
    determinePlanRefinementConvergence(makeState({ status: 'done' })),
    'converged',
  );
  assert.equal(
    determinePlanRefinementConvergence(makeState({ status: 'blocked', rounds: [] })),
    'coder_blocked',
    'blocking before any review round is coder-blocked',
  );
  assert.equal(
    determinePlanRefinementConvergence(
      makeState({
        status: 'blocked',
        rounds: [{ round: 1 } as ReviewRound, { round: 2 } as ReviewRound],
        maxRounds: 3,
      }),
    ),
    'stuck',
    'blocking before max rounds is stuck',
  );
  assert.equal(
    determinePlanRefinementConvergence(
      makeState({
        status: 'blocked',
        rounds: [{ round: 1 } as ReviewRound, { round: 2 } as ReviewRound, { round: 3 } as ReviewRound],
        maxRounds: 3,
      }),
    ),
    'max_rounds',
    'blocking at max rounds is max_rounds',
  );
});

test('formatPlanRefinementSummary matches the documented shape', () => {
  assert.equal(
    formatPlanRefinementSummary({
      rounds: 3,
      backupPath: '/plans/archive/P.pre-plan.abc.md',
      convergenceReason: 'converged',
      residualNonBlocking: 0,
    }),
    '[neal] plan refined: 3 rounds, backup at /plans/archive/P.pre-plan.abc.md, convergence reason: converged',
  );
  assert.equal(
    formatPlanRefinementSummary({
      rounds: 5,
      backupPath: null,
      convergenceReason: 'max_rounds',
      residualNonBlocking: 0,
    }),
    '[neal] plan refined: 5 rounds, convergence reason: max_rounds',
  );
  assert.equal(
    formatPlanRefinementSummary({
      rounds: 2,
      backupPath: '/plans/archive/P.pre-plan.xyz.md',
      convergenceReason: 'stuck',
      residualNonBlocking: 2,
    }),
    '[neal] plan refined: 2 rounds, backup at /plans/archive/P.pre-plan.xyz.md, convergence reason: stuck (2 residual non-blocking findings)',
  );
});

test('planRefinementExitCode returns 0 only for converged or null', () => {
  assert.equal(planRefinementExitCode('converged'), 0);
  assert.equal(planRefinementExitCode(null), 0);
  assert.equal(planRefinementExitCode('stuck'), 2);
  assert.equal(planRefinementExitCode('max_rounds'), 2);
  assert.equal(planRefinementExitCode('coder_blocked'), 2);
});

test('countOpenNonBlockingFindings only tallies open non-blocking findings', () => {
  const findings: Partial<ReviewFinding>[] = [
    { status: 'open', severity: 'non_blocking' },
    { status: 'open', severity: 'non_blocking' },
    { status: 'fixed', severity: 'non_blocking' },
    { status: 'open', severity: 'blocking' },
    { status: 'rejected', severity: 'non_blocking' },
  ];
  assert.equal(countOpenNonBlockingFindings({ findings: findings as ReviewFinding[] }), 2);
});
