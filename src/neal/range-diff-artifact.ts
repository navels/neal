import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface RangeDiffEntry {
  number: number;
  status: string;
  oldPath: string | null;
  newPath: string | null;
  // Absent means ordinary UTF-8; otherwise the path is a lossless Git C string.
  oldPathEncoding?: 'git-quoted';
  newPathEncoding?: 'git-quoted';
  patchFile: string;
  byteCount: number;
  lineCount: number;
  binary: boolean;
}

export interface RangeDiffManifest {
  base: string;
  head: string;
  indexPath: string;
  totalBytes: number;
  entries: RangeDiffEntry[];
}

async function git(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

function parseRecords(output: Buffer): { status: string; oldPath: Buffer | null; newPath: Buffer | null }[] {
  if (!output.length) return [];
  const fields: Buffer[] = [];
  let start = 0;
  for (let end = output.indexOf(0); end !== -1; end = output.indexOf(0, start)) {
    fields.push(output.subarray(start, end));
    start = end + 1;
  }
  if (start !== output.length) throw new Error('Unterminated range diff metadata');
  const records: { status: string; oldPath: Buffer | null; newPath: Buffer | null }[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]?.toString('utf8');
    const path = fields[i++];
    if (!status || !/^(?:[AMDT]|R\d+)$/.test(status) || !path?.length) {
      throw new Error('Invalid range diff metadata record');
    }
    const newPath = status.startsWith('R') ? fields[i++] : path;
    if (!newPath?.length) throw new Error('Missing rename destination in range diff metadata');
    records.push({ status, oldPath: status === 'A' ? null : path, newPath: status === 'D' ? null : newPath });
  }
  return records;
}

// Match Git's core.quotePath=true C quoting without trying to split headers on
// spaces: ordinary spaces in Git paths are deliberately not quoted.
function quoteGitPath(path: Buffer): string {
  let quoted = false;
  const escapes: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
  let body = '';
  for (const byte of path) {
    if (byte < 32 || byte >= 127 || byte === 34 || byte === 92) {
      quoted = true;
      body += escapes[byte] ?? `\\${byte.toString(8).padStart(3, '0')}`;
    } else {
      body += String.fromCharCode(byte);
    }
  }
  return quoted ? `"${body}"` : body;
}

function splitBlocks(diff: Buffer): Buffer[] {
  if (!diff.length) return [];
  if (!diff.subarray(0, 11).equals(Buffer.from('diff --git '))) throw new Error('Range diff has no initial patch header');
  // Only LF separates Git lines. A CR inside source text must not become a
  // header boundary, and non-UTF-8 source bytes must survive unchanged.
  const offsets = [0];
  const separator = Buffer.from('\ndiff --git ');
  for (let offset = diff.indexOf(separator); offset !== -1; offset = diff.indexOf(separator, offset + 1)) {
    offsets.push(offset + 1);
  }
  return offsets.map((offset, i) => diff.subarray(offset, offsets[i + 1] ?? diff.length));
}

function displayPath(path: Buffer | null): { text: string | null; encoding?: 'git-quoted' } {
  if (path === null) return { text: null };
  const text = path.toString('utf8');
  return Buffer.from(text).equals(path) ? { text } : { text: quoteGitPath(path), encoding: 'git-quoted' };
}

function escapeCell(value: string | null, encoding?: 'git-quoted'): string {
  if (value === null) return '—';
  if (encoding === 'git-quoted') return `git-quoted: ${value.replace(/\|/g, '\\174')}`;
  // Keep ordinary paths readable; only pipes need escaping beyond JSON's
  // quoting and control-character escapes to preserve the table's columns.
  return JSON.stringify(value).replace(/\|/g, '\\u007c');
}

function renderIndex(manifest: RangeDiffManifest): string {
  return [
    '# Range diff index', '',
    `Range: ${manifest.base}..${manifest.head}`,
    `Entries: ${manifest.entries.length}`,
    `Total patch bytes: ${manifest.totalBytes}`, '',
    'This index is the complete list of changed records. Patch filenames are relative to this index.',
    'Paths are repository-relative JSON strings (decode with JSON.parse); pipes use \\u007c. — means absent.',
    'Non-UTF-8 paths are labeled git-quoted: and use Git C quoting with octal byte escapes (including \\174 for pipes). Decode these to bytes, not UTF-8; their numbered patch files remain directly readable.',
    'Byte counts describe raw patch files; line counts include a final unterminated line. Binary patches contain Git’s text summary, not raw binary data.', '',
    '| # | Status | Old path | New path | Patch file | Bytes | Lines | Binary |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...manifest.entries.map((entry) => `| ${entry.number} | ${entry.status} | ${escapeCell(entry.oldPath, entry.oldPathEncoding)} | ${escapeCell(entry.newPath, entry.newPathEncoding)} | ${entry.patchFile} | ${entry.byteCount} | ${entry.lineCount} | ${entry.binary ? 'yes' : 'no'} |`),
    '',
  ].join('\n');
}

/** Owns dir's contents. Each file is replaced atomically; the set is not a transaction. */
export async function writeRangeDiffArtifact(args: {
  cwd: string;
  base: string;
  head: string;
  dir: string;
}): Promise<RangeDiffManifest> {
  const { cwd } = args;
  const base = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${args.base}^{commit}`])).toString().trim();
  const head = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${args.head}^{commit}`])).toString().trim();
  const diffArgs = [
    '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative',
    '--submodule=short', '--ignore-submodules=none', '--no-renames', '--find-renames=50%', '-l0',
    '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0',
    '--src-prefix=a/', '--dst-prefix=b/', '--line-prefix=', '--full-index', '--word-diff=none',
    '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', '-O/dev/null',
  ];
  const diff = await git(cwd, [...diffArgs, '--patch', `${base}..${head}`, '--']);
  const records = parseRecords(await git(cwd, [...diffArgs, '--name-status', '-z', `${base}..${head}`, '--']));
  const blocks = splitBlocks(diff);
  const patches: Buffer[] = [];
  let blockIndex = 0;
  const entries = records.map((record, i): RangeDiffEntry => {
    const header = `diff --git ${quoteGitPath(Buffer.concat([Buffer.from('a/'), (record.oldPath ?? record.newPath)!]))} ${quoteGitPath(Buffer.concat([Buffer.from('b/'), (record.newPath ?? record.oldPath)!]))}\n`;
    // Git renders a type change as adjacent deletion/addition blocks, while
    // --name-status reports one T record. Keep both in that entry's patch.
    const count = record.status === 'T' ? 2 : 1;
    const entryBlocks = blocks.slice(blockIndex, blockIndex + count);
    if (entryBlocks.length !== count || entryBlocks.some((block) => !block.subarray(0, Buffer.byteLength(header)).equals(Buffer.from(header)))) {
      throw new Error(`Range diff patch/metadata order mismatch at entry ${i + 1}`);
    }
    blockIndex += count;
    const patch = Buffer.concat(entryBlocks);
    patches.push(patch);
    let lineCount = 0;
    for (const byte of patch) if (byte === 10) lineCount += 1;
    if (patch.length && patch[patch.length - 1] !== 10) lineCount += 1;
    const oldPath = displayPath(record.oldPath);
    const newPath = displayPath(record.newPath);
    return {
      status: record.status, oldPath: oldPath.text, newPath: newPath.text,
      ...(oldPath.encoding ? { oldPathEncoding: oldPath.encoding } : {}),
      ...(newPath.encoding ? { newPathEncoding: newPath.encoding } : {}),
      number: i + 1, patchFile: `${String(i + 1).padStart(4, '0')}.patch`,
      byteCount: patch.length, lineCount, binary: /(?:^|\n)Binary files [^\n]* differ\n/.test(patch.toString('latin1')),
    };
  });
  if (blockIndex !== blocks.length) throw new Error('Range diff patch/metadata count mismatch');

  const dir = resolve(cwd, args.dir);
  const manifest: RangeDiffManifest = { base, head, indexPath: join(dir, 'index.md'), totalBytes: diff.length, entries };
  // Finish Git queries and validation before touching an existing artifact.
  await mkdir(dir, { recursive: true });
  const staging = await mkdtemp(join(dir, '.write-'));
  try {
    for (const [i, entry] of entries.entries()) {
      await writeFile(join(staging, entry.patchFile), patches[i]!);
      await rename(join(staging, entry.patchFile), join(dir, entry.patchFile));
    }
    const keep = new Set(['index.md', ...entries.map((entry) => entry.patchFile)]);
    for (const name of await readdir(dir)) {
      if (!keep.has(name) && join(dir, name) !== staging) await rm(join(dir, name), { recursive: true, force: true });
    }
    await writeFile(join(staging, 'index.md'), renderIndex(manifest), 'utf8');
    await rename(join(staging, 'index.md'), manifest.indexPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}
