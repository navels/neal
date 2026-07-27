import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

export type WorktreeStatusLine = {
  raw: string;
  pathText: string;
  paths: string[];
};

const LIKELY_SCRATCH_ROOTS = new Set([
  'build_review',
  'build-review',
  'review_build',
  'review-build',
  'review_scratch',
  'review-scratch',
  'reviewer_scratch',
  'reviewer-scratch',
  'scratch',
]);
const WRAPPER_OWNED_PREFIXES = ['.neal/', '.forge/'];
const WRAPPER_OWNED_PATHS = new Set(['.neal', '.forge', 'CURRENT_PLAN.md']);

export function toStoredWorktreePath(cwd: string, path: string): string {
  const absoluteCwd = resolveExistingPath(resolve(cwd));
  const absolutePath = resolveExistingPath(isAbsolute(path) ? resolve(path) : resolve(absoluteCwd, path));
  const relativePath = relative(absoluteCwd, absolutePath);

  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
    return normalize(relativePath);
  }

  return absolutePath;
}

function resolveExistingPath(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function filterAllowedDirtyPathStatus(cwd: string, statusOutput: string, allowedDirtyPaths: string[]): string {
  const allowedPaths = new Set(allowedDirtyPaths.flatMap((path) => allowedDirtyPathKeys(cwd, path)));

  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const paths = parseWorktreeStatusLine(line)?.paths ?? [];
      return paths.length === 0 || paths.some((path) => !allowedPaths.has(toStoredWorktreePath(cwd, path)));
    })
    .join('\n');
}

function allowedDirtyPathKeys(cwd: string, path: string): string[] {
  const storedPath = toStoredWorktreePath(cwd, path);
  if (isAbsolute(path)) {
    return [storedPath];
  }
  return [storedPath, normalize(path)];
}

export function filterWrapperOwnedWorktreeStatus(statusOutput: string): string {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const paths = parseWorktreeStatusLine(line)?.paths ?? [];
      return paths.length === 0 || paths.some((path) => !isWrapperOwnedPath(path));
    })
    .join('\n');
}

export function parseWorktreeStatusLine(line: string): WorktreeStatusLine | null {
  const raw = line.trimEnd();
  if (!raw) {
    return null;
  }

  const pathText = getStatusLinePathText(raw);
  if (!pathText) {
    return {
      raw,
      pathText,
      paths: [],
    };
  }

  return {
    raw,
    pathText,
    paths: pathText.split(' -> ').map((path) => normalize(path)),
  };
}

export function getLikelyScratchLeakPaths(statusOutput: string): string[] {
  const scratchPaths = statusOutput
    .split('\n')
    .map(parseWorktreeStatusLine)
    .filter((entry): entry is WorktreeStatusLine => entry !== null)
    .flatMap((entry) => entry.paths)
    .filter(isLikelyProjectScratchPath);

  return [...new Set(scratchPaths)];
}

export function formatDirtyWorktreeDiagnostic(args: {
  statusOutput: string;
  expectedScratchDirs?: readonly string[];
}): string {
  const scratchPaths = getLikelyScratchLeakPaths(args.statusOutput);
  if (scratchPaths.length === 0) {
    return '';
  }

  const expectedScratchDirs = [...new Set(args.expectedScratchDirs ?? [])].filter(Boolean);
  const lines = [
    'Likely Neal reviewer scratch leakage detected:',
    ...scratchPaths.map((path) => `- ${path}`),
    '',
  ];

  if (expectedScratchDirs.length > 0) {
    lines.push('Expected Neal scratch location(s):', ...expectedScratchDirs.map((path) => `- ${path}`), '');
  } else {
    lines.push('Reviewer scratch should stay under `.neal/runs/<run-id>/scratch/`.', '');
  }

  lines.push(
    'Neal is still blocking because these project-tree paths are not proven Neal-owned. Inspect and move, remove, commit, or stash them outside Neal if appropriate.',
  );

  return lines.join('\n');
}

function isLikelyProjectScratchPath(path: string): boolean {
  if (isAbsolute(path)) {
    return false;
  }

  const normalized = normalize(path).replace(/\\/g, '/').replace(/^\.\//, '');
  const [root] = normalized.split('/');
  return LIKELY_SCRATCH_ROOTS.has(root);
}

export function isWrapperOwnedPath(path: string) {
  if (isAbsolute(path)) {
    return false;
  }

  const normalized = normalize(path)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  return WRAPPER_OWNED_PATHS.has(normalized) || WRAPPER_OWNED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function getStatusLinePathText(line: string) {
  if (line.length >= 3 && line[2] === ' ') {
    return line.slice(3).trim();
  }
  if (line.length >= 2 && line[1] === ' ') {
    return line.slice(2).trim();
  }
  return line.trim();
}
