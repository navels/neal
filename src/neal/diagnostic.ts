import type { RunLogger } from './logger.js';
import { StatusFooter } from './status-footer.js';

let statusFooter: StatusFooter | null = null;

export function configureDiagnosticFooter(footer: StatusFooter) {
  statusFooter?.dispose();
  statusFooter = footer;
}

export function clearDiagnosticFooter() {
  statusFooter?.dispose();
  statusFooter = null;
}

export function getDiagnosticFooter() {
  return statusFooter;
}

export function writeDiagnostic(message: string, logger?: RunLogger) {
  if (statusFooter) {
    statusFooter.write(message);
  } else {
    process.stderr.write(message);
  }

  void logger?.stderr(message);
}
