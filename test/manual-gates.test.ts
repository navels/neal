import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { runManualGateResumeChecks } from '../src/neal/manual-gates.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { ManualGateResumeCheck, OrchestrationState } from '../src/neal/types.js';

async function createManualGateState(checks: ManualGateResumeCheck[]): Promise<OrchestrationState> {
  const root = await mkdtemp(join(tmpdir(), 'neal-manual-gate-'));
  const cwd = join(root, 'repo');
  const runDir = join(cwd, '.neal', 'runs', 'manual-gate-run');
  await mkdir(runDir, { recursive: true });
  const now = new Date().toISOString();
  const state = await createInitialState(
    {
      cwd,
      runDir,
      topLevelMode: 'execute',
      planDoc: join(cwd, 'PLAN.md'),
      planDocBackupPath: null,
      stateDir: join(cwd, '.neal'),
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(cwd),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 5,
    },
    'base-commit',
  );

  return {
    ...state,
    phase: 'manual_gate',
    manualGate: {
      id: 'approval',
      title: 'Approval required',
      reason: 'The user must approve deployment.',
      instructionsPath: join(runDir, 'GATE-approval.md'),
      resumeChecks: checks,
      resumePhase: 'coder_scope',
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
      lastFailure: null,
    },
  };
}

test('manual gate resume checks accept an exit-zero command', async () => {
  const state = await createManualGateState([
    {
      type: 'command',
      name: 'zero',
      command: [process.execPath, '-e', 'process.exit(0)'],
    },
  ]);

  const result = await runManualGateResumeChecks(state);

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.checkName, 'zero');
});

test('manual gate resume checks record nonzero exit codes', async () => {
  const state = await createManualGateState([
    {
      type: 'command',
      name: 'nonzero',
      command: [process.execPath, '-e', 'process.stderr.write("nope"); process.exit(7)'],
    },
  ]);

  const result = await runManualGateResumeChecks(state);

  assert.equal(result.ok, false);
  assert.equal(result.failure.checkName, 'nonzero');
  assert.equal(result.failure.exitCode, 7);
  assert.equal(result.failure.signal, null);
  assert.equal(result.failure.stderrTail, 'nope');
});

test('manual gate resume checks record timeout signals', async () => {
  const state = await createManualGateState([
    {
      type: 'command',
      name: 'slow',
      command: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'],
      timeoutMs: 20,
    },
  ]);

  const result = await runManualGateResumeChecks(state);

  assert.equal(result.ok, false);
  assert.equal(result.failure.checkName, 'slow');
  assert.equal(result.failure.exitCode, null);
  assert.equal(result.failure.signal, 'SIGTERM');
});

test('manual gate resume checks pass argv arrays without shell interpretation', async () => {
  const state = await createManualGateState([
    {
      type: 'command',
      name: 'argv',
      command: [
        process.execPath,
        '-e',
        'process.exit(process.argv[1] === "literal; exit 9" ? 0 : 1)',
        'literal; exit 9',
      ],
    },
  ]);

  const result = await runManualGateResumeChecks(state);

  assert.equal(result.ok, true);
});

test('manual gate resume checks bound tails and redact sensitive environment values', async () => {
  const previousToken = process.env.NEAL_TEST_TOKEN;
  process.env.NEAL_TEST_TOKEN = 'very-secret-token-value';
  const state = await createManualGateState([
    {
      type: 'command',
      name: 'tails',
      command: [
        process.execPath,
        '-e',
        [
          'const value = process.env.NEAL_TEST_TOKEN;',
          'process.stdout.write("x".repeat(5000) + value);',
          'process.stderr.write("y".repeat(5000) + value);',
          'process.exit(3);',
        ].join(' '),
      ],
    },
  ]);

  try {
    const result = await runManualGateResumeChecks(state);

    assert.equal(result.ok, false);
    assert.ok(result.failure.stdoutTail.length <= 4000);
    assert.ok(result.failure.stderrTail.length <= 4000);
    assert.doesNotMatch(result.failure.stdoutTail, /very-secret-token-value/);
    assert.doesNotMatch(result.failure.stderrTail, /very-secret-token-value/);
    assert.match(result.failure.stdoutTail, /\[redacted\]/);
    assert.match(result.failure.stderrTail, /\[redacted\]/);
  } finally {
    if (previousToken === undefined) {
      delete process.env.NEAL_TEST_TOKEN;
    } else {
      process.env.NEAL_TEST_TOKEN = previousToken;
    }
  }
});
