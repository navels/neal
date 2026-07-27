import { spawn } from 'node:child_process';

import type { ManualGateResumeCheck, ManualGateState, OrchestrationState } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_LIMIT = 4_000;
const REDACTED = '[redacted]';

export type ManualGateCheckPass = {
  ok: true;
  checkName: string;
  exitCode: 0;
  signal: null;
  stdoutTail: string;
  stderrTail: string;
};

export type ManualGateCheckFailure = ManualGateState['lastFailure'] & {
  ok: false;
};

export type ManualGateCheckResult = ManualGateCheckPass | ManualGateCheckFailure;

export type ManualGateResumeCheckResult =
  | {
      ok: true;
      results: ManualGateCheckPass[];
    }
  | {
      ok: false;
      failure: ManualGateCheckFailure;
      results: ManualGateCheckResult[];
    };

export async function runManualGateResumeChecks(state: OrchestrationState): Promise<ManualGateResumeCheckResult> {
  const gate = state.manualGate;
  if (state.phase !== 'manual_gate' || gate === null) {
    throw new Error('Cannot run manual gate resume checks without an active manual gate.');
  }

  const results: ManualGateCheckResult[] = [];
  for (const check of gate.resumeChecks) {
    const result = await runManualGateResumeCheck(state, check);
    results.push(result);
    if (!result.ok) {
      return {
        ok: false,
        failure: result,
        results,
      };
    }
  }

  return {
    ok: true,
    results: results as ManualGateCheckPass[],
  };
}

export function redactManualGateOutput(value: string, env = process.env): string {
  let redacted = value;
  for (const [key, secret] of Object.entries(env)) {
    if (!secret || !isSensitiveEnvKey(key)) {
      continue;
    }
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

function isSensitiveEnvKey(key: string) {
  return /TOKEN|SECRET|PASSWORD|KEY/i.test(key);
}

async function runManualGateResumeCheck(
  state: OrchestrationState,
  check: ManualGateResumeCheck,
): Promise<ManualGateCheckResult> {
  const [command, ...args] = check.command;
  if (!command) {
    throw new Error(`Manual gate check ${check.name} has an empty command.`);
  }

  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = check.cwd === 'run_dir' ? state.runDir : state.cwd;
  const raw = await runCommand({
    command,
    args,
    cwd,
    timeoutMs,
  });
  const stdoutTail = boundedTail(redactManualGateOutput(raw.stdout));
  const stderrTail = boundedTail(redactManualGateOutput(raw.stderr));

  if (raw.exitCode === 0 && raw.signal === null) {
    return {
      ok: true,
      checkName: check.name,
      exitCode: 0,
      signal: null,
      stdoutTail,
      stderrTail,
    };
  }

  return {
    ok: false,
    checkName: check.name,
    exitCode: raw.exitCode,
    signal: raw.signal,
    stdoutTail,
    stderrTail,
  };
}

function runCommand(args: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, args.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal: signal ?? (timedOut ? 'SIGTERM' : null),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function boundedTail(value: string) {
  return value.length <= OUTPUT_TAIL_LIMIT ? value : value.slice(value.length - OUTPUT_TAIL_LIMIT);
}
