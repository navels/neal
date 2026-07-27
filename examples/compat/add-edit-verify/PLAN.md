# Compat fixture: fix `add`

> Fixture note: this plan describes the pre-fix state and is intentionally not updated after the fix lands.

## Execution Shape

executionShape: one_shot

## Objective

`src/add.js` exports an `add(a, b)` helper that is supposed to return the sum of
its two arguments, but it currently returns the difference. The test in
`test/add.test.js` fails because of this bug.

Make the smallest complete change to `src/add.js` so that `add(a, b)` returns the
sum of `a` and `b`, then confirm the test passes.

## Boundaries

Allowed paths:

- `src/add.js`

Forbidden:

- Do not edit the test file.
- Do not add dependencies or new files.

## Verification

Run `node --test test/add.test.js`; it must exit `0`.
