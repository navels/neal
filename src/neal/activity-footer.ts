type FooterStream = {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
};

export type ActivityFooterState = {
  mode: string;
  activity: string;
  status: string;
  startedAt: number;
  subject?: string | null;
  now?: number;
};

type ActivityFooterOptions = {
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

export function renderActivityFooterLine(state: ActivityFooterState) {
  const subject = state.subject ? ` ${state.subject}` : '';
  const now = state.now ?? Date.now();
  return [
    `[neal] ${state.mode}${subject}`,
    `activity: ${state.activity}`,
    `elapsed: ${formatElapsed(now - state.startedAt)}`,
    `status: ${state.status}`,
  ].join(' | ');
}

export class ActivityFooter {
  private readonly stream: FooterStream;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly minRedrawIntervalMs: number;
  private readonly minColumns: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private redrawTimer: NodeJS.Timeout | null = null;
  private resizeListener: (() => void) | null = null;
  private currentLine = '';
  private footerVisible = false;
  private lastRedrawAt = 0;
  private state: ActivityFooterState | null = null;
  private disposed = false;

  constructor(options: ActivityFooterOptions = {}) {
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

  setState(state: ActivityFooterState) {
    if (this.disposed) {
      return;
    }

    this.state = state;
    this.currentLine = renderActivityFooterLine({
      ...state,
      now: this.now(),
    });
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

  private handleResize() {
    if (this.disposed) {
      return;
    }

    if (!this.canRender()) {
      this.clearFooter();
      return;
    }

    this.refresh(true);
  }

  private refresh(force = false) {
    if (!this.state || this.disposed) {
      return;
    }

    this.currentLine = renderActivityFooterLine({
      ...this.state,
      now: this.now(),
    });
    this.renderFooter(force);
  }

  private ensureRefreshTimer() {
    if (this.refreshTimer || this.disposed || this.refreshIntervalMs <= 0 || !this.isEnabled()) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  private canRender() {
    return (
      this.isEnabled() &&
      !this.disposed &&
      this.currentLine !== '' &&
      (this.stream.columns ?? 0) >= this.minColumns
    );
  }

  private renderFooter(force = false) {
    if (!this.canRender()) {
      this.clearFooter();
      return;
    }

    const elapsed = this.now() - this.lastRedrawAt;
    if (!force && elapsed < this.minRedrawIntervalMs) {
      if (!this.redrawTimer) {
        this.redrawTimer = setTimeout(() => {
          this.redrawTimer = null;
          this.renderFooter(true);
        }, this.minRedrawIntervalMs - elapsed);
        this.redrawTimer.unref?.();
      }
      return;
    }

    this.lastRedrawAt = this.now();
    const columns = this.stream.columns ?? this.currentLine.length;
    const line = truncateForColumns(this.currentLine, Math.max(0, columns - 1));
    this.stream.write(`\r\x1b[2K${line}`);
    this.footerVisible = true;
  }

  private clearFooter() {
    if (!this.footerVisible || !this.isEnabled()) {
      return;
    }
    this.stream.write('\r\x1b[2K');
    this.footerVisible = false;
  }
}
