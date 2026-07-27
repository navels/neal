import process from 'node:process';

import { parseReviewArgs } from '../cli.js';
import { assertGitRepositoryWithCommit } from '../git.js';
import { runNealReviewCli } from '../review-findings/run.js';
import { withInteractiveActivity } from './interactive-activity.js';

export async function runReviewCommand(args: string[]): Promise<void> {
  const parsed = parseReviewArgs(args);
  await assertGitRepositoryWithCommit(process.cwd(), 'neal review');
  await withInteractiveActivity({
    mode: 'review',
    initialActivity: 'preparing review',
  }, async ({ stderr, reportActivity }) => {
    await runNealReviewCli({
      cwd: process.cwd(),
      parsed,
      stdout: process.stdout,
      stderr,
      onActivity: reportActivity,
    });
  });
}
