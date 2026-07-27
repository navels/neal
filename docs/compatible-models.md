# Compatible models

> **Last updated:** 2026-07-20 · **Reference:** `openai-codex` (gpt-5.5) · **Pool:** 90 OpenRouter models
>
> The whitelist from running [`neal compat`](compat.md) across an OpenRouter candidate
> pool. It records **compatibility, not skill**: a PASS means the model can drive
> neal's loop on the trivial bundled fixtures in that role. It says nothing about how
> well the model performs on real work. Choose among the PASSes by your own
> cost/quality needs.

## How to read this

- Scored under the **discrimination criterion** ([#49](https://github.com/navels/neal/issues/49),
  `schemaVersion: 2`): a reviewer PASSes a fixture iff it raises at least one blocking
  finding on the broken diff **and** strictly fewer on the good diff. Severity
  calibration is not graded. Earlier sweeps (2026-06-18) required zero blocking
  findings on the good diff and are not comparable.
- The pool is the 2026-06-18 pool plus every qualifying model added to OpenRouter
  since (paid, text-output chat models; no `:free` variants, no routers/aliases, no
  native-adapter providers).
- Role cells = passed/total fixtures (coder 2, reviewer 2 pairs, planner 1. The
  redundant `is-even-add-test` fixture was dropped 2026-07-20).
- **Single-run results are noisy at the margin.** Fail-only-once models were
  re-confirmed once. Results below note where a verdict flipped on re-run.
- Native adapters (`openai-codex`, `anthropic-claude`) are supported by construction
  and need no compat run.

## Compatible (44) - verified across all roles

Sorted cheapest first ($/Mtok in·out, from the live OpenRouter catalog).

| Model | Coder | Reviewer | Planner | $/Mtok | ctx | Note |
|---|---|---|---|---|---|---|
| `nex-agi/nex-n2-mini` | 2/2 | 4/4 | 1/1 | 0.02·0.10 | 262k |  |
| `nvidia/nemotron-3-nano-30b-a3b` | 2/2 | 4/4 | 1/1 | 0.05·0.20 | 262k |  |
| `google/gemma-4-26b-a4b-it` | 2/2 | 4/4 | 1/1 | 0.07·0.34 | 262k |  |
| `inclusionai/ling-2.6-1t` | 2/2 | 4/4 | 1/1 | 0.07·0.62 | 262k |  |
| `nvidia/nemotron-3-super-120b-a12b` | 2/2 | 4/4 | 1/1 | 0.08·0.40 | 1000k |  |
| `deepseek/deepseek-v4-flash` | 2/2 | 4/4 | 1/1 | 0.10·0.20 | 1049k |  |
| `qwen/qwen3.6-35b-a3b` | 2/2 | 4/4 | 1/1 | 0.14·1.00 | 262k |  |
| `kwaipilot/kat-coder-air-v2.5` | 2/2 | 4/4 | 1/1 | 0.15·0.60 | 256k |  |
| `minimax/minimax-m2.5` | 2/2 | 4/4 | 1/1 | 0.15·0.90 | 205k |  |
| `mistralai/mistral-small-2603` | 2/2 | 4/4 | 1/1 | 0.15·0.60 | 262k |  |
| `stepfun/step-3.7-flash` | 2/2 | 4/4 | 1/1 | 0.20·1.15 | 256k |  |
| `tencent/hy3` | 2/2 | 4/4 | 1/1 | 0.20·0.80 | 262k |  |
| `google/gemma-4-31b-it` | 2/2 | 4/4 | 1/1 | 0.22·0.55 | 262k |  |
| `deepseek/deepseek-chat-v3.1` | 2/2 | 4/4 | 1/1 | 0.25·0.95 | 164k |  |
| `google/gemini-3.1-flash-lite` | 2/2 | 4/4 | 1/1 | 0.25·1.50 | 1049k |  |
| `google/gemini-3.1-flash-lite-preview` | 2/2 | 4/4 | 1/1 | 0.25·1.50 | 1049k |  |
| `minimax/minimax-m2.7` | 2/2 | 4/4 | 1/1 | 0.25·1.00 | 205k | first attempt failed (protocol:3). Confirmed PASS on re-run |
| `z-ai/glm-5.2` | 2/2 | 4/4 | 1/1 | 0.26·0.81 | 1049k |  |
| `deepseek/deepseek-v3.1-terminus` | 2/2 | 4/4 | 1/1 | 0.27·1.00 | 131k |  |
| `deepseek/deepseek-v3.2` | 2/2 | 4/4 | 1/1 | 0.27·0.40 | 164k |  |
| `deepseek/deepseek-v3.2-exp` | 2/2 | 4/4 | 1/1 | 0.27·0.41 | 164k |  |
| `minimax/minimax-m2` | 2/2 | 4/4 | 1/1 | 0.30·1.20 | 205k |  |
| `qwen/qwen3.5-plus-20260420` | 2/2 | 4/4 | 1/1 | 0.30·1.80 | 1000k |  |
| `qwen/qwen3.7-plus` | 2/2 | 4/4 | 1/1 | 0.32·1.28 | 1000k |  |
| `deepseek/deepseek-v4-pro` | 2/2 | 4/4 | 1/1 | 0.43·0.87 | 1049k | first attempt failed (structured_output:1). Confirmed PASS on re-run |
| `moonshotai/kimi-k2-0905` | 2/2 | 4/4 | 1/1 | 0.60·2.50 | 262k |  |
| `moonshotai/kimi-k2-thinking` | 2/2 | 4/4 | 1/1 | 0.60·2.50 | 262k |  |
| `nvidia/nemotron-3-ultra-550b-a55b` | 2/2 | 4/4 | 1/1 | 0.60·3.60 | 1000k |  |
| `kwaipilot/kat-coder-pro-v2.5` | 2/2 | 4/4 | 1/1 | 0.74·2.96 | 256k |  |
| `moonshotai/kimi-k2.7-code` | 2/2 | 4/4 | 1/1 | 0.85·3.80 | 262k |  |
| `z-ai/glm-5` | 2/2 | 4/4 | 1/1 | 0.95·2.55 | 205k |  |
| `z-ai/glm-5.1` | 2/2 | 4/4 | 1/1 | 0.97·3.04 | 203k |  |
| `x-ai/grok-build-0.1` | 2/2 | 4/4 | 1/1 | 1.00·2.00 | 256k |  |
| `qwen/qwen3.6-max-preview` | 2/2 | 4/4 | 1/1 | 1.04·6.24 | 262k |  |
| `meta/muse-spark-1.1` | 2/2 | 4/4 | 1/1 | 1.25·4.25 | 1049k |  |
| `x-ai/grok-4.20` | 2/2 | 4/4 | 1/1 | 1.25·2.50 | 2000k |  |
| `x-ai/grok-4.3` | 2/2 | 4/4 | 1/1 | 1.25·2.50 | 1000k | first attempt failed (provider_failed:2). Confirmed PASS on re-run |
| `qwen/qwen3.7-max` | 2/2 | 4/4 | 1/1 | 1.48·4.42 | 1000k |  |
| `google/gemini-3.5-flash` | 2/2 | 4/4 | 1/1 | 1.50·9.00 | 1049k |  |
| `mistralai/mistral-medium-3-5` | 2/2 | 4/4 | 1/1 | 1.50·7.50 | 262k |  |
| `google/gemini-3.1-pro-preview-customtools` | 2/2 | 4/4 | 1/1 | 2.00·12.00 | 1049k |  |
| `x-ai/grok-4.5` | 2/2 | 4/4 | 1/1 | 2.00·6.00 | 500k |  |
| `moonshotai/kimi-k3` | 2/2 | 4/4 | 1/1 | 3.00·15.00 | 1049k | first attempt failed (provider_failed:1). Confirmed PASS on re-run |
| `sakana/fugu-ultra` | 2/2 | 4/4 | 1/1 | 5.00·30.00 | 1000k |  |

## Borderline - re-run candidates (10)

Failed one or a few cells with a non-protocol mode, or failed differently across
attempts. `provider_failed` rows are transient infrastructure. The rest are
single-run signals that may flip. Re-run before excluding.

| Model | Coder | Reviewer | Planner | Tripped on | Note |
|---|---|---|---|---|---|
| `bytedance-seed/seed-1.6` | 0/2 | 4/4 | 1/1 | coder/add-edit-verify: structured_output |  |
| `bytedance-seed/seed-1.6-flash` | 0/2 | 0/4 | 1/1 | coder/add-edit-verify: provider_failed |  |
| `bytedance-seed/seed-2.0-lite` | 0/2 | 4/4 | 1/1 | coder/add-edit-verify: structured_output | confirmed FAIL 2/2 (attempt 1 {'structured_output': 2}, attempt 2 {'structured_output': 1}) |
| `inclusionai/ling-2.6-flash` | 1/2 | 0/4 | 0/1 | coder/add-edit-verify: provider_failed |  |
| `meta-llama/llama-3.1-8b-instruct` | 0/2 | 0/4 | 0/1 | coder/add-edit-verify: provider_failed |  |
| `meta-llama/llama-4-maverick` | 1/2 | 4/4 | 1/1 | coder/add-edit-verify: block_unresolved | confirmed FAIL 2/2 (attempt 1 {'block_unresolved': 1}, attempt 2 {'structured_output': 1, 'block_unresolved': 1}) |
| `mistralai/devstral-2512` | 0/2 | 4/4 | 1/1 | coder/add-edit-verify: provider_failed | confirmed FAIL 2/2 (attempt 1 {'provider_failed': 2}, attempt 2 {'provider_failed': 1}) |
| `moonshotai/kimi-k2.5` | 1/2 | 4/4 | 1/1 | coder/sum-grep-edit: structured_output |  |
| `moonshotai/kimi-k2.6` | 2/2 | 2/4 | 1/1 | reviewer/sum-grep-edit: structured_output |  |
| `qwen/qwen3.6-flash` | 2/2 | 0/4 | 1/1 | reviewer/add-edit-verify: structured_output |  |

## Incompatible (36) - fail the provider handshake

These can't drive neal's agentic loop on OpenRouter at all (`protocol` failure on
the provider check, every role): mostly small models and ones whose OR endpoints
don't support tool use.

- `aion-labs/aion-3.0`
- `aion-labs/aion-3.0-mini`
- `amazon/nova-2-lite-v1`
- `amazon/nova-lite-v1`
- `amazon/nova-micro-v1`
- `amazon/nova-premier-v1`
- `amazon/nova-pro-v1`
- `bytedance-seed/seed-2.0-mini`
- `cohere/command-a`
- `cohere/command-r-08-2024`
- `cohere/command-r-plus-08-2024`
- `cohere/command-r7b-12-2024`
- `inclusionai/ring-2.6-1t`
- `meta-llama/llama-3.2-1b-instruct`
- `meta-llama/llama-3.2-3b-instruct`
- `meta-llama/llama-3.3-70b-instruct`
- `meta-llama/llama-4-scout`
- `microsoft/phi-4`
- `microsoft/wizardlm-2-8x22b`
- `minimax/minimax-m2-her`
- `minimax/minimax-m2.1` *(confirmed 2/2)*
- `minimax/minimax-m3` *(confirmed 2/2)*
- `mistralai/ministral-14b-2512`
- `mistralai/ministral-3b-2512`
- `mistralai/ministral-8b-2512`
- `moonshotai/kimi-k2`
- `openai/gpt-oss-120b`
- `openai/gpt-oss-20b`
- `openai/gpt-oss-safeguard-20b`
- `poolside/laguna-xs-2.1`
- `stepfun/step-3.5-flash`
- `thinkingmachines/inkling`
- `x-ai/grok-4.20-multi-agent`
- `z-ai/glm-4.7`
- `z-ai/glm-4.7-flash`
- `z-ai/glm-5-turbo`

> **`require_parameters` note:** `minimax-m2.1` and `minimax-m3` (June PASSes, now
> `protocol`, confirmed 2/2) trace to the `require_parameters: true` OpenRouter
> routing constraint (#46), which excludes backends that do not support
> `json_schema`. This is a routing/infrastructure attribution, not a model
> capability change. Re-run if OpenRouter adds a capable backend for these slugs.
> `minimax-m2.7` is intermittent under the same constraint (failed the sweep,
> passed the confirm). The same constraint also *fixed* several June `protocol`
> failures by steering routing to capable backends: `moonshotai/kimi-k2-0905`,
> `kimi-k2-thinking`, `kimi-k2.7-code`, and `mistralai/mistral-small-2603` all
> flipped to full PASS.

## Native adapters (supported, no compat run required)

| Provider id | Coder | Reviewer | Planner |
| --- | --- | --- | --- |
| `openai-codex` | supported | supported | supported |
| `anthropic-claude` | supported | supported | supported |

## Reproducing / extending

```
neal compat --model <slug> --role all --reference openai-codex --json
```

`openai-codex` (gpt-5.5) is the authoritative reference. No OpenRouter model has
validated as a drop-in reference (two tried 2026-06-18, both failed. See the
2026-06-18 revision of this file). Throttle to about three concurrent invocations
for codex capacity.

Paid slugs only, never `:free`. Re-run when a slug's backing model version changes.
