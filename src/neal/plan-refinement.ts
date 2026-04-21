import type { OrchestrationState } from './types.js';

export type PlanRefinementConvergenceReason = 'converged' | 'stuck' | 'max_rounds' | 'coder_blocked';

export function isPlanRefinementState(
  state: Pick<OrchestrationState, 'topLevelMode' | 'derivedPlanPath' | 'diagnosticRecovery'>,
): boolean {
  return state.topLevelMode === 'plan' && !state.derivedPlanPath && !state.diagnosticRecovery;
}

export function formatPlanRefinementRoundLine(args: { round: number; maxRounds: number }): string {
  return `[neal] plan refinement mode: round ${args.round}/${args.maxRounds}`;
}

export function determinePlanRefinementConvergence(
  state: Pick<OrchestrationState, 'status' | 'rounds' | 'maxRounds'>,
): PlanRefinementConvergenceReason | null {
  if (state.status === 'done') {
    return 'converged';
  }
  if (state.status !== 'blocked') {
    return null;
  }
  if (state.rounds.length === 0) {
    return 'coder_blocked';
  }
  if (state.rounds.length >= state.maxRounds) {
    return 'max_rounds';
  }
  return 'stuck';
}

export function formatPlanRefinementSummary(args: {
  rounds: number;
  backupPath: string | null;
  convergenceReason: PlanRefinementConvergenceReason;
  residualNonBlocking: number;
}): string {
  const parts = [`plan refined: ${args.rounds} rounds`];
  if (args.backupPath) {
    parts.push(`backup at ${args.backupPath}`);
  }
  parts.push(`convergence reason: ${args.convergenceReason}`);
  const line = `[neal] ${parts.join(', ')}`;
  if (args.residualNonBlocking > 0) {
    return `${line} (${args.residualNonBlocking} residual non-blocking findings)`;
  }
  return line;
}

export function planRefinementExitCode(reason: PlanRefinementConvergenceReason | null): number {
  return reason === 'converged' || reason === null ? 0 : 2;
}

export function countOpenNonBlockingFindings(
  state: Pick<OrchestrationState, 'findings'>,
): number {
  return state.findings.filter((finding) => finding.status === 'open' && finding.severity === 'non_blocking').length;
}
