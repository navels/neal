import { validatePlanDocument } from './plan-validation.js';

const EXECUTION_QUEUE_HEADER = '## Execution Queue';
const SCOPE_HEADING_PATTERN = /^### Scope (\d+):/;
const SECTION_HEADING_PATTERN = /^##(#)? /;

export type LaterScopeRevisionEligibility = {
  eligible: boolean;
  scopeCount: number;
  reasons: string[];
};

export type LaterScopeRevisionResult =
  | { ok: true; document: string }
  | { ok: false; errors: string[] };

export type LaterScopeRevisionInput = {
  planDocument: string;
  currentScopeNumber: number;
  targetScopeNumber: number;
  replacementBody: string;
};

type ScopeEntry = {
  number: number;
  start: number;
  end: number;
};

/**
 * Decides whether operator guidance may revise a later top-level scope in
 * `planDocument`: the document validates, its shape is `multi_scope`, it is
 * already in canonical `## Execution Queue` / `### Scope N:` form on disk, and
 * it has at least one scope after `currentScopeNumber`.
 */
export function getLaterScopeRevisionEligibility(
  planDocument: string,
  currentScopeNumber: number,
): LaterScopeRevisionEligibility {
  const reasons = collectCanonicalMultiScopeErrors(planDocument);
  const scopeCount = reasons.length === 0 ? collectScopeEntries(planDocument.split('\n')).length : 0;

  if (reasons.length === 0 && scopeCount <= currentScopeNumber) {
    reasons.push(
      `The plan has ${scopeCount} scope(s) and the current scope is ${currentScopeNumber}, so there is no later scope to revise.`,
    );
  }

  return { eligible: reasons.length === 0, scopeCount, reasons };
}

/**
 * Replaces exactly one later `### Scope N:` entry in `planDocument` with
 * `replacementBody`. The splice is bounded by the next `### `/`## ` heading
 * (or end of file), so nothing outside the target entry changes. The revised
 * document must still validate with the same scope count.
 */
export function reviseLaterScope(input: LaterScopeRevisionInput): LaterScopeRevisionResult {
  const { planDocument, currentScopeNumber, targetScopeNumber, replacementBody } = input;
  const errors = collectCanonicalMultiScopeErrors(planDocument);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const lines = planDocument.split('\n');
  const entries = collectScopeEntries(lines);
  const scopeCount = entries.length;

  if (!Number.isInteger(targetScopeNumber) || targetScopeNumber <= currentScopeNumber) {
    errors.push(
      `Target scope ${targetScopeNumber} must be a later scope than the current scope ${currentScopeNumber}.`,
    );
  }
  if (Number.isInteger(targetScopeNumber) && targetScopeNumber > scopeCount) {
    errors.push(`Target scope ${targetScopeNumber} is past the plan's scope count of ${scopeCount}.`);
  }
  errors.push(...collectReplacementBodyErrors(replacementBody, targetScopeNumber));
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const target = entries.find((entry) => entry.number === targetScopeNumber);
  if (target === undefined) {
    return { ok: false, errors: [`Target scope ${targetScopeNumber} has no \`### Scope ${targetScopeNumber}:\` heading in the plan.`] };
  }

  const bodyLines = trimTrailingBlankLines(replacementBody.split('\n'));
  const contentEnd = target.start + trimTrailingBlankLines(lines.slice(target.start, target.end)).length;
  const revisedLines = [...lines.slice(0, target.start), ...bodyLines, ...lines.slice(contentEnd)];
  const document = revisedLines.join('\n');

  const validation = validatePlanDocument(document);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.map((error) => `Revised plan does not validate: ${error}`) };
  }
  const revisedCount = collectScopeEntries(document.split('\n')).length;
  if (revisedCount !== scopeCount) {
    return {
      ok: false,
      errors: [`Revised plan has ${revisedCount} scope(s) but the original has ${scopeCount}; the scope count must not change.`],
    };
  }

  return { ok: true, document };
}

function collectCanonicalMultiScopeErrors(planDocument: string): string[] {
  const validation = validatePlanDocument(planDocument);
  if (!validation.ok) {
    return validation.errors.map((error) => `Plan does not validate: ${error}`);
  }
  if (validation.executionShape !== 'multi_scope') {
    return [`Plan shape is \`${validation.executionShape}\`; only \`multi_scope\` plans have later scopes to revise.`];
  }
  if (validation.normalization.applied) {
    return [
      'Plan uses an alias form that is normalized in memory; only plans already in canonical `## Execution Queue` / `### Scope N:` form can be revised.',
    ];
  }
  return [];
}

function collectReplacementBodyErrors(replacementBody: string, targetScopeNumber: number): string[] {
  const errors: string[] = [];
  const bodyLines = replacementBody.split('\n');
  const firstLine = bodyLines[0] ?? '';
  const headingMatch = SCOPE_HEADING_PATTERN.exec(firstLine.trim());
  if (headingMatch === null || Number(headingMatch[1]) !== targetScopeNumber) {
    errors.push(`Replacement body must start with the line \`### Scope ${targetScopeNumber}:\`.`);
  }
  const extraHeadings = bodyLines.slice(1).filter((line) => SECTION_HEADING_PATTERN.test(line.trim()));
  if (extraHeadings.length > 0) {
    errors.push(
      `Replacement body must contain exactly one scope entry; found additional heading(s): ${extraHeadings.map((line) => `\`${line.trim()}\``).join(', ')}.`,
    );
  }
  return errors;
}

function collectScopeEntries(lines: string[]): ScopeEntry[] {
  const queueStart = lines.findIndex((line) => line.trim() === EXECUTION_QUEUE_HEADER);
  if (queueStart === -1) {
    return [];
  }
  let queueEnd = lines.length;
  for (let index = queueStart + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index].trim())) {
      queueEnd = index;
      break;
    }
  }

  const entries: ScopeEntry[] = [];
  for (let index = queueStart + 1; index < queueEnd; index += 1) {
    const match = SCOPE_HEADING_PATTERN.exec(lines[index].trim());
    if (match === null) {
      continue;
    }
    let end = queueEnd;
    for (let cursor = index + 1; cursor < queueEnd; cursor += 1) {
      if (SECTION_HEADING_PATTERN.test(lines[cursor].trim())) {
        end = cursor;
        break;
      }
    }
    entries.push({ number: Number(match[1]), start: index, end });
  }
  return entries;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed.at(-1)?.trim() === '') {
    trimmed.pop();
  }
  return trimmed;
}
