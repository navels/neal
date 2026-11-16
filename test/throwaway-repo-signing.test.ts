import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Tripwire for a failure that only shows up on some machines.
//
// A developer whose global git config has `commit.gpgsign = true` and no
// pinned `user.signingkey` can commit as themselves, but any commit made under
// a made-up identity fails: git asks gpg for a key matching the committer, and
// there isn't one ("gpg failed to sign the data ... No secret key"). Every
// throwaway repo neal creates commits under a made-up identity, in tests, in
// scripts, and in `neal compat`. CI never signs, so a file that forgets the
// opt-out passes there and breaks only on those machines.
//
// The rule this enforces: a file that creates a git repository and commits in
// it must set `commit.gpgsign` in that repository.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_DIRS = ['src', 'scripts', 'test', 'examples'];
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.mjs', '.js', '.sh'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'fixtures', '.neal']);
const THIS_FILE = 'test/throwaway-repo-signing.test.ts';

// A git subcommand passed as a quoted argument ('init', "commit"), or the
// plain command line in a shell script.
function runsGitSubcommand(source: string, path: string, subcommand: string): boolean {
  const quotedArg = new RegExp(`(['"\`])${subcommand}\\1`);
  if (quotedArg.test(source)) {
    return true;
  }
  return path.endsWith('.sh') && new RegExp(`\\bgit\\s+${subcommand}\\b`).test(source);
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...listSourceFiles(join(dir, entry.name)));
      }
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function findRepoCreatingFiles() {
  return SCANNED_DIRS.flatMap((dir) => listSourceFiles(join(repoRoot, dir)))
    .map((absolutePath) => ({
      path: relative(repoRoot, absolutePath).split('\\').join('/'),
      source: readFileSync(absolutePath, 'utf8'),
    }))
    .filter(({ path }) => path !== THIS_FILE)
    .filter(({ path, source }) => runsGitSubcommand(source, path, 'init') && runsGitSubcommand(source, path, 'commit'));
}

test('every file that creates a git repo and commits in it opts out of commit signing', () => {
  const creators = findRepoCreatingFiles();

  // Guard the detector itself: if these stop matching, the scan has rotted and
  // an empty offender list would mean nothing.
  const creatorPaths = creators.map(({ path }) => path);
  for (const known of ['src/neal/commands/compat.ts', 'scripts/eval-reviewer.mjs', 'test/helpers/orchestrator-harness.ts']) {
    assert.ok(creatorPaths.includes(known), `repo-creation scan no longer detects ${known}`);
  }

  const offenders = creators.filter(({ source }) => !source.includes('commit.gpgsign')).map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    [
      'These files create a git repository and commit in it without setting commit.gpgsign:',
      ...offenders.map((path) => `  - ${path}`),
      'On a machine with global commit signing and no pinned signing key, those commits fail with',
      '"gpg failed to sign the data". Add `git config commit.gpgsign false` to the repository the',
      'file creates, next to where it sets user.name and user.email.',
    ].join('\n'),
  );
});
