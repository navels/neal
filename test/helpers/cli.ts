import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Spawn the neal CLI socket-free.
//
// Invoking tsx as a CLI (`node_modules/.bin/tsx <script>`) starts a Unix-domain
// IPC server (tsx's `createIpcServer` -> `listen`) so the tsx parent can talk to
// the node child it spawns. Under the network-denied sandbox neal's coder and
// reviewer run in (codex read-only / workspace-write, both deny socket bind),
// that `listen()` fails with `EPERM` before any test runs — so every CLI test
// that spawns via tsx-as-CLI dies in-sandbox. Loading tsx as an `--import`
// loader on a plain `node` invocation needs no socket.
//
// The loader is resolved to an absolute file URL because these subprocesses run
// with `cwd` set to a fixture directory that has no `node_modules` of its own; a
// bare `--import tsx` specifier would fail to resolve there (ERR_MODULE_NOT_FOUND).
const require = createRequire(import.meta.url);
const TSX_LOADER_URL = pathToFileURL(require.resolve('tsx')).href;

/**
 * Build a `{ command, args }` pair that runs `scriptPath` (a `.ts`/`.mts` entry,
 * e.g. `src/neal/index.ts`) under tsx without opening any IPC socket. Drop-in for
 * the previous `.bin/tsx <scriptPath> ...args` spawn/execFile call sites.
 */
export function nealCliInvocation(scriptPath: string, args: readonly string[] = []) {
  return {
    command: process.execPath,
    args: ['--import', TSX_LOADER_URL, scriptPath, ...args],
  };
}

// Matches Node runtime warning lines on a spawned CLI's stderr:
// - `(node:<pid>) [DEP0205] DeprecationWarning: ...` / `(node:<pid>) ExperimentalWarning: ...`
//   (any `(node:<pid>)`-prefixed warning line, whatever the category)
// - the follow-up hint lines Node prints for them
//   (`(Use \`node --trace-deprecation ...\`)` / `--trace-warnings`)
const NODE_RUNTIME_WARNING_LINE =
  /^\(node:\d+\)|DeprecationWarning|ExperimentalWarning|--trace-deprecation|--trace-warnings/;

/**
 * Strip Node runtime warning lines from a spawned CLI's stderr so assertions
 * stay exact about neal's own output without breaking on Node-version noise.
 *
 * Newer Node versions emit warnings for the tsx `--import` loader these tests
 * spawn with (e.g. Node 26 emits DEP0205 because tsx calls the deprecated
 * `module.register()`), which lands on stderr and breaks
 * `assert.equal(stderr, ...)` sites. Only
 * runtime warning lines are removed; everything else — including the trailing
 * newline structure of real output — is preserved, so `assert.equal(
 * normalizeCliStderr(stderr), expected)` remains a strict assertion on what
 * neal itself wrote.
 */
export function normalizeCliStderr(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !NODE_RUNTIME_WARNING_LINE.test(line))
    .join('\n');
}
