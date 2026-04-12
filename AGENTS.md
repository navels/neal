# Repository Guidelines

## Project Structure & Module Organization

This repository is a small TypeScript CLI package. Source lives in `src/`, with the entrypoint at `src/index.ts` and local notification logic in `src/notifier.ts`. Compiled output goes to `dist/` and should be treated as generated build output. Root config is minimal: `package.json`, `tsconfig.json`, and `pnpm-workspace.yaml`.

Keep new runtime code under `src/`. If the tool grows, prefer splitting `src/index.ts` into focused modules such as `src/cli/`, `src/codex/`, or `src/notifications/`.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies.
- `pnpm start -- /path/to/PLAN.md`: run the CLI directly from TypeScript via `tsx`.
- `pnpm build`: compile `src/**/*.ts` into `dist/` and refresh the globally linked `codex-chunked` binary.
- `pnpm typecheck`: run `tsc --noEmit` for strict static checks.

Run the tool from the target repository when validating end-to-end behavior, as described in [`README.md`](/Users/lee.nave/code/personal/codex-chunked/README.md).

## Coding Style & Naming Conventions

Use TypeScript with strict typing and ES module syntax. Match the existing file style in [`src/index.ts`](/Users/lee.nave/code/personal/codex-chunked/src/index.ts): 2-space indentation, single quotes, semicolons, and descriptive `camelCase` function names. Keep top-level constants in `SCREAMING_SNAKE_CASE` when they represent fixed protocol markers such as `AUTONOMY_DONE`.

Prefer small helpers over long inline branches, and keep CLI-facing strings explicit so behavior is easy to audit. There is no formatter or linter configured yet, so consistency with the current source matters.

## Testing Guidelines

There is no automated test suite in the repository yet. Until one is added, every change should pass `pnpm typecheck` and, when behavior changes, a manual CLI run using `pnpm start -- /path/to/PLAN.md`.

When adding tests, place them beside the source in `src/` or under a dedicated `test/` directory, and use names that mirror the unit under test, such as `index.test.ts`.

## Commit & Pull Request Guidelines

The repository currently has no commit history, so use short, imperative commit messages such as `Add notifier failure handling` or `Refactor chunk streaming`. Keep each commit scoped to one logical change.

Pull requests should include a brief description of the behavior change, the commands used for verification, and any sample terminal output when the CLI UX changes. Link the related issue or plan doc when applicable.

## Configuration Notes

The CLI expects Node.js 18+ and uses `@openai/codex-sdk`. Local notifications are implemented in-repo and shell out to `~/bin/notify` by default. Override that with `AUTONOMY_NOTIFY_BIN` when needed, and call out environment-specific assumptions in reviews and PRs.
