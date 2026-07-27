import process from 'node:process';
import readline from 'node:readline';

import { parseSquashArgs } from '../cli.js';
import { assertGitRepositoryWithCommit } from '../git.js';
import {
  buildSquashCommitMessage,
  buildSquashResultMetadata,
  executeSquashForRun,
  selectLatestSquashRun,
  selectSquashRunForPlan,
  validateSelectedRunForSquash,
  type SquashResultMetadata,
} from '../squash.js';

type SquashPreviewArgs = {
  selection: Awaited<ReturnType<typeof selectSquashRunForPlan>> | Awaited<ReturnType<typeof selectLatestSquashRun>>;
  validation: Awaited<ReturnType<typeof validateSelectedRunForSquash>>;
  commitMessage: Awaited<ReturnType<typeof buildSquashCommitMessage>>;
  metadata: SquashResultMetadata;
};

export async function runSquashCommand(args: string[]): Promise<void> {
  const parsed = parseSquashArgs(args);
  await assertGitRepositoryWithCommit(process.cwd(), 'neal squash');
  const selection = parsed.planDoc
    ? await selectSquashRunForPlan({
        cwd: process.cwd(),
        planDocArg: parsed.planDoc,
      })
    : await selectLatestSquashRun({
        cwd: process.cwd(),
      });
  const validation = await validateSelectedRunForSquash({
    cwd: process.cwd(),
    selected: selection.selected,
  });
  const commitMessage = await buildSquashCommitMessage({
    cwd: process.cwd(),
    selected: selection.selected,
  });
  const metadata = await buildSquashResultMetadata({
    cwd: process.cwd(),
    selected: selection.selected,
    validation,
    commitMessage,
  });
  writeSquashPreview({
    selection,
    validation,
    commitMessage,
    metadata,
  });
  await confirmSquashRewrite();

  const execution = await executeSquashForRun({
    cwd: process.cwd(),
    selected: selection.selected,
    validation,
    commitMessage,
  });
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        mode: 'squash_result',
        rewriteReady: true,
        planDoc: selection.normalizedPlanDoc,
        selectedRunDir: selection.selected.runDir,
        selectedRunId: selection.selected.runId,
        completedMatchCount: selection.completedMatchCount,
        selectionWarning: selection.selectionWarning,
        baseCommit: validation.baseCommit,
        finalCommit: validation.finalCommit,
        createdCommits: validation.createdCommits,
        postPlanCommits: validation.postPlanCommits,
        commitMessageSource: commitMessage.source,
        commitMessageSubject: commitMessage.subject,
        commitMessage: commitMessage.message,
        planDocDisposition: execution.artifact.metadata.planDocDisposition,
        planDocIncludedInReplacementCommit: execution.artifact.metadata.planDocIncludedInReplacementCommit,
        metadata: execution.artifact.metadata,
        replacementCommit: execution.replacementCommit,
        finalHeadCommit: execution.finalHeadCommit,
        squashArtifactPath: execution.artifactPath,
      },
      null,
      2,
    ) + '\n',
  );
}

function writeSquashPreview({ selection, validation, commitMessage, metadata }: SquashPreviewArgs) {
  const lines = [
    `[neal] selected squash run: ${selection.selected.runId}`,
    `[neal] run dir: ${selection.selected.runDir}`,
    `[neal] plan doc: ${selection.normalizedPlanDoc}`,
    `[neal] plan doc disposition: ${metadata.planDocDisposition}`,
    `[neal] replacement tree includes plan doc: ${metadata.planDocIncludedInReplacementCommit ? 'yes' : 'no'}`,
    `[neal] base commit: ${validation.baseCommit}`,
    `[neal] final commit: ${validation.finalCommit}`,
    '[neal] commits to replace:',
    ...validation.createdCommits.map((commit) => `  - ${commit}`),
    validation.postPlanCommits.length > 0 ? '[neal] later commits to preserve:' : '[neal] later commits to preserve: none',
    ...validation.postPlanCommits.map((commit) => `  - ${commit}`),
    `[neal] commit message source: ${metadata.commitMessageSource}`,
    `[neal] commit message subject: ${metadata.commitMessageSubject}`,
    '[neal] generated commit message:',
    commitMessage.message,
  ];

  if (selection.selectionWarning) {
    lines.splice(2, 0, `[neal] ${selection.selectionWarning}`);
  }

  process.stderr.write(lines.join('\n') + '\n');
}

async function confirmSquashRewrite() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(
      '[neal] Interactive TTY confirmation is required before rewriting history; automated squash confirmation is not part of the public CLI.\n',
    );
    throw new Error('neal squash requires interactive TTY confirmation; no history was rewritten');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question('[neal] Proceed with squash rewrite? [y/N] ', resolve);
    });
    const normalized = answer.trim().toLowerCase();
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new Error('neal squash aborted; no history was rewritten');
    }
  } finally {
    rl.close();
  }
}
