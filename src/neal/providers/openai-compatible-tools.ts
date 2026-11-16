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
 *   `createReadOnlyToolset` (`read_file`, `list_dir`, `grep`) for reviewers
 *   reading the range-diff artifacts and repository files.
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
import { isUtf8 } from 'node:buffer';
import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { gitConfigIsolationEnv } from './git-config-isolation.js';

export const RESULT_BYTE_LIMIT = 16 * 1024;
export const READ_FILE_BYTE_LIMIT = 256 * 1024;
// Leave room for metadata and up to three bytes completing a UTF-8 character.
export const READ_FILE_PAGE_BYTE_LIMIT = RESULT_BYTE_LIMIT - 512;
export const GREP_MAX_MATCHING_LINES = 200;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
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
export function truncateResult(text: string, hint = ''): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= RESULT_BYTE_LIMIT) {
    return text;
  }
  const shown = Buffer.from(text, 'utf8')
    .subarray(0, RESULT_BYTE_LIMIT)
    .toString('utf8');
  return `${shown}[truncated: showing ${RESULT_BYTE_LIMIT} of ${totalBytes} bytes]${hint}`;
}

/** Runs a tool body, converting thrown errors into bounded error results. */
async function safeResult(run: () => Promise<string> | string, truncationHint = ''): Promise<string> {
  try {
    return truncateResult(await run(), truncationHint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return truncateResult(`${TOOL_ERROR_PREFIX}${message}`);
  }
}

async function readFileBody(
  rootDir: string,
  relativePath: string,
  offset?: number,
  length?: number,
): Promise<string> {
  const resolved = await resolveExistingJailedPath(rootDir, relativePath);
  const stats = await fs.stat(resolved);
  if (!stats.isFile()) {
    throw new Error(`not a regular file: ${relativePath}`);
  }
  if (offset !== undefined || length !== undefined) {
    return readFilePage(resolved, relativePath, offset ?? 0, length ?? READ_FILE_PAGE_BYTE_LIMIT);
  }
  if (stats.size > READ_FILE_BYTE_LIMIT) {
    throw new Error(
      `file too large to read: ${relativePath} is ${stats.size} bytes (limit ${READ_FILE_BYTE_LIMIT}); use read_file with offset and length for paging`,
    );
  }
  const content = await fs.readFile(resolved);
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new Error(`refusing to read binary file (NUL byte detected): ${relativePath}`);
  }
  return content.toString('utf8');
}

/** Bounded positioned reads, including short reads, without loading the whole file. */
async function readFileBytes(file: fs.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** The complete valid character at this byte, or zero for an invalid byte. */
function utf8CharacterLength(bytes: Buffer, index: number): number {
  const lead = bytes[index];
  if (lead < 0x80) {
    return 1;
  }
  const length = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
    : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  return length > 0 && index + length <= bytes.length && isUtf8(bytes.subarray(index, index + length))
    ? length : 0;
}

async function readFilePage(
  resolved: string,
  relativePath: string,
  offset: number,
  length: number,
): Promise<string> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative safe integer byte offset');
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > READ_FILE_PAGE_BYTE_LIMIT) {
    throw new Error(`length must be an integer from 1 to ${READ_FILE_PAGE_BYTE_LIMIT} bytes`);
  }
  const file = await fs.open(resolved, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error(`not a regular file: ${relativePath}`);
    }
    if (offset > stats.size) {
      throw new Error(`offset ${offset} exceeds file size ${stats.size}`);
    }
    const sniff = await readFileBytes(file, 0, Math.min(stats.size, BINARY_SNIFF_BYTES));
    if (sniff.includes(0)) {
      throw new Error(`refusing to read binary file (NUL byte detected): ${relativePath}`);
    }
    const windowLength = Math.min(length, stats.size - offset);
    const readStart = Math.max(0, offset - 3);
    const prefixLength = offset - readStart;
    const bytes = await readFileBytes(file, readStart,
      Math.min(prefixLength + windowLength + 3, stats.size - readStart));
    if (bytes.length < prefixLength + windowLength) {
      throw new Error('file changed size during paged read; retry the read');
    }
    // Skip only bytes belonging to a valid character that started before this
    // window. Invalid prefix bytes neither fail nor consume this page.
    let start = prefixLength;
    for (let index = 0; index < prefixLength; index += 1) {
      const characterLength = utf8CharacterLength(bytes, index);
      if (index + characterLength > prefixLength) {
        start = index + characterLength;
        break;
      }
    }
    // A valid character belongs to the window containing its first byte. An
    // invalid byte belongs to its own window and becomes one ASCII question
    // mark, so even an entirely invalid page cannot exceed the result budget.
    let end = start;
    let replacedBytes = 0;
    while (end < prefixLength + windowLength) {
      const characterLength = utf8CharacterLength(bytes, end);
      if (characterLength === 0) {
        bytes[end] = 0x3f;
        replacedBytes += 1;
      }
      end += characterLength || 1;
    }
    const content = bytes.subarray(start, end);
    const windowEnd = offset + windowLength;
    const nextOffset = windowEnd < stats.size ? String(windowEnd) : 'EOF';
    return `[read_file bytes ${offset}..${windowEnd} of ${stats.size}; end exclusive; text bytes ${readStart + start}..${readStart + end}; invalid UTF-8 bytes replaced with "?": ${replacedBytes}]\n` +
      content.toString('utf8') + `\n[next offset: ${nextOffset}]`;
  } finally {
    await file.close();
  }
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
    const result = await safeResult(body, toolName === 'read_file'
      ? ' Use read_file with offset and length for paging.'
      : '');
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
        'Read a text file inside the working directory. Rejects binary files. Without paging, rejects files larger than 256 KiB and truncates output at 16 KiB. Supply offset or length to page files of any size. Paged results include raw byte ranges (end exclusive), total size, text byte ranges and next offset (EOF when done). Windows are fixed: valid UTF-8 characters belong to the window containing their first byte. Each invalid byte becomes one ASCII question mark in its own window, with the replacement count reported in the header. You can precompute offsets and request multiple pages in one turn, in any order.',
      inputSchema: z.object({
        path: z.string().describe('File path relative to the working directory'),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
          .describe('Raw byte offset for paging (default: 0 when length is supplied)'),
        length: z.number().int().min(1).max(READ_FILE_PAGE_BYTE_LIMIT).optional()
          .describe(`Raw bytes per page, at most ${READ_FILE_PAGE_BYTE_LIMIT} (default when offset is supplied). Advance offsets by this length, even across UTF-8 boundaries.`),
      }),
      execute: (input) =>
        instrumented(
          'read_file',
          () => readFileBody(rootDir, input.path, input.offset, input.length),
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
 * `edit_file`, `list_dir`, `grep`, `run`) jailed to `rootDir`.
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
 * The read-only toolset: exactly `read_file`, `list_dir`, and `grep`.
 * Reviewers read commit-range indexes and patches with these tools.
 */
export function createReadOnlyToolset(rootDir: string, options?: OpenAICompatibleToolsetOptions) {
  const { read_file, list_dir, grep } = buildTools(rootDir, options);
  return { read_file, list_dir, grep };
}
