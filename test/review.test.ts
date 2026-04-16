import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderConsultMarkdown } from '../src/neal/consult.js';
import { notifyInteractiveBlockedRecovery } from '../src/neal/orchestrator/notifications.js';
import { renderPlanProgressMarkdown } from '../src/neal/progress.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

async function createState(overrides: Partial<OrchestrationState> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'neal-review-artifacts-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      ignoreLocalChanges: false,
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      consultMarkdownPath: join(runDir, 'CONSULT.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return { root, state: { ...state, ...overrides } };
}

test('consult and progress artifacts preserve completed interactive blocked recovery history', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'coder_response',
    interactiveBlockedRecoveryHistory: [
      {
        enteredAt: '2026-04-16T00:00:00.000Z',
        sourcePhase: 'reviewer_scope',
        blockedReason: 'Review findings stopped converging.',
        maxTurns: 3,
        lastHandledTurn: 1,
        resolvedAt: '2026-04-16T00:03:00.000Z',
        resolvedByAction: 'resume_current_scope',
        resultPhase: 'coder_response',
        turns: [
          {
            number: 1,
            recordedAt: '2026-04-16T00:01:00.000Z',
            operatorGuidance: 'Apply the reviewer feedback and continue this scope.',
            disposition: {
              recordedAt: '2026-04-16T00:02:00.000Z',
              sessionHandle: 'coder-session-4b',
              action: 'resume_current_scope',
              summary: 'The scope can continue.',
              rationale: 'The operator clarified how to proceed.',
              blocker: '',
              replacementPlan: '',
              resultingPhase: 'coder_response',
            },
          },
        ],
      },
    ],
  });

  const consultMarkdown = renderConsultMarkdown(state);
  assert.match(consultMarkdown, /## Interactive Blocked Recovery History 1/);
  assert.match(consultMarkdown, /Resolution: resume_current_scope/);
  assert.match(consultMarkdown, /Recovery turn 1 coder action: resume_current_scope/);
  assert.match(consultMarkdown, /Recovery turn 1 resulting phase: coder_response/);

  const progressMarkdown = renderPlanProgressMarkdown(state);
  assert.match(progressMarkdown, /## Interactive Blocked Recovery History/);
  assert.match(progressMarkdown, /Sessions: 1/);
  assert.match(progressMarkdown, /Latest action: resume_current_scope/);
  assert.match(progressMarkdown, /Latest result phase: coder_response/);
});

test('interactive blocked recovery notification is distinct from a terminal blocked notification', async () => {
  const { root, state } = await createState({
    currentScopeNumber: 3,
  });
  const notifyLogPath = join(root, 'notify.log');
  const notifyScriptPath = join(root, 'notify.sh');
  await writeFile(
    notifyScriptPath,
    `#!/bin/sh\nprintf '%s\n' "$1" >> "${notifyLogPath}"\n`,
    'utf8',
  );
  await chmod(notifyScriptPath, 0o755);

  const previousNotifyBin = process.env.AUTONOMY_NOTIFY_BIN;
  process.env.AUTONOMY_NOTIFY_BIN = notifyScriptPath;

  try {
    await notifyInteractiveBlockedRecovery(state, 'Need operator guidance');
    const notifyLog = await readFile(notifyLogPath, 'utf8');
    assert.match(notifyLog, /interactive blocked recovery for scope 3: Need operator guidance/);
    assert.doesNotMatch(notifyLog, /: blocked:/);
  } finally {
    if (previousNotifyBin === undefined) {
      delete process.env.AUTONOMY_NOTIFY_BIN;
    } else {
      process.env.AUTONOMY_NOTIFY_BIN = previousNotifyBin;
    }
  }
});
