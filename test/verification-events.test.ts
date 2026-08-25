import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVerificationTally, extractCommandResults } from '../src/neal/verification-events.js';
import type { VerificationCommandResult } from '../src/neal/types.js';

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

function failingResult(command: string): VerificationCommandResult {
  return {
    command,
    provider: 'openai-codex',
    status: 'completed',
    exitCode: 1,
    cwd: '/repo',
    gitHead: 'abc123',
    completedAt: '2026-04-25T18:15:00.000Z',
    itemId: null,
    outputLength: null,
  };
}

test('buildVerificationTally keeps a repeated command recent when its latest failure occurs last', () => {
  // 15 distinct failing commands; the first command fails again at the very
  // end of the run. Recency must follow each command's latest event position,
  // so that final failure belongs in recentFailures even though the command
  // first appeared before every other failure.
  const commands = Array.from({ length: 15 }, (_, index) => `pnpm test group-${String(index).padStart(2, '0')}`);
  const results = [...commands.map(failingResult), failingResult('pnpm test group-00')];

  const tally = buildVerificationTally(results);

  assert.equal(tally.totalRuns, 16);
  assert.equal(tally.distinctCommands, 15);
  assert.equal(tally.failed, 15);
  assert.equal(tally.recentFailures.length, 10);
  assert.deepEqual(
    tally.recentFailures.map((failure) => failure.command),
    [
      'pnpm test group-06',
      'pnpm test group-07',
      'pnpm test group-08',
      'pnpm test group-09',
      'pnpm test group-10',
      'pnpm test group-11',
      'pnpm test group-12',
      'pnpm test group-13',
      'pnpm test group-14',
      'pnpm test group-00',
    ],
  );
});
