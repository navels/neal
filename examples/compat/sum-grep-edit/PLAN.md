# Compat fixture: fix the number helper that never adds

> Fixture note: this plan describes the pre-fix state and is intentionally not updated after the fix lands.

## Execution Shape

executionShape: one_shot

## Objective

`src/numbers.js` exports several small number helpers. One of them is faulty:
`sumAll(ns)` is supposed to return the total of the list, but it always returns
`0`. The `sumAll` test in `test/numbers.test.js` fails because of this.

Read `src/numbers.js`, locate the faulty `sumAll` helper, and make the smallest
complete change so it returns the sum of the list. Do not touch the other
helpers, which already pass their tests.

## Boundaries

Allowed paths:

- `src/numbers.js`

Forbidden:

- Do not edit the test file.
- Do not change the other (already-correct) helpers.
- Do not add dependencies or new files.

## Verification

Run `node --test test/numbers.test.js`; it must exit `0`.
