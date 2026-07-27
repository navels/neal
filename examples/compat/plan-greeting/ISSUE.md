# Plan seed: fix the greeting helper

## Execution Shape

executionShape: one_shot

## Objective

`src/greet.js` exports `greet(name)`, which should return `Hello, <name>!` but
currently always returns `Hello!`, ignoring its argument. The test in
`test/greet.test.js` fails because of this.

Produce a one-shot plan that makes the smallest complete change to `src/greet.js`
so `greet(name)` returns `Hello, <name>!`, verified by
`node --test test/greet.test.js` exiting `0`.

## Boundaries

Allowed paths:

- `src/greet.js`

Forbidden:

- Do not edit the test file or add dependencies.
