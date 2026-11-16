import { NealProviderError } from './providers/types.js';
import type { OrchestrationState } from './types.js';

export const USAGE_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
const USAGE_LIMIT_RESET_BUFFER_MS = 60 * 1000;
const USAGE_LIMIT_MAX_CONSECUTIVE_WAITS = 3;

export function getUsageLimitError(error: unknown): NealProviderError | null {
  const providerError = error instanceof NealProviderError
    ? error
    : error instanceof Error && 'providerError' in error ? error.providerError : null;
  return providerError instanceof NealProviderError && providerError.kind === 'usage_limit' ? providerError : null;
}

export function decideUsageLimitWait(args: {
  error: unknown;
  nowMs: number;
  waitsSoFar: number;
}): { action: 'wait'; wakeAt: number } | { action: 'fail'; reason: string } {
  const error = getUsageLimitError(args.error);
  if (!error) return { action: 'fail', reason: 'not a usage limit' };
  if (args.waitsSoFar >= USAGE_LIMIT_MAX_CONSECUTIVE_WAITS) {
    return { action: 'fail', reason: 'usage limit repeated without progress after three waits' };
  }
  if (error.resetsAt === null) return { action: 'fail', reason: 'provider did not report a reset time' };
  if (error.resetsAt <= args.nowMs) return { action: 'fail', reason: 'reported reset time is not in the future' };
  const wakeAt = error.resetsAt + USAGE_LIMIT_RESET_BUFFER_MS;
  if (wakeAt - args.nowMs > USAGE_LIMIT_MAX_WAIT_MS) {
    return { action: 'fail', reason: 'reset plus buffer exceeds the six-hour wait cap' };
  }
  return { action: 'wait', wakeAt };
}

// Compare failures, not the temporary running state created by resume.
export function usageLimitProgressKey(state: OrchestrationState): string {
  return JSON.stringify([state.phase, state.currentScopeNumber, state.rounds.length]);
}

export function formatUsageLimitWaitingReason(resetsAt: string, wakeAt: string): string {
  return `usage limit resets at ${new Date(resetsAt).toLocaleString()}; neal will resume automatically at ${new Date(wakeAt).toLocaleString()}`;
}
