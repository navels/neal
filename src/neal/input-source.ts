import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunId } from './logger.js';
import type { FileOrTextInputSource } from './cli.js';

export type ResolvedInput = {
  planDoc: string;
  runDir?: string;
};

export async function resolveInput(
  source: FileOrTextInputSource,
  cwd: string,
  mode: 'plan' | 'execute',
): Promise<ResolvedInput> {
  switch (source.mode) {
    case 'file_default':
    case 'file_explicit':
      return {
        planDoc: await resolveFilePath(source.value, cwd, mode),
      };
    case 'text_explicit':
      return materializeInlinePlan(source.value, cwd, mode);
  }
}

async function resolveFilePath(inputPath: string, cwd: string, mode: 'plan' | 'execute') {
  const absolutePath = resolve(cwd, inputPath);
  try {
    await access(absolutePath);
    return absolutePath;
  } catch {
    throw new Error(
      `File mode requires an existing plan file path: ${inputPath}. Did you mean --${mode}-text?`,
    );
  }
}

async function materializeInlinePlan(planText: string, cwd: string, mode: 'plan' | 'execute'): Promise<ResolvedInput> {
  if (planText.trim() === '') {
    throw new Error(`--${mode}-text requires a non-empty inline plan string argument`);
  }

  const runDir = join(cwd, '.neal', 'runs', createRunId());
  const planDoc = join(runDir, mode === 'execute' ? 'INLINE_EXECUTE_PLAN.md' : 'INLINE_PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, planText, 'utf8');
  return {
    planDoc,
    runDir,
  };
}
