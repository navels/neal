import { basename } from 'node:path';

import { EXECUTE_FINALIZATION_PHASE } from './execute-finalization.js';
import { formatPublicPhase } from './phase-display.js';
import { formatPublicRunStatus, getRunDisplayStatus } from './run-status.js';
import { getExecutionPlanPath, getExecutionPlanScopeCount, renderScopeProgressSegments } from './scopes.js';
import { getDerivedPlanView, getFinalCompletionView } from './state-views.js';
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
const FOOTER_ACTIVITY_LABELS = {
  coder_plan: 'planner planning',
  reviewer_plan: 'reviewer reviewing plan',
  coder_plan_response: 'planner revising plan',
  coder_plan_optional_response: 'planner optional plan follow-up',
  awaiting_derived_plan_execution: 'preparing derived plan',
  coder_scope: 'coder working',
  manual_gate: 'waiting for manual gate',
  reviewer_scope: 'reviewer reviewing',
  coder_response: 'coder revising',
  coder_optional_response: 'coder optional follow-up',
  interactive_blocked_recovery: 'waiting for guidance',
  [EXECUTE_FINALIZATION_PHASE]: 'finalizing scope',
  final_completion_review: 'reviewer final check',
  done: 'done',
  blocked: 'blocked',
} as const satisfies Record<OrchestrationState['phase'], string>;

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
  const displayStatus = getRunDisplayStatus(state);
  const segments = [`[neal] ${basename(state.planDoc)}`];

  if (state.topLevelMode !== 'plan') {
    const { scopeSegment, derivedSegment } = renderScopeProgressSegments(state, args.totalScopeCount);
    segments.push(scopeSegment);
    if (derivedSegment) {
      segments.push(derivedSegment);
    }
  }

  segments.push(`activity: ${formatFooterActivity(state)}`);
  segments.push(`elapsed: ${formatElapsed(now - args.phaseStartedAt)}`);
  segments.push(`status: ${formatPublicRunStatus(displayStatus)}`);

  if (displayStatus.effectiveStatus === 'waiting_for_manual_gate') {
    segments.push(`manual gate: ${state.manualGate?.id ?? 'unknown'}`);
    segments.push(`next: neal resume --run ${basename(state.runDir)}`);
  } else if (displayStatus.pendingOperatorGuidance) {
    segments.push('operator guidance: pending');
    segments.push(`next: neal resume --run ${basename(state.runDir)}`);
  } else if (displayStatus.waitingForOperatorGuidance) {
    segments.push('operator guidance: waiting');
    segments.push(`next: neal resume --run ${basename(state.runDir)} --message "..."`);
  }

  if (state.phase === 'reviewer_scope' || state.phase === 'reviewer_plan') {
    segments.push(`review round: ${state.rounds.length + 1}`);
  }

  const finalCompletion = getFinalCompletionView(state);
  if (finalCompletion?.activeReview) {
    segments.push('completion review');
  }

  const derivedPlan = getDerivedPlanView(state);
  if (derivedPlan && !derivedPlan.executing) {
    segments.push(`derived plan: ${derivedPlan.status ?? 'pending_review'}`);
  }

  return segments.join(' | ');
}

function formatFooterActivity(state: OrchestrationState) {
  if (state.status === 'paused') {
    return 'paused after scope';
  }

  return FOOTER_ACTIVITY_LABELS[state.phase] ?? formatPublicPhase(state.phase);
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

  replaceView(message: string) {
    if (!this.isEnabled() || this.disposed) {
      this.stream.write(message);
      return;
    }

    this.clearFooter();
    this.stream.write('\x1b[H\x1b[2J');
    if (message !== '') {
      this.stream.write(message);
    }
    this.renderFooter(true);
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

    let totalScopeCount: Awaited<ReturnType<typeof getExecutionPlanScopeCount>> = { kind: 'unavailable' };
    if (this.state.topLevelMode !== 'plan') {
      const executionPlanPath = getExecutionPlanPath(this.state);
      const cachedScopeCount = this.scopeCountCache.get(executionPlanPath);
      if (cachedScopeCount === undefined) {
        totalScopeCount = await getExecutionPlanScopeCount(executionPlanPath);
        this.scopeCountCache.set(executionPlanPath, totalScopeCount);
      } else {
        totalScopeCount = cachedScopeCount;
      }
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
