import { truncateInlineSectionBody } from './context/inline-review-context.js';
import type { FinalCompletionVerificationTally, VerificationCommandResult } from './types.js';

export type RunEvent = {
  ts?: unknown;
  type?: unknown;
  data?: Record<string, unknown>;
};

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isVerificationCommand(command: string) {
  return /\b(test|tests|typecheck|tsc|lint|build|verify|validation|check|pytest|vitest|jest)\b/i.test(command);
}

function isCommandExecutionEvent(event: RunEvent) {
  return (
    event.type === 'provider.command_completed' ||
    event.type === 'coder.command_execution' ||
    event.type === 'codex.command_execution'
  );
}

export function extractCommandResults(events: RunEvent[]) {
  return events
    .filter(isCommandExecutionEvent)
    .map((event): VerificationCommandResult | null => {
      const command = stringValue(event.data?.command);
      if (!command) {
        return null;
      }

      return {
        command,
        provider: stringValue(event.data?.provider),
        status: stringValue(event.data?.status),
        exitCode: numberValue(event.data?.exitCode),
        cwd: stringValue(event.data?.cwd),
        gitHead: stringValue(event.data?.gitHead),
        completedAt: stringValue(event.ts),
        itemId: stringValue(event.data?.itemId),
        outputLength: numberValue(event.data?.outputLength),
      };
    })
    .filter((result): result is VerificationCommandResult => result !== null);
}

export function extractVerificationCommandResults(events: RunEvent[]) {
  return extractCommandResults(events).filter((result) => isVerificationCommand(result.command));
}

export function latestCommandResultPerCommand(results: VerificationCommandResult[]) {
  const byCommand = new Map<string, VerificationCommandResult>();
  for (const result of results) {
    byCommand.set(result.command, result);
  }
  return [...byCommand.values()];
}

function renderCommandStatus(result: VerificationCommandResult) {
  if (result.exitCode === 0) {
    return 'passed';
  }

  if (typeof result.exitCode === 'number') {
    return 'failed';
  }

  if (result.status === 'failed') {
    return 'failed';
  }

  return 'unknown';
}

// Bounds for the final-completion verification tally: at most this many recent
// failing commands, each command string capped so one pathological command
// cannot inflate the tally.
export const VERIFICATION_TALLY_RECENT_FAILURE_LIMIT = 10;
export const VERIFICATION_TALLY_COMMAND_MAX_CHARS = 300;

// Builds the bounded verification tally the final-completion prompts embed:
// pass/fail/unknown counts over the latest result per distinct command, plus
// the last few failing commands with their exit codes. Distinct commands are
// ordered by their latest event position (not first appearance), so a repeated
// command that failed at the end of the run counts as recent. The complete
// per-command record stays in events.ndjson.
export function buildVerificationTally(results: VerificationCommandResult[]): FinalCompletionVerificationTally {
  const latestByCommand = new Map<string, { result: VerificationCommandResult; lastIndex: number }>();
  results.forEach((result, index) => {
    latestByCommand.set(result.command, { result, lastIndex: index });
  });
  const latestResults = [...latestByCommand.values()]
    .sort((a, b) => a.lastIndex - b.lastIndex)
    .map((entry) => entry.result);
  let passed = 0;
  let failed = 0;
  let unknown = 0;
  const failures: FinalCompletionVerificationTally['recentFailures'] = [];

  for (const result of latestResults) {
    const status = renderCommandStatus(result);
    if (status === 'passed') {
      passed += 1;
    } else if (status === 'failed') {
      failed += 1;
      failures.push({
        command: truncateInlineSectionBody(result.command, VERIFICATION_TALLY_COMMAND_MAX_CHARS),
        exitCode: result.exitCode,
      });
    } else {
      unknown += 1;
    }
  }

  return {
    totalRuns: results.length,
    distinctCommands: latestResults.length,
    passed,
    failed,
    unknown,
    recentFailures: failures.slice(-VERIFICATION_TALLY_RECENT_FAILURE_LIMIT),
  };
}

export function summarizeVerificationCommandResults(results: VerificationCommandResult[]) {
  if (results.length === 0) {
    return 'No verification commands were recorded in events.ndjson.';
  }

  const latestResults = latestCommandResultPerCommand(results);
  const lines = ['Recorded latest verification command results for this run:'];
  let unknownExitStatusCount = 0;

  for (const result of latestResults) {
    const renderedStatus = renderCommandStatus(result);
    const exit = typeof result.exitCode === 'number' ? `exit ${result.exitCode}` : 'exit unknown';
    const gitHead = result.gitHead ? `, git ${result.gitHead.slice(0, 12)}` : '';
    const cwd = result.cwd ? `, cwd ${result.cwd}` : '';
    const completedAt = result.completedAt ? `, at ${result.completedAt}` : '';
    lines.push(`- ${renderedStatus} (${exit}${gitHead}${cwd}${completedAt}): ${result.command}`);
    if (typeof result.exitCode !== 'number') {
      unknownExitStatusCount += 1;
    }
  }

  if (unknownExitStatusCount > 0) {
    lines.push(
      `- ${unknownExitStatusCount} latest verification command(s) have unknown exit status, usually from older events recorded before structured command results were available.`,
    );
  }

  return lines.join('\n');
}
