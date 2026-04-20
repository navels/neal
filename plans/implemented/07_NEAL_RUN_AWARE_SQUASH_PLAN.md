# Goal

Add a `neal --squash` command that rewrites the commits created by a completed Neal execution run into a single commit with a deterministic, plan-aware commit message.

The operator should be able to run:

```bash
neal --squash plans/04_NEAL_CURATED_PROMPT_SPECS_PLAN.md
```

and have Neal find the most recent completed run for that exact plan doc, verify that the run produced a clean linear commit range, and replace those run-owned commits with one final commit.

This is meant to solve a concrete traceability problem:

- operators often remember the plan doc more readily than the commit range
- Neal already records `planDoc`, `baseCommit`, `finalCommit`, and `createdCommits`
- that run metadata is strong enough to drive a safe squash flow without guessing from git history or commit subjects

The final squashed commit should follow this shape:

```text
Implement plans/04_NEAL_CURATED_PROMPT_SPECS_PLAN.md

- Add Neal prompt spec inventory contract
- Migrate planning prompts into prompt specs library
- Add prompt spec fixture regressions
- Migrate execute prompts into prompt specs
- Remove dead prompt migration imports
- Document prompt spec ownership boundaries
- Tighten prompt spec contract coverage
```

# Problem Statement

Neal already tracks enough execution metadata to know exactly which commits belong to a completed run, but that metadata is not yet operationalized for cleanup. The current workflow is:

- execute a multi-scope plan
- optionally make follow-up fixes
- manually inspect git history
- manually squash or rebase commits if cleaner history is desired

That is error-prone for two reasons:

1. the operator must reconstruct which commit range belongs to which run
2. the final squashed commit message is ad hoc, so even a cleaned-up history may still be ambiguous about which plan was implemented

The right abstraction is not "squash whatever commits mention this file path." The right abstraction is "squash the commits Neal recorded for this completed run."

# Desired Contract

`neal --squash` should be run-aware and conservative.

The operator-facing contract should be:

- `neal --squash PLAN.md` selects the most recent completed Neal execute-mode run for that exact plan doc
- Neal refuses to squash if the target run is ambiguous, incomplete, blocked, or produced no commits
- Neal refuses to squash if the current worktree is dirty
- Neal refuses to squash if the run's created commits are not a clean linear range from `baseCommit` to `finalCommit` on the current branch
- Neal prints which run and which commits it intends to squash before rewriting history
- Neal rewrites only the commits Neal recorded for that run
- Neal generates a single final commit message from run metadata, not fresh model invention

This should be a history-rewrite utility for completed Neal work, not a new execution mode.

# Non-Goals

This feature should not:

- infer commit ranges by grepping git history for plan filenames
- squash unfinished or blocked runs
- silently choose among multiple plausible historical runs for the same plan doc without telling the operator
- invent a new commit summary using the coder or reviewer model
- manage arbitrary interactive rebases
- rewrite non-Neal commits that happen to be adjacent in history

# Selection Semantics

The initial version should support:

- `neal --squash PLAN.md`

That command should:

1. normalize the provided plan path relative to the current working directory
2. discover Neal run directories under `.neal/runs/`
3. load run metadata from the archived state or final result artifacts for each candidate run
4. filter to execute-mode runs whose `planDoc` exactly matches the normalized path
5. filter again to runs that completed successfully and recorded at least one created commit
6. select the most recent completed matching run

If no completed matching run exists, Neal should fail with a direct error.

If more than one completed matching run exists, the initial version may still choose the latest one, but it must print which run was selected and how to disambiguate manually by inspecting `.neal/runs/`.

The plan-doc lookup is a convenience key. The true squash target is the completed run.

# Safety Checks

Before rewriting history, Neal should verify all of the following:

- the worktree is clean
- the HEAD commit equals the run's `finalCommit`
- the run has a non-empty `createdCommits` array
- `createdCommits` is ordered and unique
- the first created commit descends from `baseCommit`
- the last created commit equals `finalCommit`
- the run-owned commits form a contiguous linear range from `baseCommit..finalCommit`

If any of those checks fail, Neal should stop and explain exactly which invariant failed.

The initial version should be deliberately strict. If the operator has rebased, amended, or otherwise rewritten the run after completion, `--squash` should refuse rather than guessing.

# Commit Message Semantics

The generated squashed commit message should have two parts:

1. Subject line

```text
Implement plans/<PLAN_FILENAME>.md
```

Use the exact run `planDoc` path as recorded by Neal, rendered relative to the current working directory when possible.

2. Bullet summary

The bullet list must be derived from run-owned metadata in this priority order:

- accepted scope summaries captured in run artifacts or state
- created commit subjects from `createdCommits`
- if neither is available, fail with an explicit error rather than inventing prose

The initial version should not call a model to summarize the work. This message should be deterministic and auditable.

If the best available source is commit subjects, each bullet should be the original subject with redundant plan prefixes removed only when the trimming is mechanical and lossless.

# Rewrite Semantics

The initial version should use a non-interactive rewrite flow that is easy to audit.

The expected behavior is:

1. verify the target run and commit range
2. compute the final squashed commit message
3. reset the branch to `baseCommit`
4. replay the tree state from `finalCommit`
5. create one new commit with the generated message

This should leave the worktree and index clean with one replacement commit at HEAD.

The old run-owned commits become unreachable in the ordinary way git history rewrites do. Neal does not need to delete or hide them further.

# CLI and UX Requirements

Add a new command:

```text
neal --squash PLAN.md
```

The command should:

- print the selected run directory
- print `baseCommit`, `finalCommit`, and the commits that will be replaced
- print the exact commit message that will be used
- require a confirmation flag or interactive confirmation before the rewrite unless a non-interactive `--yes` flag is supplied

The initial version should support:

- `--yes` to skip confirmation
- `--dry-run` to print the selected run, commit range, and generated message without rewriting history

`--squash` should not depend on live coder or reviewer agents.

# Artifact and Audit Requirements

Neal should leave an audit trail for the squash action itself.

The initial version should write a small run-local artifact such as `SQUASH_PLAN.md` or `SQUASH_RESULT.json` containing:

- the selected run directory
- the selected plan doc
- the original `baseCommit`
- the original `finalCommit`
- the original `createdCommits`
- the replacement squashed commit hash
- the generated commit message
- the timestamp of the squash operation

This artifact should live under the selected run's directory so later inspection can tie the rewritten history back to the original run metadata.

# Guardrails

1. Neal must never squash commits for a run that did not complete successfully.
2. Neal must never rewrite history when the worktree is dirty.
3. Neal must never guess a commit range from commit messages alone.
4. Neal must never synthesize the bullet summary with a model in the initial version.
5. Neal must fail closed when run metadata is incomplete or inconsistent.

# Verification Strategy

Verification should be deterministic and git-backed.

Add automated tests covering:

- selecting the latest completed matching run for a plan doc
- rejecting missing runs
- rejecting blocked or incomplete runs
- rejecting dirty-worktree state
- rejecting non-linear or inconsistent commit metadata
- generating the squashed commit message from scope summaries
- falling back to commit subjects when scope summaries are unavailable
- `--dry-run` printing the expected target and message without rewriting history
- successful squash producing one replacement commit whose tree matches the original `finalCommit`
- successful squash writing the squash audit artifact

Use real temporary git repositories in tests for the rewrite path. Do not fake git topology with pure data fixtures for the critical squash behavior.

## Execution Shape

executionShape: multi_scope

## Execution Queue

### Scope 1: Run selection and metadata validation
- Goal: Add `--squash`, `--dry-run`, and `--yes` parsing; discover the latest completed matching execute run; and validate strict squash eligibility without rewriting history yet.
- Verification: `pnpm typecheck` and targeted tests for run discovery, selection, and validation failures.
- Success Condition: Neal can select one completed run for an exact plan doc, report the run-owned commit range, and fail closed on missing or inconsistent metadata.

### Scope 2: Commit message generation
- Goal: Build the deterministic squashed commit message from accepted scope summaries first, then commit subjects when necessary.
- Verification: `pnpm typecheck` and targeted tests for scope-summary sourcing, commit-subject fallback, and sparse-metadata rejection.
- Success Condition: Neal can render the exact final squash message for a validated run without invoking a model.

### Scope 3: Safe rewrite execution and audit artifact
- Goal: Perform the non-interactive squash rewrite, require confirmation unless `--yes` is present, and write the squash audit artifact under the selected run directory.
- Verification: `pnpm typecheck` and git-backed tests covering `--dry-run`, successful rewrite, and audit-artifact persistence.
- Success Condition: Neal replaces the validated run-owned commits with one deterministic commit whose tree matches the original final commit and leaves an inspectable audit trail.

# Scope 1: Run Selection and Metadata Validation

Implement run discovery, plan-doc matching, and strict eligibility checks for `--squash`.

Goal:

- add CLI parsing for `--squash`, `--dry-run`, and `--yes`
- discover completed execute-mode runs for an exact plan-doc path
- validate that the selected run has sufficient metadata for a safe squash

Verification:

- `pnpm typecheck`
- targeted tests covering run discovery and selection failure modes

Success Condition:

- Neal can select a unique target run for a plan doc and explain why it is eligible or ineligible without rewriting history yet.

# Scope 2: Commit Message Generation

Implement deterministic commit-message generation from run metadata.

Goal:

- define the message builder
- source bullets from accepted scope summaries when available
- fall back to created-commit subjects only when necessary
- reject runs whose metadata is too sparse to produce an auditable message

Verification:

- `pnpm typecheck`
- targeted tests covering scope-summary and commit-subject inputs

Success Condition:

- Neal can produce the exact squashed commit message for a target run without involving a model or guessing from arbitrary git history.

# Scope 3: Safe Rewrite Execution

Implement the actual history rewrite and the squash audit artifact.

Goal:

- enforce worktree and topology preconditions
- replace the run-owned commit range with one new commit
- write the squash result artifact into the selected run directory

Verification:

- `pnpm typecheck`
- git-backed tests in temporary repositories covering dry-run and successful rewrite behavior

Success Condition:

- On a clean linear completed run, Neal can squash the run-owned commits into one replacement commit whose tree matches the original final state and whose message follows the deterministic format.

# Scope 4: CLI Polish and Operator Safeguards

Finish the command UX and refusal surfaces.

Goal:

- add clear operator-facing output for selected run, commit range, and generated message
- require confirmation unless `--yes` is provided
- make refusal cases direct and actionable

Verification:

- `pnpm typecheck`
- CLI-level tests for confirmation, dry-run output, and refusal messages

Success Condition:

- `neal --squash` is safe to run interactively and explicit enough that an operator can see exactly what will be rewritten before any history changes occur.

# Recommended Implementation Order

1. Land run selection and validation first.
2. Add deterministic message generation next.
3. Implement the rewrite path only after the selection and message surfaces are stable.
4. Finish with confirmation flow, dry-run behavior, and refusal-message polish.

# Final Notes

This feature is intentionally conservative. It is better for `neal --squash` to refuse on edge cases than to rewrite the wrong history.

When all scopes are complete, end with `AUTONOMY_DONE`.
