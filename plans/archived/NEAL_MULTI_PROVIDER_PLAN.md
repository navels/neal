# Neal Multi-Provider Plan

## Goal

Allow `neal` to:

1. choose which agent/provider/model acts as the coder
2. choose which agent/provider/model acts as the reviewer
3. support additional providers and models over time without rewriting the orchestration loop

This plan treats provider/model choice as a configuration problem layered under Neal's existing role model:

- coder
- reviewer
- consultant

The orchestration loop should remain role-oriented. Provider-specific SDK logic should move behind adapters.

## Current State

Today, Neal is hard-wired to two providers:

- coder: OpenAI Codex via `@openai/codex-sdk`
- reviewer/consultant: Claude via `@anthropic-ai/claude-agent-sdk`

The coupling lives primarily in [src/neal/agents.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/agents.ts):

- provider-specific SDK calls
- prompt execution
- event streaming
- timeout handling
- structured result parsing

This is fine for the current coder/reviewer pairing, but it will not scale cleanly to:

- multiple Codex models
- multiple Claude models
- alternate reviewer providers
- alternate coder providers with different thread/resume semantics

## Non-Goals

This plan does not require:

- full parity across all providers in the first step
- adding every future provider immediately
- changing Neal's core reviewed execution model
- replacing role-based orchestration with generic agent graphs

## Design Principles

1. Keep Neal role-oriented.
   Orchestration should continue to talk about coder, reviewer, and consultant roles.

2. Move provider-specific logic behind adapters.
   `orchestrator.ts` should not branch on provider names.

3. Keep Neal's protocol wrapper-owned.
   Prompt structure, structured result expectations, and phase semantics should remain Neal concepts, not provider concepts.

4. Add one proof provider at a time.
   Do not build a huge abstraction for hypothetical providers without validating it on at least one additional real provider.

5. Expect capability mismatch.
   Some providers will be easier to use as reviewers than as coders. Do not assume coder and reviewer adapters will have the same difficulty.

## Phase 1: Extract Current Providers Behind Adapters

### Objective

Move current coder and reviewer wiring behind explicit provider adapters with no behavior change yet.

### Changes

Create a provider layer, for example:

- `src/neal/providers/types.ts`
- `src/neal/providers/openai-codex.ts`
- `src/neal/providers/anthropic-claude.ts`

Define role-oriented interfaces:

```ts
type CoderTurnInput = { ... };
type CoderTurnResult = { ... };

type AdvisorRoundInput = { ... };
type AdvisorReviewResult = { ... };
type AdvisorConsultResult = { ... };

type CoderAdapter = {
  runPlanningTurn(input: CoderTurnInput): Promise<CoderTurnResult>;
  runScopeTurn(input: CoderTurnInput): Promise<CoderTurnResult>;
  runPlanResponseTurn(input: ...): Promise<...>;
  runReviewResponseTurn(input: ...): Promise<...>;
  runConsultResponseTurn(input: ...): Promise<...>;
};

type StructuredAdvisorAdapter = {
  runPlanReview(input: AdvisorRoundInput): Promise<AdvisorReviewResult>;
  runScopeReview(input: AdvisorRoundInput): Promise<AdvisorReviewResult>;
  runConsult(input: AdvisorRoundInput): Promise<AdvisorConsultResult>;
};
```

Reviewer and consultant remain separate Neal roles, but they do not need separate provider adapter categories if the same provider capability can serve both via different prompts and schemas.

### Resumability Contract

The coder adapter contract must explicitly declare how resume works.

Codex currently has native thread resume, which Neal depends on heavily. Future coder providers may not. The adapter layer should support both:

- native provider resume
- wrapper-managed virtual resume

For example:

```ts
type ResumeCapability =
  | { kind: 'native-thread' }
  | { kind: 'wrapper-managed' };
```

If a provider lacks native thread resume, the adapter must define how Neal reconstructs the next coder turn from wrapper-owned state and artifacts.

### Neutral Event Schema

Provider events must be normalized at the adapter boundary.

Neal should not keep growing provider-specific event families as the primary event taxonomy. Phase 1 should define a stable wrapper-owned event model, for example:

- `coder.assistant_text`
- `coder.command_execution`
- `coder.file_change`
- `advisor.assistant_text`
- `advisor.tool_progress`
- `advisor.notification`

### Deliverable

`orchestrator.ts` talks to adapters, not directly to provider SDKs, and the adapter boundary has explicit resume and event-shape rules.

## Phase 2: Add Explicit Role Configuration

### Objective

Make coder/reviewer/consultant selection explicit in config and persisted state now that adapters exist and their real needs are known.

### Changes

Add a persisted config shape like:

```ts
type AgentRoleConfig = {
  provider: string;
  model: string | null;
};

type AgentConfig = {
  coder: AgentRoleConfig;
  reviewer: AgentRoleConfig;
  consultant: AgentRoleConfig;
};
```

Suggested initial defaults:

```ts
{
  coder: { provider: 'openai-codex', model: null },
  reviewer: { provider: 'anthropic-claude', model: null },
  consultant: { provider: 'anthropic-claude', model: null }
}
```

### CLI / Environment Surface

Add either CLI flags, env vars, or both:

- `--coder-provider`
- `--coder-model`
- `--reviewer-provider`
- `--reviewer-model`
- `--consultant-provider`
- `--consultant-model`

Env fallback is reasonable:

- `NEAL_CODER_PROVIDER`
- `NEAL_CODER_MODEL`
- `NEAL_REVIEWER_PROVIDER`
- `NEAL_REVIEWER_MODEL`
- `NEAL_CONSULTANT_PROVIDER`
- `NEAL_CONSULTANT_MODEL`

### Deliverable

State and runtime config represent alternate role/provider/model combinations without prematurely encoding assumptions from the pre-adapter world.

## Phase 3: Keep Neal's Protocol Above the Adapter Layer

### Objective

Prevent provider-specific prompt/result drift.

### Changes

Move these concepts into a provider-neutral layer:

- prompt builders
- structured response schemas
- marker rules
- review finding schema
- consult request/response schema
- wrapper event model

Provider adapters should only translate between:

- Neal protocol
- provider SDK/API calls

### Deliverable

The provider boundary is execution-specific, not logic-specific.

## Phase 4: Configurable Model Selection for Existing Providers

### Objective

Support multiple models under current provider integrations before adding new providers.

### Changes

Implement model selection in the existing adapters:

- OpenAI coder adapter accepts configurable model
- Anthropic reviewer/consultant adapter accepts configurable model

If the underlying SDK uses defaults today, keep `null` as "provider default" and only pass model when explicitly configured.
Even when config keeps `model: null`, record the resolved provider/model in run metadata when the adapter can determine it so historical runs stay interpretable.

### Deliverable

Users can choose:

- different Codex models for coding
- different Claude models for review

without changing the orchestration loop.

## Phase 5: Add a Provider Registry

### Objective

Make provider selection pluggable.

### Changes

Add a registry, for example:

```ts
type ProviderRegistry = {
  getCoderAdapter(config: AgentRoleConfig): CoderAdapter;
  getAdvisorAdapter(config: AgentRoleConfig): StructuredAdvisorAdapter;
};
```

Resolve adapters by provider name:

- `openai-codex`
- `anthropic-claude`
- future: `google-gemini`
- future: `deepseek`

The registry should return factories or per-run instances, not implicit singletons. Thread/session lifecycle belongs to a run.

### Deliverable

Adding a provider becomes a new adapter + registry entry, not a cross-cutting orchestration change.

## Phase 6: Add One Alternate Reviewer Provider First

### Objective

Validate the abstraction on the easier role before tackling alternate coders.

### Reasoning

Advisor adapters are narrower than coder adapters:

- prompt in
- structured findings out
- stream progress
- optional repo/tool access

Coder adapters are harder because they also need:

- long-running execution
- edit/tool/file semantics
- resumability or equivalent
- marker/turn completion
- retry and timeout behavior

### Recommendation

Use the first additional provider as a reviewer/consultant, not as a coder.

### Deliverable

One real non-Claude reviewer path working end-to-end through Neal.

## Phase 7: Add Alternate Coder Providers

### Objective

Support non-Codex coding agents where they are capable enough.

### Constraints

Do not assume every provider can support the full coder contract equally well.

Coder requirements include:

- file edits in-repo
- shell/tool execution
- streamed progress
- resumability or an equivalent restart strategy
- structured completion output

This may require provider-specific compromises or a reduced capability mode.

### Deliverable

A second working coder provider, or a documented statement that some providers are reviewer-only for now.

## State And Artifact Changes

### Session State

Persist role config in `session.json`:

- `agentConfig.coder`
- `agentConfig.reviewer`
- `agentConfig.consultant`

### Run Metadata

Write selected roles/models into run metadata:

- `meta.json`
- retrospectives
- maybe review/consult markdown headers

This makes historical runs inspectable by provider/model combination.

## CLI UX

### Recommended Initial UX

Keep defaults working with no flags:

```bash
neal --execute PLAN.md
```

Allow overrides:

```bash
neal --execute PLAN.md \
  --coder-provider openai-codex \
  --coder-model gpt-5.4-codex \
  --reviewer-provider anthropic-claude \
  --reviewer-model claude-sonnet-4
```

Later, add named presets if useful:

```bash
neal --execute PLAN.md --profile codex-claude
```

Profiles should be optional sugar over explicit config, not the primary abstraction.

## Migration Strategy

### Step 1

Extract current coder and reviewer implementations into adapters with no behavior change.

### Step 2

Add role config types and persist defaults.

### Step 3

Thread role config through orchestration and logging.

### Step 4

Support model overrides for current adapters.

### Step 5

Add provider registry.

### Step 6

Add one alternate reviewer provider as proof.

### Step 7

Add alternate coder provider support where practical.

## Risks

1. Over-abstraction before a second provider exists.
   Mitigation: keep Phase 1 minimal and validate against one added reviewer quickly.

2. Provider capability mismatch.
   Mitigation: keep coder and advisor adapter contracts distinct and define resume semantics explicitly.

3. Resume/thread assumptions leaking across providers.
   Mitigation: make resumability part of the coder adapter contract, not a global assumption.

4. Event-stream inconsistency.
   Mitigation: define a neutral Neal-owned event schema in Phase 1 and normalize provider events at the adapter boundary.

## Recommendation

Build this in two waves:

1. adapter extraction + explicit resume/event contracts + role config + configurable provider models
2. one alternate reviewer provider, then later alternate coders

That gets immediate value without prematurely overcommitting the architecture.
