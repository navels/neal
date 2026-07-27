# AGENTS.md

Instructions for AI coding agents working in this repository. Human
contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

neal is a TypeScript CLI: a plan-driven, multi-agent coding loop with
separate planner/coder/reviewer roles. Read
[docs/architecture.md](docs/architecture.md) first for the run loop, state
model, and provider registry. The plan format, state machine, and prompt
contracts are all explicit and documented under `docs/` — don't infer
behavior from folder structure or naming alone.

## Setup and verification

```bash
corepack enable && corepack prepare pnpm@11 --activate && pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm run verify:package
```

Run all five before calling anything done. `pnpm test` runs
`NEAL_NOTIFY_BIN= node --import tsx --test test/*.test.ts`; the suite needs
no live credentials or network access, and it must stay that way.

## Gotchas that will silently break things

- **Two `typescript` installs, on purpose.** `typescript-7` (an alias for
  `typescript@^7`) drives `pnpm build`/`pnpm typecheck`; the plain
  `typescript` dependency stays pinned at `^6` because `typescript-eslint`'s
  parser crashes on TypeScript 7's package (no classic compiler API). Don't
  "fix" this by unifying them. See `docs/maintenance.md`.
- **Prompt builders are byte-pinned.** Editing a file listed in
  `MATRIX_BUILDER_MODULES` (`test/prompt-render-integrity.test.ts`) changes
  its SHA fingerprint. If the change alters rendered prompt output, bump the
  affected `PromptSpec.version` in `src/neal/prompts/specs.ts`, append a new
  golden under `test/fixtures/prompts/render-integrity/`, and re-pin both the
  render SHA and the module SHA — never overwrite an existing versioned
  golden. If the live rendered output remains byte-identical, just re-pin the
  module SHA. Either way, run the focused test before opening a PR:

  ```bash
  NEAL_NOTIFY_BIN= node --import tsx --test test/prompt-render-integrity.test.ts
  ```
- **"Consultant" and "adjudication" are different things.** The consultant
  (`src/neal/adjudicator/consultant.ts`) is the read-only role that triages a
  stuck run. The general adjudication framework (`src/neal/adjudicator/`,
  `ADJUDICATION_SPECS`) covers ordinary plan/execute/final-completion review
  and keeps the word "adjudication" — don't rename it to match the
  consultant, and don't call the consultant an "adjudicator" in user- or
  LLM-facing text.
- **`generic-agentic` no longer exists.** It was collapsed into
  `openai-compatible` (see the CHANGELOG's Unreleased entry). If you see
  `generic-agentic` in a diff, doc, or your own suggestion, it's stale.
- **Native SDK bumps need live qualification, not just green CI.**
  `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk` can't be exercised
  in CI (no subscription auth there). Qualify with
  `scripts/qualify-sdk.sh <pr-number>` from a checkout with authenticated
  Claude/Codex CLIs before merging. See `docs/maintenance.md`.

## Conventions

- CHANGELOG: add new entries under `## [Unreleased]`; never edit historical
  version entries, even ones using now-renamed terms.
- Match existing style: strict TypeScript, ES modules, 2-space indent,
  single quotes, semicolons, descriptive `camelCase`, `SCREAMING_SNAKE_CASE`
  for fixed protocol-marker constants. No formatter is configured — match
  the surrounding file.
- Prefer the smallest complete change. Broad product-direction changes (new
  CLI surface, config knobs, provider policy, persisted-state shape, resume
  semantics, prompt contracts) need discussion first — see CONTRIBUTING.md's
  Change Scope section.

## Canonical docs

- [docs/architecture.md](docs/architecture.md) — start here
- [docs/plan-format.md](docs/plan-format.md) — executable plan contract
- [docs/state-machine.md](docs/state-machine.md) — run/queue state invariants
- [docs/providers.md](docs/providers.md) — provider adapter contract
- [docs/prompt-specs.md](docs/prompt-specs.md) — prompt-spec ownership and
  the render-integrity contract in full
- [CONTRIBUTING.md](CONTRIBUTING.md) — human-contributor setup, PR
  expectations, and code style
