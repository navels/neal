import { execFile, spawn } from 'node:child_process';

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr.trim() || error.message));
        return;
      }

      resolvePromise(stdout.trim());
    });
  });
}

function runGitWithInput(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, {
      cwd,
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

export async function getHeadCommit(cwd: string) {
  return runGit(['rev-parse', 'HEAD'], cwd);
}

export async function getCommitRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return [];
  }

  const output = await runGit(['rev-list', '--reverse', `${base}..${head}`], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

export async function getDiffForRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return '';
  }

  return runGit(['diff', '--stat', '--patch', `${base}..${head}`], cwd);
}

export async function getDiffStatForRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return '';
  }

  return runGit(['diff', '--stat', `${base}..${head}`], cwd);
}

export async function getChangedFilesForRange(cwd: string, base: string, head: string) {
  if (base === head) {
    return [];
  }

  const output = await runGit(['diff', '--name-only', `${base}..${head}`], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
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

export async function getWorktreeStatus(cwd: string) {
  return runGit(['status', '--short'], cwd);
}

export async function squashCommits(cwd: string, baseCommit: string, message: string) {
  await runGit(['reset', '--soft', baseCommit], cwd);
  await runGitWithInput(['commit', '-F', '-'], cwd, message.endsWith('\n') ? message : `${message}\n`);
  return getHeadCommit(cwd);
}
