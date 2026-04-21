import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
      return mode === 'plan'
        ? materializeInlinePlanDraft(source.targetPath, source.value, cwd)
        : materializeInlineExecutePlan(source.value, cwd);
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

async function materializeInlineExecutePlan(planText: string, cwd: string): Promise<ResolvedInput> {
  const runDir = join(cwd, '.neal', 'runs', createRunId());
  const planDoc = join(runDir, 'INLINE_EXECUTE_PLAN.md');
  await mkdir(runDir, { recursive: true });
  await writeFile(planDoc, planText, 'utf8');
  return {
    planDoc,
    runDir,
  };
}

async function materializeInlinePlanDraft(targetPath: string | undefined, planText: string, cwd: string): Promise<ResolvedInput> {
  if (!targetPath) {
    throw new Error('--plan-text requires an inline plan string followed by a target plan file path argument');
  }

  const planDoc = resolve(cwd, targetPath);
  await mkdir(dirname(planDoc), { recursive: true });
  await writeFile(planDoc, planText, 'utf8');
  return {
    planDoc,
  };
}
