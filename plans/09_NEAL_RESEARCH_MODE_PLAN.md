# Goal

Add a `--research` mode to Neal that performs repository analysis and, when needed, external research through the existing coder/reviewer loop, then produces a settled research/recommendation artifact instead of code changes or an execution plan.

The first version should support the same input-mode semantics as `--execute`:

- `neal --research QUESTION.md`
- `neal --research-file QUESTION.md`
- `neal --research-text "Analyze this repository ..."`

The output should be a Neal-owned research memo and review artifact, not source edits or commits.

# Problem Statement

There is a recurring workflow that Neal does not currently support directly:

- inspect the local repository
- research an external tool, architecture, or dependency
- synthesize a recommendation or feasibility analysis
- have a second model independently evaluate that research and recommendation
- iterate until the memo is settled

Today this is done manually outside Neal, even though the underlying interaction shape matches Neal well:

- coder researches and drafts
- reviewer independently evaluates
- coder responds to findings
- reviewer settles or continues raising findings

This is structurally closer to `--plan` than to `--execute`, but the output is not an executable plan. It is a research/recommendation memo.

# Desired Contract

`--research` should be a distinct top-level Neal mode with these properties:

1. Input semantics match `--execute`

- `--research QUESTION.md` means file input by default
- `--research-file QUESTION.md` is the explicit file-mode spelling
- `--research-text "..."` is the explicit string-mode spelling

2. No code or git side effects by default

- Neal does not create commits
- Neal does not edit repository source files unless the operator explicitly asked for that in the research request
- the default contract is artifact production only

3. Research artifact output

- Neal writes a primary research memo artifact
- Neal writes a reviewer artifact capturing findings and settlement state
- the final result is a settled memo or a blocked research run

4. Same adjudicated loop shape Neal already uses

- coder researches and drafts the memo
- reviewer independently evaluates grounding, completeness, and recommendation quality
- coder revises in response to findings
- loop continues until acceptance or block

5. External research is allowed when needed

- if the question requires current external information, the research flow should browse and cite sources
- if the question is purely repository-internal, the flow can remain local

# Non-Goals

This plan should not:

- turn `--research` into a code-execution or implementation mode
- require separate memo subtypes in the first version
- invent a generalized “all Neal modes are one engine” refactor as part of this slice
- require source edits to the repository as part of ordinary research runs
- depend on final squash, scope markers, or final completion review from execute mode

# Recommended Output Contract

The first version should use one general research memo contract rather than multiple memo types.

The primary artifact should be markdown with a stable shape such as:

- `# Research Memo`
- `## Question`
- `## Repository Findings`
- `## External Research`
- `## Options Considered`
- `## Recommendation`
- `## Risks and Unknowns`

The contract should be flexible enough to support:

- recommendation questions
- feasibility questions
- comparison questions
- architecture evaluation questions

If the prompt is purely investigative and does not warrant a recommendation, the memo should say so explicitly in the recommendation section rather than forcing a fake conclusion.

# Reviewer Contract

The reviewer in research mode should not behave like an implementation reviewer.

The reviewer should explicitly evaluate:

- whether repository claims are grounded in actual inspected code
- whether external research is accurate and sufficiently sourced
- whether the memo considers the relevant options and tradeoffs
- whether the recommendation follows from the evidence
- whether important uncertainties or constraints are surfaced clearly

The reviewer should raise blocking findings when:

- the memo is factually unsupported
- the repository analysis is not grounded in actual code inspection
- the external research is missing where clearly needed
- the recommendation is under-argued or contradicted by the evidence

# Artifact Requirements

The first version should produce at least:

- `RESEARCH.md`
- `RESEARCH_REVIEW.md`

For string-input runs, Neal should also write a run-owned source artifact analogous to inline execute input, for example:

- `INLINE_RESEARCH_REQUEST.md`

The final JSON result should include paths to the research artifact and review artifact.

# Input Semantics

Input handling should intentionally mirror `--execute`.

The first-version expected behavior is:

- `--research QUESTION.md`
  - treat the argument as a file path
- `--research-file QUESTION.md`
  - explicit file-mode spelling
- `--research-text "..."`
  - treat the argument as inline research request text
  - write a run-owned input artifact under `.neal/runs/<run>/`

This should reuse the same input-source pattern Neal already uses for execute mode where practical.

# State and Mode Semantics

`--research` should be a separate top-level mode, parallel to `plan` and `execute`.

The first version should have its own simple phase family, likely something like:

- `coder_research`
- `reviewer_research`
- `coder_research_response`
- `done`
- `blocked`

This mode should not inherit execute-only machinery such as:

- scope numbers
- created commits
- final squash
- final completion review
- meaningful progress gating

The state should remain as small as possible for the artifact-oriented flow.

# Configuration and Provider Behavior

The first version should reuse the existing coder/reviewer provider selection and model-override behavior Neal already exposes.

No new provider-role combinations are required for this slice.

The mode should honor the same defaults and overrides as other Neal modes unless a research-specific need emerges later.

# Guardrails

1. Research mode must not create commits by default.
2. Research mode must not silently edit repository source files unless the request explicitly calls for that.
3. The reviewer must independently evaluate the research quality, not merely copyedit the memo.
4. String/file input behavior must match `--execute`.
5. The first version should keep one general research contract rather than introducing memo subtypes prematurely.

# Verification Strategy

Verification should cover both prompt/rendering behavior and mode execution behavior.

Add tests covering:

- CLI parsing for `--research`, `--research-file`, and `--research-text`
- inline string input writing a run-owned request artifact
- file input resolving the expected source path
- research prompt rendering for coder and reviewer
- reviewer findings reopening the coder response loop
- accepted research run writing `RESEARCH.md` and `RESEARCH_REVIEW.md`
- blocked research run surfacing the correct artifact paths and state
- no commit / no created-commit behavior in research mode

Where possible, use injected round runners or existing adjudicator-style test seams rather than relying on live provider calls.

# Scope 1: CLI and Input Source Plumbing

Add the new top-level mode and match execute-style input semantics.

Goal:

- add `--research`, `--research-file`, and `--research-text`
- reuse or extend Neal's input-source logic for file vs inline text handling
- write inline requests to a run-owned input artifact

Verification:

- `pnpm typecheck`
- targeted CLI/input parsing tests

Success Condition:

- Neal can start a research run from either file or string input using execute-consistent semantics.

# Scope 2: Research Prompt and Schema Contract

Define the coder/reviewer research contract and artifact shape.

Goal:

- add coder prompt for research memo drafting
- add reviewer prompt for research memo evaluation
- define any structured schema needed for reviewer findings / coder responses
- pin the research memo shape in prompt tests

Verification:

- `pnpm typecheck`
- prompt render tests and schema tests

Success Condition:

- Neal has a stable research memo contract and reviewer evaluation contract that can support repo analysis plus external recommendation work.

# Scope 3: Research Run Loop and Artifacts

Wire the new mode into Neal's orchestration and artifact writing.

Goal:

- add the research phase loop
- write `RESEARCH.md` and `RESEARCH_REVIEW.md`
- allow coder/reviewer iteration until settled or blocked
- return artifact paths in the final JSON output

Verification:

- `pnpm typecheck`
- orchestrator-style tests for accepted and blocked research runs

Success Condition:

- A research run can execute end to end and produce settled memo artifacts without creating commits or touching execute-only machinery.

# Scope 4: UX and Polishing

Make the mode readable and safe to use in practice.

Goal:

- ensure diagnostics clearly indicate research mode
- make refusal and blocked messages understandable
- document the new mode in README

Verification:

- `pnpm typecheck`
- targeted tests for output/usage strings

Success Condition:

- `--research` is discoverable, understandable, and clearly distinct from `--plan` and `--execute`.

# Recommended Implementation Order

1. Land CLI/input semantics first so the mode boundary is clear.
2. Add the research prompt/reviewer contract next.
3. Then wire the run loop and artifact writing.
4. Finish with UX and docs.

# Final Notes

This feature is worth doing because it matches a repeated real workflow and fits Neal's adjudicated loop architecture well without requiring the heavier execution machinery.

Keep the first version narrow:

- one general research contract
- no subtype taxonomy
- no commits
- no execute-only completion machinery

When all scopes are complete, end with `AUTONOMY_DONE`.
