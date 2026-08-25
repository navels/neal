import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { truncateInlineSectionBody } from '../context/inline-review-context.js';
import type { RunLogger } from '../logger.js';

export type GuidanceRole = 'coder' | 'reviewer' | 'planner';

// Per-role character cap for operator guidance inlined into prompts. Guidance
// beyond the cap is truncated at render time with an explicit marker; the
// guidance file itself is never modified. `neal check` warns when a guidance
// file exceeds this cap.
export const USER_GUIDANCE_MAX_CHARS = 20_000;

export const GUIDANCE_ROLES: readonly GuidanceRole[] = ['coder', 'reviewer', 'planner'];

export const GUIDANCE_SECTION_HEADER = '## User Guidance';

type GuidanceCacheEntry = {
  content: string | null;
  path: string;
};

const cache = new Map<GuidanceRole, GuidanceCacheEntry>();

function resolveGuidancePath(role: GuidanceRole) {
  const overrideDir = process.env.NEAL_GUIDANCE_DIR;
  if (overrideDir !== undefined) {
    return join(overrideDir, `${role}.md`);
  }

  return join(homedir(), '.neal', 'guidance', `${role}.md`);
}

function loadGuidanceEntry(role: GuidanceRole): GuidanceCacheEntry {
  if (cache.has(role)) {
    return cache.get(role)!;
  }

  const path = resolveGuidancePath(role);
  if (!existsSync(path)) {
    const entry = { content: null, path };
    cache.set(role, entry);
    return entry;
  }

  const raw = readFileSync(path, 'utf8');
  const trimmed = raw.replace(/\s+$/g, '');
  const entry = {
    content: trimmed.trim() ? trimmed : null,
    path,
  };
  cache.set(role, entry);
  return entry;
}

export function loadUserGuidance(role: GuidanceRole): string | null {
  return loadGuidanceEntry(role).content;
}

export function getUserGuidanceLines(role: GuidanceRole): string[] {
  const content = loadUserGuidance(role);
  if (!content) {
    return [];
  }
  return ['', GUIDANCE_SECTION_HEADER, '', truncateInlineSectionBody(content, USER_GUIDANCE_MAX_CHARS)];
}

export function clearUserGuidanceCache() {
  cache.clear();
}

export type GuidanceDiagnosticsEntry = {
  role: GuidanceRole;
  bytes: number;
  // Character count of the guidance content, comparable against
  // USER_GUIDANCE_MAX_CHARS (the cap is in characters, not bytes).
  chars: number;
  path: string;
};

export function collectGuidanceDiagnostics(): GuidanceDiagnosticsEntry[] {
  const entries: GuidanceDiagnosticsEntry[] = [];
  for (const role of GUIDANCE_ROLES) {
    const entry = loadGuidanceEntry(role);
    if (entry.content === null) continue;
    entries.push({
      role,
      bytes: Buffer.byteLength(entry.content, 'utf8'),
      chars: entry.content.length,
      path: entry.path,
    });
  }
  return entries;
}

export async function logUserGuidanceApplied(logger: Pick<RunLogger, 'event' | 'stderr'>) {
  const entries = collectGuidanceDiagnostics();
  if (entries.length === 0) {
    await logger.event('run.user_guidance_scanned', { appliedRoles: [] });
    return;
  }

  const summary = entries.map((entry) => ({ role: entry.role, bytes: entry.bytes, path: entry.path }));
  await logger.event('run.user_guidance_applied', { entries: summary });
  const parts = entries.map((entry) => `${entry.role}=${entry.bytes}B`);
  await logger.stderr(`[neal] user guidance applied: ${parts.join(', ')}\n`);
}
