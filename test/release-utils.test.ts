import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ProvenanceStatement = Record<string, unknown>;

type ReleaseUtilsModule = {
  getChangelogSection: (markdown: string, version: string) => string;
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
