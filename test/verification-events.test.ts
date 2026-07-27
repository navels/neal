import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCommandResults } from '../src/neal/verification-events.js';

test('extractCommandResults recognizes normalized provider command events', () => {
  const results = extractCommandResults([
    {
      ts: '2026-04-25T18:15:00.000Z',
      type: 'provider.command_completed',
      data: {
        provider: 'openai-codex',
        role: 'coder',
        command: 'pnpm typecheck',
        status: 'completed',
        exitCode: 0,
        cwd: '/repo',
        gitHead: 'abc123',
        itemId: 'cmd-1',
        outputLength: 42,
      },
    },
  ]);

  assert.deepEqual(results, [
    {
      command: 'pnpm typecheck',
      provider: 'openai-codex',
      status: 'completed',
      exitCode: 0,
      cwd: '/repo',
      gitHead: 'abc123',
      completedAt: '2026-04-25T18:15:00.000Z',
      itemId: 'cmd-1',
      outputLength: 42,
    },
  ]);
});
