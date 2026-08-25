import { NealProviderError } from './types.js';
import type { ProviderId, ProviderRole } from './types.js';

// Provider-agnostic input-budget preflight. An adapter whose role capabilities
// declare `maxInputChars` calls `assertPromptWithinInputBudget` at the top of
// its turn/round entry points, so every call site is covered without per-site
// wiring and an over-limit prompt never reaches the SDK. The thrown error is a
// non-retryable `input_too_large` whose message names the prompt size, the
// limit, and the three largest sections; that message rides the normal
// `provider_error` event into `neal status`, so it stays a few short lines to
// survive status's 1,000-char message truncation.

export type PromptSectionSize = {
  name: string;
  chars: number;
};

const REPORTED_SECTION_COUNT = 3;
const SECTION_NAME_MAX_CHARS = 60;

// Measures the prompt as contiguous sections split on `## ` headings, the
// heading level Neal's prompt builders use for top-level sections. Text before
// the first heading is labeled "instructions". Section sizes include the
// heading line and sum exactly to the prompt length.
export function measurePromptSections(prompt: string): PromptSectionSize[] {
  const boundaries: Array<{ index: number; name: string }> = [];
  for (const match of prompt.matchAll(/^## (.*)$/gm)) {
    boundaries.push({
      index: match.index,
      name: match[1].trim() === '' ? 'untitled section' : match[1].trim(),
    });
  }

  const sections: PromptSectionSize[] = [];
  const leadingChars = boundaries.length === 0 ? prompt.length : boundaries[0].index;
  if (leadingChars > 0) {
    sections.push({ name: 'instructions', chars: leadingChars });
  }
  for (const [position, boundary] of boundaries.entries()) {
    const end = position + 1 < boundaries.length ? boundaries[position + 1].index : prompt.length;
    sections.push({ name: boundary.name, chars: end - boundary.index });
  }
  if (sections.length === 0) {
    sections.push({ name: 'instructions', chars: prompt.length });
  }
  return sections;
}

function formatChars(value: number): string {
  return value.toLocaleString('en-US');
}

function formatSectionName(name: string): string {
  return name.length > SECTION_NAME_MAX_CHARS
    ? `${name.slice(0, SECTION_NAME_MAX_CHARS - 3)}...`
    : name;
}

export function buildInputTooLargeMessage(args: {
  provider: ProviderId;
  promptChars: number;
  maxInputChars: number;
  sections: readonly PromptSectionSize[];
}): string {
  const largest = [...args.sections]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, REPORTED_SECTION_COUNT);
  const sectionReport = largest
    .map((section) => `"${formatSectionName(section.name)}" ${formatChars(section.chars)} chars`)
    .join('; ');
  return [
    `Prompt is ${formatChars(args.promptChars)} chars; ${args.provider} accepts at most ${formatChars(args.maxInputChars)} input chars per turn.`,
    `Largest sections: ${sectionReport}.`,
  ].join('\n');
}

// Reads the largest section name back out of a message produced by
// buildInputTooLargeMessage, so `neal status` can name the input to shrink in
// its Next Action. Provider-authored input_too_large rejections carry no
// section report, so this returns null for them and the caller falls back to
// generic wording. Kept next to the builder so the format and its one parser
// stay in lockstep.
export function largestSectionNameFromInputTooLargeMessage(message: string): string | null {
  const match = message.match(/Largest sections: "([^"]+)"/);
  return match ? match[1] : null;
}

// No-op when the role declares no budget or the prompt fits. Throws before any
// SDK work otherwise; the error is non-retryable by construction, so it never
// consumes API-retry budget.
export function assertPromptWithinInputBudget(args: {
  prompt: string;
  maxInputChars: number | undefined;
  provider: ProviderId;
  role: ProviderRole;
  sessionHandle?: string | null;
}): void {
  if (args.maxInputChars === undefined || args.prompt.length <= args.maxInputChars) {
    return;
  }
  throw new NealProviderError({
    message: buildInputTooLargeMessage({
      provider: args.provider,
      promptChars: args.prompt.length,
      maxInputChars: args.maxInputChars,
      sections: measurePromptSections(args.prompt),
    }),
    provider: args.provider,
    role: args.role,
    sessionHandle: args.sessionHandle ?? null,
    kind: 'input_too_large',
    retryable: false,
  });
}
