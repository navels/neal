import type { ParsedReviewArgs, ParsedReviewSelector } from './cli.js';
import {
  getChangedFilesForRange,
  getCommitRange,
  getCommitSubjects,
  getHeadCommit,
  isAncestorCommit,
  resolveCommitRef,
} from './git.js';

export type ResolvedReviewTarget = {
  selector: ParsedReviewSelector;
  baseRef: string;
  headRef: string;
  externalBaseCommit: string;
  externalHeadCommit: string;
  externalCommits: string[];
  externalCommitSubjects: string[];
  externalChangedFiles: string[];
};

function shortCommit(commit: string) {
  return commit.slice(0, 7);
}

function getSelectorRefs(selector: ParsedReviewSelector) {
  switch (selector.kind) {
    case 'last':
      return {
        baseRef: `HEAD~${selector.count}`,
        headRef: 'HEAD',
      };
    case 'since':
      return {
        baseRef: selector.baseRef,
        headRef: 'HEAD',
      };
  }
}

async function resolveReviewCommitRef(cwd: string, label: 'base' | 'head', ref: string) {
  try {
    return await resolveCommitRef(cwd, ref);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve review ${label} ref "${ref}" to a commit: ${detail}`);
  }
}

export async function assertReviewExternalCommitsReproducible(args: {
  cwd: string;
  externalBaseCommit: string;
  externalHeadCommit: string;
  externalCommits: string[];
}) {
  const actualCommits = await getCommitRange(args.cwd, args.externalBaseCommit, args.externalHeadCommit);
  if (
    actualCommits.length !== args.externalCommits.length ||
    actualCommits.some((commit, index) => commit !== args.externalCommits[index])
  ) {
    throw new Error('neal review external commit list no longer matches the resolved base..head range');
  }
}

export async function resolveReviewTarget(cwd: string, parsed: ParsedReviewArgs): Promise<ResolvedReviewTarget> {
  const { baseRef, headRef } = getSelectorRefs(parsed.selector);
  const externalBaseCommit = await resolveReviewCommitRef(cwd, 'base', baseRef);
  const externalHeadCommit = await resolveReviewCommitRef(cwd, 'head', headRef);
  const currentHeadCommit = await getHeadCommit(cwd);

  if (externalHeadCommit !== currentHeadCommit) {
    throw new Error(
      `neal review requires the selected head to be the current checkout HEAD in v1: selected ${shortCommit(
        externalHeadCommit,
      )}, current ${shortCommit(currentHeadCommit)}`,
    );
  }

  const baseIsAncestor = await isAncestorCommit(cwd, externalBaseCommit, externalHeadCommit);
  if (!baseIsAncestor) {
    throw new Error(
      `neal review requires the selected base to be an ancestor of the selected head: ${shortCommit(
        externalBaseCommit,
      )} is not an ancestor of ${shortCommit(externalHeadCommit)}`,
    );
  }

  const externalCommits = await getCommitRange(cwd, externalBaseCommit, externalHeadCommit);
  if (externalCommits.length === 0) {
    throw new Error('neal review requires at least one commit in the selected range');
  }

  await assertReviewExternalCommitsReproducible({
    cwd,
    externalBaseCommit,
    externalHeadCommit,
    externalCommits,
  });

  return {
    selector: parsed.selector,
    baseRef,
    headRef,
    externalBaseCommit,
    externalHeadCommit,
    externalCommits,
    externalCommitSubjects: await getCommitSubjects(cwd, externalCommits),
    externalChangedFiles: await getChangedFilesForRange(cwd, externalBaseCommit, externalHeadCommit),
  };
}

