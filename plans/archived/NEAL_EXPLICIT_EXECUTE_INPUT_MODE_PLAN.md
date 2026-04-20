## Execution Shape

executionShape: multi_scope

## Goal

Make Neal's execute input mode explicit when desired, while preserving file-path execution as the default behavior.

The intended CLI behavior after this work is:

- `neal --execute /path/to/PLAN.md` continues to mean "execute this plan file"
- `neal --execute-file /path/to/PLAN.md` provides an explicit file-mode spelling
- `neal --execute-text "<plan markdown>"` provides an explicit inline-string mode

This should remove ambiguity about whether Neal is reading a plan file or interpreting a string, without breaking the normal file-based workflow.

## Why This Matters

Right now `--execute` is file-oriented in practice, but the CLI surface does not make the input mode explicit.

That creates two problems:

- if Neal later supports inline plan text, the operator needs a clear way to say "this is a string, not a file path"
- the CLI should not rely on heuristics like "if the path exists treat it as a file, otherwise treat it as text"

The desired UX is:

- file mode remains the default and stays simple
- explicit flags exist for both file and text mode
- Neal never guesses the intended mode from argument shape

## Desired Contract

After this implementation:

1. `neal --execute <path>` continues to mean file mode.
2. `neal --execute-file <path>` is an explicit file-mode synonym.
3. `neal --execute-text <markdown>` is an explicit inline plan-text mode.
4. Neal does not infer text-vs-file mode heuristically from whether a file exists.
5. Mutually incompatible execute-input flags are rejected with a clear CLI error.
6. Help text and usage output make the default and explicit modes obvious.

## Non-Goals

This plan should not:

- change the default meaning of `--execute <arg>`
- add path-vs-text heuristics
- introduce prefixes like `file:` or `text:` inside a single execute argument
- redesign the rest of the CLI surface
- change how plan files themselves are validated or executed once loaded

## CLI Shape

The first version should support exactly these entry points:

```text
neal --execute /path/to/PLAN.md
neal --execute-file /path/to/PLAN.md
neal --execute-text "<plan markdown>"
```

Rules:

- `--execute` without an explicit mode remains file mode
- `--execute-file` and `--execute-text` are explicit alternatives
- `--execute` should not silently switch to text mode
- combinations like `--execute ... --execute-text ...` or `--execute-file ... --execute-text ...` should fail fast

If future work adds stdin support or other sources, it should do so with the same principle: explicit source selection, no guessing.

Future work may add additional explicit text-oriented sources such as `--execute-text-file` or stdin support for very large inline payloads, but that is out of scope for this implementation.

## Parsing And Loading Rules

The implementation should separate:

- argument parsing
- plan source selection
- plan loading

Preferred model:

1. CLI parsing resolves an execute input mode:
   - `file_default`
   - `file_explicit`
   - `text_explicit`
2. A small loader layer turns that mode into plan content and, when applicable, a meaningful plan-doc path.
3. Orchestration then proceeds on the resolved plan artifact without caring how the input was provided.

For text mode, Neal should materialize the inline markdown into a run-owned plan artifact on disk so the rest of the system can continue to reference a concrete plan path in state and artifacts.

That artifact should be clearly owned by Neal rather than pretending the text came from a user-managed file path.

## Artifact Semantics For Text Mode

Inline plan text should still become a concrete plan artifact before execution begins.

The first version should:

- write the provided text into a wrapper-owned plan file
- place it inside the run directory in a stable Neal-owned location such as `.neal/runs/<id>/INLINE_EXECUTE_PLAN.md`
- record that path in session state and artifacts

This keeps the rest of Neal's execution model consistent:

- plan review and execution still point at a real file
- artifacts can reference a concrete plan path
- resume behavior stays simple

The operator should be able to tell from the path or metadata that the source originated from inline text rather than a user-provided file.

## Error Behavior

Neal should fail fast and clearly for:

- missing argument after `--execute-file`
- missing argument after `--execute-text`
- empty string after `--execute-text`
- conflicting execute-input flags
- `--execute` used together with another execute-input source flag
- file mode pointing at a non-existent path

Error messages should explain both what went wrong and what the operator should do instead.

Examples:

- `--execute-text requires a non-empty inline plan string argument`
- `Choose exactly one execute input source: --execute, --execute-file, or --execute-text`
- `File mode requires an existing plan file path: ... Did you mean --execute-text?`

## Help Text And Usage

Usage and help output should make the default explicit.

The operator should be able to tell immediately that:

- bare `--execute` means file mode
- `--execute-file` is the explicit file-mode spelling
- `--execute-text` is for inline markdown

This likely requires updates to:

- usage text
- help text
- README examples if they currently imply only one execute form

## Implementation Surface

Likely implementation areas:

- [`src/neal/index.ts`](/Users/lee.nave/code/personal/codex-chunked/src/neal/index.ts)
  - CLI parsing
  - mutual-exclusion checks
  - help / usage updates
- plan-loading helpers under `src/neal/`
  - resolve file-vs-text input
  - materialize inline text into a Neal-owned plan artifact
- orchestration bootstrap under `src/neal/`
  - consume the resolved plan path without mode-specific branching
- tests
  - CLI parsing
  - conflicting-flag rejection
  - inline-text artifact creation
  - execution bootstrap using explicit text mode

If the code benefits from a dedicated helper such as `src/neal/input-source.ts`, that is preferable to embedding mode resolution directly in `index.ts`.

## Risks

1. Ambiguous flag interactions
- Adding explicit source flags can create messy precedence rules.
- Mitigation: reject conflicting combinations instead of inventing precedence.

2. Text mode leaks into file semantics
- Inline text still needs a concrete artifact path, but that should not masquerade as a user-managed file.
- Mitigation: materialize text into a run-owned Neal artifact such as `INLINE_EXECUTE_PLAN.md` and record that path clearly.

3. Help text drift
- The parser and usage docs could diverge.
- Mitigation: add tests that assert the new flags and examples appear in usage/help text.

4. Resume complexity for text mode
- If text mode does not materialize to a stable file, resume gets brittle.
- Mitigation: always persist inline text to a stable Neal-owned artifact before execution begins.

## Verification Strategy

Minimum verification:

- `pnpm typecheck`
- CLI parsing tests proving:
  - `--execute <path>` resolves to default file mode
  - `--execute-file <path>` resolves to explicit file mode
  - `--execute-text "<text>"` resolves to explicit text mode
  - `--execute-text ""` fails clearly
  - conflicting combinations fail clearly
- bootstrap tests proving:
  - file mode still uses the provided file path
  - text mode materializes a run-owned Neal plan artifact
  - execution state records the correct plan path for resume and artifacts
- help / usage tests proving:
  - the new flags appear
  - file mode is documented as the default
  - error text references the correct alternative flag names when relevant

## Execution Queue

### Scope 1: Add Explicit Execute Input Modes To CLI Parsing
- Goal: Extend the CLI so execute input mode can be expressed explicitly without changing the default file-path behavior.
- Verification: `pnpm exec tsx --test test/index.test.ts`; `pnpm typecheck`.
- Success Condition: `--execute`, `--execute-file`, and `--execute-text` are parsed deterministically, and conflicting combinations fail with clear errors.

### Scope 2: Add A Small Plan-Input Resolver And Text-Mode Artifact Materialization
- Goal: Introduce a small resolver layer that turns file or inline-text input into a concrete plan artifact path for execution, reusing the existing inline-plan materialization behavior where appropriate but moving explicit text-mode artifacts into the run directory.
- Verification: `pnpm exec tsx --test test/index.test.ts`; `pnpm exec tsx --test test/orchestrator.test.ts`; `pnpm typecheck`.
- Success Condition: File mode and text mode both resolve to a concrete plan path, and inline text is persisted into a run-owned Neal artifact suitable for normal execution and resume behavior.

### Scope 3: Update Help Text, Usage, And Coverage
- Goal: Make the new execute modes legible to operators and pin the behavior with tests.
- Verification: `pnpm exec tsx --test test/index.test.ts`; `pnpm typecheck`.
- Success Condition: CLI help and usage clearly document that `--execute` defaults to file mode and that `--execute-file` / `--execute-text` are explicit alternatives, with tests covering both the documented help output and the relevant error-path messaging.

## Acceptance Criteria

This work is complete only when all of the following are true:

1. `--execute <path>` still works as the default file-mode behavior.
2. `--execute-file <path>` and `--execute-text "<text>"` exist as explicit alternatives.
3. Neal never guesses file-vs-text mode heuristically.
4. Text mode materializes to a stable Neal-owned plan artifact.
5. Conflicting execute-input flags fail clearly.
6. Help text and tests reflect the new contract.

When all scopes are complete, end with `AUTONOMY_DONE`.
