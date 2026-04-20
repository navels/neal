# Neal Scope Unification Plan

## Goal

Simplify `neal` by treating every execution plan as scope-based.

Under this model:

- there is no conceptual distinction between `one_shot` and `chunked`
- every `neal --execute` run works through one or more scopes
- a former one-shot plan is simply a plan with exactly one scope
- a former chunked plan is a plan with multiple scopes

This removes the need for the `--chunked` flag and reduces branching in prompts, state, plan authoring, and completion handling.

## Why Change It

The current architecture still carries two overlapping ideas:

- execution loop
- execution mode

In practice, the review/response/finalize loop is already the same in both cases. The real difference is only whether the plan contains one implementation scope or several.

Keeping both modes creates avoidable complexity:

- separate prompt builders for one-shot vs chunked execution
- separate completion-marker expectations
- separate planning language for work that is operationally the same
- extra CLI surface area
- extra ambiguity in plan-writing

Treating all execution as scoped makes the model cleaner:

- one execution contract
- one progress model
- one completion model
- one plan-authoring model

## Non-Goals

This change does not introduce:

- parallel scope execution
- dynamic scope discovery by the wrapper beyond what the plan already implies
- direct Codex/Claude peer-to-peer communication
- a new planning interaction model

This is a model simplification, not a major workflow expansion.

## Product Model

After this change:

- `neal --execute PLAN.md` is the only execution entrypoint
- every execution plan is assumed to have one or more scopes
- progress is always tracked in terms of scope completion
- the wrapper always loops until:
  - the plan is complete
  - or the current scope truly blocks

The distinction becomes:

- single-scope plan
- multi-scope plan

Not:

- one-shot mode
- chunked mode

## CLI Changes

### Current

```bash
neal --execute PLAN.md
neal --execute --chunked PLAN.md
neal --plan PLAN.md
neal --resume [state-file]
```

### Target

```bash
neal --execute PLAN.md
neal --plan PLAN.md
neal --resume [state-file]
```

Changes:

- remove `--chunked`
- `neal --execute PLAN.md` always means “execute the plan scope by scope until complete or blocked”
- resume behavior remains unchanged, but resumed execution no longer cares about an execution-mode distinction

Backward compatibility:

- keep parsing `--chunked` for one transition period
- warn that it is deprecated
- ignore it once scope-unified execution is active

Then remove it entirely in a later cleanup.

## Plan Semantics

Plans should become explicit about scope shape instead of execution mode.

### Current planning language

Plans often talk about:

- one-shot
- chunked
- exactly one meaningful chunk

### Target planning language

Plans should instead describe:

- whether the plan is expected to complete in a single scope
- or whether it requires multiple scopes
- how scope selection/progression works
- what makes a scope complete

For small plans:

- the plan simply has one scope
- no special mode is needed

For campaign plans:

- the plan defines or implies repeated scope selection/progression

## Marker Contract

The current marker model is:

- `AUTONOMY_CHUNK_DONE`
- `AUTONOMY_DONE`
- `AUTONOMY_BLOCKED`

This should be simplified.

### Target marker model

Preferred target:

- `AUTONOMY_SCOPE_DONE`
- `AUTONOMY_DONE`
- `AUTONOMY_BLOCKED`

Meaning:

- `AUTONOMY_SCOPE_DONE`
  - this scope is complete, and more scopes remain
- `AUTONOMY_DONE`
  - the entire plan is complete
- `AUTONOMY_BLOCKED`
  - the current scope cannot continue safely

Transition compatibility:

- initially accept `AUTONOMY_CHUNK_DONE` as an alias for `AUTONOMY_SCOPE_DONE`
- migrate prompts and docs to the new wording
- remove the old marker later

This also means the current mode-specific marker validator should collapse to a single execution check. After unification, execution should accept one marker set for every plan:

- `AUTONOMY_SCOPE_DONE`
- `AUTONOMY_DONE`
- `AUTONOMY_BLOCKED`

with `AUTONOMY_CHUNK_DONE` treated as a temporary compatibility alias.

## State Model Changes

The current state still stores:

- `executionMode: 'one_shot' | 'chunked'`

That should be removed eventually.

### Target state model

Replace execution-mode logic with scope-oriented state:

```ts
type OrchestrationState = {
  ...
  topLevelMode: 'plan' | 'execute';
  phase: OrchestrationPhase;
  currentScopeNumber: number;
  completedScopes: ProgressScope[];
  ...
};
```

The wrapper should infer effective behavior from:

- current scope number
- completed scopes
- plan/progress artifacts
- marker returned by Codex

Not from a separate `executionMode`.

`ProgressScope.kind` should also be simplified. The current `'one_shot' | 'chunk'` distinction becomes unnecessary once every execution unit is a scope.

Preferred target:

- remove `kind` entirely

Compatibility fallback if needed:

- temporarily normalize all new entries to a single `'scope'` concept during migration

### Transition plan

Phase 1:

- keep `executionMode` in state for compatibility
- stop using it as the primary runtime branch

Phase 2:

- remove `executionMode` from prompts and CLI
- keep state hydration fallback for older sessions

Phase 3:

- remove `executionMode` from persisted state version once compatibility is no longer needed

## Prompt Changes

### Codex implementation prompt

Replace the current split:

- `buildOneShotPrompt()`
- `buildChunkedPrompt()`

With one scope-based execution prompt.

Core behavior:

- read the plan
- read the progress doc
- execute the current scope only
- do not start another scope in the same turn
- finish with one of:
  - `AUTONOMY_SCOPE_DONE`
  - `AUTONOMY_DONE`
  - `AUTONOMY_BLOCKED`

For single-scope plans:

- Codex should normally return `AUTONOMY_DONE`

For multi-scope plans:

- Codex should normally return `AUTONOMY_SCOPE_DONE` until the final scope

### Claude review prompt

No major conceptual change is required.

Claude should continue to review:

- the commit range for the current scope
- the current repository state
- prior review history if useful

### Codex response prompt

No major conceptual change is required.

The only wording change should be:

- “You are still working on the same scope”

instead of:

- “You are still working on the same chunk”

## Progress Model

The current progress model is already scope-like.

That should become the primary conceptual model everywhere:

- `PLAN_PROGRESS.md`
- `plan-progress.json`
- retrospectives
- notifications
- CLI output

Language changes:

- prefer `scope` over `chunk` in wrapper-owned artifacts
- preserve compatibility where needed during transition

Examples:

- `Scope 3 accepted`
- `Scope 4 blocked`
- `Plan complete after 1 scope`

## Orchestrator Changes

The orchestrator should no longer branch on one-shot vs chunked behavior for execution flow.

Instead:

1. start on scope 1
2. run Codex for the current scope
3. review/respond/finalize as today
4. inspect the marker
5. if marker is:
   - `AUTONOMY_SCOPE_DONE`: advance to next scope
   - `AUTONOMY_DONE`: finish the run
   - `AUTONOMY_BLOCKED`: block the run

That means:

- the current outer chunk loop becomes the default execution loop
- the old one-shot path becomes just the case where scope 1 returns `AUTONOMY_DONE`

Continuation logic should be terminal-marker-based rather than hardcoding a specific continuation marker. The cleaner rule is:

- continue when the marker is neither `AUTONOMY_DONE` nor `AUTONOMY_BLOCKED`

During compatibility:

- `AUTONOMY_SCOPE_DONE` continues
- `AUTONOMY_CHUNK_DONE` also continues

## Retrospectives And Notifications

Retrospectives and notifications should gradually adopt `scope` language.

Examples:

- `scope complete`
- `scope blocked`
- `plan implementation complete`

Transition compatibility:

- preserve existing archived filenames if necessary
- or accept mixed `chunk`/`scope` wording temporarily in artifacts

This is lower priority than unifying execution semantics.

## Planning Mode Changes

`neal --plan` should stop deciding between `one_shot` and `chunked` as explicit execution modes.

Instead, it should produce a plan that is explicit about:

- whether the work is a single scope
- or a repeated-scope campaign

The planning goal becomes:

- produce an execution plan with clear scope boundaries and completion rules

not:

- choose an execution mode flag

## Migration Strategy

### Phase 1: Compatibility Layer

- keep `--chunked` accepted but deprecated
- keep `executionMode` in state and CLI parsing
- unify runtime execution semantics around scopes
- accept both:
  - `AUTONOMY_CHUNK_DONE`
  - `AUTONOMY_SCOPE_DONE`

### Phase 2: Prompt And Doc Migration

- replace “chunk” with “scope” in prompts where it refers to the execution unit
- update README and planning docs
- update test fixtures and sandbox plans

### Phase 3: State And CLI Cleanup

- remove `--chunked`
- remove mode-specific prompt builders
- stop persisting `executionMode` in new state
- keep resume fallback for older sessions if needed

## Implementation Steps

1. Add scope-marker compatibility support:
   - accept `AUTONOMY_SCOPE_DONE`
   - treat `AUTONOMY_CHUNK_DONE` as a backward-compatible alias

2. Replace one-shot/chunked execution branching with a unified scope loop:
   - one execution path
   - same finalization path

3. Replace the two Codex execution prompt builders with one scope-based prompt.

4. Update Codex response prompts from “same chunk” to “same scope”.

5. Update progress and notification wording where it is cheap and low-risk.

6. Update `neal --plan` prompts so they produce single-scope or multi-scope plans instead of mode-tagged plans.

7. Deprecate `--chunked` in CLI parsing and help text.

8. Update README and fixtures.

9. Validate both:
   - single-scope execute run
   - multi-scope campaign run

10. Remove the old mode-specific leftovers after compatibility is proven.

## Validation Plan

Minimum validation:

1. Single-scope fixture
- `neal --execute <single-scope-plan>`
- Codex returns `AUTONOMY_DONE`
- run completes normally

2. Multi-scope fixture
- `neal --execute <campaign-plan>`
- Codex returns `AUTONOMY_SCOPE_DONE`
- wrapper advances to the next scope automatically

3. Backward compatibility
- old `AUTONOMY_CHUNK_DONE` still works during transition
- `--chunked` still parses without breaking runs
- old session files still resume

4. Planning mode
- `neal --plan` produces plans that clearly describe single-scope vs multi-scope behavior without relying on execution-mode wording

## Recommendation

This is a worthwhile cleanup.

It simplifies the core Neal model and makes the product easier to explain:

- `neal --plan` writes an executable plan
- `neal --execute` works through scopes until done or blocked

That is a stronger model than carrying both “one-shot” and “chunked” as first-class runtime modes.
