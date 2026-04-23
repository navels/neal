import { basename } from 'node:path';

import { getExecutionPlanPath, getExecutionPlanScopeCount, isExecutingDerivedPlan, renderScopeProgressSegments } from './scopes.js';
import type { OrchestrationState } from './types.js';

type FooterStream = {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
};

type FooterContext = {
  state: OrchestrationState;
  phaseStartedAt: number;
  totalScopeCount: Awaited<ReturnType<typeof getExecutionPlanScopeCount>>;
  now?: number;
};

type StatusFooterOptions = {
  stream?: FooterStream;
  now?: () => number;
  refreshIntervalMs?: number;
  minRedrawIntervalMs?: number;
  minColumns?: number;
};

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_MIN_REDRAW_INTERVAL_MS = 100;
const DEFAULT_MIN_COLUMNS = 60;

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function truncateForColumns(text: string, columns: number) {
  if (columns <= 0 || text.length <= columns) {
    return text;
  }

  if (columns <= 3) {
    return text.slice(0, columns);
  }

  return `${text.slice(0, columns - 3)}...`;
}

export function renderStatusFooterLine(args: FooterContext) {
  const now = args.now ?? Date.now();
  const state = args.state;
  const segments = [`[neal] ${basename(state.planDoc)}`];
  const { scopeSegment, derivedSegment } = renderScopeProgressSegments(state, args.totalScopeCount);
  segments.push(scopeSegment);
  if (derivedSegment) {
    segments.push(derivedSegment);
  }

  segments.push(`phase: ${state.phase}`);
  segments.push(`elapsed: ${formatElapsed(now - args.phaseStartedAt)}`);
  segments.push(`status: ${state.status}`);

  if (state.phase === 'reviewer_scope' || state.phase === 'reviewer_plan') {
    segments.push(`review round: ${state.rounds.length + 1}`);
  }

  if (state.phase === 'final_completion_review') {
    segments.push('completion review');
  }

  if (state.phase === 'reviewer_consult' || state.phase === 'coder_consult_response') {
    const consultRound = state.consultRounds.at(-1)?.number;
    if (consultRound) {
      segments.push(`consult: ${consultRound}`);
    }
  }

  if (state.derivedPlanPath && !isExecutingDerivedPlan(state)) {
    segments.push(`derived plan: ${state.derivedPlanStatus ?? 'pending_review'}`);
  }

  return segments.join(' | ');
}

export class StatusFooter {
  private readonly stream: FooterStream;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly minRedrawIntervalMs: number;
  private readonly minColumns: number;
  private readonly scopeCountCache = new Map<string, Awaited<ReturnType<typeof getExecutionPlanScopeCount>>>();
  private redrawTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private resizeListener: (() => void) | null = null;
  private currentLine = '';
  private footerVisible = false;
  private lastRedrawAt = 0;
  private state: OrchestrationState | null = null;
  private phaseStartedAt = 0;
  private disposed = false;

  constructor(options: StatusFooterOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.now = options.now ?? (() => Date.now());
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.minRedrawIntervalMs = options.minRedrawIntervalMs ?? DEFAULT_MIN_REDRAW_INTERVAL_MS;
    this.minColumns = options.minColumns ?? DEFAULT_MIN_COLUMNS;

    if (this.isEnabled() && this.stream === process.stderr) {
      this.resizeListener = () => {
        this.handleResize();
      };
      process.on('SIGWINCH', this.resizeListener);
    }
  }

  isEnabled() {
    return this.stream.isTTY === true;
  }

  async setState(state: OrchestrationState, phaseStartedAt: number) {
    if (this.disposed) {
      return;
    }

    this.state = state;
    this.phaseStartedAt = phaseStartedAt;
    this.currentLine = await this.buildFooterLine();
    this.ensureRefreshTimer();
    this.renderFooter(true);
  }

  write(message: string) {
    if (!this.isEnabled() || this.disposed) {
      this.stream.write(message);
      return;
    }

    this.clearFooter();
    this.stream.write(message);

    if (message.endsWith('\n') || message.endsWith('\r\n')) {
      this.renderFooter(true);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
      this.redrawTimer = null;
    }
    if (this.resizeListener) {
      process.off('SIGWINCH', this.resizeListener);
      this.resizeListener = null;
    }
    this.clearFooter();
  }

  handleResize() {
    if (this.disposed) {
      return;
    }

    if (!this.canRender()) {
      this.clearFooter();
      return;
    }

    void this.refresh(true);
  }

  private async buildFooterLine() {
    if (!this.state) {
      return '';
    }

    const executionPlanPath = getExecutionPlanPath(this.state);
    let totalScopeCount = this.scopeCountCache.get(executionPlanPath);
    if (totalScopeCount === undefined) {
      totalScopeCount = await getExecutionPlanScopeCount(executionPlanPath);
      this.scopeCountCache.set(executionPlanPath, totalScopeCount);
    }

    const line = renderStatusFooterLine({
      state: this.state,
      phaseStartedAt: this.phaseStartedAt,
      totalScopeCount,
      now: this.now(),
    });
    return truncateForColumns(line, this.stream.columns ?? 0);
  }

  private canRender() {
    return this.isEnabled() && (this.stream.columns ?? 0) >= this.minColumns;
  }

  private ensureRefreshTimer() {
    if (this.refreshTimer || this.refreshIntervalMs <= 0 || !this.isEnabled()) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  private async refresh(force = false) {
    if (!this.state || !this.canRender()) {
      return;
    }

    this.currentLine = await this.buildFooterLine();
    this.renderFooter(force);
  }

  private scheduleRedraw(delayMs: number) {
    if (this.redrawTimer) {
      return;
    }

    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = null;
      this.renderFooter(true);
    }, delayMs);
  }

  private renderFooter(force = false) {
    if (!this.currentLine || !this.canRender()) {
      return;
    }

    if (force && this.redrawTimer) {
      clearTimeout(this.redrawTimer);
      this.redrawTimer = null;
    }

    const now = this.now();
    const elapsedSinceRedraw = now - this.lastRedrawAt;
    if (!force && elapsedSinceRedraw < this.minRedrawIntervalMs) {
      this.scheduleRedraw(this.minRedrawIntervalMs - elapsedSinceRedraw);
      return;
    }

    this.stream.write(`\r\x1b[2K${this.currentLine}`);
    this.footerVisible = true;
    this.lastRedrawAt = now;
  }

  private clearFooter() {
    if (!this.footerVisible || !this.isEnabled()) {
      return;
    }

    this.stream.write('\r\x1b[2K');
    this.footerVisible = false;
  }
}
