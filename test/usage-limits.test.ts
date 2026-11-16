import test from 'node:test';
import assert from 'node:assert/strict';

import { CoderRoundError, ReviewerRoundError } from '../src/neal/agents.js';
import { NealProviderError } from '../src/neal/providers/types.js';
import { decideUsageLimitWait, USAGE_LIMIT_MAX_WAIT_MS, usageLimitProgressKey } from '../src/neal/usage-limits.js';
import type { OrchestrationState } from '../src/neal/types.js';

const nowMs = Date.parse('2026-11-15T12:00:00Z');
function error(resetsAt: number | null) {
  return new NealProviderError({ message: 'usage limit', provider: 'openai-codex', role: 'coder', kind: 'usage_limit', resetsAt });
}

test('usage-limit wait includes the reset buffer inside its six-hour cap', () => {
  const edge = nowMs + USAGE_LIMIT_MAX_WAIT_MS - 60_000;
  assert.deepEqual(decideUsageLimitWait({ error: error(edge), nowMs, waitsSoFar: 0 }), { action: 'wait', wakeAt: nowMs + USAGE_LIMIT_MAX_WAIT_MS });
  for (const reset of [edge + 1, nowMs, nowMs - 1, null, NaN, Infinity]) {
    assert.equal(decideUsageLimitWait({ error: error(reset), nowMs, waitsSoFar: 0 }).action, 'fail');
  }
  assert.equal(decideUsageLimitWait({ error: new Error('usage limit'), nowMs, waitsSoFar: 0 }).action, 'fail');
});

test('usage-limit waits accept wrapped round errors and stop after three waits', () => {
  for (const failure of [error(nowMs + 1000), new CoderRoundError(error(nowMs + 1000)), new ReviewerRoundError(error(nowMs + 1000))]) {
    assert.equal(decideUsageLimitWait({ error: failure, nowMs, waitsSoFar: 2 }).action, 'wait');
    assert.equal(decideUsageLimitWait({ error: failure, nowMs, waitsSoFar: 3 }).action, 'fail');
  }
});

test('only phase, scope, or round changes reset the usage-limit progress key', () => {
  const state = { phase: 'coder_scope', currentScopeNumber: 2, rounds: [], status: 'failed' } as unknown as OrchestrationState;
  const key = usageLimitProgressKey(state);
  assert.equal(usageLimitProgressKey({ ...state, status: 'running', coderSessionHandle: 'new' }), key);
  assert.notEqual(usageLimitProgressKey({ ...state, phase: 'reviewer_scope' }), key);
  assert.notEqual(usageLimitProgressKey({ ...state, currentScopeNumber: 3 }), key);
  assert.notEqual(usageLimitProgressKey({ ...state, rounds: [{} as OrchestrationState['rounds'][number]] }), key);
});
