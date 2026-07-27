import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORTED_NEAL_ACTION_TYPES,
  isSupportedNealActionType,
  validateSuggestedNealAction,
  type NealContextPack,
  type SuggestedNealAction,
} from '../src/neal/context/shared.js';

test('shared context contracts expose bounded metadata and command-free suggestions', () => {
  assert.equal(isSupportedNealActionType('recover'), true);
  assert.equal(isSupportedNealActionType('shell_command'), false);
  assert.equal(SUPPORTED_NEAL_ACTION_TYPES.includes('inspect_artifact'), true);

  const suggestion = {
    type: 'recover',
    label: 'Recover selected run',
    target: {
      runDirName: '2026-04-25T18-00-00.000Z-test',
      statePath: '.neal/runs/2026-04-25T18-00-00.000Z-test/RUN_STATE.json',
    },
    rationale: 'The selected run is blocked.',
  } satisfies SuggestedNealAction;

  assert.equal(suggestion.type, 'recover');
  assert.equal(Object.hasOwn(suggestion, 'command'), false);

  const pack = emptyContextPack({
    artifacts: [
      {
        label: 'RUN_STATE.json',
        kind: 'state',
        content: '{}',
        byteLength: 2,
        truncated: false,
        omitted: false,
        omissionReason: null,
      },
    ],
    citations: [{ label: 'RUN_STATE.json', kind: 'state' }],
    limits: {
      perArtifactByteLimit: 1024,
      totalByteLimit: 4096,
      totalArtifactBytes: 2,
      truncatedArtifactCount: 0,
      omittedArtifactCount: 0,
    },
  });

  assert.equal(pack.artifacts[0].label, 'RUN_STATE.json');
  assert.equal(pack.limits.totalArtifactBytes, 2);
});

test('shared suggestion validation accepts explicit public targets only', () => {
  const runAction = validateSuggestedNealAction({
    type: 'pause_after_scope',
    label: 'Pause selected run after this scope',
    target: {
      runDirName: '2026-04-25T18-00-00.000Z-test',
    },
  });

  assert.equal(runAction.type, 'pause_after_scope');
  assert.equal(runAction.target.runDirName, '2026-04-25T18-00-00.000Z-test');

  const planAction = validateSuggestedNealAction({
    type: 'start_execution',
    label: 'Execute reviewed plan',
    target: {
      planPath: 'plans/PLAN.md',
    },
  });

  assert.equal(planAction.type, 'start_execution');
  assert.equal(planAction.target.planPath, 'plans/PLAN.md');
});

test('shared suggestion validation rejects implicit, malformed, and command targets', () => {
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'resume',
      label: 'Resume',
      target: {},
    }),
    /runDirName or exact statePath/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'recover',
      label: 'Recover latest',
      target: { runDirName: 'latest' },
    }),
    /explicit run directory/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'resume',
      label: 'Resume current',
      target: { runDirName: 'current' },
    }),
    /explicit run directory/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'recover',
      label: 'Recover current pointer',
      target: { statePath: 'current' },
    }),
    /implicit run pointer/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'recover',
      label: 'Recover current pointer file',
      target: { statePath: '.neal/current.json' },
    }),
    /exact RUN_STATE\.json/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'start_execution',
      label: 'Start',
      target: { runDirName: '2026-04-25T18-00-00.000Z-test' },
    }),
    /planPath/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'resume',
      label: 'Resume selected run',
      target: { runDirName: '2026-04-25T18-00-00.000Z-test', unsupportedTarget: 'stale' },
    }),
    /unsupported target field "unsupportedTarget"/,
  );
  assert.throws(
    () => validateSuggestedNealAction({
      type: 'recover',
      label: 'Run shell',
      target: { runDirName: '2026-04-25T18-00-00.000Z-test', command: 'rm -rf .' },
    }),
    /forbidden command payload/,
  );
});

function emptyContextPack(overrides: Partial<NealContextPack> = {}): NealContextPack {
  return {
    version: 1,
    createdAt: '2026-04-25T18:15:52.082Z',
    cwd: '/tmp/project',
    state: null,
    artifacts: [],
    citations: [],
    suggestedActions: [],
    limits: {
      perArtifactByteLimit: 1024,
      totalByteLimit: 4096,
      totalArtifactBytes: 0,
      truncatedArtifactCount: 0,
      omittedArtifactCount: 0,
    },
    warnings: [],
    ...overrides,
  };
}
