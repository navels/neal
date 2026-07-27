# Issue Triage Example Improvement Plan

## Execution Shape

executionShape: multi_scope

## Objective

Improve this dependency-free JavaScript issue-triage example in small, reviewable
steps. Keep the package local to this directory and keep every scope verifiable
with the example's built-in Node test suite.

## Boundaries

Allowed paths:

- `examples/issue-triage-js/src/issue-triage.js`
- `examples/issue-triage-js/test/issue-triage.test.js`
- `examples/issue-triage-js/README.md`

`examples/issue-triage-js/PLAN.md` may be updated only if Neal's
plan-refinement loop makes a necessary structural clarification.

Forbidden paths and work:

- Do not edit Neal runtime source under `src/`.
- Do not edit root documentation, root package metadata, workflows, benchmark
  files, or other repository-level files.
- Do not add dependencies, lockfiles, generated artifacts, provider transcripts,
  or `.neal/` artifacts to Git.
- Do not call live network services from tests or package code.

## Current Behavior

The seed implementation parses simple lines such as
`- [P1] auth: Login fails @web #bug #customer`, summarizes counts, and formats a
short markdown report. It intentionally leaves several realistic edge cases for
this plan to improve.

## Execution Queue

### Scope 1: Add parser edge-case tests and support lowercase priorities, leading/trailing whitespace, and `*` bullets
- Goal: Add focused parser tests, then update `parseIssueLine` and `parseIssues` so issue lines can use lowercase priorities, leading or trailing whitespace, and either `-` or `*` bullets while preserving normalized `P1`-style priorities.
- Verification: Run `pnpm test` from `examples/issue-triage-js/`.
- Success Condition: Parser tests cover the new edge cases, the implementation handles them, existing baseline parsing still works, and the example test suite passes.

Implementation notes:

- Keep comments and blank lines ignored by `parseIssues`.
- Preserve the exported function names.
- Do not broaden the parser beyond issue-triage lines needed by this example.

### Scope 2: Add summary tests and fix optional owners, `unassigned` owner grouping, duplicate tag handling, and deterministic ordering
- Goal: Add summary-focused tests, then update parsing and summarization so owners are optional, missing owners are counted as `unassigned`, duplicate tags on one issue are counted once, and summary count objects are built in deterministic key order.
- Verification: Run `pnpm test` from `examples/issue-triage-js/`.
- Success Condition: Summary tests cover optional owners, duplicate tags, and deterministic ordering; `summarizeIssues` returns stable counts by priority, area, owner, and tag; and the example test suite passes.

Implementation notes:

- Keep `parseIssueLine` returning `owner: null` for issues without an owner.
- Apply the `unassigned` grouping in `summarizeIssues`.
- Prefer simple deterministic ordering over a new dependency.

### Scope 3: Add formatter tests and make `formatSummary(summary)` produce deterministic markdown sorted by priority, area, owner, and tag
- Goal: Add formatter tests, then update `formatSummary(summary)` so its markdown sections are deterministic and sorted by priority, area, owner, and tag.
- Verification: Run `pnpm test` from `examples/issue-triage-js/`.
- Success Condition: Formatter tests cover stable section ordering, sorted entries, and empty sections where relevant; `formatSummary(summary)` produces deterministic markdown; and the example test suite passes.

Implementation notes:

- Keep the report compact and readable.
- Do not change the summary object shape unless the tests require a small
  backward-compatible clarification.

### Scope 4: Update the example README or sample usage to match the final behavior and keep the example tests passing
- Goal: Update `examples/issue-triage-js/README.md` or its sample usage so the documentation matches the final parser, summarizer, and formatter behavior.
- Verification: Run `pnpm test` from `examples/issue-triage-js/`.
- Success Condition: The README or sample usage accurately reflects the final behavior, does not direct users outside the example directory for code edits, and the example test suite passes.

Implementation notes:

- Keep the README focused on running and understanding this example.
- Do not document behavior that the tests do not cover.
