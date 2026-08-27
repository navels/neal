import test from 'node:test';
import assert from 'node:assert/strict';

import { getLaterScopeRevisionEligibility, reviseLaterScope } from '../src/neal/plan-scope-revision.js';

const PLAN = `# Example Plan

## Execution Shape

executionShape: multi_scope

## Objective

Ship three slices.

## Execution Queue

### Scope 1: First slice
- Goal: Do the first thing.
- Verification: \`pnpm typecheck\`
- Success Condition: First thing done.

### Scope 2: Second slice
- Goal: Do the second thing.
- Verification: \`pnpm test\`
- Success Condition: Second thing done.

### Scope 3: Third slice
- Goal: Do the third thing.
- Verification: \`pnpm build\`
- Success Condition: Third thing done.
`;

const PLAN_WITH_TRAILING_SECTION = `${PLAN}
## Boundaries

- Keep it small.
`;

const ALIAS_PLAN = `
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
- Verification strategy: \`pnpm typecheck\`
- Exit criteria: No compatibility wrapper remains.
`;

const SCOPE_2_BODY = `### Scope 2: Second slice, revised
- Goal: Do the second thing differently.
- Verification: \`pnpm test\`
- Success Condition: Second thing done the new way.`;

const SCOPE_3_BODY = `### Scope 3: Third slice, revised
- Goal: Do the third thing differently.
- Verification: \`pnpm build\`
- Success Condition: Third thing done the new way.
`;

function expectErrors(result: ReturnType<typeof reviseLaterScope>, pattern: RegExp) {
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.match(result.errors.join('\n'), pattern);
}

test('revises a middle scope and leaves every other byte unchanged', () => {
  const result = reviseLaterScope({
    planDocument: PLAN,
    currentScopeNumber: 1,
    targetScopeNumber: 2,
    replacementBody: SCOPE_2_BODY,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const [beforeOriginal, afterOriginal] = PLAN.split(/### Scope 2: Second slice\n(?:- .*\n)+/);
  const [beforeRevised, afterRevised] = result.document.split(`${SCOPE_2_BODY}\n`);
  assert.equal(beforeRevised, beforeOriginal);
  assert.equal(afterRevised, afterOriginal);
  assert.match(result.document, /### Scope 2: Second slice, revised/);
  assert.doesNotMatch(result.document, /Do the second thing\./);
});

test('revises the last scope at end of file', () => {
  const result = reviseLaterScope({
    planDocument: PLAN,
    currentScopeNumber: 2,
    targetScopeNumber: 3,
    replacementBody: SCOPE_3_BODY,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const prefix = PLAN.slice(0, PLAN.indexOf('### Scope 3:'));
  assert.equal(result.document, `${prefix}${SCOPE_3_BODY}`);
});

test('splice stops at a trailing second-level section', () => {
  const result = reviseLaterScope({
    planDocument: PLAN_WITH_TRAILING_SECTION,
    currentScopeNumber: 1,
    targetScopeNumber: 3,
    replacementBody: SCOPE_3_BODY,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const prefix = PLAN.slice(0, PLAN.indexOf('### Scope 3:'));
  assert.equal(result.document, `${prefix}${SCOPE_3_BODY}\n## Boundaries\n\n- Keep it small.\n`);
});

test('rejects a target equal to or before the current scope', () => {
  for (const targetScopeNumber of [1, 2]) {
    expectErrors(
      reviseLaterScope({
        planDocument: PLAN,
        currentScopeNumber: 2,
        targetScopeNumber,
        replacementBody: `### Scope ${targetScopeNumber}: X\n- Goal: a\n- Verification: b\n- Success Condition: c`,
      }),
      /must be a later scope than the current scope 2/,
    );
  }
});

test('rejects a target past the scope count', () => {
  expectErrors(
    reviseLaterScope({
      planDocument: PLAN,
      currentScopeNumber: 1,
      targetScopeNumber: 4,
      replacementBody: '### Scope 4: X\n- Goal: a\n- Verification: b\n- Success Condition: c',
    }),
    /past the plan's scope count of 3/,
  );
});

test('rejects a body whose heading number does not match the target', () => {
  expectErrors(
    reviseLaterScope({
      planDocument: PLAN,
      currentScopeNumber: 1,
      targetScopeNumber: 2,
      replacementBody: SCOPE_3_BODY,
    }),
    /must start with the line `### Scope 2:`/,
  );
});

test('rejects a body containing a second heading', () => {
  expectErrors(
    reviseLaterScope({
      planDocument: PLAN,
      currentScopeNumber: 1,
      targetScopeNumber: 2,
      replacementBody: `${SCOPE_2_BODY}\n\n### Scope 3: Sneaky\n- Goal: a`,
    }),
    /exactly one scope entry; found additional heading\(s\): `### Scope 3: Sneaky`/,
  );
  expectErrors(
    reviseLaterScope({
      planDocument: PLAN,
      currentScopeNumber: 1,
      targetScopeNumber: 2,
      replacementBody: `${SCOPE_2_BODY}\n\n## Boundaries\n- none`,
    }),
    /found additional heading\(s\): `## Boundaries`/,
  );
});

test('rejects a body that drops a required bullet', () => {
  expectErrors(
    reviseLaterScope({
      planDocument: PLAN,
      currentScopeNumber: 1,
      targetScopeNumber: 2,
      replacementBody: '### Scope 2: Missing goal\n- Verification: `pnpm test`\n- Success Condition: done.',
    }),
    /Revised plan does not validate: Scope 2 is missing required bullet `- Goal:`/,
  );
});

test('refuses an alias-form plan and reports it ineligible', () => {
  expectErrors(
    reviseLaterScope({
      planDocument: ALIAS_PLAN,
      currentScopeNumber: 1,
      targetScopeNumber: 2,
      replacementBody: '### Scope 2: X\n- Goal: a\n- Verification: b\n- Success Condition: c',
    }),
    /alias form/,
  );

  const eligibility = getLaterScopeRevisionEligibility(ALIAS_PLAN, 1);
  assert.equal(eligibility.eligible, false);
  assert.match(eligibility.reasons.join('\n'), /alias form/);
});

test('eligibility requires a canonical multi-scope plan with a later scope', () => {
  const eligible = getLaterScopeRevisionEligibility(PLAN, 1);
  assert.deepEqual(eligible, { eligible: true, scopeCount: 3, reasons: [] });

  const lastScope = getLaterScopeRevisionEligibility(PLAN, 3);
  assert.equal(lastScope.eligible, false);
  assert.equal(lastScope.scopeCount, 3);
  assert.match(lastScope.reasons.join('\n'), /no later scope to revise/);

  const oneShot = getLaterScopeRevisionEligibility(
    '# Plan\n\n## Execution Shape\n\nexecutionShape: one_shot\n\n## Goal\n\nShip it.\n',
    1,
  );
  assert.equal(oneShot.eligible, false);
  assert.match(oneShot.reasons.join('\n'), /only `multi_scope` plans/);

  const invalid = getLaterScopeRevisionEligibility('# Plan\n\nno shape here\n', 1);
  assert.equal(invalid.eligible, false);
  assert.match(invalid.reasons.join('\n'), /Plan does not validate/);
});
