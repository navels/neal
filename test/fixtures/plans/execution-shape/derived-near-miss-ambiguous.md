# Ambiguous Derived Near-Miss Plan

## Execution Shape

executionShape: multi_scope

## Goal

Demonstrate the class of derived plan Neal must still reject even when it recognizes the legacy queue header.

## Ordered Derived Scopes

1. Scope 6.6A
- Goal: Leave the scope title implicit and force the validator to guess.
- Verification strategy: `pnpm typecheck`
- Exit criteria: Validation refuses to invent the missing canonical heading.
