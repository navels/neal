import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateChangedFilesForAcceptedDerivedScopes,
  classifyAlreadySatisfiedTopLevelScopeAcceptance,
  classifyEmptyDerivedParentAdvance,
  getAcceptedDerivedScopesForParentObjective,
  getAcceptedParentScopeForObjective,
  getCurrentExecutionScopeDescriptor,
  getEmptyAcceptedDerivedScopesForParentObjective,
  getExecutionPlanScopeCount,
  getSubstantiveAcceptedDerivedScopesForParentObjective,
} from '../src/neal/scopes.js';
import type { ProgressScope } from '../src/neal/types.js';

type DescriptorState = Parameters<typeof getCurrentExecutionScopeDescriptor>[0];
type ParentAdvanceState = Parameters<typeof classifyEmptyDerivedParentAdvance>[0]['state'];
type AlreadySatisfiedTopLevelState = Parameters<typeof classifyAlreadySatisfiedTopLevelScopeAcceptance>[0]['state'];

async function createPlanDir() {
  const root = await mkdtemp(join(tmpdir(), 'neal-scopes-'));
  await mkdir(root, { recursive: true });
  return root;
}

function stateFor(planPath: string, overrides: Partial<DescriptorState> = {}): DescriptorState {
  return {
    planDoc: planPath,
    topLevelMode: 'execute',
    executionShape: 'multi_scope',
    currentScopeNumber: 1,
    derivedPlanPath: null,
    derivedFromScopeNumber: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    ...overrides,
  };
}

function multiScopePlan(titles: string[]) {
  return [
    '# Multi Scope Plan',
    '',
    '## Execution Shape',
    '',
    'executionShape: multi_scope',
    '',
    '## Execution Queue',
    '',
    ...titles.flatMap((title, index) => [
      `### Scope ${index + 1}: ${title}`,
      '- Goal: Do the bounded work.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: The bounded work is complete.',
      '',
    ]),
  ].join('\n');
}

function completedScope(overrides: Partial<ProgressScope> & Pick<ProgressScope, 'number'>): ProgressScope {
  const { number, ...rest } = overrides;
  return {
    number,
    marker: 'AUTONOMY_SCOPE_DONE',
    result: 'accepted',
    baseCommit: 'base',
    finalCommit: `final-${number}`,
    summary: null,
    commitSubject: `scope ${number}`,
    changedFiles: [],
    reviewRounds: 1,
    findings: 0,
    residualReviewDebt: [],
    archivedReviewPath: `/tmp/review-${number}.md`,
    blocker: null,
    derivedFromParentScope: null,
    replacedByDerivedPlanPath: null,
    ...rest,
  };
}

function parentAdvanceState(overrides: Partial<ParentAdvanceState> = {}): ParentAdvanceState {
  return {
    topLevelMode: 'execute',
    executionShape: 'multi_scope',
    currentScopeNumber: 5,
    derivedFromScopeNumber: 5,
    derivedPlanPath: '/tmp/DERIVED.md',
    derivedPlanStatus: 'accepted',
    derivedScopeIndex: 3,
    completedScopes: [
      completedScope({
        number: '5.1',
        changedFiles: ['src/first.ts', 'src/shared.ts'],
        derivedFromParentScope: '5',
      }),
      completedScope({
        number: '5.2',
        changedFiles: [],
        derivedFromParentScope: '5',
      }),
      completedScope({
        number: '4.1',
        changedFiles: ['src/other.ts'],
        derivedFromParentScope: '4',
      }),
    ],
    ...overrides,
  };
}

function alreadySatisfiedTopLevelState(
  overrides: Partial<AlreadySatisfiedTopLevelState> = {},
): AlreadySatisfiedTopLevelState {
  return {
    topLevelMode: 'execute',
    executionShape: 'multi_scope',
    currentScopeNumber: 4,
    derivedFromScopeNumber: null,
    derivedPlanPath: null,
    derivedPlanStatus: null,
    derivedScopeIndex: null,
    currentScopeProgressJustification: {
      milestoneTargeted: 'Scope 4 already-satisfied acceptance.',
      newEvidence: 'Focused verification passed with no current diff.',
      whyNotRedundant: 'Prior accepted scopes already implemented this behavior.',
      nextStepUnlocked: 'The next top-level scope can start.',
    },
    completedScopes: [
      completedScope({
        number: '1',
        changedFiles: ['src/first.ts'],
      }),
      completedScope({
        number: '2.3',
        changedFiles: ['src/shared.ts'],
        derivedFromParentScope: '2',
      }),
    ],
    ...overrides,
  };
}

test('parent-objective helpers account for accepted derived siblings across the full completed-scope history', () => {
  const state = parentAdvanceState({
    completedScopes: [
      completedScope({
        number: '5.1',
        changedFiles: ['src/a.ts', 'src/shared.ts'],
        derivedFromParentScope: '5',
      }),
      completedScope({
        number: '5.2',
        changedFiles: [],
        derivedFromParentScope: '5',
      }),
      completedScope({
        number: '5.3',
        changedFiles: ['src/shared.ts', 'src/c.ts'],
        derivedFromParentScope: '5',
      }),
      completedScope({
        number: '5',
        changedFiles: ['src/a.ts', 'src/shared.ts', 'src/c.ts'],
        replacedByDerivedPlanPath: '/tmp/DERIVED.md',
      }),
      completedScope({
        number: '5.4',
        result: 'blocked',
        changedFiles: ['src/blocked.ts'],
        derivedFromParentScope: '5',
        blocker: 'blocked',
      }),
    ],
  });

  assert.deepEqual(getAcceptedDerivedScopesForParentObjective(state, '5').map((scope) => scope.number), [
    '5.1',
    '5.2',
    '5.3',
  ]);
  assert.deepEqual(getSubstantiveAcceptedDerivedScopesForParentObjective(state, '5').map((scope) => scope.number), [
    '5.1',
    '5.3',
  ]);
  assert.deepEqual(getEmptyAcceptedDerivedScopesForParentObjective(state, '5').map((scope) => scope.number), ['5.2']);
  assert.equal(getAcceptedParentScopeForObjective(state, '5')?.number, '5');
  assert.deepEqual(
    aggregateChangedFilesForAcceptedDerivedScopes(getAcceptedDerivedScopesForParentObjective(state, '5')),
    ['src/a.ts', 'src/shared.ts', 'src/c.ts'],
  );
});

test('empty derived parent-advance classification accepts explicit safe parent advancement', () => {
  const result = classifyEmptyDerivedParentAdvance({
    state: parentAdvanceState(),
    currentChangedFiles: [],
    currentReviewerFindings: [],
    mergedFindings: [],
    reviewerAction: 'advance_parent',
    reviewerRationale: 'Prior accepted derived work satisfies parent scope 5; this checkpoint is empty.',
    source: 'explicit',
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.failedPreconditions, []);
  assert.equal(result.parentScopeLabel, '5');
  assert.equal(result.currentScopeLabel, '5.3');
  assert.equal(result.priorSubstantiveCount, 1);
  assert.equal(result.priorEmptyCount, 1);
  assert.deepEqual(result.aggregateChangedFiles, ['src/first.ts', 'src/shared.ts']);
  assert.equal(result.source, 'explicit');
});

test('empty derived parent-advance classification accepts deterministic fallback after repeated empty siblings', () => {
  const result = classifyEmptyDerivedParentAdvance({
    state: parentAdvanceState({
      completedScopes: [
        completedScope({
          number: '5.1',
          changedFiles: ['src/first.ts'],
          derivedFromParentScope: '5',
        }),
        completedScope({
          number: '5.2',
          changedFiles: [],
          derivedFromParentScope: '5',
        }),
        completedScope({
          number: '5.3',
          changedFiles: [],
          derivedFromParentScope: '5',
        }),
      ],
      derivedScopeIndex: 4,
    }),
    currentChangedFiles: [],
    currentReviewerFindings: [],
    mergedFindings: [],
    reviewerAction: 'block_for_operator',
    reviewerRationale: 'The parent looks complete, but the reviewer asked Neal to decide.',
    source: 'fallback',
  });

  assert.equal(result.eligible, true);
  assert.equal(result.currentScopeLabel, '5.4');
  assert.equal(result.priorSubstantiveCount, 1);
  assert.equal(result.priorEmptyCount, 2);
  assert.deepEqual(result.aggregateChangedFiles, ['src/first.ts']);
  assert.equal(result.source, 'fallback');
});

test('empty derived parent-advance classification rejects unsafe preconditions', () => {
  const cases: {
    name: string;
    state?: Partial<ParentAdvanceState>;
    currentChangedFiles?: string[];
    currentReviewerFindings?: Parameters<typeof classifyEmptyDerivedParentAdvance>[0]['currentReviewerFindings'];
    mergedFindings?: Parameters<typeof classifyEmptyDerivedParentAdvance>[0]['mergedFindings'];
    source?: Parameters<typeof classifyEmptyDerivedParentAdvance>[0]['source'];
    reviewerAction?: Parameters<typeof classifyEmptyDerivedParentAdvance>[0]['reviewerAction'];
    expected: RegExp;
  }[] = [
    {
      name: 'non-execute run',
      state: { topLevelMode: 'plan' },
      expected: /run is not execute mode/,
    },
    {
      name: 'non-derived execution',
      state: {
        derivedPlanPath: null,
        derivedFromScopeNumber: null,
        derivedPlanStatus: null,
        derivedScopeIndex: null,
      },
      expected: /accepted derived plan is not actively executing/,
    },
    {
      name: 'one-shot execution shape',
      state: { executionShape: 'one_shot' },
      expected: /one-shot execution shape/,
    },
    {
      name: 'current changed files',
      currentChangedFiles: ['src/current.ts'],
      expected: /changed-file list is not empty/,
    },
    {
      name: 'current reviewer findings',
      currentReviewerFindings: [{ severity: 'blocking' }],
      expected: /current reviewer result has findings/,
    },
    {
      name: 'merged open findings',
      mergedFindings: [{ status: 'open' }],
      expected: /open findings/,
    },
    {
      name: 'no prior substantive derived work',
      state: {
        completedScopes: [
          completedScope({
            number: '5.1',
            changedFiles: [],
            derivedFromParentScope: '5',
          }),
        ],
      },
      expected: /no prior substantive/,
    },
    {
      name: 'accepted top-level parent record already exists',
      state: {
        completedScopes: [
          completedScope({
            number: '5.1',
            changedFiles: ['src/first.ts'],
            derivedFromParentScope: '5',
          }),
          completedScope({
            number: '5',
            changedFiles: ['src/first.ts'],
            replacedByDerivedPlanPath: '/tmp/DERIVED.md',
          }),
        ],
      },
      expected: /already has an accepted top-level record/,
    },
    {
      name: 'fallback without two prior empty derived siblings',
      source: 'fallback',
      reviewerAction: 'block_for_operator',
      expected: /at least two prior empty/,
    },
  ];

  for (const scenario of cases) {
    const result = classifyEmptyDerivedParentAdvance({
      state: parentAdvanceState(scenario.state),
      currentChangedFiles: scenario.currentChangedFiles ?? [],
      currentReviewerFindings: scenario.currentReviewerFindings ?? [],
      mergedFindings: scenario.mergedFindings ?? [],
      reviewerAction: scenario.reviewerAction ?? 'advance_parent',
      reviewerRationale: 'Prior accepted derived work satisfies parent scope 5.',
      source: scenario.source ?? 'explicit',
    });

    assert.equal(result.eligible, false, scenario.name);
    assert.match(result.failedPreconditions.join('\n'), scenario.expected, scenario.name);
  }
});

test('already-satisfied top-level scope classification accepts a strict legacy advance_parent fallback', () => {
  const result = classifyAlreadySatisfiedTopLevelScopeAcceptance({
    state: alreadySatisfiedTopLevelState(),
    currentChangedFiles: [],
    currentReviewerFindings: [],
    mergedFindings: [],
    reviewerAction: 'advance_parent',
    reviewerRationale: 'Scope 4 is already satisfied by accepted scopes 1 and 2.3, with verification passing.',
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.failedPreconditions, []);
  assert.equal(result.scopeLabel, '4');
  assert.deepEqual(result.priorAcceptedScopeLabels, ['1', '2.3']);
  assert.equal(result.reviewerAction, 'advance_parent');
});

test('already-satisfied top-level scope classification rejects unsafe preconditions', () => {
  const cases: {
    name: string;
    state?: Partial<AlreadySatisfiedTopLevelState>;
    currentChangedFiles?: string[];
    currentReviewerFindings?: Parameters<typeof classifyAlreadySatisfiedTopLevelScopeAcceptance>[0]['currentReviewerFindings'];
    mergedFindings?: Parameters<typeof classifyAlreadySatisfiedTopLevelScopeAcceptance>[0]['mergedFindings'];
    reviewerAction?: Parameters<typeof classifyAlreadySatisfiedTopLevelScopeAcceptance>[0]['reviewerAction'];
    reviewerRationale?: string;
    expected: RegExp;
  }[] = [
    {
      name: 'derived plan executing',
      state: {
        derivedPlanPath: '/tmp/DERIVED.md',
        derivedFromScopeNumber: 4,
        derivedPlanStatus: 'accepted',
        derivedScopeIndex: 2,
      },
      expected: /accepted derived plan is actively executing/,
    },
    {
      name: 'non-empty current changed files',
      currentChangedFiles: ['src/current.ts'],
      expected: /changed-file list is not empty/,
    },
    {
      name: 'current reviewer findings',
      currentReviewerFindings: [{ severity: 'blocking' }],
      expected: /current reviewer result has findings/,
    },
    {
      name: 'open merged findings',
      mergedFindings: [{ status: 'open' }],
      expected: /open findings/,
    },
    {
      name: 'missing rationale',
      reviewerRationale: '   ',
      expected: /reviewer rationale is empty/,
    },
    {
      name: 'missing progress justification',
      state: { currentScopeProgressJustification: null },
      expected: /current scope progress justification is missing/,
    },
    {
      name: 'empty progress justification field',
      state: {
        currentScopeProgressJustification: {
          milestoneTargeted: 'Scope 4 already-satisfied acceptance.',
          newEvidence: '',
          whyNotRedundant: 'Prior accepted scopes already implemented this behavior.',
          nextStepUnlocked: 'The next top-level scope can start.',
        },
      },
      expected: /empty field\(s\): newEvidence/,
    },
    {
      name: 'no prior accepted work',
      state: { completedScopes: [] },
      expected: /no prior accepted completed scope/,
    },
    {
      name: 'already accepted current top-level scope',
      state: {
        completedScopes: [
          completedScope({
            number: '1',
            changedFiles: ['src/first.ts'],
          }),
          completedScope({
            number: '4',
            changedFiles: [],
          }),
        ],
      },
      expected: /already has an accepted completed-scope record/,
    },
  ];

  for (const scenario of cases) {
    const result = classifyAlreadySatisfiedTopLevelScopeAcceptance({
      state: alreadySatisfiedTopLevelState(scenario.state),
      currentChangedFiles: scenario.currentChangedFiles ?? [],
      currentReviewerFindings: scenario.currentReviewerFindings ?? [],
      mergedFindings: scenario.mergedFindings ?? [],
      reviewerAction: scenario.reviewerAction ?? 'advance_parent',
      reviewerRationale: scenario.reviewerRationale ?? 'Scope 4 is already satisfied by prior accepted work.',
    });

    assert.equal(result.eligible, false, scenario.name);
    assert.match(result.failedPreconditions.join('\n'), scenario.expected, scenario.name);
  }
});

test('scope descriptor resolves multi-scope titles and totals', async () => {
  const root = await createPlanDir();
  const planPath = join(root, 'PLAN.md');
  await writeFile(planPath, multiScopePlan(['Prepare plumbing', 'Restore narrative view']), 'utf8');

  const descriptor = await getCurrentExecutionScopeDescriptor(stateFor(planPath, { currentScopeNumber: 2 }));

  assert.equal(descriptor.planPath, planPath);
  assert.equal(descriptor.scopeLabel, '2');
  assert.equal(descriptor.planScopeNumber, 2);
  assert.deepEqual(descriptor.scopeCount, { kind: 'known', total: 2 });
  assert.equal(descriptor.title, 'Restore narrative view');
  assert.equal(descriptor.display, 'scope 2/2: Restore narrative view');
  assert.deepEqual(await getExecutionPlanScopeCount(planPath), { kind: 'known', total: 2 });
});

test('scope descriptor resolves one-shot titles from explicit scope heading before h1', async () => {
  const root = await createPlanDir();
  const planPath = join(root, 'PLAN.md');
  await writeFile(
    planPath,
    [
      '# Fallback One Shot Title',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
      '',
      '## Implementation Notes',
      '',
      '### Scope 1: Explicit One Shot Title',
    ].join('\n'),
    'utf8',
  );

  const descriptor = await getCurrentExecutionScopeDescriptor(
    stateFor(planPath, { executionShape: 'one_shot', currentScopeNumber: 1 }),
  );

  assert.equal(descriptor.planScopeNumber, 1);
  assert.deepEqual(descriptor.scopeCount, { kind: 'known', total: 1 });
  assert.equal(descriptor.title, 'Explicit One Shot Title');
  assert.equal(descriptor.display, 'scope 1/1: Explicit One Shot Title');
});

test('scope descriptor falls back to h1 for one-shot plans', async () => {
  const root = await createPlanDir();
  const planPath = join(root, 'PLAN.md');
  await writeFile(
    planPath,
    [
      '# Terminal Smoke Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: one_shot',
    ].join('\n'),
    'utf8',
  );

  const descriptor = await getCurrentExecutionScopeDescriptor(
    stateFor(planPath, { executionShape: 'one_shot', currentScopeNumber: 1 }),
  );

  assert.equal(descriptor.title, 'Terminal Smoke Plan');
  assert.equal(descriptor.display, 'scope 1/1: Terminal Smoke Plan');
});

test('scope descriptor names recurring unknown-total scopes', async () => {
  const root = await createPlanDir();
  const planPath = join(root, 'PLAN.md');
  await writeFile(
    planPath,
    [
      '# Unknown Total Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope_unknown',
      '',
      '## Execution Loop',
      '',
      '### Recurring Scope',
      '- Goal: Do one bounded slice.',
      '- Verification: `pnpm typecheck`',
      '- Success Condition: One bounded slice is complete.',
      '',
      '## Completion Condition',
      '',
      'Stop when all slices are complete.',
    ].join('\n'),
    'utf8',
  );

  const descriptor = await getCurrentExecutionScopeDescriptor(
    stateFor(planPath, { executionShape: 'multi_scope_unknown', currentScopeNumber: 3 }),
  );

  assert.equal(descriptor.planScopeNumber, 3);
  assert.deepEqual(descriptor.scopeCount, { kind: 'unknown_by_contract' });
  assert.equal(descriptor.title, 'Recurring Scope');
  assert.equal(descriptor.display, 'scope 3: Recurring Scope');
});

test('scope descriptor resolves derived-plan titles from the active derived plan', async () => {
  const root = await createPlanDir();
  const parentPlanPath = join(root, 'PARENT.md');
  const derivedPlanPath = join(root, 'DERIVED.md');
  await writeFile(parentPlanPath, multiScopePlan(['Parent one', 'Parent two']), 'utf8');
  await writeFile(derivedPlanPath, multiScopePlan(['Derive first change', 'Add fixture coverage']), 'utf8');

  const descriptor = await getCurrentExecutionScopeDescriptor(
    stateFor(parentPlanPath, {
      currentScopeNumber: 5,
      derivedPlanPath,
      derivedFromScopeNumber: 5,
      derivedPlanStatus: 'accepted',
      derivedScopeIndex: 2,
    }),
  );

  assert.equal(descriptor.planPath, derivedPlanPath);
  assert.equal(descriptor.scopeLabel, '5.2');
  assert.equal(descriptor.planScopeNumber, 2);
  assert.deepEqual(descriptor.scopeCount, { kind: 'known', total: 2 });
  assert.equal(descriptor.title, 'Add fixture coverage');
  assert.equal(descriptor.display, 'scope 5.2: Add fixture coverage');
});

test('scope descriptor degrades to label-only display for invalid or unreadable plans', async () => {
  const root = await createPlanDir();
  const invalidPlanPath = join(root, 'INVALID.md');
  const missingPlanPath = join(root, 'MISSING.md');
  await writeFile(
    invalidPlanPath,
    [
      '# Invalid Plan',
      '',
      '## Execution Shape',
      '',
      'executionShape: multi_scope',
    ].join('\n'),
    'utf8',
  );

  const invalidDescriptor = await getCurrentExecutionScopeDescriptor(
    stateFor(invalidPlanPath, { currentScopeNumber: 2 }),
  );
  assert.deepEqual(invalidDescriptor.scopeCount, { kind: 'unavailable' });
  assert.equal(invalidDescriptor.title, null);
  assert.equal(invalidDescriptor.display, 'scope 2');

  const missingDescriptor = await getCurrentExecutionScopeDescriptor(
    stateFor(missingPlanPath, { executionShape: 'one_shot', currentScopeNumber: 1 }),
  );
  assert.deepEqual(missingDescriptor.scopeCount, { kind: 'known', total: 1 });
  assert.equal(missingDescriptor.title, null);
  assert.equal(missingDescriptor.display, 'scope 1');
});
