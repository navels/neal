import { existsSync } from 'node:fs';
import readline from 'node:readline';

import {
  clearDiagnosticFooter,
  getBufferedDetailSnapshot,
  isDiagnosticDetailVisible,
  showDiagnosticDetailView,
  showDiagnosticNarrativeView,
  writeNarrative,
  type DiagnosticDetailFilter,
} from './diagnostic.js';

type KeypressInput = {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: 'keypress', listener: (input: string, key: readline.Key) => void) => unknown;
  off: (event: 'keypress', listener: (input: string, key: readline.Key) => void) => unknown;
};

type InteractiveKeyControllerOptions = {
  input?: KeypressInput;
  stopRequestFile?: string;
  allowStopRequest?: boolean;
  emitKeypressEvents?: (input: NodeJS.ReadStream) => void;
  exit?: (code: number) => void;
  getDetailFilter?: () => DiagnosticDetailFilter;
};

export type InteractiveKeyController = {
  cleanup: () => void;
  isStopRequested: () => boolean;
};

export function renderInteractiveKeyHint(allowStopRequest: boolean) {
  return allowStopRequest
    ? '[neal] keys: q stop after current scope, v show/hide details\n'
    : '[neal] keys: v show/hide details\n';
}

export function createInteractiveKeyController(
  options: InteractiveKeyControllerOptions = {},
): InteractiveKeyController {
  let stopRequested = false;
  let cleanedUp = false;
  const input = options.input ?? process.stdin;
  const stopRequestFile = options.stopRequestFile ?? process.env.NEAL_STOP_AFTER_CURRENT_SCOPE_FILE;
  const allowStopRequest = options.allowStopRequest ?? true;

  if (!input.isTTY) {
    return {
      cleanup() {},
      isStopRequested() {
        return allowStopRequest && (stopRequested || hasStopRequestFile(stopRequestFile));
      },
    };
  }

  const emitKeypressEvents = options.emitKeypressEvents ?? readline.emitKeypressEvents;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  emitKeypressEvents(input as NodeJS.ReadStream);
  input.setRawMode?.(true);
  input.resume();

  const onKeypress = (_input: string, key: readline.Key) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      clearDiagnosticFooter();
      exit(130);
      return;
    }

    if (key.name === 'q' && allowStopRequest) {
      stopRequested = !stopRequested;
      writeNarrative(
        stopRequested
          ? '\n[neal] stop requested after the current scope\n'
          : '\n[neal] stop request cleared; continuing after the current scope\n',
      );
      return;
    }

    if (key.name === 'v') {
      toggleDetailVisibility(options.getDetailFilter?.() ?? {});
    }
  };

  input.on('keypress', onKeypress);

  function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    input.off('keypress', onKeypress);
    if (input.isTTY) {
      input.setRawMode?.(false);
    }
    input.pause();
  }

  return {
    cleanup,
    isStopRequested() {
      return allowStopRequest && (stopRequested || hasStopRequestFile(stopRequestFile));
    },
  };
}

function hasStopRequestFile(stopRequestFile: string | undefined) {
  return stopRequestFile ? existsSync(stopRequestFile) : false;
}

function toggleDetailVisibility(filter: DiagnosticDetailFilter) {
  if (isDiagnosticDetailVisible()) {
    showDiagnosticNarrativeView();
    return;
  }

  showDiagnosticDetailView(selectDetailReplayFilter(filter));
}

function selectDetailReplayFilter(filter: DiagnosticDetailFilter): DiagnosticDetailFilter {
  if (!filter.runId) {
    return filter;
  }

  const preferredFilter = {
    runId: filter.runId,
    phase: filter.phase,
    scopeLabel: filter.scopeLabel,
    scopeNumber: filter.scopeNumber,
  };
  const preferredSnapshot = getBufferedDetailSnapshot(preferredFilter);
  if (preferredSnapshot.entries.length > 0) {
    return preferredFilter;
  }

  return { runId: filter.runId };
}
