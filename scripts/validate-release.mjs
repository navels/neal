import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const expectedPackageName = '@navels/neal';
const expectedBinPath = 'dist/neal/index.js';
const requiredFiles = [
  'dist',
  'README.md',
  'LICENSE',
  'neal.yml',
  'docs',
];
const directSdkDependencies = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  'ai',
  '@ai-sdk/openai-compatible',
  'zod',
];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function describeDependencySpec(spec) {
  return spec === undefined ? 'missing' : JSON.stringify(spec);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    return {
      status: null,
      stdout,
      stderr,
      combinedOutput: result.error.message,
      error: result.error,
    };
  }

  return {
    status: result.status,
    stdout,
    stderr,
    combinedOutput: `${stdout}${stderr}`.trim(),
    error: null,
  };
}

function describeCommandFailure(command, args, result) {
  return [
    `Command failed: ${command} ${args.join(' ')}`,
    result.status === null ? 'exit status: unavailable' : `exit status: ${result.status}`,
    result.combinedOutput ? `output:\n${result.combinedOutput}` : '',
  ].filter(Boolean).join('\n');
}

function isNpmNotFound(result) {
  if (result.status !== 1) {
    return false;
  }

  for (const output of [result.stdout, result.stderr]) {
    try {
      const parsed = JSON.parse(output);
      if (parsed?.error?.code === 'E404') {
        return true;
      }
    } catch {
      // npm may print plain text diagnostics around the JSON object.
    }
  }

  return result.combinedOutput.includes('E404');
}

const releaseVersion = process.env.RELEASE_VERSION ?? '';
const dryRunInput = process.env.RELEASE_DRY_RUN ?? '';
const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';

assert(releaseVersion, 'RELEASE_VERSION is required.');
assert(
  semverPattern.test(releaseVersion),
  'RELEASE_VERSION must be an exact SemVer version without a leading v.',
);
assert(
  dryRunInput === 'true' || dryRunInput === 'false',
  'RELEASE_DRY_RUN must be either true or false.',
);

const dryRun = dryRunInput === 'true';

assert(
  packageJson.name === expectedPackageName,
  `Expected package.json name to be ${expectedPackageName}.`,
);
assert(
  packageJson.version === releaseVersion,
  `Expected package.json version ${packageJson.version} to match RELEASE_VERSION ${releaseVersion}.`,
);
assert(
  packageJson.bin?.neal === expectedBinPath,
  `Expected package.json bin.neal to be ${expectedBinPath}.`,
);
for (const requiredFile of requiredFiles) {
  assert(
    packageJson.files?.includes(requiredFile),
    `Expected package.json files to include ${requiredFile}.`,
  );
}

for (const dependencyName of directSdkDependencies) {
  const spec = packageJson.dependencies?.[dependencyName];
  assert(
    typeof spec === 'string' && semverPattern.test(spec),
    `Direct SDK dependency ${dependencyName} must use an exact SemVer spec; invalid spec: ${describeDependencySpec(spec)}.`,
  );
}

if (!dryRun && packageJson.private === true) {
  fail('RELEASE_DRY_RUN=false is not allowed while package.json private is true.');
}

if (dryRun && packageJson.private === true) {
  console.log('Notice: package.json is private, so publish dry-run is intentionally skipped.');
}

if (isGitHubActions) {
  assert(
    process.env.GITHUB_REF === 'refs/heads/main',
    `Publish workflow must run from refs/heads/main; got ${process.env.GITHUB_REF ?? 'unset'}.`,
  );
}

const npmArgs = ['view', `${expectedPackageName}@${releaseVersion}`, 'version', '--json'];
const npmResult = run('npm', npmArgs);
if (npmResult.status === 0) {
  fail(`npm package ${expectedPackageName}@${releaseVersion} already exists.`);
}
if (!isNpmNotFound(npmResult)) {
  fail(`Unable to verify npm registry availability.\n${describeCommandFailure('npm', npmArgs, npmResult)}`);
}

console.log(`npm package ${expectedPackageName}@${releaseVersion} is available.`);

const remoteResult = run('git', ['remote', 'get-url', 'origin']);
if (remoteResult.status === 0) {
  const tagName = `v${releaseVersion}`;
  const tagArgs = ['ls-remote', '--exit-code', '--tags', 'origin', tagName];
  const tagResult = run('git', tagArgs);

  if (tagResult.status === 0) {
    fail(`Remote tag ${tagName} already exists on origin.`);
  }

  if (tagResult.status === 2) {
    console.log(`Remote tag ${tagName} is available.`);
  } else {
    const diagnostic = describeCommandFailure('git', tagArgs, tagResult);
    if (isGitHubActions) {
      fail(`Unable to verify remote tag availability.\n${diagnostic}`);
    }

    console.warn(`Warning: unable to verify remote tag availability locally.\n${diagnostic}`);
  }
} else {
  console.log('No origin remote is configured; skipping remote tag check.');
}

console.log(`Release validation passed for ${expectedPackageName}@${releaseVersion} (dry_run=${dryRunInput}).`);
