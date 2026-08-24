import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const expectedBinPath = 'dist/neal/index.js';
export const requiredPackageEntries = [
  'package/package.json',
  'package/dist/neal/index.js',
  'package/README.md',
  'package/LICENSE',
  'package/neal.yml',
  'package/docs/README.md',
  'package/docs/plan-format.md',
  'package/docs/release.md',
  'package/docs/providers.md',
  'package/docs/review-convergence.md',
  'package/docs/storage.md',
  'package/docs/demo.md',
  'package/examples/issue-triage-js/README.md',
  'package/examples/issue-triage-js/PLAN.md',
  'package/examples/issue-triage-js/package.json',
  'package/examples/issue-triage-js/src/issue-triage.js',
  'package/examples/issue-triage-js/test/issue-triage.test.js',
];
const requiredHelpFragments = [
  `neal ${packageJson.version}`,
  'Usage: neal setup',
  'or: neal execute <plan.md> [--no-squash]',
  'or: neal run [--no-squash] <plan.md> [more-plans...]',
  'or: neal status [--json] [--run <run-id>]',
  'or: neal check',
  'or: neal squash [plan.md]',
  'or: neal version',
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function isEntryAtOrBelow(entry, directory) {
  return entry === directory || entry.startsWith(`${directory}/`);
}

export function describeForbiddenPackageEntry(entry) {
  const normalizedEntry = entry.replace(/\/+$/u, '');
  const forbiddenDirectories = [
    ['package/tmp', 'local tmp directory'],
    ['package/.neal', 'local Neal run artifact directory'],
    ['package/.forge', 'local Forge artifact directory'],
    ['package/tmp.benchmarks', 'local benchmark output directory'],
    ['package/node_modules', 'dependency install directory'],
    ['package/test', 'test-only fixture directory'],
    ['package/test-results', 'test output directory'],
    ['package/benchmark', 'benchmark harness directory'],
    ['package/src', 'source tree directory'],
  ];

  for (const [directory, reason] of forbiddenDirectories) {
    if (isEntryAtOrBelow(normalizedEntry, directory)) {
      return reason;
    }
  }

  if (/^package\/\.env(?:$|\.)/u.test(normalizedEntry)) {
    return 'environment secret file';
  }

  const basename = normalizedEntry.split('/').at(-1) ?? normalizedEntry;
  if (basename === '.npmrc' || /^id_(?:rsa|dsa|ecdsa|ed25519)$/u.test(basename)) {
    return 'credential file';
  }
  if (/\.(?:pem|key|p12|pfx)$/iu.test(basename)) {
    return 'credential file';
  }
  if (basename === '.DS_Store' || basename === 'Thumbs.db') {
    return 'transient OS metadata file';
  }
  if (/\.(?:sqlite|sqlite3|db)$/iu.test(basename)) {
    return 'sqlite database file';
  }
  if (/\.log$/iu.test(basename)) {
    return 'log file';
  }
  if (/\.(?:tgz|tar|tar\.gz)$/iu.test(basename)) {
    return 'local package archive';
  }
  if (/\.(?:tmp|swp|bak)$/iu.test(basename) || basename.endsWith('~')) {
    return 'transient editor or backup file';
  }
  if (basename === '.neal.results.json' || basename === 'summary.json' || basename === 'SUMMARY.md') {
    return 'benchmark result artifact';
  }

  return null;
}

export function collectForbiddenPackageEntries(entries) {
  return entries.flatMap((entry) => {
    const reason = describeForbiddenPackageEntry(entry);
    return reason === null ? [] : [{ entry, reason }];
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    ...options,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const combinedOutput = `${stdout}${stderr}`.trim();
    fail(
      `${command} ${args.join(' ')} exited with status ${result.status}`
      + (combinedOutput ? `:\n${combinedOutput}` : ''),
    );
  }

  return {
    stdout,
    stderr,
    combinedOutput: `${stdout}${stderr}`,
  };
}

async function findPackedTarball(packOutput, packDir) {
  const outputCandidates = [
    ...packOutput.matchAll(/(?:^|\s)([^\s'"`]+\.tgz)(?=$|\s)/g),
  ].map((match) => match[1]);

  for (const candidate of outputCandidates) {
    const candidatePath = isAbsolute(candidate) ? candidate : join(packDir, candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const tarballs = (await readdir(packDir))
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(packDir, entry));

  assert(
    tarballs.length === 1,
    `Expected exactly one packed tarball in ${packDir}, found ${tarballs.length}`,
  );

  return tarballs[0];
}

async function main() {
  assert(
    packageJson.bin?.neal === expectedBinPath,
    `Expected package.json bin.neal to be ${expectedBinPath}`,
  );

  const binPath = join(rootDir, expectedBinPath);
  assert(existsSync(binPath), `Expected ${expectedBinPath} to exist before packing`);

  const binContents = await readFile(binPath, 'utf8');
  assert(
    binContents.startsWith('#!/usr/bin/env node'),
    `Expected ${expectedBinPath} to start with a Node shebang`,
  );
  const binIsExecutable = await access(binPath, constants.X_OK).then(() => true, () => false);
  assert(
    binIsExecutable,
    `Expected ${expectedBinPath} to be executable`,
  );

  const packDir = await mkdtemp(join(tmpdir(), 'neal-pack-'));
  const installPrefix = await mkdtemp(join(tmpdir(), 'neal-install-'));
  const packResult = run('pnpm', ['pack', '--pack-destination', packDir]);
  const tarballPath = await findPackedTarball(packResult.combinedOutput, packDir);

  const tarEntries = run('tar', ['-tzf', tarballPath]).stdout.split('\n').filter(Boolean);
  const tarEntrySet = new Set(tarEntries);
  for (const requiredEntry of requiredPackageEntries) {
    assert(tarEntrySet.has(requiredEntry), `Expected package tarball to include ${requiredEntry}`);
  }

  const forbiddenEntries = collectForbiddenPackageEntries(tarEntries);
  assert(
    forbiddenEntries.length === 0,
    [
      'Expected package tarball to exclude local artifacts, credentials, source/test-only files, and transient files.',
      ...forbiddenEntries.map(({ entry, reason }) => `- ${entry} (${reason})`),
    ].join('\n'),
  );

  // Size regression guard: the package is dist + docs + small examples and
  // should stay far under this ceiling. A jump past it means a heavy asset
  // (recording, image, archive) leaked into the tarball.
  const maxTarballBytes = 1_000_000;
  const tarballBytes = (await stat(tarballPath)).size;
  assert(
    tarballBytes <= maxTarballBytes,
    `Expected package tarball to stay under ${maxTarballBytes} bytes, got ${tarballBytes}. `
      + 'A heavy asset has likely leaked into the package (check the files list and docs/).',
  );

  run('npm', ['install', '--global', '--prefix', installPrefix, tarballPath]);

  const nealBinPath = join(installPrefix, 'bin', 'neal');
  const helpResult = run(nealBinPath, ['help']);
  for (const fragment of requiredHelpFragments) {
    assert(
      helpResult.combinedOutput.includes(fragment),
      `Expected installed neal help output to include ${JSON.stringify(fragment)}`,
    );
  }

  console.log(`Verified package tarball: ${tarballPath}`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
