/**
 * openai-compatible provider tool layer: the six neal-defined AI SDK tools,
 * jailed to a root directory. Key mechanics:
 *
 * - an event-emission hook so tool execution surfaces the existing provider
 *   event grammar (`tool_started`, `tool_progress`, `command_completed`,
 *   `file_changed`) without new event types;
 * - per-tool error attribution: every error-as-result emits a
 *   `tool_progress` payload with `toolName` and `isError: true` so run
 *   records are self-sufficient;
 * - role-scoped factories: `createCoderToolset` (all six writer tools),
 *   `createPlanAuthorToolset` (read plus plan-artifact writes, no shell), and
 *   `createReadOnlyToolset` (`read_file`, `list_dir`, `grep`, plus the read-only
 *   `git_diff` range inspector) so the Phase 2 tool-capable reviewer is a
 *   registration change, not a tool change.
 *
 * `git_diff` exists because reviewer prompts name a commit range as the
 * source of truth, but plain file reads can only see the head state: they
 * cannot reveal deletions, renames, or what specifically changed in the
 * range. The tool is a neal-owned read-only query (a fixed `git diff`
 * argv — never a shell string), with refs validated against a conservative
 * pattern and the optional path filter jailed lexically (lexically only:
 * deleted paths must remain addressable, and git only ever resolves the
 * filter against repository-relative paths).
 *
 * Cross-cutting constraints are enforced in code, not prompting:
 *
 * - every `path` argument resolves inside `rootDir`: lexically
 *   (resolveJailedPath) and against symlink escapes via realpath comparison
 *   (resolveExistingJailedPath / resolveWritableJailedPath);
 * - every tool result is truncated to 16 KiB with an explicit marker;
 * - tool errors are returned as tool results (never thrown out of the loop)
 *   so the model can self-correct.
 *
 * Trust level note: path-jailing tool arguments does not sandbox the `run`
 * tool — shell commands execute with the same trust as vendor writers.
 */
import { exec, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { gitConfigIsolationEnv } from './git-config-isolation.js';

export const RESULT_BYTE_LIMIT = 16 * 1024;
export const READ_FILE_BYTE_LIMIT = 256 * 1024;
export const GREP_MAX_MATCHING_LINES = 200;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const GIT_DIFF_TIMEOUT_MS = 30_000;

/**
 * Conservative git revision pattern for `git_diff` arguments: SHAs, branch
 * and tag names, `HEAD`, and suffix operators (`~`, `^`). Must start with an
 * alphanumeric so a revision can never be parsed as a git option, and must
 * not contain whitespace, `..`, or shell metacharacters. The tool composes
 * `base..head` itself, so range syntax in a single argument is rejected.
 */
const GIT_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/^~-]*$/;

const BINARY_SNIFF_BYTES = 8 * 1024;
const TOOL_ERROR_PREFIX = 'Error: ';

/**
 * Tool-level event payloads mirroring the provider runtime event grammar
 * (`ProviderRuntimeEvent` in `./types.ts`) minus the base fields
 * (`provider`, `role`, `sessionHandle`, ...). The adapter that owns the
 * toolset adds those base fields and forwards each payload to its provider
 * event sink, so consumers (narrator, status health, liveness watchdog,
 * benchmark classifier) see the same event shapes as vendor writers.
 */
export type OpenAICompatibleToolEvent =
  | { type: 'tool_started'; toolName: string }
  | { type: 'tool_progress'; toolName: string; message: string; isError: boolean }
  | {
      type: 'command_completed';
      toolName: 'run';
      command: string;
      exitCode: number | null;
      output: string;
      cwd: string;
    }
  | { type: 'file_changed'; toolName: 'write_file' | 'edit_file'; files: string[] };

export type OpenAICompatibleToolEventEmitter = (event: OpenAICompatibleToolEvent) => void;

export type OpenAICompatibleToolsetOptions = {
  /** Bounds the `run` tool; injectable so tests can use a short timeout. */
  runTimeoutMs?: number;
  /**
   * Optional write allowlist. When present, `write_file` and `edit_file` only
   * mutate paths resolving to one of these root-relative or absolute paths.
   */
  allowedWritePaths?: string[];
  /**
   * Enables shell execution. Defaults to true for execute-mode coder work; plan
   * phases set this false because shell commands can mutate arbitrary files.
   */
  allowRun?: boolean;
  /**
   * Event-emission hook invoked synchronously during tool execution.
   * Emitter failures are swallowed: telemetry must never turn a tool result
   * into a thrown error (errors-as-results is the loop contract).
   */
  emitToolEvent?: OpenAICompatibleToolEventEmitter;
};

/**
 * Resolves `relativePath` against `rootDir` and throws when the argument is
 * absolute or the resolution escapes the root (`..` etc.). Exported for
 * direct testing.
 */
export function resolveJailedPath(rootDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`absolute paths are not allowed: ${relativePath}`);
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes the working directory: ${relativePath}`);
  }
  return resolved;
}

function assertInsideRealRoot(realPath: string, realRoot: string, original: string): void {
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes the working directory via symlink: ${original}`);
  }
}

/**
 * Resolves an existing path for reading/listing/grepping/editing: lexical
 * jail check first, then a realpath comparison against the real root so
 * symlinks inside the jail cannot reach outside it.
 */
export async function resolveExistingJailedPath(
  rootDir: string,
  relativePath: string,
): Promise<string> {
  const lexical = resolveJailedPath(rootDir, relativePath);
  const realRoot = await fs.realpath(path.resolve(rootDir));
  const real = await fs.realpath(lexical);
  assertInsideRealRoot(real, realRoot, relativePath);
  return real;
}

/**
 * Resolves a path for writing: lexical jail check, then (a) the deepest
 * existing ancestor of the target's parent must realpath inside the real
 * root (catches symlinked intermediate directories), and (b) an existing
 * final-path symlink must also realpath inside the real root (never write
 * through an escaping symlink).
 */
export async function resolveWritableJailedPath(
  rootDir: string,
  relativePath: string,
): Promise<string> {
  const lexical = resolveJailedPath(rootDir, relativePath);
  const realRoot = await fs.realpath(path.resolve(rootDir));

  let ancestor = path.dirname(lexical);
  let realAncestor: string | null = null;
  while (realAncestor === null) {
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(ancestor);
      if (code === 'ENOENT' && parent !== ancestor) {
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
  assertInsideRealRoot(realAncestor, realRoot, relativePath);

  try {
    const stats = await fs.lstat(lexical);
    if (stats.isSymbolicLink()) {
      const real = await fs.realpath(lexical);
      assertInsideRealRoot(real, realRoot, relativePath);
      return real;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return lexical;
}

/** True when a tool result string is an error-as-result produced by this layer. */
export function isToolErrorResult(result: string): boolean {
  return result.startsWith(TOOL_ERROR_PREFIX);
}

/** Bounds a tool result to 16 KiB, appending an explicit truncation marker. */
export function truncateResult(text: string): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= RESULT_BYTE_LIMIT) {
    return text;
  }
  const shown = Buffer.from(text, 'utf8')
    .subarray(0, RESULT_BYTE_LIMIT)
    .toString('utf8');
  return `${shown}[truncated: showing ${RESULT_BYTE_LIMIT} of ${totalBytes} bytes]`;
}

/** Runs a tool body, converting thrown errors into bounded error results. */
async function safeResult(run: () => Promise<string> | string): Promise<string> {
  try {
    return truncateResult(await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return truncateResult(`${TOOL_ERROR_PREFIX}${message}`);
  }
}

async function readFileBody(rootDir: string, relativePath: string): Promise<string> {
  const resolved = await resolveExistingJailedPath(rootDir, relativePath);
  const stats = await fs.stat(resolved);
  if (!stats.isFile()) {
    throw new Error(`not a regular file: ${relativePath}`);
  }
  if (stats.size > READ_FILE_BYTE_LIMIT) {
    throw new Error(
      `file too large to read: ${relativePath} is ${stats.size} bytes (limit ${READ_FILE_BYTE_LIMIT})`,
    );
  }
  const content = await fs.readFile(resolved);
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new Error(`refusing to read binary file (NUL byte detected): ${relativePath}`);
  }
  return content.toString('utf8');
}

async function writeFileBody(
  rootDir: string,
  relativePath: string,
  content: string,
  allowedWritePaths?: string[],
): Promise<string> {
  const resolved = await resolveWritableJailedPath(rootDir, relativePath);
  await assertWriteAllowed(rootDir, resolved, allowedWritePaths);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf8');
  return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${relativePath}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function editFileBody(
  rootDir: string,
  relativePath: string,
  oldText: string,
  newText: string,
  allowedWritePaths?: string[],
): Promise<string> {
  const resolved = await resolveExistingJailedPath(rootDir, relativePath);
  await assertWriteAllowed(rootDir, resolved, allowedWritePaths);
  const content = await fs.readFile(resolved, 'utf8');
  const matches = countOccurrences(content, oldText);
  if (matches === 0) {
    throw new Error(`no match for the old string in ${relativePath}; nothing was changed`);
  }
  if (matches > 1) {
    throw new Error(
      `the old string matches ${matches} times in ${relativePath}; it must match exactly once. Include more surrounding context to make it unique`,
    );
  }
  const updated = content.replace(oldText, newText);
  await fs.writeFile(resolved, updated, 'utf8');
  return `edited ${relativePath}: replaced 1 occurrence`;
}

async function assertWriteAllowed(
  rootDir: string,
  resolvedPath: string,
  allowedWritePaths: string[] | undefined,
): Promise<void> {
  if (allowedWritePaths === undefined) {
    return;
  }
  const resolvedReal = await realpathOrResolved(resolvedPath);
  for (const allowedPath of allowedWritePaths) {
    const allowedResolved = path.isAbsolute(allowedPath)
      ? path.resolve(allowedPath)
      : resolveJailedPath(rootDir, allowedPath);
    const allowedReal = await realpathOrResolved(allowedResolved);
    if (resolvedReal === allowedReal) {
      return;
    }
  }
  const root = await realpathOrResolved(path.resolve(rootDir));
  const displayPath = path.relative(root, resolvedReal) || '.';
  const allowedDisplay = allowedWritePaths.length > 0 ? allowedWritePaths.join(', ') : '(none)';
  throw new Error(
    `write access denied for ${displayPath}; this phase may only write: ${allowedDisplay}`,
  );
}

async function realpathOrResolved(candidatePath: string): Promise<string> {
  try {
    return await fs.realpath(candidatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  let ancestor = path.dirname(path.resolve(candidatePath));
  const missingParts = [path.basename(candidatePath)];
  while (true) {
    try {
      return path.join(await fs.realpath(ancestor), ...missingParts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return path.resolve(candidatePath);
      }
      missingParts.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function listDirBody(rootDir: string, relativePath: string): Promise<string> {
  const resolved = await resolveExistingJailedPath(rootDir, relativePath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  if (entries.length === 0) {
    return '(empty directory)';
  }
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .join('\n');
}

async function collectFiles(dir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      await collectFiles(path.join(dir, entry.name), files);
    } else if (entry.isFile()) {
      files.push(path.join(dir, entry.name));
    }
  }
}

async function grepBody(
  rootDir: string,
  pattern: string,
  relativePath: string | undefined,
): Promise<string> {
  const root = await fs.realpath(path.resolve(rootDir));
  const start =
    relativePath === undefined ? root : await resolveExistingJailedPath(rootDir, relativePath);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const files: string[] = [];
  const startStats = await fs.stat(start);
  if (startStats.isDirectory()) {
    await collectFiles(start, files);
  } else {
    files.push(start);
  }
  const lines: string[] = [];
  let capped = false;
  outer: for (const file of files) {
    const content = await fs.readFile(file);
    if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      continue; // skip binary files
    }
    const rel = path.relative(root, file) || path.basename(file);
    const fileLines = content.toString('utf8').split('\n');
    for (let i = 0; i < fileLines.length; i += 1) {
      if (regex.test(fileLines[i])) {
        lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
        if (lines.length >= GREP_MAX_MATCHING_LINES) {
          capped = true;
          break outer;
        }
      }
    }
  }
  if (lines.length === 0) {
    return `no matches for /${pattern}/`;
  }
  if (capped) {
    lines.push(`[grep output capped at ${GREP_MAX_MATCHING_LINES} matching lines]`);
  }
  return lines.join('\n');
}

function assertGitRevision(value: string, label: 'base' | 'head'): string {
  if (!GIT_REVISION_PATTERN.test(value) || value.includes('..')) {
    throw new Error(
      `invalid git ${label} revision: ${JSON.stringify(value)}. Pass a single commit SHA, branch, tag, or HEAD-relative revision; the tool composes the base..head range itself.`,
    );
  }
  return value;
}

/**
 * Read-only committed-range diff: a fixed `git diff` argv (never a shell
 * string) against the repository at `rootDir`. The optional path filter is
 * jailed lexically only — a deleted file does not exist on disk, so the
 * realpath checks used by the read tools would wrongly reject exactly the
 * paths this tool exists to reveal; git resolves the filter against
 * repository-relative paths, never the wider filesystem. The no-command
 * guarantee is enforced in code, not configuration: `--no-ext-diff` and
 * `--no-textconv` suppress operator-configured diff drivers, `GIT_`
 * environment overrides (GIT_EXTERNAL_DIFF, GIT_DIR, GIT_WORK_TREE, ...)
 * are stripped from the child environment, pathspec magic (`:`-prefixed
 * filters) is rejected, and the `--` separator is always emitted so a
 * revision can never be reparsed as a path.
 */
function gitDiffBody(
  rootDir: string,
  base: string,
  head: string,
  relativePath: string | undefined,
  stat: boolean | undefined,
): Promise<string> {
  const range = `${assertGitRevision(base, 'base')}..${assertGitRevision(head, 'head')}`;
  const gitArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames'];
  if (stat) {
    gitArgs.push('--stat');
  }
  gitArgs.push(range, '--');
  if (relativePath !== undefined) {
    if (relativePath.startsWith(':')) {
      throw new Error(`pathspec magic is not allowed: ${relativePath}`);
    }
    resolveJailedPath(rootDir, relativePath);
    gitArgs.push(relativePath);
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      childEnv[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      gitArgs,
      {
        cwd: path.resolve(rootDir),
        env: childEnv,
        timeout: GIT_DIFF_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`git diff ${range} failed: ${detail}`));
          return;
        }
        if (stdout.length === 0) {
          resolve(
            `(no differences for ${range}${relativePath === undefined ? '' : ` -- ${relativePath}`})`,
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

type RunOutcome = { text: string; exitCode: number | null };

function runBody(rootDir: string, command: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: path.resolve(rootDir),
        // Agent-issued shell commands must not be able to write the operator's
        // real global gitconfig. See git-config-isolation.ts.
        env: { ...process.env, ...gitConfigIsolationEnv() },
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && error.killed);
        let exitCode: number | null;
        if (error) {
          exitCode = typeof error.code === 'number' ? error.code : null;
        } else {
          exitCode = 0;
        }
        const parts: string[] = [];
        if (timedOut) {
          parts.push(`command timed out after ${timeoutMs}ms and was killed`);
        }
        parts.push(
          `exit code: ${exitCode === null ? 'none (process killed before exiting)' : exitCode}`,
        );
        parts.push(`stdout:\n${stdout}`);
        parts.push(`stderr:\n${stderr}`);
        resolve({ text: parts.join('\n'), exitCode });
      },
    );
  });
}

/** Jail-relative display path for `file_changed` events. */
function jailRelativePath(rootDir: string, relativePath: string): string {
  return path.relative(path.resolve(rootDir), resolveJailedPath(rootDir, relativePath));
}

function buildTools(rootDir: string, options?: OpenAICompatibleToolsetOptions) {
  const runTimeoutMs = options?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const allowedWritePaths = options?.allowedWritePaths;
  const allowRun = options?.allowRun ?? true;
  const hook = options?.emitToolEvent;

  /** Telemetry must never break tool execution; emitter failures are swallowed. */
  const emit = (event: OpenAICompatibleToolEvent): void => {
    if (!hook) {
      return;
    }
    try {
      hook(event);
    } catch {
      // Errors-as-results is the loop contract; a throwing emitter must not
      // convert a tool result into a thrown error or hide a real result.
    }
  };

  /**
   * Wraps a tool body with the shared event grammar: `tool_started` on
   * entry, then on completion either an `isError: true` `tool_progress`
   * carrying the error result (per-tool error attribution) or an
   * `isError: false` `tool_progress` carrying a short success summary.
   */
  const instrumented = async (
    toolName: string,
    body: () => Promise<string> | string,
    summarize: (result: string) => string,
    onSuccess?: (result: string) => void,
  ): Promise<string> => {
    emit({ type: 'tool_started', toolName });
    const result = await safeResult(body);
    if (isToolErrorResult(result)) {
      emit({ type: 'tool_progress', toolName, message: result, isError: true });
      return result;
    }
    onSuccess?.(result);
    emit({ type: 'tool_progress', toolName, message: summarize(result), isError: false });
    return result;
  };

  return {
    read_file: tool({
      description:
        'Read a UTF-8 text file inside the working directory. Rejects files larger than 256 KiB and binary files.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the working directory'),
      }),
      execute: (input) =>
        instrumented(
          'read_file',
          () => readFileBody(rootDir, input.path),
          (result) => `read ${input.path} (${Buffer.byteLength(result, 'utf8')} bytes)`,
        ),
    }),
    write_file: tool({
      description:
        'Write a whole file inside the working directory, creating parent directories as needed. Overwrites any existing content.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the working directory'),
        content: z.string().describe('Full new file content'),
      }),
      execute: (input) =>
        instrumented(
          'write_file',
          () => writeFileBody(rootDir, input.path, input.content, allowedWritePaths),
          (result) => result,
          () =>
            emit({
              type: 'file_changed',
              toolName: 'write_file',
              files: [jailRelativePath(rootDir, input.path)],
            }),
        ),
    }),
    edit_file: tool({
      description:
        'Replace one exact occurrence of `old` with `new` in a file. `old` must match the file content exactly once; include enough surrounding context to make it unique.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the working directory'),
        old: z.string().describe('Exact existing text to replace (must match exactly once)'),
        new: z.string().describe('Replacement text'),
      }),
      execute: (input) =>
        instrumented(
          'edit_file',
          () => editFileBody(rootDir, input.path, input.old, input.new, allowedWritePaths),
          (result) => result,
          () =>
            emit({
              type: 'file_changed',
              toolName: 'edit_file',
              files: [jailRelativePath(rootDir, input.path)],
            }),
        ),
    }),
    list_dir: tool({
      description:
        'List the entries of a directory inside the working directory (non-recursive). Directories are marked with a trailing slash.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Directory path relative to the working directory; use "." for the root'),
      }),
      execute: (input) =>
        instrumented(
          'list_dir',
          () => listDirBody(rootDir, input.path),
          (result) =>
            `listed ${input.path} (${
              result === '(empty directory)' ? 0 : result.split('\n').length
            } entries)`,
        ),
    }),
    git_diff: tool({
      description:
        'Show the committed git diff between two commits of the working-directory repository (read-only). This is the only way to see exactly what a commit range changed, including deletions and renames that reading head-state files cannot reveal. Output is truncated to 16 KiB: call with stat:true first for the changed-file overview of a large range, then request per-path diffs.',
      inputSchema: z.object({
        base: z.string().describe('Base revision of the range (commit SHA, branch, tag, or HEAD-relative revision)'),
        head: z.string().describe('Head revision of the range (commit SHA, branch, tag, or HEAD-relative revision)'),
        path: z
          .string()
          .optional()
          .describe('Limit the diff to one file or directory, relative to the working directory; deleted paths are valid here'),
        stat: z
          .boolean()
          .optional()
          .describe('When true, return the diffstat summary instead of the patch — use this first on large ranges'),
      }),
      execute: (input) =>
        instrumented(
          'git_diff',
          () => gitDiffBody(rootDir, input.base, input.head, input.path, input.stat),
          (result) =>
            `git_diff ${input.base}..${input.head}${input.path === undefined ? '' : ` -- ${input.path}`}${
              input.stat ? ' --stat' : ''
            } (${Buffer.byteLength(result, 'utf8')} bytes)`,
        ),
    }),
    grep: tool({
      description:
        'Search file contents recursively with a JavaScript regular expression, skipping node_modules and dotted directories. Output is capped at 200 matching lines.',
      inputSchema: z.object({
        pattern: z.string().describe('JavaScript regular expression source'),
        path: z
          .string()
          .optional()
          .describe('Directory or file to search, relative to the working directory (default: root)'),
      }),
      execute: (input) =>
        instrumented(
          'grep',
          () => grepBody(rootDir, input.pattern, input.path),
          (result) =>
            result.startsWith('no matches for ')
              ? result
              : `grep /${input.pattern}/: ${
                  result.split('\n').filter((line) => !line.startsWith('[grep output capped'))
                    .length
                } matching line(s)`,
        ),
    }),
    run: tool({
      description: `Run a shell command in the working directory with a ${runTimeoutMs}ms timeout. Returns the exit code, stdout, and stderr.`,
      inputSchema: z.object({
        command: z.string().describe('Shell command to execute'),
      }),
      execute: async (input) => {
        emit({ type: 'tool_started', toolName: 'run' });
        if (!allowRun) {
          const result = truncateResult(
            `${TOOL_ERROR_PREFIX}shell commands are disabled in this phase; use read_file, list_dir, grep, write_file, or edit_file within the allowed write paths`,
          );
          emit({ type: 'tool_progress', toolName: 'run', message: result, isError: true });
          return result;
        }
        let outcome: RunOutcome;
        try {
          outcome = await runBody(rootDir, input.command, runTimeoutMs);
        } catch (error) {
          // Unexpected infrastructure failure (exec callback contract broke):
          // keep the errors-as-results posture and attribute the error.
          const message = error instanceof Error ? error.message : String(error);
          const result = truncateResult(`${TOOL_ERROR_PREFIX}${message}`);
          emit({ type: 'tool_progress', toolName: 'run', message: result, isError: true });
          return result;
        }
        const result = truncateResult(outcome.text);
        emit({
          type: 'command_completed',
          toolName: 'run',
          command: input.command,
          exitCode: outcome.exitCode,
          output: result,
          cwd: path.resolve(rootDir),
        });
        return result;
      },
    }),
  };
}

/**
 * The full coder toolset: the six writer tools (`read_file`, `write_file`,
 * `edit_file`, `list_dir`, `grep`, `run`) jailed to `rootDir`. The coder has
 * shell access through `run`, so it does not get the reviewer-oriented
 * `git_diff` query tool — coder behavior is byte-stable across Phase 2.
 */
export function createCoderToolset(rootDir: string, options?: OpenAICompatibleToolsetOptions) {
  const { read_file, write_file, edit_file, list_dir, grep, run } = buildTools(rootDir, options);
  return { read_file, write_file, edit_file, list_dir, grep, run };
}

/**
 * The plan-author toolset: read/inspect tools plus bounded file writers, with
 * no shell tool exposed. Plan phases pass `allowedWritePaths` for the active
 * plan artifact, preventing implementation edits before execution.
 */
export function createPlanAuthorToolset(rootDir: string, options?: OpenAICompatibleToolsetOptions) {
  const { read_file, write_file, edit_file, list_dir, grep } = buildTools(rootDir, options);
  return { read_file, write_file, edit_file, list_dir, grep };
}

/**
 * The read-only toolset: exactly `read_file`, `list_dir`, `grep`, and
 * `git_diff` — no write or shell access. `git_diff` gives reviewers actual
 * commit-range visibility (deletions included) without shell access; see the
 * module doc.
 */
export function createReadOnlyToolset(rootDir: string, options?: OpenAICompatibleToolsetOptions) {
  const { read_file, list_dir, grep, git_diff } = buildTools(rootDir, options);
  return { read_file, list_dir, grep, git_diff };
}
