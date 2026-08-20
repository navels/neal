# Changelog

All notable changes to neal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
a CLI contract. While neal is pre-1.0, minor versions may include breaking
changes. See [docs/maintenance.md](docs/maintenance.md) for the versioning and
dependency-update policy.

## [Unreleased]

### Fixed

- `neal review` printed `claude --resume <id>` for every recorded session, even
  when the reviewer was `openai-codex` and the id was a Codex thread id that
  `claude --resume` cannot open. Rounds now record which provider owns each
  session, and the resume hint prints that provider's command (`codex resume
  <id>` for Codex, `claude --resume <id>` for Claude) or just the id when it
  has no command for the provider.

### Changed

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
