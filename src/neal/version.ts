import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

type PackageMetadata = {
  version?: unknown;
};

export type NealBuildMetadata = {
  packageVersion: string;
  nodeVersion: string;
  sourceGitSha: string | null;
};

let cachedBuildMetadata: Promise<NealBuildMetadata> | null = null;

export function getAppVersion() {
  const packageJsonPath = new URL('../../package.json', import.meta.url);
  const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageMetadata;
  if (typeof metadata.version !== 'string' || metadata.version.trim() === '') {
    throw new Error('package.json is missing a valid version');
  }
  return metadata.version;
}

export async function getNealBuildMetadata(): Promise<NealBuildMetadata> {
  cachedBuildMetadata ??= readNealBuildMetadata();
  return cachedBuildMetadata;
}

async function readNealBuildMetadata(): Promise<NealBuildMetadata> {
  return {
    packageVersion: getAppVersion(),
    nodeVersion: process.version,
    sourceGitSha: await readSourceGitSha(),
  };
}

async function readSourceGitSha() {
  const packageRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
  try {
    const { stdout } = await execFileAsync('git', ['-C', packageRoot, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
