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
