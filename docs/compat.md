# `neal compat`: model compatibility smoke test

`neal compat` answers one question per model: **can this OpenAI-compatible model
drive neal's loop at all**, as a coder, a reviewer, or a planner? It is a
**compatibility smoke test, not a performance benchmark**. There is no
resolve-rate, no score, and no ranking. The
fixtures are deliberately trivial. Any working agent should pass them. A failure
therefore means something is **fundamentally wrong** with the model's ability to
operate neal's contract. It does not mean a task was hard.

`neal compat` is fully self-contained in the neal repo. The only things an
operator needs to qualify a model are the neal checkout plus an API key: no
external benchmark assets, no dataset download, no remote runner.

## Compatibility, not skill

- **Measured:** whether the model can follow neal's contract end to end (valid
  tool calls + structured output, no max-step loops, no unresolved operator
  blocks, a clean finalization) **and** solve a trivial bundled fixture.
- **Not measured:** skill. No resolve-rate, no scores, no rankings, trivial
  fixtures only.
- **Outcome:** a binary **PASS / FAIL per (model, role)**, with a structural
  failure mode recorded for every FAIL.

## How it layers with `neal check`

`neal check` and `neal compat` are two distinct gates:

- **`neal check`** validates the effective config and confirms each configured
  role's provider can answer one small structured probe
  (`provider_check_payload`). It proves *connectivity and basic protocol*, not
  that the model can complete a full neal run. When the resolved **coder or
  reviewer** role uses the non-native `openai-compatible`
  provider, `neal check` prints a one-line pointer: *"This is an openai-compatible
  model - run `neal compat` to confirm it can drive the full loop."* Native
  adapters (`openai-codex`, `anthropic-claude`) do not get the pointer. The
  planner inherits the coder provider by default, so the coder check covers the
  common case. An explicitly configured non-native planner paired with native
  coder/reviewer is not separately flagged (run `neal compat --role planner`
  to qualify it).
- **`neal compat`** runs the same structured pre-filter first (it reuses
  `check`'s `verifyConfiguredProviders`), then drives the model through complete
  neal runs against the bundled fixtures and produces a PASS/FAIL matrix.

So `neal check` is the cheap connectivity gate. `neal compat` is the full-loop
qualification gate that `check` points openai-compatible users toward.

## Usage

```bash
neal compat [--model <slug>] [--role coder|reviewer|planner|all] [--reference openai-codex|anthropic-claude|openai-compatible:<slug>] [--json]
```

- `--role` (default `all`) selects which role(s) to test: `coder`, `reviewer`,
  `planner`, or `all`.
- With no flags at all, every role runs on your configured provider and model,
  which is how to verify a native slug (`openai-codex` or `anthropic-claude`);
  `--model` always routes the candidate to `openai-compatible`.
- `--model <slug>` runs the slug on the **`openai-compatible`** provider in the
  candidate role (provider forced to `openai-compatible`, any configured effort
  dropped, so the slug drives a clean OpenRouter call). When omitted, the
  candidate role uses its configured provider/model unchanged.
- `--reference <id>` names the provider for the **non-candidate** roles so a
  FAIL is attributable to the candidate in the tested role, not to a weak (and
  possibly flaky) partner. Accepted forms: a native provider id (`openai-codex`,
  the default when omitted while `--model` is set, or `anthropic-claude`), or
  `openai-compatible:<openrouter-model>` to run the reference roles on an
  OpenRouter model. A bare model slug is rejected. Native reference roles run on
  that adapter's default model (`gpt-5.5` for `openai-codex`, `claude-opus-4-8`
  for `anthropic-claude`). Prefer a native reference for whitelist
  qualification. See [compatible-models.md](compatible-models.md) for why
  OpenRouter references proved unreliable as qualification partners. When
  **neither** `--model` nor `--reference` is given, every role stays on its
  configured provider/model (pure pass-through).
- `--json` prints the stable machine-readable matrix instead of the human table
  (schema below).

The command resolves its base config via the same writer-provider resolver the
other commands use, then derives a candidate config by cloning it and routing the
tested role onto `openai-compatible` (when `--model` is set) and the non-candidate
roles onto the resolved reference provider: a native adapter at its default
model, or `openai-compatible` at the slug from the
`openai-compatible:<slug>` form (when either flag is set). It runs
against **throwaway git copies** of the bundled fixtures and **never mutates** a
committed fixture under `examples/compat/`. The process exits non-zero when the
overall result is FAIL.

Example (Phase B operational usage, OpenRouter paid slug with a native reference):

```bash
neal compat --model deepseek/deepseek-chat --role all --reference openai-codex --json
```

## Bundled fixtures (`examples/compat/`)

Each fixture is a tiny self-contained project. `examples/compat/manifest.json`
is the single data source that makes the command data-driven. The shipped
fixtures are:

| Fixture | Roles | Contract surface |
| --- | --- | --- |
| `add-edit-verify` | coder, reviewer | edit + verify + commit |
| `sum-grep-edit` | coder, reviewer | read/grep-then-edit |
| `plan-greeting` | planner | emit a `one_shot` plan |

Each fixture maps to a distinct way neal *directs* a model. A fixture that only
varies the coding task (not the direction shape) would measure skill, which this
command deliberately does not. That is why there are exactly three.

Each coder fixture bundles buggy source, a test that fails against the buggy
source, and a `PLAN.md` declaring `executionShape: one_shot` that describes the
smallest complete fix. The reviewer fixtures reuse the same projects, each paired
with two pre-made unified diffs (`good.diff`, `broken.diff`). The planner fixture
provides an issue-statement seed (`ISSUE.md`) and no reviewer diffs.

Fixture source and test files deliberately avoid any comment or claim that
becomes false once `good.diff` applies (`// BUG: …`, "intentionally buggy",
a stale `// TODO:`). A reviewer worktree is the project plus the applied diff, so
such text is a real defect in the material under review and draws legitimate
blocking findings on the known-good diff. The one exception is each fixture's
`PLAN.md`, which describes the pre-fix state by definition and carries a fixture
note saying so.

`examples/issue-triage-js` remains an optional tier-2 "real-ish" check above the
trivial gate. `neal compat` does not require it.

### Manifest schema

```jsonc
{
  "fixtures": [
    {
      "id": "add-edit-verify",
      "roles": ["coder", "reviewer"],          // which roles use this fixture
      "projectDir": "add-edit-verify",          // relative to examples/compat/
      "planDoc": "add-edit-verify/PLAN.md",     // coder run plan (one_shot)
      "verifyCommand": "node --test test/add.test.js", // coder PASS check
      "referenceFix": { "file": "src/add.js", "from": "a - b", "to": "a + b" },
      "reviewer": {
        "goodDiff": "add-edit-verify/good.diff",   // reviewer must ACCEPT
        "brokenDiff": "add-edit-verify/broken.diff" // reviewer must FLAG/REJECT
      }
    }
  ]
}
```

A planner fixture sets `"roles": ["planner"]` and provides `"issuePrompt"`
instead of `reviewer`. Any fixture carrying the `reviewer` role must also define
`verifyCommand`: reviewer fixtures reuse the coder project's command as the
deterministic good/broken oracle: `goodDiff` must make it pass, `brokenDiff`
must make it fail. The `referenceFix` is used only by the structural fixture
self-test (`test/compat-fixtures.test.ts`), never by a model run.

## Definition of PASS (per model, per role)

Across **every** fixture for the role, the model must (1) **complete the run
cleanly** and (2) produce the **role-correct result**. A clean run reaches
`status: 'done'` — not `'failed'`, `'blocked'`, or an operator-stop wait —
and does not exceed its step/round budget.
The role-correct result is:

- **coder:** `finalState.status === 'done'` **and** the fixture's
  `verifyCommand` exits `0` in the throwaway worktree (the failing test now
  passes).
- **reviewer:** the review-findings loop converges (`outcome === 'accepted'`) for
  **both** diffs, and the converged findings **discriminate** them. Counting
  blocking findings (a `ReviewFindingItem` with `severity === 'blocking'`) per
  diff, PASS iff `blocking(broken) >= 1` **and** `blocking(good) < blocking(broken)`.
  Severity calibration is **not** graded: a reviewer may raise blocking findings
  on the good diff and still PASS, as long as the broken diff draws strictly more.
  A reviewer that blocks on neither diff, or equally on both, FAILs. `outcome`
  alone is not sufficient (it is `'accepted'` whenever the findings artifact
  converges, including a zero-finding artifact), so the verdict is scored on
  `draft.findings` severities. The verdict is a **pair** verdict: both the good
  and broken cells carry the same `pass`, and each carries its own
  `blockingCount`.
- **planner** (secondary): the emitted plan document validates via
  `validatePlanDocument` as a schema-conformant `one_shot` plan.

Any single fundamental failure on any fixture for the role → **FAIL** for that
role, with the mode recorded.

`neal compat` runs each fixture with **no operator attached**. A run that stops
to wait for an operator is classified `block_unresolved` and FAILs: the
fixtures are trivial, so needing a human is itself the compatibility failure.
This is the same rule external harnesses apply — a blocked run always exits
with writer code `2`, and a driver with no operator (neal-swebench, CI)
records that exit as a failure verdict. Compat also silences neal's own
operator notifier for its child runs (it sets the defined-but-empty
`NEAL_NOTIFY_BIN` override at startup), so a blocked fixture run never pings
the operator's configured notify helper mid-matrix.

## Failure-mode taxonomy

Each FAIL records a mode derived from **structural run state**
(`finalState.status`, emitted run events, `ReviewFindingsOutcome`, and
`validatePlanDocument`), never from substring-matching model prose. When more than
one applies, the earliest in this list (most specific cause first) is recorded:

- `protocol`: the `verifyConfiguredProviders` pre-filter threw for the candidate
  (it could not emit one valid `provider_check_payload`). Fixtures were skipped.
- `provider_failed`: the run failed with a model-attributable provider error
  event (transport/auth/transient/other) rather than a clean completion, **except**
  a provider error whose `errorKind` is a structured-output kind, which is recorded
  as `structured_output` (below). This is also the bucket for a **writer** run that
  ends `status: 'failed'` without a more specific structural signal, including
  step/round-budget exhaustion, which the current runtime does not surface to compat
  as a distinct cap event, so writer step-cap exhaustion is reported here rather than
  as `max_step_loop`.
- `block_unresolved`: the run's final persisted state is an operator stop (the
  model escalated to a block that only a human could answer). The signal
  mirrors the writer exit-code-2 mapping: the run is structurally waiting for
  the operator per `getRunDisplayStatus` (the interactive-recovery wait or a
  pending-guidance view) or persisted `status: 'blocked'`. Also recorded when
  the review loop's outcome was `'blocked'`.
- `max_step_loop`: the **reviewer** loop's outcome was `'cap_reached'` (the
  review-findings convergence cap was hit). Writer (coder/planner) step-cap
  exhaustion is not separately distinguishable under the current runtime and is
  classified as `provider_failed` (above).
- `wrong_or_empty_output`. Coder: the run reached `done` but `verifyCommand`
  exited non-zero (or the diff was empty); reviewer: the findings did not
  discriminate the pair (no blocking finding on the broken diff, or the good diff
  drew at least as many blocking findings as the broken one), recorded on both
  cells of the pair; planner: the emitted plan was not a schema-conformant
  `one_shot` plan. When one diff's review **failed** outright, the pair verdict is
  unscoreable: that diff keeps its own failure mode and the other cell fails with
  the same mode and a `pair unscoreable: …` detail, so the systematic cause is
  what gets attributed.
- `structured_output`: the model could not produce or honor **schema-enforced**
  JSON. This covers a reviewer/planner round whose payload failed schema validation
  (surfaced as the corresponding round error) **and** a coder/reviewer provider
  error whose `errorKind` is `structured_output_invalid` or
  `structured_output_missing`, e.g. an OpenRouter (openai-compatible) gateway that
  rejects the `type: 'json_schema'` request (HTTP 400) or returns a missing/invalid
  object. This is distinct from `provider_failed` (transport/auth/other transport
  errors) and from `wrong_or_empty_output` (a syntactically valid verdict/output
  that was substantively wrong). Both the coder (`classifyWriterFailure`) and
  reviewer (`classifyReviewerThrownFailure`) paths attribute these kinds here.
- `finalization_error`: the run failed during finalization/artifact writing, or
  the run produced no final document where one was expected.

When no structural signal is conclusive, `provider_failed` is recorded with the
terminal error message attached.

## Output

By default `neal compat` prints a human-readable matrix: one row per
role × fixture cell (with the reviewer `good`/`broken` diff kind), a per-role
roll-up, and an overall verdict.

### `--json` schema

`--json` prints a single JSON object. This shape is stable and feeds the Phase B
whitelist (`docs/compatible-models.md`):

```jsonc
{
  "schemaVersion": 2,
  "model": "deepseek/deepseek-chat",   // candidate --model, or null when omitted
  "reference": null,                    // the --reference value as given: a native provider id (openai-codex | anthropic-claude), openai-compatible:<slug>, or null when omitted
  "role": "all",                        // coder | reviewer | planner | all
  "candidateProviders": {               // provider each role used as the candidate: "openai-compatible" per role when --model is set, else the configured provider
    "coder": "openai-compatible",
    "reviewer": "openai-compatible",
    "planner": "openai-compatible"
  },
  "cells": [
    {
      "role": "coder",                  // coder | reviewer | planner
      "fixtureId": "add-edit-verify",   // manifest id; "provider:<role>" for a protocol pre-filter FAIL
      "diffKind": null,                 // "good" | "broken" for reviewer cells, else null
      "blockingCount": null,            // blocking findings on this diff; null for non-reviewer or errored cells
      "pass": true,
      "failureMode": null,              // one of the taxonomy modes when pass=false, else null
      "detail": null                    // human-readable explanation when pass=false, else null
    }
  ],
  "roles": [
    {
      "role": "coder",
      "pass": true,
      "cellCount": 3,                   // cells for this role
      "passCount": 3                    // cells that passed
    }
  ],
  "overallPass": true                   // true iff every targeted role's roll-up passed
}
```

No tooling gates on `schemaVersion`. It exists so a stored report's scoring
semantics are identifiable. Version `2` is the discrimination criterion described
above plus `blockingCount`. Version `1` reports scored the reviewer on zero
blocking findings for the good diff and retained no counts, so they cannot be
re-scored.

A role roll-up is PASS iff it has at least one cell and every one of its cells
passed. `overallPass` is true iff every targeted role roll-up passed. The process
exits non-zero when `overallPass` is false.

## Cost

Cheap by construction: trivial fixtures and cheap models. If qualifying a model
gets expensive, the fixture set is too big.

## Phase B: building the whitelist

With a provider configured (OpenRouter **paid** slugs only, never `:free`) and a
known-good `--reference`, run `neal compat --model <slug> --role all --json` for
each candidate and fill the dated [`compatible-models.md`](compatible-models.md)
matrix from the JSON output. Date and version the matrix. Model behavior drifts,
so re-run on version bumps.
