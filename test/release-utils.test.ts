import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ProvenanceStatement = Record<string, unknown>;

type ReleaseUtilsModule = {
  getChangelogSection: (markdown: string, version: string) => string;
  compareReleaseVersions: (a: string, b: string) => number;
  assertVersionAdvancesLatest: (args: { version: string; latestVersion: string | null; npmPublished: boolean }) => void;
  parseProvenanceStatement: (response: unknown) => ProvenanceStatement;
  assertReleaseProvenance: (
    statement: ProvenanceStatement,
    expected: {
      packageName: string;
      version: string;
      repository: string;
      workflowPath: string;
      ref: string;
      commit: string;
    },
  ) => void;
  parseRemoteTagTarget: (output: string, tagName: string) => string | null;
  assertReleaseStateAllowed: (state: {
    dryRun: boolean;
    npmPublished: boolean;
    tagExists: boolean;
    version: string;
  }) => void;
  isRegistryPropagationError: (error: unknown) => boolean;
  retryWhilePropagating: <T>(
    label: string,
    attempt: () => T | Promise<T>,
    options?: {
      timeoutMs?: number;
      intervalMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      log?: (message: string) => void;
    },
  ) => Promise<T>;
};

const releaseUtils = await import(
  pathToFileURL(resolve('scripts/release-utils.mjs')).href
) as ReleaseUtilsModule;

const expectedProvenance = {
  packageName: '@navels/neal',
  version: '0.3.1',
  repository: 'https://github.com/navels/neal',
  workflowPath: '.github/workflows/publish.yml',
  ref: 'refs/heads/main',
  commit: 'abc123',
};

function provenanceStatement(commit = 'abc123') {
  return {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'pkg:npm/%40navels/neal@0.3.1' }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: 'refs/heads/main',
            repository: 'https://github.com/navels/neal',
            path: '.github/workflows/publish.yml',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/navels/neal@refs/heads/main',
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
}

test('getChangelogSection returns only the requested release notes', () => {
  const markdown = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    'Future work.',
    '',
    '## [0.3.1] - 2026-07-27',
    '',
    'Initial public release.',
    '',
    '## [0.3.0] - 2026-07-26',
    '',
    'Old notes.',
  ].join('\n');

  assert.equal(releaseUtils.getChangelogSection(markdown, '0.3.1'), 'Initial public release.');
});

test('getChangelogSection rejects missing and empty release notes', () => {
  assert.throws(
    () => releaseUtils.getChangelogSection('# Changelog\n', '0.3.1'),
    /missing a ## \[0\.3\.1\] section/,
  );
  assert.throws(
    () => releaseUtils.getChangelogSection('## [0.3.1]\n\n## [0.3.0]\nOld notes.\n', '0.3.1'),
    /section ## \[0\.3\.1\] is empty/,
  );
});

test('parseProvenanceStatement decodes the SLSA payload', () => {
  const statement = provenanceStatement();
  const response = {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          },
        },
      },
    ],
  };

  assert.deepEqual(releaseUtils.parseProvenanceStatement(response), statement);
});

test('assertReleaseProvenance requires the expected source commit and workflow', () => {
  assert.doesNotThrow(() => {
    releaseUtils.assertReleaseProvenance(provenanceStatement(), expectedProvenance);
  });
  assert.throws(
    () => releaseUtils.assertReleaseProvenance(provenanceStatement('wrong-sha'), expectedProvenance),
    /expected commit abc123/,
  );
});

test('parseRemoteTagTarget prefers an annotated tag peeled commit', () => {
  const output = [
    'tag-object\trefs/tags/v0.3.1',
    'commit-sha\trefs/tags/v0.3.1^{}',
  ].join('\n');

  assert.equal(releaseUtils.parseRemoteTagTarget(output, 'v0.3.1'), 'commit-sha');
  assert.equal(releaseUtils.parseRemoteTagTarget('', 'v0.3.1'), null);
});

test('release-state recovery is allowed only on the real-publish path', () => {
  assert.doesNotThrow(() => {
    releaseUtils.assertReleaseStateAllowed({
      dryRun: false,
      npmPublished: true,
      tagExists: true,
      version: '0.3.1',
    });
  });
  assert.throws(
    () => releaseUtils.assertReleaseStateAllowed({
      dryRun: true,
      npmPublished: true,
      tagExists: false,
      version: '0.3.1',
    }),
    /npm package @navels\/neal@0\.3\.1 already exists/,
  );
  assert.throws(
    () => releaseUtils.assertReleaseStateAllowed({
      dryRun: true,
      npmPublished: false,
      tagExists: true,
      version: '0.3.1',
    }),
    /Remote tag v0\.3\.1 already exists/,
  );
});

test('isRegistryPropagationError matches only registry 404s', () => {
  assert.equal(releaseUtils.isRegistryPropagationError(new Error('npm error code E404')), true);
  assert.equal(releaseUtils.isRegistryPropagationError(new Error('Unable to fetch npm attestations: HTTP 404.')), true);
  assert.equal(releaseUtils.isRegistryPropagationError(new Error('npm error code E403 Forbidden')), false);
  assert.equal(releaseUtils.isRegistryPropagationError(new Error('provenance commit mismatch')), false);
  assert.equal(releaseUtils.isRegistryPropagationError(undefined), false);
});

test('retryWhilePropagating polls a lagging registry read until it succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await releaseUtils.retryWhilePropagating(
    '@navels/neal@0.3.1',
    () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('npm error code E404\nnpm error 404 No match found for version 0.3.1');
      }
      return 'visible';
    },
    {
      intervalMs: 10_000,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: () => {},
    },
  );

  assert.equal(result, 'visible');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10_000, 10_000]);
});

test('retryWhilePropagating rethrows a real failure without polling', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      releaseUtils.retryWhilePropagating(
        'signed attestations',
        () => {
          calls += 1;
          throw new Error('npm error code EINTEGRITY signature mismatch');
        },
        { sleep: async () => {}, log: () => {} },
      ),
    /EINTEGRITY/,
  );
  assert.equal(calls, 1, 'a non-propagation failure must fail the release immediately');
});

test('retryWhilePropagating gives up once the propagation window closes', async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    () =>
      releaseUtils.retryWhilePropagating(
        '@navels/neal@0.3.1',
        () => {
          calls += 1;
          throw new Error('npm error code E404');
        },
        {
          timeoutMs: 30_000,
          intervalMs: 10_000,
          now: () => clock,
          sleep: async (ms: number) => {
            clock += ms;
          },
          log: () => {},
        },
      ),
    /E404/,
  );
  assert.equal(calls, 4, 'polls through the window, then surfaces the registry error');
});

test('release versions compare by SemVer precedence, not as strings', () => {
  const { compareReleaseVersions } = releaseUtils;
  assert.ok(compareReleaseVersions('0.8.1', '0.8.0') > 0);
  assert.ok(compareReleaseVersions('0.7.1', '0.8.0') < 0);
  assert.ok(compareReleaseVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareReleaseVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareReleaseVersions('0.8.0', '0.8.0'), 0);
  assert.ok(compareReleaseVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareReleaseVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0);
  assert.ok(compareReleaseVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  // Numeric identifiers have no upper bound, so they can't go through Number.
  assert.ok(compareReleaseVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992') > 0);
  assert.ok(compareReleaseVersions('9007199254740993.0.0', '9007199254740992.0.0') > 0);
  // Numeric identifiers rank below alphanumeric ones.
  assert.ok(compareReleaseVersions('1.0.0-1', '1.0.0-alpha') < 0);
  assert.throws(() => compareReleaseVersions('v0.8.0', '0.8.0'), /Not a SemVer version/);
});

// The 0.7.1 incident: an unused version number that sits below the published
// latest passed every check until `npm publish` refused it, after the release
// prep had already merged.
test('a release must be numbered after the version npm serves as latest', () => {
  const { assertVersionAdvancesLatest } = releaseUtils;
  assert.throws(
    () => assertVersionAdvancesLatest({ version: '0.7.1', latestVersion: '0.8.0', npmPublished: false }),
    /0\.7\.1 is not higher than 0\.8\.0/,
  );
  assert.throws(
    () => assertVersionAdvancesLatest({ version: '0.8.0', latestVersion: '0.8.0', npmPublished: false }),
    /not higher than/,
  );
  assertVersionAdvancesLatest({ version: '0.8.1', latestVersion: '0.8.0', npmPublished: false });
  // Recovery reruns target a version that is already public.
  assertVersionAdvancesLatest({ version: '0.8.0', latestVersion: '0.8.0', npmPublished: true });
  // A package that has never been published has no latest.
  assertVersionAdvancesLatest({ version: '0.1.0', latestVersion: null, npmPublished: false });
});
