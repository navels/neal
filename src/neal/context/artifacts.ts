import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { NealArtifactCitation, NealContextArtifact } from './shared.js';

export const DEFAULT_CONTEXT_ARTIFACT_BYTE_LIMIT = 16 * 1024;
export const DEFAULT_CONTEXT_TOTAL_BYTE_LIMIT = 96 * 1024;

export type BoundedArtifactReadStrategy = 'head' | 'tail';

export type BoundedArtifactRequest = NealArtifactCitation & {
  path: string;
  readStrategy?: BoundedArtifactReadStrategy;
};

export type ContextByteBudget = {
  perArtifactByteLimit: number;
  totalByteLimit: number;
  usedBytes: number;
};

export async function readBoundedArtifact(
  request: BoundedArtifactRequest,
  budget: ContextByteBudget,
): Promise<NealContextArtifact> {
  if (budget.usedBytes >= budget.totalByteLimit) {
    return omittedArtifact(request, 'total byte limit reached');
  }

  let fileStat;
  try {
    fileStat = await stat(request.path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return omittedArtifact(request, 'missing');
    }
    throw error;
  }

  if (!fileStat.isFile()) {
    return omittedArtifact(request, 'not a regular file');
  }

  const availableBytes = Math.max(0, budget.totalByteLimit - budget.usedBytes);
  const byteLimit = Math.min(budget.perArtifactByteLimit, availableBytes);
  if (byteLimit <= 0) {
    return omittedArtifact(request, 'total byte limit reached');
  }

  const content = await readFileWindow(request.path, fileStat.size, byteLimit, request.readStrategy ?? 'head');
  budget.usedBytes += content.byteLength;

  return {
    label: request.label,
    kind: request.kind,
    content: content.text,
    byteLength: content.byteLength,
    truncated: fileStat.size > content.bytesRead || content.droppedPartialLine,
    omitted: false,
    omissionReason: null,
  };
}

export function makeBoundedInlineArtifact(
  citation: NealArtifactCitation,
  content: string,
  budget: ContextByteBudget,
): NealContextArtifact {
  if (budget.usedBytes >= budget.totalByteLimit) {
    return omittedArtifact(citation, 'total byte limit reached');
  }

  const availableBytes = Math.max(0, budget.totalByteLimit - budget.usedBytes);
  const byteLimit = Math.min(budget.perArtifactByteLimit, availableBytes);
  const buffer = Buffer.from(content, 'utf8');
  const truncated = buffer.byteLength > byteLimit;
  const boundedBuffer = truncated ? buffer.subarray(0, byteLimit) : buffer;
  const boundedContent = boundedBuffer.toString('utf8');
  const byteLength = boundedBuffer.byteLength;
  budget.usedBytes += byteLength;

  return {
    ...citation,
    content: boundedContent,
    byteLength,
    truncated,
    omitted: false,
    omissionReason: null,
  };
}

export async function findLatestRetrospectiveArtifact(runDir: string): Promise<BoundedArtifactRequest | null> {
  const defaultPath = join(runDir, 'RETROSPECTIVE.md');
  try {
    const defaultStat = await stat(defaultPath);
    if (defaultStat.isFile()) {
      return {
        label: 'RETROSPECTIVE.md',
        kind: 'run_artifact',
        path: defaultPath,
      };
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isFile() && /^RETROSPECTIVE-.+\.md$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latestName = names.at(-1);
  if (!latestName) {
    return null;
  }

  return {
    label: latestName,
    kind: 'run_artifact',
    path: join(runDir, latestName),
  };
}

function omittedArtifact(citation: NealArtifactCitation, reason: string): NealContextArtifact {
  return {
    ...citation,
    content: '',
    byteLength: 0,
    truncated: false,
    omitted: true,
    omissionReason: reason,
  };
}

async function readFileWindow(
  path: string,
  fileSize: number,
  byteLimit: number,
  strategy: BoundedArtifactReadStrategy,
): Promise<{ text: string; byteLength: number; bytesRead: number; droppedPartialLine: boolean }> {
  const file = await open(path, 'r');
  try {
    const length = Math.min(fileSize, byteLimit);
    const start = strategy === 'tail' ? Math.max(0, fileSize - length) : 0;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    let boundedBuffer = buffer.subarray(0, bytesRead);
    let droppedPartialLine = false;

    if (strategy === 'tail' && start > 0) {
      const newlineIndex = boundedBuffer.indexOf('\n');
      if (newlineIndex >= 0) {
        boundedBuffer = boundedBuffer.subarray(newlineIndex + 1);
        droppedPartialLine = true;
      }
    }

    return {
      text: boundedBuffer.toString('utf8'),
      byteLength: boundedBuffer.byteLength,
      bytesRead,
      droppedPartialLine,
    };
  } finally {
    await file.close();
  }
}

function isNotFoundError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
