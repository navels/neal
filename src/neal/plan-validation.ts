import type { ExecutionShape } from './types.js';

const EXECUTION_SHAPE_HEADER = '## Execution Shape';
const EXECUTION_QUEUE_HEADER = '## Execution Queue';
const SCOPE_HEADING_PATTERN = /^### Scope (\d+):(.*)$/;
const REQUIRED_SCOPE_BULLETS = ['goal', 'verification', 'success condition'] as const;
const EXECUTION_QUEUE_HEADER_ALIASES = new Set(['## Ordered Derived Scopes', '## Derived Execution Queue']);
const VERIFICATION_LABEL_ALIASES = new Set(['verification', 'verification strategy']);
const SUCCESS_CONDITION_LABEL_ALIASES = new Set(['success condition', 'exit criteria']);

export type PlanNormalizationScopeMapping = {
  normalizedScopeNumber: number;
  originalScopeLabel: string;
};

export type PlanNormalizationMetadata = {
  applied: boolean;
  normalizedDocument: string;
  operations: string[];
  scopeLabelMappings: PlanNormalizationScopeMapping[];
};

export type PlanValidationResult =
  | {
      ok: true;
      executionShape: ExecutionShape;
      errors: [];
      normalization: PlanNormalizationMetadata;
    }
  | {
      ok: false;
      executionShape: ExecutionShape | null;
      errors: string[];
      normalization: PlanNormalizationMetadata;
    };

export function validatePlanDocument(planDocument: string): PlanValidationResult {
  const normalization = normalizePlanDocument(planDocument);
  const lines = normalization.normalizedDocument.split(/\r?\n/);
  const errors: string[] = [];

  const executionShapeSection = findSection(lines, EXECUTION_SHAPE_HEADER);
  const executionShape = validateExecutionShapeSection(lines, executionShapeSection, errors);

  if (executionShape === 'multi_scope') {
    validateExecutionQueueSection(lines, errors);
  }

  if (executionShape === 'one_shot') {
    validateOneShotQueueAbsence(lines, errors);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      executionShape,
      errors,
      normalization,
    };
  }

  if (executionShape === null) {
    return {
      ok: false,
      executionShape: null,
      errors: ['Internal validation error: execution shape resolved to null after successful validation.'],
      normalization,
    };
  }

  return {
    ok: true,
    executionShape,
    errors: [],
    normalization,
  };
}

function normalizePlanDocument(planDocument: string): PlanNormalizationMetadata {
  const lines = planDocument.split(/\r?\n/);
  const operations: string[] = [];
  const scopeLabelMappings: PlanNormalizationScopeMapping[] = [];
  const normalizedLines = [...lines];

  const queueSection = findSectionByHeaders(lines, [EXECUTION_QUEUE_HEADER, ...EXECUTION_QUEUE_HEADER_ALIASES]);
  if (queueSection === null) {
    return {
      applied: false,
      normalizedDocument: planDocument,
      operations,
      scopeLabelMappings,
    };
  }

  const queueHeader = lines[queueSection.start]?.trim();
  if (queueHeader !== EXECUTION_QUEUE_HEADER && queueHeader !== undefined) {
    normalizedLines[queueSection.start] = EXECUTION_QUEUE_HEADER;
    operations.push(`Normalized execution queue header \`${queueHeader}\` to \`${EXECUTION_QUEUE_HEADER}\`.`);
  }

  const normalizedQueueLines = normalizeExecutionQueueLines(
    getSectionContentLines(lines, queueSection),
    operations,
    scopeLabelMappings,
  );

  if (normalizedQueueLines !== null) {
    normalizedLines.splice(
      queueSection.start + 1,
      queueSection.end - queueSection.start - 1,
      ...normalizedQueueLines,
    );
  }

  const normalizedDocument = normalizedLines.join('\n');
  return {
    applied: normalizedDocument !== planDocument,
    normalizedDocument,
    operations,
    scopeLabelMappings,
  };
}

function normalizeExecutionQueueLines(
  lines: string[],
  operations: string[],
  scopeLabelMappings: PlanNormalizationScopeMapping[],
): string[] | null {
  const queueDraft = collectNormalizedScopes(lines);
  if (queueDraft === null) {
    return null;
  }
  const { scopes, sawAliasScopeHeading } = queueDraft;

  let applied = false;
  const normalizedLines: string[] = [];

  scopes.forEach((scope, index) => {
    const normalizedScopeNumber = index + 1;
    const canonicalHeading = sawAliasScopeHeading
      ? `### Scope ${normalizedScopeNumber}: ${scope.title}`
      : scope.heading.trim();
    const originalHeading = scope.heading.trim();
    if (originalHeading !== canonicalHeading) {
      applied = true;
      operations.push(`Normalized scope heading \`${originalHeading}\` to \`${canonicalHeading}\`.`);
    }

    if (sawAliasScopeHeading && scope.originalLabel !== String(normalizedScopeNumber)) {
      scopeLabelMappings.push({
        normalizedScopeNumber,
        originalScopeLabel: scope.originalLabel,
      });
    }

    normalizedLines.push(canonicalHeading);

    let goalAugmented = false;
    for (const line of scope.body) {
      const normalizedLine = normalizeScopeBodyLine(
        line,
        scope.originalLabel,
        normalizedScopeNumber,
        sawAliasScopeHeading,
        () => {
          goalAugmented = true;
        },
      );

      if (normalizedLine !== line) {
        applied = true;
      }
      normalizedLines.push(normalizedLine);
    }

    if (sawAliasScopeHeading && scope.originalLabel !== String(normalizedScopeNumber) && !goalAugmented) {
      applied = true;
      normalizedLines.push(
        `- Goal: (Former derived scope ${scope.originalLabel}) Complete scope ${normalizedScopeNumber} work.`,
      );
      operations.push(
        `Inserted goal label mapping for normalized Scope ${normalizedScopeNumber} from original label \`${scope.originalLabel}\`.`,
      );
    }
  });

  if (!applied) {
    return lines;
  }

  return normalizedLines;
}

type NormalizedScopeDraft = {
  heading: string;
  originalLabel: string;
  title: string;
  body: string[];
};

function collectNormalizedScopes(lines: string[]): { scopes: NormalizedScopeDraft[]; sawAliasScopeHeading: boolean } | null {
  const scopes: NormalizedScopeDraft[] = [];
  let currentScope: NormalizedScopeDraft | null = null;
  let sawScope = false;
  let sawAliasScopeHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (currentScope !== null) {
        currentScope.body.push(line);
      }
      continue;
    }

    const canonicalHeadingMatch = trimmed.match(SCOPE_HEADING_PATTERN);
    if (canonicalHeadingMatch !== null) {
      sawScope = true;
      if (currentScope !== null) {
        scopes.push(currentScope);
      }

      currentScope = {
        heading: trimmed,
        originalLabel: canonicalHeadingMatch[1] ?? '',
        title: canonicalHeadingMatch[2]?.trim() ?? '',
        body: [],
      };
      continue;
    }

    const aliasHeading = parseAliasScopeHeading(trimmed);
    if (aliasHeading !== null) {
      sawScope = true;
      sawAliasScopeHeading = true;
      if (currentScope !== null) {
        scopes.push(currentScope);
      }

      currentScope = {
        heading: trimmed,
        originalLabel: aliasHeading.originalLabel,
        title: aliasHeading.title,
        body: [],
      };
      continue;
    }

    if (currentScope !== null) {
      currentScope.body.push(line);
      continue;
    }

    return null;
  }

  if (currentScope !== null) {
    scopes.push(currentScope);
  }

  return sawScope ? { scopes, sawAliasScopeHeading } : null;
}

function parseAliasScopeHeading(trimmed: string): { originalLabel: string; title: string } | null {
  const headingAliasMatch = trimmed.match(/^### Scope ([^:]+):(.*)$/);
  if (headingAliasMatch !== null) {
    const originalLabel = headingAliasMatch[1]?.trim() ?? '';
    const title = headingAliasMatch[2]?.trim() ?? '';
    if (originalLabel !== '' && !/^\d+$/.test(originalLabel) && title !== '') {
      return { originalLabel, title };
    }
  }

  const numberedAliasMatch = trimmed.match(/^\d+\.\s+Scope\s+([^:]+):\s*(.+)$/);
  if (numberedAliasMatch !== null) {
    const originalLabel = numberedAliasMatch[1]?.trim() ?? '';
    const title = numberedAliasMatch[2]?.trim() ?? '';
    if (originalLabel !== '' && title !== '') {
      return { originalLabel, title };
    }
  }

  return null;
}

function normalizeScopeBodyLine(
  line: string,
  originalLabel: string,
  normalizedScopeNumber: number,
  preserveOriginalScopeLabel: boolean,
  onGoalAugmented: () => void,
) {
  const bulletMatch = line.match(/^(\s*-\s+)([^:]+):(.*)$/);
  if (bulletMatch === null) {
    return line;
  }

  const prefix = bulletMatch[1] ?? '- ';
  const label = bulletMatch[2]?.trim() ?? '';
  const rest = bulletMatch[3] ?? '';
  const normalizedLabel = normalizeBulletLabel(label);
  let normalizedRest = rest;

  if (
    preserveOriginalScopeLabel &&
    normalizedLabel === 'Goal' &&
    originalLabel !== String(normalizedScopeNumber) &&
    !rest.includes(`Former derived scope ${originalLabel}`)
  ) {
    normalizedRest = ` (Former derived scope ${originalLabel})${rest}`;
    onGoalAugmented();
  }

  return `${prefix}${normalizedLabel}:${normalizedRest}`;
}

function normalizeBulletLabel(label: string) {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'goal') {
    return 'Goal';
  }
  if (VERIFICATION_LABEL_ALIASES.has(normalized)) {
    return 'Verification';
  }
  if (SUCCESS_CONDITION_LABEL_ALIASES.has(normalized)) {
    return 'Success Condition';
  }

  return label.trim();
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

function validateOneShotQueueAbsence(lines: string[], errors: string[]) {
  const queueSection = findSection(lines, EXECUTION_QUEUE_HEADER);
  if (queueSection !== null) {
    errors.push('`executionShape: one_shot` must not include a `## Execution Queue` section.');
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
  return findSectionByHeaders(lines, [header]);
}

function findSectionByHeaders(lines: string[], headers: string[]): SectionBounds | null {
  const start = lines.findIndex((line) => headers.includes(line.trim()));
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
