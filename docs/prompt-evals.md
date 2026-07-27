# Prompt evals

Prompt changes ship with two guards: a versioning contract that makes silent
drift impossible, and a reviewer-recall eval that measures what a reviewer
prompt actually does. Together they gate behavior-changing edits to the review
doctrine.

## Prompt versioning

Every registered `PromptSpec` carries an integer `version` and an in-source
changelog, and each render fixture records the version and a `renderSha` of the
prompt it pinned. The render-integrity contract test fails when a spec's
rendered output changes without a version bump. So "which prompt version
produced this run" is always answerable, and a prompt edit that forgets to bump
its version fails CI instead of drifting silently.

When you change a prompt: edit it, bump its `version`, add a changelog line, and
regenerate its render fixture. The test tells you exactly which spec is out of
sync.

## Reviewer-recall eval

The eval measures a reviewer prompt against a labeled fixture set (diffs with
known defects, plus clean diffs) and reports recall, precision, and blocking-
finding rate. It exists so the reviewer-doctrine rewrite can be gated on
numbers instead of intuition: run it before the change, run it after, compare.

### Running it

```
pnpm build
node scripts/eval-reviewer.mjs
```

It runs the reviewer configured in `~/.neal/config.yml` (or a repo `neal.yml`)
against every fixture, so it makes real provider calls and bills whatever that
reviewer bills. Run it from a checkout with an authenticated Codex/Claude CLI
to use a subscription, the same as `scripts/qualify-sdk.sh`. It prints a table
and writes `EVAL_REPORT.json` (gitignored).

### What the numbers mean

- **Recall**: labeled defects the reviewer flagged / all labeled defects. The
  headline number for a doctrine change: a rewrite that raises precision by
  suppressing findings will show up here as a recall drop.
- **Precision**: blocking findings that hit a labeled file / all blocking
  findings.
- **Clean false-positive rate**: clean fixtures the reviewer flagged with a
  blocking finding / clean fixtures.
- **Blocking rate**: mean blocking findings per fixture, a proxy for how many
  coder rounds the reviewer would force.

Matching is coarse on purpose: a finding counts for a label when they name the
same **file**. It measures "did the reviewer flag the right file", not "did it
describe the exact defect". Do not over-read the absolute numbers. Read the
**delta** between two prompt versions on the same fixtures.

### Adding fixtures

Fixtures live in `examples/reviewer-eval/`. Each is a directory with a `base/`
tree (the before state) and a `change.diff`, plus a manifest entry:

```json
{
  "id": "off-by-one",
  "kind": "defective",
  "diff": "off-by-one/change.diff",
  "baseDir": "off-by-one/base",
  "expectedFindings": [
    { "file": "src/paginate.ts", "defectClass": "off-by-one", "description": "..." }
  ]
}
```

A defective fixture labels at least one file the diff touches. A clean fixture
labels none. The loader (`src/neal/eval/reviewer-eval-manifest.ts`) enforces
that structurally: it checks a label points at a file the diff modifies, but
it does **not** try to prove the diff exhibits the defect. That proof was an
over-specification. A human authoring the fixture asserts the defect. Keep the
starter set growing toward ~10–15 fixtures across defect classes.

## Process rule

A pull request that changes reviewer-facing implementation-review prompt text must include:

1. a `version` bump and changelog line on the affected spec (enforced), and
2. before/after eval numbers in the PR description.

The reviewer-recall fixtures exercise implementation review, not plan review.
Evaluate `plan_reviewer` prompt changes with representative `neal plan` runs and
compare objective preservation, scope quality, readability, and review-round
count. Do not report reviewer-recall numbers for a plan-review-only change as if
they measured the changed prompt.

The eval is not run in CI (it costs live tokens). The versioning contract is
the CI-side guard, and the eval numbers are a human review requirement.
