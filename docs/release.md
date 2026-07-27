# Release process

Releases are manual, versioned npm operations. Normal CI only verifies pushes
and pull requests. The GitHub Actions `Publish` workflow handles publishing and
runs only through `workflow_dispatch`.

## Versioning policy

neal uses Semantic Versioning. `package.json.version` changes only in an
intentional release-preparation pull request, not in ordinary implementation
commits. Release versions are exact SemVer strings without a leading `v`, and
an npm version must never be reused.

Before `1.0.0`, minor releases may include meaningful behavior changes while
the CLI, configuration, exit-code, and artifact contracts settle. After
`1.0.0`, breaking changes to documented CLI commands, flags, configuration,
exit codes, or durable run artifacts require a major version.

Examples:

- Patch: `0.1.1` fixes a defect or compatibility issue without intentionally
  changing documented behavior.
- Minor before `1.0.0`: `0.2.0` adds a feature or meaningful behavior change
  while the public contract is still settling.
- Major: `1.0.0` establishes the stable public contract. Later breaking
  contract changes require `2.0.0`, `3.0.0`, and so on.

## SDK dependency policy

Direct coding-agent and AI SDK runtime dependencies must use exact SemVer specs
in `package.json`. Do not use `latest`, caret ranges, tilde ranges, wildcards,
workspace specs, file specs, or link specs for these direct dependencies in a
published CLI package:

- `@anthropic-ai/claude-agent-sdk`
- `@openai/codex-sdk`
- `ai`
- `@ai-sdk/openai-compatible`
- `zod`

An SDK update should land as a normal dependency pull request that updates both
`package.json` and `pnpm-lock.yaml`, runs normal CI, and records any provider
compatibility findings. The resulting neal release should match the user-facing
impact: use a patch release for a compatibility fix that preserves documented
behavior, a minor release for behavior changes before `1.0.0`, and a major
release after `1.0.0` if a documented public contract breaks.

## Local release readiness

Prepare a release with a normal pull request that changes `package.json.version`
to the intended exact SemVer version:

```sh
pnpm version <version> --no-git-tag-version
```

Run the local release-readiness gates from the repository root:

```sh
RELEASE_VERSION=<version> RELEASE_DRY_RUN=true pnpm run validate:release
pnpm typecheck
pnpm test
pnpm build
node scripts/verify-package.mjs
```

`validate:release` checks that the workflow input version matches
`package.json.version`, validates required package metadata, checks npm version
availability, and checks remote `v<version>` tag availability when an `origin`
remote is configured. Package verification confirms the built CLI and packed
tarball.

## Manual publish workflow

After the release-preparation pull request is merged and normal CI passes, run
the `Publish` workflow manually from `main` with:

- `version`: the exact `package.json.version`, without a leading `v`
- `dry_run`: `true`

The workflow is guarded to `refs/heads/main`, uses the `npm-publish`
environment, grants `contents: read` and `id-token: write`, installs with
`pnpm install --frozen-lockfile`, and runs these gates before any publish step:

```sh
RELEASE_VERSION=<version> RELEASE_DRY_RUN=<dry_run> pnpm run validate:release
pnpm typecheck
pnpm test
pnpm build
node scripts/verify-package.mjs
```

Review the dry-run result before any real publish. Run `Publish` again with
`dry_run: false` only when a release-preparation plan has explicitly authorized
the real publish.

The real-publish path is **staged**: the workflow runs `npm stage publish`,
which places the version in a staged, not-publicly-available state. A
maintainer then reviews and approves it with 2FA: `npm stage list`,
`npm stage view <stage-id>` / `npm stage download <stage-id>`, and
`npm stage approve <stage-id>` (or the npmjs.com UI). Nothing reaches `latest`
without that human approval, so a compromised workflow cannot ship directly.

## First-publish history

`0.1.0` was published manually on 2026-07-12 with an interactive 2FA publish
from a maintainer terminal: npm trusted publishing cannot be configured for a
package that has never been published, so the first publish had to
authenticate directly. Every release after `0.1.0` goes through the `Publish`
workflow and the staged flow above.

## Trusted publishing setup

The publish workflow relies on trusted publishing/OIDC and intentionally has no
npm-token fallback. It grants `id-token: write` for OIDC, keeps repository
contents read-only, uses the `npm-publish` GitHub environment, and runs
`npm stage publish` only on the real-publish path (staged publishing requires
npm >= 11.15.0, so the workflow upgrades npm accordingly).

The npm-side configuration for `@navels/neal`:

- Publishing access: **Require two-factor authentication and disallow tokens**.
  This blocks every traditional token permanently. Trusted publishers are
  unaffected because they use OIDC, and staged approvals always require a
  maintainer's 2FA.
- Trusted publisher: owner/repo `navels/neal`, workflow filename
  `publish.yml`, environment `npm-publish`, allowed action **`npm stage
  publish` only** (stage-only, plain `npm publish` is deliberately not
  granted).

## Release boundaries

The current workflow checks that the remote `v<version>` tag is available, but
it does not create tags or GitHub releases. Do not promise or perform release
marker creation as part of the current publish workflow. If tags or GitHub
releases are needed after a successful publish, add them in a separate plan with
the required permissions and explicit operator approval.

Recovery rule for later real publishes: if `npm publish` succeeds but a later
release-marker step fails in a separate plan, do not rerun the publish blindly.
First confirm the npm version exists, then create only the missing marker.

Official references:

- GitHub `workflow_dispatch` inputs:
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>
- npm trusted publishing:
  <https://docs.npmjs.com/trusted-publishers/>
- npm trust command:
  <https://docs.npmjs.com/cli/v11/commands/npm-trust/>
