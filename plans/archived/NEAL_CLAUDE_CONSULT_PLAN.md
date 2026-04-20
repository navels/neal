# Neal Claude Consult Plan

## Goal

Add a bounded consultation workflow to `neal` so Codex can ask Claude for help when a chunk becomes blocked during implementation.

This is not a shift to fully peer-to-peer multi-agent execution. The wrapper remains in control, Codex remains the sole implementation agent, and Claude remains advisory plus review-oriented.

## Scope

This plan covers one narrow use case:

- Codex encounters a blocker during implementation or review-response work
- instead of immediately terminating the chunk, `neal` may route the blocker to Claude for consultation
- Codex may then continue the same chunk with Claude's advice

Out of scope for this first version:

- freeform Codex/Claude back-and-forth
- Claude-originated implementation work
- cross-chunk shared consult context
- consults during final squash
- consults during one-shot planning mode unless explicitly added later

## Design Principles

- The wrapper owns all agent coordination.
- Claude consults are structured and limited.
- Codex remains responsible for deciding what to change in the repo.
- Claude may diagnose, suggest, or narrow the problem, but should not become a second implementation agent.
- A consult should either unblock the current chunk or confirm that the blocker is real.

## User Value

This feature is meant to improve recoverability on hard chunks where:

- Codex cannot identify the cause of a failure
- Codex is unsure whether a failure is chunk-local or pre-existing
- Codex needs help narrowing a regression or verification failure
- Codex needs a second opinion before declaring the chunk blocked

The intended result is fewer premature `AUTONOMY_BLOCKED` exits.

## Proposed Workflow

In chunked execution:

1. Codex works normally on the current chunk.
2. If Codex hits a blocker, it may emit a structured blocker report instead of immediately ending the run.
3. `neal` enters a `claude_consult` phase.
4. Claude reviews the blocker report, the current repo state, and relevant run artifacts.
5. Claude returns a structured consultation response.
6. `neal` enters a `codex_consult_response` phase.
7. Codex resumes the same chunk and explicitly responds to Claude's advice:
   - follow it
   - partially follow it
   - reject it with explanation
8. Codex either:
   - continues the chunk successfully
   - remains blocked, in which case the wrapper stops

This flow should be available during:

- `codex_chunk`
- `codex_response`

It should not start a new chunk.

## New Phases

Add the following orchestration phases:

- `claude_consult`
- `codex_consult_response`

Revised phase family:

```ts
type OrchestrationPhase =
  | 'codex_plan'
  | 'claude_plan_review'
  | 'codex_plan_response'
  | 'codex_chunk'
  | 'claude_review'
  | 'codex_response'
  | 'claude_consult'
  | 'codex_consult_response'
  | 'final_squash'
  | 'done'
  | 'blocked';
```

## Triggering Rules

Claude consultation should only trigger when all of the following are true:

- Codex reports a blocker during execution or review-response
- the blocker is tied to the current chunk
- the chunk has not exceeded the consult limit
- the blocker is plausibly diagnosable from repo state or run artifacts

Do not consult Claude for:

- missing credentials
- missing user decisions
- network/service outages
- policy constraints that only the user can resolve

Those are true blockers and should terminate immediately.

## Structured Blocker Contract

Codex must not ask Claude for vague “help”.

When Codex requests consultation, it should return structured output with:

```ts
type CodexConsultRequest = {
  outcome: 'consult' | 'blocked';
  summary: string;
  blocker: string;
  question: string;
  attempts: string[];
  relevantFiles: string[];
  verificationContext: string[];
};
```

Field intent:

- `summary`: short human-readable explanation
- `blocker`: the exact blocking condition
- `question`: the concrete question for Claude
- `attempts`: what Codex already tried
- `relevantFiles`: files Claude should inspect first
- `verificationContext`: exact failing commands or artifact paths when relevant

If Codex cannot produce a concrete question, that is a signal that the blocker is probably real and should terminate.

## Structured Claude Consult Response

Claude should return structured consultation output:

```ts
type ClaudeConsultResponse = {
  summary: string;
  diagnosis: string;
  confidence: 'low' | 'medium' | 'high';
  recoverable: boolean;
  recommendations: string[];
  relevantFiles: string[];
  rationale: string;
};
```

Field intent:

- `summary`: short user-facing overview
- `diagnosis`: best explanation of what is happening
- `confidence`: rough confidence level
- `recoverable`: whether Codex should likely continue
- `recommendations`: ordered next steps for Codex
- `relevantFiles`: files to inspect or adjust
- `rationale`: why Claude believes the recommendations are sound

Claude should not propose unrelated redesigns or future cleanup unless they directly bear on the blocker.

## Codex Consult Response Contract

After Claude consults, Codex resumes the same chunk and must respond structurally:

```ts
type CodexConsultDisposition = {
  outcome: 'resumed' | 'blocked';
  summary: string;
  blocker: string;
  decision: 'followed' | 'partially_followed' | 'rejected';
  rationale: string;
};
```

This lets the wrapper track whether Claude advice was used and why the chunk still blocked if it failed.

## State Model Additions

Extend `session.json` with consult history:

```ts
type ConsultRound = {
  number: number;
  sourcePhase: 'codex_chunk' | 'codex_response';
  codexThreadId: string | null;
  claudeSessionId: string | null;
  request: CodexConsultRequest;
  response: ClaudeConsultResponse | null;
  disposition: CodexConsultDisposition | null;
};
```

Add to orchestration state:

```ts
type OrchestrationState = {
  ...
  consultRounds: ConsultRound[];
  maxConsultsPerScope: number;
};
```

Recommended default:

- `maxConsultsPerScope = 2`

## Run Artifacts

Keep consult artifacts in the current run directory under `.neal/runs/<timestamp>-<id>/`.

Recommended files:

- `CONSULT.md`
- optional later: `consult.json`

`session.json` remains authoritative.

`CONSULT.md` should be rendered by the wrapper from `session.json`, just like `REVIEW.md`.

Minimum contents:

- consult round number
- source phase
- blocker summary
- Codex attempts
- Claude diagnosis and recommendations
- Codex disposition

## Prompt Strategy

### Codex blocker prompt

When Codex reports blocked during execution:

- require the structured blocker contract
- require a concrete question for Claude
- require attempts already made
- require relevant files and verification context
- forbid generic “need help” outputs

### Claude consult prompt

Claude should be told:

- this is a blocker consultation, not a code review
- Codex is the implementation owner
- focus on diagnosis and next steps
- do not expand scope unnecessarily
- use repo inspection tools only as needed
- prefer concrete, bounded advice tied to named files and failures

### Codex consult-response prompt

Codex should be told:

- read the current consult artifact
- decide whether Claude's advice is sound
- continue the same chunk
- explicitly state whether the advice was followed and why
- only remain blocked if the blocker is still real after reasonable follow-through

## Guardrails

Use strict limits to keep the workflow understandable:

- max 2 consult cycles per chunk
- consultation only from blocker paths
- no consultation during final squash
- no consultation after a true external blocker is already identified
- no starting a new chunk from a consult response

If the consult count is exhausted:

- mark the chunk blocked
- notify normally

## Resume Semantics

Consult rounds should be resumable exactly like other phases.

`neal --resume` should be able to recover if the process dies during:

- `claude_consult`
- `codex_consult_response`

State requirements:

- persist the current phase before the agent run starts
- persist Claude session id on consult failure
- persist consult request/response/disposition as soon as available

Chunk boundaries still reset agent context. Consult continuity only applies within the current chunk.

## Logging

Add consult-specific events to `events.ndjson`:

- `consult.start`
- `consult.request`
- `consult.response`
- `consult.disposition`
- `consult.exhausted`

Include:

- scope number
- consult round number
- source phase
- Codex thread id
- Claude session id
- blocker summary
- outcome

## CLI Behavior

No new user-facing flag is required for v1.

Consultation can be enabled by default in `neal --execute` and `neal --execute --chunked` once implemented.

If later control is needed, add:

- `--no-consult`
- `--max-consults <n>`

Do not add those before there is real need.

## Validation Plan

Add a sandbox validation path that forces a recoverable blocker.

Example scenarios:

- Codex encounters a deterministic failing test with a known local fix path
- Codex encounters a migration ambiguity where the repo contains enough evidence for Claude to advise

Success criteria for validation:

1. Codex enters blocked state candidate.
2. Wrapper routes to Claude consult instead of immediately stopping.
3. Claude returns structured advice.
4. Codex resumes the same chunk and acts on the advice.
5. The chunk completes or blocks with a materially better blocker report.
6. Consult history is visible in run artifacts.

## Implementation Phases

### Phase A: Plumbing

1. Add consult phases to the orchestration state machine.
2. Add consult types to `types.ts`.
3. Add consult persistence to `state.ts`.
4. Add consult artifact rendering.
5. Add consult logging events.

### Phase B: Agent Contracts

1. Add structured Codex blocker output for consultable blockers.
2. Add Claude consult round adapter.
3. Add Codex consult-response round adapter.
4. Persist Claude consult session ids just like review session ids.

### Phase C: Orchestration

1. Route eligible Codex blockers into `claude_consult`.
2. Route successful consults into `codex_consult_response`.
3. Enforce consult limits.
4. Fall back to normal blocked behavior when consult is exhausted or not applicable.

### Phase D: Validation

1. Add sandbox fixture for a recoverable blocker.
2. Run end-to-end validation.
3. Tune prompts only after observing real consult behavior.

## Risks

- Codex may ask bad or underspecified questions.
- Claude may produce overly broad advice.
- Consult loops may mask true blockers if limits are too loose.
- The system may become harder to debug if consult artifacts are not rendered clearly.

These risks are why v1 should stay blocker-only and bounded.

## Success Criteria

This feature is successful when:

- Codex can request Claude consultation only for structured blocker cases
- Claude returns actionable, repo-grounded advice
- Codex can use that advice to continue the same chunk
- true blockers still terminate cleanly
- consult history is visible in the run artifacts and state
- the wrapper remains deterministic and comprehensible
