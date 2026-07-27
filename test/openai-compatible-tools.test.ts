/**
 * Deterministic tests for the openai-compatible tool layer
 * (src/neal/providers/openai-compatible-tools.ts): jail enforcement (lexical
 * and symlink), result truncation, errors-as-results semantics, the
 * event-emission hook grammar (tool_started / tool_progress /
 * command_completed / file_changed with per-tool error attribution), and the
 * role-scoped toolset factories. Hermetic: temp dirs only, no network, no
 * API keys.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { generateText, stepCountIs, type ToolExecutionOptions } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { z } from 'zod';

import {
  GREP_MAX_MATCHING_LINES,
  RESULT_BYTE_LIMIT,
  createCoderToolset,
  createPlanAuthorToolset,
  createReadOnlyToolset,
  isToolErrorResult,
  resolveJailedPath,
  truncateResult,
  type OpenAICompatibleToolEvent,
} from '../src/neal/providers/openai-compatible-tools.js';

const execFileAsync = promisify(execFile);

const callOptions = { toolCallId: 'test-call', messages: [] } as unknown as ToolExecutionOptions<never>;

/**
 * Invokes a tool's execute the way the SDK loop would and asserts the result
 * is a plain string (these tools never stream).
 */
async function callTool<INPUT>(
  toolDefinition: { execute?: (input: INPUT, options: ToolExecutionOptions<never>) => unknown },
  input: INPUT,
): Promise<string> {
  assert.ok(toolDefinition.execute, 'tool has no execute function');
  const result = await toolDefinition.execute(input, callOptions);
  assert.equal(typeof result, 'string', 'tool result must be a string');
  return result as string;
}

describe('resolveJailedPath', () => {
  const root = '/jail/root';

  it('rejects absolute paths', () => {
    assert.throws(() => resolveJailedPath(root, '/etc/passwd'), /absolute paths are not allowed/);
  });

  it('rejects .. escapes', () => {
    assert.throws(() => resolveJailedPath(root, '../outside.txt'), /escapes the working directory/);
    assert.throws(
      () => resolveJailedPath(root, 'a/../../outside.txt'),
      /escapes the working directory/,
    );
  });

  it('rejects sibling-prefix escapes', () => {
    assert.throws(
      () => resolveJailedPath(root, '../root-sibling/file.txt'),
      /escapes the working directory/,
    );
  });

  it('resolves in-jail paths, including the root itself', () => {
    assert.equal(resolveJailedPath(root, 'src/app.js'), path.join(root, 'src', 'app.js'));
    assert.equal(resolveJailedPath(root, '.'), path.resolve(root));
    assert.equal(resolveJailedPath(root, 'a/../b.txt'), path.join(root, 'b.txt'));
  });
});

describe('truncateResult', () => {
  it('returns short results unchanged', () => {
    assert.equal(truncateResult('short'), 'short');
  });

  it('caps oversized results with the explicit marker', () => {
    const size = RESULT_BYTE_LIMIT + 100;
    const result = truncateResult('a'.repeat(size));
    assert.ok(result.endsWith(`[truncated: showing ${RESULT_BYTE_LIMIT} of ${size} bytes]`));
  });
});

describe('coder tool layer', () => {
  let rootDir: string;
  let tools: ReturnType<typeof createCoderToolset>;

  before(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-tools-'));
    tools = createCoderToolset(rootDir, { runTimeoutMs: 500 });
  });

  after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('read_file rejects an oversized file as an error result', async () => {
    await fs.writeFile(path.join(rootDir, 'big.txt'), 'x'.repeat(300 * 1024));
    const result = await callTool(tools.read_file, { path: 'big.txt' });
    assert.ok(isToolErrorResult(result), `expected error result, got: ${result.slice(0, 100)}`);
    assert.match(result, /file too large/);
  });

  it('read_file rejects a binary file as an error result', async () => {
    await fs.writeFile(path.join(rootDir, 'blob.bin'), Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    const result = await callTool(tools.read_file, { path: 'blob.bin' });
    assert.ok(isToolErrorResult(result));
    assert.match(result, /binary file/);
  });

  it('read_file returns text content and write_file creates parent dirs', async () => {
    const written = await callTool(tools.write_file, {
      path: 'nested/deep/file.txt',
      content: 'hello provider\n',
    });
    assert.ok(!isToolErrorResult(written), written);
    const result = await callTool(tools.read_file, { path: 'nested/deep/file.txt' });
    assert.equal(result, 'hello provider\n');
  });

  it('read_file surfaces jail violations as error results, not throws', async () => {
    const result = await callTool(tools.read_file, { path: '../outside.txt' });
    assert.ok(isToolErrorResult(result));
    assert.match(result, /escapes the working directory/);
  });

  it('edit_file errors on zero matches', async () => {
    await fs.writeFile(path.join(rootDir, 'edit-zero.txt'), 'alpha beta gamma\n');
    const result = await callTool(tools.edit_file, {
      path: 'edit-zero.txt',
      old: 'delta',
      new: 'epsilon',
    });
    assert.ok(isToolErrorResult(result));
    assert.match(result, /no match/);
    assert.equal(
      await fs.readFile(path.join(rootDir, 'edit-zero.txt'), 'utf8'),
      'alpha beta gamma\n',
    );
  });

  it('edit_file errors on multiple matches, stating the count', async () => {
    await fs.writeFile(path.join(rootDir, 'edit-multi.txt'), 'dup dup dup\n');
    const result = await callTool(tools.edit_file, {
      path: 'edit-multi.txt',
      old: 'dup',
      new: 'one',
    });
    assert.ok(isToolErrorResult(result));
    assert.match(result, /matches 3 times/);
    assert.equal(
      await fs.readFile(path.join(rootDir, 'edit-multi.txt'), 'utf8'),
      'dup dup dup\n',
    );
  });

  it('edit_file succeeds on a unique match', async () => {
    await fs.writeFile(path.join(rootDir, 'edit-ok.txt'), 'keep CHANGE keep\n');
    const result = await callTool(tools.edit_file, {
      path: 'edit-ok.txt',
      old: 'CHANGE',
      new: 'CHANGED',
    });
    assert.ok(!isToolErrorResult(result), result);
    assert.equal(
      await fs.readFile(path.join(rootDir, 'edit-ok.txt'), 'utf8'),
      'keep CHANGED keep\n',
    );
  });

  it('write policy allows only configured write paths', async () => {
    const scopedTools = createCoderToolset(rootDir, {
      allowedWritePaths: [path.join(rootDir, 'PLAN.md')],
      runTimeoutMs: 500,
    });

    const planWrite = await callTool(scopedTools.write_file, {
      path: 'PLAN.md',
      content: '# Plan\n',
    });
    assert.ok(!isToolErrorResult(planWrite), planWrite);

    const codeWrite = await callTool(scopedTools.write_file, {
      path: 'src/changed.ts',
      content: 'export const changed = true;\n',
    });
    assert.ok(isToolErrorResult(codeWrite), codeWrite);
    assert.match(codeWrite, /write access denied for src\/changed\.ts/);
    await assert.rejects(() => fs.stat(path.join(rootDir, 'src', 'changed.ts')), /ENOENT/);
  });

  it('write policy rejects edit_file outside configured write paths before mutation', async () => {
    await fs.writeFile(path.join(rootDir, 'code.ts'), 'const value = 1;\n');
    const scopedTools = createCoderToolset(rootDir, {
      allowedWritePaths: ['PLAN.md'],
      runTimeoutMs: 500,
    });

    const result = await callTool(scopedTools.edit_file, {
      path: 'code.ts',
      old: '1',
      new: '2',
    });

    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /write access denied for code\.ts/);
    assert.equal(await fs.readFile(path.join(rootDir, 'code.ts'), 'utf8'), 'const value = 1;\n');
  });

  it('run can be disabled for write-scoped planning phases', async () => {
    const scopedTools = createCoderToolset(rootDir, {
      allowRun: false,
      runTimeoutMs: 500,
    });

    const result = await callTool(scopedTools.run, { command: 'echo should-not-run' });

    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /shell commands are disabled in this phase/);
    assert.doesNotMatch(result, /should-not-run/);
  });

  it('list_dir marks directories with a trailing slash', async () => {
    await fs.mkdir(path.join(rootDir, 'listing', 'sub'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'listing', 'plain.txt'), 'x');
    const result = await callTool(tools.list_dir, { path: 'listing' });
    const entries = result.split('\n');
    assert.ok(entries.includes('sub/'), result);
    assert.ok(entries.includes('plain.txt'), result);
  });

  it('grep output is capped at 200 matching lines', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `needle line ${i}`).join('\n');
    await fs.mkdir(path.join(rootDir, 'grepdir'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'grepdir', 'haystack.txt'), lines);
    const result = await callTool(tools.grep, { pattern: 'needle', path: 'grepdir' });
    const matching = result.split('\n').filter((line) => line.includes('needle line'));
    assert.equal(matching.length, GREP_MAX_MATCHING_LINES);
    assert.match(result, /\[grep output capped at 200 matching lines\]/);
  });

  it('grep defaults to the root and reports file:line matches', async () => {
    await fs.writeFile(path.join(rootDir, 'grep-target.txt'), 'first\nunique-marker-xyz\nlast\n');
    const result = await callTool(tools.grep, { pattern: 'unique-marker-xyz' });
    assert.match(result, /grep-target\.txt:2:unique-marker-xyz/);
  });

  it('run surfaces a non-zero exit code in the result', async () => {
    const result = await callTool(tools.run, { command: 'echo out; echo err >&2; exit 7' });
    assert.match(result, /exit code: 7/);
    assert.match(result, /stdout:\nout\n/);
    assert.match(result, /stderr:\nerr\n/);
  });

  it('run surfaces exit code 0 on success', async () => {
    const result = await callTool(tools.run, { command: 'echo fine' });
    assert.match(result, /exit code: 0/);
    assert.match(result, /stdout:\nfine\n/);
  });

  it('run enforces its timeout and reports it explicitly', async () => {
    const result = await callTool(tools.run, { command: 'sleep 5' });
    assert.match(result, /timed out after 500ms/);
  });

  it('a >16 KiB tool result is truncated with the marker', async () => {
    const size = 20 * 1024;
    await fs.writeFile(path.join(rootDir, 'long.txt'), 'a'.repeat(size));
    const result = await callTool(tools.read_file, { path: 'long.txt' });
    assert.ok(
      result.endsWith(`[truncated: showing ${RESULT_BYTE_LIMIT} of ${size} bytes]`),
      `unexpected tail: ...${result.slice(-80)}`,
    );
    assert.ok(Buffer.byteLength(result, 'utf8') < size, 'result was not actually truncated');
  });
});

describe('symlink jail escapes', () => {
  let rootDir: string;
  let outsideDir: string;
  let tools: ReturnType<typeof createCoderToolset>;
  const outsideSecret = 'outside secret content\n';

  before(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-jail-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-outside-'));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), outsideSecret);
    // symlink inside the jail pointing at a directory outside it
    await fs.symlink(outsideDir, path.join(rootDir, 'sneaky-dir'));
    // symlink inside the jail pointing at a file outside it
    await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(rootDir, 'sneaky-file'));
    // symlink inside the jail pointing at a file inside it (positive control)
    await fs.writeFile(path.join(rootDir, 'insider.txt'), 'inside content\n');
    await fs.symlink(path.join(rootDir, 'insider.txt'), path.join(rootDir, 'inside-link'));
    tools = createCoderToolset(rootDir, { runTimeoutMs: 500 });
  });

  after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it('read_file refuses a symlinked file that escapes the jail', async () => {
    const result = await callTool(tools.read_file, { path: 'sneaky-file' });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
  });

  it('read_file refuses a path traversing a symlinked directory out of the jail', async () => {
    const result = await callTool(tools.read_file, { path: 'sneaky-dir/secret.txt' });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
  });

  it('list_dir refuses a symlinked directory that escapes the jail', async () => {
    const result = await callTool(tools.list_dir, { path: 'sneaky-dir' });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
  });

  it('grep refuses a start path that escapes the jail through a symlink', async () => {
    const result = await callTool(tools.grep, { pattern: 'secret', path: 'sneaky-dir' });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
  });

  it('edit_file refuses an escaping symlink and leaves the outside file untouched', async () => {
    const result = await callTool(tools.edit_file, {
      path: 'sneaky-file',
      old: 'outside secret',
      new: 'mutated',
    });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
    assert.equal(await fs.readFile(path.join(outsideDir, 'secret.txt'), 'utf8'), outsideSecret);
  });

  it('write_file refuses to create files under a symlinked directory outside the jail', async () => {
    const result = await callTool(tools.write_file, {
      path: 'sneaky-dir/new-file.txt',
      content: 'escaped',
    });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
    await assert.rejects(fs.access(path.join(outsideDir, 'new-file.txt')));
  });

  it('write_file refuses to write through an escaping final-path symlink', async () => {
    const result = await callTool(tools.write_file, {
      path: 'sneaky-file',
      content: 'overwritten',
    });
    assert.ok(isToolErrorResult(result), result);
    assert.match(result, /escapes the working directory via symlink/);
    assert.equal(await fs.readFile(path.join(outsideDir, 'secret.txt'), 'utf8'), outsideSecret);
  });

  it('still allows symlinks that stay inside the jail', async () => {
    const readResult = await callTool(tools.read_file, { path: 'inside-link' });
    assert.equal(readResult, 'inside content\n');
    const writeResult = await callTool(tools.write_file, {
      path: 'inside-link',
      content: 'updated inside\n',
    });
    assert.ok(!isToolErrorResult(writeResult), writeResult);
    assert.equal(await fs.readFile(path.join(rootDir, 'insider.txt'), 'utf8'), 'updated inside\n');
  });

  it('grep recursion does not traverse symlinked directories', async () => {
    // the walk skips symlinks entirely, so the outside secret never appears
    const result = await callTool(tools.grep, { pattern: 'outside secret' });
    assert.ok(!result.includes('secret.txt'), result);
  });
});

describe('event-emission hook', () => {
  let rootDir: string;
  let events: OpenAICompatibleToolEvent[];
  let tools: ReturnType<typeof createCoderToolset>;

  before(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-events-'));
    events = [];
    tools = createCoderToolset(rootDir, {
      runTimeoutMs: 500,
      emitToolEvent: (event) => {
        events.push(event);
      },
    });
  });

  after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function eventsOf(slice: OpenAICompatibleToolEvent[], type: OpenAICompatibleToolEvent['type']) {
    return slice.filter((event) => event.type === type);
  }

  /** Runs a tool call and returns just the events it emitted, in order. */
  async function capture<INPUT>(
    toolDefinition: { execute?: (input: INPUT, options: ToolExecutionOptions<never>) => unknown },
    input: INPUT,
  ): Promise<{ result: string; emitted: OpenAICompatibleToolEvent[] }> {
    const start = events.length;
    const result = await callTool(toolDefinition, input);
    return { result, emitted: events.slice(start) };
  }

  it('error results produce tool_started then tool_progress with toolName and isError true', async () => {
    const { result, emitted } = await capture(tools.read_file, { path: '../outside.txt' });
    assert.ok(isToolErrorResult(result));
    assert.deepEqual(
      emitted.map((event) => event.type),
      ['tool_started', 'tool_progress'],
    );
    assert.equal(emitted[0].toolName, 'read_file');
    const progress = emitted[1];
    assert.ok(progress.type === 'tool_progress');
    assert.equal(progress.toolName, 'read_file');
    assert.equal(progress.isError, true);
    assert.match(progress.message, /escapes the working directory/);
  });

  it('attributes errors to each failing tool by name', async () => {
    await fs.writeFile(path.join(rootDir, 'attr.txt'), 'alpha\n');
    const cases: Array<{ tool: keyof typeof tools; input: unknown }> = [
      { tool: 'edit_file', input: { path: 'attr.txt', old: 'missing', new: 'x' } },
      { tool: 'list_dir', input: { path: 'no-such-dir' } },
      { tool: 'grep', input: { pattern: '(', path: undefined } },
    ];
    for (const testCase of cases) {
      const { result, emitted } = await capture(
        tools[testCase.tool] as { execute?: (input: unknown, options: ToolExecutionOptions<never>) => unknown },
        testCase.input,
      );
      assert.ok(isToolErrorResult(result), `${testCase.tool}: ${result.slice(0, 80)}`);
      const errorProgress = eventsOf(emitted, 'tool_progress').filter(
        (event) => event.type === 'tool_progress' && event.isError,
      );
      assert.equal(errorProgress.length, 1, `${testCase.tool} emitted ${errorProgress.length} error events`);
      assert.equal(errorProgress[0].toolName, testCase.tool);
    }
  });

  it('successful reads produce tool_progress with isError false', async () => {
    await fs.writeFile(path.join(rootDir, 'ok.txt'), 'fine\n');
    const { emitted } = await capture(tools.read_file, { path: 'ok.txt' });
    assert.deepEqual(
      emitted.map((event) => event.type),
      ['tool_started', 'tool_progress'],
    );
    const progress = emitted[1];
    assert.ok(progress.type === 'tool_progress');
    assert.equal(progress.isError, false);
    assert.match(progress.message, /read ok\.txt \(5 bytes\)/);
  });

  it('write_file emits file_changed with a one-element jail-relative files array', async () => {
    const { emitted } = await capture(tools.write_file, {
      path: 'evt/sub/../target.txt',
      content: 'written\n',
    });
    const changed = eventsOf(emitted, 'file_changed');
    assert.equal(changed.length, 1);
    assert.ok(changed[0].type === 'file_changed');
    assert.deepEqual(changed[0].files, [path.join('evt', 'target.txt')]);
    assert.equal(changed[0].toolName, 'write_file');
    // the success summary still arrives as tool_progress
    const progress = eventsOf(emitted, 'tool_progress');
    assert.equal(progress.length, 1);
    assert.ok(progress[0].type === 'tool_progress' && progress[0].isError === false);
  });

  it('edit_file emits file_changed on success and no file_changed on failure', async () => {
    await fs.writeFile(path.join(rootDir, 'evt-edit.txt'), 'before\n');
    const success = await capture(tools.edit_file, {
      path: 'evt-edit.txt',
      old: 'before',
      new: 'after',
    });
    const changed = eventsOf(success.emitted, 'file_changed');
    assert.equal(changed.length, 1);
    assert.ok(changed[0].type === 'file_changed');
    assert.deepEqual(changed[0].files, ['evt-edit.txt']);
    assert.equal(changed[0].toolName, 'edit_file');

    const failure = await capture(tools.edit_file, {
      path: 'evt-edit.txt',
      old: 'never-present',
      new: 'x',
    });
    assert.ok(isToolErrorResult(failure.result));
    assert.equal(eventsOf(failure.emitted, 'file_changed').length, 0);
  });

  it('run emits command_completed with command, exit code, output, and cwd', async () => {
    const { emitted } = await capture(tools.run, { command: 'echo evt-out; exit 7' });
    assert.deepEqual(
      emitted.map((event) => event.type),
      ['tool_started', 'command_completed'],
    );
    const completed = emitted[1];
    assert.ok(completed.type === 'command_completed');
    assert.equal(completed.toolName, 'run');
    assert.equal(completed.command, 'echo evt-out; exit 7');
    assert.equal(completed.exitCode, 7);
    assert.match(completed.output, /stdout:\nevt-out\n/);
    assert.equal(completed.cwd, path.resolve(rootDir));
  });

  it('run reports a null exit code via command_completed when the timeout kills it', async () => {
    const { emitted } = await capture(tools.run, { command: 'sleep 5' });
    const completed = eventsOf(emitted, 'command_completed');
    assert.equal(completed.length, 1);
    assert.ok(completed[0].type === 'command_completed');
    assert.equal(completed[0].exitCode, null);
    assert.match(completed[0].output, /timed out after 500ms/);
  });

  it('a throwing emitter never breaks tool execution', async () => {
    const throwingTools = createCoderToolset(rootDir, {
      runTimeoutMs: 500,
      emitToolEvent: () => {
        throw new Error('emitter exploded');
      },
    });
    await fs.writeFile(path.join(rootDir, 'hook-safe.txt'), 'safe\n');
    const result = await callTool(throwingTools.read_file, { path: 'hook-safe.txt' });
    assert.equal(result, 'safe\n');
  });
});

describe('role-scoped toolsets', () => {
  it('the coder toolset contains exactly the six tools', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-roles-'));
    try {
      const tools = createCoderToolset(rootDir);
      assert.deepEqual(Object.keys(tools).sort(), [
        'edit_file',
        'grep',
        'list_dir',
        'read_file',
        'run',
        'write_file',
      ]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('the read-only toolset contains exactly read_file, list_dir, grep, git_diff', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-roles-ro-'));
    try {
      const tools = createReadOnlyToolset(rootDir);
      assert.deepEqual(Object.keys(tools).sort(), ['git_diff', 'grep', 'list_dir', 'read_file']);
      const keys = Object.keys(tools);
      assert.ok(!keys.includes('write_file'));
      assert.ok(!keys.includes('edit_file'));
      assert.ok(!keys.includes('run'));
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('the coder toolset does not gain the reviewer git_diff tool', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-roles-coder-gd-'));
    try {
      const tools = createCoderToolset(rootDir);
      assert.ok(!Object.keys(tools).includes('git_diff'));
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('the plan-author toolset omits shell and diff tools but keeps bounded writers', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-roles-plan-'));
    try {
      const tools = createPlanAuthorToolset(rootDir, { allowedWritePaths: ['PLAN.md'] });
      assert.deepEqual(Object.keys(tools).sort(), [
        'edit_file',
        'grep',
        'list_dir',
        'read_file',
        'write_file',
      ]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('read-only tools still execute and stay jailed', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-roles-exec-'));
    try {
      const tools = createReadOnlyToolset(rootDir);
      await fs.writeFile(path.join(rootDir, 'ro.txt'), 'read-only content\n');
      assert.equal(await callTool(tools.read_file, { path: 'ro.txt' }), 'read-only content\n');
      const escape = await callTool(tools.read_file, { path: '../outside.txt' });
      assert.ok(isToolErrorResult(escape));
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

/**
 * git_diff battery: actual commit-range visibility for read-only reviewers.
 * The fixture repository has one modified file and one deleted file between
 * base and head, so the battery proves the deletion-detection contract that
 * head-state file reads cannot provide.
 */
describe('git_diff tool', () => {
  let rootDir: string;
  let base: string;
  let head: string;

  async function git(...gitArgs: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', gitArgs, { cwd: rootDir });
    return stdout.trim();
  }

  before(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-ga-git-diff-'));
    await git('init', '--quiet');
    // Pin identity and signing locally so the fixture commits succeed
    // regardless of the operator's global git configuration.
    await git('config', 'user.email', 'neal-test@example.invalid');
    await git('config', 'user.name', 'Neal Test');
    await git('config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(rootDir, 'kept.txt'), 'line one\n');
    await fs.writeFile(path.join(rootDir, 'doomed.txt'), 'doomed content\n');
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'base commit');
    base = await git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(rootDir, 'kept.txt'), 'line one\nline two\n');
    await fs.rm(path.join(rootDir, 'doomed.txt'));
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'head commit');
    head = await git('rev-parse', 'HEAD');
    // Configure an external diff driver for the whole battery: --no-ext-diff
    // must suppress it on every call, so every patch assertion below also
    // proves operator git config cannot execute commands through this tool.
    await git('config', 'diff.external', 'echo EXTERNAL-DIFF-RAN');
  });

  after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('shows the committed range patch, including deletions head-state reads cannot reveal', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const result = await callTool(tools.git_diff, { base, head });
    assert.ok(!isToolErrorResult(result));
    assert.match(result, /\+line two/);
    assert.match(result, /deleted file mode/);
    assert.match(result, /-doomed content/);
    assert.ok(!result.includes('EXTERNAL-DIFF-RAN'), 'configured external diff driver must be suppressed');
  });

  it('strips GIT_ environment overrides from the child process', async () => {
    const tools = createReadOnlyToolset(rootDir);
    process.env.GIT_EXTERNAL_DIFF = 'echo ENV-EXTERNAL-DIFF-RAN';
    try {
      const result = await callTool(tools.git_diff, { base, head });
      assert.ok(!isToolErrorResult(result));
      assert.match(result, /\+line two/);
      assert.ok(!result.includes('ENV-EXTERNAL-DIFF-RAN'), 'GIT_EXTERNAL_DIFF must not reach the child');
    } finally {
      delete process.env.GIT_EXTERNAL_DIFF;
    }
  });

  it('rejects pathspec magic in the path filter', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const result = await callTool(tools.git_diff, { base, head, path: ':(top)kept.txt' });
    assert.ok(isToolErrorResult(result));
    assert.match(result, /pathspec magic is not allowed/);
  });

  it('returns the diffstat overview with stat:true', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const result = await callTool(tools.git_diff, { base, head, stat: true });
    assert.ok(!isToolErrorResult(result));
    assert.match(result, /kept\.txt/);
    assert.match(result, /doomed\.txt/);
    assert.match(result, /2 files changed/);
    assert.ok(!result.includes('+line two'), 'stat mode must not include patch hunks');
  });

  it('filters to a single path, including a deleted path that no longer exists on disk', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const result = await callTool(tools.git_diff, { base, head, path: 'doomed.txt' });
    assert.ok(!isToolErrorResult(result));
    assert.match(result, /deleted file mode/);
    assert.ok(!result.includes('kept.txt'), 'path filter must exclude other files');
  });

  it('reports an empty range as a no-differences result, not an error', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const result = await callTool(tools.git_diff, { base: head, head });
    assert.ok(!isToolErrorResult(result));
    assert.match(result, /no differences for /);
  });

  it('rejects revisions that could be parsed as options or ranges', async () => {
    const tools = createReadOnlyToolset(rootDir);
    for (const bad of ['--all', '-p', `${base}..${head}`, 'two words', '']) {
      const result = await callTool(tools.git_diff, { base: bad, head });
      assert.ok(isToolErrorResult(result), `expected error for base ${JSON.stringify(bad)}`);
      assert.match(result, /invalid git base revision/);
    }
    const badHead = await callTool(tools.git_diff, { base, head: '--cached' });
    assert.ok(isToolErrorResult(badHead));
    assert.match(badHead, /invalid git head revision/);
  });

  it('returns unknown revisions as bounded error results', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const result = await callTool(tools.git_diff, { base: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head });
    assert.ok(isToolErrorResult(result));
    assert.match(result, /git diff .* failed/);
  });

  it('jails the optional path filter lexically', async () => {
    const tools = createReadOnlyToolset(rootDir);
    const absolute = await callTool(tools.git_diff, { base, head, path: '/etc/passwd' });
    assert.ok(isToolErrorResult(absolute));
    assert.match(absolute, /absolute paths are not allowed/);
    const escape = await callTool(tools.git_diff, { base, head, path: '../outside.txt' });
    assert.ok(isToolErrorResult(escape));
    assert.match(escape, /escapes the working directory/);
  });

  it('emits the shared tool event grammar with per-tool error attribution', async () => {
    const events: OpenAICompatibleToolEvent[] = [];
    const tools = createReadOnlyToolset(rootDir, { emitToolEvent: (event) => events.push(event) });

    const ok = await callTool(tools.git_diff, { base, head });
    assert.ok(!isToolErrorResult(ok));
    assert.deepEqual(events[0], { type: 'tool_started', toolName: 'git_diff' });
    assert.equal(events[1].type, 'tool_progress');
    assert.equal(events[1].toolName, 'git_diff');
    if (events[1].type === 'tool_progress') {
      assert.equal(events[1].isError, false);
      assert.match(events[1].message, /git_diff .* bytes\)/);
    }

    events.length = 0;
    const bad = await callTool(tools.git_diff, { base: '--all', head });
    assert.ok(isToolErrorResult(bad));
    assert.equal(events[1].type, 'tool_progress');
    if (events[1].type === 'tool_progress') {
      assert.equal(events[1].isError, true);
      assert.equal(events[1].message, bad);
    }
  });
});

describe('strict tool inputs', () => {
  // The kimi-era stringified-input coercion shim is gone: input schemas are
  // plain z.object(...) and a double-encoded (stringified JSON) argument is
  // an honest schema error. Per the recorded discovery in openai-compatible.ts
  // (runAgentToolLoop doc comment, ai@6.0.202): the SDK does not throw
  // InvalidToolInputError out of generateText for a bad input — it skips
  // execution, marks the call invalid, and feeds an "Invalid input for tool
  // <name>" error-text tool result back to the next model turn. This test
  // pins that native behavior; nothing coerces or repairs around it.
  it('rejects a stringified-JSON input at the schema and feeds the SDK-native error to the next turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-generic-tools-strict-'));
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello strictness\n', 'utf8');
    const toolEvents: OpenAICompatibleToolEvent[] = [];
    const tools = createCoderToolset(root, { emitToolEvent: (event) => toolEvents.push(event) });

    // Schema level: the plain object validates; its stringified form does not.
    const schema = tools.read_file.inputSchema as unknown as z.ZodType<{ path: string }>;
    assert.equal(schema.safeParse({ path: 'hello.txt' }).success, true);
    assert.equal(schema.safeParse(JSON.stringify({ path: 'hello.txt' })).success, false);
    assert.equal(schema.safeParse('not json at all').success, false);

    // SDK level: turn 1 double-encodes the arguments (the argument JSON sent
    // as a JSON string, the live kimi-k2 failure shape); turn 2 sees the
    // SDK's error feedback and stops.
    const usage = {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    };
    let calls = 0;
    const model = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'read_file',
                input: JSON.stringify(JSON.stringify({ path: 'hello.txt' })),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text', text: 'The read_file input was rejected.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      }) as any,
    });

    const result = await generateText({
      model,
      tools,
      prompt: 'Read hello.txt.',
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });

    // The tool body never executed (no tool_started/tool_progress events) and
    // the next model turn received the SDK's native invalid-input feedback.
    assert.equal(calls, 2);
    assert.deepEqual(toolEvents, []);
    const secondTurnPrompt = JSON.stringify(model.doGenerateCalls[1].prompt);
    assert.ok(
      secondTurnPrompt.includes('Invalid input for tool read_file'),
      `expected SDK invalid-input feedback in the second turn, got: ${secondTurnPrompt}`,
    );
    assert.equal(result.text, 'The read_file input was rejected.');
  });
});
