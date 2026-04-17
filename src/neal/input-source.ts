import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunId } from './logger.js';
import type { ExecuteInputSource } from './cli.js';

export type ResolvedExecuteInput = {
  planDoc: string;
  runDir?: string;
};

export async function resolveExecuteInput(source: ExecuteInputSource, cwd: string): Promise<ResolvedExecuteInput> {
  switch (source.mode) {
    case 'file_default':
    case 'file_explicit':
      return {
        planDoc: await resolveExecuteFilePath(source.value, cwd),
      };
    case 'text_explicit':
      return materializeInlineExecutePlan(source.value, cwd);
  }
}

async function resolveExecuteFilePath(inputPath: string, cwd: string) {
  const absolutePath = resolve(cwd, inputPath);
  try {
    await access(absolutePath);
    return absolutePath;
  } catch {
    throw new Error(
      `File mode requires an existing plan file path: ${inputPath}. Did you mean --execute-text?`,
    );
  }
}

async function materializeInlineExecutePlan(planText: string, cwd: string): Promise<ResolvedExecuteInput> {
  if (planText.trim() === '') {
    throw new Error('--execute-text requires a non-empty inline plan string argument');
  }

  const runDir = join(cwd, '.neal', 'runs', createRunId());
  const planDoc = join(runDir, 'INLINE_EXECUTE_PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, planText, 'utf8');
  return {
    planDoc,
    runDir,
  };
}
