import process from 'node:process';

import { parseChangesArgs } from '../cli.js';
import {
  buildRunChangesSnapshot,
  renderHumanRunChanges,
} from '../changes.js';

export async function runChangesCommand(args: string[]) {
  const parsed = parseChangesArgs(args);
  const snapshot = await buildRunChangesSnapshot({
    cwd: process.cwd(),
    runId: parsed.runId,
  });

  if (parsed.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }

  process.stdout.write(renderHumanRunChanges(snapshot).trimEnd() + '\n');
}
