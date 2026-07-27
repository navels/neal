import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReviewerResumeHandle } from '../src/neal/agents/rounds.js';
import type { AgentRoleConfig } from '../src/neal/types.js';

// Reviewer session continuity (issue #23): review rounds within one
// engagement resume the reviewer's previous session so the reviewer converges
// like a continuing conversation instead of cold-start re-auditing every
// round. The provider gate must keep sessionless providers at null —
// openai-compatible treats a non-null resume handle as corrupted state.

function reviewer(provider: AgentRoleConfig['provider']): AgentRoleConfig {
  return { provider, model: null, effort: null };
}

test('resolveReviewerResumeHandle passes the handle through for session-capable providers', () => {
  assert.equal(resolveReviewerResumeHandle(reviewer('openai-codex'), 'thread-1'), 'thread-1');
  assert.equal(resolveReviewerResumeHandle(reviewer('anthropic-claude'), 'session-1'), 'session-1');
});

test('resolveReviewerResumeHandle filters sessionless providers to null', () => {
  assert.equal(resolveReviewerResumeHandle(reviewer('openai-compatible'), 'synthetic-handle'), null);
});

test('resolveReviewerResumeHandle maps absent handles to null for every provider', () => {
  for (const provider of ['openai-codex', 'anthropic-claude', 'openai-compatible'] as const) {
    assert.equal(resolveReviewerResumeHandle(reviewer(provider), null), null);
    assert.equal(resolveReviewerResumeHandle(reviewer(provider), undefined), null);
  }
});
