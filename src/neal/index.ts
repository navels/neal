#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import { ClaudeRoundError, CodexRoundError } from './agents.js';
import { loadOrInitialize, runOnePass } from './orchestrator.js';
import type { RunLogger } from './logger.js';
import { showSummaries } from './summaries.js';

function usage(): never {
  console.error('Usage: neal --execute <plan-doc>');
  console.error('   or: neal --plan <plan-doc>');
  console.error('   or: neal --resume [state-file]');
  console.error('   or: neal --summaries [runs-dir]');
  process.exit(1);
}

async function resumeLastThread(threadId: string) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('codex', ['resume', threadId], {
      stdio: 'inherit',
    });

    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`codex resume terminated by signal ${signal}`));
        return;
      }

      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`codex resume exited with status ${code}`));
      }
    });
  });
}

function createStopController() {
  let stopRequested = false;

  if (!process.stdin.isTTY) {
    return {
      cleanup() {},
      isStopRequested() {
        return stopRequested;
      },
    };
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onKeypress = (_input: string, key: readline.Key) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      process.exit(130);
    }

    if (key.name === 'q') {
      stopRequested = true;
      process.stderr.write('\n[neal] stop requested after the current scope\n');
    }
  };

  process.stdin.on('keypress', onKeypress);

  function cleanup() {
    process.stdin.off('keypress', onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  return {
    cleanup,
    isStopRequested() {
      return stopRequested;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }

  if (args[0] === '--summaries') {
    await showSummaries(args[1]);
    return;
  }

  let topLevelMode: 'plan' | 'execute' = 'execute';
  let planDoc: string | null = null;
  let resumeStatePath: string | undefined;
  let index = 0;
  let sawExplicitMode = false;

  if (args[index] === '--plan') {
    topLevelMode = 'plan';
    sawExplicitMode = true;
    index += 1;
  } else if (args[index] === '--execute') {
    sawExplicitMode = true;
    index += 1;
  }

  const firstArg = args[index];
  if (!firstArg) {
    usage();
  }

  if (firstArg === '--resume') {
    resumeStatePath = resolve(args[index + 1] ?? '.neal/session.json');
    await access(resumeStatePath);
  } else {
    if (!sawExplicitMode) {
      usage();
    }
    planDoc = resolve(firstArg);
    await access(planDoc);
  }

  const resolvedPlanDoc = resumeStatePath ? null : planDoc;
  const { state, statePath, logger } = await loadOrInitialize(resolvedPlanDoc, process.cwd(), resumeStatePath, topLevelMode);
  runLogger = logger;
  const stopController = createStopController();
  let lastThreadId: string | null = state.codexThreadId;
  let shouldResumeLastThread = false;

  if (process.stdin.isTTY) {
    process.stderr.write('[neal] press q to stop after the current scope\n');
  }

  let finalState;
  try {
    finalState = await runOnePass(state, statePath, logger, {
      shouldStopAfterCurrentScope() {
        return stopController.isStopRequested();
      },
      onCodexThread(threadId) {
        if (threadId) {
          lastThreadId = threadId;
        }
      },
    });
    shouldResumeLastThread =
      stopController.isStopRequested() &&
      finalState.phase === 'codex_scope' &&
      finalState.status === 'running' &&
      Boolean(lastThreadId);
  } finally {
    stopController.cleanup();
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        phase: finalState.phase,
        status: finalState.status,
        topLevelMode: finalState.topLevelMode,
        planDoc: finalState.planDoc,
        statePath,
        runDir: finalState.runDir,
        progressJsonPath: finalState.progressJsonPath,
        progressMarkdownPath: finalState.progressMarkdownPath,
        reviewMarkdownPath: finalState.reviewMarkdownPath,
        archivedReviewPath: finalState.archivedReviewPath,
        baseCommit: finalState.baseCommit,
        finalCommit: finalState.finalCommit,
        codexThreadId: finalState.codexThreadId,
        claudeSessionId: finalState.claudeSessionId,
        rounds: finalState.rounds.length,
        findings: finalState.findings.length,
      },
      null,
      2,
    ) + '\n',
  );

  if (shouldResumeLastThread && lastThreadId) {
    process.stderr.write(`[neal] resuming ${lastThreadId}\n`);
    await resumeLastThread(lastThreadId);
  }
}

let runLogger: RunLogger | undefined;

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  void runLogger?.event('run.failed', {
    message,
    codexThreadId: error instanceof CodexRoundError ? error.threadId : null,
    claudeSessionId: error instanceof ClaudeRoundError ? error.sessionId : null,
    claudeSubtype: error instanceof ClaudeRoundError ? error.subtype : null,
  });
  if (error instanceof Error && error.stack) {
    void runLogger?.stderr(`[fatal] ${error.stack}\n`);
  } else {
    void runLogger?.stderr(`[fatal] ${message}\n`);
  }
  if (error instanceof CodexRoundError && error.threadId) {
    process.stderr.write(`[neal] ${message} (codex thread: ${error.threadId})\n`);
  } else if (error instanceof ClaudeRoundError && error.sessionId) {
    process.stderr.write(`[neal] ${message} (claude session: ${error.sessionId})\n`);
  } else {
    process.stderr.write(`[neal] ${message}\n`);
  }
  process.exit(1);
});
