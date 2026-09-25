import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { listRuns, resolveRunStatePath } from './run-registry.js';
import {
  summarizeRunMetrics,
  type RunMetricProviderSummary,
  type RunMetricsSummary,
  type RunUsageTotals,
} from './run-metrics.js';
import { loadState } from './state.js';
import type { AgentConfig, OrchestrationState } from './types.js';
import type { RunEvent } from './verification-events.js';

export type UsageCostCoverage = 'complete' | 'partial' | 'none';

export type UsageAggregateProviderSummary = {
  provider: string;
  role: string;
  label: string | null;
  turns: number;
  usage: RunUsageTotals;
  costUsd: number | null;
  costSource: 'provider' | 'rate' | 'mixed' | null;
  costCoverage: UsageCostCoverage;
  pricedUsageSegments: number;
  usageSegments: number;
};

export type UsageAggregateSummary = {
  providers: UsageAggregateProviderSummary[];
  totalCostUsd: number | null;
  costCoverage: UsageCostCoverage;
  pricedUsageSegments: number;
  usageSegments: number;
};

export type NealRunUsageSnapshot = {
  ok: true;
  scope: 'run';
  cwd: string;
  runId: string;
  runDir: string;
  planDoc: string;
  topLevelMode: OrchestrationState['topLevelMode'];
  status: OrchestrationState['status'];
  phase: OrchestrationState['phase'];
  agentConfig: AgentConfig;
  events: {
    path: string;
    parsedLines: number;
    malformedLines: number;
  };
  metrics: RunMetricsSummary;
};

export type NealAllUsageSnapshot = {
  ok: true;
  scope: 'all';
  cwd: string;
  runCount: number;
  runs: NealRunUsageSnapshot[];
  totals: UsageAggregateSummary;
};

const EMPTY_USAGE: RunUsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

function hasUsage(usage: RunUsageTotals) {
  return Object.values(usage).some((value) => value > 0);
}

function addUsage(target: RunUsageTotals, source: RunUsageTotals) {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
}

type UsageMetricsInput = {
  metrics: RunMetricsSummary;
  agentConfig?: AgentConfig | null;
};

function configuredRolesForProvider(agentConfig: AgentConfig | null | undefined, provider: string) {
  if (!agentConfig) {
    return [];
  }
  return (['planner', 'coder', 'reviewer'] as const).filter(
    (role) => agentConfig[role].provider === provider,
  );
}

function semanticRole(
  provider: RunMetricProviderSummary,
  agentConfig: AgentConfig | null | undefined,
) {
  const label = provider.label?.trim() ?? '';
  if (/^Planner\b/i.test(label)) {
    return 'planner';
  }
  if (/^Coder\b/i.test(label)) {
    return 'coder';
  }
  if (label === 'plan-review') {
    return 'reviewer:plan';
  }
  if (label === 'review') {
    return 'reviewer:scope';
  }

  const configured = configuredRolesForProvider(agentConfig, provider.provider);
  if (label === 'final-completion') {
    if (configured.length === 1 && configured[0] === 'reviewer') {
      return 'reviewer:final';
    }
    if (configured.length === 1 && configured[0] === 'coder') {
      return 'coder:final';
    }
  }

  if (configured.length === 1) {
    return configured[0];
  }

  return provider.label ? `${provider.role}:${provider.label}` : provider.role;
}

function aggregateProviderKey(provider: RunMetricProviderSummary, role: string) {
  return `${provider.provider}\0${role}`;
}

function mergeCostSource(
  current: UsageAggregateProviderSummary['costSource'],
  next: RunMetricProviderSummary['costSource'],
): UsageAggregateProviderSummary['costSource'] {
  if (next === null) {
    return current;
  }
  if (current === null || current === next) {
    return next;
  }
  return 'mixed';
}

function coverage(priced: number, total: number): UsageCostCoverage {
  if (priced === 0) {
    return 'none';
  }
  return priced === total ? 'complete' : 'partial';
}

export function aggregateUsageMetrics(inputs: UsageMetricsInput[]): UsageAggregateSummary {
  const buckets = new Map<string, UsageAggregateProviderSummary>();
  let totalCost = 0;
  let hasCost = false;
  let usageSegments = 0;
  let pricedUsageSegments = 0;

  for (const input of inputs) {
    for (const provider of input.metrics.providers) {
      const role = semanticRole(provider, input.agentConfig);
      const key = aggregateProviderKey(provider, role);
      const existing = buckets.get(key) ?? {
        provider: provider.provider,
        role,
        label: null,
        turns: 0,
        usage: { ...EMPTY_USAGE },
        costUsd: null,
        costSource: null,
        costCoverage: 'none' as const,
        pricedUsageSegments: 0,
        usageSegments: 0,
      };

      existing.turns += provider.turns;
      addUsage(existing.usage, provider.usage);
      existing.costSource = mergeCostSource(existing.costSource, provider.costSource);

      if (hasUsage(provider.usage)) {
        existing.usageSegments += 1;
        usageSegments += 1;
        if (provider.costUsd !== null) {
          existing.pricedUsageSegments += 1;
          pricedUsageSegments += 1;
        }
      }

      if (provider.costUsd !== null) {
        existing.costUsd = (existing.costUsd ?? 0) + provider.costUsd;
        totalCost += provider.costUsd;
        hasCost = true;
      }

      existing.costCoverage = coverage(existing.pricedUsageSegments, existing.usageSegments);
      buckets.set(key, existing);
    }
  }

  const roleOrder = new Map<string, number>([
    ['planner', 0],
    ['coder', 1],
    ['coder:final', 2],
    ['reviewer:plan', 3],
    ['reviewer:scope', 4],
    ['reviewer:final', 5],
  ]);

  const providers = [...buckets.values()].sort((left, right) => {
    const leftRank = roleOrder.get(left.role) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = roleOrder.get(right.role) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    const roleComparison = left.role.localeCompare(right.role);
    if (roleComparison !== 0) {
      return roleComparison;
    }
    const providerComparison = left.provider.localeCompare(right.provider);
    if (providerComparison !== 0) {
      return providerComparison;
    }
    return right.turns - left.turns;
  });

  return {
    providers,
    totalCostUsd: hasCost ? totalCost : null,
    costCoverage: coverage(pricedUsageSegments, usageSegments),
    pricedUsageSegments,
    usageSegments,
  };
}

async function readRunEvents(runDir: string) {
  const path = join(runDir, 'events.ndjson');
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, events: [] as RunEvent[], parsedLines: 0, malformedLines: 0 };
    }
    throw error;
  }

  const events: RunEvent[] = [];
  let malformedLines = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as RunEvent);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { path, events, parsedLines: events.length, malformedLines };
}

async function buildRunSnapshotFromStatePath(cwd: string, statePath: string): Promise<NealRunUsageSnapshot> {
  const state = await loadState(statePath);
  const loaded = await readRunEvents(state.runDir);
  return {
    ok: true,
    scope: 'run',
    cwd: resolve(cwd),
    runId: basename(state.runDir),
    runDir: state.runDir,
    planDoc: state.planDoc,
    topLevelMode: state.topLevelMode,
    status: state.status,
    phase: state.phase,
    agentConfig: state.agentConfig,
    events: {
      path: loaded.path,
      parsedLines: loaded.parsedLines,
      malformedLines: loaded.malformedLines,
    },
    metrics: summarizeRunMetrics(loaded.events),
  };
}

export async function buildRunUsageSnapshot(args: {
  cwd: string;
  runId?: string | null;
}): Promise<NealRunUsageSnapshot> {
  const resolution = await resolveRunStatePath({
    cwd: args.cwd,
    runId: args.runId ?? null,
  });
  return buildRunSnapshotFromStatePath(args.cwd, resolution.statePath);
}

export async function buildAllUsageSnapshot(args: {
  cwd: string;
}): Promise<NealAllUsageSnapshot> {
  const cwd = resolve(args.cwd);
  const runs = await listRuns(cwd);
  const snapshots = await Promise.all(
    runs.map((run) => buildRunSnapshotFromStatePath(cwd, run.statePath)),
  );
  return {
    ok: true,
    scope: 'all',
    cwd,
    runCount: snapshots.length,
    runs: snapshots,
    totals: aggregateUsageMetrics(
      snapshots.map((snapshot) => ({
        metrics: snapshot.metrics,
        agentConfig: snapshot.agentConfig,
      })),
    ),
  };
}

function formatNumber(value: number) {
  return value === 0 ? '-' : value.toLocaleString('en-US');
}

function formatCost(
  value: number | null,
  source: UsageAggregateProviderSummary['costSource'],
  coverageValue: UsageCostCoverage,
) {
  if (value === null) {
    return '-';
  }
  const suffix = source === 'rate' ? '*' : source === 'mixed' ? '†' : '';
  const partial = coverageValue === 'partial' ? ' partial' : '';
  return `$${value.toFixed(4)}${suffix}${partial}`;
}

type TableColumn = {
  header: string;
  align: 'left' | 'right';
  value: (provider: UsageAggregateProviderSummary) => string;
};

function padCell(value: string, width: number, align: TableColumn['align']) {
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

function renderTable(providers: UsageAggregateProviderSummary[]) {
  if (providers.length === 0) {
    return ['No provider usage events recorded.'];
  }

  const columns: TableColumn[] = [
    { header: 'Provider', align: 'left', value: (provider) => provider.provider },
    { header: 'Role', align: 'left', value: (provider) => provider.role },
    { header: 'Turns', align: 'right', value: (provider) => formatNumber(provider.turns) },
    { header: 'Input', align: 'right', value: (provider) => formatNumber(provider.usage.inputTokens) },
    {
      header: 'Cache hit',
      align: 'right',
      value: (provider) =>
        formatNumber(provider.usage.cachedInputTokens + provider.usage.cacheReadInputTokens),
    },
    {
      header: 'Cache write',
      align: 'right',
      value: (provider) => formatNumber(provider.usage.cacheCreationInputTokens),
    },
    { header: 'Output', align: 'right', value: (provider) => formatNumber(provider.usage.outputTokens) },
    {
      header: 'Reasoning',
      align: 'right',
      value: (provider) => formatNumber(provider.usage.reasoningOutputTokens),
    },
    {
      header: 'Cost telemetry',
      align: 'right',
      value: (provider) => formatCost(provider.costUsd, provider.costSource, provider.costCoverage),
    },
  ];

  const rows = providers.map((provider) => columns.map((column) => column.value(provider)));
  const widths = columns.map((column, columnIndex) =>
    Math.max(
      column.header.length,
      ...rows.map((row) => row[columnIndex]?.length ?? 0),
    ),
  );
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  const header = columns
    .map((column, index) => padCell(column.header, widths[index] ?? 0, column.align))
    .join('  ');
  const body = rows.map((row) =>
    row
      .map((value, index) =>
        padCell(value ?? '', widths[index] ?? 0, columns[index]?.align ?? 'left'),
      )
      .join('  '),
  );

  return [header, separator, ...body];
}

function renderCostSummary(summary: UsageAggregateSummary) {
  if (summary.totalCostUsd === null || summary.costCoverage === 'none') {
    return 'Cost telemetry: unavailable';
  }
  if (summary.costCoverage === 'partial') {
    return `Cost telemetry: $${summary.totalCostUsd.toFixed(4)} (partial: available for ${summary.pricedUsageSegments}/${summary.usageSegments} usage buckets)`;
  }
  return `Cost telemetry: $${summary.totalCostUsd.toFixed(4)}`;
}

function displayPath(cwd: string, path: string) {
  if (!isAbsolute(path)) {
    return path;
  }
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

export function renderHumanRunUsage(snapshot: NealRunUsageSnapshot) {
  const aggregate = aggregateUsageMetrics([
    { metrics: snapshot.metrics, agentConfig: snapshot.agentConfig },
  ]);
  const lines = [
    '# Neal Usage',
    '',
    `Run: ${snapshot.runId}`,
    `Plan: ${displayPath(snapshot.cwd, snapshot.planDoc)}`,
    `Mode: ${snapshot.topLevelMode}`,
    `Status: ${snapshot.status} / ${snapshot.phase}`,
    renderCostSummary(aggregate),
    '',
    ...renderTable(aggregate.providers),
  ];

  if (aggregate.providers.some((provider) => provider.costSource === 'rate' || provider.costSource === 'mixed')) {
    lines.push('', '* Rate-estimated telemetry from published or configured token rates; provider billing remains authoritative.');
  }
  if (aggregate.providers.some((provider) => provider.costSource === 'mixed')) {
    lines.push('† Mixed provider-reported and rate-estimated telemetry sources.');
  }
  lines.push(
    '',
    'Note: Cost telemetry is not account billing; subscription quotas and charges remain provider-side. Input/cache fields follow each provider\'s reported semantics, so cache hits are not directly comparable across providers.',
  );
  if (snapshot.events.malformedLines > 0) {
    lines.push('', `Warning: ignored ${snapshot.events.malformedLines} malformed events.ndjson line(s).`);
  }

  return lines.join('\n');
}

export function renderHumanAllUsage(snapshot: NealAllUsageSnapshot) {
  const lines = [
    '# Neal Usage',
    '',
    `Runs: ${snapshot.runCount}`,
    renderCostSummary(snapshot.totals),
    '',
    ...renderTable(snapshot.totals.providers),
  ];

  if (snapshot.totals.providers.some((provider) => provider.costSource === 'rate' || provider.costSource === 'mixed')) {
    lines.push('', '* Rate-estimated telemetry from published or configured token rates; provider billing remains authoritative.');
  }
  if (snapshot.totals.providers.some((provider) => provider.costSource === 'mixed')) {
    lines.push('† Mixed provider-reported and rate-estimated telemetry sources.');
  }
  lines.push(
    '',
    'Note: Cost telemetry is not account billing; subscription quotas and charges remain provider-side. Input/cache fields follow each provider\'s reported semantics, so cache hits are not directly comparable across providers.',
  );
  const malformed = snapshot.runs.reduce((sum, run) => sum + run.events.malformedLines, 0);
  if (malformed > 0) {
    lines.push('', `Warning: ignored ${malformed} malformed events.ndjson line(s) across selected runs.`);
  }

  return lines.join('\n');
}
