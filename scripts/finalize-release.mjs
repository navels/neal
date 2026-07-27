import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseProvenance,
  getChangelogSection,
  parseProvenanceStatement,
  parseRemoteTagTarget,
} from './release-utils.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = '@navels/neal';
const version = process.env.RELEASE_VERSION ?? '';
const commit = process.env.GITHUB_SHA ?? '';
const repositorySlug = process.env.GITHUB_REPOSITORY ?? '';
const repository = `https://github.com/${repositorySlug}`;
const tagName = `v${version}`;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    fail([
      `Command failed: ${command} ${args.join(' ')}`,
      result.error?.message,
      output,
    ].filter(Boolean).join('\n'));
  }

  return result.stdout ?? '';
}

async function verifySignedAttestations() {
  const auditDir = await mkdtemp(join(tmpdir(), 'neal-release-audit-'));
  try {
    await writeFile(
      join(auditDir, 'package.json'),
      `${JSON.stringify({ private: true, dependencies: { [packageName]: version } }, null, 2)}\n`,
      'utf8',
    );
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: auditDir });
    run('npm', ['audit', 'signatures'], { cwd: auditDir });
  } finally {
    await rm(auditDir, { recursive: true, force: true });
  }
}

async function fetchProvenance() {
  const encodedPackage = encodeURIComponent(packageName);
  const response = await fetch(
    `https://registry.npmjs.org/-/npm/v1/attestations/${encodedPackage}@${version}`,
  );
  if (!response.ok) {
    fail(`Unable to fetch npm attestations: HTTP ${response.status}.`);
  }
  return response.json();
}

assert(version, 'RELEASE_VERSION is required.');
assert(commit, 'GITHUB_SHA is required.');
assert(repositorySlug === 'navels/neal', `Expected GITHUB_REPOSITORY navels/neal; got ${repositorySlug || 'unset'}.`);
assert(process.env.GITHUB_REF === 'refs/heads/main', `Expected GITHUB_REF refs/heads/main; got ${process.env.GITHUB_REF ?? 'unset'}.`);
assert(process.env.GH_TOKEN, 'GH_TOKEN is required.');

run('npm', ['view', `${packageName}@${version}`, 'version', '--json']);
await verifySignedAttestations();

const attestationResponse = await fetchProvenance();
const statement = parseProvenanceStatement(attestationResponse);
assertReleaseProvenance(statement, {
  packageName,
  version,
  repository,
  workflowPath: '.github/workflows/publish.yml',
  ref: 'refs/heads/main',
  commit,
});
console.log(`Verified signed npm provenance for ${packageName}@${version} at ${commit}.`);

const changelog = await readFile(join(rootDir, 'CHANGELOG.md'), 'utf8');
const releaseNotes = getChangelogSection(changelog, version);
const remoteTags = run('git', [
  'ls-remote',
  '--tags',
  'origin',
  `refs/tags/${tagName}`,
  `refs/tags/${tagName}^{}`,
]);
const remoteTagTarget = parseRemoteTagTarget(remoteTags, tagName);

if (remoteTagTarget && remoteTagTarget !== commit) {
  fail(`Remote tag ${tagName} points to ${remoteTagTarget}, not ${commit}.`);
}

const releaseView = spawnSync('gh', ['release', 'view', tagName, '--repo', repositorySlug, '--json', 'url'], {
  cwd: rootDir,
  encoding: 'utf8',
  env: process.env,
});

if (releaseView.status === 0) {
  assert(remoteTagTarget === commit, `GitHub release ${tagName} exists without the expected remote tag.`);
  console.log(`GitHub release ${tagName} already exists at the expected commit.`);
} else {
  const args = [
    'release',
    'create',
    tagName,
    '--repo',
    repositorySlug,
    '--title',
    tagName,
    '--notes',
    releaseNotes,
  ];
  if (remoteTagTarget) {
    args.push('--verify-tag');
  } else {
    args.push('--target', commit);
  }
  run('gh', args);
  console.log(`Created GitHub release ${tagName} at ${commit}.`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `\n## Release complete\n\n- npm: \`${packageName}@${version}\`\n- GitHub: \`${tagName}\` at \`${commit}\`\n`,
    'utf8',
  );
}
