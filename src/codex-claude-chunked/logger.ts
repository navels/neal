import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ExecutionMode } from './types.js';

type LoggerEvent = {
  ts: string;
  type: string;
  data?: Record<string, unknown>;
};

export type RunLoggerInit = {
  cwd: string;
  stateDir: string;
  planDoc: string;
  executionMode: ExecutionMode;
  runDir?: string;
  resumedFromStatePath?: string;
};

function createRunId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function safeWrite(action: () => Promise<void>) {
  try {
    await action();
  } catch {
    // Best-effort diagnostics only.
  }
}

export class RunLogger {
  readonly runDir: string;
  private readonly eventsPath: string;
  private readonly stderrPath: string;
  private readonly metaPath: string;

  constructor(runDir: string) {
    this.runDir = runDir;
    this.eventsPath = join(runDir, 'events.ndjson');
    this.stderrPath = join(runDir, 'stderr.log');
    this.metaPath = join(runDir, 'meta.json');
  }

  async init(init: RunLoggerInit) {
    await safeWrite(async () => {
      await mkdir(this.runDir, { recursive: true });
      await writeFile(
        this.metaPath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            cwd: init.cwd,
            planDoc: init.planDoc,
            planName: basename(init.planDoc),
            executionMode: init.executionMode,
            resumedFromStatePath: init.resumedFromStatePath ?? null,
            runDir: this.runDir,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    });
  }

  async event(type: string, data?: Record<string, unknown>) {
    const payload: LoggerEvent = {
      ts: new Date().toISOString(),
      type,
      data,
    };

    await safeWrite(async () => {
      await appendFile(this.eventsPath, JSON.stringify(payload) + '\n', 'utf8');
    });
  }

  async stderr(message: string) {
    await safeWrite(async () => {
      await appendFile(this.stderrPath, message, 'utf8');
    });
  }
}

export async function createRunLogger(init: RunLoggerInit) {
  const runDir = init.runDir ?? join(init.stateDir, 'runs', createRunId());
  const logger = new RunLogger(runDir);
  await logger.init(init);
  return logger;
}
