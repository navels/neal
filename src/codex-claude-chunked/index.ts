#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { loadOrInitialize, runOnePass } from './orchestrator.js';
import type { RunLogger } from './logger.js';

function usage(): never {
  console.error('Usage: forge <plan-doc>');
  console.error('   or: forge --resume [state-file]');
  process.exit(1);
}

async function main() {
  const firstArg = process.argv[2];
  if (!firstArg) {
    usage();
  }

  let planDoc: string | null = null;
  let resumeStatePath: string | undefined;

  if (firstArg === '--resume') {
    resumeStatePath = resolve(process.argv[3] ?? '.forge/session.json');
    await access(resumeStatePath);
  } else {
    planDoc = resolve(firstArg);
    await access(planDoc);
  }

  const resolvedPlanDoc = resumeStatePath ? null : planDoc;
  const { state, statePath, logger } = await loadOrInitialize(resolvedPlanDoc, process.cwd(), resumeStatePath);
  runLogger = logger;
  const finalState = await runOnePass(state, statePath, logger);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        phase: finalState.phase,
        status: finalState.status,
        planDoc: finalState.planDoc,
        statePath,
        runDir: finalState.runDir,
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
