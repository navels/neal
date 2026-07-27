import type { RunLogger } from './logger.js';
import { StatusFooter } from './status-footer.js';

type DiagnosticFooter = Pick<StatusFooter, 'write' | 'dispose'> &
  Partial<Pick<StatusFooter, 'isEnabled' | 'replaceView'>>;
type DiagnosticTerminalView = 'narrative' | 'detail';

export type DiagnosticDetailContext = {
  runId?: string;
  phase?: string;
  scopeLabel?: string;
  scopeNumber?: string | number;
  provider?: string;
  role?: string;
  commandSummary?: string;
  fileCount?: number;
  timestamp?: string;
};

export type BufferedDetailEntry = {
  message: string;
  context: DiagnosticDetailContext & { timestamp: string };
  bytes: number;
};

export type BufferedNarrativeEntry = {
  message: string;
  timestamp: string;
  bytes: number;
};

type BufferSnapshot<TEntry> = {
  entries: TEntry[];
  droppedEntries: number;
  droppedBytes: number;
};

type DetailBufferSnapshot = BufferSnapshot<BufferedDetailEntry>;
type NarrativeBufferSnapshot = BufferSnapshot<BufferedNarrativeEntry>;

export type DiagnosticDetailFilter = {
  runId?: string;
  phase?: string;
  scopeLabel?: string;
  scopeNumber?: string | number;
};

const DETAIL_BUFFER_ENTRY_LIMIT = 400;
const DETAIL_BUFFER_BYTE_LIMIT = 128 * 1024;
const NARRATIVE_BUFFER_ENTRY_LIMIT = 400;
const NARRATIVE_BUFFER_BYTE_LIMIT = 128 * 1024;

let statusFooter: DiagnosticFooter | null = null;
let activeView: DiagnosticTerminalView = 'narrative';
let activeDetailContext: DiagnosticDetailContext = {};
let bufferedNarrativeEntries: BufferedNarrativeEntry[] = [];
let bufferedNarrativeBytes = 0;
let droppedNarrativeEntries = 0;
let droppedNarrativeBytes = 0;
let bufferedDetailEntries: BufferedDetailEntry[] = [];
let bufferedDetailBytes = 0;
let droppedDetailEntries = 0;
let droppedDetailBytes = 0;

export function configureDiagnosticFooter(footer: DiagnosticFooter) {
  statusFooter?.dispose();
  statusFooter = footer;
}

export function clearDiagnosticFooter() {
  statusFooter?.dispose();
  statusFooter = null;
}

export function setDiagnosticDetailContext(context: DiagnosticDetailContext) {
  activeDetailContext = {
    ...activeDetailContext,
    ...context,
  };
}

export function resetDiagnosticDetailState(context: DiagnosticDetailContext = {}) {
  activeView = 'narrative';
  activeDetailContext = { ...context };
  bufferedNarrativeEntries = [];
  bufferedNarrativeBytes = 0;
  droppedNarrativeEntries = 0;
  droppedNarrativeBytes = 0;
  bufferedDetailEntries = [];
  bufferedDetailBytes = 0;
  droppedDetailEntries = 0;
  droppedDetailBytes = 0;
}

export function setDiagnosticDetailVisibility(visible: boolean) {
  activeView = visible ? 'detail' : 'narrative';
}

export function isDiagnosticDetailVisible() {
  return activeView === 'detail';
}

export function getBufferedNarrativeSnapshot(): NarrativeBufferSnapshot {
  return {
    entries: [...bufferedNarrativeEntries],
    droppedEntries: droppedNarrativeEntries,
    droppedBytes: droppedNarrativeBytes,
  };
}

export function getBufferedDetailSnapshot(filter: DiagnosticDetailFilter = {}): DetailBufferSnapshot {
  return {
    entries: bufferedDetailEntries.filter((entry) => matchesDetailFilter(entry.context, filter)),
    droppedEntries: droppedDetailEntries,
    droppedBytes: droppedDetailBytes,
  };
}

export function writeBufferedDetail(filter: DiagnosticDetailFilter = {}) {
  const transcript = renderDetailTranscript(filter);
  if (transcript !== '') {
    writeTerminalDiagnostic(transcript);
  }
}

export function showDiagnosticDetailView(filter: DiagnosticDetailFilter = {}) {
  activeView = 'detail';
  const transcript = renderDetailTranscript(filter);
  if (canReplaceManagedView()) {
    statusFooter!.replaceView!(transcript);
    return;
  }

  if (transcript !== '') {
    writeTerminalDiagnostic(transcript);
  }
}

export function showDiagnosticNarrativeView() {
  activeView = 'narrative';
  if (canReplaceManagedView()) {
    statusFooter!.replaceView!(renderNarrativeTranscript());
  }
}

export function writeNarrative(message: string, logger?: RunLogger) {
  bufferNarrative(message);
  if (activeView === 'narrative' || !isManagedDiagnosticView()) {
    writeTerminalDiagnostic(message);
  }

  void logger?.stderr(message);
}

export function writeDetail(message: string, logger?: RunLogger, context: DiagnosticDetailContext = {}) {
  bufferDetail(message, context);
  if (activeView === 'detail') {
    writeTerminalDiagnostic(message);
  }

  void logger?.stderr(message);
}

export function writeErrorDetail(message: string, logger?: RunLogger, context: DiagnosticDetailContext = {}) {
  writeDetail(message, logger, context);
}

export function writeDiagnostic(message: string, logger?: RunLogger) {
  writeNarrative(message, logger);
}

export function resetDiagnosticStateForTests() {
  clearDiagnosticFooter();
  resetDiagnosticDetailState();
}

function writeTerminalDiagnostic(message: string) {
  if (statusFooter) {
    statusFooter.write(message);
  } else {
    process.stderr.write(message);
  }
}

function isManagedDiagnosticView() {
  return statusFooter?.isEnabled?.() === true;
}

function canReplaceManagedView() {
  return isManagedDiagnosticView() && typeof statusFooter?.replaceView === 'function';
}

function renderNarrativeTranscript() {
  const snapshot = getBufferedNarrativeSnapshot();
  const transcript: string[] = [];
  if (snapshot.droppedEntries > 0 || snapshot.droppedBytes > 0) {
    transcript.push(
      `[neal] earlier narrative omitted from buffer (${snapshot.droppedEntries} entries, ${snapshot.droppedBytes} bytes)\n`,
    );
  }

  for (const entry of snapshot.entries) {
    transcript.push(entry.message);
  }

  return transcript.join('');
}

function renderDetailTranscript(filter: DiagnosticDetailFilter) {
  const snapshot = getBufferedDetailSnapshot(filter);
  const transcript: string[] = [];
  if (snapshot.droppedEntries > 0 || snapshot.droppedBytes > 0) {
    transcript.push(
      `[neal:detail] earlier detail omitted from buffer (${snapshot.droppedEntries} entries, ${snapshot.droppedBytes} bytes)\n`,
    );
  }

  for (const entry of snapshot.entries) {
    transcript.push(entry.message);
  }

  return transcript.join('');
}

function bufferNarrative(message: string) {
  const entry = {
    message,
    timestamp: new Date().toISOString(),
    bytes: Buffer.byteLength(message, 'utf8'),
  };

  bufferedNarrativeEntries.push(entry);
  bufferedNarrativeBytes += entry.bytes;
  trimNarrativeBuffer();
}

function trimNarrativeBuffer() {
  while (
    bufferedNarrativeEntries.length > NARRATIVE_BUFFER_ENTRY_LIMIT ||
    bufferedNarrativeBytes > NARRATIVE_BUFFER_BYTE_LIMIT
  ) {
    const [dropped] = bufferedNarrativeEntries.splice(0, 1);
    if (!dropped) {
      return;
    }
    bufferedNarrativeBytes -= dropped.bytes;
    droppedNarrativeEntries += 1;
    droppedNarrativeBytes += dropped.bytes;
  }
}

function bufferDetail(message: string, context: DiagnosticDetailContext) {
  const entryContext = {
    ...activeDetailContext,
    ...context,
    timestamp: context.timestamp ?? activeDetailContext.timestamp ?? new Date().toISOString(),
  };
  const entry = {
    message,
    context: entryContext,
    bytes: Buffer.byteLength(message, 'utf8'),
  };

  bufferedDetailEntries.push(entry);
  bufferedDetailBytes += entry.bytes;
  trimDetailBuffer();
}

function trimDetailBuffer() {
  while (
    bufferedDetailEntries.length > DETAIL_BUFFER_ENTRY_LIMIT ||
    bufferedDetailBytes > DETAIL_BUFFER_BYTE_LIMIT
  ) {
    const [dropped] = bufferedDetailEntries.splice(0, 1);
    if (!dropped) {
      return;
    }
    bufferedDetailBytes -= dropped.bytes;
    droppedDetailEntries += 1;
    droppedDetailBytes += dropped.bytes;
  }
}

function matchesDetailFilter(context: DiagnosticDetailContext, filter: DiagnosticDetailFilter) {
  if (filter.runId !== undefined && context.runId !== filter.runId) {
    return false;
  }
  if (filter.phase !== undefined && context.phase !== filter.phase) {
    return false;
  }
  if (filter.scopeLabel !== undefined && context.scopeLabel !== filter.scopeLabel) {
    return false;
  }
  if (filter.scopeNumber !== undefined && String(context.scopeNumber) !== String(filter.scopeNumber)) {
    return false;
  }

  return true;
}
