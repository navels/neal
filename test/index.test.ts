import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildUsageLines, parseNewRunArgs } from '../src/neal/cli.js';
import { loadOrInitialize } from '../src/neal/orchestrator.js';
import { getDefaultAgentConfig } from '../src/neal/state.js';
import { resolveExecuteInput } from '../src/neal/input-source.js';

const execFileAsync = promisify(execFile);
process.env.HOME = join(tmpdir(), 'neal-test-home-index');

async function runNealCliResult(...args: string[]) {
  return runNealCliResultInCwd(process.cwd(), ...args);
}

async function runNealCliResultInCwd(cwd: string, ...args: string[]) {
  return execFileAsync('pnpm', ['--dir', process.cwd(), 'exec', 'tsx', 'src/neal/index.ts', ...args], { cwd });
}

async function runGit(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function runNealCliFailure(...args: string[]) {
  try {
    await runNealCliResult(...args);
    throw new Error(`Expected failure for args: ${args.join(' ')}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: execError.code ?? 1,
    };
  }
}

async function runNealCliFailureInCwd(cwd: string, ...args: string[]) {
  try {
    await runNealCliResultInCwd(cwd, ...args);
    throw new Error(`Expected failure for args: ${args.join(' ')}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: execError.code ?? 1,
    };
  }
}

test('parseNewRunArgs treats bare --execute as default file mode', () => {
  const parsed = parseNewRunArgs(['--execute', 'plans/PLAN.md'], getDefaultAgentConfig());
  assert.equal(parsed.topLevelMode, 'execute');
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'file_default',
    value: 'plans/PLAN.md',
  });
});

test('parseNewRunArgs supports explicit execute file mode', () => {
  const parsed = parseNewRunArgs(['--execute-file', 'plans/PLAN.md'], getDefaultAgentConfig());
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'file_explicit',
    value: 'plans/PLAN.md',
  });
});

test('parseNewRunArgs supports explicit execute text mode', () => {
  const parsed = parseNewRunArgs(['--execute-text', '# Plan'], getDefaultAgentConfig());
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'text_explicit',
    value: '# Plan',
  });
});

test('parseNewRunArgs allows execute-text values that begin with --', () => {
  const parsed = parseNewRunArgs(['--execute-text', '--foo bar'], getDefaultAgentConfig());
  assert.deepEqual(parsed.executeInputSource, {
    mode: 'text_explicit',
    value: '--foo bar',
  });
});

test('parseNewRunArgs rejects empty execute-text values directly', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute-text', ''], getDefaultAgentConfig()),
    /--execute-text requires a non-empty inline plan string argument/,
  );
});

test('parseNewRunArgs rejects conflicting execute-input flags', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute', 'plans/PLAN.md', '--execute-text', '# Plan'], getDefaultAgentConfig()),
    /Choose exactly one execute input source/,
  );
});

test('parseNewRunArgs rejects mixed top-level plan and execute modes consistently', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute-text', '# Plan', '--plan', 'PLAN.md'], getDefaultAgentConfig()),
    /Choose exactly one execute input source/,
  );
});

test('parseNewRunArgs rejects missing execute-file values before option parsing continues', () => {
  assert.throws(
    () => parseNewRunArgs(['--execute-file', '--coder-model', 'gpt-5.4'], getDefaultAgentConfig()),
    /--execute-file requires a plan file path argument/,
  );
});

test('buildUsageLines documents the execute input modes clearly', () => {
  const usage = buildUsageLines().join('\n');
  assert.match(usage, /--execute <plan-doc>.*default file mode/);
  assert.match(usage, /--execute-file <plan-doc>.*explicit file mode/);
  assert.match(usage, /--execute-text "<plan markdown>"/);
});

test('resolveExecuteInput keeps file mode on the provided plan path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-file-'));
  const planDoc = join(cwd, 'PLAN.md');
  await writeFile(planDoc, '# Plan\n', 'utf8');

  const resolved = await resolveExecuteInput({ mode: 'file_explicit', value: 'PLAN.md' }, cwd);
  assert.equal(resolved.planDoc, planDoc);
  assert.equal(resolved.runDir, undefined);
});

test('resolveExecuteInput materializes text mode into a run-owned plan artifact', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-text-'));
  const resolved = await resolveExecuteInput(
    {
      mode: 'text_explicit',
      value: '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    },
    cwd,
  );

  assert.ok(resolved.runDir);
  assert.match(resolved.planDoc, /\.neal\/runs\/[^/]+\/INLINE_EXECUTE_PLAN\.md$/);
  assert.equal(resolved.planDoc, join(resolved.runDir!, 'INLINE_EXECUTE_PLAN.md'));
  await access(resolved.planDoc);
  assert.equal(await readFile(resolved.planDoc, 'utf8'), '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n');
});

test('text-mode bootstrap records the materialized inline plan path in state and run artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neal-index-bootstrap-'));
  const cwd = join(root, 'repo');
  await runGit(root, 'init', 'repo');
  await runGit(cwd, 'config', 'user.name', 'Neal Test');
  await runGit(cwd, 'config', 'user.email', 'neal@example.com');
  await runGit(cwd, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README.md'), 'bootstrap\n', 'utf8');
  await runGit(cwd, 'add', 'README.md');
  await runGit(cwd, 'commit', '-m', 'base commit');

  const resolved = await resolveExecuteInput(
    {
      mode: 'text_explicit',
      value: '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
    },
    cwd,
  );

  const loaded = await loadOrInitialize(
    resolved.planDoc,
    cwd,
    getDefaultAgentConfig(),
    undefined,
    'execute',
    { runDir: resolved.runDir },
  );

  assert.equal(loaded.state.planDoc, resolved.planDoc);
  assert.equal(loaded.state.runDir, resolved.runDir);
  assert.equal(loaded.logger.runDir, resolved.runDir);

  const meta = JSON.parse(await readFile(join(resolved.runDir!, 'meta.json'), 'utf8')) as {
    planDoc: string;
    runDir: string;
  };
  assert.equal(meta.planDoc, resolved.planDoc);
  assert.equal(meta.runDir, resolved.runDir);

  const persistedState = JSON.parse(await readFile(loaded.statePath, 'utf8')) as {
    planDoc: string;
    runDir: string;
  };
  assert.equal(persistedState.planDoc, resolved.planDoc);
  assert.equal(persistedState.runDir, resolved.runDir);
});

test('execute startup cleans up a materialized inline run directory when initialization fails', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'neal-index-cleanup-'));
  const result = await runNealCliFailureInCwd(
    cwd,
    '--execute-text',
    '# Inline Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n',
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot start neal --execute with a dirty worktree|fatal|not a git repository/i);
  await assert.rejects(access(join(cwd, '.neal', 'runs')));
  const nealEntries = await readdir(join(cwd, '.neal')).catch(() => []);
  assert.deepEqual(nealEntries, []);
});

test('neal usage output documents execute-file and execute-text', async () => {
  const result = await runNealCliFailure();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--execute <plan-doc>.*default file mode/);
  assert.match(result.stderr, /--execute-file <plan-doc>/);
  assert.match(result.stderr, /--execute-text "<plan markdown>"/);
});

test('neal rejects an empty execute-text argument clearly', async () => {
  const result = await runNealCliFailure('--execute-text', '');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--execute-text requires a non-empty inline plan string argument/);
});

test('neal rejects a missing execute-file argument clearly', async () => {
  const result = await runNealCliFailure('--execute-file', '--coder-model', 'gpt-5.4');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--execute-file requires a plan file path argument/);
});

test('neal rejects conflicting execute-input source flags clearly', async () => {
  const result = await runNealCliFailure('--execute', 'PLAN.md', '--execute-text', '# Plan');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Choose exactly one execute input source: --execute, --execute-file, or --execute-text/);
});

test('neal rejects mixed top-level plan and execute modes clearly regardless of ordering', async () => {
  const result = await runNealCliFailure('--execute-text', '# Plan', '--plan', 'PLAN.md');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Choose exactly one execute input source: --execute, --execute-file, or --execute-text/);
});

test('neal points file-mode misses at execute-text explicitly', async () => {
  const result = await runNealCliFailure('--execute-file', 'missing-plan.md');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /File mode requires an existing plan file path: missing-plan\.md/);
  assert.match(result.stderr, /Did you mean --execute-text\?/);
});
