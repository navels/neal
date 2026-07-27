# Contributing

neal is a TypeScript CLI. Bug fixes and focused core feature
improvements are welcome.

## Local Setup

Use Node.js 24.18.0 or newer. The checked-in `.nvmrc` selects 24.18.0 for
local development, and Corepack should activate the pnpm version pinned in
`packageManager`.

```bash
corepack enable
corepack prepare pnpm@11 --activate
pnpm install
pnpm start -- help
```

On Windows, run neal from WSL2 with the target repository on the Linux
filesystem. Running neal directly from PowerShell or cmd.exe isn't supported.

Run the CLI from the target repository you want neal to operate on. While
working in this checkout, use `pnpm start -- ...` to run the TypeScript entry
point directly. You don't need build output to run from source. You do need it
when verifying the packed package (`pnpm run verify:package`) or when
registering the development link below.

For local manual testing through a global `neal` command, use the optional
contributor development link:

```bash
pnpm run dev:link
```

That command runs `pnpm build && npm link`, registers the package's `bin.neal`
entry with the active Node.js installation, and links it back to this checkout.
After source changes, run `pnpm build` again so the linked command sees the
rebuilt `dist/` output. If the shell can't find the command, use
`command -v neal` and `npm list -g --depth 0 --link=true` as diagnostics.

## Verification

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm run verify:package
```

`pnpm run verify:package` builds, packs the package tarball, installs that
tarball into a temporary prefix, and runs the installed `neal help` command.

CI runs the same typecheck, test, build, and package verification gates on
Node 24.18.0, matching the checked-in `.nvmrc` and the published package
engine.

For CLI behavior changes, also run the relevant `pnpm start -- ...` command from
a disposable target repository or fixture.

Manual npm release operation is documented in [docs/release.md](docs/release.md).
Normal CI remains verification-only. Publishing is handled only by the manual
`Publish` workflow. Don't duplicate the release procedure in pull requests.
Link to the release docs when a versioned publish is relevant.

## Code Style

Keep runtime code under `src/`. Generated `dist/` output is build output. Match
the existing TypeScript style: strict typing, ES module syntax, 2-space
indentation, single quotes, semicolons, and descriptive `camelCase` function
names.

Use `SCREAMING_SNAKE_CASE` for fixed protocol-marker constants. Prefer small
helpers over long inline branches, and keep CLI-facing strings explicit so
behavior is easy to audit. There's no formatter configured yet, so consistency
with nearby source matters.

## Change Scope

Focused fixes and improvements to neal's core loop, validation, storage,
provider adapters, terminal output, and documentation are good fits for pull
requests.

New workflows, major behavior changes, broad product additions, provider model
or permission policy changes, persisted state changes, resume semantics changes,
prompt contract changes, storage layout changes, and history-rewriting behavior
changes need focused tests and explicit artifact/privacy implications. Broad
product-direction work should be discussed first or kept as a fork.

## Pull Requests

Pull requests should include a brief description of the behavior change, the
verification commands run, and sample terminal output when CLI UX changes. Link
the related issue, design note, or discussion when applicable.

## Canonical References

- [docs/providers.md](docs/providers.md): built-in provider setup, capabilities,
  permissions, and adapter contracts
- [docs/plan-format.md](docs/plan-format.md): executable plan shapes and
  selected-plan Git behavior
- [docs/storage.md](docs/storage.md): project-local `.neal/` artifacts,
  retention, and privacy expectations
- [docs/release.md](docs/release.md): manual release workflow, exact SDK
  dependency policy, and first-publish boundary
- [docs/demo.md](docs/demo.md): safe `asciinema` recording guidance from a
  disposable repository
