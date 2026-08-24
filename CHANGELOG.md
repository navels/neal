# Changelog

All notable changes to neal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
a CLI contract. While neal is pre-1.0, minor versions may include breaking
changes. See [docs/maintenance.md](docs/maintenance.md) for the versioning and
dependency-update policy.

## [Unreleased]

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
