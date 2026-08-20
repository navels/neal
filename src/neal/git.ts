import { execFile, spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

// Git output (diffs, status) scales with scope artifacts — a scope that
// vendors or generates a large file produces a multi-megabyte diff, and
// Node's default execFile maxBuffer (1 MiB) kills the run with
// "stdout maxBuffer length exceeded". 64 MiB clears any realistic scope
// diff while still bounding a runaway.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr.trim() || error.message));
        return;
      }

      resolvePromise(stdout.trim());
    });
  });
}

function runGitOptionalConfig(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise(stdout.trim());
        return;
      }

      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
      if (code === 1 && stdout.trim() === '' && stderr.trim() === '') {
        resolvePromise(null);
        return;
      }

      rejectPromise(new Error(stderr.trim() || error.message));
    });
  });
}

async function getBooleanGitConfig(cwd: string, key: string) {
  const value = await runGitOptionalConfig(['config', '--bool', '--get', key], cwd);
  if (value === null) {
    return null;
  }
  return value === 'true';
}

function runGitWithInput(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      rejectPromise(new Error(stderr.trim() || error.message));
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`git ${args.join(' ')} terminated by signal ${signal}`));
        return;
      }

      if (code === 0) {
        resolvePromise(stdout.trim());
      } else {
        rejectPromise(new Error(stderr.trim() || `git ${args.join(' ')} exited with status ${code}`));
      }
    });

    child.stdin.end(input);
  });
}

function runGitWithInputStatus(args: string[], cwd: string, input: string): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      rejectPromise(new Error(stderr.trim() || error.message));
    });

    child.on('exit', (code, signal) => {
      resolvePromise({
        stdout,
        stderr,
        code: code ?? 0,
        signal,
      });
    });

    child.stdin.end(input);
  });
}

export async function getHeadCommit(cwd: string) {
  return runGit(['rev-parse', 'HEAD'], cwd);
}

export async function getRepositoryRoot(cwd: string) {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

export async function tryGetRepositoryRoot(cwd: string) {
  try {
    const insideWorkTree = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (insideWorkTree !== 'true') {
      return null;
    }
    return await getRepositoryRoot(cwd);
  } catch {
    return null;
  }
}

export async function getGitPath(cwd: string, path: string) {
  const gitPath = await runGit(['rev-parse', '--git-path', path], cwd);
  return isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
}

export type NealDirGitIgnoreStatus =
  | { kind: 'not_git' }
  | { kind: 'ignored'; repoRoot: string }
  | { kind: 'not_ignored'; repoRoot: string; excludePath: string };

export async function getNealDirGitIgnoreStatus(cwd: string): Promise<NealDirGitIgnoreStatus> {
  const repoRoot = await tryGetRepositoryRoot(cwd);
  if (repoRoot === null) {
    return { kind: 'not_git' };
  }

  const ignoredPaths = await getIgnoredPaths(repoRoot, ['.neal/']);
  if (ignoredPaths.includes('.neal/')) {
    return { kind: 'ignored', repoRoot };
  }

  return {
    kind: 'not_ignored',
    repoRoot,
    excludePath: await getGitPath(repoRoot, 'info/exclude'),
  };
}

export async function assertGitRepositoryWithCommit(cwd: string, commandLabel: string) {
  const repositoryMessage =
    `${commandLabel} requires a Git repository with at least one commit. ` +
    'Run `git init` if needed, create an initial commit, then retry.';
  const noInitialCommitMessage =
    `This repository has no commits yet. Create an initial commit before running \`${commandLabel}\`.`;

  try {
    const insideWorkTree = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    if (insideWorkTree !== 'true') {
      throw new Error(repositoryMessage);
    }
  } catch {
    throw new Error(repositoryMessage);
  }

  try {
    await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], cwd);
  } catch {
    throw new Error(noInitialCommitMessage);
  }
}

export async function resolveCommitRef(cwd: string, ref: string) {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
}

export async function isAncestorCommit(cwd: string, ancestor: string, descendant: string) {
  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    execFile('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, maxBuffer: GIT_MAX_BUFFER }, (error, _stdout, stderr) => {
      if (!error) {
        resolvePromise(true);
        return;
      }

      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
      if (code === 1) {
        resolvePromise(false);
        return;
      }

      rejectPromise(new Error(stderr.trim() || error.message));
    });
  });
}

export async function getCommitRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return [];
  }

  const output = await runGit(['rev-list', '--reverse', `${base}..${head}`], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

export async function getDiffStatForRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return '';
  }

  return runGit(['diff', '--stat', `${base}..${head}`], cwd);
}

export async function getDiffForRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return '';
  }

  return runGit(['diff', '--find-renames', `${base}..${head}`], cwd);
}

// Range diff restricted to the given paths. Fixed argv with a `--` separator,
// never a shell string, so a path can never be read as a revision or option.
export async function getDiffForRangePaths(cwd: string, base: string, head: string, paths: readonly string[]) {
  if (base === head || paths.length === 0) {
    return '';
  }

  return runGit(['diff', '--find-renames', `${base}..${head}`, '--', ...paths], cwd);
}

export async function getChangedFilesForRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return [];
  }

  const output = await runGit(['diff', '--name-only', `${base}..${head}`], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

export async function commitTreePathExists(cwd: string, commit: string, path: string) {
  const output = await runGit(['ls-tree', '--name-only', commit, '--', path], cwd);
  return output.split('\n').filter(Boolean).includes(path);
}

export async function getIgnoredPaths(cwd: string, paths: string[]) {
  if (paths.length === 0) {
    return [];
  }

  const result = await runGitWithInputStatus(
    ['check-ignore', '--no-index', '--stdin', '-z'],
    cwd,
    paths.join('\0') + '\0',
  );
  if (result.signal) {
    throw new Error(`git check-ignore terminated by signal ${result.signal}`);
  }
  if (result.code === 1) {
    return [];
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git check-ignore exited with status ${result.code}`);
  }

  return result.stdout.split('\0').filter(Boolean);
}

export type DropIgnoredPathsFromCommitRangeResult = {
  ignoredFiles: string[];
  headCommit: string;
  createdReplacementCommit: boolean;
};

export async function dropIgnoredPathsFromCurrentCommitRange(
  cwd: string,
  baseCommit: string,
  headCommit: string,
): Promise<DropIgnoredPathsFromCommitRangeResult> {
  const changedFiles = await getChangedFilesForRange(cwd, baseCommit, headCommit);
  const ignoredFiles = await getIgnoredPaths(cwd, changedFiles);
  if (ignoredFiles.length === 0) {
    return {
      ignoredFiles: [],
      headCommit,
      createdReplacementCommit: false,
    };
  }

  const currentHead = await getHeadCommit(cwd);
  if (currentHead !== headCommit) {
    throw new Error(`Cannot drop ignored files from commit range because HEAD moved from ${headCommit} to ${currentHead}`);
  }

  const replacementMessage = await getCommitMessage(cwd, headCommit);
  await runGit(['reset', '--soft', baseCommit], cwd);
  await runGit(['reset', '--', ...ignoredFiles], cwd);

  const stagedFiles = await runGit(['diff', '--cached', '--name-only'], cwd);
  if (!stagedFiles) {
    return {
      ignoredFiles,
      headCommit: baseCommit,
      createdReplacementCommit: false,
    };
  }

  await runGitWithInput(
    ['commit', '--no-verify', '-F', '-'],
    cwd,
    replacementMessage.endsWith('\n') ? replacementMessage : `${replacementMessage}\n`,
  );

  return {
    ignoredFiles,
    headCommit: await getHeadCommit(cwd),
    createdReplacementCommit: true,
  };
}

export async function assertNoIgnoredChangedFiles(cwd: string, changedFiles: string[], context: string) {
  const ignoredFiles = await getIgnoredPaths(cwd, changedFiles);
  if (ignoredFiles.length === 0) {
    return;
  }

  throw new Error(
    [
      `${context} would include ignored file(s), which Neal will not commit:`,
      ...ignoredFiles.map((file) => `- ${file}`),
      'Remove those files from the commit or change the ignore rules intentionally before continuing.',
    ].join('\n'),
  );
}

export async function getCommitSubjects(cwd: string, commits: string[]) {
  if (commits.length === 0) {
    return [];
  }

  const output = await runGit(['show', '--quiet', '--format=%H %s', ...commits], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

export async function getCommitMessage(cwd: string, commit: string) {
  return runGit(['show', '--quiet', '--format=%B', commit], cwd);
}

export async function getWorktreeStatus(cwd: string, options: { untrackedFiles?: 'all' } = {}) {
  const args = ['status', '--short'];
  if (options.untrackedFiles === 'all') {
    args.push('--untracked-files=all');
  }
  return runGit(args, cwd);
}

export async function stagePath(cwd: string, path: string) {
  await runGit(['add', '--', path], cwd);
}

export async function getStagedChangedFiles(cwd: string) {
  const output = await runGit(['diff', '--cached', '--name-only'], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

export async function getStagedDiff(cwd: string) {
  return runGit(['diff', '--cached', '--binary'], cwd);
}

export async function commitStagedChanges(cwd: string, message: string) {
  await runGitWithInput(['commit', '--no-verify', '-F', '-'], cwd, message.endsWith('\n') ? message : `${message}\n`);
  return getHeadCommit(cwd);
}

export async function getUnstagedDiff(cwd: string) {
  return runGit(['diff', '--binary'], cwd);
}

export async function getUntrackedFiles(cwd: string) {
  const output = await runGit(['ls-files', '--others', '--exclude-standard'], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

export async function resetHard(cwd: string, target: string) {
  await runGit(['reset', '--hard', target], cwd);
}

export async function restoreWorktreePaths(cwd: string, paths: string[]) {
  if (paths.length === 0) {
    return;
  }
  await runGit(['restore', '--staged', '--worktree', '--', ...paths], cwd);
}

export async function createSquashReplacementCommit(cwd: string, baseCommit: string, finalCommit: string, message: string) {
  const args = ['commit-tree', `${finalCommit}^{tree}`, '-p', baseCommit];
  if (await getBooleanGitConfig(cwd, 'commit.gpgsign')) {
    args.push('-S');
  }
  args.push('-F', '-');

  return runGitWithInput(
    args,
    cwd,
    message.endsWith('\n') ? message : `${message}\n`,
  );
}

export async function rebaseCurrentBranchOnto(cwd: string, newBase: string, upstream: string) {
  await runGit(['rebase', '--onto', newBase, upstream], cwd);
}

export async function cleanUntracked(cwd: string, excludedPaths: string[] = []) {
  const args = ['clean', '-fd'];
  for (const path of excludedPaths) {
    args.push('-e', path);
  }

  await runGit(args, cwd);
}

export async function cleanUntrackedPaths(cwd: string, paths: string[]) {
  if (paths.length === 0) {
    return;
  }
  await runGit(['clean', '-fd', '--', ...paths], cwd);
}

export async function squashCommits(cwd: string, baseCommit: string, message: string) {
  await runGit(['reset', '--soft', baseCommit], cwd);
  await runGitWithInput(['commit', '--no-verify', '-F', '-'], cwd, message.endsWith('\n') ? message : `${message}\n`);
  return getHeadCommit(cwd);
}
