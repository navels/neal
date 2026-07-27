import type { DiagnosticDetailContext } from './diagnostic.js';

export type ActivityUpdate = {
  activity: string;
  status?: string;
  subject?: string | null;
  detailContext?: DiagnosticDetailContext;
};

export type ActivityReporter = (update: ActivityUpdate) => void | Promise<void>;
