import { spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

type SummaryFile = {
  path: string;
  relativePath: string;
};

async function collectSummaryFiles(rootDir: string): Promise<SummaryFile[]> {
  const runEntries = await readdir(rootDir, { withFileTypes: true });
  const files: SummaryFile[] = [];

  for (const entry of runEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runDir = join(rootDir, entry.name);
    const runFiles = await readdir(runDir, { withFileTypes: true });
    for (const runFile of runFiles) {
      if (!runFile.isFile()) {
        continue;
      }

      if (!/^RETROSPECTIVE(?:-|\.md$)/.test(runFile.name)) {
        continue;
      }

      const filePath = join(runDir, runFile.name);
      files.push({
        path: filePath,
        relativePath: relative(rootDir, filePath),
      });
    }
  }

  return files.sort((a, b) => b.relativePath.localeCompare(a.relativePath));
}

async function renderSummaryBundle(rootDir: string) {
  const files = await collectSummaryFiles(rootDir);
  if (files.length === 0) {
    throw new Error(`No retrospectives found under ${rootDir}`);
  }

  const sections: string[] = [];
  for (const file of files) {
    const content = await readFile(file.path, 'utf8');
    sections.push(
      `# ${file.relativePath}`,
      '',
      content.trimEnd(),
      '',
    );
  }

  return sections.join('\n');
}

async function writeToPager(content: string) {
  const pager = (process.env.PAGER || 'less -FRX').trim();
  const [command, ...args] = pager.split(/\s+/);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    child.on('error', rejectPromise);
    child.stdin.write(content);
    child.stdin.end();
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

export async function showSummaries(pathArg?: string) {
  const rootDir = resolve(pathArg ?? '.neal/runs');
  await access(rootDir);
  const content = await renderSummaryBundle(rootDir);

  if (!process.stdout.isTTY) {
    process.stdout.write(content);
    return;
  }

  try {
    await writeToPager(content);
  } catch {
    process.stdout.write(content);
  }
}
