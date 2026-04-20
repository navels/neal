# Neal Runtime Config Standardization Plan

## Goal

Standardize the shared runtime knobs that `neal` already owns so operators configure them once under `neal.*` instead of reasoning about provider-specific YAML and env var names for normal operation.

In this repository state, the shared knobs to standardize now are:

- inactivity timeout
- adapter-level API retry limit where that retry loop already exists

Do not introduce a new top-level `runtime.*` block. The repo already uses `neal.*` in [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) for wrapper-owned settings, and this change should extend that existing block.

## Scope Model

Complete this plan in one scope.

- End with `AUTONOMY_DONE` when the full change is complete.
- End with `AUTONOMY_BLOCKED` only for a true blocker that prevents finishing the implementation and verification.
- Do not return `AUTONOMY_SCOPE_DONE`; this plan is intentionally single-scope.

## Allowed Scope

You may edit only the runtime-config implementation and adjacent operator-facing docs/config for this change:

- [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts)
- [src/neal/providers/openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts)
- [src/neal/providers/anthropic-claude.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/anthropic-claude.ts)
- [config.yml](/Users/lee.nave/code/personal/codex-chunked/config.yml)
- [README.md](/Users/lee.nave/code/personal/codex-chunked/README.md)

Do not edit unrelated runtime files such as:

- `src/neal/orchestrator.ts`
- `src/neal/state.ts`
- `src/neal/providers/registry.ts`
- `src/neal/types.ts`
- `src/notifier.ts`
- `package.json`
- `pnpm-lock.yaml`

If a typecheck failure forces a narrowly scoped mechanical fix outside the allowed files, stop and report the blocker instead of widening scope on your own.

## Current Repository State

Ground the work in the code that exists now:

- [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) already owns config loading, default values, YAML merge precedence, and env var reads.
- The top-level `neal` block already contains `phase_heartbeat_ms`, `max_review_rounds`, and `review_stuck_window`.
- Shared runtime behavior is still split across provider-specific getters:
  - `getCodexInactivityTimeoutMs()`
  - `getClaudeInactivityTimeoutMs()`
  - `getClaudeApiRetryLimit()`
  - `getClaudeMaxTurns()`
  - `getClaudeContinuationLimit()`
- [src/neal/providers/openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts) uses `getCodexInactivityTimeoutMs()` for both coder and advisor streamed turns.
- [src/neal/providers/anthropic-claude.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/anthropic-claude.ts) uses:
  - `getClaudeInactivityTimeoutMs()` in `collectClaudeResult()`
  - `getClaudeApiRetryLimit()` throughout the Anthropic retry loop
  - `getClaudeMaxTurns()` and `getClaudeContinuationLimit()` for Anthropic-only session semantics
- [config.yml](/Users/lee.nave/code/personal/codex-chunked/config.yml) still stores `inactivity_timeout_ms` under both `providers.openai-codex` and `providers.anthropic-claude`, and stores `api_retry_limit` under `providers.anthropic-claude`.
- [README.md](/Users/lee.nave/code/personal/codex-chunked/README.md) documents those provider-specific YAML keys and legacy env vars such as `CODEX_INACTIVITY_TIMEOUT_MS` and `CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS`.

## Required End State

When this plan is complete:

- `neal.inactivity_timeout_ms` is the preferred shared YAML key for streamed-turn inactivity timeouts.
- `neal.api_retry_limit` is the preferred shared YAML key for adapter-level transient API retries.
- Shared getters in [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) own those values.
- Both providers read the shared inactivity-timeout getter.
- Anthropic reads the shared API retry getter everywhere it currently retries API/transient failures.
- Anthropic-only controls remain provider-specific:
  - `providers.anthropic-claude.max_turns`
  - `providers.anthropic-claude.continuation_limit`
- Legacy provider-specific YAML keys and env vars remain as compatibility fallbacks for this slice, but the new standardized names win when both are present.
- Operator docs and the sample repo config reflect the standardized `neal.*` shape.

Do not add a fake shared abstraction for Anthropic-only concepts. `max_turns` and `continuation_limit` should remain where they are until another provider actually shares those semantics.

## Implementation

### 1. Consolidate shared runtime config in `src/neal/config.ts`

Update [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) so the shared wrapper-owned runtime knobs live under `NealConfigFile['neal']` and `DEFAULT_CONFIG.neal`.

Make these concrete changes:

- Add `inactivity_timeout_ms?: number | null` and `api_retry_limit?: number | null` to the `neal` block type.
- Add default values for those keys to `DEFAULT_CONFIG.neal` using the current effective defaults:
  - `inactivity_timeout_ms: 600_000`
  - `api_retry_limit: 10`
- Remove those defaults from provider-specific default blocks where they are no longer the preferred home:
  - remove `providers['openai-codex'].inactivity_timeout_ms`
  - remove `providers['anthropic-claude'].inactivity_timeout_ms`
  - remove `providers['anthropic-claude'].api_retry_limit`
- Keep `providers['anthropic-claude'].max_turns` and `providers['anthropic-claude'].continuation_limit`.

Replace the provider-specific shared getters with wrapper-owned getters:

- add `getInactivityTimeoutMs(cwd = process.cwd())`
- add `getApiRetryLimit(cwd = process.cwd())`
- delete `getCodexInactivityTimeoutMs()`, `getClaudeInactivityTimeoutMs()`, and `getClaudeApiRetryLimit()` from [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts); all call sites are migrated in this scope and no other consumers exist.

Retain `getClaudeMaxTurns()` and `getClaudeContinuationLimit()` because they are still Anthropic-specific.

### 2. Preserve compatibility with explicit precedence

Implement the shared getters so their precedence is explicit and stable:

1. standardized env var
2. legacy env-var aliases
3. standardized `neal.*` YAML key
4. legacy provider-specific YAML compatibility key
5. built-in default

Use these exact standardized env vars:

- `NEAL_INACTIVITY_TIMEOUT_MS`
- `NEAL_API_RETRY_LIMIT`

Use these existing env vars as compatibility aliases only:

- `CODEX_INACTIVITY_TIMEOUT_MS`
- `CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS`
- `CLAUDE_API_RETRY_LIMIT`
- `CLAUDE_REVIEW_API_RETRY_LIMIT`

Use these existing YAML keys as compatibility fallbacks only:

- `providers.openai-codex.inactivity_timeout_ms`
- `providers.anthropic-claude.inactivity_timeout_ms`
- `providers.anthropic-claude.api_retry_limit`

The standardized value must win when both a new and legacy source are present. Do not keep provider-specific precedence ahead of `neal.*`.

Within the legacy fallback tiers, keep the ordering deterministic:

- For `getInactivityTimeoutMs()`, check legacy env vars in this order:
  1. `CODEX_INACTIVITY_TIMEOUT_MS`
  2. `CLAUDE_REVIEW_INACTIVITY_TIMEOUT_MS`
- For `getInactivityTimeoutMs()`, check legacy YAML keys in this order:
  1. `providers.openai-codex.inactivity_timeout_ms`
  2. `providers.anthropic-claude.inactivity_timeout_ms`
- For `getApiRetryLimit()`, check legacy env vars in this order:
  1. `CLAUDE_API_RETRY_LIMIT`
  2. `CLAUDE_REVIEW_API_RETRY_LIMIT`
- For `getApiRetryLimit()`, there is only one legacy YAML compatibility key:
  - `providers.anthropic-claude.api_retry_limit`

If both legacy inactivity aliases are present in the same tier with different numeric values, the getter should:

- use the first value in the ordered list above
- emit a warning that both legacy aliases were set with conflicting values
- include the winning standardized replacement name `NEAL_INACTIVITY_TIMEOUT_MS` in that warning

If both a legacy env var and a legacy YAML fallback are present with different values, normal tier precedence still applies: the env var wins and the getter should still emit the relevant migration warning(s).

Add a small warning-once mechanism in [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) so using a legacy env var or legacy provider-specific YAML key emits one process-local warning to stderr telling the operator to migrate to the standardized name. Keep the warning implementation local to this file; do not add a new logging subsystem for this change.

### 3. Update provider adapters to the shared getters

Update [src/neal/providers/openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts):

- replace the import of `getCodexInactivityTimeoutMs`
- use `getInactivityTimeoutMs()` in both `consumeCodexTurn()` and `consumeCodexAdvisorTurn()`

Update [src/neal/providers/anthropic-claude.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/anthropic-claude.ts):

- replace imports of `getClaudeInactivityTimeoutMs` and `getClaudeApiRetryLimit`
- use `getInactivityTimeoutMs()` in `collectClaudeResult()`
- use `getApiRetryLimit()` everywhere the Anthropic adapter currently checks or logs retry budget
- keep `getClaudeMaxTurns()` and `getClaudeContinuationLimit()` unchanged

Do not add a new retry loop to [src/neal/providers/openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts) in this scope. The repo does not currently have a provider-level Codex API retry mechanism in that adapter, so this standardization pass should unify the config source for shared knobs without inventing unsupported runtime behavior.

### 4. Update tracked config and docs to the new preferred shape

Update [config.yml](/Users/lee.nave/code/personal/codex-chunked/config.yml) so the tracked sample config reflects the standardized runtime surface:

- add `neal.inactivity_timeout_ms: 600000`
- add `neal.api_retry_limit: 10`
- remove provider-level `inactivity_timeout_ms` entries
- remove provider-level `api_retry_limit` from `providers.anthropic-claude`
- keep `providers.anthropic-claude.max_turns` and `providers.anthropic-claude.continuation_limit`

Update [README.md](/Users/lee.nave/code/personal/codex-chunked/README.md) so it matches the implemented behavior:

- show the preferred YAML example with shared runtime knobs under `neal.*`
- explain that `providers.*` is now only for genuinely provider-specific settings in this slice
- document `NEAL_INACTIVITY_TIMEOUT_MS` and `NEAL_API_RETRY_LIMIT` as the preferred env overrides
- document the legacy env vars and provider-specific YAML keys as temporary compatibility aliases
- state clearly that the standardized names win when both old and new values are set
- keep the documented overall precedence order aligned with the existing loader behavior:
  1. CLI flags
  2. environment variables / `.env`
  3. `~/.config/neal/config.yml`
  4. repo `config.yml`
  5. built-in defaults

### 5. Make the home config the preferred YAML source

As the final implementation step in this scope, update [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) so YAML precedence is explicitly:

1. `~/.config/neal/config.yml`
2. repo `config.yml`
3. built-in defaults

The overall config precedence after this step must be:

1. CLI flags
2. environment variables / `.env`
3. `~/.config/neal/config.yml`
4. repo `config.yml`
5. built-in defaults

This is not just a documentation note. The loader should actually prefer the home config over the repo config for overlapping YAML keys.

## Verification

Run these checks after the edits:

1. `pnpm typecheck`
2. `pnpm exec tsx --eval "import { getInactivityTimeoutMs, getApiRetryLimit } from './src/neal/config.ts'; console.log(JSON.stringify({ inactivity: getInactivityTimeoutMs(), retry: getApiRetryLimit() }));"`

Then verify precedence and compatibility behavior with targeted one-off commands instead of changing extra code:

3. Run the same `tsx --eval` command with `NEAL_INACTIVITY_TIMEOUT_MS` and `NEAL_API_RETRY_LIMIT` set to non-default values and confirm the output changes.
4. Run it again with both a new env var and a legacy alias set to different values and confirm the standardized `NEAL_*` value wins.
5. Run it with both legacy inactivity env vars set to different values and confirm the getter uses `CODEX_INACTIVITY_TIMEOUT_MS`, emits a conflict warning, and points operators to `NEAL_INACTIVITY_TIMEOUT_MS`.
6. Run it against a temporary copied config file or temporary working directory setup that uses only the legacy provider-specific YAML keys and confirm the getter still resolves those fallback values while emitting a migration warning.
7. Run it against a temporary copied config file or temporary working directory setup that sets both legacy inactivity YAML keys to different values and confirm the getter uses `providers.openai-codex.inactivity_timeout_ms`, emits a conflict warning, and points operators to `NEAL_INACTIVITY_TIMEOUT_MS`.

Keep verification artifacts out of the repo. Do not commit scratch files, temporary configs, or ad hoc scripts.

## Completion Criteria

The work is complete only when all of the following are true:

- [src/neal/config.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/config.ts) exposes shared `getInactivityTimeoutMs()` and `getApiRetryLimit()` getters with the required precedence and compatibility behavior, including home-config precedence over repo-local YAML.
- [src/neal/providers/openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts) and [src/neal/providers/anthropic-claude.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/anthropic-claude.ts) consume the shared getter(s) where appropriate.
- Anthropic-only getters remain limited to `max_turns` and `continuation_limit`.
- [config.yml](/Users/lee.nave/code/personal/codex-chunked/config.yml) and [README.md](/Users/lee.nave/code/personal/codex-chunked/README.md) describe the standardized `neal.*` shape instead of the old provider-specific shape.
- `pnpm typecheck` passes.
- The targeted config-resolution checks were run and the precedence behavior matched this plan.
- The work ends with one real git commit for this scope.

## Blocker Handling

Stop and report `AUTONOMY_BLOCKED` if any of these occur:

- the standardized env-var names or compatibility policy conflict with a higher-priority repo instruction discovered during execution
- `pnpm typecheck` fails for unrelated pre-existing reasons that prevent validating this change
- implementing warning-once behavior requires widening scope beyond the allowed files
- the runtime behavior in the current provider SDKs contradicts this plan in a way that cannot be resolved inside the allowed files

If blocked, report the exact file, symbol, and conflicting behavior. Do not silently broaden scope and do not leave the config surface half-migrated.

## Future Packaging Note

This scope already makes `~/.config/neal/config.yml` the preferred YAML source. If `neal` is later distributed as a normal package (for example via `npx` or global package install) rather than primarily run from its own source repository, keep that precedence model: home config remains the primary persistent config location and repo-local `config.yml` remains an optional per-repo override.
