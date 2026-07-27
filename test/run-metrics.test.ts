import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderRunMetricsMarkdown, summarizeRunMetrics } from '../src/neal/run-metrics.js';
import { writeCheckpointRetrospective } from '../src/neal/retrospective.js';
import { RunLogger } from '../src/neal/logger.js';
import { createProviderTelemetrySink } from '../src/neal/providers/telemetry.js';
import type { ProviderRuntimeEvent } from '../src/neal/providers/types.js';
import { createInitialState, getDefaultAgentConfig } from '../src/neal/state.js';
import type { OrchestrationState } from '../src/neal/types.js';
import type { RunEvent } from '../src/neal/verification-events.js';

test('summarizeRunMetrics reports phase timing, command counts, provider turns, and usage', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'phase.start', { phase: 'coder_scope' }),
    event('2026-05-18T00:00:10.000Z', 'provider.turn_completed', {
      provider: 'openai-codex',
      role: 'coder',
      usage: { input_tokens: 10, output_tokens: 3 },
    }),
    event('2026-05-18T00:00:11.000Z', 'provider.usage_reported', {
      provider: 'openai-codex',
      role: 'coder',
      usage: { input_tokens: 10, output_tokens: 3 },
    }),
    event('2026-05-18T00:00:20.000Z', 'provider.command_completed', {
      provider: 'openai-codex',
      role: 'coder',
      command: 'pnpm typecheck',
      exitCode: 0,
      status: 'completed',
    }),
    event('2026-05-18T00:00:30.000Z', 'provider.command_completed', {
      provider: 'openai-codex',
      role: 'coder',
      command: 'rg missing',
      exitCode: 1,
      status: 'completed',
    }),
    event('2026-05-18T00:00:31.000Z', 'provider.tool_started', {
      provider: 'openai-codex',
      role: 'coder',
      toolName: 'exec_command',
    }),
    event('2026-05-18T00:00:32.000Z', 'provider.file_changed', {
      provider: 'openai-codex',
      role: 'coder',
      files: ['src/neal/run-metrics.ts'],
    }),
    event('2026-05-18T00:01:00.000Z', 'phase.complete', { phase: 'coder_scope' }),
    event('2026-05-18T00:01:00.000Z', 'phase.start', { phase: 'reviewer_scope' }),
    event('2026-05-18T00:02:00.000Z', 'provider.turn_completed', {
      provider: 'anthropic-claude',
      role: 'reviewer',
      label: 'final',
    }),
    event('2026-05-18T00:02:01.000Z', 'provider.usage_reported', {
      provider: 'anthropic-claude',
      role: 'reviewer',
      label: 'final',
      usage: { cache_read_input_tokens: 50, output_tokens: 7 },
    }),
    event('2026-05-18T00:03:00.000Z', 'phase.complete', { phase: 'reviewer_scope' }),
  ]);
  const markdown = renderRunMetricsMarkdown(metrics);

  assert.equal(metrics.observedDurationMs, 180_000);
  assert.equal(metrics.providerTurns, 2);
  assert.equal(metrics.commandCount, 2);
  assert.equal(metrics.nonZeroCommandCount, 1);
  assert.equal(metrics.resolvedNonZeroCommandCount, 0);
  assert.equal(metrics.unresolvedNonZeroCommandCount, 1);
  assert.equal(metrics.toolEventCount, 1);
  assert.equal(metrics.fileChangeEventCount, 1);
  assert.deepEqual(
    metrics.phases.map((phase) => ({
      phase: phase.phase,
      durationMs: phase.durationMs,
      providerTurns: phase.providerTurns,
      commandCount: phase.commandCount,
      nonZeroCommandCount: phase.nonZeroCommandCount,
      resolvedNonZeroCommandCount: phase.resolvedNonZeroCommandCount,
      unresolvedNonZeroCommandCount: phase.unresolvedNonZeroCommandCount,
      toolEventCount: phase.toolEventCount,
      fileChangeEventCount: phase.fileChangeEventCount,
    })),
    [
      {
        phase: 'coder_scope',
        durationMs: 60_000,
        providerTurns: 1,
        commandCount: 2,
        nonZeroCommandCount: 1,
        resolvedNonZeroCommandCount: 0,
        unresolvedNonZeroCommandCount: 1,
        toolEventCount: 1,
        fileChangeEventCount: 1,
      },
      {
        phase: 'reviewer_scope',
        durationMs: 120_000,
        providerTurns: 1,
        commandCount: 0,
        nonZeroCommandCount: 0,
        resolvedNonZeroCommandCount: 0,
        unresolvedNonZeroCommandCount: 0,
        toolEventCount: 0,
        fileChangeEventCount: 0,
      },
    ],
  );
  assert.equal(metrics.providers.find((provider) => provider.provider === 'openai-codex')?.usage.inputTokens, 10);
  assert.equal(metrics.providers.find((provider) => provider.provider === 'openai-codex')?.usage.outputTokens, 3);
  assert.equal(
    metrics.providers.find((provider) => provider.provider === 'anthropic-claude')?.usage.cacheReadInputTokens,
    50,
  );
  assert.match(markdown, /- Observed duration: 3m 00s/);
  assert.match(markdown, /\| implementing current scope \| 1m 00s \| 1 \| 2 \| 1 \| 1 \| 1 \|/);
  assert.match(markdown, /\| reviewing current scope \| 2m 00s \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(markdown, /\| openai-codex \/ coder \| 1 \| 10 \| - \| - \| - \| 3 \| - \| - \|/);
  assert.match(markdown, /\| anthropic-claude \/ reviewer:final \| 1 \| - \| - \| - \| 50 \| 7 \| - \| - \|/);
});

test('summarizeRunMetrics separates non-zero commands resolved by later passing reruns', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'phase.start', { phase: 'coder_scope' }),
    event('2026-05-18T00:00:10.000Z', 'provider.command_completed', {
      command: 'pnpm test',
      cwd: '/repo',
      exitCode: 1,
      status: 'failed',
    }),
    event('2026-05-18T00:00:20.000Z', 'provider.command_completed', {
      command: 'pnpm lint',
      cwd: '/repo',
      exitCode: 1,
      status: 'failed',
    }),
    event('2026-05-18T00:00:30.000Z', 'provider.command_completed', {
      command: 'pnpm test',
      cwd: '/repo',
      exitCode: 0,
      status: 'completed',
    }),
    event('2026-05-18T00:00:40.000Z', 'phase.complete', { phase: 'coder_scope' }),
  ]);
  const markdown = renderRunMetricsMarkdown(metrics);

  assert.equal(metrics.commandCount, 3);
  assert.equal(metrics.nonZeroCommandCount, 2);
  assert.equal(metrics.resolvedNonZeroCommandCount, 1);
  assert.equal(metrics.unresolvedNonZeroCommandCount, 1);
  assert.equal(metrics.phases[0]?.nonZeroCommandCount, 2);
  assert.equal(metrics.phases[0]?.resolvedNonZeroCommandCount, 1);
  assert.equal(metrics.phases[0]?.unresolvedNonZeroCommandCount, 1);
  assert.match(markdown, /- Commands: 3 total, 1 unresolved non-zero or failed, 1 resolved by later passing rerun/);
});

test('writeCheckpointRetrospective includes run metrics from events.ndjson', async (t) => {
  const fixture = await createRetrospectiveFixture([
    event('2026-05-18T00:00:00.000Z', 'phase.start', { phase: 'coder_scope' }),
    event('2026-05-18T00:01:00.000Z', 'provider.turn_completed', {
      provider: 'openai-codex',
      role: 'coder',
      usage: { input_tokens: 42, output_tokens: 9 },
    }),
    event('2026-05-18T00:01:10.000Z', 'provider.command_completed', {
      provider: 'openai-codex',
      role: 'coder',
      command: 'pnpm typecheck',
      exitCode: 0,
      status: 'completed',
    }),
    event('2026-05-18T00:02:00.000Z', 'phase.complete', { phase: 'coder_scope' }),
  ]);
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  const { archivedPath } = await writeCheckpointRetrospective(fixture.state, 'done');
  const retrospective = await readFile(archivedPath, 'utf8');

  assert.match(retrospective, /## Run Metrics/);
  assert.match(retrospective, /- Observed duration: 2m 00s/);
  assert.match(retrospective, /- Provider turns: 1/);
  assert.match(retrospective, /- Commands: 1 total, 0 non-zero or failed/);
  assert.match(retrospective, /### Phase Timing/);
  assert.match(retrospective, /### Provider Usage/);
  assert.match(retrospective, /\| openai-codex \/ coder \| 1 \| 42 \| - \| - \| - \| 9 \| - \| - \|/);
});

test('summarizeRunMetrics keeps run totals when phase boundaries are absent', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'provider.turn_completed', {
      provider: 'openai-codex',
      role: 'coder',
    }),
    event('2026-05-18T00:00:01.000Z', 'provider.command_completed', {
      provider: 'openai-codex',
      role: 'coder',
      command: 'pnpm build',
      exitCode: 0,
    }),
  ]);

  assert.equal(metrics.providerTurns, 1);
  assert.equal(metrics.commandCount, 1);
  assert.deepEqual(metrics.phases, []);
});

test('renderRunMetricsMarkdown marks incomplete phase durations as lower bounds', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'phase.start', { phase: 'coder_scope' }),
    event('2026-05-18T00:02:00.000Z', 'provider.command_completed', {
      provider: 'openai-codex',
      role: 'coder',
      command: 'pnpm test',
      exitCode: 0,
    }),
  ]);

  assert.equal(metrics.phases[0]?.durationMs, 120_000);
  assert.match(renderRunMetricsMarkdown(metrics), /\| implementing current scope \| >= 2m 00s \| 0 \| 1 \|/);
});

test('cost fields survive the telemetry serialization boundary into run metrics', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'neal-run-metrics-telemetry-'));
  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const logger = new RunLogger(runDir);
  const sink = createProviderTelemetrySink({
    logger,
    provider: 'openai-compatible',
    role: 'structured-advisor',
    cwd: runDir,
  });

  const costBearing: ProviderRuntimeEvent = {
    type: 'usage_reported',
    provider: 'openai-compatible',
    role: 'structured-advisor',
    usage: { input_tokens: 100, output_tokens: 20 },
    costUsd: 0.0042,
    costSource: 'rate',
  };
  const noCost: ProviderRuntimeEvent = {
    type: 'usage_reported',
    provider: 'openai-compatible',
    role: 'structured-advisor',
    usage: { input_tokens: 5, output_tokens: 1 },
  };

  await sink(costBearing);
  await sink(noCost);

  const raw = await readFile(join(runDir, 'events.ndjson'), 'utf8');
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);

  const metrics = summarizeRunMetrics(events);
  const bucket = metrics.providers.find((provider) => provider.provider === 'openai-compatible');
  assert.ok(bucket);
  // Both events land in one provider/role bucket; the numeric cost survived
  // writeRunEvent without being dropped or misnamed.
  assert.equal(bucket.costUsd, 0.0042);
  assert.equal(bucket.costSource, 'rate');

  // A run built only from the no-cost event yields a null-cost bucket, proving
  // absent cost fields stay omitted through serialization.
  const noCostRun = summarizeRunMetrics(events.filter((item) => (item.data?.costUsd ?? null) === null));
  const noCostBucket = noCostRun.providers.find((provider) => provider.provider === 'openai-compatible');
  assert.ok(noCostBucket);
  assert.equal(noCostBucket.costUsd, null);
  assert.equal(noCostBucket.costSource, null);
});

test('summarizeRunMetrics reports complete cost coverage when every usage-bearing bucket is priced', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'provider.usage_reported', {
      provider: 'openai-compatible',
      role: 'coder',
      usage: { input_tokens: 100, output_tokens: 20 },
      costUsd: 0.01,
      costSource: 'rate',
    }),
    event('2026-05-18T00:00:01.000Z', 'provider.usage_reported', {
      provider: 'anthropic-claude',
      role: 'reviewer',
      usage: { input_tokens: 200, output_tokens: 40 },
      costUsd: 0.05,
      costSource: 'provider',
    }),
  ]);

  assert.equal(metrics.costCoverage, 'complete');
  assert.ok(metrics.totalCostUsd !== null && Math.abs(metrics.totalCostUsd - 0.06) < 1e-9);
  const markdown = renderRunMetricsMarkdown(metrics);
  assert.match(markdown, /- Estimated cost: \$0\.0600/);
  assert.match(markdown, /\| Cost \|/);
});

test('summarizeRunMetrics reports partial cost coverage without presenting a subtotal as a full total', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'provider.usage_reported', {
      provider: 'openai-compatible',
      role: 'coder',
      usage: { input_tokens: 100, output_tokens: 20 },
      costUsd: 0.01,
      costSource: 'rate',
    }),
    event('2026-05-18T00:00:01.000Z', 'provider.usage_reported', {
      provider: 'openai-codex',
      role: 'reviewer',
      usage: { input_tokens: 200, output_tokens: 40 },
    }),
  ]);

  assert.equal(metrics.costCoverage, 'partial');
  assert.equal(metrics.totalCostUsd, 0.01);
  const markdown = renderRunMetricsMarkdown(metrics);
  assert.match(markdown, /- Estimated cost \(partial — 1 of 2 priced providers\): \$0\.0100/);
  // Rate-computed cells carry a footnote marker and the footnote line.
  assert.match(markdown, /\$0\.0100\*/);
  assert.match(markdown, /\\\* Cost estimated from published or configured rates, not reported by the provider\./);
});

test('summarizeRunMetrics reports no cost coverage when nothing is priced', () => {
  const metrics = summarizeRunMetrics([
    event('2026-05-18T00:00:00.000Z', 'provider.usage_reported', {
      provider: 'openai-codex',
      role: 'coder',
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  ]);

  assert.equal(metrics.costCoverage, 'none');
  assert.equal(metrics.totalCostUsd, null);
  const markdown = renderRunMetricsMarkdown(metrics);
  assert.match(markdown, /- Estimated cost: unknown/);
  // No rate cost present -> no footnote line (catches either wording).
  assert.doesNotMatch(markdown, /Cost estimated from/);
});

test('summarizeRunMetrics sums cost within a bucket, prefers provider source on mixed sources, and honors usage gating', () => {
  const metrics = summarizeRunMetrics([
    // Dedicated usage_reported events exist, so this turn_completed's cost and
    // usage must be ignored (existing gating) — its inflated cost must never
    // leak into the bucket total.
    event('2026-05-18T00:00:00.000Z', 'provider.turn_completed', {
      provider: 'openai-compatible',
      role: 'coder',
      label: 'scope',
      usage: { input_tokens: 999, output_tokens: 999 },
      costUsd: 999,
      costSource: 'rate',
    }),
    event('2026-05-18T00:00:01.000Z', 'provider.usage_reported', {
      provider: 'openai-compatible',
      role: 'coder',
      label: 'scope',
      usage: { input_tokens: 100, output_tokens: 20 },
      costUsd: 0.01,
      costSource: 'rate',
    }),
    event('2026-05-18T00:00:02.000Z', 'provider.usage_reported', {
      provider: 'openai-compatible',
      role: 'coder',
      label: 'scope',
      usage: { input_tokens: 50, output_tokens: 10 },
      costUsd: 0.05,
      costSource: 'provider',
    }),
  ]);

  const bucket = metrics.providers.find(
    (provider) => provider.provider === 'openai-compatible' && provider.label === 'scope',
  );
  assert.ok(bucket);
  // Both counted (usage_reported) costs are summed; the gated turn_completed
  // cost is excluded.
  assert.ok(bucket.costUsd !== null && Math.abs(bucket.costUsd - 0.06) < 1e-9);
  // A bucket that received both a rate and a provider cost resolves to
  // 'provider'.
  assert.equal(bucket.costSource, 'provider');
  // Usage stays aggregated from the dedicated usage_reported events only (the
  // turn_completed 999/999 usage is gated out): 100+50 input, 20+10 output.
  assert.equal(bucket.usage.inputTokens, 150);
  assert.equal(bucket.usage.outputTokens, 30);
  assert.equal(metrics.costCoverage, 'complete');
});

test('writeCheckpointRetrospective writes current and archived RUN_METRICS.json matching the returned summary', async (t) => {
  const fixture = await createRetrospectiveFixture([
    event('2026-05-18T00:00:00.000Z', 'phase.start', { phase: 'coder_scope' }),
    event('2026-05-18T00:01:00.000Z', 'provider.usage_reported', {
      provider: 'openai-compatible',
      role: 'coder',
      usage: { input_tokens: 100, output_tokens: 20 },
      costUsd: 0.0123,
      costSource: 'rate',
    }),
    event('2026-05-18T00:02:00.000Z', 'phase.complete', { phase: 'coder_scope' }),
  ]);
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  const result = await writeCheckpointRetrospective(fixture.state, 'done');
  const runDir = fixture.state.runDir;

  const expectedCurrent = join(runDir, 'RUN_METRICS.json');
  // kind 'done' with no finalCommit -> RUN_METRICS-final.json (mirrors the
  // archived retrospective naming convention).
  const expectedArchived = join(runDir, 'RUN_METRICS-final.json');
  assert.equal(result.currentMetricsPath, expectedCurrent);
  assert.equal(result.archivedMetricsPath, expectedArchived);

  const currentParsed = JSON.parse(await readFile(expectedCurrent, 'utf8'));
  const archivedParsed = JSON.parse(await readFile(expectedArchived, 'utf8'));
  const expected = summarizeRunMetrics(
    (await readFile(join(runDir, 'events.ndjson'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent),
  );

  assert.deepEqual(currentParsed, JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(archivedParsed, currentParsed);
  assert.equal(currentParsed.costCoverage, 'complete');
  assert.equal(currentParsed.totalCostUsd, 0.0123);
  const bucket = currentParsed.providers.find(
    (provider: { provider: string }) => provider.provider === 'openai-compatible',
  );
  assert.equal(bucket.costUsd, 0.0123);
  assert.equal(bucket.costSource, 'rate');
});

function event(ts: string, type: string, data: Record<string, unknown> = {}): RunEvent {
  return { ts, type, data };
}

async function createRetrospectiveFixture(events: RunEvent[]) {
  const root = await mkdtemp(join(tmpdir(), 'neal-run-metrics-'));
  const cwd = join(root, 'repo');
  const stateDir = join(cwd, '.neal');
  const runDir = join(stateDir, 'runs', 'test-run');
  const planDoc = join(cwd, 'PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, '# Plan\n', 'utf8');
  await writeFile(join(runDir, 'events.ndjson'), events.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');

  const initialState = await createInitialState(
    {
      cwd,
      planDoc,
      stateDir,
      runDir,
      topLevelMode: 'execute',
      allowedDirtyPaths: [],
      agentConfig: getDefaultAgentConfig(cwd),
      progressJsonPath: join(runDir, 'plan-progress.json'),
      progressMarkdownPath: join(runDir, 'PLAN_PROGRESS.md'),
      reviewMarkdownPath: join(runDir, 'REVIEW.md'),
      recoveryMarkdownPath: join(runDir, 'RECOVERY.md'),
      maxRounds: 3,
    },
    'base',
  );
  const state: OrchestrationState = {
    ...initialState,
    status: 'done',
    phase: 'done',
    finalCompletionSummary: {
      planGoalSatisfied: true,
      whatChangedOverall: 'Completed the requested work.',
      verificationSummary: 'pnpm typecheck passed.',
      remainingKnownGaps: [],
    },
  };

  return { root, state };
}
