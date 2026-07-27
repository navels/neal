# Provider adapters

neal's writer-run provider layer is an internal extension point for built-in
agent SDK adapters. A provider adapter maps one SDK's sessions, tools,
structured-output behavior, errors, usage data, and stream/message events into
neal-owned contracts.

neal currently ships built-in adapters for:

- `openai-codex`
- `anthropic-claude`
- `openai-compatible`, a neal-owned agent loop for any OpenAI-compatible
  tool-calling endpoint, with writer tools for the coder and read-only tools
  for the reviewer. See
  [OpenAI-compatible provider](#openai-compatible-provider).

neal does not currently load external provider plugins or discover
npm-installed providers. Public `neal review` is a separate read-only findings
flow that uses configured provider adapters. It is not a writer-run mode and is
not a registered provider id.

`neal setup` can inspect local built-in provider runtime availability while
writing explicit writer-run defaults. That detection is intentionally local and
non-connectivity-based: it checks runtime surfaces such as the OpenAI Codex SDK
entrypoint and Claude SDK-bundled or standalone executable paths, but it does
not authenticate, send prompts, collect secrets, or verify account state. Use
`neal check` after setup for the live provider connectivity prompt.

## Contract overview

Provider contracts live in `src/neal/providers/types.ts`. A built-in provider
module should export a `NealProviderDefinition` plus any focused test hooks it
needs.

The provider definition includes:

- `id`: the provider id used in config and run state.
- `displayName`: a human-readable provider name.
- `capabilities`: role-by-role capability declarations.
- `createCoderAdapter`: optional factory for coder turns.
- `createStructuredAdvisorAdapter`: optional factory for structured-advisor
  turns.

Registered provider definitions are owned by `src/neal/providers/registry.ts`.
Config parsing, run-state hydration, adapter lookup, and writer-run capability
checks all resolve provider identity through that registry.

## Roles

neal exposes three effective agent roles for writer runs:

- `planner`: writes and revises plan artifacts through the coder adapter surface.
  It inherits the coder provider/model unless configured explicitly.
- `coder`: runs ordinary implementation turns and may receive an optional
  structured response schema.
- `reviewer`: runs schema-oriented rounds for review, plan review, support, and
  final completion review work through the structured-advisor adapter surface.

Provider capability roles remain `coder` and `structured-advisor`. `planner` is
a neal role label backed by the configured provider's coder adapter. The same
provider may support both capability roles, or only one. The checked-in config
template and first-run setup examples use `openai-codex` for the coder role and
`anthropic-claude` for the reviewer role, but fresh writer runs still require
explicit coder and reviewer provider config from `neal setup` or config files.
Final completion summary currently uses the configured coder provider through
the structured-advisor adapter, so a writer-ready coder provider must support
both coder and structured-advisor paths.

## Capabilities

Each provider capability role declares:

- whether the role is supported
- read, write, and shell tool access
- session resume support
- model override support
- neal structured control protocol support
- usage reporting support

Capabilities are enforced before writer work starts or resumes. neal requires
the planner and coder effective roles to resolve to providers with the coder
capability, write and shell access, and neal structured control protocol support.
The reviewer effective role must resolve to a provider with the
structured-advisor capability and read tool access: every reviewer inspects
the repository directly. Session resume support is required when a persisted
session handle is present.

Current built-in capabilities are intentionally conservative:

- OpenAI Codex supports coder and structured-advisor roles. The coder role is
  read, write, and shell capable because the current SDK configuration uses
  broad local access. The structured-advisor (reviewer) role is read capable
  but never write or shell capable (see
  [The read-only reviewer invariant](#the-read-only-reviewer-invariant)).
- Anthropic Claude supports coder and structured-advisor roles. The coder role
  is read, write, and shell capable. The structured-advisor (reviewer) role is
  read capable but never write or shell capable.
- OpenAI-compatible supports coder and structured-advisor roles. The coder
  role is read, write, and shell capable through neal-owned tools executed
  locally. The structured-advisor role is read capable (a read-only toolset,
  no write or shell access), so its reviewer inspects the repository directly
  with read tools. Neither role supports session resume. See
  [OpenAI-compatible provider](#openai-compatible-provider).

The `coder` capability describes adapter paths, not a global promise that every
writer-run workflow is read-only: writer-run coder turns use provider SDKs with
broad local permissions. The separate public `neal review` command enforces its
own read-only boundary in the review command flow.

### Coder tool policy enforcement

Plan-authoring rounds pass a `toolPolicy` (`allowedWritePaths` restricted to
the plan document, `allowRun: false`) to the coder adapter. Enforcement
strength is adapter-specific and mechanical where each SDK allows it:

- `openai-compatible`: full jail. The policy selects the neal-owned plan-author
  toolset: writes only to the allowlisted paths, no shell tool at all.
- `anthropic-claude`: tool exclusion plus a path callback. `allowRun: false`
  removes Bash from the turn's tools list, and a PreToolUse hook denies any
  write-class tool call whose resolved path is not allowlisted.
- `openai-codex`: sandbox downgrade only. The jailed turn's thread runs under
  the `workspace-write` sandbox instead of `danger-full-access`. The Codex SDK
  has no per-tool-call hook, so path-level confinement is not enforceable:
  shell still runs inside the sandbox and can write any workspace path, not
  just the plan document.

Rounds without a `toolPolicy` are unaffected on every adapter: ordinary coder
scope rounds keep full access because verification legitimately runs commands.

### The read-only reviewer invariant

A reviewer exists to *judge*, never to *modify* or *re-execute*. neal enforces
this structurally: every *supported* `structured-advisor` capability has
`write: false` and `shell: false`. The invariant constrains only `write` and
`shell`. `read` is not part of the invariant, but every built-in reviewer
(`openai-codex`, `anthropic-claude`, `openai-compatible`) declares read access,
and the writer-run capability check requires it.

`src/neal/providers/registry.ts` asserts this over every registered provider
definition (built-in or test-registered) at the definition-resolution
chokepoint and at test registration time, so no provider definition can ever
declare a writing or shell-running reviewer. The assertion checks only the
`write`/`shell` half. It never constrains `read`, and it never touches the
`coder` capability (coders keep `write`/`shell`).

Two consequences follow from no reviewer holding shell access:

- Reviewers never re-run tests or other verification. Verification happens once,
  performed by the coder. The reviewer trusts the coder's reported result plus
  its own reading of the diff and (for read-tool reviewers) the repository.
- Reviewers never mutate the checkout. A review produces a verdict and findings,
  not edits.

Usage reporting is `opportunistic`: providers emit usage only when the SDK
event or result supplies it.

### Review doctrine access modes

Reviewer prompts render neal's shared review doctrine in one of two access
modes, derived from the configured reviewer provider's structured-advisor
tool access:

- `read-only` (read access without shell access, which every built-in reviewer
  today): the reviewer is instructed to inspect the repository through read
  tools only (reading changed files and searching the tree) and is never
  instructed to run commands, run tests, or use scratch directories.
  Commit-range visibility depends on whether the provider exposes its own
  range-diff tool:
  - `openai-compatible` declares a read-only `git_diff` commit-range tool
    (`providesRangeDiffTool`), so its reviewer inspects the range with that tool
    and receives no inlined diff.
  - native read-only reviewers such as `openai-codex` and `anthropic-claude`
    have read and search tools but no commit-range diff tool, so neal inlines
    the commit-range diff into the reviewer prompt as the source of truth for
    what the range changed (including deletions and renames that head-state file
    reads cannot reveal), and the reviewer uses its read/search tools to verify
    the surrounding code.

  In both branches the doctrine states that absence from a diff is not evidence
  of absence from the repository: the reviewer must open files with read tools
  before claiming a missing import or declaration.
- `tool-access` (read and shell access): a reviewer is instructed to inspect
  and execute against the repository directly. Because the read-only reviewer
  invariant forbids any supported `structured-advisor` capability from holding
  shell access (see
  [The read-only reviewer invariant](#the-read-only-reviewer-invariant)), no
  built-in reviewer resolves to this mode today. It would require a
  shell-capable reviewer, which the registry assertion rejects.

Read-tool reviewers are never instructed to run verification: the doctrine
reflects that verification is the coder's, trusted by the reviewer's reading.
Write access does not affect review doctrine: reviews never instruct repository
mutation, and no supported reviewer capability declares write access in any
case.

## Runtime turns

Provider adapters receive neal-owned turn arguments rather than reading neal
configuration directly.

Plain coder turns receive:

- `cwd`
- `prompt`
- `inactivityTimeoutMs`
- optional `resumeHandle`
- optional structured `outputSchema`, retained only for raw coder prompt
  compatibility outside neal product control paths
- optional `onSessionStarted` callback
- optional provider event sink

Structured coder turns receive:

- `label`
- `cwd`
- `prompt`
- `schema`
- `inactivityTimeoutMs`
- optional `resumeHandle`
- optional `onSessionStarted` callback
- optional provider event sink

Structured-advisor turns receive:

- `label`
- `cwd`
- `prompt`
- `schema`
- `inactivityTimeoutMs`
- `apiRetryLimit`
- optional `model`
- optional `resumeHandle`
- optional provider event sink

The orchestration and round layers own timeout/retry configuration lookup,
schema validation, state transitions, review decisions, source-control policy,
and terminal narration policy. Provider adapters own SDK initialization,
message or stream collection, SDK session mapping, SDK error normalization, and
SDK telemetry mapping.

All turn argument shapes also accept an optional `signal` (`AbortSignal`).
Adapters must treat an aborted signal as a request to terminate the in-flight
SDK turn and surface a normalized provider error rather than hanging.

### Turn liveness

neal layers two independent timeouts over every provider turn:

- `neal.agent_turn_startup_timeout_ms` (default `300000`) bounds startup
  silence: the window after a turn starts during which the provider has shown
  no observable progress (no tool use, commands, file changes, assistant text,
  structured output, or usage). `session_started` and `turn_started` keep the
  transport alive but do not count as progress.
- `neal.inactivity_timeout_ms` (default `600000`) bounds active-work idle time
  and is owned by the provider adapters. Once a turn shows any observable
  progress, the startup timer disarms permanently and only this timeout
  applies.

When the startup timer fires, neal aborts the silent attempt via the turn's
`signal` and retries the same turn up to `neal.agent_turn_retry_limit` times
(default `1`). This means neal may rerun a turn even though the provider never
reported an error: the provider went silent before doing any work, which is
indistinguishable from a stalled SDK stream. Retries are safe because zero
observable progress was made. Keep `agent_turn_retry_limit` low (the default of
1 is recommended). Persistent startup silence usually indicates a provider or
network problem that more retries will not fix. Coder turns that resume an
existing session are never retried by this layer. The orchestrator's existing
fresh-session recovery owns those.

Liveness outcomes are auditable in `events.ndjson` as
`provider.turn_liveness_timeout`, `provider.turn_liveness_retry`, and
`provider.turn_liveness_give_up`. Exhausted retries fail the turn with a
normalized `no_progress_timeout` error kind, distinct from the adapter-owned
`timeout` kind that covers idle time after active work.

## Sessions

Provider session handles are opaque strings. Providers should preserve and
return the SDK session handle when one exists, including on normalized failures
where the SDK exposed a session before the failure.

neal persists handles separately for planner, coder, and reviewer work. Resume
checks fail early if the configured provider role does not support session
resume and a persisted handle must be resumed.

## Structured output

neal product control paths use `neal-json-block-v1`. Provider adapters transport
assistant text, preserve session handles, normalize SDK errors, and delegate
control-payload extraction, parsing, validation, bounded repair, telemetry, and
normalized structured-output errors to neal's shared runtime. The
`openai-compatible` adapter is the one exception: its coder and
structured-advisor paths consume the same protocol spec (schema, validator,
labels) but fulfill it through the AI SDK's native structured-output channel in
a dedicated finalization turn, with no fenced-text transport. See
[OpenAI-compatible provider](#openai-compatible-provider).

Coder adapters expose `runStructuredPrompt<TStructured>()` for neal-owned
structured coder decisions. That method receives a caller-owned
`neal-json-block-v1` protocol spec, returns the typed `structured` object plus
the provider `sessionHandle`, emits `structured_output_received` only after
neal validation succeeds, and normalizes missing structured control payloads as
`structured_output_missing`.

`runPrompt(..., outputSchema)` remains supported for compatibility with
older raw coder harness coverage. `neal check` and neal-owned coder decision
rounds use `neal-json-block-v1` through `runStructuredPrompt()` rather than
parsing provider JSON strings in round code.

neal's shared `neal-json-block-v1` runtime appends provider-neutral transport
instructions requiring optional useful prose followed by exactly one final
fenced `neal-json` JSON block. It then extracts, parses, validates, and repairs
that control object with the caller-supplied schema label, schema, validator,
and repair limit. Raw whole-response JSON objects are accepted only as a
compatibility tolerance for older mocks and pre-migration paths. The prompt
contract remains prose plus one final `neal-json` block. State-facing
`structured_output_received` telemetry is emitted only after neal validation
succeeds.

Anthropic Claude and OpenAI Codex structured coder and structured-advisor
protocol calls do not pass SDK-native `outputFormat` or `outputSchema`. Those
SDK-native surfaces are compatibility details for non-neal raw provider calls,
not the neal product protocol. Invalid or missing local JSON can recover through
a bounded repair turn. Repair turns are side-effect-free by prompt. Claude
repair turns also omit repo tools and session resume, and Codex repair turns run
through the most restrictive available streamed-turn options.

## Telemetry

Provider modules emit provider-neutral `ProviderRuntimeEvent` values through the
turn's event sink. They do not call terminal diagnostic APIs or `RunLogger`
directly.

Normalized event types include:

- `session_started`
- `turn_started`
- `turn_completed`
- `tool_started`
- `tool_progress`
- `command_completed`
- `file_changed`
- `assistant_text`
- `structured_output_received`
- `usage_reported`
- `provider_error`

`src/neal/providers/telemetry.ts` adapts those events into `provider.*`
`events.ndjson` records and low-level detail output. Command completion events
carry enough metadata for verification summaries, including command, status,
exit code, output length, working directory, and git head when available. Raw
SDK details should remain contained under `providerData` when they are useful
for debugging.

## Errors

Errors leaving provider adapters should be `NealProviderError` instances. Core
round code should not import SDK-specific provider error classes.

Normalized error kinds are:

- `timeout`
- `no_progress_timeout` (emitted by neal's turn liveness supervisor, not by
  adapters, as described under Turn liveness above)
- `api_error`
- `structured_output_missing`
- `structured_output_invalid`
- `permission_denied`
- `session_unavailable`
- `provider_failed`
- `unknown`

Each normalized error carries the provider id, role, optional session handle,
kind, retryability, and cause. Round code wraps normalized provider errors into
round-level failures only when it needs round-specific context.

## Status-visible errors

Provider failures are visible to automation through `neal status --json` and
`neal status --json --all` as `providerError`. neal derives that summary from
the latest `provider.provider_error` event when present, including timestamp,
provider id, role, label, session handle, normalized kind, bounded message, and
retryability. If a run failed before a provider event was available, status may
fall back to the latest `phase.error` as an unclassified run error with
`provider`, `role`, and `kind` set to `null`.

`providerError` is classification metadata, not a raw provider transcript. It
must not include SDK payloads, full prompts, provider `providerData`, full
assistant text, raw command output, credentials, or environment dumps. Keep rich
diagnostics in local support artifacts such as `events.ndjson` and
`stderr.log`. Public wrappers should use the bounded status summary.

## Model overrides

Provider factories receive an optional model override from `agent.*.model`.
`model: null` means neal lets the provider choose its default model. A non-null
model is accepted only when the provider role declares `supportsModelOverride`.

Model selection stays provider-local after the registry passes the configured
override into the adapter factory.

## Reasoning effort overrides

Each role accepts an optional reasoning-effort override from `agent.*.effort`.
`effort: null` (or an omitted key) means neal sends no effort option and the
provider uses its default reasoning depth. A non-null effort is mapped to the
closest provider-native option: OpenAI Codex receives
`ThreadOptions.modelReasoningEffort` and Anthropic Claude receives
`Options.effort`.

Supported values are provider-specific:

- `openai-codex`: `minimal`, `low`, `medium`, `high`, `xhigh`.
- `anthropic-claude`: `low`, `medium`, `high`, `xhigh`, `max`.
- `openai-compatible`: no supported values. Any configured `effort` is rejected
  with the standard effort config error. This is a neal limitation, not a claim
  that compatible endpoints cannot control reasoning. Some expose an effort or
  token-budget setting, but the accepted values and behavior vary by endpoint
  and model. Supporting that safely requires an endpoint-specific pass-through
  or capability contract. Until then, neal leaves reasoning at the upstream
  default.

Effort support is declared per capability role. An effort value the configured
provider does not support is rejected before a writer run starts or resumes with
a role-specific config error that lists the supported values.

Planner effort inheritance mirrors planner model inheritance: the planner
inherits the coder effort only when `agent.planner.provider` is not configured
explicitly and `agent.planner.effort` is omitted. If `agent.planner.provider`
is set explicitly, an omitted `agent.planner.effort` resolves to provider
default (`null`) rather than inheriting the coder effort, so set
`agent.planner.effort` explicitly to override it.

## OpenAI-compatible provider

The `openai-compatible` provider runs the planner, coder, and reviewer roles
against any OpenAI-compatible Chat Completions endpoint with a strong
tool-calling model (OpenRouter, vLLM, DeepSeek, and similar). The planner uses
the coder path. neal owns
the agentic loop (one model turn per request, with a neal-owned outer loop
over the message history) and supplies its own tool set (`read_file`,
`write_file`, `edit_file`, `list_dir`, `grep`, and `run`), so any endpoint
whose model can call tools reliably can serve as the coder, and, through a
read-only subset of the same tools, as the reviewer.

The adapter is implemented on the AI SDK's OpenAI-compatible chat provider.
Gateway behaviors learned from live failures are preserved through a
neal-owned response interceptor: upstream errors embedded as an `error`
object inside an HTTP 200 body keep their status-based retryability
(OpenRouter wraps upstream 429s this way), and reasoning-model responses
whose final text arrives in `message.reasoning` / `message.reasoning_content`
instead of `message.content` fall back to that text. Usage events report the
AI SDK's normalized shape (`inputTokens` / `outputTokens` / `totalTokens`
plus detail fields), with the raw response usage object preserved under
`usage.raw`.

Because endpoint quality varies, qualify an `openai-compatible` model with
[`neal compat`](compat.md) before trusting it with real work: it drives the
candidate through complete neal runs against trivial bundled fixtures and emits
a binary PASS/FAIL per (model, role). `neal check` proves only connectivity and
basic protocol. `neal compat` proves the full loop.

Role support and behavior:

- Coder-first. The coder capability role is read, write, and shell capable.
  The planner inherits the coder provider unless configured explicitly.
- Tool-capable reviewer. The structured-advisor role runs the same
  neal-owned loop over a read-only toolset (`read_file`, `list_dir`,
  `grep`, and the read-only `git_diff` commit-range inspector), so the
  reviewer inspects the repository directly under the `read-only` review
  doctrine mode (see
  [Review doctrine access modes](#review-doctrine-access-modes)). `git_diff`
  is a neal-owned fixed-argv git query (never a shell string) that gives the
  reviewer actual commit-range visibility, including deletions and renames
  that head-state file reads cannot reveal. After the read-tool loop
  completes with a zero-tool-call turn, the structured payload is requested
  in a single dedicated finalization turn that carries no tools. The same
  adapter also serves the final-completion summary gate when
  `openai-compatible` is the coder.
- No session resume (`supportsSessionResume: false` on both roles). The
  adapter never persists a provider session handle, so `neal resume` after an
  interruption or failure restarts the interrupted scope from scratch in a
  fresh session rather than resuming mid-conversation. Already-accepted
  scopes stay committed. Only the in-flight scope is redone. Top-level
  plan-refinement revision rounds likewise start a fresh planner session per
  round instead of resuming the planning conversation.
- Step caps: each coder prompt's tool loop is bounded by the exported
  `OPENAI_COMPATIBLE_MAX_STEPS` constant (currently `48` model turns per
  prompt). Structured-advisor/reviewer rounds use the smaller exported
  `OPENAI_COMPATIBLE_ADVISOR_MAX_STEPS` constant (currently `24`: reviews are
  bounded inspections, not implementations). Reaching either cap fails the
  attempt with a non-retryable `provider_failed` error naming the cap. There
  are no config knobs for the caps.
- Reviewer telemetry: advisor rounds report cumulative per-tool call and
  error counts plus a `steps` count (model turns consumed) under
  `providerData` on `turn_completed` / `usage_reported` events, so
  tool-turns-per-review is auditable from `events.ndjson` when qualifying a
  model for reviewer duty.
- No `effort` support. Any configured `effort` for this provider is rejected
  with the standard effort config error. See
  [Reasoning effort overrides](#reasoning-effort-overrides) for why.
- Structured output is SDK-native. After the tool loop's normal
  zero-tool-call completion turn, the adapter makes exactly one dedicated
  finalization turn (no tools) through the AI SDK's `Output.object`
  structured-output channel and validates the result against the protocol
  schema. There is no fenced-JSON text protocol on this provider and no
  second chance for a malformed payload: a finalization failure is a single
  non-retryable error (kind `structured_output_missing` when the model
  produced no parseable object, or `structured_output_invalid` when the
  object failed validation) with a truncated excerpt of the rejected text
  preserved under the `provider_error` event's `providerData.diagnostic`, so
  failed runs stay classifiable. Tool inputs are likewise strict: arguments
  must match the tool's schema as sent, with no coercion of stringified
  JSON. This failure taxonomy is the qualification signal for candidate
  models: a model that cannot pass `neal check` on this provider is not
  pool-eligible.
- Transient API failures (408/429/5xx, network errors, and empty
  HTTP-200 responses) are retried with bounded backoff and surfaced as
  `api_retry` progress events.

Trust level is identical to the vendor writer providers: the `run` tool
executes arbitrary shell commands in the scope working tree with no sandbox.
The path jail on file-tool arguments keeps `read_file`, `write_file`,
`edit_file`, `list_dir`, and `grep` inside the repository (including through
symlinks), but it does not contain what `run` can do. Apply the same
disposable-checkout guidance as for the other writer providers.
Structured-advisor rounds never receive `write_file`, `edit_file`, or `run`.
The read-only toolset is jailed the same way.

Model guidance: use a paid tool-calling slug for coder duty. Rate-limited
`:free` pools are not suitable as coders, and they are usually too flaky for
reviewer duty. Treat the dated [compatible-models.md](compatible-models.md)
whitelist as the current evidence for `openai-compatible` model compatibility.
It is a contract smoke test, not a skill ranking, so still trial unfamiliar
models on a disposable project before using them on real work.

### Configuration

Add a `providers.openai_compatible` block (repo `neal.yml` overrides
`~/.neal/config.yml`, matching normal config precedence) and point one or
more roles at the provider. A worked DeepSeek example:

```yaml
providers:
  openai_compatible:
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    default_model: deepseek-chat

agent:
  coder:
    provider: openai-codex
    model: null
  reviewer:
    provider: openai-compatible
    model: deepseek-chat
```

A worked OpenRouter example driving the coder through the provider:

```yaml
providers:
  openai_compatible:
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    default_model: qwen/qwen3-coder

agent:
  coder:
    provider: openai-compatible
    model: null
  reviewer:
    provider: anthropic-claude
    model: null
```

The planner inherits the coder provider unless configured explicitly, so the
OpenRouter config above routes planning through `openai-compatible` too.
Structured-advisor rounds additionally honor a neal-internal round-level model
override first.

Settings resolve config-first with environment fallbacks:

- `base_url`: `providers.openai_compatible.base_url`, else
  `OPENAI_COMPATIBLE_BASE_URL`. Required.
- `api_key_env`: `providers.openai_compatible.api_key_env`, else the default
  `OPENAI_COMPATIBLE_API_KEY`. The API key value is read from that named
  environment variable. neal never stores the key itself.
- model: the role-level `agent.<role>.model` override, else
  `providers.openai_compatible.default_model`, else `OPENAI_COMPATIBLE_MODEL`.
  One of these is required.
- `headers`: optional string-to-string map of extra HTTP headers (useful for
  OpenRouter attribution headers).
- `pricing`: an **optional override** for per-million-token rates. It is no
  longer required to get a dollar cost (see "Cost pricing" below). Set it only
  for models the vendored rate card does not key exactly, or to pin different
  rates. All three rates are required when the block is present (a partial block
  is a configuration error). Rates are in USD per one million tokens:

  ```yaml
  providers:
    openai_compatible:
      base_url: https://api.deepseek.com
      api_key_env: DEEPSEEK_API_KEY
      default_model: deepseek-chat
      pricing:
        input_per_million: 0.27
        cached_input_per_million: 0.07
        output_per_million: 1.10
  ```

#### Cost pricing

neal resolves each run's dollar cost per provider/role bucket in this order:

1. **Provider-reported cost.** The Claude adapter passes through the provider's
   own `total_cost_usd`. It always wins when present.
2. **Configured `pricing` override.** The
   `providers.openai_compatible.pricing` block above.
3. **Vendored published rate card.** The default rate source, keyed by model
   slug. neal ships a trimmed copy of LiteLLM's
   [`model_prices_and_context_window.json`](https://raw.githubusercontent.com/BerriAI/litellm/d9661222492a098555f40cb8b50014054bea5ab8/model_prices_and_context_window.json)
   (retrieved 2026-07-18), so any adapter whose resolved model slug is exactly a
   card key gets a rate-computed cost with **zero configuration**.
4. **Tokens only.** If none of the above yields pricing, the run shows token
   counts only. neal never invents dollars.

Card lookup is **exact-match only**: the resolved model slug must be an exact
card key. neal does not strip provider prefixes and does not fall back to the
basename after a `/`, so a slash-qualified slug (for example a local or gateway
slug like `local/gpt-5.5` or `azure/<deployment>`) is priced only if the card
lists that exact string. Otherwise it stays tokens-only. LiteLLM lists many
`vendor/model` keys directly, so provider-qualified slugs are still priced when
the card carries that exact key. Set an explicit `pricing` override for slugs the
card does not key exactly.

**Base-tier only.** Card cost uses each model's published base /
standard-context per-token rates only. neal does **not** apply long-context
surcharges, tiered, batch, or priority rates. A turn whose prompt crosses a
model's long-context threshold (for example GPT-5.6 Sol above 272K prompt tokens,
which upstream prices at 2× input / 1.5× output) is priced at the base tier and
is therefore an **underestimate** for that turn. Operators who need exact
long-context cost can pin explicit rates via the `pricing` override.

The `openai-codex` provider is now card-priced by its configured model (each
role is priced by the model it actually ran). There is no codex pricing config
block by design, so a codex role with no configured model (SDK default) stays
tokens-only.

The card is community-maintained list prices, and rate-computed cost is an
estimate. Rate-computed cost (from either the vendored card or a configured
override) is flagged with a footnote (`*`) in the retrospective's Provider Usage
table. The note reads "Cost estimated from published or configured rates, not
reported by the provider." That distinguishes it from cost a provider reports
directly. Cached input is billed once, at the cached rate.

`neal setup` offers `openai-compatible` for the planner, coder, and reviewer
roles and prints guidance when the base URL, API key, or model is unresolved.
`neal setup` detection reports which config keys or environment variables are
missing without making network calls.

### Live smoke check (optional)

The default test suite never requires live credentials or network access. To
verify a real endpoint end to end, set credentials and run `neal check` with
the reviewer role configured for `openai-compatible`. The `provider-check`
structured round exercises the adapter against the live endpoint:

```sh
OPENAI_COMPATIBLE_BASE_URL=https://api.deepseek.com \
OPENAI_COMPATIBLE_API_KEY=... \
OPENAI_COMPATIBLE_MODEL=deepseek-chat \
pnpm start -- check
```

### Local endpoints (Ollama, llama.cpp, vLLM)

A local server that speaks the OpenAI-compatible Chat Completions API (Ollama,
llama.cpp's `server`, vLLM, and similar) is just another endpoint for this
provider. It reuses the same `providers.openai_compatible` block documented
above, with the same config-first, environment-fallback resolution rules from
[Configuration](#configuration). Only the `base_url`, model slug, and auth
variable change.

```yaml
providers:
  openai_compatible:
    base_url: http://localhost:11434/v1
    api_key_env: OLLAMA_API_KEY # any non-empty placeholder for servers that ignore auth
    default_model: qwen3-coder:30b

agent:
  coder:
    provider: openai-codex
    model: null
  reviewer:
    provider: openai-compatible
    model: null
```

neal has no `api_key` config field: it resolves the key from the environment
variable named by `api_key_env` (default `OPENAI_COMPATIBLE_API_KEY`), and the
AI SDK requires that value to be non-empty even when the local server ignores
auth. So export a non-empty placeholder to the variable you named
(`export OLLAMA_API_KEY=ollama`) before starting a run. Use the fully qualified
local slug your server reports (Ollama tags such as `qwen3-coder:30b`), not a
bare family name.

Qualify a local model with [`neal compat`](compat.md)
(`neal compat --model <slug> --role all`) before trusting it with writer runs.
`--model` forces the candidate onto `openai-compatible`. Note the reference
caveat: `--model` defaults `--reference` to `openai-codex`, which needs a Codex
login, so a purely-local operator should pass
`--reference openai-compatible:<same-slug>` for a self-contained check, while
being aware that self-reference is a weaker qualification partner (a candidate
grading itself), so treat its PASS with more caution than a native reference
(see [compatible-models.md](compatible-models.md)).

Set realistic role expectations. Local models below the whitelist bar usually
fail the **coder** role on structured output (`structured_output` dominates the
coder-FAIL rows in [compatible-models.md](compatible-models.md)), so the config
above is the realistic starting point: keep the coder on a native provider
(`openai-codex` or `anthropic-claude`) and give the local `openai-compatible`
endpoint reviewer-only duty. That split only works if the local model calls
tools reliably: the reviewer path is tool-driven, so a chat-only model (no
tool calling) is not supported in any role.

## Adding a built-in provider

To add another built-in provider:

1. Implement a provider module under `src/neal/providers/`.
2. Export a `NealProviderDefinition`.
3. Register the definition in `src/neal/providers/registry.ts`.
4. Map SDK sessions and resume handles to opaque neal handles.
5. Map SDK stream or message events to `ProviderRuntimeEvent` values.
6. Normalize SDK errors to `NealProviderError`.
7. Add focused tests for event mapping, capabilities, neal structured control
   protocol behavior, session handles, and normalized errors.
8. Document SDK prerequisites, environment assumptions, supported roles,
   capabilities, and limitations.

Use `test/helpers/fake-provider.ts` for registry and capability tests that do
not need a real SDK. SDK adapter tests should stay focused on provider-specific
event collection, structured-output parsing, retry behavior, and error
normalization.

## SDK prerequisites

Provider documentation should state the SDK package, required credentials or
login state, model assumptions, filesystem/tool permission assumptions, and any
environment variables the SDK needs.

Current built-in writer providers run with broad local permissions:

- OpenAI Codex uses `approvalPolicy: never` and
  `sandboxMode: danger-full-access`.
- Anthropic Claude uses `permissionMode: bypassPermissions`.
- OpenAI-compatible makes HTTP API calls for model turns but executes
  neal-owned tools locally. The coder role's `run` tool executes shell
  commands with no sandbox, matching the vendor writers' trust level.
  Structured-advisor rounds execute only the read-only toolset locally.

Those settings are part of current writer-run behavior. Do not narrow or widen
them as part of provider registration unless a separate product change requires
it.

## Review boundary

Public `neal review` uses a separate read-only findings loop:

- `src/neal/review-findings/provider.ts`

The default adapter uses the configured coder provider to draft structured
findings and the configured reviewer structured-advisor adapter to adjudicate
them. The command is still not a writer-run mode: it does not create
`RUN_STATE.json`, does not mutate `.neal/current.json` or queue pointers, and
writes isolated artifacts under `.neal/reviews/<review-id>/`.

Two distinct read-only guarantees apply here, and they should not be conflated:

- The provider-capability invariant (see
  [The read-only reviewer invariant](#the-read-only-reviewer-invariant)):
  every supported `structured-advisor` capability has `write: false` and
  `shell: false`, so a writer-run reviewer/structured-advisor round cannot
  write or run shell by capability. This holds for both writer runs and
  `neal review`.
- The `neal review` command's additional artifact-boundary guard: the command
  checks protected writer state and worktree changes after provider rounds and
  fails if anything outside its review artifacts changed. This post-round guard
  is owned by the `neal review` command flow, not by a provider capability, and
  is specific to `neal review`. A writer run does not perform this artifact
  diff.

So the capability invariant guarantees reviewers never write or run shell in
any mode, while `neal review` adds its own command-level enforcement on top.
Do not treat the `neal review` artifact-boundary guard as a provider capability,
and do not assume a writer run performs that post-round artifact check.
