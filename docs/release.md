# Release process

Releases start from the manual GitHub Actions `Publish` workflow. The workflow
checks and stages the npm package, waits for a maintainer's npm approval, then
creates the matching GitHub tag and release.

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

- Patch: `0.3.2` fixes a defect or compatibility issue without intentionally
  changing documented behavior.
- Minor before `1.0.0`: `0.4.0` adds a feature or meaningful behavior change
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
compatibility findings. Match the neal release to the user-facing impact: use a
patch release for a compatibility fix that preserves documented behavior, a
minor release for behavior changes before `1.0.0`, and a major release after
`1.0.0` if a documented public contract breaks.

For a qualified dependency-bump PR, `scripts/release-sdk-bump.sh <pr-number>`
runs this entire process as one command: it merges the dependency PR, opens and
merges the release-preparation pull request with a generated changelog section,
runs the Publish workflow dry run and, after a confirmation, the real run, and
prompts for the npm 2FA stage approval. It refuses PRs that touch anything
beyond `package.json` and `pnpm-lock.yaml`, and refuses native agentic-SDK
bumps that lack a `scripts/qualify-sdk.sh` PASS review. Every other release
follows the manual steps below.

## Prepare a release

Bump `package.json.version` and add a nonempty `## [<version>]` section to
`CHANGELOG.md` in a normal release-preparation pull request:

```sh
pnpm version <version> --no-git-tag-version
```

Run the release gates from the repository root:

```sh
RELEASE_VERSION=<version> RELEASE_DRY_RUN=true pnpm run validate:release
pnpm typecheck
pnpm test
pnpm lint
pnpm build
node scripts/verify-package.mjs
```

`validate:release` checks the package version, required metadata, direct SDK
pins, changelog section, npm version availability, and remote tag availability.

## Publish

After the release-preparation pull request is merged and normal CI passes, open
**Actions > Publish > Run workflow** on `main`.

Run it first with the exact version and `dry_run: true`. This runs every gate
and `npm publish --dry-run` without changing npm or GitHub.

Run it again with `dry_run: false` after reviewing the dry run. The workflow:

1. Runs the same release gates.
2. Runs `npm stage publish` and writes the stage ID and approval commands to the
   GitHub job summary.
3. Waits up to 60 minutes for the package to become public.
4. Verifies npm's signed provenance against the workflow's repository, path,
   branch, and exact commit SHA.
5. Creates `v<version>` at that commit and a GitHub release from the matching
   changelog section.

Review the stage with `npm stage view <stage-id>` or
`npm stage download <stage-id>`. Approve it with 2FA using
`npm stage approve <stage-id>` or the npmjs.com UI. npm won't publish the
package until that approval happens.

## Recovery

Rerun `Publish` with the same version and `dry_run: false` after a timeout or a
partial failure. The workflow checks existing state before taking action:

- If the npm version isn't public, it stages it and waits for approval.
- If the npm version is public, it skips staging and verifies its signed
  provenance against the current workflow commit.
- If the tag or GitHub release already exists at the expected commit, it keeps
  it and finishes successfully.
- If the npm provenance or tag points to another commit, it stops without
  changing the existing release.

If the approval wait times out, approve the existing npm stage before rerunning.
Do not try to stage the same version a second time.

## Trusted publishing setup

The workflow uses npm trusted publishing with no token fallback. The npm trusted
publisher is configured for owner/repository `navels/neal`, workflow
`publish.yml`, environment `npm-publish`, and the **`npm stage publish` only**
permission. Publishing access requires two-factor authentication and disallows
traditional tokens.

The workflow grants `id-token: write` for npm's OpenID Connect authentication
and `contents: write` for the final tag and GitHub release. The `npm-publish`
environment accepts only `main`. npm's stage-only permission means the workflow
can't make a package public without a maintainer's 2FA approval.

Official references:

- GitHub `workflow_dispatch` inputs:
  <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>
- npm trusted publishing:
  <https://docs.npmjs.com/trusted-publishers/>
- npm staged packages:
  <https://docs.npmjs.com/staged-publishing/>
- npm trust command:
  <https://docs.npmjs.com/cli/v11/commands/npm-trust/>
