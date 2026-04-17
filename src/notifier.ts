import { spawn } from 'node:child_process';

import { getNotifyBin } from './neal/config.js';

export type NotificationKind = 'done' | 'blocked' | 'complete' | 'retry';

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

export async function notify(kind: NotificationKind, message: string, cwd = process.cwd()) {
  const notifyPath = getNotifyBin(cwd);
  await runCommand(notifyPath, [message]);
}
