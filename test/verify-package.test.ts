import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type VerifyPackageModule = {
  requiredPackageEntries: string[];
  describeForbiddenPackageEntry: (entry: string) => string | null;
  collectForbiddenPackageEntries: (entries: string[]) => Array<{ entry: string; reason: string }>;
};

const verifyPackage = await import(
  pathToFileURL(resolve('scripts/verify-package.mjs')).href
) as VerifyPackageModule;

test('package verification requires canonical launch docs', () => {
  assert.ok(verifyPackage.requiredPackageEntries.includes('package/docs/plan-format.md'));
});

test('package verification requires the plan-review convergence doc', () => {
  assert.ok(verifyPackage.requiredPackageEntries.includes('package/docs/review-convergence.md'));
});

test('package verification flags local artifact and secret-bearing entries', () => {
  const forbiddenEntries = [
    'package/tmp/scratch.txt',
    'package/.neal/runs/run/state.json',
    'package/.forge/session.json',
    'package/tmp.benchmarks/run-1/summary.json',
    'package/node_modules/pkg/index.js',
    'package/test/fixture.test.ts',
    'package/test-results/output.json',
    'package/benchmark/results.ndjson',
    'package/src/neal/index.ts',
    'package/.env',
    'package/.env.local',
    'package/.npmrc',
    'package/docs/private.pem',
    'package/docs/id_ed25519',
    'package/dist/local.sqlite',
    'package/docs/debug.log',
    'package/navels-neal-0.1.0.tgz',
    'package/dist/.neal.results.json',
    'package/dist/SUMMARY.md',
    'package/docs/.DS_Store',
    'package/docs/draft.tmp',
  ];

  for (const entry of forbiddenEntries) {
    assert.notEqual(verifyPackage.describeForbiddenPackageEntry(entry), null, entry);
  }
});

test('package verification allows expected runtime and docs entries', () => {
  const allowedEntries = [
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
    'package/docs/assets/neal-execution-flow.png',
  ];

  for (const entry of allowedEntries) {
    assert.equal(verifyPackage.describeForbiddenPackageEntry(entry), null, entry);
  }
});

test('package verification reports every forbidden tar entry with a reason', () => {
  assert.deepEqual(
    verifyPackage.collectForbiddenPackageEntries([
      'package/dist/neal/index.js',
      'package/src/neal/index.ts',
      'package/.env.production',
    ]),
    [
      { entry: 'package/src/neal/index.ts', reason: 'source tree directory' },
      { entry: 'package/.env.production', reason: 'environment secret file' },
    ],
  );
});
