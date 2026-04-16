import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePlanDocument } from './plan-validation.js';

test('accepts a valid one-shot plan document', () => {
  const result = validatePlanDocument(`
# Example Plan

## Execution Shape

executionShape: one_shot

## Goal

Ship a focused change.
`);

  assert.deepEqual(result, {
    ok: true,
    executionShape: 'one_shot',
    errors: [],
  });
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
- Verification: \`tsx --test src/neal/plan-validation.test.ts\`
- Success Condition: Missing headers and bullets fail deterministically.
`);

  assert.deepEqual(result, {
    ok: true,
    executionShape: 'multi_scope',
    errors: [],
  });
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
