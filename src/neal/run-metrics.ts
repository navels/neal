import { formatMaybePublicPhase } from './phase-display.js';
import type { RunEvent } from './verification-events.js';

export type RunUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type RunMetricProviderSummary = {
  provider: string;
  role: string;
  label: string | null;
  turns: number;
  usage: RunUsageTotals;
  // Running sum of cost for this provider/role bucket. Stays null until at least
  // one counted event carried a numeric cost, so a genuine 0 stays
  // distinguishable from "no cost reported".
  costUsd: number | null;
  // 'provider' when the provider reported cost directly (Claude), 'rate' when
  // cost was rate-computed from token counts, null when no cost was reported.
  costSource: 'provider' | 'rate' | null;
};

export type RunMetricPhaseSummary = {
  phase: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  providerTurns: number;
  commandCount: number;
  nonZeroCommandCount: number;
  resolvedNonZeroCommandCount: number;
  unresolvedNonZeroCommandCount: number;
  toolEventCount: number;
  fileChangeEventCount: number;
};

export type RunMetricsSummary = {
  observedStartedAt: string | null;
  observedCompletedAt: string | null;
  observedDurationMs: number | null;
  providerTurns: number;
  commandCount: number;
  nonZeroCommandCount: number;
  resolvedNonZeroCommandCount: number;
  unresolvedNonZeroCommandCount: number;
  toolEventCount: number;
  fileChangeEventCount: number;
  phases: RunMetricPhaseSummary[];
  providers: RunMetricProviderSummary[];
  // Sum of the cost of every provider bucket that reported cost, or null when no
  // usage-bearing bucket reported cost. Always accompanied by costCoverage so a
  // consumer can distinguish a partial subtotal from a complete run total.
  totalCostUsd: number | null;
  // 'complete' when every usage-bearing bucket reported cost, 'partial' when
  // some but not all did, 'none' when none did.
  costCoverage: 'complete' | 'partial' | 'none';
};

type MutablePhaseSummary = RunMetricPhaseSummary & {
  startIndex: number;
  endIndex: number | null;
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

function validIso(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function timeMs(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addUsage(target: RunUsageTotals, value: unknown) {
  if (!isRecord(value)) {
    return;
  }

  target.inputTokens += numberValue(value.input_tokens) + numberValue(value.inputTokens);
  target.cachedInputTokens += numberValue(value.cached_input_tokens) + numberValue(value.cachedInputTokens);
  target.cacheCreationInputTokens +=
    numberValue(value.cache_creation_input_tokens) + numberValue(value.cacheCreationInputTokens);
  target.cacheReadInputTokens += numberValue(value.cache_read_input_tokens) + numberValue(value.cacheReadInputTokens);
  target.outputTokens += numberValue(value.output_tokens) + numberValue(value.outputTokens);
  target.reasoningOutputTokens +=
    numberValue(value.reasoning_output_tokens) + numberValue(value.reasoningOutputTokens);
  target.totalTokens += numberValue(value.total_tokens) + numberValue(value.totalTokens);
}

function hasUsage(usage: RunUsageTotals) {
  return Object.values(usage).some((value) => value > 0);
}

// Accumulate cost from one counted event into the provider bucket. Presence is
// tracked separately from value: costUsd stays null until an event carries a
// numeric costUsd, then it holds the running sum. A single provider/role bucket
// has one source; if both appear, 'provider' wins.
function accumulateCost(bucket: RunMetricProviderSummary, data: Record<string, unknown>) {
  const raw = data.costUsd;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return;
  }
  bucket.costUsd = (bucket.costUsd ?? 0) + raw;
  const source = data.costSource;
  if (source === 'provider' || source === 'rate') {
    bucket.costSource = bucket.costSource === 'provider' || source === 'provider' ? 'provider' : 'rate';
  }
}

function cloneEmptyUsage(): RunUsageTotals {
  return { ...EMPTY_USAGE };
}

function usageSortValue(summary: RunMetricProviderSummary) {
  const usage = summary.usage;
  return (
    usage.inputTokens +
    usage.cachedInputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens +
    usage.outputTokens +
    usage.reasoningOutputTokens +
    usage.totalTokens
  );
}

function providerKey(data: Record<string, unknown>) {
  const provider = stringValue(data.provider) ?? 'unknown';
  const role = stringValue(data.role) ?? 'unknown';
  const label = stringValue(data.label);
  return {
    provider,
    role,
    label,
    key: `${provider}\0${role}\0${label ?? ''}`,
  };
}

function commandIsNonZero(event: RunEvent) {
  const exitCode = event.data?.exitCode;
  if (typeof exitCode === 'number') {
    return exitCode !== 0;
  }
  return event.data?.status === 'failed';
}

function commandIsSuccess(event: RunEvent) {
  return event.data?.exitCode === 0;
}

function commandKey(event: RunEvent) {
  const command = stringValue(event.data?.command);
  if (!command) {
    return null;
  }
  const cwd = stringValue(event.data?.cwd) ?? '';
  return `${cwd}\0${command}`;
}

function findResolvedNonZeroCommandIndexes(items: Array<{ event: RunEvent; index: number }>) {
  const successfulCommands = new Set<string>();
  const resolvedIndexes = new Set<number>();

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.event.type !== 'provider.command_completed') {
      continue;
    }
    const key = commandKey(item.event);
    if (!key) {
      continue;
    }
    if (commandIsSuccess(item.event)) {
      successfulCommands.add(key);
      continue;
    }
    if (commandIsNonZero(item.event) && successfulCommands.has(key)) {
      resolvedIndexes.add(item.index);
    }
  }

  return resolvedIndexes;
}

function createPhase(event: RunEvent, index: number): MutablePhaseSummary | null {
  const phase = stringValue(event.data?.phase);
  if (!phase) {
    return null;
  }
  return {
    phase,
    startedAt: validIso(event.ts),
    completedAt: null,
    durationMs: null,
    providerTurns: 0,
    commandCount: 0,
    nonZeroCommandCount: 0,
    resolvedNonZeroCommandCount: 0,
    unresolvedNonZeroCommandCount: 0,
    toolEventCount: 0,
    fileChangeEventCount: 0,
    startIndex: index,
    endIndex: null,
  };
}

function completePhase(phase: MutablePhaseSummary, event: RunEvent, index: number) {
  phase.completedAt = validIso(event.ts);
  phase.endIndex = index;
  const start = timeMs(phase.startedAt);
  const end = timeMs(phase.completedAt);
  phase.durationMs = start !== null && end !== null && end >= start ? end - start : null;
}

function findOpenPhase(phases: MutablePhaseSummary[], phaseName: string) {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (phase?.phase === phaseName && phase.endIndex === null) {
      return phase;
    }
  }
  return null;
}

function phaseForEvent(phases: MutablePhaseSummary[], eventIndex: number) {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (!phase || phase.startIndex > eventIndex) {
      continue;
    }
    if (phase.endIndex === null || phase.endIndex >= eventIndex) {
      return phase;
    }
  }
  return null;
}

export function summarizeRunMetrics(events: RunEvent[]): RunMetricsSummary {
  const normalizedEvents = events
    .map((event, index) => ({ event, index, ts: validIso(event.ts) }))
    .filter((item) => item.ts !== null);
  const hasDedicatedUsageEvents = normalizedEvents.some((item) => item.event.type === 'provider.usage_reported');
  const firstTimestamp = normalizedEvents[0]?.ts ?? null;
  const lastTimestamp = normalizedEvents.at(-1)?.ts ?? null;
  const firstTime = timeMs(firstTimestamp);
  const lastTime = timeMs(lastTimestamp);
  const phases: MutablePhaseSummary[] = [];
  const providers = new Map<string, RunMetricProviderSummary>();
  let providerTurns = 0;
  let commandCount = 0;
  let nonZeroCommandCount = 0;
  let resolvedNonZeroCommandCount = 0;
  let unresolvedNonZeroCommandCount = 0;
  let toolEventCount = 0;
  let fileChangeEventCount = 0;
  const resolvedNonZeroCommandIndexes = findResolvedNonZeroCommandIndexes(normalizedEvents);

  for (const { event, index } of normalizedEvents) {
    if (event.type === 'phase.start') {
      const phase = createPhase(event, index);
      if (phase) {
        phases.push(phase);
      }
    } else if (event.type === 'phase.complete') {
      const phaseName = stringValue(event.data?.phase);
      const phase = phaseName ? findOpenPhase(phases, phaseName) : null;
      if (phase) {
        completePhase(phase, event, index);
      }
    }
  }

  for (const { event, index } of normalizedEvents) {
    const phase = phaseForEvent(phases, index);
    if (event.type === 'provider.turn_completed') {
      providerTurns += 1;
      if (phase) {
        phase.providerTurns += 1;
      }
      const data = event.data ?? {};
      const identity = providerKey(data);
      const existing = providers.get(identity.key) ?? {
        provider: identity.provider,
        role: identity.role,
        label: identity.label,
        turns: 0,
        usage: cloneEmptyUsage(),
        costUsd: null,
        costSource: null,
      };
      existing.turns += 1;
      if (!hasDedicatedUsageEvents) {
        addUsage(existing.usage, data.usage);
        accumulateCost(existing, data);
      }
      providers.set(identity.key, existing);
    } else if (event.type === 'provider.usage_reported') {
      const data = event.data ?? {};
      const identity = providerKey(data);
      const existing = providers.get(identity.key) ?? {
        provider: identity.provider,
        role: identity.role,
        label: identity.label,
        turns: 0,
        usage: cloneEmptyUsage(),
        costUsd: null,
        costSource: null,
      };
      addUsage(existing.usage, data.usage);
      accumulateCost(existing, data);
      providers.set(identity.key, existing);
    } else if (event.type === 'provider.command_completed') {
      commandCount += 1;
      if (commandIsNonZero(event)) {
        nonZeroCommandCount += 1;
        if (resolvedNonZeroCommandIndexes.has(index)) {
          resolvedNonZeroCommandCount += 1;
        } else {
          unresolvedNonZeroCommandCount += 1;
        }
      }
      if (phase) {
        phase.commandCount += 1;
        if (commandIsNonZero(event)) {
          phase.nonZeroCommandCount += 1;
          if (resolvedNonZeroCommandIndexes.has(index)) {
            phase.resolvedNonZeroCommandCount += 1;
          } else {
            phase.unresolvedNonZeroCommandCount += 1;
          }
        }
      }
    } else if (event.type === 'provider.tool_started' || event.type === 'provider.tool_progress') {
      toolEventCount += 1;
      if (phase) {
        phase.toolEventCount += 1;
      }
    } else if (event.type === 'provider.file_changed') {
      fileChangeEventCount += 1;
      if (phase) {
        phase.fileChangeEventCount += 1;
      }
    }
  }

  for (const phase of phases) {
    if (phase.durationMs !== null || phase.endIndex !== null) {
      continue;
    }
    const start = timeMs(phase.startedAt);
    const end = timeMs(lastTimestamp);
    phase.durationMs = start !== null && end !== null && end >= start ? end - start : null;
  }

  const publicPhases = phases.map(({ startIndex: _startIndex, endIndex: _endIndex, ...phase }) => phase);

  const providerSummaries = [...providers.values()].sort((left, right) => {
    const turns = right.turns - left.turns;
    if (turns !== 0) {
      return turns;
    }
    return usageSortValue(right) - usageSortValue(left);
  });

  // Coverage is computed only over usage-bearing buckets so a partial subtotal
  // never masquerades as a complete run total.
  const usageBearing = providerSummaries.filter((provider) => hasUsage(provider.usage));
  const pricedUsageBearing = usageBearing.filter((provider) => provider.costUsd !== null);
  const costCoverage: RunMetricsSummary['costCoverage'] =
    pricedUsageBearing.length === 0
      ? 'none'
      : pricedUsageBearing.length === usageBearing.length
        ? 'complete'
        : 'partial';
  const totalCostUsd =
    costCoverage === 'none'
      ? null
      : providerSummaries.reduce((sum, provider) => (provider.costUsd !== null ? sum + provider.costUsd : sum), 0);

  return {
    observedStartedAt: firstTimestamp,
    observedCompletedAt: lastTimestamp,
    observedDurationMs: firstTime !== null && lastTime !== null && lastTime >= firstTime ? lastTime - firstTime : null,
    providerTurns,
    commandCount,
    nonZeroCommandCount,
    resolvedNonZeroCommandCount,
    unresolvedNonZeroCommandCount,
    toolEventCount,
    fileChangeEventCount,
    phases: publicPhases,
    providers: providerSummaries,
    totalCostUsd,
    costCoverage,
  };
}

function formatDuration(value: number | null) {
  if (value === null) {
    return 'unknown';
  }
  const totalSeconds = Math.max(0, Math.round(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatNumber(value: number) {
  return value === 0 ? '0' : value.toLocaleString('en-US');
}

function formatPhaseName(phase: string) {
  return formatMaybePublicPhase(phase) ?? phase;
}

function formatPhaseDuration(phase: RunMetricPhaseSummary) {
  const formatted = formatDuration(phase.durationMs);
  return phase.completedAt || phase.durationMs === null ? formatted : `>= ${formatted}`;
}

function formatProviderName(summary: RunMetricProviderSummary) {
  const label = summary.label ? `:${summary.label}` : '';
  return `${summary.provider} / ${summary.role}${label}`;
}

function usageCell(value: number) {
  return value > 0 ? formatNumber(value) : '-';
}

function formatCostAmount(value: number) {
  return `$${value.toFixed(4)}`;
}

// Cost cell for the Provider Usage table: '-' when the bucket reported no cost,
// otherwise the fixed-precision USD amount with a footnote marker on
// rate-computed cells.
function formatCost(value: number | null, source: 'provider' | 'rate' | null) {
  if (value === null) {
    return '-';
  }
  return source === 'rate' ? `${formatCostAmount(value)}*` : formatCostAmount(value);
}

// The top-summary cost line, labeled by coverage so a partial subtotal is never
// presented as a complete run total.
function formatEstimatedCostLine(metrics: RunMetricsSummary) {
  if (metrics.costCoverage === 'none' || metrics.totalCostUsd === null) {
    return '- Estimated cost: unknown';
  }
  if (metrics.costCoverage === 'partial') {
    const usageBearing = metrics.providers.filter((provider) => hasUsage(provider.usage));
    const priced = usageBearing.filter((provider) => provider.costUsd !== null);
    return `- Estimated cost (partial — ${priced.length} of ${usageBearing.length} priced providers): ${formatCostAmount(metrics.totalCostUsd)}`;
  }
  return `- Estimated cost: ${formatCostAmount(metrics.totalCostUsd)}`;
}

export function renderRunMetricsMarkdown(metrics: RunMetricsSummary) {
  const commandSummary = metrics.resolvedNonZeroCommandCount > 0
    ? `- Commands: ${metrics.commandCount} total, ${metrics.unresolvedNonZeroCommandCount} unresolved non-zero or failed, ${metrics.resolvedNonZeroCommandCount} resolved by later passing rerun`
    : `- Commands: ${metrics.commandCount} total, ${metrics.nonZeroCommandCount} non-zero or failed`;
  const lines = [
    `- Observed duration: ${formatDuration(metrics.observedDurationMs)}`,
    `- Provider turns: ${metrics.providerTurns}`,
    commandSummary,
    `- Tool events: ${metrics.toolEventCount}`,
    `- File change events: ${metrics.fileChangeEventCount}`,
    formatEstimatedCostLine(metrics),
  ];

  if (metrics.phases.length > 0) {
    lines.push(
      '',
      '### Phase Timing',
      '',
      '| Phase | Duration | Provider turns | Commands | Non-zero commands | Tool events | File changes |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...metrics.phases.map(
        (phase) =>
          `| ${formatPhaseName(phase.phase)} | ${formatPhaseDuration(phase)} | ${phase.providerTurns} | ${phase.commandCount} | ${phase.nonZeroCommandCount} | ${phase.toolEventCount} | ${phase.fileChangeEventCount} |`,
      ),
    );
  }

  const providersWithUsage = metrics.providers.filter((provider) => provider.turns > 0 || hasUsage(provider.usage));
  if (providersWithUsage.length > 0) {
    lines.push(
      '',
      '### Provider Usage',
      '',
      '| Provider / role | Turns | Input | Cached input | Cache created | Cache read | Output | Reasoning output | Total | Cost |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...providersWithUsage.map((provider) => {
        const usage = provider.usage;
        return `| ${formatProviderName(provider)} | ${provider.turns} | ${usageCell(usage.inputTokens)} | ${usageCell(usage.cachedInputTokens)} | ${usageCell(usage.cacheCreationInputTokens)} | ${usageCell(usage.cacheReadInputTokens)} | ${usageCell(usage.outputTokens)} | ${usageCell(usage.reasoningOutputTokens)} | ${usageCell(usage.totalTokens)} | ${formatCost(provider.costUsd, provider.costSource)} |`;
      }),
    );
    if (providersWithUsage.some((provider) => provider.costUsd !== null && provider.costSource === 'rate')) {
      lines.push('', '\\* Cost estimated from published or configured rates, not reported by the provider.');
    }
  } else {
    lines.push('', '### Provider Usage', '', '- No provider usage events recorded.');
  }

  return lines.join('\n');
}
