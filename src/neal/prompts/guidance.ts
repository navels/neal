import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type GuidanceRole = 'coder' | 'reviewer' | 'planner';

export const GUIDANCE_ROLES: readonly GuidanceRole[] = ['coder', 'reviewer', 'planner'];

export const GUIDANCE_SECTION_HEADER = '## User Guidance';

const cache = new Map<GuidanceRole, string | null>();

function resolveGuidancePath(role: GuidanceRole) {
  const base = process.env.NEAL_GUIDANCE_DIR ?? join(homedir(), '.config', 'neal', 'guidance');
  return join(base, `${role}.md`);
}

export function loadUserGuidance(role: GuidanceRole): string | null {
  if (cache.has(role)) {
    return cache.get(role) ?? null;
  }

  const path = resolveGuidancePath(role);
  if (!existsSync(path)) {
    cache.set(role, null);
    return null;
  }

  const raw = readFileSync(path, 'utf8');
  const trimmed = raw.replace(/\s+$/g, '');
  const content = trimmed.trim() ? trimmed : null;
  cache.set(role, content);
  return content;
}

export function getUserGuidanceLines(role: GuidanceRole): string[] {
  const content = loadUserGuidance(role);
  if (!content) {
    return [];
  }
  return ['', GUIDANCE_SECTION_HEADER, '', content];
}

export function clearUserGuidanceCache() {
  cache.clear();
}

export type GuidanceDiagnosticsEntry = {
  role: GuidanceRole;
  bytes: number;
  path: string;
};

export function collectGuidanceDiagnostics(): GuidanceDiagnosticsEntry[] {
  const entries: GuidanceDiagnosticsEntry[] = [];
  for (const role of GUIDANCE_ROLES) {
    const content = loadUserGuidance(role);
    if (content === null) continue;
    entries.push({
      role,
      bytes: Buffer.byteLength(content, 'utf8'),
      path: resolveGuidancePath(role),
    });
  }
  return entries;
}
