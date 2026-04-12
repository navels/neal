# Forge One-Shot Validation Plan

Use this plan to validate `forge` in default one-shot mode inside this repository without touching the real CLI implementation.

Run it with:

```bash
forge --execute notes/testing/FORGE_ONE_SHOT_PLAN.md
```

## Goal

Complete this small plan end-to-end in a single implementation scope:

1. Add a `buildReviewHeadline()` helper in `src/testing-fixture/review.ts`.
2. Export the helper from `src/testing-fixture/index.ts`.
3. Add a short usage example to `notes/testing/SANDBOX_USAGE.md`.

## Allowed Scope

Stay inside these paths:

- `src/testing-fixture/**`
- `notes/testing/**`

Do not edit:

- `src/index.ts`
- `src/notifier.ts`
- `src/codex-claude-chunked/**`
- `package.json`
- `pnpm-lock.yaml`
- `README.md`
- `AGENTS.md`

## Implementation Rules

1. Read this plan before changing code.
2. Keep the implementation small, deterministic, and easy to review.
3. Use a commit message that starts with `test-fixture:`.
4. Do not leave partial work behind. Finish the full plan or report a true blocker.

## Verification

Run `pnpm typecheck` before committing.

## Completion Criteria

- `buildReviewHeadline()` exists and is exported.
- `notes/testing/SANDBOX_USAGE.md` includes a short example that uses the new helper.
- `pnpm typecheck` passes.
- The work ends with a real git commit.
- End with `AUTONOMY_DONE` when complete, or `AUTONOMY_BLOCKED` if truly blocked.
