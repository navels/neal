#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadOrInitialize, runOnePass } from './orchestrator.js';
import type { RunLogger } from './logger.js';
import type { ExecutionMode } from './types.js';

function usage(): never {
  console.error('Usage: forge [--execute] [--chunked] <plan-doc>');
  console.error('   or: forge --resume [state-file]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }

  let executionMode: ExecutionMode = 'one_shot';
  let planDoc: string | null = null;
  let resumeStatePath: string | undefined;
  let index = 0;

  if (args[index] === '--execute') {
    index += 1;
  }

  if (args[index] === '--chunked') {
    executionMode = 'chunked';
    index += 1;
  }

  const firstArg = args[index];
  if (!firstArg) {
    usage();
  }

  if (firstArg === '--resume') {
    resumeStatePath = resolve(args[index + 1] ?? '.forge/session.json');
    await access(resumeStatePath);
  } else {
    planDoc = resolve(firstArg);
    await access(planDoc);
  }

  const resolvedPlanDoc = resumeStatePath ? null : planDoc;
  const { state, statePath, logger } = await loadOrInitialize(resolvedPlanDoc, process.cwd(), resumeStatePath, executionMode);
  runLogger = logger;
  const finalState = await runOnePass(state, statePath, logger);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        phase: finalState.phase,
        status: finalState.status,
        planDoc: finalState.planDoc,
        executionMode: finalState.executionMode,
        statePath,
        runDir: finalState.runDir,
        progressJsonPath: finalState.progressJsonPath,
        progressMarkdownPath: finalState.progressMarkdownPath,
        reviewMarkdownPath: finalState.reviewMarkdownPath,
        archivedReviewPath: finalState.archivedReviewPath,
        baseCommit: finalState.baseCommit,
        finalCommit: finalState.finalCommit,
        codexThreadId: finalState.codexThreadId,
        rounds: finalState.rounds.length,
        findings: finalState.findings.length,
      },
      null,
      2,
    ) + '\n',
  );
}

let runLogger: RunLogger | undefined;

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  void runLogger?.event('run.failed', { message });
  if (error instanceof Error && error.stack) {
    void runLogger?.stderr(`[fatal] ${error.stack}\n`);
  } else {
    void runLogger?.stderr(`[fatal] ${message}\n`);
  }
  process.stderr.write(`[forge] ${message}\n`);
  process.exit(1);
});
