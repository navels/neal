# Issue Triage JavaScript Example

This is a tiny dependency-free JavaScript package for trying Neal against a
real but small codebase. The seed package already has passing tests and a
limited implementation. `PLAN.md` asks Neal to improve the parser, summary, and
formatter across four local scopes.

The package parses issue lines shaped like:

```text
- [P1] auth: Login fails @web #bug #customer
```

## Requirements

- Node.js 22 or newer
- pnpm
- A Git repository with an initial commit before running Neal
- Configured Neal providers for the live `neal run` path

## Non-Live Verification

From the repository root:

```sh
pnpm --dir examples/issue-triage-js test
```

From this example directory:

```sh
pnpm test
```

These commands use Node's built-in test runner. They do not call Neal, use
provider credentials, or spend model budget.

## Live Neal Run

Use a disposable branch or worktree so the example changes are easy to inspect
or discard.

From the repository root:

```sh
neal setup
neal check
cd examples/issue-triage-js
neal run PLAN.md
pnpm test
```

Use `neal run --no-squash PLAN.md` when you want to inspect the per-scope
commits Neal creates during the run.

`neal run` uses the providers configured by `neal setup`. It can take time and
may spend provider budget. Passing the local tests before the run does not
guarantee that a live provider-backed run will complete successfully.

Normal repository CI validates this example through non-live tests and package
checks without running providers.
