import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function makeCommand(binDir: string, name: string, source: string) {
  const path = join(binDir, name);
  await writeFile(path, source, 'utf8');
  await chmod(path, 0o755);
}

test('real release validation accepts published npm and existing tag state for recovery', async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'neal-release-validation-'));
  const outputPath = join(binDir, 'github-output');
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string };

  try {
    await makeCommand(
      binDir,
      'npm',
      '#!/bin/sh\nprintf \'"%s"\\n\' "$RELEASE_VERSION"\n',
    );
    await makeCommand(
      binDir,
      'git',
      [
        '#!/bin/sh',
        'if [ "$1 $2 $3" = "remote get-url origin" ]; then',
        '  printf \'https://github.com/navels/neal.git\\n\'',
        '  exit 0',
        'fi',
        'printf \'abc123\\trefs/tags/v%s\\n\' "$RELEASE_VERSION"',
        '',
      ].join('\n'),
    );

    const result = spawnSync(process.execPath, ['scripts/validate-release.mjs'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        RELEASE_VERSION: packageJson.version,
        RELEASE_DRY_RUN: 'false',
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_OUTPUT: outputPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Existing release state found/);
    assert.equal(await readFile(outputPath, 'utf8'), 'npm_published=true\n');
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
});

// A fake npm that reports the release version as unpublished and answers the
// `dist-tags.latest` query with the given version.
function npmWithLatest(latest: string) {
  return [
    '#!/bin/sh',
    'case "$*" in',
    `  *dist-tags.latest*) printf '"%s"\\n' "${latest}"; exit 0 ;;`,
    'esac',
    `printf '{"error":{"code":"E404","summary":"not found"}}\\n'`,
    'exit 1',
    '',
  ].join('\n');
}

const gitWithFreeTag = [
  '#!/bin/sh',
  'if [ "$1 $2 $3" = "remote get-url origin" ]; then',
  "  printf 'https://github.com/navels/neal.git\\n'",
  '  exit 0',
  'fi',
  'exit 2',
  '',
].join('\n');

async function runValidationAgainstLatest(latest: string) {
  const binDir = await mkdtemp(join(tmpdir(), 'neal-release-validation-latest-'));
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string };
  try {
    await makeCommand(binDir, 'npm', npmWithLatest(latest));
    await makeCommand(binDir, 'git', gitWithFreeTag);
    return spawnSync(process.execPath, ['scripts/validate-release.mjs'], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        RELEASE_VERSION: packageJson.version,
        RELEASE_DRY_RUN: 'true',
        GITHUB_ACTIONS: '',
        GITHUB_OUTPUT: '',
      },
    });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

test('release validation rejects a free version that is not higher than the npm latest', async () => {
  const result = await runValidationAgainstLatest('999.0.0');
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /is not higher than 999\.0\.0/);
});

test('release validation accepts a free version that is higher than the npm latest', async () => {
  const result = await runValidationAgainstLatest('0.0.1');
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /is higher than the current npm latest, 0\.0\.1/);
});
