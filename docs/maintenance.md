# Maintenance: dependencies and versioning

neal's behavior comes largely from the agent SDKs it drives, so dependency
updates need real attention, not routine hygiene. Here's the policy.

## Dependency buckets

Grouped so at most a handful of dependency PRs are ever open at once:

| Bucket | Contents | Cadence | Update posture |
| --- | --- | --- | --- |
| **Weekly non-major** | everything except the native SDKs (minor/patch/pin/digest) | weekly, one grouped PR | auto-merge after CI and the live smoke pass, subject to a 3-day soak |
| **Native SDKs** | `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk`, both exact-pinned. `ai`, `@ai-sdk/openai-compatible`, and `zod` also stay exact-pinned. | one grouped PR, opened after the 3-day soak instead of waiting for the weekly schedule | qualify on a subscription-authenticated machine with `scripts/qualify-sdk.sh`. Never auto-merge. Skip the CI smoke because it does not exercise the native adapters. |
| **Library majors** | every npm major except the native SDKs (`typescript`, `@types/node`, `ai`, `@ai-sdk/openai-compatible`, `zod`, etc.) | monthly, one grouped PR | review manually because some need code changes |
| **GitHub Actions majors** | `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, etc. | monthly, one grouped PR separate from library majors | review and merge on green CI. Do not auto-merge because a major action bump can still change behavior. |

The native-SDK split exists because an agentic-SDK bump can change
tool-calling, structured output, or sandbox behavior. That breaks neal's loop
**without** breaking compilation. And CI can't behaviorally exercise the
native adapters: their auth is subscription-based and lives only on a
maintainer's machine. Everything else is behaviorally exercised in CI: the
live smoke runs on every package.json/lockfile PR, so the weekly grouped PR
is gated on it as a whole.

## The update flow

1. **Detect.** [Renovate](../renovate.json) opens grouped PRs: the weekly
   non-major bucket, the native-SDK bucket (labelled `agentic-sdk` +
   `needs-qualification`), and, monthly, separate library-majors and
   GitHub-Actions-majors buckets (both labelled `needs-review`).
2. **Verify (automatic).** CI (`.github/workflows/ci.yml`) runs typecheck + lint
   + unit tests + package verification on Node 24.18.0, which catches
   **API-shape / contract** breaks. The live smoke
   (`.github/workflows/smoke.yml`) runs on every package.json / lockfile PR: a
   real `neal compat` run against a cheap OpenRouter model through
   `openai-compatible`, catching **behavioral** breaks in the AI-SDK tier. The
   weekly non-major PR auto-merges when both are green.
   **The smoke requires the `OPENROUTER_API_KEY` repo secret.** Without it
   the smoke skips (green) and the AI-SDK auto-merge gate is compile-only.
3. **Verify (behavioral, native tier).** `@openai/codex-sdk` and
   `@anthropic-ai/claude-agent-sdk` can't be smoked in CI, so qualify them
   from any checkout with authenticated Claude/Codex CLIs:
   ```
   scripts/qualify-sdk.sh <pr-number>
   ```
   It runs the full suite plus a live `neal compat --role all` pass-through on
   every bumped adapter in the PR (in a throwaway worktree, with roles and
   models pinned explicitly so nothing leaks from `~/.neal/config.yml`), posts
   the compat matrices to the PR, and approves on PASS, leaving the PR open
   for the release script.
4. **Adopt.** Run `scripts/release-sdk-bump.sh <pr-number>`: it merges the PR,
   opens and merges the release-preparation PR (version bump + changelog), and
   runs the Publish workflow through the npm 2FA approval. See
   [docs/release.md](release.md). Urgent bumps (a fix neal needs immediately)
   may skip the Renovate soak with a manual PR. Qualify them the same way.

## TypeScript 6 and 7 side by side

`package.json` carries two TypeScript copies on purpose:

| Dependency | Version | Used by |
| --- | --- | --- |
| `typescript` | `^6.0.3` | typescript-eslint's parser, via `pnpm lint` |
| `typescript-7` (alias of `typescript`) | `^7.0.2` | `pnpm typecheck` and `pnpm build` |

TypeScript 7 ships no JavaScript API. Its `typescript` entry point exports only
`version` and `versionMajorMinor`, so anything that calls `require('typescript')`
expecting the classic compiler API breaks. typescript-eslint's parser is built on
that API and crashes on load
([typescript-eslint#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518),
tracked in [#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).

Microsoft [documented running the two side by side](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)
for exactly this reason, and expects TypeScript 7.1 to ship the replacement API.
Lint stays on 6, the compiler is 7, and there's no syntax divergence to worry
about because 7.0 is a port of 6.x semantics rather than a new language version.

**When TypeScript 7.1 lands with an API and typescript-eslint supports it:** drop
`typescript-7`, move `typescript` to `^7`, and point `build` / `typecheck` back at
plain `tsc`.

## Versioning

SemVer, treated as a **CLI/application** contract:

- **MAJOR.** Breaking CLI/behavior: a command or flag removed, a plan-format or
  config break, a provider-contract change users depend on.
- **MINOR.** New backward-compatible surface: a new command, flag, or provider.
- **PATCH.** Bug fixes, no new surface.

Mapping a dependency bump to neal's version:

- Invisible to users (pin hygiene, internal) → **patch**.
- Adds a capability neal now exposes → **minor**.
- Changes observable behavior in a breaking way → **major** (or minor pre-1.0).

**Pre-1.0:** while on `0.x`, minor may break (the honest "still evolving"
contract). Move to **`1.0.0`** deliberately, once the CLI surface, plan format,
and provider contracts are stable enough to promise compatibility, not before.

## Changelog discipline

Every release updates [CHANGELOG.md](../CHANGELOG.md) (Keep a Changelog format).
Agentic-SDK bumps get an explicit line with the from→to versions and a one-line
behavior note ("re-qualified with `neal compat`, no behavior change", or the
specific change observed). The dependency churn *is* the risk surface, so it is
recorded, not buried.
