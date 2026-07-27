import process from 'node:process';

import { parseStatusArgs } from '../cli.js';
import { listRuns } from '../run-registry.js';
import {
  buildStatusListSnapshot,
  buildStatusSnapshot,
  renderHumanStatusListSnapshot,
  renderHumanStatusSnapshot,
} from '../status.js';
import { resolveCliRunStatePath } from './runtime.js';

export async function runStatusCommand(args: string[]) {
  const parsed = parseStatusArgs(args);
  if (parsed.all) {
    const snapshot = await buildStatusListSnapshot({ cwd: process.cwd() });
    if (parsed.json) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderHumanStatusListSnapshot(snapshot).trimEnd() + '\n');
    return;
  }

  if (!parsed.json && parsed.runId === null && (await listRuns(process.cwd())).length === 0) {
    process.stdout.write('No Neal runs found in this repository yet. Start one with: neal run <plan.md>\n');
    return;
  }

  const resolution = await resolveCliRunStatePath({
    runId: parsed.runId,
  });
  const snapshot = await buildStatusSnapshot({
    cwd: process.cwd(),
    statePath: resolution.statePath,
  });
  if (parsed.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderHumanStatusSnapshot(snapshot).trimEnd() + '\n');
}
