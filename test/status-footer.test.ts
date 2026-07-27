import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderStatusFooterLine, StatusFooter } from '../src/neal/status-footer.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';

class FakeStream {
  isTTY: boolean;
  columns: number;
  writes: string[] = [];

  constructor(options: { isTTY: boolean; columns?: number }) {
    this.isTTY = options.isTTY;
    this.columns = options.columns ?? 120;
  }

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
}

async function createState(overrides: Partial<OrchestrationState> = {}, planContent?: string) {
  const root = await mkdtemp(join(tmpdir(), 'neal-status-footer-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');

  await mkdir(runDir, { recursive: true });
  await writeFile(
    planDoc,
    planContent ??
      `# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: First
- Goal: Do one thing.
- Verification: \`pnpm typecheck\`
- Success Condition: First scope completes.

### Scope 2: Second
- Goal: Do the next thing.
- Verification: \`pnpm typecheck\`
- Success Condition: Second scope completes.
`,
    'utf8',
  );

  const state = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'abc123',
  );

  return {
    state: {
      ...state,
      ...overrides,
    },
  };
}

test('renderStatusFooterLine shows scope totals when knowable', async () => {
  const { state } = await createState({
    currentScopeNumber: 2,
    phase: 'reviewer_scope',
    status: 'running',
    rounds: [],
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 2 },
    now: 125_000,
  });

  assert.match(line, /\[neal\] PLAN\.md/);
  assert.match(line, /scope 2\/2/);
  assert.match(line, /activity: reviewer reviewing/);
  assert.match(line, /elapsed: 02:05/);
  assert.match(line, /status: running/);
  assert.match(line, /review round: 1/);
});

test('renderStatusFooterLine shows derived execution context separately from the parent scope label', async () => {
  const { state } = await createState({
    currentScopeNumber: 5,
    phase: 'coder_scope',
    status: 'running',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 5,
    derivedScopeIndex: 2,
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 3 },
    now: 30_000,
  });

  assert.match(line, /scope 5\.2/);
  assert.match(line, /derived 2\/3/);
  assert.doesNotMatch(line, /scope 5\.2\/3/);
});

test('renderStatusFooterLine distinguishes non-executing derived-plan states', async () => {
  for (const derivedPlanStatus of ['pending_review', 'accepted', 'rejected'] as const) {
    const { state } = await createState({
      currentScopeNumber: 5,
      phase: derivedPlanStatus === 'accepted' ? 'awaiting_derived_plan_execution' : 'reviewer_plan',
      status: derivedPlanStatus === 'rejected' ? 'blocked' : 'running',
      derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_5.md',
      derivedPlanStatus,
      derivedFromScopeNumber: 5,
      derivedScopeIndex: null,
    });

    const line = renderStatusFooterLine({
      state,
      phaseStartedAt: 0,
      totalScopeCount: { kind: 'known', total: 3 },
      now: 30_000,
    });

    assert.match(line, new RegExp(`derived plan: ${derivedPlanStatus}`));
    assert.doesNotMatch(line, /derived \d/);
  }
});

test('renderStatusFooterLine omits unknown totals for recurring unknown-total plans', async () => {
  const { state } = await createState({
    currentScopeNumber: 2,
    phase: 'coder_scope',
    status: 'running',
    executionShape: 'multi_scope_unknown',
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'unknown_by_contract' },
    now: 15_000,
  });

  assert.match(line, /scope 2\b/);
  assert.doesNotMatch(line, /scope 2\//);
});

test('renderStatusFooterLine uses observer activity labels instead of raw phase names', async () => {
  const { state } = await createState({
    currentScopeNumber: 2,
    phase: 'coder_scope',
    status: 'running',
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 2 },
    now: 15_000,
  });

  assert.match(line, /activity: coder working/);
  assert.doesNotMatch(line, /coder_scope/);
  assert.doesNotMatch(line, /implementing current scope/);
});

test('renderStatusFooterLine omits derived unknown totals for recurring derived plans', async () => {
  const { state } = await createState({
    currentScopeNumber: 7,
    phase: 'coder_scope',
    status: 'running',
    executionShape: 'multi_scope_unknown',
    derivedPlanPath: '/tmp/DERIVED_PLAN_SCOPE_7.md',
    derivedPlanStatus: 'accepted',
    derivedFromScopeNumber: 7,
    derivedScopeIndex: 3,
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'unknown_by_contract' },
    now: 15_000,
  });

  assert.match(line, /scope 7\.3/);
  assert.match(line, /derived 3\b/);
  assert.doesNotMatch(line, /scope 7\.3\/\?/);
  assert.doesNotMatch(line, /derived 3\/\?/);
});

test('renderStatusFooterLine shows waiting interactive recovery as waiting for guidance', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-25T18:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 1,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-25T18:01:00.000Z',
          operatorGuidance: 'Stay blocked.',
          disposition: null,
        },
      ],
    },
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 4 },
    now: 15_000,
  });

  assert.match(line, /status: waiting_for_guidance/);
  assert.match(line, /operator guidance: waiting/);
  assert.match(line, /next: neal resume --run .* --message "\.\.\."/);
});

test('renderStatusFooterLine shows manual gate waits with plain resume next action', async () => {
  const { state } = await createState({
    phase: 'manual_gate',
    status: 'running',
    manualGate: {
      id: 'approval',
      title: 'Approve deployment',
      reason: 'External approval is required.',
      instructionsPath: '/tmp/GATE-approval.md',
      resumeChecks: [
        {
          type: 'command',
          name: 'approval file',
          command: ['test', '-f', 'approved.txt'],
        },
      ],
      resumePhase: 'coder_scope',
      createdAt: '2026-04-25T18:00:00.000Z',
      updatedAt: '2026-04-25T18:00:00.000Z',
      lastCheckedAt: null,
      lastFailure: null,
    },
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 2 },
    now: 1_000,
  });

  assert.match(line, /activity: waiting for manual gate/);
  assert.match(line, /status: waiting_for_manual_gate/);
  assert.match(line, /manual gate: approval/);
  assert.match(line, /next: neal resume --run test-run/);
  assert.doesNotMatch(line, /operator guidance/);
});

test('renderStatusFooterLine shows pending interactive recovery as resumable running work', async () => {
  const { state } = await createState({
    currentScopeNumber: 4,
    phase: 'interactive_blocked_recovery',
    status: 'running',
    interactiveBlockedRecovery: {
      enteredAt: '2026-04-25T18:00:00.000Z',
      sourcePhase: 'coder_scope',
      blockedReason: 'Need operator guidance.',
      maxTurns: 3,
      lastHandledTurn: 0,
      pendingDirective: null,
      turns: [
        {
          number: 1,
          recordedAt: '2026-04-25T18:01:00.000Z',
          operatorGuidance: 'Resume with this constraint.',
          disposition: null,
        },
      ],
    },
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 4 },
    now: 15_000,
  });

  assert.match(line, /status: running/);
  assert.match(line, /operator guidance: pending/);
  assert.match(line, /next: neal resume --run /);
  assert.doesNotMatch(line, /waiting_for_operator/);
});

test('renderStatusFooterLine omits scope progress for plan refinement runs', async () => {
  const { state } = await createState({
    topLevelMode: 'plan',
    currentScopeNumber: 1,
    phase: 'reviewer_plan',
    status: 'running',
    executionShape: 'one_shot',
    rounds: [],
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'known', total: 1 },
    now: 15_000,
  });

  assert.match(line, /\[neal\] PLAN\.md/);
  assert.doesNotMatch(line, /\bscope 1(?:\/1)?\b/);
  assert.match(line, /activity: reviewer reviewing plan/);
  assert.match(line, /status: running/);
  assert.match(line, /review round: 1/);
});

test('renderStatusFooterLine labels planning authoring as planner activity', async () => {
  const { state } = await createState({
    topLevelMode: 'plan',
    phase: 'coder_plan',
    status: 'running',
    executionShape: null,
  });

  const line = renderStatusFooterLine({
    state,
    phaseStartedAt: 0,
    totalScopeCount: { kind: 'unknown_by_contract' },
    now: 15_000,
  });

  assert.match(line, /activity: planner planning/);
  assert.doesNotMatch(line, /coder planning/);
});

test('StatusFooter is disabled when the diagnostic stream is not a TTY', async () => {
  const { state } = await createState();
  const stream = new FakeStream({ isTTY: false });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
  });

  await footer.setState(state, Date.now());
  footer.write('[neal] plain line\n');

  assert.deepEqual(stream.writes, ['[neal] plain line\n']);
});

test('StatusFooter clears and redraws around ordinary log writes in TTY mode', async () => {
  const { state } = await createState();
  const stream = new FakeStream({ isTTY: true, columns: 120 });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 10_000,
  });

  await footer.setState(state, 0);
  footer.write('[neal] ordinary log line\n');

  assert.ok(stream.writes.length >= 4);
  assert.match(stream.writes[0] ?? '', /\r\x1b\[2K\[neal\] PLAN\.md/);
  assert.equal(stream.writes[1], '\r\x1b[2K');
  assert.equal(stream.writes[2], '[neal] ordinary log line\n');
  assert.match(stream.writes[3] ?? '', /\r\x1b\[2K\[neal\] PLAN\.md/);
});

test('StatusFooter replaces the managed TTY view and redraws the footer', async () => {
  const { state } = await createState();
  const stream = new FakeStream({ isTTY: true, columns: 120 });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 10_000,
  });

  await footer.setState(state, 0);
  stream.writes = [];

  footer.replaceView('restored narrative\n');

  assert.equal(stream.writes[0], '\r\x1b[2K');
  assert.equal(stream.writes[1], '\x1b[H\x1b[2J');
  assert.equal(stream.writes[2], 'restored narrative\n');
  assert.match(stream.writes[3] ?? '', /\r\x1b\[2K\[neal\] PLAN\.md/);
  assert.doesNotMatch(stream.writes.join(''), /\x1b\[3J/);
});

test('StatusFooter replaceView stays append-only when the diagnostic stream is not a TTY', async () => {
  const { state } = await createState();
  const stream = new FakeStream({ isTTY: false });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
  });

  await footer.setState(state, Date.now());
  footer.replaceView('plain replacement\n');

  assert.deepEqual(stream.writes, ['plain replacement\n']);
  assert.doesNotMatch(stream.writes.join(''), /\x1b\[[0-9;]*[A-Za-z]/);
});

test('StatusFooter omits totals when the current execution plan total is not knowable', async () => {
  const { state } = await createState(
    {
      currentScopeNumber: 3,
      phase: 'coder_scope',
      status: 'running',
    },
    '# Example Plan\n\n## Execution Shape\n\nexecutionShape: multi_scope\n',
  );
  const stream = new FakeStream({ isTTY: true, columns: 120 });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 5_000,
  });

  await footer.setState(state, 0);

  assert.equal(stream.writes.length, 1);
  assert.match(stream.writes[0] ?? '', /scope 3\b/);
  assert.doesNotMatch(stream.writes[0] ?? '', /scope 3\//);
});

test('StatusFooter clears the footer when the terminal narrows below the minimum width', async () => {
  const { state } = await createState();
  const stream = new FakeStream({ isTTY: true, columns: 120 });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    minColumns: 80,
    now: () => 5_000,
  });

  await footer.setState(state, 0);
  stream.writes = [];
  stream.columns = 40;
  footer.handleResize();

  assert.deepEqual(stream.writes, ['\r\x1b[2K']);
});

test('StatusFooter dispose clears the footer and suppresses future redraws', async () => {
  const { state } = await createState();
  const stream = new FakeStream({ isTTY: true, columns: 120 });
  const footer = new StatusFooter({
    stream,
    refreshIntervalMs: 0,
    minRedrawIntervalMs: 0,
    now: () => 5_000,
  });

  await footer.setState(state, 0);
  stream.writes = [];

  footer.dispose();
  footer.write('[neal] ordinary log line after dispose\n');
  await footer.setState(state, 0);

  assert.deepEqual(stream.writes, ['\r\x1b[2K', '[neal] ordinary log line after dispose\n']);
});
