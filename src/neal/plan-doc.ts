import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { getIgnoredPaths, getRepositoryRoot } from './git.js';

/**
 * Run a destructive worktree action (reset --hard / clean) while preserving
 * the plan document's byte content across it. The plan doc is a wrapper-owned
 * overlay by contract: it may be an uncommitted modification of a TRACKED file
 * (reset --hard would silently restore the committed content — a different
 * plan — mid-run) or an untracked file (clean would delete it). Either way the
 * run's plan must survive worktree hygiene. Restores nothing if the plan doc
 * did not exist before the action.
 */
export async function withPlanDocPreserved<T>(
  planDoc: string,
  action: () => Promise<T>,
): Promise<T> {
  let content: Buffer | null = null;
  try {
    content = await readFile(planDoc);
  } catch {
    content = null;
  }
  const result = await action();
  if (content !== null) {
    await writeFile(planDoc, content);
  }
  return result;
}

export type PlanDocDisposition =
  | 'included'
  | 'present_in_replacement_tree'
  | 'metadata_only_clean'
  | 'ignored'
  | 'outside_repo'
  | 'missing'
  | 'not_regular_file';

export type InspectPlanDocDispositionOptions = {
  changedFiles?: string[];
};

export type PlanDocInspection = {
  selectedPlanDoc: string;
  absolutePlanDoc: string;
  repositoryRoot: string;
  repoRelativePath: string | null;
  normalizedPlanDoc: string;
  disposition: PlanDocDisposition;
  eligibleForCommit: boolean;
  exists: boolean;
  isRegularFile: boolean;
  ignored: boolean;
};

export type PlanDocMetadata = {
  selectedPlanDoc: string;
  normalizedPlanDoc: string;
  planDocDisposition: PlanDocDisposition;
  repoRelativePath: string | null;
  eligibleForCommit: boolean;
};

export async function inspectPlanDocDisposition(
  cwd: string,
  planDoc: string,
  options: InspectPlanDocDispositionOptions = {},
): Promise<PlanDocInspection> {
  const repositoryRoot = await realpath(await getRepositoryRoot(cwd));
  const absolutePlanDoc = resolve(cwd, planDoc);
  const comparablePlanDoc = await resolvePathForRepositoryComparison(absolutePlanDoc);
  const selectedPlanDoc = absolutePlanDoc;

  if (!isPathInside(repositoryRoot, comparablePlanDoc)) {
    const fileStatus = await getFileStatus(absolutePlanDoc);
    return {
      selectedPlanDoc,
      absolutePlanDoc,
      repositoryRoot,
      repoRelativePath: null,
      normalizedPlanDoc: absolutePlanDoc,
      disposition: 'outside_repo',
      eligibleForCommit: false,
      exists: fileStatus !== 'missing',
      isRegularFile: fileStatus === 'regular_file',
      ignored: false,
    };
  }

  const repoRelativePath = toRepoRelativePath(repositoryRoot, comparablePlanDoc);
  const normalizedPlanDoc = repoRelativePath;
  const fileStatus = await getFileStatus(absolutePlanDoc);
  if (fileStatus === 'missing') {
    return {
      selectedPlanDoc,
      absolutePlanDoc,
      repositoryRoot,
      repoRelativePath,
      normalizedPlanDoc,
      disposition: 'missing',
      eligibleForCommit: false,
      exists: false,
      isRegularFile: false,
      ignored: false,
    };
  }

  if (fileStatus !== 'regular_file') {
    return {
      selectedPlanDoc,
      absolutePlanDoc,
      repositoryRoot,
      repoRelativePath,
      normalizedPlanDoc,
      disposition: 'not_regular_file',
      eligibleForCommit: false,
      exists: true,
      isRegularFile: false,
      ignored: false,
    };
  }

  const ignoredPaths = await getIgnoredPaths(repositoryRoot, [repoRelativePath]);
  const ignored = ignoredPaths.includes(repoRelativePath);
  if (ignored) {
    return {
      selectedPlanDoc,
      absolutePlanDoc,
      repositoryRoot,
      repoRelativePath,
      normalizedPlanDoc,
      disposition: 'ignored',
      eligibleForCommit: false,
      exists: true,
      isRegularFile: true,
      ignored: true,
    };
  }

  const changedFiles = new Set(
    (options.changedFiles ?? []).map((changedFile) => normalizeChangedFilePath(repositoryRoot, changedFile)),
  );
  const disposition: PlanDocDisposition = changedFiles.has(repoRelativePath) ? 'included' : 'metadata_only_clean';

  return {
    selectedPlanDoc,
    absolutePlanDoc,
    repositoryRoot,
    repoRelativePath,
    normalizedPlanDoc,
    disposition,
    eligibleForCommit: true,
    exists: true,
    isRegularFile: true,
    ignored: false,
  };
}

export function toPlanDocMetadata(inspection: PlanDocInspection): PlanDocMetadata {
  return {
    selectedPlanDoc: inspection.selectedPlanDoc,
    normalizedPlanDoc: inspection.normalizedPlanDoc,
    planDocDisposition: inspection.disposition,
    repoRelativePath: inspection.repoRelativePath,
    eligibleForCommit: inspection.eligibleForCommit,
  };
}

function isPathInside(parent: string, child: string) {
  const relativePath = relative(parent, child);
  return (
    relativePath === '' ||
    (
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath)
    )
  );
}

function toRepoRelativePath(repositoryRoot: string, path: string) {
  const relativePath = relative(repositoryRoot, path);
  return toGitPath(relativePath === '' ? '.' : normalize(relativePath));
}

function normalizeChangedFilePath(repositoryRoot: string, path: string) {
  const absolutePath = isAbsolute(path) ? resolve(path) : null;
  if (absolutePath && isPathInside(repositoryRoot, absolutePath)) {
    return toRepoRelativePath(repositoryRoot, absolutePath);
  }

  return toGitPath(normalize(path));
}

function toGitPath(path: string) {
  return path.split(sep).join('/');
}

async function getFileStatus(path: string): Promise<'regular_file' | 'not_regular_file' | 'missing'> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile() ? 'regular_file' : 'not_regular_file';
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }
}

async function resolvePathForRepositoryComparison(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = path;

  while (true) {
    try {
      const existingPath = await realpath(currentPath);
      return missingSegments.length === 0 ? existingPath : join(existingPath, ...missingSegments.reverse());
    } catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT')) {
        throw error;
      }
      const parent = dirname(currentPath);
      if (parent === currentPath) {
        return path;
      }
      missingSegments.push(basename(currentPath));
      currentPath = parent;
    }
  }
}

function isNodeErrorWithCode(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
