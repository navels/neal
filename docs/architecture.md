# Architecture

neal drives a plan document through a deterministic state machine with
planning and execution phases using coding agents in planner, coder, and reviewer roles.
The planning phase has the planner and reviewer revise the plan until
it has a valid execution shape, logical scopes, and a repository-grounded
implementation approach at a level a person can still review. File-level
discovery and local implementation choices stay in the execution phase.

During the execution phase, the coder implements a scope of work
with a fresh context, commits, and the reviewer checks the work. Any findings
are fed back to the coder and addressed. This coder/reviewer loop continues
until the reviewer is satisfied and execution proceeds to the next scope.
Once all scopes are complete, the coder and reviewer make a final pass to
review all the commits together. Finally, neal squashes all the work into a single commit.

Each role (planner, coder, reviewer) has its own prompt-driven behavior
and is backed by whatever provider (Anthropic, Codex, OpenRouter) and
model you choose. Run state is saved under `.neal/` so that a run can be
easily resumed without losing work in progress.

## 1. The run loop (orchestrator)

`src/neal/orchestrator.ts` drives a deterministic state machine over a plan
document. The phases live in `src/neal/orchestrator/phases/`:

- **planning:** uses its own planner/reviewer loop to refine the plan you wrote
  into a human-reviewable shape neal can execute,
  decides whether it is `one_shot`, `multi_scope`, or `multi_scope_unknown`,
  and records that choice in the plan (`plan-refinement.ts` and
  `plan-validation.ts`). See [plan-format.md](plan-format.md).
- **coder:** runs one scope with the coder role from a fresh context, then
  commits.
- **review:** hands the committed diff to the read-only reviewer. Its findings
  go back to the coder until the reviewer accepts the change.
- **recovery:** when a run gets stuck, the consultant is engaged. This is a role
  backed by the reviewer provider/model (`adjudicator/consultant.ts`):
  it can inspect the run but never change it, and it gets only a limited number
  of tries. There are three kinds of stuck:
  the coder reports it can't proceed, the coder and reviewer keep going back and
  forth without resolution, or a step that tried to break a
  scope into a smaller plan produced a plan that wasn't valid. When the fix is
  small and safe, the consultant returns a directive that neal applies, and the
  run keeps going. Otherwise the run stops and waits for you, or fails cleanly
  if it's running unattended.

After every scope is accepted, a final-completion review
(`final-completion-review.ts`) checks the whole plan, then neal squashes the run
into a clean commit.

## 2. State and persistence

Every run is crash-safe and resumable, because all state is saved under the
project-local `.neal/` directory ([storage.md](storage.md)) with atomic writes
(`atomic-write.ts`). Two files hold that state:

- **Run state** (`RUN_STATE.json`): the phase and status of a single run, with
  its invariants documented in [state-machine.md](state-machine.md).
- **Plan queue** (`plan-queue.ts`): the ordered list of scopes and which ones
  are done.

`neal resume` (`resume-decision.ts`, `resume-planner.ts`) rebuilds an interrupted
run from these files. A per-run lock (`run-lock.ts`) keeps two runs from colliding.

## 3. Providers and roles

The three roles (planner, coder, reviewer) are each bound to a provider on their
own, so you can run a different vendor or model for each one. The provider
registry (`src/neal/providers/registry.ts`) is where each provider's capabilities
are declared and enforced:

- **Native adapters:** `openai-codex` and `anthropic-claude` wrap the vendors'
  agentic SDKs, which own their own tool loop and sandbox.
- **`openai-compatible`:** a neal-owned agent loop over any OpenAI-compatible or
  OpenRouter model. File tools are jailed to the repository, while the coder's
  shell tool is unsandboxed (`providers/openai-compatible-tools.ts`).

The most important rule: the reviewer can't write, by construction. At
registration, every provider is checked (`assertStructuredAdvisorReadOnly`) to
confirm its reviewer capability declares `write: false` and `shell: false`. So a
reviewer can't change the repo, no matter what the prompt says. See
[providers.md](providers.md) and [SECURITY.md](../SECURITY.md) for the full trust
model.

## 4. Prompts and adjudication

Each role's behavior comes from versioned prompt specs (`src/neal/prompts/`,
[prompt-specs.md](prompt-specs.md)). They run through shared structured rounds
(`agents/rounds.ts`) that force the model's output to match a schema
(`agents/schemas.ts`). The full coder/reviewer loop is listed in
[adjudicator-inventory.md](adjudicator-inventory.md).

## 5. Model qualification (`neal compat`)

`neal compat` (`src/neal/commands/compat.ts`) is a self-contained harness. It
runs a candidate model through the planner, coder, and reviewer roles on small
bundled fixtures, sorts any failures into clear kinds (protocol,
structured-output, or behavior), and prints a PASS/FAIL table. It's how the
[compatible-models.md](compatible-models.md) whitelist gets made, and it also
serves as the live CI smoke test when a dependency is bumped (see
[maintenance.md](maintenance.md) and [compat.md](compat.md)).

## Where to go next

- [plan-format.md](plan-format.md): the executable plan contract
- [state-machine.md](state-machine.md): run/queue state invariants
- [providers.md](providers.md): provider adapter contract + extension checklist
- [prompt-specs.md](prompt-specs.md): prompt-spec ownership boundaries
- [storage.md](storage.md): the `.neal/` storage contract
