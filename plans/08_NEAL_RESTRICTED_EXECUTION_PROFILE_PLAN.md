# Goal

Add a restricted execution profile for Neal that constrains coder and reviewer sessions to the current repository, preserves web research, blocks remote-mutating git operations such as `git push`, and prevents access to sensitive host tooling such as `aws` and other credential-bearing CLIs that are not required for the code-and-review loop.

The first version should prioritize runtime enforcement over prompt-only guidance.

# Problem Statement

Neal currently gives both coder and reviewer roles direct shell-capable execution surfaces:

- Codex runs with no approval gate and full filesystem sandbox bypass
- Claude runs with permission bypass enabled
- both roles can execute shell commands
- the reviewer has a narrower tool surface than the coder in some providers, but still retains shell access

That means Neal can currently rely on prompts and role conventions, but it cannot honestly claim to enforce a bounded operating environment. In particular, the current setup does not robustly prevent:

- access outside the target repository
- use of cloud CLIs or credential-bearing tooling
- remote-mutating git operations such as `git push`
- leakage through a rich inherited environment such as `HOME`, `PATH`, and cloud credential variables

This is a real engineering gap. For many code-and-review workflows, the desired operating contract is:

- work inside the repo
- inspect and edit local code
- run tests and read docs
- use the web for research
- do not touch the operator's cloud accounts, machine-level credentials, or remote git state

Prompt instructions are not sufficient for that contract. Neal needs runtime enforcement.

# Desired Contract

When the restricted execution profile is enabled, Neal should enforce the following:

1. Repository-bounded execution

- agent processes operate with the target repository as their effective working root
- file reads and writes outside the repository are blocked except for a small Neal-owned allowlist
- Neal-owned exceptions may include `.neal/` and `~/.config/neal/config.yml` when required

2. Web research remains available

- coder and reviewer retain the ability to use web research appropriate to their provider/runtime
- web access must not require broad shell access to the operator's host environment

3. Remote-mutating git commands are blocked

- local inspection and local commit operations remain allowed
- remote-affecting operations such as `git push`, `git pull`, `git fetch`, and remote reconfiguration are denied

4. Sensitive host tooling is blocked

- cloud CLIs, secret managers, deployment tooling, host remote-access tooling, and similar sensitive commands are denied

5. Sensitive environment surface is reduced

- agent subprocesses do not inherit the operator's full credential-bearing environment
- Neal scrubs known sensitive environment variables and should be able to run with an isolated temporary `HOME`

6. Role differences remain meaningful

- reviewer remains narrower than coder
- both roles can inspect the codebase and run approved commands
- only the coder gets mutation tools needed for implementation

# Non-Goals

This plan should not:

- replace Neal's provider integrations with a new bespoke execution engine
- eliminate web access
- require a full container runtime in the first version
- perfectly sandbox arbitrary hostile binaries on day one
- solve general workstation security beyond Neal's own execution surface
- rely on prompt text as the primary enforcement mechanism

# Threat Model and Scope

The first version is aimed at reducing realistic accidental or low-friction misuse, not defending against a fully adversarial local attacker with arbitrary native-code escape techniques.

The target failure modes are:

- accidental `git push`
- accidental use of `aws`, `gh`, `kubectl`, `terraform`, `op`, `ssh`, or similar tools
- accidental reads from home-directory secrets and credentials
- accidental edits outside the repository
- role drift where the reviewer uses more privilege than intended

This is a pragmatic containment profile for Neal's normal code-and-review loops.

# Enforcement Strategy

The first implementation should use a Neal-owned restricted shell wrapper plus environment scrubbing.

The wrapper should:

- sit in front of all shell-capable tool execution Neal exposes to providers
- parse the requested command conservatively
- allow approved commands and subcommands
- reject denied commands and subcommands with a clear error message
- run the approved command under a scrubbed environment

This gives Neal a single enforcement surface that works across providers without immediately depending on provider-specific sandbox capabilities.

Containerization or stronger OS-level sandboxing may be added later, but should not block the first version.

# Allowed and Blocked Command Model

The initial implementation should define an explicit policy.

Allowed categories:

- repository inspection:
  - `pwd`
  - `ls`
  - `find`
  - `rg`
  - `sed`
  - `cat`
  - `head`
  - `tail`
  - `wc`
- local build and test commands:
  - `pnpm`
  - `npm`
  - `node`
  - `tsx`
  - `tsc`
  - repo-local scripts invoked from the repository
- local git inspection and commit workflow:
  - `git status`
  - `git diff`
  - `git show`
  - `git log`
  - `git add`
  - `git commit`
  - `git branch --show-current`
- standard utility commands needed by the existing Neal loop, provided they do not cross the repo boundary

Blocked categories:

- remote-mutating git:
  - `git push`
  - `git pull`
  - `git fetch`
  - `git clone`
  - `git remote add`
  - `git remote set-url`
- cloud and infrastructure tooling:
  - `aws`
  - `gcloud`
  - `az`
  - `kubectl`
  - `terraform`
  - `helm`
  - `vercel`
  - `netlify`
- credential and secret tooling:
  - `op`
  - `vault`
  - `gh auth`
  - `git credential`
- remote-access and host-copy tools:
  - `ssh`
  - `scp`
  - `rsync`
  - `sftp`
- container tooling in the initial version:
  - `docker`
  - `podman`

The exact list should be defined centrally in code and tested directly.

# Filesystem and Environment Policy

When the restricted profile is enabled, Neal should:

- set the repo root as the enforced working directory for approved shell commands
- reject command arguments that resolve outside the repo root unless they match an explicit Neal allowlist
- scrub sensitive environment variables such as:
  - `AWS_*`
  - `GOOGLE_*`
  - `AZURE_*`
  - `GH_*`
  - `OP_*`
  - common credential file path variables
- provide a minimal `PATH`
- prefer an isolated temporary `HOME` for agent subprocesses

The initial version should make the allowlist explicit and small. Neal-owned exceptions should be documented in the code and surfaced in tests.

# Provider Integration Strategy

The enforcement boundary should live in Neal, not in prompts.

Provider-specific integration should be:

- OpenAI Codex: continue to use the provider runtime, but route shell-capable operations through the restricted host environment Neal prepares
- Anthropic Claude: continue to expose shell-capable tools only through the restricted wrapper environment Neal prepares

Reviewer/coder role differences should remain provider-specific where necessary, but the restricted execution profile should be enforced consistently across both.

The concrete current integration points are:

- [src/neal/providers/openai-codex.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/openai-codex.ts)
- [src/neal/providers/anthropic-claude.ts](/Users/lee.nave/code/personal/codex-chunked/src/neal/providers/anthropic-claude.ts)

# Configuration Surface

The restricted execution profile should be configurable in `config.yml`.

The initial YAML shape should be explicit and repo-local overridable:

```yaml
neal:
  execution_profile: unrestricted
  restricted_execution:
    isolate_home: true
    allow_web_research: true
    block_remote_git: true
    block_sensitive_tooling: true
```

The default should remain `unrestricted` for the first landing so the feature can be introduced safely without breaking existing workflows.

Once the restricted profile is proven in real runs, Neal can consider flipping the default later.

# CLI and UX Requirements

Neal should make the active execution profile visible.

When restricted mode is enabled:

- startup output should say that the restricted execution profile is active
- refusal messages from blocked commands should be clear and specific
- refusal messages should explain whether the block came from:
  - repo-boundary enforcement
  - blocked git remote operation
  - blocked sensitive tooling
  - scrubbed environment assumptions

The operator should not have to infer that a command was blocked by policy.

# Guardrails

1. The restricted profile must be enforced by runtime behavior, not only by prompts.
2. Reviewer must not gain write privileges or broader shell powers than coder.
3. Neal must fail closed on unknown denied-command classifications when policy requires blocking.
4. Neal must not silently pass through remote-mutating git commands in restricted mode.
5. Neal must not silently inherit the operator's full credential-bearing environment in restricted mode.

# Verification Strategy

Verification should include both pure policy tests and end-to-end command-execution tests.

The test suite should cover:

- allowed local inspection commands succeeding inside the repo
- path traversal attempts outside the repo being rejected
- blocked binaries such as `aws` and `ssh` being rejected
- blocked git subcommands such as `git push` and `git fetch` being rejected
- allowed local git commands such as `git status` and `git commit` remaining functional
- environment scrubbing behavior for representative sensitive variables
- reviewer role still lacking mutation capability where applicable
- startup / refusal diagnostics clearly surfacing restricted-profile behavior

Use temporary repositories and controlled child-process environments rather than only mocking policy decisions.

# Scope 1: Restricted Policy and Environment Model

Implement the configuration, policy model, and environment-scrubbing helpers.

Goal:

- add YAML config for execution profile selection
- define allowed and blocked command policy structures
- implement environment-scrubbing and isolated-home helpers

Verification:

- `pnpm typecheck`
- targeted unit tests for config parsing and environment shaping

Success Condition:

- Neal can resolve a restricted execution profile and produce a deterministic policy + environment bundle for command execution.

# Scope 2: Restricted Shell Wrapper

Add a Neal-owned wrapper for shell-capable command execution.

Goal:

- implement a wrapper that evaluates requested commands against the restricted policy
- reject blocked commands with clear machine- and human-readable reasons
- run approved commands under the scrubbed environment and repo-bounded working directory

Verification:

- `pnpm typecheck`
- targeted tests for allow/deny decisions and refusal messages

Success Condition:

- Neal has one central enforcement point for shell command execution in restricted mode.

# Scope 3: Provider Integration

Route coder and reviewer shell-capable flows through the restricted wrapper.

Goal:

- integrate the wrapper into both provider paths
- preserve reviewer/coder role differences
- keep existing ordinary code-and-review workflows working for allowed commands

Verification:

- `pnpm typecheck`
- provider-facing tests covering reviewer and coder command execution in restricted mode

Success Condition:

- Both providers honor the restricted profile consistently, and reviewer remains a narrower role than coder.

# Scope 4: Git and Sensitive-Tooling Guardrails

Harden the most important blocked-command categories and refusal UX.

Goal:

- explicitly block remote git mutation paths
- explicitly block sensitive host tooling
- make refusal surfaces direct and understandable

Verification:

- `pnpm typecheck`
- end-to-end tests proving representative blocked commands are denied

Success Condition:

- In restricted mode, Neal cannot accidentally push code, run cloud CLIs, or invoke host remote-access tooling through the ordinary code-and-review loop.

# Scope 5: Docs, Diagnostics, and Real-Run Hardening

Document the profile and make its runtime behavior visible.

Goal:

- document the restricted execution profile in README and config comments
- surface the active profile in startup diagnostics
- add enough run logging to debug future policy misses or false positives

Verification:

- `pnpm typecheck`
- targeted tests for startup/refusal diagnostics

Success Condition:

- Operators can tell when restricted mode is active, understand why a command was blocked, and adjust policy safely when real-run gaps are discovered.

# Recommended Implementation Order

1. Land the policy model and environment scrubbing first.
2. Add the restricted shell wrapper next.
3. Integrate providers only after the wrapper behavior is stable under tests.
4. Harden the high-value blocked-command categories before broader polish.
5. Finish with docs and diagnostics.

# Final Notes

This feature is worthwhile because it introduces real operational boundaries without requiring a full container runtime in the first slice.

If the restricted wrapper proves too porous or too provider-dependent in practice, the natural follow-up is a stronger sandbox/container execution profile. The first version should be explicit about that limitation rather than pretending to provide stronger isolation than it really does.

When all scopes are complete, end with `AUTONOMY_DONE`.
