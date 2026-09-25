import process from 'node:process';

import { parseUsageArgs } from '../cli.js';
import {
  buildAllUsageSnapshot,
  buildRunUsageSnapshot,
  renderHumanAllUsage,
  renderHumanRunUsage,
} from '../usage.js';

export async function runUsageCommand(args: string[]) {
  const parsed = parseUsageArgs(args);

  if (parsed.all) {
    const snapshot = await buildAllUsageSnapshot({ cwd: process.cwd() });
    if (parsed.json) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderHumanAllUsage(snapshot).trimEnd() + '\n');
    return;
  }

  const snapshot = await buildRunUsageSnapshot({
    cwd: process.cwd(),
    runId: parsed.runId,
  });
  if (parsed.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }
  process.stdout.write(renderHumanRunUsage(snapshot).trimEnd() + '\n');
}
