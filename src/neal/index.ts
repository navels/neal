#!/usr/bin/env node

import 'dotenv/config';

import process from 'node:process';

import {
  buildUsageLines,
} from './cli.js';
import { runCheckCommand } from './commands/check.js';
import { runCompatCommand } from './commands/compat.js';
import { runNewRunCommand } from './commands/new-run.js';
import { runPlanAndExecuteCommand } from './commands/plan-and-execute.js';
import { runResumeRunCommand } from './commands/resume-run.js';
import { getCurrentRunLogger } from './commands/runtime.js';
import { runReviewCommand } from './commands/review.js';
import { runSetupCommand } from './commands/setup.js';
import { runSquashCommand } from './commands/squash.js';
import { runStatusCommand } from './commands/status.js';
import {
  formatWriterProviderSetupRequiredLines,
  isWriterProvidersNotConfiguredError,
} from './config.js';
import { clearDiagnosticFooter, writeErrorDetail, writeNarrative } from './diagnostic.js';
import { CoderRoundError, ReviewerRoundError } from './agents.js';
import { getAppVersion } from './version.js';

function printUsage(lines: string[]) {
  for (const line of lines) {
    console.error(line);
  }
}

function usage(): never {
  printUsage(buildUsageLines(getAppVersion()));
  process.exit(1);
}

function help(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function getProcessArgs() {
  const args = process.argv.slice(2);
  if (args[0] === '--' && process.env.npm_lifecycle_event === 'start') {
    return args.slice(1);
  }
  return args;
}

async function main() {
  const args = getProcessArgs();
  const version = getAppVersion();
  if (args.length === 0) {
    usage();
  }

  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    if (args.length === 1) {
      help(buildUsageLines(version));
      return;
    }
    throw new Error('Usage: neal help');
  }

  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-V') {
    if (args.length !== 1) {
      throw new Error('Usage: neal version');
    }
    process.stdout.write(`${version}\n`);
    return;
  }

  if (args[0] === 'status') {
    await runStatusCommand(args);
    return;
  }

  if (args[0] === 'review') {
    await runReviewCommand(args);
    return;
  }

  if (args[0] === 'setup') {
    await runSetupCommand(args);
    return;
  }

  if (args[0] === 'plan') {
    await runNewRunCommand(args);
    return;
  }

  if (args[0] === 'execute') {
    await runNewRunCommand(args);
    return;
  }

  if (args[0] === 'run') {
    await runPlanAndExecuteCommand(args);
    return;
  }

  if (args[0] === 'resume') {
    await runResumeRunCommand(args);
    return;
  }

  if (args[0] === 'squash') {
    await runSquashCommand(args);
    return;
  }

  if (args[0] === 'check') {
    await runCheckCommand(args);
    return;
  }

  if (args[0] === 'compat') {
    await runCompatCommand(args);
    return;
  }

  throw new Error(`Unknown command: ${args[0]}. Run \`neal help\` for supported commands.`);
}

void main().catch((error: unknown) => {
  clearDiagnosticFooter();
  const runLogger = getCurrentRunLogger();
  const message = error instanceof Error ? error.message : String(error);
  const coderSessionHandle = error instanceof CoderRoundError ? error.sessionHandle : null;
  const reviewerSessionHandle = error instanceof ReviewerRoundError ? error.sessionHandle : null;
  void runLogger?.event('run.failed', {
    message,
    coderSessionHandle,
    reviewerSessionHandle,
    reviewerSubtype: error instanceof ReviewerRoundError ? error.subtype : null,
  });
  if (error instanceof Error && error.stack) {
    void runLogger?.stderr(`[fatal] ${error.stack}\n`);
  } else {
    void runLogger?.stderr(`[fatal] ${message}\n`);
  }
  if (coderSessionHandle) {
    writeErrorDetail(`[neal:detail] coder session: ${coderSessionHandle}\n`, runLogger, { role: 'coder' });
  } else if (reviewerSessionHandle) {
    writeErrorDetail(`[neal:detail] reviewer session: ${reviewerSessionHandle}\n`, runLogger, { role: 'reviewer' });
  }
  if (isWriterProvidersNotConfiguredError(error)) {
    writeNarrative(`${formatWriterProviderSetupRequiredLines(error, '[neal]').join('\n')}\n`);
  } else {
    // Some thrown messages already carry the prefix (e.g. run-lock guidance);
    // only prepend it when absent so every failure reports it exactly once.
    writeNarrative(message.startsWith('[neal] ') ? `${message}\n` : `[neal] ${message}\n`);
  }
  process.exit(1);
});
