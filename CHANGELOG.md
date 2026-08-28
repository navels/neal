# Changelog

All notable changes to neal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
a CLI contract. While neal is pre-1.0, minor versions may include breaking
changes. See [docs/maintenance.md](docs/maintenance.md) for the versioning and
dependency-update policy.

## [Unreleased]

### Added

- Operator guidance during a block can revise a later scope. When a
  `neal resume --message` directive calls for changing a scope after the current
  one, the coder rewrites that scope and neal validates and writes it into the
  plan, so the decision lands where the later scope runs against it instead of in
  a side note. The coder never revises the current or an earlier scope, and a
  consultant-injected directive can't trigger it.
- `neal.review_level` (`strict | moderate | lenient`, default `moderate`) sets
  how strict the scope and final-completion reviewers are about what rises to
  a blocking finding. Under every level a blocking finding must be reachable
  under the assumed trust boundaries, and `~/.neal/guidance/reviewer.md` can
  widen or narrow those boundaries or demote and promote finding categories
  without turning off the reachability filter, the adversarial stance, or
  blocking on reachable correctness failures. Blank means unset; any other
  unknown value fails `neal check`, fresh writer commands, and a `neal resume`
  that is about to resume writer work, before any run state is touched or an
  agent turn starts.
  The `scope_reviewer` and `completion_reviewer` prompt-spec versions bumped.

### Fixed

- A blocked run that exhausted the recovery turn cap and was then given a
  terminal directive resolving to `terminal_block` no longer fails to save. The
  terminal directive records one resolution turn past the cap, and the state
  invariant now allows that single extra turn (#37).
- `neal review` no longer fails with `ENOTDIR` when the runs directory holds a
  stray file such as macOS `.DS_Store`. Its read-only state check now looks at
  run directories only.

## [0.6.0] - 2026-08-25

### Fixed

- Final-completion review could exceed the reviewer provider's input limit
  because the completion packet embedded the run's whole verification-command
  history in both completion prompts, and `neal resume` rebuilt the same
  oversized prompt and failed the same way (#28).

### Changed

- The completion packet now carries a small verification tally (pass/fail/unknown
  counts plus the last 10 failing commands) and points at `events.ndjson` for the
  full record, instead of embedding every command (#28).
- Prompt inputs that grow with run length — operator guidance, agent-authored
  free text, changed-file lists, commit subjects, diff stats, and completed-scope
  history — are capped when the prompt is built, with a visible truncation marker
  (#28).
- A provider can declare a hard input limit (Codex is 1,048,576 characters). neal
  checks the prompt against it before the call and fails fast with a non-retryable
  `input_too_large` error that names the three largest sections. Codex's own
  over-limit rejection maps to the same error (#28).
- `neal status` explains an input-size failure and tells you to trim the named
  input and resume, rather than just saying to resume. Resume still runs and
  re-measures the prompt each time, so it works once the input is smaller (#28).
  See [docs/prompt-specs.md](docs/prompt-specs.md) for the prompt-size contract.
- Raised the default `final_completion_continue_execution_max` from 2 to 3, so
  the final-completion reviewer gets one more round to send the coder back
  before a run blocks for the operator.
- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.239` to `0.3.240`.
  Re-qualified the native adapter with `neal compat`; no behavior change.

## [0.5.1] - 2026-08-24

### Changed

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.238` to `0.3.239`. Re-qualified the native adapter with `neal compat`; no behavior change.

## [0.5.0] - 2026-08-24

### Changed

- Updated `ai` from `7.0.65` to `7.0.73` and `@ai-sdk/openai-compatible` from
  `3.0.30` to `3.0.34`.

### Removed

- Removed unattended mode: the `--unattended` flag on `neal plan` /
  `neal execute` / `neal run`, the `agent.unattended` config key, the
  unattended prompt variants, and the persisted `unattended` /
  `unattendedAutoResumeCount` run-state fields (#22). There is exactly one
  block-recovery story: every operator stop lands in a controlled,
  operator-actionable state and the writer exits `2`. Interactive-recovery
  and top-level plan-review blocks accept `neal resume --message`; a blocked
  final-completion review stays blocked for status/artifact inspection.
  Migration: drop `--unattended` from scripts and `agent.unattended` from
  config, and have harnesses that need a hard verdict treat an exit-2 operator
  stop as a failure themselves (`neal compat` already does).

## [0.4.3] - 2026-08-24

### Changed

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.237` to `0.3.238` and `@openai/codex-sdk` from `0.148.0` to `0.149.0`. Re-qualified both native adapters with `neal compat`; no behavior change.

## [0.4.2] - 2026-08-23

### Changed

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.235` to `0.3.237`.
  Re-qualified the native adapter with `neal compat`; no behavior change.

## [0.4.1] - 2026-08-21

### Changed

- Updated `@openai/codex-sdk` from `0.147.0` to `0.148.0` and
  `@anthropic-ai/claude-agent-sdk` from `0.3.234` to `0.3.235`. Re-qualified
  both native adapters with `neal compat`; no behavior change.

## [0.4.0] - 2026-08-20

### Changed

- Updated `@anthropic-ai/claude-agent-sdk` from `0.3.227` to `0.3.234`.
  Re-qualified the native adapter with `neal compat`; no behavior change.
- Updated `ai` from `7.0.58` to `7.0.65` and `@ai-sdk/openai-compatible` from
  `3.0.27` to `3.0.30`.
- Anthropic Claude structured-advisor (reviewer) and repair turns now set
  `strictMcpConfig`, so MCP servers from the operator's user settings, plugins,
  and project `.mcp.json` no longer load into the read-only reviewer session.
  The `tools` allowlist never covered them, and they often include tools that
  write.
- `docs/providers.md` now states what the read-only reviewer invariant does and
  does not enforce per provider, that the reviewer shares the coder's checkout,
  and that the `neal review` draft round runs on the coder capability with
  read-only as a prompt instruction plus after-the-fact detection.
- `neal review` draft and reviewer prompts now require plain-language wording
  in the summary, findings, warnings, and accepted `finalMarkdown`: short
  sentences, everyday words, no undefined shorthand, with exact paths,
  identifiers, numbers, and SHAs preserved. The reviewer treats wording that
  breaks those rules as a revise reason.
- The scope reviewer now sees earlier accepted scopes' per-file diffs for any
  file the current scope diff touches again, under "Earlier-scope changes to
  files in this diff", and its doctrine says that weakening or removing a
  test, assertion, or check an earlier scope introduced is a blocking finding
  unless the plan calls for it. The reviewer continuity packet also lists each
  completed scope's changed files. Before this, the reviewer's only record of
  an earlier scope was the coder's summary, so a later scope could meet its own
  criteria by undoing an earlier one without the reviewer noticing. `scope_reviewer`
  prompt spec bumped to version 3. (#10)

### Fixed

- Structured-JSON repair could not recover a payload that was already valid.
  When a response had two `neal-json` blocks, the repair prompt got no JSON at
  all; the original response was cut at 12,000 chars, which truncated a
  nine-finding review payload mid-object; and a repair that answered with one
  ```json fence was rejected for the fence label alone. The repair prompt now
  receives the first block's JSON, the original-response bound is 60,000 chars,
  and a lone fenced JSON object is accepted with the same tolerance as a raw
  JSON object. (#11)
- `neal review` printed `claude --resume <id>` for every recorded session, even
  when the reviewer was `openai-codex` and the id was a Codex thread id that
  `claude --resume` cannot open. Rounds now record which provider owns each
  session, and the resume hint prints that provider's command (`codex resume
  <id>` for Codex, `claude --resume <id>` for Claude) or just the id when it
  has no command for the provider.

## [0.3.3] - 2026-08-14

### Changed

- Updated `@openai/codex-sdk` from `0.146.0` to `0.147.0` and
  `@anthropic-ai/claude-agent-sdk` from `0.3.220` to `0.3.227`. Re-qualified
  both native adapters with `neal compat`; no behavior change.
- Updated `ai` from `7.0.31` to `7.0.58` and `@ai-sdk/openai-compatible` from
  `3.0.12` to `3.0.27`.

## [0.3.2] - 2026-08-04

### Changed

- Updated `@openai/codex-sdk` from `0.145.0` to `0.146.0` and
  `@anthropic-ai/claude-agent-sdk` from `0.3.218` to `0.3.220`. Re-qualified
  both native adapters with `neal compat`; no behavior change.

## [0.3.1] - 2026-07-27

Initial release from the reset public repository.
