import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type NotificationKind = 'done' | 'blocked' | 'complete' | 'retry';

function getCommandPath(envName: string, defaultRelativePath: string) {
  return process.env[envName] ?? resolve(homedir(), defaultRelativePath);
}

async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
    });

    child.on('error', rejectPromise);
    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${command} terminated by signal ${signal}`));
        return;
      }

      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} exited with status ${code}`));
      }
    });
  });
}

export async function notify(kind: NotificationKind, message: string) {
  if (kind === 'done') {
    const healthcheckPath = getCommandPath('AUTONOMY_HEALTHCHECK', 'bin/healthcheck.sh');
    await runCommand(healthcheckPath, ['codex']);
    return;
  }

  const notifyPath = getCommandPath('AUTONOMY_NOTIFY_BIN', 'bin/notify');
  await runCommand(notifyPath, [message]);
}
