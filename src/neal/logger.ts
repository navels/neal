import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write.js';
import { RUNS_DIR_NAME } from './storage-paths.js';
import { getNealBuildMetadata, type NealBuildMetadata } from './version.js';
import type { TopLevelMode } from './types.js';

type LoggerEvent = {
  ts: string;
  type: string;
  data?: Record<string, unknown>;
};

type RunMetaResumeRecord = {
  resumedAt: string;
  resumedFromStatePath: string;
  build: NealBuildMetadata;
};

type RunMetaRecord = Record<string, unknown> & {
  resumes?: unknown;
};

export type RunLoggerInit = {
  cwd: string;
  stateDir: string;
  planDoc: string;
  topLevelMode: TopLevelMode;
  runDir?: string;
  resumedFromStatePath?: string;
};

export function createRunId() {
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

async function readExistingMeta(path: string): Promise<RunMetaRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RunMetaRecord : null;
  } catch {
    return null;
  }
}

function appendResumeMeta(meta: RunMetaRecord, resume: RunMetaResumeRecord): RunMetaRecord {
  const resumes = Array.isArray(meta.resumes) ? meta.resumes : [];
  return {
    ...meta,
    resumes: [
      ...resumes,
      resume,
    ],
  };
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
      const now = new Date().toISOString();
      const build = await getNealBuildMetadata();
      const resumeRecord = init.resumedFromStatePath
        ? {
            resumedAt: now,
            resumedFromStatePath: init.resumedFromStatePath,
            build,
          }
        : null;

      if (resumeRecord) {
        const existing = await readExistingMeta(this.metaPath);
        if (existing) {
          await writeJsonAtomic(this.metaPath, appendResumeMeta(existing, resumeRecord));
          return;
        }
      }

      await writeJsonAtomic(this.metaPath, {
        version: 1,
        createdAt: now,
        cwd: init.cwd,
        planDoc: init.planDoc,
        planName: basename(init.planDoc),
        topLevelMode: init.topLevelMode,
        resumedFromStatePath: init.resumedFromStatePath ?? null,
        runDir: this.runDir,
        ...(resumeRecord ? { resumes: [resumeRecord] } : { build }),
      });
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
  const runDir = init.runDir ?? join(init.stateDir, RUNS_DIR_NAME, createRunId());
  const logger = new RunLogger(runDir);
  await logger.init(init);
  return logger;
}
