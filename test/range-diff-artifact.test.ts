import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { writeRangeDiffArtifact, type RangeDiffManifest } from '../src/neal/range-diff-artifact.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function gitInput(cwd: string, input: Buffer, ...args: string[]) {
  const result = execFileAsync('git', args, { cwd, encoding: 'buffer' });
  result.child.stdin!.end(input);
  return (await result).stdout.toString().trim();
}

function decodeGitPath(value: string): Buffer {
  assert.ok(value.startsWith('"') && value.endsWith('"'));
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  return Buffer.from(value.slice(1, -1).replace(/\\([0-7]{3}|[abtnvfr"\\])/g, (_, escaped: string) =>
    escapes[escaped] ?? String.fromCharCode(parseInt(escaped, 8))), 'latin1');
}

async function repo(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'neal-range-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  const dir = join(root, 'artifact');
  await mkdir(cwd);
  await git(cwd, 'init');
  await git(cwd, 'config', 'user.email', 'test@example.invalid');
  await git(cwd, 'config', 'user.name', 'test');
  await git(cwd, 'config', 'commit.gpgsign', 'false');
  await git(cwd, 'config', 'core.autocrlf', 'false');
  await git(cwd, 'config', 'core.filemode', 'true');
  return { cwd, dir };
}

async function commit(cwd: string) {
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '--allow-empty', '-qm', 'fixture');
  return (await git(cwd, 'rev-parse', 'HEAD')).toString().trim();
}

async function verify(cwd: string, dir: string, base: string, head: string) {
  const manifest = await writeRangeDiffArtifact({ cwd, dir, base, head });
  // Independent aggregate Git query: no path-specific diffs and no trimming.
  const aggregate = await git(cwd, '-c', 'core.quotePath=true', 'diff', '--find-renames',
    '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=none',
    '--full-index', '--no-indent-heuristic', `${base}..${head}`, '--');
  const patches = await Promise.all(manifest.entries.map((entry) => readFile(join(dir, entry.patchFile))));
  assert.deepEqual(Buffer.concat(patches), aggregate);
  assert.equal(manifest.totalBytes, aggregate.length);
  assert.equal(manifest.base, base);
  assert.equal(manifest.head, head);
  const index = await readFile(manifest.indexPath, 'utf8');
  assert.ok(index.includes(`Range: ${base}..${head}`));
  assert.ok(index.includes(`Entries: ${manifest.entries.length}`));
  assert.ok(index.includes(`Total patch bytes: ${aggregate.length}`));
  const rows = index.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, manifest.entries.length);
  for (const [i, entry] of manifest.entries.entries()) {
    const patch = patches[i]!;
    assert.equal(entry.number, i + 1);
    assert.equal(entry.patchFile, `${String(i + 1).padStart(4, '0')}.patch`);
    assert.equal(entry.byteCount, patch.length);
    assert.equal(entry.lineCount, patch.toString('latin1').split('\n').length - (patch.at(-1) === 10 ? 1 : 0));
    const cells = rows[i]!.split('|').slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 8);
    assert.equal(cells[1], entry.status);
    for (const [column, path, encoding] of [
      [cells[2]!, entry.oldPath, entry.oldPathEncoding],
      [cells[3]!, entry.newPath, entry.newPathEncoding],
    ]) {
      if (encoding === 'git-quoted') {
        assert.ok(column!.startsWith('git-quoted: '));
        assert.deepEqual(decodeGitPath(column!.slice('git-quoted: '.length)), decodeGitPath(path!));
      } else {
        assert.equal(column === '—' ? null : JSON.parse(column!), path);
      }
    }
    assert.equal(cells[4], entry.patchFile);
    assert.equal(Number(cells[5]), patch.length);
    assert.equal(Number(cells[6]), entry.lineCount);
    assert.equal(cells[7], entry.binary ? 'yes' : 'no');
  }
  return manifest;
}

function record(manifest: RangeDiffManifest, path: string) {
  const entry = manifest.entries.find((entry) => (entry.newPath ?? entry.oldPath) === path);
  assert.ok(entry, `missing entry for ${JSON.stringify(path)}`);
  return entry;
}

test('writes complete ordered patches for additions, deletions, edits, mode changes, type changes and binaries', async (t) => {
  const { cwd, dir } = await repo(t);
  for (const name of ['modified', 'deleted', 'mode', 'type']) await writeFile(join(cwd, name), `${name}\n`);
  await symlink('modified', join(cwd, 'link-to-file'));
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(cwd, 'non-utf8'), Buffer.from([0xff, 10]));
  const base = await commit(cwd);
  await writeFile(join(cwd, 'modified'), 'changed\n');
  await rm(join(cwd, 'deleted'));
  await writeFile(join(cwd, 'added'), 'added\n');
  await chmod(join(cwd, 'mode'), 0o755);
  await rm(join(cwd, 'type'));
  await symlink('modified', join(cwd, 'type'));
  await rm(join(cwd, 'link-to-file'));
  await writeFile(join(cwd, 'link-to-file'), 'regular now\n');
  await writeFile(join(cwd, 'binary'), Buffer.from([0, 4, 5, 6]));
  await writeFile(join(cwd, 'non-utf8'), Buffer.concat([
    Buffer.from([0xfe]), Buffer.from('\rdiff --git fake header\rBinary files fake differ\n'),
  ]));
  const head = await commit(cwd);
  const manifest = await verify(cwd, dir, base, head);
  assert.equal(manifest.entries.length, 8);
  for (const name of ['modified', 'mode', 'non-utf8']) assert.equal(record(manifest, name).status, 'M');
  assert.equal(record(manifest, 'added').oldPath, null);
  assert.equal(record(manifest, 'added').status, 'A');
  assert.equal(record(manifest, 'deleted').newPath, null);
  assert.equal(record(manifest, 'deleted').status, 'D');
  assert.equal(record(manifest, 'binary').binary, true);
  assert.equal(record(manifest, 'non-utf8').binary, false);
  for (const name of ['type', 'link-to-file']) {
    const entry = record(manifest, name);
    assert.equal(entry.status, 'T');
    const patch = await readFile(join(dir, entry.patchFile), 'utf8');
    assert.equal([...patch.matchAll(/^diff --git /gm)].length, 2);
  }
});

test('keeps edited and ambiguous renames paired exactly as the aggregate, and copies are additions', async (t) => {
  const { cwd, dir } = await repo(t);
  const similar = Array.from({ length: 30 }, (_, i) => `shared line ${i}\n`).join('');
  await writeFile(join(cwd, 'old-one'), similar + 'one\n');
  await writeFile(join(cwd, 'old-two'), similar + 'two\n');
  await writeFile(join(cwd, 'copy-source'), 'distinct content to copy\n');
  const base = await commit(cwd);
  await rename(join(cwd, 'old-one'), join(cwd, 'new-one'));
  await rename(join(cwd, 'old-two'), join(cwd, 'new-two'));
  await writeFile(join(cwd, 'new-one'), similar + 'edited one\n');
  await writeFile(join(cwd, 'new-two'), similar + 'edited two\n');
  await copyFile(join(cwd, 'copy-source'), join(cwd, 'copied'));
  const head = await commit(cwd);
  const manifest = await verify(cwd, dir, base, head);
  const metadata = (await git(cwd, 'diff', '--find-renames', '--name-status', '-z', `${base}..${head}`)).toString().split('\0');
  assert.equal(manifest.entries.length, 3);
  for (const entry of manifest.entries.filter((entry) => entry.status.startsWith('R'))) {
    const offset = metadata.indexOf(entry.oldPath!);
    assert.equal(metadata[offset - 1], entry.status);
    assert.equal(metadata[offset + 1], entry.newPath);
    assert.notEqual(entry.status, 'R100');
  }
  assert.equal(manifest.entries.filter((entry) => entry.status.startsWith('R')).length, 2);
  assert.equal(record(manifest, 'copied').status, 'A');
});

test('escapes unusual paths reversibly without interpreting pathspec or Markdown characters', async (t) => {
  const { cwd, dir } = await repo(t);
  await mkdir(join(cwd, 'src'));
  const paths = ['src/a[1].ts', 'src/a1.ts', 'a|b.txt', ':(glob)*', '-option', 'under_score.txt',
    'space b/name', 'tab\tline\nreturn\r.txt', 'quotes"back\\.txt', '`*_[x](y)!#~&<>.txt', 'é😀.txt'];
  await mkdir(join(cwd, 'space b'));
  for (const path of paths) await writeFile(join(cwd, path), 'before\n');
  const base = await commit(cwd);
  for (const path of paths) await writeFile(join(cwd, path), 'after\n');
  // Also exercise quoted old/new paths on a rename header.
  await rename(join(cwd, 'é😀.txt'), join(cwd, 'renamed\t😀.txt'));
  await writeFile(join(cwd, 'renamed\t😀.txt'), 'before\n');
  const head = await commit(cwd);
  const manifest = await verify(cwd, dir, base, head);
  assert.equal(manifest.entries.length, paths.length);
  for (const path of paths.slice(0, -1)) assert.equal(record(manifest, path).status, 'M');
  assert.equal(record(manifest, 'renamed\t😀.txt').oldPath, 'é😀.txt');
  const index = await readFile(manifest.indexPath, 'utf8');
  assert.ok(index.includes('a\\u007cb.txt'));
  assert.ok(index.includes('tab\\tline\\nreturn\\r.txt'));
  assert.ok(index.includes('"src/a[1].ts"'));
  assert.ok(index.includes('"under_score.txt"'));
  assert.ok(index.includes('"`*_[x](y)!#~&<>.txt"'));
});

test('preserves non-UTF-8 path bytes in Git-created trees without checking them out', async (t) => {
  const { cwd, dir } = await repo(t);
  const bytePath = (prefix: string, byte: number) => Buffer.concat([Buffer.from(prefix), Buffer.from([byte]), Buffer.from('|name')]);
  const edited = bytePath('edit-', 0xff);
  const deleted = bytePath('deleted-', 0xfe);
  const added = bytePath('added-', 0xfd);
  const renamedFrom = bytePath('old-', 0xfc);
  const renamedTo = bytePath('new-', 0xfb);
  // A real replacement character must not collide with an invalid byte.
  const valid = Buffer.from('edit-�|name');
  async function tree(entries: [Buffer, string][]) {
    const records: Buffer[] = [];
    for (const [path, content] of entries) {
      const blob = await gitInput(cwd, Buffer.from(content), 'hash-object', '-w', '--stdin');
      records.push(Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), path, Buffer.from([0])]));
    }
    return gitInput(cwd, Buffer.concat(records), 'mktree', '-z');
  }
  const baseTree = await tree([[edited, 'before\n'], [deleted, 'removed\n'], [renamedFrom, 'rename content\n'], [valid, 'valid before\n']]);
  const headTree = await tree([[edited, 'after\n'], [added, 'new addition\n'], [renamedTo, 'rename content\n'], [valid, 'valid after\n']]);
  const base = (await git(cwd, 'commit-tree', baseTree, '-m', 'base')).toString().trim();
  const head = (await git(cwd, 'commit-tree', headTree, '-p', base, '-m', 'head')).toString().trim();
  const manifest = await verify(cwd, dir, base, head);
  const expected: [string, Buffer | null, Buffer | null][] = [
    ['M', edited, edited], ['D', deleted, null], ['A', null, added],
    ['R100', renamedFrom, renamedTo], ['M', valid, valid],
  ];
  assert.equal(manifest.entries.length, expected.length);
  const decoded = manifest.entries.map((entry) => [entry.status,
    entry.oldPath === null ? null : (entry.oldPathEncoding ? decodeGitPath(entry.oldPath) : Buffer.from(entry.oldPath)),
    entry.newPath === null ? null : (entry.newPathEncoding ? decodeGitPath(entry.newPath) : Buffer.from(entry.newPath)),
  ]);
  const sortRecords = (records: unknown[][]) => records.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(sortRecords(decoded), sortRecords(expected));
  assert.equal(manifest.entries.filter((entry) => entry.oldPathEncoding || entry.newPathEncoding).length, 4);
  const index = await readFile(manifest.indexPath, 'utf8');
  assert.ok(index.includes('git-quoted: "edit-\\377\\174name"'));
  assert.ok(index.includes('"edit-�\\u007cname"'));
  assert.deepEqual(await readdir(cwd), ['.git']);
});

test('forces short submodule patches even when nested diffs and ignored submodules are configured', async (t) => {
  const parent = await repo(t);
  const child = await repo(t);
  await writeFile(join(child.cwd, 'source'), 'old\n');
  const childBase = await commit(child.cwd);
  await git(parent.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', child.cwd, 'module');
  const base = await commit(parent.cwd);
  await writeFile(join(child.cwd, 'source'), 'new\n');
  const childHead = await commit(child.cwd);
  await git(join(parent.cwd, 'module'), '-c', 'protocol.file.allow=always', 'fetch');
  await git(join(parent.cwd, 'module'), 'checkout', childHead);
  const head = await commit(parent.cwd);
  await git(parent.cwd, 'config', 'diff.submodule', 'diff');
  await git(parent.cwd, 'config', 'diff.ignoreSubmodules', 'all');
  await git(parent.cwd, 'config', 'submodule.module.ignore', 'all');
  const manifest = await verify(parent.cwd, parent.dir, base, head);
  assert.equal(manifest.entries.length, 1);
  assert.equal(record(manifest, 'module').status, 'M');
  const patch = await readFile(join(parent.dir, '0001.patch'), 'utf8');
  assert.ok(patch.includes(`-Subproject commit ${childBase}`));
  assert.ok(patch.includes(`+Subproject commit ${childHead}`));
  assert.equal([...patch.matchAll(/^diff --git /gm)].length, 1);
});

test('replaces artifacts deterministically, clears stale files, and preserves the old set on invalid revisions', async (t) => {
  const { cwd, dir } = await repo(t);
  const base = await commit(cwd);
  await writeFile(join(cwd, 'one'), 'one\n');
  await writeFile(join(cwd, 'two'), 'two\n');
  const head = await commit(cwd);
  const first = await verify(cwd, dir, base, head);
  const index = await readFile(first.indexPath);
  const patch = await readFile(join(dir, '0001.patch'));
  await writeFile(join(dir, 'stale.patch'), 'stale');
  assert.deepEqual(await writeRangeDiffArtifact({ cwd, dir, base, head }), first);
  assert.deepEqual(await readFile(first.indexPath), index);
  assert.deepEqual(await readFile(join(dir, '0001.patch')), patch);
  assert.deepEqual((await readdir(dir)).sort(), ['0001.patch', '0002.patch', 'index.md']);
  await assert.rejects(writeRangeDiffArtifact({ cwd, dir, base: 'missing-ref', head }));
  assert.deepEqual(await readFile(first.indexPath), index);
  const empty = await verify(cwd, dir, head, head);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.totalBytes, 0);
  assert.deepEqual(await readdir(dir), ['index.md']);
});

test('preserves a multi-megabyte patch including long lines and the final no-newline marker', async (t) => {
  const { cwd, dir } = await repo(t);
  const base = await commit(cwd);
  await writeFile(join(cwd, 'large'), '😀'.repeat(400_000) + '\nlast line');
  const head = await commit(cwd);
  const manifest = await verify(cwd, dir, base, head);
  assert.ok(manifest.totalBytes > 1024 * 1024);
  const patch = await readFile(join(dir, '0001.patch'), 'utf8');
  assert.ok(patch.endsWith('+last line\n\\ No newline at end of file\n'));
});

test('isolates artifact formatting from local diff configuration and external drivers', async (t) => {
  const { cwd, dir } = await repo(t);
  await writeFile(join(cwd, '.gitattributes'), '*.txt diff=custom\n');
  await writeFile(join(cwd, 'a.txt'), 'old\n\nend\n');
  await writeFile(join(cwd, 'z.txt'), 'z\n');
  const base = await commit(cwd);
  await writeFile(join(cwd, 'a.txt'), 'new\n\nend\n');
  await writeFile(join(cwd, 'z.txt'), 'new z\n');
  const head = await commit(cwd);
  const original = await verify(cwd, dir, base, head);
  const patches = await Promise.all(original.entries.map((entry) => readFile(join(dir, entry.patchFile))));
  const orderFile = join(dir, '..', 'order');
  await writeFile(orderFile, 'z*\na*\n');
  for (const [key, value] of Object.entries({
    'color.ui': 'always', 'core.quotePath': 'false', 'core.abbrev': '5',
    'diff.noprefix': 'true', 'diff.mnemonicPrefix': 'true', 'diff.renames': 'copies',
    'diff.algorithm': 'histogram', 'diff.indentHeuristic': 'true', 'diff.context': '0',
    'diff.interHunkContext': '9', 'diff.suppressBlankEmpty': 'true', 'diff.orderFile': orderFile,
    'diff.external': 'false', 'diff.custom.command': 'false', 'diff.custom.textconv': 'false',
  })) await git(cwd, 'config', key, value);
  const isolated = await writeRangeDiffArtifact({ cwd, dir, base, head });
  assert.deepEqual(isolated, original);
  assert.deepEqual(await Promise.all(isolated.entries.map((entry) => readFile(join(dir, entry.patchFile)))), patches);
});
