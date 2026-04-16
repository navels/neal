import type { ExecutionShape } from './types.js';

const EXECUTION_SHAPE_HEADER = '## Execution Shape';
const EXECUTION_QUEUE_HEADER = '## Execution Queue';
const SCOPE_HEADING_PATTERN = /^### Scope (\d+):(.*)$/;
const REQUIRED_SCOPE_BULLETS = ['goal', 'verification', 'success condition'] as const;

export type PlanValidationResult =
  | {
      ok: true;
      executionShape: ExecutionShape;
      errors: [];
    }
  | {
      ok: false;
      executionShape: ExecutionShape | null;
      errors: string[];
    };

export function validatePlanDocument(planDocument: string): PlanValidationResult {
  const lines = planDocument.split(/\r?\n/);
  const errors: string[] = [];

  const executionShapeSection = findSection(lines, EXECUTION_SHAPE_HEADER);
  const executionShape = validateExecutionShapeSection(lines, executionShapeSection, errors);

  if (executionShape === 'multi_scope') {
    validateExecutionQueueSection(lines, errors);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      executionShape,
      errors,
    };
  }

  if (executionShape === null) {
    return {
      ok: false,
      executionShape: null,
      errors: ['Internal validation error: execution shape resolved to null after successful validation.'],
    };
  }

  return {
    ok: true,
    executionShape,
    errors: [],
  };
}

function validateExecutionShapeSection(
  lines: string[],
  section: SectionBounds | null,
  errors: string[],
): ExecutionShape | null {
  if (section === null) {
    errors.push('Missing required `## Execution Shape` section.');
    return null;
  }

  const contentLines = getSectionContentLines(lines, section).filter((line) => line.trim() !== '');

  if (contentLines.length === 0) {
    errors.push('`## Execution Shape` must contain exactly one non-empty line.');
    return null;
  }

  if (contentLines.length > 1) {
    errors.push('`## Execution Shape` must contain exactly one non-empty line.');
  }

  const declaredShape = contentLines[0]?.trim();
  if (declaredShape === 'executionShape: one_shot') {
    return 'one_shot';
  }
  if (declaredShape === 'executionShape: multi_scope') {
    return 'multi_scope';
  }

  errors.push(
    '`## Execution Shape` must declare exactly `executionShape: one_shot` or `executionShape: multi_scope`.',
  );
  return null;
}

function validateExecutionQueueSection(lines: string[], errors: string[]) {
  const queueSection = findSection(lines, EXECUTION_QUEUE_HEADER);
  if (queueSection === null) {
    errors.push('`executionShape: multi_scope` requires a `## Execution Queue` section.');
    return;
  }

  const contentLines = getSectionContentLines(lines, queueSection);
  const scopes = collectScopes(contentLines, errors);

  if (scopes.length === 0) {
    errors.push('`## Execution Queue` must contain at least one `### Scope N:` entry.');
    return;
  }

  validateScopeOrdering(scopes, errors);

  for (const scope of scopes) {
    validateScopeBullets(scope, errors);
  }
}

type SectionBounds = {
  start: number;
  end: number;
};

type ScopeSection = {
  number: number;
  heading: string;
  body: string[];
};

function findSection(lines: string[], header: string): SectionBounds | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return null;
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index].trim())) {
      return { start, end: index };
    }
  }

  return { start, end: lines.length };
}

function getSectionContentLines(lines: string[], section: SectionBounds): string[] {
  return lines.slice(section.start + 1, section.end);
}

function collectScopes(lines: string[], errors: string[]): ScopeSection[] {
  const scopes: ScopeSection[] = [];
  let currentScope: ScopeSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (currentScope !== null) {
        currentScope.body.push(line);
      }
      continue;
    }

    const headingMatch = trimmed.match(SCOPE_HEADING_PATTERN);
    if (headingMatch !== null) {
      if (currentScope !== null) {
        scopes.push(currentScope);
      }

      currentScope = {
        number: Number.parseInt(headingMatch[1] ?? '', 10),
        heading: trimmed,
        body: [],
      };
      continue;
    }

    if (/^### /.test(trimmed)) {
      errors.push(
        `\`## Execution Queue\` contains invalid scope heading \`${trimmed}\`; expected literal \`### Scope N:\` entries.`,
      );
      continue;
    }

    if (currentScope !== null) {
      currentScope.body.push(line);
      continue;
    }

    errors.push(
      `\`## Execution Queue\` contains content before the first scope entry: \`${trimmed}\`.`,
    );
  }

  if (currentScope !== null) {
    scopes.push(currentScope);
  }

  return scopes;
}

function validateScopeOrdering(scopes: ScopeSection[], errors: string[]) {
  scopes.forEach((scope, index) => {
    const expectedNumber = index + 1;
    if (scope.number !== expectedNumber) {
      errors.push(
        `\`## Execution Queue\` scope numbering must start at 1 and remain contiguous; expected Scope ${expectedNumber} but found Scope ${scope.number}.`,
      );
    }
  });
}

function validateScopeBullets(scope: ScopeSection, errors: string[]) {
  const presentLabels = new Set<string>();

  for (const line of scope.body) {
    const bulletMatch = line.trim().match(/^- ([^:]+):/);
    if (bulletMatch === null) {
      continue;
    }

    presentLabels.add(bulletMatch[1].trim().toLowerCase());
  }

  for (const label of REQUIRED_SCOPE_BULLETS) {
    if (!presentLabels.has(label)) {
      errors.push(`Scope ${scope.number} is missing required bullet \`- ${toDisplayLabel(label)}:\`.`);
    }
  }
}

function toDisplayLabel(label: (typeof REQUIRED_SCOPE_BULLETS)[number]) {
  if (label === 'success condition') {
    return 'Success Condition';
  }

  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}
