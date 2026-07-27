import { spawn } from 'node:child_process';

import { getNotifyBin } from './neal/config.js';

export type NotificationKind = 'done' | 'blocked' | 'complete' | 'retry';

export const NOTIFICATION_CHECK_MESSAGE = '[neal] check notification test';

async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
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
  if (!notifyPath) {
    return;
  }

  try {
    await runCommand(notifyPath, [message]);
  } catch {
    // Notifications are a local convenience; the primary run result wins.
  }
}

export async function verifyNotification(cwd = process.cwd(), message = NOTIFICATION_CHECK_MESSAGE) {
  const notifyPath = getNotifyBin(cwd);
  if (!notifyPath) {
    return null;
  }

  await runCommand(notifyPath, [message]);
  return notifyPath;
}
