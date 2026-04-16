import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePlanDocument } from '../src/neal/plan-validation.js';

test('accepts a valid one-shot plan document', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: one_shot

## Goal

Ship a focused change.
`);

  assert.equal(result.ok, true);
  assert.equal(result.executionShape, 'one_shot');
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalization.applied, false);
});

test('accepts a valid multi-scope execution queue with case-insensitive bullets', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Add validation
- Goal: Add the validator module.
  Continue the bullet content on the next line.
- verification: \`pnpm typecheck\`
- success condition: The validator accepts valid plans.

### Scope 2: Add tests
- GOAL: Cover failure cases.
- Verification: \`tsx --test test/plan-validation.test.ts\`
- Success Condition: Missing headers and bullets fail deterministically.
`);

  assert.equal(result.ok, true);
  assert.equal(result.executionShape, 'multi_scope');
  assert.deepEqual(result.errors, []);
  assert.match(result.normalization.normalizedDocument, /- Goal: Cover failure cases\./);
});

test('rejects plans that omit the execution shape header', () => {
  const result = validatePlanDocument(`
# Example Plan

executionShape: one_shot
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, null);
  assert.match(result.errors.join('\n'), /Missing required `## Execution Shape` section/);
});

test('rejects multi-scope plans without an execution queue header', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: multi_scope
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, 'multi_scope');
  assert.match(result.errors.join('\n'), /requires a `## Execution Queue` section/);
});

test('rejects one-shot plans that also include an execution queue', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: one_shot

## Execution Queue

### Scope 1: Invalid
- Goal: This should not exist on a one-shot plan.
- Verification: \`pnpm typecheck\`
- Success Condition: This should fail validation.
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, 'one_shot');
  assert.match(result.errors.join('\n'), /must not include a `## Execution Queue` section/);
});

test('rejects execution queues with numbering gaps', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: First
- Goal: Start correctly.
- Verification: \`pnpm typecheck\`
- Success Condition: Scope one is complete.

### Scope 3: Third
- Goal: Skip a number.
- Verification: \`pnpm typecheck\`
- Success Condition: This should fail.
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, 'multi_scope');
  assert.match(result.errors.join('\n'), /expected Scope 2 but found Scope 3/);
});

test('rejects scopes missing required bullets', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Missing verification
- Goal: Add the validator.
- Success Condition: The scope is complete.
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, 'multi_scope');
  assert.match(result.errors.join('\n'), /Scope 1 is missing required bullet `- Verification:`/);
});

test('normalizes derived-plan queue aliases into the canonical execution queue shape', () => {
  const result = validatePlanDocument(`
# Derived Plan

## Execution Shape

executionShape: multi_scope

## Ordered Derived Scopes

1. Scope 6.6A: Migrate cartridge-data-inputs to the native base
- Goal: Move the implementation into the native base layer.
- Verification strategy: \`pnpm typecheck\`
- Exit criteria: The native base owns the migrated logic.

2. Scope 6.6B: Remove the compatibility shim
- Goal: Delete the temporary compatibility wrapper.
- Verification strategy: \`pnpm exec tsx --test test/plan-validation.test.ts\`
- Exit criteria: No compatibility wrapper remains.
`);

  assert.equal(result.ok, true);
  assert.equal(result.executionShape, 'multi_scope');
  assert.equal(result.normalization.applied, true);
  assert.match(result.normalization.normalizedDocument, /## Execution Queue/);
  assert.match(
    result.normalization.normalizedDocument,
    /### Scope 1: Migrate cartridge-data-inputs to the native base/,
  );
  assert.match(
    result.normalization.normalizedDocument,
    /- Goal: \(Former derived scope 6\.6A\) Move the implementation into the native base layer\./,
  );
  assert.match(result.normalization.normalizedDocument, /- Verification: `pnpm typecheck`/);
  assert.match(result.normalization.normalizedDocument, /- Success Condition: The native base owns the migrated logic\./);
  assert.deepEqual(result.normalization.scopeLabelMappings, [
    { normalizedScopeNumber: 1, originalScopeLabel: '6.6A' },
    { normalizedScopeNumber: 2, originalScopeLabel: '6.6B' },
  ]);
});

test('normalizes alias bullet labels inside canonical scope headings', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Normalize bullet aliases
- Goal: Rewrite only the validator output shape.
- Verification strategy: \`pnpm typecheck\`
- Exit criteria: Review churn does not depend on bullet-label spelling.
`);

  assert.equal(result.ok, true);
  assert.equal(result.normalization.applied, true);
  assert.match(result.normalization.normalizedDocument, /- Verification: `pnpm typecheck`/);
  assert.match(
    result.normalization.normalizedDocument,
    /- Success Condition: Review churn does not depend on bullet-label spelling\./,
  );
});

test('rejects one-shot plans even when an aliased execution queue header normalizes successfully', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: one_shot

## Derived Execution Queue

### Scope 1: Invalid
- Goal: This should still fail.
- Verification: \`pnpm typecheck\`
- Success Condition: Validation rejects the queue.
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, 'one_shot');
  assert.equal(result.normalization.applied, true);
  assert.match(result.errors.join('\n'), /must not include a `## Execution Queue` section/);
});

test('rejects ambiguous alias scopes that do not provide an unambiguous title', () => {
  const result = validatePlanDocument(`
# Derived Plan

## Execution Shape

executionShape: multi_scope

## Ordered Derived Scopes

1. Scope 6.6A
- Goal: This line is not enough to infer the canonical heading.
- Verification strategy: \`pnpm typecheck\`
- Exit criteria: Validation refuses to guess.
`);

  assert.equal(result.ok, false);
  assert.equal(result.executionShape, 'multi_scope');
  assert.equal(result.normalization.applied, true);
  assert.match(
    result.errors.join('\n'),
    /`## Execution Queue` must contain at least one `### Scope N:` entry.|contains content before the first scope entry/,
  );
});
