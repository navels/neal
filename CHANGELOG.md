# Changelog

All notable changes to neal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
a CLI contract. While neal is pre-1.0, minor versions may include breaking
changes. See [docs/maintenance.md](docs/maintenance.md) for the versioning and
dependency-update policy.

## [Unreleased]

### Changed

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
