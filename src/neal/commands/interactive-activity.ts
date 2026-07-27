import { Writable } from 'node:stream';

import { ActivityFooter, type ActivityFooterState } from '../activity-footer.js';
import {
  clearDiagnosticFooter,
  configureDiagnosticFooter,
  resetDiagnosticDetailState,
  setDiagnosticDetailContext,
  writeNarrative,
  type DiagnosticDetailContext,
} from '../diagnostic.js';
import { createInteractiveKeyController, renderInteractiveKeyHint } from '../interactive-controls.js';
import type { ActivityReporter } from '../activity-reporting.js';

type InteractiveActivityOptions = {
  mode: string;
  initialActivity: string;
  subject?: string | null;
  status?: string;
};

type InteractiveActivityContext = {
  stderr: NodeJS.WritableStream;
  reportActivity: ActivityReporter;
};

export async function withInteractiveActivity<T>(
  options: InteractiveActivityOptions,
  action: (context: InteractiveActivityContext) => Promise<T>,
): Promise<T> {
  let detailContext: DiagnosticDetailContext = {};
  resetDiagnosticDetailState(detailContext);

  const footer = new ActivityFooter();
  configureDiagnosticFooter(footer);

  let state: ActivityFooterState = {
    mode: options.mode,
    activity: options.initialActivity,
    status: options.status ?? 'running',
    subject: options.subject,
    startedAt: Date.now(),
  };
  footer.setState(state);

  const controller = createInteractiveKeyController({
    allowStopRequest: false,
    getDetailFilter() {
      return detailContext;
    },
  });

  const reportActivity: ActivityReporter = async (update) => {
    detailContext = update.detailContext ?? detailContext;
    setDiagnosticDetailContext(detailContext);
    state = {
      ...state,
      activity: update.activity,
      status: update.status ?? state.status,
      subject: update.subject === undefined ? state.subject : update.subject,
    };
    footer.setState(state);
  };

  try {
    if (process.stdin.isTTY) {
      writeNarrative(renderInteractiveKeyHint(false));
    }

    return await action({
      stderr: createNarrativeWritable(),
      reportActivity,
    });
  } finally {
    controller.cleanup();
    clearDiagnosticFooter();
    resetDiagnosticDetailState();
  }
}

function createNarrativeWritable(): NodeJS.WritableStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      writeNarrative(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
      callback();
    },
  });
}
