# Changelog

All notable changes to neal are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as
a CLI contract — and while pre-1.0, minor versions may include breaking changes.
See [docs/maintenance.md](docs/maintenance.md) for the versioning and
dependency-update policy.

## [Unreleased]

- **Breaking (pre-1.0):** renamed the repository config from `config.yml` to
  `neal.yml` to avoid colliding with an application's existing config file.
  The user config remains `~/.neal/config.yml`. There is no fallback for the
  old repository filename, so existing repository config files must be renamed.
- **Breaking:** collapsed the generic provider surface to a single
  `openai-compatible` provider. The old no-tool `openai-compatible` reviewer
  adapter is removed, `generic-agentic` is renamed to `openai-compatible`
  (same tool-calling implementation, all roles), and the capability-driven
  no-read reviewer mode is gone: every reviewer now reads the repository
  directly (Codex/Claude reviewers still receive the inlined commit-range
  diff). No aliases and no run-state migration - config that names
  `generic-agentic` must be updated.

<!--
Record each dependency-driven change here, especially agentic-SDK bumps, with a
one-line behavior note, e.g.:
- Bumped `@openai/codex-sdk` 0.137.0 -> 0.1xx.0; re-qualified with `neal compat`,
  no behavior change.
-->

- Bumped `ai` 6.0.228 -> 7.0.31 and `@ai-sdk/openai-compatible` 2.0.61 -> 3.0.12
  (major). Code adaptation: `ToolCallOptions` renamed to `ToolExecutionOptions`
  (now generic); the SDK's normalized usage object dropped the `raw` passthrough
  and top-level `reasoningTokens`/`cachedInputTokens`, so the openai-compatible
  adapter detects usage from the normalized token fields instead of `raw`. No
  change to Neal's own event or cost behavior.
- **Breaking (pre-1.0):** renamed the blocked-adjudicator to the "consultant".
  The config knob `review_stuck_arbiter_max_attempts` is now
  `consultant_max_attempts`; the persisted `RUN_STATE.json` fields
  `reviewStuckArbiterCount` and `adjudicatorAdvice` are now `consultantAttemptCount`
  and `consultantAdvice`; and the logged events `review_stuck_arbiter.*` are now
  `consultant.*`. Config files and in-flight run state that use the old names are
  not read. The general "adjudication" framework (plan, execute, and
  final-completion review) keeps its name.
- Removed the GitHub issue pipeline and its local twin: the
  `neal-issue.yml` and `example-canary.yml` workflows, `pipeline/`,
  `scripts/neal-issue-local.sh`, and `docs/issue-pipeline.md`. `neal` itself is
  unchanged; this only removes the CI automation that ran it on labeled
  issues. Also dropped the scheduled `rate-card-refresh.yml` workflow;
  `scripts/refresh-rate-card.mjs` still re-pins the vendored rate card, run
  manually. `ci.yml` now verifies on a single `.nvmrc`-pinned Node version
  instead of a 22/24/26 matrix.

## [0.2.0] - 2026-07-16

Most of this release was implemented by neal itself — via the new GitHub issue
pipeline and its local twin — with cross-model review on every scope.

### Added
- **Per-run cost accounting.** Usage buckets now carry dollar cost:
  provider-reported where the SDK supplies it (`anthropic-claude`), otherwise
  rate-computed from a vendored, checksum-pinned published rate card
  (BerriAI/litellm) by resolved model slug, with
  `providers.openai_compatible.pricing` as an explicit override — and never
  invented for unknown models. Machine-readable `RUN_METRICS*.json` summaries
  land next to each retrospective, and the retrospective Provider Usage table
  gained a cost column distinguishing provider-reported from rate-computed.
- **GitHub issue pipeline.** A maintainer labels an issue and a gated Actions
  workflow seeds a plan, runs neal unattended (Claude Opus 4.8 codes,
  GPT-5.6-sol reviews), and opens a pull request carrying the refined plan, a
  metrics-derived provenance line, and a per-provider cost ledger — or reports
  blocked/failed back on the issue with work-in-progress salvaged to a branch.
  `scripts/neal-issue-local.sh` is the subscription-billed local twin: same
  seed, same PR format, one isolated git worktree per run (parallel runs
  supported). See [docs/issue-pipeline.md](docs/issue-pipeline.md).
- **Structural pass on the orchestrator** (PR #4, executed by neal across 14
  reviewed scopes): the 11k-line orchestrator test split into area files,
  validation migrated to zod, `pnpm lint` introduced; suite grew 1288 → 1521.
- **Prompt-layer hardening** (PR #15): a render-time lint rejecting
  output-format contradictions in structured rounds, evidence-audit clauses in
  the coder and completion prompts, the blocked adjudicator registered in the
  prompt registry with fixtures and render tests, and model-calibrated
  eagerness lines tagged for migration audits.
- **Dependency automation**: tiered Renovate rules gated by a live-model CI
  smoke (per-cell majority verdict), plus `scripts/qualify-sdk.sh` to qualify
  native agentic-SDK bumps from a subscription-authenticated checkout.

### Fixed
- `openai-compatible`: no sampling `temperature` is sent (reasoning models
  reject non-default values with HTTP 400); transient HTTP 401s now get the
  bounded API-retry budget instead of terminating unattended runs (403 stays
  terminal); errors embedded in HTTP-200 bodies follow the same status table.
- `anthropic-claude`: coder tool activity now emits
  `command_completed`/`file_changed` evidence events, so reviewers see
  verification evidence from Claude coders instead of an empty ledger.
- The plan document now survives destructive worktree hygiene: `reset --hard`
  and `clean` during scope discard, parent advance, and split-plan recovery no
  longer restore a stale tracked plan over the live one mid-run.
- Git subprocess calls no longer crash on large scope diffs (`maxBuffer`
  raised well past realistic artifact sizes).

### Changed
- Bumped `@openai/codex-sdk` 0.137.0 -> 0.144.1: the 0.137 vendored Codex
  binary rejects newer reviewer models (`gpt-5.6-sol` returns "requires a newer
  version of Codex"). Qualified with the full suite (1288 tests) and a live
  planner/coder/reviewer smoke run; no adapter behavior change.

## [0.1.0] - 2026-07-12

Initial public release.

### Added
- Source-first **planner / coder / reviewer** loop over scoped plan documents,
  with crash-safe, resumable runs persisted under `.neal/`.
- Provider adapters: `openai-codex` and `anthropic-claude` (native agentic SDKs),
  plus `generic-agentic` for any OpenAI-compatible / OpenRouter model.
- **`neal compat`** — a model-compatibility harness that qualifies a model across
  the planner/coder/reviewer roles on bundled fixtures
  (see [docs/compatible-models.md](docs/compatible-models.md)).
- **Structurally read-only reviewer** role, enforced at provider registration.
- **Bounded, unattended autonomous recovery** for `review_stuck` deadlocks (a
  read-only arbiter that resolves recoverable reviewer/coder deadlocks in scope,
  and escalates genuine walls unchanged).
- Manual npm release workflow with exact-pin and packaged-content validation, and
  a live-model CI smoke for dependency bumps.
